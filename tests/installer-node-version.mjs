import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

test('installer enforces the package Node minimum before downloading', () => {
  const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const probe = installer.match(/node -e '([^']+)'/);
  assert.ok(probe, 'installer contains its executable version probe');
  assert.ok(installer.indexOf(probe[0]) < installer.indexOf('git clone'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.node, '>=22.19.0');
  for (const [version, expected] of [['20.19.0', 1], ['22.0.0', 1], ['22.18.0', 1], ['22.19.0', 0], ['22.20.0', 0], ['24.18.0', 0]]) {
    let status;
    runInNewContext(probe[1], { process: { versions: { node: version }, exit: (code) => { status = code; } } });
    assert.equal(status, expected, version);
  }
});

test('installer signal traps exit without advancing and clean the workspace', () => {
  const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const traps = installer.split('\n').filter(line => line.startsWith('trap ')).join('\n');
  for (const [signal, expected] of [['INT', 130], ['TERM', 143]]) {
    const result = spawnSync('sh', ['-c', `cleanup() { printf 'CLEANED\\n'; }\n${traps}\nkill -${signal} $$\nprintf 'NEXT_STAGE\\n'`], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, expected);
    assert.match(result.stdout, /CLEANED/);
    assert.doesNotMatch(result.stdout, /NEXT_STAGE/);
    assert.match(result.stderr, /Installation (interrupted|terminated)/);
  }
});

test('installer gives actionable guidance when the global bin is hidden by PATH or shell caching', () => {
  const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(installer, /stale command cache/);
  assert.match(installer, /hash -r .*rehash/);
  assert.match(installer, /export PATH=/);
  assert.match(installer, /Verifying installation/);
});
