import { existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { auditData } from "./data-audit.js";
import { guardAutonomousCommand, guardReadOnlyInspection, type AutonomyLevel } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";
import { splitCommandLine } from "./process.js";
import { renderReport, writeReport, type ReportKind } from "./reports.js";
import { createValidationPolicy, writeValidationPolicy } from "./validation-policy.js";
import { retrieveSource, searchResearchSources, sourceClaims } from "./sources.js";
import { ResearchStore } from "./store.js";
import type { CompetitionConfig } from "./types.js";
import { isSensitiveWorkspacePath, redactSecrets } from "./redaction.js";

export interface ResearchToolContext {
  root: string;
  storePath: string;
  autonomy: AutonomyLevel;
  competition?: CompetitionConfig;
  onProgress?: (message: string) => void;
  onProcess?: (control: ProcessControl) => void;
}

export interface ResearchToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ResearchToolResult {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface ResearchToolSpec {
  name: string;
  description: string;
  input: Record<string, string>;
  readOnly: boolean;
}

function recordToolEvent(context: ResearchToolContext, result: ResearchToolResult): void {
  try {
    const store = new ResearchStore(context.storePath);
    const output = result.output === undefined ? undefined : redactSecrets(JSON.stringify(result.output).slice(0, 8_000));
    store.appendEvent(result.ok ? "research.tool.completed" : "research.tool.failed", {
      name: result.name,
      ok: result.ok,
      error: result.error,
      output,
    });
    store.close();
  } catch {
    // Tool audit logging must not turn a successful research observation into a failure.
  }
}

export const RESEARCH_TOOLS: ResearchToolSpec[] = [
  { name: "workspace.files", description: "List tracked and untracked workspace files excluding state and dependencies.", input: {}, readOnly: true },
  { name: "workspace.search", description: "Search text or regular expressions in the workspace.", input: { query: "text or regular expression", path: "optional relative path" }, readOnly: true },
  { name: "workspace.read", description: "Read a bounded text file inside the workspace.", input: { path: "relative file path", maxBytes: "optional byte limit" }, readOnly: true },
  { name: "git.status", description: "Read the current Git status and HEAD commit.", input: {}, readOnly: true },
  { name: "shell.exec", description: "Run an allowlisted shell command with captured output.", input: { command: "argv array or shell string", timeoutMs: "optional timeout" }, readOnly: true },
  { name: "source.retrieve", description: "Retrieve, hash, excerpt, and store a research source with extracted claims.", input: { url: "HTTP(S) URL" }, readOnly: false },
  { name: "source.search", description: "Search scholarly works and return ranked candidates for later retrieval.", input: { query: "research question or keywords", limit: "optional result count" }, readOnly: true },
  { name: "data.audit", description: "Audit workspace files for size, duplicates, and suspicious data issues.", input: { path: "optional relative path" }, readOnly: true },
  { name: "validation.generate", description: "Create a versioned validation policy for the active workspace.", input: {}, readOnly: false },
  { name: "report.generate", description: "Write a durable research, challenge, or final report.", input: { kind: "research|challenge|final" }, readOnly: false },
];

function inside(root: string, requested: string): string {
  const rootPath = realpathSync(root);
  const path = resolve(rootPath, requested);
  const rel = relative(rootPath, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path escapes the workspace: ${requested}`);
  if (isSensitiveWorkspacePath(rel)) throw new Error(`Refusing to expose sensitive workspace path: ${requested}`);
  if (existsSync(path)) {
    const resolvedPath = realpathSync(path);
    const resolvedRel = relative(rootPath, resolvedPath);
    if (resolvedRel.startsWith("..") || isAbsolute(resolvedRel)) throw new Error(`Path escapes the workspace through a symlink: ${requested}`);
    if (isSensitiveWorkspacePath(resolvedRel)) throw new Error(`Refusing to expose sensitive workspace path: ${requested}`);
    return resolvedPath;
  }
  return path;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Tool argument '${name}' is required.`);
  return value;
}

function commandArgs(value: unknown): string[] {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  if (typeof value === "string") return splitCommandLine(value);
  throw new Error("Tool argument 'command' must be an argv array or non-empty string.");
}

export async function executeResearchTool(call: ResearchToolCall, context: ResearchToolContext): Promise<ResearchToolResult> {
  try {
    const spec = RESEARCH_TOOLS.find((tool) => tool.name === call.name);
    if (!spec) throw new Error(`Unknown research tool: ${call.name}`);
    if (context.autonomy === "safe" && !spec.readOnly) {
      throw new Error(`SAFE mode permits inspection tools only; '${call.name}' requires fast or yolo autonomy.`);
    }
    const args = call.arguments ?? {};
    let output: unknown;
    switch (call.name) {
      case "workspace.files": {
        const result = await runProcess(["rg", "--files", "-g", "!.sota/**", "-g", "!node_modules/**"], context.root, 30_000, undefined, context.onProcess);
        output = { exitCode: result.exitCode, files: result.stdout.split("\n").filter(Boolean).slice(0, 2_000) };
        break;
      }
      case "workspace.search": {
        const query = stringArg(args, "query");
        const target = typeof args.path === "string" ? inside(context.root, args.path) : context.root;
        const result = await runProcess(["rg", "-n", "--hidden", "-g", "!.sota/**", "-g", "!node_modules/**", query, target], context.root, 30_000, undefined, context.onProcess);
        output = { exitCode: result.exitCode, matches: result.stdout.slice(0, 50_000), stderr: result.stderr.slice(0, 4_000) };
        break;
      }
      case "workspace.read": {
        const path = inside(context.root, stringArg(args, "path"));
        if (!existsSync(path)) throw new Error(`File does not exist: ${args.path}`);
        const maxBytes = typeof args.maxBytes === "number" ? Math.max(1, Math.min(args.maxBytes, 2_000_000)) : 200_000;
        output = { path: relative(context.root, path), truncated: readFileSync(path).byteLength > maxBytes, text: redactSecrets(readFileSync(path, "utf8").slice(0, maxBytes)) };
        break;
      }
      case "git.status": {
        const status = await runProcess(["git", "status", "--short"], context.root, 30_000, undefined, context.onProcess);
        const head = await runProcess(["git", "rev-parse", "HEAD"], context.root, 30_000, undefined, context.onProcess);
        output = { head: head.stdout.trim(), status: status.stdout.trim(), statusCode: status.exitCode };
        break;
      }
      case "shell.exec": {
        const command = commandArgs(args.command);
        const guard = guardAutonomousCommand(command);
        if (!guard.allowed) throw new Error(guard.reason);
        if (context.autonomy === "safe") {
          const inspection = guardReadOnlyInspection(command);
          if (!inspection.allowed) throw new Error(inspection.reason);
        }
        const timeout = typeof args.timeoutMs === "number" ? Math.max(1_000, Math.min(args.timeoutMs, 15 * 60_000)) : 120_000;
        context.onProgress?.(`Tool shell.exec · ${command.join(" ")}`);
        const result = await runProcess(command, context.root, timeout, undefined, context.onProcess);
        output = { exitCode: result.exitCode, stdout: redactSecrets(result.stdout.slice(-50_000)), stderr: redactSecrets(result.stderr.slice(-10_000)), durationMs: result.durationMs };
        break;
      }
      case "source.retrieve": {
        const url = stringArg(args, "url");
        const retrieved = await retrieveSource(url);
        const claims = sourceClaims(retrieved.text);
        const store = new ResearchStore(context.storePath);
        store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims } });
        for (const [index, statement] of claims.entries()) store.saveClaim({ id: `${retrieved.id}_claim_${index + 1}`, payload: { id: `${retrieved.id}_claim_${index + 1}`, statement, scope: retrieved.url, confidence: 0.35, sourceType: "literature", sourceId: retrieved.id, status: "active" } });
        store.appendEvent("research.source.retrieved", { id: retrieved.id, url: retrieved.url, claimCount: claims.length });
        store.close();
        output = { id: retrieved.id, title: retrieved.title, url: retrieved.url, claims, excerpt: retrieved.excerpt };
        break;
      }
      case "source.search": {
        const query = stringArg(args, "query");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8;
        output = { query, results: await searchResearchSources(query, limit) };
        break;
      }
      case "data.audit": {
        const target = typeof args.path === "string" ? inside(context.root, args.path) : context.root;
        output = auditData(target);
        break;
      }
      case "validation.generate": {
        if (!context.competition) throw new Error("No workspace configuration is active.");
        const policy = createValidationPolicy(context.competition);
        const path = join(context.root, ".sota", "validation-policy.json");
        mkdirSync(join(context.root, ".sota"), { recursive: true });
        const checksum = writeValidationPolicy(path, policy);
        output = { path, checksum, policy };
        break;
      }
      case "report.generate": {
        const kind = stringArg(args, "kind") as ReportKind;
        if (!["research", "challenge", "final"].includes(kind)) throw new Error("Report kind must be research, challenge, or final.");
        const store = new ResearchStore(context.storePath);
        const content = renderReport(store, kind);
        const path = writeReport(context.root, kind, content);
        store.appendEvent("report.generated", { kind, path });
        store.close();
        output = { kind, path };
        break;
      }
      default: throw new Error(`Unknown research tool: ${call.name}`);
    }
    const result = { name: call.name, ok: true, output };
    recordToolEvent(context, result);
    return result;
  } catch (error) {
    const result = { name: call.name, ok: false, error: error instanceof Error ? error.message : String(error) };
    recordToolEvent(context, result);
    return result;
  }
}
