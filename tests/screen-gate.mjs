import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./helpers/launch-workspace.mjs";
import { ResearchStore } from "../dist/core/store.js";

const EVALUATOR = `import json, os, random, sys
random.seed(3)
delta = float(os.environ.get("SIM_DELTA", "0"))
stage = "reduced" if "--reduced" in sys.argv else "full"
open(".stages.log", "a").write(stage + " " + os.environ.get("SIM_DELTA", "base") + "\\n")
rows = [(f"u{i}", random.gauss(-1, 0.3) + delta) for i in range(400)]
with open("unit_scores.csv", "w") as f:
    f.write("unit,score\\n")
    for unit, score in rows: f.write(f"{unit},{score:.6f}\\n")
print(json.dumps({"score": sum(score for _, score in rows) / len(rows)}))
`;

test("e2e: a screen that does not beat its reference on paired units never gets a full evaluation", (t) => {
  const { root, cli, propose } = workspace(t, {}, EVALUATOR);
  const config = JSON.parse(readFileSync(join(root, "competition.json"), "utf8"));
  config.evaluator.unitScores = { path: "unit_scores.csv", idColumn: "unit", scoreColumn: "score" };
  config.ratchet = { mode: "paired" };
  config.execution = { reducedValidationCommand: ["python3", "evaluate.py", "--reduced"] };
  for (const path of ["competition.json", join("competitions", "toy", "competition.json")]) writeFileSync(join(root, path), JSON.stringify(config));
  assert.equal(cli("baseline").status, 0);
  const worse = propose("worse", "EV_SUBMISSION=base", "SIM_DELTA=-0.01");
  const better = propose("better", "EV_SUBMISSION=base", "SIM_DELTA=0.05");
  const rejected = cli("experiment", "run", worse);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /did not earn a full evaluation \(regressed\)/);
  const kept = cli("experiment", "run", better);
  assert.equal(kept.status, 0, kept.stderr);
  const store = new ResearchStore(join(root, ".sota", "database.sqlite"));
  try {
    assert.equal(store.experiments().find((entry) => entry.id === worse).payload.status, "rejected");
    assert.equal(store.experiments().find((entry) => entry.id === better).payload.status, "completed");
  } finally { store.close(); }
  const stages = (id) => readFileSync(join(root, ".sota", "worktrees", id, ".stages.log"), "utf8").trim().split("\n");
  assert.deepEqual(stages(worse), ["reduced -0.01"], "no full run was spent on the losing screen");
  assert.deepEqual(stages(better), ["reduced 0.05", "full 0.05"]);
  const ledger = JSON.parse(readFileSync(join(root, ".sota", "improvements.json"), "utf8"));
  assert.ok(ledger.entries?.some?.((entry) => entry.experimentId === worse && entry.stage === "screen" && entry.verdict === "regressed") ?? JSON.stringify(ledger).includes("regressed"));
  void existsSync;
});
