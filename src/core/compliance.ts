import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
/** Same file as the repair escalations (self-repair.escalationPath); kept local to avoid an import cycle with types.ts. */
const escalationPath = (stateDir: string): string => join(stateDir, "ESCALATIONS.md");

/**
 * Compliance gate for ideas. The competition lists its hard rules; every card declares the data it
 * touches and the rules it could brush against, plus the director's self-critique. A deterministic
 * review (declared data vs allowed data, rule keywords, sensitive datasets) and the self-critique
 * mark a card compliant, needs_human_ruling or rejected. needs_human_ruling cards are never screened
 * automatically: they are escalated to ESCALATIONS.md until a human ruling is recorded in config.
 */

export const ComplianceRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** Data-access tags that break this rule outright (declaring one rejects the card). */
  forbiddenData: z.array(z.string()).default([]),
  /** Phrases that suggest the idea brushes against the rule (needs a human ruling). */
  keywords: z.array(z.string()).default([]),
  /** Datasets where this rule is sensitive, and the phrases that trigger it there. */
  sensitiveDatasets: z.array(z.string()).default([]),
  sensitiveKeywords: z.array(z.string()).default([]),
});
export type ComplianceRule = z.infer<typeof ComplianceRuleSchema>;

export const ComplianceConfigSchema = z.object({
  /** Data-access tags a card may declare without review (e.g. given_columns, visible_answers). */
  allowedData: z.array(z.string()).default([]),
  rules: z.array(ComplianceRuleSchema).default([]),
  /** Human rulings: the only way a needs_human_ruling card can be screened (or a card overruled). */
  rulings: z.array(z.object({ card: z.string().min(1), datasets: z.array(z.string()).optional(), status: z.enum(["compliant", "rejected"]), by: z.string().min(1), note: z.string().optional() })).default([]),
});
export type ComplianceConfig = z.infer<typeof ComplianceConfigSchema>;

/** What each card must declare. */
export const ComplianceDeclarationSchema = z.object({
  dataAccess: z.array(z.string().min(1)).min(1),
  ruleRisks: z.array(z.object({ rule: z.string().min(1), why: z.string().min(5) })).default([]),
  /** The director's self-critique per rule it considered: clear, brushes (ask a human) or violates. */
  selfCritique: z.array(z.object({ rule: z.string().min(1), verdict: z.enum(["clear", "brushes", "violates"]), argument: z.string().min(10) })).default([]),
  scope: z.object({ datasets: z.array(z.string()).default([]) }).default({}),
});
export type ComplianceDeclaration = z.infer<typeof ComplianceDeclarationSchema>;

export type ComplianceStatus = "compliant" | "needs_human_ruling" | "rejected";
export interface ComplianceReview { cardId: string; status: ComplianceStatus; reasons: string[]; rules: string[]; ruling?: ComplianceConfig["rulings"][number] }

function cardText(card: Record<string, unknown>): string {
  const skip = new Set(["citations", "dataAccess", "ruleRisks", "selfCritique", "scope"]);
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) if (!skip.has(key)) walk(inner);
  };
  walk(card);
  return parts.join(" \n ").toLowerCase();
}

