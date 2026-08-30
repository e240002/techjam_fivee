import { describe, expect, it } from "vitest";
import { buildCodexArgs, parseCodexEventLine } from "./codex-runner.js";
import type { RunnerEvent } from "./types.js";

describe("Codex runner protocol", () => {
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

  it("extracts the session, final message and usage", () => {
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
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
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

  it("emits a thread_started event with no payload beyond kind", () => {
  const parsed = { messages: [], threadId: null, usage: null, errors: [] };
  const events: RunnerEvent[] = [];
  parseCodexEventLine(
    JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
    parsed,
    (e) => events.push(e),
  );
  expect(events).toEqual([{ kind: "thread_started", threadId: "thread-123" }]);
 });

  it("never puts the error message into the emitted event", () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const events: RunnerEvent[] = [];
    parseCodexEventLine(
      JSON.stringify({ type: "error", message: "some sensitive detail" }),
      parsed,
      (e) => events.push(e),
    );
    expect(events).toEqual([{ kind: "error" }]); // no `message` key at all
    expect(parsed.errors).toEqual(["some sensitive detail"]); // still fine to keep internally
  });

  it("reports item type but not text for non-agent_message items", () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const events: RunnerEvent[] = [];
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "some_other_type", text: "should not leak" },
      }),
      parsed,
      (e) => events.push(e),
    );
    expect(events).toEqual([{ kind: "item_completed", itemType: "some_other_type" }]);
    expect(parsed.messages).toEqual([]); // confirms it wasn't mistaken for agent_message
  });

  it("still works with no onEvent callback passed", () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    expect(() =>
      parseCodexEventLine(
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } }),
        parsed,
      ),
    ).not.toThrow();
    expect(parsed.usage).toEqual({ inputTokens: 5 });
  });

  it("does not let a throwing onEvent callback break parsing", () => {
  const parsed = { messages: [], threadId: null, usage: null, errors: [] };
  expect(() =>
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
      () => {
        throw new Error("tracing layer blew up");
      },
    ),
  ).not.toThrow();
  expect(parsed.threadId).toBe("thread-123"); // parsing still completed correctly
  });
});



