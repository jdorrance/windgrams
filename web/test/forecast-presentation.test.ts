import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { launchConditions } from '../src/lib/launch-forecast.ts';
import { DEFAULT_DETAILS } from '../src/lib/launches.ts';
import { setUnitSystem } from '../src/lib/units.ts';
import { buildWindgramView, hourSampling, readWindgram, renderWindgramSvg } from './helpers/windgram.ts';
import { sampleHeight } from '../../packages/windgram/src/windgram-sampling.ts';
import { forecastDataSupport } from '../src/lib/forecast-data-support.ts';
import type { PublishedForecastHour } from '@windgrams/contracts/published-lift';

afterEach(() => setUnitSystem('imperial'));
const profile = () => parseSiteForecast(JSON.parse(readFileSync(new URL('../dev-data-src/convective-cycle.profile.json', import.meta.url), 'utf8')))!;
const limits = { ...DEFAULT_DETAILS, facingDeg: 0, windArcHalfWidthDeg: 30, windMaxMph: 15, gustMaxMph: 20 };

test('launch readings name model terrain, signed height separation and unavailable wind without changing forecasts', () => {
  setUnitSystem('metric');
  const hour = profile().hours[0];
  hour.surface.windSpeedMps = 5;
  hour.surface.windDirectionDeg = null;
  hour.surface.windGustMps = null;
  const original = structuredClone(hour);
  const conditions = launchConditions(hour, limits, 530, 407.1);
  assert.match(conditions.windBasis, /10 m above model ground/);
  assert.match(conditions.windBasis, /Model ground: 407 m MSL · Launch: 530 m MSL · Model − launch: −123 m/);
  assert.match(conditions.values[0][1], /Direction unavailable/);
  assert.deepEqual(conditions.issues, ['Model surface wind direction comparison unavailable', 'Model surface gust comparison unavailable']);
  assert.deepEqual(hour, original);
  assert.match(launchConditions(hour, limits, 100, 200).windBasis, /Model − launch: \+100 m/);
  assert.match(launchConditions(hour, limits, null).windBasis, /Model ground: unknown · Launch: unknown · Model − launch: unknown/);
  hour.surface.windSpeedMps = 0;
  assert.equal(launchConditions(hour, DEFAULT_DETAILS, null).values[0][1], 'Light / calm');
  hour.surface.windSpeedMps = null;
  assert.equal(launchConditions(hour, limits, null).values[0][1], 'Unavailable');
  assert.ok(launchConditions(hour, limits, null).issues.includes('Model surface speed comparison unavailable'));
  hour.surface.windSpeedMps = { p50: 5, members: 0 } as never;
  assert.equal(launchConditions(hour, limits, null).values[0][1], 'Unavailable', 'an empty ensemble has no usable median');
});

test('gust readings are named by the document\'s declared class and compared the same way', () => {
  setUnitSystem('metric');
  const source = profile(), hour = source.hours[0];
  hour.surface.windSpeedMps = 3;
  hour.surface.windDirectionDeg = 0;
  hour.surface.windGustMps = 12; // ≈27 mph, above the 20 mph limit
  assert.equal(source.semantics?.gust, 'hourMax', 'fixture declares the hour-max class');
  const declared = launchConditions(hour, limits, 530, 407.1, source.semantics?.gust ?? null);
  assert.deepEqual(declared.values[1], ['Model surface hour-max gust', '43 km/h']);
  assert.deepEqual(declared.issues, ['Model surface hour-max gust above default limit']);
  const sampled = launchConditions(hour, limits, 530, 407.1, 'instant');
  assert.deepEqual(sampled.values[1], ['Model surface gust sample', '43 km/h']);
  assert.deepEqual(sampled.issues, ['Model surface gust sample above default limit']);
  const undeclared = launchConditions(hour, limits, 530, 407.1);
  assert.deepEqual(undeclared.values[1], ['Model surface gust', '43 km/h'], 'an undeclared class keeps the plain word, never a default');
  assert.deepEqual(undeclared.issues, ['Model surface gust above default limit']);
  hour.surface.windGustMps = null;
  assert.ok(launchConditions(hour, limits, 530, 407.1, 'hourMax').issues.includes('Model surface hour-max gust comparison unavailable'));
});

