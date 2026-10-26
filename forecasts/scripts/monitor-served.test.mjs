import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { modelDescriptor } from '@windgrams/providers/registry';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { postprocessPointForecast } from '@windgrams/soaring/compatibility';
import { catalogueFingerprint } from '@windgrams/pipeline';
import { monitorServed } from './monitor-served.mjs';

const fixture = postprocessPointForecast(JSON.parse(gunzipSync(readFileSync(new URL('../../web/test/fixtures/windgram-visual/dog-gfs.json.gz', import.meta.url)))));
const encode = value => JSON.stringify(value);
const hash = text => createHash('sha256').update(text).digest('hex');
function dataset({ modelId = 'gfs', method = SOARING_CONTRACT_VERSION, unavailableDiagnostics = false } = {}) {
  const profile = structuredClone(fixture);
  profile.model = modelId;
  profile.soaringMeta.contractVersion = method;
  for (const hour of profile.hours) if (hour.soaring) hour.soaring.contractVersion = method;
  if (unavailableDiagnostics) {
    profile.hours[0].levels = profile.hours[0].levels.slice(0, 2);
    profile.hours[0].soaring = null;
  }
  const reference = Date.parse(profile.run.referenceTime);
  const now = new Date(reference + 7 * 3_600_000).toISOString();
  const model = { ...modelDescriptor(modelId), forecastHours: profile.hours.map(hour => (Date.parse(hour.validAt) - reference) / 3_600_000) };
  const sites = [{ slug: profile.site.id, name: profile.site.name, latitude: profile.site.latitude, longitude: profile.site.longitude, timeZone: profile.site.timeZone, countryCode: 'US' }];
  const pointManifest = { schemaVersion: 1, model: modelId, ...profile.run, forecastHours: profile.hours.length, firstForecastHour: model.forecastHours[0], lastForecastHour: model.forecastHours.at(-1), sites: [{ slug: profile.site.id, name: profile.site.name }], stats: { downloadBytes: 0, downloads: 0, durationMs: 0, retries: 0 } };
  const documents = new Map([
    [`${modelId}/manifest.json`, encode(pointManifest)],
    [`${modelId}/sites/${profile.site.id}.json`, encode(profile)],
    [`health/${model.jobGroup}.json`, encode({ schemaVersion: 1, group: model.jobGroup, models: { [modelId]: { attemptedAt: now, completedAt: now, lastSuccessfulRefreshAt: now, outcome: 'updated', reason: null } } })],
  ]);
  for (const product of ['nws', 'ecmwf', 'raob']) {
    documents.set(`${product}/manifest.json`, encode({ schemaVersion: 1, generatedAt: now,
      sites: [{ slug: profile.site.id, ok: true, ...(product === 'raob' ? { absent: false } : {}) }], ...(product === 'nws' ? { offices: [] } : {}) }));
    documents.set(`${product}/sites/${profile.site.id}.json`, encode({ schemaVersion: 1, generatedAt: now,
      site: { slug: profile.site.id }, ...(product === 'raob' ? { soundings: [{ validAt: now,
        levels: Array.from({ length: 10 }, (_, index) => ({ pressureHpa: 900 - index * 50, heightM: 100 + index * 500, temperatureC: 15 - index * 3 })) }] }
        : { hours: profile.hours.map(hour => ({ validAt: hour.validAt, temperatureC: 15, windSpeedMps: 3 })) }) }));
  }
  const caseId = 'test-gfs-live';
  const hours = profile.hours.map((hour, i) => ({ forecastHour: model.forecastHours[i], validAt: hour.validAt, file: `hours/${i}.json` }));
  const bundleFiles = new Map([['profile.json', encode(profile)]]);
  for (const hour of hours) bundleFiles.set(hour.file, encode({ forecastHour: hour.forecastHour, validAt: hour.validAt, soaringContractVersion: method, thermalVelocityMps: [null], usableLiftTopM: [null], boundaryLayerTopM: [null], cloudBaseM: [null], pblHeightM: [null], status: ['valid'], levelCount: [0], ceilingReached: [false] }));
  const manifest = { schemaVersion: 1, model: 'gfs', soaringContractVersion: method, capturedAt: profile.run.generatedAt, cellCount: 1, siteCell: 0, case: { id: caseId, model: 'gfs', referenceTime: profile.run.referenceTime, bbox: [-123, 46, -121, 48], sinkMps: 1, site: { name: 'Test', latitude: 47, longitude: -122, timeZone: 'America/Los_Angeles' }, launchElevation: { elevationM: 100 } }, versions: { algorithm: 'test' }, hours, files: Object.fromEntries([...bundleFiles].map(([path, text]) => [path, hash(text)])) };
  const manifestBytes = encode(manifest), manifestSha256 = hash(manifestBytes);
  const path = `soaring/v1/${caseId}`, bundle = `bundles/${manifestSha256}`;
  documents.set(`${path}/index.json`, encode({ schemaVersion: 1, bundle, manifestSha256 }));
  documents.set(`${path}/${bundle}/manifest.json`, manifestBytes);
  for (const [file, text] of bundleFiles) documents.set(`${path}/${bundle}/${file}`, text);
  documents.set('soaring/v1/regions.json', encode({ schemaVersion: 1, soaringContractVersion: method, generatedAt: now, trialRegionId: 'test', regions: [{ id: 'test', name: 'Test', status: 'active-verified-trial', caseId, nativeModels: [{ model: 'gfs', caseId }], timeZone: 'America/Los_Angeles', morningBriefingLocalHour: 8, bbox: [-123, 46, -121, 48], primarySite: profile.site.id, launches: [profile.site.id], deterministicModels: ['gfs'], ensembleModels: [], sparseAdapters: [] }] }));
  const requests = [];
  const fetchImpl = async url => { const key = String(url).replace('https://forecast.example/data/', ''); requests.push(key); return documents.has(key) ? new Response(documents.get(key), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }); };
  return { documents, model, now, profile, requests, bundlePath: `${path}/${bundle}`, options: { from: 'https://forecast.example/data', models: [model], sites, now, fetchImpl } };
}

