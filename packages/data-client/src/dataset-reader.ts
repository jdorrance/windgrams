import type { SiteForecast } from '@azohra/meteo.briefing/contract';
import { validateReplayHour, type ReplayHour } from '@windgrams/contracts/regional';
import { fieldDefinition, readRegionalField } from '@windgrams/contracts/fields';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import { createReplayProfileCache, readRegionalJson } from './regional.ts';
import { publishedFile, validCellIndex } from './regional-bundle.ts';
import { boundedReader, freeze, memo } from './dataset-cache.ts';
import { datasetDocuments } from './dataset-documents.ts';
import { reconstructRegionalCellProfile } from './dataset-profile.ts';
import { cellAt, instant, timeAt } from './dataset-query.ts';
import type { RegionalDataset, RegionalDatasetDocuments, RegionalSample, RegionalSampleRequest } from './dataset-types.ts';

/** Open already-resolved documents, including saved subsets with an injected reader. */
export function openRegionalDatasetFromDocuments(options: RegionalDatasetDocuments): RegionalDataset {
  const { manifest, grid, model, hours, availableCells, completeHorizon, primaryAvailable } = datasetDocuments(options);
  const bundleUrl = options.bundleUrl.replace(/\/$/, '');
  const read = boundedReader(options.read ?? (url => readRegionalJson(url, { signal: options.signal })), options.signal);
  const byTime = new Map(hours.map(hour => [hour.validAt, hour]));
  const load = memo<string, ReplayHour>(8, async validAt => {
    const entry = byTime.get(validAt)!;
    const hour = validateReplayHour(await read(`${bundleUrl}/${entry.file}`), manifest.cellCount);
    if (!hour || hour.validAt !== entry.validAt || hour.forecastHour !== entry.forecastHour) {
      throw new Error('Regional hour differs from its manifest');
    }
    return hour;
  }, options.signal);
  const profilePattern = manifest.cellProfiles;
  const remoteProfiles = profilePattern ? createReplayProfileCache(bundleUrl, manifest, read) : null;
  const loadLegacyProfile = memo<number, SiteForecast | null>(8, async cellIndex => {
    if (!completeHorizon) return null;
    if (primaryAvailable && cellIndex === manifest.siteCell && manifest.files && Object.hasOwn(manifest.files, 'profile.json')) {
      const profile = parsePublishedProfileJson(JSON.stringify(await read(`${bundleUrl}/profile.json`)));
      if (!profile || profile.model !== model
        || instant(profile.run.referenceTime) !== instant(manifest.case.referenceTime)
        || profile.site.latitude !== manifest.case.site.latitude || profile.site.longitude !== manifest.case.site.longitude
        || profile.hours.length !== manifest.hours.length
        || profile.hours.some((hour, i) => instant(hour.validAt) !== instant(manifest.hours[i].validAt))) {
        throw new Error('Regional primary profile differs from its map');
      }
      return profile;
    }
    const hourly = await Promise.all(manifest.hours.map(hour => load(hour.validAt)));
    return reconstructRegionalCellProfile(manifest, hourly, cellIndex, grid.features[cellIndex].properties);
  }, options.signal);

  async function sample(request: RegionalSampleRequest): Promise<RegionalSample> {
    options.signal?.throwIfAborted();
    const requested = { ...request, position: { ...request.position }, fields: [...request.fields] };
    for (const field of requested.fields) fieldDefinition(field);
    const cell = cellAt(grid, requested.position);
    const time = timeAt(hours, requested.validAt, requested.timeToleranceMinutes);
    const selected = { cell, time };
    if (!cell) return { requested, selected, gap: 'outside-coverage', values: {} };
    if (!time) return { requested, selected, gap: 'time-unavailable', values: {} };
    const hour = await load(time.validAt);
    const values = Object.fromEntries(requested.fields.map(field => [field, readRegionalField(hour, field, cell.cellIndex)]));
    return { requested, selected, gap: null, values };
  }

  return Object.freeze({
    identity: Object.freeze({ caseId: manifest.case.id, model, referenceTime: manifest.case.referenceTime, bundleUrl }),
    manifest, grid,
    async loadHour(validAt: string) {
      options.signal?.throwIfAborted();
      const selected = timeAt(hours, validAt);
      return selected ? load(selected.validAt) : null;
    },
    async loadCellProfile(cellIndex: number) {
      options.signal?.throwIfAborted();
      if (!validCellIndex(cellIndex, manifest)) throw new Error('Invalid regional cell');
      if (availableCells && !availableCells.has(cellIndex)) return null;
      if (remoteProfiles && profilePattern) {
        if (!publishedFile(manifest, profilePattern.replace('{index}', String(cellIndex)))) return null;
        const profile = await remoteProfiles.load(cellIndex, grid.features[cellIndex].properties.gridIndex);
        options.signal?.throwIfAborted();
        return freeze(profile);
      }
      return loadLegacyProfile(cellIndex);
    },
    sample,
    async sampleRoute(requests: readonly RegionalSampleRequest[], { concurrency = 4 } = {}) {
      if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
        throw new Error('Route concurrency must be an integer from 1 to 16');
      }
      const results: RegionalSample[] = new Array(requests.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
        while (next < requests.length) {
          const index = next++;
          results[index] = await sample(requests[index]);
        }
      }));
      return results;
    },
  });
}
