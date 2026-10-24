// DWD ICON-EU v1 native triangular grid. Decoding stays in icon-decode.py;
// unit/time normalization and the shared soaring derivation stay here.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { roundDocument } from '@azohra/meteo.forecast';
import { deriveSiteForecast } from '../../soaring/vendor/derive-0.6.0.mjs';
import { postprocessPointForecast } from '../../soaring/point-postprocess.mjs';

export const ICON_BASE = 'https://opendata.dwd.de/weather/nwp/v1/m/icon-eu/p/';
export const ICON_MODEL_LEVELS = Object.freeze(Array.from({ length: 30 }, (_, i) => 45 + i));
export const ICON_FORECAST_HOURS = Object.freeze(Array.from({ length: 78 }, (_, i) => i + 1));
export const ICON_SEMANTICS = Object.freeze({ gust: 'hourMax', precipitation: 'windowMeanRate' });
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function iconBounds(value) {
  if (value === undefined) return undefined;
  const bbox = Array.isArray(value) ? Object.fromEntries(['west', 'south', 'east', 'north'].map((key, i) => [key, value[i]])) : value;
  if (!bbox || !['west', 'south', 'east', 'north'].every(key => finite(bbox[key]))
    || bbox.west < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90
    || bbox.west >= bbox.east || bbox.south >= bbox.north) throw new Error('Invalid ICON bounding box');
  return bbox;
}

export function iconReferenceTime(referenceTime) {
  const t = new Date(referenceTime);
  if (!finite(t.getTime()) || t.getUTCMinutes() || t.getUTCSeconds() || t.getUTCMilliseconds() || t.getUTCHours() % 6) {
    throw new Error('ICON-EU requires an explicit 00, 06, 12 or 18 UTC main run');
  }
  return t.toISOString().replace('.000Z', 'Z');
}

export function iconFieldUrl(field, referenceTime, forecastHour, level = null) {
  const run = iconReferenceTime(referenceTime);
  if (!/^[A-Z][A-Z0-9_]*$/.test(field) || !Number.isInteger(forecastHour) || forecastHour < 0 || forecastHour > 120
    || (level !== null && (!Number.isInteger(level) || level < 1 || level > 75))) throw new Error('Invalid ICON field request');
  return `${ICON_BASE}${field}${level === null ? '' : `/lvt1/150/lv1/${level}`}/r/${run.slice(0, 16).replace(':', '%3A')}/s/PT${String(forecastHour).padStart(3, '0')}H00M.grib2`;
}

/** Main runs keep the three-day horizon stable while short intermediate cycles arrive. */
export async function discoverIconRun({ now = new Date(), fetchFn = fetch, lastForecastHour = 78 } = {}) {
  const response = await fetchFn(`${ICON_BASE}HSURF/r/`);
  if (!response.ok) throw new Error(`ICON run inventory HTTP ${response.status}`);
  const text = await response.text();
  const candidates = [...text.matchAll(/href="(\d{4}-\d\d-\d\dT\d\d(?:%3A|:)00)\/"/gi)]
    .map(match => `${decodeURIComponent(match[1])}:00Z`)
    .filter(run => Number.isFinite(Date.parse(run)) && new Date(run).getUTCHours() % 6 === 0 && Date.parse(run) <= +now)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  for (const referenceTime of candidates) {
    const urls = [iconFieldUrl('T', referenceTime, lastForecastHour, 74), iconFieldUrl('P', referenceTime, lastForecastHour, 45),
      iconFieldUrl('TOT_PREC', referenceTime, lastForecastHour), iconFieldUrl('ASHFL_S', referenceTime, lastForecastHour)];
    const probes = await Promise.all(urls.map(url => fetchFn(url, { method: 'HEAD' })));
    if (probes.every(probe => probe.ok)) return { referenceTime: iconReferenceTime(referenceTime), forecastHours: lastForecastHour, completionUrls: urls };
  }
  throw new Error('ICON-EU has no complete main run; keep the last published forecast');
}

/** QV is specific humidity (kg water / kg moist air), not mixing ratio. */
export function iconDewPointC(specificHumidity, pressurePa) {
  if (!finite(specificHumidity) || specificHumidity <= 0 || specificHumidity >= 1 || !finite(pressurePa) || pressurePa <= 0) return null;
  const vaporPressureHpa = specificHumidity * pressurePa / (0.622 + 0.378 * specificHumidity) / 100;
  const logarithm = Math.log(vaporPressureHpa / 6.112);
  return 243.5 * logarithm / (17.67 - logarithm);
}

