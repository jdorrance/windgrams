// Native ICON cells and point profiles share one acquisition and one derivation.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DRY_ADIABATIC_LAPSE_C_PER_M } from '@azohra/meteo.briefing/derive';
import { greatCircleDistanceKm } from '@azohra/meteo.grib';
import { deriveIconProfile, ICON_SEMANTICS } from '../scripts/lib/icon-eu.mjs';
import { SOARING_CONTRACT_VERSION, metrics, v2LayerMetrics, metric, assertAgreement } from './science.mjs';
import { encodeBundleFile, json, sha256, versionsFor } from './common.mjs';
import { ICON_REPLAY_INVENTORY, computeImplementationCodeHashes } from './inventory.mjs';

export function iconRegionalDocuments(acquired, region, sites, context, { includeNativeLevels = true, onCellProfile = () => {} } = {}) {
  const primary = sites.find(site => site.slug === region.primarySite);
  const siteCell = acquired.siteCells[primary?.slug];
  if (!primary || !Number.isInteger(siteCell)) throw new Error('Missing ICON primary launch cell');
  const launchElevation = context?.sites?.[primary.slug]?.elevation;
  if (!Number.isFinite(launchElevation?.elevationM)) throw new Error('Missing measured primary launch elevation');
  const c = {
    schemaVersion: 1, id: `${region.id}-icon-eu-live`, model: 'icon-eu',
    referenceTime: acquired.referenceTime, forecastHours: acquired.hours.map(hour => hour.forecastHour),
    bbox: region.bbox, site: primary, launchElevation, launchElevationCapturedAt: context.generatedAt,
    nativeModelLevels: acquired.levels, sinkMps: 1, minimumAboveGroundLevels: 3,
  };
  const columns = ['p', 'h', 't', 'td', 'ws', 'wd', 'vv'];
  const hourly = acquired.hours.map(hour => ({
    schemaVersion: 1, soaringContractVersion: SOARING_CONTRACT_VERSION, model: 'icon-eu',
    forecastHour: hour.forecastHour, validAt: hour.validAt,
    ...Object.fromEntries([...metrics, ...v2LayerMetrics, 'sfcT', 'sfcTd', 'mslp', 'status', 'levelCount', 'ceilingReached'].map(key => [key, []])),
    ...(includeNativeLevels ? { levelsByModel: Object.fromEntries(acquired.levels.map(level => [String(level), Object.fromEntries(columns.map(key => [key, []]))])) } : {}),
  }));
  let profile;
  const modelElevations = [];
  for (let index = 0; index < acquired.cells.length; index++) {
    const cell = acquired.cells[index];
    const doc = deriveIconProfile(acquired, index, index === siteCell ? primary : {
      slug: cell.id, name: cell.id, latitude: cell.latitude, longitude: cell.longitude, timeZone: region.timeZone,
    }, { launchElevationM: index === siteCell ? launchElevation.elevationM : null });
    modelElevations.push(doc.site.modelElevationM);
    if (index === siteCell) profile = doc;
    onCellProfile(doc, index);
    for (let hi = 0; hi < hourly.length; hi++) {
      const target = hourly[hi], hour = doc.hours[hi], source = acquired.hours[hi].sources[index];
      for (const key of metrics) target[key].push(metric(hour, key));
      for (const key of v2LayerMetrics) target[key].push(hour.soaring?.[key] ?? null);
      target.sfcT.push(hour.surface.temperatureC);
      target.sfcTd.push(hour.surface.dewPointC);
      target.mslp.push(hour.surface.seaLevelPressureHpa);
      target.status.push('valid');
      target.levelCount.push(hour.levels.length);
      const aboveGround = source.levels.filter(level => level.heightM > cell.terrainM + 20);
      target.ceilingReached.push(aboveGround.length > 0 && aboveGround.every(level =>
        source.temperatureC - (level.heightM - cell.terrainM) * DRY_ADIABATIC_LAPSE_C_PER_M > level.temperatureC));
      // Source model-level IDs survive filtering; values use exactly the same
      // rounded published column as the point chart and sounding.
      if (aboveGround.length !== hour.levels.length) throw new Error('ICON native/published level count mismatch');
      if (!includeNativeLevels) continue;
      const levels = new Map(aboveGround.map((level, li) => [level.modelLevel, hour.levels[li]]));
      for (const level of acquired.levels) {
        const lv = levels.get(level), bucket = target.levelsByModel[String(level)];
        const values = lv ? {
          p: lv.pressureHpa, h: lv.heightM, t: lv.temperatureC, td: lv.dewPointC,
          ws: lv.windSpeedMps, wd: lv.windDirectionDeg, vv: lv.verticalVelocityPaS ?? null,
        } : {};
        for (const key of columns) bucket[key].push(values[key] ?? null);
      }
    }
  }
  const agreement = assertAgreement(profile, hourly, siteCell);
  const grid = {
    type: 'FeatureCollection', features: acquired.cells.map((cell, cellIndex) => ({
      type: 'Feature', id: cell.id,
      properties: { id: cell.id, cellIndex, gridIndex: cell.index, latitude: cell.latitude, longitude: cell.longitude, modelElevationM: modelElevations[cellIndex] },
      geometry: { type: 'Polygon', coordinates: [[...cell.corners, cell.corners[0]]] },
    })),
  };
  const audit = {
    schemaVersion: 1, soaringContractVersion: SOARING_CONTRACT_VERSION, caseId: c.id, model: 'icon-eu',
    referenceTime: acquired.referenceTime, capturedAt: acquired.provenance.capturedAt, requiredRecordsComplete: true,
    grid: acquired.grid, sampledCell: { ...acquired.cells[siteCell], arrayIndex: siteCell,
      distanceKm: greatCircleDistanceKm(6371, primary.latitude, primary.longitude,
        acquired.cells[siteCell].latitude, acquired.cells[siteCell].longitude) },
    windRotation: 'Earth-relative U/V', mapProfileAgreement: agreement,
    terrain: { modelElevationM: profile.site.modelElevationM, launch: launchElevation, rawMslHeightsPreserved: true },
    limitations: ['6.5 km grid; local ridge and valley winds may differ.',
      '30 height samples; thermals may extend above the sounding.',
      'Gusts and surface heating cover the previous hour.',
      'Vertical air motion and convergence are unavailable.'],
  };
  const files = { 'grid.geojson': grid, 'profile.json': profile, 'audit.json': audit,
    'source.json': { grid: acquired.grid, provenance: acquired.provenance },
    ...Object.fromEntries(hourly.map(hour => [`f${hour.forecastHour}.json`, hour])) };
  const manifest = {
    schemaVersion: 1, soaringContractVersion: SOARING_CONTRACT_VERSION, case: c, model: 'icon-eu',
    semantics: ICON_SEMANTICS, capturedAt: acquired.provenance.capturedAt, versions: versionsFor(c), nodeMajor: 24,
    gridKey: acquired.grid.uuid, cellCount: acquired.cells.length, siteCell,
    units: { thermalVelocityMps: 'm/s', thermalVelocityV2Mps: 'm/s', usableLiftTopM: 'm MSL', usableLiftTopV2M: 'm MSL',
      sensibleHeatFluxWm2: 'W/m²', latentHeatFluxWm2: 'W/m²', precipitationMmHr: 'mm/hr', nativePressure: 'hPa', nativeHeight: 'm MSL' },
    hours: hourly.map(hour => ({ forecastHour: hour.forecastHour, validAt: hour.validAt, file: `f${hour.forecastHour}.json` })),
    codeHashes: computeImplementationCodeHashes(ICON_REPLAY_INVENTORY),
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha256(json(value))])),
  };
  return { manifest, files, profile, hourly };
}

