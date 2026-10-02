export interface ContextBudgetReport {
  maxChars: number;
  usedChars: number;
  dropped: string[];
  truncated: string[];
}

export interface BoundedContext {
  context: Record<string, unknown>;
  report: ContextBudgetReport;
}

const priority = [
  "observation", "authoritativeEvidence", "phaseGoal", "allocation", "availableTools", "evidenceConflicts", "toolResults", "laneToolResults",
  "crossPollination", "peerLaneBoard", "laneReports", "priorLaneReports", "researchMemory", "experienceReplay",
  "literatureFrontier", "literatureBenchmarkEvidence", "openCriticConstraint", "adaptiveHarnessPolicy",
  "harnessAdaptationAgenda", "harnessEvolutionPlan", "harnessBenchmarkEvidence",
  "harnessChangeHistory",
  "recentEvents", "researchSources",
];

// Keep the controller's authoritative state visible even when a provider or
// workspace emits an unusually large observation. These are context caps, not
// storage caps: the complete values remain durable in the store/artifacts.
const sectionCaps: Record<string, number> = {
  observation: 12_000,
  authoritativeEvidence: 6_000,
  phaseGoal: 6_000,
  allocation: 6_000,
  evidenceConflicts: 4_000,
  toolResults: 12_000,
  crossPollination: 6_000,
  laneReports: 10_000,
  priorLaneReports: 24_000,
  peerLaneBoard: 8_000,
  // Tool evidence is a collection of independently useful observations. A
  // fair per-item split makes a large but decisive file read unusable once a
  // lane has also run inventory/search tools. Reserve a larger section and
  // pack its observations by evidential value below.
  laneToolResults: 32_000,
  researchMemory: 8_000,
  experienceReplay: 8_000,
  literatureFrontier: 6_000,
  recentEvents: 8_000,
  researchSources: 8_000,
  availableTools: 8_000,
};
const protectedSections = new Set(["observation", "authoritativeEvidence", "phaseGoal", "allocation", "evidenceConflicts"]);
const protectedSectionReserve = 512;

function size(value: unknown): number {
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function laneObservationDetails(value: unknown): { substantive: boolean; readableBytes: number } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tool = typeof record.name === "string" ? record.name : typeof record.tool === "string" ? record.tool : "";
  const output = record.output && typeof record.output === "object" && !Array.isArray(record.output) ? record.output as Record<string, unknown> : {};
  const readableBytes = typeof output.text === "string" ? output.text.length : typeof output.matches === "string" ? output.matches.length : 0;
  return { substantive: tool === "workspace.read" || tool === "data.audit" || tool === "artifact.audit", readableBytes };
}

