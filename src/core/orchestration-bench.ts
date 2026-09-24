import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ResearchStore } from "./store.js";

export interface OrchestrationProbe {
  id: string;
  description: string;
  passed: boolean;
  observed: unknown;
}

export interface OrchestrationBenchmarkReport {
  schemaVersion: 1;
  benchmark: "evidra-orchestration";
  probes: OrchestrationProbe[];
  passed: number;
  failed: number;
  score: number;
}

/**
 * Exercise the controller's coordination boundary without providers, network,
 * or workspace mutation. This is intentionally a benchmark, not a unit-test
 * replacement: it produces a portable report that can be compared across
 * harness versions and installation environments.
 */
export function runOrchestrationBenchmark(): OrchestrationBenchmarkReport {
  const root = mkdtempSync(join(tmpdir(), "evidra-orchestration-"));
  const probes: OrchestrationProbe[] = [];
  const check = (id: string, description: string, passed: boolean, observed: unknown): void => { probes.push({ id, description, passed, observed }); };
  try {
    const store = new ResearchStore(join(root, "state.sqlite"));
    const first = store.acquireAgentLane({ role: "model researcher", leaseId: "worker-a", provider: "local", model: "bench", budgetSeconds: 10 });
    const duplicate = store.acquireAgentLane({ role: "model researcher", leaseId: "worker-b", provider: "local", model: "bench" });
    check("duplicate-lane-prevention", "A second worker cannot acquire a live specialist role.", first.acquired && !duplicate.acquired, { first, duplicate });

    const wrongHeartbeat = store.heartbeatAgentLane("model researcher", "worker-b");
    const rightHeartbeat = store.heartbeatAgentLane("model researcher", "worker-a");
    check("lane-heartbeat-ownership", "Only the lease holder can refresh a specialist heartbeat.", !wrongHeartbeat && rightHeartbeat, { wrongHeartbeat, rightHeartbeat });

    const recorded = store.recordAgentLaneUsage("model researcher", "worker-a", 3);
    const budget = store.agentLaneBudget("model researcher", "worker-a");
    check("lane-budget-accounting", "Lane usage is durable and reduces remaining budget.", recorded && budget?.remainingSeconds === 7 && budget.usageCalls === 1, { recorded, budget });

    store.enqueueTask({ id: "bench-task", kind: "research.cycle", priority: 1, payload: {}, goalId: "goal-bench", parentTaskId: "task-parent" });
    const claimed = store.claimNextTask(undefined, "worker-a");
    const wrongTaskHeartbeat = store.heartbeatTask("bench-task", "worker-b");
    const rightTaskHeartbeat = store.heartbeatTask("bench-task", "worker-a");
    check("queue-heartbeat-ownership", "Only the queue claimant can refresh a running task.", claimed?.ownerId === "worker-a" && claimed.goalId === "goal-bench" && claimed.parentTaskId === "task-parent" && !wrongTaskHeartbeat && rightTaskHeartbeat, { claimedOwner: claimed?.ownerId, goalId: claimed?.goalId, parentTaskId: claimed?.parentTaskId, wrongTaskHeartbeat, rightTaskHeartbeat });
    store.updateTask("bench-task", "completed");
    store.enqueueTask({ id: "dependent", kind: "dependent", priority: 2, payload: {}, dependsOn: ["prerequisite"] });
    const blockedBeforeParent = store.claimNextTask(undefined, "worker-a");
    store.enqueueTask({ id: "prerequisite", kind: "prerequisite", priority: 1, payload: {} });
    const prerequisite = store.claimNextTask(undefined, "worker-a");
    store.updateTask("prerequisite", "completed");
    const dependent = store.claimNextTask(undefined, "worker-a");
    check("dependency-ordering", "A queued task waits for every prerequisite to complete.", !blockedBeforeParent && prerequisite?.id === "prerequisite" && dependent?.id === "dependent", { blockedBeforeParent: blockedBeforeParent?.id, prerequisite: prerequisite?.id, dependent: dependent?.id });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    store.enqueueTask({ id: "aging-fresh", kind: "aging", priority: 2, payload: {} });
    store.enqueueTask({ id: "aging-waiting", kind: "aging", priority: 1, payload: {}, availableAt: twoHoursAgo });
    const aged = store.claimNextTask(["aging"], "worker-a");
    check("queue-starvation-prevention", "Bounded priority aging gives long-waiting background work a turn without removing explicit priority.", aged?.id === "aging-waiting", { selected: aged?.id });
    if (aged) store.updateTask(aged.id, "completed");

    store.enqueueTask({ id: "expired-deadline", kind: "deadline", priority: 1, deadlineAt: new Date(Date.now() - 1_000).toISOString(), payload: {} });
    const expiredClaim = store.claimNextTask(["deadline"], "worker-a");
    const expiredTask = store.queueTasks().find((task) => task.id === "expired-deadline");
    check("deadline-expiry", "Expired work is cancelled durably instead of being claimed or stranded.", !expiredClaim && expiredTask?.status === "cancelled", { claimed: expiredClaim?.id, status: expiredTask?.status });

    store.enqueueTask({ id: "cancel-race", kind: "cancellation", priority: 1, payload: {} });
    const cancelClaim = store.claimTask("cancel-race", ["cancellation"], "worker-a");
    const cancelled = store.cancelTask("cancel-race", "benchmark operator stop");
    const lateCompletion = store.completeClaimedTask("cancel-race", "worker-a", "completed");
    check("cancellation-race", "Operator cancellation wins over a late worker completion.", cancelClaim?.id === "cancel-race" && cancelled && !lateCompletion && store.queueTasks().find((task) => task.id === "cancel-race")?.status === "cancelled", { claimed: cancelClaim?.id, cancelled, lateCompletion, status: store.queueTasks().find((task) => task.id === "cancel-race")?.status });

    store.enqueueTask({ id: "proof-contract", kind: "validated-work", priority: 1, payload: { completionContract: { requiredPayloadKeys: ["summary"], requiredEvidenceRefs: ["benchmark-proof"], requiredActivityKinds: ["progress"] } } });
    const proofClaim = store.claimTask("proof-contract", ["validated-work"], "worker-a");
    const rejected = !store.completeClaimedTask("proof-contract", "worker-a", "completed", {});
    store.recordQueueActivity({ taskId: "proof-contract", actorId: "worker-a", kind: "progress", message: "validated benchmark path" });
    store.appendEvent("benchmark-proof", { taskId: "proof-contract" });
    const accepted = store.completeClaimedTask("proof-contract", "worker-a", "completed", { summary: "verified" });
    check("completion-watchdog", "A task cannot complete until its declared proof contract is satisfied.", proofClaim?.id === "proof-contract" && rejected && accepted && store.queueTasks().find((task) => task.id === "proof-contract")?.status === "completed", { rejected, accepted, status: store.queueTasks().find((task) => task.id === "proof-contract")?.status });

    store.enqueueTask({ id: "parent-contract", kind: "delegated-parent", priority: 1, payload: { completionContract: { requireChildCompletion: true } } });
    store.enqueueTask({ id: "child-contract", kind: "delegated-child", priority: 1, parentTaskId: "parent-contract", payload: {} });
    const parentClaim = store.claimTask("parent-contract", ["delegated-parent"], "worker-parent");
    const childBlocked = !store.completeClaimedTask("parent-contract", "worker-parent", "completed", { summary: "premature" });
    const childClaim = store.claimTask("child-contract", ["delegated-child"], "worker-child");
    const childCompleted = childClaim ? store.completeClaimedTask("child-contract", "worker-child", "completed", { result: "done" }) : false;
    const parentCompleted = store.completeClaimedTask("parent-contract", "worker-parent", "completed", { summary: "children complete" });
    check("delegated-child-completion", "A coordinator cannot complete before every delegated child has completed.", parentClaim?.id === "parent-contract" && childBlocked && childCompleted && parentCompleted, { childBlocked, childCompleted, parentCompleted });

    store.enqueueTask({ id: "approval-gate", kind: "governed", priority: 1, requiresApproval: true, approvalReason: "benchmark operator review", payload: {} });
    const approvalBlocked = store.claimTask("approval-gate", ["governed"], "worker-a");
    const approvalSet = store.setTaskApproval("approval-gate", "approved", "benchmark approved");
    const approvalClaim = store.claimTask("approval-gate", ["governed"], "worker-a");
    check("approval-gate", "Approval-required work remains unclaimable until an explicit approval is recorded.", !approvalBlocked && approvalSet && approvalClaim?.id === "approval-gate", { approvalBlocked: approvalBlocked?.id, approvalSet, approvalClaim: approvalClaim?.id });
    if (approvalClaim) store.updateTask("approval-gate", "completed");

    store.enqueueTask({ id: "paused-dispatch", kind: "governed", priority: 1, payload: {} });
    const paused = store.setQueuePaused(true, "benchmark maintenance");
    const pausedClaim = store.claimTask("paused-dispatch", ["governed"], "worker-a");
    store.setQueuePaused(false);
    const resumedClaim = store.claimTask("paused-dispatch", ["governed"], "worker-a");
    check("queue-pause-governance", "A durable queue pause blocks new claims and resume reopens dispatch.", paused.paused && !pausedClaim && resumedClaim?.id === "paused-dispatch", { paused: paused.paused, pausedClaim: pausedClaim?.id, resumedClaim: resumedClaim?.id });
    if (resumedClaim) store.updateTask("paused-dispatch", "completed");

    store.enqueueTask({ id: "task-pause", kind: "governed", priority: 1, payload: {} });
    const taskPaused = store.pauseTask("task-pause", "benchmark inspection");
    const taskPausedClaim = store.claimTask("task-pause", ["governed"], "worker-a");
    const taskResumed = store.resumeTask("task-pause");
    const taskResumedClaim = store.claimTask("task-pause", ["governed"], "worker-a");
    check("task-pause-resume", "A single ticket can be suspended and resumed without consuming a retry.", taskPaused && !taskPausedClaim && taskResumed && taskResumedClaim?.attempts === 1, { taskPaused, taskPausedClaim: taskPausedClaim?.id, taskResumed, attempts: taskResumedClaim?.attempts });
    if (taskResumedClaim) store.updateTask("task-pause", "completed");

    store.enqueueTask({ id: "priority-control", kind: "governed", priority: 1, payload: {} });
    const priorityUpdated = store.setTaskPriority("priority-control", 9);
    const priorityClaim = store.claimTask("priority-control", ["governed"], "worker-a");
    const livePriorityUpdate = store.setTaskPriority("priority-control", 2);
    check("priority-control", "Operators can redirect queued work without mutating a live claim.", priorityUpdated && priorityClaim?.priority === 9 && !livePriorityUpdate, { priorityUpdated, claimedPriority: priorityClaim?.priority, livePriorityUpdate });
    if (priorityClaim) store.updateTask("priority-control", "completed");

    store.enqueueTask({ id: "label-control", kind: "governed", priority: 1, labels: ["GPU", "validation"], payload: {} });
    const labelsUpdated = store.setTaskLabels("label-control", ["review", "gpu"]);
    const labelTask = store.queueTasks().find((task) => task.id === "label-control");
    check("label-control", "Task classifications are normalized and durable before dispatch.", labelsUpdated && labelTask?.labels.join(",") === "gpu,review", { labelsUpdated, labels: labelTask?.labels });
    store.updateTask("label-control", "completed");

    store.enqueueTask({ id: "budget-stop", kind: "governed", priority: 1, tokenBudget: 2, payload: {} });
    const budgetClaim = store.claimTask("budget-stop", ["governed"], "worker-a");
    const budgetRecorded = budgetClaim ? store.recordQueueUsage({ taskId: "budget-stop", actorId: "worker-a", inputTokens: 1, outputTokens: 1, claimToken: budgetClaim.claimToken ?? undefined }) : false;
    const budgetTask = store.queueTasks().find((task) => task.id === "budget-stop");
    check("live-budget-stop", "Crossing a live token ceiling cancels the claim before another worker turn.", Boolean(budgetRecorded && budgetTask?.status === "cancelled" && budgetTask.payload && typeof budgetTask.payload === "object" && (budgetTask.payload as Record<string, unknown>).cancellation !== undefined), { budgetRecorded, status: budgetTask?.status, cancellation: budgetTask?.payload && typeof budgetTask.payload === "object" ? (budgetTask.payload as Record<string, unknown>).cancellation : undefined });

    store.releaseAgentLane("model researcher", "worker-a");
    const stale = store.acquireAgentLane({ role: "validation scientist", leaseId: "worker-stale", provider: "local", model: "bench" });
    store.enqueueTask({ id: "stale-lane-ticket", kind: "research.lane", priority: 1, payload: { role: "validation scientist", leaseId: "worker-stale" } });
    store.claimTask("stale-lane-ticket", ["research.lane"], "worker-stale");
    store.close();
    const raw = new Database(join(root, "state.sqlite"));
    raw.prepare("UPDATE agent_lanes SET heartbeat_at = ? WHERE role = ?").run(new Date(Date.now() - 10_000).toISOString(), "validation scientist");
    raw.prepare("UPDATE work_queue SET claimed_at = ? WHERE id = ?").run(new Date(Date.now() - 10_000).toISOString(), "stale-lane-ticket");
    raw.close();
    // Re-open through the public store API so the benchmark also covers state
    // durability across controller instances.
    const reopened = new ResearchStore(join(root, "state.sqlite"));
    const staleTickets = reopened.staleLaneTickets(1_000);
    const staleResult = reopened.staleAgentLanes(1_000);
    check("stale-lease-recovery", "Expired leased lanes and their tickets become recoverable after reopen.", stale.acquired && staleResult.includes("validation scientist") && staleTickets.includes("stale-lane-ticket") && reopened.queueTasks().find((task) => task.id === "stale-lane-ticket")?.status === "failed", { staleResult, staleTickets, ticketStatus: reopened.queueTasks().find((task) => task.id === "stale-lane-ticket")?.status });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const passed = probes.filter((probe) => probe.passed).length;
  return { schemaVersion: 1, benchmark: "evidra-orchestration", probes, passed, failed: probes.length - passed, score: probes.length ? passed / probes.length : 0 };
}
