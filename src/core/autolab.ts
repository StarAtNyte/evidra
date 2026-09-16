import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

/** Public task contract exposed by AutoLab's task.toml files. */
export interface AutoLabTask {
  id: string;
  path: string;
  taskFile: string;
  instructionPath: string;
  valid: boolean;
  missingFiles: string[];
  difficulty?: string;
  domain?: string;
  tags: string[];
  metric?: string;
  direction?: "maximize" | "minimize";
  baseline?: { score: number; method?: string };
  reference?: { score: number; method?: string };
  resources?: { cpus?: number; memoryMb?: number; storageMb?: number; gpus?: number; allowInternet?: boolean };
  agentTimeoutSec?: number;
  verifierTimeoutSec?: number;
}

export interface AutoLabDiscovery {
  schemaVersion: 1;
  repository: string;
  tasks: AutoLabTask[];
  validTasks: number;
  invalidTasks: number;
}

const AutoLabTaskSchema = z.object({
  id: z.string().min(1), path: z.string().min(1), taskFile: z.string().min(1), instructionPath: z.string().min(1),
  valid: z.boolean(), missingFiles: z.array(z.string()), difficulty: z.string().optional(), domain: z.string().optional(), tags: z.array(z.string()),
  metric: z.string().optional(), direction: z.enum(["maximize", "minimize"]).optional(),
  baseline: z.object({ score: z.number().finite(), method: z.string().optional() }).optional(),
  reference: z.object({ score: z.number().finite(), method: z.string().optional() }).optional(),
  resources: z.object({ cpus: z.number().finite().optional(), memoryMb: z.number().finite().optional(), storageMb: z.number().finite().optional(), gpus: z.number().finite().optional(), allowInternet: z.boolean().optional() }).optional(),
  agentTimeoutSec: z.number().finite().optional(), verifierTimeoutSec: z.number().finite().optional(),
}).passthrough();

export const AutoLabDiscoverySchema = z.object({
  schemaVersion: z.literal(1), repository: z.string().min(1), tasks: z.array(AutoLabTaskSchema), validTasks: z.number().int().nonnegative(), invalidTasks: z.number().int().nonnegative(),
}).passthrough().superRefine((discovery, context) => {
  if (discovery.validTasks !== discovery.tasks.filter((task) => task.valid).length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["validTasks"], message: "must equal the number of valid tasks" });
  if (discovery.invalidTasks !== discovery.tasks.filter((task) => !task.valid).length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["invalidTasks"], message: "must equal the number of invalid tasks" });
  const ids = new Set<string>();
  for (const [index, task] of discovery.tasks.entries()) {
    if (ids.has(task.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "id"], message: "task identities must be unique" });
    ids.add(task.id);
    if (task.valid && task.missingFiles.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tasks", index, "valid"], message: "valid tasks cannot list missing files" });
  }
});

export function parseAutoLabDiscovery(value: unknown): AutoLabDiscovery {
  return AutoLabDiscoverySchema.parse(value) as AutoLabDiscovery;
}

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index - 1] !== "\\") quoted = !quoted;
    if (line[index] === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function tomlValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true" || value === "false") return value === "true";
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => tomlValue(item)).filter((item) => item !== "");
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function parseTaskToml(text: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) { section = table[1].trim(); continue; }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const key = section ? `${section}.${assignment[1]}` : assignment[1];
    output[key] = tomlValue(assignment[2]);
  }
  return output;
}

