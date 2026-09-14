import { z } from "zod";
import { cpus, totalmem } from "node:os";
import { ResearchStore } from "../core/store.js";
import type { AgentProvider, ExecAgentOptions } from "./codex-exec.js";
import { isProviderUsageLimit, isRetryableAgentError, resolveLocalFallbackModel, runWithLocalFallback } from "./codex-exec.js";
import type { ProcessControl } from "../core/process.js";
import type { AutonomyLevel } from "../core/permissions.js";
import type { ResearchToolCall, ResearchToolResult } from "../core/tools.js";
import { boundResearchContext } from "../core/context-budget.js";

export const RESEARCH_LANE_ROLES = [
  "data detective",
  "validation scientist",
  "model researcher",
] as const;

export const GENERAL_RESEARCH_LANE_ROLES = [
  "domain researcher",
  "validation scientist",
  "method researcher",
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
  evidence: z.array(z.string()).max(12),
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
  timeoutMs?: number;
  cwd: string;
  storePath: string;
  maxParallel?: number;
  autonomy?: AutonomyLevel;
  onProgress?: (message: string) => void;
  onProcess?: (control: ProcessControl) => void;
  isCancelled?: () => boolean;
  executeTool?: (call: ResearchToolCall) => Promise<ResearchToolResult>;
  onToolCall?: (source: string, call: ResearchToolCall) => string;
  onToolResult?: (source: string, callId: string, result: ResearchToolResult) => void;
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

/** Keep lane observations bounded and role-specific before model synthesis. */
export function laneToolCalls(role: ResearchLaneRole, objective = ""): ResearchToolCall[] {
  const focus = role === "data detective"
    ? "duplicate|leak|missing|shift|group|target|label"
    : role === "validation scientist"
      ? "split|fold|valid|metric|evaluator|seed|test"
      : role === "model researcher"
        ? "train|model|estimator|baseline|experiment|config"
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
  if (role === "domain researcher" || role === "method researcher") {
    const literatureQuery = objective.trim().slice(0, 600) || `${role} methods and evidence`;
    calls.push({ name: "source.search", arguments: { query: literatureQuery, limit: 6 } });
  }
  return calls;
}

/** Choose an appropriate research team without assuming every task is ML. */
export function selectResearchLaneRoles(objective: string, requested: number): ResearchLaneRole[] {
  const mlOrCompetition = /\b(dataset|training|train|model|estimator|competition|leaderboard|metric|fold|gpu|prediction|baseline)\b/i.test(objective);
  const pool = mlOrCompetition ? RESEARCH_LANE_ROLES : GENERAL_RESEARCH_LANE_ROLES;
  return pool.slice(0, Math.max(1, Math.min(requested, pool.length)));
}

const MAX_LANE_TOOL_RESULT_BYTES = 12_000;

export function boundLaneToolResult(result: ResearchToolResult): ResearchToolResult {
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
        : role === "domain researcher"
          ? "Investigate the domain, definitions, assumptions, relevant literature, competing explanations, and unresolved questions."
          : "Investigate alternative methods, mechanisms, procedures, and implementation paths; propose falsifiable comparisons.";
  return `${focus}\n\nObjective: ${objective}\n\n` +
    "You are an independent Evidra research lane. Use the supplied workspace and evidence context; run only read-only inspection when tools are available. Do not edit files, submit anything, or claim measurements you did not observe. Return ONLY JSON with this shape: " +
    '{"role":"...","summary":"...","findings":["..."],"recommendations":["..."],"uncertainties":["..."],"evidence":["command, artifact, or source supporting each important statement"],"confidence":0.0}. ' +
    "Recommendations must be testable and should state what would falsify them. A bounded prior-peer board may be present in the context: use it to challenge, extend, or explicitly reject earlier findings, but never treat it as stronger than primary evidence.";
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
        uncertainties: Array.isArray(report.uncertainties) ? report.uncertainties.slice(0, 3) : [],
        evidence: Array.isArray(report.evidence) ? report.evidence.slice(0, 5) : [],
      };
    })
    .slice(-Math.max(1, Math.min(limit, 8)));
}

