// Live CPU probe. Usage after npm run build:
// node scripts/probe-modal-concurrent-cancellation.mjs /absolute/sdk/bin/python /absolute/sdk/bin/modal
// Uses configured Modal credentials and launches two bounded CPU jobs.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ModalExecutor } from '../dist/core/executors.js';
import { ResearchStore } from '../dist/core/store.js';
import { reconcileRemoteExperiment } from '../dist/core/remote-reconciliation.js';

if (process.argv.length !== 4) throw new Error('Provide absolute SDK Python and Modal CLI paths');
const python = resolve(process.argv[2]), cli = resolve(process.argv[3]);
assert(!/[\r\n\s]/.test(python), 'Python shebang requires a path without whitespace');
const root = mkdtempSync(join(tmpdir(), 'evidra-modal-concurrent-'));
console.log(JSON.stringify({ root })); // Keep this state directory for interrupted-probe recovery.
const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'modal'), `#!${python}
import os,sys,pathlib,json
if len(sys.argv)>1 and sys.argv[1]=='run':
    nonce=sys.argv[sys.argv.index('--submission-id')+1]
    pathlib.Path(${JSON.stringify(root)}+'/'+nonce+'.json').write_text(json.dumps({'pid':os.getpid(),'submissionId':nonce}))
os.execv(${JSON.stringify(cli)},[${JSON.stringify(cli)},*sys.argv[1:]])
`, { mode: 0o755 });
process.env.PATH = bin + ':' + process.env.PATH;
process.env.EVIDRA_MODAL_PYTHON = python;
delete process.env.EVIDRA_MODAL_GPU;
delete process.env.EVIDRA_MODAL_ENTRYPOINT;
const db = join(root, 'state.sqlite'), store = new ResearchStore(db), events = [], receipts = {};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(id, seconds) {
  const workspace = join(root, id);
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'probe.py'), `import time,json,pathlib\ntime.sleep(${seconds})\npathlib.Path('result.json').write_text(json.dumps({'experiment':'${id}'}))\nprint('accuracy=1.0')\n`);
  const manifest = { id, resources: { executor: 'modal', timeoutMinutes: 2 }, evaluation: { requiredArtifacts: ['result.json'] } };
  store.saveExperiment({ id, payload: { ...manifest, status: 'running' } });
  const execution = { settled: false };
  execution.promise = new ModalExecutor(root, event => {
    store.appendEvent('run.remote.' + event.phase, event);
    events.push(event);
    writeFileSync(join(root, 'events.json'), JSON.stringify(events, null, 2));
    if (event.phase === 'submitted') receipts[id] = event;
  }).run(manifest, workspace, ['python', 'probe.py'], undefined, 'accuracy').then(result => {
    if (result.status === 'failed') store.saveExperiment({ id, payload: { ...manifest, status: 'failed' } });
    return result;
  }).finally(() => { execution.settled = true; });
  // Observe immediately: a peer can reject while the receipt barrier is pending.
  // Awaiting the original promise below still propagates its failure.
  execution.promise.catch(() => {});
  return execution;
}
const target = start('target', 45), peer = start('peer', 35);
let passed = false;
try {
  const deadline = Date.now() + 120_000;
  while (!receipts.target || !receipts.peer) {
    assert(Date.now() < deadline, 'Receipt deadline exceeded; inspect retained state before retrying');
    assert(!(target.settled && !receipts.target || peer.settled && !receipts.peer), 'Execution ended without a receipt');
    await pause(100);
  }
  assert.notEqual(receipts.target.appId, receipts.peer.appId);
  assert.notEqual(receipts.target.appName, receipts.peer.appName);
  await pause(2000);
  const client = JSON.parse(readFileSync(join(root, receipts.target.submissionId + '.json'), 'utf8'));
  assert.equal(client.submissionId, receipts.target.submissionId);
  assert(!target.settled, 'Target finished before interruption');
  process.kill(client.pid, 'SIGKILL');
  const targetResult = await target.promise;
  assert.deepEqual(targetResult.metrics, {});
  assert.equal(store.experiments().find(e => e.id === 'target').payload.remoteReconciliationRequired, true);
  const cancellationAttempts = [await reconcileRemoteExperiment(db, root, 'target', { cancelModal: true })];
  if (!cancellationAttempts.at(-1).released) {
    await pause(1000);
    cancellationAttempts.push(await reconcileRemoteExperiment(db, root, 'target', { cancelModal: true }));
  }
  assert.equal(cancellationAttempts.at(-1).released, true);
  const peerResult = await peer.promise;
  assert.equal(peerResult.status, 'completed');
  assert.equal(peerResult.metrics.accuracy, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'peer', 'result.json'), 'utf8')), { experiment: 'peer' });
  const cleanup = store.eventsByTypes(['run.remote.cleanup.requested', 'run.remote.cleanup.observed']);
  assert(!cleanup.some(e => e.payload.experimentId === 'peer'));
  assert.equal(store.remoteExecutionState('target').confirmed, true);
  assert.equal(store.remoteExecutionState('peer').confirmed, true);
  assert.equal(store.runs().length, 0);
  writeFileSync(join(root, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), gpuRequested: false, receipts, targetResult: { ...targetResult, stdout: '[client diagnostics omitted]' }, peerResult, cancellationAttempts, events, cleanup, scope: 'Distinct apps in one store; no shared-input or GPU claim.' }, null, 2) + '\n');
  passed = true;
  console.log(JSON.stringify({ root, status: 'passed' }));
} finally {
  // Let callbacks finish before closing SQLite, even when an assertion fails.
  // No automatic stop by name: retained receipts identify only owned apps.
  const outcomes = await Promise.allSettled([target.promise, peer.promise]);
  try {
    writeFileSync(join(root, 'recovery.json'), JSON.stringify({
      at: new Date().toISOString(), passed, database: db, receipts,
      executions: outcomes.map((outcome, index) => ({
        experimentId: index === 0 ? 'target' : 'peer',
        promiseStatus: outcome.status,
        ...(outcome.status === 'fulfilled' ? { status: outcome.value.status, exitCode: outcome.value.exitCode } : {}),
        remoteState: store.remoteExecutionState(index === 0 ? 'target' : 'peer'),
      })),
      cleanup: store.eventsByTypes(['run.remote.cleanup.requested', 'run.remote.cleanup.observed']),
      instruction: 'Inspect this database and exact recorded identities before retrying; missing receipts do not prove remote termination.',
    }, null, 2) + '\n');
  } finally { store.close(); }
}
