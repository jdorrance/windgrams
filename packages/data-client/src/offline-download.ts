import type { SaveSnapshotOptions, SnapshotByteReader, SnapshotFile, SnapshotHasher, SnapshotInventory, SnapshotObjectStore } from './offline-types.ts';

export function objectKey(inventory: SnapshotInventory, path: string): string {
  return `objects/${inventory.id}/${path}`;
}

export async function matchesFile(bytes: Uint8Array | null, file: SnapshotFile, hash: SnapshotHasher): Promise<boolean> {
  return bytes !== null && bytes.byteLength === file.bytes && await hash(bytes) === file.sha256;
}

/** Store verified whole files. The repository commits their inventory after this succeeds. */
export async function downloadSnapshot(
  inventory: SnapshotInventory,
  store: SnapshotObjectStore,
  read: SnapshotByteReader,
  hash: SnapshotHasher,
  options: SaveSnapshotOptions,
): Promise<void> {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('Download concurrency must be from 1 to 8');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  let cursor = 0;
  let completedFiles = 0;
  let completedBytes = 0;
  let failure: unknown;

  async function storeFile(file: SnapshotFile): Promise<void> {
    controller.signal.throwIfAborted();
    const key = objectKey(inventory, file.path);
    const cached = await store.get(key);
    let bytes: Uint8Array;
    if (cached !== null && await matchesFile(cached, file, hash)) {
      bytes = cached;
    } else {
      bytes = await read(`${inventory.bundleUrl}/${file.path}`, controller.signal);
      controller.signal.throwIfAborted();
      if (!await matchesFile(bytes, file, hash)) throw new Error(`Forecast checksum or size mismatch: ${file.path}`);
      await store.put(key, bytes);
    }
    if (file.path === 'manifest.json'
      && JSON.stringify(JSON.parse(new TextDecoder().decode(bytes))) !== JSON.stringify(inventory.manifest)) {
      throw new Error('Saved forecast metadata differs from its authenticated manifest');
    }
    controller.signal.throwIfAborted();
    completedFiles++;
    completedBytes += file.bytes;
    options.onProgress?.({ completedFiles, totalFiles: inventory.files.length, completedBytes, totalBytes: inventory.totalBytes });
  }

  async function worker(): Promise<void> {
    try {
      while (cursor < inventory.files.length) await storeFile(inventory.files[cursor++]);
    } catch (error) {
      if (failure === undefined) failure = error;
      controller.abort(error);
    }
  }

  try {
    options.signal?.throwIfAborted();
    await Promise.all(Array.from({ length: Math.min(concurrency, inventory.files.length) }, worker));
    if (failure !== undefined) throw failure;
    controller.signal.throwIfAborted();
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
