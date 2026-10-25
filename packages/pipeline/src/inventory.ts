import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { datasetKey } from './store.js';
export interface BuildInventory { schemaVersion: 1; package: string; version: string; files: Record<string, string>; dependencies: Record<string, { declared: string; version: string }> }
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Verify installed package files against their build inventories and return their content hashes. */
export function packageBuildHashes(packages: readonly string[], resolveSpecifier: (specifier: string) => string = import.meta.resolve): Record<string, string> {
  const hashes: Record<string, string> = {}, visited = new Set<string>();
  const visit = (name: string, resolver: (specifier: string) => string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const resolved = resolver(`${name}/build-inventory.json`);
    const url = resolved.startsWith('file:') ? new URL(resolved) : pathToFileURL(resolved);
    const bytes = readFileSync(url), inventory = JSON.parse(bytes.toString('utf8')) as BuildInventory;
    if (inventory.schemaVersion !== 1 || inventory.package !== name || !inventory.version || !Object.keys(inventory.files ?? {}).length) throw new Error(`Invalid package build inventory: ${name}`);
    const prefix = `${name}@${inventory.version}`;
    hashes[`${prefix}/build-inventory.json`] = hash(bytes);
    for (const [file, expected] of Object.entries(inventory.files).sort(([a], [b]) => a.localeCompare(b))) {
      const actual = hash(readFileSync(new URL(datasetKey(file), url)));
      if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error(`Package build bytes differ from inventory: ${name}/${file}`);
      hashes[`${prefix}/${file}`] = actual;
    }
    const require = createRequire(url);
    for (const dependency of Object.keys(inventory.dependencies).sort()) if (dependency.startsWith('@windgrams/')) visit(dependency, require.resolve);
  };
  for (const name of [...packages].sort()) visit(name, resolveSpecifier);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
