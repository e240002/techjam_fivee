import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const { execFileMock, spawnMock } = vi.hoisted(() => {
  return { execFileMock: vi.fn(), spawnMock: vi.fn() };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock,
  };
});

import {
  buildContainerRunArgs,
  ContainerCodexRunner,
  containerName,
} from "./container-codex-runner.js";
import { RunCancelledError } from "./errors.js";
import type { RunnerEvent } from "./types.js";

function createFakeChild(): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();

  Object.assign(child, {
    stdout,
    stderr,
    kill: vi.fn(),
  });

  return child as unknown as ChildProcess;
}

describe("Container Codex runner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    execFileMock.mockReset();
    spawnMock.mockReset();
  });

  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain(
      `type=bind,src=${config.codexHome},dst=/codex-home`,
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

  it("emits RunnerEvents while executing inside the container", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const events: RunnerEvent[] = [];
    const runPromise = runner.run(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "say hi",
        threadId: null,
      },
      (e) => {
        events.push(e);
      },
    );

    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({ type: "thread.started", thread_id: "thread-abc" }) + "\n",
      ),
    );
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Hi!" },
        }) + "\n",
      ),
    );
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 3, output_tokens: 2 },
        }) + "\n",
      ),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 0);

    const result = await runPromise;

    expect(events).toEqual([
      { kind: "thread_started", threadId: "thread-abc" },
      { kind: "item_completed", itemType: "agent_message" },
      { kind: "turn_completed", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    expect(result.output).toBe("Hi!");
    expect(result.threadId).toBe("thread-abc");
  });

  it("emits the final event even when the last line has no trailing newline", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const events: RunnerEvent[] = [];
    const runPromise = runner.run(
      {
        agentId: "agent-2",
        workspacePath: "/tmp/workspace",
        prompt: "say hi",
        threadId: null,
      },
      (e) => {
        events.push(e);
      },
    );

    // No trailing newline: this relies on the close handler flushing the event.
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Flushed." },
        }),
      ),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 0);

    await runPromise;

    expect(events).toContainEqual({
      kind: "item_completed",
      itemType: "agent_message",
    });
  });

  it("awaits asynchronous observers in event order", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const runPromise = runner.run(
      {
        agentId: "agent-ordered",
        workspacePath: "/tmp/workspace",
        prompt: "say hi",
        threadId: null,
      },
      async (event) => {
        order.push("start:" + event.kind);
        if (event.kind === "thread_started") {
          signalFirstStarted();
          await firstBlocked;
        }
        order.push("end:" + event.kind);
      },
    );

    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-ordered" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Done." },
          }),
        ].join("\n") + "\n",
      ),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 0);

    await firstStarted;
    expect(order).toEqual(["start:thread_started"]);
    releaseFirst();
    await runPromise;
    expect(order).toEqual([
      "start:thread_started",
      "end:thread_started",
      "start:item_completed",
      "end:item_completed",
    ]);
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const runPromise = runner.run({
      agentId: "agent-unicode",
      workspacePath: "/tmp/workspace",
      prompt: "say hi",
      threadId: null,
    });
    const payload = Buffer.from(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "你好" },
      }) + "\n",
    );
    const splitAt = payload.indexOf(Buffer.from("好")) + 1;
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      payload.subarray(0, splitAt),
    );
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      payload.subarray(splitAt),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 0);

    await expect(runPromise).resolves.toEqual(
      expect.objectContaining({ output: "你好" }),
    );
  });

  it("bounds observer drain after container completion", async () => {
    vi.useFakeTimers();
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CODEX_TIMEOUT_MS: "1000",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    let signalObserverStarted!: () => void;
    let releaseObserver!: () => void;
    const observerStarted = new Promise<void>((resolve) => {
      signalObserverStarted = resolve;
    });
    const observerBlocked = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const observedKinds: string[] = [];
    const runPromise = runner.run(
      {
        agentId: "agent-bounded-observer",
        workspacePath: "/tmp/workspace",
        prompt: "say hi",
        threadId: null,
      },
      async (event) => {
        observedKinds.push(event.kind);
        if (event.kind === "thread_started") {
          signalObserverStarted();
          await observerBlocked;
        }
      },
    );

    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Done." },
          }),
        ].join("\n") + "\n",
      ),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 0);

    await observerStarted;
    expect(await runner.cancel("agent-bounded-observer")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(runPromise).resolves.toEqual(
      expect.objectContaining({ output: "Done." }),
    );
    releaseObserver();
    await Promise.resolve();
    await Promise.resolve();
    expect(observedKinds).toEqual(["thread_started"]);
  });

  it("prioritizes cancellation when container termination emits an error", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === "function") callback(null, "", "");
    });
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const runPromise = runner.run({
      agentId: "agent-cancel-error",
      workspacePath: "/tmp/workspace",
      prompt: "cancel",
      threadId: null,
    });
    const cancelPromise = runner.cancel("agent-cancel-error");
    (fakeChild as unknown as EventEmitter).emit(
      "error",
      new Error("container termination failed"),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 1);

    await expect(cancelPromise).resolves.toBe(true);
    await expect(runPromise).rejects.toBeInstanceOf(RunCancelledError);
  });

  it("sanitizes container process errors with configured secrets", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      ARK_API_KEY: "bare-secret-value",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const runPromise = runner.run({
      agentId: "agent-spawn-error",
      workspacePath: "/tmp/workspace",
      prompt: "fail",
      threadId: null,
    });
    (fakeChild as unknown as EventEmitter).emit(
      "error",
      new Error("Invalid API key provided: bare-secret-value"),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 1);

    const error = await runPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain("bare-secret-value");
  });

  it("redacts stderr before exposing a container runner failure", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      ARK_API_KEY: "must-not-leak",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const runPromise = runner.run({
      agentId: "agent-error",
      workspacePath: "/tmp/workspace",
      prompt: "fail",
      threadId: null,
    });
    (fakeChild.stderr as unknown as EventEmitter).emit(
      "data",
      Buffer.from("Invalid API key provided: must-not-leak"),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 1);

    const error = await runPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[REDACTED]");
    expect((error as Error).message).not.toContain("must-not-leak");
  });

  it("still works with no onEvent callback passed", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const runner = new ContainerCodexRunner(config);
    const fakeChild = createFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const runPromise = runner.run({
      agentId: "agent-3",
      workspacePath: "/tmp/workspace",
      prompt: "say hi",
      threadId: null,
    });

    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "OK." },
        }) + "\n",
      ),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 0);

    await expect(runPromise).resolves.toEqual(
      expect.objectContaining({ output: "OK." }),
    );
  });
});
