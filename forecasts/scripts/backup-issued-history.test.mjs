import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveModelRun, archivedModelRuns } from '../verification/issued-history.mjs';
import { inventoryHistory, packHistory, restoreHistory, verifyHistoryInventory } from './backup-issued-history.mjs';

function workspace(t) { const root = mkdtempSync(join(tmpdir(), 'history-backup-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

function issuedHistory(t) {
  const root = workspace(t);
  const live = join(root, 'hrrr-conus');
  mkdirSync(join(live, 'sites'), { recursive: true });
  const referenceTime = '2026-10-21T00:00:00Z';
  const levels = [925, 850].map((pressureHpa, i) => ({ pressureHpa, heightM: 500 + i * 500, temperatureC: 10, dewPointC: 5, windSpeedMps: 3, windDirectionDeg: 180 }));
  const doc = { model: 'hrrr-conus', site: { id: 'or-woodrat-mountain', modelElevationM: 300 }, run: { referenceTime },
    soaringMeta: { contractVersion: '2.3.0' }, hours: [{ validAt: referenceTime, surface: { temperatureC: 10 }, levels, soaring: { contractVersion: '2.3.0', thermalVelocityV2Mps: 0 } }] };
  writeFileSync(join(live, 'manifest.json'), JSON.stringify({ model: doc.model, referenceTime, forecastHours: 1, sites: [{ slug: doc.site.id }] }));
  writeFileSync(join(live, 'sites', `${doc.site.id}.json`), JSON.stringify(doc));
  archiveModelRun(root, 'hrrr-conus');
  return join(root, 'history');
}

test('pack, tamper detection and restore round-trip preserve issued revisions', t => {
  const history = issuedHistory(t);
  const out = join(workspace(t), 'backup');
  const manifest = packHistory({ historyRoot: history, outputDir: out, createdAt: '2026-10-26T00:00:00Z', chunkBytes: 1024 });
  assert.ok(manifest.fileCount >= 3);
  assert.equal(manifest.revisions, 1);
  assert.ok(manifest.archive.chunks.length > 1, 'small chunk size exercises chunking');
  verifyHistoryInventory(history, manifest);

  const restored = join(workspace(t), 'data', 'history');
  restoreHistory({ archiveDir: out, outputRoot: restored });
  assert.equal(inventoryHistory(restored).treeSha256, manifest.treeSha256);
  assert.equal(archivedModelRuns(join(restored, '..'), 'hrrr-conus').length, 1, 'restored first issue is scoreable');

  const damaged = join(workspace(t), 'backup');
  packHistory({ historyRoot: history, outputDir: damaged, chunkBytes: 1024 });
  const chunk = join(damaged, 'issued-history.tar.part-000');
  const bytes = readFileSync(chunk); bytes[10] ^= 0xff; writeFileSync(chunk, bytes);
  assert.throws(() => restoreHistory({ archiveDir: damaged, outputRoot: join(workspace(t), 'data', 'history') }), /Corrupt backup chunk/);
});

test('inventory verification rejects a modified history file', t => {
  const history = issuedHistory(t);
  const manifest = inventoryHistory(history);
  const index = join(history, 'hrrr-conus', '20261021T000000Z', 'index.json');
  writeFileSync(index, `${readFileSync(index, 'utf8')} `);
  assert.throws(() => verifyHistoryInventory(history, manifest), /History inventory differs/);
});
