export interface TimelineEvent {
  type: string;
  payload: unknown;
  createdAt: string;
}

function payloadOf(event: TimelineEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function summarizeTimelineEvent(event: TimelineEvent): string {
  const payload = payloadOf(event);
  const id = text(payload.id ?? payload.experimentId ?? payload.runId, "");
  if (event.type.startsWith("experiment.stage.")) {
    const stage = event.type.slice("experiment.stage.".length).replace(/\./g, " ");
    const metric = typeof payload.metric === "number" ? ` · metric ${payload.metric}` : "";
    return `experiment ${id} · ${stage}${metric}`.trim();
  }
  if (event.type === "run.retry.scheduled") return `experiment ${text(payload.experimentId, "unknown")} · retry ${String(payload.attempt ?? "?")} · ${text(payload.action, "recovery scheduled")}`;
  if (event.type === "run.attempt.started") return `experiment ${text(payload.experimentId, "unknown")} · attempt ${String(payload.attempt ?? "?")} · started · ${text(payload.executor, "local")}`;
  if (event.type === "run.attempt.completed") return `experiment ${text(payload.experimentId, "unknown")} · attempt ${String(payload.attempt ?? "?")} · ${text(payload.status, "unknown")}${payload.metric !== null && payload.metric !== undefined ? ` · metric ${String(payload.metric)}` : ""}`;
  if (event.type === "research.decision") return `research · ${text(payload.phase, "decision")} · ${text(payload.decision, "updated")}`;
  if (event.type === "research.cycle.completed") return `research cycle · ${text(payload.phase, "completed")}`;
  if (event.type.startsWith("controller.")) return `controller · ${event.type.slice("controller.".length).replace(/\./g, " ")}${id ? ` · ${id}` : ""}`;
  if (event.type === "submission.external.submitted") return `submission · submitted via ${text(payload.platform, "adapter")}`;
  if (event.type === "submission.score.recorded") return `submission · score ${String(payload.score ?? "unknown")}`;
  if (event.type.startsWith("queue.")) return `queue · ${event.type.slice("queue.".length).replace(/\./g, " ")}${id ? ` · ${id}` : ""}`;
  return event.type.replace(/\./g, " ") + (id ? ` · ${id}` : "");
}

export function renderTimeline(events: TimelineEvent[], limit = 30): string {
  const bounded = events.slice(-Math.max(1, Math.min(limit, 200)));
  if (!bounded.length) return "No timeline events recorded.";
  return bounded.map((event) => {
    const timestamp = event.createdAt.length >= 19 ? event.createdAt.slice(11, 19) : event.createdAt;
    return `${timestamp}  ${summarizeTimelineEvent(event)}`;
  }).join("\n");
}
