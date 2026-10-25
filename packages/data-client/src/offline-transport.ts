import { fetchWithRetry } from './http.ts';

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Read stored bytes. Serve .gz objects without Content-Encoding so their hashes remain verifiable. */
export async function readSnapshotBytes(url: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<Uint8Array> {
  const response = await fetchWithRetry(url, { signal }, { timeoutMs });
  if (!response.ok) throw new Error(`Forecast download unavailable (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
