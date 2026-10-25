// Retry transient HTTP failures and network errors. Return 404 responses immediately.
// Honor Retry-After with a maximum wait of 30 seconds.

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

export interface FetchRetryOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** Abort a backoff promptly; release its timer and signal listener on either outcome. */
function waitForRetry(ms: number, signal: AbortSignal | null | undefined, sleep?: (ms: number) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      settle();
    };
    const abort = () => finish(() => reject(signal?.reason));
    signal?.addEventListener('abort', abort, { once: true });
    if (sleep) Promise.resolve().then(() => sleep(ms)).then(() => finish(resolve), error => finish(() => reject(error)));
    else timer = setTimeout(() => finish(resolve), ms);
  });
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  deps: FetchRetryOptions = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let last: Response | undefined;
  let error: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? 15_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const response = await fetchImpl(url, { ...init, signal });
      if (response.ok || response.status === 404 || !RETRYABLE.has(response.status)) return response;
      last = response;
      error = undefined;
    } catch (caught) {
      // A stalled feed must not leave every launch chart waiting indefinitely.
      if (signal.aborted) throw signal.reason;
      if (caught instanceof Error && caught.name === "AbortError") throw caught;
      last = undefined;
      error = caught;
    }
    if (attempt < 2) {
      // A retry replaces this response; release an unread body before the next request.
      void last?.body?.cancel().catch(() => {});
      await waitForRetry(waitMs(last, attempt), init?.signal, deps.sleep);
    }
  }
  if (last) return last;
  throw error;
}
