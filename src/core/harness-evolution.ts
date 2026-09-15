import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** A stable, file-level view of the harness action space. */
export interface HarnessComponent {
  id: string;
  path: string;
  kind: "agent" | "orchestration" | "execution" | "memory" | "validation" | "ui" | "other";
  checksum: string;
  bytes: number;
  editable: boolean;
}

export interface HarnessChangePresence {
  status: "changed" | "unchanged" | "unavailable";
  changedPaths: string[];
  addedPaths: string[];
  removedPaths: string[];
  reason: string;
}

export interface HarnessIntervention {
  id: string;
  priority: number;
  failureClass: string;
  components: string[];
  prediction: string;
  falsification: string;
  acceptance: string;
}

export interface HarnessChangeContract {
  id: string;
  componentIds: string[];
  baselineScore?: number;
  predictedDelta: { low: number; median: number; high: number };
  prediction: string;
  falsification: string;
  acceptance: string;
}

export interface HarnessChangeOutcome {
  status: "confirmed" | "partially_confirmed" | "refuted" | "unobserved";
  observedDelta?: number;
  explanation: string;
}

function classify(path: string): HarnessComponent["kind"] {
  if (/agents\//.test(path)) return "agent";
  if (/cli|scheduler|queue|campaign|allocation|search-policy|portfolio/.test(path)) return "orchestration";
  if (/executor|execution|process|modal|worktree|benchmark-runner/.test(path)) return "execution";
  if (/store|memory|experience|trajectory|research-context/.test(path)) return "memory";
  if (/validation|metric|audit|evidence|scorecard/.test(path)) return "validation";
  if (/ui\//.test(path)) return "ui";
  return "other";
}

function ignored(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === ".sota" || name === "dist" || name === "coverage";
}

function walk(root: string, current: string, output: HarnessComponent[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (ignored(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, path, output);
      continue;
    }
    if (!entry.isFile() || !/\.(?:ts|tsx|js|mjs|json|yaml|yml)$/.test(entry.name)) continue;
    const bytes = readFileSync(path);
    const relativePath = relative(root, path).split("\\").join("/");
    output.push({
      id: `component:${relativePath}`,
      path: relativePath,
      kind: classify(relativePath),
      checksum: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      editable: relativePath.startsWith("src/") && !/\.config\./.test(relativePath),
    });
  }
}

/** Inventory only source/config files; credentials, dependencies, and artifacts are excluded. */
export function inventoryHarnessComponents(root: string, maxFiles = 500): HarnessComponent[] {
  const output: HarnessComponent[] = [];
  try { walk(root, root, output); } catch { return []; }
  return output.sort((a, b) => a.path.localeCompare(b.path)).slice(0, Math.max(1, maxFiles));
}

/** Check that a retest is exercising a real source change, not an unchanged rerun. */
export function assessHarnessChangePresence(
  baseline: Array<{ path: string; checksum: string }> | undefined,
  current: HarnessComponent[],
  targetComponentIds: string[] = [],
): HarnessChangePresence {
  if (!baseline) return { status: "unavailable", changedPaths: [], addedPaths: [], removedPaths: [], reason: "No baseline component snapshot was recorded." };
  const before = new Map(baseline.map((component) => [component.path, component.checksum]));
  const after = new Map(current.map((component) => [component.path, component.checksum]));
  const changedPaths = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path)).sort();
  const addedPaths = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removedPaths = [...before.keys()].filter((path) => !after.has(path)).sort();
  const allChanges = [...new Set([...changedPaths, ...addedPaths, ...removedPaths])]
    .filter((path) => path.startsWith("src/"))
    .filter((path) => !targetComponentIds.length || targetComponentIds.includes(`component:${path}`))
    .sort();
  return allChanges.length
    ? { status: "changed", changedPaths: allChanges, addedPaths: addedPaths.filter((path) => allChanges.includes(path)), removedPaths: removedPaths.filter((path) => allChanges.includes(path)), reason: `${allChanges.length} targeted source component path(s) changed.` }
    : { status: "unchanged", changedPaths: [], addedPaths: [], removedPaths: [], reason: targetComponentIds.length ? "None of the declared harness components changed since the benchmark snapshot." : "No src/ component changed since the benchmark snapshot." };
}

function componentsOf(inventory: HarnessComponent[], patterns: RegExp[]): string[] {
  return inventory.filter((component) => patterns.some((pattern) => pattern.test(component.path))).map((component) => component.id).slice(0, 6);
}

