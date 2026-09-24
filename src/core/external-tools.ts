import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ResearchStore } from "./store.js";

const MANIFEST_PATH = ".evidra/tools.json";
const MAX_MANIFEST_BYTES = 128_000;
const MAX_TOOLS = 32;
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
};

export type ExternalToolLoadResult = { tools: ExternalResearchTool[]; warnings: string[]; path: string | null; contentHash: string | null };
export type ExternalToolStatus = "enabled" | "disabled" | "quarantined";
export type ExternalToolState = { status: ExternalToolStatus; reason?: string; changedAt: string; manifestHash?: string };
export type ExternalToolStateMap = Record<string, ExternalToolState>;

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

/** Load explicitly declared, argv-only project tools; malformed entries are quarantined as warnings. */
export function loadExternalResearchTools(root: string): ExternalToolLoadResult {
  const path = resolve(root, MANIFEST_PATH);
  if (!existsSync(path) || !lstatSync(path).isFile()) return { tools: [], warnings: [], path: null, contentHash: null };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) { return { tools: [], warnings: [`${MANIFEST_PATH} could not be read: ${error instanceof Error ? error.message : String(error)}`], path: MANIFEST_PATH, contentHash: null }; }
  const contentHash = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  let parsed: unknown;
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) return { tools: [], warnings: [`${MANIFEST_PATH} exceeds the ${MAX_MANIFEST_BYTES}-byte limit`], path: MANIFEST_PATH, contentHash };
    parsed = JSON.parse(text);
  } catch (error) {
    return { tools: [], warnings: [`${MANIFEST_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`], path: MANIFEST_PATH, contentHash };
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
    if (!name || !/^external\.[a-z0-9][a-z0-9._-]{1,78}$/.test(name) || names.has(name) || !description || !command) {
      warnings.push(`${MANIFEST_PATH} tool ${index + 1} is invalid; expected a unique external.* name, description, and argv command`);
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
    names.add(name);
    tools.push({ name, description, input, readOnly: value.readOnly === true, cacheable: value.cacheable !== false && value.readOnly === true, command, roles, timeoutMs });
  }
  return { tools, warnings, path: MANIFEST_PATH, contentHash };
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
      state[name] = { status, ...(typeof value.reason === "string" && value.reason.trim() ? { reason: value.reason.slice(0, 500) } : {}), changedAt: typeof value.changedAt === "string" ? value.changedAt : new Date(0).toISOString(), ...(typeof value.manifestHash === "string" && /^sha256:[a-f0-9]{64}$/.test(value.manifestHash) ? { manifestHash: value.manifestHash } : {}) };
    }
    return state;
  } catch { return {}; }
}

export function externalToolStatus(root: string, name: string): ExternalToolState {
  const manifest = loadExternalResearchTools(root);
  const state = loadExternalToolState(root)[name] ?? { status: "enabled" as const, changedAt: new Date(0).toISOString() };
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
