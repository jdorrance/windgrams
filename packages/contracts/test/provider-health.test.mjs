import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderHealth } from '@windgrams/contracts/provider-health';

const ownership = { group: 'provider', models: ['model-a'] };
const attemptedAt = '2026-10-25T12:00:00Z', completedAt = '2026-10-25T12:30:00Z';
const entry = { attemptedAt, completedAt, lastSuccessfulRefreshAt: completedAt, outcome: 'updated', reason: null };
const document = value => ({ schemaVersion: 1, group: ownership.group, models: { 'model-a': value } });

test('refresh health preserves lifecycle states and checks caller-supplied ownership', () => {
  for (const outcome of ['updated', 'retained', 'unavailable', 'running']) {
    const value = { ...entry, outcome, completedAt: outcome === 'running' ? null : completedAt,
      lastSuccessfulRefreshAt: outcome === 'updated' ? completedAt : null };
    assert.deepEqual(parseProviderHealth(document(value), ownership), document(value));
  }
  assert.equal(parseProviderHealth(document(entry), { ...ownership, group: 'other' }), null);
  assert.equal(parseProviderHealth(document(entry), { ...ownership, models: ['other'] }), null);
});

test('refresh health rejects malformed or contradictory attempt timestamps', () => {
  for (const patch of [
    { attemptedAt: 'yesterday' }, { attemptedAt: '2026-10-25T12:00:00' },
    { completedAt: '2026-10-25T11:00:00Z' }, { completedAt: null },
    { lastSuccessfulRefreshAt: '2026-10-25T13:00:00Z' },
    { lastSuccessfulRefreshAt: attemptedAt }, { outcome: 'running' },
    { outcome: 'success' }, { reason: 'x'.repeat(1001) }, { reason: 1 },
  ]) assert.equal(parseProviderHealth(document({ ...entry, ...patch }), ownership), null, JSON.stringify(patch));
  assert.equal(parseProviderHealth({ ...document(entry), schemaVersion: 2 }, ownership), null);
  assert.equal(parseProviderHealth(null, ownership), null);
});
