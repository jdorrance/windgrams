// Physical storage only. Revision identities always hash the original JSON bytes.
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const profilePattern = /^(?:full-columns\/)?sites\/[a-zA-Z0-9_-]+\.json$/;
const logicalPattern = /^(?:manifest\.json|(?:full-columns\/)?sites\/[a-zA-Z0-9_-]+\.json)$/;
export const MAX_HISTORY_FILE_BYTES = 64 * 1024 * 1024;

export function logicalHistoryFile(file) {
  if (file.endsWith('.gz') && profilePattern.test(file.slice(0, -3))) return file.slice(0, -3);
  return file;
}

/** Missing evidence returns null; ambiguous or corrupt storage throws. */
export function readIssuedHistoryFile(directory, file) {
  if (!logicalPattern.test(file)) throw new Error(`Invalid history file: ${file}`);
  const plain = join(directory, file), compressed = `${plain}.gz`;
  const hasPlain = existsSync(plain), hasCompressed = profilePattern.test(file) && existsSync(compressed);
  if (hasPlain && hasCompressed) throw new Error(`Ambiguous issued-history file: ${file}`);
  if (!hasPlain && !hasCompressed) return null;
  const path = hasPlain ? plain : compressed, stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HISTORY_FILE_BYTES) throw new Error(`Invalid issued-history file: ${file}`);
  const bytes = readFileSync(path);
  return hasCompressed ? gunzipSync(bytes, { maxOutputLength: MAX_HISTORY_FILE_BYTES }) : bytes;
}

export function writeIssuedHistoryFile(directory, file, bytes) {
  if (!logicalPattern.test(file) || bytes.length > MAX_HISTORY_FILE_BYTES) throw new Error(`Invalid history file: ${file}`);
  const path = join(directory, file) + (profilePattern.test(file) ? '.gz' : '');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, profilePattern.test(file) ? gzipSync(bytes) : bytes, { flag: 'wx' });
}

/** Existing bytes are removed only after a bounded, exact round trip. Metadata stays untouched. */
export function compressIssuedHistoryFile(directory, file) {
  const plain = join(directory, file);
  if (!profilePattern.test(file) || !existsSync(plain)) return false;
  const bytes = readIssuedHistoryFile(directory, file), compressed = gzipSync(bytes);
  if (!gunzipSync(compressed, { maxOutputLength: MAX_HISTORY_FILE_BYTES }).equals(bytes)) throw new Error(`History compression changed bytes: ${file}`);
  const temporary = `${plain}.gz.pending-${process.pid}`;
  try {
    writeFileSync(temporary, compressed, { flag: 'wx' });
    if (!gunzipSync(readFileSync(temporary), { maxOutputLength: MAX_HISTORY_FILE_BYTES }).equals(bytes)) throw new Error(`History compression changed stored bytes: ${file}`);
    renameSync(temporary, `${plain}.gz`);
    rmSync(plain);
  } finally { rmSync(temporary, { force: true }); }
  return true;
}

/** Immutable revision files may share blocks; mutable indexes always receive independent bytes. */
export function copyIssuedHistoryTree(source, destination, prefix = '') {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('History directories must not be symlinks');
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyIssuedHistoryTree(join(source, name), join(destination, name), `${prefix}/${name}`);
  } else if (stat.isFile()) {
    const immutable = /\/revisions\/[a-f0-9]{64}\/(?:revision\.json|manifest\.json|(?:full-columns\/)?sites\/[a-zA-Z0-9_-]+\.json(?:\.gz)?)$/.test(prefix);
    if (immutable) {
      try { linkSync(source, destination); return; }
      catch (error) { if (error.code !== 'EXDEV' && error.code !== 'ENOTSUP') throw error; }
    }
    copyFileSync(source, destination);
  } else throw new Error('History contains a special file');
}
