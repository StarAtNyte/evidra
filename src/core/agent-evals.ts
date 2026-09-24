export type AgentRoleReview = {
  role: string;
  assignments: number;
  completed: number;
  failed: number;
  confidence: number;
  evidenceAnchors: number;
  processPasses: number;
  processWarnings: number;
  processFailures: number;
  score: number;
  recommendation: "trusted" | "needs-review" | "insufficient-data";
};

type Trajectory = { payload: unknown; quality: unknown };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Produce a bounded role review from observed lane reports. This is a process
 * review, not a claim that one lane caused the task metric; attribution stays
 * conservative and only uses durable lane evidence and trajectory quality.
 */
export function evaluateAgentRoles(trajectories: Trajectory[]): AgentRoleReview[] {
  const buckets = new Map<string, { assignments: number; completed: number; failed: number; confidence: number; evidenceAnchors: number; processPasses: number; processWarnings: number; processFailures: number }>();
  for (const trajectory of trajectories.slice(-128)) {
    const payload = object(trajectory.payload);
    const quality = object(trajectory.quality);
    const overall = typeof quality.overall === "string" ? quality.overall : "NOT_EVALUATED";
    const reports = Array.isArray(payload.laneReports) ? payload.laneReports : [];
    for (const raw of reports) {
      const report = object(raw);
      const role = typeof report.role === "string" && report.role.trim() ? report.role.trim() : "unknown";
      const bucket = buckets.get(role) ?? { assignments: 0, completed: 0, failed: 0, confidence: 0, evidenceAnchors: 0, processPasses: 0, processWarnings: 0, processFailures: 0 };
      bucket.assignments += 1;
      if (report.status === "failed") bucket.failed += 1;
      else bucket.completed += 1;
      if (typeof report.confidence === "number" && Number.isFinite(report.confidence)) bucket.confidence += Math.max(0, Math.min(1, report.confidence));
      const evidence = Array.isArray(report.verifiedEvidenceIds) ? report.verifiedEvidenceIds : Array.isArray(report.evidence) ? report.evidence : [];
      bucket.evidenceAnchors += evidence.filter((item) => typeof item === "string" && item.trim()).length;
      if (overall === "PASS") bucket.processPasses += 1;
      else if (overall === "FAIL") bucket.processFailures += 1;
      else if (overall === "WARN") bucket.processWarnings += 1;
      buckets.set(role, bucket);
    }
  }
  return [...buckets.entries()].map(([role, bucket]) => {
    const completionRate = bucket.assignments ? bucket.completed / bucket.assignments : 0;
    const confidence = bucket.assignments ? bucket.confidence / bucket.assignments : 0;
    const evidenceRate = bucket.assignments ? Math.min(1, bucket.evidenceAnchors / (bucket.assignments * 2)) : 0;
    const processRate = bucket.assignments ? (bucket.processPasses + bucket.processWarnings * 0.5) / bucket.assignments : 0;
    const score = Math.round((completionRate * 0.3 + confidence * 0.2 + evidenceRate * 0.2 + processRate * 0.3) * 1000) / 1000;
    return {
      role,
      ...bucket,
      confidence: Math.round(confidence * 1000) / 1000,
      score,
      recommendation: bucket.assignments < 2 ? "insufficient-data" : score >= 0.7 && bucket.processFailures === 0 ? "trusted" : "needs-review",
    } satisfies AgentRoleReview;
  }).sort((left, right) => right.score - left.score || left.role.localeCompare(right.role));
}
