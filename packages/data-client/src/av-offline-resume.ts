/** Bounded checkpoints for validated immutable AV JSON; committed slots own their own inventory. */
import { z } from 'zod';
import { avSha256, MAX_BODY_BYTES } from './av-client.ts';
import type { SnapshotObjectStore } from './offline-types.ts';

export const AV_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const AV_SNAPSHOT_MAX_FILES = 1024;
export const AV_RESUME_KEY = 'av/resume.json';
const MAX_JOURNAL_BYTES = 1024 * 1024;
const CHECKPOINT_RESPONSES = 8;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.strictObject({ url: z.string().max(4096), sha256: digest,
  bytes: z.number().int().positive().max(MAX_BODY_BYTES), expiresAt: z.iso.datetime() });
const journalSchema = z.strictObject({ version: z.literal(1), entries: z.array(entrySchema).max(AV_SNAPSHOT_MAX_FILES), id: digest });
type Entry = z.infer<typeof entrySchema>;
const blobKey = (hash: string) => `av/objects/${hash}`;
function immutable(url: string): boolean {
  try { return /\/v1\/models\/(?:gfs|icon-eu|rrfs)\/runs\/[^/]+\/(?:profile|samples)$/.test(new URL(url, 'https://resume.invalid').pathname); }
  catch { return false; }
}

export function createAvResumeJournal(store: SnapshotObjectStore, now: () => number) {
  let pending: Promise<Map<string, Entry>> | undefined, dirty = false, changes = 0;
  const entries = () => pending ??= (async () => {
    const bytes = await store.get(AV_RESUME_KEY);
    if (!bytes) return new Map<string, Entry>();
    let value: z.infer<typeof journalSchema> | undefined;
    if (bytes.length <= MAX_JOURNAL_BYTES) {
      try {
        const parsed = journalSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        if (parsed.success) value = parsed.data;
      } catch { /* Invalid checkpoints are replaced by validated network reads. */ }
    }
    if (!value || value.entries.reduce((sum, entry) => sum + entry.bytes, 0) > AV_SNAPSHOT_MAX_BYTES
      || new Set(value.entries.map(entry => entry.url)).size !== value.entries.length
      || value.entries.some(entry => !immutable(entry.url))
      || await avSha256(encode({ version: 1, entries: value.entries })) !== value.id) {
      await store.remove(AV_RESUME_KEY);
      return new Map<string, Entry>();
    }
    const live = value.entries.filter(entry => Date.parse(entry.expiresAt) > now());
    dirty = live.length !== value.entries.length;
    return new Map(live.map(entry => [entry.url, entry]));
  })();
  async function flush() {
    if (!pending || !dirty) return;
    const map = await pending, payload = { version: 1 as const, entries: [...map.values()] };
    const bytes = encode({ ...payload, id: await avSha256(encode(payload)) });
    if (bytes.length > MAX_JOURNAL_BYTES) throw new Error('AV resume journal exceeds byte budget');
    await store.put(AV_RESUME_KEY, bytes);
    dirty = false; changes = 0;
  }
  return {
    async response(url: string, signal?: AbortSignal): Promise<Response | null> {
      signal?.throwIfAborted();
      if (!immutable(url)) return null;
      const map = await entries(), entry = map.get(url);
      if (!entry) return null;
      if (Date.parse(entry.expiresAt) <= now()) { map.delete(url); dirty = true; return null; }
      const bytes = await store.get(blobKey(entry.sha256));
      signal?.throwIfAborted();
      if (!bytes || bytes.length !== entry.bytes || await avSha256(bytes) !== entry.sha256) {
        map.delete(url); dirty = true; return null;
      }
      signal?.throwIfAborted();
      map.delete(url); map.set(url, entry); dirty = true;
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: {
        etag: `"${entry.sha256}"`, 'content-length': String(entry.bytes), 'content-type': 'application/json'
      } });
    },
    async remember(entry: Entry) {
      if (!immutable(entry.url) || entry.url.length > 4096) return;
      entrySchema.parse(entry);
      const map = await entries();
      map.delete(entry.url); map.set(entry.url, entry); dirty = true;
      let bytes = [...map.values()].reduce((sum, value) => sum + value.bytes, 0);
      while (map.size > AV_SNAPSHOT_MAX_FILES || bytes > AV_SNAPSHOT_MAX_BYTES) {
        const oldest = map.keys().next().value!;
        bytes -= map.get(oldest)!.bytes; map.delete(oldest);
      }
      if (++changes >= CHECKPOINT_RESPONSES) await flush();
    },
    flush,
  };
}
