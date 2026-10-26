import type { AtmosphericColumn, AtmosphericLevel } from '@windgrams/contracts';
import type { IconBounds, IconCell, IconFieldRecord, IconExtract, IconExtractRecord, IconAcquisition, IconAcquireOptions } from './icon-types.ts';
import type { Bounds } from '@windgrams/geography';
import { object } from './json.ts';
import { specificHumidityDewpointC } from './thermodynamics.ts';
import { parseIconExtract, parseIconRecord, parseIconAcquisition, parseIconHour, parseIconArchive } from './icon-json.ts';
// DWD ICON-EU v1 native triangular grid. Decoding stays in icon-decode.py;
// unit/time normalization and the shared soaring derivation stay here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ICON_BASE = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/';
export const ICON_MODEL_LEVELS = Object.freeze(Array.from({ length: 30 }, (_, i) => 45 + i));
export const ICON_FORECAST_HOURS = Object.freeze(Array.from({ length: 78 }, (_, i) => i + 1));
export const ICON_SEMANTICS = Object.freeze({ gust: 'hourMax', precipitation: 'windowMeanRate' });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function iconBounds(value: IconBounds | Bounds | undefined): IconBounds | undefined {
  if (value === undefined) return undefined;
  const bbox: IconBounds = Array.isArray(value) ? { west: value[0], south: value[1], east: value[2], north: value[3] } : value as IconBounds;
  if (!bbox || !(["west", "south", "east", "north"] as const).every(key => finite(bbox[key]))
    || bbox.west < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90
    || bbox.west >= bbox.east || bbox.south >= bbox.north) throw new Error('Invalid ICON bounding box');
  return bbox;
}

export function iconReferenceTime(referenceTime: string): string {
  const t = new Date(referenceTime);
  if (!finite(t.getTime()) || t.getUTCMinutes() || t.getUTCSeconds() || t.getUTCMilliseconds() || t.getUTCHours() % 6) {
    throw new Error('ICON-EU requires an explicit 00, 06, 12 or 18 UTC main run');
  }
  return t.toISOString().replace('.000Z', 'Z');
}

export function iconFieldUrl(field: string, referenceTime: string, forecastHour: number, level: number | null = null): string {
  const run = iconReferenceTime(referenceTime);
  if (!/^[A-Z][A-Z0-9_]*$/.test(field) || !Number.isInteger(forecastHour) || forecastHour < 0 || forecastHour > 120
    || (level !== null && (!Number.isInteger(level) || level < 1 || level > 75))) throw new Error('Invalid ICON field request');
  return `${ICON_BASE}${field}${level === null ? '' : `/lvt1/150/lv1/${level}`}/r/${run.slice(0, 16).replace(':', '%3A')}/s/PT${String(forecastHour).padStart(3, '0')}H00M.grib2`;
}

/** Main runs keep the three-day horizon stable while short intermediate cycles arrive. */
export async function discoverIconRun({ now = new Date(), fetchFn = fetch, lastForecastHour = 78, signal }: { now?: Date; fetchFn?: typeof fetch; lastForecastHour?: number; signal?: AbortSignal } = {}): Promise<{ referenceTime: string; forecastHours: number; completionUrls: string[] }> {
  signal?.throwIfAborted();
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const response = await fetchFn(`${ICON_BASE}HSURF/r/`, { signal: requestSignal() });
  if (!response.ok) throw new Error(`ICON run inventory HTTP ${response.status}`);
  const text = await response.text();
  const candidates = [...text.matchAll(/href="(\d{4}-\d\d-\d\dT\d\d(?:%3A|:)00)\/"/gi)]
    .map(match => `${decodeURIComponent(match[1])}:00Z`)
    .filter(run => Number.isFinite(Date.parse(run)) && new Date(run).getUTCHours() % 6 === 0 && Date.parse(run) <= +now)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  for (const referenceTime of candidates) {
    signal?.throwIfAborted();
    // DWD publishes mixing height later than the native and flux fields.
    // Wait for its requested horizon before selecting an otherwise ready run.
    const urls = [iconFieldUrl('T', referenceTime, lastForecastHour, 74), iconFieldUrl('P', referenceTime, lastForecastHour, 45),
      iconFieldUrl('TOT_PREC', referenceTime, lastForecastHour), iconFieldUrl('ASHFL_S', referenceTime, lastForecastHour),
      iconFieldUrl('MH', referenceTime, lastForecastHour)];
    const probes = await Promise.allSettled(urls.map(url => fetchFn(url, { method: 'HEAD', signal: requestSignal() })));
    signal?.throwIfAborted();
    if (probes.every(probe => probe.status === 'fulfilled' && probe.value.ok)) return { referenceTime: iconReferenceTime(referenceTime), forecastHours: lastForecastHour, completionUrls: urls };
  }
  throw new Error('ICON-EU has no complete main run; keep the last published forecast');
}

