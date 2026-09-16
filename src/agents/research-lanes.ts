import { z } from "zod";
import { cpus, totalmem } from "node:os";
import { ResearchStore } from "../core/store.js";
import type { AgentProvider, CodexWebSearchMode, ExecAgentOptions } from "./codex-exec.js";
import type { AgentResult } from "../core/types.js";
import { isProviderUsageLimit, isRetryableAgentError, resolveLocalFallbackModel, runWithLocalFallback } from "./codex-exec.js";
import type { ProcessControl } from "../core/process.js";
import type { AutonomyLevel } from "../core/permissions.js";
import { normalizeResearchToolResult, toolFailureTrust, type ResearchToolCall, type ResearchToolResult } from "../core/tools.js";
import { boundResearchContext } from "../core/context-budget.js";
import type { LaneFinding } from "../core/cross-pollination.js";

export const RESEARCH_LANE_ROLES = [
  "data detective",
  "validation scientist",
  "model researcher",
  "ensemble scientist",
  "reproducibility engineer",
] as const;

export const GENERAL_RESEARCH_LANE_ROLES = [
  "domain researcher",
  "validation scientist",
  "method researcher",
  "reproducibility engineer",
] as const;

export type ResearchLaneRole = typeof RESEARCH_LANE_ROLES[number] | typeof GENERAL_RESEARCH_LANE_ROLES[number];

export const ResearchLaneReportSchema = z.object({
  role: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  summary: z.string().min(1),
  findings: z.array(z.string()).max(12),
  recommendations: z.array(z.string()).max(8),
  uncertainties: z.array(z.string()).max(8),
  discriminatingTests: z.array(z.string()).max(8).default([]),
  evidence: z.array(z.string()).max(12),
  evidenceSourceIds: z.array(z.string().min(1)).max(8).default([]),
  confidence: z.number().min(0).max(1),
});

export type ResearchLaneReport = z.infer<typeof ResearchLaneReportSchema> & {
  status: "completed" | "failed";
  error?: string;
  toolResults?: ResearchToolResult[];
};

