import type { ReplayManifest } from '@windgrams/contracts/regional';
import { instant } from './dataset-query.ts';

interface BundlePointer {
  bundle: string;
  manifestSha256: string;
}

/** Older online pointers may omit the checksum; saved forecasts require it. */
export function bundlePointer(value: unknown, caseId: string, requireChecksum = false): BundlePointer {
  if (!value || typeof value !== 'object'
    || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('caseId' in value) || value.caseId !== caseId
    || !('bundle' in value) || typeof value.bundle !== 'string'
    || !/^bundles\/[a-f0-9]{64}$/.test(value.bundle)) {
    throw new Error('Invalid regional bundle pointer');
  }
  const manifestSha256 = value.bundle.slice('bundles/'.length);
  if (('manifestSha256' in value && value.manifestSha256 !== manifestSha256)
    || (requireChecksum && !('manifestSha256' in value))) {
    throw new Error('Invalid regional bundle pointer');
  }
  return { bundle: value.bundle, manifestSha256 };
}

export function forecastTimes(manifest: ReplayManifest): Set<number> {
  const reference = instant(manifest.case.referenceTime);
  const times = new Set<number>();
  let previous = -Infinity;
  for (const hour of manifest.hours) {
    const valid = instant(hour.validAt);
    if (valid <= previous || valid !== reference + hour.forecastHour * 3_600_000) {
      throw new Error('Regional manifest has inconsistent forecast hours');
    }
    previous = valid;
    times.add(valid);
  }
  if (!times.size) throw new Error('Regional forecast has no published hours');
  return times;
}

export function validCellIndex(index: number, manifest: ReplayManifest): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < manifest.cellCount;
}

export function publishedFile(manifest: ReplayManifest, filename: string): boolean {
  return !manifest.files || Object.hasOwn(manifest.files, filename);
}
