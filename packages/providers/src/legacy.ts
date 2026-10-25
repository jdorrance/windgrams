import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SITES_SCHEMA_VERSION, parseForecastManifest, parseSiteForecast } from '@azohra/meteo.briefing/contract';
import type { AcquisitionAdapter, AcquisitionRequest, ProcessedProfileResult } from './types.ts';
import { modelDescriptor } from './registry.ts';
import { object } from './internal/json.ts';
import { requestedForecastHours } from './internal/acquisition.ts';

export const LEGACY_FORECAST_VERSION = '0.6.0' as const;
export interface LegacyProcessedProfileResult extends ProcessedProfileResult {
  derivation: { package: '@azohra/meteo.forecast'; version: typeof LEGACY_FORECAST_VERSION };
}
export interface LegacyBuildOptions {
  sitesPath: string; outputRoot: string; referenceTime?: string; maxSteps?: number; history: false;
  dataset?: { fetch: typeof fetch }; log?: (message: string) => void;
}
export interface LegacyBuilder {
  /** Write the requested model directory under outputRoot. */
  build(options: LegacyBuildOptions): Promise<void>;
  model: { slug?: string; forecastHours?: number[]; completionUrls?: (date: string, hour: string) => string[]; pressureToken?: string; surfaceToken?: string };
}

/** Validate the pinned third-party bridge before invoking its private builders. */
function legacyModel(value: unknown, id: string): LegacyBuilder['model'] {
  if (!object(value) || value.slug !== id || !Array.isArray(value.forecastHours) || !value.forecastHours.every(hour => typeof hour === 'number')
    || (value.completionUrls !== undefined && typeof value.completionUrls !== 'function')
    || (value.pressureToken !== undefined && typeof value.pressureToken !== 'string')
    || (value.surfaceToken !== undefined && typeof value.surfaceToken !== 'string')) throw new Error(`Pinned model contract changed: ${id}`);
  return value as LegacyBuilder['model'];
}
async function loadModule(url: string): Promise<Record<string, unknown>> {
  const loaded: unknown = await import(url);
  if (!object(loaded)) throw new Error('Pinned builder module is invalid');
  return loaded;
}
async function invoke(builder: unknown, args: readonly unknown[]): Promise<void> {
  if (typeof builder !== 'function') throw new Error('Pinned builder function is missing');
  await Reflect.apply(builder, undefined, args);
}

/** The pinned public registry strips referenceTime/dataset; keep that bridge here. */
export async function loadLegacyBuilder(id: string): Promise<LegacyBuilder> {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@azohra/meteo.forecast')), 'utf8'));
  if (!object(pkg) || pkg.version !== LEGACY_FORECAST_VERSION) throw new Error(`Legacy builder bridge requires @azohra/meteo.forecast ${LEGACY_FORECAST_VERSION}`);
  const base = import.meta.resolve('@azohra/meteo.forecast');
  if (['hrrr-conus', 'rrfs', 'gfs'].includes(id)) {
    const module = await loadModule(new URL('./builders/noaa.js', base).href);
    const model = legacyModel(module[id === 'hrrr-conus' ? 'HRRR' : id.toUpperCase()], id);
    if (typeof module.buildNoaa !== 'function' || typeof model.completionUrls !== 'function') throw new Error(`Pinned NOAA adapter contract changed: ${id}`);
    if (id === 'rrfs') process.env.METEO_RRFS_BASE ||= 'https://noaa-rrfs-ops-pds.s3.amazonaws.com';
    return { model, build: options => invoke(module.buildNoaa, [model, options]) };
  }
  if (id === 'geps') {
    const module = await loadModule(new URL('./builders/eccc-ensemble.js', base).href);
    const model = legacyModel(module.GEPS, id);
    if (typeof module.buildGeps !== 'function') throw new Error('Pinned GEPS adapter contract changed');
    return { model, build: options => invoke(module.buildGeps, [options]) };
  }
  if (['hrdps-continental', 'rdps', 'gdps'].includes(id)) {
    const module = await loadModule(new URL('./builders/eccc.js', base).href);
    const model = legacyModel(module[id === 'hrdps-continental' ? 'HRDPS' : id.toUpperCase()], id);
    if (typeof module.buildEccc !== 'function') throw new Error(`Pinned ECCC adapter contract changed: ${id}`);
    return { model, build: options => invoke(module.buildEccc, [model, options]) };
  }
  throw new Error(`No processed-profile adapter: ${id}`);
}
/** Acquire the requested run, including repeat requests that backfill sites in an existing run. */
export function createLegacyAdapter(id: string, options: { log?: (message: string) => void } = {}): AcquisitionAdapter<LegacyProcessedProfileResult> {
  return createLegacyAdapterWithLoader(id, options);
}

