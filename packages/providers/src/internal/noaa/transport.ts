import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { byteRange, parseFields, parseGrid, parseProduct } from '@azohra/meteo.grib';
import type { IdxRecord } from '@azohra/meteo.grib';
import type { NoaaColumnOptions, NoaaField, NoaaSourceAsset } from './types.ts';
import { parameters, fixedSurface } from './fields.ts';
import { validAt, gfsWindowStart } from './intervals.ts';
import { rrfsBase } from '../../feeds.ts';

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function fileUrl(c: NoaaColumnOptions, hour: number, product?: string): string {
  const date = c.referenceTime.slice(0, 10).replaceAll('-', ''), cycle = c.referenceTime.slice(11, 13);
  if (c.model === 'gfs') return `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.pgrb2.0p25.f${String(hour).padStart(3, '0')}`;
  if (c.model === 'rrfs') {
    if (!['2dfld', 'prslev'].includes(product ?? '')) throw new Error('RRFS supports only verified pressure and surface products');
    return `${rrfsBase()}/rrfs.${date}/${cycle}/rrfs.t${cycle}z.${product}.3km.f${String(hour).padStart(3, '0')}.conus.grib2`;
  }
  if (product && !['wrfprs', 'wrfnat'].includes(product)) throw new Error(`Unsupported HRRR product: ${product}`);
  return `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${date}/conus/hrrr.t${cycle}z.${product ?? 'wrfprs'}f${String(hour).padStart(2, '0')}.grib2`;
}
export async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}
/** Content-addressed validated cache. Request receipts commit only after complete byte validation. */
export async function asset(root: string, url: string, record: IdxRecord | null, validate: (bytes: Buffer) => void, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<{ bytes: Buffer; source: NoaaSourceAsset }> {
  const range = record ? byteRange(record) : null, key = sha256(`${url}\n${range}`), receipt = join(root, `${key}.json`);
  await mkdir(root, { recursive: true });
  let saved: NoaaSourceAsset | undefined;
  try { saved = JSON.parse(await readFile(receipt, 'utf8')) as NoaaSourceAsset; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (saved) {
    if (saved.url !== url || saved.range !== range || !/^[0-9a-f]{64}$/.test(saved.sha256) || saved.file !== `${saved.sha256}.bin` || !Number.isInteger(saved.size) || saved.size <= 0) throw new Error('Invalid NOAA cache receipt');
    const bytes = await readFile(join(root, saved.file));
    if (bytes.length !== saved.size || sha256(bytes) !== saved.sha256) throw new Error('Corrupt NOAA cached bytes');
    validate(bytes); return { bytes, source: saved };
  }
  signal?.throwIfAborted();
  const response = await fetchImpl(url, { headers: range ? { Range: range } : {}, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
  if (response.status !== (record ? 206 : 200)) throw new Error(`HTTP ${response.status} for ${url}; expected ${record ? '206 range' : '200 index'}`);
  if (record && !response.headers.get('content-range')?.startsWith(`bytes ${record.offset}-${record.offset + record.length! - 1}/`)) throw new Error('Wrong NOAA Content-Range');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (record && bytes.length !== record.length) throw new Error('Truncated NOAA byte range');
  validate(bytes);
  const digest = sha256(bytes), source = { url, range, sha256: digest, size: bytes.length, file: `${digest}.bin` };
  await atomicWrite(join(root, source.file), bytes);
  await atomicWrite(receipt, `${JSON.stringify(source)}\n`);
  return { bytes, source };
}
export function inspectField(bytes: Uint8Array, c: NoaaColumnOptions, hour: number, expectedGrid?: string, selection?: NoaaField) {
  const parsed = parseFields(bytes);
  if (parsed.length !== 1) throw new Error('Expected a single NOAA GRIB field');
  const field = parsed[0], id = field.identification;
  const referenceTime = new Date(Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second)).toISOString().replace('.000Z', 'Z');
  if (referenceTime !== c.referenceTime) throw new Error(`Wrong NOAA run: ${referenceTime}`);
  const product = parseProduct(field.section4);
  const accumulation = product.parameterCategory === 1 && product.parameterNumber === 8;
  const gfsInterval = c.model === 'gfs' && (accumulation || (product.parameterCategory === 0 && [10, 11].includes(product.parameterNumber)));
  const interval = (c.model === 'rrfs' && accumulation) || gfsInterval;
  const startHour = gfsInterval ? gfsWindowStart(hour) : hour - 1, duration = hour - startHour;
  if (field.discipline !== 0 || product.productDefinitionTemplateNumber !== (interval ? 8 : 0)) throw new Error('Unsupported NOAA discipline/product template');
  if (interval) {
    const s = new DataView(field.section4.buffer, field.section4.byteOffset, field.section4.byteLength);
    if (s.byteLength < 58) throw new Error('Truncated NOAA source interval');
    const end = new Date(Date.UTC(s.getUint16(34), s.getUint8(36) - 1, s.getUint8(37), s.getUint8(38), s.getUint8(39), s.getUint8(40))).toISOString().replace('.000Z', 'Z');
    if (end !== validAt(c.referenceTime, hour) || s.getUint8(41) !== 1 || s.getUint32(42) !== 0 || s.getUint8(47) !== 2 || s.getUint8(46) !== (accumulation ? 1 : 0) || s.getUint8(48) !== 1 || s.getUint32(49) !== duration) throw new Error('Wrong NOAA source interval or statistical process');
  }
  if (selection) {
    const identity = c.model === 'gfs' && selection.variable === 'HPBL' ? [3, 196] : parameters[selection.variable], [surface, value] = fixedSurface(selection.level);
    if (!identity || surface === undefined || product.parameterCategory !== identity[0] || product.parameterNumber !== identity[1] || product.typeOfFirstFixedSurface !== surface || product.scaledValueOfFirstFixedSurface! * 10 ** -product.scaleFactorOfFirstFixedSurface! !== value) throw new Error(`Wrong NOAA variable/level: ${selection.key}`);
  }
  if (product.indicatorOfUnitOfTimeRange !== 1 || product.forecastTime !== (interval ? startHour : hour)) throw new Error('Wrong NOAA forecast time');
  const grid = parseGrid(field.section3);
  if ((c.model === 'gfs' ? grid.kind !== 'latlon' : grid.kind !== 'lambert' || grid.projectionCentreFlag !== 0) || (expectedGrid && grid.gridKey !== expectedGrid)) throw new Error(`Inconsistent/unsupported NOAA grid: ${grid.gridKey}`);
  if (grid.kind === 'rotated') throw new Error('Rotated NOAA grid is unsupported');
  return { field, grid, product };
}
