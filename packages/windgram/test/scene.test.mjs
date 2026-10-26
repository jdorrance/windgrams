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

// Wind trigonometry differs by a few ULPs between V8's ARM64 and x64 builds.
// Keep 15 significant digits for derived components, speeds and bearings only.
// SVGs, keys, source measurements, coordinates and all other data stay exact.
function sceneParityHash(payload) {
  const windNumber = value => typeof value === 'number' ? Number(value.toPrecision(15)) : value;
  const serialized = JSON.stringify(payload, (key, value) => {
    if (key === 'speedKt' || key === 'directionDeg') return windNumber(value);
    if (key === 'windU' || key === 'windV') {
      return value.map(node => ({ ...node, value: windNumber(node.value) }));
    }
    return value;
  });
  return createHash('sha256').update(serialized).digest('hex');
}

// Baseline reviewed with physical 2 m/10 m anchors and solar-crossing daylight;
// see web/test/fixtures/windgram-visual/README.md for the intentional differences.
test('reviewed renderer preserves 40 scenes, exact SVGs and keys, and physical readouts', () => {
  for (const entry of manifest.fixtures.filter(f => f.file)) for (const unitSystem of ['imperial', 'metric']) for (const compact of [false, true]) for (const heightRange of ['soaring', 'full']) {
    const profile = load(entry);
    const view = buildWindgramView(profile, { unitSystem, compact, heightRange, widthPx: compact ? 356 : 800, timeZone: entry.timeZone, launch: entry.launch, hours: { dateKey: entry.day, timeZone: entry.timeZone } });
    const payload = { view: sceneData(view), svg: renderWindgramSvg(view, { idPrefix: 'parity' }), key: renderWindgramKey(unitSystem), readings: view.hours.map((_, i) => readWindgram(view, i, (view.floorM + view.topM) / 2)) };
    const key = [entry.id, unitSystem, compact, heightRange].join('/');
    assert.equal(sceneParityHash(payload), baseline[key], key);
  }
});

test('scene parity tolerates only insignificant derived wind rounding', () => {
  const payload = {
    windU: [{ altitudeM: 1000, value: 0.9840885434857611 }],
    windV: [{ altitudeM: 1000, value: 5.747077093956845 }],
    speedKt: 13.49528126929258,
    directionDeg: 228.99999999999997,
    temperatureF: 32,
    svg: '<path d="M0.9840885434857611,0"/>',
    key: '<text>Wind 10 kt</text>',
  };
  const original = structuredClone(payload);
  const hash = sceneParityHash(payload);
  assert.equal(hash, sceneParityHash({
    ...payload,
    windU: [{ altitudeM: 1000, value: 0.9840885434857609 }],
    windV: [{ altitudeM: 1000, value: 5.747077093956843 }],
    speedKt: 13.495281269292578,
    directionDeg: 229,
  }));
  for (const change of [
    { windU: [{ altitudeM: 1000, value: 0.9840885434858 }] },
    { windV: [{ altitudeM: 1000, value: 5.7470770939569 }] },
    { speedKt: 13.495281269293 },
    { directionDeg: 229.000000000001 },
    { temperatureF: 32.00000000000001 },
    { windU: [{ altitudeM: 1000.0000000000001, value: payload.windU[0].value }] },
    { svg: '<path d="M0.9840885434857609,0"/>' },
    { key: '<text>Wind 11 kt</text>' },
  ]) assert.notEqual(sceneParityHash({ ...payload, ...change }), hash, JSON.stringify(change));
  assert.deepEqual(payload, original, 'snapshot normalization never mutates scientific data');
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
