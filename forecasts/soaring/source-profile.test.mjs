import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAtmosphericColumn } from '@windgrams/contracts';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import { postprocessPointForecast, sourceFromPublishedDeterministicHour } from '@windgrams/soaring/compatibility';
import { deriveSourceForecast } from './source-profile.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/blanchard-raw.json', import.meta.url)));
const profileFrom = column => deriveSourceForecast({ siteId: 'sample', siteName: 'Sample', latitude: 48, longitude: -122,
  modelElevationM: fixture.terrain, referenceTime: '2026-10-21T00:00:00Z', generatedAt: '2026-10-21T14:00:00Z', hours: [column] }, 'hrrr-conus', {});

test('native cloud, convection and surface fields survive profile publication', () => {
  const measurements = { surfacePressureHpa: 980, wind80mSpeedMps: 4, wind80mDirectionDeg: 275,
    nativeCloudBaseM: 900, nativeCloudCeilingM: 1100, nativeCloudTopM: 2100,
    nativeAdiabaticLclM: 850, nativeLfcM: 1500, nativeEquilibriumLevelM: 4000 };
  const source = { ...fixture.hours[0].source, ...measurements, convectiveParcel: 'surface' };
  const profile = profileFrom(source);
  const processed = postprocessPointForecast(profile);
  const reconstructed = parseAtmosphericColumn(sourceFromPublishedDeterministicHour(processed.hours[0]));
  assert.ok(reconstructed);
  for (const [field, value] of Object.entries(measurements)) {
    assert.equal(processed.hours[0].surface[field], value, field);
    assert.equal(reconstructed[field], value, field);
  }
  assert.equal(reconstructed.convectiveParcel, 'surface');
  assert.equal(processed.hours[0].soaring.diagnosticSupport.surfacePressure.source, 'model');
  assert.equal(processed.hours[0].soaring.effectiveCloudLimitM, Math.round(processed.hours[0].derived.cloudBaseM * 10) / 10,
    'lift retains the baseline cloud cap');
  const absent = sourceFromPublishedDeterministicHour({ ...processed.hours[0], surface: { ...processed.hours[0].surface, nativeCloudBaseM: undefined } });
  assert.equal(absent.nativeCloudBaseM, null);
});

test('dew point and depression inputs produce the same profile without changing the source', () => {
  const original = structuredClone(fixture.hours[0].source);
  const dewPointOnly = value => {
    const { dewPointDepressionC, ...rest } = value;
    return { ...rest, dewPointC: value.temperatureC - dewPointDepressionC };
  };
  const column = { ...dewPointOnly(original), levels: original.levels.map(dewPointOnly) };
  const snapshot = structuredClone(column);
  assert.ok(parseAtmosphericColumn(column));
  assert.deepEqual(profileFrom(column), profileFrom(original));
  assert.deepEqual(column, snapshot);
  assert.deepEqual(profileFrom({ ...original, dewPointC: null }), profileFrom(original), 'a null alternate moisture field keeps the supplied depression');
});

test('missing measurements round-trip as unavailable and measured zeros survive', () => {
  const optional = ['windGustMps', 'capeJkg', 'cinJkg', 'pblHeightM', 'lowCloudPercent', 'midCloudPercent', 'highCloudPercent'];
  const column = { ...fixture.hours[0].source, ...Object.fromEntries(optional.map(field => [field, null])),
    surfacePressureHpa: null, nativeCloudBaseM: null,
    levels: fixture.hours[0].source.levels.map(level => ({ ...level, verticalVelocityPaS: null, cloudFractionPercent: null })),
  };
  const snapshot = structuredClone(column);
  const processed = postprocessPointForecast(profileFrom(column));
  const parsed = parsePublishedProfileJson(JSON.stringify(processed));
  assert.ok(parsed, 'nullable source fields must produce a readable profile');
  for (const field of optional) assert.equal(parsed.hours[0].surface[field], undefined, field);
  for (const level of parsed.hours[0].levels) {
    assert.equal(level.verticalVelocityPaS, undefined);
    assert.equal(level.cloudFractionPercent, undefined);
  }
  assert.equal(parsed.hours[0].surface.surfacePressureHpa, null);
  assert.equal(parsed.hours[0].surface.nativeCloudBaseM, null);
  assert.equal(parsed.hours[0].soaring.capeJkg, null);
  assert.equal(parsed.hours[0].soaring.cinJkg, null);
  assert.equal(parsed.hours[0].soaring.windGustMps, null);
  assert.equal(parsed.hours[0].soaring.maxUpwardVelocityMps, null);
  assert.deepEqual(column, snapshot);
  const zero = profileFrom({ ...column, capeJkg: 0, cinJkg: 0, pblHeightM: 0, windGustMps: 0 });
  for (const field of ['capeJkg', 'cinJkg', 'pblHeightM', 'windGustMps']) assert.equal(zero.hours[0].surface[field], 0);
});

test('missing required publication fields fail explicitly and malformed extensions are omitted', () => {
  for (const field of ['cloudCoverPercent', 'precipitationMm', 'sensibleHeatFluxWm2', 'latentHeatFluxWm2', 'seaLevelPressureHpa']) {
    assert.throws(() => profileFrom({ ...fixture.hours[0].source, [field]: null }), new RegExp(`Missing required profile field ${field}`));
  }
  const profile = profileFrom({ ...fixture.hours[0].source, surfacePressureHpa: NaN, wind80mSpeedMps: 'unknown', convectiveParcel: 'other' });
  for (const field of ['surfacePressureHpa', 'wind80mSpeedMps', 'convectiveParcel']) assert.equal(profile.hours[0].surface[field], undefined);
  assert.ok(parsePublishedProfileJson(JSON.stringify(profile)));
});
