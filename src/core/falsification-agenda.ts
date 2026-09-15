/** A bounded, provider-neutral agenda for testing hypotheses rather than merely discussing them. */
export interface FalsificationAgendaItem {
  hypothesisId: string;
  title: string;
  falsificationTest: string;
  status: "untested" | "tested" | "supported" | "rejected" | "inconclusive";
  priority: number;
  rationale: string;
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/**
 * Build a deterministic agenda from durable hypotheses and experiment state.
 * A terminal experiment counts as a test of the direction even when it failed:
 * failures are evidence, not permission to silently repeat the same route.
 */
export function buildFalsificationAgenda(
  hypotheses: Array<{ id: string; payload: unknown }>,
  experiments: Array<{ id: string; payload: unknown }>,
  limit = 8,
): FalsificationAgendaItem[] {
  const terminalStatuses = new Set(["completed", "failed", "invalid", "rejected"]);
  const tested = new Set<string>();
  for (const experiment of experiments) {
    const payload = experiment.payload as { hypothesisId?: unknown; status?: unknown };
    if (typeof payload.hypothesisId === "string" && terminalStatuses.has(String(payload.status))) tested.add(payload.hypothesisId);
  }
  const candidates = hypotheses.flatMap((entry) => {
    const payload = entry.payload as { title?: unknown; falsificationTest?: unknown; status?: unknown; implementationRisk?: unknown; computeCostGpuHours?: unknown };
    const title = normalized(payload.title) || entry.id;
    const falsificationTest = normalized(payload.falsificationTest);
    if (!falsificationTest) return [];
    const rawStatus = normalized(payload.status).toLowerCase();
    const status: FalsificationAgendaItem["status"] = rawStatus === "supported" || rawStatus === "rejected" || rawStatus === "inconclusive"
      ? rawStatus
      : tested.has(entry.id) ? "tested" : "untested";
    const riskPenalty = payload.implementationRisk === "high" ? 2 : payload.implementationRisk === "medium" ? 1 : 0;
    const cost = typeof payload.computeCostGpuHours === "number" && Number.isFinite(payload.computeCostGpuHours) ? payload.computeCostGpuHours : 0;
    const priority = (status === "untested" ? 100 : status === "inconclusive" ? 70 : status === "supported" ? 45 : status === "tested" ? 35 : 10) - riskPenalty - Math.min(10, cost);
    return [{ hypothesisId: entry.id, title: title.slice(0, 300), falsificationTest: falsificationTest.slice(0, 800), status, priority, rationale: status === "untested" ? "No terminal experiment has tested this hypothesis." : status === "inconclusive" ? "Prior evidence is inconclusive; design a changed or more discriminating test." : status === "supported" ? "Supported directions still require replication before promotion." : status === "rejected" ? "Rejected direction is retained as negative evidence; do not repeat unchanged." : "A terminal experiment exists; inspect its evidence before scheduling another run." }];
  });
  return candidates.sort((left, right) => right.priority - left.priority || left.hypothesisId.localeCompare(right.hypothesisId)).slice(0, Math.max(1, Math.min(limit, 50)));
}
