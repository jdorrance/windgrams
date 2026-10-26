import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { catalogueFingerprint } from '@windgrams/pipeline';
import { validateRrfsDataset, validateRrfsProfile } from './validate-rrfs.mjs';
import { postprocessPointForecast } from '../soaring/point-postprocess.mjs';

const issued = JSON.parse(readFileSync(new URL('../soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)));
const profile = postprocessPointForecast(issued, { launchElevationM: issued.soaringMeta.launchElevationM });
const validate = document => validateRrfsProfile(document, profile.run.referenceTime, profile.site.id);

test('the captured NOAA RRFS run has a complete hourly 84-hour column and bounded v2 diagnostics', () => {
  assert.deepEqual(validate(profile), {
    site: 'wa-blanchard', hours: 84,
    firstValidAt: '2026-10-23T07:00:00Z', lastValidAt: '2026-10-26T18:00:00Z',
  });
  assert.equal(profile.hours[60].validAt, '2026-10-25T19:00:00Z');
  assert.equal(profile.hours[61].validAt, '2026-10-25T20:00:00Z');
});

test('truncated runs, wrong valid times, and run-total precipitation cannot be promoted', () => {
  for (const mutate of [
    d => d.hours.pop(),
    d => { d.hours[61].validAt = d.hours[60].validAt; },
    d => { d.semantics.precipitation = 'instantRate'; },
    d => { d.hours[60].surface.precipitationMmHr = -1; },
  ]) {
    const broken = structuredClone(profile); mutate(broken);
    assert.throws(() => validate(broken));
  }
});

test('missing upper-air data, absent postprocessing, and lift above the resolved top fail validation', () => {
  for (const mutate of [
    d => { d.hours[0].levels = d.hours[0].levels.slice(0, 2); },
    d => { d.hours[0].levels[1].pressureHpa = d.hours[0].levels[0].pressureHpa; },
    d => { d.hours[0].levels[0].windSpeedMps = null; },
    d => { delete d.hours[0].soaring; },
    d => { d.hours[0].soaring.contractVersion = '2.1.0'; },
    d => { d.hours[0].soaring.usableLiftTopV2M = 1200; d.hours[0].soaring.resolvedThermalTopM = 1000; },
  ]) {
    const broken = structuredClone(profile); mutate(broken);
    assert.throws(() => validate(broken));
  }
});

function dataset(t, { exclusions = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'validate-rrfs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalogue = JSON.parse(readFileSync(new URL('../sites.json', import.meta.url))).sites;
  const included = catalogue.find(site => site.slug === profile.site.id);
  const excluded = catalogue.find(site => site.slug === 'mx-el-wejo');
  const outside = catalogue.find(site => site.slug.startsWith('am-'));
  const covered = exclusions ? [included, excluded] : [included];
  const sitesPath = join(root, 'sites.json');
  writeFileSync(sitesPath, JSON.stringify({ sites: [...covered, outside] }));
  const profilePath = join(root, 'rrfs', 'sites', `${included.slug}.json`);
  mkdirSync(join(root, 'rrfs', 'sites'), { recursive: true });
  writeFileSync(profilePath, JSON.stringify(profile));
  const manifest = { schemaVersion: 1, model: 'rrfs', referenceTime: profile.run.referenceTime, generatedAt: profile.run.generatedAt,
    firstForecastHour: 1, lastForecastHour: 84, forecastHours: 84, sites: [{ slug: included.slug, name: included.name }],
    stats: { downloads: 0, downloadBytes: 0, retries: 0, durationMs: 0 } };
  if (exclusions) manifest.coverage = { requestedSiteHash: catalogueFingerprint(covered), excluded: [excluded.slug], reason: 'outside-native-grid' };
  const validate = () => {
    writeFileSync(join(root, 'rrfs', 'manifest.json'), JSON.stringify(manifest));
    return validateRrfsDataset(root, sitesPath);
  };
  return { manifest, included, excluded, outside, profilePath, validate };
}

test('RRFS dataset accepts catalogue-bound native-grid exclusions and validates every remaining profile', t => {
  const data = dataset(t);
  const report = data.validate();
  assert.equal(report.sites, 1);
  assert.equal(report.validatedSiteHours, 84);
  const broken = structuredClone(profile);
  broken.hours[83].surface.windSpeedMps = null;
  writeFileSync(data.profilePath, JSON.stringify(broken));
  assert.throws(data.validate, /surface wind|windSpeedMps|forecast contract/);
  rmSync(data.profilePath);
  assert.throws(data.validate, /ENOENT/);
});

test('RRFS dataset rejects malformed, stale and unrelated grid exclusions', t => {
  const data = dataset(t), valid = data.manifest.coverage;
  for (const coverage of [null, {}, { ...valid, requestedSiteHash: 'old' },
    { ...valid, reason: 'download-failed' }, { ...valid, excluded: null }, { ...valid, excluded: 'invalid' },
    { ...valid, excluded: [data.excluded.slug, data.excluded.slug] },
    { ...valid, excluded: ['unknown-launch'] }, { ...valid, excluded: [data.outside.slug] },
    { ...valid, excluded: [null] }]) {
    data.manifest.coverage = coverage;
    assert.throws(data.validate, /coverage exclusions/, JSON.stringify(coverage));
  }
  data.manifest.coverage = { ...valid, excluded: [data.included.slug, data.excluded.slug] };
  assert.throws(data.validate, /no covered launches/);
});

test('RRFS exclusions never excuse undeclared missing, unexpected or duplicate launches', t => {
  const data = dataset(t), included = data.manifest.sites[0];
  for (const sites of [[], [included, included], [included, { slug: data.excluded.slug, name: data.excluded.name }],
    [{ slug: data.outside.slug, name: data.outside.name }]]) {
    data.manifest.sites = sites;
    assert.throws(data.validate, /manifest|launch catalogue/);
  }
  data.manifest.sites = [included];
  delete data.manifest.coverage;
  assert.throws(data.validate, /complete launch catalogue/);
});

test('RRFS datasets without exclusion metadata still accept complete covered catalogues', t => {
  const data = dataset(t, { exclusions: false });
  assert.equal(data.validate().sites, 1);
});
