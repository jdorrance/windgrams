import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCountryCatalog, mergeCatalogs } from './import-flyingsites.mjs';

const mexico = JSON.parse(readFileSync(new URL('data/mexico-launches.json', import.meta.url)));
const bytes = readFileSync(new URL('data/mexico-pge-source.json', import.meta.url));
const candidates = JSON.parse(bytes).features;

test('MX review accounts for every archived candidate, including aliases and withheld locations', () => {
  assert.equal(bytes.length, mexico.sourceSnapshot.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), mexico.sourceSnapshot.sha256);
  assert.equal(candidates.length, 84);
  assert.equal(mexico.launches.length, 75);
  assert.equal(mexico.excluded.length, 9);
  const ids = [...mexico.launches, ...mexico.excluded].map(record => record.sourceId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.sort(), candidates.map(record => record.id).sort());
  for (const record of mexico.excluded) {
    assert.ok(record.reason && record.sourceUrl.startsWith('https://') && record.checkedAt);
  }
  const alias = mexico.excluded.find(record => record.sourceId === '15193');
  assert.equal(alias.retainedSlug, 'mx-cantil-de-las-aguilas');
  assert.equal(mexico.launches.find(record => record.slug === alias.retainedSlug).sourceId, '11634');
  for (const id of ['6797', '14249', '22993', '10722', '21435', '21436', '21437', '18116']) {
    assert.ok(mexico.excluded.some(record => record.sourceId === id), id);
  }
});

test('MX reviewed positions, state labels and explicit local time zones reach the two public catalogues', () => {
  const imported = buildCountryCatalog(mexico);
  const publishedSites = JSON.parse(readFileSync(new URL('../sites.json', import.meta.url))).sites;
  const publishedLaunches = JSON.parse(readFileSync(new URL('../../web/src/data/launches.json', import.meta.url))).launches;
  assert.equal(new Set(imported.sitesFile.sites.map(site => `${site.latitude},${site.longitude}`)).size, 75);
  assert.equal(new Set(mexico.launches.map(site => site.region)).size, 26);
  assert.equal(Object.hasOwn(mexico, 'timeZone'), false, 'MX has no country-wide time zone fallback');
  for (const record of mexico.launches) {
    const original = candidates.find(candidate => candidate.id === record.sourceId);
    assert.deepEqual([record.longitude, record.latitude], original.geometry.coordinates);
    assert.ok(record.latitude > 14 && record.latitude < 33 && record.longitude > -118 && record.longitude < -86);
    assert.ok(Object.hasOwn(record, 'timeZone'));
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: record.timeZone }));
    const site = imported.sitesFile.sites.find(site => site.slug === record.slug);
    assert.equal('elevationM' in site, false);
    assert.equal('sourceElevationM' in site, false);
    assert.equal(record.elevationDatum, 'unknown');
    const details = imported.launchesFile.launches[site.slug];
    assert.equal(details.countryCode, 'MX');
    assert.deepEqual([details.windMinMph, details.windMaxMph, details.gustMaxMph], [null, null, null]);
    assert.equal(details.source.license, 'CC-BY-SA-3.0');
    assert.ok(publishedSites.some(site => site.slug === record.slug), record.slug);
    assert.equal(publishedLaunches[record.slug].countryCode, 'MX');
  }
  const record = id => mexico.launches.find(record => record.sourceId === id);
  assert.equal(record('9867').slug, 'mx-valle-de-bravo-el-penon');
  assert.equal(record('9867').name, 'Valle de Bravo — El Peñón');
  assert.equal(record('9867').timeZone, 'America/Mexico_City');
  assert.equal(record('6948').timeZone, 'America/Tijuana');
  assert.equal(record('10904').timeZone, 'America/Merida');
  assert.equal(record('18117').timeZone, 'America/Cancun');
  assert.equal(record('11634').region, 'Jalisco', 'classified using the reviewed boundary at the source point');
  assert.equal(record('23042').region, 'Nuevo León', 'classified using the source point rather than the namesake town');
  for (const pair of [['6754', '10133'], ['22043', '23846'], ['23577', '23578']]) {
    assert.notEqual(record(pair[0]).slug, record(pair[1]).slug, 'nearby distinct takeoffs stay separate');
  }
});

