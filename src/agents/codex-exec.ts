import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { Codex } from "@openai/codex-sdk";
import type { AgentResult, AgentTask } from "../core/types.js";
import type { ProcessControl } from "../core/process.js";
import { redactSecrets } from "../core/redaction.js";

export type AgentProvider = "codex" | "local";

/** Cost-conscious Codex default used by the CLI, TUI, and autonomous tests. */
export const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export function effectiveCodexSandbox(requested?: CodexSandboxMode): CodexSandboxMode {
  const override = process.env.EVIDRA_CODEX_SANDBOX;
  if (override === "read-only" || override === "workspace-write" || override === "danger-full-access") return override;
  return requested ?? "read-only";
}

/**
 * A full-access provider sandbox must never share Evidra's controller checkout.
 * This is intentionally a copy, rather than a Git worktree: research agents are
 * instructed not to edit, but a provider/tool can still violate that instruction.
 * The copy makes that failure harmless and is removed when the turn ends.
 */
export function createIsolatedCodexWorkspace(source: string): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "evidra-codex-research-"));
  cpSync(source, path, {
    recursive: true,
    filter: (entry) => {
      const parts = relative(source, entry).split("/");
      const first = parts[0] ?? basename(entry);
      const name = basename(entry);
      // Keep .git and .sota so the provider can inspect the same project
      // context as the controller. Never copy dependencies, generated
      // experiment worktrees, or common credential files into the provider
      // sandbox.
      if (first === "node_modules") return false;
      if (first === ".sota" && parts[1] === "worktrees") return false;
      if (/^\.env(?:\.|$)/i.test(name) || /(?:credentials|token|secret|private).*\.(?:json|ya?ml|toml|pem|key)$/i.test(name)) return false;
      return true;
    },
  });
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface ExecAgentOptions {
  provider: AgentProvider;
  model: string;
  cwd: string;
  /** Resume the provider conversation for the next ordinary chat turn. */
  threadId?: string;
  reasoningEffort?: string;
  sandbox?: CodexSandboxMode;
  onThread?: (threadId: string) => void;
  limitPolicy?: "auto" | "wait" | "fallback" | "stop";
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

/** Errors for which an automatic local route is a truthful startup substitute. */
export function isProviderFallbackEligible(error: unknown): boolean {
  if (isProviderUsageLimit(error)) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /not logged in|unreachable|network|connection|temporarily unavailable|failed its health check/i.test(text);
}

export function isRetryableAgentError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return isProviderUsageLimit(error) || /network|unreachable|timed out|timeout|stream disconnected|connection termination|temporarily|did not return|invalid decision|returned invalid|turn failed|econnreset|ePIPE|503|502|504/i.test(text);
}

