import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetiredRegionalCase, publicRegionCatalogue } from './retired-regions.mjs';

test('old planned US regions and all their generated case variants stay retired', () => {
  const retired = [
    ['central-puget-tiger', 'tiger-puget-trough-20261021-06z'],
    ['columbia-gorge-eastern-wa', 'columbia-gorge-gap-flow-20261021-06z'],
    ['rogue-oregon-outback', 'rogue-valley-woodrat-20261021-06z'],
    ['intermountain-idaho-utah', 'intermountain-idaho-utah-v2'],
  ];
  for (const [, caseId] of retired) for (const suffix of ['', '-live', '-rrfs-live']) assert.equal(isRetiredRegionalCase(caseId + suffix), true);
  const index = { trialRegionId: 'central-puget-tiger', regions: [
    ...retired.map(([id, caseId]) => ({ id, caseId, status: 'point-postprocessed-ready-for-grid' })),
    { id: 'armenia', caseId: 'armenia-icon-eu-live', status: 'active-verified-trial' },
  ] };
  const result = publicRegionCatalogue(index);
  assert.deepEqual(result.regions.map(region => region.id), ['armenia']);
  assert.equal(result.trialRegionId, 'armenia');
  assert.equal(index.regions.length, 5, 'source configuration remains intact');
  assert.equal(isRetiredRegionalCase('armenia-icon-eu-live'), false);
});

test('retirement filtering leaves malformed optional values for boundary validation', () => {
  for (const index of [null, undefined, { regions: null }, { regions: [null, 'invalid', { nativeModels: [null] }] }]) {
    assert.equal(publicRegionCatalogue(index), index);
  }
  for (const caseId of [null, undefined, 12, {}]) assert.equal(isRetiredRegionalCase(caseId), false);
});
