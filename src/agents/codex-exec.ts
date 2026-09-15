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

/** Resolve one Codex executable for SDK and CLI subprocesses alike. */
export function resolveCodexBinary(): string {
  const configured = process.env.EVIDRA_CODEX_BIN?.trim();
  return configured && !/[\r\n]/.test(configured) ? configured : "codex";
}

/** Never delegate Evidra's legacy default sentinel to a provider-side default. */
export function effectiveCodexModel(preferred?: string): string {
  return !preferred || preferred === "default" ? DEFAULT_CODEX_MODEL : preferred;
}

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexWebSearchMode = "disabled" | "cached" | "live";

export function effectiveCodexSandbox(requested?: CodexSandboxMode): CodexSandboxMode {
  const baseline = requested ?? "read-only";
  const override = process.env.EVIDRA_CODEX_SANDBOX;
  if (override !== "read-only" && override !== "workspace-write" && override !== "danger-full-access") return baseline;
  // A process-wide environment override must not weaken a role-level
  // restriction. Research lanes and critics explicitly request read-only;
  // allowing this variable to promote them would make their provider copy
  // share the active checkout with write access. It may still tighten a
  // permissive engineer or user-requested sandbox.
  if (baseline === "read-only" && override !== "read-only") return baseline;
  return override;
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
  /** Enable Codex-native web retrieval only for explicitly research routes. */
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexWebSearchMode;
  onThread?: (threadId: string) => void;
  limitPolicy?: "auto" | "wait" | "fallback" | "stop";
  timeoutMs?: number;
  /** Abort autonomous turns that repeat the exact same shell command. Zero disables it. */
  maxRepeatedCommands?: number;
  /** Receive concise, redacted native provider activity for durable traces. */
  onActivity?: (source: string, activity: string) => void;
  /** Receive the bounded, redacted assistant message for replay diagnostics. */
  onAssistant?: (source: string, text: string) => void;
  onUsage?: (usage: AgentResult["usage"], provider: string, model: string, role: string) => void;
  /** Abort the provider turn and any entitlement-reset wait immediately. */
  interruptSignal?: AbortSignal;
}

export interface CodexExecDependencies {
  /** Test or embedding hook; production defaults to the installed SDK. */
  isLoggedIn?: () => Promise<boolean>;
  createClient?: (options: Record<string, unknown>) => {
    startThread: (options: Record<string, unknown>) => { runStreamed: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }> };
    resumeThread: (threadId: string, options: Record<string, unknown>) => { runStreamed: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }> };
  };
}

export class ProviderUsageLimitError extends Error {
  constructor(message: string, readonly retryAfterMs: number) {
    super(message);
    this.name = "ProviderUsageLimitError";
  }
}

export function isProviderUsageLimit(error: unknown): boolean {
  return error instanceof ProviderUsageLimitError || /rate limit|usage limit|quota|too many requests|not enough credits|at capacity|overloaded|server busy/i.test(error instanceof Error ? error.message : String(error));
}

/** Detect the host-level launcher failures that can be repaired by moving a
 * read-only turn into Evidra's disposable isolated workspace. */
export function isCodexSandboxFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /bwrap|loopback|network namespace|sandbox.*(?:denied|failed)|(?:network|namespace).*(?:operation not permitted|permission denied)/i.test(text);
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

/** Decide whether an active Codex failure may change to the configured local route. */
export function shouldUseLocalFallback(error: unknown, options: Pick<ExecAgentOptions, "provider" | "limitPolicy">, fallbackModel?: string): boolean {
  return options.provider === "codex"
    && Boolean(fallbackModel)
    && (options.limitPolicy === "auto" || options.limitPolicy === "fallback")
    && isProviderFallbackEligible(error);
}