function addSite(data, site) {
  const location = { ...data.options.sites[0], ...site };
  data.options.sites.push(location);
  const path = `${data.model.id}/manifest.json`, manifest = JSON.parse(data.documents.get(path));
  manifest.sites.push({ slug: location.slug, name: location.name });
  data.documents.set(path, encode(manifest));
  const profile = structuredClone(data.profile);
  Object.assign(profile.site, { id: location.slug, name: location.name, latitude: location.latitude, longitude: location.longitude, timeZone: location.timeZone });
  data.documents.set(`${data.model.id}/sites/${location.slug}.json`, encode(profile));
  return location;
}

test('a fresh pre-expansion global inventory fails before probing profiles', async () => {
  const data = dataset();
  const catalogue = JSON.parse(readFileSync(new URL('../sites.json', import.meta.url))).sites;
  const launches = JSON.parse(readFileSync(new URL('../../web/src/data/launches.json', import.meta.url))).launches;
  data.options.sites = catalogue.map(site => ({ ...site, countryCode: launches[site.slug].countryCode }));
  const manifest = JSON.parse(data.documents.get('gfs/manifest.json'));
  manifest.sites = data.options.sites.filter(site => site.countryCode === 'US').map(({ slug, name }) => ({ slug, name }));
  data.documents.set('gfs/manifest.json', encode(manifest));
  const report = await monitorServed(data.options);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.kind === 'point').reason, new RegExp(`${catalogue.length - manifest.sites.length} missing, 0 unexpected`));
  assert.equal(data.requests.some(path => path.startsWith('gfs/sites/')), false);
});

