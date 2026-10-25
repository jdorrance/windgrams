import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Implement put/get for a storage backend; document how concurrent writes and multi-pointer updates behave. */
export interface DatasetStore { readonly name: string; put(key: string, body: Uint8Array | string): Promise<void>; get(key: string): Promise<Uint8Array | null> }
export function datasetKey(key: string): string {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`invalid dataset key: ${key}`);
  return key;
}
/** Atomic replacement per file within the supplied root. */
export function fileStore(root: string): DatasetStore {
  const base = resolve(root);
  const pathFor = (key: string): string => { const path = resolve(base, datasetKey(key)); if (!path.startsWith(base + sep)) throw new Error('Invalid dataset path'); return path; };
  return { name: `file:${base}`,
    async put(key, body) { const path = pathFor(key), temporary = `${path}.${randomUUID()}.tmp`; mkdirSync(dirname(path), { recursive: true }); try { writeFileSync(temporary, body); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); } },
    async get(key) { try { return readFileSync(pathFor(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } },
  };
}
/** Write all content files before updating the pointers that reference them. */
export async function publishImmutableFiles(store: DatasetStore, files: ReadonlyMap<string, Uint8Array | string>, pointers: ReadonlyMap<string, Uint8Array | string>): Promise<void> {
  for (const key of [...files.keys(), ...pointers.keys()]) datasetKey(key);
  for (const [key, body] of files) await store.put(key, body);
  for (const [key, body] of pointers) await store.put(key, body);
}