/** Convert DWD's run-mean downward flux to the preceding hour's upward mean. */
export function iconHourlyFlux(current, previous, index) {
  const c = current?.metadata, p = previous?.metadata;
  if (!c || !p || c.stepType !== 'avg' || p.stepType !== 'avg' || c.units !== 'W m**-2' || p.units !== c.units
    || c.startHour !== 0 || p.startHour !== 0 || c.endHour - p.endHour !== 1 || c.endHour <= 0) {
    throw new Error('ICON heat flux requires consecutive run-mean W/m² intervals');
  }
  const v = current.values[index], prev = previous.values[index];
  if (!finite(v) || (p.endHour > 0 && !finite(prev))) return null;
  return -(v * c.endHour - (p.endHour === 0 ? 0 : prev * p.endHour));
}

/** Accumulated kg/m² equals mm liquid equivalent; each output is one hour. */
export function iconHourlyPrecipitation(current, previous, index) {
  const c = current?.metadata, p = previous?.metadata;
  if (!c || !p || c.stepType !== 'accum' || p.stepType !== 'accum' || c.units !== 'kg m**-2' || p.units !== c.units
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

function wind(u, v) {
  if (!finite(u) || !finite(v)) return null;
  return { windSpeedMps: Math.hypot(u, v), windDirectionDeg: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
}

/** Normalize one native cell with all 30 terrain-following levels unchanged. */
export function iconSource(extract, forecastHour, cellIndex) {
  const record = (field, hour = forecastHour, level = null) => extract.records[`${field}:${hour}:${level === null ? 'None' : level}`];
  const value = (field, units, hour = forecastHour, level = null) => {
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
  if (!surfaceWind || ![temperatureK, dewpointK, sensible, latent, precipitation, cloudCover, pmsl].every(finite)) return null;
  const source = {
    validAt: new Date(Date.parse(extract.referenceTime) + forecastHour * 3600000).toISOString().replace('.000Z', 'Z'),
    temperatureC: temperatureK - 273.15, dewPointDepressionC: Math.max(0, temperatureK - dewpointK), ...surfaceWind,
    cloudCoverPercent: cloudCover, sensibleHeatFluxWm2: sensible, latentHeatFluxWm2: latent,
    precipitationMm: precipitation, seaLevelPressureHpa: pmsl / 100, levels: [],
  };
  const gust = record('VMAX_10M').metadata;
  if (gust.stepType !== 'max' || gust.startHour !== forecastHour - 1 || gust.endHour !== forecastHour) {
    throw new Error('ICON gust requires a maximum over the preceding hour');
  }
  const optional = [['VMAX_10M', 'windGustMps', 'm s**-1'], ['CAPE_ML', 'capeJkg', 'J kg-1'],
    ['CIN_ML', 'cinJkg', 'J kg-1'], ['MH', 'pblHeightM', 'm'], ['CLCL', 'lowCloudPercent', '%'],
    ['CLCM', 'midCloudPercent', '%'], ['CLCH', 'highCloudPercent', '%']];
  for (const [field, key, unit] of optional) {
    const v = value(field, unit);
    if (finite(v)) source[key] = key === 'cinJkg' ? -Math.abs(v) : v;
  }
  const terrain = extract.cells[cellIndex].terrainM;
  for (const level of extract.levels) {
    const pressure = value('P', 'Pa', forecastHour, level), t = value('T', 'K', forecastHour, level);
    const q = value('QV', 'kg kg**-1', forecastHour, level), dewpoint = iconDewPointC(q, pressure);
    const upper = value('HHL', 'm', 0, level), lower = value('HHL', 'm', 0, level + 1);
    const w = wind(value('U', 'm s**-1', forecastHour, level), value('V', 'm s**-1', forecastHour, level));
    if (!w || ![pressure, t, dewpoint, upper, lower].every(finite)) return null;
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
function recordsForHour(extract, forecastHour) {
  if (extract.records) return extract.records;
  const records = {};
  for (const [key, metadata] of Object.entries(extract.recordManifest)) {
    if (metadata.field === 'HHL' || metadata.hour === forecastHour
      || (metadata.hour === forecastHour - 1 && ['ASHFL_S', 'ALHFL_S', 'TOT_PREC'].includes(metadata.field))) {
      records[key] = JSON.parse(readFileSync(extract.recordFiles[key], 'utf8'));
    }
  }
  return records;
}

export function normalizeIconExtract(extract) {
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
export function writeIconAcquisition(path, acquired) {
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

export function readIconAcquisition(path) {
  const absolute = resolve(path), metadata = JSON.parse(readFileSync(absolute, 'utf8'));
  if (metadata.hours) return metadata; // Small retained trials remain readable.
  if (metadata.acquisitionFormat !== 'icon-hours-v1' || !Array.isArray(metadata.hourFiles)) throw new Error('Invalid ICON acquisition manifest');
  const { hourFiles, acquisitionFormat, ...base } = metadata;
  const hours = hourFiles.map(entry => {
    if (!/^[A-Za-z0-9_.-]+-hours\/f\d{3}-[a-f0-9]{64}\.json$/.test(entry.file)) throw new Error('Invalid ICON hour file path');
    const bytes = readFileSync(join(dirname(absolute), entry.file));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('ICON hour checksum mismatch');
    const hour = JSON.parse(bytes.toString('utf8'));
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
  extractPath, acquisitionPath, log = console.log } = {}) {
  referenceTime = iconReferenceTime(referenceTime ?? (await discoverIconRun()).referenceTime);
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
    await new Promise((resolvePromise, reject) => {
      const child = spawn(python, [fileURLToPath(new URL('./icon-decode.py', import.meta.url)), request], { stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      child.stdout.on('data', chunk => log(chunk.toString().trim()));
      child.stderr.on('data', chunk => { errors += chunk; log(chunk.toString().trim()); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolvePromise() : reject(new Error(errors.trim() || `ICON decoder exit ${code}`)));
    });
    const acquired = normalizeIconExtract(JSON.parse(readFileSync(output, 'utf8')));
    if (acquisitionPath) writeIconAcquisition(acquisitionPath, acquired);
    return acquired;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Map and point both call this function on the same captured native-cell source. */
export function deriveIconProfile(acquired, cellIndex, site, { launchElevationM = null, generatedAt = acquired.provenance.capturedAt } = {}) {
  const cell = acquired.cells[cellIndex];
  if (!cell) throw new Error('ICON cell index is outside the extraction');
  const hours = acquired.hours.map(hour => hour.sources[cellIndex]);
  if (hours.some(hour => !hour)) throw new Error(`ICON ${site.slug}: incomplete native profile`);
  const profile = roundDocument(deriveSiteForecast({ siteId: site.slug, siteName: site.name, latitude: site.latitude, longitude: site.longitude,
    siteTimeZone: site.timeZone ?? 'Asia/Yerevan', modelElevationM: cell.terrainM,
    referenceTime: acquired.referenceTime, generatedAt, hours }, 'icon-eu', ICON_SEMANTICS));
  // The common publication table leaves arbitrary native pressures untouched.
  for (const hour of profile.hours) for (const level of hour.levels) level.pressureHpa = Math.round(level.pressureHpa * 100) / 100;
  const result = postprocessPointForecast(profile, { modelSlug: 'icon-eu', launchElevationM });
  result.source = { provider: 'DWD', license: 'CC BY 4.0', product: ICON_BASE, gridUuid: acquired.grid.uuid,
    gridIndex: cell.index, latitude: cell.latitude, longitude: cell.longitude, nativeModelLevels: acquired.levels,
    heatFlux: 'Preceding-hour upward mean from successive DWD run means', precipitation: 'Preceding-hour accumulation difference' };
  return result;
}

/** Writes staged files; the caller owns atomic publication and history. */
export async function buildIconPointProfiles({ sitesPath, sites, outputRoot, referenceTime, maxSteps,
  acquisition, ...options } = {}) {
  sites ??= JSON.parse(readFileSync(sitesPath, 'utf8')).sites;
  sites = sites.filter(site => site.country === 'AM' || site.region === 'am' || site.slug.startsWith('am-'));
  if (!sites.length) throw new Error('ICON-EU catalogue has no Armenian launches');
  const forecastHours = maxSteps ? ICON_FORECAST_HOURS.slice(0, maxSteps) : ICON_FORECAST_HOURS;
  const acquired = acquisition ?? await acquireIcon({ ...options, sites, referenceTime, forecastHours });
  const generatedAt = acquired.provenance.capturedAt;
  const root = join(outputRoot, 'icon-eu');
  mkdirSync(join(root, 'sites'), { recursive: true });
  for (const site of sites) {
    const doc = deriveIconProfile(acquired, acquired.siteCells[site.slug], site, { generatedAt });
    writeFileSync(join(root, 'sites', `${site.slug}.json`), `${JSON.stringify(doc)}\n`);
  }
  const manifest = { schemaVersion: 1, model: 'icon-eu', referenceTime: acquired.referenceTime, generatedAt,
    firstForecastHour: acquired.hours[0].forecastHour, lastForecastHour: acquired.hours.at(-1).forecastHour,
    forecastHours: acquired.hours.length, sites: sites.map(({ name, slug }) => ({ name, slug })),
    stats: { downloads: acquired.provenance.downloads ?? (acquired.provenance.downloadedBytes ? acquired.provenance.sourceObjects.length + (acquired.grid.geometrySource?.records?.length ?? 0) : 0),
      downloadBytes: acquired.provenance.downloadedBytes, retries: acquired.provenance.retries ?? 0, durationMs: Math.round(acquired.provenance.elapsedSeconds * 1000) } };
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, 'source.json'), `${JSON.stringify({ grid: acquired.grid, provenance: acquired.provenance })}\n`);
  return { acquired, manifest };
}
