import { test } from "node:test";
import assert from "node:assert/strict";
import { mosaic, tilesAround } from "./mosaic.mjs";
import { contextIsFresh, engineTerrain as T, measure, GLO90_SOURCE, glo90Url, mergeSiteContexts } from "../terrain.mjs";
import { parseSiteContextJson } from '@azohra/meteo.briefing/contract';

const CERVIDAE = { slug: "cervidae-peak", name: "Cervidae Peak", latitude: 43.62332, longitude: -115.98076, timeZone: "America/Boise" };

// A synthetic ridge: smooth, and different everywhere, so a misplaced pixel changes the answer.
const elevation = (lat, lon) => 1500 - 900 * Math.hypot(lat - 43.62, (lon + 115.98) * 0.72) + 40 * Math.sin(lon * 180) + 25 * Math.cos(lat * 150);

/** A GLO-30-shaped tile (1°, 1 arc-second pixels) whose values come from a function of position. */
function syntheticTile({ west, south, degrees = 1, wide = degrees, res = 1 / 3600, nodata = -32767, value = elevation, type = Float32Array }) {
  const width = Math.round(wide / res);
  const height = Math.round(degrees / res);
  const transform = [res, 0, west, 0, -res, south + degrees];
  return {
    width,
    height,
    transform,
    nodata,
    epsg: 4326,
    reads: 0,
    async readWindow(col0, row0, cols, rows) {
      this.reads += 1;
      if (col0 < 0 || row0 < 0 || col0 + cols > width || row0 + rows > height) throw new Error("read outside tile");
      const out = new type(cols * rows);
      for (let r = 0; r < rows; r += 1) {
        const lat = transform[5] + (row0 + r + 0.5) * transform[4];
        for (let c = 0; c < cols; c += 1) out[r * cols + c] = value(lat, transform[2] + (col0 + c + 0.5) * transform[0]);
      }
      return out;
    },
  };
}

test("tilesAround lists every tile the window touches", () => {
  const urls = tilesAround(T.glo30Url, CERVIDAE.latitude, CERVIDAE.longitude, 0.09, 0.13);
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.includes("N43_00_W116")));
  assert.ok(urls.some((u) => u.includes("N43_00_W117")));
});

test("mosaic reads windows across tile edges and corners", async () => {
  const value = (lat, lon) => Math.round(lat * 1000) * 100000 + Math.round((lon + 200) * 1000);
  const small = (west, south) => syntheticTile({ west, south, degrees: 1, res: 0.1, value, type: Float64Array });
  const tiles = [small(-117, 43), small(-116, 43), small(-117, 42), small(-116, 42)];
  const joined = mosaic(tiles);
  assert.equal(joined.width, 20);
  assert.equal(joined.height, 20);
  assert.deepEqual(joined.transform, [0.1, 0, -117, 0, -0.1, 44]);
  // 4x4 window centred on the shared corner (-116, 43)
  const window = await joined.readWindow(8, 8, 4, 4);
  const reference = await small(-117, 42).readWindow(0, 0, 1, 1); // just for the typed-array type
  assert.equal(window.constructor, reference.constructor);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const lat = 44 + (8 + r + 0.5) * -0.1;
      const lon = -117 + (8 + c + 0.5) * 0.1;
      assert.equal(window[r * 4 + c], value(lat, lon));
    }
  }
});

test("mosaic fills missing neighbours with nodata and refuses mismatched grids", async () => {
  const joined = mosaic([syntheticTile({ west: -116, south: 43, res: 0.1 }), syntheticTile({ west: -117, south: 42, res: 0.1 })]);
  const window = await joined.readWindow(8, 8, 4, 4);
  assert.equal(window[0], -32767); // north-west quadrant: no tile there
  assert.notEqual(window[2], -32767);
  assert.throws(() => mosaic([syntheticTile({ west: -116, south: 43, res: 0.1 }), syntheticTile({ west: -117, south: 43, res: 0.05 })]), /resolutions/);
  assert.throws(() => mosaic([syntheticTile({ west: -116, south: 43, res: 0.1 }), syntheticTile({ west: -117.03, south: 43, res: 0.1 })]), /aligned/);
});

