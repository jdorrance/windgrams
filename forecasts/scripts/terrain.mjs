// Measures each launch's terrain context (site-context.json) and, with
// --sync, keeps the published copy in step with the published sites.json.
//
// This replaces `meteo forecast terrain --sync` for launches near a map-tile
// edge: it runs the engine's own measurement functions (same sources, same
// maths, same document) on tiles joined by scripts/lib/mosaic.mjs, because
// engine 0.6.0 cannot read across a tile edge. Remove it once the engine
// stitches tiles itself.
//
// Usage:
//   node scripts/terrain.mjs --sync                           publish via WINDGRAMS_STORE (default: file)
//   node scripts/terrain.mjs --sites sites.json --output site-context.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseSites, roundDocument } from "@azohra/meteo.forecast";
import { parseSiteContextJson, parseSitesCatalogueJson } from "@azohra/meteo.briefing/contract";
import { cachingOpen, retryingFetch } from "./lib/http.mjs";
import { storeFromEnv } from "./lib/store.mjs";
import { mosaic, tilesAround } from "./lib/mosaic.mjs";
import { terrainPolicy, terrainPolicyId, terrainSourcesMatchPolicy } from "./lib/terrain-policy.mjs";

// The engine's terrain module is not part of its public exports; load it by path.
const engineDir = dirname(createRequire(import.meta.url).resolve("@azohra/meteo.forecast/package.json"));
export const engineTerrain = await import(pathToFileURL(join(engineDir, "dist/terrain.js")).href);
const T = engineTerrain;
export const GLO90_SOURCE = Object.freeze({
  ...T.SOURCES[T.GLO30_ID], id: 'glo90', product: 'Copernicus GLO-90 DEM', resolutionM: 90,
  attribution: T.SOURCES[T.GLO30_ID].attribution.replace('WorldDEM-30', 'WorldDEM-90'),
});
// The public GLO-30 release omits Armenia. Use the complete GLO-90 release
// consistently across each terrain window, including neighbouring border tiles.
export const usesGlo90 = site => terrainPolicy(site) === 'glo90';
export const glo90Url = (latitude, longitude) => T.glo30Url(latitude, longitude)
  .replace('copernicus-dem-30m', 'copernicus-dem-90m').replaceAll('DSM_COG_10_', 'DSM_COG_30_');

/**
 * Measures the terrain context for `sites` exactly as the engine does, reading
 * windows that may span several tiles.
 */
export async function measure(sites, { open = T.openCog, fetchImpl = globalThis.fetch, log = console.log, warn = console.error, generatedAt } = {}) {
  // A rejected open used to stay in the map, so one timeout failed every later
  // read of that tile. Retry, and remember the URL only when it succeeds.
  const openOnce = cachingOpen(open);
  const fetchRetry = retryingFetch(fetchImpl);

  async function windowAround(urlOf, site, halfM) {
    const dLat = halfM / T.M_PER_DEG_LAT;
    const dLon = halfM / T.mPerDegLon(site.latitude);
    const centre = urlOf(site.latitude, site.longitude);
    const urls = tilesAround(urlOf, site.latitude, site.longitude, dLat, dLon);
    const results = await Promise.allSettled(urls.map(openOnce));
    const failed = urls.filter((_, i) => results[i].status === "rejected");
    if (failed.includes(centre)) throw results[urls.indexOf(centre)].reason;
    const tiles = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (failed.length > 0) {
      if (tiles[0].nodata === null) throw new Error(`${site.slug}: neighbouring tile(s) unavailable (${failed.join(", ")}) and the source declares no nodata value`);
      warn(`WARN ${site.slug}: neighbouring tile(s) unavailable, treated as no data: ${failed.join(", ")}`);
    }
    if (tiles.length > 1) log(`${site.slug}: joined ${tiles.length} tiles for a ${Math.round(halfM / 1000)} km window`);
    return T.cogWindow(mosaic(tiles), site.latitude, site.longitude, halfM);
  }

  const terrainCache = new Map();
  const terrainOf = async (site) => {
    if (terrainCache.has(site.slug)) return terrainCache.get(site.slug);
    const { window, lats, lons } = await windowAround(usesGlo90(site) ? glo90Url : T.glo30Url, site, Math.max(...T.RELIEF_RADII_M) + 200);
    const terrain = T.terrainFromWindow(window, lats, lons, site);
    if (usesGlo90(site)) terrain.source = GLO90_SOURCE.id;
    terrainCache.set(site.slug, terrain);
    return terrain;
  };
  const elevationOf = async (site) =>
    terrainPolicy(site) !== 'regional-north-america' ? { source: usesGlo90(site) ? GLO90_SOURCE.id : T.GLO30_ID, elevationM: (await terrainOf(site)).elevationM } : T.pickElevation(
      async (url) => T.projectedPoint(await openOnce(url), site.latitude, site.longitude),
      await T.lidarbcUrls(site.latitude, site.longitude, fetchRetry),
    );
  const landCoverOf = async (site) => {
    const { window, lats, lons } = await windowAround(T.worldcoverUrl, site, Math.max(...T.LAND_COVER_RADII_M) + 100);
    return T.landCoverFromWindow(window, lats, lons, site);
  };

  const stamp = generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const document = roundDocument(await T.buildDocument(sites, { terrainOf, elevationOf, landCoverOf, generatedAt: stamp, log, warn }));
  if (sites.some(usesGlo90)) document.sources.push(GLO90_SOURCE);
  if (parseSiteContextJson(JSON.stringify(document)) === null) throw new Error("the measured site-context.json fails the reader contract");
  document.measurementPolicies = Object.fromEntries(sites.map(site => [site.slug, terrainPolicyId(site)]));
  document.measurementTimes = Object.fromEntries(sites.map(site => [site.slug, stamp]));
  return document;
}