export const ResearchReviewSchema = z.object({
  verdict: z.enum(["proceed", "revise", "reject"]),
  summary: z.string().min(1),
  objections: z.array(z.string()).max(12),
  requiredChecks: z.array(z.string()).max(12),
  evidence: z.array(z.string()).max(12).default([]),
  independentReplication: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export type ResearchReview = z.infer<typeof ResearchReviewSchema> & {
  status: "completed" | "failed";
  error?: string;
};

export const ResearchSemanticAuditSchema = z.object({
  verdict: z.enum(["pass", "revise", "reject"]),
  summary: z.string().min(1),
  findings: z.array(z.string()).max(12),
  requiredChecks: z.array(z.string()).max(12),
  evidence: z.array(z.string()).max(12).default([]),
  criteria: z.array(z.object({
    criterionId: z.string().min(1),
    verdict: z.enum(["pass", "revise", "reject"]),
    evidence: z.array(z.string()).max(8).default([]),
    reasoning: z.string().min(1),
  })).max(12).default([]),
  confidence: z.number().min(0).max(1),
});

export type ResearchSemanticAudit = z.infer<typeof ResearchSemanticAuditSchema> & {
  status: "completed" | "failed";
  error?: string;
  servedProvider?: string;
  servedModel?: string;
};

export function normalizeResearchSemanticAudit(audit: z.infer<typeof ResearchSemanticAuditSchema>, validEvidence: ReadonlySet<string>, requiredCriteria: Array<{ id: string; description: string; required?: boolean }> = []): ResearchSemanticAudit {
  const evidence = audit.evidence.filter((anchor) => validEvidence.has(anchor));
  const invalid = audit.evidence.filter((anchor) => !validEvidence.has(anchor));
  const criteria = audit.criteria.map((criterion) => ({ ...criterion, evidence: criterion.evidence.filter((anchor) => validEvidence.has(anchor)) }));
  const criterionIds = new Set(requiredCriteria.map((criterion) => criterion.id));
  const unknownCriteria = criteria.filter((criterion) => !criterionIds.has(criterion.criterionId)).map((criterion) => criterion.criterionId);
  const missingCriteria = requiredCriteria.filter((criterion) => criterion.required !== false && !criteria.some((auditCriterion) => auditCriterion.criterionId === criterion.id)).map((criterion) => criterion.id);
  const failedCriteria = requiredCriteria.filter((criterion) => criterion.required !== false && criteria.find((auditCriterion) => auditCriterion.criterionId === criterion.id)?.verdict !== "pass").map((criterion) => criterion.id);
  const criterionFailure = requiredCriteria.length > 0 && (missingCriteria.length > 0 || failedCriteria.length > 0);
  return {
    ...audit,
    evidence,
    criteria,
    verdict: audit.verdict === "pass" && (evidence.length === 0 || audit.requiredChecks.length > 0 || criterionFailure) ? "revise" : audit.verdict,
    findings: [...audit.findings, ...(invalid.length ? [`Unrecognized evidence anchors discarded: ${invalid.join(", ")}.`] : []), ...(unknownCriteria.length ? [`Unknown criterion IDs discarded: ${unknownCriteria.join(", ")}.`] : [])].slice(0, 12),
    requiredChecks: [...audit.requiredChecks, ...(missingCriteria.length ? [`missing criteria: ${missingCriteria.join(", ")}`] : []), ...(failedCriteria.length ? [`failed criteria: ${failedCriteria.join(", ")}`] : [])].slice(0, 12),
    status: "completed",
  };
}

const RESEARCH_LANE_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["role", "summary", "findings", "recommendations", "uncertainties", "discriminatingTests", "evidence", "evidenceSourceIds", "confidence"],
  properties: {
    role: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array", maxItems: 12, items: { type: "string" } },
    recommendations: { type: "array", maxItems: 8, items: { type: "string" } },
    uncertainties: { type: "array", maxItems: 8, items: { type: "string" } },
    discriminatingTests: { type: "array", maxItems: 8, items: { type: "string" } },
    evidence: { type: "array", maxItems: 12, items: { type: "string" } },
    evidenceSourceIds: { type: "array", maxItems: 8, items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

const RESEARCH_REVIEW_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "objections", "requiredChecks", "evidence", "independentReplication", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["proceed", "revise", "reject"] },
    summary: { type: "string" },
    objections: { type: "array", maxItems: 12, items: { type: "string" } },
    requiredChecks: { type: "array", maxItems: 12, items: { type: "string" } },
    evidence: { type: "array", maxItems: 12, items: { type: "string" } },
    independentReplication: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

const RESEARCH_SEMANTIC_AUDIT_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "requiredChecks", "evidence", "criteria", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["pass", "revise", "reject"] },
    summary: { type: "string" },
    findings: { type: "array", maxItems: 12, items: { type: "string" } },
    requiredChecks: { type: "array", maxItems: 12, items: { type: "string" } },
    evidence: { type: "array", maxItems: 12, items: { type: "string" } },
    criteria: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["criterionId", "verdict", "evidence", "reasoning"], properties: { criterionId: { type: "string" }, verdict: { type: "string", enum: ["pass", "revise", "reject"] }, evidence: { type: "array", maxItems: 8, items: { type: "string" } }, reasoning: { type: "string" } } } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

/** A review cannot approve a decision while declaring unresolved checks. */
export function normalizeResearchReview(review: ResearchReview, validEvidence?: ReadonlySet<string>): ResearchReview {
  const groundedEvidence = validEvidence
    ? review.evidence.filter((evidence) => validEvidence.has(evidence))
    : review.evidence;
  const invalidEvidence = validEvidence ? review.evidence.filter((evidence) => !validEvidence.has(evidence)) : [];
  const missingEvidence = groundedEvidence.length === 0;
  if (review.verdict !== "proceed" || (review.requiredChecks.length === 0 && !missingEvidence)) {
    return invalidEvidence.length ? { ...review, evidence: groundedEvidence } : review;
  }
  const reasons = [
    ...(review.requiredChecks.length ? ["The review declared unresolved required checks while requesting proceed."] : []),
    ...(missingEvidence ? [validEvidence ? "The review cited no evidence anchor that matches a durable observation." : "The review cited no durable evidence anchors."] : []),
    ...(invalidEvidence.length ? [`Unrecognized evidence anchors were discarded: ${invalidEvidence.join(", ")}.`] : []),
  ];
  return {
    ...review,
    verdict: "revise",
    evidence: groundedEvidence,
    summary: `${review.summary} Approval withheld until the review has durable evidence anchors and no unresolved checks.`,
    objections: [...new Set([...review.objections, ...reasons])].slice(0, 12),
    confidence: Math.min(review.confidence, 0.6),
  };
}

export interface ResearchLanesOptions {
  provider: AgentProvider;
  model: string;
  /** Optional heterogeneous pool. The first route is the primary route; remaining routes are assigned round-robin. */
  modelPool?: Array<{ provider: AgentProvider; model: string }>;
  fallbackLocalModel?: string;
  limitPolicy?: ExecAgentOptions["limitPolicy"];
  reasoningEffort?: string;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexWebSearchMode;
  timeoutMs?: number;
  cwd: string;
  storePath: string;
  maxParallel?: number;
  /** Total specialists in the wave-based team; defaults to the available role pool outside safe mode. */
  laneTeamSize?: number;
  autonomy?: AutonomyLevel;
  laneFocus?: string;
  laneRotation?: number;
  onProgress?: (message: string) => void;
  onProcess?: (control: ProcessControl) => void;
  isCancelled?: () => boolean;
  executeTool?: (call: ResearchToolCall) => Promise<ResearchToolResult>;
  onToolCall?: (source: string, call: ResearchToolCall) => string;
  onToolResult?: (source: string, callId: string, result: ResearchToolResult) => void;
  onActivity?: (source: string, activity: string) => void;
  onAssistant?: (source: string, text: string) => void;
  onUsage?: (usage: AgentResult["usage"], provider: string, model: string, role: string) => void;
}

export interface ResearchLaneRoute {
  role: ResearchLaneRole;
  provider: AgentProvider;
  model: string;
}

export function assignResearchLaneRoutes(roles: ResearchLaneRole[], options: Pick<ResearchLanesOptions, "provider" | "model" | "modelPool">): ResearchLaneRoute[] {
  const pool = (options.modelPool ?? []).filter((route) => route.model.trim().length > 0);
  const routes = pool.length ? pool : [{ provider: options.provider, model: options.model }];
  return roles.map((role, index) => ({ role, ...routes[index % routes.length] }));
}

function laneRouteKey(route: Pick<ResearchLaneRoute, "provider" | "model">): string {
  return `${route.provider}\u0000${route.model}`;
}

/** Select the first untried route for bounded recovery of a failed lane. */
export function alternateResearchLaneRoute(
  current: Pick<ResearchLaneRoute, "provider" | "model">,
  pool: Array<{ provider: AgentProvider; model: string }> | undefined,
  attempted: ReadonlySet<string> = new Set(),
): Omit<ResearchLaneRoute, "role"> | undefined {
  const currentKey = laneRouteKey(current);
  return (pool ?? []).find((route) => {
    const key = laneRouteKey(route);
    return route.model.trim().length > 0 && key !== currentKey && !attempted.has(key);
  });
}

/** Keep lane observations bounded and role-specific before model synthesis. */
export function laneToolCalls(role: ResearchLaneRole, objective = ""): ResearchToolCall[] {
  const focus = role === "data detective"
    ? "duplicate|leak|missing|shift|group|target|label"
    : role === "validation scientist"
      ? "split|fold|valid|metric|evaluator|seed|test"
      : role === "model researcher"
        ? "train|model|estimator|baseline|experiment|config"
        : role === "ensemble scientist"
          ? "prediction|oof|ensemble|blend|correlation|diversity|error"
          : role === "reproducibility engineer"
            ? "reproduce|replicate|seed|environment|dependency|artifact|determin"
      : role === "domain researcher"
          ? "theorem|definition|assumption|proof|method|result|literature|paper"
          : "algorithm|method|approach|experiment|procedure|implementation|benchmark";
  const calls: ResearchToolCall[] = [
    { name: "workspace.files", arguments: {} },
    { name: "workspace.search", arguments: { query: focus } },
  ];
  // Literature-aware lanes should discover primary work before the director
  // commits to a method. Search is deliberately bounded and remains only a
  // candidate frontier; retrieval and claim verification still happen through
  // the evidence-aware source workflow.
  if (role === "domain researcher" || role === "method researcher" || role === "model researcher" || role === "validation scientist") {
    researchLiteratureQueries(objective, role).forEach((literatureQuery, index) => calls.push({ name: "source.search", arguments: { query: literatureQuery, limit: 6, depth: index === 0 ? "deep" : "shallow" } }));
  }
  if (role === "domain researcher" || role === "data detective") {
    calls.push({ name: "web.search", arguments: { query: objective.trim().slice(0, 500) || "official documentation discussions datasets", limit: 6 } });
  }
  if (role === "method researcher" || role === "model researcher") calls.push({ name: "repository.search", arguments: { query: objective.trim().slice(0, 300) || "research method implementation", limit: 6 } });
  if (role === "ensemble scientist") calls.push({ name: "ensemble.analyze", arguments: {} });
  return calls;
}

/**
 * Generate complementary literature probes rather than spending a lane's
 * entire search budget on one wording of the objective. The probes are
 * deterministic so query cost and coverage can be replayed and compared.
 */
export function researchLiteratureQueries(objective: string, role: ResearchLaneRole): string[] {
  const base = objective.trim().slice(0, 500) || `${role} methods and evidence`;
  const probes = role === "validation scientist"
    ? ["replication limitations evaluation protocol", "robustness ablation independent validation"]
      : role === "domain researcher"
      ? ["definitions assumptions competing explanations", "open problems evidence and counterexamples"]
      : role === "method researcher"
        ? ["alternative algorithms implementation details replication", "ablation transfer limitations benchmark"]
        : role === "model researcher"
          ? ["representation inductive bias optimization generalization", "architecture ablation robustness out of distribution"]
      : ["implementation replication limitations", "ablation generalization benchmark evaluation"];
  return [...new Set([base, ...probes.map((probe) => `${base} ${probe}`)])].slice(0, 3);
}

/** Choose an appropriate research team without assuming every task is ML. */
export interface ResearchLaneSelectionOptions {
  /** A measured deficiency can pull its specialist to the front of the team. */
  focus?: string;
  /** Rotate otherwise equivalent specialists across autonomous cycles. */
  rotation?: number;
}

export function selectResearchLaneRoles(objective: string, requested: number, options: ResearchLaneSelectionOptions = {}): ResearchLaneRole[] {
  const mlOrCompetition = /\b(dataset|training|train|model|estimator|competition|leaderboard|metric|fold|gpu|prediction|baseline)\b/i.test(objective);
  const pool = mlOrCompetition ? RESEARCH_LANE_ROLES : GENERAL_RESEARCH_LANE_ROLES;
  const count = Math.max(1, Math.min(requested, pool.length));
  const focus = options.focus?.toLowerCase() ?? "";
  const focusRole = focus.includes("data")
    ? "data detective"
    : focus.includes("evidence") || focus.includes("validation")
      ? "validation scientist"
    : focus.includes("recovery") || focus.includes("reproduc") || focus.includes("tool")
      ? "reproducibility engineer"
      : focus.includes("goal") || focus.includes("termination")
        ? "validation scientist"
        : focus.includes("breadth") || focus.includes("search")
          ? "method researcher"
          : undefined;
  const prioritized = focusRole && pool.some((role) => role === focusRole)
    ? [focusRole as ResearchLaneRole, ...pool.filter((role) => role !== focusRole)]
    : [...pool];
  // Rotation is applied only to the non-specialist portfolio. A measured
  // failure must keep its repair lane first, while the remaining seats rotate
  // to prevent a low-concurrency campaign from seeing one fixed slice of the
  // research team forever.
  const head = prioritized[0] === focusRole ? [prioritized[0]] : [];
  const tail = prioritized.slice(head.length);
  const offset = tail.length ? Math.abs(Math.trunc(options.rotation ?? 0)) % tail.length : 0;
  const rotated = [...tail.slice(offset), ...tail.slice(0, offset)];
  return [...head, ...rotated].slice(0, count);
}

const MAX_LANE_TOOL_RESULT_BYTES = 12_000;

export function boundLaneToolResult(result: ResearchToolResult): ResearchToolResult {
  result = normalizeResearchToolResult(result);
  if (result.output === undefined) return result;
  const serialized = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_LANE_TOOL_RESULT_BYTES) return result;
  return {
    ...result,
    output: `${serialized.slice(0, MAX_LANE_TOOL_RESULT_BYTES)}\n...[lane observation truncated by Evidra]...`,
  };
}