/** Internal test seam for the version-pinned bridge. */
export function createLegacyAdapterWithLoader(id: string, options: { load?: (id: string) => Promise<LegacyBuilder>; log?: (message: string) => void } = {}): AcquisitionAdapter<LegacyProcessedProfileResult> {
  const model = modelDescriptor(id);
  if (model.product !== 'processed-profile') throw new Error(`${id} emits normalized columns`);
  return {
    model,
    async acquire(request: AcquisitionRequest): Promise<LegacyProcessedProfileResult> {
      if (request.run.model !== id || request.run.provider !== model.provider) throw new Error('Requested source does not match adapter');
      const stamp = new Date(request.run.referenceTime);
      if (!Number.isFinite(+stamp) || stamp.getUTCMinutes() || stamp.getUTCSeconds() || stamp.getUTCMilliseconds() || !model.cyclesUtc.includes(stamp.getUTCHours())) throw new Error(`Invalid ${id} reference time`);
      if (!request.sites.length) throw new Error('Acquisition requires at least one site');
      const expectedHours = requestedForecastHours(model.forecastHours, request.maxSteps);
      mkdirSync(request.outputRoot, { recursive: true });
      const temporary = mkdtempSync(join(tmpdir(), 'windgrams-provider-'));
      try {
        const sitesPath = join(temporary, 'sites.json');
        writeFileSync(sitesPath, JSON.stringify({ schemaVersion: SITES_SCHEMA_VERSION, sites: request.sites }));
        const { build } = await (options.load ?? loadLegacyBuilder)(id);
        // Upstream uses this reader only for publication/history. History is off;
        // the pipeline's validated local state owns idempotency and recovery.
        const dataset = { fetch: async () => new Response(null, { status: 404 }) };
        await build({ sitesPath, outputRoot: request.outputRoot, referenceTime: request.run.referenceTime, history: false,
          dataset, ...(request.maxSteps ? { maxSteps: request.maxSteps } : {}), ...(options.log ? { log: options.log } : {}) });
        const manifest = parseForecastManifest(JSON.parse(readFileSync(join(request.outputRoot, id, 'manifest.json'), 'utf8')));
        if (!manifest || manifest.model !== id || Date.parse(manifest.referenceTime) !== +stamp) throw new Error(`${id}: acquisition returned the wrong run`);
        const requestedSites = new Map(request.sites.map(site => [site.slug, site]));
        if (JSON.stringify(manifest.sites.map(site => site.slug).sort()) !== JSON.stringify([...requestedSites.keys()].sort())) throw new Error(`${id}: acquisition returned an incomplete site inventory`);
        if (manifest.forecastHours !== expectedHours.length || manifest.firstForecastHour !== expectedHours[0] || manifest.lastForecastHour !== expectedHours.at(-1)) throw new Error(`${id}: acquisition returned an incomplete horizon`);
        const profiles = manifest.sites.map(site => {
          const doc = parseSiteForecast(JSON.parse(readFileSync(join(request.outputRoot, id, 'sites', `${site.slug}.json`), 'utf8')));
          if (!doc || doc.model !== id || doc.site.id !== site.slug || Date.parse(doc.run.referenceTime) !== +stamp) throw new Error(`${id}: invalid acquired profile ${site.slug}`);
          const requested = requestedSites.get(site.slug)!;
          if (doc.site.latitude !== requested.latitude || doc.site.longitude !== requested.longitude) throw new Error(`${id}: acquired profile location differs from request ${site.slug}`);
          const hours = doc.hours.map(hour => (Date.parse(hour.validAt) - +stamp) / 3_600_000);
          if (JSON.stringify(hours) !== JSON.stringify(expectedHours)) throw new Error(`${id}: incomplete acquired hours ${site.slug}`);
          return doc;
        });
        return { kind: 'processed-profile', stage: 'upstream-derived', run: request.run,
          derivation: { package: '@azohra/meteo.forecast', version: LEGACY_FORECAST_VERSION }, profiles, manifest: { ...manifest } };
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    },
  };
}
