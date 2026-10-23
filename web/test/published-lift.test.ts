import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCellSiteForecast, type ReplayManifest, type ReplayHour } from '../src/lib/soaring.ts';
import { publishedLift, parsePublishedProfileJson } from '../src/lib/published-lift.ts';
import { buildWindgramView } from '../src/lib/windgram-view.ts';
import { buildSounding, readSounding } from '../src/lib/skewt.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../forecasts/soaring/${name}`, import.meta.url), 'utf8'));
const c = read('cases/north-sound-20261021-00z.json');
const raw = read('fixtures/blanchard-raw.json');
const golden = read('fixtures/blanchard-published.json');
const hours = JSON.parse(readFileSync(new URL('./fixtures/blanchard-map-hours.json', import.meta.url), 'utf8')).hours as ReplayHour[];
const manifest = { case: c, capturedAt: golden.run.generatedAt, siteCell: 0, hours } as ReplayManifest;
const cell = { ...raw.cell, id: 'test-cell', gridIndex: 1, modelElevationM: raw.terrain };

test('every archived map hour agrees with the cell windgram and sounding, including zero lift', () => {
  const profile = buildCellSiteForecast(manifest, hours, 0, cell)!;
  assert.ok(profile);
  const view = buildWindgramView(profile, { timeZone: c.site.timeZone });
  for (const [i, h] of hours.entries()) {
    const lift = publishedLift(profile.hours[i]);
    assert.equal(lift.thermalVelocityMps, h.thermalVelocityV2Mps![0]);
    assert.equal(lift.usableLiftTopM, h.usableLiftTopV2M![0]);
    assert.equal(view.hours[i].thermalVelocityMps, h.thermalVelocityV2Mps![0]);
    const sounding = buildSounding(profile, profile.hours[i])!;
    assert.equal(sounding.thermalVelocityMps, h.thermalVelocityV2Mps![0]);
    assert.equal(sounding.usableLiftTopM, h.usableLiftTopV2M![0]);
  }
  assert.equal(view.hours[6].thermalVelocityMps, 0.85);
  assert.equal(publishedLift(profile.hours[6]).usableLiftTopM, 465.5);
  assert.doesNotMatch(readSounding(buildSounding(profile, profile.hours[6])!, 378.5).headline, /too weak to climb/);
});
test('a missing surface or incomplete column never invents a valid profile', () => {
  const broken = structuredClone(hours); broken[3].sfcT = [null];
  assert.equal(buildCellSiteForecast(manifest, broken, 0, cell), null);
  broken[3] = { ...hours[3], status: ['insufficient-levels'] };
  assert.equal(buildCellSiteForecast(manifest, broken, 0, cell), null);
});
test('cell profiles retain the source model and precipitation semantics', () => {
  const legacy = buildCellSiteForecast(manifest, hours, 0, cell)!;
  assert.equal(legacy.model, 'hrrr-conus');
  assert.equal(legacy.semantics.precipitation, 'instantRate');
  const rrfsManifest: ReplayManifest = { ...manifest, model: 'rrfs', semantics: { gust: 'instant', precipitation: 'windowMeanRate' } };
  const rrfs = buildCellSiteForecast(rrfsManifest, hours, 0, cell)!;
  assert.equal(rrfs.model, 'rrfs');
  assert.equal(rrfs.semantics.precipitation, 'windowMeanRate');
  assert.deepEqual(rrfs.hours, legacy.hours);
  const caseModel = buildCellSiteForecast({ ...manifest, case: { ...manifest.case, model: 'rrfs' } }, hours, 0, cell)!;
  assert.equal(caseModel.model, 'rrfs');
  assert.equal(caseModel.semantics.precipitation, 'windowMeanRate');
});
test('point loading retains published diagnostics and nulls without resurrecting baseline lift', () => {
  const rawProfile = structuredClone(golden);
  rawProfile.hours[6].soaring = { thermalVelocityV2Mps: 0.85, usableLiftTopV2M: null, resolvedThermalTopM: 504.3, surfaceLclM: 1315 };
  const parsed = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  assert.equal(publishedLift(parsed.hours[6]).usableLiftTopM, null);
  assert.equal(buildSounding(parsed, parsed.hours[6])!.usableLiftTopM, null);
  assert.deepEqual(publishedLift(parsed.hours[0]), golden.hours[0].derived);
  rawProfile.hours[6].soaring.thermalVelocityV2Mps = null;
  const missing = parsePublishedProfileJson(JSON.stringify(rawProfile))!;
  const sounding = buildSounding(missing, missing.hours[6])!;
  assert.equal(sounding.thermalVelocityMps, null);
  assert.match(readSounding(sounding, 378.5).headline, /unavailable/);
});
