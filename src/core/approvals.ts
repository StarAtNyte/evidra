import type { ResearchStore } from "./store.js";

export type ApprovalInboxItem = {
  kind: "experiment" | "submission" | "external-action";
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
export function approvalInbox(store: ResearchStore): ApprovalInboxItem[] {
  const items: ApprovalInboxItem[] = [];
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
  return items;
}