test('regional inventories probe covered Mexican launches and honor native-grid exclusions', async () => {
  const data = dataset({ modelId: 'hrrr-conus' });
  const included = addSite(data, { slug: 'mx-north', latitude: 32, longitude: -116, timeZone: 'America/Tijuana', countryCode: 'MX' });
  const excluded = { ...included, slug: 'mx-grid-edge', latitude: 25, longitude: -100, timeZone: 'America/Monterrey' };
  const outside = { ...excluded, slug: 'mx-south', latitude: 19, timeZone: 'America/Mexico_City' };
  data.options.sites.push(excluded, outside);
  const path = 'hrrr-conus/manifest.json', manifest = JSON.parse(data.documents.get(path));
  const coverage = { requestedSiteHash: catalogueFingerprint(data.options.sites.filter(site => site !== outside)), excluded: [excluded.slug], reason: 'outside-native-grid' };
  for (const invalid of [null, { requestedSiteHash: 'old' }, { excluded: [outside.slug] }, { excluded: [excluded.slug, excluded.slug] }, { excluded: 'invalid' }, { reason: 'fetch-failed' }]) {
    data.requests.length = 0;
    manifest.coverage = { ...coverage, ...invalid };
    data.documents.set(path, encode(manifest));
    const report = await monitorServed(data.options), point = report.checks.find(check => check.kind === 'point');
    assert.equal(point.ok, invalid === null, JSON.stringify(point));
    if (invalid) assert.match(point.reason, /coverage exclusions/);
    else assert.deepEqual(data.requests.filter(path => path.startsWith('hrrr-conus/sites/')), [data.profile.site.id, included.slug].map(slug => `hrrr-conus/sites/${slug}.json`));
  }
});

test('point probes cover each country once and continue after a country fails', async () => {
  for (const failed of [null, 'US', 'NZ', 'AM', 'MX']) {
    const data = dataset();
    const nz = addSite(data, { slug: 'nz-first', latitude: -37, longitude: 175, timeZone: 'Pacific/Auckland', countryCode: 'NZ' });
    addSite(data, { ...nz, slug: 'nz-second' });
    const am = addSite(data, { slug: 'am-first', latitude: 40, longitude: 44, timeZone: 'Asia/Yerevan', countryCode: 'AM' });
    const mx = addSite(data, { slug: 'mx-first', latitude: 19, longitude: -100, timeZone: 'America/Mexico_City', countryCode: 'MX' });
    addSite(data, { ...mx, slug: 'mx-second' });
    const failedSlug = data.options.sites.find(site => site.countryCode === failed)?.slug;
    if (failed === 'NZ') data.documents.set(`gfs/sites/${failedSlug}.json`, '{');
    else if (failed) data.documents.delete(`gfs/sites/${failedSlug}.json`);
    const report = await monitorServed(data.options);
    const point = report.checks.find(check => check.kind === 'point');
    assert.equal(point.ok, !failed);
    if (failed) assert.match(point.reason, new RegExp(`^${failedSlug}:`));
    assert.deepEqual(data.requests.filter(path => path.startsWith('gfs/sites/')), [data.profile.site.id, nz.slug, am.slug, mx.slug].map(slug => `gfs/sites/${slug}.json`));
  }
});

test('point monitoring rejects trials, invalid inventories and moved launch metadata', async () => {
  for (const issue of ['trial', 'duplicate', 'unexpected', 'location', 'country']) {
    const data = dataset(), path = 'gfs/manifest.json', manifest = JSON.parse(data.documents.get(path));
    if (issue === 'trial') manifest.trial = true;
    if (issue === 'duplicate') manifest.sites.push(manifest.sites[0]);
    if (issue === 'unexpected') manifest.sites.push({ slug: 'unexpected', name: 'Unexpected' });
    if (issue === 'location') data.options.sites[0].longitude += 0.01;
    if (issue === 'country') delete data.options.sites[0].countryCode;
    data.documents.set(path, encode(manifest));
    const report = await monitorServed(data.options), point = report.checks.find(check => check.kind === 'point');
    assert.equal(point.ok, false);
    assert.equal(point.status, issue === 'location' ? 'inconsistent' : 'unavailable');
  }
});

