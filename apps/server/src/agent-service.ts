import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
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
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = recoveredAt;
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = recoveredAt;
        }
      }
      for (const trace of database.traces) {
        const run = database.runs.find((candidate) => candidate.id === trace.runId);
        const recoveredStatus =
          trace.status === "running"
            ? run?.status === "completed" || run?.status === "failed"
              ? run.status
              : "cancelled"
            : trace.status;
        const completedAt = trace.completedAt ?? recoveredAt;

        if (trace.status === "running") {
          trace.status = recoveredStatus;
          trace.completedAt = completedAt;
        }

        for (const span of trace.spans) {
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
            span.error ??= "Run cancelled after server restart";
          } else if (recoveredStatus === "failed") {
            span.error ??= "Execution failed";
          }
        }
      }
    });
  }

  async shutdown(): Promise<void> {
    const activeAgentIds = [...this.activeExecutions.keys()];
    await Promise.allSettled(
      activeAgentIds.map((agentId) => this.cancelExecution(agentId)),
    );
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
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
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
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
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
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
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    const trace = await this.startRunTrace(agentAtStart.id, run.id);
    let modelSpanId: string | null = null;

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      modelSpanId = await this.startModelSpan(trace);

      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });

      const completedAt = now();

      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;

        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
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
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });

      await this.finalizeRunTrace(trace, modelSpanId, "completed");
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      const traceStatus = cancelled ? "cancelled" : "failed";
      const traceError = cancelled ? "Run cancelled" : "Execution failed";

      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });

      await this.finalizeRunTrace(
        trace,
        modelSpanId,
        traceStatus,
        traceError,
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
    error?: string,
  ): Promise<void> {
    const spanResult = error === undefined ? { status } : { status, error };

    if (modelSpanId) {
      try {
        await this.traces.endSpan(modelSpanId, spanResult);
      } catch {
        // Tracing is best-effort and must not change the Run result.
      }
    }

    if (trace.orchestrationSpanId) {
      try {
        await this.traces.endSpan(trace.orchestrationSpanId, spanResult);
      } catch {
        // Keep attempting to close the rest of the trace.
      }
    }

    if (trace.traceId) {
      try {
        await this.traces.endTrace(trace.traceId, status);
      } catch {
        // Tracing is best-effort and must not change the Run result.
      }
    }
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
      await this.runner.cancel(agentId);

      const execution = this.activeExecutions.get(agentId);

      if (execution) {
        await execution;
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
