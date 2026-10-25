import { inventoryBytes, validInventory } from './offline-inventory.ts';
import { downloadSnapshot, matchesFile, objectKey } from './offline-download.ts';
import { readSnapshotBytes, sha256 } from './offline-transport.ts';
import type { SavedSnapshot, SnapshotByteReader, SnapshotHasher, SnapshotInventory, SnapshotObjectStore, SnapshotRepository } from './offline-types.ts';

function slotKey(slot: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(slot)) throw new Error('Invalid saved forecast name');
  return `saved/${slot}.json`;
}

/** Mutations run serially under the store's shared lock, when supplied. */
export function createSnapshotRepository(options: {
  store: SnapshotObjectStore;
  read?: SnapshotByteReader;
  sha256?: SnapshotHasher;
  now?: () => string;
}): SnapshotRepository {
  const { store } = options;
  const read = options.read ?? readSnapshotBytes;
  const hash = options.sha256 ?? sha256;
  let queue = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = queue.then(() => {
      signal?.throwIfAborted();
      return store.withLock ? store.withLock(operation, signal) : operation();
    });
    queue = result.then(() => {}, () => {});
    return result;
  }

  async function check(inventory: SnapshotInventory): Promise<void> {
    if (!validInventory(inventory) || await hash(inventoryBytes(inventory)) !== inventory.id) {
      throw new Error('Invalid saved forecast inventory');
    }
  }

  async function record(slot: string): Promise<SavedSnapshot | null> {
    const bytes = await store.get(slotKey(slot));
    if (!bytes) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || !('slot' in value) || value.slot !== slot
      || !('savedAt' in value) || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))
      || !('inventory' in value) || !validInventory(value.inventory)) {
      throw new Error('Invalid saved forecast record');
    }
    await check(value.inventory);
    return { slot, savedAt: value.savedAt, inventory: value.inventory };
  }

  async function list(): Promise<SavedSnapshot[]> {
    const keys = await store.list('saved/');
    const saved = await Promise.all(keys.map(key => record(key.slice('saved/'.length, -'.json'.length))));
    return saved.filter(value => value !== null).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async function removeObjects(id: string): Promise<void> {
    if ((await list()).some(saved => saved.inventory.id === id)) return;
    for (const key of await store.list(`objects/${id}/`)) await store.remove(key);
  }

  return {
    save(slot, inventory, saveOptions = {}) {
      return mutate(async () => {
        const key = slotKey(slot);
        // Own the download plan while host state and requests change around it.
        const stable = structuredClone(inventory);
        await check(stable);
        await downloadSnapshot(stable, store, read, hash, saveOptions);
        const previous = await record(slot);
        const savedAt = options.now?.() ?? new Date().toISOString();
        if (!Number.isFinite(Date.parse(savedAt))) throw new Error('Invalid download clock');
        const saved = { slot, savedAt, inventory: stable };
        saveOptions.signal?.throwIfAborted();
        await store.put(key, new TextEncoder().encode(JSON.stringify(saved)));
        // Cleanup cannot turn a successful commit into a reported download failure.
        if (previous && previous.inventory.id !== stable.id) {
          await removeObjects(previous.inventory.id).catch(() => {});
        }
        return saved;
      }, saveOptions.signal);
    },
    async open(slot) {
      const saved = await record(slot);
      if (!saved) return null;
      const keys = new Set(await store.list(`objects/${saved.inventory.id}/`));
      if (saved.inventory.files.some(file => !keys.has(objectKey(saved.inventory, file.path)))) {
        throw new Error('Saved forecast is incomplete');
      }
      return saved;
    },
    list,
    async read(saved, path) {
      await check(saved.inventory);
      const file = saved.inventory.files.find(entry => entry.path === path);
      if (!file) return null;
      const bytes = await store.get(objectKey(saved.inventory, path));
      if (!await matchesFile(bytes, file, hash)) throw new Error(`Saved forecast file is missing or corrupt: ${path}`);
      return bytes;
    },
    remove(slot) {
      return mutate(async () => {
        const saved = await record(slot);
        await store.remove(slotKey(slot));
        if (saved) await removeObjects(saved.inventory.id);
      });
    },
    prune() {
      return mutate(async () => {
        const retained = new Set((await list()).map(saved => saved.inventory.id));
        for (const key of await store.list('objects/')) {
          if (!retained.has(key.split('/')[1])) await store.remove(key);
        }
      });
    },
  };
}
