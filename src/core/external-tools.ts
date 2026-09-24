import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MANIFEST_PATH = ".evidra/tools.json";
const MAX_MANIFEST_BYTES = 128_000;
const MAX_TOOLS = 32;
const MAX_COMMAND_PARTS = 32;

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

export type ExternalToolLoadResult = { tools: ExternalResearchTool[]; warnings: string[]; path: string | null };

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

/** Load explicitly declared, argv-only project tools; malformed entries are quarantined as warnings. */
export function loadExternalResearchTools(root: string): ExternalToolLoadResult {
  const path = resolve(root, MANIFEST_PATH);
  if (!existsSync(path) || !lstatSync(path).isFile()) return { tools: [], warnings: [], path: null };
  let parsed: unknown;
  try {
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) return { tools: [], warnings: [`${MANIFEST_PATH} exceeds the ${MAX_MANIFEST_BYTES}-byte limit`], path: MANIFEST_PATH };
    parsed = JSON.parse(text);
  } catch (error) {
    return { tools: [], warnings: [`${MANIFEST_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`], path: MANIFEST_PATH };
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
  return { tools, warnings, path: MANIFEST_PATH };
}
