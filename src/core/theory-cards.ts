import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./improvement-ledger.js";
import { classifyTechnique } from "./scout.js";

/**
 * Theory cards: every hypothesis carries its mathematics before any compute is spent.
 *
 * A card states the probabilistic model or estimator, which term of the loss decomposition it
 * attacks, its assumptions, what is estimated and how it is cross-fitted (parameters vs data and a
 * selection-noise risk), a back-of-envelope expected gain computed from the data-analysis numbers,
 * and the algorithm with its complexity and integration point. Cards come from three origins:
 * literature/library methods (with citations), inventions fitted to the data's structure, and new
 * theory (assumptions, derivation, falsifiable prediction; flagged new/unproven until the ratchet
 * confirms or falsifies it). The theory ledger records every verdict against its card.
 */

/** Log loss = H(Y|X) + KL(p* || p_hat); the KL term splits into bias (misspecification), variance (estimation) and calibration. */
export const LOSS_TERMS = ["irreducible_entropy", "bias_misspecification", "variance_estimation", "calibration", "coverage_missing_information"] as const;
export type LossTerm = typeof LOSS_TERMS[number];

export const TheoryCardSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(3),
  origin: z.enum(["literature", "invention", "new_theory"]),
  family: z.string().min(1).optional(),
  citations: z.array(z.object({ title: z.string().min(1), sourceId: z.string().optional(), url: z.string().optional(), venue: z.string().optional(), year: z.number().int().optional(), library: z.string().optional() })).default([]),
  /** The probabilistic model / estimator written out, e.g. "p(y|x) = sum_k w_k(x) p_k(y|x), w = softmax(V phi(x))". */
  model: z.string().min(20),
  lossTerm: z.object({ term: z.enum(LOSS_TERMS), why: z.string().min(10) }),
  assumptions: z.array(z.string().min(3)).min(1),
  estimation: z.object({
    estimated: z.string().min(3),
    method: z.string().min(3),
    crossFit: z.string().min(3),
    parameters: z.number().int().nonnegative(),
    dataSize: z.number().int().positive(),
    /** Number of configurations compared on held-out data (drives winner's-curse optimism). */
    selections: z.number().int().positive().default(1),
  }),
  expectedGain: z.object({
    value: z.number(),
    derivation: z.string().min(10),
    /** The data-analysis numbers the estimate uses (segment, share, headroom). */
    inputs: z.object({ segment: z.string().optional(), lossShare: z.number().min(0).max(1).optional(), headroom: z.number().optional(), recoverFraction: z.number().min(0).max(1).optional() }).default({}),
    probability: z.number().min(0).max(1).optional(),
  }),
  algorithm: z.object({ steps: z.string().min(10), complexity: z.string().min(3), integrationPoint: z.string().min(3) }),
  /** Required for new theory: the derivation and a falsifiable prediction on the evaluation data. */
  derivation: z.string().optional(),
  prediction: z.object({ statement: z.string().min(10), segment: z.string().optional(), sign: z.enum(["positive", "negative", "zero"]).default("positive"), minimumEffect: z.number().optional() }).optional(),
  /** Relative compute cost (1 = one reduced screen). */
  cost: z.number().positive().default(1),
});
export type TheoryCard = z.infer<typeof TheoryCardSchema>;

/**
 * Wild cards fill the reserved exploration quota: high variance, low prior, possibly no theory beyond
 * a stated hunch. They are exempt from the full math requirement but still need a falsifiable
 * prediction and a cheap screen, and every hard rule (launch guard, screen gate, budgets) applies.
 */
export const WildCardSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(3),
  origin: z.literal("wild"),
  family: z.string().min(1).optional(),
  hunch: z.string().min(10),
  prediction: z.object({ statement: z.string().min(10), segment: z.string().optional(), sign: z.enum(["positive", "negative", "zero"]).default("positive"), minimumEffect: z.number().optional() }),
  /** Guessed outcome distribution: a mean gain (may be ~0) and a wide spread. */
  expectedGain: z.object({ value: z.number().default(0), spread: z.number().positive().optional(), probability: z.number().min(0).max(1).optional() }).default({}),
  cost: z.number().positive().default(1),
  model: z.string().optional(),
});
export type WildCard = z.infer<typeof WildCardSchema>;
export type AnyCard = TheoryCard | WildCard;
export const isWild = (card: AnyCard): card is WildCard => card.origin === "wild";

