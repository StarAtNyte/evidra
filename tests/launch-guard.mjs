import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateDependencies, checkResources, classifyLaunchFailure, dependencyStatus, detectSystemicFailure,
  failureSignature, missingEnvironment, parseTimeVerbose, resolveEnvContract, resolveLaunchPolicy, resourcesFromOutput,
} from "../dist/core/launch-guard.js";

const policy = resolveLaunchPolicy(undefined);

test("launch failures are classified infra vs experiment", () => {
  assert.equal(classifyLaunchFailure({ exitCode: 1, output: "Failed to connect to bus: No medium found" }, policy).kind, "infra");
  assert.equal(classifyLaunchFailure({ exitCode: 127, output: "" }, policy).kind, "infra", "command not found exit code");
  assert.equal(classifyLaunchFailure({ exitCode: 1, output: "Traceback ... ValueError: shapes do not match" }, policy).kind, "experiment");
  assert.equal(classifyLaunchFailure({ exitCode: 0, output: "" }, policy).kind, "ok");
  const custom = resolveLaunchPolicy({ infraPatterns: ["GPU lock unavailable"] });
  assert.equal(classifyLaunchFailure({ exitCode: 3, output: "GPU lock unavailable" }, custom).kind, "infra");
  assert.equal(failureSignature("run 1795 at /tmp/x/ab12cd34ef: bus 7"), failureSignature("run 1802 at /tmp/y/ff00ee11dd: bus 9"), "signatures ignore ids, numbers and paths");
});

test("identical fast failures across experiments are systemic; slow idea-specific ones are not", () => {
  const now = Date.parse("2026-11-20T07:00:00Z");
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const fast = ["a", "b", "c"].map((experimentId, index) => ({ experimentId, signature: "sig", at: at(index), kind: "experiment", durationSeconds: 4 }));
  assert.deepEqual(detectSystemicFailure(fast, policy, now).experiments.sort(), ["a", "b", "c"]);
  assert.equal(detectSystemicFailure(fast.slice(0, 2), policy, now).systemic, false, "below the threshold");
  assert.equal(detectSystemicFailure(fast.map((entry) => ({ ...entry, durationSeconds: 900 })), policy, now).systemic, false, "slow experiment failures are evidence about the ideas");
  assert.equal(detectSystemicFailure(fast.map((entry) => ({ ...entry, kind: "infra", durationSeconds: 900 })), policy, now).systemic, true, "infra failures count at any speed");
  assert.equal(detectSystemicFailure(fast.map((entry) => ({ ...entry, at: at(120) })), policy, now).systemic, false, "outside the window");
  assert.equal(detectSystemicFailure([...fast.slice(0, 2), { ...fast[2], signature: "other" }], policy, now).systemic, false, "different signatures");
});

test("readiness: env-implied dependencies need a marker; trusted and declared conditions work", () => {
  const readiness = { defaultMarker: "READY", envPaths: { EV_SUBMISSION: "/subs/{value}" }, trusted: ["/subs/v48_final"] };
  const files = new Set(["/subs/v50_bx", "/subs/v50_bx/model.py", "/subs/v48_final", "/reports/v51.json"]);
  const exists = (path) => files.has(path);
  const v50 = candidateDependencies(undefined, { EV_SUBMISSION: "v50_bx", SIM_PP: "1" }, readiness);
  assert.deepEqual(v50, [{ path: "/subs/v50_bx", producer: "external" }]);
  const waiting = dependencyStatus(v50, readiness, { exists });
  assert.equal(waiting.ready, false, "a directory with files is not ready until its producer marks it");
  assert.match(waiting.pending[0].waitingFor, /READY/);
  files.add("/subs/v50_bx/READY");
  assert.equal(dependencyStatus(v50, readiness, { exists }).ready, true);
  assert.equal(dependencyStatus(candidateDependencies(undefined, { EV_SUBMISSION: "v48_final" }, readiness), readiness, { exists }).ready, true, "trusted baseline");
  assert.equal(dependencyStatus([{ path: "/subs/v51" }], readiness, { exists }).pending[0].waitingFor, "path does not exist");
  assert.equal(dependencyStatus([{ path: "/subs/v50_bx", readyWhen: { file: "/reports/v51.json" } }], readiness, { exists }).ready, true);
  assert.equal(dependencyStatus([{ path: "/subs/v50_bx", readyWhen: { command: ["parity"] } }], readiness, { exists, run: () => false }).ready, false, "a failing parity check blocks");
});

test("env contract: required env, time -v parsing, hosted limits with margin and wall scaling", () => {
  assert.deepEqual(missingEnvironment(["XDG_RUNTIME_DIR", "CUDA_VISIBLE_DEVICES"], { XDG_RUNTIME_DIR: "/run/user/1" }), ["CUDA_VISIBLE_DEVICES"]);
  const parsed = parseTimeVerbose("\tElapsed (wall clock) time (h:mm:ss or m:ss): 1:02:03.5\n\tMaximum resident set size (kbytes): 14680064\n");
  assert.equal(parsed.wallSeconds, 3723.5);
  assert.equal(parsed.peakRssMb, 14336);
  assert.deepEqual(resourcesFromOutput('noise\n{"cps_skill": 0.5, "resources": {"peakRssMb": 9000, "wallSeconds": 700}}'), { peakRssMb: 9000, wallSeconds: 700 });
  const contract = resolveEnvContract({ hosted: { memoryGb: 16, wallSeconds: 3600 }, wallScale: 0.8 });
  assert.equal(checkResources({ peakRssMb: 13000, wallSeconds: 3000 }, contract).ok, true, "13 GB < 85% of 16 GB; 3000 s x 0.8 < 3060 s");
  const over = checkResources({ peakRssMb: 14336, wallSeconds: 4000 }, contract);
  assert.equal(over.ok, false);
  assert.equal(over.reasons.length, 2);
  assert.match(over.reasons[0], /85% of hosted 16 GB/);
  assert.equal(over.predictedHostedWallSeconds, 3200);
  assert.equal(checkResources(undefined, contract).ok, true, "unmeasured runs are not rejected");
  const informed = checkResources({ wallSeconds: 4000 }, resolveEnvContract({ hosted: { wallSeconds: 3600 }, wallScale: 1, measuredWallRatio: { value: 0.77 } }));
  assert.equal(informed.ok, false, "acceptance stays on the conservative wallScale");
  assert.equal(informed.measuredHostedWallSeconds, 3080);
});