export function writeIconRegionalBundle(acquired, region, sites, context, root) {
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, '.icon-bundle-'));
  try {
    const hashes = {}, fileBytes = {};
    const save = (name, value) => {
      const bytes = encodeBundleFile(name, value);
      hashes[name] = sha256(bytes);
      fileBytes[name] = bytes.byteLength;
      writeFileSync(join(staging, name), bytes);
    };
    const { manifest, files } = iconRegionalDocuments(acquired, region, sites, context, {
      includeNativeLevels: false,
      onCellProfile: (profile, index) => save(`cell-${index}.json.gz`, profile),
    });
    for (const [name, value] of Object.entries(files)) save(/^f\d+\.json$/.test(name) ? `${name}.gz` : name, value);
    manifest.hours = manifest.hours.map(hour => ({ ...hour, file: `${hour.file}.gz` }));
    manifest.cellProfiles = 'cell-{index}.json.gz';
    manifest.files = hashes;
    manifest.fileBytes = fileBytes;
    const hash = sha256(json(manifest)), dir = join(root, manifest.case.id, 'bundles', hash);
    writeFileSync(join(staging, 'manifest.json'), json(manifest));
    mkdirSync(join(root, manifest.case.id, 'bundles'), { recursive: true });
    renameSync(staging, dir);
    return { dir, manifest };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
