import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, loadVisualFixture } from './fixtures/windgram-visual/scenarios.mjs';
import { parsePublishedProfileJson } from '../src/lib/published-lift.ts';
import { buildWindgramView, hourSampling, readWindgram } from '../src/lib/windgram-view.ts';

test('frozen Dog and ICON records retain provenance, source times and native levels', () => {
  const published = manifest.fixtures.filter(entry => entry.kind === 'published');
  assert.deepEqual(published.map(entry => entry.id), ['dog-rrfs', 'dog-hrrr-conus', 'dog-hrdps-continental', 'dog-gfs', 'aparan-icon-eu']);
  for (const entry of published) {
    const raw = loadVisualFixture(entry); // Checks compressed and uncompressed SHA-256.
    const profile = parsePublishedProfileJson(JSON.stringify(raw));
    assert.ok(profile, entry.id + ' parses with its published diagnostic extensions');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: entry.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    assert.equal(profile.hours.length, entry.hourCount);
    profile.hours.forEach((hour, i) => {
      assert.equal(date.format(new Date(hour.validAt)), entry.day);
      assert.deepEqual(hour.levels, raw.hours[i].levels);
      assert.deepEqual(hour.surface, raw.hours[i].surface);
      assert.equal(hour.validAt, raw.hours[i].validAt);
    });
    assert.deepEqual([...new Set(profile.hours.map(hour => hour.levels.length))], entry.nativeLevelCounts);
  }
});

test('Aparan fixture keeps unavailable morning separate from source forecasts and AGL datum', () => {
  const entry = manifest.fixtures.find(item => item.id === 'aparan-icon-eu')!;
  const profile = parsePublishedProfileJson(JSON.stringify(loadVisualFixture(entry)))!;
  const view = buildWindgramView(profile, { timeZone: entry.timeZone, compact: true, widthPx: 356,
    heightRange: 'soaring', launch: entry.launch, unitSystem: 'imperial', hours: { dateKey: entry.day, timeZone: entry.timeZone } });
  assert.ok(view.timeAxis[0].hourIndex === null, 'Morning has no model sample');
  assert.ok(Date.parse(view.timeAxis[0].validAt) < Date.parse(profile.hours[0].validAt));
  assert.ok(view.hours.every(hour => profile.hours.some(source => source.validAt === hour.validAt)));
  assert.equal(view.ground.elevationM, 2404.8);
  const reading = readWindgram(view, 0, view.floorM + 100);
  assert.equal(reading.heightAglM, reading.heightM - 2404.8);
});

test('labelled synthetic recipes exercise strong lift, inversions and cloud layers', () => {
  for (const entry of manifest.fixtures.filter(item => item.kind === 'synthetic')) {
    const raw = loadVisualFixture(entry);
    const profile = parsePublishedProfileJson(JSON.stringify(raw));
    assert.ok(profile, entry.id + ' parses');
    assert.equal(profile.site.timeZone, 'Etc/UTC');
    const samples = profile.hours.map(hour => hourSampling(hour, profile.site.modelElevationM));
    if (entry.id === 'synthetic-strong-lift') {
      assert.ok(profile.hours.some(hour => typeof hour.derived.thermalVelocityMps === 'number' && hour.derived.thermalVelocityMps >= 2.5));
    } else if (entry.id === 'synthetic-inversions') {
      assert.ok(samples.every(hour => hour.lapseCPer1000Ft.filter(node => node.value > 0.5).length >= 4));
    } else {
      assert.ok(profile.hours.every(hour => hour.levels.some(level => level.cloudFractionPercent === 75)));
      assert.ok(samples.every(hour => hour.relativeHumidityPercent.some(node => node.value > 95)));
    }
  }
});
