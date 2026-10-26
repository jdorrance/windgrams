import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildWindgramView } from '@windgrams/windgram/scene';
import { mountWindgram } from '@windgrams/windgram/dom';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';

const profile = parsePublishedProfileJson(gunzipSync(readFileSync(new URL('../../../web/test/fixtures/windgram-visual/dog-gfs.json.gz', import.meta.url))).toString());
const build = widthPx => buildWindgramView(profile, { unitSystem: 'metric', timeZone: 'America/Los_Angeles', widthPx, hours: { dateKey: '2026-10-24', timeZone: 'America/Los_Angeles' } });

// Minimal DOM ownership harness: the inspector's pointer geometry has its own
// real-profile tests in web/test/windgram-inspector.test.ts.
class Element extends EventTarget {
  attributes = new Map();
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
}
function hostElement() {
  const host = new Element();
  const ownerDocument = Object.assign(new EventTarget(), { createElementNS: () => new Element() });
  let svg = null, markup = '';
  Object.assign(host, {
    ownerDocument, contains: target => target === host,
    querySelector: selector => selector === 'svg.windgram' ? svg : svg?.querySelector(selector) ?? null,
    replaceChildren: () => { svg = null; markup = ''; },
  });
  Object.defineProperty(host, 'innerHTML', {
    get: () => markup,
    set(value) {
      markup = value;
      let selected = null;
      svg = {
        querySelector: selector => selector === '[data-selected-hour]' ? selected : null,
        insertBefore: child => { selected = child; },
        getScreenCTM: () => null,
      };
    },
  });
  return host;
}
function key(host, value) {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key: value });
  host.dispatchEvent(event);
}

test('mount updates retain the selected valid time and replace listener ownership', () => {
  const view = build(600), host = hostElement(), selected = [];
  assert.ok(view.hours.length > 1);
  host.setAttribute('role', 'figure');
  const mounted = mountWindgram(host, { view, idPrefix: 'independent', onSelectHour: time => selected.push(time) });
  const validAt = view.hours[1].validAt;
  mounted.select(validAt);
  const cursor = host.querySelector('[data-selected-hour]');
  assert.equal(cursor.getAttribute('x'), String(view.left), 'the first daylight selection stops at sunrise');
  assert.equal(Number(cursor.getAttribute('width')), view.hours[1].x + view.columnWidth / 2 - view.left);
  const resized = build(356);
  mounted.update(resized);
  assert.equal(host.querySelector('[data-selected-hour]').getAttribute('x'), String(resized.left), 'resize retains the selected hour and its clipped edge');
  key(host, 'End');
  const lastVisible = resized.hours.findLast(hour => hour.x <= resized.left + resized.plotWidth);
  assert.deepEqual(selected, [lastVisible.validAt], 'one callback for the last visible sample after replacing the inspector');
  const lastCursor = host.querySelector('[data-selected-hour]');
  assert.equal(Number(lastCursor.getAttribute('x')) + Number(lastCursor.getAttribute('width')), resized.left + resized.plotWidth, 'last selection stops at sunset');
  mounted.select('2000-01-01T00:00:00Z');
  assert.equal(host.querySelector('[data-selected-hour]').getAttribute('visibility'), 'hidden');
  mounted.dispose(); mounted.dispose();
  assert.equal(host.innerHTML, '');
  assert.equal(host.getAttribute('role'), 'figure');
  key(host, 'Home');
  mounted.update(view);
  assert.equal(host.innerHTML, '', 'disposed mounts cannot recreate a chart');
  assert.equal(selected.length, 1, 'disposed mounts release keyboard listeners');
});

test('independent mounts do not share SVG identity or selected-hour state', () => {
  const view = build(600), a = hostElement(), b = hostElement();
  const first = mountWindgram(a, { view, idPrefix: 'first', selectedValidAt: null });
  const second = mountWindgram(b, { view, idPrefix: 'second', selectedValidAt: null });
  first.select(view.hours[1].validAt);
  assert.match(a.innerHTML, /id="first-plot"/);
  assert.match(b.innerHTML, /id="second-plot"/);
  assert.equal(a.querySelector('[data-selected-hour]').getAttribute('visibility'), 'visible');
  assert.equal(b.querySelector('[data-selected-hour]').getAttribute('visibility'), 'hidden');
  first.select(view.hours[0].validAt);
  assert.ok(view.hours[0].x < view.left, 'the nighttime source is retained outside the visible frame');
  assert.equal(a.querySelector('[data-selected-hour]').getAttribute('visibility'), 'hidden', 'nighttime selection cannot draw over the altitude labels');
  assert.equal(b.querySelector('[data-selected-hour]').getAttribute('visibility'), 'hidden');
  first.dispose(); second.dispose();
});

test('programmatic hour selection and resize retain independent keyboard positions', () => {
  const view = build(600), a = hostElement(), b = hostElement();
  const selectedA = [], selectedB = [];
  const first = mountWindgram(a, { view, idPrefix: 'first', selectedValidAt: view.hours[2].validAt, onSelectHour: time => selectedA.push(time) });
  const second = mountWindgram(b, { view, idPrefix: 'second', onSelectHour: time => selectedB.push(time) });
  const previousA = a.getAttribute('aria-label'), previousB = b.getAttribute('aria-label');
  first.select(view.hours[3].validAt);
  assert.match(a.getAttribute('aria-label'), /Lift top/);
  assert.notEqual(a.getAttribute('aria-label'), previousA, 'selection updates the reading');
  assert.equal(b.getAttribute('aria-label'), previousB, 'another mount retains its reading');
  second.select(view.hours[0].validAt);
  key(a, 'ArrowRight');
  key(b, 'ArrowRight');
  assert.deepEqual(selectedA, [view.hours[4].validAt]);
  assert.deepEqual(selectedB, [view.hours[1].validAt], 'another mount retains its own selection on the same scene');
  first.select(null);
  assert.doesNotMatch(a.getAttribute('aria-label'), /Lift top ·/);
  first.select(view.hours[4].validAt);
  const resized = build(356);
  first.update(resized);
  key(a, 'ArrowLeft');
  assert.deepEqual(selectedA, [view.hours[4].validAt, resized.hours[3].validAt]);
  first.dispose(); second.dispose();
});
