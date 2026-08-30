import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { TraceService } from "./tracing/trace-service.js";

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
  const { rm } = await import("node:fs/promises");

  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

// CHANGED:
// traces can now optionally be injected for trace tests.
// Existing tests can still call makeService() exactly as before.
async function makeService(
  runner: AgentRunner = new FakeRunner(),
  traces: TraceService = new TraceService(),
): Promise<AgentService> {
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

  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    traces, // ADDED: inject the TraceService
  );

  await service.initialize();

  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });

    expect(service.listAgents()).toHaveLength(1);

    expect(
      (await service.updateAgent(agent.id, { description: "Builds apps" }))
        .description,
    ).toBe("Builds apps");

    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");

    await service.deleteAgent(agent.id);

    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });

    const { run } = await service.sendMessage(
      agent.id,
      "write hello world",
    );

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const messages = service.getMessages(agent.id);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);

    expect(messages[1]?.content).toContain("write hello world");

    expect(service.getAgent(agent.id).codexThreadId).toBe(
      "fake-thread",
    );
  });

  // ADDED: success trace test
  it("creates a completed trace with orchestration and model spans", async () => {
    // Create the TraceService ourselves so we can inspect it later.
    const traces = new TraceService();

    // Pass the same TraceService into AgentService.
    const service = await makeService(
      new FakeRunner(),
      traces,
    );

    const agent = await service.createAgent({
      name: "Trace Test Agent",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "say hello",
    );

    // sendMessage starts execution asynchronously,
    // so wait until the AgentRun has actually completed.
    await expect.poll(() => service.getRun(run.id).status).toBe(
      "completed",
    );

    // Get everything that TraceService recorded.
    const allTraces = traces.getTraces();

    // One AgentRun should have produced one Trace.
    expect(allTraces).toHaveLength(1);

    const trace = allTraces[0];

    // Log the trace for debugging purposes.
    console.log(JSON.stringify(trace, null, 2));

    expect(trace).toBeDefined();

    if (!trace) {
      throw new Error("Expected trace to exist");
    }

    // Verify Trace ↔ AgentRun ↔ Agent correlation.
    expect(trace.runId).toBe(run.id);
    expect(trace.agentId).toBe(agent.id);
    expect(trace.status).toBe("completed");

    // For now we expect exactly:
    //
    // Trace
    // └── agent.run
    //     └── codex.run
    expect(trace.spans).toHaveLength(2);

    const orchestrationSpan = trace.spans.find(
      (span) =>
        span.type === "orchestration" &&
        span.name === "agent.run",
    );

    const modelSpan = trace.spans.find(
      (span) =>
        span.type === "model" &&
        span.name === "codex.run",
    );

    // Both spans should exist.
    expect(orchestrationSpan).toBeDefined();
    expect(modelSpan).toBeDefined();

    if (!orchestrationSpan || !modelSpan) {
      throw new Error("Expected trace spans to exist");
    }

    // agent.run is the root span.
    expect(orchestrationSpan.parentSpanId).toBeNull();
    expect(orchestrationSpan.status).toBe("completed");
    expect(orchestrationSpan.completedAt).not.toBeNull();
    expect(orchestrationSpan.durationMs).not.toBeNull();

    // codex.run is a child of agent.run.
    expect(modelSpan.parentSpanId).toBe(
      orchestrationSpan.id,
    );

    expect(modelSpan.status).toBe("completed");
    expect(modelSpan.completedAt).not.toBeNull();
    expect(modelSpan.durationMs).not.toBeNull();
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
    const agent = await service.createAgent({
      name: "Concurrent",
    });

    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);

    const rejected = attempts.find(
      (attempt) => attempt.status === "rejected",
    );

    expect(rejected).toMatchObject({
      reason: { statusCode: 409 },
    });

    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({
      output: "done",
      threadId: "thread",
      usage: null,
    });

    const accepted = attempts.find(
      (attempt) => attempt.status === "fulfilled",
    );

    if (accepted?.status === "fulfilled") {
      await expect
        .poll(() => service.getRun(accepted.value.run.id).status)
        .toBe("completed");
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

    const agent = await service.createAgent({
      name: "Busy",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "first",
    );

    await expect(
      service.startAgent(agent.id),
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    await expect(
      service.sendMessage(agent.id, "second"),
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({
      output: "done",
      threadId: "thread",
      usage: null,
    });

    await expect.poll(() => service.getRun(run.id).status).toBe(
      "completed",
    );
  });
});