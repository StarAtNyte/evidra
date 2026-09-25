import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ResearchStore } from "./store.js";

const MANIFEST_PATH = ".evidra/tools.json";
const MAX_MANIFEST_BYTES = 128_000;
const MAX_TOOLS = 32;
const MAX_PLUGINS = 16;
const MAX_COMMAND_PARTS = 32;
const TOOL_STATE_PATH = ".sota/tool-state.json";
const MAX_STATE_BYTES = 64_000;

export type ExternalResearchTool = {
  name: string;
  description: string;
  input: Record<string, string>;
  readOnly: boolean;
  cacheable: boolean;
  command: string[];
  roles: string[];
  timeoutMs: number;
  /** Built-in project manifest or an explicitly discovered plugin manifest. */
  source?: string;
};

export type ExternalToolLoadResult = { tools: ExternalResearchTool[]; warnings: string[]; path: string | null; contentHash: string | null };
export type ExternalToolStatus = "enabled" | "disabled" | "quarantined";
export type ExternalToolHealth = { status: "ok" | "failed"; checkedAt: string; failureStreak: number; lastError?: string };
export type ExternalToolState = { status: ExternalToolStatus; reason?: string; changedAt: string; manifestHash?: string; health?: ExternalToolHealth };
export type ExternalToolStateMap = Record<string, ExternalToolState>;

const MAX_HEALTH_ERROR = 500;
const HEALTH_FAILURE_QUARANTINE_THRESHOLD = 3;

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

