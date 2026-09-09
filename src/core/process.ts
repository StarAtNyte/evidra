import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";

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

export function runProcess(
  command: string[],
  cwd: string,
  timeoutMs = 15 * 60_000,
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
  onProcess?: (control: ProcessControl) => void,
  environment?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // A detached process group lets interruption stop wrappers such as uv, python,
    // and evaluator subprocesses together instead of leaving grandchildren alive.
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, detached: true, env: environment });
    let paused = false;
    let settled = false;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already exited */ } }
    };
    const control: ProcessControl = {
      pause: () => { if (!settled && !paused) { signalGroup("SIGSTOP"); paused = true; } },
      resume: () => { if (!settled && paused) { signalGroup("SIGCONT"); paused = false; } },
      terminate: () => { if (!settled) { if (paused) signalGroup("SIGCONT"); signalGroup("SIGTERM"); } },
      get paused() { return paused; },
    };
    onProcess?.(control);
    let stdout = "";
    let stderr = "";

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString(); stdout = appendCapture(stdout, text); onOutput?.("stdout", text); });
    child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr = appendCapture(stderr, text); onOutput?.("stderr", text); });
    child.on("error", reject);
    child.on("close", (exitCode) => finish({
      command,
      cwd,
      exitCode: exitCode ?? 1,
      durationMs: Date.now() - started,
      stdout,
      stderr,
    }));

    const timer = setTimeout(() => {
      signalGroup("SIGTERM");
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
