import type { AutonomyLevel } from "./permissions.js";

export type CapabilityTier = "C0" | "C1" | "C2" | "C3";

export interface CapabilityRouteInput {
  objective: string;
  mode: "research" | "challenge";
  provider: "codex" | "local";
  autonomy: AutonomyLevel;
  recentFailureCount?: number;
  /** Quality feedback from prior trajectories; this is the harness feedback signal. */
  recentQuality?: Array<{ overall?: string; gaps?: string[] }>;
  budgetRemainingMinutes?: number;
  requestedParallel?: number;
}

export interface CapabilityRoute {
  tier: CapabilityTier;
  demandScore: number;
  parallelLanes: number;
  reasoningEffort: "low" | "medium" | "high";
  rationale: string[];
}

export interface CapabilityOutcome {
  schemaVersion: 1;
  objective: string;
  mode: "research" | "challenge";
  predictedTier: CapabilityTier;
  served: { provider: string; model: string; parallelLanes: number };
  outcome: "success" | "partial" | "failure";
  quality: string;
  gaps: string[];
}

/** Convert a stored trajectory quality object into routing feedback without treating missing instrumentation as failure. */
export function qualityFeedback(quality: unknown): { overall?: string; gaps: string[] } {
  const record = quality && typeof quality === "object" ? quality as Record<string, unknown> : {};
  const gaps = Object.entries(record)
    .filter(([key, value]) => key !== "overall" && value && typeof value === "object")
    .filter(([, value]) => {
      const dimension = value as { verdict?: unknown; coverage?: unknown };
      return (dimension.verdict === "FAIL" || dimension.verdict === "WARN") && dimension.coverage !== "missing";
    })
    .map(([key]) => key);
  return { overall: typeof record.overall === "string" ? record.overall : undefined, gaps };
}

/** Normalize routing prediction, serving action, and observed outcome. */
export function capabilityOutcome(input: {
  objective: string;
  mode: "research" | "challenge";
  route: CapabilityRoute;
  provider: string;
  model: string;
  quality: unknown;
  parallelLanes: number;
}): CapabilityOutcome {
  const feedback = qualityFeedback(input.quality);
  const quality = feedback.overall ?? "NOT_EVALUATED";
  return {
    schemaVersion: 1,
    objective: input.objective,
    mode: input.mode,
    predictedTier: input.route.tier,
    served: { provider: input.provider, model: input.model, parallelLanes: input.parallelLanes },
    outcome: quality === "PASS" ? "success" : quality === "FAIL" ? "failure" : "partial",
    quality,
    gaps: feedback.gaps,
  };
}

/**
 * Route by observed capability demand, not model identity. The route is a
 * policy recommendation: provider/model selection remains user-controlled,
 * while Evidra can increase verification and reduce unsafe fan-out as demand
 * rises.
 */
export function routeCapability(input: CapabilityRouteInput): CapabilityRoute {
  const text = input.objective.toLowerCase();
  let score = 0;
  const rationale: string[] = [];
  if (input.mode === "challenge") { score += 2; rationale.push("challenge execution requires empirical verification"); }
  if (/(experiment|implement|train|evaluate|benchmark|submit|optimi[sz]|replicat|run)/.test(text)) { score += 2; rationale.push("objective contains execution or evaluation work"); }
  if (/(research|investigat|compare|novel|hypothes|theorem|proof|generaliz)/.test(text)) { score += 1; rationale.push("objective requires open-ended investigation"); }
  if (input.objective.length > 500) { score += 1; rationale.push("long objective has multiple constraints"); }
  if ((input.recentFailureCount ?? 0) > 0) { score += Math.min(2, input.recentFailureCount ?? 0); rationale.push(`${input.recentFailureCount} recent failure(s) require recovery-aware routing`); }
  const quality = input.recentQuality ?? [];
  const failedQuality = quality.filter((item) => item.overall === "FAIL").length;
  const warnedQuality = quality.filter((item) => item.overall === "WARN").length;
  if (failedQuality > 0) { score += Math.min(3, failedQuality); rationale.push(`${failedQuality} prior trajectory failure(s) increase capability demand`); }
  if (warnedQuality > 0) { score += Math.min(2, warnedQuality); rationale.push(`${warnedQuality} prior trajectory warning(s) require stronger verification`); }
  const recurringGaps = new Set(quality.flatMap((item) => item.gaps ?? [])).size;
  if (recurringGaps >= 2) { score += 1; rationale.push(`${recurringGaps} distinct capability gaps were observed in prior trajectories`); }
  if (input.budgetRemainingMinutes !== undefined && input.budgetRemainingMinutes < 10) { score += 1; rationale.push("budget pressure increases the cost of another failed attempt"); }
  if (input.provider === "local") rationale.push("local provider capacity is conservatively bounded");
  const tier: CapabilityTier = score >= 6 ? "C3" : score >= 4 ? "C2" : score >= 2 ? "C1" : "C0";
  const defaultParallel = tier === "C3" ? 1 : tier === "C2" ? 2 : tier === "C1" ? 2 : 1;
  const autonomyCeiling = input.autonomy === "safe" ? 1 : input.autonomy === "fast" ? 2 : 4;
  const parallelLanes = Math.max(1, Math.min(input.requestedParallel ?? defaultParallel, defaultParallel, autonomyCeiling));
  return {
    tier,
    demandScore: score,
    parallelLanes,
    reasoningEffort: tier === "C3" ? "high" : tier === "C2" ? "medium" : "low",
    rationale: rationale.length ? rationale : ["bounded request with no elevated demand signals"],
  };
}
