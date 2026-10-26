import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { normalizeIconExtract, deriveIconProfile } from '../scripts/lib/icon-eu.mjs';
import { iconRegionalDocuments, writeIconRegionalBundle } from './icon-replay.mjs';
import { assertAgreement } from './science.mjs';
import { sha256, json, semanticsFor } from './common.mjs';

const raw = JSON.parse(readFileSync(new URL('../scripts/lib/icon-native-fixture.json', import.meta.url), 'utf8'));
const sites = Object.entries(raw.siteCells).map(([slug, i]) => ({ slug, name: slug, latitude: raw.cells[i].latitude, longitude: raw.cells[i].longitude, timeZone: 'Asia/Yerevan' }));
const region = { id: 'armenia', primarySite: 'hatis', timeZone: 'Asia/Yerevan', bbox: [43.4, 38.8, 46.7, 41.3] };
const context = { generatedAt: '2026-10-24T12:00:00Z', sites: { hatis: { elevation: { source: 'glo90', elevationM: 2150 } } } };

test('all native ICON cells match their point diagnostics and published atmospheric levels', () => {
  const acquired = normalizeIconExtract(raw);
  const result = iconRegionalDocuments(acquired, region, sites, context);
  assert.equal(result.manifest.cellCount, 3);
  assert.equal(result.files['audit.json'].sampledCell.distanceKm, 0);
  assert.equal(result.manifest.semantics.gust, 'hourMax');
  assert.deepEqual(result.manifest.semantics, semanticsFor({ model: 'icon-eu' }));
  assert.equal(result.manifest.case.referenceTime, raw.referenceTime);
  assert.deepEqual(result.manifest.case.forecastHours, [7]);
  for (const [i, site] of sites.entries()) {
    const doc = deriveIconProfile(acquired, i, site, { launchElevationM: i === 0 ? 2150 : null });
    assert.ok(assertAgreement(doc, result.hourly, i).exact);
    assert.equal(result.files['grid.geojson'].features[i].properties.modelElevationM, doc.site.modelElevationM);
    for (let hi = 0; hi < doc.hours.length; hi++) {
      const hour = doc.hours[hi], field = result.hourly[hi];
      assert.equal(hour.soaring.diagnosticSupport.surfacePressure.source, 'model');
      assert.equal(hour.soaring.diagnosticSupport.surfacePressure.valueHpa, raw.records['PS:7:None'].values[i] / 100);
      const native = Object.values(field.levelsByModel).map(values => ({
        pressureHpa: values.p[i], heightM: values.h[i], temperatureC: values.t[i], dewPointC: values.td[i],
        windSpeedMps: values.ws[i], windDirectionDeg: values.wd[i],
      })).filter(level => level.heightM != null).sort((a, b) => a.heightM - b.heightM);
      assert.deepEqual(native, hour.levels);
      assert.equal(native.length, 29);
      assert.equal(field.levelCount[i], native.length);
      assert.equal(field.levelsByModel['74'].h[i], null, 'lowest native level within 20 m is masked');
      assert.ok(native.every((level, j) => !j || level.pressureHpa < native[j - 1].pressureHpa));
    }
  }
  for (const feature of result.files['grid.geojson'].features) {
    const ring = feature.geometry.coordinates[0];
    assert.equal(ring.length, 4);
    assert.deepEqual(ring[0], ring.at(-1));
    assert.ok(ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)));
  }
});

test('audit measures the primary launch offset from its sampled native cell', () => {
  const shiftedSites = sites.map(site => site.slug === region.primarySite ? { ...site, latitude: site.latitude + 0.01 } : site);
  const result = iconRegionalDocuments(normalizeIconExtract(raw), region, shiftedSites, context);
  const distance = result.files['audit.json'].sampledCell.distanceKm;
  assert.ok(distance > 1.11 && distance < 1.12);
});

test('ceiling flags distinguish an unresolved dry thermal top from a capped column', () => {
  const acquired = normalizeIconExtract(raw);
  // Synthetic stress cases built on real level heights and pressures.
  acquired.hours[0].sources[0].temperatureC = 60;
  acquired.hours[0].sources[1].temperatureC = -40;
  const result = iconRegionalDocuments(acquired, region, sites, context);
  assert.equal(result.hourly[0].ceilingReached[0], true);
  assert.equal(result.hourly[0].ceilingReached[1], false);
});

test('regional bundles fail on missing source columns or missing launch terrain', () => {
  const acquired = normalizeIconExtract(raw);
  assert.throws(() => iconRegionalDocuments(acquired, region, sites, { sites: {} }), /Missing measured primary launch elevation/);
  acquired.hours[0].sources[1] = null;
  assert.throws(() => iconRegionalDocuments(acquired, region, sites, context), /incomplete native profile/);
});

test('native bundle retains checksummed files and a reproducible manifest', t => {
  const root = mkdtempSync(join(tmpdir(), 'icon-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = writeIconRegionalBundle(normalizeIconExtract(raw), region, sites, context, root);
  assert.equal(result.dir.endsWith(sha256(json(result.manifest))), true);
  for (const [name, digest] of Object.entries(result.manifest.files)) {
    const bytes = readFileSync(join(result.dir, name));
    assert.equal(sha256(bytes), digest, name);
    assert.equal(result.manifest.fileBytes[name], bytes.byteLength, name);
  }
  assert.equal(result.manifest.cellProfiles, 'cell-{index}.json.gz');
  const metrics = JSON.parse(gunzipSync(readFileSync(join(result.dir, result.manifest.hours[0].file))).toString('utf8'));
  assert.ok(result.manifest.hours[0].file.endsWith('.json.gz'));
  assert.equal(metrics.levelsByModel, undefined, 'initial map payload must omit the heavy atmospheric columns');
  const acquired = normalizeIconExtract(raw);
  for (let index = 0; index < acquired.cells.length; index++) {
    const profile = JSON.parse(gunzipSync(readFileSync(join(result.dir, `cell-${index}.json.gz`))).toString('utf8'));
    const expected = deriveIconProfile(acquired, index, sites[index], { launchElevationM: index === 0 ? 2150 : null });
    assert.deepEqual(profile.hours, expected.hours, 'lazy per-cell profiles retain the complete published column and diagnostics');
    assert.ok(assertAgreement(profile, [metrics], index).exact);
  }
});
