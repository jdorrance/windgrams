export const validAt = (referenceTime: string, hour: number) => new Date(Date.parse(referenceTime) + hour * 3_600_000).toISOString().replace('.000Z', 'Z');
export const gfsWindowStart = (hour: number) => Math.floor((hour - 3) / 6) * 6;

/** Recover the trailing three hours from GFS's 3/6-hour window products. */
export function trailingGfsValues(current: readonly (number | null)[], companion: readonly (number | null)[] | null, accumulation: boolean): (number | null)[] {
  if (companion && companion.length !== current.length) throw new Error('GFS companion field has different selected cells');
  return current.map((value, i) => {
    const previous = companion?.[i];
    if (value === null || !Number.isFinite(value) || (companion && (previous == null || !Number.isFinite(previous)))) return null;
    if (accumulation && (value < 0 || (previous != null && previous < 0))) return null;
    const recovered = companion ? accumulation ? value - previous! : 2 * value - previous! : value;
    // No quantization tolerance is claimed: negative recovered amounts remain unavailable.
    return accumulation ? recovered < 0 ? null : recovered / 3 : recovered;
  });
}
