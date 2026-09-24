import { approvalInbox, type ApprovalInboxItem } from "./approvals.js";
import { goalAlignment } from "./goal-alignment.js";
import type { ResearchStore } from "./store.js";

export type AttentionSeverity = "critical" | "warning" | "info";

export type OperatorAttentionItem = {
  id: string;
  severity: AttentionSeverity;
  kind: string;
  summary: string;
  next: string;
};

export type OperatorAttention = {
  total: number;
  critical: number;
  warning: number;
  info: number;
  items: OperatorAttentionItem[];
};

const severityRank: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function approvalSeverity(item: ApprovalInboxItem): AttentionSeverity {
  if (item.kind === "phase-goal" || item.kind === "queue-recovery") return "critical";
  if (item.kind === "external-action" || item.status === "rejected" || item.status === "unknown") return "warning";
  return "info";
}

/**
 * Project durable control-plane signals into one bounded operator inbox.
 * This is read-only: it never changes queue, campaign, or approval state.
 */
export function operatorAttention(store: ResearchStore, root?: string): OperatorAttention {
  const items: OperatorAttentionItem[] = [];
  for (const approval of approvalInbox(store, root)) {
    items.push({ id: `${approval.kind}:${approval.id}`, severity: approvalSeverity(approval), kind: approval.kind, summary: `${approval.id} · ${approval.detail}`, next: approval.next });
  }

  const queue = store.queueTasks();
  for (const task of queue) {
    if (!["queued", "running"].includes(task.status)) continue;
    const readiness = store.taskReadiness(task.id);
    if (readiness && !readiness.ready) {
      const reasons = [...readiness.missing.map((id) => `missing:${id}`), ...readiness.pending.map((id) => `waiting:${id}`), ...readiness.failed.map((id) => `failed:${id}`)].slice(0, 4);
      items.push({ id: `queue-blocked:${task.id}`, severity: "warning", kind: "queue-blocked", summary: `${task.id} · ${task.kind}${reasons.length ? ` · ${reasons.join(", ")}` : " · not ready"}`, next: `/queue status` });
    }
  }
  for (const task of queue.filter((entry) => entry.status === "failed").slice(0, 24)) {
    items.push({ id: `queue-failed:${task.id}`, severity: "warning", kind: "queue-failed", summary: `${task.id} · ${task.kind} · failed`, next: `/queue history ${task.id}` });
  }
  for (const lane of store.agentLanes().filter((entry) => entry.status === "blocked" || entry.status === "failed").slice(0, 24)) {
    items.push({ id: `agent:${lane.role}`, severity: "critical", kind: "agent", summary: `${lane.role} · ${lane.status}${lane.error ? ` · ${lane.error.slice(0, 160)}` : ""}`, next: "/agents status" });
  }
  for (const lane of store.agentLanes().filter((entry) => entry.status === "running").slice(0, 24)) {
    const heartbeat = lane.heartbeatAt ? Date.parse(lane.heartbeatAt) : Number.NaN;
    if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 120_000) {
      items.push({ id: `agent-stale:${lane.role}`, severity: "critical", kind: "agent-stale", summary: `${lane.role} · running without a fresh heartbeat`, next: "/agents status" });
    }
  }
  for (const worker of store.externalWorkers(64).filter((entry) => entry.health === "stale" && entry.status === "running").slice(0, 24)) {
    items.push({ id: `worker:${worker.workerId}`, severity: "critical", kind: "worker-stale", summary: `${worker.workerId} · ${worker.role} · heartbeat stale`, next: "/agents status" });
  }

  const alignment = goalAlignment(store);
  if (alignment.status === "blocked") items.push({ id: "goal-alignment", severity: "critical", kind: "goal-alignment", summary: "Campaign alignment is blocked; new autonomous work must pause", next: "/status" });
  const control = store.queueControl();
  if (control.paused) items.push({ id: "queue-control", severity: "info", kind: "queue-control", summary: `Queue dispatch paused${control.reason ? ` · ${control.reason}` : ""}`, next: "/queue resume" });

  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  unique.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || left.id.localeCompare(right.id));
  const bounded = unique.slice(0, 64);
  return {
    total: bounded.length,
    critical: bounded.filter((item) => item.severity === "critical").length,
    warning: bounded.filter((item) => item.severity === "warning").length,
    info: bounded.filter((item) => item.severity === "info").length,
    items: bounded,
  };
}