/** Keep live provider activity useful in a one-line TUI status rail. */
export function progressLine(value: string, limit = 180): string {
  const compact = redactSecrets(value.replace(/\s+/g, " ").trim())
    .replace(/((?:--?|\/)(?:api[-_]?key|token|secret|password|passwd|authorization|auth|credential)=)\[REDACTED\]/gi, "$1[REDACTED_ARGUMENT]")
    .replace(/((?:--?|\/)(?:api[-_]?key|token|secret|password|passwd|authorization|auth|credential)\s+)([^\s]+)/gi, "$1[REDACTED_ARGUMENT]");
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/** Convert SDK item events into concise, secret-redacted TUI activity. */
export function codexItemProgress(item: unknown, eventType = "item.started"): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as {
    type?: unknown;
    command?: unknown;
    exit_code?: unknown;
    query?: unknown;
    server?: unknown;
    tool?: unknown;
    status?: unknown;
    error?: { message?: unknown };
    changes?: unknown;
    text?: unknown;
    items?: unknown;
    message?: unknown;
  };
  const type = typeof value.type === "string" ? value.type : "";
  const completed = eventType === "item.completed";
  if (type === "command_execution") {
    const command = typeof value.command === "string" ? progressLine(value.command) : "command";
    if (value.status === "failed" || (typeof value.exit_code === "number" && value.exit_code !== 0)) {
      return `Command failed: ${command}${typeof value.exit_code === "number" ? ` (exit ${value.exit_code})` : ""}`;
    }
    return completed ? `Finished: ${command}` : `Running: ${command}`;
  }
  if (type === "web_search") {
    return `Searching: ${progressLine(typeof value.query === "string" ? value.query : "web")}`;
  }
  if (type === "file_change") {
    const changes = Array.isArray(value.changes)
      ? value.changes.filter((change): change is { path?: unknown; kind?: unknown } => Boolean(change) && typeof change === "object")
        .map((change) => `${typeof change.kind === "string" ? change.kind : "update"} ${typeof change.path === "string" ? progressLine(change.path, 80) : "file"}`)
        .slice(0, 3)
      : [];
    if (value.status === "failed") return changes.length ? `File change failed: ${changes.join(", ")}` : "File change failed.";
    return changes.length ? `${completed ? "Applied" : "Applying"}: ${changes.join(", ")}` : "Applying a workspace change...";
  }
  if (type === "mcp_tool_call") {
    const server = typeof value.server === "string" ? progressLine(value.server, 60) : "MCP";
    const tool = typeof value.tool === "string" ? progressLine(value.tool, 100) : "tool";
    if (value.status === "failed" || (typeof value.error?.message === "string" && value.error.message.trim()) || (typeof value.message === "string" && value.message.trim())) return `Tool failed: ${server}/${tool}`;
    return `${completed ? "Tool completed" : "Calling tool"}: ${server}/${tool}`;
  }
  if (type === "todo_list") {
    const entries = Array.isArray(value.items) ? value.items : [];
    const done = entries.filter((entry) => Boolean(entry) && typeof entry === "object" && (entry as { completed?: unknown }).completed === true).length;
    return `Plan progress: ${done}/${entries.length} step${entries.length === 1 ? "" : "s"}`;
  }
  if (type === "reasoning") {
    return typeof value.text === "string" && value.text.trim() ? `Reasoning: ${progressLine(value.text, 140)}` : "Reasoning...";
  }
  if (type === "error") return `Codex item error: ${progressLine(typeof value.message === "string" ? value.message : "unknown error")}`;
  return undefined;
}

/** Extract the assistant text before generic item-progress handling. */
export function codexAgentMessageText(item: unknown, eventType: string): string | undefined {
  if (eventType !== "item.updated" && eventType !== "item.completed") return undefined;
  if (!item || typeof item !== "object") return undefined;
  const value = item as { type?: unknown; text?: unknown };
  return value.type === "agent_message" && typeof value.text === "string" && value.text.trim()
    ? value.text
    : undefined;
}

/** Extract the useful diagnostic from either SDK failure event shape. */
export function codexEventErrorMessage(event: unknown): string {
  if (!event || typeof event !== "object") return "Codex turn failed.";
  const value = event as { message?: unknown; error?: { message?: unknown } };
  if (typeof value.error?.message === "string" && value.error.message.trim()) return value.error.message;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  return "Codex turn failed.";
}

/** Preserve the useful account usage fields emitted by the Codex SDK. */
export function normalizeCodexUsage(value: unknown): AgentResult["usage"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string): number | undefined => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
  const usage = {
    inputTokens: number("input_tokens"),
    outputTokens: number("output_tokens"),
    cachedInputTokens: number("cached_input_tokens"),
    cacheWriteInputTokens: number("cache_write_input_tokens"),
    reasoningOutputTokens: number("reasoning_output_tokens"),
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
}

export const MAX_PROVIDER_RESET_WAIT_MS = 24 * 60 * 60_000;

