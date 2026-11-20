import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTechnique, planScoutRound, promoteScoutScreens, resolveScoutPolicy, scoutBrief, scoutLedgerFromEvents, summarizeScoutLedger } from "../dist/core/scout.js";
import { loadUnitScores, pairedBootstrap, unitScoresFromRecords } from "../dist/core/unit-scores.js";
import { decideRatchet, resolveRatchetPolicy } from "../dist/core/ratchet.js";
import { appendImprovement, readImprovementLedger, verifyImprovementLedger, ledgerPaths } from "../dist/core/improvement-ledger.js";
import { analyzeUnitLoss, lossAnalysisBrief, renderLossAnalysis } from "../dist/core/loss-analysis.js";
import { unitScoresFromPredictionRows } from "../dist/core/error-analysis.js";

const policy = resolveScoutPolicy({ enabled: true, width: 3, cooldown: 2 });

test("free-text families map to coarse technique classes", () => {
  assert.equal(classifyTechnique({ family: "symbolic rule-mined tables" }), "symbolic_rules");
  assert.equal(classifyTechnique({ family: "MDL-pruned symbolic answer rules" }), "symbolic_rules");
  assert.equal(classifyTechnique({ family: "latent-class / mixture" }), "latent_variable");
  assert.equal(classifyTechnique({ family: "Bayesian network (Chow-Liu/TAN)" }), "probabilistic_graphical");
  assert.equal(classifyTechnique({ family: "routing / gated pooling (MoE)" }), "routing_gating");
  assert.equal(classifyTechnique({ family: "hyperparameter sweep", title: "tune learning rate" }), "hyperparameter_tuning");
  assert.equal(classifyTechnique({ family: "TabICL in-context" }), "foundation_pretrained");
  assert.match(classifyTechnique({ family: "zorbification" }), /^other:zorbification/);
  assert.equal(classifyTechnique({ family: "TabICL tuning" }), "hyperparameter_tuning", "knob classes win ties");
  assert.equal(classifyTechnique({ family: "latent/denoising (Rao-Blackwellised targets)" }), "latent_variable", "keywords match at word starts only");
  assert.equal(classifyTechnique({ family: "hierarchical Bayes / context trees" }), "hierarchical_bayes");
  assert.equal(classifyTechnique({ family: "gradient boosted trees" }), "tree_ensemble");
});

test("a scout round takes one candidate per class and caps knobs", () => {
  const plan = planScoutRound([
    { id: "a", title: "MDL rules", family: "symbolic rules" },
    { id: "b", title: "rule lists v2", family: "rule mining" },
    { id: "c", title: "tune lr", family: "hyperparameter tuning" },
    { id: "d", title: "budget split", family: "compute budget reallocation" },
    { id: "e", title: "copula", family: "copula dependence" },
  ], [], policy);
  assert.deepEqual(plan.selected.map((entry) => entry.id), ["a", "c", "e"]);
  assert.match(plan.rejected.find((entry) => entry.id === "b").reason, /already covers/);
  assert.match(plan.rejected.find((entry) => entry.id === "d").reason, /knob/);
});

test("a class screened without a gain cools down until other classes are tried, and untried classes come first", () => {
  const ledger = [
    { experimentId: "x1", techniqueClass: "symbolic_rules", family: "rules", title: "r", stage: "screen", improvement: -0.001, valid: true },
  ];
  const plan = planScoutRound([{ id: "a", title: "rules again", family: "symbolic rules" }, { id: "b", title: "knn", family: "nearest neighbour retrieval" }], ledger, policy);
  assert.deepEqual(plan.selected.map((entry) => entry.id), ["b"]);
  assert.match(plan.rejected[0].reason, /cooldown/);
  const later = [...ledger, { experimentId: "x2", techniqueClass: "neural_net", family: "mlp", title: "m", stage: "screen", improvement: -0.01, valid: true }, { experimentId: "x3", techniqueClass: "tree_ensemble", family: "gbdt", title: "g", stage: "screen", improvement: -0.01, valid: true }];
  const summary = summarizeScoutLedger(later, policy).find((entry) => entry.techniqueClass === "symbolic_rules");
  assert.equal(summary.coolingDown, false, "cooldown expires after `cooldown` other classes");
  assert.equal(summarizeScoutLedger([{ ...ledger[0], valid: false, improvement: null }], policy)[0].coolingDown, false, "an infrastructure-failed screen does not cool a class down");
  const productive = summarizeScoutLedger([{ ...ledger[0], improvement: 0.002 }], policy)[0];
  assert.equal(productive.coolingDown, false, "a class that gained is never on cooldown");
  const brief = scoutBrief(later, policy);
  assert.ok(brief.untriedClasses.some((entry) => entry.class === "latent_variable"));
  assert.ok(!brief.untriedClasses.some((entry) => entry.class === "hyperparameter_tuning"), "knob classes are never offered as exploration");
});

