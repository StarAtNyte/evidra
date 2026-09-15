import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";
import { EarlyStoppingMonitor, type EarlyStoppingConfig } from "./early-stopping.js";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

function appendCapture(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  // Keep both startup diagnostics and the final metric/reporting lines. A
  // bounded controller must never be able to OOM on a verbose worker.
  const half = Math.floor(MAX_CAPTURE_BYTES / 2);
  const head = next.slice(0, half);
  const tail = next.slice(-half);
  return `${head}\n...[output truncated by Evidra at ${MAX_CAPTURE_BYTES} bytes]...\n${tail}`;
}

export interface ProcessControl {
  pause(): void;
  resume(): void;
  terminate(): void;
  readonly paused: boolean;
}

/** Convert a subprocess spawn error into evidence the recovery layer can classify. */
export function processFailureResult(command: string[], cwd: string, error: unknown): ProcessResult {
  return {
    command,
    cwd,
    exitCode: 127,
    durationMs: 0,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  };
}

export function runProcess(
  command: string[],
  cwd: string,
  timeoutMs = 15 * 60_000,
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
  onProcess?: (control: ProcessControl) => void,
  environment?: NodeJS.ProcessEnv,
  earlyStopping?: EarlyStoppingConfig & { reference: Array<{ step: number; metric: number }> },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // A detached process group lets interruption stop wrappers such as uv, python,
    // and evaluator subprocesses together instead of leaving grandchildren alive.
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: true, env: environment });
    let paused = false;
    let settled = false;
    let processExited = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already exited */ } }
    };
    const control: ProcessControl = {
      pause: () => { if (!settled && !paused) { signalGroup("SIGSTOP"); paused = true; } },
      resume: () => { if (!settled && paused) { signalGroup("SIGCONT"); paused = false; } },
      terminate: () => {
        if (settled || processExited) return;
        if (paused) signalGroup("SIGCONT");
        signalGroup("SIGTERM");
        if (!forceTimer) {
          forceTimer = setTimeout(() => {
            forceTimer = undefined;
            if (!processExited) signalGroup("SIGKILL");
          }, 1_500);
          forceTimer.unref();
        }
      },
      get paused() { return paused; },
    };
    const earlyStoppingMonitor = earlyStopping?.enabled ? new EarlyStoppingMonitor(earlyStopping, earlyStopping.reference) : undefined;
    let earlyStopReason: string | undefined;
    onProcess?.(control);
    let stdout = "";
    let stderr = "";

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(earlyStopReason ? { ...result, stderr: `${result.stderr}\nEarly stopped by Evidra: ${earlyStopReason}` } : result);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      reject(error);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString(); stdout = appendCapture(stdout, text); onOutput?.("stdout", text);
      if (earlyStoppingMonitor && !earlyStopReason) {
        const decision = earlyStoppingMonitor.observe(text);
        if (decision.stop) { earlyStopReason = decision.reason; control.terminate(); }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr = appendCapture(stderr, text); onOutput?.("stderr", text); });
    child.on("error", fail);
    child.on("close", (exitCode) => {
      processExited = true;
      if (forceTimer) clearTimeout(forceTimer);
      // A launcher such as uv, npm, or a shell can exit before descendants
      // have finished. They inherit this detached process group, so clean up
      // the group after the leader closes instead of returning while workers
      // continue consuming CPU or holding experiment resources.
      signalGroup("SIGTERM");
      cleanupTimer = setTimeout(() => {
        cleanupTimer = undefined;
        signalGroup("SIGKILL");
      }, 500);
      cleanupTimer.unref();
      finish({
        command,
        cwd,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });

    timer = setTimeout(() => {
      if (!processExited) {
        signalGroup("SIGTERM");
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          if (!processExited) signalGroup("SIGKILL");
        }, 1_500);
        forceTimer.unref();
      }
      finish({ command, cwd, exitCode: 124, durationMs: Date.now() - started, stdout, stderr: `${stderr}\nTimed out.` });
    }, timeoutMs);
  });
}

/** Small shell-free tokenizer for explicit TUI commands such as /run rg "foo bar". */
export function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; else current += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) { if (current) { tokens.push(current); current = ""; } continue; }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
