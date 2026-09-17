import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresProviderSetup } from '../dist/ui/onboarding.js';

test('unfinished provider setup blocks chat, research, and queued execution', () => {
  for (const request of ['hi', '/research start', '/challenge start', '!ls', '/loop resume']) {
    assert.equal(requiresProviderSetup(false, request), true, request);
    assert.equal(requiresProviderSetup(true, request), false, request);
  }
});

test('failed login leaves recovery and exit controls available', () => {
  for (const request of ['/login codex', '/login status', '/logout', '/provider local', '/help', '/exit', '/doctor']) {
    assert.equal(requiresProviderSetup(false, request), false, request);
  }
  assert.equal(requiresProviderSetup(false, '/login-malformed'), true);
});
