import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as core from '@windgrams/soaring';
import * as compatibility from '@windgrams/soaring/compatibility';
import { parseAtmosphericColumn } from '@windgrams/contracts';

test('public scientific signatures narrow unknown data and reject untyped or incomplete state', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    fileURLToPath(new URL('./public-types.ts', import.meta.url)),
    fileURLToPath(new URL('../../geography/test/public-types.ts', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('typed diagnostic facade retains runtime function identity and exact diagnostic shape', async () => {
  const kernel = await import('../dist/diagnostics.js');
  assert.equal(core.deriveDiagnosticsV2, kernel.deriveDiagnosticsV2);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/diagnostic-parity.json', import.meta.url)));
  for (const item of fixture.cases) {
    const result = core.deriveDiagnosticsV2(item.terrainM, item.source, item.v1Hour, item.options);
    assert.deepEqual(result, item.expected);
    assert.equal(result.contractVersion, '2.2.0');
    for (const [key, value] of Object.entries(result)) {
      if (['contractVersion', 'verticalResolution', 'experimental'].includes(key)) continue;
      assert.ok(value === null || Number.isFinite(value), key);
    }
    assert.equal(result.verticalResolution.synthesizedLevels, 0);
  }
});

test('compatibility reconstruction preserves unvalidated optional distributions for explicit scalar validation', () => {
  const profile = JSON.parse(readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
  const hour = profile.hours[0];
  const distribution = { members: 2, p10: 1, p25: 2, p50: 3, p75: 4, p90: 5 };
  hour.surface.windGustMps = distribution;
  const reconstructed = compatibility.sourceFromPublishedDeterministicHour(hour);
  assert.equal(reconstructed.windGustMps, distribution);
  assert.equal(parseAtmosphericColumn(reconstructed), null);
  assert.equal(core.deriveDiagnosticsV2(0, null, {}), null);
});