/** A phrase counts unless it is directly negated ("no record linkage", "without hidden labels"). */
function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^a-z])${escaped}`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const before = text.slice(Math.max(0, match.index - 24), match.index + match[1].length);
    if (!/\b(no|not|never|without|avoid(s|ing)?|nor)\b[^.;:]*$/.test(before)) return true;
  }
  return false;
}

export function reviewCompliance(card: Record<string, unknown>, config: ComplianceConfig | undefined): ComplianceReview {
  const cardId = String(card.id ?? card.title ?? "card");
  if (!config || (!config.rules.length && !config.allowedData.length)) return { cardId, status: "compliant", reasons: ["no compliance rules configured"], rules: [] };
  const declared = ComplianceDeclarationSchema.safeParse(card);
  if (!declared.success) return { cardId, status: "rejected", reasons: [`compliance declaration missing: ${declared.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`], rules: [] };
  const declaration = declared.data;
  const datasets = declaration.scope.datasets;
  const ruling = config.rulings.find((entry) => entry.card === cardId && (!entry.datasets || datasets.every((dataset) => entry.datasets!.includes(dataset))));
  const reject: string[] = [];
  const human: string[] = [];
  const rules = new Set<string>();
  const text = cardText(card);
  const known = new Set(config.rules.map((rule) => rule.id));
  for (const tag of declaration.dataAccess) {
    const breaking = config.rules.filter((rule) => rule.forbiddenData.includes(tag));
    if (breaking.length) { reject.push(`declares forbidden data "${tag}" (${breaking.map((rule) => rule.id).join(", ")})`); breaking.forEach((rule) => rules.add(rule.id)); }
    else if (config.allowedData.length && !config.allowedData.includes(tag)) human.push(`declares data "${tag}" outside the allowed set (${config.allowedData.join(", ")})`);
  }
  for (const risk of declaration.ruleRisks) {
    rules.add(risk.rule);
    human.push(`card declares it could brush against ${risk.rule}: ${risk.why}`);
    if (!known.has(risk.rule)) human.push(`unknown rule "${risk.rule}"`);
  }
  for (const critique of declaration.selfCritique) {
    if (critique.verdict === "violates") { rules.add(critique.rule); reject.push(`self-critique: violates ${critique.rule}: ${critique.argument}`); }
    else if (critique.verdict === "brushes") { rules.add(critique.rule); human.push(`self-critique: brushes ${critique.rule}: ${critique.argument}`); }
  }
  for (const rule of config.rules) {
    const hits = rule.keywords.filter((phrase) => mentions(text, phrase));
    if (hits.length) { rules.add(rule.id); human.push(`${rule.id}: mentions ${hits.map((hit) => `"${hit}"`).join(", ")}`); }
    const sensitive = datasets.filter((dataset) => rule.sensitiveDatasets.includes(dataset));
    if (sensitive.length) {
      const sensitiveHits = rule.sensitiveKeywords.filter((phrase) => mentions(text, phrase));
      if (sensitiveHits.length) { rules.add(rule.id); human.push(`${rule.id}: ${sensitiveHits.map((hit) => `"${hit}"`).join(", ")} on sensitive dataset ${sensitive.join(", ")}`); }
    }
    if (declaration.ruleRisks.length === 0 && !declaration.selfCritique.some((critique) => critique.rule === rule.id) && (hits.length || sensitive.length)) human.push(`${rule.id}: the card neither declares this risk nor critiques it`);
  }
  if (ruling) return { cardId, status: ruling.status, reasons: [`human ruling by ${ruling.by}${ruling.note ? `: ${ruling.note}` : ""}`, ...reject, ...human], rules: [...rules], ruling };
  if (reject.length) return { cardId, status: "rejected", reasons: [...reject, ...human], rules: [...rules] };
  if (human.length) return { cardId, status: "needs_human_ruling", reasons: human, rules: [...rules] };
  return { cardId, status: "compliant", reasons: [], rules: [] };
}

/** Escalate a card that needs a human ruling (once per card and reason set). Returns true when written. */
export function escalateCompliance(stateDir: string, review: ComplianceReview, card: { title?: string }): boolean {
  const path = escalationPath(stateDir);
  const marker = `<!-- compliance:${review.cardId}:${review.rules.sort().join(",")} -->`;
  if (existsSync(path) && readFileSync(path, "utf8").includes(marker)) return false;
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "# Escalations\n\nFixes the repair agent may not apply on its own. The rest of the campaign keeps running.\n");
  appendFileSync(path, [
    "",
    `## ${new Date().toISOString()} ${review.cardId} (compliance: needs a human ruling)`,
    marker,
    "",
    `- Idea: ${card.title ?? review.cardId}`,
    `- Rules: ${review.rules.join(", ") || "unspecified"}`,
    ...review.reasons.map((reason) => `- ${reason}`),
    `- Not screened. To allow it, add {"card": "${review.cardId}", "status": "compliant", "by": "<name>"} to compliance.rulings (or "rejected" to close it).`,
    "",
  ].join("\n"));
  return true;
}
