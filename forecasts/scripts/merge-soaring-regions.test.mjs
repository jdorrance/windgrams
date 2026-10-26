import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegionIndexes } from './merge-soaring-regions.mjs';

test('Armenia becomes the default after retired primary grids and nested retired pointers are removed', () => {
  const primary = { trialRegionId: 'north-sound', regions: [{ id: 'north-sound', caseId: 'north-sound-20261021-00z-live' }] };
  const icon = { trialRegionId: 'armenia', regions: [{ id: 'armenia', status: 'active-verified-trial', caseId: 'armenia-icon-eu-live',
    nativeModels: [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live', expandedCaseId: 'north-sound-expanded-v2' }] }] };
  const result = mergeRegionIndexes(primary, null, () => true, icon);
  assert.equal(result.trialRegionId, 'armenia');
  assert.deepEqual(result.regions.map(region => region.id), ['armenia']);
  assert.deepEqual(result.regions[0].nativeModels, [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }]);
  assert.equal(icon.regions[0].nativeModels[0].expandedCaseId, 'north-sound-expanded-v2', 'source metadata remains unchanged');
});

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

test('ICON adds Armenia while preserving fresh primary and RRFS providers', () => {
  const primary = { regions: [{ id: 'north', caseId: 'north-hrrr-live', nativeModels: [] }] };
  const rrfs = { regions: [{ id: 'north', nativeModels: [{ model: 'rrfs', caseId: 'north-rrfs-live' }] }] };
  const icon = { regions: [
    { id: 'north', nativeModels: [{ model: 'hrrr-conus', caseId: 'north-stale-hrrr' }, { model: 'rrfs', caseId: 'north-stale-rrfs' }] },
    { id: 'armenia', status: 'active-verified-trial', caseId: 'armenia-icon-eu-live', nativeModels: [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }] },
  ] };
  const merged = mergeRegionIndexes(primary, rrfs, () => true, icon);
  assert.deepEqual(merged.regions[0].nativeModels, [{ model: 'hrrr-conus', caseId: 'north-hrrr-live' }, { model: 'rrfs', caseId: 'north-rrfs-live' }]);
  assert.equal(merged.regions[1].id, 'armenia');
  assert.equal(merged.regions[1].caseId, 'armenia-icon-eu-live');
  assert.deepEqual(merged.regions[1].nativeModels, [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }]);
  assert.deepEqual(mergeRegionIndexes(merged, rrfs, () => true, icon), merged);
});

test('ICON-only first publication excludes incomplete bundles and keeps last-good native cases', () => {
  const icon = { regions: [
    { id: 'armenia', status: 'active-verified-trial', caseId: 'armenia-icon-eu-live', nativeModels: [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }] },
    { id: 'incomplete', status: 'active-verified-trial', nativeModels: [{ model: 'icon-eu', caseId: 'missing-icon-eu-live' }] },
  ] };
  const published = id => id === 'armenia-icon-eu-live';
  const first = mergeRegionIndexes(null, null, published, icon);
  assert.equal(first.regions.length, 1);
  assert.equal(first.regions[0].caseId, 'armenia-icon-eu-live');
  const failedRefresh = structuredClone(icon);
  failedRefresh.regions[0].nativeModels[0].caseId = 'armenia-icon-eu-incomplete';
  assert.deepEqual(mergeRegionIndexes(first, null, published, failedRefresh), first);
});
