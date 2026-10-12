// Live bounded GPU allocation probe after npm run build.
// Usage: node scripts/probe-modal-gpu.mjs /absolute/sdk/bin/python /absolute/sdk/bin/modal [GPU]
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ModalExecutor } from '../dist/core/executors.js';
import { ResearchStore } from '../dist/core/store.js';

assert(process.argv.length >= 4 && process.argv.length <= 5, 'Provide SDK Python and Modal CLI paths, optionally GPU type');
process.env.EVIDRA_MODAL_PYTHON = resolve(process.argv[2]);
process.env.PATH = dirname(resolve(process.argv[3])) + ':' + process.env.PATH;
delete process.env.EVIDRA_MODAL_GPU;
delete process.env.EVIDRA_MODAL_ENTRYPOINT;
const gpu = process.argv[4] ?? 'T4';
const root = mkdtempSync(join(tmpdir(), 'evidra-modal-gpu-')), workspace = join(root, 'workspace');
mkdirSync(workspace);
console.log(JSON.stringify({ root, gpu }));
writeFileSync(join(workspace, 'probe.py'), `import ctypes,json,pathlib,subprocess
cuda=ctypes.CDLL('libcuda.so.1')
assert cuda.cuInit(0)==0, 'CUDA driver initialization failed'
count=ctypes.c_int()
assert cuda.cuDeviceGetCount(ctypes.byref(count))==0
assert count.value>=1, 'No CUDA device visible'
names=subprocess.check_output(['nvidia-smi','--query-gpu=name','--format=csv,noheader'],text=True).strip().splitlines()
assert names
pathlib.Path('gpu.json').write_text(json.dumps({'cudaDeviceCount':count.value,'deviceNames':names}))
print('accuracy=1.0')
`);
const manifest = { id: 'modal-gpu-smoke', resources: { executor: 'modal', gpu, timeoutMinutes: 2 }, evaluation: { requiredArtifacts: ['gpu.json'] } };
const store = new ResearchStore(join(root, 'state.sqlite')), events = [];
store.saveExperiment({ id: manifest.id, payload: { ...manifest, status: 'running' } });
try {
  const result = await new ModalExecutor(root, event => {
    store.appendEvent('run.remote.' + event.phase, event);
    events.push(event);
    writeFileSync(join(root, 'events.json'), JSON.stringify(events, null, 2));
  }).run(manifest, workspace, ['python', 'probe.py'], undefined, 'accuracy');
  if (result.status === 'failed') store.saveExperiment({ id: manifest.id, payload: { ...manifest, status: 'failed' } });
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.status, 'completed', result.stderr);
  assert.equal(result.metrics.accuracy, 1);
  assert.equal(store.remoteExecutionState(manifest.id).confirmed, true);
  const terminal = events.find(event => event.phase === 'terminal');
  assert.equal(terminal.appState, 'STOPPED');
  assert.equal(terminal.runningTasks, 0);
  const artifact = JSON.parse(readFileSync(join(workspace, 'gpu.json'), 'utf8'));
  assert(artifact.cudaDeviceCount >= 1);
  const evidence = { at: new Date().toISOString(), gpuRequested: gpu, result, artifact, events, scope: 'Live CUDA driver/device detection, metric/artifact transport and stopped allocation proof. No GPU kernel workload, cancellation or performance claim.' };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ root, status: 'passed', artifact }));
} finally { store.close(); }