test("screens are promoted only when they beat the reference screen", () => {
  const outcomes = [{ experimentId: "a", metric: 0.60, valid: true }, { experimentId: "b", metric: 0.65, valid: true }, { experimentId: "c", valid: false }];
  assert.deepEqual(promoteScoutScreens(outcomes, { promoteTop: 2, minScreenDelta: 0 }, "maximize", 0.62).promoted, ["b"]);
  assert.deepEqual(promoteScoutScreens(outcomes, { promoteTop: 1, minScreenDelta: 0 }, "maximize").promoted, ["b"], "without a reference, rank decides");
  assert.deepEqual(promoteScoutScreens(outcomes, { promoteTop: 2, minScreenDelta: 0 }, "minimize", 0.62).promoted, ["a"]);
  const ranked = [{ experimentId: "noisy", metric: 0.045, rank: 0.004, valid: true }, { experimentId: "tight", metric: 0.01, rank: 0.009, valid: true }];
  assert.deepEqual(promoteScoutScreens(ranked, { promoteTop: 1, minScreenDelta: 0 }, "maximize", 0).promoted, ["tight"], "paired screens rank by CI lower bound, not by a noisy mean");
  assert.equal(scoutLedgerFromEvents([{ payload: { experimentId: "a", techniqueClass: "neural_net", stage: "screen", improvement: 0.1, valid: true } }, { payload: { bogus: true } }]).length, 1);
});

const units = (scores, segment = () => ({})) => scores.map((score, index) => ({ unit: `u${index}`, score, segments: segment(index) }));

test("paired bootstrap resolves a small consistent gain that a noisy aggregate hides", () => {
  const base = Array.from({ length: 400 }, (_, index) => Math.sin(index * 12.9898) * 5);
  const reference = units(base);
  const better = units(base.map((value) => value + 0.01));
  const result = pairedBootstrap(reference, better, { direction: "maximize", seed: 1 });
  assert.equal(result.matched, 400);
  assert.ok(result.lower > 0, "every unit improved, so the CI excludes zero");
  const noisy = units(base.map((value, index) => value + (index % 2 ? 0.5 : -0.49)));
  const verdict = decideRatchet({ scalarImproved: true, scalarDelta: 0.005, paired: pairedBootstrap(reference, noisy, { direction: "maximize", seed: 1 }), policy: resolveRatchetPolicy({}) });
  assert.equal(verdict.accept, false, "a scalar win that the paired CI cannot resolve is rejected");
  assert.equal(verdict.verdict, "noisy");
  assert.equal(decideRatchet({ scalarImproved: false, scalarDelta: 0, paired: result, policy: resolveRatchetPolicy({}) }).accept, false, "unit and aggregate evidence must agree");
  const keep = decideRatchet({ scalarImproved: true, scalarDelta: 0.01, paired: result, policy: resolveRatchetPolicy({}) });
  assert.equal(keep.accept, true);
  assert.equal(keep.mode, "paired_bootstrap");
  const minimize = pairedBootstrap(reference, better, { direction: "minimize", seed: 1 });
  assert.ok(minimize.upper < 0);
  assert.equal(decideRatchet({ scalarImproved: false, scalarDelta: -1, paired: minimize, policy: resolveRatchetPolicy({}) }).verdict, "regressed");
});

test("cluster bootstrap and ratchet fallbacks", () => {
  const reference = units(Array.from({ length: 60 }, () => 0), (index) => ({ respondent: index % 6 }));
  const candidate = units(Array.from({ length: 60 }, (_, index) => (index % 6 === 0 ? 1 : 0)), (index) => ({ respondent: index % 6 }));
  const clustered = pairedBootstrap(reference, candidate, { direction: "maximize", clusterBy: "respondent", seed: 3 });
  assert.equal(clustered.clusters, 6);
  assert.ok(clustered.lower <= 0, "one lucky cluster is not resolved evidence");
  const few = pairedBootstrap(units([1, 2]), units([2, 3]), { direction: "maximize" });
  assert.equal(decideRatchet({ scalarImproved: true, scalarDelta: 1, paired: few, policy: resolveRatchetPolicy({}) }).mode, "scalar");
  assert.equal(decideRatchet({ scalarImproved: true, scalarDelta: 1, paired: few, policy: resolveRatchetPolicy({ mode: "paired" }) }).accept, false);
  assert.equal(decideRatchet({ scalarImproved: true, scalarDelta: 1, policy: resolveRatchetPolicy({}) }).accept, true);
  assert.equal(decideRatchet({ scalarImproved: true, scalarDelta: 1, policy: resolveRatchetPolicy({ mode: "paired" }) }).verdict, "insufficient_units");
});