/**
 * Select a conservative lane count from user intent and host/provider
 * capacity. This is deliberately bounded: more agents are not automatically
 * more useful when they contend for one Ollama process or one subscription.
 */
export function researchLaneConcurrency(options: { autonomy?: AutonomyLevel; provider: AgentProvider; requested?: number } ): number {
  const cpuCount = Math.max(1, cpus().length);
  const memoryGiB = totalmem() / (1024 ** 3);
  const autonomy = options.autonomy ?? "safe";
  const hostCeiling = memoryGiB < 8 || cpuCount < 4 ? 1 : memoryGiB < 16 || cpuCount < 8 ? 2 : 4;
  const localCeiling = options.provider === "local" ? Math.max(1, Number.parseInt(process.env.OLLAMA_NUM_PARALLEL ?? "1", 10) || 1) : 6;
  const moodCeiling = autonomy === "safe" ? 1 : autonomy === "fast" ? 2 : 4;
  return Math.max(1, Math.min(options.requested ?? moodCeiling, hostCeiling, localCeiling, moodCeiling));
}

/** Select total team size separately from concurrency so later waves can peer-review earlier ones. */
export function researchLaneTeamSize(
  objective: string,
  concurrency: number,
  options: Pick<ResearchLanesOptions, "autonomy" | "laneTeamSize"> = {},
): number {
  const mlOrCompetition = /\b(dataset|training|train|model|estimator|competition|leaderboard|metric|fold|gpu|prediction|baseline)\b/i.test(objective);
  const availableRoles = mlOrCompetition ? RESEARCH_LANE_ROLES.length : GENERAL_RESEARCH_LANE_ROLES.length;
  const defaultTeamSize = (options.autonomy ?? "safe") === "safe" ? concurrency : availableRoles;
  const requestedTeamSize = typeof options.laneTeamSize === "number" && Number.isFinite(options.laneTeamSize)
    ? Math.floor(options.laneTeamSize)
    : defaultTeamSize;
  return Math.max(concurrency, Math.min(availableRoles, requestedTeamSize));
}

