export const SCHEMA_VERSION = 1;
/** Bump when the maths or the encoding changes; it is part of the tile path. */
export const ALGORITHM_VERSION = 1;
export const TILE_SIZE = 256;
export const MIN_ZOOM = 11;
export const MAX_ZOOM = 14;
/** Horizons are traced from the centres of this zoom's pixels. */
export const HORIZON_ZOOM = 12;
/** Horizon cells per tile side, at every zoom (4 tile pixels per cell). */
export const HORIZON_CELLS = 64;
/** Extra ring of cells around each tile's horizon grid, for seamless interpolation. */
export const HORIZON_BORDER = 1;
export const AZIMUTHS_DEG = Array.from({ length: 18 }, (_, i) => i * 20);
/** Horizon angles are stored as bytes in steps of this many degrees (0 to 76.5). */
export const HORIZON_STEP_DEG = 0.3;
export const DEFAULT_RADIUS_KM = 15;
export const DEFAULT_MAX_DISTANCE_KM = 20;
/**
 * Side of the blocks a domain is built in, in zoom-14 pixels (16 tiles, variable ground width):
 * a multiple of a zoom-11 tile, so no tile spans two blocks. Memory then stays
 * the same however large a launch's area is.
 */
export const BLOCK_PX = 16 * TILE_SIZE;
/** Metres of fine elevation read around a block (the normals' border and the relief's outer corners). */
export const FINE_MARGIN_M = 250;

export const DEG = Math.PI / 180;
export const WGS84_A = 6378137;
export const MEAN_EARTH_RADIUS_M = 6371008.8;
/** Standard terrestrial refraction coefficient: light bends over the curve, lifting distant terrain slightly. */
export const REFRACTION_K = 0.13;
export const CELL_PX = TILE_SIZE / HORIZON_CELLS;
export const HORIZON_SIDE = HORIZON_CELLS + 2 * HORIZON_BORDER;


export const round = (v: number, digits: number): number | null => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
