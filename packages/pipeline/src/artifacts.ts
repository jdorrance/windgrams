import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { modelDescriptor, PROVIDER_GROUPS } from '@windgrams/providers/registry';
import { datasetKey } from './store.js';

export interface ArtifactSelectionOptions {
  extraPaths?: readonly string[];
  regionIndexes?: readonly { model: string; file: string }[];
  resolveLegacyCase?: (caseId: string) => string | undefined;
  /** Omit retired regional products without affecting point forecasts or issued history. */
  includeRegionalCase?: (caseId: string) => boolean;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function readObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(value)) throw new Error(`Invalid artifact metadata: ${path}`);
  return value;
}
function knownModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return modelDescriptor(value).id; } catch { return undefined; }
}
function physicalPath(path: string): string {
  const suffix: string[] = [];
  while (!existsSync(path)) { suffix.unshift(basename(path)); path = dirname(path); }
  return resolve(realpathSync(path), ...suffix);
}
function overlaps(first: string, second: string): boolean {
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  return within(first, second) || within(second, first);
}

/** Select a provider's files using model metadata or resolveLegacyCase for older regional archives. */
export function providerArtifactPaths(root: string, group: string, { extraPaths = [], regionIndexes = [], resolveLegacyCase, includeRegionalCase = () => true }: ArtifactSelectionOptions = {}): string[] {
  const models = PROVIDER_GROUPS[group];
  if (!models) throw new Error(`Unknown provider group: ${group}`);
  const paths = [...extraPaths];
  for (const id of models) {
    paths.push(id, `history/${id}`);
    const regionIndex = regionIndexes.find(entry => entry.model === id);
    if (regionIndex) paths.push(`soaring/v1/${datasetKey(regionIndex.file)}`);
  }
  const regions = join(root, 'soaring/v1');
  const owners = new Map<string, string>();
  for (const entry of regionIndexes) {
    const path = join(regions, datasetKey(entry.file));
    if (!existsSync(path)) continue;
    try {
      const index = readObject(path);
      if (index.regions !== undefined && !Array.isArray(index.regions)) throw new Error(`Invalid regional index: ${entry.file}`);
      for (const region of index.regions ?? []) {
        if (!object(region)) throw new Error(`Invalid regional entry: ${entry.file}`);
        if (region.nativeModels !== undefined && !Array.isArray(region.nativeModels)) throw new Error(`Invalid regional model list: ${entry.file}`);
        for (const item of region.nativeModels ?? []) {
          if (!object(item) || typeof item.caseId !== 'string' || !knownModel(item.model)) throw new Error(`Invalid regional model owner: ${entry.file}`);
          owners.set(item.caseId, String(item.model));
        }
        if (typeof region.caseId === 'string' && !owners.has(region.caseId)) owners.set(region.caseId, entry.model);
      }
    } catch (error) {
      if (models.includes(entry.model)) throw error;
    }
  }
  if (existsSync(regions)) for (const entry of readdirSync(regions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !includeRegionalCase(entry.name)) continue;
    let owner = knownModel(owners.get(entry.name) ?? resolveLegacyCase?.(entry.name));
    if (owner && !models.includes(owner)) continue;
    const pointerPath = join(regions, entry.name, 'index.json');
    if (existsSync(pointerPath)) {
      try {
        const pointer = readObject(pointerPath);
        if (typeof pointer.bundle === 'string' && /^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) {
          const manifest = readObject(join(regions, entry.name, pointer.bundle, 'manifest.json'));
          const declared = manifest.model ?? (object(manifest.case) ? manifest.case.model : undefined);
          if (declared !== undefined && !knownModel(declared)) throw new Error(`Unknown case model: ${entry.name}`);
          if (declared && owner && declared !== owner) throw new Error(`Conflicting case ownership: ${entry.name}`);
          owner = knownModel(declared) ?? owner;
        }
      } catch (error) {
        if (owner && models.includes(owner)) throw error;
        continue;
      }
    }
    if (owner && models.includes(owner)) paths.push(`soaring/v1/${entry.name}`);
  }
  return [...new Set(paths)].map(datasetKey).filter(key => existsSync(join(root, key)));
}
export function packProvider(root: string, destination: string, group: string, options: ArtifactSelectionOptions = {}): string[] {
  const paths = providerArtifactPaths(root, group, options);
  const source = resolve(root), output = resolve(destination), physicalOutput = physicalPath(output);
  if (overlaps(source, output) || overlaps(physicalPath(source), physicalOutput)
    || paths.some(key => overlaps(physicalPath(join(source, key)), physicalOutput))) {
    throw new Error('Artifact source and destination must be separate directories.');
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const key of paths) { mkdirSync(dirname(join(output, key)), { recursive: true }); cpSync(join(source, key), join(output, key), { recursive: true, preserveTimestamps: true }); }
  if (!paths.length) writeFileSync(join(output, 'EMPTY'), 'empty\n');
  return paths;
}