function parseJson(output: unknown): unknown {
  const text = String(output).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Lane did not return a JSON report.");
  }
}

function lanePrompt(role: ResearchLaneRole, objective: string): string {
  const focus = role === "data detective"
    ? "Inspect data provenance, duplicates, leakage, distributions, hidden groups, and train/test shift."
    : role === "validation scientist"
      ? "Inspect evaluation design, split validity, metric reliability, uncertainty, and replication requirements."
      : role === "model researcher"
        ? "Inspect the implementation and research space, identify promising general methods, and propose falsifiable experiments."
        : role === "reproducibility engineer"
          ? "Inspect reproducibility, environment capture, seeds, artifact contracts, independent reruns, and failure recovery."
        : role === "domain researcher"
          ? "Investigate the domain, definitions, assumptions, relevant literature, competing explanations, and unresolved questions."
          : "Investigate alternative methods, mechanisms, procedures, and implementation paths; propose falsifiable comparisons.";
  return `${focus}\n\nObjective: ${objective}\n\n` +
    "You are an independent Evidra research lane. Use the supplied workspace and evidence context; run only read-only inspection when tools are available. Do not edit files, submit anything, or claim measurements you did not observe. Return ONLY JSON with this shape: " +
    '{"role":"...","summary":"...","findings":["..."],"recommendations":["..."],"uncertainties":["..."],"discriminatingTests":["cheapest observation or experiment that would distinguish competing explanations"],"evidence":["command, artifact, or source supporting each important statement"],"evidenceSourceIds":["exact durable source IDs for literature-derived evidence"],"confidence":0.0}. ' +
    "Recommendations must be testable and should state what would falsify them. For every material uncertainty or disagreement, propose a concrete discriminating test. A bounded prior-peer board may be present in the context: use it to challenge, extend, or explicitly reject earlier findings, but never treat it as stronger than primary evidence.";
}

/** Keep cross-cycle peer communication useful without replaying unbounded transcripts. */
export function boundedPeerBoard(events: Array<{ type: string; payload: unknown }>, limit = 4): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.type === "research.lane.completed")
    .map((event) => {
      const payload = event.payload && typeof event.payload === "object" ? event.payload as { report?: unknown } : {};
      const report = payload.report && typeof payload.report === "object" ? payload.report as Record<string, unknown> : {};
      return {
        role: typeof report.role === "string" ? report.role : "unknown",
        summary: typeof report.summary === "string" ? report.summary.slice(0, 1200) : "",
        findings: Array.isArray(report.findings) ? report.findings.slice(0, 5) : [],
        recommendations: Array.isArray(report.recommendations) ? report.recommendations.slice(0, 4) : [],
        uncertainties: Array.isArray(report.uncertainties) ? report.uncertainties.slice(0, 3) : [],
        discriminatingTests: Array.isArray(report.discriminatingTests) ? report.discriminatingTests.slice(0, 3) : [],
        evidence: Array.isArray(report.evidence) ? report.evidence.slice(0, 5) : [],
        evidenceSourceIds: Array.isArray(report.evidenceSourceIds) ? report.evidenceSourceIds.slice(0, 5) : [],
        confidence: typeof report.confidence === "number" && Number.isFinite(report.confidence) ? report.confidence : 0,
      };
    })
    .slice(-Math.max(1, Math.min(limit, 8)));
}