test("mosaic joins USGS 3DEP tiles, whose stored pixel size is rounded", async () => {
  // Real header values of USGS_13_n44w116 / n44w117: 1/3" pixels, 6-pixel overlap, rounded resolution.
  const res = 9.259259269220167e-5;
  const overlap = 6 * (1 / 10800);
  const tile = (west) => syntheticTile({ west: west - overlap, south: 43 - overlap, degrees: 0.02 + 2 * overlap, wide: 1 + 2 * overlap, res });
  const joined = mosaic([tile(-116), tile(-117)]);
  assert.equal(joined.width, 10800 + Math.round((1 + 2 * overlap) / res));
  const window = await joined.readWindow(10790, 10, 20, 1);
  assert.ok(window.every((v) => Number.isFinite(v) && v !== -32767));
});

const HALF_M = Math.max(...T.RELIEF_RADII_M) + 200;

test('missing mosaic corners stay masked when source tiles have no nodata sentinel', async () => {
  const tile = (west, south) => syntheticTile({ west, south, res: .1, nodata: null, value: () => 100, type: Uint16Array });
  const joined = mosaic([tile(-116, 43), tile(-117, 42)]);
  const values = await joined.readWindow(8, 8, 4, 4);
  assert.ok(Number.isNaN(joined.nodata));
  assert.ok(Number.isNaN(values[0]));
  assert.equal(values[2], 100);
  const { window } = await T.cogWindow(joined, 43, -116, 1000);
  assert.ok(window.mask.some(value => value === 1));
  assert.ok(window.values.every((value, index) => window.mask[index] ? Number.isNaN(value) : value === 100));
});

test('coastal launch terrain excludes an absent offshore tile and still requires launch data', async () => {
  const site = { slug: 'nz-coast', latitude: -39.0651, longitude: 174.021, timeZone: 'Pacific/Auckland' };
  const missing = 'Copernicus_DSM_COG_10_S39_00_E173_00_DEM';
  const open = async url => {
    if (url.includes(missing)) throw Object.assign(new Error('No offshore tile'), { status: 404 });
    const dem = /Copernicus_DSM_COG_10_S(\d+)_00_E(\d+)_00_DEM/.exec(url);
    if (dem) return syntheticTile({ west: +dem[2], south: -dem[1], res: .001, nodata: null, value: () => 100 });
    const cover = /ESA_WorldCover_10m_2021_v200_S(\d+)E(\d+)_Map/.exec(url);
    if (cover) return syntheticTile({ west: +cover[2], south: -cover[1], degrees: 3, res: .001, nodata: 0, value: () => 30, type: Uint8Array });
    throw new Error(`Unexpected source: ${url}`);
  };
  const warnings = [];
  const document = await measure([site], { open, log: () => {}, warn: message => warnings.push(message) });
  const terrain = document.sites[site.slug].terrain;
  assert.equal(terrain.elevationM, 100);
  assert.equal(terrain.slopeDeg, 0);
  assert.ok(terrain.relief.every(disc => disc.minM === 100 && disc.maxM === 100));
  assert.match(warnings.join('\n'), /offshore|S39_00_E173/);
  assert.ok(parseSiteContextJson(JSON.stringify(document)));
  await assert.rejects(measure([site], { open: async url => {
    if (url === T.glo30Url(site.latitude, site.longitude)) throw Object.assign(new Error('Launch tile missing'), { status: 404 });
    return open(url);
  }, log: () => {}, warn: () => {} }), /Launch tile missing/);
});

test("one tile reproduces the engine's tile-edge failure at Cervidae", async () => {
  const single = syntheticTile({ west: -116, south: 43 });
  const { window, lats, lons } = await T.cogWindow(single, CERVIDAE.latitude, CERVIDAE.longitude, HALF_M);
  assert.throws(() => T.terrainFromWindow(window, lats, lons, CERVIDAE), /crosses the GLO-30 tile edge/);
});

