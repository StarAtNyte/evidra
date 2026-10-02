import { existsSync, readFileSync, mkdirSync, realpathSync, lstatSync, statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { auditData } from "./data-audit.js";
import { guardAutonomousCommand, guardReadOnlyInspection, guardWorkspaceCommand, type AutonomyLevel } from "./permissions.js";
import { runProcess, type ProcessControl } from "./process.js";
import { splitCommandLine } from "./process.js";
import { prepareWorkerHome, safeWorkerEnvironment } from "./executors.js";
import { renderReport, writeReport, type ReportKind } from "./reports.js";
import { createValidationPolicy, writeValidationPolicy } from "./validation-policy.js";
import { canonicalSourceUrl, DEFAULT_SOURCE_REFRESH_MS, researchSearchQueries, retrieveSource, searchResearchRepositories, searchResearchSources, searchResearchWeb, sourceClaimRecords, sourceClaims, sourceFrontier, sourceIsFresh, sourceSearchCacheIsCurrent, sourceSearchNeedsRefinement, SOURCE_SEARCH_RANKING_VERSION, type SourceSearchResult } from "./sources.js";
import { competitionResearchClaimType, competitionResearchSources, competitionSourceRefreshMs, type CompetitionResearchSource, type CompetitionResearchChannelKind } from "./competition-sources.js";
import { ResearchStore } from "./store.js";
import type { CompetitionConfig } from "./types.js";
import { isSensitiveWorkspacePath, redactSecrets } from "./redaction.js";
import { readValidationPolicyLock } from "./validation-lock.js";
import { sha256File } from "./evidence.js";
import { analyzePredictionRows, comparePredictionRows, parsePredictionRows } from "./error-analysis.js";
import { diversityReport, loadPredictionVector, safePredictionPath } from "./ensemble.js";
import { extractCompetitionInsights } from "./competition-insights.js";
import { agentToolPermission } from "./agent-organization.js";
import { activeExternalResearchTools, externalToolStatus, loadExternalResearchTools, setExternalToolStatus, type ExternalResearchTool } from "./external-tools.js";
import { loadCompetitionAdapter } from "../competitions/adapters.js";

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
  /** Specialist identity. Omitted means the controller is invoking the tool. */
  role?: string;
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
  /** True when this lane reused an observation produced by a sibling lane in the same team. */
  cached?: boolean;
  /** Deterministic signals found in untrusted content; signals never execute or rewrite content. */
  securityWarnings?: string[];
}

export interface ResearchToolSpec {
  name: string;
  description: string;
  input: Record<string, string>;
  readOnly: boolean;
  /** Whether an identical call may reuse an observation within one director turn. */
  cacheable?: boolean;
}

function publicExternalSpec(tool: ExternalResearchTool): ResearchToolSpec {
  return { name: tool.name, description: `${tool.description} (external project adapter)`, input: tool.input, readOnly: tool.readOnly, cacheable: tool.cacheable };
}

export function availableResearchTools(root?: string): ResearchToolSpec[] {
  return [...RESEARCH_TOOLS, ...(root ? activeExternalResearchTools(root).map(publicExternalSpec) : [])];
}

/** Apply the safest default when a provider or test double omits provenance metadata. */
export function normalizeResearchToolResult(result: unknown): ResearchToolResult {
  const value = result && typeof result === "object" && !Array.isArray(result)
    ? result as Partial<ResearchToolResult>
    : {};
  const trust = value.trust === "controller_observation" || value.trust === "untrusted_content" || value.trust === "permission_boundary"
    ? value.trust
    : "untrusted_content";
  const name = typeof value.name === "string" && value.name.trim() ? value.name : "unknown";
  const ok = value.ok === true;
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.ok !== "boolean") {
    return {
      name,
      ok: false,
      error: "Research tool returned a malformed result contract.",
      trust: "controller_observation",
      ...(Array.isArray(value.securityWarnings) ? { securityWarnings: value.securityWarnings.filter((warning): warning is string => typeof warning === "string") } : {}),
    };
  }
  return { ...value, name, ok, trust, ...(Array.isArray(value.securityWarnings) ? { securityWarnings: value.securityWarnings.filter((warning): warning is string => typeof warning === "string") } : {}) };
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

function recordToolEvent(context: ResearchToolContext, result: ResearchToolResult, metadata: Record<string, unknown> = {}): void {
  try {
    const store = new ResearchStore(context.storePath);
    const serializedOutput = result.output === undefined ? undefined : redactSecrets(JSON.stringify(result.output));
    const output = serializedOutput === undefined ? undefined : serializedOutput.slice(0, 8_000);
    const outputHash = serializedOutput === undefined ? undefined : `sha256:${createHash("sha256").update(serializedOutput).digest("hex")}`;
    store.appendEvent(result.ok ? "research.tool.completed" : "research.tool.failed", {
      name: result.name,
      actor: context.role ?? "controller",
      autonomy: context.autonomy,
      ok: result.ok,
      trust: result.trust,
      securityWarnings: result.securityWarnings,
      error: result.error,
      output,
      outputHash,
      ...metadata,
    });
    store.close();
  } catch {
    // Tool audit logging must not turn a successful research observation into a failure.
  }
}

function toolTrust(name: string): ResearchToolTrust {
  if (name.startsWith("external.")) return "untrusted_content";
  if (["workspace.read", "workspace.search", "git.diff", "shell.exec", "source.search", "source.retrieve", "competition.observe", "web.search", "repository.search"].includes(name)) return "untrusted_content";
  if (["validation.generate", "report.generate", "agent.handoff"].includes(name)) return "permission_boundary";
  return "controller_observation";
}

