import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import type { CompetitionConfig } from "./types.js";

export const SPLIT_STRATEGIES = [
  { id: "random_holdout", description: "Random train/validation holdout." },
  { id: "stratified_kfold", description: "Stratified K-fold validation." },
  { id: "group_kfold", description: "Group-disjoint K-fold validation." },
  { id: "stratified_group_kfold", description: "Stratified and group-disjoint K-fold validation." },
  { id: "temporal_forward", description: "Forward-only temporal validation." },
  { id: "leave_one_domain_out", description: "Leave one source or domain out." },
  { id: "custom", description: "A workspace-defined split implementation." },
] as const;

export function splitStrategy(id: string): { id: string; description: string } {
  return SPLIT_STRATEGIES.find((strategy) => strategy.id === id) ?? { id, description: "Workspace-defined split strategy." };
}

export const ValidationPolicySchema = z.object({
  version: z.string().min(1),
  datasetRevision: z.string().min(1),
  primarySplit: z.string().min(1),
  folds: z.array(z.number().int().nonnegative()).min(1),
  seeds: z.array(z.number().int()).min(1),
  metric: z.object({ name: z.string(), direction: z.enum(["minimize", "maximize"]) }),
  acceptance: z.object({ minimumDelta: z.number(), requireReplication: z.boolean(), requireLeakageAudit: z.boolean(), requireReview: z.boolean() }),
  createdAt: z.string().datetime(),
});
export type ValidationPolicy = z.infer<typeof ValidationPolicySchema>;

export function createValidationPolicy(competition: CompetitionConfig): ValidationPolicy {
  const split = competition.validation?.primarySplit ?? "mini";
  const folds = competition.validation?.folds ?? [0];
  const seeds = competition.validation?.seeds ?? [0, 1, 2];
  return ValidationPolicySchema.parse({
    version: `${competition.id}:${competition.datasetRevision}:${split}-v1`,
    datasetRevision: competition.datasetRevision,
    primarySplit: split,
    folds,
    seeds,
    metric: competition.metric,
    acceptance: { minimumDelta: competition.metric.direction === "minimize" ? -0.002 : 0.002, requireReplication: true, requireLeakageAudit: true, requireReview: true },
    createdAt: new Date().toISOString(),
  });
}

export function writeValidationPolicy(path: string, policy: ValidationPolicy): string {
  const serialized = `${JSON.stringify(policy, null, 2)}\n`;
  writeFileSync(path, serialized);
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}
