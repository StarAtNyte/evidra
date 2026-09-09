import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";

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
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), { cwd, shell: false });
    let paused = false;
    let settled = false;
    const control: ProcessControl = {
      pause: () => { if (!settled && !paused) { child.kill("SIGSTOP"); paused = true; } },
      resume: () => { if (!settled && paused) { child.kill("SIGCONT"); paused = false; } },
      terminate: () => { if (!settled) child.kill("SIGTERM"); },
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

    child.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString(); stdout += text; onOutput?.("stdout", text); });
    child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr += text; onOutput?.("stderr", text); });
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
      child.kill("SIGTERM");
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
