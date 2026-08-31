import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import { TraceService } from "./tracing/trace-service.js";
import type {
  AgentRunner,
  Database,
  RunnerEventHandler,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeServiceWithTraces(
  runner: AgentRunner = new FakeRunner(),
): Promise<{
  service: AgentService;
  traces: TraceService;
  store: JsonStore;
  root: string;
  config: ReturnType<typeof loadConfig>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const traces = new TraceService(store, [config.arkApiKey, config.authToken]);
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    traces,
  );
  await service.initialize();
  return { service, traces, store, root, config };
}

async function makeService(
  runner: AgentRunner = new FakeRunner(),
): Promise<AgentService> {
  return (await makeServiceWithTraces(runner)).service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("cascades stored runs, messages, and traces when deleting an Agent", async () => {
    const { service, traces, store } = await makeServiceWithTraces();
    const agent = await service.createAgent({ name: "Delete cascade" });
    const { run } = await service.sendMessage(agent.id, "create trace");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(traces.getTraceByRunId(run.id)).not.toBeNull();

    await service.deleteAgent(agent.id);

    const snapshot = store.snapshot();
    expect(snapshot.agents.some((candidate) => candidate.id === agent.id)).toBe(false);
    expect(snapshot.messages.some((message) => message.agentId === agent.id)).toBe(false);
    expect(snapshot.runs.some((candidate) => candidate.agentId === agent.id)).toBe(false);
    expect(snapshot.traces.some((trace) => trace.agentId === agent.id)).toBe(false);
  });

  it("creates a completed trace with correlated spans", async () => {
    const { service, traces } = await makeServiceWithTraces();
    const agent = await service.createAgent({ name: "Trace test" });
    const { run } = await service.sendMessage(agent.id, "say hello");

    await expect.poll(() => traces.getTraceByRunId(run.id)?.status).toBe("completed");

    const trace = traces.getTraceByRunId(run.id);
    expect(trace).toMatchObject({
      runId: run.id,
      agentId: agent.id,
      status: "completed",
    });
    expect(trace?.spans).toHaveLength(2);
    const orchestration = trace?.spans.find((span) => span.type === "orchestration");
    const model = trace?.spans.find((span) => span.type === "model");
    expect(orchestration).toMatchObject({
      parentSpanId: null,
      name: "agent.run",
      status: "completed",
    });
    expect(model).toMatchObject({
      parentSpanId: orchestration?.id,
      name: "codex.run",
      status: "completed",
    });
  });

  it("records bounded runner-event counts and usage without raw thread data", async () => {
    const runner: AgentRunner = {
      run: async (_request, onEvent?: RunnerEventHandler) => {
        await onEvent?.({ kind: "thread_started", threadId: "thread-private" });
        await onEvent?.({ kind: "item_completed", itemType: "tool_call" });
        await onEvent?.({ kind: "item_completed", itemType: "tool_call" });
        await onEvent?.({
          kind: "turn_completed",
          usage: { inputTokens: 21, cachedInputTokens: 3, outputTokens: 8 },
        });
        await onEvent?.({ kind: "error" });
        return {
          output: "eventful result",
          threadId: "thread-private",
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, traces } = await makeServiceWithTraces(runner);
    const agent = await service.createAgent({ name: "Event metadata" });
    const { run } = await service.sendMessage(agent.id, "capture events");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).usage).toEqual({
      inputTokens: 21,
      cachedInputTokens: 3,
      outputTokens: 8,
    });
    expect(service.getAgent(agent.id).codexThreadId).toBe("thread-private");
    const modelSpan = traces
      .getTraceByRunId(run.id)
      ?.spans.find((span) => span.type === "model");
    expect(modelSpan?.metadata).toEqual({
      usage: {
        inputTokens: 21,
        cachedInputTokens: 3,
        outputTokens: 8,
      },
      itemCounts: { tool_call: 2 },
      errorCount: 1,
    });
    expect(JSON.stringify(modelSpan?.metadata)).not.toContain("thread-private");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Agent run integration failures", () => {
  it("keeps the Run lifecycle healthy when trace setup fails", async () => {
    const { service, traces } = await makeServiceWithTraces();
    vi.spyOn(traces, "startTrace").mockRejectedValueOnce(
      new Error("trace storage unavailable"),
    );
    const agent = await service.createAgent({ name: "Trace setup failure" });
    const { run } = await service.sendMessage(
      agent.id,
      "complete without tracing",
    );

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(traces.getTraceByRunId(run.id)).toBeNull();
  });

  it("lets stop win during the admission window before execution registration", async () => {
    let runnerCalled = false;
    const { service, store } = await makeServiceWithTraces({
      run: async () => {
        runnerCalled = true;
        return { output: "unexpected", threadId: "unexpected", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Admission race" });

    let signalAdmission!: () => void;
    let releaseAdmission!: () => void;
    const admissionReached = new Promise<void>((resolve) => {
      signalAdmission = resolve;
    });
    const admissionHeld = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let interceptNextMutation = true;
    const mutate = store.mutate.bind(store);
    vi.spyOn(store, "mutate").mockImplementation(
      async <T>(
        mutation: (database: Database) => T | Promise<T>,
      ): Promise<T> =>
        mutate(async (database) => {
          const result = await mutation(database);
          if (interceptNextMutation) {
            interceptNextMutation = false;
            signalAdmission();
            await admissionHeld;
          }
          return result;
        }),
    );

    const accepted = service.sendMessage(agent.id, "race with stop");
    await admissionReached;
    const stopping = service.stopAgent(agent.id);
    releaseAdmission();

    const [{ run }, stopped] = await Promise.all([accepted, stopping]);
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");
    expect(runnerCalled).toBe(false);
    expect(stopped).toMatchObject({ status: "stopped", lastError: null });
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
    ]);
  });

  it("does not rewrite a successful Run when trace finalization fails", async () => {
    const { service, traces } = await makeServiceWithTraces();
    const finalizeTrace = vi
      .spyOn(traces, "finalizeTrace")
      .mockRejectedValueOnce(new Error("trace finalization failed"));
    const agent = await service.createAgent({ name: "Trace finalization failure" });
    const { run } = await service.sendMessage(agent.id, "finish successfully");

    await expect.poll(() => finalizeTrace.mock.calls.length).toBe(1);

    expect(service.getRun(run.id)).toMatchObject({
      status: "completed",
      output: "Completed: finish successfully",
      error: null,
    });
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      lastError: null,
    });
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("records runner failures on the run, Agent, and trace", async () => {
    const { service, traces } = await makeServiceWithTraces({
      run: async () => {
        throw new Error("runner exploded");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failure test" });
    const { run } = await service.sendMessage(agent.id, "trigger failure");

    await expect.poll(() => traces.getTraceByRunId(run.id)?.status).toBe("failed");

    expect(service.getRun(run.id)).toMatchObject({
      status: "failed",
      error: "runner exploded",
    });
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "error",
      lastError: "runner exploded",
    });
    const trace = traces.getTraceByRunId(run.id);
    expect(trace?.spans).toHaveLength(2);
    expect(trace?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "orchestration", status: "failed", error: "Execution failed" }),
        expect.objectContaining({ type: "model", status: "failed", error: "Execution failed" }),
      ]),
    );
  });

  it("cancels a run while the model is active", async () => {
    let rejectRun!: (error: Error) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pending = new Promise<RunnerResult>((_resolve, reject) => {
      rejectRun = reject;
    });
    const { service, traces } = await makeServiceWithTraces({
      run: async () => {
        signalStarted();
        return pending;
      },
      cancel: async () => {
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Cancellation test" });
    const { run } = await service.sendMessage(agent.id, "long-running model");

    await started;
    const stopped = await service.stopAgent(agent.id);

    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      error: "Run cancelled",
    });
    expect(stopped).toMatchObject({ status: "stopped", lastError: null });
    const trace = traces.getTraceByRunId(run.id);
    expect(trace).toMatchObject({ status: "cancelled" });
    expect(trace?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "orchestration", status: "cancelled" }),
        expect.objectContaining({ type: "model", status: "cancelled" }),
      ]),
    );
  });

  it("cancels a run before invoking the model", async () => {
    let runnerCalled = false;
    const { service, traces } = await makeServiceWithTraces({
      run: async () => {
        runnerCalled = true;
        return { output: "unexpected", threadId: "unexpected", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Early cancellation test" });
    const { run } = await service.sendMessage(agent.id, "cancel immediately");
    const stopped = await service.stopAgent(agent.id);

    expect(runnerCalled).toBe(false);
    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      error: "Run cancelled",
    });
    expect(stopped.status).toBe("stopped");
    const trace = traces.getTraceByRunId(run.id);
    expect(trace).toMatchObject({ status: "cancelled" });
    expect(trace?.spans).toEqual([
      expect.objectContaining({ type: "orchestration", status: "cancelled" }),
    ]);
  });

  it("rechecks cancellation after model span creation before invoking the runner", async () => {
    let runnerCalled = false;
    let releaseModelSpan!: () => void;
    let signalModelSpanStarted!: () => void;
    let signalCancelAttempted!: () => void;
    const modelSpanStarted = new Promise<void>((resolve) => {
      signalModelSpanStarted = resolve;
    });
    const cancelAttempted = new Promise<void>((resolve) => {
      signalCancelAttempted = resolve;
    });
    const heldModelSpan = new Promise<void>((resolve) => {
      releaseModelSpan = resolve;
    });
    const { service, traces } = await makeServiceWithTraces({
      run: async () => {
        runnerCalled = true;
        return { output: "unexpected", threadId: "unexpected", usage: null };
      },
      cancel: async () => {
        signalCancelAttempted();
        return false;
      },
      isAvailable: async () => true,
    });
    const startSpan = traces.startSpan.bind(traces);
    vi.spyOn(traces, "startSpan").mockImplementation(async (input) => {
      if (input.type === "model") {
        signalModelSpanStarted();
        await heldModelSpan;
      }
      return startSpan(input);
    });
    const agent = await service.createAgent({ name: "Cancellation race test" });
    const { run } = await service.sendMessage(agent.id, "cancel during tracing");

    await modelSpanStarted;
    const stop = service.stopAgent(agent.id);
    await cancelAttempted;
    releaseModelSpan();
    const stopped = await stop;

    expect(runnerCalled).toBe(false);
    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      error: "Run cancelled",
    });
    expect(stopped).toMatchObject({ status: "stopped", lastError: null });
    const trace = traces.getTraceByRunId(run.id);
    expect(trace).toMatchObject({ status: "cancelled" });
    expect(trace?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "orchestration", status: "cancelled" }),
        expect.objectContaining({ type: "model", status: "cancelled" }),
      ]),
    );
  });

  it("never persists the exact configured API key from a runner failure", async () => {
    const { service, store } = await makeServiceWithTraces({
      run: async () => {
        throw new Error("Invalid API key provided: test-key");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Secret failure" });
    const { run } = await service.sendMessage(agent.id, "trigger secret error");

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    expect(service.getRun(run.id).error).toBe(
      "Invalid API key provided: [REDACTED]",
    );
    expect(service.getAgent(agent.id).lastError).toBe(
      "Invalid API key provided: [REDACTED]",
    );
    expect(JSON.stringify(store.snapshot())).not.toContain("test-key");
  });

  it("cancels active executions during graceful shutdown", async () => {
    let rejectRun!: (error: Error) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pending = new Promise<RunnerResult>((_resolve, reject) => {
      rejectRun = reject;
    });
    const { service, traces } = await makeServiceWithTraces({
      run: async () => {
        signalStarted();
        return pending;
      },
      cancel: async () => {
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Shutdown test" });
    const { run } = await service.sendMessage(agent.id, "long-running model");

    await started;
    await service.shutdown();

    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      error: "Run cancelled",
    });
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      lastError: null,
    });
    expect(traces.getTraceByRunId(run.id)).toMatchObject({
      status: "cancelled",
    });
  });
});