/**
 * Convert completed lane reports into a small, explicit hand-off board.
 * Unlike the full reports this board is safe to pass to another lane: it is
 * bounded, preserves evidence anchors, and makes it clear that peer output is
 * a challenge surface rather than ground truth.
 */
export function laneHandoffBoard(reports: LaneFinding[], limit = 4): Array<Record<string, unknown>> {
  return reports.map((report) => ({
    role: typeof report.role === "string" ? report.role : "unknown",
    summary: typeof report.summary === "string" ? report.summary.slice(0, 1200) : "",
    findings: Array.isArray(report.findings) ? report.findings.slice(0, 5) : [],
    recommendations: Array.isArray(report.recommendations) ? report.recommendations.slice(0, 4) : [],
    uncertainties: Array.isArray(report.uncertainties) ? report.uncertainties.slice(0, 3) : [],
    discriminatingTests: Array.isArray(report.discriminatingTests) ? report.discriminatingTests.slice(0, 3) : [],
    evidence: Array.isArray(report.evidence) ? report.evidence.slice(0, 5) : [],
    evidenceSourceIds: Array.isArray(report.evidenceSourceIds) ? report.evidenceSourceIds.slice(0, 5) : [],
    confidence: typeof report.confidence === "number" && Number.isFinite(report.confidence) ? report.confidence : 0,
  })).slice(-Math.max(1, Math.min(limit, 8)));
}

function saveLaneEvent(storePath: string, role: string, report: ResearchLaneReport): void {
  const store = new ResearchStore(storePath);
  store.appendEvent(report.status === "completed" ? "research.lane.completed" : "research.lane.failed", { role, report });
  if (report.status === "completed") {
    const claimId = `claim_lane_${Date.now()}_${role.replace(/[^a-z0-9]+/gi, "-")}`;
    const sourceIds = [...new Set((report.evidenceSourceIds ?? []).filter((sourceId) => store.sources().some((source) => source.id === sourceId)))];
    const sourceId = sourceIds[0];
    store.saveClaim({
      id: claimId,
      payload: {
        id: claimId,
        statement: `[${role}] ${report.summary}`,
        scope: "research lane report",
        confidence: sourceId ? Math.min(report.confidence, 0.35) : report.confidence,
        sourceType: sourceId ? "literature" : "observation",
        sourceId: sourceId ?? `lane_${role}`,
        status: "active",
        findings: report.findings,
        evidence: report.evidence,
      },
    });
    for (const linkedSourceId of sourceIds) store.saveEdge({ id: `edge_${claimId}_${linkedSourceId}`, fromId: claimId, toId: linkedSourceId, relation: "derived_from", confidence: 0.35, evidenceIds: [claimId] });
  }
  store.close();
}

