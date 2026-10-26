// Compare captured source modes offline; write a report and optional experimental profiles.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { parseNormalizedColumnRecord } from '@windgrams/contracts';
import { validPosition } from '@windgrams/geography';
import { modelDescriptor } from '@windgrams/providers/registry';
import { deriveDiagnosticsV2, SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { postprocessPointForecast } from '@windgrams/soaring/compatibility';
import { deriveSourceForecast } from '../soaring/source-profile.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fields = ['resolvedThermalTopM', 'thermalVelocityV2Mps', 'usableLiftTopV2M', 'hcritWxtoflyM',
  'surfaceLclM', 'effectiveCloudLimitM', 'mixedLayerLclM', 'blMeanWindSpeedMps', 'blWindShearMps'];
const nativeFields = ['nativeCloudBaseM', 'nativeCloudCeilingM', 'nativeCloudTopM',
  'nativeAdiabaticLclM', 'nativeLfcM', 'nativeEquilibriumLevelM'];
const modes = ['legacy-pressure', 'expanded-pressure', 'hrrr-native'];
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

function validateCapture(capture) {
  if (!capture || capture.schemaVersion !== 1 || !['hrrr-conus', 'rrfs', 'gfs'].includes(capture.model)
    || !modes.includes(capture.verticalMode) || capture.verticalMode === 'hrrr-native' && capture.model !== 'hrrr-conus'
    || !timestamp(capture.referenceTime) || !timestamp(capture.capturedAt) || !capture.grid?.gridKey
    || !Array.isArray(capture.cells) || !capture.cells.length
    || !Array.isArray(capture.hours) || !capture.hours.length || !Array.isArray(capture.assets)) {
    throw new Error('Invalid NOAA capture');
  }
  const cells = new Set();
  for (const cell of capture.cells) {
    if (!cell || typeof cell.id !== 'string' || !cell.id || cells.has(cell.id) || !validPosition(cell)
      || !Number.isFinite(cell.modelElevationM)) throw new Error('Invalid or duplicate capture cell');
    cells.add(cell.id);
  }
  for (const asset of capture.assets) {
    if (!asset || typeof asset.url !== 'string' || !asset.url || !(asset.range === null || typeof asset.range === 'string')
      || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid capture source asset');
  }
  const schedule = modelDescriptor(capture.model).forecastHours;
  const hours = new Set();
  for (const hour of capture.hours) {
    if (!hour || !schedule.includes(hour.forecastHour) || hours.has(hour.forecastHour)
      || Date.parse(hour.validAt) !== Date.parse(capture.referenceTime) + hour.forecastHour * 3_600_000
      || !Array.isArray(hour.columns) || hour.columns.length !== capture.cells.length) throw new Error('Capture hours or cell counts are inconsistent');
    hours.add(hour.forecastHour);
    for (const [index, column] of hour.columns.entries()) {
      if (column === null) continue;
      const cell = capture.cells[index];
      if (!parseNormalizedColumnRecord(column) || column.column.validAt !== hour.validAt
        || column.modelElevationM !== cell.modelElevationM || column.provenance.gridCell.id !== cell.id
        || column.provenance.gridCell.latitude !== cell.latitude || column.provenance.gridCell.longitude !== cell.longitude
        || column.provenance.sources.some(source => source.model !== capture.model || source.referenceTime !== capture.referenceTime
          || source.gridId !== capture.grid.gridKey)) {
        throw new Error('Capture column identity or units are invalid');
      }
    }
  }
}

/** Load a source capture and validate its columns and native identities. */
export async function readNoaaCapture(path) {
  const bytes = await readFile(path), capture = JSON.parse(bytes);
  validateCapture(capture);
  let acquisitionMetrics = null;
  try {
    const metricsBytes = await readFile(`${path}.metrics.json`), metrics = JSON.parse(metricsBytes);
    acquisitionMetrics = { ...metrics, file: resolve(`${path}.metrics.json`), sha256: sha(metricsBytes) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { path: resolve(path), sha256: sha(bytes), capture, acquisitionMetrics };
}

function baselineProfile(column, capture, cell) {
  return deriveSourceForecast({ siteId: cell.id, siteName: cell.id, latitude: cell.latitude, longitude: cell.longitude,
    modelElevationM: cell.modelElevationM, referenceTime: capture.referenceTime, generatedAt: capture.capturedAt,
    hours: [column],
  }, capture.model, { gust: 'instant', precipitation: capture.model === 'hrrr-conus' ? 'instantRate' : 'windowMeanRate' });
}

const metrics = value => Object.fromEntries(fields.map(field => [field, value?.[field] ?? null]));
const delta = (before, after) => Object.fromEntries(fields.map(field => [field,
  Number.isFinite(before?.[field]) && Number.isFinite(after?.[field]) ? after[field] - before[field] : null]));

function appendProfile(groups, key, profile, mode) {
  const group = groups.get(key);
  if (!group) {
    groups.set(key, { model: profile.model, mode, referenceTime: profile.run.referenceTime, cellId: profile.site.id, profile });
    return;
  }
  if (['modelElevationM', 'latitude', 'longitude'].some(field => group.profile.site[field] !== profile.site[field])) {
    throw new Error(`Inconsistent source profile cell: ${key}`);
  }
  group.profile.hours.push(...profile.hours);
  if (Date.parse(profile.run.generatedAt) > Date.parse(group.profile.run.generatedAt)) group.profile.run.generatedAt = profile.run.generatedAt;
}

/** Compare captured columns with matching run, valid time and native cell. */
export function evaluateNoaaSources(inputs) {
  const started = performance.now(), records = [], captures = [], profileGroups = new Map();
  const seen = new Set();
  for (const input of inputs) {
    const { capture } = input, schedule = modelDescriptor(capture.model).forecastHours;
    const requestedHours = capture.hours.map(hour => hour.forecastHour);
    const sourceAssets = new Map(capture.assets.map(asset => [`${asset.url}|${asset.range}`, asset]));
    const sourceBytes = [...sourceAssets.values()].reduce((total, asset) => total + asset.size, 0);
    const excluded = [];
    for (const hour of capture.hours) for (const [index, record] of hour.columns.entries()) {
      const cell = capture.cells[index];
      if (!record) { excluded.push({ forecastHour: hour.forecastHour, cellId: cell.id, reason: hour.missingReasons?.[index] ?? 'missing column' }); continue; }
      const key = [capture.model, capture.referenceTime, hour.validAt, record.provenance.sources[0].gridId, cell.id].join('|');
      const modeKey = `${key}|${capture.verticalMode}`;
      if (seen.has(modeKey)) throw new Error(`Duplicate source-mode column: ${modeKey}`);
      seen.add(modeKey);
      const published = baselineProfile(record.column, capture, cell);
      const diagnostic = deriveDiagnosticsV2(cell.modelElevationM, record.column, published.hours[0]);
      records.push({ key, mode: capture.verticalMode, model: capture.model, referenceTime: capture.referenceTime,
        validAt: hour.validAt, cellId: cell.id, latitude: cell.latitude, longitude: cell.longitude, terrainM: cell.modelElevationM,
        sourceSha256: input.sha256, record, capture, cell,
        diagnostics: metrics(diagnostic), support: diagnostic?.diagnosticSupport ?? null,
        sampling: diagnostic?.verticalResolution.sampling ?? null,
        nativeFields: Object.fromEntries(nativeFields.map(field => [field, record.column[field] ?? null])) });
      const profileKey = [capture.model, capture.verticalMode, capture.referenceTime, record.provenance.sources[0].gridId, cell.id].join('|');
      appendProfile(profileGroups, profileKey, published, capture.verticalMode);
    }
    const missingHorizonHours = schedule.filter(hour => !requestedHours.includes(hour));
    captures.push({ file: input.path, sha256: input.sha256, model: capture.model, mode: capture.verticalMode,
      referenceTime: capture.referenceTime, capturedHours: requestedHours, expectedHours: schedule,
      missingHorizonHours, fullHorizon: missingHorizonHours.length === 0, cells: capture.cells.length,
      missingColumns: excluded, sourceAssets: sourceAssets.size, sourceBytes,
      acquisitionMetrics: input.acquisitionMetrics ?? null,
      adapterImplementationSha256: capture.adapterImplementationSha256,
      estimatedFullHorizonSourceBytes: Math.ceil(sourceBytes * schedule.length / requestedHours.length),
      estimateNote: 'Extrapolated from captured hours, including reused cache bytes and repeated terrain overhead.' });
  }
  const profiles = [...profileGroups.values()].map(group => ({ ...group, profile: postprocessPointForecast({ ...group.profile,
    hours: group.profile.hours.sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt)),
  }) }));
  const baselines = new Map(records.filter(row => row.mode === 'legacy-pressure').map(row => [row.key, row]));
  const comparisons = [], unmatched = [];
  for (const candidate of records.filter(row => row.mode !== 'legacy-pressure')) {
    const baseline = baselines.get(candidate.key);
    if (!baseline || baseline.terrainM !== candidate.terrainM || baseline.latitude !== candidate.latitude || baseline.longitude !== candidate.longitude) {
      unmatched.push({ key: candidate.key, mode: candidate.mode, reason: 'Missing legacy match for run, valid time, grid, cell, location and terrain' }); continue;
    }
    const base = baseline.record.column, next = candidate.record.column;
    const variants = {
      pressureOnly: { ...base, surfacePressureHpa: next.surfacePressureHpa },
      levelsOnly: { ...base, levels: next.levels },
      wind80mOnly: { ...base, wind80mSpeedMps: next.wind80mSpeedMps, wind80mDirectionDeg: next.wind80mDirectionDeg },
    };
    const outputs = Object.fromEntries(Object.entries(variants).map(([name, column]) => [name,
      metrics(deriveDiagnosticsV2(candidate.terrainM, column, baselineProfile(column, candidate.capture, candidate.cell).hours[0])),
    ]));
    outputs.candidate = candidate.diagnostics;
    comparisons.push({ key: candidate.key, model: candidate.model, candidateMode: candidate.mode, baseline: baseline.diagnostics,
      outputs, differencesFromBaseline: Object.fromEntries(Object.entries(outputs).map(([name, values]) => [name, delta(baseline.diagnostics, values)])),
      absenceChanges: Object.fromEntries(Object.entries(outputs).map(([name, values]) => [name, fields.filter(field => (baseline.diagnostics[field] === null) !== (values[field] === null))])) });
  }
  return { report: {
    schemaVersion: 1, experiment: 'noaa-source-impact/1.0.0', method: SOARING_CONTRACT_VERSION,
    elapsedEvaluationMs: Math.round(performance.now() - started), captures,
    rows: records.map(({ key, mode, model, referenceTime, validAt, cellId, terrainM, sourceSha256, diagnostics, support, sampling, nativeFields }) =>
      ({ key, mode, model, referenceTime, validAt, cellId, terrainM, sourceSha256, diagnostics, support, sampling, nativeFields })),
    comparisons, unmatched,
    productionDefault: 'legacy-pressure', publicationReady: false,
    limits: ['Measures diagnostic sensitivity to source selection.',
      'Pairs share run, valid time, native grid/cell, location and terrain; unavailable fields remain null.',
      'Full-horizon byte estimates scale the captured source bytes. A full capture supplies actual bytes and elapsed time.',
      'Native cloud heights provide model context; usable lift retains the current effective cloud-limit policy.'],
  }, profiles };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { captures: { type: 'string' }, output: { type: 'string' }, profiles: { type: 'string' } } });
  if (!values.captures || !values.output) throw new Error('Usage: --captures FILE,FILE,... --output NEW_REPORT.json [--profiles NEW_DIRECTORY]');
  const inputs = await Promise.all(values.captures.split(',').map(readNoaaCapture));
  const { report, profiles } = evaluateNoaaSources(inputs);
  if (values.profiles) {
    await mkdir(values.profiles); // Requires a new output directory.
    for (const [index, value] of profiles.entries()) {
      await writeFile(join(values.profiles, `${value.model}-${value.mode}-${index}.json`), `${JSON.stringify(value.profile)}\n`, { flag: 'wx' });
    }
  }
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output: values.output, captures: inputs.length, columns: report.rows.length,
    comparisons: report.comparisons.length, unmatched: report.unmatched.length, fullHorizonCaptures: report.captures.filter(capture => capture.fullHorizon).length }));
}