export const RESEARCH_TOOLS: ResearchToolSpec[] = [
  { name: "workspace.files", description: "List a bounded set of tracked and untracked workspace files, excluding internal state and dependencies by default. An explicit scope may inspect .sota/research artifacts, .sota/runs result records, or one .sota/worktrees/<id> experiment worktree; databases and traces remain hidden.", input: { path: "optional relative directory", limit: "optional maximum entries (1-500; default 200)" }, readOnly: true },
  { name: "workspace.search", description: "Search the workspace by phrase, regex, or natural-language terms; a no-match plain query retries using distinctive identifiers or ranked longer terms, avoiding broad generic OR matches. Internal state is excluded by default; selected .sota/research, .sota/runs, and experiment worktree scopes are supported. Results are capped; narrow by path or query if truncated.", input: { query: "phrase, regular expression, or natural-language terms", path: "optional relative path", limit: "optional maximum matching lines (1-500; default 100)" }, readOnly: true },
  { name: "workspace.read", description: "Read one bounded text file or a bounded list of up to 64 text files inside the workspace, including redacted run-result records under .sota/runs; list output is capped at 512 KB total. Controller databases and traces are not readable.", input: { path: "relative file path, or use paths", paths: "optional array of up to 64 relative file paths (512 KB aggregate output cap)", maxBytes: "optional byte limit per file" }, readOnly: true },
  { name: "git.status", description: "Read the current Git status and HEAD commit.", input: {}, readOnly: true },
  { name: "git.diff", description: "Read a bounded working-tree diff for code and configuration review.", input: { path: "optional relative path" }, readOnly: true },
  // Shell execution is inspection-compatible in SAFE mode, but it is not
  // cacheable: FAST/YOLO may run commands whose filesystem/process state can
  // change between rounds.
  { name: "shell.exec", description: "Run one allowlisted read-only command with captured output. Prefer an argv array such as [\"rg\", \"-n\", \"pattern\", \"path\"]; do not join commands with &&, ;, pipes, redirections, cd, or shell wrappers. Use workspace.search/read/files for composed inspection.", input: { command: "one argv array or simple command string; no shell operators", timeoutMs: "optional timeout" }, readOnly: true, cacheable: false },
  // Retrieval writes only durable local evidence; it does not mutate the
  // workspace or perform an external action, so safe research may use it.
  { name: "source.retrieve", description: "Retrieve, hash, excerpt, and store a research source with extracted claims; optionally classify it as a paper or external channel; reuse a fresh cached copy unless refresh is requested. The common kind value 'research' is accepted as an alias for 'general'.", input: { url: "HTTP(S) URL", kind: "optional research|general|paper|rules|discussion|leaderboard|documentation|repository|other", refresh: "optional boolean to bypass the fresh-source cache" }, readOnly: true },
  { name: "competition.observe", description: "Observe a configured research channel and store it with typed provenance. Use canonical kind values: rules, discussion, leaderboard, documentation, paper, repository, other, or general. Common aliases such as challenge, scores, standings, and final are normalized.", input: { kind: "optional canonical channel kind or common alias", url: "optional configured HTTP(S) URL", refresh: "optional boolean to bypass the channel cache" }, readOnly: true },
  { name: "source.search", description: "Search scholarly works and return ranked candidates for later retrieval; use deep depth for bounded progressive query probing.", input: { query: "research question or keywords", limit: "optional result count", depth: "optional shallow|deep" }, readOnly: true },
  { name: "web.search", description: "Search public web pages for official documentation, discussions, datasets, and implementation leads; results are untrusted until retrieved and hashed.", input: { query: "research question or keywords", limit: "optional result count" }, readOnly: true },
  { name: "repository.search", description: "Search public implementation repositories for reproducible method leads; repository metadata is not experimental evidence.", input: { query: "method, paper, or implementation keywords", limit: "optional result count" }, readOnly: true },
  { name: "data.audit", description: "Audit workspace files for size, duplicates, and suspicious data issues.", input: { path: "optional relative path" }, readOnly: true },
  { name: "artifact.audit", description: "Audit relative files for safe containment, regular-file integrity, streaming SHA-256 checksum, size, and optional JSON validity. Large files are supported without loading them into memory; set maxBytes per file and maxTotalBytes for the aggregate read budget (hard caps: 2 GiB/file, 16 GiB total).", input: { paths: "relative file paths array", maxBytes: "optional per-file limit (hard cap 2 GiB)", maxTotalBytes: "optional aggregate hashing limit (hard cap 16 GiB)" }, readOnly: true },
  { name: "prediction.analyze", description: "Analyze a bounded JSON/JSONL prediction artifact; optionally compare it with a baseline to identify fixed and regressed groups.", input: { path: "relative JSON or JSONL prediction artifact", baseline: "optional relative baseline artifact", maxRows: "optional row limit" }, readOnly: true },
  { name: "ensemble.analyze", description: "Inspect registered prediction/OOF artifacts and measure pairwise diversity without creating or promoting a blend.", input: {}, readOnly: true },
  { name: "agent.handoff", description: "Send a bounded, durable message to another approved research role; delivery occurs at that role's next safe boundary and does not grant new authority.", input: { role: "recipient role", message: "bounded handoff message", scopeKey: "optional phase or task scope" }, readOnly: false },
  { name: "validation.generate", description: "Create a versioned validation policy for the active workspace.", input: {}, readOnly: false },
  { name: "report.generate", description: "Write a durable research, challenge, or final report.", input: { kind: "research|challenge|final" }, readOnly: false },
];

const TOOL_HINTS: Record<string, string> = {
  "workspace.files": "workspace repository files project inventory inspect code",
  "workspace.search": "search grep find inspect code repository files logs text",
  "workspace.read": "read inspect file code configuration documentation artifact",
  "git.status": "git repository changes commit diff status provenance",
  "git.diff": "git diff changes patch review implementation code experiment",
  "shell.exec": "run command test build execute benchmark evaluator process shell",
  "source.retrieve": "paper literature source article arxiv retrieve citation claims",
  "competition.observe": "competition challenge rules discussion forum leaderboard score repository observe",
  "source.search": "paper literature scholarly research search citation method",
  "web.search": "web official documentation competition forum discussion dataset leaderboard",
  "repository.search": "repository implementation github code method reproduce",
  "data.audit": "data dataset audit duplicate distribution missing leakage split",
  "artifact.audit": "artifact output checksum file result integrity validity",
  "prediction.analyze": "prediction error residual confusion regression slice baseline",
  "ensemble.analyze": "ensemble blend diversity oof prediction models",
  "agent.handoff": "agent handoff delegate message coordinate peer specialist critic validation researcher",
  "validation.generate": "validation policy evaluator split leakage contract",
  "report.generate": "report summarize publish findings final",
};

