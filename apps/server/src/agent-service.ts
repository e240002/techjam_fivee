import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { formatRuntimeError } from "./runtime-errors.js";
import { JsonStore } from "./store.js";
import { sanitizeMetadata, sanitizeText } from "./tracing/redaction.js";
import { TraceService } from "./tracing/trace-service.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunnerEvent,
  RunUsage,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

type TerminalTraceStatus = "completed" | "failed" | "cancelled";

interface RunTraceState {
  traceId: string | null;
  orchestrationSpanId: string | null;
}

interface RunnerEventState {
  threadId: string | null;
  usage: RunUsage | null;
  itemCounts: Map<string, number>;
  errorCount: number;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Map<string, number>();
  private readonly lifecycleBlocks = new Set<string>();
  private readonly sensitiveValues: readonly string[];
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly traces: TraceService,
  ) {
    this.sensitiveValues = [config.arkApiKey, config.authToken].filter(
      (value) => value.length > 0,
    );
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      const recoveredAt = now();
      for (const run of database.runs) {
        if (run.error !== null) {
          run.error = this.sanitizeErrorText(run.error);
        }
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = recoveredAt;
        }
      }
      for (const agent of database.agents) {
        if (agent.lastError !== null) {
          agent.lastError = this.sanitizeErrorText(agent.lastError);
        }
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = recoveredAt;
        }
      }
      for (const trace of database.traces) {
        const run = database.runs.find((candidate) => candidate.id === trace.runId);
        const runStatus =
          run &&
          (run.status === "completed" ||
            run.status === "failed" ||
            run.status === "cancelled")
            ? run.status
            : null;
        const inferredSpanStatus = trace.spans.some(
          (span) => span.status === "failed",
        )
          ? "failed"
          : trace.spans.some((span) => span.status === "cancelled")
            ? "cancelled"
            : trace.spans.length > 0 &&
                trace.spans.every((span) => span.status === "completed")
              ? "completed"
              : null;
        const recoveredStatus =
          trace.status === "running"
            ? (runStatus ?? inferredSpanStatus ?? "cancelled")
            : trace.status;
        const latestSpanCompletedAt = trace.spans
          .map((span) => span.completedAt)
          .filter((value): value is string => value !== null)
          .sort((left, right) => right.localeCompare(left))[0];
        const completedAt =
          run?.completedAt ??
          trace.completedAt ??
          latestSpanCompletedAt ??
          recoveredAt;

        if (trace.status === "running") {
          trace.status = recoveredStatus;
        }
        trace.completedAt ??= completedAt;

        for (const span of trace.spans) {
          span.metadata = sanitizeMetadata(span.metadata, this.sensitiveValues);
          if (span.error !== null) {
            span.error = this.sanitizeErrorText(span.error);
          }
          if (span.status !== "running") continue;
          span.status = recoveredStatus;
          span.completedAt = completedAt;
          const startedAtMs = Date.parse(span.startedAt);
          const completedAtMs = Date.parse(completedAt);
          span.durationMs =
            Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
              ? Math.max(0, completedAtMs - startedAtMs)
              : null;
          if (recoveredStatus === "cancelled") {
            span.error ??=
              run?.error ?? "Trace interrupted before it could be completed";
          } else if (recoveredStatus === "failed") {
            span.error ??= "Execution failed";
          }
        }
      }
    });
  }

  shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown(timeoutMs);
    return this.shutdownPromise;
  }

  private async performShutdown(timeoutMs: number): Promise<void> {
    // Flush admissions that entered the store queue before shuttingDown was set.
    await this.store.mutate(() => undefined);
    await Promise.resolve();

    const activeAgentIds = [...this.activeExecutions.keys()];
    if (activeAgentIds.length === 0) return;

    const cancellations = Promise.allSettled(
      activeAgentIds.map((agentId) => this.cancelExecution(agentId)),
    );
    let timeout: NodeJS.Timeout | null = null;
    const results = await Promise.race([
      cancellations,
      new Promise<null>((resolve) => {
        timeout = setTimeout(
          () => resolve(null),
          Math.max(0, Math.trunc(timeoutMs)),
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    if (results === null) {
      await this.checkpointInterruptedRuns(
        activeAgentIds,
        "Server shut down before this run completed",
      );
      throw new Error("Timed out while cancelling active Agent runs");
    }

    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (failures.length > 0) {
      await this.checkpointInterruptedRuns(
        activeAgentIds,
        "Server could not cleanly cancel this run",
      );
      throw new AggregateError(failures, "Failed to cancel active Agent runs");
    }
  }

  listAgents(): Agent[] {
    return this.store
      .select((database) => database.agents)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.select((database) =>
      database.agents.find((item) => item.id === id),
    );
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    if (this.shuttingDown) {
      throw new HttpError(503, "Server is shutting down");
    }
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy" || this.lifecycleBlocks.has(id)) {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy" || this.lifecycleBlocks.has(id)) {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    this.beginLifecycleChange(id);
    try {
      await this.setStatus(id, "stopped");
      await this.cancelExecution(id);
      const archivedWorkspace = await this.workspaces.archive(agent);
      await this.store.mutate((database) => {
        database.agents = database.agents.filter((item) => item.id !== id);
        database.messages = database.messages.filter((item) => item.agentId !== id);
        database.runs = database.runs.filter((item) => item.agentId !== id);
        database.traces = database.traces.filter((trace) => trace.agentId !== id);
      });
      return { archivedWorkspace };
    } finally {
      this.lifecycleBlocks.delete(id);
    }
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    this.beginLifecycleChange(id);
    try {
      await this.setStatus(id, "stopped");
      await this.cancelExecution(id);
      return this.getAgent(id);
    } finally {
      this.lifecycleBlocks.delete(id);
    }
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .select((database) =>
        database.messages.filter((message) => message.agentId === agentId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.select((database) =>
      database.runs.find((item) => item.id === runId),
    );
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .select((database) =>
        database.runs.filter((run) => run.agentId === agentId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (this.shuttingDown) {
      throw new HttpError(503, "Server is shutting down");
    }
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      if (this.shuttingDown) {
        throw new HttpError(503, "Server is shutting down");
      }
      if (this.lifecycleBlocks.has(agentId)) {
        throw new HttpError(409, "Agent lifecycle change is in progress");
      }
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexReasoningEffort: this.config.codexReasoningEffort ?? null,
      codexModelVerbosity: this.config.codexModelVerbosity ?? null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const cancelBeforeRunner = await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      return (
        !storedRun ||
        !agent ||
        agent.status === "stopped" ||
        this.lifecycleBlocks.has(agentAtStart.id) ||
        this.shuttingDown
      );
    });

    const trace = await this.startRunTrace(agentAtStart.id, run.id);
    let modelSpanId: string | null = null;
    const events = this.createRunnerEventState();

    try {
      if (cancelBeforeRunner || this.isCancellationRequested(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      modelSpanId = await this.startModelSpan(trace);

      if (
        this.isCancellationRequested(agentAtStart.id) ||
        this.lifecycleBlocks.has(agentAtStart.id) ||
        this.shuttingDown
      ) {
        throw new RunCancelledError();
      }

      const result = await this.runner.run(
        {
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
        },
        (event) => this.captureRunnerEvent(events, event),
      );

      const completedAt = now();
      events.usage = this.mergeUsage(result.usage, events.usage);
      events.threadId =
        this.safeThreadId(result.threadId) ??
        events.threadId ??
        this.safeThreadId(agentAtStart.codexThreadId);

      if (
        this.isCancellationRequested(agentAtStart.id) ||
        this.lifecycleBlocks.has(agentAtStart.id) ||
        this.shuttingDown
      ) {
        throw new RunCancelledError();
      }

      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (
          !storedRun ||
          !agent ||
          storedRun.status === "cancelled" ||
          agent.status === "stopped"
        ) {
          throw new RunCancelledError();
        }

        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.error = null;
        storedRun.usage = events.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = events.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });

      await this.finalizeRunTrace(
        trace,
        modelSpanId,
        "completed",
        completedAt,
        undefined,
        events,
      );
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError ||
        this.isCancellationRequested(agentAtStart.id) ||
        this.lifecycleBlocks.has(agentAtStart.id) ||
        this.shuttingDown;
      const message = cancelled
        ? "Run cancelled"
        : this.sanitizeError(error);
      const traceStatus = cancelled ? "cancelled" : "failed";
      const traceError = cancelled ? "Run cancelled" : "Execution failed";

      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.usage = this.mergeUsage(events.usage, storedRun.usage);
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          if (events.threadId !== null) {
            agent.codexThreadId = events.threadId;
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });

      await this.finalizeRunTrace(
        trace,
        modelSpanId,
        traceStatus,
        completedAt,
        traceError,
        events,
      );
    }
  }

  private async startRunTrace(
    agentId: string,
    runId: string,
  ): Promise<RunTraceState> {
    let traceId: string | null = null;

    try {
      traceId = (await this.traces.startTrace({ agentId, runId })).id;
    } catch {
      return { traceId: null, orchestrationSpanId: null };
    }

    try {
      const orchestrationSpan = await this.traces.startSpan({
        traceId,
        type: "orchestration",
        name: "agent.run",
      });
      return { traceId, orchestrationSpanId: orchestrationSpan.id };
    } catch {
      return { traceId, orchestrationSpanId: null };
    }
  }

  private async startModelSpan(trace: RunTraceState): Promise<string | null> {
    if (!trace.traceId || !trace.orchestrationSpanId) return null;

    try {
      const modelSpan = await this.traces.startSpan({
        traceId: trace.traceId,
        parentSpanId: trace.orchestrationSpanId,
        type: "model",
        name: "codex.run",
      });
      return modelSpan.id;
    } catch {
      return null;
    }
  }

  private async finalizeRunTrace(
    trace: RunTraceState,
    modelSpanId: string | null,
    status: TerminalTraceStatus,
    completedAt: string,
    error?: string,
    events?: RunnerEventState,
  ): Promise<void> {
    if (modelSpanId && events) {
      const metadata = this.runnerEventMetadata(events);
      try {
        if (Object.keys(metadata).length > 0) {
          await this.traces.setSpanMetadata(modelSpanId, metadata);
        }
      } catch {
        // Metadata is best-effort; still close the trace atomically below.
      }
    }

    if (trace.traceId) {
      try {
        await this.traces.finalizeTrace(trace.traceId, {
          status,
          completedAt,
          ...(error === undefined ? {} : { error }),
        });
      } catch {
        // Tracing is best-effort and must not change the Run result.
      }
    }
  }

  private createRunnerEventState(): RunnerEventState {
    return {
      threadId: null,
      usage: null,
      itemCounts: new Map<string, number>(),
      errorCount: 0,
    };
  }

  private captureRunnerEvent(state: RunnerEventState, event: RunnerEvent): void {
    if (event.kind === "thread_started") {
      state.threadId = this.safeThreadId(event.threadId) ?? state.threadId;
      return;
    }

    if (event.kind === "turn_completed") {
      state.usage = this.mergeUsage(event.usage, state.usage);
      return;
    }

    if (event.kind === "item_completed") {
      const itemType = sanitizeText(
        event.itemType,
        this.sensitiveValues,
      )
        .replace(/[^A-Za-z0-9._:-]+/g, "_")
        .slice(0, 128) || "unknown";
      if (state.itemCounts.has(itemType) || state.itemCounts.size < 32) {
        state.itemCounts.set(itemType, (state.itemCounts.get(itemType) ?? 0) + 1);
      }
      return;
    }

    state.errorCount += 1;
  }

  private runnerEventMetadata(state: RunnerEventState): Record<string, unknown> {
    return sanitizeMetadata(
      {
        ...(state.usage === null ? {} : { usage: state.usage }),
        ...(state.itemCounts.size === 0
          ? {}
          : {
              itemCounts: Object.fromEntries(
                [...state.itemCounts.entries()].sort(([left], [right]) =>
                  left.localeCompare(right),
                ),
              ),
            }),
        ...(state.errorCount === 0 ? {} : { errorCount: state.errorCount }),
      },
      this.sensitiveValues,
    );
  }

  private mergeUsage(
    primary: RunUsage | null,
    fallback: RunUsage | null,
  ): RunUsage | null {
    const normalizedPrimary = this.normalizeUsage(primary);
    const normalizedFallback = this.normalizeUsage(fallback);
    if (!normalizedPrimary && !normalizedFallback) return null;
    return {
      ...(normalizedFallback ?? {}),
      ...(normalizedPrimary ?? {}),
    };
  }

  private normalizeUsage(usage: RunUsage | null): RunUsage | null {
    if (!usage) return null;
    const normalized: RunUsage = {};
    for (const key of [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
    ] as const) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        normalized[key] = Math.trunc(value);
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  private safeThreadId(value: string | null): string | null {
    if (value === null) return null;
    const candidate = value.trim();
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(candidate)) return null;
    return sanitizeText(candidate, this.sensitiveValues) === candidate
      ? candidate
      : null;
  }

  private sanitizeError(error: unknown): string {
    return formatRuntimeError(error, {
      arkModel: this.config.arkModel,
      sensitiveValues: this.sensitiveValues,
    });
  }

  private sanitizeErrorText(message: string): string {
    return sanitizeText(message, this.sensitiveValues);
  }

  private beginLifecycleChange(agentId: string): void {
    if (this.lifecycleBlocks.has(agentId)) {
      throw new HttpError(409, "Agent lifecycle change is already in progress");
    }
    this.lifecycleBlocks.add(agentId);
  }

  private isCancellationRequested(agentId: string): boolean {
    return (this.cancellationRequests.get(agentId) ?? 0) > 0;
  }

  private async checkpointInterruptedRuns(
    agentIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const completedAt = now();
    const agentIdSet = new Set(agentIds);
    const runIds = await this.store.mutate((database) => {
      const affectedRunIds: string[] = [];
      for (const run of database.runs) {
        if (
          agentIdSet.has(run.agentId) &&
          (run.status === "queued" || run.status === "running")
        ) {
          run.status = "cancelled";
          run.error = reason;
          run.completedAt = completedAt;
          affectedRunIds.push(run.id);
        }
      }
      for (const agent of database.agents) {
        if (agentIdSet.has(agent.id) && agent.status === "busy") {
          agent.status = "ready";
          agent.lastError = null;
          agent.updatedAt = completedAt;
        }
      }
      return affectedRunIds;
    });

    const runIdSet = new Set(runIds);
    const traceIds = this.store.select((database) =>
      database.traces
        .filter((trace) => runIdSet.has(trace.runId))
        .map((trace) => trace.id),
    );
    await Promise.allSettled(
      traceIds.map((traceId) =>
        this.traces.finalizeTrace(traceId, {
          status: "cancelled",
          error: reason,
          completedAt,
        }),
      ),
    );
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);

      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }

      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(
          409,
          "Stop the active run before starting this Agent",
        );
      }
      if (
        status === "ready" &&
        (this.lifecycleBlocks.has(id) || this.shuttingDown)
      ) {
        throw new HttpError(409, "Agent lifecycle change is in progress");
      }

      agent.status = status;

      if (status === "ready") {
        agent.lastError = null;
      }

      agent.updatedAt = now();

      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.set(
      agentId,
      (this.cancellationRequests.get(agentId) ?? 0) + 1,
    );

    try {
      let cancellationError: unknown;
      try {
        await this.runner.cancel(agentId);
      } catch (error) {
        cancellationError = error;
      }
      const execution = this.activeExecutions.get(agentId);

      if (execution) {
        await execution;
      }
      if (cancellationError !== undefined) {
        throw cancellationError;
      }
    } finally {
      const remaining = (this.cancellationRequests.get(agentId) ?? 1) - 1;
      if (remaining > 0) {
        this.cancellationRequests.set(agentId, remaining);
      } else {
        this.cancellationRequests.delete(agentId);
      }
    }
  }
}
