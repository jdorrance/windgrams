import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { SCHEMA_VERSION, ALGORITHM_VERSION, DEFAULT_RADIUS_KM, DEFAULT_MAX_DISTANCE_KM, MAX_ZOOM, MIN_ZOOM, TILE_SIZE, AZIMUTHS_DEG, DEG, HORIZON_CELLS, HORIZON_BORDER, HORIZON_STEP_DEG, round } from './constants.ts';
import { domainOf, blocksOf, lonToX, latToY, sampleGrid } from './grid.ts';
import { surfaceLevel } from './surface.ts';
import { traceHorizons, fillSkyView, horizonsAtPixel } from './horizon.ts';
import { halveLevel, tileRange, encodeTile } from './encoding.ts';
import { reliefFrame, fillRelief, encodeRelief } from './relief.ts';
import type { SolarSite, SolarDomainOptions, SolarTerrainOptions, SolarTerrainBuild, SolarTerrainProduct, SolarTerrainIndex, TerrainTile, TerrainDomain, ElevationGrid, TerrainSources } from './types.ts';
import { object } from '../json.ts';
// ── Whole product ───────────────────────────────────────────────────────────

/** Short content id for a set of inputs; part of the tile path so tiles can be cached forever. */
export function generationOf(inputs: SolarTerrainIndex['inputs']): string {
  return createHash("sha256").update(JSON.stringify({ ...inputs, schemaVersion: SCHEMA_VERSION })).digest("hex").slice(0, 12);
}



/**
 * Starts building one launch's tiles, block by block, so a large area never
 * has to be in memory at once:
 *
 *   const build = startSolarTerrain(site, { coarse, sources, radiusKm or area, maxDistanceKm });
 *   for (const block of build.blocks) tiles = build.addBlock(block, fineGridCoveringTheBlock);
 *   const { index, relief } = build.finish();
 *
 * `area` ({ name, south, west, north, east }) replaces the square of `radiusKm`
 * around the launch; the launch must be inside it.
 */
