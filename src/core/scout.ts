/**
 * Scout mode: broad, cheap exploration across technique classes.
 *
 * The failure it targets is a director that proposes knob variations of a
 * single path. Each scout round asks for N hypotheses from N *different*
 * technique classes, screens each with the reduced evaluator, and promotes
 * only the best screens to full evaluation. A tried-classes ledger keeps a
 * class on cooldown after it has been screened without a gain, so the next
 * round has to go somewhere else (the FAMILIES.md rule, enforced in code).
 *
 * The class taxonomy plays the role of K-Search's root-level branches: every
 * untried class stays an open branch, and selection is deterministic code,
 * not an LLM preference.
 */

export interface TechniqueClass {
  id: string;
  label: string;
  /** Lowercase keywords; the class with the most weighted hits wins. */
  keywords: string[];
  /** Concrete starting points offered to the director when the class is untried. */
  examples: string[];
  /** True for parameter or budget tweaks of an existing method: never counts as broad exploration. */
  knob?: boolean;
}

export const TECHNIQUE_CLASSES: readonly TechniqueClass[] = [
  { id: "linear_glm", label: "linear / generalized linear models", keywords: ["logistic regression", "linear", "ridge", "lasso", "elastic net", "glm", "multinomial", "softmax regression", "poisson", "lr"], examples: ["regularized multinomial GLM with interactions", "reduced-rank regression"] },
  { id: "tree_ensemble", label: "tree ensembles", keywords: ["gbdt", "gradient boost", "boost", "xgboost", "lightgbm", "catboost", "random forest", "extra trees", "hgb", "decision tree", "decision forest", "regression tree"], examples: ["LightGBM with monotone constraints", "oblique / soft decision trees"] },
  { id: "neighbors_retrieval", label: "nearest neighbours / retrieval / case-based", keywords: ["knn", "nearest", "neighbour", "neighbor", "retrieval", "case-based", "prototype", "kernel density", "similarity", "exemplar"], examples: ["metric-learned kNN", "retrieval-augmented prediction"] },
  { id: "neural_net", label: "neural networks trained from scratch", keywords: ["mlp", "neural", "transformer", "attention", "cnn", "rnn", "lstm", "autoencoder", "deep", "embedding", "contrastive", "set model", "resnet"], examples: ["masked-feature transformer over rows", "denoising autoencoder"] },
  { id: "foundation_pretrained", label: "pretrained / foundation models and LLMs", keywords: ["tabpfn", "tabicl", "pretrained", "foundation", "llm", "language model", "fine-tun", "finetun", "in-context", "zero-shot", "few-shot", "lora", "prompt"], examples: ["tabular foundation model in-context", "LLM features or LLM-as-predictor"] },
  { id: "probabilistic_graphical", label: "probabilistic graphical models / dependence structure", keywords: ["bayesian network", "graphical model", "chow-liu", "tree-augmented", "markov", "crf", "copula", "factor graph", "dependency network", "ising"], examples: ["Chow-Liu tree over targets", "Gaussian / discrete copula"] },
  { id: "latent_variable", label: "latent-variable / low-rank models", keywords: ["latent class", "latent", "mixture model", "irt", "item response", "factor analysis", "low-rank", "low rank", "matrix factorization", "pca", "topic model", "em algorithm"], examples: ["latent-class mixture", "IRT / factor model"] },
  { id: "hierarchical_bayes", label: "hierarchical Bayes / shrinkage", keywords: ["hierarchical", "shrinkage", "partial pooling", "empirical bayes", "multilevel", "dirichlet", "random effects", "varying-coefficient", "bayesian", "bayes", "context tree"], examples: ["partial pooling by segment", "empirical-Bayes priors"] },
  { id: "ensemble_stacking", label: "ensembling / stacking / pooling", keywords: ["stacking", "stacker", "blend", "ensemble", "pooling", "pool", "bagging", "averaging", "product of experts", "super learner"], examples: ["cross-fitted stacker", "log-linear pooling"] },
  { id: "routing_gating", label: "routing / gating / per-segment selection", keywords: ["routing", "router", "gate", "gated", "gating", "mixture of experts", "moe", "per-segment", "per segment", "switch", "selector"], examples: ["learned router between models by segment", "per-segment model selection"] },
  { id: "calibration_scoring", label: "calibration / proper-scoring post-processing", keywords: ["calibration", "calibrate", "temperature", "platt", "isotonic", "proper scoring", "recalibrat", "dirichlet calibration", "conformal"], examples: ["cross-fitted temperature per segment", "isotonic / beta calibration"] },
  { id: "symbolic_rules", label: "symbolic / rule-based / program synthesis", keywords: ["rule", "symbolic", "decision list", "program synthesis", "mdl", "conjunction", "logic", "grammar"], examples: ["MDL rule lists", "symbolic regression"] },
  { id: "data_centric", label: "data-centric: augmentation, reweighting, cleaning, self-training", keywords: ["augment", "reweight", "resampl", "denois", "clean", "pseudo-label", "pseudo label", "self-training", "distill", "synthetic data", "imputation", "impute", "curriculum", "hard example", "label noise"], examples: ["importance reweighting toward the test distribution", "pseudo-labelling unlabeled rows"] },
  { id: "feature_engineering", label: "feature engineering / representation", keywords: ["feature", "encoding", "target encoding", "interaction", "binning", "embedding of categories", "feature selection", "transform"], examples: ["target encoding with cross-fitting", "learned interaction features"] },
  { id: "sequential_joint", label: "joint / autoregressive / structured prediction", keywords: ["autoregressive", "chained", "chain", "sequential", "joint prediction", "structured prediction", "multi-output", "multi-task", "multitask"], examples: ["classifier chains over targets", "multi-task shared encoder"] },
  { id: "analytic_simulation", label: "analytic / closed-form / simulation", keywords: ["closed-form", "closed form", "analytic", "monte carlo", "simulation", "numerical", "quadrature", "cubature", "exact"], examples: ["closed-form estimator", "variance-reduced Monte Carlo"] },
  { id: "efficiency_budget", label: "efficiency / compute budget reallocation", keywords: ["speed", "faster", "parallel", "cache", "vectoriz", "compile", "budget", "deadline", "wall time", "latency", "throughput"], examples: ["spend saved compute on a stronger model", "reallocate the time budget between components"], knob: true },
  { id: "hyperparameter_tuning", label: "hyperparameter tuning of the current method", keywords: ["hyperparameter", "tuning", "tune", "sweep", "learning rate", "regularization strength", "optuna", "grid search", "bayesian optimization", "knob", "threshold"], examples: ["per-segment hyperparameter selection (cross-fitted)"], knob: true },
];

