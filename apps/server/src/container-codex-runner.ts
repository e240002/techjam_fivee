import { execFile, spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import {
  buildCodexArgs,
  createRunnerEventDispatcher,
  parseCodexEventLine,
  waitForChildProcess,
} from "./codex-runner.js";
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

interface ActiveContainer {
  child: ChildProcess;
  containerName: string;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  processSettled: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
  forceKillTimer: NodeJS.Timeout | null;
}

interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
): string[] {
  const name = containerName(request.agentId, config.runtimeInstanceId);
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--workdir",
    "/workspace",
    config.containerRuntimeImage,
    "codex",
    ...buildCodexArgs(request, config.codexSandboxMode, "/workspace"),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active || active.processSettled) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = execFileAsync(
        this.config.containerEngine,
        ["rm", "--force", active.containerName],
        { timeout: 8_000, env: this.childEnvironment() },
      )
        .then(() => undefined)
        .catch(() => {
          active.child.kill("SIGTERM");
          if (!active.forceKillTimer) {
            active.forceKillTimer = setTimeout(
              () => active.child.kill("SIGKILL"),
              3_000,
            );
            active.forceKillTimer.unref();
          }
        });
    }
    return active.termination;
  }

  async run(
    request: RunnerRequest,
    onEvent?: RunnerEventHandler,
  ): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const child = spawn(
      this.config.containerEngine,
      buildContainerRunArgs(request, this.config),
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const completion = waitForChildProcess(child);
    const settled = completion.then(() => undefined);
    const active: ActiveContainer = {
      child,
      containerName: containerName(request.agentId, this.config.runtimeInstanceId),
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      processSettled: false,
      settled,
      termination: null,
      forceKillTimer: null,
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
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    };

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active);
        return;
      }
      if (target === "stdout") {
        stdout += stdoutDecoder.write(chunk);
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) enqueueEventLine(line);
      } else {
        appendStderr(stderrDecoder.write(chunk));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active);
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
      if (stdout.trim()) enqueueEventLine(stdout.trim());
      const terminalState = {
        cancelled: active.cancelled,
        timedOut: active.timedOut,
        outputExceeded: active.outputExceeded,
      };
      await events.drain();

      if (terminalState.cancelled) throw new RunCancelledError();
      if (terminalState.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
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
          this.config.containerEngine +
            " Runtime exited with code " +
            completionResult.exitCode +
            ": " +
            detail,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: parsed.usage };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
