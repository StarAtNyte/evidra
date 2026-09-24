import { agentOrganization, type AgentRoleContract } from "./agent-organization.js";
import { phaseGoalSetId } from "./phase-goals.js";
import type { ResearchStore } from "./store.js";

export type CampaignOrganizationPhase = {
  id: string;
  phase: string;
  status: string;
  objective: string | null;
  queue: { total: number; active: number; blocked: number };
};

export type CampaignOrganizationRole = AgentRoleContract & {
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
  phases: CampaignOrganizationPhase[];
  roles: CampaignOrganizationRole[];
  totals: {
    phases: number;
    roles: number;
    queue: number;
    activeQueue: number;
    blockedQueue: number;
  };
  accountability: {
    unassignedRunning: string[];
    unscopedLive: string[];
    misalignedLive: string[];
    unbudgetedLive: string[];
  };
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function campaignMode(store: ResearchStore): "research" | "challenge" {
  const campaign = store.campaign() as { runtime?: { mode?: unknown } } | undefined;
  if (campaign?.runtime?.mode === "challenge") return "challenge";
  return "research";
}

/**
 * Build the bounded organization view used by operators and remote dashboards.
 * This is a projection only: it never changes scheduling, permissions, or gates.
 */
export function campaignOrganization(store: ResearchStore): CampaignOrganization {
  const campaign = store.campaign() as { goal?: unknown; status?: unknown; runtime?: { mode?: unknown } } | undefined;
  const tasks = store.queueTasks();
  const goals = store.phaseGoals();
  const mode = campaignMode(store);
  const campaignGoal = text(campaign?.goal);
  const activeGoalSetId = campaignGoal ? phaseGoalSetId(campaignGoal, mode) : null;
  const belongsToCampaign = (entry: { payload: unknown }): boolean => {
    if (activeGoalSetId === null) return true;
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as { goalSetId?: unknown } : {};
    return typeof payload.goalSetId !== "string" || payload.goalSetId === activeGoalSetId;
  };
  const campaignGoals = goals.filter(belongsToCampaign);
  const phaseById = new Map(campaignGoals.map((goal) => [goal.id, goal]));
  const phaseRows = campaignGoals.slice(0, 24).map((entry) => {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload as Record<string, unknown> : {};
    const phaseTasks = tasks.filter((task) => task.goalId === entry.id);
    return {
      id: entry.id,
      phase: entry.phase,
      status: text(payload.status) ?? entry.status,
      objective: text(payload.objective),
      queue: {
        total: phaseTasks.length,
        active: phaseTasks.filter((task) => task.status === "running" || task.status === "assigned").length,
        blocked: phaseTasks.filter((task) => task.status === "blocked" || task.approvalStatus === "pending").length,
      },
    } satisfies CampaignOrganizationPhase;
  });
  const organization = agentOrganization(store).slice(0, 32).map((role) => {
    const activeQueue = tasks.filter((task) => task.status === "running" || task.status === "assigned")
      .filter((task) => task.assigneeId === role.role || task.ownerId === role.role).length;
    return {
      ...role,
      task: role.task,
      pendingDirectives: store.pendingAgentDirectives(role.role).length,
      activeQueue,
    } satisfies CampaignOrganizationRole;
  });
  // Keep the phase lookup live in this projection so malformed/foreign goal IDs
  // remain visible as unassigned work instead of being silently presented as aligned.
  const alignedTasks = tasks.filter((task) => !task.goalId || phaseById.has(task.goalId));
  const liveTasks = tasks.filter((task) => task.status === "queued" || task.status === "running");
  const activeQueue = alignedTasks.filter((task) => task.status === "running" || task.status === "assigned").length;
  const blockedQueue = alignedTasks.filter((task) => task.status === "blocked" || task.approvalStatus === "pending").length;
  return {
    goal: text(campaign?.goal),
    mode,
    status: text(campaign?.status) ?? "idle",
    phases: phaseRows,
    roles: organization,
    totals: { phases: phaseRows.length, roles: organization.length, queue: alignedTasks.length, activeQueue, blockedQueue },
    accountability: {
      unassignedRunning: liveTasks.filter((task) => task.status === "running" && !task.assigneeId && !task.ownerId).map((task) => task.id).slice(0, 64),
      unscopedLive: liveTasks.filter((task) => !task.goalId).map((task) => task.id).slice(0, 64),
      misalignedLive: liveTasks.filter((task) => Boolean(task.goalId) && !phaseById.has(task.goalId!)).map((task) => task.id).slice(0, 64),
      unbudgetedLive: liveTasks.filter((task) => task.tokenBudget === null && task.costBudgetUsd === null).map((task) => task.id).slice(0, 64),
    },
  };
}

export function formatCampaignOrganization(map: CampaignOrganization): string {
  const phaseLines = map.phases.map((phase) => `  ${phase.status.padEnd(9)} ${phase.phase} · ${phase.id} · ${phase.queue.active} active / ${phase.queue.total} queued${phase.queue.blocked ? ` · ${phase.queue.blocked} blocked` : ""}${phase.objective ? `\n    ${phase.objective}` : ""}`);
  const roleLines = map.roles
    .filter((role) => role.parentRole === null || role.status !== "unstarted" || role.pendingDirectives > 0 || role.activeQueue > 0)
    .map((role) => `  ${role.status.padEnd(9)} ${role.role} → ${role.parentRole ?? "operator"} · ${role.health}${role.activeQueue ? ` · ${role.activeQueue} active` : ""}${role.pendingDirectives ? ` · ${role.pendingDirectives} directives` : ""}${role.task ? `\n    ${role.task}` : ""}`);
  return [
    "Campaign organization",
    `  mission: ${map.goal ?? "not initialized"}`,
    `  mode: ${map.mode} · status: ${map.status}`,
    `  work: ${map.totals.activeQueue} active · ${map.totals.queue} aligned${map.totals.blockedQueue ? ` · ${map.totals.blockedQueue} blocked` : ""}`,
    `  accountability: ${map.accountability.unassignedRunning.length} ownerless running · ${map.accountability.unscopedLive.length} unscoped · ${map.accountability.misalignedLive.length} mis-scoped · ${map.accountability.unbudgetedLive.length} unbudgeted`,
    "",
    "Phase ownership",
    ...(phaseLines.length ? phaseLines : ["  No phase goals recorded."]),
    "",
    "Reporting lines",
    ...(roleLines.length ? roleLines : ["  No active roles recorded."]),
  ].join("\n");
}
