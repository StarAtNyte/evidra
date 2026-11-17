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
  "operatorSteering", "agentDirectives", "toolInstruction", "phaseGoal", "allocation",
  "observation", "authoritativeEvidence", "verifiedState", "availableTools", "evidenceConflicts", "toolResults", "laneToolResults",
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
  operatorSteering: 6_000,
  agentDirectives: 6_000,
  toolInstruction: 4_000,
  verifiedState: 6_000,
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
const protectedSections = new Set(["operatorSteering", "agentDirectives", "toolInstruction", "observation", "authoritativeEvidence", "verifiedState", "phaseGoal", "allocation", "evidenceConflicts"]);
const protectedSectionReserve = 512;

function size(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : serialized.length;
}

/** Use the same representation for packing and every provider prompt. */
export function serializeResearchContext(context: Record<string, unknown>): string {
  return JSON.stringify(context);
}

const truncationMarker = "\n...[context truncated by Evidra]";

function boundString(value: string, budget: number): string | undefined {
  if (size(value) <= budget) return value;
  if (size(truncationMarker) > budget) return size("") <= budget ? "" : undefined;
  let low = 0;
  let high = Math.min(value.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(value.slice(0, middle) + truncationMarker) <= budget) low = middle;
    else high = middle - 1;
  }
  // Avoid ending a preview on half of an astral Unicode code point.
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low) + truncationMarker;
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
  if (size(value) <= budget) return value;
  if (budget < 2) { truncated.push(path); return undefined; }
  if (typeof value === "string") {
    truncated.push(path);
    return boundString(value, budget);
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
        let remaining = budget - 2;
        for (let index = 0; index < value.length; index += 1) {
          const lanesLeft = value.length - index;
          if (remaining < 512) { truncated.push(path); break; }
          const itemBudget = Math.floor((remaining - Math.max(0, lanesLeft - 1)) / lanesLeft);
          const bounded = boundValue(value[index], itemBudget, `${path}[${index}]`, truncated);
          if (bounded !== undefined) output.push(bounded);
          remaining -= size(bounded) + (output.length > 1 ? 1 : 0);
        }
        if (output.length < value.length) truncated.push(path);
        return output;
      }
      const entries = value.map((item, index) => {
        return { item, index, ...laneObservationDetails(item) };
      }).sort((left, right) => Number(right.substantive) - Number(left.substantive) || right.readableBytes - left.readableBytes || left.index - right.index);
      let remaining = budget - 2;
      const retained = new Map<number, unknown>();
      for (const entry of entries) {
        if (remaining < 256) break;
        // Preserve a meaningful slice of primary observations; keep only a
        // compact status/result preview for the many routine search calls.
        const available = remaining - (retained.size ? 1 : 0);
        const itemBudget = entry.substantive ? Math.min(24_500, available) : Math.min(1_500, available);
        const bounded = boundValue(entry.item, itemBudget, `${path}[${entry.index}]`, truncated);
        if (bounded === undefined) continue;
        const used = size(bounded);
        retained.set(entry.index, bounded);
        remaining -= used + (retained.size > 1 ? 1 : 0);
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
      let remaining = budget - 2;
      const retained = new Map<number, unknown>();
      for (const entry of entries) {
        if (remaining < 192) break;
        const available = remaining - (retained.size ? 1 : 0);
        const itemBudget = entry.substantive ? Math.min(6_500, available) : Math.min(1_200, available);
        const bounded = boundValue(entry.item, itemBudget, `${path}[${entry.index}]`, truncated);
        if (bounded === undefined) continue;
        retained.set(entry.index, bounded);
        remaining -= size(bounded) + (retained.size > 1 ? 1 : 0);
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
    const newestFirst = ["toolResults", "recentEvents", "operatorSteering", "agentDirectives"].includes(path);
    const indices = newestFirst ? [...value.keys()].reverse() : [...value.keys()];
    for (let position = 0; position < indices.length; position += 1) {
      const index = indices[position];
      const entriesLeft = indices.length - position;
      // Give the newest feedback meaningful room before older history. An
      // equal split over hundreds of old calls can erase the latest error.
      const remaining = Math.floor((budget - size(output) - (output.length ? 1 : 0)) / Math.max(1, newestFirst ? Math.min(2, entriesLeft) : entriesLeft));
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
    const entries = Object.entries(value as Record<string, unknown>);
    if (/^(?:toolResults|laneToolResults|priorLaneReports)(?:\[|\.)/.test(path)) {
      const metadata = ["name", "tool", "ok", "trust", "sourceId", "contentHash", "path", "truncated", "securityWarnings"];
      entries.sort(([left], [right]) => {
        const rank = (key: string): number => { const index = metadata.indexOf(key); return index < 0 ? metadata.length : index; };
        return rank(left) - rank(right);
      });
    }
    const beforeTruncation = truncated.length;
    for (const [key, child] of entries) {
      const remaining = budget - size(output) - size(key) - 1 - (Object.keys(output).length ? 1 : 0);
      const bounded = boundValue(child, remaining, `${path}.${key}`, truncated);
      if (bounded !== undefined) Object.defineProperty(output, key, { value: bounded, enumerable: true, configurable: true, writable: true });
      else truncated.push(`${path}.${key}`);
      if (size(output) >= budget * 0.95) {
        if (Object.keys(output).length < Object.keys(value as Record<string, unknown>).length) truncated.push(path);
        break;
      }
    }
    // Retained text previews must not keep an upstream claim that their
    // contents are complete. The original durable observation is untouched.
    if (truncated.length > beforeTruncation && output.truncated === false) output.truncated = true;
    return output;
  }
  truncated.push(path);
  return undefined;
}

/** Pack model context under one aggregate character budget without changing evidence semantics. */
/**
 * Keep provider turns small enough for responsive, repeated autonomous cycles.
 * Large historical state is still durable in SQLite; it should not be replayed
 * wholesale into every lane/director prompt. Operators can raise the ceiling
 * for unusually large tasks without changing the evidence on disk.
 */
export function boundResearchContext(input: Record<string, unknown>, maxChars = Number(process.env.EVIDRA_CONTEXT_MAX_CHARS ?? 48_000)): BoundedContext {
  const budget = Number.isFinite(maxChars) ? Math.max(4_000, Math.floor(maxChars)) : 48_000;
  // Reserve room for the audit report that is attached to the model context
  // after packing. Without this margin the advertised budget could be exceeded
  // by the report itself.
  const packingBudget = budget - 768;
  const truncated: string[] = [];
  const dropped: string[] = [];
  // A previously packed director context carries its old report. It is
  // metadata, not evidence, and must not compete with the next turn's state.
  const keys = Object.keys(input).filter((key) => key !== "contextBudget").sort((left, right) => {
    const leftIndex = priority.indexOf(left);
    const rightIndex = priority.indexOf(right);
    return (leftIndex < 0 ? priority.length : leftIndex) - (rightIndex < 0 ? priority.length : rightIndex) || left.localeCompare(right);
  });
  const context: Record<string, unknown> = {};
  for (const [index, key] of keys.entries()) {
    const remaining = packingBudget - size(context);
    if (remaining < 256) { dropped.push(key); continue; }
    const propertyCost = size(key) + 1 + (Object.keys(context).length ? 1 : 0);
    const remainingProtected = keys.slice(index + 1).filter((candidate) => protectedSections.has(candidate) && input[candidate] !== undefined).length;
    const available = Math.min(remaining - propertyCost, Math.max(256, remaining - propertyCost - remainingProtected * protectedSectionReserve));
    const cap = Object.hasOwn(sectionCaps, key) ? sectionCaps[key] : available;
    const bounded = boundValue(input[key], Math.min(available, cap), key, truncated);
    if (bounded === undefined) dropped.push(key);
    else Object.defineProperty(context, key, { value: bounded, enumerable: true, configurable: true, writable: true });
  }
  const report: ContextBudgetReport = { maxChars: budget, usedChars: 0, dropped: [...new Set(dropped)], truncated: [...new Set(truncated)] };
  // Preserve complete paths for the controller, but send a bounded preview
  // and exact counts to the model. Diagnostic growth must not itself overflow
  // the context after thousands of historical sections have been omitted.
  const preview = (paths: string[]): string[] => paths.slice(0, 4).map((path) => boundString(path, 64) ?? "");
  const modelReport = {
    ...report,
    dropped: preview(report.dropped),
    truncated: preview(report.truncated),
    droppedCount: report.dropped.length,
    truncatedCount: report.truncated.length,
  };
  context.contextBudget = modelReport;
  // usedChars includes the report itself; converge across a digit boundary.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const usedChars = size(context);
    report.usedChars = usedChars;
    if (modelReport.usedChars === usedChars) break;
    modelReport.usedChars = usedChars;
  }
  return { context, report };
}