/** Run an adversarial review after independent lanes have reported. */
export async function runResearchCritic(
  objective: string,
  decision: unknown,
  laneReports: ResearchLaneReport[],
  options: ResearchLanesOptions,
): Promise<ResearchReview> {
  const store = new ResearchStore(options.storePath);
  store.updateAgentLane({ role: "critic", status: "running", provider: options.provider, model: options.model, task: objective, error: null });
  store.close();
  options.onProgress?.("Research critic · checking assumptions and disagreement...");
  const prompt = `${objective}\n\nYou are Evidra's independent critic. Review the proposed decision and independent lane reports below. Look for unsupported claims, leakage, invalid comparisons, missing controls, overconfident conclusions, and cheaper falsification tests. Do not rewrite the decision or invent measurements. Return ONLY JSON: {"verdict":"proceed|revise|reject","summary":"...","objections":["..."],"requiredChecks":["..."],"evidence":["copy an exact evidence anchor from the lane reports or durable observation context"],"independentReplication":true,"confidence":0.0}. A proceed verdict is valid only when evidence contains at least one exact anchor from the supplied reports and requiredChecks is empty.\n\nDecision:\n${JSON.stringify(decision)}\n\nLane reports:\n${JSON.stringify(laneReports)}`;
  try {
    let provider = options.provider;
    let model = options.model;
    let result: Awaited<ReturnType<typeof runWithLocalFallback>> | undefined;
    let lastError: unknown;
    const attemptedRoutes = new Set<string>();
    for (let attempt = 1; attempt <= 3 && !result; attempt += 1) {
      attemptedRoutes.add(`${provider}\u0000${model}`);
      try {
        result = await runWithLocalFallback({ role: "critic", objective: prompt, context: { decision, laneReports }, outputSchema: RESEARCH_REVIEW_OUTPUT_SCHEMA }, {
          provider,
          model,
          limitPolicy: options.limitPolicy,
          reasoningEffort: options.reasoningEffort,
          networkAccessEnabled: options.networkAccessEnabled ?? true,
          webSearchMode: options.webSearchMode ?? "live",
          timeoutMs: options.timeoutMs,
          cwd: options.cwd,
          sandbox: "read-only",
          onActivity: options.onActivity,
          onAssistant: options.onAssistant,
        }, provider === "codex" ? options.fallbackLocalModel : undefined, options.onProgress, options.onProcess);
      } catch (error) {
        lastError = error;
        if (!isRetryableAgentError(error) || attempt === 3 || (isProviderUsageLimit(error) && options.limitPolicy === "wait")) throw error;
        const alternate = alternateResearchLaneRoute({ provider, model }, options.modelPool, attemptedRoutes);
        if (alternate) {
          provider = alternate.provider;
          model = alternate.model;
          options.onProgress?.(`Research critic changing route to ${provider}/${model}...`);
          continue;
        }
        const delayMs = attempt * 1_000;
        options.onProgress?.(`Research critic retry ${attempt}/2 in ${delayMs / 1000}s...`);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    if (!result) throw lastError instanceof Error ? lastError : new Error("Research critic did not return a result.");
    options.onUsage?.(result.usage, result.provider, result.model ?? model, "critic");
    const evidenceStore = new ResearchStore(options.storePath);
    const evidenceAnchors = new Set<string>([
      ...laneReports.flatMap((lane) => lane.evidence),
      ...evidenceStore.sources().map((source) => source.id),
      ...evidenceStore.runs().map((run) => run.id),
      ...evidenceStore.artifacts().map((artifact) => artifact.id),
    ]);
    evidenceStore.close();
    const review = normalizeResearchReview({ ...ResearchReviewSchema.parse(parseJson(result.output)), status: "completed" }, evidenceAnchors);
    const completed = new ResearchStore(options.storePath);
    completed.appendEvent("research.critic.completed", {
      review,
      objective,
      requestedProvider: options.provider,
      requestedModel: options.model,
      servedProvider: result.provider,
      servedModel: result.model ?? options.model,
    });
    const claimId = `claim_critic_${Date.now()}`;
    completed.saveClaim({ id: claimId, payload: { id: claimId, statement: `[critic:${review.verdict}] ${review.summary}`, scope: "research decision review", confidence: review.confidence, sourceType: "review", sourceId: claimId, status: "active", objections: review.objections, requiredChecks: review.requiredChecks, evidence: review.evidence, servedProvider: result.provider, servedModel: result.model ?? options.model } });
    completed.updateAgentLane({ role: "critic", status: "idle", provider: result.provider, model: result.model ?? model, task: null, error: null });
    completed.close();
    return review;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = new ResearchStore(options.storePath);
    failed.appendEvent("research.critic.failed", { objective, error: message });
    failed.updateAgentLane({ role: "critic", status: "failed", provider: options.provider, model: options.model, task: objective, error: message });
    failed.close();
    return { verdict: "revise", summary: "Independent critic did not complete; do not promote this direction without manual review.", objections: [message], requiredChecks: ["rerun the independent critic"], evidence: [], independentReplication: true, confidence: 0, status: "failed", error: message };
  }
}

/**
 * Run a fresh semantic audit after the director and critic. The auditor gets
 * only typed decision/evidence context, uses a separate role/thread, and can
 * never mutate the workspace. Hard controller checks still outrank this
 * model-backed opinion.
 */
export async function runResearchSemanticAuditor(
  objective: string,
  decision: unknown,
  evidenceContext: unknown,
  options: ResearchLanesOptions,
  acceptanceCriteria: Array<{ id: string; description: string; required?: boolean }> = [],
): Promise<ResearchSemanticAudit> {
  const role = "semantic auditor";
  const store = new ResearchStore(options.storePath);
  store.updateAgentLane({ role, status: "running", provider: options.provider, model: options.model, task: objective, error: null });
  store.close();
  options.onProgress?.("Research auditor · independently checking evidence and method...");
  try {
    const directEvidence: ResearchToolResult[] = [];
    if (options.executeTool) {
      const inspect = async (call: ResearchToolCall): Promise<ResearchToolResult> => {
        const result = normalizeResearchToolResult(await options.executeTool!(call));
        directEvidence.push(result);
        return result;
      };
      const files = await inspect({ name: "workspace.files", arguments: {} });
      await inspect({ name: "git.status", arguments: {} });
      await inspect({ name: "workspace.search", arguments: { query: "metric|score|result|artifact|submission|report" } });
      const listed = files.output && typeof files.output === "object" && Array.isArray((files.output as { files?: unknown }).files)
        ? (files.output as { files: unknown[] }).files.filter((file): file is string => typeof file === "string")
        : [];
      const artifactPaths = listed.filter((file) => /(?:result|artifact|metric|score|submission|output|report)/i.test(file) && /\.(?:json|jsonl|csv|log|txt)$/i.test(file)).slice(0, 16);
      if (artifactPaths.length) await inspect({ name: "artifact.audit", arguments: { paths: artifactPaths, maxBytes: 2_000_000 } });
    }
    const prompt = `${objective}\n\nYou are Evidra's independent semantic auditor. Inspect the typed proposed decision and bounded durable evidence below, plus fresh read-only tool observations collected by the controller. Do not trust the director, critic, or executor narrative. Check whether the proposed action follows from evidence, whether the comparison/control is valid, whether the hypothesis is falsifiable, and whether risks or required checks are unresolved. Do not invent measurements, citations, or workspace facts. Return ONLY JSON with verdict pass|revise|reject, summary, findings, requiredChecks, overall evidence, criterion-level results, and confidence: {"verdict":"pass|revise|reject","summary":"...","findings":["..."],"requiredChecks":["..."],"evidence":["exact evidence anchors only"],"criteria":[{"criterionId":"exact supplied criterion id","verdict":"pass|revise|reject","evidence":["exact anchors"],"reasoning":"..."}],"confidence":0.0}. Evaluate every supplied criterion. A pass requires every required criterion to pass, at least one exact evidence anchor, and no requiredChecks.\n\nAcceptance criteria:\n${JSON.stringify(acceptanceCriteria)}\n\nProposed decision:\n${JSON.stringify(decision)}\n\nBounded evidence:\n${JSON.stringify(evidenceContext)}\n\nFresh auditor observations:\n${JSON.stringify(directEvidence)}`;
    let provider = options.provider;
    let model = options.model;
    const alternate = alternateResearchLaneRoute({ provider, model }, options.modelPool, new Set([`${provider}\u0000${model}`]));
    // Prefer a distinct authenticated route where one is available; otherwise
    // a fresh auditor thread still provides independent context separation.
    if (alternate) ({ provider, model } = alternate);
    const result = await runWithLocalFallback({ role, objective: prompt, context: { decision, evidenceContext }, outputSchema: RESEARCH_SEMANTIC_AUDIT_OUTPUT_SCHEMA }, {
      provider,
      model,
      limitPolicy: options.limitPolicy,
      reasoningEffort: options.reasoningEffort,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      timeoutMs: options.timeoutMs,
      cwd: options.cwd,
      sandbox: "read-only",
      onActivity: options.onActivity,
      onAssistant: options.onAssistant,
    }, provider === "codex" ? options.fallbackLocalModel : undefined, options.onProgress, options.onProcess);
    options.onUsage?.(result.usage, result.provider, result.model ?? model, role);
    const evidenceStore = new ResearchStore(options.storePath);
    const validEvidence = new Set<string>([
      ...evidenceStore.eventsByType("research.observation").map((event) => event.type),
      ...evidenceStore.eventsByType("research.tool.completed").map((event) => event.type),
      ...evidenceStore.sources().map((source) => source.id),
      ...evidenceStore.runs().map((run) => run.id),
      ...evidenceStore.artifacts().map((artifact) => artifact.id),
      ...directEvidence.map((result) => result.name),
    ]);
    evidenceStore.close();
    const audit: ResearchSemanticAudit = {
      ...normalizeResearchSemanticAudit(ResearchSemanticAuditSchema.parse(parseJson(result.output)), validEvidence, acceptanceCriteria),
      servedProvider: result.provider,
      servedModel: result.model ?? model,
    };
    const completed = new ResearchStore(options.storePath);
    completed.appendEvent("research.semantic_audit.completed", { objective, audit, requestedProvider: options.provider, requestedModel: options.model, servedProvider: result.provider, servedModel: result.model ?? model });
    completed.updateAgentLane({ role, status: "idle", provider: result.provider, model: result.model ?? model, task: null, error: null });
    completed.close();
    return audit;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = new ResearchStore(options.storePath);
    failed.appendEvent("research.semantic_audit.failed", { objective, error: message });
    failed.updateAgentLane({ role, status: "failed", provider: options.provider, model: options.model, task: objective, error: message });
    failed.close();
    return { verdict: "revise", summary: "Semantic auditor did not complete; preserve the decision for another audit.", findings: [message], requiredChecks: ["rerun semantic auditor"], evidence: [], criteria: [], confidence: 0, status: "failed", error: message };
  }
}

async function runLane(role: ResearchLaneRole, objective: string, context: Record<string, unknown>, options: ResearchLanesOptions, laneRoute: ResearchLaneRoute): Promise<ResearchLaneReport> {
  const store = new ResearchStore(options.storePath);
  store.updateAgentLane({ role, status: "running", provider: laneRoute.provider, model: laneRoute.model, task: objective, error: null });
  store.close();
  options.onProgress?.(`Research lane · ${role} · investigating...`);
  try {
    const toolResults: ResearchToolResult[] = [];
    if (options.executeTool) {
      const calls = laneToolCalls(role, objective);
      let retrievedSourceCount = 0;
      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex];
        if (options.isCancelled?.()) throw new Error("Interrupted · research lane cancelled.");
        options.onProgress?.(`Research lane · ${role} · ${call.name}...`);
        const callId = options.onToolCall?.(`lane:${role}`, call) ?? `${role}-${call.name}-${toolResults.length + 1}`;
        let result: ResearchToolResult = { name: call.name, ok: false, error: "Tool did not return a result.", trust: "permission_boundary" };
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            result = boundLaneToolResult(await options.executeTool(call));
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            result = { name: call.name, ok: false, error: errorMessage, trust: toolFailureTrust(errorMessage) };
          }
          options.onToolResult?.(`lane:${role}`, attempt === 1 ? callId : `${callId}:retry`, result);
          if (result.ok || attempt === 2 || !isRetryableAgentError(new Error(result.error ?? ""))) break;
          options.onProgress?.(`Research lane · ${role} · ${call.name} failed transiently; retrying once...`);
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        // Preserve the failed observation and let the lane explain the gap or
        // select a different route; one unavailable tool must not erase an
        // otherwise independent research perspective.
        toolResults.push(result);
        if ((call.name === "source.search" || call.name === "web.search") && result.ok && retrievedSourceCount < 2) {
          const output = result.output && typeof result.output === "object" ? result.output as { results?: unknown } : {};
          const candidates = Array.isArray(output.results)
            ? output.results.flatMap((entry): string[] => Boolean(entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string" && /^https?:\/\//i.test((entry as { url: string }).url)) ? [(entry as { url: string }).url] : [])
            : [];
          for (const url of [...new Set(candidates)].slice(0, 2 - retrievedSourceCount)) {
            // Search results are candidates, not evidence. Retrieve only two
            // top results per lane: enough for independent source coverage
            // without allowing a search call to flood context.
            calls.push({ name: "source.retrieve", arguments: { url } });
            retrievedSourceCount += 1;
          }
        }
      }
    }
    let provider = laneRoute.provider;
    let model = laneRoute.model;
    let parsed: z.infer<typeof ResearchLaneReportSchema> | undefined;
    let lastError: unknown;
    const attemptedRoutes = new Set<string>();
    for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
      if (options.isCancelled?.()) throw new Error("Interrupted · research lane cancelled.");
      attemptedRoutes.add(laneRouteKey({ provider, model }));
      try {
        const bounded = boundResearchContext({ ...context, laneToolResults: toolResults });
        const result = await runWithLocalFallback({ role, objective: lanePrompt(role, objective), context: bounded.context, outputSchema: RESEARCH_LANE_OUTPUT_SCHEMA }, {
          provider,
          model,
          limitPolicy: options.limitPolicy,
          reasoningEffort: options.reasoningEffort,
          networkAccessEnabled: options.networkAccessEnabled ?? true,
          webSearchMode: options.webSearchMode ?? "live",
          timeoutMs: options.timeoutMs,
          cwd: options.cwd,
          sandbox: "read-only",
          onActivity: options.onActivity,
          onAssistant: options.onAssistant,
        }, provider === "codex" ? options.fallbackLocalModel : undefined, options.onProgress, options.onProcess);
        options.onUsage?.(result.usage, result.provider, result.model ?? model, role);
        parsed = { ...ResearchLaneReportSchema.parse(parseJson(result.output)), provider: result.provider, model: result.model ?? model };
      } catch (error) {
        lastError = error;
        if (options.isCancelled?.()) throw error;
        if (!isRetryableAgentError(error) || attempt === 3 || (isProviderUsageLimit(error) && options.limitPolicy === "wait")) throw error;
        if (attempt === 1 && provider === "codex" && options.fallbackLocalModel && (options.limitPolicy === "fallback" || options.limitPolicy === "auto") && isProviderUsageLimit(error)) {
          model = await resolveLocalFallbackModel(options.fallbackLocalModel);
          provider = "local";
          options.onProgress?.(`Research lane · ${role} · changing route to local/${model}...`);
        } else {
          const alternate = alternateResearchLaneRoute({ provider, model }, options.modelPool, attemptedRoutes);
          if (alternate) {
            provider = alternate.provider;
            model = alternate.model;
            options.onProgress?.(`Research lane · ${role} · changing route to ${provider}/${model}...`);
            continue;
          }
          // If no untried route exists, retain the bounded same-route retry.
          // This is useful for transient transport failures and avoids
          // fabricating diversity when the configured pool has one member.
          const delayMs = attempt * 1_000;
          options.onProgress?.(`Research lane · ${role} · retry ${attempt}/2 in ${delayMs / 1000}s...`);
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    if (!parsed) throw lastError instanceof Error ? lastError : new Error("Lane did not produce a validated report.");
    const report: ResearchLaneReport = { ...parsed, role, status: "completed", ...(options.executeTool ? { toolResults } : {}) };
    saveLaneEvent(options.storePath, role, report);
    const completed = new ResearchStore(options.storePath);
    completed.updateAgentLane({ role, status: "idle", provider: report.provider ?? options.provider, model: report.model ?? options.model, task: null, error: null });
    completed.close();
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: ResearchLaneReport = { role, summary: "Lane failed before producing a validated report.", findings: [], recommendations: [], uncertainties: [message], discriminatingTests: [], evidence: [], evidenceSourceIds: [], confidence: 0, status: "failed", error: message };
    saveLaneEvent(options.storePath, role, report);
    const failed = new ResearchStore(options.storePath);
    failed.updateAgentLane({ role, status: "failed", provider: laneRoute.provider, model: laneRoute.model, task: objective, error: message });
    failed.close();
    return report;
  }
}

/** Run independent research lanes with an explicit concurrency bound. */
export async function runResearchLanes(objective: string, context: Record<string, unknown>, options: ResearchLanesOptions): Promise<ResearchLaneReport[]> {
  // A Codex pool may become local after entitlement exhaustion. Size the
  // initial pool for the most constrained route that can actually serve it,
  // otherwise several lanes can switch to one Ollama process at once.
  const mayUseLocalFallback = options.provider === "local"
    || Boolean(options.fallbackLocalModel && (options.limitPolicy === "auto" || options.limitPolicy === "fallback"));
  const concurrency = researchLaneConcurrency({ autonomy: options.autonomy, provider: mayUseLocalFallback ? "local" : options.provider, requested: options.maxParallel });
  const teamSize = researchLaneTeamSize(objective, concurrency, options);
  const roles = selectResearchLaneRoles(objective, teamSize, { focus: options.laneFocus, rotation: options.laneRotation });
  const routes = assignResearchLaneRoutes(roles, options);
  const reports: ResearchLaneReport[] = [];
  // Run bounded waves. A wave remains parallel, while the next wave receives
  // the prior wave's compact board. This gives agents a real communication
  // boundary without sharing mutable workspaces or allowing an unbounded
  // transcript to leak into every prompt.
  for (let offset = 0; offset < roles.length; offset += concurrency) {
    const wave = roles.slice(offset, offset + concurrency);
    const peerLaneBoard = laneHandoffBoard(reports);
    const waveReports = await Promise.all(wave.map((role) => runLane(
      role,
      objective,
      { ...context, ...(peerLaneBoard.length ? { peerLaneBoard } : {}) },
      options,
      routes.find((route) => route.role === role)!,
    )));
    reports.push(...waveReports);
    if (offset + wave.length < roles.length && waveReports.length) {
      const handoffStore = new ResearchStore(options.storePath);
      handoffStore.appendEvent("research.lane.handoff", {
        objective,
        fromRoles: waveReports.map((report) => report.role),
        toRoles: roles.slice(offset + wave.length),
        board: laneHandoffBoard(reports),
        boundary: "completed-wave",
      });
      handoffStore.close();
    }
  }
  return roles.map((role) => reports.find((report) => report.role === role)!).filter(Boolean);
}
