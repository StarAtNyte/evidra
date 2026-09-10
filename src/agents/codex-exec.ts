import { spawn, spawnSync } from "node:child_process";
import { Codex } from "@openai/codex-sdk";
import type { AgentResult, AgentTask } from "../core/types.js";
import type { ProcessControl } from "../core/process.js";

export type AgentProvider = "codex" | "local";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export function effectiveCodexSandbox(requested?: CodexSandboxMode): CodexSandboxMode {
  const override = process.env.EVIDRA_CODEX_SANDBOX;
  if (override === "read-only" || override === "workspace-write" || override === "danger-full-access") return override;
  return requested ?? "read-only";
}

export interface ExecAgentOptions {
  provider: AgentProvider;
  model: string;
  cwd: string;
  reasoningEffort?: string;
  sandbox?: CodexSandboxMode;
  onThread?: (threadId: string) => void;
  limitPolicy?: "wait" | "fallback" | "stop";
  timeoutMs?: number;
}

export class ProviderUsageLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "ProviderUsageLimitError";
  }
}

export function isProviderUsageLimit(error: unknown): boolean {
  return error instanceof ProviderUsageLimitError || /rate limit|usage limit|quota|too many requests|not enough credits/i.test(error instanceof Error ? error.message : String(error));
}

export function isRetryableAgentError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return isProviderUsageLimit(error) || /network|unreachable|timed out|timeout|stream disconnected|connection termination|temporarily|did not return|invalid decision|returned invalid|turn failed|econnreset|ePIPE|503|502|504/i.test(text);
}

