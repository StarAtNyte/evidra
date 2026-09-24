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

    store.releaseAgentLane("model researcher", "worker-a");
    const stale = store.acquireAgentLane({ role: "validation scientist", leaseId: "worker-stale", provider: "local", model: "bench" });
    store.close();
    const raw = new Database(join(root, "state.sqlite"));
    raw.prepare("UPDATE agent_lanes SET heartbeat_at = ? WHERE role = ?").run(new Date(Date.now() - 10_000).toISOString(), "validation scientist");
    raw.close();
    // Re-open through the public store API so the benchmark also covers state
    // durability across controller instances.
    const reopened = new ResearchStore(join(root, "state.sqlite"));
    const staleResult = reopened.staleAgentLanes(1_000);
    check("stale-lease-recovery", "Expired leased lanes become recoverable after reopen.", stale.acquired && staleResult.includes("validation scientist"), { staleResult });
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const passed = probes.filter((probe) => probe.passed).length;
  return { schemaVersion: 1, benchmark: "evidra-orchestration", probes, passed, failed: probes.length - passed, score: probes.length ? passed / probes.length : 0 };
}
