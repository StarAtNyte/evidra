import { createHash } from "node:crypto";
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

/** Stable state fingerprint: an acknowledgement reopens when the underlying signal changes. */
export function attentionFingerprint(item: OperatorAttentionItem): string {
  return createHash("sha256").update(`${item.id}\0${item.severity}\0${item.kind}\0${item.summary}\0${item.next}`).digest("hex").slice(0, 32);
}

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
  const routines = store.routines();
  const staleRoutines = routines.filter((routine) => routine.status === "running" && routine.leaseExpiresAt !== null && Date.parse(routine.leaseExpiresAt) <= Date.now()).length;
  const failedRoutines = routines.filter((routine) => routine.status === "failed" || routine.lastResult === "failed").length;
  const activeTasks = tasks.filter((task) => ["queued", "running", "paused"].includes(task.status)).length;
  const lanes = store.agentLanes();
  const runningAgents = lanes.filter((lane) => lane.status === "running").length;
  const staleAgents = lanes.filter((lane) => {
    if (lane.status !== "running") return false;
    const heartbeat = lane.heartbeatAt ? Date.parse(lane.heartbeatAt) : Number.NaN;
    return !Number.isFinite(heartbeat) || Date.now() - heartbeat > 120_000;
  }).length;
  const exhaustedAgents = lanes.filter((lane) => lane.status === "running" && lane.budgetSeconds !== null && lane.usedSeconds >= lane.budgetSeconds).length;
  const alignment = goalAlignment(store);
  const organizationBudget = campaignOrganization(store).totals.budget;
  const organizationBudgetUtilization = Math.max(organizationBudget.tokenUtilization ?? 0, organizationBudget.costUtilization ?? 0);
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const blockedAgents = lanes.filter((lane) => lane.status === "blocked" || lane.status === "failed").length;
  let status: ControlPlaneHealth["status"] = "healthy";
  let reason = "Campaign control plane is healthy.";
  if (staleRoutines > 0) {
    status = "blocked";
    reason = `${staleRoutines} routine runner lease(s) expired and require recovery.`;
  } else if (campaign === "idle" && activeTasks === 0 && runningAgents === 0 && failedRoutines === 0) {
    status = "idle";
    reason = "No campaign or active work is running.";
  } else if (alignment.status === "blocked") {
    status = "blocked";
    reason = "Goal alignment is blocked; autonomous allocation must stop.";
  } else if (campaign === "running" && organizationBudgetUtilization >= 1 && (organizationBudget.tokenBudget !== null || organizationBudget.costBudgetUsd !== null)) {
    status = "blocked";
    reason = `Campaign queue budget is exhausted (${Math.round(organizationBudgetUtilization * 100)}% utilization).`;
  } else if (campaign === "running" && organizationBudgetUtilization >= 0.8 && (organizationBudget.tokenBudget !== null || organizationBudget.costBudgetUsd !== null)) {
    status = "degraded";
    reason = `Campaign queue budget is ${Math.round(organizationBudgetUtilization * 100)}% utilized.`;
  } else if (staleAgents > 0 || exhaustedAgents > 0 || (campaign === "running" && controller !== "running")) {
    status = "blocked";
    reason = staleAgents > 0 ? `${staleAgents} running agent(s) have stale heartbeats.` : exhaustedAgents > 0 ? `${exhaustedAgents} running agent(s) exhausted their wall-clock budget.` : "A running campaign has no live controller lease.";
  } else if (controller === "stale" || failedTasks > 0 || failedRoutines > 0 || blockedAgents > 0 || store.queueControl().paused) {
    status = "degraded";
    reason = controller === "stale" ? "The previous controller lease is stale." : failedTasks > 0 ? `${failedTasks} queue task(s) failed and need inspection.` : failedRoutines > 0 ? `${failedRoutines} routine(s) failed and need inspection.` : blockedAgents > 0 ? `${blockedAgents} agent lane(s) are blocked or failed.` : "Queue dispatch is paused by policy.";
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
  const taskById = new Map(queue.map((task) => [task.id, task]));
  for (const task of queue) {
    if (!["queued", "running"].includes(task.status)) continue;
    const progress = store.queueProgress(task.id);
    if (progress?.state === "stalled") {
      items.push({ id: `queue-stalled:${task.id}`, severity: "critical", kind: "queue-stalled", summary: `${task.id} · ${task.kind} has a stale heartbeat${progress.heartbeatAgeSeconds !== null ? ` (${progress.heartbeatAgeSeconds}s)` : ""}`, next: `/queue history ${task.id}` });
    } else if (progress?.state === "blocked") {
      items.push({ id: `queue-blocked-progress:${task.id}`, severity: "warning", kind: "queue-blocked-progress", summary: `${task.id} · ${task.kind} reported blocked${progress.lastActivityMessage ? ` · ${progress.lastActivityMessage.slice(0, 140)}` : ""}`, next: `/queue activity ${task.id}` });
    }
    const readiness = store.taskReadiness(task.id);
    if (readiness && !readiness.ready) {
      const reasons = [...readiness.missing.map((id) => `missing:${id}`), ...readiness.pending.map((id) => `waiting:${id}`), ...readiness.failed.map((id) => `failed:${id}`)].slice(0, 4);
      items.push({ id: `queue-blocked:${task.id}`, severity: "warning", kind: "queue-blocked", summary: `${task.id} · ${task.kind}${reasons.length ? ` · ${reasons.join(", ")}` : " · not ready"}`, next: `/queue status` });
    }
  }
  for (const task of queue.filter((entry) => entry.status === "failed").slice(0, 24)) {
    items.push({ id: `queue-failed:${task.id}`, severity: "warning", kind: "queue-failed", summary: `${task.id} · ${task.kind} · failed`, next: `/queue history ${task.id}` });
  }
  for (const event of store.eventsByType("queue.lease_lost", 24)) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as { taskId?: unknown; actorId?: unknown; reason?: unknown } : {};
    const taskId = typeof payload.taskId === "string" && payload.taskId.trim() ? payload.taskId.trim() : "unknown-task";
    const actorId = typeof payload.actorId === "string" && payload.actorId.trim() ? payload.actorId.trim() : "unknown-worker";
    items.push({ id: `queue-lease-lost:${taskId}:${event.createdAt}`, severity: "critical", kind: "queue-lease-lost", summary: `${taskId} · worker ${actorId} lost its queue lease${typeof payload.reason === "string" && payload.reason.trim() ? ` · ${payload.reason.trim().slice(0, 120)}` : ""}`, next: `/queue history ${taskId}` });
  }
  const latestWorkerErrors = new Map<string, { event: { createdAt: string }; error: string }>();
  for (const event of store.eventsByType("queue.worker.error", 64)) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as { workerId?: unknown; error?: unknown } : {};
    const workerId = typeof payload.workerId === "string" && payload.workerId.trim() ? payload.workerId.trim() : "unknown-worker";
    const error = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim().slice(0, 160) : "queue supervisor failure";
    latestWorkerErrors.set(workerId, { event, error });
  }
  for (const [workerId, entry] of latestWorkerErrors) {
    items.push({ id: `queue-worker-error:${workerId}`, severity: "warning", kind: "queue-worker-error", summary: `${workerId} · ${entry.error}`, next: "/queue status" });
  }
  // A delegated failure is actionable in the context of its live parent. Make
  // the supervision boundary visible so the route or decomposition can change
  // deliberately instead of the parent silently repeating a broken branch.
  for (const child of queue.filter((entry) => entry.parentTaskId && ["failed", "cancelled"].includes(entry.status)).slice(0, 32)) {
    const parent = taskById.get(child.parentTaskId as string);
    if (!parent || ["completed", "failed", "cancelled"].includes(parent.status)) continue;
    const outcome = child.status === "failed" ? "failed" : "was cancelled";
    items.push({
      id: `queue-supervision:${parent.id}:${child.id}`,
      severity: child.status === "failed" ? "critical" : "warning",
      kind: "queue-supervision",
      summary: `${parent.id} · delegated child ${child.id} ${outcome}; parent supervision required`,
      next: `/queue history ${parent.id}`,
    });
  }
  for (const lane of store.agentLanes().filter((entry) => entry.status === "blocked" || entry.status === "failed").slice(0, 24)) {
    items.push({ id: `agent:${lane.role}`, severity: "critical", kind: "agent", summary: `${lane.role} · ${lane.status}${lane.error ? ` · ${lane.error.slice(0, 160)}` : ""}`, next: "/agents status" });
  }
  for (const lane of store.agentLanes().filter((entry) => entry.status === "running").slice(0, 24)) {
    if (lane.budgetSeconds !== null && lane.usedSeconds >= lane.budgetSeconds) {
      items.push({ id: `agent-budget:${lane.role}`, severity: "critical", kind: "agent-budget", summary: `${lane.role} · wall-clock budget exhausted (${Math.round(lane.usedSeconds)}s / ${Math.round(lane.budgetSeconds)}s)`, next: "/agents status" });
    }
    const heartbeat = lane.heartbeatAt ? Date.parse(lane.heartbeatAt) : Number.NaN;
    if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 120_000) {
      items.push({ id: `agent-stale:${lane.role}`, severity: "critical", kind: "agent-stale", summary: `${lane.role} · running without a fresh heartbeat${lane.leaseId ? " · lease can be recovered" : " · no reclaimable lease"}`, next: lane.leaseId ? "/agents recover" : "/agents status" });
    }
  }
  for (const worker of store.externalWorkers(64).filter((entry) => entry.health === "stale" && entry.status === "running").slice(0, 24)) {
    items.push({ id: `worker:${worker.workerId}`, severity: "critical", kind: "worker-stale", summary: `${worker.workerId} · ${worker.role} · heartbeat stale`, next: "/agents status" });
  }
  for (const routine of store.routines().filter((entry) => entry.status === "running" && entry.leaseExpiresAt !== null && Date.parse(entry.leaseExpiresAt) <= Date.now()).slice(0, 24)) {
    items.push({ id: `routine-stale:${routine.id}`, severity: "critical", kind: "routine-stale", summary: `${routine.id} · ${routine.name} runner lease expired`, next: "/routine recover" });
  }
  for (const routine of store.routines().filter((entry) => entry.status === "failed" || entry.lastResult === "failed").slice(0, 24)) {
    items.push({ id: `routine-failed:${routine.id}`, severity: "warning", kind: "routine-failed", summary: `${routine.id} · ${routine.name} failed${routine.lastError ? ` · ${routine.lastError.slice(0, 140)}` : ""}`, next: `/routine history ${routine.id}` });
  }

  const alignment = goalAlignment(store);
  if (alignment.status === "blocked") items.push({ id: "goal-alignment", severity: "critical", kind: "goal-alignment", summary: "Campaign alignment is blocked; new autonomous work must pause", next: "/status" });
  const organization = campaignOrganization(store);
  if (organization.status === "running") {
    const budget = organization.totals.budget;
    const tokenUtilization = budget.tokenUtilization ?? 0;
    const costUtilization = budget.costUtilization ?? 0;
    const highestUtilization = Math.max(tokenUtilization, costUtilization);
    if (highestUtilization >= 1) items.push({ id: "accountability:budget-utilization", severity: "critical", kind: "budget", summary: `Campaign work budget is exhausted (${Math.round(highestUtilization * 100)}% utilization); stop allocation or revise the declared budget`, next: "/organization" });
    else if (highestUtilization >= 0.8) items.push({ id: "accountability:budget-utilization", severity: "warning", kind: "budget", summary: `Campaign work budget is ${Math.round(highestUtilization * 100)}% utilized; review remaining work before allocating more`, next: "/organization" });
    if (organization.accountability.unassignedRunning.length) items.push({ id: "accountability:ownerless", severity: "warning", kind: "accountability", summary: `${organization.accountability.unassignedRunning.length} running task(s) have no owner`, next: "/organization" });
    if (organization.accountability.unscopedLive.length) items.push({ id: "accountability:scope", severity: "warning", kind: "accountability", summary: `${organization.accountability.unscopedLive.length} live task(s) have no phase goal`, next: "/organization" });
    if (organization.accountability.misalignedLive.length) items.push({ id: "accountability:misaligned", severity: "critical", kind: "accountability", summary: `${organization.accountability.misalignedLive.length} live task(s) reference a foreign or missing phase`, next: "/organization" });
    if (organization.accountability.foreignCampaignLive.length) items.push({ id: "accountability:foreign-campaign", severity: "warning", kind: "accountability", summary: `${organization.accountability.foreignCampaignLive.length} live task(s) belong to another campaign run`, next: "/organization" });
    if (organization.accountability.legacyCampaignLive.length) items.push({ id: "accountability:legacy-campaign", severity: "warning", kind: "accountability", summary: `${organization.accountability.legacyCampaignLive.length} live task(s) have no campaign identity and are excluded from current-run accounting`, next: "/organization" });
    if (organization.accountability.unbudgetedLive.length) items.push({ id: "accountability:budget", severity: "warning", kind: "accountability", summary: `${organization.accountability.unbudgetedLive.length} live task(s) have no task-level budget`, next: "/organization" });
  }
  for (const stale of store.staleAgentDirectives().slice(0, 24)) {
    items.push({ id: `directive-stale:${stale.directive.id}`, severity: "critical", kind: "directive-stale", summary: `Directive #${stale.directive.id} to ${stale.directive.role} was acknowledged but ${stale.reason}`, next: "/agents recover" });
  }
  const control = store.queueControl();
  if (control.paused) items.push({ id: "queue-control", severity: "info", kind: "queue-control", summary: `Queue dispatch paused${control.reason ? ` · ${control.reason}` : ""}`, next: "/queue resume" });

  const unique = [...new Map(items.map((item) => [item.id, item])).values()]
    .filter((item) => store.attentionAcknowledgement(item.id)?.fingerprint !== attentionFingerprint(item));
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