/** Convert DWD's run-mean downward flux to the preceding hour's upward mean. */
export function iconHourlyFlux(current: IconFieldRecord | undefined, previous: IconFieldRecord | undefined, index: number): number | null {
  const c = current?.metadata, p = previous?.metadata;
  if (!current || !previous || !c || !p || c.stepType !== 'avg' || p.stepType !== 'avg' || c.units !== 'W m**-2' || p.units !== c.units
    || c.startHour !== 0 || p.startHour !== 0 || c.endHour - p.endHour !== 1 || c.endHour <= 0) {
    throw new Error('ICON heat flux requires consecutive run-mean W/m² intervals');
  }
  const v = current.values[index], prev = previous.values[index];
  if (!finite(v) || (p.endHour > 0 && !finite(prev))) return null;
  return -(v * c.endHour - (p.endHour === 0 ? 0 : (prev as number) * p.endHour));
}

/** Accumulated kg/m² equals mm liquid equivalent; each output is one hour. */
export function iconHourlyPrecipitation(current: IconFieldRecord | undefined, previous: IconFieldRecord | undefined, index: number): number | null {
  const c = current?.metadata, p = previous?.metadata;
  if (!current || !previous || !c || !p || c.stepType !== 'accum' || p.stepType !== 'accum' || c.units !== 'kg m**-2' || p.units !== c.units
    || c.startHour !== 0 || p.startHour !== 0 || c.endHour - p.endHour !== 1) {
    throw new Error('ICON precipitation requires consecutive run accumulations');
  }
  const v = current.values[index], prev = previous.values[index];
  if (!finite(v) || !finite(prev)) return null;
  // GRIB quantization changes can produce tiny negatives as the run grows.
  const amount = v - prev;
  const tolerance = finite(c.packingError) && finite(p.packingError) ? c.packingError + p.packingError + 1e-9 : 0.02;
  if (amount < -tolerance) throw new Error('ICON precipitation accumulation decreases beyond packing tolerance');
  return Math.max(0, amount);
}