export function providerRetryAfterMs(error: unknown): number {
  if (error instanceof ProviderUsageLimitError) return error.retryAfterMs;
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/(?:retry|reset)[^\d]*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
  if (!match) return 15 * 60_000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("hour") || unit.startsWith("hr") ? 3_600_000 : unit.startsWith("min") ? 60_000 : 1_000;
  return Math.max(5_000, Math.min(6 * 60 * 60_000, Math.round(amount * multiplier)));
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
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return true;
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

/** Pick an installed local fallback without assuming one exact Ollama tag. */
export async function resolveLocalFallbackModel(preferred = "auto"): Promise<string> {
  const models = await listLocalModels();
  if (!models.length) throw new Error("No local Ollama models are installed. Install a Qwen model or set EVIDRA_FALLBACK_MODEL.");
  if (preferred !== "auto" && models.some((model) => model.id === preferred)) return preferred;
  if (preferred !== "auto") throw new Error(`Local fallback model '${preferred}' is not installed. Available models: ${models.map((model) => model.id).join(", ")}`);
  return models.find((model) => /qwen/i.test(model.id))?.id ?? models[0].id;
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

    return this.runCodexSdk(prompt, onProgress, onProcess);
  }

  private async runCodexSdk(prompt: string, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void): Promise<AgentResult> {
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.options.timeoutMs ?? 15 * 60_000);
    const signalHandler = (): void => { abort.abort(); };
    process.once("SIGTERM", signalHandler);
    process.once("SIGINT", signalHandler);
    let paused = false;
    let settled = false;
    const control: ProcessControl = {
      // The SDK exposes cancellation rather than SIGSTOP. Keep pause state
      // observable to the TUI; a resumed request can be started explicitly.
      pause: () => { if (!settled) paused = true; },
      resume: () => { if (!settled) paused = false; },
      terminate: () => { if (!settled) abort.abort(); },
      get paused() { return paused; },
    };
    onProcess?.(control);

    try {
      const codex = new Codex();
      const thread = codex.startThread({
        workingDirectory: this.options.cwd,
        skipGitRepoCheck: true,
        model: this.options.model !== "default" ? this.options.model : undefined,
        sandboxMode: effectiveCodexSandbox(this.options.sandbox),
        modelReasoningEffort: this.options.reasoningEffort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent" | undefined,
        approvalPolicy: "never",
      });
      const stream = await thread.runStreamed(prompt, { signal: abort.signal });
      let finalText = "";
      let usage: AgentResult["usage"];
      let threadId: string | undefined;
      for await (const event of stream.events) {
        const value = event as unknown as { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string }; usage?: AgentResult["usage"]; message?: string };
        if (value.type === "thread.started" && value.thread_id) { threadId = value.thread_id; this.options.onThread?.(value.thread_id); }
        else if (value.type === "turn.started") onProgress?.("Thinking...");
        else if (value.type === "item.started" && value.item?.type === "command_execution") onProgress?.(`Running: ${value.item.command ?? "command"}`);
        else if (value.type === "item.completed" && value.item?.type === "agent_message" && value.item.text) finalText = value.item.text;
        else if (value.type === "turn.completed") {
          const raw = value.usage as unknown as { input_tokens?: number; output_tokens?: number } | undefined;
          usage = raw ? { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens } : undefined;
          onProgress?.("Completed.");
        }
        else if (value.type === "turn.failed" || value.type === "error") throw new Error(value.message ?? "Codex turn failed.");
      }
      settled = true;
      if (!finalText) throw new Error("Codex returned no assistant response.");
      return { provider: this.options.provider, model: this.options.model, threadId, output: finalText, usage };
    } catch (error) {
      settled = true;
      if (abort.signal.aborted) throw new Error(timedOut ? "Codex request timed out." : "Codex request interrupted.");
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (/rate limit|usage limit|quota|too many requests|not enough credits|429/i.test(diagnostic)) {
        const retryAfterMs = providerRetryAfterMs(new Error(diagnostic));
        throw new ProviderUsageLimitError(`Codex usage limit reached. Retrying in ${Math.ceil(retryAfterMs / 60_000)} minute(s).`, retryAfterMs);
      }
      if (/not supported when using Codex with a ChatGPT account/i.test(diagnostic)) throw new Error("The selected model is not available for your ChatGPT Codex account. Use /model default.");
      if (/stream disconnected|network|timed out|upstream connect error|connection termination/i.test(diagnostic)) throw new Error("Codex is unreachable right now. Check your connection, then try again.");
      throw error;
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGTERM", signalHandler);
      process.removeListener("SIGINT", signalHandler);
    }
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
    return { provider: "local", model: this.options.model, output: text };
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
    const limitReached = isProviderUsageLimit(error);
    if (options.provider !== "codex" || !fallbackModel || !limitReached || options.limitPolicy === "wait" || options.limitPolicy === "stop") throw error;
    const localModel = await resolveLocalFallbackModel(fallbackModel);
    onProgress?.(`Codex limit reached; switching to local/${localModel}...`);
    await checkProvider({ provider: "local", model: localModel, cwd: options.cwd });
    return new CodexExecAgent({ provider: "local", model: localModel, cwd: options.cwd }).run(task, onProgress, onProcess);
  }
}

/** Run a tool-capable engineer while honoring Codex entitlement reset windows. */
export async function runWithUsageLimitWait(
  task: AgentTask,
  options: ExecAgentOptions,
  onProgress?: (message: string) => void,
  onProcess?: (control: ProcessControl) => void,
  maxWaitMs = 6 * 60 * 60_000,
): Promise<AgentResult> {
  const started = Date.now();
  while (true) {
    try {
      return await new CodexExecAgent(options).run(task, onProgress, onProcess);
    } catch (error) {
      if (!isProviderUsageLimit(error) || options.limitPolicy !== "wait") throw error;
      const remaining = maxWaitMs - (Date.now() - started);
      if (remaining <= 0) throw new Error("Provider usage limit did not reset within the engineer wait budget.");
      const delay = Math.min(providerRetryAfterMs(error), remaining);
      onProgress?.(`Codex usage limit reached; waiting ${Math.ceil(delay / 60_000)} minute(s) before retrying the experiment engineer.`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
