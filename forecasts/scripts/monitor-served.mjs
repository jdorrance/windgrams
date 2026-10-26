// Bounded reads of the deployed origin: cadence, representative profiles, and live bundles.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseForecastManifestJson } from '@azohra/meteo.briefing/contract';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import { validateRegionCatalogue, validateReplayManifest, validateReplayHour, replayModel } from '@windgrams/contracts/regional';
import { assessForecastFreshness, fetchWithRetry } from '@windgrams/data-client';
import { MODELS, modelDescriptor, modelCoversSite } from '@windgrams/providers/registry';
import { catalogueFingerprint } from '@windgrams/pipeline';
import catalogue from '../sites.json' with { type: 'json' };
import launchDetails from '../../web/src/data/launches.json' with { type: 'json' };
import { parseProviderHealth } from './lib/provider-health.mjs';
import { parseObservationManifest } from './lib/observation-manifest.mjs';
import { LOOKBACK_HOURS, MIN_LEVELS } from './lib/raob.mjs';

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
// Country is a probe grouping, separate from the provider's catalogue fingerprint.
const currentSites = catalogue.sites.map(site => ({ ...site, countryCode: launchDetails.launches[site.slug]?.countryCode }));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (product, kind, error) => ({ product, kind, status: 'unavailable', ok: false, reason: error instanceof Error ? error.message : String(error) });
const assessment = (product, kind, input) => {
  const result = assessForecastFreshness(input);
  return { product, kind, status: result.status, ok: result.status === 'current', reason: result.reason };
};

function pointInventory(model, manifest, coverage, sites) {
  const covered = sites.filter(site => modelCoversSite(model, site));
  const excluded = coverage?.excluded ?? [];
  if (coverage !== undefined && (!coverage || !Array.isArray(coverage.excluded) || coverage.reason !== 'outside-native-grid'
    || coverage.requestedSiteHash !== catalogueFingerprint(covered) || new Set(excluded).size !== excluded.length
    || excluded.some(slug => !covered.some(site => site.slug === slug)))) throw new Error('Invalid or outdated coverage exclusions');
  const expected = covered.filter(site => !excluded.includes(site.slug));
  const actual = new Set(manifest.sites.map(site => site.slug));
  const missing = expected.filter(site => !actual.has(site.slug)).length;
  const unexpected = [...actual].filter(slug => !expected.some(site => site.slug === slug)).length;
  if (actual.size !== manifest.sites.length) throw new Error('Duplicate sites in point manifest');
  if (missing || unexpected) throw new Error(`Site inventory differs from current catalogue: ${missing} missing, ${unexpected} unexpected`);
  const representatives = new Map();
  for (const site of expected) {
    if (!/^[A-Z]{2}$/.test(site.countryCode ?? '')) throw new Error(`${site.slug}: missing catalogue country`);
    if (!representatives.has(site.countryCode)) representatives.set(site.countryCode, site);
  }
  return [...representatives.values()];
}

async function monitorPoint(read, now, model, manifest, site) {
  const profile = parsePublishedProfileJson((await read(`${model.id}/sites/${site.slug}.json`)).text);
  if (!profile || profile.model !== model.id || profile.site.id !== site.slug || !profile.hours.length) throw new Error('Missing or invalid representative profile');
  const first = Date.parse(profile.hours[0].validAt), last = Date.parse(profile.hours.at(-1).validAt), reference = Date.parse(manifest.referenceTime);
  const consistent = profile.run.referenceTime === manifest.referenceTime
    && profile.site.latitude === site.latitude && profile.site.longitude === site.longitude
    && (site.name === undefined || profile.site.name === site.name) && (site.timeZone === undefined || profile.site.timeZone === site.timeZone)
    && first === reference + manifest.firstForecastHour * 3_600_000 && last === reference + manifest.lastForecastHour * 3_600_000
    && profile.hours.length === manifest.forecastHours
    && profile.hours.every((hour, index) => Date.parse(hour.validAt) === reference + model.forecastHours[index] * 3_600_000)
    && profile.hours.length === model.forecastHours.length;
  const result = assessment(model.id, 'point', { now, referenceTime: profile.run.referenceTime, validUntil: profile.hours.at(-1).validAt, policy: model.catalogue, consistent });
  if (!result.ok) result.reason = `${site.slug}: ${result.reason}`;
  return result;
}