const CLASS_BY_ID = new Map(TECHNIQUE_CLASSES.map((entry) => [entry.id, entry]));

function hits(text: string, keyword: string): number {
  if (!text) return 0;
  // Keywords match at a word start ("reweight" matches "reweighting", "ising" does not match "denoising");
  // short ones must be whole words so "em" or "lr" do not fire inside other words.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z])${escaped}${keyword.length <= 3 ? "([^a-z]|$)" : ""}`).test(text) ? 1 : 0;
}

/** Map a free-text hypothesis to a technique class; family weighs most, then title, then mechanism. */
export function classifyTechnique(input: { family?: string; title?: string; mechanism?: string; proposedChange?: string }): string {
  const family = (input.family ?? "").toLowerCase();
  const title = (input.title ?? "").toLowerCase();
  const mechanism = `${input.mechanism ?? ""} ${input.proposedChange ?? ""}`.toLowerCase();
  let best: { id: string; score: number } | undefined;
  for (const entry of TECHNIQUE_CLASSES) {
    let score = 0;
    for (const keyword of entry.keywords) score += 4 * hits(family, keyword) + 2 * hits(title, keyword) + 0.5 * hits(mechanism, keyword);
    // On a tie a knob class wins: "TabICL tuning" is a tuning step, not a new foundation-model attempt.
    if (score > 0 && (!best || score > best.score || (score === best.score && entry.knob))) best = { id: entry.id, score };
  }
  if (best) return best.id;
  const fallback = family.trim().replace(/\s+/g, " ") || title.trim().replace(/\s+/g, " ") || "unspecified";
  return `other:${fallback.slice(0, 48)}`;
}

