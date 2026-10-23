import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegionIndexes } from './merge-soaring-regions.mjs';

test('independent model overlays retain primary and last-good native case pointers', () => {
  const primary = { regions: [
    { id: 'north', caseId: 'north-hrrr-new', nativeModels: [{ model: 'rrfs', caseId: 'north-rrfs-old' }] },
    { id: 'south', caseId: 'south-hrrr', nativeModels: [] },
  ] };
  const overlay = { regions: [
    { id: 'north', caseId: 'north-hrrr-stale', nativeModels: [{ model: 'hrrr-conus', caseId: 'north-hrrr-stale' }, { model: 'rrfs', caseId: 'north-rrfs-new' }] },
    { id: 'south', nativeModels: [{ model: 'rrfs', caseId: 'south-incomplete' }] },
  ] };
  const merged = mergeRegionIndexes(primary, overlay, id => id !== 'south-incomplete');
  assert.equal(merged.regions[0].caseId, 'north-hrrr-new');
  assert.deepEqual(merged.regions[0].nativeModels, [
    { model: 'rrfs', caseId: 'north-rrfs-new' }, { model: 'hrrr-conus', caseId: 'north-hrrr-new' },
  ]);
  assert.deepEqual(merged.regions[1].nativeModels, [{ model: 'hrrr-conus', caseId: 'south-hrrr' }]);
  assert.equal(mergeRegionIndexes(primary, null, () => true).regions[0].nativeModels[0].caseId, 'north-rrfs-old');
});

test('an RRFS-only first publication never advertises nonexistent HRRR or incomplete native bundles', () => {
  const overlay = { regions: [
    { id: 'north', status: 'active-verified-trial', templateCaseId: 'north-template', caseId: 'north-hrrr-missing', expandedCaseId: 'expanded-missing', nativeModels: [{ model: 'rrfs', caseId: 'north-rrfs-live' }] },
    { id: 'south', status: 'active-verified-trial', caseId: 'south-hrrr-missing', nativeModels: [{ model: 'rrfs', caseId: 'south-rrfs-missing' }] },
  ] };
  const merged = mergeRegionIndexes(null, overlay, id => id === 'north-rrfs-live');
  assert.equal(merged.regions.length, 1);
  assert.equal(merged.regions[0].caseId, 'north-rrfs-live');
  assert.equal(merged.regions[0].templateCaseId, 'north-template');
  assert.equal(merged.regions[0].expandedCaseId, undefined);
  assert.deepEqual(merged.regions[0].nativeModels, [{ model: 'rrfs', caseId: 'north-rrfs-live' }]);
  const again = mergeRegionIndexes(merged, overlay, id => id === 'north-rrfs-live');
  assert.deepEqual(again.regions[0].nativeModels, [{ model: 'rrfs', caseId: 'north-rrfs-live' }]);
});
