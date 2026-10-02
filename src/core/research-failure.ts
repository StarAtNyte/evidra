import { evaluateTrajectory, type TrajectoryEvent, type TrajectoryQuality } from "./trajectories.js";

export interface ResearchFailureLane {
  role: string;
  status?: string;
  error?: string;
  summary?: string;
  findings?: string[];
  recommendations?: string[];
  uncertainties?: string[];
  evidence?: string[];
  evidenceSourceIds?: string[];
}
/** @deprecated Use ResearchFailureLane; successful lane output is retained too. */
export type FailedResearchLane = ResearchFailureLane;

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
  lanes: ResearchFailureLane[],
): ResearchFailureRecord {
  const message = error instanceof Error ? error.message : String(error);
  const stamp = `research-${Date.now()}-${cycle}`;
  const completedCallIds = new Set(toolEvents.filter((event) => event.kind === "tool_result" && typeof event.callId === "string").map((event) => event.callId as string));
  const abortedCalls: TrajectoryEvent[] = toolEvents
    .filter((event) => event.kind === "tool_call" && typeof event.callId === "string" && !completedCallIds.has(event.callId))
    .map((event) => ({
      id: `${event.callId}-aborted`,
      kind: "tool_result" as const,
      callId: event.callId,
      at: new Date().toISOString(),
      payload: {
        tool: typeof event.payload.tool === "string" ? event.payload.tool : "unknown",
        ok: false,
        status: "failed",
        aborted: true,
        error: "agent turn ended before the tool returned",
      },
    }));
  const events: TrajectoryEvent[] = [
    ...toolEvents,
    ...abortedCalls,
    ...lanes.map((lane, index) => ({
      id: `${stamp}-lane-${index}`,
      kind: "assistant" as const,
      payload: {
        stage: "research_lane",
        status: lane.status ?? (lane.error ? "failed" : "unknown"),
        role: lane.role,
        ...(lane.error ? { error: lane.error.slice(0, 1_000) } : {}),
        ...(lane.summary ? { summary: lane.summary.slice(0, 2_000) } : {}),
        ...(lane.findings?.length ? { findings: lane.findings.slice(0, 12).map((item) => item.slice(0, 1_000)) } : {}),
        ...(lane.recommendations?.length ? { recommendations: lane.recommendations.slice(0, 8).map((item) => item.slice(0, 1_000)) } : {}),
        ...(lane.uncertainties?.length ? { uncertainties: lane.uncertainties.slice(0, 8).map((item) => item.slice(0, 1_000)) } : {}),
        ...(lane.evidence?.length ? { evidence: lane.evidence.slice(0, 16).map((item) => item.slice(0, 1_000)) } : {}),
        ...(lane.evidenceSourceIds?.length ? { evidenceSourceIds: lane.evidenceSourceIds.slice(0, 16) } : {}),
      },
    })),
    { id: `${stamp}-agent`, kind: "process", payload: { status: "failed", stage: "agent_decision", error: message } },
    { id: `${stamp}-terminal`, kind: "terminal", payload: { status: "failed", goalAttained: false, error: message } },
  ];
  return { events, quality: evaluateTrajectory(events), error: message };
}
