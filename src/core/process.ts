import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";

export function runProcess(command: string[], cwd: string, timeoutMs = 15 * 60_000): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
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