function wind(u: number | null | undefined, v: number | null | undefined): { windSpeedMps: number; windDirectionDeg: number } | null {
  if (!finite(u) || !finite(v)) return null;
  return { windSpeedMps: Math.hypot(u, v), windDirectionDeg: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
}

/** Normalize one native cell with all 30 terrain-following levels unchanged. */
export function iconSource(extract: IconExtract & { records: Record<string, IconExtractRecord> }, forecastHour: number, cellIndex: number): AtmosphericColumn | null {
  const record = (field: string, hour = forecastHour, level: number | null = null) => extract.records[`${field}:${hour}:${level === null ? 'None' : level}`];
  const value = (field: string, units: string, hour = forecastHour, level: number | null = null): number | null => {
    const r = record(field, hour, level);
    if (!r || r.metadata.units !== units) throw new Error(`ICON ${field} has missing or unexpected units; expected ${units}`);
    return r.values[cellIndex];
  };
  const temperatureK = value('T_2M', 'K'), dewpointK = value('TD_2M', 'K');
  const surfaceWind = wind(value('U_10M', 'm s**-1'), value('V_10M', 'm s**-1'));
  const sensible = iconHourlyFlux(record('ASHFL_S'), record('ASHFL_S', forecastHour - 1), cellIndex);
  const latent = iconHourlyFlux(record('ALHFL_S'), record('ALHFL_S', forecastHour - 1), cellIndex);
  const precipitation = iconHourlyPrecipitation(record('TOT_PREC'), record('TOT_PREC', forecastHour - 1), cellIndex);
  const cloudCover = value('CLCT', '%'), pmsl = value('PMSL', 'Pa');
  if (!surfaceWind || !finite(temperatureK) || !finite(dewpointK) || !finite(sensible) || !finite(latent) || !finite(precipitation) || !finite(cloudCover) || !finite(pmsl)) return null;
  const source: AtmosphericColumn & { levels: AtmosphericLevel[] } = {
    validAt: new Date(Date.parse(extract.referenceTime) + forecastHour * 3600000).toISOString().replace('.000Z', 'Z'),
    temperatureC: temperatureK - 273.15, dewPointDepressionC: Math.max(0, temperatureK - dewpointK), ...surfaceWind,
    cloudCoverPercent: cloudCover, sensibleHeatFluxWm2: sensible, latentHeatFluxWm2: latent,
    precipitationMm: precipitation, seaLevelPressureHpa: pmsl / 100, levels: [],
  };
  const gust = record('VMAX_10M').metadata;
  if (gust.stepType !== 'max' || gust.startHour !== forecastHour - 1 || gust.endHour !== forecastHour) {
    throw new Error('ICON gust requires a maximum over the preceding hour');
  }
  const optional: readonly [string, 'windGustMps' | 'capeJkg' | 'cinJkg' | 'pblHeightM' | 'lowCloudPercent' | 'midCloudPercent' | 'highCloudPercent', string][] = [['VMAX_10M', 'windGustMps', 'm s**-1'], ['CAPE_ML', 'capeJkg', 'J kg-1'],
    ['CIN_ML', 'cinJkg', 'J kg-1'], ['MH', 'pblHeightM', 'm'], ['CLCL', 'lowCloudPercent', '%'],
    ['CLCM', 'midCloudPercent', '%'], ['CLCH', 'highCloudPercent', '%']];
  for (const [field, key, unit] of optional) {
    const v = value(field, unit);
    if (finite(v)) source[key] = key === 'cinJkg' ? -Math.abs(v) : v;
  }
  const terrain = extract.cells[cellIndex].terrainM;
  for (const level of extract.levels) {
    const pressure = value('P', 'Pa', forecastHour, level), t = value('T', 'K', forecastHour, level);
    const q = value('QV', 'kg kg**-1', forecastHour, level), dewpoint = specificHumidityDewpointC(q, pressure);
    const upper = value('HHL', 'm', 0, level), lower = value('HHL', 'm', 0, level + 1);
    const w = wind(value('U', 'm s**-1', forecastHour, level), value('V', 'm s**-1', forecastHour, level));
    if (!w || !finite(pressure) || !finite(t) || !finite(dewpoint) || !finite(upper) || !finite(lower)) return null;
    if (upper <= lower || lower < terrain - 1) throw new Error('ICON native half levels are inverted or below terrain');
    if (level === Math.max(...extract.levels) && Math.abs(lower - terrain) > 1) throw new Error('ICON bottom interface differs from model terrain');
    const heightM = (upper + lower) / 2;
    source.levels.push({ modelLevel: level, pressureHpa: pressure / 100, heightM, temperatureC: t - 273.15,
      dewPointDepressionC: Math.max(0, t - 273.15 - dewpoint), ...w });
  }
  source.levels.sort((a, b) => a.heightM - b.heightM);
  if (source.levels.length < 4) return null;
  return source;
}

/** A bounded hour read keeps the native field archive below V8 string limits. */
function recordsForHour(extract: IconExtract, forecastHour: number): Record<string, IconExtractRecord> {
  if (extract.records) return extract.records;
  const records: Record<string, IconExtractRecord> = {};
  for (const [key, metadata] of Object.entries(extract.recordManifest)) {
    if (metadata.field === 'HHL' || metadata.hour === forecastHour
      || (metadata.hour === forecastHour - 1 && ['ASHFL_S', 'ALHFL_S', 'TOT_PREC'].includes(metadata.field))) {
      records[key] = parseIconRecord(JSON.parse(readFileSync(extract.recordFiles[key], 'utf8')), extract.cells.length);
    }
  }
  return records;
}

export function normalizeIconExtract(extract: IconExtract): IconAcquisition {
  return {
    model: 'icon-eu', referenceTime: extract.referenceTime, grid: extract.grid, cells: extract.cells,
    siteCells: extract.siteCells, levels: extract.levels, provenance: {
      ...extract.provenance, capturedAt: new Date(extract.provenance.capturedAt).toISOString(),
      sourceObjects: Object.values(extract.records ?? extract.recordManifest).map(({ field, hour, level, metadata, source }) => ({
        field, forecastHour: hour, modelLevel: level, ...source,
        units: metadata.units, stepType: metadata.stepType, startHour: metadata.startHour, endHour: metadata.endHour,
      })),
    },
    hours: extract.forecastHours.map(forecastHour => {
      const hourly = { ...extract, records: recordsForHour(extract, forecastHour) };
      return { forecastHour,
        validAt: new Date(Date.parse(extract.referenceTime) + forecastHour * 3600000).toISOString().replace('.000Z', 'Z'),
        sources: extract.cells.map((_, index) => iconSource(hourly, forecastHour, index)),
      };
    }),
  };
}

/** Keep each JSON file to one forecast hour; a full native run exceeds V8's string limit. */
export function writeIconAcquisition(path: string, acquired: IconAcquisition): void {
  const absolute = resolve(path), folder = `${basename(absolute, '.json')}-hours`;
  mkdirSync(join(dirname(absolute), folder), { recursive: true });
  const hourFiles = acquired.hours.map(hour => {
    const bytes = JSON.stringify(hour) + '\n', sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `${folder}/f${String(hour.forecastHour).padStart(3, '0')}-${sha256}.json`;
    writeFileSync(join(dirname(absolute), file), bytes);
    return { forecastHour: hour.forecastHour, validAt: hour.validAt, file, sha256 };
  });
  const { hours, ...metadata } = acquired;
  writeFileSync(`${absolute}.tmp`, JSON.stringify({ ...metadata, acquisitionFormat: 'icon-hours-v1', hourFiles }) + '\n');
  renameSync(`${absolute}.tmp`, absolute);
}

export function readIconAcquisition(path: string): IconAcquisition {
  const absolute = resolve(path), raw: unknown = JSON.parse(readFileSync(absolute, 'utf8'));
  if (object(raw) && raw.hours) return parseIconAcquisition(raw);
  const metadata = parseIconArchive(raw); // Small retained trials remain readable.
  if (metadata.acquisitionFormat !== 'icon-hours-v1' || !Array.isArray(metadata.hourFiles)) throw new Error('Invalid ICON acquisition manifest');
  const { hourFiles, acquisitionFormat, ...base } = metadata;
  const hours = hourFiles.map(entry => {
    if (!/^[A-Za-z0-9_.-]+-hours\/f\d{3}-[a-f0-9]{64}\.json$/.test(entry.file)) throw new Error('Invalid ICON hour file path');
    const bytes = readFileSync(join(dirname(absolute), entry.file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('ICON hour checksum mismatch');
    const hour = parseIconHour(JSON.parse(bytes.toString('utf8')), { referenceTime: base.referenceTime, cellCount: base.cells.length });
    if (hour.forecastHour !== entry.forecastHour || hour.validAt !== entry.validAt || hour.sources.length !== base.cells.length) {
      throw new Error('ICON hour differs from its acquisition manifest');
    }
    return hour;
  });
  return { ...base, hours };
}

/** Download once per region/run, retain extracted arrays and checksummed provenance. */
export async function acquireIcon({ referenceTime, forecastHours = ICON_FORECAST_HOURS, sites = [], bbox,
  cacheDir, python = process.env.ICON_PYTHON ?? 'python3', concurrency = 8, maxDownloadBytes = 16_000_000_000,
  extractPath, acquisitionPath, signal, log = console.log }: IconAcquireOptions): Promise<IconAcquisition> {
  signal?.throwIfAborted();
  referenceTime = iconReferenceTime(referenceTime ?? (await discoverIconRun({ signal })).referenceTime);
  if (!forecastHours.length || forecastHours.some((h, i) => !Number.isInteger(h) || h < 1 || h > 78 || (i && h <= forecastHours[i-1]))) {
    throw new Error('ICON forecast hours must be unique ascending integers from 1 to 78');
  }
  if (!cacheDir) throw new Error('ICON cacheDir is required');
  bbox = iconBounds(bbox);
  const temporary = mkdtempSync(join(tmpdir(), 'windgrams-icon-'));
  const output = extractPath ? resolve(extractPath) : join(temporary, 'extracted.json');
  const request = join(temporary, 'request.json');
  mkdirSync(resolve(cacheDir), { recursive: true });
  writeFileSync(request, JSON.stringify({ referenceTime, forecastHours, sites, bbox, cacheDir: resolve(cacheDir), output,
    concurrency, maxDownloadBytes, levels: ICON_MODEL_LEVELS }));
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(python, [fileURLToPath(new URL('./icon-decode.py', import.meta.url)), request], { stdio: ['ignore', 'pipe', 'pipe'] });
      const abort = () => { child.kill('SIGTERM'); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let errors = '';
      child.stdout.on('data', chunk => log(chunk.toString().trim()));
      child.stderr.on('data', chunk => { errors += chunk; log(chunk.toString().trim()); });
      child.on('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(signal.reason);
        else if (code === 0) resolvePromise();
        else reject(new Error(errors.trim() || `ICON decoder exit ${code}`));
      });
    });
    const acquired = normalizeIconExtract(parseIconExtract(JSON.parse(readFileSync(output, 'utf8'))));
    if (acquisitionPath) writeIconAcquisition(acquisitionPath, acquired);
    return acquired;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