test("joined tiles give the same terrain as one large tile", async () => {
  const joined = mosaic([syntheticTile({ west: -116, south: 43 }), syntheticTile({ west: -117, south: 43 })]);
  const big = syntheticTile({ west: -117, south: 43, wide: 2 }); // 2° wide, 1° tall
  const a = await T.cogWindow(joined, CERVIDAE.latitude, CERVIDAE.longitude, HALF_M);
  const b = await T.cogWindow(big, CERVIDAE.latitude, CERVIDAE.longitude, HALF_M);
  const fromJoined = T.terrainFromWindow(a.window, a.lats, a.lons, CERVIDAE);
  const fromBig = T.terrainFromWindow(b.window, b.lats, b.lons, CERVIDAE);
  assert.deepEqual(fromJoined, fromBig);
  assert.equal(fromJoined.relief.length, 3);
});

test("measure builds a contract-valid site-context across tile edges", async () => {
  const opened = [];
  const worldcover = (lat, lon) => ((Math.floor(lat * 400) + Math.floor(lon * 400)) % 3 === 0 ? 30 : 20);
  const open = async (url) => {
    opened.push(url);
    if (url === T.MRDEM30_URL) {
      // Canada-only DTM: Idaho projects outside it, so the pick falls back to GLO-30.
      return { width: 10, height: 10, transform: [30, 0, 0, 0, -30, 300], nodata: -32767, epsg: 3979, readWindow: async () => new Float32Array(25) };
    }
    const glo = /Copernicus_DSM_COG_10_N(\d+)_00_W(\d+)_00_DEM/.exec(url);
    if (glo) return syntheticTile({ west: -Number(glo[2]), south: Number(glo[1]) });
    const wc = /ESA_WorldCover_10m_2021_v200_N(\d+)W(\d+)_Map/.exec(url);
    if (wc) return syntheticTile({ west: -Number(wc[2]), south: Number(wc[1]), degrees: 3, res: 1 / 12000, nodata: 0, value: worldcover, type: Uint8Array });
    throw new Error(`unexpected URL ${url}`);
  };
  const fetchImpl = async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ features: [] })).buffer });
  const logs = [];
  const warnings = [];
  const document = await measure([CERVIDAE], { open, fetchImpl, log: (m) => logs.push(m), warn: (m) => warnings.push(m), generatedAt: "2026-09-29T21:00:00Z" });

  const entry = document.sites["cervidae-peak"];
  assert.deepEqual(entry.point, { latitude: CERVIDAE.latitude, longitude: CERVIDAE.longitude });
  assert.equal(entry.elevation.source, "glo30");
  assert.equal(entry.terrain.relief.length, 3);
  assert.ok(["shrubland", "grassland"].includes(entry.landCover.atLaunch));
  assert.equal(document.schemaVersion, 3);
  assert.ok(opened.some((u) => u.includes("W117")), "the western neighbour tile was read");
  assert.match(logs.join("\n"), /joined 2 tiles/);
  assert.match(warnings.join("\n"), /falls back to the GLO-30 surface model/);
});

test("contextIsFresh requires current points, usable elevation and the source policy", () => {
  const context = { generatedAt: '2026-10-24T12:00:00Z', sites: { "cervidae-peak": { point: { latitude: CERVIDAE.latitude, longitude: CERVIDAE.longitude }, elevation: { source: 'glo30', elevationM: 1500 }, terrain: { source: 'glo30' }, landCover: { source: 'worldcover2021' } } } };
  assert.equal(contextIsFresh([CERVIDAE], context), true);
  assert.equal(contextIsFresh([{ ...CERVIDAE, longitude: -115.9 }], context), false);
  assert.equal(contextIsFresh([CERVIDAE, { ...CERVIDAE, slug: "other" }], context), false);
  assert.equal(contextIsFresh([CERVIDAE], null), false);
  assert.equal(contextIsFresh([CERVIDAE], { ...context, measurementPolicies: { [CERVIDAE.slug]: 'terrain-v0:old' } }), false);
  assert.equal(contextIsFresh([CERVIDAE], { ...context, generatedAt: 'unknown' }), false);
});

