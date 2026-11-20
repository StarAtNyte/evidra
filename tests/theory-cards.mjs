import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateTheoryCard, rankTheoryCards, planIdeationRound, scoreWildCards, recordTheoryVerdict, readTheoryLedger,
  cardStatus, pendingTheoryWriteups, completeTheoryWriteup, roundBreadthIssues, cardClass, analysisNumbersFromBrief,
} from "../dist/core/theory-cards.js";
import { planSupervisorTick } from "../dist/core/supervisor.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/theory-cards-simulacra.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(fixture.cards.map((card) => [card.id, card]));
const parse = (id) => { const result = validateTheoryCard(byId[id], fixture.analysis); assert.deepEqual(result.issues, [], `${id}: ${JSON.stringify(result.issues)}`); return result.card; };

test("a card without math is sent back before compute", () => {
  const result = validateTheoryCard(byId["bigger-mlp"], fixture.analysis);
  const fields = result.issues.map((issue) => issue.field);
  assert.ok(fields.includes("model"), "a prose model is not an estimator");
  assert.ok(fields.includes("expectedGain.derivation"), "a gain without numbers is rejected");
  assert.ok(fields.includes("estimation.parameters"), "500k parameters on 120k cells is flagged");
  // Missing sections entirely.
  const bare = validateTheoryCard({ title: "Try a transformer", origin: "invention" });
  assert.ok(bare.issues.length >= 4);
  assert.ok(bare.issues.some((issue) => issue.field === "lossTerm"));
  // Literature without a citation, gain above measured headroom, inconsistent arithmetic.
  assert.ok(validateTheoryCard({ ...byId["ts-per-dataset"], citations: [] }, fixture.analysis).issues.some((issue) => issue.field === "citations"));
  assert.ok(validateTheoryCard({ ...byId["ts-per-dataset"], expectedGain: { ...byId["ts-per-dataset"].expectedGain, value: 0.02 } }, fixture.analysis).issues.some((issue) => /headroom/.test(issue.message)));
  assert.ok(validateTheoryCard({ ...byId["ts-per-dataset"], expectedGain: { ...byId["ts-per-dataset"].expectedGain, value: 0.006 } }, fixture.analysis).issues.some((issue) => /disagrees with its own inputs/.test(issue.message)));
  // New theory must derive and predict.
  const { derivation, prediction, ...noDerivation } = byId["answer-entropy-law"];
  const issues = validateTheoryCard(noDerivation, fixture.analysis).issues.map((issue) => issue.field);
  assert.ok(issues.includes("derivation") && issues.includes("prediction"));
  // The complete cards pass.
  for (const id of ["ts-per-dataset", "respondent-shrinkage", "answer-entropy-law"]) parse(id);
});

test("gain inside the selection-noise risk is rejected", () => {
  const card = { ...byId["respondent-shrinkage"], expectedGain: { ...byId["respondent-shrinkage"].expectedGain, value: 0.0003, inputs: {} }, estimation: { ...byId["respondent-shrinkage"].estimation, selections: 20 } };
  const result = validateTheoryCard(card, fixture.analysis);
  assert.ok(result.issues.some((issue) => /selection-noise risk/.test(issue.message)), JSON.stringify(result.issues));
  assert.ok(result.risk.optimism > 0 && result.risk.overfit > 0);
});