test("unit-score files load from CSV and JSONL with inferred columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidra-units-"));
  writeFileSync(join(dir, "u.csv"), "cell_id,country,logprob,age\nc1,KE,-0.5,23\nc2,\"N,G\",-1.5,40\n");
  const table = loadUnitScores(join(dir, "u.csv"));
  assert.equal(table.idColumn, "cell_id");
  assert.equal(table.scoreColumn, "logprob");
  assert.deepEqual(table.units[1], { unit: "c2", score: -1.5, segments: { country: "N,G", age: 40 } });
  writeFileSync(join(dir, "u.jsonl"), `${JSON.stringify({ id: "a", loss: 1, item: "q1" })}\nnot json\n${JSON.stringify({ id: "b", loss: 2, item: "q2" })}\n`);
  assert.equal(loadUnitScores(join(dir, "u.jsonl")).units.length, 2);
  assert.throws(() => unitScoresFromRecords([{ name: "x" }]), /score column/);
});

test("the improvements ledger is atomic, idempotent and hash-chained", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidra-ledger-"));
  const base = { metricName: "m", direction: "maximize", stage: "full", verdict: "keep", mode: "scalar", reason: "beat champion" };
  appendImprovement(dir, { ...base, experimentId: "e1", runId: "r1", accepted: true, improvement: 0.01, referenceMetric: 0.5, candidateMetric: 0.51 });
  appendImprovement(dir, { ...base, experimentId: "e2", runId: "r2", accepted: false, verdict: "noisy", improvement: 0.001 });
  appendImprovement(dir, { ...base, experimentId: "e2", runId: "r2", accepted: false, verdict: "noisy", improvement: 0.001 });
  const entries = readImprovementLedger(dir);
  assert.equal(entries.length, 2);
  assert.equal(verifyImprovementLedger(entries).valid, true);
  const markdown = readFileSync(ledgerPaths(dir).markdown, "utf8");
  assert.match(markdown, /1 accepted full-evaluation step/);
  assert.match(markdown, /Hash chain: intact/);
  const tampered = entries.map((entry, index) => index === 0 ? { ...entry, improvement: 1 } : entry);
  assert.deepEqual(verifyImprovementLedger(tampered), { valid: false, brokenAt: 1 });
});

test("loss analysis localizes the loss, estimates cross-fitted routing headroom, and emits hypotheses", () => {
  // Run A is good on country=KE, run B on country=NG; item q3 is hard for both.
  const make = (good) => Array.from({ length: 600 }, (_, index) => {
    const country = ["KE", "NG", "ZA"][index % 3];
    const item = `q${index % 4}`;
    let score = -1;
    if (item === "q3") score -= 2;
    if (country === good) score += 0.3;
    return { unit: `u${index}`, score: score + ((index * 7919) % 13) / 1000, segments: { country, item } };
  });
  const table = (rows) => ({ units: rows, scoreColumn: "logprob", idColumn: "unit", segmentColumns: ["country", "item"], skippedRows: 0, source: "test" });
  const report = analyzeUnitLoss([{ id: "A", table: table(make("KE")) }, { id: "B", table: table(make("NG")) }], { direction: "maximize" });
  assert.equal(report.gapTable[0].column, "item");
  assert.equal(report.gapTable[0].value, "q3");
  const routing = report.routing.find((entry) => entry.column === "country");
  assert.ok(routing.crossFittedGain > 0.05, `routing by country recovers B's advantage (${routing.crossFittedGain})`);
  assert.equal(routing.choices.NG, "B");
  const ng = report.differences.find((entry) => entry.runId === "B" && entry.column === "country" && entry.value === "NG");
  assert.ok(ng.meanDifference < -0.25, "A trails B on NG by B's advantage");
  assert.ok(report.oracle.gain > 0);
  const titles = report.hypotheses.map((entry) => entry.title);
  assert.ok(titles.includes("Targeted model for item=q3"));
  assert.ok(titles.includes("Learned routing by country"));
  assert.ok(report.hypotheses.some((entry) => entry.techniqueClass === "routing_gating"));
  assert.ok(lossAnalysisBrief(report).dataHypotheses.length >= 2);
  assert.match(renderLossAnalysis(report), /Gap table/);
});

