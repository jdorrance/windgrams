import { gzipSync } from 'node:zlib';
import { MAX_ZOOM, round } from './constants.ts';
import { sampleGrid, xToLon, yToLat } from './grid.ts';
import type { TerrainDomain, ElevationGrid, ReliefFrame, ReliefProduct, ReliefMeta } from './types.ts';
import { object } from '../json.ts';
// ── Relief (the 3D view's ground) ───────────────────────────────────────────

/** Version of the relief file; it is part of the file name, so a format change never meets a cached copy. */
export const RELIEF_VERSION = 1;
/** Relief heights sit on the corners of this zoom's pixels (about 55 m apart at 44° N). */
export const RELIEF_ZOOM = 11;
/** Longest relief side, in heights; a larger area drops to a coarser zoom so the 3D view stays light. */
export const RELIEF_MAX_SIDE = 1200;
const RELIEF_OFFSET_M = 500;
const RELIEF_SCALE = 10;

/** The finest zoom (RELIEF_ZOOM at most) whose relief of the domain fits RELIEF_MAX_SIDE. */
export function reliefZoomFor(domain: TerrainDomain): number {
  let z = RELIEF_ZOOM;
  while (z > 0 && Math.max(domain.x1 - domain.x0, domain.y1 - domain.y0) / 2 ** (MAX_ZOOM - z) + 2 > RELIEF_MAX_SIDE) z -= 1;
  return z;
}

/** An empty relief grid over the domain, filled block by block with fillRelief. */
export function reliefFrame(domain: TerrainDomain): ReliefFrame {
  const zoom = reliefZoomFor(domain);
  const f = 2 ** (MAX_ZOOM - zoom);
  const x0 = Math.floor(domain.x0 / f);
  const y0 = Math.floor(domain.y0 / f);
  const width = Math.ceil(domain.x1 / f) - x0 + 1;
  const height = Math.ceil(domain.y1 / f) - y0 + 1;
  return { domain, zoom, f, x0, y0, width, height, values: new Uint16Array(width * height), min: Infinity, max: -Infinity };
}

/**
 * Fills the relief heights that fall in `block` (all of them without one) from
 * a fine elevation grid covering it. Heights on a block edge are filled by
 * both blocks, with the same value.
 */
export function fillRelief(frame: ReliefFrame, fine: ElevationGrid, block = frame.domain): void {
  const { domain, zoom, f, x0, y0, width, height, values } = frame;
  const within = (p: number, lo: number, hi: number, blo: number, bhi: number) => {
    const c = Math.min(Math.max(p, lo), hi);
    return c >= blo && c <= bhi;
  };
  for (let j = 0; j < height; j += 1) {
    if (!within((y0 + j) * f, domain.y0, domain.y1, block.y0, block.y1)) continue;
    const lat = yToLat(y0 + j, zoom);
    for (let i = 0; i < width; i += 1) {
      if (!within((x0 + i) * f, domain.x0, domain.x1, block.x0, block.x1)) continue;
      const v = sampleGrid(fine, lat, xToLon(x0 + i, zoom));
      if (Number.isNaN(v)) continue;
      values[j * width + i] = Math.min(65535, Math.max(1, Math.round((v + RELIEF_OFFSET_M) * RELIEF_SCALE)));
      frame.min = Math.min(frame.min, v);
      frame.max = Math.max(frame.max, v);
    }
  }
}

/** The relief file and its index entry. */
export function encodeRelief(frame: ReliefFrame, generation: string): ReliefProduct {
  const { zoom, x0, y0, width, height, values } = frame;
  const bytes = Buffer.alloc(values.length * 2);
  for (let k = 0; k < values.length; k += 1) {
    const prev = k % width === 0 ? (k === 0 ? 0 : values[k - width]) : values[k - 1];
    bytes.writeUInt16LE((values[k] - prev) & 0xffff, k * 2);
  }
  const body = gzipSync(bytes, { level: 9 });
  return {
    body,
    meta: {
      version: RELIEF_VERSION,
      path: `${generation}/relief-v${RELIEF_VERSION}.bin.gz`,
      zoom,
      x0,
      y0,
      width,
      height,
      offsetM: RELIEF_OFFSET_M,
      scale: RELIEF_SCALE,
      minM: round(frame.min, 0),
      maxM: round(frame.max, 0),
      encoding: "uint16 little-endian, (elevation m + offsetM) * scale, 0 = no data; row-delta (mod 65536); gzip",
      bytes: body.length,
    },
  };
}

/**
 * Elevation on a regular Web Mercator grid over the domain, for drawing the
 * terrain in 3D: one height per corner of the zoom-11 pixels (coarser for a
 * large area, see reliefZoomFor), so the grid's edges are the domain's edges
 * and the sunlight tiles drape onto it exactly.
 *
 * Stored as unsigned 16-bit little-endian values, (elevation + 500 m) in
 * decimetres (0 = no data), row by row from the north-west corner, each
 * row-delta filtered like the tiles (differences taken modulo 65536), gzipped.
 */
export function buildRelief(fine: ElevationGrid, domain: TerrainDomain, generation: string): ReliefProduct {
  const frame = reliefFrame(domain);
  fillRelief(frame, fine);
  return encodeRelief(frame, generation);
}

/** Decodes a relief file's (gunzipped) bytes into heights in metres, NaN where there is no data. */
export function decodeRelief(raw: Uint8Array, meta: Pick<ReliefMeta, 'width' | 'height' | 'scale' | 'offsetM'>): Float32Array {
  const n = meta.width * meta.height;
  const values = new Uint16Array(n);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k += 1) {
    const prev = k % meta.width === 0 ? (k === 0 ? 0 : values[k - meta.width]) : values[k - 1];
    values[k] = (raw[2 * k] | (raw[2 * k + 1] << 8)) + prev;
    out[k] = values[k] === 0 ? Number.NaN : values[k] / meta.scale - meta.offsetM;
  }
  return out;
}

/** True when a published index carries the current relief. */
export function reliefIsFresh(index: unknown): boolean {
  return object(index) && object(index.relief) && index.relief.version === RELIEF_VERSION;
}