export function techniqueLabel(id: string): string {
  return CLASS_BY_ID.get(id)?.label ?? id.replace(/^other:/, "");
}

export interface ScoutPolicy {
  enabled: boolean;
  /** Hypotheses (distinct classes) screened per round. */
  width: number;
  /** Screens promoted to full evaluation per round. */
  promoteTop: number;
  /** A class screened without a gain is skipped until this many other classes have been tried since. */
  cooldown: number;
  /** A screen must beat the reference screen by at least this (oriented) to be promoted. */
  minScreenDelta: number;
  /** Knob classes (tuning, budget) allowed per round. */
  maxKnobsPerRound: number;
  /** Reference reduced-evaluator metric when the champion has no recorded screen. */
  referenceScreenMetric?: number;
}

export const DEFAULT_SCOUT_POLICY: ScoutPolicy = { enabled: false, width: 4, promoteTop: 1, cooldown: 4, minScreenDelta: 0, maxKnobsPerRound: 1 };

export function resolveScoutPolicy(config: Partial<ScoutPolicy> | undefined, overrideWidth?: number): ScoutPolicy {
  const merged = { ...DEFAULT_SCOUT_POLICY, ...Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined)) } as ScoutPolicy;
  if (overrideWidth !== undefined && Number.isFinite(overrideWidth) && overrideWidth > 0) { merged.enabled = true; merged.width = overrideWidth; }
  merged.width = Math.max(2, Math.min(5, Math.floor(merged.width)));
  merged.promoteTop = Math.max(1, Math.min(merged.width, Math.floor(merged.promoteTop)));
  merged.cooldown = Math.max(0, Math.floor(merged.cooldown));
  return merged;
}

export interface ScoutLedgerEntry {
  experimentId: string;
  techniqueClass: string;
  family: string;
  title: string;
  stage: "screen" | "full";
  /** Oriented improvement over the reference (positive is better); null when unmeasured. */
  improvement: number | null;
  valid: boolean;
  promoted?: boolean;
  accepted?: boolean;
  recordedAt?: string;
}

export interface ScoutClassSummary {
  techniqueClass: string;
  label: string;
  screens: number;
  fulls: number;
  bestImprovement: number | null;
  accepted: number;
  /** Distinct other classes tried since this class was last tried. */
  othersSinceLast: number;
  coolingDown: boolean;
}

/** Summarize the tried-classes ledger. Entries are oldest first. */
export function summarizeScoutLedger(entries: readonly ScoutLedgerEntry[], policy: Pick<ScoutPolicy, "cooldown">): ScoutClassSummary[] {
  const byClass = new Map<string, ScoutClassSummary & { lastIndex: number; validEntries: number }>();
  entries.forEach((entry, index) => {
    const summary = byClass.get(entry.techniqueClass) ?? { techniqueClass: entry.techniqueClass, label: techniqueLabel(entry.techniqueClass), screens: 0, fulls: 0, bestImprovement: null, accepted: 0, othersSinceLast: 0, coolingDown: false, lastIndex: index, validEntries: 0 };
    if (entry.valid) summary.validEntries += 1;
    if (entry.stage === "screen") summary.screens += 1; else summary.fulls += 1;
    if (entry.accepted) summary.accepted += 1;
    if (entry.valid && entry.improvement !== null && (summary.bestImprovement === null || entry.improvement > summary.bestImprovement)) summary.bestImprovement = entry.improvement;
    summary.lastIndex = index;
    byClass.set(entry.techniqueClass, summary);
  });
  return [...byClass.values()].map(({ lastIndex, validEntries, ...summary }) => {
    const later = new Set(entries.slice(lastIndex + 1).map((entry) => entry.techniqueClass).filter((id) => id !== summary.techniqueClass));
    const productive = summary.accepted > 0 || (summary.bestImprovement !== null && summary.bestImprovement > 0);
    // Only measured failures cool a class down; a crashed or infrastructure-failed screen is not evidence against it.
    return { ...summary, othersSinceLast: later.size, coolingDown: validEntries > 0 && !productive && later.size < policy.cooldown };
  }).sort((left, right) => (right.bestImprovement ?? -Infinity) - (left.bestImprovement ?? -Infinity) || left.techniqueClass.localeCompare(right.techniqueClass));
}

