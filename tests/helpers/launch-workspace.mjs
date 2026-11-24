import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A committed toy competition workspace driven through the real CLI. */
export function workspace(t, launch, evaluator, files = {}, extraConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), "evidra-launch-"));
  if (typeof launch === "function") launch = launch(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "evaluate.py"), evaluator);
  writeFileSync(join(root, "estimator.py"), "");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  writeFileSync(join(root, ".gitignore"), "__pycache__/\n");
  mkdirSync(join(root, "subs", "base"), { recursive: true });
  mkdirSync(join(root, "subs", "v50"), { recursive: true });
  writeFileSync(join(root, "subs", "v50", "model.py"), "");
  const config = { id: "toy", name: "toy", taskType: "probabilistic_classification", datasetRevision: "v1", metric: { name: "score", direction: "maximize" }, evaluator: { command: ["python3", "evaluate.py"], estimatorPath: "estimator.py" }, baselineCommand: ["python3", "evaluate.py"], experimentCommand: ["python3", "evaluate.py"], workspacePath: ".", launch: { readiness: { envPaths: { EV_SUBMISSION: "subs/{value}" }, trusted: ["subs/base"] }, ...launch }, ...extraConfig };
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

