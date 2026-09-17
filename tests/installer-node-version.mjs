import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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
