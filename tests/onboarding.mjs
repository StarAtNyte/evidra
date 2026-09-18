import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresProviderSetup } from '../dist/ui/onboarding.js';
import { insertAtCursor, isShiftEnterSequence } from '../dist/ui/input-keys.js';
import { normalizeSessionConfig } from '../dist/ui/app.js';

test('unfinished provider setup blocks chat, research, and queued execution', () => {
  for (const request of ['hi', '/research start', '/challenge start', '!ls', '/loop resume']) {
    assert.equal(requiresProviderSetup(false, request), true, request);
    assert.equal(requiresProviderSetup(true, request), false, request);
  }
});

test('failed login leaves recovery and exit controls available', () => {
  for (const request of ['/login codex', '/login status', '/logout', '/provider local', '/fallback', '/limits', '/help', '/exit', '/doctor']) {
    assert.equal(requiresProviderSetup(false, request), false, request);
  }
  assert.equal(requiresProviderSetup(false, '/login-malformed'), true);
});

test('terminal Shift+Enter encodings become a single inserted newline', () => {
  assert.equal(isShiftEnterSequence('\u001b[27;2;13~'), true);
  assert.equal(isShiftEnterSequence('\u001b[13;2u'), true);
  assert.equal(isShiftEnterSequence('ordinary text'), false);
  assert.deepEqual(insertAtCursor('abcd', 2, '\n'), { value: 'ab\ncd', cursor: 3 });
  assert.deepEqual(insertAtCursor('abcd', 99, 'x'), { value: 'abcdx', cursor: 5 });
});

test('fresh terminal config resets permissions and provider thread', () => {
  const normalized = normalizeSessionConfig({
    provider: 'codex',
    model: 'gpt-5.3-codex',
    autonomy: 'yolo',
    codexThreadId: 'thread-from-previous-terminal',
    campaign: { status: 'running', startedAt: '2026-09-18T00:00:00.000Z', budgetMinutes: 90 },
  });
  assert.equal(normalized.autonomy, 'safe');
  assert.equal(normalized.codexThreadId, undefined);
  assert.equal(normalized.model, 'gpt-5.6-luna');
  assert.equal(normalized.campaign?.status, 'paused');
});
