import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverIconRun, normalizeIconExtract, readIconAcquisition, writeIconAcquisition } from '../src/icon.ts';
import { parseIconExtract } from '../src/internal/icon-json.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../forecasts/scripts/lib/icon-native-fixture.json', import.meta.url)));

test('ICON inline and segmented caches require consistent cells, run hours and column times', t => {
  const root = mkdtempSync(join(tmpdir(), 'icon-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = normalizeIconExtract(fixture);
  const corruptions = [
    data => { data.siteCells.extra = data.cells.length; },
    data => { data.siteCells.extra = 0.5; },
    data => { data.referenceTime = 'invalid'; },
    data => { data.hours[0].sources[0].validAt = '2020-01-01T00:00:00Z'; },
    data => { data.hours[0].forecastHour += 1; },
    data => { data.hours[0].sources.pop(); },
    data => { data.hours.push(structuredClone(data.hours[0])); },
    data => { data.hours = []; },
  ];
  for (const format of ['inline', 'segmented']) {
    const path = join(root, `${format}.json`);
    const write = data => format === 'inline' ? writeFileSync(path, JSON.stringify(data)) : writeIconAcquisition(path, data);
    write(original);
    assert.deepEqual(readIconAcquisition(path), original);
    for (const corrupt of corruptions) {
      const data = structuredClone(original);
      corrupt(data);
      write(data);
      assert.throws(() => readIconAcquisition(path), /ICON/, `${format}: ${corrupt}`);
    }
  }
});

test('ICON decoder records preserve one value, including explicit null, per selected cell', () => {
  const extract = structuredClone(fixture);
  const record = Object.values(extract.records)[0];
  record.values[0] = null;
  assert.equal(parseIconExtract(extract), extract);
  record.values.pop();
  assert.throws(() => parseIconExtract(extract), /Invalid ICON field record/);
});

test('a failed ICON completion probe still permits the preceding complete main run', async () => {
  const result = await discoverIconRun({ now: new Date('2026-10-24T13:00:00Z'), fetchFn: async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method !== 'HEAD') return { ok: true, text: async () => '<a href="2026-10-24T06%3A00/">6</a><a href="2026-10-24T00%3A00/">0</a>' };
    if (url.includes('06%3A00') && url.includes('ASHFL_S')) throw new Error('connection reset');
    return { ok: true };
  } });
  assert.equal(result.referenceTime, '2026-10-24T00:00:00Z');
});
