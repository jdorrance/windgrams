// Compare model-ground and 10 m wind anchors using frozen columns.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { parseAtmosphericColumn } from '@windgrams/contracts';
import { computeBoundaryLayerWind } from '@windgrams/meteorology';
import { deriveDiagnosticsV2, SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { resolvedParcelDepthM } from '@windgrams/soaring/compatibility';
import { frozenThermalColumns } from './thermal-experiment.mjs';

const keys = ['blMeanWindSpeedMps', 'blTopWindSpeedMps', 'blWindShearMps', 'buoyancyShearRatio'];
const finite = Number.isFinite;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const band = depth => depth <= 10 ? '0–10 m' : depth <= 100 ? '10–100 m' : depth <= 500 ? '100–500 m' : '>500 m';
const aboveGround = (terrainM, column) => column.levels.filter(level => finite(level?.heightM) && level.heightM > terrainM + 20).sort((a, b) => a.heightM - b.heightM);

/** Hold wind samples and layer top fixed; compare means from model ground and 10 m AGL. */
export function compareWindAnchors(terrainM, column, layerTopM, thermalVelocityMps) {
  if (!finite(terrainM) || !Array.isArray(column?.levels)) throw new Error('Wind comparison requires model terrain and column levels');
  const levels = aboveGround(terrainM, column);
  const surface = { windSpeedMps: column.windSpeedMps, windDirectionDeg: column.windDirectionDeg };
  const wind80 = finite(column.wind80mSpeedMps) && finite(column.wind80mDirectionDeg)
    ? { windSpeedMps: column.wind80mSpeedMps, windDirectionDeg: column.wind80mDirectionDeg } : null;
  const addRatio = wind => wind ? { ...wind, buoyancyShearRatio: finite(thermalVelocityMps)
    ? thermalVelocityMps / Math.max(0.2, wind.blWindShearMps) : null } : null;
  const baseline = finite(layerTopM) ? addRatio(computeBoundaryLayerWind(terrainM, surface, levels, layerTopM, wind80)) : null;
  // Keep the 80 m wind at terrain + 80 m when shifting the lower boundary.
  const physicalLevels = [...levels, ...(wind80 ? [{ heightM: terrainM + 80, ...wind80 }] : [])];
  const candidate = finite(layerTopM) && layerTopM > terrainM + 10
    ? addRatio(computeBoundaryLayerWind(terrainM + 10, surface, physicalLevels, layerTopM)) : null;
  const unavailableReason = !finite(layerTopM) ? 'Layer top is unavailable'
    : layerTopM <= terrainM + 10 ? 'Layer top is at or below the 10 m lower boundary'
    : candidate ? null : 'Wind samples are unavailable for integration';
  return { baseline, candidate, unavailableReason,
    deltas: Object.fromEntries(keys.map(key => [key,
      finite(baseline?.[key]) && finite(candidate?.[key]) ? candidate[key] - baseline[key] : null])) };
}

function distribution(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const at = p => sorted.length ? sorted[Math.round((sorted.length - 1) * p)] : null;
  return { count: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    min: at(0), p50: at(.5), p90: at(.9), max: at(1) };
}

/** Records use {id, model, terrainM, column, evidence}; optional layerTopM marks synthetic cases. */
export function evaluateWindAnchors(records) {
  const results = records.map(record => {
    const { column, terrainM } = record;
    const overridden = record.layerTopM != null;
    if (!finite(terrainM) || !parseAtmosphericColumn(column)
      || overridden && (!finite(record.layerTopM) || record.layerTopM < terrainM)) throw new Error(`Invalid column or layer top: ${record.id}`);
    const levels = aboveGround(terrainM, column);
    const depth = resolvedParcelDepthM(column.temperatureC, column.sensibleHeatFluxWm2, column.latentHeatFluxWm2,
      column.pblHeightM, terrainM, levels);
    const top = record.layerTopM ?? (depth > 0 ? terrainM + depth
      : finite(column.pblHeightM) && column.pblHeightM >= 0 ? terrainM + column.pblHeightM : depth === 0 ? terrainM : null);
    const diagnostics = deriveDiagnosticsV2(terrainM, column, {});
    const result = compareWindAnchors(terrainM, column, top, diagnostics?.thermalVelocityV2Mps);
    const parity = top == null || overridden || !diagnostics ? null : keys.every(key => {
      const expected = diagnostics?.[key] ?? null, actual = result.baseline?.[key] ?? null;
      return expected === null && actual === null || finite(expected) && finite(actual) && Math.abs(expected - actual) <= .011;
    });
    return { id: record.id, model: record.model, evidence: record.evidence ?? null,
      synthetic: record.synthetic === true || overridden, terrainM, layerTopM: top, depthM: top == null ? null : top - terrainM,
      depthBand: top == null ? 'unavailable' : band(top - terrainM), productionParity: parity, ...result };
  });
  const groups = new Map();
  for (const result of results) {
    const key = `${result.model}|${result.depthBand}|${result.synthetic ? 'synthetic' : 'frozen-weather'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return { schemaVersion: 1, experiment: 'boundary-layer-wind-anchor/1.0.0', productionMethod: SOARING_CONTRACT_VERSION,
    productionPolicy: '10 m model wind anchored at model ground',
    candidatePolicy: '10 m model wind anchored at terrain + 10 m; mean from 10 m AGL to the same layer top',
    inputSha256: sha(records), columns: results.length, productionParityFailures: results.filter(row => row.productionParity === false).length,
    results, groups: [...groups].map(([key, rows]) => ({ key, columns: rows.length,
      candidateUnavailable: rows.filter(row => !row.candidate).length,
      differences: Object.fromEntries(keys.map(field => [field, distribution(rows.map(row => row.deltas?.[field]))])) })),
    limits: ['Measures sensitivity to the lower wind boundary.',
      'The candidate mean covers 10 m AGL through the layer top.'] };
}

export function defaultWindColumns() {
  // The RRFS fixture lacks the rotation needed for vector-wind comparison.
  const frozen = frozenThermalColumns().filter(record => record.model !== 'rrfs');
  const column = { ...frozen[0].column, windSpeedMps: 2, windDirectionDeg: 270,
    levels: [100, 200, 400].map((heightM, index) => ({ heightM, temperatureC: 19 - index * 2,
      dewPointC: 10, pressureHpa: 1000 - index * 20, windSpeedMps: 10, windDirectionDeg: 270 })) };
  return [...frozen, ...[5, 50, 500].map(depth => ({ id: `synthetic-${depth}m`, model: 'synthetic', terrainM: 0,
    column, layerTopM: depth, synthetic: true })), { id: 'synthetic-calm', model: 'synthetic', terrainM: 0,
    column: { ...column, windSpeedMps: 0, levels: column.levels.map(level => ({ ...level, windSpeedMps: 0 })) }, layerTopM: 50, synthetic: true }];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } } });
  if (!values.output) throw new Error('Usage: --output NEW_REPORT.json [--input FROZEN_COLUMN_RECORDS.json]');
  const report = evaluateWindAnchors(values.input ? JSON.parse(readFileSync(values.input, 'utf8')) : defaultWindColumns());
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output: values.output, columns: report.columns, productionParityFailures: report.productionParityFailures }));
  if (report.productionParityFailures) process.exitCode = 1;
}
