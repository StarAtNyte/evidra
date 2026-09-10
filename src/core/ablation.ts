import { z } from "zod";

export const AblationFactorSchema = z.object({
  id: z.string().min(1).max(80),
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/),
  label: z.string().min(1).max(160),
  disabledValue: z.unknown(),
});

export const AblationVariantSchema = z.object({
  id: z.string().min(1),
  factorId: z.string().min(1),
  label: z.string().min(1),
  configPatch: z.record(z.string(), z.unknown()),
  control: z.boolean(),
});

export const AblationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  hypothesisId: z.string().min(1),
  factors: z.array(AblationFactorSchema).min(1).max(8),
  variants: z.array(AblationVariantSchema).min(2).max(9),
  design: z.literal("leave-one-factor-out"),
});

export type AblationFactor = z.infer<typeof AblationFactorSchema>;
export type AblationPlan = z.infer<typeof AblationPlanSchema>;

/** Build a deterministic control plus leave-one-factor-out variants. */
export function createAblationPlan(input: { hypothesisId: string; factors: AblationFactor[] }): AblationPlan {
  const factors = input.factors.slice(0, 8).map((factor) => AblationFactorSchema.parse(factor));
  if (factors.length < 1) throw new Error("At least one ablation factor is required.");
  const ids = new Set<string>();
  for (const factor of factors) {
    if (ids.has(factor.id)) throw new Error(`Duplicate ablation factor: ${factor.id}`);
    ids.add(factor.id);
  }
  const variants = [
    { id: `${input.hypothesisId}:control`, factorId: "control", label: "Full proposed configuration", configPatch: {}, control: true },
    ...factors.map((factor) => ({
      id: `${input.hypothesisId}:without:${factor.id}`,
      factorId: factor.id,
      label: `Without ${factor.label}`,
      configPatch: { [factor.key]: factor.disabledValue },
      control: false,
    })),
  ];
  return AblationPlanSchema.parse({ schemaVersion: 1, hypothesisId: input.hypothesisId, factors, variants, design: "leave-one-factor-out" });
}

/** Read valid plans from durable events and keep the newest plan per hypothesis. */
export function ablationPlansFromEvents(events: Array<{ type: string; payload: unknown }>, limit = 8): AblationPlan[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event.type === "research.ablation.plan")
    .map((event) => AblationPlanSchema.safeParse(event.payload))
    .filter((result): result is { success: true; data: AblationPlan } => result.success)
    .map((result) => result.data)
    .filter((plan) => {
      if (seen.has(plan.hypothesisId)) return false;
      seen.add(plan.hypothesisId);
      return true;
    })
    .slice(0, Math.max(0, Math.min(limit, 20)));
}
