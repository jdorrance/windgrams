// Capture immutable regional bundles and the native cells nearest shared launches.
import { jsonOf, pool, readJsonResource } from '../evidence-store.mjs';

const ok = (entry) => entry?.status === 200;
const inside = (site, [west, south, east, north]) =>
  site.longitude >= west && site.longitude <= east && site.latitude >= south && site.latitude <= north;

async function captureFiles(store, bundleUrl, manifest, shared) {
  const hourFiles = new Set(manifest.hours.map((hour) => hour.file));
  const paths = Object.keys(manifest.files ?? {}).filter(
    (path) =>
      ['grid.geojson', 'audit.json', 'profile.json'].includes(path) ||
      hourFiles.has(path) ||
      path.startsWith('sites/') ||
      path.startsWith('launches'),
  );
  if (!paths.includes('grid.geojson')) paths.push('grid.geojson');
  const capture = async (path, kind = 'regional-data') => ({
    path,
    expectedHash: manifest.files?.[path],
    entry: await store.take(`${bundleUrl}/${path}`, { kind }),
  });
  const files = await pool(paths, 4, (path) => capture(path)),
    gridEntry = files.find((file) => file.path === 'grid.geojson')?.entry;
  if (!ok(gridEntry)) return files;
  const grid = await jsonOf(store.root, gridEntry),
    cells = new Set([manifest.siteCell]);
  for (const { site } of shared) {
    let nearest;
    for (const { properties = {} } of grid.features ?? []) {
      const distance = (properties.latitude - site.latitude) ** 2 + (properties.longitude - site.longitude) ** 2;
      if (Number.isFinite(distance) && (!nearest || distance < nearest.distance))
        nearest = { distance, index: properties.cellIndex };
    }
    if (Number.isInteger(nearest?.index)) cells.add(nearest.index);
  }
  for (const cell of cells) {
    const path = `cell-${cell}.json.gz`;
    if (manifest.files?.[path]) files.push(await capture(path, 'regional-cell-profile'));
  }
  return files;
}

/** Manifest and index hashes bind a bundle; retries cannot silently mix publications. */
export async function captureRegionalBundles(store, base, catalogue, matches) {
  const records = [];
  for (const region of catalogue?.regions ?? [])
    for (const native of region.nativeModels ?? []) {
      if (typeof native.caseId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(native.caseId))
        throw new Error('Invalid regional case identity');
      const caseRoot = `${base}/soaring/v1/${native.caseId}`;
      const read = (url, kind) => readJsonResource(store, url, { kind, fresh: true });
      const shared = matches.filter(({ site }) => inside(site, region.bbox));
      let record;
      for (let attempt = 0; attempt < 3; attempt++) {
        const pointer = await read(`${caseRoot}/index.json`, 'regional-pointer');
        record = {
          region: region.id,
          model: native.model,
          pointer: pointer.entry,
          status: 'unavailable',
          reason: 'invalid-or-unavailable-bundle-pointer',
          attempts: attempt + 1,
        };
        if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.value?.bundle)) continue;
        const bundleUrl = `${caseRoot}/${pointer.value.bundle}`;
        const manifest = await read(`${bundleUrl}/manifest.json`, 'regional-manifest');
        Object.assign(record, {
          manifest: manifest.entry,
          bundleUrl,
          sharedSites: shared.map((match) => match.site.slug),
          files: [],
        });
        try {
          if (Array.isArray(manifest.value?.hours) && shared.length)
            record.files = await captureFiles(store, bundleUrl, manifest.value, shared);
          record.check = (await read(`${caseRoot}/index.json`, 'regional-pointer-check')).entry;
          record.stable = Boolean(
            Array.isArray(manifest.value?.hours) &&
            ok(manifest.entry) &&
            pointer.value.manifestSha256 === manifest.entry.sha256 &&
            pointer.entry.sha256 === record.check.sha256,
          );
          if (record.stable) {
            record.status = shared.length ? 'captured' : 'outside-shared-coverage';
            delete record.reason;
            break;
          }
          record.reason = 'regional-bundle-unavailable-or-changing';
        } catch (error) {
          record.stable = false;
          record.reason = error.message;
        }
      }
      records.push(record);
    }
  return records;
}
