import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildWindgramView, readWindgram } from '@windgrams/windgram/scene';
import { renderWindgramSvg, renderWindgramKey } from '@windgrams/windgram/svg';
import { sceneData } from '../dist/scene-store.js';
import { convertQuantity } from '@windgrams/windgram/format';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';

const fixtures = new URL('../../../web/test/fixtures/windgram-visual/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtures), 'utf8'));
const baseline = JSON.parse(readFileSync(new URL('./scene-parity.sha256.json', import.meta.url), 'utf8'));
const load = entry => parsePublishedProfileJson(gunzipSync(readFileSync(new URL(entry.file, fixtures))).toString());

test('package extraction preserves 40 exact scenes, SVGs, keys and physical readouts', () => {
  for (const entry of manifest.fixtures.filter(f => f.file)) for (const unitSystem of ['imperial', 'metric']) for (const compact of [false, true]) for (const heightRange of ['soaring', 'full']) {
    const profile = load(entry);
    const view = buildWindgramView(profile, { unitSystem, compact, heightRange, widthPx: compact ? 356 : 800, timeZone: entry.timeZone, launch: entry.launch, hours: { dateKey: entry.day, timeZone: entry.timeZone } });
    const payload = { view: sceneData(view), svg: renderWindgramSvg(view, { idPrefix: 'parity' }), key: renderWindgramKey(unitSystem), readings: view.hours.map((_, i) => readWindgram(view, i, (view.floorM + view.topM) / 2)) };
    const key = [entry.id, unitSystem, compact, heightRange].join('/');
    assert.equal(createHash('sha256').update(JSON.stringify(payload)).digest('hex'), baseline[key], key);
  }
});

test('independent contexts need no browser preferences and produce independent SVG ids', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  const entry = manifest.fixtures.find(f => f.id === 'dog-gfs');
  const profile = load(entry);
  const build = unitSystem => buildWindgramView(profile, { unitSystem, timeZone: entry.timeZone, widthPx: 600, hours: { dateKey: entry.day, timeZone: entry.timeZone } });
  const imperial = build('imperial'), metric = build('metric');
  const first = renderWindgramSvg(imperial, { idPrefix: 'first' });
  const second = renderWindgramSvg(metric, { idPrefix: 'second' });
  assert.equal(imperial.unitSystem, 'imperial');
  assert.equal(metric.unitSystem, 'metric');
  assert.equal(renderWindgramSvg(imperial, { idPrefix: 'first' }), first);
  assert.match(first, /id="first-plot"/);
  assert.match(second, /id="second-plot"/);
  assert.doesNotMatch(second, /id="first-plot"/);
  assert.deepEqual(sceneData(imperial).sampling, sceneData(metric).sampling);
  assert.equal(convertQuantity(1, 'elevation', 'metric'), 1);
});

test('fractional time zones retain real minutes on forecast and daylight ticks', () => {
  const entry = manifest.fixtures.find(f => f.id === 'dog-gfs');
  const profile = load(entry);
  profile.site.latitude = -43.95;
  profile.site.longitude = -176.56;
  const timeZone = 'Pacific/Chatham';
  const view = buildWindgramView(profile, { unitSystem: 'metric', timeZone, widthPx: 356, compact: true, hours: { dateKey: '2026-10-25', timeZone } });
  assert.ok(view.hours.length > 0 && sceneData(view).timeAxis.length > 0);
  for (const hour of view.hours) assert.match(hour.label, /:45[ap]$/);
  for (const tick of sceneData(view).timeAxis) assert.match(tick.label, /:45[ap]$/);
  for (const hour of view.hours) assert.ok(profile.hours.some(source => source.validAt === hour.validAt), 'native valid times are unchanged');
});

test('public scenes contain only metadata and reject copied or hydrated handles', () => {
  const entry = manifest.fixtures.find(f => f.id === 'dog-gfs');
  const view = buildWindgramView(load(entry), { unitSystem: 'metric', timeZone: entry.timeZone, widthPx: 600 });
  assert.equal(Object.hasOwn(view, 'sampling'), false);
  assert.equal(Object.hasOwn(view, 'contours'), false);
  assert.equal(Object.hasOwn(view.hours[0], 'temperatureF'), false);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.hours) && Object.isFrozen(view.ground));
  assert.throws(() => readWindgram({ ...view }, 0, 1000), /returned by buildWindgramView/);
  assert.throws(() => renderWindgramSvg(JSON.parse(JSON.stringify(view))), /returned by buildWindgramView/);
  view.selectedHourIndex = 1;
  assert.equal(view.selectedHourIndex, 1);
  assert.equal(sceneData(view).selectedHourIndex, 1, 'keyboard inspector starts at host selection');
});
