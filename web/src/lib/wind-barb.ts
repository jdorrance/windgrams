/**
 * A standard wind barb centered at the origin: the staff points toward where the wind
 * comes from; pennant = 50 kt, full barb = 10 kt, half barb = 5 kt.
 */
export function barbPaths(speedKt: number, directionDeg: number): { staff: string; flags: string[]; calm: boolean } {
  if (speedKt < 2.5) return { staff: "", flags: [], calm: true };
  const len = 22;
  const rad = (directionDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const px = -uy;
  const py = ux;
  const at = (d: number) => [ux * d, uy * d] as const;
  const [ex, ey] = at(len);
  const staff = `M0,0L${ex.toFixed(1)},${ey.toFixed(1)}`;
  const flags: string[] = [];
  let remaining = Math.round(speedKt / 5) * 5;
  let d = len;
  while (remaining >= 50) {
    const [ax, ay] = at(d);
    const [bx, by] = at(d - 6);
    flags.push(`M${ax.toFixed(1)},${ay.toFixed(1)}L${(ax + px * 9).toFixed(1)},${(ay + py * 9).toFixed(1)}L${bx.toFixed(1)},${by.toFixed(1)}Z`);
    remaining -= 50;
    d -= 8;
  }
  while (remaining >= 10) {
    const [ax, ay] = at(d);
    flags.push(`M${ax.toFixed(1)},${ay.toFixed(1)}L${(ax + px * 9 + ux * 3).toFixed(1)},${(ay + py * 9 + uy * 3).toFixed(1)}`);
    remaining -= 10;
    d -= 4;
  }
  if (remaining >= 5) {
    if (d === len) d -= 4;
    const [ax, ay] = at(d);
    flags.push(`M${ax.toFixed(1)},${ay.toFixed(1)}L${(ax + px * 5 + ux * 1.5).toFixed(1)},${(ay + py * 5 + uy * 1.5).toFixed(1)}`);
  }
  return { staff, flags, calm: false };
}

