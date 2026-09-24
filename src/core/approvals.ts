import type { ResearchStore } from "./store.js";
import { externalToolStatus, loadExternalResearchTools } from "./external-tools.js";

export type ApprovalInboxItem = {
  kind: "experiment" | "submission" | "external-action" | "external-tool" | "phase-goal" | "queue-recovery";
  id: string;
  status: string;
  next: string;
  detail: string;
};

/**
 * Project the separate experiment, submission, and external-action gates into
 * one read-only operator inbox. This deliberately does not approve anything;
 * each `next` action remains behind its original validation boundary.
 */
export function approvalInbox(store: ResearchStore, root?: string): ApprovalInboxItem[] {
  const items: ApprovalInboxItem[] = [];
  const recoveryEvents = store.eventsByTypes(["queue.recovery_required", "queue.recovery_scheduled", "queue.lane.stale", "queue.review.stale"]);
  const latestRecovery = new Map<string, { type: string; payload: Record<string, unknown> }>();
  for (const event of recoveryEvents) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const taskId = typeof payload.taskId === "string" && payload.taskId.trim() ? payload.taskId : typeof payload.id === "string" && payload.id.trim() ? payload.id : null;
    if (taskId) latestRecovery.set(taskId, { type: event.type, payload });
  }
  for (const goal of store.phaseGoals()) {
    if (goal.status === "blocked") {
      const payload = goal.payload as { title?: unknown; objective?: unknown };
      items.push({ kind: "phase-goal", id: goal.id, status: "blocked", next: "/resume", detail: `${typeof payload.title === "string" ? payload.title : goal.phase}${typeof payload.objective === "string" ? ` · ${payload.objective}` : ""}` });
    }
  }
  for (const experiment of store.experiments()) {
    const payload = experiment.payload as { status?: unknown; hypothesisId?: unknown };
    if (payload.status === "proposed") {
      items.push({
        kind: "experiment",
        id: experiment.id,
        status: "pending",
        next: `/experiment run ${experiment.id}`,
        detail: `proposal${typeof payload.hypothesisId === "string" ? ` · hypothesis ${payload.hypothesisId}` : ""}`,
      });
    }
  }
  for (const submission of store.submissions()) {
    if (submission.status === "prepared") {
      items.push({ kind: "submission", id: submission.id, status: "pending", next: `/submission approve ${submission.id}`, detail: `experiment ${submission.experimentId}` });
    }
  }
  for (const intent of store.externalActions()) {
    if (intent.status === "unknown" || intent.status === "in_flight") {
      items.push({
        kind: "external-action",
        id: intent.id,
        status: intent.status,
        next: intent.kind === "competition_submission"
          ? `/submission reconcile ${String((intent.payload as { bundle?: unknown }).bundle ?? intent.id)} --status submitted|not-submitted`
          : "reconcile the recorded external action",
        detail: intent.kind,
      });
    }
  }
  if (root) {
    for (const tool of loadExternalResearchTools(root).tools) {
      const state = externalToolStatus(root, tool.name);
      if (state.status === "quarantined") items.push({ kind: "external-tool", id: tool.name, status: state.status, next: `/tools enable ${tool.name}`, detail: state.reason ?? "adapter requires operator review" });
    }
  }
  for (const [taskId, entry] of latestRecovery) {
    if (entry.type !== "queue.recovery_required" && !entry.type.endsWith(".stale")) continue;
    const route = typeof entry.payload.route === "string" ? entry.payload.route : entry.type.endsWith(".stale") ? "restart_worker" : "change_route";
    const action = typeof entry.payload.action === "string" ? entry.payload.action : "inspect failure";
    items.push({ kind: "queue-recovery", id: taskId, status: "pending", next: `/queue recover ${taskId} --route ${route}`, detail: `${typeof entry.payload.failureClass === "string" ? entry.payload.failureClass : "unknown"} · ${action}` });
  }
  return items;
}
