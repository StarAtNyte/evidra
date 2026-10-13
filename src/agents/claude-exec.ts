import { spawn, spawnSync } from "node:child_process";
import type { AgentResult } from "../core/types.js";
import type { ProcessControl } from "../core/process.js";
import { createIsolatedCodexWorkspace, effectiveCodexSandbox, progressLine, ProviderUsageLimitError, type CodexSandboxMode, type ExecAgentOptions } from "./codex-exec.js";

/** Default Claude route when the operator selects the provider without a model. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** Resolve one Claude Code executable for headless turns and health checks. */
export function resolveClaudeBinary(): string {
  const configured = process.env.EVIDRA_CLAUDE_BIN?.trim();
  return configured && !/[\r\n]/.test(configured) ? configured : "claude";
}

/** Map Evidra's model sentinel, and Codex-only model names carried over from
 * a provider switch, onto a model Claude Code actually serves. */
export function effectiveClaudeModel(preferred?: string): string {
  if (!preferred || preferred === "default") return DEFAULT_CLAUDE_MODEL;
  return /^(?:claude|opus|sonnet|haiku|fable)/i.test(preferred) ? preferred : DEFAULT_CLAUDE_MODEL;
}

/** Claude Code accepts low..max; keep Codex-style effort names usable. */
export function claudeEffort(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === "minimal") return "low";
  if (value === "ultra" || value === "persistent") return "max";
  return ["low", "medium", "high", "xhigh", "max"].includes(value) ? value : undefined;
}

export function claudeIsLoggedInAsync(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const child = spawn(resolveClaudeBinary(), ["auth", "status"], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve((JSON.parse(text) as { loggedIn?: unknown }).loggedIn === true); }
      catch { resolve(false); }
    });
  });
}

export function claudeLoginStatus(): string {
  const result = spawnSync(resolveClaudeBinary(), ["auth", "status"], { encoding: "utf8", timeout: 20_000 });
  if (result.error) return "Claude Code CLI not found.";
  try {
    const status = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
    return status.loggedIn ? `Logged in using ${status.authMethod ?? "Claude Code"}` : "Not logged in";
  } catch {
    return result.stdout.trim() || "Unknown";
  }
}

/** Read-only roles may inspect files and the web but never run shell or edit. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];

export function claudeHeadlessArgs(options: ExecAgentOptions, sandboxMode: CodexSandboxMode, model: string, outputSchema?: string): string[] {
  const webAllowed = options.networkAccessEnabled !== false && options.webSearchMode !== "disabled";
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    // The harness owns configuration: ambient user settings, hooks, plugins,
    // CLAUDE.md files and MCP servers must not change a locked run.
    "--setting-sources", "",
    "--strict-mcp-config",
  ];
  const effort = claudeEffort(options.reasoningEffort);
  if (effort) args.push("--effort", effort);
  if (sandboxMode === "read-only") {
    args.push("--permission-mode", "dontAsk", "--allowedTools", ...READ_ONLY_TOOLS, ...(webAllowed ? WEB_TOOLS : []));
  } else {
    args.push("--permission-mode", "bypassPermissions");
    if (!webAllowed) args.push("--disallowedTools", ...WEB_TOOLS);
  }
  if (outputSchema) args.push("--json-schema", outputSchema);
  if (options.threadId) args.push("--resume", options.threadId);
  return args;
}

function claudeUsage(value: unknown): AgentResult["usage"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const number = (key: string): number | undefined => typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] as number : undefined;
  const input = number("input_tokens");
  const cacheRead = number("cache_read_input_tokens");
  const cacheWrite = number("cache_creation_input_tokens");
  const details = raw.output_tokens_details as { thinking_tokens?: unknown } | undefined;
  const usage = {
    // Match Codex accounting: input includes cached prefix tokens.
    inputTokens: input === undefined && cacheRead === undefined && cacheWrite === undefined ? undefined : (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    outputTokens: number("output_tokens"),
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningOutputTokens: typeof details?.thinking_tokens === "number" ? details.thinking_tokens : undefined,
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
}

function toolActivity(name: string, input: Record<string, unknown> | undefined): string {
  const detail = input?.command ?? input?.file_path ?? input?.pattern ?? input?.query ?? input?.url ?? input?.description;
  return progressLine(`Claude · ${name}${typeof detail === "string" ? `: ${detail}` : ""}`);
}

/** The model stopped streaming mid-turn: no event arrived for the idle limit while no tool was running. */
export class ClaudeStreamStalledError extends Error {
  constructor(message: string, readonly sessionId: string | undefined) {
    super(message);
    this.name = "ClaudeStreamStalledError";
  }
}