const SEARCH_QUERY_STOPWORDS = new Set([
  "about", "after", "and", "before", "change", "claim", "evidence", "files", "for", "from",
  "into", "manifest", "ordered", "per-mlp", "result", "results", "score", "source", "the",
  "this", "through", "under", "utilization", "with",
]);

/** Prefer rare identifiers; generic OR terms otherwise make large workspaces look falsely relevant. */
export function workspaceSearchFallbackTerms(query: string): { terms: string[]; mode: "identifier fallback" | "ranked-term fallback" } {
  const tokens = [...new Set(query.trim().split(/\s+/).filter((term) =>
    (term.length >= 4 || /[A-Za-z].*\d|\d.*[A-Za-z]/.test(term)) && !SEARCH_QUERY_STOPWORDS.has(term.toLowerCase()),
  ))];
  const identifiers = tokens.filter((term) =>
    (/\d/.test(term) && (term.length >= 4 || /[A-Za-z].*\d|\d.*[A-Za-z]/.test(term))) ||
    (/[\-_]/.test(term) && term.length >= 6),
  );
  if (identifiers.length) return { terms: identifiers.slice(0, 6), mode: "identifier fallback" };
  const ranked = tokens
    .map((term, index) => ({ term, index }))
    .sort((left, right) => right.term.length - left.term.length || left.index - right.index)
    .slice(0, 6)
    .map(({ term }) => term);
  return { terms: ranked, mode: "ranked-term fallback" };
}