export function cardClass(card: AnyCard): string {
  return classifyTechnique({ family: card.family ?? card.title, title: card.title, mechanism: isWild(card) ? `${card.hunch} ${card.model ?? ""}` : card.model });
}

export interface CardIssue { field: string; message: string }

export interface AnalysisNumbers {
  /** Aggregate noise floor (2 SE) from the loss analysis. */
  noiseFloor?: number;
  /** Recoverable score per segment, keyed "column=value". */
  headroom?: Record<string, number>;
  /** Loss share per segment, keyed "column=value". */
  share?: Record<string, number>;
}

/**
 * Winner's-curse optimism of selecting the best of k configurations under noise with standard error
 * se: E[max of k N(0, se^2)] ~ se * sqrt(2 ln k). Parameters fitted per unit of data add a
 * fitting-noise term se * sqrt(p / n); p / n itself is the memorization check. Both are reported, not hidden.
 */
export function selectionNoiseRisk(estimation: TheoryCard["estimation"], standardError?: number): { optimism: number; overfit: number; total: number; ratio: number } {
  const se = standardError ?? 0;
  const optimism = estimation.selections > 1 ? se * Math.sqrt(2 * Math.log(estimation.selections)) : 0;
  // Cross-fitting makes the held-out estimate honest, so p/n is a memorization check (ratio), and the
  // detectable-gain risk is the selection optimism plus the noise of fitting p parameters: se * sqrt(p/n).
  const ratio = estimation.parameters / Math.max(1, estimation.dataSize);
  const overfit = se * Math.sqrt(ratio);
  return { optimism, overfit, total: optimism + overfit, ratio };
}

