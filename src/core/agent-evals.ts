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
  playbookPasses: number;
  playbookPartials: number;
  playbookBlocks: number;
  playbookRate: number;
  score: number;
  recommendation: "trusted" | "needs-review" | "insufficient-data";
};

export type AgentRoleIntervention = {
  role: string;
  action: "preserve" | "coach" | "observe";
  priority: "normal" | "high";
  reason: string;
};

type Trajectory = { payload: unknown; quality: unknown };
type ReviewBucket = {
  assignments: number;
  completed: number;
  failed: number;
  confidence: number;
  evidenceAnchors: number;
  processPasses: number;
  processWarnings: number;
  processFailures: number;
  playbookPasses: number;
  playbookPartials: number;
  playbookBlocks: number;
  weightedAssignments: number;
  weightedCompleted: number;
  weightedConfidence: number;
  weightedEvidenceAnchors: number;
  weightedProcessPasses: number;
  weightedProcessWarnings: number;
  weightedPlaybookPasses: number;
  weightedPlaybookPartials: number;
  weightedPlaybookBlocks: number;
  recentProcessFailures: number;
  recentPlaybookBlocks: number;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Produce a bounded role review from observed lane reports. This is a process
 * review, not a claim that one lane caused the task metric; attribution stays
 * conservative and only uses durable lane evidence and trajectory quality.
 */
export function evaluateAgentRoles(trajectories: Trajectory[]): AgentRoleReview[] {
  const selected = trajectories.slice(-128);
  const recentCutoff = Math.max(0, selected.length - 16);
  const buckets = new Map<string, ReviewBucket>();
  for (const [index, trajectory] of selected.entries()) {
    // Durable history is chronological. A bounded exponential decay makes
    // current behavior matter more without erasing historical counts or the
    // hard evidence gate below.
    const recencyWeight = Math.pow(0.96, selected.length - 1 - index);
    const payload = object(trajectory.payload);
    const quality = object(trajectory.quality);
    const overall = typeof quality.overall === "string" ? quality.overall : "NOT_EVALUATED";
    const reports = Array.isArray(payload.laneReports) ? payload.laneReports : [];
    for (const raw of reports) {
      const report = object(raw);
      const role = typeof report.role === "string" && report.role.trim() ? report.role.trim() : "unknown";
      const bucket = buckets.get(role) ?? { assignments: 0, completed: 0, failed: 0, confidence: 0, evidenceAnchors: 0, processPasses: 0, processWarnings: 0, processFailures: 0, playbookPasses: 0, playbookPartials: 0, playbookBlocks: 0, weightedAssignments: 0, weightedCompleted: 0, weightedConfidence: 0, weightedEvidenceAnchors: 0, weightedProcessPasses: 0, weightedProcessWarnings: 0, weightedPlaybookPasses: 0, weightedPlaybookPartials: 0, weightedPlaybookBlocks: 0, recentProcessFailures: 0, recentPlaybookBlocks: 0 };
      bucket.assignments += 1;
      if (report.status === "failed") bucket.failed += 1;
      else bucket.completed += 1;
      if (typeof report.confidence === "number" && Number.isFinite(report.confidence)) bucket.confidence += Math.max(0, Math.min(1, report.confidence));
      const evidence = Array.isArray(report.verifiedEvidenceIds) ? report.verifiedEvidenceIds : Array.isArray(report.evidence) ? report.evidence : [];
      bucket.evidenceAnchors += evidence.filter((item) => typeof item === "string" && item.trim()).length;
      const checks = Array.isArray(report.playbookChecks) ? report.playbookChecks : [];
      for (const check of checks) {
        const status = object(check).status;
        if (status === "pass") bucket.playbookPasses += 1;
        else if (status === "partial") bucket.playbookPartials += 1;
        else if (status === "blocked") bucket.playbookBlocks += 1;
      }
      if (overall === "PASS") bucket.processPasses += 1;
      else if (overall === "FAIL") bucket.processFailures += 1;
      else if (overall === "WARN") bucket.processWarnings += 1;
      if (index >= recentCutoff && overall === "FAIL") bucket.recentProcessFailures += 1;
      bucket.weightedAssignments += recencyWeight;
      bucket.weightedCompleted += report.status === "failed" ? 0 : recencyWeight;
      bucket.weightedConfidence += (typeof report.confidence === "number" && Number.isFinite(report.confidence) ? Math.max(0, Math.min(1, report.confidence)) : 0) * recencyWeight;
      bucket.weightedEvidenceAnchors += evidence.filter((item) => typeof item === "string" && item.trim()).length * recencyWeight;
      bucket.weightedProcessPasses += overall === "PASS" ? recencyWeight : 0;
      bucket.weightedProcessWarnings += overall === "WARN" ? recencyWeight : 0;
      for (const check of checks) {
        const status = object(check).status;
        if (status === "pass") bucket.weightedPlaybookPasses += recencyWeight;
        else if (status === "partial") bucket.weightedPlaybookPartials += recencyWeight;
        else if (status === "blocked") bucket.weightedPlaybookBlocks += recencyWeight;
        if (index >= recentCutoff && status === "blocked") bucket.recentPlaybookBlocks += 1;
      }
      buckets.set(role, bucket);
    }
  }
  return [...buckets.entries()].map(([role, bucket]) => {
    const completionRate = bucket.weightedAssignments ? bucket.weightedCompleted / bucket.weightedAssignments : 0;
    const confidence = bucket.weightedAssignments ? bucket.weightedConfidence / bucket.weightedAssignments : 0;
    const evidenceRate = bucket.weightedAssignments ? Math.min(1, bucket.weightedEvidenceAnchors / (bucket.weightedAssignments * 2)) : 0;
    const processRate = bucket.weightedAssignments ? (bucket.weightedProcessPasses + bucket.weightedProcessWarnings * 0.5) / bucket.weightedAssignments : 0;
    const playbookChecks = bucket.playbookPasses + bucket.playbookPartials + bucket.playbookBlocks;
    const weightedPlaybookChecks = bucket.weightedPlaybookPasses + bucket.weightedPlaybookPartials + bucket.weightedPlaybookBlocks;
    const playbookRate = playbookChecks && weightedPlaybookChecks ? (bucket.weightedPlaybookPasses + bucket.weightedPlaybookPartials * 0.5) / weightedPlaybookChecks : 1;
    const score = Math.round((completionRate * 0.25 + confidence * 0.15 + evidenceRate * 0.2 + processRate * 0.25 + playbookRate * 0.15) * 1000) / 1000;
    return {
      role,
      assignments: bucket.assignments,
      completed: bucket.completed,
      failed: bucket.failed,
      evidenceAnchors: bucket.evidenceAnchors,
      processPasses: bucket.processPasses,
      processWarnings: bucket.processWarnings,
      processFailures: bucket.processFailures,
      playbookPasses: bucket.playbookPasses,
      playbookPartials: bucket.playbookPartials,
      playbookBlocks: bucket.playbookBlocks,
      confidence: Math.round(confidence * 1000) / 1000,
      playbookRate: Math.round(playbookRate * 1000) / 1000,
      score,
      // A role cannot become trusted from self-reported process quality alone:
      // at least one durable evidence anchor per assignment is required.
      recommendation: bucket.assignments < 2 ? "insufficient-data" : score >= 0.7 && bucket.evidenceAnchors >= bucket.assignments && bucket.recentProcessFailures === 0 && bucket.recentPlaybookBlocks === 0 ? "trusted" : "needs-review",
    } satisfies AgentRoleReview;
  }).sort((left, right) => right.score - left.score || left.role.localeCompare(right.role));
}

/** Turn a review into a bounded controller action; this is policy, not metric attribution. */
export function agentRoleInterventions(reviews: readonly AgentRoleReview[]): AgentRoleIntervention[] {
  return reviews.map((review) => review.recommendation === "trusted"
    ? { role: review.role, action: "preserve", priority: "normal", reason: "recent role evidence meets completion, evidence, process, and playbook gates" }
    : review.recommendation === "needs-review"
      ? { role: review.role, action: "coach", priority: "high", reason: `${review.playbookBlocks} blocked playbook step(s), ${review.processFailures} process failure(s), and score ${(review.score * 100).toFixed(0)}% require a changed route` }
      : { role: review.role, action: "observe", priority: "normal", reason: "not enough durable assignments to change role allocation" });
}

/** Convert a coaching finding into a bounded, role-scoped instruction. */
export function agentCoachingDirective(intervention: AgentRoleIntervention): string {
  return `Coaching intervention: ${intervention.reason}. Change the route, ground material findings in durable observations, and state a falsification test.`;
}
