import test from 'node:test';
import assert from 'node:assert/strict';
import { replayModel, validateRegionCatalogue, validateReplayManifest, validateReplayHour } from '@windgrams/contracts/regional';

const site = { name: 'Chatham', latitude: -43.95, longitude: -176.56, timeZone: 'Pacific/Chatham' };
const manifest = {
  schemaVersion: 1, capturedAt: '2026-10-25T00:00:00Z', cellCount: 2, siteCell: 0,
  case: { id: 'global-test', model: 'gfs', referenceTime: '2026-10-25T00:00:00Z', bbox: [-177, -44, -176, -43], sinkMps: 1,
    site, launchElevation: { elevationM: 10 } }, versions: { algorithm: '2' },
  hours: [{ forecastHour: 1, validAt: '2026-10-25T01:00:00Z', file: 'hours/f001.json.gz' }],
};
const hour = { forecastHour: 1, validAt: '2026-10-25T01:00:00Z',
  thermalVelocityMps: [1, null], usableLiftTopM: [500, null], boundaryLayerTopM: [800, null], cloudBaseM: [900, null], pblHeightM: [700, null],
  status: ['valid', 'missing'], levelCount: [8, 0], ceilingReached: [false, false],
  levelsByModel: { 1: { h: [10, null], t: [20, null], td: [10, null], ws: [3, null], wd: [270, null], vv: [0, null], p: [1000, null] } },
};

test('regional boundaries retain valid metadata, fractional zones and missing-cell arrays exactly', () => {
  assert.equal(validateReplayManifest(manifest), manifest);
  assert.equal(validateReplayHour(hour, 2), hour);
  assert.equal(validateReplayManifest({ ...manifest, semantics: { gust: 'hourMax' }, cellProfiles: 'cell-{index}.json.gz' }).semantics.gust, 'hourMax');
});

test('manifest validation confines filenames and verifies metadata before requests', () => {
  for (const file of ['../secret', '/file.json', 'https://other.test/file', 'hour.json?extra', 'a\\file.json']) {
    assert.equal(validateReplayManifest({ ...manifest, hours: [{ ...manifest.hours[0], file }] }), null);
  }
  assert.equal(validateReplayManifest({ ...manifest, siteCell: 2 }), null);
  assert.equal(validateReplayManifest({ ...manifest, model: 'other-model' }), null);
  assert.equal(validateReplayManifest({ ...manifest, semantics: { gust: 'hourly-ish' } }), null);
  assert.equal(validateReplayManifest({ ...manifest, case: { ...manifest.case, site: { ...site, timeZone: 'Unknown/Zone' } } }), null);
});

test('contract readers require explicit ownership even for familiar archive names', () => {
  assert.equal(replayModel({ ...manifest, case: { ...manifest.case, id: 'north-sound-20261021-00z', model: undefined } }), 'unknown');
  assert.equal(replayModel(manifest), 'gfs');
});

test('hour validation rejects shifted arrays and invalid cell values without filling missing weather', () => {
  for (const changed of [
    { thermalVelocityMps: [1] }, { wind80mSpeedMps: [2] }, { levelCount: [8, null] },
    { status: ['valid', 'unknown'] }, { thermalVelocityMps: [Infinity, null] },
    { levelsByModel: { 1: { ...hour.levelsByModel[1], p: [1000] } } },
  ]) assert.equal(validateReplayHour({ ...hour, ...changed }, 2), null);
  assert.equal(validateReplayHour(hour, 3), null);
});

test('catalogue validation accepts declared global model choices and rejects malformed routes', () => {
  const region = { id: 'chatham', name: 'Chatham', status: 'active', caseId: 'global-test', timeZone: site.timeZone,
    morningBriefingLocalHour: 8, bbox: [-177, -44, -176, -43], primarySite: 'nz-example', launches: ['nz-example'],
    deterministicModels: ['gfs'], ensembleModels: [], sparseAdapters: [], nativeModels: [{ model: 'gfs', caseId: 'global-test' }] };
  const catalogue = { schemaVersion: 1, soaringContractVersion: '2', generatedAt: manifest.capturedAt, trialRegionId: 'chatham', regions: [region] };
  assert.equal(validateRegionCatalogue(catalogue), catalogue);
  assert.equal(validateRegionCatalogue({ ...catalogue, regions: [{ ...region, nativeModels: [{ model: 'gfs' }] }] }), null);
  assert.equal(validateRegionCatalogue({ ...catalogue, regions: [{ ...region, timeZone: 'Unknown/Zone' }] }), null);
  assert.equal(validateRegionCatalogue({ ...catalogue, regions: [{ ...region, caseId: '../other' }] }), null);
});
