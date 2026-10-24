import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCapabilities, launchCountry, shortModelLabel } from '../src/lib/forecast-capabilities.ts';
import { launchConditions } from '../src/lib/launch-forecast.ts';
import { DEFAULT_DETAILS } from '../src/lib/launches.ts';
import { readFileSync } from 'node:fs';
import { parsePublishedProfileJson } from '../src/lib/published-lift.ts';

test('Armenia uses ICON and global coverage while existing US model priority stays intact', () => {
  assert.equal(launchCountry({ timeZone: 'Asia/Yerevan' }), 'AM');
  const armenia = forecastCapabilities({ timeZone: 'Asia/Yerevan' });
  assert.deepEqual(armenia.models, ['icon-eu', 'gfs', 'gdps', 'geps']);
  assert.equal(armenia.nws, false);
  assert.equal(armenia.raob, false);
  const us = forecastCapabilities({ timeZone: 'America/Boise' });
  assert.deepEqual(us.models, ['hrrr-conus', 'hrdps-continental', 'rrfs', 'rdps', 'gfs', 'gdps', 'geps']);
  assert.equal(us.nws, true);
  assert.equal(us.raob, true);
  assert.equal(shortModelLabel('icon-eu'), 'ICON-EU');
  assert.equal(shortModelLabel('hrrr-conus'), 'HRRR');
});

test('unknown launch limits add no fabricated wind-direction or speed judgement', () => {
  const raw = readFileSync(new URL('../../forecasts/soaring/fixtures/blanchard-published.json', import.meta.url), 'utf8');
  const hour = structuredClone(parsePublishedProfileJson(raw)!.hours[0]);
  hour.surface.windDirectionDeg = 180;
  hour.surface.windSpeedMps = 10;
  hour.surface.windGustMps = 20;
  const unknown = launchConditions(hour, DEFAULT_DETAILS, null);
  assert.deepEqual(unknown.issues, []);
  assert.ok(unknown.values[0][1].includes('S '));
  const known = launchConditions(hour, { ...DEFAULT_DETAILS, facingDeg: 0, windArcHalfWidthDeg: 30, windMaxMph: 15, gustMaxMph: 20 }, null);
  assert.deepEqual(known.issues, ['Wind outside launch direction', 'Wind above saved limit', 'Gusts above saved limit']);
});