/** Convert measured benchmark/trajectory failures into bounded, testable harness interventions. */
export function planHarnessInterventions(input: {
  inventory: HarnessComponent[];
  failureProfile?: Record<string, number>;
  qualityGaps?: string[];
  benchmarkAvailable?: boolean;
}): HarnessIntervention[] {
  const failures = Object.entries(input.failureProfile ?? {}).filter(([, count]) => Number.isFinite(count) && count > 0);
  const gapText = (input.qualityGaps ?? []).join(" ").toLowerCase();
  const plans: HarnessIntervention[] = [];
  const add = (failureClass: string, priority: number, patterns: RegExp[], prediction: string, falsification: string, acceptance: string): void => {
    const count = failures.find(([name]) => name === failureClass)?.[1] ?? 0;
    if (!count && !gapText.includes(failureClass.replace(/_/g, " "))) return;
    plans.push({ id: `intervention:${failureClass}`, priority: priority + count, failureClass, components: componentsOf(input.inventory, patterns), prediction, falsification, acceptance });
  };
  add("timeout", 8, [/executor|process|recovery|scheduler|benchmark-runner/], "bounded retries and adaptive timeout routing will increase valid-run rate without increasing duplicate work", "paired runs show no valid-run or time-efficiency improvement", "same-task matched benchmark: valid-run rate improves and reproducibility does not regress");
  add("transient_cloud", 8, [/executor|process|modal|recovery/], "cloud retry classification and checkpoint-aware recovery will reduce transient failures", "recovery attempts repeat the same failure class at the same rate", "same seed and budget: lower transient failure rate with preserved artifact checksums");
  add("cuda_oom", 9, [/executor|execution|recovery|cost-model/], "resource-aware backoff will route oversized jobs to a smaller configuration before retrying", "the alternate route still exceeds memory or changes the experiment contract", "the run completes under the declared budget with an explicit route record");
  add("data_missing", 9, [/data-audit|competition-contract|tools|validation/], "preflight data-contract checks will catch missing inputs before expensive execution", "a missing-input run reaches the worker without a diagnostic", "preflight rejects with an actionable path and no GPU work is charged");
  add("invalid_metric", 10, [/executors|execution|metrics|validation|benchmark-runner/], "strict metric/artifact validation will prevent narrative or malformed results from entering promotion", "an invalid output is still accepted as a scorecard trial", "malformed output is classified and excluded from competitive claims");
  add("rate_limit", 6, [/agents|codex-exec|queue|campaign/], "provider-aware routing will preserve campaign progress across entitlement exhaustion", "the campaign loses durable state or starts concurrent duplicate workers", "matched recovery resumes once or switches provider with provenance");
  add("auth", 7, [/agents|codex-exec|tools|submission/], "preflight authentication checks will fail before a research cycle spends its budget", "an unauthenticated route starts an active campaign", "failure is classified, durable, and resumable without a phantom result");
  add("dependency", 7, [/competition-contract|executors|tools|recovery/], "dependency preflight will route to repair/alternate execution before repeated retries", "the same missing dependency is retried three times unchanged", "one diagnostic identifies the dependency and proposes a bounded repair route");
  if (gapText.includes("tool") || gapText.includes("executionalignment")) add("tool_feedback", 8, [/tools|research-director|research-lanes|trajectories/], "closed tool-call/result boundaries will improve decision alignment", "the next decision ignores a returned tool failure", "every requested tool has a result and the next decision cites its outcome");
  if (!plans.length && input.benchmarkAvailable) add("unknown", 3, [/agents|cli|research-director|research-lanes/], "the next controlled harness change will improve the declared benchmark score", "the paired benchmark shows no improvement or worsens process quality", "a matched benchmark run validates both task score and process quality");
  return plans.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, 8);
}

/** Compare a declared prediction with measured evidence without accepting a narrative win. */
export function evaluateHarnessChange(contract: HarnessChangeContract, outcome: { candidateScore?: number; baselineScore?: number; valid?: boolean; changePresence?: HarnessChangePresence }): HarnessChangeOutcome {
  if (outcome.changePresence?.status === "unchanged") return { status: "unobserved", explanation: `Declared harness change is absent: ${outcome.changePresence.reason}` };
  if (outcome.changePresence?.status === "unavailable") return { status: "unobserved", explanation: `Harness change presence could not be verified: ${outcome.changePresence.reason}` };
  const baseline = outcome.baselineScore ?? contract.baselineScore;
  const candidate = outcome.candidateScore;
  if (!outcome.valid || baseline === undefined || candidate === undefined || !Number.isFinite(baseline) || !Number.isFinite(candidate)) return { status: "unobserved", explanation: "No valid paired score was recorded." };
  const observedDelta = candidate - baseline;
  if (observedDelta >= contract.predictedDelta.low) return { status: observedDelta >= contract.predictedDelta.median ? "confirmed" : "partially_confirmed", observedDelta, explanation: "The paired result meets the declared lower-bound prediction." };
  return { status: "refuted", observedDelta, explanation: "The paired result falls below the declared lower-bound prediction." };
}
