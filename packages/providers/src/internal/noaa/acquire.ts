import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nearestGridpoint, parseIdx, sampleFieldValuesAsync } from '@azohra/meteo.grib';
import { createNodeJ2kDecoderPool } from '@azohra/meteo.grib/j2k-node';
import type { NoaaAcquireOptions, NoaaAcquisition, NoaaColumnOptions, NoaaSelection, NoaaSourceAsset, NoaaGrid } from './types.ts';
import { modelDescriptor, modelCoversSite } from '../../registry.ts';
import { pressureLevelsFor, selectRecords } from './fields.ts';
import { asset, atomicWrite, fileUrl, inspectField, sha256 } from './transport.ts';
import { cellSource, columnRecord } from './column.ts';
import { nativeColumn, selectNativeRecords } from './native.ts';
import { assertNoaaBounds, selectGridCells } from './grid.ts';
import { gfsWindowStart, trailingGfsValues, validAt } from './intervals.ts';

function selectedCells(grid: NoaaGrid, options: NoaaAcquireOptions) {
  const siteIndexes: Record<string, number> = {};
  for (const site of options.sites ?? []) {
    const nearest = nearestGridpoint(grid, site.latitude, site.longitude);
    const maxDistanceKm = options.model === 'gfs' ? 30 : 10;
    if (nearest.distanceKm > maxDistanceKm) throw new Error(`NOAA site ${site.slug} is more than ${maxDistanceKm} km outside its selected native grid`);
    siteIndexes[site.slug] = nearest.index;
  }
  const cells = selectGridCells(grid, { bounds: options.bounds, indices: Object.values(siteIndexes), maxCells: options.maxCells ?? 12_000 })
    .map(cell => ({ ...cell, modelElevationM: NaN }));
  if (!cells.length) throw new Error('NOAA request selected no cells');
  return { cells, siteCells: Object.fromEntries(Object.entries(siteIndexes).map(([slug, index]) => [slug, cells.findIndex(cell => cell.index === index)])) };
}
/** Capture and decode once per field/hour, then sample all point and regional cells together. */
export async function acquireNoaa(options: NoaaAcquireOptions): Promise<NoaaAcquisition> {
  const model = modelDescriptor(options.model), mode = options.verticalMode ?? 'legacy-pressure';
  if (!['hrrr-conus', 'rrfs', 'gfs'].includes(options.model) || !['legacy-pressure', 'expanded-pressure', 'hrrr-native'].includes(mode)) throw new Error('Unsupported NOAA normalized acquisition');
  if (mode === 'hrrr-native' && options.model !== 'hrrr-conus') throw new Error('Native acquisition is verified only for HRRR wrfnat');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/.test(options.referenceTime) || !Number.isFinite(Date.parse(options.referenceTime)) || new Date(options.referenceTime).toISOString().replace('.000Z', 'Z') !== options.referenceTime) throw new Error('NOAA referenceTime must be an exact ISO UTC cycle hour');
  if (!model.cyclesUtc.includes(new Date(options.referenceTime).getUTCHours())) throw new Error('Unsupported NOAA model cycle');
  if (!options.forecastHours.length || options.forecastHours.some((hour, i) => !model.forecastHours.includes(hour) || (i > 0 && hour <= options.forecastHours[i - 1]))) throw new Error('NOAA forecast hours must be unique, ascending supported leads');
  if (!options.cacheDir || (!(options.sites?.length) && !options.bounds)) throw new Error('NOAA requires cacheDir and sites or bounds');
  if (options.maxCells !== undefined && (!Number.isInteger(options.maxCells) || options.maxCells < 1)) throw new Error('maxCells must be a positive integer');
  if (options.bounds) assertNoaaBounds(options.bounds);
  const slugs = new Set<string>();
  for (const site of options.sites ?? []) {
    if (!site.slug || slugs.has(site.slug) || !Number.isFinite(site.latitude) || !Number.isFinite(site.longitude) || !modelCoversSite(options.model, site)) throw new Error(`Invalid/duplicate/out-of-coverage NOAA site: ${site.slug}`);
    slugs.add(site.slug);
  }
  const c: NoaaColumnOptions = { model: options.model, referenceTime: options.referenceTime, terrainForecastHour: 0, pressureLevels: pressureLevelsFor(options.model, mode), includeExtendedFields: mode !== 'legacy-pressure' };
  const adapterImplementationSha256 = sha256(await readFile(new URL('../../build-inventory.json', import.meta.url)));
  const fetchImpl = options.fetchImpl ?? fetch, assets: NoaaSourceAsset[] = [], root = join(options.cacheDir, 'noaa-columns-1');
  await mkdir(root, { recursive: true });
  const identity = sha256(JSON.stringify({ model: options.model, referenceTime: options.referenceTime, mode, forecastHours: options.forecastHours, sites: options.sites, bounds: options.bounds }));
  let capturedAt: string;
  try {
    const saved = JSON.parse(await readFile(join(root, `${identity}.capture.json`), 'utf8'));
    if (saved.identity !== identity || typeof saved.capturedAt !== 'string' || !Number.isFinite(Date.parse(saved.capturedAt))) throw new Error('Invalid NOAA capture receipt');
    capturedAt = saved.capturedAt;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; capturedAt = new Date().toISOString(); }
  let pool: Awaited<ReturnType<typeof createNodeJ2kDecoderPool>> | undefined;
  const getIndex = async (hour: number, product?: string) => {
    const result = await asset(root, `${fileUrl(c, hour, product)}.idx`, null, bytes => {
      const stamp = c.referenceTime.slice(0, 13).replace(/[-T:]/g, '');
      if (!bytes.toString().trim().split('\n').every(line => line.split(':')[2] === `d=${stamp}`)) throw new Error('Wrong NOAA index run');
    }, fetchImpl, options.signal); assets.push(result.source); return parseIdx(result.bytes.toString());
  };
  const getField = async (hour: number, selection: NoaaSelection, gridKey?: string) => {
    if (!selection.record) return null;
    const result = await asset(root, fileUrl(c, hour, selection.product), selection.record, bytes => { inspectField(bytes, c, hour, gridKey, selection); }, fetchImpl, options.signal);
    assets.push(result.source); return inspectField(result.bytes, c, hour, gridKey, selection);
  };
  try {
    // Terrain is sampled from the same run; no older static or launch elevation substitution.
    const terrainHour = options.model === 'gfs' ? 3 : 1, terrainOptions = { ...c, terrainForecastHour: terrainHour };
    const terrainSelection = selectRecords(await getIndex(terrainHour, options.model === 'rrfs' ? '2dfld' : undefined), terrainOptions, terrainHour)[0];
    const terrainField = await getField(terrainHour, terrainSelection);
    if (!terrainField) throw new Error('Missing NOAA terrain');
    const grid = terrainField.grid, selected = selectedCells(grid, options), indices = selected.cells.map(cell => cell.index);
    const decode = async (field: typeof terrainField.field) => {
      options.signal?.throwIfAborted();
      const packing = new DataView(field.section5.buffer, field.section5.byteOffset, field.section5.byteLength).getUint16(9);
      if (packing === 40) pool ??= await createNodeJ2kDecoderPool({ size: 2 });
      const decoded = await sampleFieldValuesAsync(field, indices, packing === 40 && pool ? { decodeJ2k: pool.decode, decodeJ2kSampled: pool.decodeSampled } : {});
      return Array.from(decoded.values, (value, i) => decoded.missingMask?.[i] || !Number.isFinite(value) ? null : value);
    };
    const terrain = await decode(terrainField.field);
    for (const [i, cell] of selected.cells.entries()) { if (terrain[i] === null) throw new Error('Missing NOAA terrain at selected cell'); cell.modelElevationM = terrain[i]!; }
    const hours: NoaaAcquisition['hours'][number][] = [];
    for (const hour of options.forecastHours) {
      const selections: NoaaSelection[] = [];
      for (const product of options.model === 'rrfs' ? ['2dfld', 'prslev'] : [undefined]) {
        const regular = selectRecords(await getIndex(hour, product), c, hour, product);
        selections.push(...regular);
      }
      let native: NoaaSelection[] = [];
      if (mode === 'hrrr-native') { native = selectNativeRecords(await getIndex(hour, 'wrfnat'), hour); selections.push(...native); }
      const raw: Record<string, (number | null)[]> = {};
      for (const selection of selections) {
        const decoded = await getField(hour, selection, grid.gridKey); if (decoded) raw[selection.key] = await decode(decoded.field);
      }
      if (options.model === 'gfs') {
        const needsCompanion = gfsWindowStart(hour) !== hour - 3;
        const companion: Record<string, (number | null)[]> = {};
        const intervalKeys = ['latentHeatFluxWm2', 'sensibleHeatFluxWm2', 'precipitationMm'];
        if (needsCompanion) {
          const companionSelections = selectRecords(await getIndex(hour - 3), c, hour - 3, undefined, intervalKeys);
          for (const selection of companionSelections) {
            const data = await getField(hour - 3, selection, grid.gridKey);
            if (!data) throw new Error('Missing GFS interval companion');
            companion[selection.key] = await decode(data.field);
          }
        }
        for (const key of intervalKeys) raw[key] = trailingGfsValues(raw[key], needsCompanion ? companion[key] : null, key === 'precipitationMm');
      }
      const missingReasons: (string | null)[] = selected.cells.map(() => null);
      const columns = selected.cells.map((cell, i) => {
        const values = Object.fromEntries(Object.entries(raw).map(([key, values]) => [key, values[i]]));
        let column = cellSource(c, grid, cell, hour, values);
        if (!column) { missingReasons[i] = 'Missing required surface source field'; return null; }
        if (mode !== 'hrrr-native') {
          const incomplete = c.pressureLevels!.find(pressure => {
            const height = values[`${pressure}.HGT`];
            // Unknown geometry cannot establish that a missing record is below ground.
            if (height == null || !Number.isFinite(height)) return true;
            if (height <= cell.modelElevationM || (column!.surfacePressureHpa != null && pressure > column!.surfacePressureHpa)) return false;
            return ['TMP', 'DPT', 'UGRD', 'VGRD'].some(key => values[`${pressure}.${key}`] == null || !Number.isFinite(values[`${pressure}.${key}`]));
          });
          if (incomplete !== undefined) { missingReasons[i] = `Missing required above-ground ${incomplete} hPa source node; gap interpolation prohibited`; return null; }
        }
        if (mode === 'hrrr-native' && grid.kind === 'lambert') column = nativeColumn(column, grid, cell.longitude, cell.modelElevationM, values, native);
        else column = { ...column, levels: column.levels.filter(level => level.heightM > cell.modelElevationM && (column!.surfacePressureHpa == null || level.pressureHpa <= column!.surfacePressureHpa)).sort((a, b) => a.heightM - b.heightM) };
        if (!column) { missingReasons[i] = 'Missing or inconsistent native profile node; gap interpolation prohibited'; return null; }
        return columnRecord(column, cell, options, capturedAt, grid.gridKey);
      });
      hours.push({ forecastHour: hour, validAt: validAt(c.referenceTime, hour), columns, missingReasons });
    }
    const result: NoaaAcquisition = { schemaVersion: 1, adapterVersion: 'noaa-columns-1', adapterImplementationSha256, model: options.model, referenceTime: options.referenceTime, verticalMode: mode, completeness: hours.some(hour => hour.columns.some(column => column === null)) ? 'partial' : 'complete', capturedAt, grid, cells: selected.cells, siteCells: selected.siteCells, hours, assets: [...new Map(assets.map(source => [`${source.url}:${source.range}`, source])).values()] };
    await atomicWrite(join(root, `${identity}.capture.json`), `${JSON.stringify({ capturedAt, identity })}\n`);
    return result;
  } finally { if (pool) await pool.close(); }
}
