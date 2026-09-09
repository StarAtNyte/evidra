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
  const events = store.recentEvents(40);
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
  sections.push("", "## Sources", "", sources.length ? sources.map((source) => `- ${source.id}: ${line((source.payload as { title?: string; url?: string }).title ?? source.payload)} · ${(source.payload as { url?: string }).url ?? ""}`).join("\n") : "No sources recorded.");
  if (kind !== "research") sections.push("", "## Experiments and runs", "", experiments.length ? experiments.map((experiment) => `- ${experiment.id}: ${line((experiment.payload as { status?: string }).status ?? experiment.payload)}`).join("\n") : "No experiments recorded.", "", runs.length ? runs.map((run) => `- ${run.id} · ${run.status} · experiment ${run.experimentId}`).join("\n") : "No runs recorded.", "", `Artifacts recorded: ${artifacts.length}`);
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
