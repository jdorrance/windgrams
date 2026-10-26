// Shared immutable evidence bytes and bounded transport; provider decoding belongs elsewhere.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';

const MAX_BYTES = 64 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function responseBytes(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('Evidence object exceeds 64 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** A capture owns a new directory, including when an earlier capture was interrupted. */
export async function claimCapture(root, manifest = 'snapshot.json') {
  await mkdir(root, { recursive: true });
  try {
    await readFile(join(root, manifest));
    throw Object.assign(new Error('Snapshot already exists; use a new output directory'), { code: 'EEXIST' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(join(root, 'capture.lock'), new Date().toISOString(), { flag: 'wx' });
}

export async function createStore(root, { fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  await mkdir(join(root, 'objects'), { recursive: true });
  const resources = [],
    pending = new Map();

  async function save(bytes, metadata) {
    bytes = Buffer.from(bytes);
    const hash = sha256(bytes),
      file = `objects/${hash}`;
    try {
      await writeFile(join(root, file), bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (sha256(await readFile(join(root, file))) !== hash)
        throw new Error(`Corrupt existing evidence object: ${hash}`);
    }
    const entry = { ...metadata, sha256: hash, file, bytes: bytes.length };
    resources.push(entry);
    return entry;
  }

  async function request(url, kind) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(20_000),
          headers: { 'User-Agent': 'WindgramsScientificReview/1.0', 'Cache-Control': 'no-cache' },
        });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await response.body?.cancel();
          await delay(1000 * (attempt + 1));
          continue;
        }
        return await save(await responseBytes(response), {
          url,
          finalUrl: response.url,
          status: response.status,
          retrievedAt: now(),
          kind,
          contentType: response.headers.get('content-type'),
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        });
      } catch (error) {
        if (attempt < 2) continue;
        const entry = { url, status: 0, retrievedAt: now(), kind, error: error.message };
        resources.push(entry);
        return entry;
      }
    }
  }

  function take(url, { fresh = false, kind = 'source' } = {}) {
    if (fresh || !pending.has(url)) pending.set(url, request(url, kind));
    return pending.get(url);
  }
  return { root, resources, take, save };
}

export async function bytesOf(root, entry) {
  if (!entry?.file || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.file !== `objects/${entry.sha256}`)
    throw new Error('Invalid evidence reference');
  const bytes = await readFile(join(root, entry.file));
  if (sha256(bytes) !== entry.sha256) throw new Error(`Evidence hash mismatch: ${entry.url}`);
  return bytes;
}

export async function textOf(root, entry) {
  return (await bytesOf(root, entry)).toString('utf8');
}

export async function jsonOf(root, entry) {
  const bytes = await bytesOf(root, entry);
  const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_BYTES }) : bytes;
  return JSON.parse(decoded.toString('utf8'));
}

/** Read a retrieved JSON response; malformed provider bytes remain recorded evidence. */
export async function readJsonResource(store, url, options) {
  const entry = await store.take(url, options);
  if (entry.status !== 200) return { entry, value: null };
  try {
    return { entry, value: await jsonOf(store.root, entry) };
  } catch (error) {
    return { entry, value: null, error: error.message };
  }
}

export async function pool(items, concurrency, fn) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
  let next = 0;
  const result = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await fn(items[index], index);
      }
    }),
  );
  return result;
}
