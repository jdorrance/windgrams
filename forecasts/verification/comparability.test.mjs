import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonIssue, intervalIssue } from './comparability.mjs';
import { SCIENTIFIC_QUANTITIES, PROVIDER_COMPARISON_DEFINITIONS, CONVERGENCE_DISTINCTION } from './definitions.mjs';
import { DRJACK_WXTOFLY_COMPARISON } from './provider-inventory.mjs';
import { EXCLUSIONS } from './wxtofly/fields.mjs';

const base = {
  quantity: 'temperature',
  unit: '°C',
  heightReference: 'MSL',
  validAt: '2026-11-01T06:00:00Z',
  referenceTime: '2026-11-01T00:00:00Z',
  referenceTimeVerified: true,
  model: 'hrrr',
  gridId: 'native',
  cellId: 2,
};
test('strict comparisons require verified initialization and retain explicit exclusion reasons', () => {
  const options = { sameRun: true, sameGrid: true };
  assert.equal(comparisonIssue(base, structuredClone(base), options), null);
  for (const [patch, reason] of [
    [{ quantity: null }, 'unknown-field-definition'],
    [{ quantity: 'dewPoint' }, 'different-field-definition'],
    [{ unit: 'K' }, 'different-normalized-unit'],
    [{ heightReference: 'AGL' }, 'different-height-reference'],
    [{ validAt: '2026-11-01T06:00:00' }, 'different-valid-time'],
    [{ validAt: '2026-11-01T07:00:00Z' }, 'different-valid-time'],
    [{ referenceTime: null }, 'unknown-initialization'],
    [{ referenceTimeVerified: false }, 'unverified-initialization'],
    [{ referenceTime: '2026-10-31T18:00:00Z' }, 'different-initialization'],
    [{ model: 'gfs' }, 'different-model'],
    [{ cellId: null }, 'unknown-native-cell'],
    [{ cellId: 3 }, 'different-native-cell'],
  ])
    assert.equal(comparisonIssue(base, { ...base, ...patch }, options), reason);
  assert.equal(comparisonIssue(base, { ...base, validAt: '2026-11-01T01:00:00-05:00' }, options), null);
  const beforeInit = { ...base, validAt: '2026-10-31T23:00:00Z' };
  assert.equal(comparisonIssue(beforeInit, beforeInit, options), 'negative-lead-time');
  assert.equal(
    comparisonIssue(base, { ...base, referenceTime: null }),
    null,
    'cross-run disagreement remains distinct',
  );
});

test('accumulations and means need identical support, not just equal end times', () => {
  const interval = { kind: 'accumulation', start: '2026-11-01T05:00:00Z', end: base.validAt };
  assert.equal(intervalIssue(interval, { ...interval }), null);
  assert.equal(intervalIssue(interval, { ...interval, kind: 'mean' }), 'incompatible-time-support');
  assert.equal(
    intervalIssue(interval, { ...interval, start: '2026-11-01T04:00:00Z' }),
    'incompatible-accumulation-interval',
  );
  assert.equal(intervalIssue(interval, null), 'incompatible-time-support');
  assert.equal(
    intervalIssue({ kind: 'instant', validAt: base.validAt }, { kind: 'instant', validAt: base.validAt }),
    null,
  );
});

test('shared definitions forbid convergence, parcel, PBL and sink-threshold aliases', () => {
  assert.equal(DRJACK_WXTOFLY_COMPARISON, PROVIDER_COMPARISON_DEFINITIONS);
  const convergence = PROVIDER_COMPARISON_DEFINITIONS.find((row) => row.parameter.startsWith('Horizontal'));
  assert.equal(convergence.drjackId, null);
  assert.equal(convergence.wxtoflyUnit, null);
  assert.equal(convergence.notes, EXCLUSIONS['cm/s_ Convergence']);
  assert.equal(convergence.notes, CONVERGENCE_DISTINCTION);
  for (const [a, b] of [
    ['verticalVelocity', 'horizontalConvergence'],
    ['surfaceLcl', 'ccl'],
    ['surfaceLcl', 'ambientCloudBase'],
    ['thermalTop', 'nativePblDepth'],
    ['lift1', 'lift225'],
    ['lift225', 'xcLiftUnverified'],
  ]) {
    assert.ok(SCIENTIFIC_QUANTITIES[a]);
    assert.ok(SCIENTIFIC_QUANTITIES[b]);
    assert.equal(comparisonIssue({ ...base, quantity: a }, { ...base, quantity: b }), 'different-field-definition');
  }
  assert.equal(SCIENTIFIC_QUANTITIES.lift225.sinkRateMps, 225 * 0.00508);
});