test("a new-theory card is new/unproven until its falsified verdict is recorded", () => {
  const state = mkdtempSync(join(tmpdir(), "evidra-theory-"));
  const card = parse("answer-entropy-law");
  assert.equal(cardStatus(card, readTheoryLedger(state)), "new/unproven");
  const verdict = recordTheoryVerdict(state, card, { experimentId: "exp-1", ratchetVerdict: "no_gain", observedGain: -0.00002, ci: { lower: -0.0001, upper: 0.00006 }, segmentObserved: { segment: "tx_s1", meanImprovement: -0.00003, lower: -0.0001, upper: 0.00004 } });
  assert.equal(verdict.verdict, "falsified");
  assert.equal(verdict.origin, "new_theory");
  const ledger = readTheoryLedger(state);
  assert.equal(ledger.length, 1);
  assert.equal(cardStatus(card, ledger), "falsified");
  // Re-recording the same experiment replaces, never duplicates.
  recordTheoryVerdict(state, card, { experimentId: "exp-1", ratchetVerdict: "no_gain", observedGain: -0.00002, ci: { lower: -0.0001, upper: 0.00006 } });
  assert.equal(readTheoryLedger(state).length, 1);
});

test("a mechanism mismatch is flagged when the gain lands outside the predicted segment", () => {
  const state = mkdtempSync(join(tmpdir(), "evidra-theory-"));
  const card = parse("ts-per-dataset");
  const verdict = recordTheoryVerdict(state, card, { experimentId: "exp-2", ratchetVerdict: "keep", observedGain: 0.0007, ci: { lower: 0.0002, upper: 0.0012 }, segmentObserved: { segment: "nh_s2", meanImprovement: 0.00001, lower: -0.0004, upper: 0.0004 } });
  assert.equal(verdict.verdict, "confirmed", "the aggregate claim held");
  assert.match(verdict.mechanismMismatch, /predicted segment nh_s2 did not/);
});

test("ranking orders by expected gain x probability / cost, with class priors from verdicts", () => {
  const cards = ["ts-per-dataset", "respondent-shrinkage", "answer-entropy-law"].map(parse);
  const ranked = rankTheoryCards(cards, []);
  for (const entry of ranked) assert.ok(Math.abs(entry.score - entry.card.expectedGain.value * entry.probability / entry.card.cost) < 1e-15);
  for (let index = 1; index < ranked.length; index += 1) assert.ok(ranked[index - 1].score >= ranked[index].score);
  assert.equal(ranked[0].card.id, "ts-per-dataset");
  // Cost matters: the same card at 10x the cost drops below the others.
  const expensive = rankTheoryCards([{ ...cards[0], cost: 3 }, cards[1], cards[2]], []);
  assert.notEqual(expensive[0].card.id, "ts-per-dataset");
  // Prior verdicts of the same class lower its probability.
  const history = [1, 2, 3].map((index) => ({ cardId: `c${index}`, experimentId: `e${index}`, title: "t", origin: "literature", techniqueClass: cardClass(cards[0]), verdict: "falsified", ratchetVerdict: "no_gain", predictedGain: 0.001, observedGain: 0, recordedAt: "" }));
  const informed = rankTheoryCards(cards, history);
  assert.ok(informed.find((entry) => entry.card.id === "ts-per-dataset").probability < ranked.find((entry) => entry.card.id === "ts-per-dataset").probability);
});

test("a round mixes literature and invention, reserves the wild quota, and never repeats a class", () => {
  const cards = ["ts-per-dataset", "respondent-shrinkage", "answer-entropy-law", "wild-reverse-order", "wild-retrieval-twins"].map(parse);
  // A duplicate-class card: a second calibration method must not share the round.
  const duplicate = { ...cards[0], id: "isotonic", title: "Isotonic calibration per dataset", family: "calibration isotonic", expectedGain: { ...cards[0].expectedGain, value: 0.0011 } };
  const plan = planIdeationRound([...cards, duplicate], [], { screens: 5, wildQuota: 0.2 });
  const classes = plan.selected.map((entry) => entry.techniqueClass);
  assert.equal(new Set(classes).size, classes.length, `classes repeat: ${classes}`);
  assert.equal(plan.wildSlots, 1);
  assert.equal(plan.selected.filter((entry) => entry.slot === "wild").length, 1);
  assert.ok(plan.deferred.some((entry) => entry.card.id === "isotonic" && /already in this round/.test(entry.reason)));
  assert.deepEqual(plan.breadthIssues, []);
  const origins = new Set(plan.selected.map((entry) => entry.card.origin));
  assert.ok(origins.has("literature") && (origins.has("invention") || origins.has("new_theory")));
  assert.deepEqual(roundBreadthIssues([cards[1], cards[2]]), ["no literature/library-mined method in the round"]);
  // Quota is configurable and rounds up; zero turns it off.
  assert.equal(planIdeationRound(cards, [], { screens: 5, wildQuota: 0.4 }).wildSlots, 2);
  assert.equal(planIdeationRound(cards, [], { screens: 5, wildQuota: 0 }).selected.filter((entry) => entry.slot === "wild").length, 0);
  // Wild cards never take ranked slots beyond their quota.
  assert.equal(planIdeationRound(cards, [], { screens: 4, wildQuota: 0.2 }).selected.filter((entry) => entry.slot === "wild").length, 1);
});

