import { agentOrganization, type AgentRoleContract } from "./agent-organization.js";
import { phaseGoalSetId, researchStageProgress, type ResearchStageProgress } from "./phase-goals.js";
import type { ResearchPhase } from "./types.js";
import type { ResearchStore } from "./store.js";

export type CampaignOrganizationPhase = {
  id: string;
  phase: string;
  status: string;
  objective: string | null;
  queue: { total: number; queued: number; active: number; blocked: number; completed: number; failed: number };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  budget: { tokenBudget: number | null; costBudgetUsd: number | null; tokenUtilization: number | null; costUtilization: number | null };
};

export type CampaignOrganizationRole = AgentRoleContract & {
  admission: "approved" | "review" | "rejected";
  status: string;
  health: string;
  task: string | null;
  pendingDirectives: number;
  activeQueue: number;
};

export type CampaignOrganization = {
  goal: string | null;
  mode: "research" | "challenge";
  status: string;
  progress: {
    completedPhases: number;
    totalPhases: number;
    ratio: number;
    status: "pending" | "active" | "blocked" | "met";
    activeStage: ResearchStageProgress["stage"] | null;
    activePhase: ResearchPhase | null;
    stages: ResearchStageProgress[];
  };
  phases: CampaignOrganizationPhase[];
  roles: CampaignOrganizationRole[];
  totals: {
    phases: number;
    roles: number;
    queue: number;
    unscopedQueue: number;
    queuedQueue: number;
    activeQueue: number;
    blockedQueue: number;
    completedQueue: number;
    failedQueue: number;
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
    budget: { tokenBudget: number | null; costBudgetUsd: number | null; tokenUtilization: number | null; costUtilization: number | null };
  };
  accountability: {
    unassignedRunning: string[];
    unscopedLive: string[];
    misalignedLive: string[];
    unbudgetedLive: string[];
    foreignCampaignLive: string[];
    legacyCampaignLive: string[];
  };
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function taskRole(task: { payload: unknown }): string | null {
  const payload = task.payload && typeof task.payload === "object" ? task.payload as { role?: unknown } : {};
  return text(payload.role);
}

function campaignMode(store: ResearchStore): "research" | "challenge" {
  const campaign = store.campaign() as { runtime?: { mode?: unknown } } | undefined;
  if (campaign?.runtime?.mode === "challenge") return "challenge";
  return "research";
}

function usageAndBudget(store: ResearchStore, tasks: ReturnType<ResearchStore["queueTasks"]>): { usage: { inputTokens: number; outputTokens: number; costUsd: number }; budget: { tokenBudget: number | null; costBudgetUsd: number | null; tokenUtilization: number | null; costUtilization: number | null } } {
  const usage = tasks.reduce((total, task) => {
    const current = store.queueUsageTotals(task.id);
    return { inputTokens: total.inputTokens + (current?.inputTokens ?? 0), outputTokens: total.outputTokens + (current?.outputTokens ?? 0), costUsd: total.costUsd + (current?.costUsd ?? 0) };
  }, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const tokenBudget = tasks.reduce((total, task) => total + (typeof task.tokenBudget === "number" && Number.isFinite(task.tokenBudget) ? Math.max(0, task.tokenBudget) : 0), 0);
  const costBudgetUsd = tasks.reduce((total, task) => total + (typeof task.costBudgetUsd === "number" && Number.isFinite(task.costBudgetUsd) ? Math.max(0, task.costBudgetUsd) : 0), 0);
  const hasTokenBudget = tasks.some((task) => typeof task.tokenBudget === "number" && Number.isFinite(task.tokenBudget));
  const hasCostBudget = tasks.some((task) => typeof task.costBudgetUsd === "number" && Number.isFinite(task.costBudgetUsd));
  return {
    usage,
    budget: {
      tokenBudget: hasTokenBudget ? tokenBudget : null,
      costBudgetUsd: hasCostBudget ? costBudgetUsd : null,
      tokenUtilization: hasTokenBudget && tokenBudget > 0 ? (usage.inputTokens + usage.outputTokens) / tokenBudget : null,
      costUtilization: hasCostBudget && costBudgetUsd > 0 ? usage.costUsd / costBudgetUsd : null,
    },
  };
}

/**
 * Build the bounded organization view used by operators and remote dashboards.
 * This is a projection only: it never changes scheduling, permissions, or gates.
 */
export function campaignOrganization(store: ResearchStore): CampaignOrganization {
  const campaign = store.campaign() as { goal?: unknown; goalSetId?: unknown; status?: unknown; startedAt?: unknown; runtime?: { mode?: unknown } } | undefined;
  const tasks = store.queueTasks();
  const goals = store.phaseGoals();
  const mode = campaignMode(store);
  const campaignGoal = text(campaign?.goal);
  const campaignStartedAt = text(campaign?.startedAt);
  const activeGoalSetId = typeof campaign?.goalSetId === "string" && campaign.goalSetId.trim() ? campaign.goalSetId.trim() : campaignGoal ? phaseGoalSetId(campaignGoal, mode) : null;
  const belongsToCampaign = (entry: { payload: unknown }): boolean => {
    if (activeGoalSetId === null) return true;
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { goalSetId?: unknown } : {};
    return typeof payload.goalSetId !== "string" || payload.goalSetId === activeGoalSetId;
  };
  const taskCampaignStartedAt = (task: { payload: unknown }): string | null => {
    const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload) ? task.payload as Record<string, unknown> : {};
    const nested = payload.campaign && typeof payload.campaign === "object" && !Array.isArray(payload.campaign) ? payload.campaign as Record<string, unknown> : {};
    return text(payload.campaignStartedAt) ?? text(nested.startedAt);
  };
  // A goal can be intentionally resumed, but a fresh campaign with the same
  // objective must not inherit the previous run's queue usage or budget.
  // Tasks created before campaign identity was introduced remain visible as
  // legacy work, but are never counted as current-run work once a campaign
  // has an explicit identity.
  const taskBelongsToCampaign = (task: { payload: unknown }): boolean => {
    if (!campaignStartedAt) return true;
    const taskStartedAt = taskCampaignStartedAt(task);
    return taskStartedAt === campaignStartedAt;
  };
  const campaignTasks = tasks.filter(taskBelongsToCampaign);
  const campaignGoals = goals.filter(belongsToCampaign);
  const phaseById = new Map(campaignGoals.map((goal) => [goal.id, goal]));
  const phaseRows = campaignGoals.slice(0, 24).map((entry) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
    const phaseTasks = campaignTasks.filter((task) => task.goalId === entry.id);
    const phaseUsage = usageAndBudget(store, phaseTasks);
    return {
      id: entry.id,
      phase: entry.phase,
      status: text(payload.status) ?? entry.status,
      objective: text(payload.objective),
      queue: {
        total: phaseTasks.length,
        queued: phaseTasks.filter((task) => task.status === "queued").length,
        active: phaseTasks.filter((task) => task.status === "running" || task.status === "assigned").length,
        blocked: phaseTasks.filter((task) => task.status === "blocked" || task.approvalStatus === "pending").length,
        completed: phaseTasks.filter((task) => task.status === "completed").length,
        failed: phaseTasks.filter((task) => task.status === "failed" || task.status === "cancelled").length,
      },
      usage: phaseUsage.usage,
      budget: phaseUsage.budget,
    } satisfies CampaignOrganizationPhase;
  });
  const stageProgress = researchStageProgress(campaignGoals.map((entry) => ({
    phase: entry.phase as ResearchPhase,
    status: ((entry.payload && typeof entry.payload === "object" ? text((entry.payload as Record<string, unknown>).status) : null) ?? entry.status) as "active" | "blocked" | "met" | "pending",
  })));
  const activeStage = stageProgress.find((stage) => stage.status === "active" || stage.status === "blocked");
  const completedPhases = campaignGoals.filter((entry) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
    return (text(payload.status) ?? entry.status) === "met";
  }).length;
  const progressStatus: CampaignOrganization["progress"]["status"] = campaignGoals.some((entry) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
    return (text(payload.status) ?? entry.status) === "blocked";
  }) ? "blocked" : campaignGoals.length > 0 && completedPhases === campaignGoals.length ? "met" : campaignGoals.length ? "active" : "pending";
  const organization = agentOrganization(store).slice(0, 32).map((role) => {
    const activeQueue = campaignTasks.filter((task) => task.status === "running" || task.status === "assigned")
      .filter((task) => task.assigneeId === role.role || task.ownerId === role.role || taskRole(task) === role.role).length;
    return {
      ...role,
      task: role.task,
      pendingDirectives: store.pendingAgentDirectives(role.role).length,
      activeQueue,
    } satisfies CampaignOrganizationRole;
  });
  // Keep the phase lookup live in this projection so malformed/foreign goal IDs
  // remain visible as unassigned work instead of being silently presented as aligned.
  const alignedTasks = campaignTasks.filter((task) => Boolean(task.goalId) && phaseById.has(task.goalId!));
  const liveTasks = campaignTasks.filter((task) => task.status === "queued" || task.status === "running");
  const foreignCampaignLive = tasks.filter((task) => {
    if (!campaignStartedAt || !["queued", "running"].includes(task.status)) return false;
    const taskStartedAt = taskCampaignStartedAt(task);
    return taskStartedAt !== null && taskStartedAt !== campaignStartedAt;
  });
  const legacyCampaignLive = tasks.filter((task) => campaignStartedAt !== null && ["queued", "running"].includes(task.status) && taskCampaignStartedAt(task) === null);
  const activeQueue = alignedTasks.filter((task) => task.status === "running" || task.status === "assigned").length;
  const queuedQueue = alignedTasks.filter((task) => task.status === "queued").length;
  const blockedQueue = alignedTasks.filter((task) => task.status === "blocked" || task.approvalStatus === "pending").length;
  const completedQueue = alignedTasks.filter((task) => task.status === "completed").length;
  const failedQueue = alignedTasks.filter((task) => task.status === "failed" || task.status === "cancelled").length;
  const campaignUsage = usageAndBudget(store, alignedTasks);
  return {
    goal: text(campaign?.goal),
    mode,
    status: text(campaign?.status) ?? "idle",
    progress: {
      completedPhases,
      totalPhases: campaignGoals.length,
      ratio: campaignGoals.length ? completedPhases / campaignGoals.length : 0,
      status: progressStatus,
      activeStage: activeStage?.stage ?? null,
      activePhase: activeStage?.activePhase ?? null,
      stages: stageProgress,
    },
    phases: phaseRows,
    roles: organization,
    totals: { phases: phaseRows.length, roles: organization.length, queue: alignedTasks.length, unscopedQueue: campaignTasks.filter((task) => !task.goalId).length, queuedQueue, activeQueue, blockedQueue, completedQueue, failedQueue, usage: campaignUsage.usage, budget: campaignUsage.budget },
    accountability: {
      unassignedRunning: liveTasks.filter((task) => task.status === "running" && !task.assigneeId && !task.ownerId && !taskRole(task)).map((task) => task.id).slice(0, 64),
      unscopedLive: liveTasks.filter((task) => !task.goalId).map((task) => task.id).slice(0, 64),
      misalignedLive: liveTasks.filter((task) => Boolean(task.goalId) && !phaseById.has(task.goalId!)).map((task) => task.id).slice(0, 64),
      unbudgetedLive: liveTasks.filter((task) => task.tokenBudget === null && task.costBudgetUsd === null).map((task) => task.id).slice(0, 64),
      foreignCampaignLive: foreignCampaignLive.map((task) => task.id).slice(0, 64),
      legacyCampaignLive: legacyCampaignLive.map((task) => task.id).slice(0, 64),
    },
  };
}

