import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ResearchStore } from "./store.js";

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
  const experiments = store.experiments();
  const runs = store.runs();
  const artifacts = store.artifacts();
  const trajectories = store.trajectories(100);
  const ensembles = store.ensembleCandidates(100);
  const events = store.recentEvents(40);
  const harnessBenchmarkEvents = store.recentEvents(200).filter((event) => event.type === "harness.benchmark.completed");
  const routingEvents = events.filter((event) => event.type === "research.capability_outcome");
  const experienceEvents = events.filter((event) => event.type === "research.experience.recorded");
  const contradictionEdges = store.edges().filter((edge) => edge.relation === "contradicts");
  const duplicateEvents = events.filter((event) => event.type === "evidence.claim.duplicate_detected");
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
    "## Phase goals",
    "",
    goals.length ? goals.map((goal) => {
      const payload = goal.payload as { title?: string; objective?: string; status?: string; attempts?: number };
      return `- **${goal.phase}** · ${payload.status ?? goal.status} · attempts ${payload.attempts ?? 0}\n  ${payload.title ?? "Untitled"}\n  ${payload.objective ?? ""}`;
    }).join("\n") : "No phase goals recorded.",
  ];
  if (kind !== "challenge") sections.push("", "## Hypotheses", "", hypotheses.length ? hypotheses.map((hypothesis) => `- ${hypothesis.id}: ${line((hypothesis.payload as { title?: string }).title ?? hypothesis.payload)}`).join("\n") : "No hypotheses recorded.");
  sections.push("", "## Decisions", "", decisions.length ? decisions.map((decision) => `- ${decision.id} · ${decision.createdAt}\n  ${line(decision.payload)}`).join("\n") : "No decisions recorded.");
  sections.push("", "## Evidence claims", "", claims.length ? claims.slice(0, 80).map((claim) => `- ${claim.id}: ${line((claim.payload as { statement?: string }).statement ?? claim.payload)}`).join("\n") : "No claims recorded.");
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
      const payload = event.payload as { challenger?: string; scorecards?: Array<{ harness?: string; competitiveScore?: number; failureProfile?: Record<string, number> }>; comparisons?: Array<{ incumbent?: string; challengerWins?: boolean; reason?: string }> };
      const scores = (payload.scorecards ?? []).map((scorecard) => `${scorecard.harness ?? "unknown"}=${typeof scorecard.competitiveScore === "number" ? scorecard.competitiveScore.toFixed(1) : "?"}${Object.keys(scorecard.failureProfile ?? {}).length ? ` failures=${JSON.stringify(scorecard.failureProfile)}` : ""}`).join(", ");
      const comparisons = (payload.comparisons ?? []).map((comparison) => `vs ${comparison.incumbent ?? "unknown"}: ${comparison.challengerWins ? "win" : "not proven"}`).join("; ");
      return `- ${event.createdAt} · challenger ${payload.challenger ?? "unknown"}\n  Scores: ${scores || "none"}${comparisons ? `\n  Comparisons: ${comparisons}` : ""}`;
    }).join("\n")
    : "No matched harness benchmark feedback recorded.");
  sections.push("", "## Sources", "", sources.length ? sources.map((source) => `- ${source.id}: ${line((source.payload as { title?: string; url?: string }).title ?? source.payload)} · ${(source.payload as { url?: string }).url ?? ""}`).join("\n") : "No sources recorded.");
  sections.push("", "## Ensemble candidates", "", ensembles.length ? ensembles.map((candidate) => `- ${candidate.id} · ${candidate.status} · ${candidate.checksum}\n  ${candidate.path}`).join("\n") : "No ensemble candidates recorded.");
  if (kind !== "research") sections.push("", "## Experiments and runs", "", experiments.length ? experiments.map((experiment) => {
    const payload = experiment.payload as { status?: string; executionPlan?: Array<{ id: string; status: string }> };
    const plan = payload.executionPlan?.map((stage) => `${stage.id}=${stage.status}`).join(", ");
    return `- ${experiment.id}: ${line(payload.status ?? experiment.payload)}${plan ? `\n  stages: ${plan}` : ""}`;
  }).join("\n") : "No experiments recorded.", "", runs.length ? runs.map((run) => `- ${run.id} · ${run.status} · experiment ${run.experimentId}`).join("\n") : "No runs recorded.", "", `Artifacts recorded: ${artifacts.length}`);
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
