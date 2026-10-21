// Retries for the browser's reads of /data. A missing document is final.
// A 429 waits for Retry-After, up to 30 seconds.

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function waitMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.min(30_000, Math.max(0, when - Date.now()));
  }
  return attempt === 0 ? 500 : 1500;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last: Response | undefined;
  let error: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok || response.status === 404 || !RETRYABLE.has(response.status)) return response;
      last = response;
      error = undefined;
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") throw caught;
      last = undefined;
      error = caught;
    }
    if (attempt < 2) await sleep(waitMs(last, attempt));
  }
  if (last) return last;
  throw error;
}
