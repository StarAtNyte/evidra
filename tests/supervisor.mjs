import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { laneScores, planSupervisorTick } from "../dist/core/supervisor.js";
import { ResearchStore } from "../dist/core/store.js";
import { workspace } from "./helpers/launch-workspace.mjs";

const now = Date.parse("2026-11-20T08:00:00Z");
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

test("supervisor: stuck workers are restarted from checkpoint, then retired", () => {
  const decision = planSupervisorTick({ now, queue: [], ledger: [], history: [], policy: { stallMinutes: 30, maxRestarts: 2 }, workers: [
    { experimentId: "alive", lane: "a", startedAt: ago(120), lastHeartbeatAt: ago(1), restarts: 0 },
    { experimentId: "stuck", lane: "a", startedAt: ago(120), lastHeartbeatAt: ago(45), restarts: 0 },
    { experimentId: "hopeless", lane: "b", startedAt: ago(60), restarts: 2 },
    { experimentId: "restarted", lane: "b", startedAt: ago(1), lastHeartbeatAt: ago(90), restarts: 1 },
  ] });
  assert.deepEqual(decision.restart.map((entry) => entry.experimentId), ["stuck"]);
  assert.deepEqual(decision.retire.map((entry) => entry.experimentId), ["hopeless"]);
});

test("supervisor: effort goes to lanes with ratchet wins, but no lane starves the others", () => {
  const ledger = [
    { techniqueClass: "calibration", accepted: true, stage: "full" }, { techniqueClass: "calibration", accepted: true, stage: "full" },
    { techniqueClass: "routing", accepted: false, stage: "full" }, { techniqueClass: "routing", accepted: false, stage: "full" },
  ];
  const history = ["calibration", "calibration", "routing", "routing"].map((lane, index) => ({ experimentId: `h${index}`, lane, at: ago(60 - index) }));
  const scores = laneScores(["calibration", "routing", "tree_ensembles"], ledger, history);
  assert.ok(scores.find((entry) => entry.lane === "calibration").score > scores.find((entry) => entry.lane === "routing").score, "wins raise a lane");
  const queue = [
    { experimentId: "c1", lane: "calibration", ready: true }, { experimentId: "c2", lane: "calibration", ready: true }, { experimentId: "c3", lane: "calibration", ready: true },
    { experimentId: "r1", lane: "routing", ready: true }, { experimentId: "t1", lane: "tree_ensembles", ready: true },
    { experimentId: "w1", lane: "calibration", ready: false },
  ];
  const decision = planSupervisorTick({ now, queue, workers: [], ledger, history, policy: { workers: 3, diversityWindow: 4, maxLaneShare: 0.5 } });
  const lanes = decision.launch.map((entry) => entry.lane);
  assert.equal(decision.launch.length, 3);
  assert.ok(lanes.includes("calibration"), "the winning lane gets work");
  assert.ok(lanes.filter((lane) => lane === "calibration").length <= 2, "but not every slot");
  assert.ok(!decision.launch.some((entry) => entry.experimentId === "w1"), "unready work is never launched");
});

test("supervisor: the diversity monitor flags a dominant lane; parked work waits for its backoff", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({ experimentId: `h${index}`, lane: "routing", at: ago(30 - index) }));
  const decision = planSupervisorTick({ now, queue: [{ experimentId: "p", lane: "routing", ready: true, parkedAt: ago(2) }, { experimentId: "q", lane: "routing", ready: true, parkedAt: ago(20) }], workers: [], ledger: [], history, policy: { workers: 2, parkedBackoffMinutes: 10 } });
  assert.match(decision.warnings[0], /diversity: routing took 100%/);
  assert.deepEqual(decision.launch.map((entry) => entry.experimentId), ["q"]);
});

test("e2e: supervise runs all ready work, restarts a stuck worker from its checkpoint, and exits when idle", (t) => {
  const marker = join("/tmp", `evidra-supervise-${process.pid}-${Date.now()}`);
  // The first launch hangs in preflight with no heartbeat; the restarted worker passes.
  const { root, cli, propose } = workspace(t, { preflightCommand: ["sh", "-c", `test -f ${marker} || { touch ${marker}; sleep 120; }`] }, "import json\nprint(json.dumps({'score': 0.5}))\n");
  t.after(() => spawnSync("rm", ["-f", marker]));
  const ids = [propose("calibration tweak", "EV_SUBMISSION=base"), propose("routing gate", "EV_SUBMISSION=base", "SIM_R=1"), propose("waits for v50", "EV_SUBMISSION=v50")];
  const run = cli("supervise", "--workers", "1", "--stall-minutes", "0.05", "--interval-seconds", "1", "--exit-when-idle", "--max-minutes", "3");
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /restart: no heartbeat/);
  const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
  try {
    const status = (id) => store.experiments().find((entry) => entry.id === id).payload.status;
    assert.equal(status(ids[0]), "completed");
    assert.equal(status(ids[1]), "completed");
    assert.equal(status(ids[2]), "proposed", "the unready candidate was never launched");
    assert.ok(store.eventsByType("supervisor.restarted").length >= 1);
  } finally { store.close(); }
  assert.ok(existsSync(join(root, ".sota", "supervisor")));
  void readFileSync;
});