/** Same catalogued points, usable elevations and compatible source policies. */
export function contextIsFresh(sites, context) {
  return context !== null && sites.every((site) => {
    const entry = context.sites?.[site.slug], point = entry?.point;
    return point !== undefined && point.latitude === site.latitude && point.longitude === site.longitude
      && Number.isFinite(entry.elevation?.elevationM) && terrainSourcesMatchPolicy(entry, site)
      && (context.measurementPolicies?.[site.slug] === undefined || context.measurementPolicies[site.slug] === terrainPolicyId(site))
      && Number.isFinite(Date.parse(context.measurementTimes?.[site.slug] ?? context.generatedAt));
  });
}

/** Add provenance to verified legacy entries without redating retained measurements. */
export function stampTerrainContext(context, sites) {
  if (!contextIsFresh(sites, context)) throw new Error('Missing current terrain measurement');
  return { ...context,
    measurementPolicies: { ...context.measurementPolicies, ...Object.fromEntries(sites.map(site => [site.slug, terrainPolicyId(site)])) },
    measurementTimes: { ...context.measurementTimes, ...Object.fromEntries(sites.map(site => [site.slug, context.measurementTimes?.[site.slug] ?? context.generatedAt])) },
  };
}

/** Keep measured and retained launch contexts together, with every source credited. */
export function mergeSiteContexts(cataloguedSites, context, measured) {
  const sources = new Map([...(context?.sources ?? []), ...measured.sources].map(source => [source.id, source]));
  const sites = Object.fromEntries(cataloguedSites.map(site => {
    const entry = measured.sites[site.slug] ?? context?.sites[site.slug];
    if (!entry || entry.point?.latitude !== site.latitude || entry.point?.longitude !== site.longitude) {
      throw new Error(`Missing current terrain measurement: ${site.slug}`);
    }
    return [site.slug, entry];
  }));
  const policies = { ...context?.measurementPolicies, ...measured.measurementPolicies };
  const times = Object.fromEntries(cataloguedSites.map(site => [site.slug, measured.sites[site.slug]
    ? measured.measurementTimes?.[site.slug] ?? measured.generatedAt
    : context.measurementTimes?.[site.slug] ?? context.generatedAt]));
  const document = stampTerrainContext({ ...measured, sources: [...sources.values()], sites, measurementPolicies: policies, measurementTimes: times }, cataloguedSites);
  if (!parseSiteContextJson(JSON.stringify(document))) throw new Error('Merged site-context.json fails the reader contract');
  return document;
}

const serialize = (document) => Buffer.from(`${JSON.stringify(document, null, 2)}\n`);

async function main() {
  const { values: args } = parseArgs({
    options: { sync: { type: "boolean", default: false }, sites: { type: "string" }, output: { type: "string" } },
  });

  if (args.sync) {
    const store = storeFromEnv();
    const sitesBytes = await store.get("sites.json");
    if (sitesBytes === null) throw new Error("no sites.json is published yet; run the publish:sites step first");
    const catalogue = parseSitesCatalogueJson(sitesBytes.toString("utf-8"));
    if (catalogue === null) throw new Error("the published sites.json fails the contract guard");
    const contextBytes = await store.get("site-context.json");
    const context = contextBytes === null ? null : (parseSiteContextJson(contextBytes.toString("utf-8")) ? JSON.parse(contextBytes.toString("utf-8")) : null);
    if (contextIsFresh(catalogue.sites, context)) {
      console.log("site-context.json is up to date");
      return;
    }
    const pending = catalogue.sites.filter(site => !contextIsFresh([site], context));
    const measured = await measure(pending);
    const document = mergeSiteContexts(catalogue.sites, context, measured);
    await store.put("site-context.json", serialize(document));
    console.log(`Measured terrain for ${pending.length} launch(es) and published site-context.json`);
    return;
  }

  if (!args.sites) throw new Error("usage: node scripts/terrain.mjs --sync | --sites sites.json [--output site-context.json]");
  const sitesPath = resolve(args.sites);
  const sites = parseSites(readFileSync(sitesPath, "utf-8"), sitesPath);
  const document = await measure(sites);
  const output = resolve(args.output ?? join(dirname(sitesPath), "site-context.json"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, serialize(document));
  console.log(`Wrote terrain context for ${sites.length} launch(es) to ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
