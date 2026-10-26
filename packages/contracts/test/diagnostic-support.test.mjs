import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';

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
