import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareMetricSeries } from "../dist/core/statistics.js";
import { recoveryPlan } from "../dist/core/recovery.js";
import { ResearchStore } from "../dist/core/store.js";
import { prepareSubmission, validateSubmissionBundle } from "../dist/core/submissions.js";
import { sourceClaims } from "../dist/core/sources.js";
import { diversityReport, greedyBlend } from "../dist/core/ensemble.js";

test("durable research state and queue survive store reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "evidra-smoke-"));
  try {
    const db = join(root, ".sota", "database.sqlite");
    const first = new ResearchStore(db);
    first.createProject({ id: "p1", name: "Smoke", competitionId: "local", config: {} });
    first.saveCampaign({ goal: "test", budgetMinutes: 2, status: "running" });
    first.updateAgentLane({ role: "research director", status: "running", provider: "local", model: "test", task: "smoke" });
    first.enqueueTask({ id: "task-1", kind: "research.cycle", priority: 4, payload: { smoke: true } });
    assert.equal(first.claimNextTask()?.id, "task-1");
    first.updateTask("task-1", "completed");
    first.close();
    const reopened = new ResearchStore(db);
    assert.equal(reopened.project()?.id, "p1");
    assert.equal(reopened.campaign()?.goal, "test");
    assert.equal(reopened.agentLanes()[0].status, "running");
    assert.equal(reopened.queueTasks()[0].status, "completed");
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("paired statistics and recovery are deterministic", () => {
  const comparison = compareMetricSeries([1, 2, 3], [0.8, 1.9, 2.7], true, 500);
  assert.equal(comparison.probabilityImproved, 1);
  assert(comparison.confidenceInterval[1] < 0);
  assert.equal(recoveryPlan("dependency").retry, false);
  assert.equal(recoveryPlan("transient_cloud").maxAttempts, 3);
});

test("ensemble analysis exposes diversity and deterministic blends", () => {
  const vectors = [{ id: "a", path: "a", values: [0, 1, 0, 1] }, { id: "b", path: "b", values: [0, 0, 1, 1] }];
  assert.equal(diversityReport(vectors).length, 1);
  assert.deepEqual(greedyBlend(vectors), [0, 0.5, 0.5, 1]);
});

test("source claims and submission provenance are auditable", () => {
  const root = mkdtempSync(join(tmpdir(), "evidra-submission-"));
  try {
    assert.equal(sourceClaims("This method improves validation accuracy by using a robust model and reports results on a held-out dataset.").length, 1);
    const artifact = join(root, "submission.csv");
    writeFileSync(artifact, "id,prediction\n1,0\n");
    const manifest = { schemaVersion: 1, id: "exp-1", parent: null, hypothesisId: "hyp-1", gitCommit: "abc", datasetVersion: "data", splitVersion: "split", change: { configPatch: {} }, resources: { executor: "local", timeoutMinutes: 1 }, evaluation: { folds: [0], seeds: [0], requiredArtifacts: [] }, acceptance: { minimumPrimaryDelta: 0, maximumRegressionShift: 0, requireReplication: false }, createdAt: new Date().toISOString() };
    const run = { runId: "run-1", status: "completed", exitCode: 0, durationSeconds: 1, metrics: { score: 1 }, artifacts: { submission: artifact } };
    const bundle = prepareSubmission(root, "exp-1", manifest, run, { id: "local", name: "Local", taskType: "test", datasetRevision: "data", metric: { name: "score", direction: "maximize" }, evaluator: { command: ["true"], estimatorPath: "" } });
    assert.equal(validateSubmissionBundle(bundle.path).valid, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