/** Keep live provider activity useful in a one-line TUI status rail. */
export function progressLine(value: string, limit = 180): string {
  const compact = redactSecrets(value.replace(/\s+/g, " ").trim())
    .replace(/((?:--?|\/)(?:api[-_]?key|token|secret|password|passwd|authorization|auth|credential)=)\[REDACTED\]/gi, "$1[REDACTED_ARGUMENT]")
    .replace(/((?:--?|\/)(?:api[-_]?key|token|secret|password|passwd|authorization|auth|credential)\s+)([^\s]+)/gi, "$1[REDACTED_ARGUMENT]");
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export const MAX_PROVIDER_RESET_WAIT_MS = 24 * 60 * 60_000;

export function providerRetryAfterMs(error: unknown): number {
  if (error instanceof ProviderUsageLimitError) return error.retryAfterMs;
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/(?:retry|reset)[^\d]*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
  if (!match) return 15 * 60_000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("hour") || unit.startsWith("hr") ? 3_600_000 : unit.startsWith("min") ? 60_000 : 1_000;
  return Math.max(5_000, Math.min(MAX_PROVIDER_RESET_WAIT_MS, Math.round(amount * multiplier)));
}

export function queueCodexMessage(threadId: string, message: string): boolean {
  // Steering is invoked from the TUI input handler. Never let a broken local
  // Codex transport block rendering or keyboard input indefinitely.
  const result = spawnSync("codex", ["queue", "--thread", threadId, "--message", message], { stdio: "ignore", timeout: 5_000, killSignal: "SIGTERM" });
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
  const result = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 5_000, killSignal: "SIGTERM" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function codexIsLoggedIn(): boolean {
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return true;
  return spawnSync("codex", ["login", "status"], { stdio: "ignore", timeout: 5_000, killSignal: "SIGTERM" }).status === 0;
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

/** Resolve Evidra's UI-friendly `default` sentinel to a real account model. */
export async function resolveCodexModel(preferred = "default"): Promise<string> {
  if (preferred !== "default") return preferred;
  const models = await listCodexModels();
  const selected = models.find((model) => model.id === DEFAULT_CODEX_MODEL);
  if (!selected) throw new Error(`The configured default Codex model '${DEFAULT_CODEX_MODEL}' is unavailable. Use /model to select an available model explicitly.`);
  if (!selected.id) throw new Error("Codex returned no usable models. Use /model to select an available model.");
  return selected.id;
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
  // `/api/tags` only proves that Ollama has a registry entry. Probe model
  // metadata too so corrupt/missing blobs are rejected before an autonomous
  // campaign commits to the local route.
  const probe = await fetch(`${process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: options.model }),
  });
  if (!probe.ok) throw new Error(`Local model '${options.model}' failed its health check (${probe.status}): ${await probe.text()}`);
}

/** Validate the requested route, falling back before work starts when policy permits. */
export async function resolveStartupProvider(options: ExecAgentOptions, fallbackModel = "auto"): Promise<{ provider: AgentProvider; model: string; fallback: boolean; reason?: string }> {
  try {
    await checkProvider(options);
    return { provider: options.provider, model: options.model, fallback: false };
  } catch (error) {
    if (options.provider !== "codex" || !options.limitPolicy || !["auto", "fallback"].includes(options.limitPolicy) || !isProviderFallbackEligible(error)) throw error;
    const model = await resolveLocalFallbackModel(fallbackModel);
    await checkProvider({ ...options, provider: "local", model });
    return { provider: "local", model, fallback: true, reason: error instanceof Error ? error.message : String(error) };
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
    // Serious research turns may include several tool calls and should not be
    // cut off by a five-minute conversational ceiling. Campaigns still pass
    // their remaining-budget-aware timeout explicitly.
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.options.timeoutMs ?? 30 * 60_000);
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
    const sandboxMode = effectiveCodexSandbox(this.options.sandbox);
    const isolatedWorkspace = sandboxMode === "danger-full-access" && this.options.sandbox !== "workspace-write";
    const isolated = isolatedWorkspace ? createIsolatedCodexWorkspace(this.options.cwd) : undefined;

    try {
      const codex = new Codex();
      const thread = this.options.threadId
        ? codex.resumeThread(this.options.threadId, {
          workingDirectory: isolated?.path ?? this.options.cwd,
          skipGitRepoCheck: true,
          model: this.options.model !== "default" ? this.options.model : undefined,
          sandboxMode,
          modelReasoningEffort: this.options.reasoningEffort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent" | undefined,
          approvalPolicy: "never",
        })
        : codex.startThread({
        workingDirectory: isolated?.path ?? this.options.cwd,
        skipGitRepoCheck: true,
        model: this.options.model !== "default" ? this.options.model : undefined,
        sandboxMode,
        modelReasoningEffort: this.options.reasoningEffort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent" | undefined,
        approvalPolicy: "never",
      });
      const stream = await thread.runStreamed(prompt, { signal: abort.signal });
      let finalText = "";
      let usage: AgentResult["usage"];
      let threadId: string | undefined;
      for await (const event of stream.events) {
        const value = event as unknown as { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string; query?: string }; usage?: AgentResult["usage"]; message?: string };
        if (value.type === "thread.started" && value.thread_id) { threadId = value.thread_id; this.options.onThread?.(value.thread_id); }
        else if (value.type === "turn.started") onProgress?.("Thinking...");
        else if (value.type === "item.started" && value.item?.type === "command_execution") onProgress?.(`Running: ${progressLine(value.item.command ?? "command")}`);
        else if (value.type === "item.started" && value.item?.type === "web_search") onProgress?.(`Searching: ${progressLine(value.item.query ?? "web")}`);
        else if (value.type === "item.started" && value.item?.type === "file_change") onProgress?.("Applying a workspace change...");
        else if (value.type === "item.started" && value.item?.type === "reasoning") onProgress?.("Reasoning...");
        else if ((value.type === "item.updated" || value.type === "item.completed") && value.item?.type === "agent_message" && value.item.text) {
          finalText = value.item.text;
          if (value.type === "item.updated") onProgress?.(`Codex · ${progressLine(value.item.text)}`);
        }
        else if (value.type === "turn.completed") {
          const raw = value.usage as unknown as { input_tokens?: number; output_tokens?: number } | undefined;
          usage = raw ? { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens } : undefined;
          onProgress?.("Completed.");
        }
        else if (value.type === "turn.failed" || value.type === "error") throw new Error(value.message ?? "Codex turn failed.");
      }
      settled = true;
      if (!finalText) throw new Error("Codex returned no assistant response.");
      return { provider: this.options.provider, model: this.options.model, threadId: threadId ?? this.options.threadId, output: finalText, usage };
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
      isolated?.cleanup();
    }
  }

  private async runOllama(prompt: string, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void): Promise<AgentResult> {
    onProgress?.("Calling local Ollama model...");
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.options.timeoutMs ?? 30 * 60_000);
    const signalHandler = (): void => { abort.abort(); };
    process.once("SIGTERM", signalHandler);
    process.once("SIGINT", signalHandler);
    let paused = false;
    const control: ProcessControl = {
      pause: () => { paused = true; },
      resume: () => { paused = false; },
      terminate: () => abort.abort(),
      get paused() { return paused; },
    };
    onProcess?.(control);
    try {
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
    } catch (error) {
      if (abort.signal.aborted) throw new Error(timedOut ? "Local model request timed out." : "Local model request interrupted.");
      throw error;
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGTERM", signalHandler);
      process.removeListener("SIGINT", signalHandler);
    }
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
    let localModel: string;
    try {
      localModel = await resolveLocalFallbackModel(fallbackModel);
    } catch (fallbackError) {
      if (options.limitPolicy !== "auto") throw fallbackError;
      onProgress?.("No healthy local fallback is available; returning to the durable Codex reset policy...");
      // Let the outer campaign controller own the wait. It knows the
      // remaining campaign budget and can persist/stop at the correct
      // boundary; an inner six-hour wait could outlive the campaign.
      throw error;
    }
    onProgress?.(`Codex limit reached; switching to local/${localModel}...`);
    try {
      await checkProvider({ provider: "local", model: localModel, cwd: options.cwd });
      return await new CodexExecAgent({
        ...options,
        provider: "local",
        model: localModel,
      }).run(task, onProgress, onProcess);
    } catch (localError) {
      if (options.limitPolicy !== "auto") throw localError;
      const detail = localError instanceof Error ? localError.message : String(localError);
      onProgress?.(`Local fallback is unhealthy (${detail}); returning to the durable Codex reset policy...`);
      throw error;
    }
  }
}

/** Run a tool-capable engineer while honoring Codex entitlement reset windows. */
export async function runWithUsageLimitWait(
  task: AgentTask,
  options: ExecAgentOptions,
  onProgress?: (message: string) => void,
  onProcess?: (control: ProcessControl) => void,
  maxWaitMs = MAX_PROVIDER_RESET_WAIT_MS,
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
