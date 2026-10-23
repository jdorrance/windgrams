// Build regional HRRR daylight forecasts. Historical case namespaces are immutable;
// rolling updates use a separate -live namespace. Regions with the same field/hour
// selection share a capture. Replay and enrichment stay private until validated.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { capture } from '../soaring/capture.mjs';
import { replay } from '../soaring/replay.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function writeAtomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(value)}\n`); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

function verifyBundle(dir, manifest) {
  for (const name of ['grid.geojson', 'profile.json', 'audit.json', ...(manifest.hours ?? []).map(h => h.file)]) {
    if (!manifest.files?.[name]) throw new Error(`Incomplete bundle: ${name}`);
  }
  for (const [name, hash] of Object.entries(manifest.files ?? {})) {
    if (!/^[a-zA-Z0-9.-]+$/.test(name) || sha256(readFileSync(join(dir, name))) !== hash) throw new Error(`Corrupt bundle: ${name}`);
  }
}

/**
 * Remaining 07:00–20:00 hours in the first available local day, respecting DST.
 * Start at f02 because the capture reserves f01 for terrain.
 */
export function daytimeForecastHoursForCycle(referenceTimeIso, timeZone = 'America/Los_Angeles') {
  const run = Date.parse(referenceTimeIso);
  if (!Number.isFinite(run)) throw new Error('Invalid reference time');
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' });
  let day;
  const hours = [];
  for (let h = 2; h <= 48; h++) {
    const p = Object.fromEntries(format.formatToParts(new Date(run + h * 3600000)).map(x => [x.type, x.value]));
    const date = `${p.year}-${p.month}-${p.day}`;
    if (+p.hour < 7 || +p.hour > 20) continue;
    day ??= date;
    if (date !== day) break;
    hours.push(h);
  }
  if (!hours.length) throw new Error('No daylight hours in forecast horizon');
  return hours;
}

/**
 * Builds a live case specification from a regional case template and a target HRRR `referenceTime`.
 */
export function buildLiveCaseSpec(templateCase, referenceTimeIso) {
  return {
    ...templateCase,
    id: `${templateCase.id}-live`,
    referenceTime: referenceTimeIso,
    forecastHours: daytimeForecastHoursForCycle(referenceTimeIso, templateCase.site.timeZone),
  };
}

/**
 * Checks whether `data/soaring/v1/<caseId>` already points to a valid bundle for `referenceTimeIso`.
 */
