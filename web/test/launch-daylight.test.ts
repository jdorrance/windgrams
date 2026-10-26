import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateKey, localInstantMs } from '@azohra/meteo.briefing/derive';
import { forecastCoversWindow, initialForecastDay, launchDayWindow } from '../src/lib/launch-forecast.ts';
import { TIME_ZONES, isValidTimeZone } from '../src/lib/launches.ts';

const christchurch = { latitude: -43.53, longitude: 172.63, timeZone: 'Pacific/Auckland' };

test('NZ summer and winter opening days follow sunset and the launch calendar', () => {
  assert.equal(initialForecastDay(christchurch, Date.parse('2026-12-20T20:00:00Z')), '2026-12-21', 'local morning is tomorrow in UTC');
  assert.equal(initialForecastDay(christchurch, Date.parse('2026-12-21T08:00:00Z')), '2026-12-21', '9 PM remains daylight in summer');
  assert.equal(initialForecastDay(christchurch, Date.parse('2026-12-21T09:00:00Z')), '2026-12-22');
  assert.equal(initialForecastDay(christchurch, Date.parse('2026-06-21T06:00:00Z')), '2026-06-22', 'winter evening opens tomorrow');
  assert.ok(TIME_ZONES.includes(christchurch.timeZone));
  assert.ok(isValidTimeZone(christchurch.timeZone));
});

test('NZ daylight includes early summer hours and excludes winter darkness', () => {
  const summer = launchDayWindow(christchurch, '2026-12-21');
  const winter = launchDayWindow(christchurch, '2026-06-21');
  assert.ok(summer.startMs < Date.parse('2026-12-20T17:00:00Z'), 'summer sunrise before 6 AM NZDT');
  assert.ok(summer.endMs > Date.parse('2026-12-21T08:00:00Z'), 'summer sunset after 9 PM NZDT');
  assert.ok(winter.startMs > Date.parse('2026-06-20T19:00:00Z'), 'winter sunrise after 7 AM NZST');
  assert.ok(winter.endMs < Date.parse('2026-06-21T06:00:00Z'), 'winter sunset before 6 PM NZST');
  assert.ok(forecastCoversWindow({ referenceTime: '2026-12-20T00:00:00Z', firstForecastHour: 17, lastForecastHour: 17 }, summer));
  assert.equal(forecastCoversWindow({ referenceTime: '2026-06-20T00:00:00Z', firstForecastHour: 19, lastForecastHour: 19 }, winter), false);
});

test('NZ DST transitions keep sunrise and sunset within the selected local date', () => {
  for (const [date, length] of [['2026-04-05', 25], ['2026-09-27', 23]] as const) {
    const start = localInstantMs(date, 0, christchurch.timeZone), end = localInstantMs(date, 24, christchurch.timeZone);
    assert.equal((end - start) / 3_600_000, length);
    const daylight = launchDayWindow(christchurch, date);
    for (const time of [daylight.startMs, daylight.endMs]) {
      assert.ok(time > start && time < end);
      assert.equal(localDateKey(new Date(time).toISOString(), christchurch.timeZone), date);
    }
  }
});

test('polar locations keep the complete local day when the sun never sets', () => {
  const site = { latitude: 80, longitude: 20, timeZone: 'Arctic/Longyearbyen' };
  const day = launchDayWindow(site, '2026-06-21');
  assert.equal(day.startMs, localInstantMs('2026-06-21', 0, site.timeZone));
  assert.equal(day.endMs, localInstantMs('2026-06-21', 24, site.timeZone));
});
