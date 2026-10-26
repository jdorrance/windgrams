import test from 'node:test';
import assert from 'node:assert/strict';
import { alertBody, fingerprintChecks, planAlertAction } from './report-served-failure.mjs';
import { rollbackEligible } from './monitor-served.mjs';

const failing = { ok: false, checkedAt: '2026-10-26T12:00:00Z', baseUrl: 'https://example.invalid/data', rollbackEligible: false,
  checks: [{ product: 'gfs', kind: 'point', status: 'stale', ok: false, reason: 'old' }, { product: 'hrrr-conus', kind: 'point', status: 'current', ok: true, reason: '' }] };
const now = Date.parse('2026-10-26T12:00:00Z');

test('rollback eligibility separates corrupt bytes from staleness', () => {
  assert.equal(rollbackEligible([{ kind: 'point', status: 'unavailable' }]), true);
  assert.equal(rollbackEligible([{ kind: 'regional', status: 'unavailable' }]), true);
  assert.equal(rollbackEligible([{ kind: 'point', status: 'stale' }, { kind: 'refresh', status: 'unavailable' }]), false);
});

test('alert planner creates once, suppresses repeats, comments on change, closes on recovery', () => {
  assert.deepEqual(planAlertAction({ report: failing, openIssue: null, now }), { action: 'create', fingerprint: 'gfs:point:stale' });
  const open = { number: 7, fingerprint: 'gfs:point:stale', lastCommentAt: '2026-10-26T11:00:00Z' };
  assert.equal(planAlertAction({ report: failing, openIssue: open, now }).action, 'none');
  const changed = { ...failing, checks: [...failing.checks, { product: 'rrfs', kind: 'point', status: 'unavailable', ok: false, reason: 'bad bytes' }] };
  assert.equal(planAlertAction({ report: changed, openIssue: open, now }).action, 'comment');
  const later = Date.parse('2026-10-27T12:00:01Z');
  assert.equal(planAlertAction({ report: failing, openIssue: open, now: later }).action, 'comment');
  assert.deepEqual(planAlertAction({ report: { ...failing, ok: true }, openIssue: open, now }), { action: 'close', issue: 7 });
  assert.deepEqual(planAlertAction({ report: { ...failing, ok: true }, openIssue: null, now }), { action: 'none' });
  assert.equal(fingerprintChecks(failing.checks), 'gfs:point:stale');
  assert.match(alertBody({ ...failing, rollbackEligible: true }, 'gfs:point:stale'), /previous complete publication/);
  assert.match(alertBody(failing, 'gfs:point:stale'), /cannot repair/);
});