/** Idle limit for a generating (not tool-executing) Claude turn; EVIDRA_CLAUDE_IDLE_MINUTES overrides. */
export function claudeIdleLimitMs(): number {
  const minutes = Number(process.env.EVIDRA_CLAUDE_IDLE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60_000;
}

const STALL_RESUME_PROMPT = "Your previous response stopped mid-stream because the connection stalled. Continue directly from where it stopped, without recap, and finish the original task, including its required output format.";

/** Run one Claude Code headless turn; a stalled stream is stopped and the same session resumed. */
export async function runClaudeHeadless(
  prompt: string,
  options: ExecAgentOptions,
  onProgress?: (message: string) => void,
  onProcess?: (control: ProcessControl) => void,
  outputSchemaText?: string,
): Promise<AgentResult> {
  const maxResumes = 2;
  let attemptPrompt = prompt;
  let attemptOptions = options;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runClaudeHeadlessOnce(attemptPrompt, attemptOptions, onProgress, onProcess, outputSchemaText);
    } catch (error) {
      if (!(error instanceof ClaudeStreamStalledError) || attempt >= maxResumes) throw error;
      onProgress?.(`Claude stream stalled · ${error.sessionId ? "resuming the same session" : "restarting the turn"} (${attempt + 1}/${maxResumes}).`);
      options.onActivity?.("claude", `stream stalled; ${error.sessionId ? "resuming session" : "restarting turn"}`);
      if (error.sessionId) {
        attemptPrompt = STALL_RESUME_PROMPT;
        attemptOptions = { ...options, threadId: error.sessionId };
      }
    }
  }
}

