// Exercise the installed executor from an unrelated workspace without remote RPCs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(process.argv[2]);
const sdkCli = process.argv[3] ? resolve(process.argv[3]) : undefined;
const { ModalExecutor } = await import(pathToFileURL(join(packageRoot, "dist/core/executors.js")).href);
const root = mkdtempSync(join(tmpdir(), "evidra-installed-modal-"));
const previousPath = process.env.PATH, previousEntrypoint = process.env.EVIDRA_MODAL_ENTRYPOINT;
try {
  const bin = join(root, "bin"), workspace = join(root, "unrelated workspace");
  mkdirSync(bin); mkdirSync(workspace);
  writeFileSync(join(workspace, "modal_app.py"), "raise RuntimeError('wrong workspace worker')\n");
  writeFileSync(join(bin, "modal"), `#!${process.execPath}
    const fs=require('node:fs');
    if(process.argv.includes('--version')){console.log('disposable Modal client fixture');process.exit(0);}
    fs.writeFileSync('entrypoint.json',JSON.stringify(process.argv[3]));
    console.log('[evidra-call] '+JSON.stringify({submissionId:process.argv[process.argv.indexOf('--submission-id')+1],callId:'fc-installedworker'}));
    console.log(JSON.stringify({exitCode:0,stdout:'accuracy=0.9',stderr:'',artifacts:{}}));
  `, { mode: 0o755 });
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  delete process.env.EVIDRA_MODAL_ENTRYPOINT;
  const result = await new ModalExecutor(workspace).run({
    id: "installed-modal-probe", resources: { executor: "modal", timeoutMinutes: 1 },
  }, workspace, ["disposable-fixture"], undefined, "accuracy");
  assert.equal(result.status, "completed");
  const entrypoint = JSON.parse(readFileSync(join(workspace, "entrypoint.json"), "utf8"));
  const worker = join(packageRoot, "modal_app.py");
  assert.equal(entrypoint, `${worker}::run`);
  const workerSource = readFileSync(worker);
  assert.match(workerSource.toString(), /Generic Evidra experiment worker/);
  let sdkVersion;
  if (sdkCli) {
    const version = spawnSync(sdkCli, ["--version"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
    assert.equal(version.error, undefined);
    assert.equal(version.status, 0, version.stderr);
    sdkVersion = version.stdout.trim();
    const help = spawnSync(sdkCli, ["run", entrypoint, "--help"], {
      cwd: workspace, env: { ...process.env, EVIDRA_MODAL_WORKSPACE: workspace },
      encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(help.error, undefined);
    assert.equal(help.status, 0, help.stderr);
    for (const flag of ["--command-json", "--cwd", "--artifacts-json", "--timeout-seconds", "--submission-id", "--config-sha256"]) {
      assert.ok(help.stdout.includes(flag), `Missing shipped Modal CLI flag: ${flag}`);
    }
  }
  console.log(JSON.stringify({
    schemaVersion: 1, workerSourceSha256: createHash("sha256").update(workerSource).digest("hex"),
    executorSourceSha256: createHash("sha256").update(readFileSync(join(packageRoot, "dist/core/executors.js"))).digest("hex"),
    sdkVersion,
    shippedWorkerResolvedOutsidePackage: true, workspaceDecoyIgnored: true,
    actualSdkCliHelpVerified: Boolean(sdkCli), remoteCalls: 0,
    scope: "Installed package path resolution and optional SDK CLI loading; live remote execution is unverified.",
  }, null, 2));
} finally {
  if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  if (previousEntrypoint === undefined) delete process.env.EVIDRA_MODAL_ENTRYPOINT; else process.env.EVIDRA_MODAL_ENTRYPOINT = previousEntrypoint;
  rmSync(root, { recursive: true, force: true });
}