test('Mexican measurements use GLO-30 across tile edges without Canadian elevation services', async () => {
  const site = { slug: 'mx-edge', name: 'Synthetic tile-edge test', latitude: 20.001, longitude: -100.001, timeZone: 'America/Mexico_City' };
  const opened = [];
  const open = async url => {
    opened.push(url);
    const dem = /Copernicus_DSM_COG_10_N(\d+)_00_W(\d+)_00_DEM/.exec(url);
    if (dem) return syntheticTile({ west: -Number(dem[2]), south: Number(dem[1]), value: () => 1800 });
    const cover = /ESA_WorldCover_10m_2021_v200_N(\d+)W(\d+)_Map/.exec(url);
    if (cover) return syntheticTile({ west: -Number(cover[2]), south: Number(cover[1]), degrees: 3, res: 1 / 12000, nodata: 0, value: () => 30, type: Uint8Array });
    throw new Error(`Unexpected source for Mexico: ${url}`);
  };
  const document = await measure([site], { open, fetchImpl: async () => { throw new Error('Mexico must skip Canadian elevation services'); }, log: () => {}, warn: () => {}, generatedAt: '2026-10-26T12:00:00Z' });
  const entry = document.sites[site.slug];
  assert.deepEqual(entry.elevation, { source: 'glo30', elevationM: 1800 });
  assert.equal(entry.terrain.source, 'glo30');
  assert.equal(entry.terrain.slopeDeg, 0);
  assert.equal(entry.landCover.source, 'worldcover2021');
  assert.equal(entry.landCover.atLaunch, 'grassland');
  assert.equal(opened.filter(url => url.includes('copernicus-dem-30m')).length, 4);
  assert.equal(document.measurementPolicies[site.slug], 'terrain-v1:glo30');
  assert.ok(parseSiteContextJson(JSON.stringify(document)));
  assert.equal(contextIsFresh([site], document), true);
  assert.equal(contextIsFresh([site], { ...document, measurementPolicies: { [site.slug]: 'terrain-v1:regional-north-america' } }), false);
  assert.equal(contextIsFresh([site], { ...document, sites: { [site.slug]: { ...entry, elevation: { ...entry.elevation, source: 'mrdem30' } } } }), false);
});

test('Armenian measurements consistently use 90 m DEM tiles across tile edges', async () => {
  const site = { slug: 'am-edge', name: 'Synthetic tile-edge test', latitude: 40.001, longitude: 44.001, timeZone: 'Asia/Yerevan' };
  const opened = [];
  // A plane rising 1 m per 10 m east and 1 m per 20 m north has an analytic
  // slope and aspect, independent of the DEM pixel spacing or mosaic boundaries.
  const planarHeight = (lat, lon) => 1800 + (lon - site.longitude) * T.mPerDegLon(site.latitude) * 0.1 + (lat - site.latitude) * T.M_PER_DEG_LAT * 0.05;
  const open = async url => {
    opened.push(url);
    const dem = /Copernicus_DSM_COG_30_N(\d+)_00_E(\d+)_00_DEM/.exec(url);
    if (dem) return syntheticTile({ west: +dem[2], south: +dem[1], res: 1 / 1200, value: planarHeight, type: Float64Array });
    const cover = /ESA_WorldCover_10m_2021_v200_N(\d+)E(\d+)_Map/.exec(url);
    if (cover) return syntheticTile({ west: +cover[2], south: +cover[1], degrees: 3, res: 1 / 12000, nodata: 0, value: () => 30, type: Uint8Array });
    throw new Error(`Unexpected source for Armenia: ${url}`);
  };
  const document = await measure([site], { open, fetchImpl: async () => { throw new Error('Armenia must skip Canadian elevation services'); }, log: () => {}, warn: () => {}, generatedAt: '2026-10-24T12:00:00Z' });
  const entry = document.sites[site.slug];
  assert.equal(entry.elevation.source, 'glo90');
  assert.equal(entry.elevation.elevationM, 1800);
  assert.equal(entry.terrain.source, 'glo90');
  assert.equal(entry.terrain.elevationM, 1800);
  assert.equal(entry.terrain.slopeDeg, 6.4);
  assert.equal(entry.terrain.aspectDeg, 243);
  assert.equal(entry.landCover.atLaunch, 'grassland');
  assert.ok(entry.landCover.fractions.every(disc => disc.byClass.grassland === 1));
  assert.equal(opened.filter(url => url.includes('copernicus-dem-90m')).length, 4);
  assert.ok(opened.every(url => !url.includes('copernicus-dem-30m')));
  assert.deepEqual(document.sources.find(source => source.id === 'glo90'), GLO90_SOURCE);
  assert.equal(document.sources.some(source => source.id === 'glo30'), false);
  assert.ok(parseSiteContextJson(JSON.stringify(document)));
  assert.equal(glo90Url(40.3, 44.7), 'https://copernicus-dem-90m.s3.eu-central-1.amazonaws.com/Copernicus_DSM_COG_30_N40_00_E044_00_DEM/Copernicus_DSM_COG_30_N40_00_E044_00_DEM.tif');
});

