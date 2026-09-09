import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import type { CompetitionConfig } from "./types.js";

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
  return ValidationPolicySchema.parse({
    version: `${competition.id}:${competition.datasetRevision}:mini-v1`,
    datasetRevision: competition.datasetRevision,
    primarySplit: "mini",
    folds: [0],
    seeds: [0, 1, 2],
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
