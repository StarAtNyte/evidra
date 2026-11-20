import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./helpers/launch-workspace.mjs";
import { extractTraceback, parseRepairAction, repairPolicyViolations } from "../dist/core/self-repair.js";
import { ResearchStore } from "../dist/core/store.js";

const status = (root, id) => { const store = new ResearchStore(join(root, ".sota", "database.sqlite")); try { return store.experiments().find((entry) => entry.id === id)?.payload; } finally { store.close(); } };
const calls = (root) => existsSync(join(root, ".sota", "agent-calls.log")) ? readFileSync(join(root, ".sota", "agent-calls.log"), "utf8").trim().split("\n").length : 0;
// A scripted repair agent: reads the evidence pack, logs the call, applies a fix, prints a JSON action.
const agent = (body) => (root) => {
  const path = join(root, "..", `${root.split("/").pop()}-repair_agent.py`);
  writeFileSync(path, `import json, os, sys\npack = json.load(open(os.environ["EVIDRA_REPAIR_PACK"]))\nopen(${JSON.stringify(join(root, ".sota", "agent-calls.log"))}, "a").write(pack["kind"] + " " + pack["stage"] + "\\n")\n${body}\n`);
  return { repair: { agentCommand: ["python3", path], maxAttempts: 3 } };
};

test("repair primitives: tracebacks, structured actions, policy", () => {
  assert.match(extractTraceback("noise\nTraceback (most recent call last):\n  File \"x.py\", line 1\nNameError: name 'q' is not defined\n"), /NameError/);
  assert.deepEqual(parseRepairAction('thinking...\n{"kind":"env","env":{"XDG_RUNTIME_DIR":"/run/user/1000"}}'), { kind: "env", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, summary: undefined });
  assert.equal(parseRepairAction("no json here"), undefined);
  const context = { writableRoots: ["/ws"], protectedFiles: ["/ws/evaluate.py"], forbiddenEnv: ["CUDA_VISIBLE_DEVICES", "MEM"] };
  assert.deepEqual(repairPolicyViolations({ kind: "env", env: { XDG_RUNTIME_DIR: "/run/user/1" } }, [], context), []);
  assert.match(repairPolicyViolations({ kind: "env", env: { CUDA_VISIBLE_DEVICES: "1" } }, [], context)[0], /resource contract/);
  assert.match(repairPolicyViolations({ kind: "env", env: { PATH: "/x" } }, [], context)[0], /protected process variable/);
  assert.match(repairPolicyViolations({ kind: "patch" }, ["/etc/hosts"], context)[0], /outside the workspace/);
  assert.match(repairPolicyViolations({ kind: "patch" }, ["/ws/evaluate.py"], context)[0], /protected evaluator file/);
  assert.deepEqual(repairPolicyViolations({ kind: "patch" }, ["/ws/estimator.py"], context), []);
  assert.ok(repairPolicyViolations({ kind: "escalate", reason: "needs root", needs: ["kill 1234"] }, [], context).length >= 2);
});

const BUS_EVALUATOR = "import json, os, sys\nif os.environ.get('SIM_BUS') != 'ok' and os.environ.get('SIM_NEEDS_BUS'):\n    print('Failed to connect to bus: No medium found', file=sys.stderr); sys.exit(1)\nprint(json.dumps({'score': 0.5}))\n";

test("e2e: a simulated bus failure is repaired by the agent, the run resumes, and the fix is remembered", (t) => {
  const { root, cli, propose } = workspace(t, agent('print(json.dumps({"kind": "env", "env": {"SIM_BUS": "ok"}, "summary": "restore the session bus"}))'), BUS_EVALUATOR);
  const first = propose("first", "EV_SUBMISSION=base", "SIM_NEEDS_BUS=1");
  const run = cli("experiment", "run", first);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /repaired \(agent, attempt 1\); resuming/);
  assert.equal(calls(root), 1);
  const memory = JSON.parse(readFileSync(join(root, ".sota", "repair-memory.json"), "utf8"));
  assert.deepEqual(memory[0].env, { SIM_BUS: "ok" });
  const second = propose("second", "EV_SUBMISSION=base", "SIM_NEEDS_BUS=1");
  assert.equal(cli("experiment", "run", second).status, 0);
  assert.equal(calls(root), 1, "the remembered fix is applied instantly; the agent is not called again");
});

test("e2e: a candidate with a NameError is patched by the agent and evaluated", (t) => {
  const { root, cli, propose } = workspace(t, agent('open("estimator.py", "w").write("def delta():\\n    return 0.25\\n")\nprint(json.dumps({"kind": "patch", "summary": "define the missing name"}))'),
    "import json, os\nscore = 0.5\nif os.environ.get('SIM_CANDIDATE'):\n    import estimator\n    score = estimator.delta()\nprint(json.dumps({'score': score}))\n",
    { "estimator.py": "def delta():\n    return undefined_name\n" });
  const id = propose("broken candidate", "EV_SUBMISSION=base", "SIM_CANDIDATE=1");
  const run = cli("experiment", "run", id);
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /failed \(experiment: .*repair attempt 1\/3/);
  assert.match(run.stdout, /repaired \(agent, attempt 1\)/);
  assert.equal(status(root, id).status, "completed");
  assert.match(readFileSync(join(root, ".sota", "agent-calls.log"), "utf8"), /^experiment /);
});

test("e2e: three failed repairs mark the candidate failed with a diagnosis, and other work continues", (t) => {
  const { root, cli, propose } = workspace(t, agent('print(json.dumps({"kind": "patch", "summary": "tried something"}))'), "import json, os\nif os.environ.get('SIM_BREAK'):\n    raise NameError(\"name 'undefined_name' is not defined\")\nprint(json.dumps({'score': 0.5}))\n");
  const broken = propose("hopeless", "EV_SUBMISSION=base", "SIM_BREAK=1");
  const healthy = propose("healthy", "EV_SUBMISSION=base");
  const run = cli("experiment", "run", broken);
  assert.equal(run.status, 1);
  assert.equal(calls(root), 3);
  assert.equal(status(root, broken).status, "failed");
  assert.match(String(run.stdout), /repair attempt 3\/3/);
  assert.equal(cli("experiment", "run", healthy).status, 0, "the campaign moves on to other work");
});

test("e2e: an out-of-policy fix is escalated with a note, not applied, and the rest keeps running", (t) => {
  const { root, cli, propose } = workspace(t, agent('print(json.dumps({"kind": "env", "env": {"CUDA_VISIBLE_DEVICES": "1"}, "summary": "use the other GPU"}))'), BUS_EVALUATOR);
  const blocked = propose("needs another gpu", "EV_SUBMISSION=base", "SIM_NEEDS_BUS=1");
  const healthy = propose("healthy", "EV_SUBMISSION=base");
  const run = cli("experiment", "run", blocked);
  assert.equal(run.status, 75, run.stderr);
  assert.match(run.stderr, /escalated to a human/);
  const note = readFileSync(join(root, ".sota", "ESCALATIONS.md"), "utf8");
  assert.match(note, /CUDA_VISIBLE_DEVICES is fixed by the resource contract/);
  assert.equal(status(root, blocked).status, "proposed", "escalated work is parked, not failed");
  assert.equal(existsSync(join(root, ".sota", "repair-memory.json")), false, "nothing out of policy is remembered");
  assert.equal(cli("experiment", "run", healthy).status, 0);
});