function boundValue(value: unknown, budget: number, path: string, truncated: string[]): unknown {
  if (budget <= 0) return undefined;
  if (typeof value === "string") {
    if (value.length <= budget) return value;
    truncated.push(path);
    return `${value.slice(0, Math.max(0, budget - 32))}\n...[context truncated by Evidra]`;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    if (path === "laneToolResults" || path === "priorLaneReports") {
      const laneBundles = value.some((item) => item && typeof item === "object" && !Array.isArray(item) && Array.isArray((item as Record<string, unknown>).observations));
      if (laneBundles) {
        // Allocate the aggregate budget across lanes first, then let each
        // lane's observations prioritize readable evidence. A greedy first
        // lane must not crowd every independent lane out of the director's
        // context.
        let remaining = budget;
        for (let index = 0; index < value.length; index += 1) {
          const lanesLeft = value.length - index;
          if (remaining < 512) { truncated.push(path); break; }
          const itemBudget = Math.max(512, Math.floor(remaining / lanesLeft));
          const bounded = boundValue(value[index], itemBudget, `${path}[${index}]`, truncated);
          if (bounded !== undefined) output.push(bounded);
          remaining -= size(bounded);
        }
        if (output.length < value.length) truncated.push(path);
        return output;
      }
      const entries = value.map((item, index) => {
        return { item, index, ...laneObservationDetails(item) };
      }).sort((left, right) => Number(right.substantive) - Number(left.substantive) || right.readableBytes - left.readableBytes || left.index - right.index);
      let remaining = budget;
      const retained = new Map<number, unknown>();
      for (const entry of entries) {
        if (remaining < 256) break;
        // Preserve a meaningful slice of primary observations; keep only a
        // compact status/result preview for the many routine search calls.
        const itemBudget = entry.substantive ? Math.min(24_500, remaining) : Math.min(1_500, remaining);
        const bounded = boundValue(entry.item, itemBudget, `${path}[${entry.index}]`, truncated);
        if (bounded === undefined) continue;
        const used = size(bounded);
        retained.set(entry.index, bounded);
        remaining -= used;
      }
      for (const entry of [...entries].sort((left, right) => left.index - right.index)) {
        const bounded = retained.get(entry.index);
        if (bounded !== undefined) output.push(bounded);
      }
      if (retained.size < value.length) truncated.push(path);
      return output;
    }
    if (path.endsWith(".observations")) {
      const entries = value.map((item, index) => ({ item, index, ...laneObservationDetails(item) }))
        .sort((left, right) => Number(right.substantive) - Number(left.substantive) || right.readableBytes - left.readableBytes || left.index - right.index);
      let remaining = budget;
      const retained = new Map<number, unknown>();
      for (const entry of entries) {
        if (remaining < 192) break;
        const itemBudget = entry.substantive ? Math.min(6_500, remaining) : Math.min(1_200, remaining);
        const bounded = boundValue(entry.item, itemBudget, `${path}[${entry.index}]`, truncated);
        if (bounded === undefined) continue;
        retained.set(entry.index, bounded);
        remaining -= size(bounded);
      }
      for (const entry of [...entries].sort((left, right) => left.index - right.index)) {
        const bounded = retained.get(entry.index);
        if (bounded !== undefined) output.push(bounded);
      }
      if (retained.size < value.length) truncated.push(path);
      return output;
    }
    // Feedback-bearing histories are append-only; preserve the newest entries
    // when the provider context is too small, then restore chronological order.
    const newestFirst = path === "toolResults" || path === "recentEvents";
    const indices = newestFirst ? [...value.keys()].reverse() : [...value.keys()];
    for (let position = 0; position < indices.length; position += 1) {
      const index = indices[position];
      const remaining = Math.max(128, Math.floor((budget - size(output)) / Math.max(1, indices.length - position)));
      const item = boundValue(value[index], remaining, `${path}[${index}]`, truncated);
      if (item === undefined) { truncated.push(path); break; }
      output.push(item);
      if (size(output) >= budget * 0.95) {
        if (position + 1 < indices.length) truncated.push(path);
        break;
      }
    }
    return newestFirst ? output.reverse() : output;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const remaining = Math.max(128, budget - size(output));
      const bounded = boundValue(child, remaining, `${path}.${key}`, truncated);
      if (bounded !== undefined) output[key] = bounded;
      if (size(output) >= budget * 0.95) {
        if (Object.keys(output).length < Object.keys(value as Record<string, unknown>).length) truncated.push(path);
        break;
      }
      }
      return output;
    }
  return value;
}

/** Pack model context under one aggregate character budget without changing evidence semantics. */
/**
 * Keep provider turns small enough for responsive, repeated autonomous cycles.
 * Large historical state is still durable in SQLite; it should not be replayed
 * wholesale into every lane/director prompt. Operators can raise the ceiling
 * for unusually large tasks without changing the evidence on disk.
 */
export function boundResearchContext(input: Record<string, unknown>, maxChars = Number(process.env.EVIDRA_CONTEXT_MAX_CHARS ?? 48_000)): BoundedContext {
  const budget = Math.max(4_000, Math.floor(maxChars));
  // Reserve room for the audit report that is attached to the model context
  // after packing. Without this margin the advertised budget could be exceeded
  // by the report itself.
  const packingBudget = Math.max(256, budget - 512);
  const truncated: string[] = [];
  const dropped: string[] = [];
  const keys = Object.keys(input).sort((left, right) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    return (leftIndex < 0 ? priority.length : leftIndex) - (rightIndex < 0 ? priority.length : rightIndex) || left.localeCompare(right);
  });
  const context: Record<string, unknown> = {};
  for (const [index, key] of keys.entries()) {
    const remaining = packingBudget - size(context);
    if (remaining < 256) { dropped.push(key); continue; }
    const remainingProtected = keys.slice(index + 1).filter((candidate) => protectedSections.has(candidate) && input[candidate] !== undefined).length;
    const available = Math.max(256, remaining - remainingProtected * protectedSectionReserve);
    const bounded = boundValue(input[key], Math.min(available, sectionCaps[key] ?? available), key, truncated);
    if (bounded === undefined) dropped.push(key);
    else context[key] = bounded;
  }
  const report: ContextBudgetReport = { maxChars: budget, usedChars: size(context), dropped: [...new Set(dropped)], truncated: [...new Set(truncated)] };
  context.contextBudget = report;
  return { context, report };
}
