import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";
import { EarlyStoppingMonitor, type EarlyStoppingConfig } from "./early-stopping.js";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const captureMarker = `\n...[output truncated by Evidra at ${MAX_CAPTURE_BYTES} bytes]...\n`;

function appendCapture(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  // Keep both startup diagnostics and the final metric/reporting lines. A
  // bounded controller must never be able to OOM on a verbose worker.
  const encoded = Buffer.from(next, "utf8");
  const half = Math.floor((MAX_CAPTURE_BYTES - Buffer.byteLength(captureMarker)) / 2);
  let headEnd = half;
  let tailStart = encoded.length - half;
  // The cap is in bytes, not UTF-16 code units. Align both previews to UTF-8
  // boundaries so non-ASCII logs remain readable and obey the same limit.
  while (headEnd > 0 && (encoded[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  while (tailStart < encoded.length && (encoded[tailStart] & 0xc0) === 0x80) tailStart += 1;
  return encoded.subarray(0, headEnd).toString("utf8") + captureMarker + encoded.subarray(tailStart).toString("utf8");
}

/** Apply the same UTF-8 byte ceiling to captured file previews. */
export function boundProcessOutput(output: string): string {
  return appendCapture("", output);
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
    // Evidra does not expose a stdin payload for managed commands. Inherit no
    // open pipe: programs that accidentally omit an input path (e.g. `rg`)
    // must see EOF instead of hanging until the command timeout.
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let paused = false;
    let settled = false;
    let processExited = false;
    let processClosed = false;
    let cleanupComplete = false;
    let stopReason: "interrupted" | "timeout" | "early-stop" | "callback-error" | undefined;
    let exitCode: number | null = null;
    let callbackError: unknown;
    let earlyStopReason: string | undefined;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, signal); return true; }
      catch { try { return child.kill(signal); } catch { return false; } }
    };
    const removeHandlers = (): void => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      process.removeListener("SIGINT", signalHandler);
      process.removeListener("SIGTERM", signalHandler);
    };
    const finish = (): void => {
      // A result releases execution slots and permits retries. Do not publish
      // it while the leader or its remaining process group can still mutate
      // the workspace, even when the worker handles SIGTERM by exiting zero.
      if (settled || !processClosed || !cleanupComplete) return;
      settled = true;
      removeHandlers();
      if (stopReason === "callback-error") { reject(callbackError); return; }
      let resultCode = exitCode ?? 1;
      if (stopReason === "timeout") { resultCode = 124; stderr += "\nTimed out."; }
      else if (stopReason === "interrupted") { resultCode = 130; stderr += "\nInterrupted by Evidra."; }
      else if (stopReason === "early-stop") { resultCode = 1; stderr += `\nEarly stopped by Evidra: ${earlyStopReason}`; }
      resolve({ command, cwd, exitCode: resultCode, durationMs: Date.now() - started, stdout, stderr });
    };
    const stop = (reason: NonNullable<typeof stopReason>): void => {
      if (settled) return;
      // Preserve the first terminal cause; a late timeout or signal must not
      // rewrite cancellation or an early-stopping decision.
      stopReason ??= reason;
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (paused) { signalGroup("SIGCONT"); paused = false; }
      signalGroup("SIGTERM");
      if (!processExited && !forceTimer) {
        forceTimer = setTimeout(() => { forceTimer = undefined; signalGroup("SIGKILL"); }, 1_500);
      }
    };
    const control: ProcessControl = {
      pause: () => { if (!settled && !processExited && !stopReason && !paused) { signalGroup("SIGSTOP"); paused = true; } },
      resume: () => { if (!settled && !processExited && !stopReason && paused) { signalGroup("SIGCONT"); paused = false; } },
      terminate: () => { if (!settled && !processClosed) stop("interrupted"); },
      get paused() { return paused; },
    };
    const signalHandler = (): void => { if (!settled && !processClosed) stop("interrupted"); };
    const failCallback = (error: unknown): void => {
      callbackError = error;
      // Callback failures are controller failures, so reject after cleanup
      // rather than throwing from an event handler or leaving a detached child.
      stopReason = "callback-error";
      stop("callback-error");
    };
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    const earlyStoppingMonitor = earlyStopping?.enabled ? new EarlyStoppingMonitor(earlyStopping, earlyStopping.reference) : undefined;
    // Decode across pipe chunks so a split UTF-8 code point remains intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout = appendCapture(stdout, text);
      try {
        if (stopReason !== "callback-error") onOutput?.("stdout", text);
        if (earlyStoppingMonitor && !stopReason) {
          const decision = earlyStoppingMonitor.observe(text);
          if (decision.stop) { earlyStopReason = decision.reason; stop("early-stop"); }
        }
      } catch (error) { failCallback(error); }
    });
    child.stderr.on("data", (text: string) => {
      stderr = appendCapture(stderr, text);
      try { if (stopReason !== "callback-error") onOutput?.("stderr", text); }
      catch (error) { failCallback(error); }
    });
    child.on("error", (error) => {
      if (!child.pid) {
        if (settled) return;
        settled = true;
        removeHandlers();
        reject(error);
      } else failCallback(error);
    });
    child.on("exit", (code) => {
      processExited = true;
      exitCode = code;
      paused = false;
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = undefined; }
      // Launcher exit precedes pipe closure. Stop remaining descendants now,
      // then wait for escalation before releasing the execution slot.
      cleanupComplete = !signalGroup("SIGTERM");
      cleanupTimer = setTimeout(() => {
        cleanupTimer = undefined;
        signalGroup("SIGKILL");
        cleanupComplete = true;
        // A descendant that creates a new process group can still inherit our
        // pipes. Bound draining after group cleanup rather than waiting forever.
        if (!processClosed) { child.stdout.destroy(); child.stderr.destroy(); }
        finish();
      }, 500);
      finish();
    });
    child.on("close", (code) => {
      processClosed = true;
      exitCode ??= code;
      finish();
    });

    timer = setTimeout(() => stop("timeout"), timeoutMs);
    try { onProcess?.(control); } catch (error) { failCallback(error); }

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