test('incremental terrain sync preserves US measurements and credits new Armenian sources', () => {
  const am = { slug: 'am-hatis', latitude: 40.3, longitude: 44.7 };
  const point = site => ({ latitude: site.latitude, longitude: site.longitude });
  const contextEntry = (site, source, elevationM) => ({
    point: point(site), elevation: { source, elevationM },
    terrain: { source, elevationM, slopeDeg: 10, aspectDeg: 180, relief: [{ radiusKm: 1, minM: elevationM - 100, maxM: elevationM + 100, percentile: 50 }] },
    landCover: { source: 'worldcover2021', atLaunch: 'grassland', fractions: [{ radiusKm: 1, byClass: { grassland: 1 } }] },
  });
  const original = { schemaVersion: 3, generatedAt: '2026-10-21T00:00:00Z', sources: [T.SOURCES.glo30, T.SOURCES.worldcover2021], sites: {
    [CERVIDAE.slug]: contextEntry(CERVIDAE, 'glo30', 1500), removed: contextEntry({ latitude: 43, longitude: -116 }, 'glo30', 1400),
  } };
  const measured = { schemaVersion: 3, generatedAt: '2026-10-24T12:00:00Z', sources: [GLO90_SOURCE, T.SOURCES.worldcover2021], sites: { [am.slug]: contextEntry(am, 'glo90', 2200) } };
  const before = structuredClone(original);
  const merged = mergeSiteContexts([CERVIDAE, am], original, measured);
  assert.deepEqual(original, before);
  assert.deepEqual(merged.sites[CERVIDAE.slug], original.sites[CERVIDAE.slug]);
  assert.deepEqual(merged.sites[am.slug], measured.sites[am.slug]);
  assert.equal(merged.sites.removed, undefined);
  assert.equal(new Set(merged.sources.map(source => source.id)).size, 3);
  assert.equal(merged.generatedAt, measured.generatedAt);
  assert.ok(parseSiteContextJson(JSON.stringify(merged)));
  assert.deepEqual(mergeSiteContexts([am], null, measured).sites, measured.sites);
  assert.equal(merged.measurementTimes[CERVIDAE.slug], original.generatedAt);
  assert.equal(merged.measurementTimes[am.slug], measured.generatedAt);
  assert.equal(merged.measurementPolicies[am.slug], 'terrain-v1:glo90');
  assert.throws(() => mergeSiteContexts([{ ...am, latitude: 40.4 }], original, measured), /Missing current terrain measurement/);
  assert.throws(() => mergeSiteContexts([CERVIDAE, am], null, measured), /Missing current terrain measurement/);
});
