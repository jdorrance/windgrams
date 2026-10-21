// HTTP entry for the forecast dataset and the small APIs beside the static pages.
// Local development does not use this module: Astro serves /data from disk.
// A host wires DATA to whatever store it has (the same get/put shape as
// forecasts/scripts/lib/store.mjs). Admin saving stays closed until a login
// provider is added.
//
//   GET /data/<key>          one published forecast document
//   /api/admin/launches      list and save launches (not configured yet)
//   GET /api/stations/<id>   a weather station's latest report (needs WU_API_KEY)

import { refresh } from "./refresh.ts";
import { serveStation } from "./stations.ts";

export interface StoredObject {
  body: Uint8Array | string;
  contentType: string;
  cacheControl?: string;
  etag: string;
  text?: () => Promise<string>;
}

export interface DatasetStore {
  get(key: string): Promise<StoredObject | { text?: () => Promise<string> } | null>;
  put(key: string, value: string, options?: { contentType?: string; cacheControl?: string }): Promise<unknown>;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DATA: DatasetStore;
  WU_API_KEY?: string;
}

// JSON documents, gzipped history lines, and the sunlight map's binary tiles.
const DATA_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.(?:json|jsonl\.gz|bin\.gz)$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function isStored(object: NonNullable<Awaited<ReturnType<DatasetStore["get"]>>>): object is StoredObject {
  return "body" in object && "etag" in object && "contentType" in object;
}

export async function serveData(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" }, { allow: "GET, HEAD" });
  if (!DATA_KEY.test(key) || key.includes("..")) return json(404, { error: "not found" });

  const object = await env.DATA.get(key);
  if (object === null || !isStored(object)) return json(404, { error: "not found" }, { "cache-control": "public, max-age=60" });

  const headers = new Headers();
  headers.set("content-type", object.contentType);
  headers.set("etag", object.etag);
  headers.set("cache-control", object.cacheControl ?? "public, max-age=300");
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");

  if (request.headers.get("if-none-match") === object.etag) return new Response(null, { status: 304, headers });
  const payload = typeof object.body === "string" ? object.body : Uint8Array.from(object.body);
  return new Response(request.method === "HEAD" ? null : payload, { headers });
}

async function admin(): Promise<Response> {
  return json(503, { error: "admin login is not configured" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/data/")) return serveData(request, env, decodeURIComponent(url.pathname.slice("/data/".length)));
    if (url.pathname === "/api/admin/launches") return admin();
    const station = /^\/api\/stations\/([^/]+)$/.exec(url.pathname);
    if (station) return serveStation(request, env, decodeURIComponent(station[1]));
    if (url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller: { scheduledTime: number }, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(refresh(env.DATA, { now: controller.scheduledTime }));
  },
};