function workspace(t, launch, evaluator) {
  const root = mkdtempSync(join(tmpdir(), "evidra-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "evaluate.py"), evaluator);
  writeFileSync(join(root, "estimator.py"), "");
  writeFileSync(join(root, ".gitignore"), "__pycache__/\n");
  mkdirSync(join(root, "subs", "base"), { recursive: true });
  mkdirSync(join(root, "subs", "v50"), { recursive: true });
  writeFileSync(join(root, "subs", "v50", "model.py"), "");
  const config = { id: "toy", name: "toy", taskType: "probabilistic_classification", datasetRevision: "v1", metric: { name: "score", direction: "maximize" }, evaluator: { command: ["python3", "evaluate.py"], estimatorPath: "estimator.py" }, baselineCommand: ["python3", "evaluate.py"], experimentCommand: ["python3", "evaluate.py"], workspacePath: ".", launch: { readiness: { envPaths: { EV_SUBMISSION: "subs/{value}" }, trusted: ["subs/base"] }, ...launch } };
  writeFileSync(join(root, "competition.json"), JSON.stringify(config));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("add", "-A"); git("commit", "-qm", "init");
  const cli = (...args) => spawnSync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, EVIDRA_STATE_DIR: join(root, ".sota") } });
  assert.equal(cli("init", "toy").status, 0);
  assert.equal(cli("baseline").status, 0);
  const propose = (title, ...env) => {
    const hypothesis = cli("hypothesis", "--title", title, "--family", title, "--mode", "verify", "--env", ...env).stdout.match(/hyp_\S+/)[0];
    cli("experiment", "propose", hypothesis);
    return JSON.parse(cli("launch", "status", "--json").stdout).waiting.find((entry) => entry.experimentId.includes(hypothesis.slice(4, 20))).experimentId;
  };
  const status = (id) => {
    const out = cli("launch", "status", "--json").stdout;
    return JSON.parse(out);
  };
  return { root, cli, propose, status };
}

const OK_EVALUATOR = "import json, os\nif os.environ.get('SIM_FAIL'):\n    import sys; print('Failed to connect to bus: No medium found', file=sys.stderr); sys.exit(1)\nprint(json.dumps({'score': 0.5}))\n";

test("e2e: unready candidates wait; a broken launch path halts before any attempt (exit 75)", (t) => {
  const marker = join(tmpdir(), `evidra-bus-${process.pid}-${Date.now()}`);
  const { root, cli, propose } = workspace(t, { preflightCommand: ["sh", "-c", `test -f ${marker} || { echo 'Failed to connect to bus: No medium found' >&2; exit 1; }`] }, OK_EVALUATOR);
  t.after(() => rmSync(marker, { force: true }));
  const waiting = propose("v50 switch", "EV_SUBMISSION=v50", "SIM_X=1");
  const ready = propose("base knob", "EV_SUBMISSION=base");
  const wait = cli("experiment", "run", waiting);
  assert.equal(wait.status, 75);
  assert.match(wait.stdout, /waiting: .*READY/);
  const broken = cli("experiment", "run", ready);
  assert.equal(broken.status, 75, broken.stderr);
  assert.match(broken.stderr, /preflight failed .*Failed to connect to bus/);
  assert.ok(existsSync(join(root, ".sota", "launch-halt.json")));
  const report = JSON.parse(cli("launch", "status", "--json").stdout);
  assert.ok(report.halt);
  assert.ok(report.waiting.some((entry) => entry.experimentId === ready), "the experiment is back to proposed, not failed");
  assert.equal(cli("experiment", "run", ready).status, 75, "halted launches are refused");
  writeFileSync(marker, "");
  cli("launch", "clear");
  writeFileSync(join(root, "subs", "v50", "READY"), "");
  const run = cli("experiment", "run", waiting);
  assert.equal(run.status, 0, run.stderr);
});

test("e2e: infra stage failures are retried once, never count, and N identical ones halt", (t) => {
  const { root, cli, propose } = workspace(t, {}, OK_EVALUATOR);
  const ids = ["a", "b", "c"].map((name) => propose(`broken ${name}`, "EV_SUBMISSION=base", "SIM_FAIL=1"));
  for (const id of ids.slice(0, 2)) {
    const result = cli("experiment", "run", id);
    assert.equal(result.status, 75, result.stderr);
    assert.match(result.stderr, /not an experiment result/);
  }
  const third = cli("experiment", "run", ids[2]);
  assert.equal(third.status, 75);
  assert.match(third.stderr, /LAUNCHES HALTED: 3 experiments failed identically/);
  const report = JSON.parse(cli("launch", "status", "--json").stdout);
  assert.equal(report.waiting.filter((entry) => ids.includes(entry.experimentId)).length, 3, "all three remain proposed");
  const events = readFileSync(join(root, ".sota", "launch-halt.json"), "utf8");
  assert.match(events, /Failed to connect to bus/);
});