export function formatCampaignOrganization(map: CampaignOrganization): string {
  const phaseLines = map.phases.map((phase) => `  ${phase.status.padEnd(9)} ${phase.phase} · ${phase.id} · ${phase.queue.active} active / ${phase.queue.queued} queued / ${phase.queue.completed} done${phase.queue.blocked ? ` · ${phase.queue.blocked} blocked` : ""}${phase.queue.failed ? ` · ${phase.queue.failed} failed` : ""}${phase.objective ? `\n    ${phase.objective}` : ""}`);
  const roleLines = map.roles
    .filter((role) => role.parentRole === null || role.status !== "unstarted" || role.pendingDirectives > 0 || role.activeQueue > 0)
    .map((role) => `  ${role.status.padEnd(9)} ${role.role} → ${role.parentRole ?? "operator"} · ${role.admission} · ${role.health}${role.activeQueue ? ` · ${role.activeQueue} active` : ""}${role.pendingDirectives ? ` · ${role.pendingDirectives} directives` : ""}${role.task ? `\n    ${role.task}` : ""}`);
  return [
    "Campaign organization",
    `  mission: ${map.goal ?? "not initialized"}`,
    `  mode: ${map.mode} · status: ${map.status}`,
    `  progress: ${map.progress.completedPhases}/${map.progress.totalPhases} phases · ${(map.progress.ratio * 100).toFixed(0)}% · ${map.progress.status}${map.progress.activePhase ? ` · active ${map.progress.activePhase}` : ""}`,
    `  work: ${map.totals.activeQueue} active · ${map.totals.queuedQueue} queued · ${map.totals.completedQueue} done · ${map.totals.queue} aligned${map.totals.unscopedQueue ? ` · ${map.totals.unscopedQueue} unscoped` : ""}${map.totals.blockedQueue ? ` · ${map.totals.blockedQueue} blocked` : ""}${map.totals.failedQueue ? ` · ${map.totals.failedQueue} failed` : ""}`,
    `  usage: ${map.totals.usage.inputTokens + map.totals.usage.outputTokens} tokens · $${map.totals.usage.costUsd.toFixed(4)}${map.totals.budget.tokenUtilization !== null ? ` · token budget ${(map.totals.budget.tokenUtilization * 100).toFixed(0)}%` : ""}${map.totals.budget.costUtilization !== null ? ` · cost budget ${(map.totals.budget.costUtilization * 100).toFixed(0)}%` : ""}`,
    `  accountability: ${map.accountability.unassignedRunning.length} ownerless running · ${map.accountability.unscopedLive.length} unscoped · ${map.accountability.misalignedLive.length} mis-scoped · ${map.accountability.unbudgetedLive.length} unbudgeted${map.accountability.foreignCampaignLive.length ? ` · ${map.accountability.foreignCampaignLive.length} foreign campaign` : ""}${map.accountability.legacyCampaignLive.length ? ` · ${map.accountability.legacyCampaignLive.length} legacy campaign` : ""}`,
    "",
    "Phase ownership",
    ...(phaseLines.length ? phaseLines : ["  No phase goals recorded."]),
    "",
    "Reporting lines",
    ...(roleLines.length ? roleLines : ["  No active roles recorded."]),
  ].join("\n");
}