function stringValue(parsed: Record<string, unknown>, key: string): string | undefined {
  const value = parsed[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(parsed: Record<string, unknown>, key: string): number | undefined {
  const value = parsed[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(parsed: Record<string, unknown>, key: string): boolean | undefined {
  return typeof parsed[key] === "boolean" ? parsed[key] as boolean : undefined;
}

function metricDirection(parsed: Record<string, unknown>): "maximize" | "minimize" | undefined {
  const value = stringValue(parsed, "optimization.direction")?.toLowerCase();
  return value === "maximize" || value === "higher" || value === "max" ? "maximize"
    : value === "minimize" || value === "lower" || value === "min" ? "minimize"
      : undefined;
}

function pair(parsed: Record<string, unknown>, prefix: string): { score: number; method?: string } | undefined {
  const score = finiteNumber(parsed, `${prefix}.score`);
  if (score === undefined) return undefined;
  const method = stringValue(parsed, `${prefix}.method`);
  return { score, ...(method ? { method } : {}) };
}

/** Discover AutoLab task contracts without installing Harbor or executing a task. */
export function discoverAutoLabTasks(repositoryRoot: string): AutoLabDiscovery {
  const repository = resolve(repositoryRoot);
  const tasksRoot = join(repository, "tasks");
  if (!existsSync(tasksRoot) || !statSync(tasksRoot).isDirectory()) throw new Error(`AutoLab tasks directory not found: ${tasksRoot}`);
  const tasks: AutoLabTask[] = [];
  for (const id of readdirSync(tasksRoot).sort()) {
    const taskPath = join(tasksRoot, id);
    if (!statSync(taskPath).isDirectory()) continue;
    const taskFilePath = join(taskPath, "task.toml");
    const instructionFilePath = join(taskPath, "instruction.md");
    const missingFiles = ["task.toml", "instruction.md"].filter((file) => !existsSync(join(taskPath, file)));
    const parsed = existsSync(taskFilePath) ? parseTaskToml(readFileSync(taskFilePath, "utf8")) : {};
    const metric = stringValue(parsed, "optimization.metric");
    const direction = metricDirection(parsed);
    const resources = Object.fromEntries(Object.entries({
      cpus: finiteNumber(parsed, "environment.cpus"), memoryMb: finiteNumber(parsed, "environment.memory_mb"), storageMb: finiteNumber(parsed, "environment.storage_mb"), gpus: finiteNumber(parsed, "environment.gpus"), allowInternet: boolValue(parsed, "environment.allow_internet"),
    }).filter(([, value]) => value !== undefined)) as AutoLabTask["resources"];
    const task: AutoLabTask = {
      id, path: relative(repository, taskPath), taskFile: relative(repository, taskFilePath), instructionPath: relative(repository, instructionFilePath),
      valid: missingFiles.length === 0 && Boolean(metric) && Boolean(direction) && Boolean(pair(parsed, "optimization.baseline")), missingFiles, tags: Array.isArray(parsed["metadata.tags"]) ? (parsed["metadata.tags"] as unknown[]).filter((tag): tag is string => typeof tag === "string") : [],
      ...(stringValue(parsed, "metadata.difficulty") ? { difficulty: stringValue(parsed, "metadata.difficulty") } : {}), ...(stringValue(parsed, "metadata.domain") ? { domain: stringValue(parsed, "metadata.domain") } : {}),
      ...(metric ? { metric } : {}), ...(direction ? { direction } : {}), ...(pair(parsed, "optimization.baseline") ? { baseline: pair(parsed, "optimization.baseline") } : {}), ...(pair(parsed, "optimization.reference") ? { reference: pair(parsed, "optimization.reference") } : {}),
      ...(Object.keys(resources ?? {}).length ? { resources } : {}), ...(finiteNumber(parsed, "agent.timeout_sec") !== undefined ? { agentTimeoutSec: finiteNumber(parsed, "agent.timeout_sec") } : {}), ...(finiteNumber(parsed, "verifier.timeout_sec") !== undefined ? { verifierTimeoutSec: finiteNumber(parsed, "verifier.timeout_sec") } : {}),
    };
    tasks.push(task);
  }
  return { schemaVersion: 1, repository, tasks, validTasks: tasks.filter((task) => task.valid).length, invalidTasks: tasks.filter((task) => !task.valid).length };
}