export function startSolarTerrain(site: SolarSite, { coarse, sources, radiusKm = DEFAULT_RADIUS_KM, area, maxDistanceKm = DEFAULT_MAX_DISTANCE_KM, log = () => {} }: SolarTerrainOptions): SolarTerrainBuild {
  const inputs: SolarTerrainIndex['inputs'] = {
    latitude: site.latitude,
    longitude: site.longitude,
    ...(area ? { area } : { radiusKm }),
    maxDistanceKm,
    algorithmVersion: ALGORITHM_VERSION,
    sources: Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.id])) as SolarTerrainIndex['inputs']['sources'],
  };
  const generation = generationOf(inputs);
  const domain = domainOf(site, { radiusKm, area });
  const LX = Math.floor(lonToX(site.longitude, MAX_ZOOM));
  const LY = Math.floor(latToY(site.latitude, MAX_ZOOM));
  if (LX < domain.x0 || LX >= domain.x1 || LY < domain.y0 || LY >= domain.y1) throw new Error(`${site.slug}: the launch is outside its sunlight area`);
  const blocks = blocksOf(domain);
  const blockKey = ({ x0, y0, x1, y1 }: TerrainDomain) => `${x0}/${y0}/${x1}/${y1}`;
  const pendingBlocks = new Set(blocks.map(blockKey));
  const blockCount = pendingBlocks.size;
  log(`${site.slug}: ${(domain.x1 - domain.x0) / TILE_SIZE} x ${(domain.y1 - domain.y0) / TILE_SIZE} tiles at zoom ${MAX_ZOOM}${blocks.length > 1 ? `, in ${blocks.length} blocks` : ""}`);

  const frame = reliefFrame(domain);
  const ranges: Record<string, [number, number, number, number]> = {};
  let count = 0, bytes = 0, rawBytes = 0, elevationSum = 0, elevationCount = 0;
  let launch: SolarTerrainIndex['launch'] = null;

  function addBlock(block: TerrainDomain, fine: ElevationGrid): TerrainTile[] {
    const key = blockKey(block);
    const completed = pendingBlocks.has(key) ? [key]
      : key === blockKey(domain) && pendingBlocks.size === blockCount ? [...pendingBlocks] : null;
    if (!completed) throw new Error(`${site.slug}: terrain block is outside this build or already completed`);
    const label = blockCount > 1 ? `${site.slug} block ${blockCount - pendingBlocks.size + 1}/${blockCount}` : site.slug;
    let t = Date.now();
    const { level: top, elevationSum: sum, elevationCount: n } = surfaceLevel(fine, block);
    elevationSum += sum;
    elevationCount += n;
    log(`${label}: surface normals in ${Date.now() - t} ms`);
    t = Date.now();
    const horizonGrid = traceHorizons(coarse, domain, { maxDistanceM: maxDistanceKm * 1000, block, log });
    log(`${label}: horizons for ${horizonGrid.width * horizonGrid.height} cells in ${Math.round((Date.now() - t) / 1000)} s`);
    t = Date.now();
    fillSkyView(top, horizonGrid);
    log(`${label}: sky-view factor in ${Math.round((Date.now() - t) / 1000)} s`);

    const levels = [top];
    while (levels[0].z > MIN_ZOOM) levels.unshift(halveLevel(levels[0]));
    const tiles = [];
    for (const level of levels) {
      const [x0, y0, x1, y1] = tileRange(level);
      const r = ranges[level.z];
      ranges[level.z] = r ? [Math.min(r[0], x0), Math.min(r[1], y0), Math.max(r[2], x1), Math.max(r[3], y1)] : [x0, y0, x1, y1];
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const { bytes: raw, valid } = encodeTile(level, horizonGrid, x, y);
          if (valid === 0) continue;
          rawBytes += raw.length;
          tiles.push({ z: level.z, x, y, body: gzipSync(raw, { level: 9 }) });
        }
      }
    }
    count += tiles.length;
    bytes += tiles.reduce((s, tile) => s + tile.body.length, 0);
    fillRelief(frame, fine, block);

    // The launch itself, for checks and for the page.
    if (LX >= block.x0 && LX < block.x1 && LY >= block.y0 && LY < block.y1) {
      const o = (LY - top.y0) * top.width + (LX - top.x0);
      const horizons = horizonsAtPixel(horizonGrid, LX, LY, new Float32Array(AZIMUTHS_DEG.length));
      launch = {
        elevationM: round(sampleGrid(fine, site.latitude, site.longitude), 1),
        slopeDeg: round(Math.acos(Math.min(1, top.nz[o])) / DEG, 1),
        aspectDeg: round((Math.atan2(top.nx[o], top.ny[o]) / DEG + 360) % 360, 0),
        skyViewFactor: round(top.svf[o], 3),
        horizonDeg: Array.from(horizons, (h) => round(h, 1)),
      };
    }
    for (const completedKey of completed) pendingBlocks.delete(completedKey);
    return tiles;
  }

  function finish({ generatedAt }: { generatedAt?: string } = {}): SolarTerrainProduct {
    if (pendingBlocks.size) throw new Error(`${site.slug}: ${pendingBlocks.size} block(s) not built`);
    log(`${site.slug}: ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB compressed (${(rawBytes / 1e6).toFixed(0)} MB raw)`);
    const relief = encodeRelief(frame, generation);
    log(`${site.slug}: relief ${relief.meta.width} x ${relief.meta.height} at zoom ${relief.meta.zoom}, ${relief.meta.minM}–${relief.meta.maxM} m, ${(relief.body.length / 1e3).toFixed(0)} kB`);
    const index: SolarTerrainIndex = {
      schemaVersion: SCHEMA_VERSION,
      slug: site.slug,
      generatedAt: generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      generation,
      inputs,
      sources,
      bounds: { south: round(domain.bounds.south, 6)!, west: round(domain.bounds.west, 6)!, north: round(domain.bounds.north, 6)!, east: round(domain.bounds.east, 6)! },
      referenceElevationM: round(elevationCount > 0 ? elevationSum / elevationCount : Number.NaN, 0),
      tiles: {
        path: `${generation}/{z}/{x}/{y}.bin.gz`,
        size: TILE_SIZE,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        ranges,
        count,
        bytes,
      },
      encoding: {
        planes: ["nx", "ny", "nz", "svf"],
        normal: "nx, ny: byte / 127.5 - 1 (east, north components); nz, svf: byte / 255; nz = 0 marks no data",
        horizonCells: HORIZON_CELLS,
        horizonBorder: HORIZON_BORDER,
        azimuthsDeg: AZIMUTHS_DEG,
        horizonStepDeg: HORIZON_STEP_DEG,
        delta: "row",
        compression: "gzip",
      },
      launch,
      relief: relief.meta,
    };
    return { index, relief };
  }

  return { domain, blocks, generation, addBlock, finish };
}

/**
 * Builds every tile and the index for one launch from elevation grids that
 * cover its whole domain (fine) and 20 km around it (coarse).
 * @param {{ slug: string, latitude: number, longitude: number }} site
 * @param {{ fine: Grid, coarse: Grid, sources: object, radiusKm?: number, area?: object, maxDistanceKm?: number, generatedAt?: string, log?: (m: string) => void }} options
 * @returns {{ index: object, tiles: { z: number, x: number, y: number, body: Buffer }[], relief: { meta: object, body: Buffer } }}
 */
export function buildSolarTerrain(site: SolarSite, { fine, generatedAt, ...options }: SolarTerrainOptions & { fine: ElevationGrid; generatedAt?: string }): SolarTerrainProduct & { tiles: TerrainTile[] } {
  const build = startSolarTerrain(site, options);
  const tiles = [];
  for (const block of build.blocks) for (const tile of build.addBlock(block, fine)) tiles.push(tile);
  return { ...build.finish({ generatedAt }), tiles };
}

/** True when a published index was built from exactly these inputs. */
export function indexIsFresh(index: unknown, site: SolarSite, { sources, radiusKm = DEFAULT_RADIUS_KM, area, maxDistanceKm = DEFAULT_MAX_DISTANCE_KM }: SolarDomainOptions & { sources?: TerrainSources; maxDistanceKm?: number }): boolean {
  if (!object(index) || index.schemaVersion !== SCHEMA_VERSION) return false;
  const i = object(index.inputs) ? index.inputs : {};
  return (
    i.latitude === site.latitude &&
    i.longitude === site.longitude &&
    (area ? JSON.stringify(i.area) === JSON.stringify(area) : i.area === undefined && i.radiusKm === radiusKm) &&
    i.maxDistanceKm === maxDistanceKm &&
    i.algorithmVersion === ALGORITHM_VERSION &&
    (!sources || Object.entries(sources).every(([k, v]) => object(i.sources) && i.sources[k] === v.id))
  );
}
