import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshnessNotice } from '../src/scripts/freshness-notice.ts';
import type { ProviderRefresh } from '@windgrams/contracts/provider-health';

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

test('refresh failures remain visible independently of forecast age and never expose operator errors', () => {
  let now = Date.parse('2026-10-25T06:00:00Z');
  let historical = false;
  let refresh: ProviderRefresh | null = { attemptedAt: '2026-10-25T04:00:00Z', completedAt: '2026-10-25T05:00:00Z',
    lastSuccessfulRefreshAt: null, outcome: 'retained', reason: '/tmp/provider secret diagnostic' };
  const host = { textContent: '', hidden: true, dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const controller = new AbortController();
  const notice = createFreshnessNotice(host, () => ({ referenceTime: '2026-10-25T00:00:00Z', validUntil: '2026-10-27T00:00:00Z',
    policy: { runIntervalHours: 6, typicalPublicationLagHours: 2 }, historical, refresh }), controller.signal, {
    now: () => now, window: new EventTarget(), document: Object.assign(new EventTarget(), { hidden: true }),
    setTimeout() { return 1; }, clearTimeout() {},
  });
  const warning = 'Latest update failed';
  for (const outcome of ['retained', 'unavailable'] as const) {
    refresh = { ...refresh!, outcome }; notice.refresh();
    assert.equal(host.dataset.freshness, 'current');
    assert.equal(host.hidden, false);
    assert.equal(host.textContent, warning);
  }
  now = Date.parse('2026-10-25T09:00:00Z'); notice.refresh();
  assert.equal(host.dataset.freshness, 'delayed');
  assert.equal(host.textContent, `Update delayed · ${warning}`);
  historical = true; notice.refresh();
  assert.equal(host.textContent, 'Historical forecast');
  historical = false; now = Date.parse('2026-10-25T06:00:00Z');
  for (const outcome of ['updated', 'running'] as const) {
    refresh = { ...refresh!, outcome }; notice.refresh();
    assert.equal(host.hidden, true);
  }
  refresh = null; notice.refresh();
  assert.equal(host.hidden, true);
  controller.abort();
});
