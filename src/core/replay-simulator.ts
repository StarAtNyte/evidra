import { z } from "zod";

/** A recorded discovery attempt. Replay never executes its command again. */
export interface ReplayNode {
  id: string;
  parentId: string | null;
  /** Metric score for legacy metric worlds; evaluator-defined utility is the generic form. */
  score?: number;
  utility?: number;
  outcomeType?: "metric" | "artifact" | "proof" | "behavior" | "system" | "other";
  costMinutes: number;
  valid: boolean;
  /** Optional terminal marker retained for policy diagnostics. */
  terminal?: boolean;
}

const ReplayNodeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  score: z.number().finite().optional(),
  utility: z.number().finite().optional(),
  outcomeType: z.enum(["metric", "artifact", "proof", "behavior", "system", "other"]).default("metric"),
  costMinutes: z.number().finite().nonnegative(),
  valid: z.boolean(),
  terminal: z.boolean().optional(),
}).superRefine((node, context) => {
  if (node.score === undefined && node.utility === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["utility"], message: "Replay node requires an evaluator-defined utility or legacy score." });
  if (node.outcomeType !== "metric" && node.utility === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["utility"], message: "Non-metric replay outcomes require explicit evaluator-defined utility." });
});

export interface ReplayWorld {
  rootId: string;
  nodes: ReplayNode[];
  /** Direction applies only to legacy metric `score`; evaluator utility is always higher-is-better. */
  direction?: "maximize" | "minimize";
}

export interface ReplayPolicyState {
  frontier: string[];
  revealed: string[];
  round: number;
}

export interface ReplayPolicy {
  id: string;
  maxRounds: number;
  maxParallel: number;
  select(state: ReplayPolicyState): string[];
  /** Optional branch choice among already-recorded children of a selected parent. */
  selectChild?(parentId: string, candidates: ReplayNode[], state: ReplayPolicyState): string | undefined;
}

export interface ReplayResult {
  policyId: string;
  revealed: string[];
  rounds: number;
  attemptedNodes: number;
  totalCostMinutes: number;
  bestScore: number | null;
  bestUtility: number | null;
  replayScore: number;
  stopped: "policy" | "exhausted" | "round_limit";
}

export interface ReplayScoring {
  costPenalty?: number;
  parallelismBonus?: number;
}

