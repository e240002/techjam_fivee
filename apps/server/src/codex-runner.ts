import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { sanitizeText } from "./tracing/redaction.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerEventHandler,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);
const RUNNER_EVENT_DRAIN_TIMEOUT_MS = 1_000;

export interface ChildProcessCompletion {
  exitCode: number;
  error: unknown | null;
}

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}
export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

async function emitRunnerEvent(
  onEvent: RunnerEventHandler | undefined,
  event: Parameters<RunnerEventHandler>[0],
): Promise<void> {
  if (!onEvent) return;

  try {
    await onEvent(event);
  } catch {
    // Observability must not break Codex execution.
  }
}

export function createRunnerEventDispatcher(
  onEvent?: RunnerEventHandler,
): { dispatch: RunnerEventHandler; drain: () => Promise<void> } {
  let accepting = true;
  let queue: Promise<void> = Promise.resolve();

  const dispatch: RunnerEventHandler = (event) => {
    if (!accepting || !onEvent) return;
    queue = queue.then(() => emitRunnerEvent(onEvent, event));
  };

  return {
    dispatch,
    async drain(): Promise<void> {
      if (!onEvent) return;

      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        queue.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            RUNNER_EVENT_DRAIN_TIMEOUT_MS,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained) accepting = false;
    },
  };
}

export function waitForChildProcess(
  child: ChildProcess,
): Promise<ChildProcessCompletion> {
  return new Promise((resolve) => {
    let childError: unknown | null = null;
    child.once("error", (error) => {
      childError = error;
    });
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, error: childError });
    });
  });
}

export async function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onEvent?: RunnerEventHandler,
  sensitiveValues: readonly string[] = [],
): Promise<void> {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    await emitRunnerEvent(onEvent, {
      kind: "thread_started",
      threadId: event.thread_id,
    });
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
    if (typeof item.type === "string") {
      await emitRunnerEvent(onEvent, {
        kind: "item_completed",
        itemType: item.type,
      });
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    const parsedUsage: RunUsage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
    parsed.usage = parsedUsage;
    await emitRunnerEvent(onEvent, {
      kind: "turn_completed",
      usage: { ...parsedUsage },
    });
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(sanitizeText(message, sensitiveValues));
    await emitRunnerEvent(onEvent, { kind: "error" });
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      processSettled: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active || active.processSettled) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(
    request: RunnerRequest,
    onEvent?: RunnerEventHandler,
  ): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const completion = waitForChildProcess(child);
    const settled = completion.then(() => undefined);
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      processSettled: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const sensitiveValues = [this.config.arkApiKey, this.config.authToken];
    const events = createRunnerEventDispatcher(onEvent);

    const enqueueEventLine = (line: string): void => {
      void parseCodexEventLine(
        line,
        parsed,
        events.dispatch,
        sensitiveValues,
      );
    };

    const appendStderr = (text: string): void => {
      stderr = sanitizeText(stderr + text, sensitiveValues);
      if (stderr.length > 16_384) {
        stderr = stderr.slice(-16_384);
      }
    };

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += stdoutDecoder.write(chunk);
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          enqueueEventLine(line);
        }
      } else {
        appendStderr(stderrDecoder.write(chunk));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const completionResult = await completion;
      active.processSettled = true;
      clearTimeout(timeout);
      if (active.forceKillTimer) {
        clearTimeout(active.forceKillTimer);
        active.forceKillTimer = null;
      }

      stdout += stdoutDecoder.end();
      appendStderr(stderrDecoder.end());
      if (stdout.trim()) {
        enqueueEventLine(stdout.trim());
      }
      const terminalState = {
        cancelled: active.cancelled,
        timedOut: active.timedOut,
        outputExceeded: active.outputExceeded,
      };
      await events.drain();

      if (terminalState.cancelled) {
        throw new RunCancelledError();
      }
      if (terminalState.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (terminalState.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (completionResult.error !== null) {
        const message =
          completionResult.error instanceof Error
            ? completionResult.error.message
            : String(completionResult.error);
        throw new Error(sanitizeText(message, sensitiveValues));
      }
      if (completionResult.exitCode !== 0) {
        const detail = sanitizeText(
          parsed.errors.at(-1) || stderr.trim() || "No error detail",
          sensitiveValues,
        );
        throw new Error(
          "Codex exited with code " + completionResult.exitCode + ": " + detail,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
