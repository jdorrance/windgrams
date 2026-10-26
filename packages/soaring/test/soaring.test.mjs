import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveDiagnosticsV2, computeUsableLiftTopV2M } from '@windgrams/soaring';
import { postprocessPointForecast, postprocessSparseAdapterDocument, aggregateEnsembleMetric, summarizeModelWindowSpread,
  sourceFromPublishedDeterministicHour, deriveEnsembleSoaringDiagnostics } from '@windgrams/soaring/compatibility';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/diagnostic-parity.json',import.meta.url),'utf8'));
for (const c of fixture.cases) test(`method 2.3 scalar parity with frozen 2.2 inputs: ${c.id}`, () => {
  const before=structuredClone(c.source);
  const result = deriveDiagnosticsV2(c.terrainM,c.source,c.v1Hour,c.options);
  for (const [key, value] of Object.entries(c.expected)) {
    if (['contractVersion', 'verticalResolution', 'experimental'].includes(key)) continue;
    assert.deepEqual(result[key], value, key);
  }
  const { sampling, ...resolution } = result.verticalResolution;
  assert.deepEqual(resolution, c.expected.verticalResolution);
  assert.deepEqual(c.source,before);
});

test('policy sink rates remain explicit and increasing sink cannot raise usable lift', () => {
  const inputs={modelElevationM:100,resolvedThermalTopM:2100,thermalVelocityV2Mps:2,cloudBaseM:1900};
  const first=computeUsableLiftTopV2M(inputs,1);
  const second=computeUsableLiftTopV2M(inputs,2);
  assert.ok(first!==null && second!==null && second<=first);
});

test('sparse adapters never substitute sea level for unknown terrain, and preserve zero and negative elevations', () => {
  const hour = { validAt: '2026-10-21T20:00:00Z', temperatureC: 20, dewPointC: 10, boundaryLayerHeightM: 1000 };
  const unknown = postprocessSparseAdapterDocument({ model: 'ecmwf', site: {}, hours: [hour] }, { modelSlug: 'ecmwf' });
  assert.equal(unknown.hours[0].soaring.surfaceLclM, null);
  assert.equal(unknown.hours[0].soaring.modelBlTopM, null);
  assert.equal(unknown.hours[0].soaring.gridElevationM, null);
  assert.equal(unknown.hours[0].soaring.elevationSource, 'unavailable');
  assert.equal(unknown.soaringMeta.elevationSource, 'unavailable');

  const launchOnly = postprocessSparseAdapterDocument({ model: 'ecmwf', site: {}, hours: [hour] }, { modelSlug: 'ecmwf', launchElevationM: 500 });
  assert.ok(launchOnly.hours[0].soaring.surfaceLclM > 500);
  assert.equal(launchOnly.hours[0].soaring.elevationSource, 'launch');

  for (const elevation of [0, -50]) {
    const atGrid = postprocessSparseAdapterDocument({ model: 'ecmwf', site: { gridElevationM: elevation }, hours: [hour] }, { modelSlug: 'ecmwf', launchElevationM: 500 });
    assert.equal(atGrid.hours[0].soaring.gridElevationM, elevation);
    assert.equal(atGrid.hours[0].soaring.modelBlTopM, elevation + 1000);
    assert.equal(atGrid.hours[0].soaring.elevationSource, 'grid');
  }
  // NWS grid elevation of exactly 0 is legitimate terrain, not missing data.
  const nwsZero = postprocessSparseAdapterDocument(
    { grid: { office: 'KBOI', elevationM: 0 }, hours: [{ validAt: hour.validAt, temperatureC: 20, dewpointC: 10, mixingHeightM: 800 }] },
    { modelSlug: 'nws', launchElevationM: 500 });
  assert.equal(nwsZero.hours[0].soaring.gridElevationM, 0);
  assert.equal(nwsZero.hours[0].soaring.modelBlTopM, 800);
});

test('ensemble postprocessing retains published member percentiles', () => {
  const hour={surface:{temperatureC:{members:3,p50:20}}};
  const input={model:'geps',run:{members:3},hours:[hour]};
  const output=postprocessPointForecast(input);
  assert.equal(output.hours,input.hours);
  assert.equal(output.soaringMeta.nonlinearMedianPostprocessRefused,true);
  assert.deepEqual(aggregateEnsembleMetric([null,Number.NaN]),{members:0,p10:null,p25:null,p50:null,p75:null,p90:null});
});

