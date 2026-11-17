// Offline fault probe. Run after npm run build; emits evidence and retains fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ResearchStore } from '../dist/core/store.js';

if (process.platform === 'win32') throw new Error('This SIGKILL/Unix permissions probe requires a Unix platform');
const root = mkdtempSync(join(tmpdir(), 'evidra-backup-crash-'));
const db = join(root, 'source.sqlite'), destination = join(root, 'backup.sqlite');
const store = new ResearchStore(db);
try {
  store.appendEvent('snapshot.version', { version: 1 });
  await store.backup(destination);
  store.appendEvent('snapshot.version', { version: 2 });
} finally { store.close(); }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const before = hash(destination);
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { ResearchStore } from ${JSON.stringify(new URL('../dist/core/store.js', import.meta.url).href)};
  const store = new ResearchStore(${JSON.stringify(db)});
  const backup = store.db.backup.bind(store.db);
  store.db.backup = async path => {
    await backup(path); // Complete the real SQLite backup, then interrupt publication.
    process.kill(process.pid, 'SIGKILL');
  };
  await store.backup(${JSON.stringify(destination)});
`], { encoding: 'utf8', timeout: 15_000 });
assert.equal(child.signal, 'SIGKILL', child.stderr);
assert.equal(hash(destination), before);
assert.equal(statSync(destination).mode & 0o777, 0o600);
const staging = readdirSync(root).filter(name => name.startsWith('.evidra-backup-'));
assert.equal(staging.length, 1);
assert.equal(statSync(join(root, staging[0])).mode & 0o777, 0o700);
for (const [path, versions] of [[destination, [1]], [db, [1, 2]]]) {
  const reopened = new ResearchStore(path);
  try {
    assert.equal(reopened.verifyEventChain().status, 'valid');
    assert.deepEqual(reopened.eventsByType('snapshot.version').map(event => event.payload.version), versions);
  } finally { reopened.close(); }
}
console.log(JSON.stringify({
  at: new Date().toISOString(), root, signal: child.signal,
  destinationHashPreserved: true, destinationMode: '0600', stagingMode: '0700',
  restoredVersions: [1], sourceVersions: [1, 2], unpublishedStagingDirectories: staging.length,
  scope: 'Actual SIGKILL after SQLite snapshot completion and before publication. No power-loss, orphan-cleanup or full campaign restore claim.',
}, null, 2));
