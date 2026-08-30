import { describe, expect, it, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { loadConfig } from "./config.js";
import type { RunnerEvent } from "./types.js";

const { spawnMock } = vi.hoisted(() => {
  return { spawnMock: vi.fn() };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  buildContainerRunArgs,
  containerName,
  ContainerCodexRunner,
} from "./container-codex-runner.js";

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
    vi.restoreAllMocks();
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
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
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
      (e) => events.push(e),
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
      { kind: "thread_started" },
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
      (e) => events.push(e),
    );

    // no trailing "\n" here — relies on the flush-on-close call passing onEvent
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

    expect(events).toContainEqual({ kind: "item_completed", itemType: "agent_message" });
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