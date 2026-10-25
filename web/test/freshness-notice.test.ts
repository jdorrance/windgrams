import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshnessNotice } from '../src/scripts/freshness-notice.ts';

test('a visible forecast changes at its age boundary and is reassessed after page restoration', () => {
  let now = Date.parse('2026-10-25T08:00:00Z');
  let callback: (() => void) | undefined;
  let delay = 0;
  const target = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: false });
  const host = { textContent: '', hidden: true, dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const controller = new AbortController();
  const notice = createFreshnessNotice(host, () => ({ referenceTime: '2026-10-25T00:00:00Z', validUntil: '2026-10-27T00:00:00Z', policy: { runIntervalHours: 6, typicalPublicationLagHours: 2 } }), controller.signal, {
    now: () => now, window: target, document: doc,
    setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() { callback = undefined; },
  });
  notice.refresh();
  assert.equal(host.hidden, true);
  assert.equal(delay, 1);
  now += delay;
  callback?.();
  assert.equal(host.dataset.freshness, 'delayed');
  assert.equal(host.hidden, false);
  target.dispatchEvent(new Event('pagehide'));
  assert.equal(callback, undefined);
  now = Date.parse('2026-10-27T00:00:01Z');
  target.dispatchEvent(new Event('pageshow'));
  assert.equal(host.dataset.freshness, 'expired');
  assert.equal(host.textContent, 'Forecast ended · reload for update');
  controller.abort();
  assert.equal(callback, undefined);
});

test('visibility changes catch missed boundaries; disposing prevents later DOM updates', () => {
  let now = Date.parse('2026-10-25T02:00:00Z');
  let scheduled = 0;
  const target = new EventTarget(), doc = Object.assign(new EventTarget(), { hidden: true });
  const host = { textContent: '', hidden: true, dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const controller = new AbortController();
  const notice = createFreshnessNotice(host, () => ({ referenceTime: '2026-10-25T00:00:00Z', validUntil: '2026-10-27T00:00:00Z', policy: null }), controller.signal, {
    now: () => now, window: target, document: doc,
    setTimeout() { scheduled++; return 1; }, clearTimeout() {},
  });
  notice.refresh();
  assert.equal(host.dataset.freshness, 'unknown');
  assert.equal(scheduled, 0);
  now = Date.parse('2026-10-27T01:00:00Z');
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(host.dataset.freshness, 'expired');
  controller.abort();
  now = Date.parse('2026-10-25T02:00:00Z');
  target.dispatchEvent(new Event('pageshow'));
  notice.refresh();
  assert.equal(host.dataset.freshness, 'expired');
});