export interface ScoutCandidate {
  id: string;
  title: string;
  family?: string;
  mechanism?: string;
  proposedChange?: string;
}

export interface ScoutRoundPlan {
  selected: Array<{ id: string; techniqueClass: string }>;
  rejected: Array<{ id: string; techniqueClass: string; reason: string }>;
  classes: Record<string, string>;
}

/**
 * Pick at most `width` candidates, one per technique class, skipping classes
 * on cooldown and capping knob classes. Untried classes are preferred; the
 * director's order breaks ties. Pure: the caller records the plan.
 */
export function planScoutRound(candidates: readonly ScoutCandidate[], ledger: readonly ScoutLedgerEntry[], policy: ScoutPolicy): ScoutRoundPlan {
  const summaries = new Map(summarizeScoutLedger(ledger, policy).map((summary) => [summary.techniqueClass, summary]));
  const classes: Record<string, string> = {};
  for (const candidate of candidates) classes[candidate.id] = classifyTechnique({ family: candidate.family, title: candidate.title, mechanism: candidate.mechanism, proposedChange: candidate.proposedChange });
  const ranked = candidates.map((candidate, index) => ({ candidate, index, techniqueClass: classes[candidate.id], tried: summaries.has(classes[candidate.id]) }))
    .sort((left, right) => Number(left.tried) - Number(right.tried) || left.index - right.index);
  const selected: ScoutRoundPlan["selected"] = [];
  const rejected: ScoutRoundPlan["rejected"] = [];
  const used = new Set<string>();
  let knobs = 0;
  for (const { candidate, techniqueClass } of ranked) {
    const knob = CLASS_BY_ID.get(techniqueClass)?.knob === true;
    const summary = summaries.get(techniqueClass);
    if (selected.length >= policy.width) rejected.push({ id: candidate.id, techniqueClass, reason: "scout round is full" });
    else if (used.has(techniqueClass)) rejected.push({ id: candidate.id, techniqueClass, reason: `another candidate already covers ${techniqueLabel(techniqueClass)} this round` });
    else if (summary?.coolingDown) rejected.push({ id: candidate.id, techniqueClass, reason: `${techniqueLabel(techniqueClass)} was screened without a gain; on cooldown until ${policy.cooldown} other classes are tried (${summary.othersSinceLast} so far)` });
    else if (knob && knobs >= policy.maxKnobsPerRound) rejected.push({ id: candidate.id, techniqueClass, reason: "knob-level change; the round's knob slot is used" });
    else {
      selected.push({ id: candidate.id, techniqueClass });
      used.add(techniqueClass);
      if (knob) knobs += 1;
    }
  }
  return { selected, rejected, classes };
}

export interface ScreenOutcome {
  experimentId: string;
  metric?: number;
  valid: boolean;
  /** Ordering key, higher first (e.g. the paired CI lower bound); defaults to the oriented metric. */
  rank?: number;
}

/**
 * Promote the top screens, but only those that beat the reference screen by
 * minScreenDelta. Without a reference, rank alone decides (legacy behaviour).
 */
