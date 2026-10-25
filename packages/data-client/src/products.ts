import { parsePublishedProfileJson, type PublishedSiteForecast } from '@windgrams/contracts/published-lift';
import { loadDocument, type LoadedDocument, type DocumentMiss } from '@azohra/meteo.briefing/transport';
import { fetchWithRetry } from './http.ts';
import { readRegionalJson } from './regional.ts';

export interface ForecastClientOptions {
  /** Dataset root, absolute or relative to the consuming application's origin. */
  baseUrl: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A profile paired with its manifest, or a miss. A stale pair still has mismatched runs after retry. */
export type ForecastProfileResult = LoadedDocument<PublishedSiteForecast> | DocumentMiss;
export interface ForecastClient {
  /** Load a validated profile and its manifest. Check the result's stale flag for a run mismatch. */
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
  const read = (url: string) => fetchWithRetry(url, { signal: options.signal }, { fetchImpl: options.fetch, timeoutMs: options.timeoutMs });
  return {
    loadProfile(modelSlug: string, siteSlug: string) {
      if (![modelSlug, siteSlug].every(value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))) throw new Error('Invalid forecast identity');
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
