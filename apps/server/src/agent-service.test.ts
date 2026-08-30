import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import { TraceService } from "./tracing/trace-service.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
      },
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
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  traces: TraceService = new TraceService(),
): Promise<AgentService> {
  const root = await mkdtemp(
    path.join(tmpdir(), "launchpad-test-"),
  );

  temporaryDirectories.push(root);

  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(
      root,
      "workspaces",
    ),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });

  const service = new AgentService(
    config,
    new JsonStore(
      path.join(root, "data", "db.json"),
    ),
    new WorkspaceManager(
      path.join(root, "workspaces"),
    ),
    runner,
    traces,
  );

  await service.initialize();

  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();

    const agent = await service.createAgent({
      name: "Builder",
    });

    expect(service.listAgents()).toHaveLength(1);

    expect(
      (
        await service.updateAgent(agent.id, {
          description: "Builds apps",
        })
      ).description,
    ).toBe("Builds apps");

    expect(
      (await service.stopAgent(agent.id)).status,
    ).toBe("stopped");

    expect(
      (await service.startAgent(agent.id)).status,
    ).toBe("ready");

    await service.deleteAgent(agent.id);

    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();

    const agent = await service.createAgent({
      name: "Coder",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "write hello world",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");

    const messages = service.getMessages(agent.id);

    expect(
      messages.map((message) => message.role),
    ).toEqual(["user", "assistant"]);

    expect(messages[1]?.content).toContain(
      "write hello world",
    );

    expect(
      service.getAgent(agent.id).codexThreadId,
    ).toBe("fake-thread");
  });

  it("creates a completed trace with orchestration and model spans", async () => {
    const traces = new TraceService();

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

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");

    const allTraces = traces.getTraces();

    expect(allTraces).toHaveLength(1);

    const trace = allTraces[0];

    // Log the completed trace for debugging purposes. (DELETE in production)
    console.log(
      "COMPLETED TRACE:",
      JSON.stringify(trace, null, 2),
    );

    expect(trace).toBeDefined();

    if (!trace) {
      throw new Error(
        "Expected completed trace to exist",
      );
    }

    // Trace ↔ AgentRun ↔ Agent correlation
    expect(trace.runId).toBe(run.id);
    expect(trace.agentId).toBe(agent.id);

    expect(trace.status).toBe("completed");
    expect(trace.completedAt).not.toBeNull();

    // Current basic tree:
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

    expect(orchestrationSpan).toBeDefined();
    expect(modelSpan).toBeDefined();

    if (!orchestrationSpan || !modelSpan) {
      throw new Error(
        "Expected completed trace spans to exist",
      );
    }

    // agent.run is the root span
    expect(
      orchestrationSpan.parentSpanId,
    ).toBeNull();

    expect(orchestrationSpan.status).toBe(
      "completed",
    );

    expect(
      orchestrationSpan.completedAt,
    ).not.toBeNull();

    expect(
      orchestrationSpan.durationMs,
    ).not.toBeNull();

    expect(orchestrationSpan.error).toBeNull();

    // codex.run belongs under agent.run
    expect(modelSpan.parentSpanId).toBe(
      orchestrationSpan.id,
    );

    expect(modelSpan.status).toBe("completed");

    expect(
      modelSpan.completedAt,
    ).not.toBeNull();

    expect(
      modelSpan.durationMs,
    ).not.toBeNull();

    expect(modelSpan.error).toBeNull();
  });

  it("creates a failed trace when model execution fails", async () => {
    const traces = new TraceService();

    const failingRunner: AgentRunner = {
      run: async () => {
        throw new Error("Fake Codex failure");
      },

      cancel: async () => false,

      isAvailable: async () => true,
    };

    const service = await makeService(
      failingRunner,
      traces,
    );

    const agent = await service.createAgent({
      name: "Failure Test Agent",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "make this fail",
    );

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("failed");

    const allTraces = traces.getTraces();

    expect(allTraces).toHaveLength(1);

    const trace = allTraces[0];

    // Log the failed trace for debugging purposes. (DELETE in production)
    console.log(
      "FAILED TRACE:",
      JSON.stringify(trace, null, 2),
    );

    expect(trace).toBeDefined();

    if (!trace) {
      throw new Error(
        "Expected failed trace to exist",
      );
    }

    expect(trace.runId).toBe(run.id);
    expect(trace.agentId).toBe(agent.id);

    expect(trace.status).toBe("failed");
    expect(trace.completedAt).not.toBeNull();

    // runner.run() started before failing,
    // therefore both spans should exist.
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

    expect(orchestrationSpan).toBeDefined();
    expect(modelSpan).toBeDefined();

    if (!orchestrationSpan || !modelSpan) {
      throw new Error(
        "Expected failed trace spans to exist",
      );
    }

    expect(
      orchestrationSpan.parentSpanId,
    ).toBeNull();

    expect(modelSpan.parentSpanId).toBe(
      orchestrationSpan.id,
    );

    expect(orchestrationSpan.status).toBe(
      "failed",
    );

    expect(modelSpan.status).toBe("failed");

    // Trace uses safe generic errors for now.
    expect(orchestrationSpan.error).toBe(
      "Execution failed",
    );

    expect(modelSpan.error).toBe(
      "Execution failed",
    );

    expect(
      orchestrationSpan.completedAt,
    ).not.toBeNull();

    expect(
      modelSpan.completedAt,
    ).not.toBeNull();

    expect(
      orchestrationSpan.durationMs,
    ).not.toBeNull();

    expect(
      modelSpan.durationMs,
    ).not.toBeNull();

    // Existing CodeJam AgentRun behavior
    // should still preserve the original error.
    expect(
      service.getRun(run.id).error,
    ).toBe("Fake Codex failure");
  });

  it("creates a cancelled trace when model execution is cancelled", async () => {
    const traces = new TraceService();

    let rejectRun!: (error: Error) => void;
    let markStarted!: () => void;

    // Lets the test know that runner.run()
    // has definitely started.
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    // Fake long-running model execution.
    // It stays pending until cancel() rejects it.
    const pendingRun = new Promise<RunnerResult>(
      (_resolve, reject) => {
        rejectRun = reject;
      },
    );

    const cancellableRunner: AgentRunner = {
      run: () => {
        markStarted();

        return pendingRun;
      },

      cancel: async () => {
        rejectRun(new RunCancelledError());

        return true;
      },

      isAvailable: async () => true,
    };

    const service = await makeService(
      cancellableRunner,
      traces,
    );

    const agent = await service.createAgent({
      name: "Cancellation Test Agent",
    });

    const { run } = await service.sendMessage(
      agent.id,
      "long running task",
    );

    // Wait until the fake model has actually started.
    // At this point:
    //
    // Trace
    // └── agent.run [running]
    //     └── codex.run [running]
    await started;

    // stopAgent() triggers:
    //
    // cancelExecution()
    // → runner.cancel()
    // → RunCancelledError
    // → executeRun() catch block
    await service.stopAgent(agent.id);

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("cancelled");

    const allTraces = traces.getTraces();

    expect(allTraces).toHaveLength(1);

    const trace = allTraces[0];

    // Log the cancelled trace for debugging purposes. (DELETE in production)
    console.log(
      "CANCELLED TRACE:",
      JSON.stringify(trace, null, 2),
    );

    expect(trace).toBeDefined();

    if (!trace) {
      throw new Error(
        "Expected cancelled trace to exist",
      );
    }

    expect(trace.runId).toBe(run.id);
    expect(trace.agentId).toBe(agent.id);

    expect(trace.status).toBe("cancelled");
    expect(trace.completedAt).not.toBeNull();

    // The model had already started,
    // so both spans should exist.
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

    expect(orchestrationSpan).toBeDefined();
    expect(modelSpan).toBeDefined();

    if (!orchestrationSpan || !modelSpan) {
      throw new Error(
        "Expected cancelled trace spans to exist",
      );
    }

    expect(
      orchestrationSpan.parentSpanId,
    ).toBeNull();

    expect(modelSpan.parentSpanId).toBe(
      orchestrationSpan.id,
    );

    expect(orchestrationSpan.status).toBe(
      "cancelled",
    );

    expect(modelSpan.status).toBe(
      "cancelled",
    );

    expect(orchestrationSpan.error).toBe(
      "Run cancelled",
    );

    expect(modelSpan.error).toBe(
      "Run cancelled",
    );

    expect(
      orchestrationSpan.completedAt,
    ).not.toBeNull();

    expect(
      modelSpan.completedAt,
    ).not.toBeNull();

    expect(
      orchestrationSpan.durationMs,
    ).not.toBeNull();

    expect(
      modelSpan.durationMs,
    ).not.toBeNull();

    // stopAgent() should leave the Agent stopped.
    expect(
      service.getAgent(agent.id).status,
    ).toBe("stopped");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;

    const pending = new Promise<RunnerResult>(
      (resolve) => {
        finish = resolve;
      },
    );

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
      attempts.filter(
        (attempt) =>
          attempt.status === "fulfilled",
      ),
    ).toHaveLength(1);

    const rejected = attempts.find(
      (attempt) =>
        attempt.status === "rejected",
    );

    expect(rejected).toMatchObject({
      reason: {
        statusCode: 409,
      },
    });

    expect(
      service.getMessages(agent.id),
    ).toHaveLength(1);

    finish({
      output: "done",
      threadId: "thread",
      usage: null,
    });

    const accepted = attempts.find(
      (attempt) =>
        attempt.status === "fulfilled",
    );

    if (accepted?.status === "fulfilled") {
      await expect
        .poll(
          () =>
            service.getRun(
              accepted.value.run.id,
            ).status,
        )
        .toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;

    const pending = new Promise<RunnerResult>(
      (resolve) => {
        finish = resolve;
      },
    );

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
      service.sendMessage(
        agent.id,
        "second",
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({
      output: "done",
      threadId: "thread",
      usage: null,
    });

    await expect
      .poll(() => service.getRun(run.id).status)
      .toBe("completed");
  });
});