function parseManifestTools(text: string, label: string, pluginId?: string): { tools: ExternalResearchTool[]; warnings: string[] } {
  let parsed: unknown;
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) return { tools: [], warnings: [`${label} exceeds the ${MAX_MANIFEST_BYTES}-byte limit`] };
    parsed = JSON.parse(text);
  } catch (error) {
    return { tools: [], warnings: [`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).tools)
    ? (parsed as { tools: unknown[] }).tools.slice(0, MAX_TOOLS)
    : [];
  const warnings: string[] = [];
  const tools: ExternalResearchTool[] = [];
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
    const name = boundedString(value.name, 80);
    const description = boundedString(value.description, 500);
    const command = Array.isArray(value.command) && value.command.length > 0 && value.command.length <= MAX_COMMAND_PARTS && value.command.every((part) => typeof part === "string" && part.length > 0 && part.length <= 400)
      ? value.command as string[]
      : undefined;
    const normalizedName = pluginId && name?.startsWith("external.") ? `external.${pluginId}.${name.slice("external.".length)}` : name;
    if (!normalizedName || !/^external\.[a-z0-9][a-z0-9._-]{1,78}$/.test(normalizedName) || names.has(normalizedName) || !description || !command) {
      warnings.push(`${label} tool ${index + 1} is invalid; expected a unique external.* name, description, and argv command`);
      continue;
    }
    const roles = Array.isArray(value.roles) && value.roles.every((role) => typeof role === "string" && role.trim().length > 0 && role.length <= 100)
      ? [...new Set(value.roles.map((role) => role.trim()))].slice(0, 16)
      : [];
    const inputValue = value.input && typeof value.input === "object" && !Array.isArray(value.input) ? value.input as Record<string, unknown> : {};
    const input = Object.fromEntries(Object.entries(inputValue).slice(0, 32).flatMap(([key, descriptionValue]) => {
      const descriptionText = boundedString(descriptionValue, 240);
      return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && descriptionText ? [[key, descriptionText]] : [];
    }));
    const timeoutMs = typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) ? Math.max(1_000, Math.min(15 * 60_000, Math.floor(value.timeoutMs))) : 120_000;
    names.add(normalizedName);
    tools.push({ name: normalizedName, description, input, readOnly: value.readOnly === true, cacheable: value.cacheable !== false && value.readOnly === true, command, roles, timeoutMs, ...(pluginId ? { source: label } : {}) });
  }
  return { tools, warnings };
}

/** Load argv-only project tools and namespaced plugin tools; plugin tools start quarantined. */
export function loadExternalResearchTools(root: string): ExternalToolLoadResult {
  const sources: Array<{ path: string; text: string; pluginId?: string }> = [];
  const warnings: string[] = [];
  const basePath = resolve(root, MANIFEST_PATH);
  if (existsSync(basePath) && lstatSync(basePath).isFile()) {
    try { sources.push({ path: MANIFEST_PATH, text: readFileSync(basePath, "utf8") }); }
    catch (error) { warnings.push(`${MANIFEST_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const pluginRoot = resolve(root, ".evidra/plugins");
  if (existsSync(pluginRoot) && lstatSync(pluginRoot).isDirectory()) {
    for (const entry of readdirSync(pluginRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).slice(0, MAX_PLUGINS)) {
      if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(entry.name)) { warnings.push(`.evidra/plugins/${entry.name} has an invalid plugin id`); continue; }
      const pluginPath = join(pluginRoot, entry.name, "plugin.json");
      if (!existsSync(pluginPath) || !lstatSync(pluginPath).isFile()) { warnings.push(`.evidra/plugins/${entry.name}/plugin.json is missing`); continue; }
      try { sources.push({ path: `.evidra/plugins/${entry.name}/plugin.json`, text: readFileSync(pluginPath, "utf8"), pluginId: entry.name }); }
      catch (error) { warnings.push(`${pluginPath} could not be read: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  if (!sources.length) return { tools: [], warnings, path: null, contentHash: null };
  const contentHash = `sha256:${createHash("sha256").update(sources.map((source) => `${source.path}\n${source.text}`).join("\n")).digest("hex")}`;
  const tools: ExternalResearchTool[] = [];
  const names = new Set<string>();
  for (const source of sources) {
    const parsed = parseManifestTools(source.text, source.path, source.pluginId);
    warnings.push(...parsed.warnings);
    for (const tool of parsed.tools) {
      if (names.has(tool.name)) warnings.push(`${source.path} duplicates tool '${tool.name}'`);
      else { names.add(tool.name); tools.push(tool); }
    }
  }
  return { tools: tools.slice(0, MAX_TOOLS), warnings, path: sources.map((source) => source.path).join(", "), contentHash };
}

/** Load operator-owned lifecycle state separately from the project manifest. */
export function loadExternalToolState(root: string): ExternalToolStateMap {
  const path = resolve(root, TOOL_STATE_PATH);
  if (!existsSync(path) || !lstatSync(path).isFile()) return {};
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: ExternalToolStateMap = {};
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>).slice(0, MAX_TOOLS)) {
      if (!/^external\.[a-z0-9][a-z0-9._-]{1,78}$/.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      const status = value.status;
      if (status !== "enabled" && status !== "disabled" && status !== "quarantined") continue;
      const healthValue = value.health;
      const health = healthValue && typeof healthValue === "object" && !Array.isArray(healthValue)
        ? healthValue as Record<string, unknown>
        : undefined;
      const healthStatus = health?.status === "ok" || health?.status === "failed" ? health.status : undefined;
      const failureStreak = typeof health?.failureStreak === "number" && Number.isInteger(health.failureStreak) ? Math.max(0, Math.min(HEALTH_FAILURE_QUARANTINE_THRESHOLD, health.failureStreak)) : undefined;
      state[name] = {
        status,
        ...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.slice(0, 500) } : {}),
        changedAt: typeof value.changedAt === "string" ? value.changedAt : new Date(0).toISOString(),
        ...(typeof value.manifestHash === "string" && /^sha256:[a-f0-9]{64}$/.test(value.manifestHash) ? { manifestHash: value.manifestHash } : {}),
        ...(healthStatus && failureStreak !== undefined && typeof health?.checkedAt === "string" ? {
          health: { status: healthStatus, checkedAt: health.checkedAt, failureStreak, ...(typeof health.lastError === "string" && health.lastError.trim() ? { lastError: health.lastError.slice(0, MAX_HEALTH_ERROR) } : {}) },
        } : {}),
      };
    }
    return state;
  } catch { return {}; }
}

export function externalToolStatus(root: string, name: string): ExternalToolState {
  const manifest = loadExternalResearchTools(root);
  const tool = manifest.tools.find((entry) => entry.name === name);
  const state = loadExternalToolState(root)[name] ?? (tool?.source ? { status: "quarantined" as const, reason: "plugin requires explicit operator approval", changedAt: new Date(0).toISOString() } : { status: "enabled" as const, changedAt: new Date(0).toISOString() });
  if (state.manifestHash && manifest.contentHash && state.manifestHash !== manifest.contentHash) {
    return { ...state, status: "quarantined", reason: "adapter manifest changed since its last operator approval" };
  }
  return state;
}

export function activeExternalResearchTools(root: string): ExternalResearchTool[] {
  return loadExternalResearchTools(root).tools.filter((tool) => externalToolStatus(root, tool.name).status === "enabled");
}

export function setExternalToolStatus(root: string, name: string, status: ExternalToolStatus, reason?: string): ExternalToolState {
  const manifest = loadExternalResearchTools(root);
  if (!manifest.tools.some((tool) => tool.name === name)) throw new Error(`Unknown external tool '${name}'.`);
  const state = loadExternalToolState(root);
  const next = { status, ...(reason?.trim() ? { reason: reason.trim().slice(0, 500) } : {}), changedAt: new Date().toISOString(), ...(manifest.contentHash ? { manifestHash: manifest.contentHash } : {}) } satisfies ExternalToolState;
  state[name] = next;
  const path = resolve(root, TOOL_STATE_PATH);
  mkdirSync(resolve(root, ".sota"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    const store = new ResearchStore(resolve(root, ".sota/database.sqlite"));
    store.appendEvent("research.external_tool.lifecycle_changed", { name, status, reason: next.reason ?? null, source: "operator" });
    store.close();
  } catch {
    // The lifecycle file remains authoritative if telemetry cannot be opened.
  }
  return next;
}

/** Persist bounded adapter health across CLI and controller restarts. */
export function recordExternalToolHealth(root: string, name: string, ok: boolean, error?: string): ExternalToolState {
  const manifest = loadExternalResearchTools(root);
  if (!manifest.tools.some((tool) => tool.name === name)) throw new Error(`Unknown external tool '${name}'.`);
  const state = loadExternalToolState(root);
  const previous = state[name] ?? { status: "enabled" as const, changedAt: new Date(0).toISOString() };
  const failureStreak = ok ? 0 : Math.min(HEALTH_FAILURE_QUARANTINE_THRESHOLD, (previous.health?.failureStreak ?? 0) + 1);
  const checkedAt = new Date().toISOString();
  const health: ExternalToolHealth = {
    status: ok ? "ok" : "failed",
    checkedAt,
    failureStreak,
    ...(error?.trim() ? { lastError: error.trim().slice(0, MAX_HEALTH_ERROR) } : {}),
  };
  const shouldQuarantine = !ok && failureStreak >= HEALTH_FAILURE_QUARANTINE_THRESHOLD && previous.status === "enabled";
  const next: ExternalToolState = {
    ...previous,
    ...(shouldQuarantine ? { status: "quarantined" as const, reason: `automatic quarantine after ${failureStreak} consecutive health failures` } : {}),
    health,
    changedAt: shouldQuarantine ? checkedAt : previous.changedAt,
    ...(manifest.contentHash ? { manifestHash: manifest.contentHash } : {}),
  };
  state[name] = next;
  const path = resolve(root, TOOL_STATE_PATH);
  mkdirSync(resolve(root, ".sota"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    const store = new ResearchStore(resolve(root, ".sota/database.sqlite"));
    store.appendEvent("research.external_tool.health_checked", {
      name,
      status: health.status,
      failureStreak,
      quarantined: shouldQuarantine,
      error: health.lastError ?? null,
      source: "health_probe",
    });
    if (shouldQuarantine) store.appendEvent("research.external_tool.lifecycle_changed", { name, status: next.status, reason: next.reason, source: "health_probe" });
    store.close();
  } catch {
    // Health state remains authoritative if telemetry cannot be opened.
  }
  return next;
}
