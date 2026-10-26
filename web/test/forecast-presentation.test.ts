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
});
