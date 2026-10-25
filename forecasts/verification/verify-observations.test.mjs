import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MATCHED_RAOB_SITE_PAIRS, buildBlanchardCrossModelSpread, buildSkillReport, localDaytimeWindowMs, verifyModelAgainstRaob, summarizeVerifications } from './verify-observations.mjs';
import { evaluateRaobMatch } from './history.mjs';

test('RRFS participates in matched observation verification and deterministic model comparisons', t => {
  const root = mkdtempSync(join(tmpdir(), 'rrfs-verification-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  const levels = [{ pressureHpa: 850, temperatureC: 10, dewPointC: 5, windSpeedMps: 4, windDirectionDeg: 180 }];
  // Newest-first RAOB file: 2026-10-21T00:00:00Z is first, older 2026-10-20T12:00:00Z is last
  write('raob/sites/or-woodrat-mountain.json', {
    station: { id: 'KMFR', distanceKm: 18, elevationM: 400 },
    soundings: [
      { validAt: '2026-10-21T00:00:00Z', levels },
      { validAt: '2026-10-20T12:00:00Z', levels: [{ ...levels[0], temperatureC: 2 }] },
    ],
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

  // Automatic observation selection (targetSoundingValidAt = null) selects the latest eligible matching sounding from newest-first RAOB files
  const autoMatch = verifyModelAgainstRaob(root, 'rrfs', MATCHED_RAOB_SITE_PAIRS[0], null);
  assert.ok(autoMatch);
  assert.equal(autoMatch.soundingValidAt, '2026-10-21T00:00:00Z');
  assert.equal(autoMatch.metrics.temperatureMaeC, 1);

  // A shared recorded column tests routing only, not RRFS meteorological accuracy.
  const column = JSON.parse(readFileSync(new URL('../soaring/fixtures/blanchard-published.json', import.meta.url), 'utf8'));
  write('rrfs/sites/wa-blanchard.json', { ...column, model: 'rrfs' });
  const spread = buildBlanchardCrossModelSpread(root);
  assert.equal(spread.length, 1);
  assert.equal(spread[0].model, 'rrfs');
  assert.equal(spread[0].modelKind, 'deterministic-column');
  assert.equal(spread[0].status, 'available');
  assert.equal(spread[0].coverageSamples, 14);
  assert.equal(spread[0].coverageSpanHours, 13);
  assert.ok(Number.isFinite(spread[0].peakWstarV2Mps));

  // P0-1: Empty comparison window returns null (not 0) with explicit unavailable status and coverageSamples: 0
  const emptySpread = buildBlanchardCrossModelSpread(root, { localDate: '2026-11-15', timeZone: 'America/Los_Angeles' });
  assert.equal(emptySpread.length, 1);
  assert.equal(emptySpread[0].coverageSamples, 0);
  assert.equal(emptySpread[0].coverageSpanHours, 0);
  assert.equal(emptySpread[0].status, 'unavailable');
  assert.equal(emptySpread[0].peakWstarV2Mps, null);
  assert.equal(emptySpread[0].peakUsableLiftTopV2M, null);

  // Site-timezone daytime windows adapt across timezones and DST instead of assuming 14Z-03Z everywhere
  const pdtWindow = localDaytimeWindowMs('2026-10-21', 'America/Los_Angeles');
  assert.equal(pdtWindow.windowStartIso, '2026-10-21T14:00:00Z');
  assert.equal(pdtWindow.windowEndIso, '2026-10-22T03:00:00Z');
  const edtWindow = localDaytimeWindowMs('2026-10-21', 'America/New_York');
  assert.equal(edtWindow.windowStartIso, '2026-10-21T11:00:00Z');
  assert.equal(edtWindow.windowEndIso, '2026-10-22T00:00:00Z');
});

test('evaluation requires a finite nonnegative lead and exact time is not rounded', () => {
  const input = { distanceKm: 18, soundingValidAt: '2026-10-21T00:00:00Z', forecastValidAt: '2026-10-21T01:00:00Z', referenceTime: '2026-10-21T00:00:00Z' };
  assert.equal(evaluateRaobMatch(input).matchTier, 'near-init-f01-60min');
  for (const referenceTime of [null, 'invalid', '2026-10-22T00:00:00Z']) assert.equal(evaluateRaobMatch({ ...input, referenceTime }).matched, false);
  assert.equal(evaluateRaobMatch({ ...input, referenceTime: '2026-10-20T22:00:00Z' }).matched, false);
  assert.equal(evaluateRaobMatch({ ...input, forecastValidAt: '2026-10-21T00:00:20Z' }).matchTier, 'near-init-f01-60min');
  assert.equal(evaluateRaobMatch({ ...input, distanceKm: -1 }).matched, false);
});

test('each metric retains its own support and exact/near-init observations never pool', () => {
  const row = { model: 'hrrr-conus', station: { id: 'KMFR' }, soundingValidAt: '2026-10-21T00:00:00Z', regime: 'test', leadTimeBucket: 'f00-f06', matchTier: 'exact-valid-time',
    metrics: { temperatureMaeC: 2, temperatureBiasC: 2, dewPointMaeC: null, windVectorRmseMps: null, windSpeedBiasMps: null } };
  const result = summarizeVerifications([row, { ...row, model: 'rdps', metrics: { ...row.metrics, temperatureMaeC: null, windVectorRmseMps: 4 } },
    { ...row, matchTier: 'near-init-f01-60min', metrics: { ...row.metrics, temperatureMaeC: 20 } }]);
  assert.equal(result.independentStationDays, 1);
  assert.deepEqual(result.byMatchTier['exact-valid-time'].temperatureMaeC, { comparisons: 1, independentStationDays: 1, mean: 2 });
  assert.deepEqual(result.byMatchTier['exact-valid-time'].meanProfileWindVectorRmseMps, { comparisons: 1, independentStationDays: 1, mean: 4 });
  assert.equal(result.byMatchTier['near-init-f01-60min'].temperatureMaeC.mean, 20);
});
