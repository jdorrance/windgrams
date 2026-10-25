// A single-cell archived bundle for offline UI checks; all weather remains synthetic.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { validateRegionCatalogue, validateReplayManifest, validateReplayHour, validateReplayGrid, validateReplayAudit } from '@windgrams/contracts/regional';

export function writeRegionalFixture(outputRoot, source) {
  const caseId = 'synthetic-archive', model = source.model;
  const profile = { ...source, hours: source.hours.slice(9, 15), source: { gridIndex: 0 } };
  const { latitude, longitude, timeZone, name, id: slug, modelElevationM } = profile.site;
  const bbox = [longitude - .03, latitude - .03, longitude + .03, latitude + .03];
  const [west, south, east, north] = bbox;
  const files = new Map();
  const json = (file, value, validate) => {
    if (validate && !validate(value)) throw new Error(`Invalid synthetic regional file: ${file}`);
    files.set(file, JSON.stringify(value));
  };
  json('profile.json', profile);
  files.set('cell-0.json.gz', gzipSync(JSON.stringify(profile)));
  json('grid.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'synthetic-cell',
    properties: { cellIndex: 0, id: 'synthetic-cell', gridIndex: 0, latitude, longitude, modelElevationM },
    geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
  }] }, raw => validateReplayGrid(raw, 1));
  json('audit.json', {
    sampledCell: { distanceKm: 0 }, terrain: { modelElevationM, launch: { elevationM: modelElevationM } },
    mapProfileAgreement: { exact: true, hours: profile.hours.length, valuesChecked: profile.hours.length * 4 },
    limitations: ['Synthetic weather for UI tests.'],
  }, validateReplayAudit);
  const hours = profile.hours.map(hour => {
    const forecastHour = (Date.parse(hour.validAt) - Date.parse(profile.run.referenceTime)) / 3_600_000;
    const file = `hour-${forecastHour}.json`;
    json(file, {
      forecastHour, validAt: hour.validAt,
      thermalVelocityMps: [hour.derived.thermalVelocityMps], usableLiftTopM: [hour.derived.usableLiftTopM],
      boundaryLayerTopM: [hour.derived.boundaryLayerTopM], cloudBaseM: [hour.derived.cloudBaseM], pblHeightM: [hour.surface.pblHeightM ?? null],
      wind10mSpeedMps: [hour.surface.windSpeedMps], wind10mDirDeg: [hour.surface.windDirectionDeg],
      status: ['valid'], levelCount: [hour.levels.length], ceilingReached: [false],
    }, raw => validateReplayHour(raw, 1));
    return { forecastHour, validAt: hour.validAt, file };
  });
  const hash = value => createHash('sha256').update(value).digest('hex');
  json('manifest.json', {
    schemaVersion: 1, model, semantics: profile.semantics, capturedAt: profile.run.generatedAt, cellCount: 1, siteCell: 0,
    cellProfiles: 'cell-{index}.json.gz', fileBytes: Object.fromEntries([...files].map(([file, bytes]) => [file, Buffer.byteLength(bytes)])), files: Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)])),
    case: { id: caseId, model, referenceTime: profile.run.referenceTime, bbox, sinkMps: 1,
      site: { slug, name: `${name} · synthetic fixture`, latitude, longitude, timeZone }, launchElevation: { elevationM: modelElevationM } },
    versions: { algorithm: 'synthetic-ui-fixture' }, hours,
  }, validateReplayManifest);
  const manifestSha256 = hash(files.get('manifest.json'));
  const bundle = `bundles/${manifestSha256}`;
  const root = join(outputRoot, 'soaring/v1', caseId);
  mkdirSync(join(root, bundle), { recursive: true });
  for (const [file, bytes] of files) writeFileSync(join(root, bundle, file), bytes);
  writeFileSync(join(root, 'index.json'), JSON.stringify({ schemaVersion: 1, caseId, bundle, manifestSha256 }));
  const catalogue = { schemaVersion: 1, soaringContractVersion: 'synthetic-ui-fixture', generatedAt: profile.run.generatedAt,
    trialRegionId: 'synthetic-region', regions: [{ id: 'synthetic-region', name: 'Synthetic regional fixture', status: 'active-verified-trial',
      caseId, nativeModels: [{ model, caseId }], timeZone, morningBriefingLocalHour: 8, bbox, primarySite: slug,
      launches: [slug], deterministicModels: [model], ensembleModels: [], sparseAdapters: [] }] };
  if (!validateRegionCatalogue(catalogue)) throw new Error('Synthetic regional catalogue failed validation');
  writeFileSync(join(outputRoot, 'soaring/v1/regions.json'), JSON.stringify(catalogue));
}
