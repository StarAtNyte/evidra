export interface LaneFinding {
  role?: string;
  summary?: string;
  findings?: string[];
  recommendations?: string[];
  uncertainties?: string[];
  discriminatingTests?: string[];
  evidence?: string[];
  confidence?: number;
  status?: string;
}

export interface CrossPollinationBoard {
  laneCount: number;
  completedCount: number;
  agreements: string[];
  tensions: string[];
  complementaryRecommendations: string[];
  /** Concrete tests proposed by lanes to resolve disagreement or uncertainty. */
  discriminatingTests: string[];
  transferCandidates: Array<{
    recommendation: string;
    sourceRoles: string[];
    evidence: string[];
    independentSupport: number;
    confidence: number;
  }>;
  evidence: string[];
  familyCoverage: string[];
  agreementPairs: number;
  independentEvidenceCount: number;
  agreementStrength: number;
  needsAdversarialReview: boolean;
}

/**
 * Compress independent lane reports into a bounded hand-off for the director.
 * Agreement is only reported when multiple lanes share meaningful terms; this
 * avoids turning one agent's repeated wording into fake consensus.
 */
export function synthesizeLaneReports(reports: LaneFinding[]): CrossPollinationBoard {
  const completed = reports.filter((report) => report.status !== "failed");
  const findings = completed.flatMap((report) => (report.findings ?? []).map((finding) => ({ finding, role: report.role ?? "lane", confidence: report.confidence ?? 0.5, evidenceCount: (report.evidence ?? []).length })));
  const agreements: string[] = [];
  const agreementScores: number[] = [];
  for (let index = 0; index < findings.length; index += 1) {
    for (let other = index + 1; other < findings.length; other += 1) {
      if (findings[index].role === findings[other].role) continue;
      const overlap = sharedTerms(findings[index].finding, findings[other].finding);
      if (overlap.length >= 2) {
        agreements.push(`${findings[index].finding} ↔ ${findings[other].finding} (shared: ${overlap.slice(0, 4).join(", ")})`);
        const confidence = Math.min(findings[index].confidence, findings[other].confidence);
        const evidenceFactor = findings[index].evidenceCount > 0 && findings[other].evidenceCount > 0 ? 1 : 0.5;
        agreementScores.push(Math.max(0, Math.min(1, confidence * evidenceFactor)));
      }
    }
  }
  const recommendations = completed.flatMap((report) => (report.recommendations ?? []).map((recommendation) => `${report.role ?? "lane"}: ${recommendation}`));
  const recommendationGroups: Array<{ recommendation: string; roles: Set<string>; evidence: Set<string>; roleEvidence: Map<string, Set<string>>; confidence: number[]; terms: Set<string> }> = [];
  for (const report of completed) {
    for (const recommendation of report.recommendations ?? []) {
      const normalized = recommendation.trim().toLowerCase().replace(/\s+/g, " ");
      if (!normalized) continue;
      const terms = words(recommendation);
      // Exact matches remain the strongest signal. Otherwise require two
      // discriminative shared terms before merging independently worded
      // recommendations; one shared domain word is too easy to manufacture.
      const group = recommendationGroups.find((candidate) => candidate.recommendation.trim().toLowerCase().replace(/\s+/g, " ") === normalized || intersectionSize(candidate.terms, terms) >= 2);
      const role = report.role ?? "lane";
      const target = group ?? { recommendation, roles: new Set<string>(), evidence: new Set<string>(), roleEvidence: new Map<string, Set<string>>(), confidence: [], terms };
      target.roles.add(role);
      const roleEvidence = target.roleEvidence.get(role) ?? new Set<string>();
      for (const item of report.evidence ?? []) { target.evidence.add(item); roleEvidence.add(item); }
      target.roleEvidence.set(role, roleEvidence);
      target.confidence.push(report.confidence ?? 0.5);
      if (!group) recommendationGroups.push(target);
    }
  }
  const transferCandidates = recommendationGroups
    .map((group) => {
      // Distinct prose is not independent corroboration. Count distinct
      // role-level evidence signatures, so lanes citing the same baseline or
      // source cannot inflate support; a lane with one additional anchor is
      // still distinguishable from a lane with only the shared anchor.
      const evidenceSignatures = new Set([...group.roles].map((role) => [...(group.roleEvidence.get(role) ?? [])].sort().join("\u001f")));
      const independentSupport = group.evidence.size ? evidenceSignatures.size : 0;
      return {
        recommendation: group.recommendation,
        sourceRoles: [...group.roles].sort(),
        evidence: [...group.evidence].slice(0, 6),
        independentSupport,
        confidence: group.confidence.length ? group.confidence.reduce((sum, value) => sum + value, 0) / group.confidence.length : 0,
      };
    })
    .sort((left, right) => right.independentSupport - left.independentSupport || right.evidence.length - left.evidence.length || right.confidence - left.confidence || left.recommendation.localeCompare(right.recommendation))
    .slice(0, 8);
  const tensions = completed.flatMap((report) => (report.uncertainties ?? []).map((uncertainty) => `${report.role ?? "lane"}: ${uncertainty}`));
  const discriminatingTests = unique(completed.flatMap((report) => report.discriminatingTests ?? [])).slice(0, 12);
  const evidence = completed.flatMap((report) => report.evidence ?? []).slice(0, 18);
  const familyCoverage = completed.map((report) => report.role ?? "unknown").filter((role, index, values) => values.indexOf(role) === index);
  const independentEvidenceCount = unique(completed.flatMap((report) => report.evidence ?? [])).length;
  const agreementPairs = agreementScores.length;
  const agreementStrength = agreementPairs ? agreementScores.reduce((sum, score) => sum + score, 0) / agreementPairs : 0;
  const needsAdversarialReview = completed.length < 2 || tensions.length > 0 || independentEvidenceCount < completed.length || agreementStrength < 0.6 || (tensions.length > 0 && discriminatingTests.length === 0);
  return {
    laneCount: reports.length,
    completedCount: completed.length,
    agreements: unique(agreements).slice(0, 8),
    tensions: unique(tensions).slice(0, 8),
    complementaryRecommendations: [...recommendationGroups].map((group) => group.recommendation).slice(0, 12),
    discriminatingTests,
    transferCandidates,
    evidence: unique(evidence).slice(0, 18),
    familyCoverage,
    agreementPairs,
    independentEvidenceCount,
    agreementStrength,
    needsAdversarialReview,
  };
}

const NON_DISCRIMINATIVE_TERMS = new Set([
  "about", "after", "also", "approach", "based", "better", "change", "code", "data", "different", "does", "each", "error", "experiment", "find", "from", "good", "issue", "method", "model", "more", "need", "only", "result", "score", "should", "show", "task", "test", "their", "these", "this", "through", "under", "using", "with",
]);

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !NON_DISCRIMINATIVE_TERMS.has(word)));
}

function sharedTerms(left: string, right: string): string[] {
  const rightWords = words(right);
  return [...words(left)].filter((word) => rightWords.has(word));
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let size = 0;
  for (const term of left) if (right.has(term)) size += 1;
  return size;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeRecommendations(values: string[]): string[] {
  const byAction = new Map<string, string>();
  for (const value of values) {
    const action = value.includes(":") ? value.slice(value.indexOf(":") + 1).trim().toLowerCase() : value.toLowerCase();
    if (!byAction.has(action)) byAction.set(action, value);
  }
  return [...byAction.values()];
}