test('served monitor verifies representative point, refresh health and immutable regional boundary hours', async () => {
  const data = dataset();
  const report = await monitorServed(data.options);
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(report.checks.filter(check => !check.kind.startsWith('observation')).map(check => [check.kind, check.status]), [['point', 'current'], ['refresh', 'updated'], ['regional', 'current']]);
  assert.equal(report.checks.filter(check => check.kind.startsWith('observation')).length, 6);
});
test('missing representative profile and mismatched point run fail publication checks', async () => {
  for (const missing of [true, false]) {
    const data = dataset(), path = `gfs/sites/${data.profile.site.id}.json`;
    if (missing) data.documents.delete(path);
    else data.documents.set(path, encode({ ...data.profile, run: { ...data.profile.run, referenceTime: '2026-10-24T00:00:00Z' } }));
    const report = await monitorServed(data.options);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].status, missing ? 'unavailable' : 'inconsistent');
  }
});
test('expired horizons and stale-but-valid products use the same reader cadence assessment', async () => {
  const data = dataset();
  const expired = await monitorServed({ ...data.options, now: '2026-10-25T07:00:00Z' });
  assert.equal(expired.checks.find(check => check.kind === 'point').status, 'expired');
  const stale = await monitorServed({ ...data.options, models: [{ ...data.model, catalogue: { ...data.model.catalogue, runIntervalHours: 1, typicalPublicationLagHours: 0 } }] });
  assert.equal(stale.checks.find(check => check.kind === 'point').status, 'stale');
});
test('retained refresh failure is unhealthy even when the served forecast remains current', async () => {
  const data = dataset(), health = JSON.parse(data.documents.get('health/noaa-cloud.json'));
  Object.assign(health.models.gfs, { outcome: 'retained', reason: 'source unavailable' });
  data.documents.set('health/noaa-cloud.json', encode(health));
  const report = await monitorServed(data.options);
  assert.equal(report.checks.find(check => check.kind === 'point').ok, true);
  assert.deepEqual(report.checks.find(check => check.kind === 'refresh'), { product: 'gfs', kind: 'refresh', status: 'retained', ok: false, reason: 'source unavailable' });
  assert.equal(report.ok, false);
});
test('corrupt regional content and missing health are caught at the served origin', async () => {
  const data = dataset();
  data.documents.set(`${data.bundlePath}/hours/0.json`, '{}');
  data.documents.delete('health/noaa-cloud.json');
  const report = await monitorServed(data.options);
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.kind === 'regional').reason, /content hash differs/);
  assert.equal(report.checks.find(check => check.kind === 'refresh').ok, false);
});
test('model cadence bounds unfinished and abandoned refresh attempts', async () => {
  const data = dataset(), health = JSON.parse(data.documents.get('health/noaa-cloud.json'));
  Object.assign(health.models.gfs, { outcome: 'running', completedAt: null });
  data.documents.set('health/noaa-cloud.json', encode(health));
  assert.equal((await monitorServed(data.options)).checks.find(check => check.kind === 'refresh').ok, true);
  const late = await monitorServed({ ...data.options, now: new Date(Date.parse(data.now) + 7 * 3_600_000).toISOString() });
  assert.equal(late.checks.find(check => check.kind === 'refresh').ok, false);
});

test('supplemental failed attempts are unhealthy even while retained forecast hours remain valid', async () => {
  for (const product of ['nws', 'ecmwf', 'raob']) {
    const data = dataset(), path = `${product}/manifest.json`, manifest = JSON.parse(data.documents.get(path));
    manifest.sites[0] = { slug: data.profile.site.id, ok: false, error: 'HTTP 403', retained: true };
    data.documents.set(path, encode(manifest));
    const report = await monitorServed(data.options);
    assert.equal(report.ok, false);
    assert.deepEqual(report.checks.find(check => check.product === product && check.kind === 'observation-refresh'), {
      product, kind: 'observation-refresh', status: 'failed', ok: false, reason: `${data.profile.site.id}: HTTP 403`,
    });
    assert.equal(report.checks.find(check => check.product === product && check.kind === 'observation').status, 'current');
  }
});

