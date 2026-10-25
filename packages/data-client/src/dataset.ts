import { validateRegionCatalogue, validateReplayGrid, validateReplayManifest } from '@windgrams/contracts/regional';
import { readRegionalJson } from './regional.ts';
import { bundlePointer } from './regional-bundle.ts';
import { freeze } from './dataset-cache.ts';
import { openRegionalDatasetFromDocuments } from './dataset-reader.ts';
import type { RegionalDataset, RegionalDatasetDescriptor, RegionalDatasetOptions, RegionalDiscoveryOptions } from './dataset-types.ts';

export type {
  RegionalDataset, RegionalDatasetDescriptor, RegionalDatasetDocuments, RegionalDatasetIdentity,
  RegionalDatasetOptions, RegionalDiscoveryOptions, RegionalSample, RegionalSampleRequest,
  RegionalCellSelection, RegionalTimeSelection,
} from './dataset-types.ts';
export { openRegionalDatasetFromDocuments } from './dataset-reader.ts';
export { reconstructRegionalCellProfile } from './dataset-profile.ts';

/** Published regional coverage, independent of a model provider's coverage. */
export async function discoverRegionalDatasets(options: RegionalDiscoveryOptions): Promise<RegionalDatasetDescriptor[]> {
  const root = options.baseUrl.replace(/\/$/, '');
  const catalogue = validateRegionCatalogue(await readRegionalJson(`${root}/soaring/v1/regions.json`, options));
  if (!catalogue) throw new Error('Invalid regional catalogue');
  const datasets = new Map<string, RegionalDatasetDescriptor>();
  for (const region of catalogue.regions) {
    if (region.status !== 'active-verified-trial' && region.status !== 'active') continue;
    for (const native of region.nativeModels ?? []) {
      const descriptor: RegionalDatasetDescriptor = freeze({
        id: native.caseId, name: region.name, model: native.model,
        bounds: [...region.bbox], timeZone: region.timeZone,
      });
      const existing = datasets.get(descriptor.id);
      if (existing && existing.model !== descriptor.model) throw new Error('Regional case has conflicting model identities');
      if (!existing) datasets.set(descriptor.id, descriptor);
    }
  }
  return [...datasets.values()];
}

/** Resolve the case pointer once. All later reads use that immutable bundle. */
export async function openRegionalDataset(options: RegionalDatasetOptions): Promise<RegionalDataset> {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(options.caseId)) throw new Error('Invalid regional case identity');
  const root = `${options.baseUrl.replace(/\/$/, '')}/soaring/v1/${options.caseId}`;
  const read = (url: string) => readRegionalJson(url, options);
  const pointer = bundlePointer(await read(`${root}/index.json`), options.caseId);
  const bundleUrl = `${root}/${pointer.bundle}`;
  const [rawManifest, rawGrid] = await Promise.all([
    read(`${bundleUrl}/manifest.json`), read(`${bundleUrl}/grid.geojson`),
  ]);
  const manifest = validateReplayManifest(rawManifest);
  if (!manifest || manifest.case.id !== options.caseId) throw new Error('Regional manifest differs from its case');
  return openRegionalDatasetFromDocuments({
    bundleUrl, manifest, grid: validateReplayGrid(rawGrid, manifest.cellCount),
    model: options.model, read, signal: options.signal,
  });
}
