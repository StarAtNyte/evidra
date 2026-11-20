/**
 * Supervisor: one long-lived controller over all lanes and workers.
 *
 * Borrowed ideas (no code): EAT's team supervisor, which reassigns effort between worker roles by
 * results, and pi-dsh's crash-safe supervisor, which restarts workers from durable checkpoints. Here
 * a lane is a technique class, a worker is one `experiment run` process, and the checkpoint is the
 * experiment's durable stage state (a completed screen resumes with --skip-reduced).
 *
 * planSupervisorTick is pure: given the queue, live workers, the improvements ledger and launch
 * history, it decides which workers to restart or retire and what to launch next.
 */

export interface SupervisorPolicy {
  workers: number;
  /** A worker without a heartbeat (or any sign of life) for this long is stuck. */
  stallMinutes: number;
  maxRestarts: number;
  /** Recent launches inspected by the diversity monitor. */
  diversityWindow: number;
  /** Max share of the window one lane may take while other lanes have ready work. */
  maxLaneShare: number;
  /** Minutes a parked (exit 75) experiment waits before it is tried again. */
  parkedBackoffMinutes: number;
  /** Minimum share of recent launches reserved for wild (exploration) cards. */
  wildQuota: number;
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = { workers: 2, stallMinutes: 30, maxRestarts: 2, diversityWindow: 6, maxLaneShare: 0.5, parkedBackoffMinutes: 10, wildQuota: 0.2 };

export interface QueuedExperiment {
  experimentId: string;
  lane: string;
  ready: boolean;
  /** Set when the experiment was parked (exit 75) or its dependency was not ready. */
  parkedAt?: string;
  proposedAt?: string;
  /** A wild (exploration-quota) card. */
  wild?: boolean;
}

export interface LiveWorker {
  experimentId: string;
  lane: string;
  startedAt: string;
  lastHeartbeatAt?: string;
  restarts: number;
  exited?: { code: number | null; at: string };
}

export interface LaunchRecord { experimentId: string; lane: string; at: string; wild?: boolean }

export interface LedgerOutcome { techniqueClass?: string; accepted: boolean; stage: string; improvement?: number | null }

export interface LaneScore { lane: string; wins: number; trials: number; score: number }

/**
 * Lane priority: a Beta(1,1) posterior mean of the full-run keep rate plus an exploration bonus that
 * shrinks with trials. Lanes with ratchet wins get more effort; untried lanes stay attractive.
 */
export function laneScores(lanes: string[], ledger: readonly LedgerOutcome[], history: readonly LaunchRecord[]): LaneScore[] {
  const total = Math.max(1, history.length);
  return [...new Set(lanes)].map((lane) => {
    const outcomes = ledger.filter((entry) => (entry.techniqueClass ?? "other") === lane && entry.stage !== "screen");
    const wins = outcomes.filter((entry) => entry.accepted).length;
    const trials = Math.max(outcomes.length, history.filter((entry) => entry.lane === lane).length);
    const score = (wins + 1) / (trials + 2) + Math.sqrt(Math.log(total + 1) / (trials + 1)) * 0.5;
    return { lane, wins, trials, score };
  }).sort((left, right) => right.score - left.score || left.lane.localeCompare(right.lane));
}

export interface SupervisorDecision {
  restart: Array<{ experimentId: string; reason: string }>;
  retire: Array<{ experimentId: string; reason: string }>;
  launch: Array<{ experimentId: string; lane: string; reason: string }>;
  warnings: string[];
  lanes: LaneScore[];
  wild?: { launched: number; window: number; share: number; quota: number };
}

export function planSupervisorTick(input: {
  queue: readonly QueuedExperiment[];
  workers: readonly LiveWorker[];
  ledger: readonly LedgerOutcome[];
  history: readonly LaunchRecord[];
  now: number;
  policy?: Partial<SupervisorPolicy>;
}): SupervisorDecision {
  const policy = { ...DEFAULT_SUPERVISOR_POLICY, ...input.policy };
  const decision: SupervisorDecision = { restart: [], retire: [], launch: [], warnings: [], lanes: [] };
  const live: LiveWorker[] = [];
  for (const worker of input.workers) {
    if (worker.exited) continue;
    const lastSign = Math.max(Date.parse(worker.startedAt), worker.lastHeartbeatAt ? Date.parse(worker.lastHeartbeatAt) : 0);
    const silentMinutes = (input.now - lastSign) / 60_000;
    if (silentMinutes > policy.stallMinutes) {
      if (worker.restarts < policy.maxRestarts) decision.restart.push({ experimentId: worker.experimentId, reason: `no heartbeat for ${silentMinutes.toFixed(0)} min` });
      else decision.retire.push({ experimentId: worker.experimentId, reason: `stuck after ${worker.restarts} restarts` });
      continue;
    }
    live.push(worker);
  }
  const busy = new Set([...input.workers.filter((worker) => !worker.exited).map((worker) => worker.experimentId)]);
  const eligible = input.queue.filter((entry) => entry.ready && !busy.has(entry.experimentId)
    && (!entry.parkedAt || input.now - Date.parse(entry.parkedAt) >= policy.parkedBackoffMinutes * 60_000));
  const lanes = laneScores([...input.queue.map((entry) => entry.lane), ...input.history.map((entry) => entry.lane)], input.ledger, input.history);
  decision.lanes = lanes;
  const window = input.history.slice(-policy.diversityWindow);
  const share = (lane: string, extra: string[]) => {
    const recent = [...window.map((entry) => entry.lane), ...extra].slice(-policy.diversityWindow);
    return recent.length ? recent.filter((value) => value === lane).length / recent.length : 0;
  };
  const dominant = lanes.find((lane) => window.length >= policy.diversityWindow && share(lane.lane, []) > policy.maxLaneShare);
  if (dominant) decision.warnings.push(`diversity: ${dominant.lane} took ${(share(dominant.lane, []) * 100).toFixed(0)}% of the last ${window.length} launches`);
  const slots = Math.max(0, policy.workers - live.length - decision.restart.length);
  const picked: string[] = [];
  const pool = [...eligible];
  // Wild-card quota: count wild launches in the window so exploration cannot silently go to zero.
  const wildInWindow = window.filter((entry) => entry.wild).length;
  const wildShare = window.length ? wildInWindow / window.length : 0;
  decision.wild = { launched: wildInWindow, window: window.length, share: wildShare, quota: policy.wildQuota };
  if (policy.wildQuota > 0 && window.length >= policy.diversityWindow && wildShare < policy.wildQuota) {
    decision.warnings.push(`exploration: wild cards took ${(wildShare * 100).toFixed(0)}% of the last ${window.length} launches (quota ${(policy.wildQuota * 100).toFixed(0)}%)`);
  }
  if (policy.wildQuota > 0 && slots > 0 && wildShare < policy.wildQuota) {
    const wildIndex = pool.findIndex((entry) => entry.wild);
    if (wildIndex >= 0) {
      const [next] = pool.splice(wildIndex, 1);
      picked.push(next.lane);
      decision.launch.push({ experimentId: next.experimentId, lane: next.lane, reason: `wild-card quota (${wildInWindow}/${window.length} recent launches wild, quota ${(policy.wildQuota * 100).toFixed(0)}%)` });
    }
  }
  while (decision.launch.length < slots && pool.length) {
    const otherLanesReady = (lane: string) => pool.some((entry) => entry.lane !== lane);
    // Highest-scoring lane first, but never let one lane exceed its share while others wait.
    const ranked = lanes.map((lane) => lane.lane).filter((lane) => pool.some((entry) => entry.lane === lane));
    const lane = ranked.find((candidate) => !otherLanesReady(candidate) || share(candidate, [...picked, candidate]) <= policy.maxLaneShare) ?? ranked[0];
    const index = pool.findIndex((entry) => entry.lane === lane);
    const [next] = pool.splice(index, 1);
    picked.push(next.lane);
    const score = lanes.find((entry) => entry.lane === lane);
    decision.launch.push({ experimentId: next.experimentId, lane, reason: `lane ${lane} score ${score?.score.toFixed(3)} (${score?.wins ?? 0}/${score?.trials ?? 0} kept)` });
  }
  return decision;
}
