import { spawn, spawnSync } from "node:child_process";
import type { AgentResult, AgentTask } from "../core/types.js";
import type { ProcessControl } from "../core/process.js";

export type AgentProvider = "codex" | "local";

export interface ExecAgentOptions {
  provider: AgentProvider;
  model: string;
  cwd: string;
  reasoningEffort?: string;
  sandbox?: "read-only" | "workspace-write";
  onThread?: (threadId: string) => void;
}

export function queueCodexMessage(threadId: string, message: string): boolean {
  const result = spawnSync("codex", ["queue", "--thread", threadId, "--message", message], { stdio: "ignore" });
  return result.status === 0;
}

export interface AvailableModel {
  id: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

export function loginCodex(mode: "device" | "browser" = "device"): number {
  const args = mode === "device" ? ["login", "--device-auth"] : ["login"];
  const result = spawnSync("codex", args, { stdio: "inherit" });
  return result.status ?? 1;
}

export function codexLoginStatus(): string {
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function codexIsLoggedIn(): boolean {
  return spawnSync("codex", ["login", "status"], { stdio: "ignore" }).status === 0;
}

export function listCodexModels(): Promise<AvailableModel[]> {
  if (!codexIsLoggedIn()) return Promise.reject(new Error("Codex is not logged in. Use /login codex first."));
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Timed out while loading Codex models."))), 12_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { id?: number; result?: { data?: AvailableModel[] }; error?: { message?: string } };
          if (event.id !== 2) continue;
          if (event.error) finish(() => reject(new Error(event.error?.message ?? "Codex model listing failed.")));
          else finish(() => resolve(event.result?.data ?? []));
          return;
        } catch {
          // App-server emits one JSON object per line; ignore startup noise.
        }
      }
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (!settled) finish(() => reject(new Error(`Codex model listing exited with ${code ?? 1}.`)));
    });
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "evidra", version: "0.1.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: "model/list", id: 2, params: { includeHidden: true } })}\n`);
  });
}

export async function listLocalModels(): Promise<AvailableModel[]> {
  const response = await fetch(`${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}/api/tags`);
  if (!response.ok) throw new Error(`Local Ollama is unavailable (${response.status}). Start Ollama and try again.`);
  const payload = await response.json() as { models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string } }> };
  return (payload.models ?? []).map((entry) => {
    const id = entry.name ?? entry.model ?? "";
    return { id, displayName: id, description: entry.details?.parameter_size ? `Ollama · ${entry.details.parameter_size}` : "Ollama local model" };
  }).filter((model) => model.id);
}

export async function checkProvider(options: ExecAgentOptions): Promise<void> {
  if (options.provider === "codex") {
    if (!codexIsLoggedIn()) throw new Error("Codex is not logged in. Use /login codex to sign in with your ChatGPT subscription.");
    return;
  }

  const response = await fetch(`${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}/api/tags`);
  if (!response.ok) throw new Error(`Local Ollama is unavailable (${response.status}). Start Ollama and try again.`);
  const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  const models = payload.models ?? [];
  if (!models.some((entry) => entry.name === options.model || entry.model === options.model)) {
    const available = models.map((entry) => entry.name ?? entry.model).filter(Boolean).join(", ");
    throw new Error(`Local model '${options.model}' is not installed. Available models: ${available || "none"}.`);
  }
}

export class CodexExecAgent {
  constructor(private readonly options: ExecAgentOptions) {}

