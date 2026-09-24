import { agentOrganization, type AgentRoleContract } from "./agent-organization.js";
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
  const campaign = store.campaign() as { goal?: unknown; status?: unknown } | undefined;
  const tasks = store.queueTasks();
  const goals = store.phaseGoals();
  const phaseById = new Map(goals.map((goal) => [goal.id, goal]));
  const phaseRows = goals.slice(0, 24).map((entry) => {
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
  const activeQueue = alignedTasks.filter((task) => task.status === "running" || task.status === "assigned").length;
  const blockedQueue = alignedTasks.filter((task) => task.status === "blocked" || task.approvalStatus === "pending").length;
  return {
    goal: text(campaign?.goal),
    mode: campaignMode(store),
    status: text(campaign?.status) ?? "idle",
    phases: phaseRows,
    roles: organization,
    totals: { phases: phaseRows.length, roles: organization.length, queue: alignedTasks.length, activeQueue, blockedQueue },
  };
}
