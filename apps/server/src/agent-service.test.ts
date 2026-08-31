import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import { TraceService } from "./tracing/trace-service.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
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
): Promise<{ service: AgentService; traces: TraceService }> {
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
  const traces = new TraceService(store);
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    traces,
  );
  await service.initialize();
  return { service, traces };
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

  it("does not rewrite a successful Run when trace finalization fails", async () => {
    const { service, traces } = await makeServiceWithTraces();
    const endTrace = vi
      .spyOn(traces, "endTrace")
      .mockRejectedValueOnce(new Error("trace finalization failed"));
    const agent = await service.createAgent({ name: "Trace finalization failure" });
    const { run } = await service.sendMessage(agent.id, "finish successfully");

    await expect.poll(() => endTrace.mock.calls.length).toBe(1);

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
