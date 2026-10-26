// Offline implementation/reference comparison from source weather. Outputs are experiments, never issued history.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveDiagnosticsV2, SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { normalizeIconExtract } from '@windgrams/providers/icon';
import { deriveSiteForecast } from '../soaring/vendor/derive-0.6.0.mjs';
import { referenceDiagnostics, referenceParcelDepth, compareDownsampling } from './thermal-reference.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const finite = Number.isFinite;
const fixtureRoot = new URL('../soaring/fixtures/', import.meta.url);
const depression = (value) =>
  finite(value.dewPointDepressionC)
    ? value.dewPointDepressionC
    : finite(value.dewPointC) && finite(value.temperatureC)
      ? value.temperatureC - value.dewPointC
      : null;

/** Frozen raw-source weather: 14 HRRR hours, one RRFS hour and three dense ICON cells. */
export function frozenThermalColumns() {
  const load = (file) => {
    const bytes = readFileSync(new URL(file, fixtureRoot));
    return { document: JSON.parse(bytes), evidence: { file, sha256: sha(bytes) } };
  };
  const hrrr = load('blanchard-raw.json'),
    rrfs = load('rrfs-native-column.json');
  const records = hrrr.document.hours.map((hour) => ({
    id: `hrrr-f${hour.forecastHour}`,
    model: 'hrrr-conus',
    referenceTime: '2026-10-21T00:00:00Z',
    terrainM: hrrr.document.terrain,
    evidence: hrrr.evidence,
    column: { ...hour.source, pblHeightM: hour.raw.pblHeightM },
  }));
  const raw = rrfs.document.raw;
  const levels = Object.keys(raw)
    .filter((key) => /^\d+\.HGT$/.test(key))
    .map((key) => Number(key.split('.')[0]))
    .sort((a, b) => b - a)
    .map((p) => ({
      pressureHpa: p,
      heightM: raw[`${p}.HGT`],
      temperatureC: raw[`${p}.TMP`] - 273.15,
      dewPointDepressionC: raw[`${p}.TMP`] - raw[`${p}.DPT`],
      windSpeedMps: Math.hypot(raw[`${p}.UGRD`], raw[`${p}.VGRD`]),
      windDirectionDeg: ((Math.atan2(-raw[`${p}.UGRD`], -raw[`${p}.VGRD`]) * 180) / Math.PI + 360) % 360,
    }));
  records.push({
    id: 'rrfs-f8',
    model: 'rrfs',
    referenceTime: rrfs.document.case.referenceTime,
    terrainM: rrfs.document.terrain,
    evidence: rrfs.evidence,
    column: {
      validAt: '2026-10-23T14:00:00Z',
      temperatureC: raw.temperature - 273.15,
      dewPointDepressionC: raw.temperature - raw.dewpoint,
      sensibleHeatFluxWm2: raw.sensibleHeatFluxWm2,
      latentHeatFluxWm2: raw.latentHeatFluxWm2,
      pblHeightM: raw.pblHeightM,
      windSpeedMps: Math.hypot(raw.u, raw.v),
      windDirectionDeg: ((Math.atan2(-raw.u, -raw.v) * 180) / Math.PI + 360) % 360,
      levels,
    },
  });
  const iconBytes = readFileSync(new URL('../scripts/lib/icon-native-fixture.json', import.meta.url));
  const icon = normalizeIconExtract(JSON.parse(iconBytes));
  for (const [index, cell] of icon.cells.entries())
    records.push({
      id: `icon-native-${cell.index}`,
      model: 'icon-eu',
      referenceTime: icon.referenceTime,
      terrainM: cell.terrainM,
      evidence: {
        file: '../scripts/lib/icon-native-fixture.json',
        sha256: sha(iconBytes),
        cellId: cell.id,
        description:
          'DWD native engineering sample near Hatis, Sevan or Tatev; coordinates are not verified launch positions.',
      },
      column: icon.hours[0].sources[index],
      downsampleTargetCount: 9,
    });
  return records;
}