describe("Agent restart recovery", () => {
  it("uses the correlated terminal Run timestamp when repairing an open trace", async () => {
    const { service, traces, store, root, config } =
      await makeServiceWithTraces();
    const agent = await service.createAgent({ name: "Restart recovery" });
    const runId = "run-restart-terminal";
    const startedAt = "2026-08-31T00:00:00.000Z";
    const completedAt = "2026-08-31T00:00:02.000Z";
    await store.mutate((database) => {
      database.runs.push({
        id: runId,
        agentId: agent.id,
        status: "failed",
        prompt: "recover me",
        output: null,
        error: "provider failed",
        usage: null,
        startedAt,
        completedAt,
        createdAt: startedAt,
      });
    });
    const trace = await traces.startTrace({ agentId: agent.id, runId });
    const span = await traces.startSpan({
      traceId: trace.id,
      type: "model",
      name: "codex.run",
    });
    await store.mutate((database) => {
      const storedSpan = database.traces
        .find((candidate) => candidate.id === trace.id)
        ?.spans.find((candidate) => candidate.id === span.id);
      if (storedSpan) storedSpan.startedAt = startedAt;
    });

    const restartedStore = new JsonStore(path.join(root, "data", "db.json"));
    const restartedTraces = new TraceService(restartedStore, [
      config.arkApiKey,
      config.authToken,
    ]);
    const restartedService = new AgentService(
      config,
      restartedStore,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      restartedTraces,
    );
    await restartedService.initialize();

    const recovered = restartedTraces.getTrace(trace.id);
    expect(recovered).toMatchObject({ status: "failed", completedAt });
    expect(recovered.spans[0]).toMatchObject({
      status: "failed",
      completedAt,
      durationMs: 2_000,
    });
  });

  it("cancels active Runs and their traces while restoring a busy Agent", async () => {
    const { service, traces, store, root, config } =
      await makeServiceWithTraces();
    const agent = await service.createAgent({ name: "Active restart" });
    const runId = "run-restart-active";
    const startedAt = "2026-08-31T00:00:00.000Z";
    await store.mutate((database) => {
      const storedAgent = database.agents.find(
        (candidate) => candidate.id === agent.id,
      );
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        status: "running",
        prompt: "interrupted",
        output: null,
        error: null,
        usage: null,
        startedAt,
        completedAt: null,
        createdAt: startedAt,
      });
    });
    const trace = await traces.startTrace({ agentId: agent.id, runId });
    await traces.startSpan({
      traceId: trace.id,
      type: "orchestration",
      name: "agent.run",
    });

    const restartedStore = new JsonStore(path.join(root, "data", "db.json"));
    const restartedTraces = new TraceService(restartedStore, [
      config.arkApiKey,
      config.authToken,
    ]);
    const restartedService = new AgentService(
      config,
      restartedStore,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      restartedTraces,
    );
    await restartedService.initialize();

    const recoveredRun = restartedService.getRun(runId);
    expect(recoveredRun).toMatchObject({
      status: "cancelled",
      error: "Server restarted while this run was active",
    });
    expect(recoveredRun.completedAt).not.toBeNull();
    expect(restartedService.getAgent(agent.id).status).toBe("ready");
    expect(restartedTraces.getTrace(trace.id)).toMatchObject({
      status: "cancelled",
      completedAt: recoveredRun.completedAt,
      spans: [
        expect.objectContaining({
          status: "cancelled",
          completedAt: recoveredRun.completedAt,
        }),
      ],
    });
  });
});