test('GEPS window summaries preserve published diagnostics and exclude member dropouts', () => {
  const percentile = (p50, members = 21) => ({ members, p10: p50 - 1, p50, p90: p50 + 1 });
  const doc = { model: 'geps', run: { referenceTime: '2026-10-24T00:00:00Z' }, site: { modelElevationM: 650 } };
  const hours = [
    { validAt: '2026-10-24T16:00:00Z', surface: { temperatureC: percentile(20), windSpeedMps: percentile(2) },
      derived: { thermalVelocityMps: percentile(4), usableLiftTopM: percentile(2000), cloudBaseM: percentile(1300) },
      soaring: { thermalVelocityV2Mps: percentile(2.5), usableLiftTopV2M: percentile(1800), effectiveCloudLimitM: percentile(1500) } },
    { validAt: '2026-10-24T18:00:00Z', surface: { temperatureC: percentile(22), windSpeedMps: percentile(6) },
      derived: { thermalVelocityMps: percentile(4.5), usableLiftTopM: percentile(2100), cloudBaseM: percentile(1200) } },
    { validAt: '2026-10-24T21:00:00Z', surface: { temperatureC: percentile(999, 0), windSpeedMps: percentile(999, 0) },
      derived: { thermalVelocityMps: percentile(999, 0), usableLiftTopM: percentile(9999, 0), cloudBaseM: percentile(999, 0) },
      soaring: { thermalVelocityV2Mps: percentile(999, 0), usableLiftTopV2M: percentile(9999, 0), effectiveCloudLimitM: percentile(999, 0) } },
  ];
  const summary = summarizeModelWindowSpread('geps', doc, hours);
  assert.equal(summary.referenceTime, doc.run.referenceTime);
  assert.equal(summary.modelElevationM, 650);
  assert.equal(summary.derivationRule, 'per-member-before-percentiles');
  assert.equal(summary.status, 'available');
  assert.equal(summary.coverageSamples, 3);
  assert.equal(summary.coverageSpanHours, 5);
  assert.equal(summary.peakWstarV2Mps, 2.5);
  assert.equal(summary.peakUsableLiftTopV2M, 1800);
  assert.equal(summary.peakLegacyWstarMps, 4.5);
  assert.equal(summary.peakLegacyUsableLiftTopM, 2100);
  assert.equal(summary.minEffectiveCloudLimitM, 1200);
  assert.equal(summary.meanWindSpeedMps, 4);
  assert.equal(summary.maxTempC, 22);
  const empty = summarizeModelWindowSpread('geps', doc, []);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.coverageSamples, 0);
  assert.equal(empty.coverageSpanHours, 0);
  for (const key of ['peakWstarV2Mps', 'peakUsableLiftTopV2M', 'peakLegacyWstarMps',
    'peakLegacyUsableLiftTopM', 'minEffectiveCloudLimitM', 'meanWindSpeedMps', 'maxTempC']) {
    assert.equal(empty[key], null, key);
  }
});

test('incomplete surface columns and empty ensembles stop before deriving lift', () => {
  const { source, terrainM } = fixture.cases[0];
  const { validAt, levels, ...surface } = source;
  for (const field of ['temperatureC', 'windSpeedMps', 'windDirectionDeg']) {
    assert.equal(sourceFromPublishedDeterministicHour({ validAt, levels, surface: { ...surface, [field]: null } }), null, field);
  }
  assert.throws(() => deriveEnsembleSoaringDiagnostics([], terrainM), /requires non-empty memberColumns/);
});

test('point reconstruction accepts both dew point and dew-point depression', () => {
  const { source, terrainM, v1Hour } = fixture.cases[0];
  const { validAt, levels, ...surface } = source;
  const hour = { validAt, surface, levels, derived: v1Hour.derived };
  const document = { model: 'gfs', site: { modelElevationM: terrainM }, hours: [hour] };
  const expected = postprocessPointForecast(document);
  assert.ok(expected.hours[0].soaring?.resolvedThermalTopM > terrainM);
  const depressionOnly = ({ temperatureC, dewPointC, ...rest }) => ({
    ...rest, temperatureC, dewPointDepressionC: temperatureC - dewPointC,
  });
  const changed = { ...document, hours: [{ ...hour, surface: depressionOnly(surface), levels: levels.map(depressionOnly) }] };
  const actual = postprocessPointForecast(changed);
  assert.deepEqual(actual.hours[0].soaring, expected.hours[0].soaring);
  assert.equal(actual.hours[0].levels, changed.hours[0].levels);
});
