import { replayModel, validateReplayManifest, type ReplayManifest } from '@windgrams/contracts/regional';
import { bundlePointer, forecastTimes, validCellIndex } from './regional-bundle.ts';
import { inventoryBytes, pathIsSafe, validInventory } from './offline-inventory.ts';
import { readSnapshotBytes, sha256 } from './offline-transport.ts';
import type { PrepareRegionalSnapshotOptions, SnapshotFile, SnapshotInventory } from './offline-types.ts';

function selectedHours(manifest: ReplayManifest, requested?: readonly number[]): ReplayManifest['hours'] {
  const selected = requested ?? manifest.hours.map(hour => hour.forecastHour);
  if (!selected.length || new Set(selected).size !== selected.length
    || selected.some(lead => !manifest.hours.some(hour => hour.forecastHour === lead))) {
    throw new Error('Requested forecast hours are unavailable');
  }
  return manifest.hours.filter(hour => selected.includes(hour.forecastHour));
}

function selectedCells(manifest: ReplayManifest, requested?: readonly number[]): number[] {
  const primaryPath = manifest.cellProfiles?.replace('{index}', String(manifest.siteCell));
  const defaults = primaryPath && manifest.files?.[primaryPath] ? [manifest.siteCell] : [];
  const selected = [...(requested ?? defaults)];
  if (new Set(selected).size !== selected.length || selected.some(index => !validCellIndex(index, manifest))) {
    throw new Error('Requested forecast cells are unavailable');
  }
  return selected;
}

/** Resolve one immutable run and plan a download. Profiles retain their complete forecast horizon. */
export async function prepareRegionalSnapshot(options: PrepareRegionalSnapshotOptions): Promise<SnapshotInventory> {
  if (!pathIsSafe(options.casePath)) throw new Error('Invalid regional case path');
  const read = options.read ?? readSnapshotBytes;
  const hash = options.sha256 ?? sha256;
  const root = `${options.baseUrl.replace(/\/$/, '')}/${options.casePath}`;
  const caseId = options.casePath.split('/').at(-1)!;
  const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
  options.signal?.throwIfAborted();
  const pointer = bundlePointer(decode(await read(`${root}/index.json`, options.signal)), caseId, true);
  const bundleUrl = `${root}/${pointer.bundle}`;
  const bytes = await read(`${bundleUrl}/manifest.json`, options.signal);
  if (await hash(bytes) !== pointer.manifestSha256) throw new Error('Regional manifest checksum mismatch');
  const manifest = validateReplayManifest(decode(bytes));
  if (!manifest || manifest.case.id !== caseId || replayModel(manifest) === 'unknown') {
    throw new Error('Invalid regional manifest');
  }
  forecastTimes(manifest);
  if (!manifest.files || !manifest.fileBytes) {
    throw new Error('This forecast has no offline byte inventory; refresh to a newer run');
  }
  const hours = selectedHours(manifest, options.forecastHours);
  const cellIndices = selectedCells(manifest, options.cellIndices);
  if (cellIndices.length && !manifest.cellProfiles && hours.length !== manifest.hours.length) {
    throw new Error('Legacy cell profiles require the complete forecast horizon');
  }
  const profilePattern = manifest.cellProfiles;
  const primaryProfile = !profilePattern && cellIndices.includes(manifest.siteCell)
    && Object.hasOwn(manifest.files, 'profile.json');
  const paths = [
    'grid.geojson', ...hours.map(hour => hour.file),
    ...(primaryProfile ? ['profile.json'] : []),
    ...(profilePattern ? cellIndices.map(index => profilePattern.replace('{index}', String(index))) : []),
  ];
  const fileBytes = manifest.fileBytes;
  const fileHashes = manifest.files;
  const files: SnapshotFile[] = [
    { path: 'manifest.json', bytes: bytes.byteLength, sha256: pointer.manifestSha256 },
    ...[...new Set(paths)].sort().map(path => ({ path, bytes: fileBytes[path], sha256: fileHashes[path] })),
  ];
  const inventory: SnapshotInventory = {
    schemaVersion: 1,
    id: await hash(inventoryBytes({ bundleUrl, files, hours, cellIndices, manifest })),
    caseId, model: replayModel(manifest), referenceTime: manifest.case.referenceTime,
    validUntil: hours.at(-1)!.validAt,
    bundleUrl, manifest, hours, cellIndices, files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
  options.signal?.throwIfAborted();
  if (!validInventory(inventory)) throw new Error('Incomplete offline byte inventory');
  return inventory;
}
