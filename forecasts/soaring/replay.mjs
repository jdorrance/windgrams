import { readFile, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseIdx, sampleFieldValuesAsync, byteRange } from '@azohra/meteo.grib';
import { createNodeJ2kDecoderPool } from '@azohra/meteo.grib/j2k-node';
import { verifiedBytes, inspectField } from './capture.mjs';
import { fields, selectRecords } from './fields.mjs';
import { regionalGrid } from './grid.mjs';
import {
  SOARING_CONTRACT_VERSION,
  assertAgreement,
  cellSource,
  computeNativeGridConvergence,
  deriveCell,
  differences,
  metric,
  metrics,
  profileFor,
  v2LayerMetrics,
} from './science.mjs';
import { assertRuntime, atomicWrite, concurrent, fileUrl, json, readJson, sha256, validAt, versions } from './common.mjs';

function sameCaptureInputs(a, b) {
  return Boolean(
    a && b &&
    a.schemaVersion === b.schemaVersion &&
    a.referenceTime === b.referenceTime &&
    json(a.forecastHours) === json(b.forecastHours) &&
    json(a.pressureLevels) === json(b.pressureLevels) &&
    a.terrainForecastHour === b.terrainForecastHour &&
    Boolean(a.includeExtendedFields) === Boolean(b.includeExtendedFields)
  );
}

export async function verifyCapture(c, root) {
  const manifest = await readJson(join(root, 'capture.json'));
  const exactCaseMatch = manifest.caseHash === sha256(json(c)) && json(manifest.case) === json(c);
  if (manifest.schemaVersion !== 1 || (!exactCaseMatch && !sameCaptureInputs(manifest.case, c))) {
    throw new Error('Capture case/run does not match requested case');
  }
  if (json(manifest.versions) !== json(versions)) throw new Error('Capture dependency/algorithm versions differ');
  const hours = [c.terrainForecastHour, ...c.forecastHours];
  if (json(manifest.sources.map(s => s.hour)) !== json(hours)) throw new Error('Incomplete or duplicate captured hours');
  for (const source of manifest.sources) {
    const url = fileUrl(c, source.hour);
    if (source.index.url !== `${url}.idx`) throw new Error('Wrong index source URL');
    const selected = selectRecords(parseIdx((await verifiedBytes(root, source.index)).toString()), c, source.hour);
    if (json(source.records.map(r => r.key)) !== json(selected.map(s => s.key))) throw new Error('Incomplete captured field inventory');
    for (let i = 0; i < selected.length; i++) {
      const r = source.records[i], expected = selected[i];
      if (!expected.record) { if (!r.absent) throw new Error('Optional record inventory mismatch'); continue; }
      if (r.absent || r.url !== url || r.range !== byteRange(expected.record)) throw new Error(`Missing/wrong record: ${r.key}`);
      const metadata = inspectField(await verifiedBytes(root, r), c, source.hour, manifest.gridKey, expected);
      if (metadata.validAt !== r.validAt || metadata.referenceTime !== r.referenceTime || metadata.grid.gridKey !== r.gridKey || json(metadata.product) !== json(r.product)) throw new Error(`Record metadata mismatch: ${r.key}`);
    }
  }
  return manifest;
}