/** Input records: {id, model, referenceTime, terrainM, column, evidence}; column contains source weather only. */
export function evaluateThermalColumns(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('At least one source-column record is required');
  const columns = records.map((record) => {
    const { column, terrainM } = record;
    if (!finite(terrainM) || !Array.isArray(column?.levels) || column.levels.length < 3)
      throw new Error(`Invalid source column: ${record.id}`);
    // Production baseline receives the same full source weather; its cap is checked
    // against the independent cap, never supplied as an input to that reference.
    const legacySource = {
      ...column,
      dewPointDepressionC: depression(column),
      levels: column.levels.map((level) => ({ ...level, dewPointDepressionC: depression(level) })),
    };
    const baseline = deriveSiteForecast(
      {
        siteId: record.id,
        siteName: record.id,
        latitude: 0,
        longitude: 0,
        modelElevationM: terrainM,
        referenceTime: record.referenceTime,
        generatedAt: record.referenceTime,
        hours: [legacySource],
      },
      record.model,
      {},
    ).hours[0];
    const actual = deriveDiagnosticsV2(terrainM, column, baseline),
      reference = referenceDiagnostics(column, terrainM);
    const checks = Object.keys(reference)
      .filter((field) => field !== 'support')
      .map((field) => {
        const expected = reference[field],
          value = actual?.[field] ?? null,
          tolerance = field === 'thermalVelocityV2Mps' ? 0.011 : 0.11;
        const difference = finite(value) && finite(expected) ? value - expected : null;
        return {
          field,
          expected,
          actual: value,
          difference,
          tolerance,
          pass: (value === null && expected === null) || (difference !== null && Math.abs(difference) <= tolerance),
        };
      });
    const retained = record.downsampleTargetCount
      ? Array.from({ length: record.downsampleTargetCount }, (_, index) =>
          Math.round((index * (column.levels.length - 1)) / (record.downsampleTargetCount - 1)),
        )
      : column.levels.map((_, index) => index).filter((index) => index % 2 === 0 || index === column.levels.length - 1);
    return {
      id: record.id,
      model: record.model,
      referenceTime: record.referenceTime,
      validAt: column.validAt,
      terrainM,
      evidence: record.evidence ?? null,
      checks,
      reference,
      downsampling: compareDownsampling(column, terrainM, retained),
    };
  });
  const checks = columns.flatMap((column) => column.checks);
  const sensitivityColumn = {
    temperatureC: 20,
    dewPointC: 10,
    sensibleHeatFluxWm2: 100,
    latentHeatFluxWm2: 0,
    pblHeightM: 650,
    levels: [
      { heightM: 1000, temperatureC: 10 },
      { heightM: 2000, temperatureC: 0 },
      { heightM: 3000, temperatureC: -10 },
    ],
  };
  const branchSweep = Array.from({ length: 21 }, (_, index) => {
    const temperatureC = 19.7 + index * 0.01;
    return { temperatureC, ...referenceParcelDepth({ ...sensitivityColumn, temperatureC }, 0) };
  });
  return {
    schemaVersion: 1,
    experiment: 'independent-raw-column-thermal-reference/1.0.0',
    productionMethod: SOARING_CONTRACT_VERSION,
    inputSha256: sha(JSON.stringify(records)),
    columns: columns.length,
    checks: checks.length,
    failures: checks.filter((check) => !check.pass).length,
    policy: 'Recomputed experiment; no issued forecast or archive bytes are modified.',
    results: columns,
    branchSweep: {
      kind: 'synthetic sensitivity, not observed weather',
      records: branchSweep,
      note: 'A change from the shallow PBL closure to an upper-column parcel crossing is a method choice, not a claim that the atmosphere jumps.',
    },
    limitations: [
      'Agreement checks implementation of the declared policy, not physical forecast accuracy.',
      'The NOAA cases contain selected pressure levels. Three DWD cells provide 30 native levels each for a real dense-to-nine-node sensitivity test, not general model validation.',
      'ICON normalization uses the existing provider adapter; the independent equations validate diagnostics after that boundary, not the adapter itself.',
      'Downsampling only removes existing levels; it cannot establish the weather between the original samples.',
      'RRFS wind components are not rotated in this thermal-only fixture loader and no wind results are evaluated.',
      'Cloud saturation is a sampled humidity proxy and LCL is a potential parcel level. Neither proves observed cloud.',
      'Missing moisture is excluded by the independent cap calculation; it does not bridge an unknown layer.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
    const records = values.input ? JSON.parse(readFileSync(resolve(values.input), 'utf8')) : frozenThermalColumns();
    const report = evaluateThermalColumns(records),
      output = JSON.stringify(report, null, 2) + '\n';
    if (values.output) writeFileSync(resolve(values.output), output, { flag: 'wx' });
    else process.stdout.write(output);
    if (report.failures) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