/** Validate a recorded tree before allowing it to influence policy selection. */
export function validateReplayWorld(world: ReplayWorld): ReplayWorld {
  if (!world || typeof world !== "object" || !Array.isArray(world.nodes) || !world.nodes.length) throw new Error("Replay world must contain at least one node.");
  const nodes = world.nodes.map((node, index) => {
    const parsed = ReplayNodeSchema.safeParse(node);
    if (!parsed.success) throw new Error(`Replay node ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? "invalid node"}`);
    return parsed.data;
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("Replay world contains duplicate node IDs.");
  const root = byId.get(world.rootId);
  if (!root) throw new Error(`Replay world root '${world.rootId}' does not exist.`);
  if (root.parentId !== null) throw new Error("Replay world root must have a null parent.");
  for (const node of nodes) if (node.id !== world.rootId && (!node.parentId || !byId.has(node.parentId))) throw new Error(`Replay node '${node.id}' references a missing parent.`);
  for (const node of nodes) {
    const seen = new Set<string>();
    let current: ReplayNode | undefined = node;
    while (current) {
      if (seen.has(current.id)) throw new Error(`Replay world contains a parent cycle at '${current.id}'.`);
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  if (world.direction !== undefined && world.direction !== "maximize" && world.direction !== "minimize") throw new Error("Replay world direction must be maximize or minimize.");
  return { rootId: world.rootId, nodes, ...(world.direction ? { direction: world.direction } : {}) };
}

/**
 * Run a policy against recorded outcomes only. The policy can change branch
 * order, stopping, and batch size, but cannot invent an unrecorded outcome.
 */
export function simulateReplay(worldInput: ReplayWorld, policy: ReplayPolicy, scoring: ReplayScoring = {}): ReplayResult {
  const world = validateReplayWorld(worldInput);
  if (!policy.id.trim()) throw new Error("Replay policy ID must be non-empty.");
  if (!Number.isInteger(policy.maxRounds) || policy.maxRounds < 1) throw new Error("Replay policy maxRounds must be a positive integer.");
  if (!Number.isInteger(policy.maxParallel) || policy.maxParallel < 1) throw new Error("Replay policy maxParallel must be a positive integer.");
  const costPenalty = scoring.costPenalty ?? 0.01;
  const parallelismBonus = scoring.parallelismBonus ?? 0;
  if (!Number.isFinite(costPenalty) || costPenalty < 0 || !Number.isFinite(parallelismBonus) || parallelismBonus < 0) throw new Error("Replay scoring coefficients must be finite and non-negative.");
  const byParent = new Map<string, ReplayNode[]>();
  for (const node of world.nodes) if (node.parentId !== null) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  for (const children of byParent.values()) children.sort((left, right) => left.id.localeCompare(right.id));
  const revealed = new Set<string>([world.rootId]);
  const frontier = new Set<string>([world.rootId]);
  let totalCostMinutes = 0;
  let rounds = 0;
  while (rounds < policy.maxRounds && frontier.size) {
    const selected = [...new Set(policy.select({ frontier: [...frontier].sort(), revealed: [...revealed].sort(), round: rounds + 1 }))]
      .filter((id) => frontier.has(id)).slice(0, policy.maxParallel);
    if (!selected.length) break;
    rounds += 1;
    let revealedThisRound = 0;
    for (const parentId of selected) {
      const candidates = (byParent.get(parentId) ?? []).filter((candidate) => !revealed.has(candidate.id));
      const requestedChild = policy.selectChild?.(parentId, candidates, { frontier: [...frontier].sort(), revealed: [...revealed].sort(), round: rounds });
      const child = (requestedChild ? candidates.find((candidate) => candidate.id === requestedChild) : undefined) ?? candidates[0];
      frontier.delete(parentId);
      if (!child) continue;
      revealed.add(child.id); frontier.add(child.id); revealedThisRound += 1; totalCostMinutes += child.costMinutes;
      // A branching parent remains selectable until every recorded child has
      // been revealed; this is what lets replay policies compare branch
      // order and parallel opening rather than only walking one chain.
      if ((byParent.get(parentId) ?? []).some((candidate) => !revealed.has(candidate.id))) frontier.add(parentId);
    }
    if (!revealedThisRound) break;
  }
  const validNodes = world.nodes.filter((node) => revealed.has(node.id) && node.valid && Number.isFinite(node.utility ?? node.score));
  const utilityOf = (node: ReplayNode): number => node.utility ?? (world.direction === "minimize" ? -(node.score!) : node.score!);
  const bestUtility = validNodes.length ? Math.max(...validNodes.map(utilityOf)) : null;
  const metricScores = validNodes.map((node) => node.score).filter((score): score is number => Number.isFinite(score));
  const bestScore = metricScores.length ? (world.direction === "minimize" ? Math.min(...metricScores) : Math.max(...metricScores)) : null;
  const attemptedNodes = Math.max(0, revealed.size - 1);
  const replayScore = bestUtility === null ? -costPenalty * totalCostMinutes : bestUtility - costPenalty * totalCostMinutes + parallelismBonus * (attemptedNodes / Math.max(1, rounds));
  const stopped = !frontier.size ? "exhausted" : rounds >= policy.maxRounds ? "round_limit" : "policy";
  return { policyId: policy.id, revealed: [...revealed].sort(), rounds, attemptedNodes, totalCostMinutes, bestScore, bestUtility, replayScore, stopped };
}

/** Evaluate alternative policies and return the highest replay score first. */
export function rankReplayPolicies(world: ReplayWorld, policies: ReplayPolicy[], scoring?: ReplayScoring): ReplayResult[] {
  if (!policies.length) throw new Error("At least one replay policy is required.");
  const results = policies.map((policy) => simulateReplay(world, policy, scoring));
  return results.sort((left, right) => right.replayScore - left.replayScore || left.policyId.localeCompare(right.policyId));
}
