import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deriveDiagnosticsV2, SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { sourceFromPublishedDeterministicHour } from '@windgrams/soaring/compatibility';
import { cellSource, deriveCell } from './grib-column.mjs';
import { iconSource } from '../../packages/providers/src/internal/icon-native.ts';

const root = new URL('../../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = read('forecasts/soaring/fixtures/method-2.2-impact.json');

test('method 2.2 parcel/flux changes retain the recorded rounded diagnostics on 18 native and 84 reconstructed archived columns', () => {
  assert.equal(SOARING_CONTRACT_VERSION, evidence.comparedMethod);
  for (const [path, expected] of Object.entries(evidence.sources)) assert.equal(hash(readFileSync(new URL(path, root))), expected, path);
  const groups = { hrrrNative: [], rrfsNative: [], iconNative: [], rrfsPublishedReconstruction: [] };
  const add = (group, terrain, source, baseline = {}) => {
    const { contractVersion, ...diagnostics } = deriveDiagnosticsV2(terrain, source, baseline);
    groups[group].push(diagnostics);
  };
  const c = read('forecasts/soaring/cases/north-sound-20261021-00z.json');
  const hrrr = read('forecasts/soaring/fixtures/blanchard-raw.json');
  for (const h of hrrr.hours) {
    const source = cellSource(c, hrrr.grid, hrrr.cell, h.forecastHour, h.raw);
    add('hrrrNative', hrrr.terrain, source, deriveCell(c, hrrr.terrain, source, '2026-10-21T07:43:32Z').hour);
  }
  const rrfs = read('forecasts/soaring/fixtures/rrfs-native-column.json');
  const source = cellSource(rrfs.case, rrfs.grid, rrfs.cell, 8, rrfs.raw);
  add('rrfsNative', rrfs.terrain, source, deriveCell(rrfs.case, rrfs.terrain, source, rrfs.capturedAt).hour);
  const icon = read('forecasts/scripts/lib/icon-native-fixture.json');
  icon.cells.forEach((cell, index) => add('iconNative', cell.terrainM, iconSource(icon, 7, index)));
  const published = read('forecasts/soaring/fixtures/rrfs-blanchard-published.json');
  for (const hour of published.hours) add('rrfsPublishedReconstruction', published.site.modelElevationM, sourceFromPublishedDeterministicHour(hour), hour);
  for (const [name, diagnostics] of Object.entries(groups)) {
    assert.equal(diagnostics.length, evidence.groups[name].count, name);
    assert.equal(hash(JSON.stringify(diagnostics)), evidence.groups[name].baselineDiagnosticSha256, name);
  }
});
