import type { ResearchStore } from "./store.js";

export type AgentRoleContract = {
  role: string;
  parentRole: string | null;
  responsibility: string;
  authority: "coordinate" | "investigate" | "validate" | "execute" | "repair";
  /** Dynamic external roles must pass review before they are treated as trusted. */
  reviewRequired?: boolean;
  /** Reusable operating checklist injected into the agent's bounded context. */
  playbook: readonly string[];
};

/** A small, domain-neutral org chart for research and challenge campaigns. */
export const AGENT_ROLE_CONTRACTS: readonly AgentRoleContract[] = [
  { role: "research director", parentRole: null, responsibility: "maintain the ultimate objective, allocate work, and decide the next evidence-backed action", authority: "coordinate", playbook: ["state the active goal and phase", "allocate independent work with a reason", "choose only evidence-backed next actions", "stop or pause when a durable gate requires it"] },
  { role: "domain researcher", parentRole: "research director", responsibility: "map the domain, terminology, prior work, and competing explanations", authority: "investigate", playbook: ["define terms and scope", "retrieve primary sources", "separate established evidence from open claims", "identify competing explanations"] },
  { role: "method researcher", parentRole: "research director", responsibility: "propose falsifiable mechanisms and discriminating tests", authority: "investigate", playbook: ["formulate competing mechanisms", "find implementation and ablation evidence", "state predictions and failure conditions", "propose the cheapest discriminating test"] },
  { role: "data detective", parentRole: "research director", responsibility: "audit data provenance, leakage, shift, duplicates, and hidden structure", authority: "investigate", playbook: ["inventory data and provenance", "check leakage, duplicates, and target contamination", "inspect distribution and split shift", "record unresolved data risks"] },
  { role: "model researcher", parentRole: "method researcher", responsibility: "design and compare candidate implementations without claiming unmeasured gains", authority: "investigate", playbook: ["inspect the baseline and constraints", "propose mechanism-level alternatives", "tie each change to a falsifiable prediction", "avoid claiming gains without evaluator evidence"] },
  { role: "ensemble scientist", parentRole: "model researcher", responsibility: "test diversity, combination, and robustness of candidate solutions", authority: "investigate", playbook: ["measure candidate diversity", "locate complementary error slices", "compare a simple combination against its members", "check robustness before recommending promotion"] },
  { role: "validation scientist", parentRole: "research director", responsibility: "protect evaluation design, metrics, uncertainty, and replication gates", authority: "validate", playbook: ["verify metric and split contracts", "look for leakage and invalid comparisons", "quantify uncertainty or repeatability", "require independent replication for material claims"] },
  { role: "reproducibility engineer", parentRole: "validation scientist", responsibility: "capture environments, seeds, artifacts, and independent rerun paths", authority: "validate", playbook: ["capture environment and dependency state", "pin seeds and inputs", "verify artifact completeness and checksums", "rerun through an independent path"] },
  { role: "experiment engineer", parentRole: "model researcher", responsibility: "implement isolated, declared, reproducible experiments", authority: "execute", playbook: ["use a declared immutable experiment contract", "change one meaningful mechanism at a time", "run the evaluator without modifying its contract", "record outputs, failures, and resource use"] },
  { role: "critic", parentRole: "research director", responsibility: "challenge decisions, expose unsupported assumptions, and require missing checks", authority: "validate", playbook: ["search for unsupported claims", "challenge controls and comparisons", "separate uncertainty from failure", "withhold approval while required checks remain"] },
  { role: "repair agent", parentRole: "research director", responsibility: "recover failed routes by changing the cause, route, or decomposition", authority: "repair", playbook: ["classify the failure cause", "change route or decomposition rather than blindly retrying", "preserve the failed attempt as evidence", "verify the recovery independently"] },
  { role: "semantic auditor", parentRole: "critic", responsibility: "independently assess whether conclusions follow from durable evidence", authority: "validate", playbook: ["reinspect current workspace evidence", "trace each conclusion to an exact anchor", "check every acceptance criterion", "reject conclusions with unresolved required checks"] },
] as const;

export function agentRoleContract(role: string): AgentRoleContract {
  return AGENT_ROLE_CONTRACTS.find((contract) => contract.role === role) ?? {
    role,
    parentRole: "research director",
    responsibility: "unclassified work; requires explicit operator review before expansion",
    authority: "investigate",
    reviewRequired: true,
    playbook: ["clarify the assigned scope", "inspect current evidence", "state uncertainty", "propose a falsifiable next check"],
  };
}

/** Enforce specialist authority at the tool boundary, not only in prompts. */
export function agentToolPermission(role: string, toolName: string): { allowed: boolean; reason?: string } {
  const contract = agentRoleContract(role);
  const observationTools = new Set([
    "workspace.files", "workspace.search", "workspace.read", "git.status", "git.diff",
    "source.retrieve", "competition.observe", "source.search", "web.search",
    "repository.search", "data.audit", "artifact.audit", "prediction.analyze",
  ]);
  if (observationTools.has(toolName)) return { allowed: true };
  if (toolName === "shell.exec" && ["data detective", "model researcher", "ensemble scientist", "validation scientist", "reproducibility engineer", "experiment engineer", "repair agent"].includes(role)) return { allowed: true };
  if (toolName === "ensemble.analyze" && ["model researcher", "ensemble scientist", "validation scientist", "reproducibility engineer", "critic", "semantic auditor"].includes(role)) return { allowed: true };
  return { allowed: false, reason: `Role '${role}' (${contract.authority}) is not authorized to use '${toolName}'; the research director must perform or explicitly route this action.` };
}

export function agentOrganization(store: ResearchStore): Array<AgentRoleContract & { status: string; task: string | null; budgetSeconds: number | null; usedSeconds: number; leaseId: string | null }> {
  const lanes = new Map(store.agentLanes().map((lane) => [lane.role, lane]));
  const builtIn = AGENT_ROLE_CONTRACTS.map((contract) => {
    const lane = lanes.get(contract.role);
    return { ...contract, reviewRequired: contract.reviewRequired === true, status: lane?.status ?? "unstarted", task: lane?.task ?? null, budgetSeconds: lane?.budgetSeconds ?? null, usedSeconds: lane?.usedSeconds ?? 0, leaseId: lane?.leaseId ?? null };
  });
  const known = new Set(AGENT_ROLE_CONTRACTS.map((contract) => contract.role));
  const customRoles = [...lanes.keys()].filter((role) => !known.has(role)).sort((left, right) => left.localeCompare(right));
  return [...builtIn, ...customRoles.map((role) => {
    const lane = lanes.get(role)!;
    return { ...agentRoleContract(role), status: lane.status, task: lane.task, budgetSeconds: lane.budgetSeconds, usedSeconds: lane.usedSeconds, leaseId: lane.leaseId };
  })];
}

export function formatAgentRoleContract(role: string): string {
  const contract = agentRoleContract(role);
  return `${contract.role} · reports to ${contract.parentRole ?? "operator"} · ${contract.authority}\nResponsibility: ${contract.responsibility}`;
}