test('lift rows carry the v1 label only when the hour publishes no current-method diagnostics', () => {
  setUnitSystem('metric');
  const legacy = profile().hours[0];
  Object.assign(legacy.derived, { thermalVelocityMps: 1.26, usableLiftTopM: 1234.4, cloudBaseM: 1274.6 });
  const rows = Object.fromEntries(launchConditions(legacy, limits, 530, 407.1).values);
  assert.equal(rows['Usable lift top'], 'v1: 1,250 m MSL');
  assert.equal(rows['Effective cloud limit'], 'v1: 1,250 m MSL');
  assert.equal(rows['Thermal strength'], 'v1: 1.30 m/s');
  assert.equal(Object.fromEntries(forecastDataSupport(legacy).rows)['Diagnostic support'], 'Not published for this forecast; the earlier method (v1) lift diagnostics are shown instead.');
  const current: PublishedForecastHour = { ...legacy, soaring: { thermalVelocityV2Mps: 1.26, usableLiftTopV2M: 1234.4, surfaceLclM: 1274.6, resolvedThermalTopM: 1500 } };
  const v2 = Object.fromEntries(launchConditions(current, limits, 530, 407.1).values);
  assert.equal(v2['Usable lift top'], '1,250 m MSL');
  assert.equal(v2['Potential cloud base (surface LCL)'], '1,250 m MSL');
  assert.equal(v2['Thermal strength'], '1.30 m/s');
  assert.equal(Object.fromEntries(forecastDataSupport(current).rows)['Diagnostic support'], 'Not published for this forecast.');
  const belowSink: PublishedForecastHour = { ...legacy, derived: { ...legacy.derived, thermalVelocityMps: 0.4, usableLiftTopM: null } };
  assert.equal(Object.fromEntries(launchConditions(belowSink, limits, 530, 407.1).values)['Usable lift top'], 'v1: Below sink threshold');
});

test('saved direction glyphs compare model wind and leave calm or missing wind unknown', () => {
  const source = profile();
  source.hours = source.hours.slice(0, 5);
  const directions = [350, 10, 180, 0, null];
  source.hours.forEach((hour, i) => {
    hour.surface.windDirectionDeg = directions[i];
    hour.surface.windSpeedMps = i === 3 ? 0 : 5;
  });
  const options = { timeZone: 'Etc/UTC', hours: source.hours, launchWindows: [{ fromDeg: 330, toDeg: 30 }] };
  const view = buildWindgramView(source, options);
  assert.deepEqual(view.hours.map(hour => hour.inWindWindow), [true, true, false, null, null]);
  const svg = renderWindgramSvg(view);
  assert.equal((svg.match(/data-model-wind-window="inside"/g) ?? []).length, 2);
  assert.equal((svg.match(/data-model-wind-window="unknown"/g) ?? []).length, 2);
  assert.match(svg, /Model surface wind direction is inside the saved direction window; launch wind may differ/);
  assert.doesNotMatch(renderWindgramSvg(buildWindgramView(source, { ...options, launchWindows: [] })), /data-model-wind-window/);
  assert.equal(view.series.find(series => series.key === 'boundaryLayerTopM')?.label, 'Thermal top (parcel)');
});

test('physical surface samples retain their 2 m and 10 m source heights without extrapolation', () => {
  const source = profile(), floor = source.site.modelElevationM, hour = source.hours[0];
  hour.surface.temperatureC = 20;
  hour.surface.dewPointC = 10;
  hour.surface.windSpeedMps = 2;
  hour.surface.windDirectionDeg = 270;
  hour.levels = [{ ...hour.levels[0], heightM: floor + 110, temperatureC: 10, dewPointC: 0, windSpeedMps: 12, windDirectionDeg: 270 }];
  const original = structuredClone(source);
  const sample = hourSampling(hour, floor);
  assert.equal(sample.temperatureC[0].altitudeM, floor + 2);
  assert.equal(sample.windU[0].altitudeM, floor + 10);
  assert.equal(sampleHeight(sample.temperatureC, floor), null);
  assert.equal(sampleHeight(sample.dewPointC, floor + 1), null);
  assert.equal(sampleHeight(sample.windU, floor + 9), null);
  assert.equal(sampleHeight(sample.temperatureC, floor + 56), 15);
  assert.ok(Math.abs(sampleHeight(sample.windU, floor + 60)! - 7) < 1e-10);
  assert.equal(sampleHeight(sample.temperatureC, floor + 111), null);
  const view = buildWindgramView(source, { timeZone: 'Etc/UTC', hours: [hour], heightRange: 'full' });
  assert.equal(view.barbs.find(barb => barb.surface)?.heightM, floor + 10);
  assert.match(renderWindgramSvg(view), /Model surface · 10 m above model ground/);
  assert.deepEqual(source, original, 'display sampling must leave published values and diagnostics intact');

  hour.surface.windSpeedMps = 0;
  hour.surface.windDirectionDeg = null;
  const calmView = buildWindgramView(source, { timeZone: 'Etc/UTC', hours: [hour], heightRange: 'full' });
  const calm = readWindgram(calmView, 0, floor + 10);
  assert.equal(calm.speedKt, 0, 'calm wind does not need a direction');
  assert.equal(calm.directionDeg, null, 'calm wind must not invent a direction');
  assert.equal(calmView.barbs.find(barb => barb.surface)?.speedKt, 0);
  assert.match(renderWindgramSvg(calmView), /Calm · Model surface/);
  hour.surface.windSpeedMps = -1;
  assert.equal(sampleHeight(hourSampling(hour, floor).windU, floor + 10), null);
});