export function promoteScoutScreens(outcomes: readonly ScreenOutcome[], policy: Pick<ScoutPolicy, "promoteTop" | "minScreenDelta">, direction: "maximize" | "minimize", referenceMetric?: number): { promoted: string[]; decisions: Array<{ experimentId: string; improvement: number | null; promoted: boolean; reason: string }> } {
  const sign = direction === "maximize" ? 1 : -1;
  const scored = outcomes.map((outcome) => ({ outcome, improvement: outcome.valid && typeof outcome.metric === "number" && Number.isFinite(outcome.metric) && referenceMetric !== undefined ? sign * (outcome.metric - referenceMetric) : null }));
  const eligible = scored.filter(({ outcome }) => outcome.valid && typeof outcome.metric === "number" && Number.isFinite(outcome.metric))
    .sort((left, right) => (right.outcome.rank ?? sign * (right.outcome.metric as number)) - (left.outcome.rank ?? sign * (left.outcome.metric as number)));
  const promoted: string[] = [];
  const decisions = scored.map(({ outcome, improvement }) => ({ experimentId: outcome.experimentId, improvement, promoted: false, reason: outcome.valid ? "" : "screen failed or reported no metric" }));
  for (const { outcome, improvement } of eligible) {
    const decision = decisions.find((entry) => entry.experimentId === outcome.experimentId)!;
    if (promoted.length >= policy.promoteTop) { decision.reason = `ranked below the top ${policy.promoteTop}`; continue; }
    if (improvement !== null && improvement <= policy.minScreenDelta) { decision.reason = `screen improvement ${improvement.toPrecision(3)} does not exceed ${policy.minScreenDelta} over the reference screen`; continue; }
    promoted.push(outcome.experimentId);
    decision.promoted = true;
    decision.reason = improvement === null ? "top screen (no reference screen to compare)" : `screen improvement ${improvement.toPrecision(3)}`;
  }
  return { promoted, decisions };
}

/** The director-facing brief: what is required this round, and which branches are still open. */
export function scoutBrief(ledger: readonly ScoutLedgerEntry[], policy: ScoutPolicy): Record<string, unknown> {
  const summaries = summarizeScoutLedger(ledger, policy);
  const tried = new Set(summaries.map((summary) => summary.techniqueClass));
  const untried = TECHNIQUE_CLASSES.filter((entry) => !tried.has(entry.id) && !entry.knob).map((entry) => ({ class: entry.id, label: entry.label, examples: entry.examples }));
  return {
    active: true,
    width: policy.width,
    promoteTop: policy.promoteTop,
    instruction: `Scout round: propose exactly ${policy.width} hypotheses, each from a DIFFERENT technique class below, as complete standalone methods rather than parameter tweaks of the champion. Each is screened on the reduced evaluator; only the top ${policy.promoteTop} that beat the reference screen get a full evaluation. At most ${policy.maxKnobsPerRound} may be a knob/tuning change. Prefer untried classes; classes on cooldown are rejected by Evidra.`,
    untriedClasses: untried,
    coolingDown: summaries.filter((summary) => summary.coolingDown).map((summary) => summary.techniqueClass),
    triedClasses: summaries.map((summary) => ({ class: summary.techniqueClass, label: summary.label, screens: summary.screens, fulls: summary.fulls, bestImprovement: summary.bestImprovement, accepted: summary.accepted, coolingDown: summary.coolingDown })),
  };
}

/** Rebuild the scout ledger from durable `research.scout.recorded` event payloads. */
export function scoutLedgerFromEvents(events: ReadonlyArray<{ payload: unknown; createdAt?: string }>): ScoutLedgerEntry[] {
  return events.flatMap((event) => {
    const payload = event.payload as Partial<ScoutLedgerEntry> | undefined;
    if (!payload || typeof payload.experimentId !== "string" || typeof payload.techniqueClass !== "string") return [];
    return [{
      experimentId: payload.experimentId,
      techniqueClass: payload.techniqueClass,
      family: typeof payload.family === "string" ? payload.family : "unspecified",
      title: typeof payload.title === "string" ? payload.title : payload.experimentId,
      stage: payload.stage === "full" ? "full" : "screen",
      improvement: typeof payload.improvement === "number" && Number.isFinite(payload.improvement) ? payload.improvement : null,
      valid: payload.valid === true,
      ...(typeof payload.promoted === "boolean" ? { promoted: payload.promoted } : {}),
      ...(typeof payload.accepted === "boolean" ? { accepted: payload.accepted } : {}),
      ...(event.createdAt ? { recordedAt: event.createdAt } : {}),
    }];
  });
}
