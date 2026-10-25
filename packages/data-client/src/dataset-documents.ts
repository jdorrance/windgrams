import { replayModel, validateReplayGrid, validateReplayManifest, type ReplayManifest } from '@windgrams/contracts/regional';
import { forecastTimes, publishedFile, validCellIndex } from './regional-bundle.ts';
import { freeze } from './dataset-cache.ts';
import { instant } from './dataset-query.ts';
import type { RegionalDatasetDocuments } from './dataset-types.ts';

function resolveModel(manifest: ReplayManifest, expected?: string): string {
  if (expected !== undefined) {
    if (!expected.trim() || expected === 'unknown') throw new Error('Invalid expected regional model');
    if ((manifest.model && manifest.model !== expected) || (manifest.case.model && manifest.case.model !== expected)) {
      throw new Error('Regional manifest differs from the expected model');
    }
    if (!manifest.model && !manifest.case.model) manifest.model = expected;
  }
  const model = replayModel(manifest);
  if (model === 'unknown') throw new Error('Regional forecast is missing its model identity');
  return model;
}

/** Validate ownership, identities and saved scope once, before any query can read files. */
export function datasetDocuments(options: RegionalDatasetDocuments) {
  const manifest = validateReplayManifest(structuredClone(options.manifest));
  if (!manifest) throw new Error('Invalid regional manifest');
  const model = resolveModel(manifest, options.model);
  const times = forecastTimes(manifest);
  const grid = validateReplayGrid(structuredClone(options.grid), manifest.cellCount);
  if (new Set(grid.features.map(feature => feature.properties.gridIndex)).size !== manifest.cellCount) {
    throw new Error('Regional grid repeats a native cell');
  }
  const availableTimes = options.availableValidTimes ? new Set(options.availableValidTimes.map(instant)) : times;
  for (const time of availableTimes) {
    if (!times.has(time)) throw new Error('Available forecast time is outside the manifest');
  }
  const availableCells = options.availableCellIndices ? new Set(options.availableCellIndices) : null;
  for (const cellIndex of availableCells ?? []) {
    if (!validCellIndex(cellIndex, manifest)) throw new Error('Invalid regional cell');
  }
  const hours = manifest.hours.filter(hour => availableTimes.has(instant(hour.validAt)));
  const availableFiles = options.availableFiles === undefined ? null : new Set(options.availableFiles);
  if (availableFiles) {
    const requireFile = (filename: string) => {
      if (!availableFiles.has(filename)) throw new Error(`Available regional scope is missing ${filename}`);
    };
    for (const hour of hours) requireFile(hour.file);
    const profilePattern = manifest.cellProfiles;
    if (profilePattern) {
      const cells = availableCells ?? grid.features.map(feature => feature.properties.cellIndex);
      for (const cellIndex of cells) {
        const filename = profilePattern.replace('{index}', String(cellIndex));
        if (publishedFile(manifest, filename)) requireFile(filename);
      }
    }
  }
  return {
    manifest: freeze(manifest), grid: freeze(grid), model, hours, availableCells,
    completeHorizon: availableTimes.size === manifest.hours.length,
    primaryAvailable: availableFiles?.has('profile.json')
      ?? (options.availableValidTimes === undefined && options.availableCellIndices === undefined),
  };
}