test('support readout separates native profile support, thermal branch and native PBL depth', () => {
  setUnitSystem('metric');
  const hour: PublishedForecastHour = profile().hours[0];
  assert.match(forecastDataSupport(hour).rows[0][1], /Not published/);
  const field = { firstLevelAglM: 550, levelsInLowest1000M: 2, maxGapInLowest1000M: 700 };
  hour.surface.pblHeightM = 0;
  hour.soaring = {
    thermalVelocityV2Mps: null,
    verticalResolution: { nativeLevelCount: 8, aboveGroundLevelCount: 8, isSparseProfile: true, hasSub925Levels: false, hasUpperAirAbove600Levels: false, has80mWind: false, synthesizedLevels: 0, sampling: { temperature: field, moisture: field, wind: field } },
    diagnosticSupport: {
      thermalDepth: { branch: 'profile-top', bracketMslM: null, topLimited: true },
      cloudLimit: { source: 'surface-lcl' }, surfacePressure: { source: 'hypsometric', valueHpa: 950 },
    },
  };
  const support = forecastDataSupport(hour), values = Object.fromEntries(support.rows);
  assert.match(values['Temperature profile'], /First native level: 550 m above model ground · 2 native levels/);
  assert.match(values['Temperature profile'], /largest measured gap there: 700 m/);
  assert.equal(values['Native model boundary-layer depth'], '0 m above model ground');
  assert.match(values['Thermal depth support'], /Limited by highest available level · no crossing bracket/);
  assert.equal(values['Cloud limit source'], 'Surface-parcel LCL');
  assert.match(values['Surface pressure'], /hypsometric estimate/);
  assert.match(support.limit!, /upper boundary is unresolved/);
  assert.match(support.caution!, /sparse native levels \(2 in the lowest/, 'sparse-profile caution is visible outside the collapsed details');
});

test('fallback thermal tops carry a visible caution, and resolved dense tops do not', () => {
  const hour: PublishedForecastHour = profile().hours[0];
  const supportFor = (branch: string, sparse = false) => {
    hour.soaring = {
      thermalVelocityV2Mps: null,
      verticalResolution: { nativeLevelCount: 18, aboveGroundLevelCount: 18, isSparseProfile: sparse, hasSub925Levels: true, hasUpperAirAbove600Levels: true, has80mWind: true, synthesizedLevels: 0 },
      diagnosticSupport: {
        thermalDepth: { branch, bracketMslM: null, topLimited: false },
        cloudLimit: { source: 'surface-lcl' }, surfacePressure: { source: 'model', valueHpa: 950 },
      },
    } as PublishedForecastHour['soaring'];
    return forecastDataSupport(hour);
  };
  assert.match(supportFor('model-pbl-fallback').caution!, /fallback estimate, not a resolved parcel crossing/);
  assert.match(supportFor('heat-flux-fallback').caution!, /fallback estimate/);
  assert.match(supportFor('parcel-crossing', true).caution!, /sparse native levels/);
  assert.equal(supportFor('parcel-crossing').caution, null);
  assert.equal(supportFor('parcel-crossing').limit, null);
});

test('unsourced launch limits are labelled defaults and soaring displays round coarsely without touching stored values', () => {
  setUnitSystem('metric');
  const hour = profile().hours[0];
  hour.surface.windSpeedMps = 9; // ≈20 mph, above the 15 mph limit
  const original = structuredClone(hour);
  const conditions = launchConditions(hour, limits, 530, 407.1);
  assert.ok(conditions.issues.includes('Model surface wind above default speed limit'));
  assert.match(conditions.windBasis, /Wind limits are unsourced defaults, not launch-specific/);
  const sourced = launchConditions(hour, { ...limits, source: { name: 'Club', url: 'https://example.invalid', checkedAt: '2026-10-26', license: 'CC0' } }, 530, 407.1);
  assert.ok(sourced.issues.includes('Model surface wind above saved speed limit'));
  assert.doesNotMatch(sourced.windBasis, /unsourced defaults/);
  assert.deepEqual(hour, original, 'display rounding must not mutate the published hour');
  const precise = profile().hours[0];
  Object.assign(precise.derived, { thermalVelocityMps: 1.26, usableLiftTopM: 1234.4, cloudBaseM: 1274.6 });
  const rounded = launchConditions(precise, limits, 530, 407.1);
  // The fixture publishes only the earlier (v1) family, so the rows say so.
  assert.equal(rounded.values[2][1], 'v1: 1,250 m MSL', 'lift top displays to the nearest 50 m');
  assert.equal(rounded.values[3][1], 'v1: 1,250 m MSL', 'cloud base displays to the nearest 50 m');
  assert.equal(rounded.values[4][1], 'v1: 1.30 m/s', 'thermal strength displays to 0.1 m/s');
  assert.equal(precise.derived.usableLiftTopM, 1234.4, 'stored precision is retained');
});
