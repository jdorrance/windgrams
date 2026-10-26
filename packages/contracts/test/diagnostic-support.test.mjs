import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';

test('published native surface fields share the column contract and preserve valid values', () => {
  const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const surface = profile.hours[0].surface;
  const extensions = { surfacePressureHpa: 823.47, wind80mSpeedMps: 0, wind80mDirectionDeg: 0,
    nativeCloudBaseM: -40, nativeCloudCeilingM: null, nativeCloudTopM: 1432.6,
    nativeAdiabaticLclM: 500, nativeLfcM: 700, nativeEquilibriumLevelM: 2400, convectiveParcel: 'mixed-layer' };
  Object.assign(surface, extensions);
  const read = () => parsePublishedProfileJson(JSON.stringify(profile)).hours[0].surface;
  const parsed = read();
  for (const [field, value] of Object.entries(extensions)) assert.deepEqual(parsed[field], value, field);
  for (const field of Object.keys(extensions).filter(field => field !== 'convectiveParcel')) {
    for (const invalid of ['123', { members: 3, p50: 123 }]) {
      surface[field] = invalid;
      assert.equal(read()[field], null, field);
    }
    delete surface[field];
    assert.equal(Object.hasOwn(read(), field), false, field);
  }
  for (const invalid of ['unknown', null, 0]) {
    surface.convectiveParcel = invalid;
    assert.equal(Object.hasOwn(read(), 'convectiveParcel'), false);
  }
  surface.convectiveParcel = 'surface';
  assert.equal(read().convectiveParcel, 'surface');
});

test('published support metadata is validated independently from numeric forecast fields', () => {
  const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const hour = profile.hours[0];
  hour.soaring = { thermalVelocityV2Mps: 1.2,
    verticalResolution: { nativeLevelCount: 9, aboveGroundLevelCount: 8, isSparseProfile: true,
      hasSub925Levels: false, hasUpperAirAbove600Levels: false, has80mWind: false, synthesizedLevels: 0,
      sampling: { temperature: { firstLevelAglM: 662, levelsInLowest1000M: 2, maxGapInLowest1000M: 300 },
        moisture: { firstLevelAglM: null, levelsInLowest1000M: 0, maxGapInLowest1000M: null },
        wind: { firstLevelAglM: 662, levelsInLowest1000M: 2, maxGapInLowest1000M: 300 } } },
    diagnosticSupport: { thermalDepth: { branch: 'model-pbl-fallback', bracketMslM: [100, 762], topLimited: false },
      cloudLimit: { source: 'surface-lcl' }, surfacePressure: { source: 'model', valueHpa: 900 } } };
  let parsed = parsePublishedProfileJson(JSON.stringify(profile));
  assert.deepEqual(parsed.hours[0].soaring.verticalResolution, hour.soaring.verticalResolution);
  assert.deepEqual(parsed.hours[0].soaring.diagnosticSupport, hour.soaring.diagnosticSupport);
  const validSupport = structuredClone(hour.soaring.diagnosticSupport);
  for (const thermalDepth of [
    { ...validSupport.thermalDepth, bracketMslM: [762, 100] },
    { ...validSupport.thermalDepth, branch: 'profile-top', topLimited: false },
  ]) {
    hour.soaring.diagnosticSupport = { ...validSupport, thermalDepth };
    assert.equal(parsePublishedProfileJson(JSON.stringify(profile)).hours[0].soaring.diagnosticSupport, undefined);
  }
  hour.soaring.diagnosticSupport = validSupport;
  hour.soaring.diagnosticSupport.surfacePressure.valueHpa = -1;
  hour.soaring.verticalResolution.sampling.wind.levelsInLowest1000M = -2;
  parsed = parsePublishedProfileJson(JSON.stringify(profile));
  assert.equal(parsed.hours[0].soaring.thermalVelocityV2Mps, 1.2);
  assert.equal(parsed.hours[0].soaring.diagnosticSupport, undefined);
  assert.equal(parsed.hours[0].soaring.verticalResolution, undefined);
});

test('published layer wind retains zero and percentiles while malformed values become unavailable', () => {
  const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const fields = ['blMeanWindSpeedMps', 'blMeanWindDirDeg', 'blTopWindSpeedMps', 'blTopWindDirDeg', 'blWindShearMps', 'buoyancyShearRatio'];
  const soaring = profile.hours[0].soaring = { thermalVelocityV2Mps: 1 };
  const read = () => parsePublishedProfileJson(JSON.stringify(profile)).hours[0].soaring;
  for (const field of fields) {
    for (const value of [0, { members: 3, p10: 1, p25: 1.5, p50: 2, p75: 2.5, p90: 3 }]) {
      soaring[field] = value;
      assert.deepEqual(read()[field], value, field);
    }
    soaring[field] = '2';
    assert.equal(read()[field], null, field);
    delete soaring[field];
    assert.equal(Object.hasOwn(read(), field), false, 'absent layer fields stay absent');
  }
});