async function runClaudeHeadlessOnce(
  prompt: string,
  options: ExecAgentOptions,
  onProgress?: (message: string) => void,
  onProcess?: (control: ProcessControl) => void,
  outputSchemaText?: string,
): Promise<AgentResult> {
  if (outputSchemaText) {
    try { JSON.parse(outputSchemaText); }
    catch { throw new Error("The configured Claude output schema is invalid JSON."); }
  }
  const sandboxMode = effectiveCodexSandbox(options.sandbox);
  const isolated = sandboxMode === "danger-full-access" && options.sandbox !== "workspace-write" ? createIsolatedCodexWorkspace(options.cwd) : undefined;
  const model = effectiveClaudeModel(options.model);
  // Claude Code reads image paths named in the prompt with its Read tool.
  const input = options.images?.length ? `${prompt}\n\nReference images (read them before answering):\n${options.images.join("\n")}` : prompt;
  const child = spawn(resolveClaudeBinary(), claudeHeadlessArgs(options, sandboxMode, model, outputSchemaText), {
    cwd: isolated?.path ?? options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group, so stopping the turn also stops shell jobs Claude left running.
    detached: true,
  });
  const signal = (name: NodeJS.Signals): boolean => {
    try { if (child.pid) { process.kill(-child.pid, name); return true; } } catch { /* group already gone */ }
    return child.kill(name);
  };
  child.stdin.end(input);

  let abortReason: string | undefined;
  let stalled = false;
  let paused = false;
  let settled = false;
  const stop = (reason: string): void => {
    if (settled || abortReason) return;
    abortReason = reason;
    if (paused) signal("SIGCONT");
    signal("SIGTERM");
    setTimeout(() => { if (!settled) signal("SIGKILL"); }, 5_000).unref();
  };
  // The turn is complete once Claude emits its result. Background shell jobs it started can keep the
  // CLI alive afterwards; stop the process then instead of discarding a finished turn as a timeout.
  let resultReceived = false;
  const endAfterResult = (): void => {
    if (settled) return;
    if (paused) signal("SIGCONT");
    signal("SIGTERM");
    setTimeout(() => { if (!settled) signal("SIGKILL"); }, 5_000).unref();
  };
  const timeout = setTimeout(() => { if (resultReceived) endAfterResult(); else stop("Claude request timed out."); }, options.timeoutMs ?? 30 * 60_000);
  // A stalled stream can sit silent for over an hour before the CLI notices. Silence only counts
  // while the model is generating: a running tool (a long evaluation) legitimately emits nothing.
  const idleLimitMs = claudeIdleLimitMs();
  let lastEventAt = Date.now();
  const openTools = new Set<string>();
  const watchdog = setInterval(() => {
    if (settled || paused || resultReceived || openTools.size > 0) return;
    if (Date.now() - lastEventAt < idleLimitMs) return;
    stalled = true;
    stop(`Claude stream stalled: no output for ${Math.round(idleLimitMs / 60_000)} minute(s) while generating.`);
  }, Math.min(30_000, Math.max(1_000, Math.floor(idleLimitMs / 4))));
  watchdog.unref();
  const signalHandler = (): void => stop("Claude request interrupted.");
  process.once("SIGTERM", signalHandler);
  process.once("SIGINT", signalHandler);
  options.interruptSignal?.addEventListener("abort", signalHandler, { once: true });
  if (options.interruptSignal?.aborted) signalHandler();
  // Unlike the Codex SDK, a headless CLI turn is a real process and can be suspended.
  onProcess?.({
    pause: () => { if (!settled && !paused && signal("SIGSTOP")) paused = true; },
    resume: () => { if (!settled && paused && signal("SIGCONT")) { paused = false; lastEventAt = Date.now(); } },
    terminate: () => stop("Claude request interrupted."),
    get paused() { return paused; },
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });

  let finalText = "";
  let result: Record<string, unknown> | undefined;
  let sessionId: string | undefined;
  let rejectedResetAt: number | undefined;
  let lastCommand: string | undefined;
  let repeatedCommands = 0;
  let consecutiveFailedCommands = 0;
  const bashToolIds = new Set<string>();

  const handle = (event: Record<string, unknown>): void => {
    options.onRawEvent?.(event);
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      sessionId = event.session_id;
      options.onThread?.(sessionId);
      onProgress?.("Thinking...");
      return;
    }
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info as { status?: unknown; resetsAt?: unknown } | undefined;
      if (info?.status === "rejected") rejectedResetAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : Date.now() + 60 * 60_000;
      return;
    }
    if (event.type === "result") {
      result = event;
      if (!resultReceived) {
        resultReceived = true;
        setTimeout(endAfterResult, 10_000).unref();
      }
      return;
    }
    const blocks = (event.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") openTools.delete(block.tool_use_id);
      if (event.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        finalText = block.text;
        onProgress?.(`Evidra · ${progressLine(block.text)}`);
      } else if (event.type === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
        if (typeof block.id === "string") openTools.add(block.id);
        const toolInput = block.input as Record<string, unknown> | undefined;
        const activity = toolActivity(block.name, toolInput);
        onProgress?.(activity);
        options.onActivity?.("claude", activity);
        if (block.name === "Bash" && typeof toolInput?.command === "string") {
          if (typeof block.id === "string") bashToolIds.add(block.id);
          if (toolInput.command === lastCommand) repeatedCommands += 1;
          else { lastCommand = toolInput.command; repeatedCommands = 1; }
          const limit = Math.max(0, Math.floor(options.maxRepeatedCommands ?? 0));
          if (limit > 0 && repeatedCommands >= limit) {
            onProgress?.("Agent appears stuck · stopping the repeated command loop.");
            stop(`Claude agent stuck: repeated the same command ${repeatedCommands} times (${progressLine(toolInput.command)}).`);
          }
        }
      } else if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string" && bashToolIds.has(block.tool_use_id)) {
        if (block.is_error === true) consecutiveFailedCommands += 1;
        else consecutiveFailedCommands = 0;
        const limit = Math.max(0, Math.floor(options.maxFailedCommands ?? 0));
        if (limit > 0 && consecutiveFailedCommands >= limit) {
          onProgress?.("Agent route is failing repeatedly · switching strategy.");
          stop(`Claude agent route failed: ${consecutiveFailedCommands} consecutive shell commands failed.`);
        }
      }
    }
  };

  try {
    let buffered = "";
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        lastEventAt = Date.now();
        buffered += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          try { handle(JSON.parse(line) as Record<string, unknown>); }
          catch { /* Non-JSON diagnostics are kept on stderr; ignore stray lines. */ }
        }
      });
      child.on("error", reject);
      child.on("close", resolve);
      // After the result, the CLI's own exit ends the turn even if an orphaned job still holds the pipe.
      child.on("exit", (code) => { if (resultReceived) { child.stdout.destroy(); child.stderr.destroy(); resolve(code); } });
    });
    settled = true;
    if (abortReason) throw stalled ? new ClaudeStreamStalledError(abortReason, sessionId) : new Error(abortReason);
    const usage = claudeUsage(result?.usage);
    const diagnostic = `${typeof result?.result === "string" ? result.result : ""} ${stderr}`;
    if (rejectedResetAt !== undefined || result?.api_error_status === 429 || /usage limit|rate limit|limit reached|overloaded/i.test(result?.is_error ? diagnostic : stderr)) {
      const retryAfterMs = Math.max(60_000, (rejectedResetAt ?? Date.now() + 60 * 60_000) - Date.now());
      throw new ProviderUsageLimitError(`Claude usage limit reached. Retrying in ${Math.ceil(retryAfterMs / 60_000)} minute(s).`, retryAfterMs);
    }
    if (!result) {
      if (/not logged in|login|authenticat/i.test(stderr)) throw new Error("Claude is not logged in. Run `claude` once and sign in, or set ANTHROPIC_API_KEY.");
      throw new Error(`Claude stream ended before the turn completed (exit ${exitCode}).${stderr.trim() ? ` ${progressLine(stderr, 400)}` : ""}`);
    }
    if (result.is_error === true || result.subtype !== "success") {
      if (/network|ECONNRESET|timed out|connection/i.test(diagnostic)) throw new Error("Claude is unreachable right now. Check your connection, then try again.");
      throw new Error(`Claude turn failed (${String(result.subtype ?? "error")}): ${progressLine(diagnostic, 400)}`);
    }
    const output = result.structured_output !== undefined
      ? JSON.stringify(result.structured_output)
      : typeof result.result === "string" && result.result.trim() ? result.result : finalText;
    if (!output) throw new Error("Claude returned no assistant response.");
    onProgress?.("Completed.");
    options.onAssistant?.("claude", output);
    return { provider: "claude", model, threadId: sessionId ?? options.threadId, output, usage };
  } finally {
    settled = true;
    clearTimeout(timeout);
    clearInterval(watchdog);
    process.removeListener("SIGTERM", signalHandler);
    process.removeListener("SIGINT", signalHandler);
    options.interruptSignal?.removeEventListener("abort", signalHandler);
    isolated?.cleanup();
  }
}