export function providerRetryAfterMs(error: unknown): number {
  if (error instanceof ProviderUsageLimitError) return error.retryAfterMs;
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/(?:retry(?:-after)?|reset|try\s+again|available)[^\d]*(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i);
  if (!match) return 15 * 60_000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("hour") || unit.startsWith("hr") ? 3_600_000 : unit.startsWith("min") ? 60_000 : 1_000;
  return Math.max(5_000, Math.min(MAX_PROVIDER_RESET_WAIT_MS, Math.round(amount * multiplier)));
}

export function queueCodexMessage(threadId: string, message: string): Promise<boolean> {
  // Steering is invoked from the TUI input handler. Never let a broken local
  // Codex transport block rendering or keyboard input indefinitely.
  return new Promise((resolve) => {
    const child = spawn(resolveCodexBinary(), ["queue", "--thread", threadId, "--message", message], { stdio: "ignore" });
    let settled = false;
    const finish = (queued: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(queued);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      finish(false);
    }, 5_000);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export interface AvailableModel {
  id: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
}

/** Build a small heterogeneous Codex pool without silently selecting costly
 * preview models. The requested model remains the primary route. */
export function codexResearchModelPool(primary: string, models: AvailableModel[], maxModels = 4, reasoningEffort?: string): Array<{ provider: "codex"; model: string }> {
  const selected = [primary, ...models
    .filter((model) => !model.hidden && !/astra/i.test(model.id)
      && (!reasoningEffort || !model.supportedReasoningEfforts?.length || model.supportedReasoningEfforts.includes(reasoningEffort)))
    .map((model) => model.id)]
    .filter((model, index, values) => model.trim().length > 0 && values.indexOf(model) === index)
    .slice(0, Math.max(1, Math.min(6, Number.isFinite(maxModels) ? Math.floor(maxModels) : 4)));
  return selected.map((model) => ({ provider: "codex" as const, model }));
}

/** Normalize the app-server model schema for the TUI's string-based picker. */
export function normalizeCodexModels(value: unknown): AvailableModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AvailableModel[] => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as { id?: unknown; model?: unknown; displayName?: unknown; description?: unknown; hidden?: unknown; isDefault?: unknown; supportedReasoningEfforts?: unknown };
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : typeof raw.model === "string" && raw.model.trim() ? raw.model : undefined;
    if (!id) return [];
    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts.flatMap((effort) => {
        if (typeof effort === "string" && effort.trim()) return [effort];
        if (effort && typeof effort === "object" && typeof (effort as { reasoningEffort?: unknown }).reasoningEffort === "string") return [(effort as { reasoningEffort: string }).reasoningEffort];
        return [];
      })
      : [];
    return [{ id, displayName: typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : id, ...(typeof raw.description === "string" ? { description: raw.description } : {}), ...(typeof raw.hidden === "boolean" ? { hidden: raw.hidden } : {}), ...(typeof raw.isDefault === "boolean" ? { isDefault: raw.isDefault } : {}), ...(efforts.length ? { supportedReasoningEfforts: [...new Set(efforts)] } : {}) }];
  });
}

/**
 * Run the interactive Codex login without blocking Ink's event loop. Codex
 * owns the terminal while the flow is active, but Evidra remains alive to
 * render status and can terminate the child when the operator interrupts it.
 */
export function loginCodex(
  mode: "device" | "browser" = "device",
  onProcess?: (control: ProcessControl) => void,
): Promise<number> {
  const args = mode === "device" ? ["login", "--device-auth"] : ["login"];
  return new Promise((resolve) => {
    const child = spawn(resolveCodexBinary(), args, { stdio: "inherit", detached: false });
    let settled = false;
    let paused = false;
    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const control: ProcessControl = {
      pause: () => { paused = true; },
      resume: () => { paused = false; },
      terminate: () => {
        if (settled) return;
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        setTimeout(() => {
          if (!settled) {
            try { child.kill("SIGKILL"); } catch { /* already exited */ }
          }
        }, 1_500).unref();
      },
      get paused() { return paused; },
    };
    onProcess?.(control);
    child.once("error", () => finish(1));
    child.once("close", (code, signal) => finish(signal ? 130 : (code ?? 1)));
  });
}

