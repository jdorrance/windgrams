import type { SiteLocation } from '@windgrams/providers';
const COORDINATE = /\(([-0-9.]+),\s*([-0-9.]+)\) is outside the model grid/;
const NAMED = /build failed:\s+(.+?) is outside the model grid/;
export function launchOutsideGrid<T extends SiteLocation>(text: string, sites: readonly T[]): T | null {
  const coordinate = text.match(COORDINATE);
  if (coordinate) return sites.find(site => Math.abs(site.latitude - Number(coordinate[1])) < 1e-4 && Math.abs(site.longitude - Number(coordinate[2])) < 1e-4) ?? null;
  const named = text.match(NAMED);
  return named ? sites.find(site => site.name === named[1]) ?? null : null;
}
export async function buildCovered<T extends SiteLocation>(model: string, sites: readonly T[], run: (sites: T[]) => Promise<{ status: number; text: string }>, log: (message: string) => void = console.log): Promise<{ dropped: string[]; kept: T[] }> {
  let remaining = sites.slice();
  const dropped: string[] = [];
  for (;;) {
    if (!remaining.length) throw new Error(`${model}: every launch is outside the model grid`);
    const result = await run(remaining);
    if (result.status === 0) return { dropped, kept: remaining };
    const site = launchOutsideGrid(result.text, remaining);
    if (!site) throw new Error(result.text.trim() || `${model} build failed`);
    remaining = remaining.filter(item => item.slug !== site.slug);
    dropped.push(site.slug);
    log(`${model}: skipping ${site.slug} (${site.name}), outside the model grid`);
  }
}