// Supplemental forecasts have no model-cadence policy: use their actual horizon.
// Balloon age uses the same archive search window as acquisition.
async function monitorObservations(read, now) {
  const checks = [], clock = Date.parse(now);
  for (const product of ['nws', 'ecmwf', 'raob']) {
    try {
      const manifest = parseObservationManifest((await read(`${product}/manifest.json`)).raw, product);
      if (!manifest || product !== 'raob' && !manifest.sites.length || Date.parse(manifest.generatedAt) > clock) throw new Error('Missing or invalid observation manifest');
      const failed = manifest.sites.filter(site => !site.ok);
      const oldQuery = product === 'raob' && clock - Date.parse(manifest.generatedAt) > LOOKBACK_HOURS * 3_600_000;
      checks.push({ product, kind: 'observation-refresh', status: failed.length ? 'failed' : oldQuery ? 'stale' : 'updated',
        ok: failed.length === 0 && !oldQuery,
        reason: failed.length ? failed.map(site => `${site.slug}: ${site.error}`).join('; ') : oldQuery ? 'Balloon query is older than the archive search window' : '' });
      const candidates = manifest.sites.filter(site => !site.absent);
      const site = candidates.find(site => site.ok) ?? candidates[0];
      if (!site) {
        checks.push({ product, kind: 'observation', status: 'absent', ok: true, reason: 'No usable flights were returned for covered launches' });
        continue;
      }
      const document = (await read(`${product}/sites/${site.slug}.json`)).raw;
      if (document?.schemaVersion !== 1 || document.site?.slug !== site.slug
        || !Number.isFinite(Date.parse(document.generatedAt)) || Date.parse(document.generatedAt) > clock) throw new Error('Invalid representative observation document');
      if (product === 'raob') {
        if (!Array.isArray(document.soundings) || !document.soundings.length || document.soundings.some(sounding =>
          !Number.isFinite(Date.parse(sounding.validAt)) || Date.parse(sounding.validAt) > clock
          || !Array.isArray(sounding.levels) || sounding.levels.length < MIN_LEVELS
          || sounding.levels.some(level => ![level.pressureHpa, level.heightM, level.temperatureC].every(Number.isFinite)))) throw new Error('Invalid representative balloon soundings');
        const latest = Math.max(...document.soundings.map(sounding => Date.parse(sounding.validAt)));
        const stale = clock - latest > LOOKBACK_HOURS * 3_600_000;
        checks.push({ product, kind: 'observation', status: stale ? 'stale' : 'current', ok: !stale,
          reason: stale ? 'Latest balloon observation is older than the archive search window' : '' });
      } else {
        if (!Array.isArray(document.hours) || !document.hours.length || document.hours.some((hour, index) =>
          !Number.isFinite(Date.parse(hour.validAt)) || index > 0 && Date.parse(hour.validAt) <= Date.parse(document.hours[index - 1].validAt))
          || !document.hours.some(hour => Number.isFinite(hour.temperatureC) || Number.isFinite(hour.windSpeedMps))) throw new Error('Invalid representative supplemental forecast hours');
        const expired = clock > Date.parse(document.hours.at(-1).validAt);
        checks.push({ product, kind: 'observation', status: expired ? 'expired' : 'current', ok: !expired,
          reason: expired ? 'Supplemental forecast ended' : '' });
      }
    } catch (error) { checks.push(failure(product, 'observation', error)); }
  }
  return checks;
}

