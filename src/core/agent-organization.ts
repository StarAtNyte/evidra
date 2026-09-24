import type { ResearchStore } from "./store.js";

export type AgentRoleContract = {
  role: string;
  parentRole: string | null;
  responsibility: string;
  authority: "coordinate" | "investigate" | "validate" | "execute" | "repair";
};

/** A small, domain-neutral org chart for research and challenge campaigns. */
export const AGENT_ROLE_CONTRACTS: readonly AgentRoleContract[] = [
  { role: "research director", parentRole: null, responsibility: "maintain the ultimate objective, allocate work, and decide the next evidence-backed action", authority: "coordinate" },
  { role: "domain researcher", parentRole: "research director", responsibility: "map the domain, terminology, prior work, and competing explanations", authority: "investigate" },
  { role: "method researcher", parentRole: "research director", responsibility: "propose falsifiable mechanisms and discriminating tests", authority: "investigate" },
  { role: "data detective", parentRole: "research director", responsibility: "audit data provenance, leakage, shift, duplicates, and hidden structure", authority: "investigate" },
  { role: "model researcher", parentRole: "method researcher", responsibility: "design and compare candidate implementations without claiming unmeasured gains", authority: "investigate" },
  { role: "ensemble scientist", parentRole: "model researcher", responsibility: "test diversity, combination, and robustness of candidate solutions", authority: "investigate" },
  { role: "validation scientist", parentRole: "research director", responsibility: "protect evaluation design, metrics, uncertainty, and replication gates", authority: "validate" },
  { role: "reproducibility engineer", parentRole: "validation scientist", responsibility: "capture environments, seeds, artifacts, and independent rerun paths", authority: "validate" },
  { role: "experiment engineer", parentRole: "model researcher", responsibility: "implement isolated, declared, reproducible experiments", authority: "execute" },
  { role: "critic", parentRole: "research director", responsibility: "challenge decisions, expose unsupported assumptions, and require missing checks", authority: "validate" },
  { role: "repair agent", parentRole: "research director", responsibility: "recover failed routes by changing the cause, route, or decomposition", authority: "repair" },
  { role: "semantic auditor", parentRole: "critic", responsibility: "independently assess whether conclusions follow from durable evidence", authority: "validate" },
] as const;

export function agentRoleContract(role: string): AgentRoleContract {
  return AGENT_ROLE_CONTRACTS.find((contract) => contract.role === role) ?? {
    role,
    parentRole: "research director",
    responsibility: "unclassified work; requires explicit operator review before expansion",
    authority: "investigate",
  };
}

export function agentOrganization(store: ResearchStore): Array<AgentRoleContract & { status: string; task: string | null; budgetSeconds: number | null; usedSeconds: number; leaseId: string | null }> {
  const lanes = new Map(store.agentLanes().map((lane) => [lane.role, lane]));
  return AGENT_ROLE_CONTRACTS.map((contract) => {
    const lane = lanes.get(contract.role);
    return { ...contract, status: lane?.status ?? "unstarted", task: lane?.task ?? null, budgetSeconds: lane?.budgetSeconds ?? null, usedSeconds: lane?.usedSeconds ?? 0, leaseId: lane?.leaseId ?? null };
  });
}

export function formatAgentRoleContract(role: string): string {
  const contract = agentRoleContract(role);
  return `${contract.role} · reports to ${contract.parentRole ?? "operator"} · ${contract.authority}\nResponsibility: ${contract.responsibility}`;
}
