import { getUnitSystem } from './units.ts';
import { barbPaths } from './wind-barb.ts';

interface CellCentre { longitude: number; latitude: number }
const KNOTS_PER_MPS = 3600 / 1852;

/** Aviation convention: staff points FROM the source, speed rounds to 5 knots.
 * https://www.weather.gov/hfo/windbarbinfo
 */
export function windBarbs(cells: CellCentre[], speeds: (number | null)[], directions: (number | null)[]) {
  const features = cells.flatMap((cell, i) => {
    const speed = speeds[i], direction = directions[i];
    if (speed == null || !Number.isFinite(speed) || speed < 0) return [];
    const speedKt = Math.round(speed * KNOTS_PER_MPS / 5) * 5;
    const barbSpeed = getUnitSystem() === 'metric' ? Math.round(speed * 2 / 5) * 5 : speedKt;
    if (barbSpeed && (direction == null || !Number.isFinite(direction))) return [];
    return [{
      type: 'Feature' as const,
      properties: { speedMps: speed, speedKt, barbSpeed, bearing: barbSpeed ? ((direction! % 360) + 360) % 360 : 0, icon: `wind-barb-${getUnitSystem()}-${barbSpeed}` },
      geometry: { type: 'Point' as const, coordinates: [cell.longitude, cell.latitude] as [number, number] },
    }];
  });
  return { type: 'FeatureCollection' as const, features };
}

/** North-oriented sprite, rotated geographically by MapLibre; no arrowhead. */
export function windBarbImage(speedKt: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  ctx.translate(32, 32);
  const barb = barbPaths(speedKt, 0);
  const path = new Path2D(barb.staff + barb.flags.join(''));
  if (barb.calm) path.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke(path);
  ctx.fillStyle = ctx.strokeStyle = '#172b38';
  for (const flag of barb.flags.filter(f => f.endsWith('Z'))) ctx.fill(new Path2D(flag));
  ctx.lineWidth = 1.5; ctx.stroke(path);
  return ctx.getImageData(0, 0, 128, 128);
}