/** Inject fetch/clock/catalogue for fixtures; production checks each configured model. */
export async function monitorServed({ from, now = new Date().toISOString(), models = MODELS, sites = currentSites, fetchImpl = fetch, timeoutMs = 10_000 }) {
  const base = new URL(from);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Use an HTTP dataset root without credentials, query or fragment');
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid monitor clock');
  const root = base.href.replace(/\/$/, '');
  const checks = [];
  const manifests = new Map();
  const read = async (path, expectedHash) => {
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-zA-Z0-9._/-]+$/.test(path)) throw new Error('Invalid served document path');
    const response = await fetchWithRetry(`${root}/${path}`, { cache: 'no-store', headers: { 'Accept-Encoding': 'identity' } }, { fetchImpl, timeoutMs });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_DOCUMENT_BYTES) { await response.body?.cancel(); throw new Error(`${path}: document exceeds monitor limit`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${path}: empty response`);
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DOCUMENT_BYTES) { await reader.cancel(); throw new Error(`${path}: document exceeds monitor limit`); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
    // Fetch transparently decodes Content-Encoding; validate identity when stored gzip bytes are unavailable.
    const decodedTransport = path.endsWith('.gz') && !compressed && response.headers.get('content-encoding') === 'gzip';
    if (expectedHash && !decodedTransport && sha256(bytes) !== expectedHash) throw new Error(`${path}: content hash differs from publication`);
    const text = (compressed ? gunzipSync(bytes, { maxOutputLength: MAX_DOCUMENT_BYTES }) : bytes).toString('utf8');
    return { raw: JSON.parse(text), text };
  };

  // Sequential per-model probes keep the monitor's network/memory cost bounded.
  for (const model of models) {
    try {
      const document = await read(`${model.id}/manifest.json`);
      const manifest = parseForecastManifestJson(document.text);
      if (!manifest || manifest.model !== model.id || !manifest.sites.length) throw new Error('Missing or invalid point manifest');
      if (document.raw.trial) throw new Error('Trial forecast served as production');
      let check;
      for (const site of pointInventory(model.id, manifest, document.raw.coverage, sites)) {
        let result;
        try { result = await monitorPoint(read, now, model, manifest, site); }
        catch (error) { result = failure(model.id, 'point', error); result.reason = `${site.slug}: ${result.reason}`; }
        if (!check || check.ok) check = result;
      }
      manifests.set(model.id, manifest);
      checks.push(check);
    } catch (error) { checks.push(failure(model.id, 'point', error)); }
  }

  for (const group of new Set(models.map(model => model.jobGroup))) {
    try {
      const health = parseProviderHealth((await read(`health/${group}.json`)).raw, group);
      if (!health) throw new Error('Invalid provider health');
      for (const model of models.filter(model => model.jobGroup === group)) {
        const entry = health.models[model.id];
        if (!entry) { checks.push(failure(model.id, 'refresh', 'Refresh health is missing')); continue; }
        const age = (Date.parse(now) - Date.parse(entry.attemptedAt)) / 3_600_000;
        const successAge = (Date.parse(now) - Date.parse(entry.lastSuccessfulRefreshAt ?? '')) / 3_600_000;
        const limit = 3 * model.catalogue.runIntervalHours + model.catalogue.typicalPublicationLagHours;
        const pending = entry.outcome === 'running' && age >= 0 && age <= model.catalogue.runIntervalHours;
        const healthy = age >= 0 && (entry.outcome === 'updated' && successAge <= limit || pending);
        checks.push({ product: model.id, kind: 'refresh', status: entry.outcome, ok: healthy, reason: healthy ? '' : entry.reason ?? (entry.outcome === 'running' ? 'Refresh attempt did not finish within its cadence' : 'No recent successful refresh') });
      }
    } catch (error) { checks.push(failure(group, 'refresh', error)); }
  }

  checks.push(...await monitorObservations(read, now));

  try {
    const catalogue = validateRegionCatalogue((await read('soaring/v1/regions.json')).raw);
    if (!catalogue) throw new Error('Invalid served regional catalogue');
    const seen = new Set();
    for (const region of catalogue.regions.filter(region => region.status === 'active-verified-trial')) {
      if (!region.nativeModels?.length) { checks.push(failure(region.id, 'regional', 'Active region has no published native models')); continue; }
      for (const native of region.nativeModels) {
        if (!models.some(model => model.id === native.model) || seen.has(native.caseId)) continue;
        seen.add(native.caseId);
        try {
          const model = modelDescriptor(native.model);
          const path = `soaring/v1/${native.caseId}`;
          const pointer = (await read(`${path}/index.json`)).raw;
          if (!/^bundles\/[a-f0-9]{64}$/.test(pointer?.bundle) || !/^[a-f0-9]{64}$/.test(pointer?.manifestSha256)
            || pointer.bundle !== `bundles/${pointer.manifestSha256}`) throw new Error('Invalid regional bundle pointer');
          const bundle = `${path}/${pointer.bundle}`;
          const manifest = validateReplayManifest((await read(`${bundle}/manifest.json`, pointer.manifestSha256)).raw);
          if (!manifest || manifest.case.id !== native.caseId || replayModel(manifest) !== native.model || !manifest.hours.length) throw new Error('Regional manifest identity differs from catalogue');
          const profile = parsePublishedProfileJson((await read(`${bundle}/profile.json`, manifest.files?.['profile.json'])).text);
          if (!profile || profile.model !== native.model || profile.run.referenceTime !== manifest.case.referenceTime
            || profile.hours.length !== manifest.hours.length || profile.hours.some((hour, index) => hour.validAt !== manifest.hours[index].validAt)) throw new Error('Regional profile differs from its manifest');
          for (const hour of new Set([manifest.hours[0], manifest.hours.at(-1)])) {
            const published = validateReplayHour((await read(`${bundle}/${hour.file}`, manifest.files?.[hour.file])).raw, manifest.cellCount);
            if (!published || published.validAt !== hour.validAt || published.forecastHour !== hour.forecastHour) throw new Error('Regional boundary hour differs from its manifest');
          }
          const point = manifests.get(native.model);
          const consistent = Boolean(point && point.referenceTime === manifest.case.referenceTime)
            && manifest.hours.every((hour, index) => Date.parse(hour.validAt) === Date.parse(manifest.case.referenceTime) + hour.forecastHour * 3_600_000
              && (index === 0 || hour.forecastHour > manifest.hours[index - 1].forecastHour));
          const check = assessment(native.caseId, 'regional', { now, referenceTime: manifest.case.referenceTime, validUntil: manifest.hours.at(-1).validAt, policy: model.catalogue, consistent });
          if (point && point.referenceTime !== manifest.case.referenceTime) check.reason = `Regional run ${manifest.case.referenceTime} differs from point run ${point.referenceTime}; regional publication is lagging or inconsistent.`;
          checks.push(check);
        } catch (error) { checks.push(failure(native.caseId, 'regional', error)); }
      }
    }
  } catch (error) { checks.push(failure('regions', 'regional', error)); }
  return { schemaVersion: 1, checkedAt: now, baseUrl: root, ok: checks.every(check => check.ok), checks };
}

async function main() {
  const { values } = parseArgs({ options: { from: { type: 'string' }, now: { type: 'string' } } });
  if (!values.from) throw new Error('Use --from the deployed dataset URL');
  const report = await monitorServed({ from: values.from, now: values.now });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