test("wild cards are exempt from the math but need a prediction and a cheap screen", () => {
  assert.deepEqual(validateTheoryCard(byId["wild-reverse-order"]).issues, []);
  const { prediction, ...noPrediction } = byId["wild-reverse-order"];
  assert.ok(validateTheoryCard(noPrediction).issues.some((issue) => issue.field === "prediction"));
  assert.ok(validateTheoryCard({ ...byId["wild-reverse-order"], cost: 4 }, {}, { wildMaxCost: 1 }).issues.some((issue) => issue.field === "cost"));
});

test("wild selection rewards variance and novelty, not expected gain", () => {
  const steady = { title: "Wild: steady", origin: "wild", family: "chained autoregressive", hunch: "a safe-looking hunch here", prediction: { statement: "tx_s1 improves a little", sign: "positive" }, expectedGain: { value: 0.0006, spread: 0.0001 }, cost: 0.5 };
  const longShot = { ...steady, title: "Wild: long shot", family: "symbolic rule", expectedGain: { value: 0, spread: 0.002 } };
  const [first] = scoreWildCards([validateTheoryCard(steady).card, validateTheoryCard(longShot).card], {});
  assert.equal(first.card.title, "Wild: long shot", "the higher-variance card wins despite a lower mean");
  // Equal distributions: the untried class beats the tried one.
  const a = validateTheoryCard({ ...longShot, title: "Wild: tried class", family: "symbolic rule" }).card;
  const b = validateTheoryCard({ ...longShot, title: "Wild: new class", family: "analytic closed-form" }).card;
  const scored = scoreWildCards([a, b], { symbolic_rules: 6 });
  assert.equal(scored[0].card.title, "Wild: new class");
  assert.ok(scored[0].novelty > scored[1].novelty);
});

test("a wild-card win is promoted and its theory write-up is tracked until done", () => {
  const state = mkdtempSync(join(tmpdir(), "evidra-theory-"));
  const wild = validateTheoryCard(byId["wild-retrieval-twins"]).card;
  const verdict = recordTheoryVerdict(state, wild, { experimentId: "exp-w", ratchetVerdict: "keep", observedGain: 0.0016, ci: { lower: 0.0011, upper: 0.0021 } });
  assert.equal(verdict.verdict, "confirmed");
  assert.equal(verdict.promoted, true);
  assert.equal(cardStatus(wild, readTheoryLedger(state)), "promoted (theory pending)");
  assert.equal(pendingTheoryWriteups(readTheoryLedger(state)).length, 1);
  const writeup = { ...parse("respondent-shrinkage"), id: "wild-retrieval-twins", title: "Nearest-twin respondent retrieval" };
  assert.equal(completeTheoryWriteup(state, "wild-retrieval-twins", writeup), true);
  assert.equal(pendingTheoryWriteups(readTheoryLedger(state)).length, 0);
});

