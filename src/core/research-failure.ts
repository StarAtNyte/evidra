import { evaluateTrajectory, type TrajectoryEvent, type TrajectoryQuality } from "./trajectories.js";

export interface FailedResearchLane {
  role: string;
  error?: string;
}

export interface ResearchFailureRecord {
  events: TrajectoryEvent[];
  quality: TrajectoryQuality;
  error: string;
}

/** Close a failed research cycle into an auditable, resumable trajectory. */
export function researchFailureRecord(
  cycle: number,
  error: unknown,
  toolEvents: TrajectoryEvent[],
  failedLanes: FailedResearchLane[],
): ResearchFailureRecord {
  const message = error instanceof Error ? error.message : String(error);
  const stamp = `research-${Date.now()}-${cycle}`;
  const events: TrajectoryEvent[] = [
    ...toolEvents,
    ...failedLanes.map((lane, index) => ({
      id: `${stamp}-lane-${index}`,
      kind: "process" as const,
      payload: { status: "failed", role: lane.role, error: lane.error ?? "research lane failed" },
    })),
    { id: `${stamp}-agent`, kind: "process", payload: { status: "failed", stage: "agent_decision", error: message } },
    { id: `${stamp}-terminal`, kind: "terminal", payload: { status: "failed", goalAttained: false, error: message } },
  ];
  return { events, quality: evaluateTrajectory(events), error: message };
}
