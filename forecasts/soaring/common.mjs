import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { rrfsBase } from '../scripts/lib/model-feeds.mjs';

export const versions = Object.freeze({ forecast: '0.6.0', briefing: '0.6.2', grib: '0.1.4', algorithm: 'hrrr-baseline-0.6.0-v1' });
export const semantics = { gust: 'instant', precipitation: 'instantRate', smoke: 'radiativelyCoupled' };
export function modelFor(c) {
  const model = c.model ?? 'hrrr-conus';
  if (!['hrrr-conus', 'rrfs'].includes(model)) throw new Error(`Unsupported regional model: ${model}`);
  return model;
}
export const semanticsFor = c => modelFor(c) === 'rrfs' ? { gust: 'instant', precipitation: 'windowMeanRate' } : semantics;
export const versionsFor = c => modelFor(c) === 'rrfs' ? { ...versions, algorithm: 'rrfs-regional-0.6.0-v1' } : versions;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value) + '\n';
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
export async function assertRuntime(c) {
  modelFor(c);
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Soaring replay requires Node 24');
  if (c.sinkMps !== 1 || c.minimumAboveGroundLevels !== 3) throw new Error('Baseline v1 requires a 1.0 m/s sink threshold and three above-ground levels');
  for (const [name, version] of Object.entries(versions)) {
    if (name === 'algorithm') continue;
    // Metadata next to the public entry point; no private code is imported.
    const pkg = await readJson(new URL('../package.json', import.meta.resolve(`@azohra/meteo.${name}`)));
    if (pkg.version !== version) throw new Error(`Expected meteo.${name} ${version}; found ${pkg.version}`);
  }
}
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
}
export const validAt = (c, hour) => new Date(Date.parse(c.referenceTime) + hour * 3600000).toISOString().replace('.000Z', 'Z');
export function fileUrl(c, hour, product = '2dfld') {
  const date = c.referenceTime.slice(0, 10).replaceAll('-', '');
  if (modelFor(c) === 'rrfs') {
    if (!['2dfld', 'prslev'].includes(product)) throw new Error(`Unsupported RRFS product: ${product}`);
    return `${rrfsBase()}/rrfs.${date}/${c.referenceTime.slice(11, 13)}/rrfs.t${c.referenceTime.slice(11, 13)}z.${product}.3km.f${String(hour).padStart(3, '0')}.conus.grib2`;
  }
  return `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${date}/conus/hrrr.t${c.referenceTime.slice(11, 13)}z.wrfprsf${String(hour).padStart(2, '0')}.grib2`;
}
export async function concurrent(items, count, work) {
  let next = 0;
  const results = new Array(items.length);
  const settled = await Promise.allSettled(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i], i); }
  }));
  const failed = settled.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}
