import { parsePublishedProfileJson, type PublishedSiteForecast } from '@windgrams/contracts/published-lift';
import { parseForecastManifestJson, type ForecastManifest } from '@azohra/meteo.briefing/contract';
import { loadDocument, type LoadedDocument, type DocumentMiss } from '@azohra/meteo.briefing/transport';
import { fetchWithRetry } from './http.ts';
import { readRegionalJson } from './regional.ts';
import { createAvClient, type AvBuild } from './av-client.ts';
import { avModel, type AvModel } from './av-wire.ts';
import { avProfileToPublishedSiteForecast, avPublishedManifest, type AvSite } from './av-profile.ts';

export interface ForecastClientOptions {
  /** Dataset root, absolute or relative to the consuming application's origin. */
  baseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Configure AV explicitly for GFS, ICON-EU and RRFS; other models retain the dataset root. */
  avApiBaseUrl?: string;
  sites?: readonly AvSite[];
}

/** A profile paired with its manifest, or a miss. A stale pair still has mismatched runs after retry. */
export type ForecastProfileResult = LoadedDocument<PublishedSiteForecast> | DocumentMiss;
export interface ForecastClient {
  /** Load a validated profile and its manifest. Check the result's stale flag for a run mismatch. */
  loadManifest(modelSlug: string): Promise<ForecastManifest | null>;
  loadProfile(modelSlug: string, siteSlug: string): Promise<ForecastProfileResult>;
  /** Dataset-relative path. Returns null on 404; invalid data and other HTTP failures throw. */
  readJson<T>(relativePath: string, validate: (raw: unknown) => T | null): Promise<T | null>;
  /** Read regional JSON or gzip; validate the returned document before using its fields. */
  readRegional(relativePath: string): Promise<unknown>;
}

/** Create a client for one dataset root. Supply fetch for credentials and a signal for cancellation. */
export function createForecastClient(options: ForecastClientOptions): ForecastClient {
  const base = options.baseUrl.replace(/\/$/, '');
  const path = (value: string) => {
    if (!value || value.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-zA-Z0-9._/-]+$/.test(value)) {
      throw new Error('Invalid dataset-relative path');
    }
    return `${base}/${value}`;
  };
  const av = options.avApiBaseUrl ? createAvClient({ ...options, apiBaseUrl: options.avApiBaseUrl }) : null;
  const builds = new Map<AvModel, Promise<AvBuild>>();
  const pin = (model: AvModel) => {
    let task = builds.get(model);
    if (!task) { task = av!.pin(model).catch(error => { builds.delete(model); throw error; }); builds.set(model, task); }
    return task;
  };
  const read = (url: string) => fetchWithRetry(url, { signal: options.signal }, { fetchImpl: options.fetch, timeoutMs: options.timeoutMs });
  return {
    async loadManifest(modelSlug) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(modelSlug)) throw new Error('Invalid forecast identity');
      if (av && avModel(modelSlug)) return avPublishedManifest((await pin(modelSlug)).manifest, options.sites ?? []);
      const response = await read(path(`${modelSlug}/manifest.json`));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Forecast data unavailable (${response.status})`);
      return parseForecastManifestJson(await response.text());
    },
    loadProfile(modelSlug: string, siteSlug: string) {
      if (![modelSlug, siteSlug].every(value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))) throw new Error('Invalid forecast identity');
      if (av && avModel(modelSlug)) {
        const site = options.sites?.find(site => site.slug === siteSlug);
        if (!site) return Promise.reject(new Error(`AV site coordinates unavailable: ${siteSlug}`));
        return pin(modelSlug).then(async build => {
          const document = avProfileToPublishedSiteForecast(await av.profile(build, site), site);
          return { manifest: avPublishedManifest(build.manifest, [site]), document, stale: false };
        });
      }
      return loadDocument({ baseUrl: base, modelSlug, siteSlug, guard: parsePublishedProfileJson, supportedSchemaVersion: 2, fetch: read });
    },
    async readJson<T>(relativePath: string, validate: (raw: unknown) => T | null): Promise<T | null> {
      const response = await read(path(relativePath));
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Forecast data unavailable (${response.status}).`);
      const document = validate(await response.json());
      if (document === null) throw new Error('Invalid forecast document');
      return document;
    },
    readRegional(relativePath: string): Promise<unknown> {
      return readRegionalJson(path(relativePath), { fetch: options.fetch, signal: options.signal, timeoutMs: options.timeoutMs });
    },
  };
}