/** Retrieve relevant tool descriptions without changing the full executor registry. */
export function selectResearchTools(objective: string, limit = 12, additionalTools: ResearchToolSpec[] = []): ResearchToolSpec[] {
  const registry = [...RESEARCH_TOOLS, ...additionalTools];
  const boundedLimit = Math.max(4, Math.min(registry.length, Math.floor(limit)));
  const query = objective.toLowerCase();
  const core = new Set(["workspace.files", "workspace.search", "workspace.read", "git.status"]);
  const ranked = registry.map((tool, index) => {
    const terms = `${tool.name} ${tool.description} ${TOOL_HINTS[tool.name] ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
    const score = terms.reduce((total, term) => total + (query.includes(term) ? (term.length >= 6 ? 2 : 1) : 0), 0);
    return { tool, score, index };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = new Set<string>(core);
  for (const entry of ranked) {
    if (selected.size >= boundedLimit) break;
    selected.add(entry.tool.name);
  }
  return registry.filter((tool) => selected.has(tool.name));
}

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

/** Resolve the active task's workspace without removing access to project-level artifacts.
 * Explicit paths that already exist at the project root keep their old meaning; otherwise
 * relative paths fall back to the adapter's declared workspace. */
function activeWorkspaceRoot(context: ResearchToolContext): string {
  const declared = context.competition?.workspacePath ?? (context.competition?.id
    ? loadCompetitionAdapter(context.root, context.competition.id).workspacePath(context.root)
    : undefined);
  if (!declared) return realpathSync(context.root);
  const resolved = inside(context.root, declared);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return realpathSync(context.root);
  return resolved;
}

function resolveWorkspacePath(context: ResearchToolContext, requested?: string): string {
  const projectRoot = realpathSync(context.root);
  const activeRoot = activeWorkspaceRoot(context);
  if (!requested || !requested.trim()) return activeRoot;
  const normalizedRequest = requested.replace(/\\/g, "/");
  if (normalizedRequest === ".sota" || normalizedRequest.startsWith(".sota/") ||
      (context.competition?.workspacePath && normalizedRequest.startsWith(`${context.competition.workspacePath.replace(/\\/g, "/").replace(/\/$/, "")}/`))) {
    return inside(projectRoot, requested);
  }
  if (activeRoot !== projectRoot) {
    const activePath = inside(activeRoot, requested);
    if (existsSync(activePath)) return activePath;
  }
  const projectPath = inside(projectRoot, requested);
  if (existsSync(projectPath)) return projectPath;
  if (activeRoot !== projectRoot) return inside(activeRoot, requested);
  return projectPath;
}

/** Permit explicit report, run-result, and worktree inspection without exposing the database or traces. */
function isResearchArtifactInspectionScope(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized === ".sota/research" || normalized.startsWith(".sota/research/") ||
    normalized === ".sota/runs" || normalized.startsWith(".sota/runs/") ||
    /^\.sota\/worktrees\/[^/]+(?:\/.*)?$/.test(normalized);
}

function isReadableResearchArtifact(relativePath: string): boolean {
  return isResearchArtifactInspectionScope(relativePath) && /\.(?:[cm]?[jt]sx?|py|md|jsonl?|txt|ya?ml|toml|csv|tsv|log)$/i.test(relativePath);
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

const RESEARCH_CHANNEL_ALIASES: Record<string, string> = {
  challenge: "rules", rule: "rules", rules: "rules",
  forum: "discussion", forums: "discussion", discussion: "discussion",
  score: "leaderboard", scores: "leaderboard", standings: "leaderboard",
  ranking: "leaderboard", rankings: "leaderboard", rank: "leaderboard",
  final: "leaderboard", leaderboard: "leaderboard",
  docs: "documentation", document: "documentation", documentation: "documentation",
  paper: "paper", repository: "repository", repo: "repository",
  research: "general", general: "general", other: "other",
};

function normalizeResearchChannelKind(value: unknown, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Tool argument 'kind' must be a string.");
  const requested = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const normalized = RESEARCH_CHANNEL_ALIASES[requested] ?? requested;
  if (!allowed.includes(normalized)) {
    throw new Error(`Tool argument 'kind' must be one of: ${allowed.join(", ")} (received '${value.trim()}').`);
  }
  return normalized;
}

/** Validate the small public tool contract before any filesystem or network work. */
function validateToolArguments(name: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  const args = { ...(value as Record<string, unknown>) };
  const requiredString = (key: string): void => {
    if (typeof args[key] !== "string" || !(args[key] as string).trim()) throw new Error(`Tool argument '${key}' is required and must be a non-empty string.`);
  };
  const optionalString = (key: string): void => {
    if (args[key] !== undefined && typeof args[key] !== "string") throw new Error(`Tool argument '${key}' must be a string.`);
  };
  const optionalNumber = (key: string): void => {
    if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]))) throw new Error(`Tool argument '${key}' must be a finite number.`);
  };
  switch (name) {
    case "workspace.files":
      optionalString("path"); optionalNumber("limit");
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 500)) throw new Error("Tool argument 'limit' must be an integer from 1 to 500.");
      break;
    case "workspace.search":
      requiredString("query"); optionalString("path"); optionalNumber("limit");
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 500)) throw new Error("Tool argument 'limit' must be an integer from 1 to 500.");
      break;
    case "workspace.read": {
      optionalString("path"); optionalNumber("maxBytes");
      if (args.paths !== undefined && (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 64 || !args.paths.every((path) => typeof path === "string" && path.trim()))) {
        throw new Error("Tool argument 'paths' must be an array of one to 64 non-empty relative file paths; split larger requests.");
      }
      if (!(typeof args.path === "string" && args.path.trim()) && !Array.isArray(args.paths)) throw new Error("Tool argument 'path' or 'paths' is required.");
      break;
    }
    case "git.diff": optionalString("path"); break;
    case "shell.exec": if (args.command === undefined) throw new Error("Tool argument 'command' is required."); commandArgs(args.command); optionalNumber("timeoutMs"); break;
    case "source.retrieve":
      requiredString("url"); optionalString("kind");
      args.kind = normalizeResearchChannelKind(args.kind, ["rules", "discussion", "leaderboard", "documentation", "paper", "repository", "other", "general"]);
      if (args.refresh !== undefined && typeof args.refresh !== "boolean") throw new Error("Tool argument 'refresh' must be a boolean."); break;
    case "competition.observe":
      optionalString("kind"); optionalString("url");
      if (args.refresh !== undefined && typeof args.refresh !== "boolean") throw new Error("Tool argument 'refresh' must be a boolean.");
      args.kind = normalizeResearchChannelKind(args.kind, ["rules", "discussion", "leaderboard", "documentation", "paper", "repository", "other", "general"]);
      break;
    case "source.search": case "web.search": case "repository.search":
      requiredString("query"); optionalNumber("limit");
      if (name === "source.search" && args.depth !== undefined && args.depth !== "shallow" && args.depth !== "deep") throw new Error("Tool argument 'depth' must be 'shallow' or 'deep'.");
      break;
    case "data.audit": optionalString("path"); break;
    case "artifact.audit":
      if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 64 || !args.paths.every((path) => typeof path === "string" && path.trim())) throw new Error("Tool argument 'paths' must contain 1 to 64 non-empty strings.");
      optionalNumber("maxBytes"); optionalNumber("maxTotalBytes");
      for (const key of ["maxBytes", "maxTotalBytes"] as const) {
        if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 1)) throw new Error(`Tool argument '${key}' must be a positive safe integer.`);
      }
      break;
    case "prediction.analyze": requiredString("path"); optionalString("baseline"); optionalNumber("maxRows"); break;
    case "agent.handoff": requiredString("role"); requiredString("message"); optionalString("scopeKey"); break;
    case "report.generate": if (args.kind !== "research" && args.kind !== "challenge" && args.kind !== "final") throw new Error("Tool argument 'kind' must be research, challenge, or final."); break;
  }
  return args;
}

export async function executeResearchTool(call: ResearchToolCall, context: ResearchToolContext): Promise<ResearchToolResult> {
  const externalManifest = loadExternalResearchTools(context.root);
  const unknownToolMessage = (): string => {
    const available = [...RESEARCH_TOOLS.map((tool) => tool.name), ...externalManifest.tools.map((tool) => tool.name)];
    const suggestions = call.name === "workspace.commands" || call.name === "workspace.command"
      ? "Use shell.exec for one bounded argv command, or workspace.files/search/read for structured inspection."
      : "Choose a tool from the available list.";
    return `Unknown research tool '${call.name}'. ${suggestions} Available tools: ${available.join(", ")}.`;
  };
  try {
    const external = externalManifest.tools.find((tool) => tool.name === call.name);
    const spec = RESEARCH_TOOLS.find((tool) => tool.name === call.name) ?? (external ? publicExternalSpec(external) : undefined);
    if (!spec) throw new Error(unknownToolMessage());
    if (external) {
      const lifecycle = externalToolStatus(context.root, external.name);
      if (lifecycle.status !== "enabled") throw new Error(`External tool '${external.name}' is ${lifecycle.status}${lifecycle.reason ? `: ${lifecycle.reason}` : "."}`);
    }
    let persistedContract: import("./store.js").PersistedAgentRoleContract | undefined;
    let admittedRole = false;
    if (context.role) {
      const admissionStore = new ResearchStore(context.storePath);
      admittedRole = admissionStore.agentRoleAdmitted(context.role);
      persistedContract = admissionStore.agentRoleContract(context.role);
      admissionStore.close();
      if (external) {
        if (!external.roles.includes(context.role)) throw new Error(`Permission boundary: external tool '${call.name}' has no grant for role '${context.role}'.`);
        if (persistedContract?.toolAllowlist && !persistedContract.toolAllowlist.includes(call.name)) throw new Error(`Permission boundary: role '${context.role}' is restricted to its contract tool allowlist; '${call.name}' is not admitted.`);
      } else {
        const permission = agentToolPermission(context.role, call.name, admittedRole, persistedContract);
        if (!permission.allowed) throw new Error(`Permission boundary: ${permission.reason}`);
      }
    }
    if (context.autonomy === "safe" && !spec.readOnly) {
      throw new Error(`SAFE mode permits inspection tools only; '${call.name}' requires fast or yolo autonomy.`);
    }
    const workerEnvironment = safeWorkerEnvironment({ HOME: prepareWorkerHome(context.root) });
    let output: unknown;
    let toolOk = true;
    let toolError: string | undefined;
    if (external) {
      const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
      const serializedArgs = JSON.stringify(args);
      if (Buffer.byteLength(serializedArgs, "utf8") > 16_000) throw new Error(`External tool arguments exceed the 16000-byte limit.`);
      const environment = safeWorkerEnvironment({ ...workerEnvironment, EVIDRA_TOOL_NAME: external.name, EVIDRA_TOOL_ARGS_JSON: serializedArgs });
      context.onProgress?.(`Tool ${external.name} · external adapter`);
      const result = await runProcess(external.command, context.root, external.timeoutMs, undefined, context.onProcess, environment);
      let value: unknown = result.stdout.slice(0, 50_000);
      try { value = JSON.parse(result.stdout); } catch { /* Plain text adapter output remains untrusted data. */ }
      output = { exitCode: result.exitCode, value, stderr: result.stderr.slice(0, 8_000), durationMs: result.durationMs };
      if (result.exitCode !== 0) {
        toolOk = false;
        toolError = result.stderr.trim() || `External tool exited with code ${result.exitCode}.`;
      }
    } else {
      const args = validateToolArguments(call.name, call.arguments);
      switch (call.name) {
      case "workspace.files": {
        // Default inventory follows the active adapter workspace. Explicit
        // project-root artifact paths remain addressable for reports/results.
        const directory = resolveWorkspacePath(context, typeof args.path === "string" ? args.path : undefined);
        const resultScope = relative(context.root, directory).replace(/\\/g, "/") || ".";
        const includeResearchArtifacts = isResearchArtifactInspectionScope(resultScope);
        const projectRoot = realpathSync(context.root);
        const activeRoot = activeWorkspaceRoot(context);
        const activeRelative = relative(activeRoot, directory);
        const isActiveScope = activeRoot !== projectRoot && !activeRelative.startsWith("..") && !isAbsolute(activeRelative);
        const cwd = isActiveScope ? activeRoot : projectRoot;
        const scope = isActiveScope ? activeRelative.replace(/\\/g, "/") || "." : resultScope;
        const limit = typeof args.limit === "number" ? args.limit : 200;
        const result = await runProcess(["rg", "--files", "--hidden", ...(includeResearchArtifacts ? ["--no-ignore"] : []), "-g", "!.git/**", ...(!includeResearchArtifacts ? ["-g", "!.sota/**"] : []), "-g", "!node_modules/**", "-g", "!**/.env*", "-g", "!**/*credentials*", scope], cwd, 30_000, undefined, context.onProcess, workerEnvironment);
        const allFiles = result.stdout.split("\n").filter(Boolean).map((file) => file.replace(/^\.\//, ""));
        const files = allFiles.slice(0, limit);
        output = { exitCode: result.exitCode, scope: resultScope, files, returned: files.length, limit, truncated: allFiles.length > limit || result.stdout.includes("[output truncated by Evidra") };
        break;
      }
      case "workspace.search": {
        const query = stringArg(args, "query");
        const directory = resolveWorkspacePath(context, typeof args.path === "string" ? args.path : undefined);
        const resultScope = relative(context.root, directory).replace(/\\/g, "/") || ".";
        const includeResearchArtifacts = isResearchArtifactInspectionScope(resultScope);
        const projectRoot = realpathSync(context.root);
        const activeRoot = activeWorkspaceRoot(context);
        const activeRelative = relative(activeRoot, directory);
        const isActiveScope = activeRoot !== projectRoot && !activeRelative.startsWith("..") && !isAbsolute(activeRelative);
        const cwd = isActiveScope ? activeRoot : projectRoot;
        const target = isActiveScope ? activeRelative.replace(/\\/g, "/") || "." : resultScope;
        const limit = typeof args.limit === "number" ? args.limit : 100;
        const base = ["rg", "-n", "--hidden", ...(includeResearchArtifacts ? ["--no-ignore"] : []), ...(!includeResearchArtifacts ? ["-g", "!.sota/**"] : []), "-g", "!node_modules/**", "-g", "!**/.env*", "-g", "!**/*credentials*", "-g", "!package-lock.json", "-g", "!pnpm-lock.yaml", "-g", "!yarn.lock", "-g", "!uv.lock", "-g", "!*.min.*", "-g", "!*.map"];
        let result = await runProcess([...base, query, target], cwd, 30_000, undefined, context.onProcess, workerEnvironment);
        let searchMode = "pattern";
        // Research agents often phrase a search as a bag of terms. `rg` treats
        // that as one literal sequence, but OR-ing every term makes generic
        // words dominate and can turn package-lock noise into false evidence.
        // Prefer identifiers when available; otherwise use only the longest
        // terms. Explicit regexes retain their normal semantics.
        let fallbackTerms: string[] = [];
        if (result.exitCode === 1 && query.trim().split(/\s+/).length >= 2 && !/[|*+?^${}()[\]\\]/.test(query)) {
          const fallback = workspaceSearchFallbackTerms(query);
          fallbackTerms = fallback.terms;
          if (fallbackTerms.length) {
            result = await runProcess([...base, "-i", "-F", ...fallbackTerms.flatMap((term) => ["-e", term]), target], cwd, 30_000, undefined, context.onProcess, workerEnvironment);
            searchMode = fallback.mode;
          }
        }
        const allMatches = result.stdout.split("\n").filter(Boolean);
        const matches = allMatches.slice(0, limit).join("\n").slice(0, 20_000);
        const safeMatches = redactSecrets(matches);
        output = { exitCode: result.exitCode, searchMode, ...(fallbackTerms.length ? { fallbackTerms } : {}), matches: safeMatches, returned: safeMatches ? safeMatches.split("\n").length : 0, truncated: allMatches.length > limit || result.stdout.includes("[output truncated by Evidra") || result.stdout.length > 20_000, stderr: redactSecrets(result.stderr.slice(0, 1_000)) };
        break;
      }
      case "workspace.read": {
        const maxBytes = typeof args.maxBytes === "number" ? Math.max(1, Math.min(args.maxBytes, 2_000_000)) : 200_000;
        if (typeof args.path === "string" && args.path.trim()) {
          const path = resolveWorkspacePath(context, args.path);
          const relativePath = relative(context.root, path).replace(/\\/g, "/");
          if (relativePath.startsWith(".sota/") && !isReadableResearchArtifact(relativePath)) throw new Error("Refusing to read Evidra internal state; only text research artifacts and experiment worktree source files are exposed.");
          if (!existsSync(path)) throw new Error(`File does not exist: ${args.path}`);
          const contents = readFileSync(path);
          output = { path: relativePath, truncated: contents.byteLength > maxBytes, text: redactSecrets(contents.subarray(0, maxBytes).toString("utf8")) };
        } else {
          const requestedPaths = [...new Set((args.paths as string[]).map((path) => path.trim()))];
          let remainingBytes = 512_000;
          const files = requestedPaths.map((requested) => {
            const path = resolveWorkspacePath(context, requested);
            const relativePath = relative(context.root, path).replace(/\\/g, "/");
            if (relativePath.startsWith(".sota/") && !isReadableResearchArtifact(relativePath)) throw new Error("Refusing to read Evidra internal state; only text research artifacts and experiment worktree source files are exposed.");
            if (!existsSync(path)) throw new Error(`File does not exist: ${requested}`);
            const budget = Math.min(maxBytes, remainingBytes);
            const fd = openSync(path, "r");
            let retained: Buffer;
            let fileBytes: number;
            try {
              const info = fstatSync(fd);
              if (!info.isFile()) throw new Error(`Not a regular file: ${requested}`);
              fileBytes = info.size;
              retained = Buffer.alloc(Math.min(budget, fileBytes));
              let offset = 0;
              while (offset < retained.byteLength) {
                const count = readSync(fd, retained, offset, retained.byteLength - offset, offset);
                if (count === 0) break;
                offset += count;
              }
              if (offset < retained.byteLength) retained = retained.subarray(0, offset);
            } finally { closeSync(fd); }
            remainingBytes -= retained.byteLength;
            return { path: relativePath, truncated: fileBytes > retained.byteLength, text: redactSecrets(retained.toString("utf8")) };
          });
          output = { files, truncated: remainingBytes === 0 || files.some((file) => file.truncated) };
        }
        break;
      }
      case "git.status": {
        const status = await runProcess(["git", "status", "--short"], context.root, 30_000, undefined, context.onProcess, workerEnvironment);
        const head = await runProcess(["git", "rev-parse", "HEAD"], context.root, 30_000, undefined, context.onProcess, workerEnvironment);
        output = { head: head.stdout.trim(), status: status.stdout.trim(), statusCode: status.exitCode };
        break;
      }
      case "git.diff": {
        const requested = typeof args.path === "string" ? args.path.trim() : "";
        const target = requested ? relative(context.root, inside(context.root, requested)) : undefined;
        const command = ["git", "diff", "HEAD", "--no-ext-diff", "--unified=3", "--", ...(target ? [target] : [])];
        const result = await runProcess(command, context.root, 30_000, undefined, context.onProcess, workerEnvironment);
        output = { exitCode: result.exitCode, path: target, diff: result.stdout.slice(-100_000), stderr: result.stderr.slice(-4_000) };
        if (result.exitCode !== 0) {
          toolOk = false;
          toolError = result.stderr.trim() || `Git diff exited with code ${result.exitCode}.`;
        }
        break;
      }
      case "shell.exec": {
        const command = commandArgs(args.command);
        const guard = guardAutonomousCommand(command);
        if (!guard.allowed) throw new Error(guard.reason);
        const workspaceGuard = guardWorkspaceCommand(command, context.root);
        if (!workspaceGuard.allowed) throw new Error(workspaceGuard.reason);
        const inspection = guardReadOnlyInspection(command);
        if (!inspection.allowed) {
          throw new Error(context.autonomy === "safe" ? inspection.reason : `Autonomous research tools remain read-only in ${context.autonomy.toUpperCase()} mode: ${inspection.reason}`);
        }
        const timeout = typeof args.timeoutMs === "number" ? Math.max(1_000, Math.min(args.timeoutMs, 15 * 60_000)) : 120_000;
        context.onProgress?.(`Tool shell.exec · ${command.join(" ")}`);
        const result = await runProcess(command, context.root, timeout, undefined, context.onProcess, workerEnvironment);
        output = { exitCode: result.exitCode, stdout: redactSecrets(result.stdout.slice(-50_000)), stderr: redactSecrets(result.stderr.slice(-10_000)), durationMs: result.durationMs };
        if (result.exitCode !== 0) {
          toolOk = false;
          toolError = result.stderr.trim() || `Command exited with code ${result.exitCode}.`;
        }
        break;
      }
      case "source.retrieve": {
        const url = stringArg(args, "url");
        const requestedKind = typeof args.kind === "string" ? args.kind : "general";
        const kind = (requestedKind === "research" ? "general" : requestedKind) as CompetitionResearchChannelKind;
        const forceRefresh = args.refresh === true;
        if (!forceRefresh) {
          const cacheStore = new ResearchStore(context.storePath);
          const cached = cacheStore.sources().find((entry) => {
            const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { url?: unknown; channelKind?: unknown } : {};
            const kindMatches = args.kind === undefined || payload.channelKind === kind || (kind === "general" && payload.channelKind === undefined);
            return kindMatches && typeof payload.url === "string" && canonicalSourceUrl(payload.url) === canonicalSourceUrl(url) && sourceIsFresh(entry, DEFAULT_SOURCE_REFRESH_MS);
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
        const insights = extractCompetitionInsights(retrieved.text, kind);
        const store = new ResearchStore(context.storePath);
        store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims, channelKind: kind, insights } });
        for (const [index, statement] of claims.entries()) {
          const claimId = `${retrieved.id}_claim_${index + 1}`;
          store.saveClaim({ id: claimId, payload: { id: claimId, statement, scope: retrieved.url, confidence: 0.35, sourceType: competitionResearchClaimType(kind), sourceId: retrieved.id, status: "active" } });
          store.saveEdge({ id: `edge_${claimId}_${retrieved.id}`, fromId: claimId, toId: retrieved.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
        }
        store.appendEvent("research.source.retrieved", { id: retrieved.id, url: retrieved.url, channelKind: kind, claimCount: claims.length });
        store.close();
        output = { id: retrieved.id, title: retrieved.title, url: retrieved.url, channelKind: kind, claims, insights, excerpt: retrieved.excerpt };
        break;
      }
      case "competition.observe": {
        if (!context.competition) throw new Error("No active competition or research manifest is configured.");
        const requestedKind = typeof args.kind === "string" ? args.kind : undefined;
        const requestedUrl = typeof args.url === "string" ? args.url : undefined;
        const configured = competitionResearchSources(context.competition);
        const selected: CompetitionResearchSource | undefined = requestedUrl
          ? configured.find((entry) => canonicalSourceUrl(entry.url) === canonicalSourceUrl(requestedUrl)) ?? { url: requestedUrl, kind: (requestedKind ?? "general") as CompetitionResearchChannelKind }
          : configured.find((entry) => !requestedKind || entry.kind === requestedKind);
        if (!selected) throw new Error(requestedKind ? `No configured research channel has kind '${requestedKind}'.` : "No configured research channels are available.");
        const forceRefresh = args.refresh === true;
        const cacheStore = new ResearchStore(context.storePath);
        const cached = !forceRefresh ? cacheStore.sources().find((entry) => {
          const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { url?: unknown; channelKind?: unknown } : {};
          const maxAge = competitionSourceRefreshMs(selected);
          return payload.channelKind === selected.kind && typeof payload.url === "string" && canonicalSourceUrl(payload.url) === canonicalSourceUrl(selected.url) && sourceIsFresh(entry, maxAge);
        }) : undefined;
        if (cached) {
          cacheStore.appendEvent("research.competition.channel.cache_hit", { url: selected.url, channelKind: selected.kind, sourceId: cached.id });
          cacheStore.close();
          output = { ...(cached.payload as Record<string, unknown>), id: cached.id, cached: true };
          break;
        }
        cacheStore.close();
        context.onProgress?.(`Tool competition.observe · ${selected.kind} · ${new URL(selected.url).hostname}`);
        const retrieved = await retrieveSource(selected.url);
        const claimRecords = sourceClaimRecords(retrieved.text);
        const claims = claimRecords.map((claim) => claim.statement);
        const insights = extractCompetitionInsights(retrieved.text, selected.kind);
        const store = new ResearchStore(context.storePath);
        store.saveSource({ id: retrieved.id, payload: { ...retrieved, claims, channelKind: selected.kind, insights } });
        for (const [index, claim] of claimRecords.entries()) {
          const claimId = `${retrieved.id}_claim_${index + 1}`;
          store.saveClaim({ id: claimId, payload: { id: claimId, statement: claim.statement, excerpt: claim.excerpt, sourceSpan: { start: claim.start, end: claim.end }, scope: retrieved.url, confidence: 0.35, sourceType: competitionResearchClaimType(selected.kind), sourceId: retrieved.id, status: "active" } });
          store.saveEdge({ id: `edge_${claimId}_${retrieved.id}`, fromId: claimId, toId: retrieved.id, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
        }
        store.appendEvent("research.competition.channel.observed", { sourceId: retrieved.id, url: retrieved.url, channelKind: selected.kind, claimCount: claims.length, insightCounts: { leaderboard: insights.leaderboard.length, discussions: insights.discussions.length, signals: insights.signals.length } });
        store.close();
        output = { id: retrieved.id, title: retrieved.title, url: retrieved.url, channelKind: selected.kind, contentHash: retrieved.contentHash, claims, insights, excerpt: retrieved.excerpt, cached: false };
        break;
      }
      case "source.search": {
        const query = stringArg(args, "query");
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 8;
        const depth = args.depth === "deep" ? "deep" : "shallow";
        const searchStore = new ResearchStore(context.storePath);
        const cachedSearch = searchStore.eventsByType("research.source.search.completed").reverse().find((event) => {
          return sourceSearchCacheIsCurrent(event.payload, query, depth) && Date.now() - Date.parse(event.createdAt) < DEFAULT_SOURCE_REFRESH_MS;
        });
        if (cachedSearch) {
          const payload = cachedSearch.payload as { results: unknown[] };
          const results = payload.results.slice(0, limit) as SourceSearchResult[];
          const needsRefinement = sourceSearchNeedsRefinement(results);
          const frontier = sourceFrontier(searchStore.eventsByTypes([...SOURCE_FRONTIER_EVENT_TYPES]));
          searchStore.appendEvent("research.source.search.cache_hit", { query, resultCount: payload.results.length, freshnessMs: DEFAULT_SOURCE_REFRESH_MS });
          searchStore.close();
          output = { query, results, cached: true, ...(needsRefinement ? { relevance: "weak", warning: "No result met the minimum topical-relevance signal. Treat these only as discovery leads; refine the query or use web/repository search before drawing conclusions." } : { relevance: "usable" }), frontier: { uniqueWorks: frontier.uniqueWorks, retrievedWorks: frontier.retrievedWorks, pendingWorks: frontier.pendingWorks, queryCount: frontier.queryCount } };
          break;
        }
        searchStore.close();
        const results = await searchResearchSources(query, limit, undefined, depth);
        const needsRefinement = sourceSearchNeedsRefinement(results);
        const store = new ResearchStore(context.storePath);
        store.appendEvent("research.source.search.completed", { query, depth, rankingPolicyVersion: SOURCE_SEARCH_RANKING_VERSION, queries: researchSearchQueries(query, depth), probes: depth === "deep" ? 3 : 1, results, sources: [...new Set(results.map((result) => result.provider ?? "unknown"))] });
        const frontier = sourceFrontier(store.eventsByTypes([...SOURCE_FRONTIER_EVENT_TYPES]));
        store.close();
        output = { query, results, ...(needsRefinement ? { relevance: "weak", warning: "No result met the minimum topical-relevance signal. Treat these only as discovery leads; refine the query or use web/repository search before drawing conclusions." } : { relevance: "usable" }), frontier: { uniqueWorks: frontier.uniqueWorks, retrievedWorks: frontier.retrievedWorks, pendingWorks: frontier.pendingWorks, queryCount: frontier.queryCount } };
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
        const maxBytes = typeof args.maxBytes === "number" ? Math.min(args.maxBytes, 2 * 1024 ** 3) : 10_000_000;
        const maxTotalBytes = typeof args.maxTotalBytes === "number"
          ? Math.min(args.maxTotalBytes, 16 * 1024 ** 3)
          : Math.min(16 * 1024 ** 3, maxBytes * rawPaths.length);
        let hashedBytes = 0;
        const artifacts = rawPaths.map((requested) => {
          const lexicalPath = resolve(realpathSync(context.root), requested);
          if (existsSync(lexicalPath) && lstatSync(lexicalPath).isSymbolicLink()) return { path: requested, valid: false, reason: "symlink is not an admissible artifact" };
          const path = inside(context.root, requested);
          if (!existsSync(path)) return { path: requested, valid: false, reason: "missing" };
          if (!statSync(path).isFile()) return { path: requested, valid: false, reason: "not a regular file" };
          const bytes = statSync(path).size;
          if (bytes > maxBytes) return { path: requested, valid: false, bytes, reason: `exceeds ${maxBytes} byte limit` };
          if (hashedBytes + bytes > maxTotalBytes) return { path: requested, valid: false, bytes, reason: `would exceed ${maxTotalBytes} byte aggregate hashing limit` };
          hashedBytes += bytes;
          const entry: { path: string; valid: boolean; bytes: number; checksum: string; jsonValid?: boolean; reason?: string } = { path: requested, valid: true, bytes, checksum: sha256File(path) };
          if (/\.json$/i.test(path)) {
            try { JSON.parse(readFileSync(path, "utf8")); entry.jsonValid = true; }
            catch { entry.jsonValid = false; entry.valid = false; entry.reason = "invalid JSON"; }
          }
          return entry;
        });
        output = { valid: artifacts.every((artifact) => artifact.valid), hashedBytes, maxBytes, maxTotalBytes, artifacts };
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
      case "ensemble.analyze": {
        const store = new ResearchStore(context.storePath);
        const artifacts = store.artifacts().filter((entry) => /prediction|oof/i.test(entry.name) && safePredictionPath(context.root, entry.path));
        const vectors = artifacts.flatMap((entry) => {
          try { return [loadPredictionVector(entry.id, entry.path)]; } catch { return []; }
        });
        const diversity = vectors.length >= 2 ? diversityReport(vectors) : [];
        store.appendEvent("ensemble.analysis.completed", {
          vectors: vectors.map((vector) => ({ id: vector.id, path: relative(context.root, vector.path), values: vector.values.length, checksum: vector.checksum })),
          diversity,
          eligible: vectors.length >= 2,
        });
        store.close();
        output = { vectors: vectors.map((vector) => ({ id: vector.id, path: relative(context.root, vector.path), values: vector.values.length, checksum: vector.checksum })), diversity, eligible: vectors.length >= 2, ...(vectors.length < 2 ? { reason: "at least two valid prediction artifacts are required" } : {}) };
        break;
      }
      case "agent.handoff": {
        const recipient = stringArg(args, "role").trim().slice(0, 120);
        const message = stringArg(args, "message").trim().slice(0, 4_000);
        if (!recipient || !message) throw new Error("Agent handoff requires a recipient role and message.");
        if (context.role && recipient === context.role) throw new Error("Agent handoff recipient must differ from the sender role.");
        const scopeKey = typeof args.scopeKey === "string" ? args.scopeKey.trim().slice(0, 240) || null : null;
        const store = new ResearchStore(context.storePath);
        const directive = store.enqueueAgentDirectiveOnce(recipient, message, scopeKey, context.role ?? "controller");
        store.appendEvent("agent.handoff.sent", { directiveId: directive.id, sourceRole: context.role ?? "controller", recipientRole: recipient, scopeKey });
        store.close();
        output = { directiveId: directive.id, sourceRole: context.role ?? "controller", recipientRole: recipient, scopeKey, delivery: "next_safe_boundary" };
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
        default: throw new Error(unknownToolMessage());
      }
    }
    const trust = toolTrust(call.name);
    const securityWarnings = trust === "untrusted_content" ? untrustedContentWarnings(output) : [];
    if (external && securityWarnings.length) {
      const quarantineReason = `automatic quarantine after untrusted adapter output: ${securityWarnings.join(", ")}`;
      try { setExternalToolStatus(context.root, external.name, "quarantined", quarantineReason); } catch { /* preserve the detected warning even if state persistence is unavailable */ }
      toolOk = false;
      toolError = quarantineReason;
    }
    const result = { name: call.name, ok: toolOk, output, trust, ...(toolError ? { error: toolError } : {}), ...(securityWarnings.length ? { securityWarnings } : {}) };
    recordToolEvent(context, result, external ? { manifestHash: externalManifest.contentHash } : {});
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result = { name: call.name, ok: false, error: errorMessage, trust: toolFailureTrust(errorMessage) };
    recordToolEvent(context, result, call.name.startsWith("external.") ? { manifestHash: externalManifest.contentHash } : {});
    return result;
  }
}
