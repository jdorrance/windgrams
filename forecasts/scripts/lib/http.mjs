// Shared HTTP retry for the forecast scripts. The meteo CLI retries its own
// GRIB downloads; this covers the reads those scripts make themselves
// (terrain tiles, and copying an already published dataset).

export const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait hinted by Retry-After, otherwise `fallback`. Capped at 30s. */
export function retryAfterMs(header, fallback) {
  if (header == null || header === "") return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.min(30_000, Math.max(0, when - Date.now()));
  return fallback;
}

/** A missing object. Retried reads must not keep asking for one. */
export function isMissing(error) {
  const status = error?.status ?? error?.statusCode;
  if (status === 404) return true;
  return /\b404\b|not found/i.test(String(error?.message ?? error));
}

/**
 * Runs `fn` up to `attempts` times. A missing object (404) is not retried.
 * `delayMs` is the first wait; each later wait is one step longer.
 */
export async function withRetries(fn, { attempts = 3, delayMs = 2000, sleepImpl = sleep } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (isMissing(error) || attempt === attempts - 1) throw error;
      await sleepImpl(delayMs * (attempt + 1));
    }
  }
  throw last;
}

/**
 * Opens each URL once. A success is remembered. A failure is forgotten, so
 * the next call can try again instead of replaying a timed-out promise.
 * Concurrent callers of the same URL share one attempt.
 */
export function cachingOpen(open, options = {}) {
  const opened = new Map();
  return (url) => {
    const pending = opened.get(url);
    if (pending) return pending;
    const attempt = withRetries(() => open(url), options).catch((error) => {
      opened.delete(url);
      throw error;
    });
    opened.set(url, attempt);
    return attempt;
  };
}

/**
 * fetch that retries network errors and 429/5xx. A 404 is returned as-is.
 * The last response is returned when every attempt got an HTTP status, so
 * the caller can still read the body.
 */
export function retryingFetch(fetchImpl = globalThis.fetch, { attempts = 4, delayMs = 2000, sleepImpl = sleep } = {}) {
  return async function get(url, init) {
    let lastResponse = null;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, init);
        if (response.ok || response.status === 404 || !RETRYABLE.has(response.status)) return response;
        lastResponse = response;
        lastError = new Error(`answered ${response.status}`);
      } catch (error) {
        lastResponse = null;
        lastError = error;
      }
      if (attempt === attempts - 1) break;
      const header = typeof lastResponse?.headers?.get === "function" ? lastResponse.headers.get("retry-after") : null;
      await sleepImpl(retryAfterMs(header, delayMs * (attempt + 1)));
    }
    if (lastResponse) return lastResponse;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}