/** Structural and numeric checks; any issue sends the card back to the director before compute. */
export function validateTheoryCard(raw: unknown, analysis: AnalysisNumbers = {}, options: { wildMaxCost?: number } = {}): { card?: AnyCard; issues: CardIssue[]; risk?: ReturnType<typeof selectionNoiseRisk> } {
  if (raw && typeof raw === "object" && (raw as { origin?: unknown }).origin === "wild") {
    const wild = WildCardSchema.safeParse(raw);
    if (!wild.success) return { issues: wild.error.issues.map((issue) => ({ field: issue.path.join(".") || "card", message: issue.message })) };
    const maxCost = options.wildMaxCost ?? 1;
    const issues: CardIssue[] = wild.data.cost > maxCost ? [{ field: "cost", message: `a wild card must be a cheap screen (cost ${wild.data.cost} > ${maxCost})` }] : [];
    return { card: wild.data, issues };
  }
  const parsed = TheoryCardSchema.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map((issue) => ({ field: issue.path.join(".") || "card", message: issue.message })) };
  const card = parsed.data;
  const issues: CardIssue[] = [];
  if (card.origin === "literature" && !card.citations.length) issues.push({ field: "citations", message: "a literature/library method needs at least one citation" });
  if (card.origin === "new_theory") {
    if (!card.derivation || card.derivation.length < 40) issues.push({ field: "derivation", message: "new theory must derive its estimator from its assumptions" });
    if (!card.prediction) issues.push({ field: "prediction", message: "new theory needs a falsifiable prediction on the evaluation data" });
  }
  if (!/[=~∝]|\bsum\b|\bargmin\b|\bargmax\b|\bE\[|\bp\(|log/.test(card.model)) issues.push({ field: "model", message: "write the model/estimator out (an equation, not a description)" });
  if (!/\d/.test(card.expectedGain.derivation)) issues.push({ field: "expectedGain.derivation", message: "the expected gain must be computed from numbers (loss share, headroom, recover fraction)" });
  const { segment, lossShare, headroom, recoverFraction } = card.expectedGain.inputs;
  const knownHeadroom = segment ? analysis.headroom?.[segment] : undefined;
  const ceiling = headroom ?? knownHeadroom;
  if (segment && analysis.headroom && knownHeadroom === undefined && headroom === undefined) issues.push({ field: "expectedGain.inputs.segment", message: `segment ${segment} is not in the loss analysis` });
  if (ceiling !== undefined && card.expectedGain.value > ceiling + 1e-12) issues.push({ field: "expectedGain.value", message: `expected gain ${card.expectedGain.value} exceeds the measured headroom ${ceiling} for ${segment ?? "the target"}` });
  if (ceiling !== undefined && recoverFraction !== undefined) {
    const implied = ceiling * recoverFraction * (lossShare ?? 1);
    if (Math.abs(implied - card.expectedGain.value) > Math.max(1e-6, 0.5 * Math.abs(implied))) issues.push({ field: "expectedGain.value", message: `value ${card.expectedGain.value} disagrees with its own inputs (headroom x recover x share = ${implied.toPrecision(3)})` });
  }
  const risk = selectionNoiseRisk(card.estimation, analysis.noiseFloor !== undefined ? analysis.noiseFloor / 2 : undefined);
  if (risk.ratio > 0.1) issues.push({ field: "estimation.parameters", message: `parameters/data = ${risk.ratio.toPrecision(2)} > 0.1: the fit will memorize; reduce parameters, pool, or regularize and say how` });
  if (risk.total > 0 && Math.abs(card.expectedGain.value) <= risk.total) issues.push({ field: "expectedGain.value", message: `expected gain ${card.expectedGain.value} is within the selection-noise risk ${risk.total.toPrecision(3)}; the screen cannot detect it` });
  return { card, issues, risk };
}

export interface TheoryVerdict {
  cardId: string;
  experimentId: string;
  title: string;
  origin: AnyCard["origin"];
  techniqueClass: string;
  /** A confirmed wild card is promoted to a normal card; its theory must be written up afterwards. */
  promoted?: boolean;
  theoryPending?: boolean;
  writeup?: string;
  verdict: "confirmed" | "falsified" | "inconclusive";
  ratchetVerdict: string;
  predictedGain: number;
  observedGain: number | null;
  ci?: { lower: number; upper: number };
  /** The card was wrong about mechanism (where or in which direction the effect lands), not only magnitude. */
  mechanismMismatch?: string;
  segmentObserved?: { segment: string; meanImprovement: number; lower: number; upper: number };
  recordedAt: string;
}

export function theoryLedgerPath(stateDir: string): string { return join(stateDir, "theories.json"); }

export function readTheoryLedger(stateDir: string): TheoryVerdict[] {
  try { return JSON.parse(readFileSync(theoryLedgerPath(stateDir), "utf8")) as TheoryVerdict[]; } catch { return []; }
}

/**
 * Turn a ratchet verdict into a theory verdict. Confirmed: CI lower bound above zero (and the
 * predicted segment moved the predicted way). Falsified: the CI excludes the predicted effect
 * (upper bound below the minimum effect, or the predicted segment moved the wrong way). Otherwise
 * inconclusive. A mechanism mismatch is flagged when the aggregate moved but the predicted segment
 * did not (or the reverse): the theory was wrong about where the effect comes from.
 */
export function judgeTheory(card: AnyCard, outcome: { ratchetVerdict: string; observedGain: number | null; ci?: { lower: number; upper: number }; segment?: { segment: string; meanImprovement: number; lower: number; upper: number } }): Pick<TheoryVerdict, "verdict" | "mechanismMismatch"> {
  const minimum = card.prediction?.minimumEffect ?? 0;
  const sign = card.prediction?.sign ?? "positive";
  const ci = outcome.ci;
  let verdict: TheoryVerdict["verdict"] = "inconclusive";
  if (ci) {
    if (sign === "positive") verdict = ci.lower > minimum ? "confirmed" : ci.upper < Math.max(minimum, 0) || ci.upper < card.expectedGain.value * 0.25 ? "falsified" : "inconclusive";
    else if (sign === "negative") verdict = ci.upper < 0 ? "confirmed" : ci.lower > 0 ? "falsified" : "inconclusive";
    else verdict = ci.lower > -Math.abs(minimum || 1e-9) && ci.upper < Math.abs(minimum || 1e-9) ? "confirmed" : "falsified";
  }
  let mechanismMismatch: string | undefined;
  const target = outcome.segment;
  if (target && ci) {
    const aggregateUp = ci.lower > 0;
    const segmentUp = target.lower > 0;
    const segmentDown = target.upper < 0;
    if (aggregateUp && !segmentUp) mechanismMismatch = `the aggregate improved but the predicted segment ${target.segment} did not (${target.meanImprovement.toExponential(2)} [${target.lower.toExponential(2)}, ${target.upper.toExponential(2)}]); the gain came from elsewhere`;
    else if (sign === "positive" && segmentDown) mechanismMismatch = `the predicted segment ${target.segment} moved the wrong way (${target.meanImprovement.toExponential(2)})`;
    if (segmentDown && verdict !== "falsified" && sign === "positive") verdict = "falsified";
  }
  return { verdict, ...(mechanismMismatch ? { mechanismMismatch } : {}) };
}

export function recordTheoryVerdict(stateDir: string, card: AnyCard, entry: Omit<TheoryVerdict, "cardId" | "title" | "origin" | "techniqueClass" | "verdict" | "mechanismMismatch" | "recordedAt" | "predictedGain" | "promoted" | "theoryPending">): TheoryVerdict {
  const ledger = readTheoryLedger(stateDir);
  const judged = judgeTheory(card, { ratchetVerdict: entry.ratchetVerdict, observedGain: entry.observedGain, ci: entry.ci, segment: entry.segmentObserved });
  const cardId = card.id ?? card.title;
  const record: TheoryVerdict = {
    cardId, title: card.title, origin: card.origin, techniqueClass: cardClass(card),
    predictedGain: card.expectedGain.value, recordedAt: new Date().toISOString(), ...entry, ...judged,
    ...(isWild(card) && judged.verdict === "confirmed" ? { promoted: true, theoryPending: true } : {}),
  };
  const next = [...ledger.filter((item) => !(item.cardId === cardId && item.experimentId === entry.experimentId)), record];
  mkdirSync(stateDir, { recursive: true });
  writeFileAtomic(theoryLedgerPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return record;
}

/** Status shown on a card: new/unproven until the ratchet confirms or falsifies it. */
export function cardStatus(card: AnyCard, ledger: readonly TheoryVerdict[]): "new/unproven" | "established" | "wild" | "promoted (theory pending)" | "confirmed" | "falsified" | "inconclusive" {
  const last = ledger.filter((entry) => entry.cardId === (card.id ?? card.title)).at(-1);
  if (last?.theoryPending) return "promoted (theory pending)";
  if (last) return last.verdict;
  return card.origin === "new_theory" ? "new/unproven" : isWild(card) ? "wild" : "established";
}

/** Wild-card wins whose theory still has to be written up as a full card. */
export function pendingTheoryWriteups(ledger: readonly TheoryVerdict[]): TheoryVerdict[] {
  const latest = new Map<string, TheoryVerdict>();
  for (const entry of ledger) latest.set(entry.cardId, entry);
  return [...latest.values()].filter((entry) => entry.theoryPending);
}

/** Close a promoted wild card's write-up once a full theory card for it validates. */
export function completeTheoryWriteup(stateDir: string, cardId: string, card: TheoryCard): boolean {
  const ledger = readTheoryLedger(stateDir);
  let changed = false;
  const next = ledger.map((entry) => entry.cardId === cardId && entry.theoryPending ? (changed = true, { ...entry, theoryPending: false, writeup: card.title } as TheoryVerdict) : entry);
  if (changed) writeFileAtomic(theoryLedgerPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return changed;
}

export interface RankedCard { card: AnyCard; probability: number; expectedValue: number; score: number; reason: string }

/**
 * Rank by expected gain x probability / cost. Probability blends the card's own estimate with the
 * class prior from previous theory verdicts (Beta(1,1) posterior of confirmations); new theory is
 * discounted until something in its class has been confirmed.
 */
export function rankTheoryCards(cards: readonly AnyCard[], ledger: readonly TheoryVerdict[]): RankedCard[] {
  return cards.map((card) => {
    const techniqueClass = cardClass(card);
    const history = ledger.filter((entry) => entry.techniqueClass === techniqueClass && entry.verdict !== "inconclusive");
    const confirmed = history.filter((entry) => entry.verdict === "confirmed").length;
    const prior = (confirmed + 1) / (history.length + 2);
    const own = card.expectedGain.probability ?? 0.5;
    const discount = card.origin === "new_theory" && confirmed === 0 ? 0.7 : 1;
    const probability = Math.min(1, Math.max(0, (0.5 * own + 0.5 * prior) * discount));
    const expectedValue = card.expectedGain.value * probability;
    const score = expectedValue / card.cost;
    return { card, probability, expectedValue, score, reason: `gain ${card.expectedGain.value.toPrecision(3)} x p ${probability.toFixed(2)} (own ${own.toFixed(2)}, ${techniqueClass} prior ${confirmed}/${history.length}) / cost ${card.cost}` };
  }).sort((left, right) => right.score - left.score);
}

/**
 * Breadth rule for a round: literature-mined methods and inventions/new theory must both be present
 * when both are available, and no technique class may appear twice (the scout diversity rule).
 */
export function roundBreadthIssues(cards: readonly AnyCard[]): string[] {
  const issues: string[] = [];
  const origins = new Set(cards.map((card) => card.origin));
  if (cards.length >= 2 && !origins.has("literature")) issues.push("no literature/library-mined method in the round");
  if (cards.length >= 2 && !origins.has("invention") && !origins.has("new_theory") && !origins.has("wild")) issues.push("no new invention or theory fitted to the data's structure in the round");
  const classes = cards.map(cardClass);
  const duplicates = classes.filter((value, index) => classes.indexOf(value) !== index);
  if (duplicates.length) issues.push(`technique classes repeated in one round: ${[...new Set(duplicates)].join(", ")}`);
  return issues;
}

export interface WildScore { card: WildCard; techniqueClass: string; mean: number; spread: number; novelty: number; score: number; reason: string }

/**
 * Exploration score for wild cards: an upper-confidence bound over the guessed outcome distribution
 * plus a novelty bonus against the tried-classes ledger. score = mean + kappa * spread * (1 + novelty),
 * novelty = 1 / (1 + tries of the class). Variance and novelty are rewarded; expected gain alone is not
 * what picks within the quota. Spread defaults to the noise floor (or the class's observed spread).
 */
export function scoreWildCards(cards: readonly WildCard[], triedClasses: Readonly<Record<string, number>>, options: { kappa?: number; defaultSpread?: number } = {}): WildScore[] {
  const kappa = options.kappa ?? 2;
  return cards.map((card) => {
    const techniqueClass = cardClass(card);
    const tries = triedClasses[techniqueClass] ?? 0;
    const novelty = 1 / (1 + tries);
    const mean = card.expectedGain.value;
    const spread = card.expectedGain.spread ?? options.defaultSpread ?? 0.001;
    const score = (mean + kappa * spread * (1 + novelty)) / card.cost;
    return { card, techniqueClass, mean, spread, novelty, score, reason: `UCB ${mean.toPrecision(2)} + ${kappa} x ${spread.toPrecision(2)} x (1 + novelty ${novelty.toFixed(2)}, ${tries} tries of ${techniqueClass}) / cost ${card.cost}` };
  }).sort((left, right) => right.score - left.score);
}

export interface IdeationRoundPlan {
  selected: Array<{ card: AnyCard; techniqueClass: string; slot: "ranked" | "wild"; score: number; reason: string }>;
  deferred: Array<{ card: AnyCard; reason: string }>;
  wildSlots: number;
  breadthIssues: string[];
}

/**
 * Plan one ideation round: reserve ceil(screens x wildQuota) slots for wild cards (picked by
 * scoreWildCards), fill the rest by expected gain x probability / cost, and keep technique classes
 * distinct across the whole round. Unused wild slots fall back to ranked cards. The screen gate
 * still decides what is kept; this only orders what is screened.
 */
export function planIdeationRound(cards: readonly AnyCard[], ledger: readonly TheoryVerdict[], options: { screens: number; wildQuota?: number; triedClasses?: Readonly<Record<string, number>>; defaultSpread?: number }): IdeationRoundPlan {
  const screens = Math.max(0, Math.floor(options.screens));
  const quota = Math.min(1, Math.max(0, options.wildQuota ?? 0.2));
  const wild = cards.filter(isWild);
  const normal = cards.filter((card): card is TheoryCard => !isWild(card));
  const tried: Record<string, number> = { ...(options.triedClasses ?? {}) };
  for (const entry of ledger) tried[entry.techniqueClass] = (tried[entry.techniqueClass] ?? 0) + 1;
  const wildSlots = wild.length && quota > 0 && screens > 0 ? Math.min(wild.length, Math.max(1, Math.ceil(screens * quota - 1e-9))) : 0;
  const used = new Set<string>();
  const plan: IdeationRoundPlan = { selected: [], deferred: [], wildSlots, breadthIssues: [] };
  for (const scored of scoreWildCards(wild, tried, { defaultSpread: options.defaultSpread })) {
    if (plan.selected.length < wildSlots && !used.has(scored.techniqueClass)) {
      used.add(scored.techniqueClass);
      plan.selected.push({ card: scored.card, techniqueClass: scored.techniqueClass, slot: "wild", score: scored.score, reason: scored.reason });
    } else plan.deferred.push({ card: scored.card, reason: used.has(scored.techniqueClass) ? `class ${scored.techniqueClass} already in this round` : "wild quota full" });
  }
  for (const ranked of rankTheoryCards(normal, ledger)) {
    const techniqueClass = cardClass(ranked.card);
    if (plan.selected.length < screens && !used.has(techniqueClass)) {
      used.add(techniqueClass);
      plan.selected.push({ card: ranked.card, techniqueClass, slot: "ranked", score: ranked.score, reason: ranked.reason });
    } else plan.deferred.push({ card: ranked.card, reason: used.has(techniqueClass) ? `class ${techniqueClass} already in this round` : "round full" });
  }
  plan.breadthIssues = roundBreadthIssues(plan.selected.map((entry) => entry.card));
  return plan;
}

/** Headroom, shares and the noise floor from a loss-analysis brief (lossAnalysisBrief). */
export function analysisNumbersFromBrief(brief: unknown): AnalysisNumbers {
  if (!brief || typeof brief !== "object") return {};
  const value = brief as { noiseFloor?: { minimumDetectableAggregateChange?: number }; gapTable?: Array<{ segment: string; unitShare: number; recoverableToMean: number; recoverableToBestRun?: number }> };
  const headroom: Record<string, number> = {};
  const share: Record<string, number> = {};
  for (const row of value.gapTable ?? []) {
    headroom[row.segment] = Math.max(row.recoverableToMean, row.recoverableToBestRun ?? -Infinity);
    share[row.segment] = row.unitShare;
  }
  return { ...(typeof value.noiseFloor?.minimumDetectableAggregateChange === "number" ? { noiseFloor: value.noiseFloor.minimumDetectableAggregateChange } : {}), ...(Object.keys(headroom).length ? { headroom, share } : {}) };
}

export const THEORY_CARD_INSTRUCTIONS = [
  "Every hypothesis carries theoryCard (JSON). Cards missing math are sent back before any compute is spent.",
  "Round breadth: mix (a) methods mined from literature/libraries (call literature.search or research.sources first and cite them: origin literature, citations with sourceId/url) and (b) inventions fitted to this data's structure (origin invention). One technique class per round.",
  "Full card: model (the probabilistic model/estimator as an equation); lossTerm.term (log loss = H(Y|X) + KL(p*||p_hat); the KL splits into bias_misspecification, variance_estimation, calibration; or coverage_missing_information) and why; assumptions; estimation {estimated, method, crossFit, parameters, dataSize, selections}; expectedGain {value, derivation with the numbers, inputs {segment, lossShare, headroom, recoverFraction} taken from lossAnalysis.gapTable, probability}; algorithm {steps, complexity, integrationPoint}; cost (1 = one reduced screen).",
  "New theory (origin new_theory) is allowed when no known estimator fits: state assumptions, give derivation, and a falsifiable prediction {statement, segment, sign, minimumEffect}. It is flagged new/unproven until the ratchet confirms or falsifies it.",
  "Wild cards (origin wild) fill a reserved exploration quota: a hunch, a falsifiable prediction, a cheap screen (cost <= wildMaxCost), optionally expectedGain {value, spread}. Crazy out-of-the-box ideas belong here.",
  "Promoted wild cards (pendingWriteups) need their theory written up as a full card.",
];

export function ideationBrief(ledger: readonly TheoryVerdict[], options: { wildQuota: number; wildMaxCost: number; sentBack?: Array<{ title?: string; issues: string[] }> }): Record<string, unknown> {
  return {
    instructions: THEORY_CARD_INSTRUCTIONS,
    wildQuota: options.wildQuota,
    wildMaxCost: options.wildMaxCost,
    theoryLedger: ledger.slice(-12).map((entry) => ({ title: entry.title, origin: entry.origin, techniqueClass: entry.techniqueClass, verdict: entry.verdict, predictedGain: entry.predictedGain, observedGain: entry.observedGain, ...(entry.mechanismMismatch ? { mechanismMismatch: entry.mechanismMismatch } : {}) })),
    pendingWriteups: pendingTheoryWriteups(ledger).map((entry) => ({ cardId: entry.cardId, title: entry.title, observedGain: entry.observedGain })),
    ...(options.sentBack?.length ? { sentBack: options.sentBack } : {}),
  };
}

export function loadCardFile(path: string): unknown {
  if (!existsSync(path)) throw new Error(`theory card not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}
