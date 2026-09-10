export interface LaneFinding {
  role?: string;
  summary?: string;
  findings?: string[];
  recommendations?: string[];
  uncertainties?: string[];
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
  const tensions = completed.flatMap((report) => (report.uncertainties ?? []).map((uncertainty) => `${report.role ?? "lane"}: ${uncertainty}`));
  const evidence = completed.flatMap((report) => report.evidence ?? []).slice(0, 18);
  const familyCoverage = completed.map((report) => report.role ?? "unknown").filter((role, index, values) => values.indexOf(role) === index);
  const independentEvidenceCount = unique(completed.flatMap((report) => report.evidence ?? [])).length;
  const agreementPairs = agreementScores.length;
  const agreementStrength = agreementPairs ? agreementScores.reduce((sum, score) => sum + score, 0) / agreementPairs : 0;
  const needsAdversarialReview = completed.length < 2 || tensions.length > 0 || independentEvidenceCount < completed.length || agreementStrength < 0.6;
  return {
    laneCount: reports.length,
    completedCount: completed.length,
    agreements: unique(agreements).slice(0, 8),
    tensions: unique(tensions).slice(0, 8),
    complementaryRecommendations: dedupeRecommendations(recommendations).slice(0, 12),
    evidence: unique(evidence).slice(0, 18),
    familyCoverage,
    agreementPairs,
    independentEvidenceCount,
    agreementStrength,
    needsAdversarialReview,
  };
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
}

function sharedTerms(left: string, right: string): string[] {
  const rightWords = words(right);
  return [...words(left)].filter((word) => rightWords.has(word));
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