export function codexLoginStatus(): string {
  const result = spawnSync(resolveCodexBinary(), ["login", "status"], { encoding: "utf8", timeout: 5_000, killSignal: "SIGTERM" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

export function codexIsLoggedIn(): boolean {
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return true;
  return spawnSync(resolveCodexBinary(), ["login", "status"], { stdio: "ignore", timeout: 5_000, killSignal: "SIGTERM" }).status === 0;
}

/** Non-blocking authentication probe for the TUI and provider turn path. */
export function codexIsLoggedInAsync(): Promise<boolean> {
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return Promise.resolve(true);
  return new Promise((resolve) => {
    const child = spawn(resolveCodexBinary(), ["login", "status"], { stdio: "ignore" });
    let settled = false;
    const finish = (loggedIn: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(loggedIn);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      finish(false);
    }, 5_000);
    timer.unref();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export function listCodexModels(): Promise<AvailableModel[]> {
  return codexIsLoggedInAsync().then((loggedIn) => {
    if (!loggedIn) throw new Error("Codex is not logged in. Use /login codex first.");
    return new Promise<AvailableModel[]>((resolve, reject) => {
    const child = spawn(resolveCodexBinary(), ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
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
    // A short-lived app-server can close stdin after emitting its final JSON
    // response. Do not reject immediately on EPIPE: stdout may still contain
    // the complete response and the close handler can parse it. The timeout
    // and close paths still surface a genuine transport failure.
    child.stdin.on("error", () => undefined);
    const handleLine = (line: string): boolean => {
      try {
        const event = JSON.parse(line) as { id?: number; result?: { data?: unknown }; error?: { message?: string } };
        if (event.id !== 2) return false;
        if (event.error) finish(() => reject(new Error(event.error?.message ?? "Codex model listing failed.")));
        else finish(() => resolve(normalizeCodexModels(event.result?.data)));
        return true;
      } catch {
        // App-server emits JSON objects; ignore startup noise and incomplete data.
        return false;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (handleLine(line)) return;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (settled) return;
      if (buffer.trim() && handleLine(buffer)) return;
      finish(() => reject(new Error(`Codex model listing exited with ${code ?? 1}.`)));
    });
    try {
      child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "evidra", version: "0.1.0" } } })}\n`);
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ method: "model/list", id: 2, params: { includeHidden: true } })}\n`);
    } catch (error) {
      finish(() => reject(new Error(`Codex model listing transport failed: ${error instanceof Error ? error.message : String(error)}`)));
    }
    });
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
    if (!await codexIsLoggedInAsync()) throw new Error("Codex is not logged in. Use /login codex to sign in with your ChatGPT subscription.");
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
  constructor(private readonly options: ExecAgentOptions, private readonly dependencies: CodexExecDependencies = {}) {}

  async run(task: AgentTask, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void): Promise<AgentResult> {
    const submissionBoundary = task.role === "experiment engineer"
      ? "You may create and validate local experiment outputs and evaluator artifacts required by the task, but never submit externally or expose credentials."
      : "Do not submit anything or expose credentials.";
    const responseInstruction = task.role === "experiment engineer"
      ? "Execute the task through to its required local artifact; only summarize after the artifact and verification are complete."
      : "Return a concise, evidence-oriented answer.";
    const prompt = `${task.objective}\n\nResearch context:\n${JSON.stringify(task.context, null, 2)}\n\n` +
      "You are Evidra, the research and experimentation workbench assistant. The selected provider is only an implementation detail; never introduce yourself as Codex, OpenAI, Ollama, or another underlying model. " +
      (task.role === "research director" ? "Act as Evidra's research director. " : "Act as Evidra's conversational assistant. ") +
      responseInstruction + " " +
      submissionBoundary;
    if (this.options.provider === "local") {
      const result = await this.runOllama(prompt, onProgress, onProcess);
      this.options.onUsage?.(result.usage, result.provider, result.model ?? this.options.model, task.role);
      return result;
    }

    const loggedIn = await (this.dependencies.isLoggedIn?.() ?? codexIsLoggedInAsync());
    if (!loggedIn) throw new Error("Codex is not logged in. Use /login codex to sign in with your ChatGPT subscription.");
    const result = await this.runCodexSdk(prompt, onProgress, onProcess, task.outputSchema, task.role);
    this.options.onUsage?.(result.usage, result.provider, result.model ?? this.options.model, task.role);
    return result;
  }

  private async runCodexSdk(prompt: string, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void, outputSchemaText?: string, role = "conversation assistant"): Promise<AgentResult> {
    try {
      return await this.runCodexSdkAttempt(prompt, onProgress, onProcess, outputSchemaText, role);
    } catch (error) {
      // Research/chat turns are read-only and may safely use a disposable
      // copy if the host cannot create Codex's normal bwrap namespace. Never
      // apply this to workspace-write experiment engineers.
      if (this.options.sandbox === "read-only" && isCodexSandboxFailure(error)) {
        const fallbackActivity = "Codex sandbox unavailable · changing route to a disposable isolated workspace";
        onProgress?.(`${fallbackActivity}...`);
        this.options.onActivity?.("codex", fallbackActivity);
        const retryOptions = { ...this.options, threadId: undefined, sandbox: "danger-full-access" as const };
        return await new CodexExecAgent(retryOptions, this.dependencies).runCodexSdkAttempt(prompt, onProgress, onProcess, outputSchemaText, role, "danger-full-access");
      }
      throw error;
    }
  }

  private async runCodexSdkAttempt(prompt: string, onProgress?: (message: string) => void, onProcess?: (control: ProcessControl) => void, outputSchemaText?: string, role = "conversation assistant", sandboxOverride?: CodexSandboxMode): Promise<AgentResult> {
    const abort = new AbortController();
    let timedOut = false;
    let abortReason: string | undefined;
    // Serious research turns may include several tool calls and should not be
    // cut off by a five-minute conversational ceiling. Campaigns still pass
    // their remaining-budget-aware timeout explicitly.
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.options.timeoutMs ?? 30 * 60_000);
    const signalHandler = (): void => { abort.abort(); };
    process.once("SIGTERM", signalHandler);
    process.once("SIGINT", signalHandler);
    const interruptHandler = (): void => { abort.abort(); };
    this.options.interruptSignal?.addEventListener("abort", interruptHandler, { once: true });
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
    const sandboxMode = sandboxOverride ?? effectiveCodexSandbox(this.options.sandbox);
    const isolatedWorkspace = sandboxMode === "danger-full-access" && this.options.sandbox !== "workspace-write";
    const isolated = isolatedWorkspace ? createIsolatedCodexWorkspace(this.options.cwd) : undefined;
    const model = effectiveCodexModel(this.options.model);

    try {
      const codex = this.dependencies.createClient
        ? this.dependencies.createClient({ codexPathOverride: resolveCodexBinary() })
        : new Codex({ codexPathOverride: resolveCodexBinary() });
      const thread = this.options.threadId
        ? codex.resumeThread(this.options.threadId, {
          threadSource: role === "research director" ? "evidra-research" : role === "experiment engineer" ? "evidra-experiment" : "evidra-chat",
          workingDirectory: isolated?.path ?? this.options.cwd,
          skipGitRepoCheck: true,
          model,
          sandboxMode,
          modelReasoningEffort: this.options.reasoningEffort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent" | undefined,
          networkAccessEnabled: this.options.networkAccessEnabled,
          webSearchMode: this.options.webSearchMode,
          ...(this.options.webSearchMode !== undefined ? { webSearchEnabled: this.options.webSearchMode !== "disabled" } : {}),
          approvalPolicy: "never",
        })
        : codex.startThread({
        threadSource: role === "research director" ? "evidra-research" : role === "experiment engineer" ? "evidra-experiment" : "evidra-chat",
        workingDirectory: isolated?.path ?? this.options.cwd,
        skipGitRepoCheck: true,
        model,
        sandboxMode,
        modelReasoningEffort: this.options.reasoningEffort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent" | undefined,
        networkAccessEnabled: this.options.networkAccessEnabled,
        webSearchMode: this.options.webSearchMode,
        ...(this.options.webSearchMode !== undefined ? { webSearchEnabled: this.options.webSearchMode !== "disabled" } : {}),
        approvalPolicy: "never",
      });
      let outputSchema: unknown;
      if (outputSchemaText) {
        try { outputSchema = JSON.parse(outputSchemaText); }
        catch { throw new Error("The configured Codex output schema is invalid JSON."); }
      }
      const stream = await thread.runStreamed(prompt, { signal: abort.signal, ...(outputSchema ? { outputSchema } : {}) });
      let finalText = "";
      let usage: AgentResult["usage"];
      let threadId: string | undefined;
      let turnCompleted = false;
      let lastCommand: string | undefined;
      let repeatedCommands = 0;
      for await (const event of stream.events) {
        const value = event as unknown as { type?: string; thread_id?: string; item?: { type?: string; text?: string; command?: string; query?: string; message?: string }; usage?: AgentResult["usage"]; message?: string; error?: { message?: string } };
        if (value.type === "item.started" && value.item?.type === "command_execution" && typeof value.item.command === "string") {
          if (value.item.command === lastCommand) repeatedCommands += 1;
          else { lastCommand = value.item.command; repeatedCommands = 1; }
          const limit = Math.max(0, Math.floor(this.options.maxRepeatedCommands ?? 0));
          if (limit > 0 && repeatedCommands >= limit) {
            abortReason = `Codex agent stuck: repeated the same command ${repeatedCommands} times (${progressLine(value.item.command)}).`;
            onProgress?.("Agent appears stuck · stopping the repeated command loop.");
            abort.abort();
          }
        }
        if (value.type === "thread.started" && value.thread_id) { threadId = value.thread_id; this.options.onThread?.(value.thread_id); }
        else if (value.type === "turn.started") onProgress?.("Thinking...");
        else if ((value.type === "item.updated" || value.type === "item.completed") && value.item?.type === "agent_message") {
          const message = codexAgentMessageText(value.item, value.type);
          if (message) {
            finalText = message;
            if (value.type === "item.updated") onProgress?.(`Evidra · ${progressLine(message)}`);
          }
        }
        else if (value.item && (value.type === "item.started" || value.type === "item.updated" || value.type === "item.completed")) {
          const activity = codexItemProgress(value.item, value.type);
          if (activity) {
            onProgress?.(activity);
            this.options.onActivity?.("codex", activity);
          }
        }
        else if (value.type === "turn.completed") {
          turnCompleted = true;
          usage = normalizeCodexUsage(value.usage);
          onProgress?.("Completed.");
        }
        else if (value.type === "turn.failed" || value.type === "error") throw new Error(codexEventErrorMessage(value));
      }
      settled = true;
      if (!turnCompleted) throw new Error("Codex stream ended before the turn completed.");
      if (!finalText) throw new Error("Codex returned no assistant response.");
      this.options.onAssistant?.("codex", finalText);
      return { provider: this.options.provider, model, threadId: threadId ?? this.options.threadId, output: finalText, usage };
    } catch (error) {
      settled = true;
      if (abort.signal.aborted) throw new Error(timedOut ? "Codex request timed out." : abortReason ?? "Codex request interrupted.");
      const diagnostic = error instanceof Error ? error.message : String(error);
      if (isProviderUsageLimit(error) || /429/i.test(diagnostic)) {
        const retryAfterMs = providerRetryAfterMs(new Error(diagnostic));
        throw new ProviderUsageLimitError(`Codex usage limit reached. Retrying in ${Math.ceil(retryAfterMs / 60_000)} minute(s).`, retryAfterMs);
      }
      if (isCodexSandboxFailure(error)) throw error;
      if (/not supported when using Codex with a ChatGPT account/i.test(diagnostic)) throw new Error("The selected model is not available for your ChatGPT Codex account. Use /model to choose an available model.");
      if (/stream disconnected|network|timed out|upstream connect error|connection termination/i.test(diagnostic)) throw new Error("Codex is unreachable right now. Check your connection, then try again.");
      throw error;
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGTERM", signalHandler);
      process.removeListener("SIGINT", signalHandler);
      this.options.interruptSignal?.removeEventListener("abort", interruptHandler);
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
    const interruptHandler = (): void => { abort.abort(); };
    this.options.interruptSignal?.addEventListener("abort", interruptHandler, { once: true });
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
      this.options.onAssistant?.("local", text);
      onProgress?.("Completed.");
      return { provider: "local", model: this.options.model, output: text };
    } catch (error) {
      if (abort.signal.aborted) throw new Error(timedOut ? "Local model request timed out." : "Local model request interrupted.");
      throw error;
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGTERM", signalHandler);
      process.removeListener("SIGINT", signalHandler);
      this.options.interruptSignal?.removeEventListener("abort", interruptHandler);
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
    const limitReached = isProviderUsageLimit(error);
    if (!shouldUseLocalFallback(error, options, fallbackModel)) throw error;
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
    onProgress?.(`${limitReached ? "Codex usage limit reached" : "Codex route unavailable"}; switching to local/${localModel}...`);
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
      await waitForInterrupt(delay, options.interruptSignal);
    }
  }
}

/** Sleep without losing the operator's ability to interrupt a reset wait. */
export function waitForInterrupt(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Codex request interrupted.")); return; }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => finish(new Error("Codex request interrupted."));
    const timer = setTimeout(() => finish(), Math.max(0, delayMs));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
