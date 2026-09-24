import { approvalInbox, type ApprovalInboxItem } from "./approvals.js";
import { goalAlignment } from "./goal-alignment.js";
import { campaignOrganization } from "./campaign-organization.js";
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
  health: ControlPlaneHealth;
};

export type ControlPlaneHealth = {
  status: "idle" | "healthy" | "degraded" | "blocked";
  controller: "idle" | "running" | "stale";
  campaign: "idle" | "running" | "paused" | "completed";
  activeTasks: number;
  runningAgents: number;
  staleAgents: number;
  reason: string;
};

const severityRank: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function approvalSeverity(item: ApprovalInboxItem): AttentionSeverity {
  if (item.kind === "phase-goal" || item.kind === "queue-recovery") return "critical";
  if (item.kind === "external-action" || item.status === "rejected" || item.status === "unknown") return "warning";
  return "info";
}

/** One bounded campaign-health projection shared by every operator surface. */
export function controlPlaneHealth(store: ResearchStore): ControlPlaneHealth {
  const campaignValue = store.campaign();
  const campaignStatus = campaignValue && typeof campaignValue === "object" && typeof (campaignValue as { status?: unknown }).status === "string"
    ? (campaignValue as { status: string }).status
    : "idle";
  const campaign: ControlPlaneHealth["campaign"] = campaignStatus === "running" || campaignStatus === "paused" || campaignStatus === "completed" ? campaignStatus : "idle";
  const rawLease = store.controllerLease();
  const controller: ControlPlaneHealth["controller"] = store.liveControllerLease() ? "running" : rawLease?.status === "running" ? "stale" : "idle";
  const tasks = store.queueTasks();
  const activeTasks = tasks.filter((task) => ["queued", "running", "paused"].includes(task.status)).length;
  const lanes = store.agentLanes();
  const runningAgents = lanes.filter((lane) => lane.status === "running").length;
  const staleAgents = lanes.filter((lane) => {
    if (lane.status !== "running") return false;
    const heartbeat = lane.heartbeatAt ? Date.parse(lane.heartbeatAt) : Number.NaN;
    return !Number.isFinite(heartbeat) || Date.now() - heartbeat > 120_000;
  }).length;
  const alignment = goalAlignment(store);
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const blockedAgents = lanes.filter((lane) => lane.status === "blocked" || lane.status === "failed").length;
  let status: ControlPlaneHealth["status"] = "healthy";
  let reason = "Campaign control plane is healthy.";
  if (campaign === "idle" && activeTasks === 0 && runningAgents === 0) {
    status = "idle";
    reason = "No campaign or active work is running.";
  } else if (alignment.status === "blocked") {
    status = "blocked";
    reason = "Goal alignment is blocked; autonomous allocation must stop.";
  } else if (staleAgents > 0 || (campaign === "running" && controller !== "running")) {
    status = "blocked";
    reason = staleAgents > 0 ? `${staleAgents} running agent(s) have stale heartbeats.` : "A running campaign has no live controller lease.";
  } else if (controller === "stale" || failedTasks > 0 || blockedAgents > 0 || store.queueControl().paused) {
    status = "degraded";
    reason = controller === "stale" ? "The previous controller lease is stale." : failedTasks > 0 ? `${failedTasks} queue task(s) failed and need inspection.` : blockedAgents > 0 ? `${blockedAgents} agent lane(s) are blocked or failed.` : "Queue dispatch is paused by policy.";
  }
  return { status, controller, campaign, activeTasks, runningAgents, staleAgents, reason };
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
      items.push({ id: `agent-stale:${lane.role}`, severity: "critical", kind: "agent-stale", summary: `${lane.role} · running without a fresh heartbeat${lane.leaseId ? " · lease can be recovered" : " · no reclaimable lease"}`, next: lane.leaseId ? "/agents recover" : "/agents status" });
    }
  }
  for (const worker of store.externalWorkers(64).filter((entry) => entry.health === "stale" && entry.status === "running").slice(0, 24)) {
    items.push({ id: `worker:${worker.workerId}`, severity: "critical", kind: "worker-stale", summary: `${worker.workerId} · ${worker.role} · heartbeat stale`, next: "/agents status" });
  }

  const alignment = goalAlignment(store);
  if (alignment.status === "blocked") items.push({ id: "goal-alignment", severity: "critical", kind: "goal-alignment", summary: "Campaign alignment is blocked; new autonomous work must pause", next: "/status" });
  const organization = campaignOrganization(store);
  if (organization.status === "running") {
    if (organization.accountability.unassignedRunning.length) items.push({ id: "accountability:ownerless", severity: "warning", kind: "accountability", summary: `${organization.accountability.unassignedRunning.length} running task(s) have no owner`, next: "/organization" });
    if (organization.accountability.unscopedLive.length) items.push({ id: "accountability:scope", severity: "warning", kind: "accountability", summary: `${organization.accountability.unscopedLive.length} live task(s) have no phase goal`, next: "/organization" });
    if (organization.accountability.misalignedLive.length) items.push({ id: "accountability:misaligned", severity: "critical", kind: "accountability", summary: `${organization.accountability.misalignedLive.length} live task(s) reference a foreign or missing phase`, next: "/organization" });
    if (organization.accountability.unbudgetedLive.length) items.push({ id: "accountability:budget", severity: "warning", kind: "accountability", summary: `${organization.accountability.unbudgetedLive.length} live task(s) have no task-level budget`, next: "/organization" });
  }
  for (const stale of store.staleAgentDirectives().slice(0, 24)) {
    items.push({ id: `directive-stale:${stale.directive.id}`, severity: "critical", kind: "directive-stale", summary: `Directive #${stale.directive.id} to ${stale.directive.role} was acknowledged but ${stale.reason}`, next: "/agents recover" });
  }
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
    health: controlPlaneHealth(store),
  };
}
