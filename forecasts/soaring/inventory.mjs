// Deterministic implementation-inventory hashing and import-coverage verification
// for regional forecast publishers (HRRR, RRFS, and ICON-EU).

import { readFileSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './common.mjs';
import { packageBuildHashes } from '@windgrams/pipeline';

const SOARING_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Application modules used in regional calculations. Package distributions are
 * hashed separately by computeImplementationCodeHashes.
 */
export const SCIENCE_IMPLEMENTATION_FILES = Object.freeze([
  'audit-agreement.mjs',
  'boundary-layer-wind.mjs',
  'convective-lift.mjs',
  'diagnostics.mjs',
  'grib-column.mjs',
  'grid-kinematics.mjs',
  'inventory.mjs',
  'model-comparison.mjs',
  'point-postprocess.mjs',
  'science.mjs',
  'source-profile.mjs',
  'terrain-adjustment.mjs',
  'thermodynamics.mjs',
  'vendor/derive-0.6.0.d.mts',
  'vendor/derive-0.6.0.mjs',
]);

/**
 * Deterministic implementation inventory for CONUS HRRR / RRFS regional replay.
 * Paths are stable and relative to `forecasts/soaring/`.
 */
export const CONUS_REPLAY_INVENTORY = Object.freeze(
  [
    'capture.mjs',
    'common.mjs',
    'fields.mjs',
    'grid.mjs',
    'replay.mjs',
    ...SCIENCE_IMPLEMENTATION_FILES,
    '../scripts/lib/model-feeds.mjs',
  ].sort(),
);

/**
 * Deterministic implementation inventory for native ICON-EU regional replay.
 * Covers owned derivation, normalization, publication dependencies, lockfile,
 * and the native decoder's pinned requirements.
 */
export const ICON_REPLAY_INVENTORY = Object.freeze(
  [
    './common.mjs',
    './grid.mjs',
    './icon-replay.mjs',
    ...SCIENCE_IMPLEMENTATION_FILES.map(f => `./${f}`),
    '../scripts/lib/icon-decode.py',
    '../scripts/lib/icon-eu.mjs',
    '../scripts/lib/icon-requirements.txt',
    '../scripts/lib/model-feeds.mjs',
  ].sort(),
);

/**
 * Normalizes a path relative to `forecasts/soaring/` using POSIX separators.
 * @param {string} relPath
 * @returns {string}
 */
export function canonicalInventoryPath(relPath) {
  const abs = resolve(SOARING_DIR, relPath);
  return relative(SOARING_DIR, abs).split(sep).join(posix.sep);
}

/**
 * Computes deterministic SHA-256 digests for an explicit sorted list of implementation files.
 * @param {readonly string[]} inventory
 * @param {(relPath: string) => Buffer | string} [readBytes]
 * @returns {Record<string, string>}
 */
export function computeImplementationCodeHashes(inventory, readBytes) {
  const packageHashes = readBytes ? {} : packageBuildHashes(['@windgrams/soaring', '@windgrams/providers', '@windgrams/pipeline'], import.meta.resolve);
  readBytes ??= relPath => readFileSync(resolve(SOARING_DIR, relPath));
  const sorted = [...inventory].sort();
  /** @type {Record<string, string>} */
  const hashes = { ...packageHashes };
  for (const relPath of sorted) {
    hashes[relPath] = sha256(readBytes(relPath));
  }
  return hashes;
}

const RELATIVE_IMPORT_RE = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|import\s*\(\s*)['"](\.[^'"]+\.(?:mjs|js))['"]/g;

/**
 * Verifies that every relative `.mjs`/`.js` module imported by any JS file in `inventory`
 * is also present in `inventory`. Throws if an imported dependency is missing from provenance.
 *
 * @param {readonly string[]} inventory
 * @returns {{ verifiedFiles: number; canonicalPaths: string[] }}
 */
export function verifyInventoryImportCoverage(inventory) {
  const canonicalSet = new Set(inventory.map(canonicalInventoryPath));
  for (const entry of inventory) {
    if (!entry.endsWith('.mjs') && !entry.endsWith('.js')) continue;
    const absFile = resolve(SOARING_DIR, entry);
    const source = readFileSync(absFile, 'utf8');
    const fileDir = dirname(absFile);
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      const targetRel = match[1];
      const targetAbs = resolve(fileDir, targetRel);
      const targetCanonical = relative(SOARING_DIR, targetAbs).split(sep).join(posix.sep);
      if (!canonicalSet.has(targetCanonical)) {
        throw new Error(
          `Implementation inventory is missing imported module "${targetCanonical}" (imported by "${canonicalInventoryPath(entry)}")`,
        );
      }
    }
  }
  return {
    verifiedFiles: canonicalSet.size,
    canonicalPaths: [...canonicalSet].sort(),
  };
}