test("the supervisor counts wild screens so the quota cannot silently go to zero", () => {
  const now = Date.parse("2026-11-20T08:00:00Z");
  const history = Array.from({ length: 6 }, (_, index) => ({ experimentId: `h${index}`, lane: `lane${index % 3}`, at: new Date(now - (10 - index) * 60_000).toISOString(), wild: false }));
  const queue = [
    { experimentId: "ranked-1", lane: "calibration_scoring", ready: true },
    { experimentId: "wild-1", lane: "sequential_joint", ready: true, wild: true },
  ];
  const decision = planSupervisorTick({ queue, workers: [], ledger: [], history, now, policy: { workers: 1, wildQuota: 0.2 } });
  assert.equal(decision.launch[0].experimentId, "wild-1");
  assert.match(decision.launch[0].reason, /wild-card quota/);
  assert.ok(decision.warnings.some((warning) => /exploration: wild cards took 0%/.test(warning)));
  assert.equal(decision.wild.launched, 0);
  // Quota met: ranked work goes first and no warning.
  const met = planSupervisorTick({ queue, workers: [], ledger: [], history: history.map((entry, index) => ({ ...entry, wild: index < 2 })), now, policy: { workers: 1, wildQuota: 0.2 } });
  assert.ok(!met.warnings.some((warning) => /exploration/.test(warning)));
  assert.equal(met.wild.launched, 2);
});

test("analysis numbers come from the loss-analysis brief", () => {
  const numbers = analysisNumbersFromBrief({ noiseFloor: { standardError: 0.0003, minimumDetectableAggregateChange: 0.0006 }, gapTable: [{ segment: "dataset=nh_s2", unitShare: 0.2, recoverableToMean: 0.004, recoverableToBestRun: 0.012 }] });
  assert.equal(numbers.noiseFloor, 0.0006);
  assert.equal(numbers.headroom["dataset=nh_s2"], 0.012);
  assert.equal(numbers.share["dataset=nh_s2"], 0.2);
});

test("cli: theory check sends back a card without math; a carded experiment writes its verdict back", async (t) => {
  const { workspace } = await import("./helpers/launch-workspace.mjs");
  const { writeFileSync, existsSync } = await import("node:fs");
  const { root, cli } = workspace(t, {}, "import json\nprint(json.dumps({'score': 0.5}))\n");
  writeFileSync(join(root, "good.json"), JSON.stringify(byId["ts-per-dataset"]));
  writeFileSync(join(root, "bad.json"), JSON.stringify(byId["bigger-mlp"]));
  const good = cli("theory", "check", "good.json");
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /good\.json: ok \(established\)/);
  const bad = cli("theory", "check", "bad.json");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /sent back/);
  const rejected = cli("hypothesis", "--title", "wider mlp", "--theory-card", "bad.json");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /theory card rejected/);
  const accepted = cli("hypothesis", "--title", "temperature per dataset", "--family", "calibration temperature", "--mode", "verify", "--env", "TS=1", "--theory-card", "good.json");
  assert.equal(accepted.status, 0, accepted.stderr);
  const hypothesis = accepted.stdout.match(/hyp_\S+/)[0];
  assert.equal(cli("experiment", "propose", hypothesis).status, 0);
  const experiment = JSON.parse(cli("launch", "status", "--json").stdout).waiting.find((entry) => entry.experimentId.includes(hypothesis.slice(4, 20))).experimentId;
  const ran = cli("experiment", "run", experiment);
  if (!existsSync(join(root, ".sota", "theories.json"))) console.log(ran.status, ran.stdout.slice(-1500), ran.stderr.slice(-1500));
  const ledgerPath = join(root, ".sota", "theories.json");
  assert.ok(existsSync(ledgerPath), "the ratchet verdict is written back onto the card");
  const [entry] = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.equal(entry.cardId, "ts-per-dataset");
  assert.ok(["confirmed", "falsified", "inconclusive"].includes(entry.verdict));
  assert.match(cli("theory", "ledger").stdout, /Per-dataset temperature scaling/);
});
