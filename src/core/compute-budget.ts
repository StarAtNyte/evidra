export interface GpuBudgetInput {
  budgetGpuHours?: number;
  usedGpuHours: number;
  requestedGpuHours: number;
  executor: string;
  gpu?: string;
}

export interface GpuBudgetDecision {
  allowed: boolean;
  limited: boolean;
  budgetGpuHours: number | null;
  usedGpuHours: number;
  requestedGpuHours: number;
  remainingGpuHours: number | null;
  reason: string;
}

/**
 * Enforce a campaign GPU budget before a worker is launched. Zero/undefined
 * means unlimited because many CPU-only research campaigns have no GPU cost.
 * The decision is deterministic and independent of the selected executor.
 */
export function evaluateGpuBudget(input: GpuBudgetInput): GpuBudgetDecision {
  const used = Math.max(0, Number.isFinite(input.usedGpuHours) ? input.usedGpuHours : 0);
  const requested = Math.max(0, Number.isFinite(input.requestedGpuHours) ? input.requestedGpuHours : 0);
  const budget = input.budgetGpuHours !== undefined && Number.isFinite(input.budgetGpuHours) && input.budgetGpuHours > 0 ? input.budgetGpuHours : undefined;
  if (requested === 0 || !input.gpu || !budget) {
    return { allowed: true, limited: Boolean(budget), budgetGpuHours: budget ?? null, usedGpuHours: used, requestedGpuHours: requested, remainingGpuHours: budget ? Math.max(0, budget - used) : null, reason: requested === 0 || !input.gpu ? "no GPU budget is required for this run" : "GPU budget is unlimited" };
  }
  const remaining = budget - used;
  const allowed = requested <= remaining + 1e-9;
  return { allowed, limited: true, budgetGpuHours: budget, usedGpuHours: used, requestedGpuHours: requested, remainingGpuHours: Math.max(0, remaining), reason: allowed ? `within ${budget} GPU-hour campaign budget` : `requested ${requested} GPU-hours exceeds the ${Math.max(0, remaining)} GPU-hours remaining` };
}
