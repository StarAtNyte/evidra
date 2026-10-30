import test from "node:test";
import assert from "node:assert/strict";
import { explorationHypothesis, familySummaries, isExplorationTurn, normalizeFamily, parentExperimentId, searchState } from "../dist/core/ratchet.js";

const attempt = (experimentId, family, metric, status = "completed") => ({ experimentId, idea: experimentId, family: normalizeFamily(family), status, metric, kept: false });

test("each method family keeps its own best, so a new architecture is refined rather than discarded", () => {
  const entries = [
    attempt("tune-1", "Mean propagation", 0.50),
    attempt("tune-2", "mean  propagation", 0.40),
    attempt("tune-3", "mean propagation", 0.42),
    attempt("arch-1", "Transformer", 0.90),
    attempt("arch-2", "transformer", null, "failed"),
  ];
  const families = familySummaries(entries, "minimize");
  const mean = families.find((summary) => summary.family === "mean propagation");
  const transformer = families.find((summary) => summary.family === "transformer");
  assert.equal(mean.best.experimentId, "tune-2");
  assert.equal(mean.attemptsSinceImprovement, 1);
  assert.equal(mean.young, false);
  assert.equal(transformer.best.experimentId, "arch-1", "a new family's best stands even though it loses to the champion");
  assert.equal(transformer.attempts, 2);
  assert.equal(transformer.young, true);
});

test("one attempt in three goes to a new or young family", () => {
  const mature = [attempt("a", "x", 1), attempt("b", "x", 1), attempt("c", "x", 1)];
  assert.equal(isExplorationTurn(mature), false, "the third attempt in a family is still young");
  assert.equal(isExplorationTurn([...mature, attempt("d", "x", 1)]), false);
  assert.equal(isExplorationTurn([...mature, attempt("d", "x", 1), attempt("e", "x", 1)]), true);
  assert.equal(isExplorationTurn([...mature, attempt("d", "x", 1), attempt("e", "y", 1)]), false);
  const families = familySummaries([...mature, attempt("d", "x", 1), attempt("e", "y", 1)], "minimize");
  const hypotheses = [{ title: "tune x", formulationFamily: "X" }, { title: "refine y", formulationFamily: "y" }, { title: "new z", formulationFamily: "z" }];
  assert.equal(explorationHypothesis(hypotheses, families).title, "refine y");
  assert.equal(explorationHypothesis([{ title: "tune x", formulationFamily: "x" }], families), undefined);
});

test("an attempt builds on its family's best, and a new family starts from the champion", () => {
  const events = { "experiment.champion.updated": [{ payload: { experimentId: "exp-a" }, createdAt: "2026-03-01T00:00:03.000Z" }] };
  const store = {
    eventsByType: (type) => events[type] ?? [],
    experiments: () => [
      { id: "exp-b", payload: { hypothesisId: "hb", status: "completed", runId: "rb" }, createdAt: "2026-03-01T00:00:02.000Z" },
      { id: "exp-a", payload: { hypothesisId: "ha", status: "completed", runId: "ra" }, createdAt: "2026-03-01T00:00:01.000Z" },
    ],
    runs: () => [{ id: "ra", payload: { metrics: { loss: 0.3 } } }, { id: "rb", payload: { metrics: { loss: 0.8 } } }],
    hypotheses: () => [{ id: "ha", payload: { title: "tuned", formulationFamily: "linear" } }, { id: "hb", payload: { title: "graph net", formulationFamily: "graph network" } }],
  };
  assert.equal(parentExperimentId(store, "loss", "minimize", "Graph Network"), "exp-b");
  assert.equal(parentExperimentId(store, "loss", "minimize", "diffusion"), "exp-a");
  const state = searchState(store, "loss", "minimize");
  assert.deepEqual(state.experimentLog.map((entry) => entry.experimentId), ["exp-a", "exp-b"], "the log is oldest first, so recent attempts are the latest");
  assert.equal(state.champion.experimentId, "exp-a");
  assert.equal(state.families.length, 2);
});
