import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/lib/http.ts";

const noWait = async () => {};

test("fetchWithRetry retries a 503 and does not retry a 404", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/missing")) return new Response("no", { status: 404 });
    if (calls.filter((item) => item.endsWith("/flaky")).length < 2) {
      return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
    }
    return Response.json({ ok: true });
  };
  const missing = await fetchWithRetry("https://example.test/missing", undefined, { fetchImpl, sleep: noWait });
  assert.equal(missing.status, 404);
  assert.equal(calls.length, 1);
  const ok = await fetchWithRetry("https://example.test/flaky", undefined, { fetchImpl, sleep: noWait });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
});

test("fetchWithRetry does not retry an aborted request", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  };
  await assert.rejects(
    () => fetchWithRetry("https://example.test/x", undefined, { fetchImpl, sleep: noWait }),
    /aborted/,
  );
  assert.equal(calls, 1);
});

test("fetchWithRetry retries a dropped connection", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network down");
    return new Response("ok", { status: 200 });
  };
  const response = await fetchWithRetry("https://example.test/x", undefined, { fetchImpl, sleep: noWait });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});