export function isRegionBundleCurrent(soaringV1Root, caseId, referenceTimeIso) {
  try {
    const indexPath = join(soaringV1Root, caseId, 'index.json');
    if (!existsSync(indexPath)) return false;
    const pointer = JSON.parse(readFileSync(indexPath, 'utf8'));
    if (!/^bundles\/[a-f0-9]{64}$/.test(pointer?.bundle)) return false;
    const manifestPath = join(soaringV1Root, caseId, pointer.bundle, 'manifest.json');
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.case?.referenceTime !== referenceTimeIso || manifest.case.id !== caseId) return false;
    if (sha256(readFileSync(manifestPath)) !== pointer.manifestSha256) return false;
    verifyBundle(join(soaringV1Root, caseId, pointer.bundle), manifest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refreshes `launches.json`, `cross-section.json`, and `verification.json` from the previous
 * bundle into the newly replayed bundle directory and re-hashes `manifest.json` + `index.json`.
 */
export function enrichBundleWithSidecars(dataRoot, soaringV1Root, caseId, newBundleDir, previousSidecars) {
  const manifestPath = join(newBundleDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const validSet = new Set((manifest.hours ?? []).map(h => h.validAt));

  const sameGeometry = previousSidecars.gridSha256 === manifest.files['grid.geojson'];
  if (sameGeometry && previousSidecars.crossSection) {
    const bytes = Buffer.from(`${JSON.stringify(previousSidecars.crossSection)}\n`);
    writeFileSync(join(newBundleDir, 'cross-section.json'), bytes);
    manifest.files['cross-section.json'] = sha256(bytes);
  }

  if (previousSidecars.referenceTime === manifest.case.referenceTime && previousSidecars.verification) {
    const bytes = Buffer.from(`${JSON.stringify(previousSidecars.verification)}\n`);
    writeFileSync(join(newBundleDir, 'verification.json'), bytes);
    manifest.files['verification.json'] = sha256(bytes);
  }

  if (sameGeometry && previousSidecars.launches) {
    const launchesDoc = structuredClone(previousSidecars.launches);
    delete launchesDoc.raob;
    const office = launchesDoc.nwsOffice?.office;
    const officePath = office && join(dataRoot, 'nws', 'offices', `${office}.json`);
    launchesDoc.nwsOffice = officePath && existsSync(officePath) ? JSON.parse(readFileSync(officePath, 'utf8')) : null;
    for (const launch of launchesDoc.launches ?? []) {
      launch.models = {};
      const slug = launch.slug;
      for (const mslug of ['hrrr-conus', 'hrdps-continental', 'rdps', 'gdps', 'gfs', 'geps', 'ecmwf', 'nws']) {
        const mp = join(dataRoot, mslug, 'sites', `${slug}.json`);
        if (!existsSync(mp)) continue;
        const mdoc = JSON.parse(readFileSync(mp, 'utf8'));
        const byValid = new Map((mdoc.hours ?? []).map(h => [h.validAt, h]));
        const matchedHours = [...validSet].map(v => byValid.get(v)).filter(Boolean);
        if (matchedHours.length === 0) continue;
        launch.models[mslug] = {
          referenceTime: mdoc.run?.referenceTime ?? mdoc.models?.surface?.run ?? mdoc.updateTime ?? null,
          modelElevationM: mdoc.site?.modelElevationM ?? mdoc.site?.gridElevationM ?? mdoc.grid?.elevationM ?? null,
          hours: matchedHours.map(mh => {
            if (mslug === 'geps') {
              return {
                validAt: mh.validAt,
                tempC: mh.surface?.temperatureC?.p50 ?? null,
                dewPointC: mh.surface?.dewPointC?.p50 ?? null,
                windSpeedMps: mh.surface?.windSpeedMps?.p50 ?? null,
                windDirectionDeg: mh.surface?.windDirectionDeg?.p50 ?? null,
                windGustMps: mh.surface?.windGustMps?.p50 ?? null,
                cloudCoverPct: mh.surface?.cloudCoverPercent?.p50 ?? null,
                pblHeightM: null,
                sensibleHeatWm2: mh.surface?.sensibleHeatFluxWm2?.p50 ?? null,
                wstarMps: mh.derived?.thermalVelocityMps?.p50 ?? null,
                usableLiftTopM: mh.derived?.usableLiftTopM?.p50 ?? null,
                blTopM: mh.derived?.boundaryLayerTopM?.p50 ?? null,
                cloudBaseM: mh.derived?.cloudBaseM?.p50 ?? null,
              };
            }
            if (mslug === 'ecmwf' || mslug === 'nws') {
              return {
                validAt: mh.validAt,
                tempC: mh.temperatureC ?? null,
                dewPointC: mh.dewPointC ?? mh.dewpointC ?? null,
                windSpeedMps: mh.windSpeedMps ?? null,
                windDirectionDeg: mh.windDirectionDeg ?? null,
                windGustMps: mh.windGustMps ?? null,
                cloudCoverPct: mh.cloudCoverPercent ?? mh.skyCoverPct ?? null,
                pblHeightM: mh.boundaryLayerHeightM ?? mh.mixingHeightM ?? null,
                sensibleHeatWm2: null,
                wstarMps: null,
                usableLiftTopM: null,
                blTopM: mh.soaring?.modelBlTopM ?? null,
                cloudBaseM: mh.soaring?.surfaceLclM ?? null,
              };
            }
            const s = mh.soaring ?? {};
            return {
              validAt: mh.validAt,
              tempC: mh.surface?.temperatureC ?? null,
              dewPointC: mh.surface?.dewPointC ?? null,
              windSpeedMps: mh.surface?.windSpeedMps ?? null,
              windDirectionDeg: mh.surface?.windDirectionDeg ?? null,
              windGustMps: mh.surface?.windGustMps ?? null,
              cloudCoverPct: mh.surface?.cloudCoverPercent ?? null,
              pblHeightM: mh.surface?.pblHeightM ?? null,
              sensibleHeatWm2: mh.surface?.sensibleHeatFluxWm2 ?? null,
              wstarMps: mh.derived?.thermalVelocityMps ?? null,
              usableLiftTopM: mh.derived?.usableLiftTopM ?? null,
              ...(Object.hasOwn(s, 'thermalVelocityV2Mps') ? { wstarV2Mps: s.thermalVelocityV2Mps ?? null, usableLiftTopV2M: s.usableLiftTopV2M ?? null, resolvedThermalTopM: s.resolvedThermalTopM ?? null } : {}),
              hcritWxtoflyM: s.hcritWxtoflyM ?? null,
              mixedLayerLclM: s.mixedLayerLclM ?? null,
              experimentalTerrain: s.experimental?.terrainAdjustment ?? null,
              blTopM: mh.derived?.boundaryLayerTopM ?? null,
              cloudBaseM: mh.derived?.cloudBaseM ?? null,
            };
          }),
        };
      }
    }
    const bytes = Buffer.from(`${JSON.stringify(launchesDoc)}\n`);
    writeFileSync(join(newBundleDir, 'launches.json'), bytes);
    manifest.files['launches.json'] = sha256(bytes);
  }

  verifyBundle(newBundleDir, manifest);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const finalBundleHash = sha256(manifestBytes);
  writeFileSync(manifestPath, manifestBytes);
  const caseDir = join(soaringV1Root, caseId);
  const finalDest = join(caseDir, 'bundles', finalBundleHash);
  mkdirSync(join(caseDir, 'bundles'), { recursive: true });
  if (newBundleDir !== finalDest) {
    if (existsSync(finalDest)) {
      verifyBundle(finalDest, manifest);
      if (sha256(readFileSync(join(finalDest, 'manifest.json'))) !== finalBundleHash) throw new Error('Corrupt existing manifest');
    } else renameSync(newBundleDir, finalDest);
  }
  const indexDoc = {
    schemaVersion: 1,
    caseId,
    bundle: `bundles/${finalBundleHash}`,
    manifestSha256: finalBundleHash,
  };
  writeAtomic(join(caseDir, 'index.json'), indexDoc);
  return finalDest;
}

/**
 * Removes older `bundles/<sha>` directories that are no longer referenced by `index.json`.
 */
export function pruneSupersededBundles(soaringV1Root, caseId) {
  const caseDir = join(soaringV1Root, caseId);
  const indexPath = join(caseDir, 'index.json');
  const bundlesDir = join(caseDir, 'bundles');
  if (!existsSync(indexPath) || !existsSync(bundlesDir)) return 0;
  const pointer = JSON.parse(readFileSync(indexPath, 'utf8'));
  const activeId = String(pointer.bundle ?? '').replace(/^bundles\//, '');
  let removed = 0;
  for (const entry of readdirSync(bundlesDir)) {
    // Keep recent bundles for clients still loading through an older pointer.
    if (/^[a-f0-9]{64}$/.test(entry) && entry !== activeId && Date.now() - statSync(join(bundlesDir, entry)).mtimeMs > 48 * 3600000) {
      rmSync(join(bundlesDir, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

function readPreviousSidecars(soaringV1Root, caseId) {
  try {
    const caseDir = join(soaringV1Root, caseId);
    const pointer = JSON.parse(readFileSync(join(caseDir, 'index.json'), 'utf8'));
    if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error('Invalid pointer');
    const bundleDir = join(caseDir, pointer.bundle);
    const readOpt = name => {
      const p = join(bundleDir, name);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    };
    const manifest = readOpt('manifest.json');
    return {
      referenceTime: manifest?.case?.referenceTime,
      gridSha256: manifest?.files?.['grid.geojson'],
      launches: readOpt('launches.json'),
      crossSection: readOpt('cross-section.json'),
      verification: readOpt('verification.json'),
    };
  } catch {
    return { launches: null, crossSection: null, verification: null };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', default: 'data' },
      'reference-time': { type: 'string' },
      'cache-root': { type: 'string' },
    },
  });

  const dataRoot = resolve(values.output);
  const soaringV1Root = join(dataRoot, 'soaring', 'v1');
  const regionsPath = join(soaringV1Root, 'regions.json');
  if (!existsSync(regionsPath)) {
    console.log('No data/soaring/v1/regions.json found; skipping live regional soaring build.');
    return;
  }

  const hrrrManifestPath = join(dataRoot, 'hrrr-conus', 'manifest.json');
  const referenceTime = values['reference-time'] ?? (
    existsSync(hrrrManifestPath)
      ? JSON.parse(readFileSync(hrrrManifestPath, 'utf8'))?.referenceTime
      : null
  );
  if (!referenceTime) {
    console.log('No HRRR referenceTime available; keeping seeded soaring bundles.');
    return;
  }

  const regionsDoc = JSON.parse(readFileSync(regionsPath, 'utf8'));
  const activeRegions = (regionsDoc.regions ?? []).filter(r => r.status === 'active-verified-trial' && typeof r.caseId === 'string');
  if (activeRegions.length === 0) {
    console.log('No active-verified-trial regions configured; skipping.');
    return;
  }

  const templateId = r => r.templateCaseId ?? r.caseId.replace(/-live$/, '');
  const pendingRegions = activeRegions.filter(r => !isRegionBundleCurrent(soaringV1Root, `${templateId(r)}-live`, referenceTime));
  if (pendingRegions.length === 0) {
    console.log(`All ${activeRegions.length} active soaring region(s) already at ${referenceTime}; skipping rebuild.`);
    return;
  }

  const runKey = referenceTime.replace(/[-:]/g, '').replace('.000Z', 'Z');
  const sharedCacheDir = resolve(values['cache-root'] ?? join(ROOT, '.soaring-cache', `live-${runKey}`));

  const liveCases = pendingRegions.map(region => {
    const templatePath = join(ROOT, 'soaring', 'cases', `${templateId(region)}.json`);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    const previousSidecars = readPreviousSidecars(soaringV1Root, region.caseId);
    return { region, caseSpec: buildLiveCaseSpec(template, referenceTime), previousSidecars };
  });

  try {
    console.log(`Capturing shared CONUS HRRR records for ${referenceTime} into ${sharedCacheDir}...`);
    const captures = new Set();

    for (const { region, caseSpec, previousSidecars } of liveCases) {
      console.log(`Replaying 3 km regional grid for ${region.id} (${caseSpec.id} @ ${referenceTime})...`);
      const key = sha256(JSON.stringify([caseSpec.forecastHours, caseSpec.pressureLevels, caseSpec.includeExtendedFields]));
      const cache = join(sharedCacheDir, key);
      if (!captures.has(key)) { await capture(caseSpec, cache); captures.add(key); }
      const staging = mkdtempSync(join(soaringV1Root, '.live-'));
      try {
        const res = await replay(caseSpec, cache, staging);
        const enrichedPath = enrichBundleWithSidecars(dataRoot, soaringV1Root, caseSpec.id, res.path, previousSidecars);
        region.templateCaseId = templateId(region);
        region.caseId = caseSpec.id;
        writeAtomic(regionsPath, regionsDoc);
        const pruned = pruneSupersededBundles(soaringV1Root, caseSpec.id);
        console.log(`Built ${region.id} -> ${enrichedPath} (pruned ${pruned} old bundle(s))`);
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }

    regionsDoc.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    writeAtomic(regionsPath, regionsDoc);
  } finally {
    if (!values['cache-root']) {
      rmSync(sharedCacheDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Live soaring build failed; previous bundles remain available: ${error.message}`);
    process.exitCode = 1;
  });
}
