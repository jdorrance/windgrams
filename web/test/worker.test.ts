import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type Env } from "../worker/index.ts";

/** In-memory dataset store. Conditional requests are handled by serveData, not the store. */
function fakeBucket(objects: Record<string, { body: string; contentType: string; cacheControl?: string }>) {
  const requested: string[] = [];
  return {
    requested,
    async get(key: string) {
      requested.push(key);
      const object = objects[key];
      if (!object) return null;
      return { body: object.body, contentType: object.contentType, cacheControl: object.cacheControl, etag: `"${key.length}"` };
    },
  };
}

function env(bucket = fakeBucket({}), extra: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("static page", { status: 200 }) },
    DATA: bucket as unknown as Env["DATA"],
    ...extra,
  };
}

const request = (path: string, init?: RequestInit) => new Request(`https://example.com${path}`, init);

test("serves dataset documents from the store with their metadata", async () => {
  const bucket = fakeBucket({
    "hrrr-conus/sites/cervidae-peak.json": { body: '{"ok":true}', contentType: "application/json", cacheControl: "public, max-age=300" },
  });
  const response = await worker.fetch(request("/data/hrrr-conus/sites/cervidae-peak.json"), env(bucket));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { ok: true });
});

test("serves the sunlight map's binary tiles with their long cache", async () => {
  const bucket = fakeBucket({
    "solar/cervidae-peak/0a1b2c3d4e5f/14/2915/5975.bin.gz": { body: "tile", contentType: "application/octet-stream", cacheControl: "public, max-age=31536000, immutable" },
  });
  const response = await worker.fetch(request("/data/solar/cervidae-peak/0a1b2c3d4e5f/14/2915/5975.bin.gz"), env(bucket));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await response.text(), "tile");
  const other = await worker.fetch(request("/data/solar/cervidae-peak/tile.bin"), env(bucket));
  assert.equal(other.status, 404);
});

test("answers 304 when the client already has the object", async () => {
  const bucket = fakeBucket({ "runs.json": { body: "{}", contentType: "application/json" } });
  const response = await worker.fetch(request("/data/runs.json", { headers: { "if-none-match": '"9"' } }), env(bucket));
  assert.equal(response.status, 304);
  assert.equal(response.body, null);
});

test('serves compressed regional profiles through the dataset-store route', async () => {
  const key = 'soaring/v1/armenia-icon-eu-live/bundles/abc123/cell-17.json.gz';
  const bucket = fakeBucket({ [key]: { body: 'compressed profile', contentType: 'application/gzip' } });
  const response = await worker.fetch(request(`/data/${key}`), env(bucket));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/gzip');
  assert.equal(await response.text(), 'compressed profile');
  assert.deepEqual(bucket.requested, [key]);
});

test("rejects keys outside the dataset shape without touching the store", async () => {
  const bucket = fakeBucket({});
  // "/data/../x" is normalized away by URL parsing before the Worker sees it; the
  // encoded forms below do reach it and must still be refused.
  for (const path of ["/data/gfs%2F..%2Fsecret.json", "/data/.env", "/data/notes.txt", "/data/", "/data/a//b.json", "/data/%2Fetc%2Fpasswd.json"]) {
    const response = await worker.fetch(request(path), env(bucket));
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(bucket.requested, []);
  const normalized = await worker.fetch(request("/data/../secret.json"), env(bucket));
  assert.equal(await normalized.text(), "static page");
  assert.deepEqual(bucket.requested, []);
  const missing = await worker.fetch(request("/data/gfs/manifest.json"), env(bucket));
  assert.equal(missing.status, 404);
  const post = await worker.fetch(request("/data/runs.json", { method: "POST" }), env(bucket));
  assert.equal(post.status, 405);
});

test("admin API stays closed until a login provider is configured", async () => {
  const response = await worker.fetch(request("/api/admin/launches"), env());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "admin login is not configured" });
});

test("other paths fall through to the static site; unknown API paths are 404", async () => {
  assert.equal(await (await worker.fetch(request("/launches/cervidae-peak"), env())).text(), "static page");
  assert.equal((await worker.fetch(request("/api/other"), env())).status, 404);
});

test("routes /api/stations/<id> to the station feed", async () => {
  const response = await worker.fetch(request("/api/stations/KIDBOISE863"), env());
  assert.equal(response.status, 404); // the committed catalog lists no stations
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.equal((await worker.fetch(request("/api/stations/NOPE1"), env())).status, 404);
});