  run(task: AgentTask, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void): Promise<AgentResult> {
    const prompt = `${task.objective}\n\nResearch context:\n${JSON.stringify(task.context, null, 2)}\n\n` +
      "You are Evidra, the research and experimentation workbench assistant. The selected provider is only an implementation detail; never introduce yourself as Codex, OpenAI, Ollama, or another underlying model. " +
      (task.role === "research director" ? "Act as Evidra's research director. " : "Act as Evidra's conversational assistant. ") +
      "Return a concise, evidence-oriented answer. " +
      "Do not submit anything or expose credentials.";
    if (this.options.provider === "local") return this.runOllama(prompt, onProgress, onProcess);

    if (!codexIsLoggedIn()) return Promise.reject(new Error("Codex is not logged in. Use /login codex to sign in with your ChatGPT subscription."));

    const args = ["exec", "--json", "--sandbox", this.options.sandbox ?? "read-only", "--skip-git-repo-check"];
    if (this.options.model && this.options.model !== "default") args.push("--model", this.options.model);
    if (this.options.reasoningEffort) args.push("-c", `model_reasoning_effort=\"${this.options.reasoningEffort}\"`);
    args.push("-C", this.options.cwd, prompt);

    return new Promise((resolve, reject) => {
      const child = spawn("codex", args, { cwd: this.options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
      let finalText = "";
      const humanOutput: string[] = [];

      const handleLine = (line: string): void => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string } };
          if (event.type === "thread.started" && event.thread_id) {
            this.options.onThread?.(event.thread_id);
          } else if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
            finalText = event.item.text;
          } else if (event.type === "item.started" && event.item?.type === "command_execution") {
            onProgress?.(`Running: ${event.item.command ?? "command"}`);
          } else if (event.type === "turn.started") {
            onProgress?.("Thinking...");
          } else if (event.type === "turn.completed") {
            onProgress?.("Completed.");
          } else if (event.type) {
            // Codex's JSONL transport includes lifecycle notifications such as
            // thread.started and turn.started. They are protocol, not assistant output.
          }
        } catch {
          // Preserve only genuinely human-readable non-JSON output as a fallback.
          humanOutput.push(line);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        for (const line of chunk.toString().split("\n")) handleLine(line);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        const clean = chunk.toString().replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
        for (const line of clean.split("\n").map((value) => value.trim()).filter(Boolean)) {
          if (/^(error|warning|codex error)/i.test(line)) onProgress?.(line);
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        settled = true;
        if (code !== 0) {
          const diagnostic = `${stderr}\n${humanOutput.join("\n")}`.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
          if (/not supported when using Codex with a ChatGPT account/i.test(diagnostic)) {
            reject(new Error(`The selected model is not available for your ChatGPT Codex account. Use /model default.`));
          } else if (/stream disconnected|network|timed out|upstream connect error|connection termination/i.test(diagnostic)) {
            reject(new Error("Codex is unreachable right now. Check your connection, then try again."));
          } else {
            reject(new Error(diagnostic || `Codex exec exited with ${code ?? 1}`));
          }
          return;
        }
        resolve({ provider: this.options.provider, output: finalText || humanOutput.join("\n").trim(), usage: undefined });
      });
    });
  }

  private async runOllama(prompt: string, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void): Promise<AgentResult> {
    onProgress?.("Calling local Ollama model...");
    const abort = new AbortController();
    let paused = false;
    const control: ProcessControl = {
      pause: () => { paused = true; },
      resume: () => { paused = false; },
      terminate: () => abort.abort(),
      get paused() { return paused; },
    };
    onProcess?.(control);
    const response = await fetch(process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.2 },
      }),
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    const payload = await response.json() as { message?: { content?: string } };
    const text = payload.message?.content;
    if (!text) throw new Error("Ollama returned no message content.");
    onProgress?.("Completed.");
    return { provider: "local", output: text };
  }
}

export async function runWithLocalFallback(
  task: AgentTask,
  options: ExecAgentOptions,
  fallbackModel: string | undefined,
  onProgress?: (message: string) => void,
  onProcess?: (control: ProcessControl) => void,
): Promise<AgentResult> {
  try {
    return await new CodexExecAgent(options).run(task, onProgress, onProcess);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const limitReached = /rate limit|usage limit|quota|too many requests|429|not enough credits/i.test(message);
    if (options.provider !== "codex" || !fallbackModel || !limitReached) throw error;
    onProgress?.(`Codex limit reached; switching to local/${fallbackModel}...`);
    await checkProvider({ provider: "local", model: fallbackModel, cwd: options.cwd });
    return new CodexExecAgent({ provider: "local", model: fallbackModel, cwd: options.cwd }).run(task, onProgress, onProcess);
  }
}
