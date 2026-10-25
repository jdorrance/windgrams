import { replayModel, validateReplayManifest, type ReplayManifest } from '@windgrams/contracts/regional';
import { forecastTimes, validCellIndex } from './regional-bundle.ts';
import type { SnapshotFile, SnapshotInventory } from './offline-types.ts';

const hashPattern = /^[a-f0-9]{64}$/;

export function pathIsSafe(path: string): boolean {
  return typeof path === 'string' && /^[a-zA-Z0-9._/-]+$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

export function inventoryBytes(inventory: Pick<SnapshotInventory, 'bundleUrl' | 'files' | 'hours' | 'cellIndices' | 'manifest'>): Uint8Array {
  const { bundleUrl, files, hours, cellIndices, manifest } = inventory;
  return new TextEncoder().encode(JSON.stringify({ bundleUrl, files, hours, cellIndices, manifest }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isFile(value: unknown): value is SnapshotFile {
  return isRecord(value)
    && typeof value.path === 'string' && pathIsSafe(value.path)
    && typeof value.sha256 === 'string' && hashPattern.test(value.sha256)
    && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
}

function isSelectedHour(value: unknown, manifest: ReplayManifest): value is ReplayManifest['hours'][number] {
  return isRecord(value) && manifest.hours.some(hour => hour.forecastHour === value.forecastHour
    && hour.validAt === value.validAt && hour.file === value.file);
}

/** Validate persisted metadata before trusting paths, sizes or download scope. */
export function validInventory(value: unknown): value is SnapshotInventory {
  if (!isRecord(value)) return false;
  const manifest = validateReplayManifest(value.manifest);
  if (!manifest || value.schemaVersion !== 1
    || typeof value.id !== 'string' || !hashPattern.test(value.id)
    || value.caseId !== manifest.case.id || value.model !== replayModel(manifest) || value.model === 'unknown'
    || value.referenceTime !== manifest.case.referenceTime
    || typeof value.bundleUrl !== 'string' || !/\/bundles\/[a-f0-9]{64}$/.test(value.bundleUrl)
    || !Array.isArray(value.hours) || !value.hours.length || !value.hours.every(hour => isSelectedHour(hour, manifest))
    || !Array.isArray(value.cellIndices) || !value.cellIndices.every(index => validCellIndex(index, manifest))
    || !Array.isArray(value.files) || !value.files.length || !value.files.every(isFile)) return false;

  try { forecastTimes(manifest); } catch { return false; }
  if (new Set(value.hours.map(hour => hour.forecastHour)).size !== value.hours.length
    || new Set(value.cellIndices).size !== value.cellIndices.length
    || new Set(value.files.map(file => file.path)).size !== value.files.length
    || value.validUntil !== value.hours.at(-1)?.validAt
    || value.totalBytes !== value.files.reduce((total, file) => total + file.bytes, 0)) return false;

  const byPath = new Map(value.files.map(file => [file.path, file]));
  if (byPath.get('manifest.json')?.sha256 !== value.bundleUrl.split('/').at(-1)) return false;
  const profilePattern = manifest.cellProfiles;
  const required = [
    'grid.geojson',
    ...value.hours.map(hour => hour.file),
    ...(profilePattern ? value.cellIndices.map(index => profilePattern.replace('{index}', String(index))) : []),
  ];
  if (required.some(path => !byPath.has(path))) return false;
  return value.files.every(file => file.path === 'manifest.json'
    || (manifest.files?.[file.path] === file.sha256 && manifest.fileBytes?.[file.path] === file.bytes));
}
