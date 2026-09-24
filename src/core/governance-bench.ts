import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentOrganization, agentToolPermission, AGENT_ROLE_CONTRACTS } from "./agent-organization.js";
import { ResearchStore } from "./store.js";
import { approvalInbox } from "./approvals.js";

export interface GovernanceProbe {
  id: string;
  description: string;
  passed: boolean;
  observed: unknown;
}

export interface GovernanceBenchmarkReport {
  schemaVersion: 1;
  benchmark: "evidra-agent-governance";
  probes: GovernanceProbe[];
  passed: number;
  failed: number;
  score: number;
}

/**
 * Exercise the Paperclip-inspired organization contract without providers,
 * network, or workspace mutation. This catches regressions where role
 * metadata becomes decorative, paused agents can still acquire work, or
 * operator handoffs cross phase boundaries.
 */
export function runGovernanceBenchmark(): GovernanceBenchmarkReport {
  const root = mkdtempSync(join(tmpdir(), "evidra-governance-"));
  const probes: GovernanceProbe[] = [];
  const check = (id: string, description: string, passed: boolean, observed: unknown): void => { probes.push({ id, description, passed, observed }); };
  try {
    const store = new ResearchStore(join(root, "state.sqlite"));
    const organization = agentOrganization(store);
    check("role-contract-completeness", "Every declared specialist has a responsibility, authority, parent, and playbook.", organization.length === AGENT_ROLE_CONTRACTS.length && organization.every((role) => role.responsibility.length > 0 && role.authority.length > 0 && role.playbook.length >= 2), {
      roles: organization.length,
      contracts: AGENT_ROLE_CONTRACTS.length,
      missingPlaybooks: organization.filter((role) => role.playbook.length < 2).map((role) => role.role),
    });

    const directorShell = agentToolPermission("research director", "shell.exec");
    const engineerShell = agentToolPermission("experiment engineer", "shell.exec");
    const directorReport = agentToolPermission("research director", "report.generate");
    check("role-tool-boundaries", "Specialist authority is enforced at the tool boundary, not only in prompts.", !directorShell.allowed && engineerShell.allowed && !directorReport.allowed, { directorShell, engineerShell, directorReport });

    store.setAgentPause("model researcher", true, "governance benchmark");
    const paused = store.acquireAgentLane({ role: "model researcher", leaseId: "paused-worker", provider: "local", model: "bench" });
    store.setAgentPause("model researcher", false);
    const resumed = store.acquireAgentLane({ role: "model researcher", leaseId: "resumed-worker", provider: "local", model: "bench" });
    check("pause-boundary", "A paused role cannot acquire work, while resume restores acquisition.", !paused.acquired && resumed.acquired, { paused, resumed });
    store.releaseAgentLane("model researcher", "resumed-worker");

    const scoped = store.enqueueAgentDirective("validation scientist", "inspect phase alpha", "phase-alpha");
    const wrongScope = store.consumeAgentDirectives("validation scientist", 4, "phase-beta");
    const rightScope = store.consumeAgentDirectives("validation scientist", 4, "phase-alpha");
    const global = store.enqueueAgentDirective("validation scientist", "preserve the validation gate");
    const globalApplied = store.consumeAgentDirectives("validation scientist", 4, "phase-beta");
    check("handoff-scope-isolation", "Scoped handoffs wait for their matching goal while global instructions remain available.", wrongScope.length === 0 && rightScope.length === 1 && rightScope[0]?.id === scoped.id && globalApplied.length === 1 && globalApplied[0]?.id === global.id, { wrongScope, rightScope, globalApplied });

    const applied = store.agentDirectives("validation scientist");
    check("handoff-audit-trail", "Queued and applied handoffs remain queryable after delivery.", applied.length === 2 && applied.every((directive) => directive.appliedAt !== null), { directives: applied.map((directive) => ({ id: directive.id, scopeKey: directive.scopeKey, applied: directive.appliedAt !== null })) });

    store.enqueueTask({ id: "governance-recovery", kind: "research.lane", priority: 1, payload: {} });
    store.updateTask("governance-recovery", "failed", { error: "sandbox failed", recovery: { failureClass: "sandbox", route: "alternate_executor", action: "use a verified executor" } });
    store.appendEvent("queue.recovery_required", { taskId: "governance-recovery", failureClass: "sandbox", route: "alternate_executor", action: "use a verified executor" });
    const pendingRecovery = approvalInbox(store).find((item) => item.kind === "queue-recovery" && item.id === "governance-recovery");
    let sameRouteRejected = false;
    try { store.recoverFailedTask("governance-recovery", "alternate_executor"); } catch { sameRouteRejected = true; }
    const recovered = store.recoverFailedTask("governance-recovery", "local_repair", "repair the sandbox first");
    const resolvedRecovery = !approvalInbox(store).some((item) => item.kind === "queue-recovery" && item.id === "governance-recovery");
    check("recovery-approval-boundary", "Terminal work produces an approval item and cannot resume without a changed route.", Boolean(pendingRecovery) && sameRouteRejected && recovered.status === "queued" && resolvedRecovery, { pendingRecovery, sameRouteRejected, recovered: recovered.status, resolvedRecovery });
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const passed = probes.filter((probe) => probe.passed).length;
  return { schemaVersion: 1, benchmark: "evidra-agent-governance", probes, passed, failed: probes.length - passed, score: probes.length ? passed / probes.length : 0 };
}