test('supplemental probes reject missing documents, invalid identities and expired actual horizons', async () => {
  for (const product of ['nws', 'ecmwf']) for (const issue of ['manifest', 'payload', 'identity', 'expired']) {
    const data = dataset(), path = `${product}/sites/${data.profile.site.id}.json`;
    if (issue === 'manifest') data.documents.delete(`${product}/manifest.json`);
    else if (issue === 'payload') data.documents.delete(path);
    else {
      const document = JSON.parse(data.documents.get(path));
      if (issue === 'identity') document.site.slug = 'wrong-site';
      else document.hours = [{ validAt: new Date(Date.parse(data.now) - 1).toISOString(), temperatureC: 15 }];
      data.documents.set(path, encode(document));
    }
    const report = await monitorServed(data.options);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(check => check.product === product && check.kind === 'observation').status, issue === 'expired' ? 'expired' : 'unavailable');
  }
});

test('balloon monitoring accepts confirmed absence but rejects old queries and observations outside the acquisition window', async () => {
  for (const absent of [false, true]) {
    const data = dataset(), manifestPath = 'raob/manifest.json', payloadPath = `raob/sites/${data.profile.site.id}.json`;
    const manifest = JSON.parse(data.documents.get(manifestPath));
    if (absent) {
      manifest.sites[0].absent = true;
      data.documents.set(manifestPath, encode(manifest));
      data.documents.delete(payloadPath);
    }
    let report = await monitorServed(data.options);
    assert.equal(report.ok, true);
    assert.equal(report.checks.find(check => check.product === 'raob' && check.kind === 'observation').status, absent ? 'absent' : 'current');
    const oldTime = new Date(Date.parse(data.now) - 48 * 3_600_000 - 1).toISOString();
    if (absent) {
      manifest.generatedAt = oldTime;
      data.documents.set(manifestPath, encode(manifest));
    } else {
      const document = JSON.parse(data.documents.get(payloadPath));
      document.soundings[0].validAt = oldTime;
      data.documents.set(payloadPath, encode(document));
    }
    report = await monitorServed(data.options);
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(check => check.product === 'raob' && check.kind === (absent ? 'observation-refresh' : 'observation')).status, 'stale');
  }
});


test('served monitoring reports compatible retained methods without hiding stale or inconsistent products', async () => {
  for (const method of [SOARING_CONTRACT_VERSION, '2.2.0']) {
    const datasetWithAbsence = dataset({ method, unavailableDiagnostics: true });
    addSite(datasetWithAbsence, { slug: 'nz-absence', latitude: -37, longitude: 175, timeZone: 'Pacific/Auckland', countryCode: 'NZ' });
    const unavailable = await monitorServed(datasetWithAbsence.options);
    assert.equal(unavailable.ok, true, JSON.stringify(unavailable.checks));
  }
  const data = dataset({ method: '2.2.0' });
  const healthy = await monitorServed(data.options);
  assert.equal(healthy.ok, true, JSON.stringify(healthy.checks));
  for (const check of healthy.checks.filter(check => ['point', 'regional'].includes(check.kind))) {
    assert.equal(check.methodVersion, '2.2.0'); assert.equal(check.retainedMethod, true);
  }
  const stale = await monitorServed({ ...data.options, now: '2026-10-25T07:00:00Z' });
  assert.equal(stale.checks.find(check => check.kind === 'point').status, 'expired');
  const path = `gfs/sites/${data.profile.site.id}.json`, changed = structuredClone(data.profile);
  changed.hours[0].soaring.contractVersion = SOARING_CONTRACT_VERSION;
  data.documents.set(path, encode(changed));
  const broken = await monitorServed(data.options);
  assert.equal(broken.checks.find(check => check.kind === 'point').status, 'unavailable');
  assert.match(broken.checks.find(check => check.kind === 'point').reason, /outdated soaring method/);
});