test("prediction rows feed the same loss decomposition", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `r${index}`, actual: 1, predicted: index % 4 === 0 ? 0 : 1, metadata: { region: index % 4 === 0 ? "north" : "south" } }));
  const report = analyzeUnitLoss([{ id: "p", table: unitScoresFromPredictionRows(rows) }], { direction: "minimize", minSegmentUnits: 1 });
  assert.equal(report.gapTable[0].value, "north");
  assert.ok(report.gapTable[0].recoverableToMean > 0);
});

test("per-segment gates: deciding splits must clear the bar and guards must not lose", async () => {
  const { applySegmentGates, judgeSegments } = await import("../dist/core/ratchet.js");
  const ref = (n, shift = 0) => units(Array.from({ length: n }, (_, index) => Math.sin(index) + shift));
  const good = pairedBootstrap(ref(100), ref(100, 0.01), { direction: "maximize" });
  const bad = pairedBootstrap(ref(100), ref(100, -0.01), { direction: "maximize" });
  const policy = resolveRatchetPolicy({ requireSegments: ["tx_s1", "tx_s2"], guardSegments: ["me_s1", "nh_s2"], segmentColumn: "dataset" });
  const overall = decideRatchet({ scalarImproved: true, scalarDelta: 0.01, paired: good, policy });
  const pass = applySegmentGates(overall, judgeSegments({ tx_s1: good, tx_s2: good, me_s1: good }, policy));
  assert.equal(pass.accept, true);
  assert.match(pass.reason, /unevaluated guards: nh_s2/);
  assert.equal(applySegmentGates(overall, judgeSegments({ tx_s1: good }, policy)).accept, false, "a missing deciding split blocks");
  const guardLoss = applySegmentGates(overall, judgeSegments({ tx_s1: good, tx_s2: good, me_s1: bad }, policy));
  assert.equal(guardLoss.accept, false);
  assert.equal(guardLoss.verdict, "regressed");
});

test("cross-fitted shrinkage toward a fallback finds over-confidence and folds by cluster", () => {
  // Over-confident model: on 'hard' items it puts tiny mass on outcomes that do happen.
  const rows = Array.from({ length: 800 }, (_, index) => {
    const hard = index % 4 === 0;
    const logp = hard && index % 8 === 0 ? Math.log(0.01) : Math.log(0.9);
    return { unit: `c${index}`, score: logp, segments: { item: hard ? "hard" : "easy", rid: `r${Math.floor(index / 4)}` }, mix: { logp, fallback: Math.log(0.4), scale: 1 } };
  });
  const table = { units: rows, scoreColumn: "score", idColumn: "unit", segmentColumns: ["item"], skippedRows: 0, source: "t" };
  const report = analyzeUnitLoss([{ id: "m", table }], { direction: "maximize", foldBy: "rid" });
  const perItem = report.calibration.find((entry) => entry.column === "item");
  assert.ok(perItem.crossFittedGain > 0.01, `per-item shrinkage helps (${perItem.crossFittedGain})`);
  assert.ok(perItem.weights.hard > perItem.weights.easy);
  assert.ok(report.hypotheses.some((entry) => entry.title.startsWith("Cross-fitted shrinkage")));
  const calibrated = analyzeUnitLoss([{ id: "m", table: { ...table, units: rows.map((row) => ({ ...row, mix: { ...row.mix, fallback: row.mix.logp - 3 } })) } }], { direction: "maximize" });
  assert.ok(calibrated.notes.some((note) => /not over-confident/.test(note)));
});

test("workers keep the user session bus so systemd-run --user evaluators work", async () => {
  const { safeWorkerEnvironment, sessionBusEnvironment } = await import("../dist/core/executors.js");
  assert.deepEqual(sessionBusEnvironment({ XDG_RUNTIME_DIR: "/run/user/7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, 7, () => false), { XDG_RUNTIME_DIR: "/run/user/7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" });
  assert.deepEqual(sessionBusEnvironment({}, 1000, (path) => path === "/run/user/1000" || path === "/run/user/1000/bus"), { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, "derived when a detached controller lost them");
  assert.deepEqual(sessionBusEnvironment({}, 1000, () => false), {});
  const saved = { x: process.env.XDG_RUNTIME_DIR, d: process.env.DBUS_SESSION_BUS_ADDRESS };
  process.env.XDG_RUNTIME_DIR = "/run/user/4242"; process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/4242/bus";
  try {
    const env = safeWorkerEnvironment({});
    assert.equal(env.XDG_RUNTIME_DIR, "/run/user/4242");
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/4242/bus");
  } finally {
    if (saved.x === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved.x;
    if (saved.d === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = saved.d;
  }
});
