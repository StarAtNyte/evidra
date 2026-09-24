import type { ResearchStore } from "./store.js";

export type GoalAlignmentCheck = {
  id: string;
  status: "pass" | "warn" | "blocked";
  detail: string;
  count: number;
};

export type GoalAlignmentReport = {
  status: "aligned" | "attention" | "blocked";
  score: number;
  campaignGoal: string | null;
  activePhaseGoal: string | null;
  checks: GoalAlignmentCheck[];
};

function campaignGoal(store: ResearchStore): { goal: string | null; running: boolean } {
  const campaign = store.campaign();
  if (!campaign || typeof campaign !== "object") return { goal: null, running: false };
  const value = campaign as { goal?: unknown; status?: unknown };
  return {
    goal: typeof value.goal === "string" && value.goal.trim() ? value.goal.trim() : null,
    running: value.status === "running",
  };
}

/** Check whether durable work still has a visible path to the campaign goal. */
export function goalAlignment(store: ResearchStore): GoalAlignmentReport {
  const campaign = campaignGoal(store);
  const phases = store.phaseGoals();
  const active = phases.find((phase) => phase.status === "active") ?? null;
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const tasks = store.queueTasks();
  const orphanedTasks = tasks.filter((task) => task.goalId !== null && !phaseIds.has(task.goalId));
  const runningWithoutTask = store.agentLanes().filter((lane) => lane.status === "running" && !lane.task?.trim());
  const liveTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const checks: GoalAlignmentCheck[] = [
    {
      id: "campaign-goal",
      status: campaign.goal ? "pass" : campaign.running ? "blocked" : "warn",
      detail: campaign.goal ? "A durable campaign objective is recorded." : campaign.running ? "The campaign is running without a durable objective." : "No active campaign objective is configured.",
      count: campaign.goal ? 1 : 0,
    },
    {
      id: "active-phase-goal",
      status: active ? "pass" : campaign.running ? "blocked" : "warn",
      detail: active ? `Active phase: ${active.phase}` : campaign.running ? "The campaign has no active internal phase goal." : "No active phase goal is required while idle.",
      count: active ? 1 : 0,
    },
    {
      id: "queue-lineage",
      status: orphanedTasks.length ? "blocked" : "pass",
      detail: orphanedTasks.length ? `${orphanedTasks.length} live queue task(s) reference a missing phase goal.` : "Every goal-linked live queue task resolves to a phase goal.",
      count: orphanedTasks.length,
    },
    {
      id: "lane-ownership",
      status: runningWithoutTask.length ? "warn" : "pass",
      detail: runningWithoutTask.length ? `${runningWithoutTask.length} running lane(s) have no assigned task.` : "Every running lane has an assigned task.",
      count: runningWithoutTask.length,
    },
  ];
  const blocking = checks.some((check) => check.status === "blocked");
  const attention = checks.some((check) => check.status !== "pass");
  return {
    status: blocking ? "blocked" : attention ? "attention" : "aligned",
    score: checks.length ? checks.filter((check) => check.status === "pass").length / checks.length : 1,
    campaignGoal: campaign.goal,
    activePhaseGoal: active?.id ?? null,
    checks: [...checks, { id: "live-work", status: "pass", detail: `${liveTasks.length} live queue task(s) are visible to the control plane.`, count: liveTasks.length }],
  };
}

export function formatGoalAlignment(report: GoalAlignmentReport): string {
  return [
    `Goal alignment: ${report.status.toUpperCase()} (${(report.score * 100).toFixed(0)}%)`,
    ...report.checks.map((check) => `  ${check.status === "pass" ? "✓" : check.status === "blocked" ? "✗" : "!"} ${check.id}: ${check.detail}`),
  ].join("\n");
}
