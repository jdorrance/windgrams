import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildBlanchardCrossModelSpread, buildSkillReport } from './verify-observations.mjs';

test('RRFS participates in matched observation verification and deterministic model comparisons', t => {
  const root = mkdtempSync(join(tmpdir(), 'rrfs-verification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const levels = [{ pressureHpa: 850, temperatureC: 10, dewPointC: 5, windSpeedMps: 4, windDirectionDeg: 180 }];
  write('raob/sites/or-woodrat-mountain.json', {
    station: { id: 'KMFR', distanceKm: 18, elevationM: 400 },
    soundings: [{ validAt: '2026-10-21T00:00:00Z', levels }],
  });
  write('rrfs/sites/or-woodrat-mountain.json', {
    model: 'rrfs', site: { modelElevationM: 500 }, run: { referenceTime: '2026-10-21T00:00:00Z' },
    hours: [{ validAt: '2026-10-21T01:00:00Z', levels: [{ ...levels[0], temperatureC: 11 }] }],
  });
  const report = buildSkillReport(root);
  assert.equal(report.observationVerificationSkill.matchedCount, 1);
  const comparison = report.observationVerificationSkill.matchedPairs[0];
  assert.equal(comparison.model, 'rrfs');
  assert.equal(comparison.metrics.temperatureMaeC, 1);

  // A shared recorded column tests routing only, not RRFS meteorological accuracy.
  const column = JSON.parse(readFileSync(new URL('../soaring/fixtures/blanchard-published.json', import.meta.url), 'utf8'));
  write('rrfs/sites/wa-blanchard.json', { ...column, model: 'rrfs' });
  const spread = buildBlanchardCrossModelSpread(root);
  assert.equal(spread.length, 1);
  assert.equal(spread[0].model, 'rrfs');
  assert.equal(spread[0].modelKind, 'deterministic-column');
  assert.ok(Number.isFinite(spread[0].peakWstarV2Mps));
});
