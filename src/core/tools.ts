import { existsSync, readFileSync, mkdirSync, realpathSync, lstatSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { auditData } from "./data-audit.js";
import { guardAutonomousCommand, guardReadOnlyInspection, type AutonomyLevel } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";
import { splitCommandLine } from "./process.js";
import { renderReport, writeReport, type ReportKind } from "./reports.js";
import { createValidationPolicy, writeValidationPolicy } from "./validation-policy.js";
import { DEFAULT_SOURCE_REFRESH_MS, researchSearchQueries, retrieveSource, searchResearchRepositories, searchResearchSources, searchResearchWeb, sourceClaims, sourceFrontier, sourceIsFresh } from "./sources.js";
import { ResearchStore } from "./store.js";
import type { CompetitionConfig } from "./types.js";
import { isSensitiveWorkspacePath, redactSecrets } from "./redaction.js";
import { readValidationPolicyLock } from "./validation-lock.js";
import { sha256File } from "./evidence.js";
import { analyzePredictionRows, comparePredictionRows, parsePredictionRows } from "./error-analysis.js";

const SOURCE_FRONTIER_EVENT_TYPES = [
  "research.source.search.completed",
  "research.web.search.completed",
  "research.source.retrieved",
] as const;

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

export type ResearchToolTrust = "controller_observation" | "untrusted_content" | "permission_boundary";

export interface ResearchToolResult {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  /** Trust class prevents retrieved text or workspace instructions becoming agent directives. */
  trust: ResearchToolTrust;
  /** Deterministic signals found in untrusted content; signals never execute or rewrite content. */
  securityWarnings?: string[];
}

export interface ResearchToolSpec {
  name: string;
  description: string;
  input: Record<string, string>;
  readOnly: boolean;
}

/** Apply the safest default when a provider or test double omits provenance metadata. */
export function normalizeResearchToolResult(result: ResearchToolResult): ResearchToolResult {
  return result.trust ? result : { ...result, trust: "untrusted_content" };
}

/** Classify only explicit policy/containment denials as permission-boundary events. */
export function toolFailureTrust(message: string): ResearchToolTrust {
  return /permission|refusing|safe mode|loopback|private or loopback|escapes the workspace|sensitive workspace|symlink/i.test(message)
    ? "permission_boundary"
    : "controller_observation";
}

/** Detect common instruction-injection signals without pretending to judge intent. */
export function untrustedContentWarnings(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const checks: Array<[string, RegExp]> = [
    ["instruction_override", /ignore\s+(all\s+)?previous|disregard\s+(the\s+)?(system|developer|先前)|follow\s+these\s+new\s+instructions/i],
    ["privilege_escalation", /disable\s+(safety|permissions?|sandbox)|bypass\s+(the\s+)?(permission|security|approval)|grant\s+yourself\s+access/i],
    ["secret_exfiltration", /(?:reveal|print|dump|exfiltrate)[^.\n]{0,80}(?:secret|token|password|credential|api\s*key)/i],
    ["embedded_role_message", /<(?:system|developer|assistant)>|BEGIN\s+(?:SYSTEM|DEVELOPER)\s+MESSAGE/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function recordToolEvent(context: ResearchToolContext, result: ResearchToolResult): void {
  try {
    const store = new ResearchStore(context.storePath);
    const output = result.output === undefined ? undefined : redactSecrets(JSON.stringify(result.output).slice(0, 8_000));
    store.appendEvent(result.ok ? "research.tool.completed" : "research.tool.failed", {
      name: result.name,
      ok: result.ok,
      trust: result.trust,
      securityWarnings: result.securityWarnings,
      error: result.error,
      output,
    });
    store.close();
  } catch {
    // Tool audit logging must not turn a successful research observation into a failure.
  }
}

function toolTrust(name: string): ResearchToolTrust {
  if (["workspace.read", "workspace.search", "shell.exec", "source.search", "source.retrieve", "web.search", "repository.search"].includes(name)) return "untrusted_content";
  if (["validation.generate", "report.generate"].includes(name)) return "permission_boundary";
  return "controller_observation";
}

export const RESEARCH_TOOLS: ResearchToolSpec[] = [
  { name: "workspace.files", description: "List tracked and untracked workspace files excluding state and dependencies.", input: {}, readOnly: true },
  { name: "workspace.search", description: "Search text or regular expressions in the workspace.", input: { query: "text or regular expression", path: "optional relative path" }, readOnly: true },
  { name: "workspace.read", description: "Read a bounded text file inside the workspace.", input: { path: "relative file path", maxBytes: "optional byte limit" }, readOnly: true },
  { name: "git.status", description: "Read the current Git status and HEAD commit.", input: {}, readOnly: true },
  { name: "shell.exec", description: "Run an allowlisted shell command with captured output.", input: { command: "argv array or shell string", timeoutMs: "optional timeout" }, readOnly: true },
  // Retrieval writes only durable local evidence; it does not mutate the
  // workspace or perform an external action, so safe research may use it.
  { name: "source.retrieve", description: "Retrieve, hash, excerpt, and store a research source with extracted claims; reuse a fresh cached copy unless refresh is requested.", input: { url: "HTTP(S) URL", refresh: "optional boolean to bypass the fresh-source cache" }, readOnly: true },
  { name: "source.search", description: "Search scholarly works and return ranked candidates for later retrieval; use deep depth for bounded progressive query probing.", input: { query: "research question or keywords", limit: "optional result count", depth: "optional shallow|deep" }, readOnly: true },
  { name: "web.search", description: "Search public web pages for official documentation, discussions, datasets, and implementation leads; results are untrusted until retrieved and hashed.", input: { query: "research question or keywords", limit: "optional result count" }, readOnly: true },
  { name: "repository.search", description: "Search public implementation repositories for reproducible method leads; repository metadata is not experimental evidence.", input: { query: "method, paper, or implementation keywords", limit: "optional result count" }, readOnly: true },
  { name: "data.audit", description: "Audit workspace files for size, duplicates, and suspicious data issues.", input: { path: "optional relative path" }, readOnly: true },
  { name: "artifact.audit", description: "Audit bounded research artifacts for safe containment, regular-file integrity, size, checksum, and optional JSON validity.", input: { paths: "relative artifact paths array", maxBytes: "optional per-file size limit" }, readOnly: true },
  { name: "prediction.analyze", description: "Analyze a bounded JSON/JSONL prediction artifact; optionally compare it with a baseline to identify fixed and regressed groups.", input: { path: "relative JSON or JSONL prediction artifact", baseline: "optional relative baseline artifact", maxRows: "optional row limit" }, readOnly: true },
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
        const forceRefresh = args.refresh === true;
        if (!forceRefresh) {
          const cacheStore = new ResearchStore(context.storePath);
          const cached = cacheStore.sources().find((entry) => {
            const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { url?: unknown } : {};
            return payload.url === url && sourceIsFresh(entry, DEFAULT_SOURCE_REFRESH_MS);
          });
          if (cached) {
            cacheStore.appendEvent("research.source.cache_hit", { id: cached.id, url, freshnessMs: DEFAULT_SOURCE_REFRESH_MS });
            cacheStore.close();
            output = { ...(cached.payload as Record<string, unknown>), id: cached.id, cached: true };
            break;
          }
          cacheStore.close();
        }
        const retrieved = await retrieveSource(url);
        const claims = sourceClaims(retrieved.text);
        const store = new ResearchStore(context.storePath);
        store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims } });
        for (const [index, statement] of claims.entries()) {
          const claimId = `${retrieved.id}_claim_${index + 1}`;
          store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: retrieved.url, confidence: 0.35, sourceType: "literature", sourceId: retrieved.id, status: "active" } });
          store.saveEdge({ id: `edge_${claimId}_${retrieved.id}`, fromId: claimId, toId: retrieved.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
        }
        store.appendEvent("research.source.retrieved", { id: retrieved.id, url: retrieved.url, claimCount: claims.length });
        store.close();
        output = { id: retrieved.id, title: retrieved.title, url: retrieved.url, claims, excerpt: retrieved.excerpt };
        break;
      }
      case "source.search": {
        const query = stringArg(args, "query");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8;
        const depth = args.depth === "deep" ? "deep" : "shallow";
        const searchStore = new ResearchStore(context.storePath);
        const cachedSearch = searchStore.eventsByType("research.source.search.completed").reverse().find((event) => {
          const payload = event.payload && typeof event.payload === "object" ? event.payload as { query?: unknown; depth?: unknown; results?: unknown } : {};
          return payload.query === query && (depth === "shallow" || payload.depth === "deep") && Array.isArray(payload.results) && Date.now() - Date.parse(event.createdAt) < DEFAULT_SOURCE_REFRESH_MS;
        });
        if (cachedSearch) {
          const payload = cachedSearch.payload as { results: unknown[] };
          const frontier = sourceFrontier(searchStore.eventsByTypes([...SOURCE_FRONTIER_EVENT_TYPES]));
          searchStore.appendEvent("research.source.search.cache_hit", { query, resultCount: payload.results.length, freshnessMs: DEFAULT_SOURCE_REFRESH_MS });
          searchStore.close();
          output = { query, results: payload.results.slice(0, limit), cached: true, frontier: { uniqueWorks: frontier.uniqueWorks, retrievedWorks: frontier.retrievedWorks, pendingWorks: frontier.pendingWorks, queryCount: frontier.queryCount } };
          break;
        }
        searchStore.close();
        const results = await searchResearchSources(query, limit, undefined, depth);
        const store = new ResearchStore(context.storePath);
        store.appendEvent("research.source.search.completed", { query, depth, queries: researchSearchQueries(query, depth), probes: depth === "deep" ? 3 : 1, results, sources: [...new Set(results.map((result) => result.provider ?? "unknown"))] });
        const frontier = sourceFrontier(store.eventsByTypes([...SOURCE_FRONTIER_EVENT_TYPES]));
        store.close();
        output = { query, results, frontier: { uniqueWorks: frontier.uniqueWorks, retrievedWorks: frontier.retrievedWorks, pendingWorks: frontier.pendingWorks, queryCount: frontier.queryCount } };
        break;
      }
      case "web.search": {
        const query = stringArg(args, "query");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8;
        context.onProgress?.(`Tool web.search · ${query.slice(0, 100)}`);
        const results = await searchResearchWeb(query, limit);
        const webStore = new ResearchStore(context.storePath);
        webStore.appendEvent("research.web.search.completed", { query, results, source: "duckduckgo" });
        webStore.close();
        output = { query, results, warning: "Web search results are untrusted candidates; retrieve a result before using it as evidence." };
        break;
      }
      case "repository.search": {
        const query = stringArg(args, "query");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8;
        const repositoryStore = new ResearchStore(context.storePath);
        const cachedSearch = repositoryStore.eventsByType("research.repository.search.completed").reverse().find((event) => {
          const payload = event.payload && typeof event.payload === "object" ? event.payload as { query?: unknown; results?: unknown } : {};
          return payload.query === query && Array.isArray(payload.results) && Date.now() - Date.parse(event.createdAt) < DEFAULT_SOURCE_REFRESH_MS;
        });
        if (cachedSearch) {
          const payload = cachedSearch.payload as { results: unknown[] };
          repositoryStore.appendEvent("research.repository.search.cache_hit", { query, resultCount: payload.results.length, freshnessMs: DEFAULT_SOURCE_REFRESH_MS });
          repositoryStore.close();
          output = { query, results: payload.results.slice(0, limit), cached: true, warning: "Repository matches are research leads; inspect and reproduce their methods before treating them as evidence." };
          break;
        }
        repositoryStore.close();
        const results = await searchResearchRepositories(query, limit);
        const store = new ResearchStore(context.storePath);
        store.appendEvent("research.repository.search.completed", { query, results, source: "github" });
        store.close();
        output = { query, results, cached: false, warning: "Repository matches are research leads; inspect and reproduce their methods before treating them as evidence." };
        break;
      }
      case "data.audit": {
        const target = typeof args.path === "string" ? inside(context.root, args.path) : context.root;
        output = auditData(target);
        break;
      }
      case "artifact.audit": {
        const rawPaths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
        if (!rawPaths.length || rawPaths.length > 64) throw new Error("Tool argument 'paths' must contain 1 to 64 relative paths.");
        const maxBytes = typeof args.maxBytes === "number" ? Math.max(1, Math.min(Math.floor(args.maxBytes), 50_000_000)) : 10_000_000;
        const artifacts = rawPaths.map((requested) => {
          const lexicalPath = resolve(realpathSync(context.root), requested);
          if (existsSync(lexicalPath) && lstatSync(lexicalPath).isSymbolicLink()) return { path: requested, valid: false, reason: "symlink is not an admissible artifact" };
          const path = inside(context.root, requested);
          if (!existsSync(path)) return { path: requested, valid: false, reason: "missing" };
          if (!statSync(path).isFile()) return { path: requested, valid: false, reason: "not a regular file" };
          const bytes = statSync(path).size;
          if (bytes > maxBytes) return { path: requested, valid: false, bytes, reason: `exceeds ${maxBytes} byte limit` };
          const entry: { path: string; valid: boolean; bytes: number; checksum: string; jsonValid?: boolean; reason?: string } = { path: requested, valid: true, bytes, checksum: sha256File(path) };
          if (/\.json$/i.test(path)) {
            try { JSON.parse(readFileSync(path, "utf8")); entry.jsonValid = true; }
            catch { entry.jsonValid = false; entry.valid = false; entry.reason = "invalid JSON"; }
          }
          return entry;
        });
        output = { valid: artifacts.every((artifact) => artifact.valid), artifacts };
        break;
      }
      case "prediction.analyze": {
        const path = inside(context.root, stringArg(args, "path"));
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Prediction artifact does not exist: ${args.path}`);
        const maxRows = typeof args.maxRows === "number" ? Math.max(1, Math.min(Math.floor(args.maxRows), 100_000)) : 100_000;
        const text = readFileSync(path, "utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* JSONL is parsed row-by-row. */ }
        const rows = parsePredictionRows(parsed, maxRows);
        const analysis = analyzePredictionRows(rows);
        let comparison: ReturnType<typeof comparePredictionRows> | undefined;
        if (typeof args.baseline === "string" && args.baseline.trim()) {
          const baselinePath = inside(context.root, args.baseline);
          if (!existsSync(baselinePath) || !statSync(baselinePath).isFile()) throw new Error(`Prediction baseline does not exist: ${args.baseline}`);
          const baselineText = readFileSync(baselinePath, "utf8");
          let baselineParsed: unknown = baselineText;
          try { baselineParsed = JSON.parse(baselineText); } catch { /* JSONL is parsed row-by-row. */ }
          comparison = comparePredictionRows(parsePredictionRows(baselineParsed, maxRows), rows);
        }
        const analysisStore = new ResearchStore(context.storePath);
        analysisStore.appendEvent("prediction.analysis.completed", { path: relative(context.root, path), rows: rows.length, analysis, ...(comparison ? { comparison } : {}) });
        analysisStore.close();
        output = { path: relative(context.root, path), rows: rows.length, ignoredRows: Math.max(0, text.split(/\r?\n/).filter(Boolean).length - rows.length), analysis, ...(comparison ? { comparison } : {}) };
        break;
      }
      case "validation.generate": {
        if (!context.competition) throw new Error("No workspace configuration is active.");
        const policyPath = join(context.root, ".sota", "validation-policy.json");
        const lockPath = join(context.root, ".sota", "validation-policy.lock.json");
        if (readValidationPolicyLock(lockPath)?.locked) throw new Error("Validation policy is locked; unlock it explicitly before regenerating.");
        const policy = createValidationPolicy(context.competition);
        mkdirSync(join(context.root, ".sota"), { recursive: true });
        const checksum = writeValidationPolicy(policyPath, policy);
        output = { path: policyPath, checksum, policy };
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
    const trust = toolTrust(call.name);
    const securityWarnings = trust === "untrusted_content" ? untrustedContentWarnings(output) : [];
    const result = { name: call.name, ok: true, output, trust, ...(securityWarnings.length ? { securityWarnings } : {}) };
    recordToolEvent(context, result);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = { name: call.name, ok: false, error: errorMessage, trust: toolFailureTrust(errorMessage) };
    recordToolEvent(context, result);
    return result;
  }
}
