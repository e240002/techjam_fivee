import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

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
  buildCodexArgs,
  CodexRunner,
  parseCodexEventLine,
} from "./codex-runner.js";
import type { RunnerEvent } from "./types.js";

function createFakeChild(): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();

  Object.assign(child, {
    stdout,
    stderr,
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  });

  return child as unknown as ChildProcess;
}

describe("Codex runner protocol", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", async () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    await parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    await parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    await parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("emits a thread_started event with its thread ID", async () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const events: RunnerEvent[] = [];
    await parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
      (event) => {
        events.push(event);
      },
    );
    expect(events).toEqual([
      { kind: "thread_started", threadId: "thread-123" },
    ]);
  });

  it("redacts error details before retaining them internally", async () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const events: RunnerEvent[] = [];
    await parseCodexEventLine(
      JSON.stringify({ type: "error", message: "API_KEY=some-sensitive-detail" }),
      parsed,
      (e) => {
        events.push(e);
      },
    );
    expect(events).toEqual([{ kind: "error" }]); // no `message` key at all
    expect(parsed.errors).toEqual(["API_KEY=[REDACTED]"]);
  });

  it("reports item type but not text for non-agent_message items", async () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const events: RunnerEvent[] = [];
    await parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "some_other_type", text: "should not leak" },
      }),
      parsed,
      (e) => {
        events.push(e);
      },
    );
    expect(events).toEqual([
      { kind: "item_completed", itemType: "some_other_type" },
    ]);
    expect(parsed.messages).toEqual([]); // confirms it wasn't mistaken for agent_message
  });

  it("still works with no onEvent callback passed", async () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    await expect(
      parseCodexEventLine(
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } }),
        parsed,
      ),
    ).resolves.toBeUndefined();
    expect(parsed.usage).toEqual({ inputTokens: 5 });
  });

  it("does not let a rejecting onEvent callback break parsing", async () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    await expect(
      parseCodexEventLine(
        JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
        parsed,
        async () => {
          throw new Error("tracing layer blew up");
        },
      ),
    ).resolves.toBeUndefined();
    expect(parsed.threadId).toBe("thread-123");
  });

  it("does not let an observer mutate the final usage", async () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };

    await parseCodexEventLine(
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } }),
      parsed,
      (event) => {
        if (event.kind === "turn_completed") event.usage.inputTokens = 999;
      },
    );

    expect(parsed.usage).toEqual({ inputTokens: 5 });
  });

  it("awaits asynchronous observers in event order", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
    });
    const runner = new CodexRunner(config);
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

  it("redacts stderr before exposing a runner failure", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
    });
    const runner = new CodexRunner(config);
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
      Buffer.from("ARK_API_KEY=must-not-leak"),
    );
    (fakeChild as unknown as EventEmitter).emit("close", 1);

    const error = await runPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ARK_API_KEY=[REDACTED]");
    expect((error as Error).message).not.toContain("must-not-leak");
  });
});