function saveLaneEvent(storePath: string, role: string, report: ResearchLaneReport): void {
  const store = new ResearchStore(storePath);
  store.appendEvent(report.status === "completed" ? "research.lane.completed" : "research.lane.failed", { role, report });
  if (report.status === "completed") {
    const claimId = `claim_lane_${Date.now()}_${role.replace(/[^a-z0-9]+/gi, "-")}`;
    store.saveClaim({
      id: claimId,
      payload: {
        id: claimId,
        statement: `[${role}] ${report.summary}`,
        scope: "research lane report",
        confidence: report.confidence,
        sourceType: "observation",
        sourceId: `lane_${role}`,
        status: "active",
        findings: report.findings,
        evidence: report.evidence,
      },
    });
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
    const result = await runWithLocalFallback({ role: "critic", objective: prompt, context: { decision, laneReports } }, {
      provider: options.provider,
      model: options.model,
      limitPolicy: options.limitPolicy,
      reasoningEffort: options.reasoningEffort,
      cwd: options.cwd,
      sandbox: "read-only",
    }, options.provider === "codex" ? options.fallbackLocalModel : undefined, options.onProgress, options.onProcess);
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
    completed.appendEvent("research.critic.completed", { review, objective });
    const claimId = `claim_critic_${Date.now()}`;
    completed.saveClaim({ id: claimId, payload: { id: claimId, statement: `[critic:${review.verdict}] ${review.summary}`, scope: "research decision review", confidence: review.confidence, sourceType: "review", sourceId: claimId, status: "active", objections: review.objections, requiredChecks: review.requiredChecks, evidence: review.evidence } });
    completed.updateAgentLane({ role: "critic", status: "idle", provider: options.provider, model: options.model, task: null, error: null });
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

async function runLane(role: ResearchLaneRole, objective: string, context: Record<string, unknown>, options: ResearchLanesOptions, laneRoute: ResearchLaneRoute): Promise<ResearchLaneReport> {
  const store = new ResearchStore(options.storePath);
  store.updateAgentLane({ role, status: "running", provider: laneRoute.provider, model: laneRoute.model, task: objective, error: null });
  store.close();
  options.onProgress?.(`Research lane · ${role} · investigating...`);
  try {
    const toolResults: ResearchToolResult[] = [];
    if (options.executeTool) {
      for (const call of laneToolCalls(role, objective)) {
        if (options.isCancelled?.()) throw new Error("Interrupted · research lane cancelled.");
        options.onProgress?.(`Research lane · ${role} · ${call.name}...`);
        const callId = options.onToolCall?.(`lane:${role}`, call) ?? `${role}-${call.name}-${toolResults.length + 1}`;
        let result: ResearchToolResult = { name: call.name, ok: false, error: "Tool did not return a result." };
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            result = boundLaneToolResult(await options.executeTool(call));
          } catch (error) {
            result = { name: call.name, ok: false, error: error instanceof Error ? error.message : String(error) };
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
      }
    }
    let provider = laneRoute.provider;
    let model = laneRoute.model;
    let parsed: z.infer<typeof ResearchLaneReportSchema> | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
      if (options.isCancelled?.()) throw new Error("Interrupted · research lane cancelled.");
      try {
        const bounded = boundResearchContext({ ...context, laneToolResults: toolResults });
        const result = await runWithLocalFallback({ role, objective: lanePrompt(role, objective), context: bounded.context }, {
          provider,
          model,
          limitPolicy: options.limitPolicy,
          reasoningEffort: options.reasoningEffort,
          timeoutMs: options.timeoutMs,
          cwd: options.cwd,
          sandbox: "read-only",
        }, provider === "codex" ? options.fallbackLocalModel : undefined, options.onProgress, options.onProcess);
        parsed = { ...ResearchLaneReportSchema.parse(parseJson(result.output)), provider: result.provider, model: result.model ?? model };
      } catch (error) {
        lastError = error;
        if (options.isCancelled?.()) throw error;
        if (!isRetryableAgentError(error) || attempt === 3 || (isProviderUsageLimit(error) && options.limitPolicy === "wait")) throw error;
        // A network/SDK failure is not evidence that a local model is healthy.
        // Only provider-entitlement exhaustion may switch routes; the fallback
        // helper handles that path and validates local availability. Blindly
        // switching on every retryable error can turn one Codex outage into
        // several opaque Ollama failures and poison the whole campaign.
        if (attempt === 1 && provider === "codex" && options.fallbackLocalModel && (options.limitPolicy === "fallback" || options.limitPolicy === "auto") && isProviderUsageLimit(error)) {
          model = await resolveLocalFallbackModel(options.fallbackLocalModel);
          provider = "local";
          options.onProgress?.(`Research lane · ${role} · changing route to local/${model}...`);
        } else {
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
    const report: ResearchLaneReport = { role, summary: "Lane failed before producing a validated report.", findings: [], recommendations: [], uncertainties: [message], evidence: [], confidence: 0, status: "failed", error: message };
    saveLaneEvent(options.storePath, role, report);
    const failed = new ResearchStore(options.storePath);
    failed.updateAgentLane({ role, status: "failed", provider: laneRoute.provider, model: laneRoute.model, task: objective, error: message });
    failed.close();
    return report;
  }
}

/** Run independent research lanes with an explicit concurrency bound. */
export async function runResearchLanes(objective: string, context: Record<string, unknown>, options: ResearchLanesOptions): Promise<ResearchLaneReport[]> {
  const concurrency = researchLaneConcurrency({ autonomy: options.autonomy, provider: options.provider, requested: options.maxParallel });
  const roles = selectResearchLaneRoles(objective, concurrency);
  const routes = assignResearchLaneRoutes(roles, options);
  const reports: ResearchLaneReport[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < roles.length) {
      const role = roles[next++];
      reports.push(await runLane(role, objective, context, options, routes.find((route) => route.role === role)!));
    }
  };
  await Promise.all(Array.from({ length: Math.min(roles.length, concurrency) }, () => worker()));
  return roles.map((role) => reports.find((report) => report.role === role)!).filter(Boolean);
}
