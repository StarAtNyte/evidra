import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResearchStore } from "./store.js";
import { auditClaims, selfDescribingClaimEvidenceIds } from "./claim-audit.js";
import { redactCommand } from "./redaction.js";
import { researchMemoryContext } from "./research-context.js";
import { sourceFrontier } from "./sources.js";

export type ReportKind = "research" | "challenge" | "final";

function line(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function renderReport(store: ResearchStore, kind: ReportKind): string {
  const project = store.project();
  const counts = store.counts();
  const goals = store.phaseGoals();
  const hypotheses = store.hypotheses();
  const decisions = store.decisions();
  const claims = store.claims();
  const sources = store.sources();
  const sourceFrontierReport = sourceFrontier(store.eventsByTypes([
    "research.source.search.completed",
    "research.web.search.completed",
    "research.source.retrieved",
  ]));
  const experiments = store.experiments();
  const runs = store.runs();
  const attempts = store.runAttempts();
  const artifacts = store.artifacts();
  const trajectories = store.trajectoryHistory();
  const researchMemory = researchMemoryContext(store, 50);
  const ensembles = store.ensembleCandidates(100);
  const events = store.recentEvents(40);
  const eventIntegrity = store.verifyEventChain();
  const harnessBenchmarkEvents = store.eventsByType("harness.benchmark.completed");
  const harnessEvolutionEvents = store.eventsByType("harness.evolution.plan");
  const routingEvents = store.eventsByType("research.capability_outcome");
  const experienceEvents = store.eventsByType("research.experience.recorded");
  const contradictionEdges = store.edges().filter((edge) => edge.relation === "contradicts");
  const duplicateEvents = store.eventsByType("evidence.claim.duplicate_detected");
  const conflictedClaimIds = new Set(contradictionEdges.flatMap((edge) => [edge.fromId, edge.toId]));
  const claimAudit = auditClaims({
    claims: claims.map((claim) => ({ id: claim.id, payload: claim.payload })),
    knownEvidenceIds: new Set([
      ...sources.map((source) => source.id),
      ...decisions.map((decision) => `decision_${decision.id}`),
      ...runs.map((run) => run.id),
      ...artifacts.map((artifact) => artifact.id),
      ...claims.map((claim) => claim.id),
      ...selfDescribingClaimEvidenceIds(claims),
    ]),
    conflictedClaimIds,
  });
  const title = kind === "research" ? "Research report" : kind === "challenge" ? "Challenge report" : "Final provenance report";
  const sections = [
    `# ${title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Project: ${project?.name ?? "not initialized"}`,
    `Competition: ${project?.competitionId ?? "none"}`,
    "",
    "## Counts",
    "",
    Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`).join("\n"),
    "",
    "## State integrity",
    "",
    `Event history: ${eventIntegrity.status.toUpperCase()}`,
    `Checked: ${eventIntegrity.checked} · legacy events: ${eventIntegrity.legacy}${eventIntegrity.brokenAt ? ` · broken at ${eventIntegrity.brokenAt}` : ""}`,
    eventIntegrity.reason ? `Reason: ${eventIntegrity.reason}` : "No event-chain violations detected.",
    eventIntegrity.status === "invalid" ? "This report is not suitable for publication until the state is restored and integrity passes." : "",
    "",
    "## Phase goals",
    "",
    goals.length ? goals.map((goal) => {
      const payload = goal.payload as { title?: string; objective?: string; status?: string; attempts?: number };
      return `- **${goal.phase}** · ${payload.status ?? goal.status} · attempts ${payload.attempts ?? 0}\n  ${payload.title ?? "Untitled"}\n  ${payload.objective ?? ""}`;
    }).join("\n") : "No phase goals recorded.",
  ];
  if (kind !== "challenge") sections.push("", "## Hypotheses", "", hypotheses.length ? hypotheses.map((hypothesis) => `- ${hypothesis.id}: ${line((hypothesis.payload as { title?: string }).title ?? hypothesis.payload)}`).join("\n") : "No hypotheses recorded.");
  sections.push("", "## Learned transfer memory", "", researchMemory.verifiedPlaybooks.length
    ? researchMemory.verifiedPlaybooks.map((playbook) => `- ${playbook.id} · ${playbook.title} · ${playbook.sourceCompetition} → ${playbook.sourceTaskType}\n  steps: ${playbook.steps.join("; ")}\n  evidence: ${playbook.evidenceIds.join(", ")}\n  transfer warning: ${playbook.failureModes.join("; ")}`).join("\n")
    : "No independently replicated playbook leads recorded.",
    researchMemory.failedDirections.length
      ? `\nFailed directions in memory:\n${researchMemory.failedDirections.map((direction) => `- ${direction.id} · ${direction.title} · ${direction.failureClass}: ${direction.reason}`).join("\n")}`
      : "Failed directions in memory: none.");
  sections.push("", "## Decisions", "", decisions.length ? decisions.map((decision) => `- ${decision.id} · ${decision.createdAt}\n  ${line(decision.payload)}`).join("\n") : "No decisions recorded.");
  sections.push("", "## Evidence claims", "", claims.length ? claims.slice(0, 80).map((claim) => `- ${claim.id}: ${line((claim.payload as { statement?: string }).statement ?? claim.payload)}`).join("\n") : "No claims recorded.");
  sections.push("", "## Claim verification audit", "", `Publishable: ${claimAudit.publishable ? "yes" : "no"}\nVerified: ${claimAudit.verified} · provisional: ${claimAudit.provisional} · literature-only: ${claimAudit.literatureOnly} · unsupported: ${claimAudit.unsupported} · conflicted: ${claimAudit.conflicted}`, claimAudit.entries.length ? claimAudit.entries.slice(0, 80).map((entry) => `- ${entry.status.toUpperCase()} ${entry.id} · ${entry.reasons.join("; ")}`).join("\n") : "No claims available for audit.");
  sections.push("", "## Evidence consistency", "", contradictionEdges.length || duplicateEvents.length
    ? [`Contradiction edges: ${contradictionEdges.length}`, ...contradictionEdges.slice(0, 40).map((edge) => `- ${edge.fromId} contradicts ${edge.toId} · review required`), `Duplicate findings in recent events: ${duplicateEvents.length}`].join("\n")
    : "No recorded duplicate or contradiction findings.");
  sections.push("", "## Trajectory quality", "", trajectories.length ? trajectories.map((trajectory) => {
    const quality = trajectory.quality as { overall?: string; [key: string]: unknown };
    const dimensions = Object.entries(quality).filter(([key]) => key !== "overall").map(([key, value]) => `${key}=${(value as { verdict?: string }).verdict ?? "unknown"}`).join(", ");
    return `- ${trajectory.id} · ${quality.overall ?? "unknown"}${trajectory.experimentId ? ` · experiment ${trajectory.experimentId}` : ""}${trajectory.runId ? ` · run ${trajectory.runId}` : ""}\n  ${dimensions}`;
  }).join("\n") : "No evaluated trajectories recorded.");
  sections.push("", "## Capability routing", "", routingEvents.length ? routingEvents.map((event) => {
    const payload = event.payload as { outcome?: string; predictedTier?: string; quality?: string; predictedTierScores?: Record<string, number>; served?: { provider?: string; model?: string; parallelLanes?: number }; servedProvider?: string; servedModel?: string };
    const provider = payload.served?.provider ?? payload.servedProvider ?? "unknown";
    const model = payload.served?.model ?? payload.servedModel ?? "unknown";
    const lanes = payload.served?.parallelLanes;
    const scores = payload.predictedTierScores ? ` · demand ${Object.entries(payload.predictedTierScores).map(([tier, score]) => `${tier}=${score}`).join(" ")}` : "";
    return `- ${event.createdAt} · ${payload.outcome ?? "unknown"} · predicted ${payload.predictedTier ?? "?"} · ${provider}/${model}${lanes ? ` · lanes ${lanes}` : ""} · quality ${payload.quality ?? "?"}${scores}`;
  }).join("\n") : "No capability-routing outcomes recorded.");
  sections.push("", "## Experience curriculum", "", experienceEvents.length ? (() => {
    const latest = experienceEvents.at(-1)?.payload as { capabilityProfile?: { total?: number; eligible?: number; quarantined?: number; byOutcome?: Record<string, number>; gaps?: Record<string, number> }; curriculum?: Array<{ stage: number; trajectoryIds: string[]; rationale: string }> } | undefined;
    const profile = latest?.capabilityProfile;
    const curriculum = latest?.curriculum ?? [];
    return [`Total experiences: ${profile?.total ?? 0} · eligible: ${profile?.eligible ?? 0} · quarantined: ${profile?.quarantined ?? 0}`, `Outcomes: ${Object.entries(profile?.byOutcome ?? {}).map(([key, value]) => `${key}=${value}`).join(" ") || "none"}`, `Gaps: ${Object.entries(profile?.gaps ?? {}).slice(0, 8).map(([key, value]) => `${key}=${value}`).join(" ") || "none"}`, ...curriculum.map((stage) => `- Stage ${stage.stage}: ${stage.trajectoryIds.join(", ") || "none"} · ${stage.rationale}`)].join("\n");
  })() : "No experience curriculum recorded.");
  sections.push("", "## Harness benchmark feedback", "", harnessBenchmarkEvents.length
    ? harnessBenchmarkEvents.slice(-5).map((event) => {
      const payload = event.payload as { challenger?: string; scorecards?: Array<{ harness?: string; competitiveScore?: number; failureProfile?: Record<string, number> }>; comparisons?: Array<{ incumbent?: string; challengerWins?: boolean; reason?: string }>; providerComparison?: { challenger?: string; incumbent?: string; pairedMeanDelta?: number | null; pairedLower95?: number | null; challengerWins?: boolean; reason?: string }; providerGeneralization?: { challengerProvider?: string; incumbentProvider?: string; generalizes?: boolean; reason?: string }; componentFailureEvidence?: Array<{ componentId?: string; samples?: number; failures?: number; failureLift?: number; interpretation?: string }>; changeOutcomes?: Array<{ incumbent?: string; outcome?: { status?: string; observedDelta?: number } }> };
      const scores = (payload.scorecards ?? []).map((scorecard) => `${scorecard.harness ?? "unknown"}=${typeof scorecard.competitiveScore === "number" ? scorecard.competitiveScore.toFixed(1) : "?"}${Object.keys(scorecard.failureProfile ?? {}).length ? ` failures=${JSON.stringify(scorecard.failureProfile)}` : ""}`).join(", ");
      const comparisons = (payload.comparisons ?? []).map((comparison) => `vs ${comparison.incumbent ?? "unknown"}: ${comparison.challengerWins ? "win" : "not proven"}`).join("; ");
      const changes = (payload.changeOutcomes ?? []).map((item) => `vs ${item.incumbent ?? "unknown"}: ${item.outcome?.status ?? "unobserved"}${typeof item.outcome?.observedDelta === "number" ? ` (${item.outcome.observedDelta.toFixed(4)})` : ""}`).join("; ");
      const provider = payload.providerComparison
        ? `\n  Provider route: ${payload.providerComparison.challenger ?? "unknown"} vs ${payload.providerComparison.incumbent ?? "unknown"} · ${payload.providerComparison.challengerWins ? "win" : "not proven"} · lower95=${typeof payload.providerComparison.pairedLower95 === "number" ? payload.providerComparison.pairedLower95 : "unavailable"} · ${payload.providerComparison.reason ?? "no reason recorded"}`
        : "";
      const holdout = payload.providerGeneralization
        ? `\n  Provider holdout: ${payload.providerGeneralization.challengerProvider ?? "unknown"} vs ${payload.providerGeneralization.incumbentProvider ?? "unknown"} · ${payload.providerGeneralization.generalizes ? "generalizes" : "not proven"} · ${payload.providerGeneralization.reason ?? "no reason recorded"}`
        : "";
      const componentFailures = payload.componentFailureEvidence?.length
        ? `\n  Component failure lifts: ${payload.componentFailureEvidence.slice(0, 8).map((item) => `${item.componentId ?? "unknown"}=${typeof item.failureLift === "number" ? item.failureLift.toFixed(3) : "?"} (${item.failures ?? 0}/${item.samples ?? 0})`).join(", ")}`
        : "";
      return `- ${event.createdAt} · challenger ${payload.challenger ?? "unknown"}\n  Scores: ${scores || "none"}${comparisons ? `\n  Comparisons: ${comparisons}` : ""}${provider}${holdout}${componentFailures}${changes ? `\n  Prediction contract: ${changes}` : ""}`;
    }).join("\n")
    : "No matched harness benchmark feedback recorded.");
  sections.push("", "## Harness evolution plan", "", harnessEvolutionEvents.length
    ? harnessEvolutionEvents.slice(-5).map((event) => {
      const payload = event.payload as { components?: Array<{ path?: string; checksum?: string }>; interventions?: Array<{ failureClass?: string; priority?: number; prediction?: string; acceptance?: string }> };
      const components = payload.components?.length ?? 0;
      const interventions = (payload.interventions ?? []).map((item) => `${item.failureClass ?? "unknown"} (priority ${item.priority ?? "?"}): ${item.prediction ?? "no prediction"}; accept=${item.acceptance ?? "unspecified"}`).join("\n  ");
      return `- ${event.createdAt} · ${components} checksummed components\n  ${interventions || "No targeted intervention yet; waiting for benchmark evidence."}`;
    }).join("\n")
    : "No harness evolution plan recorded.");
  sections.push("", "## Source frontier", "", `Works: ${sourceFrontierReport.uniqueWorks} · retrieved: ${sourceFrontierReport.retrievedWorks} · pending: ${sourceFrontierReport.pendingWorks}\nQuery coverage: ${(sourceFrontierReport.queryCoverage * 100).toFixed(0)}% · retrieval coverage: ${(sourceFrontierReport.retrievalCoverage * 100).toFixed(0)}% · claim coverage: ${(sourceFrontierReport.claimCoverage * 100).toFixed(0)}%\nEvidence classes: scholarly=${sourceFrontierReport.scholarlyWorks}, official=${sourceFrontierReport.officialWorks}, implementation=${sourceFrontierReport.implementationLeads}, discovery=${sourceFrontierReport.discoveryOnlyWorks}\nMean routing quality: ${(sourceFrontierReport.meanQualityScore * 100).toFixed(0)}%`, "", "## Sources", "", sources.length ? sources.map((source) => `- ${source.id}: ${line((source.payload as { title?: string; url?: string }).title ?? source.payload)} · ${(source.payload as { url?: string }).url ?? ""}`).join("\n") : "No sources recorded.");
  sections.push("", "## Ensemble candidates", "", ensembles.length ? ensembles.map((candidate) => `- ${candidate.id} · ${candidate.status} · ${candidate.checksum}\n  ${candidate.path}`).join("\n") : "No ensemble candidates recorded.");
  if (kind !== "research") sections.push("", "## Experiments and runs", "", experiments.length ? experiments.map((experiment) => {
    const payload = experiment.payload as { status?: string; executionPlan?: Array<{ id: string; status: string }> };
    const plan = payload.executionPlan?.map((stage) => `${stage.id}=${stage.status}`).join(", ");
    return `- ${experiment.id}: ${line(payload.status ?? experiment.payload)}${plan ? `\n  stages: ${plan}` : ""}`;
  }).join("\n") : "No experiments recorded.", "", runs.length ? runs.map((run) => `- ${run.id} · ${run.status} · experiment ${run.experimentId}`).join("\n") : "No runs recorded.", "", `Artifacts recorded: ${artifacts.length}`);
  sections.push("", "## Run attempts", "", attempts.length ? attempts.map((attempt) => {
    const metrics = Object.entries(attempt.metrics ?? {}).map(([name, value]) => `${name}=${value}`).join(", ");
    return `- ${attempt.experimentId} · attempt ${attempt.attempt} · ${attempt.status} · ${attempt.executor}${attempt.failureClass ? ` · ${attempt.failureClass}` : ""}${metrics ? ` · metrics ${metrics}` : attempt.metric !== null ? ` · metric ${attempt.metric}` : ""}`;
  }).join("\n") : "No run attempts recorded.");
  const reproducibleAttempts = attempts.filter((attempt) => attempt.command.length > 0).slice(-100);
  const failedDirections = experiments.flatMap((experiment) => {
    const status = (experiment.payload as { status?: unknown }).status;
    return typeof status === "string" && ["failed", "invalid", "rejected", "blocked"].includes(status) ? [{ id: experiment.id, status }] : [];
  });
  const benchmarkUncertainty = harnessBenchmarkEvents.slice(-10).flatMap((event) => {
    const payload = event.payload as { challenger?: string; comparisons?: Array<{ incumbent?: string; pairedLower95?: number | null; reason?: string }> };
    return (payload.comparisons ?? []).map((comparison) => `- ${payload.challenger ?? "unknown"} vs ${comparison.incumbent ?? "unknown"}: lower95=${typeof comparison.pairedLower95 === "number" ? comparison.pairedLower95 : "unavailable"} · ${comparison.reason ?? "no reason recorded"}`);
  });
  sections.push("", "## Reproduction and uncertainty", "", reproducibleAttempts.length
    ? reproducibleAttempts.map((attempt) => `- ${attempt.experimentId} · ${attempt.stage} · ${attempt.status}\n  command: ${redactCommand(attempt.command).join(" ")}\n  cwd: ${attempt.cwd}${attempt.metrics && Object.keys(attempt.metrics).length ? `\n  metrics: ${JSON.stringify(attempt.metrics)}` : ""}${attempt.failureClass ? `\n  failure: ${attempt.failureClass}` : ""}`).join("\n")
    : "No executable run attempts recorded.",
    failedDirections.length ? `Failed directions retained: ${failedDirections.map((experiment) => `${experiment.id} (${experiment.status})`).join(", ")}` : "Failed directions retained: none.",
    benchmarkUncertainty.length ? `Benchmark uncertainty:\n${benchmarkUncertainty.join("\n")}` : "Benchmark uncertainty: no paired confidence bounds recorded.");
  sections.push("", "## Recent event log", "", events.length ? events.map((event) => `- ${event.createdAt} · ${event.type}`).join("\n") : "No events recorded.");
  return `${sections.join("\n")}\n`;
}

export function writeReport(root: string, kind: ReportKind, content: string): string {
  const directory = join(root, "reports");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(path, content);
  return path;
}