export async function replay(c, cache, output, { log = console.error } = {}) {
  await assertRuntime(c);
  const capture = await verifyCapture(c, cache);
  const terrainRecord = capture.sources[0].records[0];
  const { grid } = inspectField(await verifiedBytes(cache, terrainRecord), c, c.terrainForecastHour, capture.gridKey);
  const region = regionalGrid(grid, c), indices = region.cells.map(cell => cell.index);
  const round1 = n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
  const round2 = n => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  // Only JPEG2000 records need workers. Simple-packed test/constant records
  // decode directly; keep the two-worker pool lazy and shared by both lanes.
  let poolPromise;
  const decode = async (record, hour) => {
    const { field } = inspectField(await verifiedBytes(cache, record), c, hour, grid.gridKey);
    const packing = new DataView(field.section5.buffer, field.section5.byteOffset, field.section5.byteLength).getUint16(9);
    const pool = packing === 40 ? await (poolPromise ??= createNodeJ2kDecoderPool({ size: 2 })) : null;
    const decoded = await sampleFieldValuesAsync(field, indices, pool ? { decodeJ2k: pool.decode, decodeJ2kSampled: pool.decodeSampled } : {});
    return Array.from(decoded.values, (n, i) => decoded.missingMask?.[i] || !Number.isFinite(n) ? null : n);
  };
  let terrain, site;
  const hourly = [], profileHours = [], siteRaw = [], audits = [];
  const pLevels = c.pressureLevels ?? [925, 900, 875, 850, 800, 750, 700, 650, 600];
  try {
    terrain = await decode(terrainRecord, c.terrainForecastHour);
    for (const source of capture.sources.slice(1)) {
      const decoded = Object.fromEntries(await concurrent(source.records.filter(r => !r.absent), 2, async record => [record.key, await decode(record, source.hour)]));
      const conv10m = computeNativeGridConvergence(grid, region.cells, decoded.u ?? [], decoded.v ?? []);
      const conv925 = computeNativeGridConvergence(grid, region.cells, decoded['925.UGRD'] ?? [], decoded['925.VGRD'] ?? []);
      const levelsByPressure = Object.fromEntries(pLevels.map(p => [String(p), { h: [], t: [], td: [], ws: [], wd: [], vv: [] }]));
      const result = {
        forecastHour: source.hour,
        validAt: validAt(c, source.hour),
        soaringContractVersion: SOARING_CONTRACT_VERSION,
        ...Object.fromEntries(metrics.map(k => [k, []])),
        ...Object.fromEntries(v2LayerMetrics.map(k => [k, []])),
        sfcT: [],
        sfcTd: [],
        mslp: [],
        levelsByPressure,
        status: [],
        levelCount: [],
        ceilingReached: [],
      };
      for (let i = 0; i < region.cells.length; i++) {
        const raw = Object.fromEntries(Object.entries(decoded).map(([k, values]) => [k, values[i]]));
        const converted = cellSource(c, grid, region.cells[i], source.hour, raw);
        const derived = deriveCell(c, terrain[i], converted, capture.capturedAt);
        for (const key of metrics) result[key].push(metric(derived.hour, key));
        const v2 = derived.v2 ? { ...derived.v2, convergence10mX1e5: conv10m[i], convergence925X1e5: conv925[i] } : null;
        for (const key of v2LayerMetrics) result[key].push(v2 ? (v2[key] ?? null) : null);
        result.sfcT.push(converted ? round1(converted.temperatureC) : null);
        result.sfcTd.push(converted ? round1(converted.temperatureC - converted.dewPointDepressionC) : null);
        result.mslp.push(converted ? round1(converted.seaLevelPressureHpa) : null);
        const byP = new Map((converted?.levels ?? []).map(l => [l.pressureHpa, l]));
        for (const p of pLevels) {
          const lv = byP.get(p);
          const bucket = levelsByPressure[String(p)];
          bucket.h.push(lv ? round1(lv.heightM) : null);
          bucket.t.push(lv ? round1(lv.temperatureC) : null);
          bucket.td.push(lv ? round1(lv.temperatureC - lv.dewPointDepressionC) : null);
          bucket.ws.push(lv ? round2(lv.windSpeedMps) : null);
          bucket.wd.push(lv ? round1(lv.windDirectionDeg) : null);
          bucket.vv.push(lv && lv.verticalVelocityPaS != null ? round2(lv.verticalVelocityPaS) : null);
        }
        result.status.push(derived.status); result.levelCount.push(derived.levelCount); result.ceilingReached.push(derived.ceilingReached);
        if (i === region.siteCell) {
          if (!derived.hour) throw new Error(`${c.site.name} f${source.hour} has ${derived.status}; refusing incomplete profile`);
          profileHours.push(derived.hour); site = derived.site;
          siteRaw.push({ forecastHour: source.hour, raw, source: converted });
        }
      }
      hourly.push(result);
      const siteHour = profileHours.at(-1), depth = siteHour.derived.boundaryLayerTopM - site.modelElevationM;
      audits.push({
        forecastHour: source.hour,
        validAt: result.validAt,
        counts: Object.fromEntries(['valid', 'missing', 'insufficient-levels'].map(s => [s, result.status.filter(v => v === s).length])),
        ceilingReached: result.ceilingReached.filter(Boolean).length,
        minAboveGroundLevels: Math.min(...result.levelCount),
        maxAboveGroundLevels: Math.max(...result.levelCount),
        optionalAbsent: source.records.filter(r => r.absent).map(r => r.key),
        blanchard: {
          levelCount: result.levelCount[region.siteCell],
          ceilingReached: result.ceilingReached[region.siteCell],
          parcelDepthM: Number(depth.toFixed(1)),
          modelPblHeightM: siteHour.surface.pblHeightM ?? null,
          resolvedThermalTopM: result.resolvedThermalTopM[region.siteCell],
          thermalVelocityV2Mps: result.thermalVelocityV2Mps[region.siteCell],
          usableLiftTopV2M: result.usableLiftTopV2M[region.siteCell],
          hcritWxtoflyM: result.hcritWxtoflyM[region.siteCell],
          dryHcritM: result.dryHcritM[region.siteCell],
          surfaceLclM: result.surfaceLclM[region.siteCell],
          mixedLayerLclM: result.mixedLayerLclM[region.siteCell],
          cuPotentialM: result.cuPotentialM[region.siteCell],
          odPotentialM: result.odPotentialM[region.siteCell],
          blMeanWindSpeedMps: result.blMeanWindSpeedMps[region.siteCell],
          blWindShearMps: result.blWindShearMps[region.siteCell],
          convergence10mX1e5: result.convergence10mX1e5[region.siteCell],
          depthDifferenceM: siteHour.surface.pblHeightM == null ? null : Number((depth - siteHour.surface.pblHeightM).toFixed(1)),
        },
      });
      log(`Replayed f${source.hour}: ${region.cells.length} cells`);
    }
  } finally { if (poolPromise) await (await poolPromise).close(); }
  const profile = profileFor(c, site, profileHours, capture.capturedAt);
  const agreement = assertAgreement(profile, hourly, region.siteCell);
  const baselinePath = new URL('./fixtures/blanchard-published.json', import.meta.url);
  const baseline = await readJson(baselinePath);
  const isPinnedBaseline = c.site?.slug === 'wa-blanchard' && c.referenceTime === baseline.run?.referenceTime;
  const comparison = isPinnedBaseline ? differences(profile, baseline) : [];
  const geojson = {
    type: 'FeatureCollection',
    features: region.cells.map((cell, i) => ({
      type: 'Feature',
      id: cell.id,
      properties: {
        id: cell.id,
        cellIndex: i,
        gridIndex: cell.index,
        latitude: cell.latitude,
        longitude: cell.longitude,
        modelElevationM: terrain[i] == null ? null : Number(terrain[i].toFixed(1)),
      },
      geometry: { type: 'Polygon', coordinates: [cell.corners] },
    })),
  };
  const audit = {
    schemaVersion: 1,
    soaringContractVersion: SOARING_CONTRACT_VERSION,
    caseId: c.id,
    referenceTime: c.referenceTime,
    capturedAt: capture.capturedAt,
    requiredRecordsComplete: true,
    grid,
    sampledCell: { ...region.nearest, id: region.cells[region.siteCell].id, arrayIndex: region.siteCell },
    windRotation: grid.uvRelativeToGrid ? 'Grid-relative U/V rotated at the sampled cell longitude using GRIB loV and standard parallels' : 'Earth-relative U/V; no rotation',
    terrain: {
      modelElevationM: site.modelElevationM,
      launch: c.launchElevation,
      launchCapturedAt: c.launchElevationCapturedAt,
      differenceM: Number((site.modelElevationM - c.launchElevation.elevationM).toFixed(1)),
      rawMslHeightsPreserved: true,
    },
    conversions: fields(c, c.forecastHours[0]).map(({ key, variable, level, required, conversion }) => ({ key, variable, level, required, conversion })),
    mapProfileAgreement: agreement,
    publishedProfileComparison: { baselineSha256: sha256(await readFile(baselinePath)), excluded: ['run.generatedAt'], exact: comparison.length === 0, differences: comparison },
    hours: audits,
    limitations: [
      'Historical replay. Numerical consistency is not verification against observations.',
      'Nine pressure levels cannot resolve all inversions or terrain-driven flows. Legacy 9-level profiles are preserved as sparse; no synthetic pressure levels are interpolated or extrapolated.',
      'Parcel-derived thermal top is not HRRR model PBL height. v1 retains baseline first-level crossings; v2 resolvedThermalTopM eliminates the index===0 jump to 925 hPa and derives thermalVelocityV2Mps, usableLiftTopV2M, hcritWxtoflyM, and dryHcritM consistently from resolvedDepthM.',
      'Ceiling-reached profiles retain the baseline top at the last sampled level and are flagged; this is a lower bound, not a resolved thermal top.',
      'v1 cloudBaseM combines surface LCL with first near-saturated layer; v2 separates surfaceLclM (zsfclcl), physical mixedLayerLclM (zblcl from BL mean potential temperature and mixing ratio without arbitrary scaling), cuPotentialM, and odPotentialM.',
      'v1 usableLiftTopM uses 1.0 m/s sink; v2 computes usableLiftTopV2M (1.0 m/s), hcritWxtoflyM at 1.143 m/s (225 ft/min), and dryHcritM strictly bounded by resolvedThermalTopM.',
      'Model terrain differs from launch terrain. Raw MSL heights are preserved; launch-altitude wind interpolation is isolated in experimental.terrainAdjustment.',
    ],
  };
  const files = {
    'grid.geojson': geojson,
    'profile.json': profile,
    'audit.json': audit,
    'blanchard-raw.json': { provenance: 'Decoded NOAA HRRR values before conversion/rounding', grid, cell: region.cells[region.siteCell], terrain: terrain[region.siteCell], hours: siteRaw },
    ...Object.fromEntries(hourly.map(h => [`f${h.forecastHour}.json`, h])),
  };
  const hashes = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(json(value))]));
  const sourceFiles = ['common.mjs', 'fields.mjs', 'grid.mjs', 'capture.mjs', 'science.mjs', 'replay.mjs', 'vendor/derive-0.6.0.mjs'];
  const codeHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))])));
  const manifest = {
    schemaVersion: 1,
    soaringContractVersion: SOARING_CONTRACT_VERSION,
    case: c,
    capturedAt: capture.capturedAt,
    versions,
    nodeMajor: 24,
    codeHashes,
    dependencyLockSha256: sha256(await readFile(new URL('../pnpm-lock.yaml', import.meta.url))),
    captureSha256: sha256(json(capture)),
    inputs: capture.sources.flatMap(s => [s.index, ...s.records.filter(r => !r.absent)]),
    gridKey: grid.gridKey,
    cellCount: region.cells.length,
    siteCell: region.siteCell,
    units: {
      thermalVelocityMps: 'm/s', usableLiftTopM: 'm MSL', boundaryLayerTopM: 'm MSL', cloudBaseM: 'm MSL', pblHeightM: 'm AGL',
      resolvedThermalTopM: 'm MSL', thermalTopPlus1CM: 'm MSL', thermalVelocityV2Mps: 'm/s', usableLiftTopV2M: 'm MSL',
      hcritWxtoflyM: 'm MSL', dryHcritM: 'm MSL',
      surfaceLclM: 'm MSL', mixedLayerLclM: 'm MSL', cuPotentialM: 'm', odPotentialM: 'm',
      blMeanWindSpeedMps: 'm/s', blMeanWindDirDeg: 'deg', blTopWindSpeedMps: 'm/s', blTopWindDirDeg: 'deg',
      blWindShearMps: 'm/s', buoyancyShearRatio: 'ratio', wind10mSpeedMps: 'm/s', wind10mDirDeg: 'deg',
      wind80mSpeedMps: 'm/s', wind80mDirDeg: 'deg',
      windGustMps: 'm/s', wind925SpeedMps: 'm/s', wind925DirDeg: 'deg', wind850SpeedMps: 'm/s', wind850DirDeg: 'deg',
      maxUpwardVelocityMps: 'm/s', minDownwardVelocityMps: 'm/s', w925Mps: 'm/s', w850Mps: 'm/s',
      convergence10mX1e5: '10⁻⁵ s⁻¹', convergence925X1e5: '10⁻⁵ s⁻¹',
      sensibleHeatFluxWm2: 'W/m²', latentHeatFluxWm2: 'W/m²',
      cloudCoverPercent: '%', lowCloudPercent: '%', midCloudPercent: '%', highCloudPercent: '%',
      precipitationMmHr: 'mm/hr', capeJkg: 'J/kg', cinJkg: 'J/kg',
    },
    hours: hourly.map(h => ({ forecastHour: h.forecastHour, validAt: h.validAt, file: `f${h.forecastHour}.json` })),
    files: hashes,
  };
  files['manifest.json'] = manifest;
  const bundle = sha256(json(manifest));
  await mkdir(output, { recursive: true });
  const staging = join(output, `.staging-${randomUUID()}`);
  const destination = join(output, c.id, 'bundles', bundle);
  await mkdir(staging);
  try {
    for (const [name, value] of Object.entries(files)) await atomicWrite(join(staging, name), json(value));
    if (!profileFor(c, profile.site, (await readJson(join(staging, 'profile.json'))).hours, capture.capturedAt)) throw new Error('Invalid serialized profile');
    for (const [name, hash] of Object.entries(hashes)) if (sha256(await readFile(join(staging, name))) !== hash) throw new Error(`Staged checksum mismatch: ${name}`);
    await mkdir(join(output, c.id, 'bundles'), { recursive: true });
    try { await rename(staging, destination); } catch (e) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e;
      for (const name of await readdir(staging)) if (sha256(await readFile(join(staging, name))) !== sha256(await readFile(join(destination, name)))) throw new Error('Existing immutable bundle is corrupt');
    }
    await atomicWrite(join(output, c.id, 'index.json'), json({ schemaVersion: 1, caseId: c.id, bundle: `bundles/${bundle}`, manifestSha256: bundle }));
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { path: destination, hashes: { ...hashes, 'manifest.json': bundle }, audit };
}