test('MX direction arcs never merge separated faces or clip active source directions', () => {
  for (const record of mexico.launches) {
    assert.equal(record.facingDeg === null, record.windArcHalfWidthDeg === null);
    if (record.facingDeg === null) continue;
    const p = candidates.find(candidate => candidate.id === record.sourceId).properties;
    const flags = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map(key => Number(p[key]) > 0);
    assert.ok(flags.filter(Boolean).length <= 5);
    assert.equal(flags.filter((active, index) => active && !flags[(index + 7) % 8]).length, 1, record.slug);
    assert.ok(record.windArcHalfWidthDeg <= 90);
    for (const [index, active] of flags.entries()) {
      if (active) assert.ok(Math.abs((index * 45 - record.facingDeg + 540) % 360 - 180) <= record.windArcHalfWidthDeg, record.slug);
    }
  }
  for (const id of ['6815', '9851', '9857', '9867', '11225', '11634', '17074']) {
    assert.equal(mexico.launches.find(record => record.sourceId === id).facingDeg, null, id);
  }
});

test('MX imports retain manual edits and other countries across repeated merges', () => {
  const incoming = buildCountryCatalog(mexico);
  const existing = {
    sitesFile: JSON.parse(readFileSync(new URL('../sites.json', import.meta.url))),
    launchesFile: JSON.parse(readFileSync(new URL('../../web/src/data/launches.json', import.meta.url))),
  };
  const site = existing.sitesFile.sites.find(site => site.slug === 'mx-la-salina');
  site.latitude += 0.001;
  existing.launchesFile.launches[site.slug].notes = 'Locally verified manual correction.';
  existing.launchesFile.launches[site.slug].windMaxMph = 12;
  assert.deepEqual(mergeCatalogs(existing, incoming), existing);
  assert.deepEqual(mergeCatalogs(mergeCatalogs(existing, incoming), incoming), existing);
});

test('CLI supports MX alone, environment overrides and the default all-country import offline', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'windgrams-mx-import-')));
  const write = (path, document) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(document)); };
  try {
    const script = join(root, 'forecasts/scripts/import-flyingsites.mjs');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(fileURLToPath(new URL('import-flyingsites.mjs', import.meta.url)), script);
    const sites = join(root, 'forecasts/sites.json'), launches = join(root, 'web/src/data/launches.json');
    write(sites, { schemaVersion: 2, sites: [] });
    write(launches, { schemaVersion: 1, launches: {} });
    write(join(root, 'forecasts/scripts/data/us-states.json'), { states: {} });
    const env = { ...process.env };
    for (const country of ['US', 'AM', 'NZ', 'MX']) {
      const path = join(root, `${country}.json`);
      env[`FLYINGSITES_${country}`] = path;
      write(path, country === 'US' ? { features: [] } : country === 'MX'
        ? { ...mexico, launches: [mexico.launches.find(record => record.sourceId === '9867')] }
        : { countryCode: country, launches: [] });
    }
    const run = args => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    const mx = run(['--country=mx']);
    assert.equal(mx.status, 0, mx.stderr);
    const first = readFileSync(sites, 'utf8');
    assert.equal(JSON.parse(first).sites[0].slug, 'mx-valle-de-bravo-el-penon');
    assert.equal(JSON.parse(first).sites.length, 1, 'the environment override is used');
    const all = run([]);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /merged us, am, nz, mx/);
    assert.equal(readFileSync(sites, 'utf8'), first);
    assert.notEqual(run(['--country=invalid']).status, 0);
    assert.equal(readFileSync(sites, 'utf8'), first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
