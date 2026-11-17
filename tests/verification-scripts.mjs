import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingVerificationScripts } from '../dist/core/verification-execution.js';

test('missing post-evaluation verifier is diagnosed before it can waste a scorer run', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidra-verifier-'));
  try {
    const commands = [['/project/.venv/bin/python', 'tools/preflight.py', '--solution', 'solution']];
    assert.match(missingVerificationScripts(root, commands)[0], /Verification 1.*tools\/preflight.py.*Stage it/);
    mkdirSync(join(root, 'tools'));
    writeFileSync(join(root, 'tools/preflight.py'), 'print("checked")\n');
    assert.deepEqual(missingVerificationScripts(root, commands), []);
    assert.deepEqual(missingVerificationScripts(root, [['python3.12', '-u', join(root, 'tools/preflight.py')]]), []);
    mkdirSync(join(root, 'tools/directory.py'));
    assert.equal(missingVerificationScripts(root, [['python', 'tools/directory.py']]).length, 1);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('inline, module, and non-Python verifiers do not invent missing scripts', () => {
  assert.deepEqual(missingVerificationScripts('/tmp', [
    ['python', '-c', 'print("file.py")'], ['python3', '-m', 'unittest', 'missing.py'],
    ['bash', '-lc', 'python generated.py'], ['node', 'check.js'], [],
  ]), []);
});
