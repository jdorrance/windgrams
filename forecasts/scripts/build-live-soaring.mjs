// Captures and replays live 3 km HRRR regional soaring bundles for all active regions
// in `data/soaring/v1/regions.json` whenever a newer HRRR cycle is published.
//
// - Reads the latest `referenceTime` from `data/hrrr-conus/manifest.json` (or `--reference-time`).
// - Maps any 00Z / 06Z / 12Z / 18Z cycle to the 14-hour daytime soaring window (14:00..03:00 UTC).
// - Skips capture/replay immediately if all active regions already match `referenceTime`.
// - Downloads CONUS HRRR byte-ranged records ONCE into a shared cache directory, then replays
//   every active region (`north-sound`, `shenandoah-blue-ridge`, etc.) from that shared cache.
// - Refreshes regional `launches.json`, `cross-section.json`, and `verification.json` inside each
//   newly built bundle and prunes superseded `bundles/<oldSha>` directories.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { capture } from '../soaring/capture.mjs';
import { replay } from '../soaring/replay.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Computes the 14 forecast steps covering the primary daytime soaring window (14:00..03:00 UTC)
 * for any 00Z, 06Z, 12Z, or 18Z HRRR cycle.
 */
export function daytimeForecastHoursForCycle(referenceTimeIso) {
  const cycleHour = new Date(referenceTimeIso).getUTCHours();
  // Offset from cycleHour to 14:00 UTC on the same or next day (always >= 2 so f01 terrain is separate)
  const startStep = ((14 - cycleHour + 24) % 24) || 24;
  return Array.from({ length: 14 }, (_, i) => startStep + i);
}

/**
 * Builds a live case specification from a regional case template and a target HRRR `referenceTime`.
 */
export function buildLiveCaseSpec(templateCase, referenceTimeIso) {
  return {
    ...templateCase,
    referenceTime: referenceTimeIso,
    forecastHours: daytimeForecastHoursForCycle(referenceTimeIso),
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
    if (typeof pointer?.bundle !== 'string') return false;
    const manifestPath = join(soaringV1Root, caseId, pointer.bundle, 'manifest.json');
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return manifest?.case?.referenceTime === referenceTimeIso;
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

  if (previousSidecars.crossSection) {
    const bytes = Buffer.from(`${JSON.stringify(previousSidecars.crossSection)}\n`);
    writeFileSync(join(newBundleDir, 'cross-section.json'), bytes);
    manifest.files['cross-section.json'] = sha256(bytes);
  }

  if (previousSidecars.verification) {
    const bytes = Buffer.from(`${JSON.stringify(previousSidecars.verification)}\n`);
    writeFileSync(join(newBundleDir, 'verification.json'), bytes);
    manifest.files['verification.json'] = sha256(bytes);
  }

  if (previousSidecars.launches) {
    const launchesDoc = structuredClone(previousSidecars.launches);
    for (const launch of launchesDoc.launches ?? []) {
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
              wstarV2Mps: s.thermalVelocityV2Mps ?? null,
              usableLiftTopV2M: s.usableLiftTopV2M ?? null,
              hcritWxtoflyM: s.hcritWxtoflyM ?? null,
              resolvedThermalTopM: s.resolvedThermalTopM ?? null,
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

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const finalBundleHash = sha256(manifestBytes);
  writeFileSync(manifestPath, manifestBytes);
  const caseDir = join(soaringV1Root, caseId);
  const finalDest = join(caseDir, 'bundles', finalBundleHash);
  if (newBundleDir !== finalDest) {
    rmSync(finalDest, { recursive: true, force: true });
    renameSync(newBundleDir, finalDest);
  }
  const indexDoc = {
    schemaVersion: 1,
    caseId,
    bundle: `bundles/${finalBundleHash}`,
    manifestSha256: finalBundleHash,
  };
  writeFileSync(join(caseDir, 'index.json'), `${JSON.stringify(indexDoc)}\n`);
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
    if (entry !== activeId) {
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
    const bundleDir = join(caseDir, pointer.bundle);
    const readOpt = name => {
      const p = join(bundleDir, name);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    };
    return {
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

  const pendingRegions = activeRegions.filter(r => !isRegionBundleCurrent(soaringV1Root, r.caseId, referenceTime));
  if (pendingRegions.length === 0) {
    console.log(`All ${activeRegions.length} active soaring region(s) already at ${referenceTime}; skipping rebuild.`);
    return;
  }

  const runKey = referenceTime.replace(/[-:]/g, '').replace('.000Z', 'Z');
  const sharedCacheDir = resolve(values['cache-root'] ?? join(ROOT, '.soaring-cache', `live-${runKey}`));

  const liveCases = activeRegions.map(region => {
    const templatePath = join(ROOT, 'soaring', 'cases', `${region.caseId}.json`);
    const template = JSON.parse(readFileSync(templatePath, 'utf8'));
    const previousSidecars = readPreviousSidecars(soaringV1Root, region.caseId);
    return { region, caseSpec: buildLiveCaseSpec(template, referenceTime), previousSidecars };
  });

  try {
    console.log(`Capturing shared CONUS HRRR records for ${referenceTime} into ${sharedCacheDir}...`);
    await capture(liveCases[0].caseSpec, sharedCacheDir);

    for (const { region, caseSpec, previousSidecars } of liveCases) {
      console.log(`Replaying 3 km regional grid for ${region.id} (${caseSpec.id} @ ${referenceTime})...`);
      const res = await replay(caseSpec, sharedCacheDir, soaringV1Root);
      const enrichedPath = enrichBundleWithSidecars(dataRoot, soaringV1Root, caseSpec.id, res.path, previousSidecars);
      const pruned = pruneSupersededBundles(soaringV1Root, caseSpec.id);
      console.log(`Built ${region.id} -> ${enrichedPath} (pruned ${pruned} old bundle(s))`);
    }

    regionsDoc.generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    writeFileSync(regionsPath, `${JSON.stringify(regionsDoc, null, 2)}\n`);
  } finally {
    if (!values['cache-root']) {
      rmSync(sharedCacheDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`WARN live soaring bundle build failed (keeping seeded bundle): ${error.message}`);
    process.exit(0);
  });
}