describe("Agent shutdown safety", () => {
  it("checkpoints active work and reports a bounded cancellation timeout", async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const neverFinishes = new Promise<RunnerResult>(() => undefined);
    const { service, traces } = await makeServiceWithTraces({
      run: async () => {
        signalStarted();
        return neverFinishes;
      },
      cancel: async () => true,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Bounded shutdown" });
    const { run } = await service.sendMessage(agent.id, "never finish");
    await started;

    await expect(service.shutdown(5)).rejects.toThrow(
      "Timed out while cancelling active Agent runs",
    );

    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      error: "Server shut down before this run completed",
    });
    expect(service.getAgent(agent.id)).toMatchObject({
      status: "ready",
      lastError: null,
    });
    expect(traces.getTraceByRunId(run.id)).toMatchObject({
      status: "cancelled",
    });
  });

  it("surfaces cancellation transport failures after saving Run state", async () => {
    let rejectRun!: (error: Error) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pending = new Promise<RunnerResult>((_resolve, reject) => {
      rejectRun = reject;
    });
    const { service } = await makeServiceWithTraces({
      run: async () => {
        signalStarted();
        return pending;
      },
      cancel: async () => {
        rejectRun(new RunCancelledError());
        throw new Error("cancel transport failed");
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failed cancellation" });
    const { run } = await service.sendMessage(agent.id, "cancel me");
    await started;

    await expect(service.shutdown(1_000)).rejects.toThrow(
      "Failed to cancel active Agent runs",
    );
    expect(service.getRun(run.id).status).toBe("cancelled");
  });

  it("rejects new work after shutdown starts", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "No new work" });

    await service.shutdown();

    await expect(service.createAgent({ name: "Too late" })).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(service.sendMessage(agent.id, "too late")).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
