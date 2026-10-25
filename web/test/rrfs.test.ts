import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePublishedProfileJson, publishedLift } from '../src/lib/published-lift.ts';
import { buildWindgramView, readWindgram } from '../src/lib/windgram-view.ts';
import { renderWindgramSvg, renderWindgramDiagnosticsSvg } from '../src/lib/windgram-chart.ts';
import { buildSounding } from '../src/lib/skewt.ts';

// Actual NOAA RRFS 2026-10-23 06Z f001–f084, decoded and postprocessed at
// Blanchard. Values and timestamps remain exactly as published in the fixture.
const bytes = readFileSync(new URL('../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url), 'utf8');
const captured = JSON.parse(bytes);
const profile = parsePublishedProfileJson(bytes)!;
assert.ok(profile, 'recorded RRFS profile satisfies the browser contract');
const view = buildWindgramView(profile, { timeZone: profile.site.timeZone, launch: { name: 'Blanchard', elevationM: 378.5 } });
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-6, `${actual} matches ${expected}`);

test('the real RRFS run renders all 84 hourly columns with original model and precipitation semantics', () => {
  assert.equal(profile.model, 'rrfs');
  assert.equal(profile.run.referenceTime, '2026-10-23T06:00:00Z');
  assert.equal(profile.semantics.precipitation, 'windowMeanRate');
  assert.equal(profile.hours.length, 84);
  assert.equal(view.hours.length, 84);
  assert.equal(view.ensemble, false);
  const precipitation = view.diagnostics.find(strip => strip.key === 'precipitation')!;
  assert.ok(precipitation);
  for (const [index, hour] of profile.hours.entries()) {
    assert.equal(Date.parse(hour.validAt), Date.parse(profile.run.referenceTime) + (index + 1) * 3_600_000);
    assert.equal(view.hours[index].validAt, hour.validAt);
    assert.equal(view.hours[index].thermalVelocityMps, captured.hours[index].soaring.thermalVelocityV2Mps);
    assert.equal(precipitation.values[index], captured.hours[index].surface.precipitationMmHr);
    assert.deepEqual(hour.levels, captured.hours[index].levels);
    assert.equal(hour.levels.length, 9);
  }
  // The recorded light-rain hour must not be turned into a cumulative amount
  // or divided by an assumed three-hour interval after forecast hour 60.
  assert.equal(precipitation.values[64], 0.06);
  const svg = renderWindgramSvg(view);
  assert.equal((svg.match(/class="wg-hourline"/g) ?? []).length, 84);
  assert.equal(view.timeAxis.filter(tick => tick.hourIndex === null).length, 0, 'undated multi-day charts retain the full source interval');
  assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  assert.doesNotMatch(renderWindgramDiagnosticsSvg(view), /NaN|Infinity|undefined/);
});

test('RRFS hours 61, 62, and 84 retain native winds, timestamps, and published soaring diagnostics', () => {
  for (const forecastHour of [61, 62, 84]) {
    const index = forecastHour - 1, hour = profile.hours[index], source = captured.hours[index];
    const sounding = buildSounding(profile, hour)!;
    assert.ok(sounding, `f${forecastHour} sounding is available`);
    assert.equal(sounding.validAt, source.validAt);
    assert.equal(sounding.points.length, 10, 'surface plus the nine original pressure levels');
    assert.equal(sounding.thermalVelocityMps, source.soaring.thermalVelocityV2Mps);
    assert.equal(sounding.boundaryLayerTopM, source.soaring.resolvedThermalTopM);
    assert.equal(sounding.usableLiftTopM, source.soaring.usableLiftTopV2M);
    assert.equal(sounding.cloudBaseM, source.soaring.surfaceLclM);
    const level = source.levels[3];
    const point = sounding.points.find(point => point.pressureHpa === level.pressureHpa)!;
    assert.equal(point.heightM, level.heightM);
    assert.equal(point.windSpeedMps, level.windSpeedMps);
    assert.equal(point.windDirectionDeg, level.windDirectionDeg);
    const displayIndex = view.hours.findIndex(displayed => displayed.validAt === hour.validAt);
    assert.ok(displayIndex >= 0, `f${forecastHour} is inside the multi-day frame`);
    const reading = readWindgram(view, displayIndex, level.heightM);
    assert.equal(reading.validAt, source.validAt);
    assert.equal(reading.interpolated, false);
    close(reading.speedKt, level.windSpeedMps * 1.9438444924406);
    close(reading.directionDeg, level.windDirectionDeg);
    close(reading.temperatureF, level.temperatureC * 1.8 + 32);
  }
  assert.equal(view.hours.at(-1)!.validAt, '2026-10-26T18:00:00Z');
});

test('actual RRFS null lift remains absent even when the older diagnostic reports lift', () => {
  const hour = profile.hours[10];
  assert.equal(hour.derived.usableLiftTopM, 719.8);
  assert.equal(captured.hours[10].soaring.usableLiftTopV2M, null);
  assert.equal(publishedLift(hour).usableLiftTopM, null);
  const sounding = buildSounding(profile, hour)!;
  assert.equal(sounding.usableLiftTopM, null);
  assert.equal(sounding.marks.top, null);
  const singleHour = buildWindgramView(profile, { timeZone: profile.site.timeZone, hours: [hour] });
  assert.equal(singleHour.series.find(series => series.key === 'usableLiftTopM')!.path, '');
  for (const [index, source] of captured.hours.entries()) {
    if (source.soaring.resolvedThermalTopM !== null) continue;
    assert.equal(publishedLift(profile.hours[index]).boundaryLayerTopM, null);
    assert.equal(buildSounding(profile, profile.hours[index])!.marks.zoneTopM, null);
  }
});
