// Internal agreement of published profiles, regional cells and the current renderer.
import { jsonOf, sha256 } from '../evidence-store.mjs';
import { scalar } from './fields.mjs';
import { openRegionalDatasetFromDocuments } from '@windgrams/data-client/dataset';
import { validateReplayGrid, validateReplayManifest } from '@windgrams/contracts/regional';
import { publishedLift } from '@windgrams/contracts/published-lift';
import { buildWindgramView, heightToY, yToHeight } from '@windgrams/windgram/scene';
import { renderWindgramSvg } from '@windgrams/windgram/svg';

const ok = (entry) => entry?.status === 200;
const hourKey = Date.parse;

export async function auditPublishedViews(root, snapshot, profiles, focus) {
  const rendererAudit = [],
    regionalAudit = [],
    coverage = [];
  for (const item of profiles.filter((p) => p.cohort === 'latest-live' && p.eligible && focus.has(p.profile.site.id))) {
    const p = item.profile;
    const dateKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: p.site.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(snapshot.startedAt));
    for (const units of ['metric', 'imperial'])
      for (const width of [375, 1000]) {
        const view = buildWindgramView(p, {
          unitSystem: units,
          timeZone: p.site.timeZone,
          hours: { dateKey, timeZone: p.site.timeZone },
          widthPx: width,
          launch: { elevationM: p.soaringMeta?.launchElevationM ?? p.site.modelElevationM },
        });
        const svg = renderWindgramSvg(view, { idPrefix: 'scientific-review' });
        const failures = view.hours.filter((h) => {
          const native = p.hours.find((x) => hourKey(x.validAt) === hourKey(h.validAt));
          return (
            !native ||
            scalar(publishedLift(native).usableLiftTopM) !== h.usableLiftTopM ||
            scalar(publishedLift(native).thermalVelocityMps) !== h.thermalVelocityMps
          );
        });
        const transformPass =
          Math.abs(yToHeight(view, heightToY(view, (view.floorM + view.topM) / 2)) - (view.floorM + view.topM) / 2) <
          1e-6;
        rendererAudit.push({
          site: p.site.id,
          model: p.model,
          units,
          width,
          pass: view.hours.length > 0 && !failures.length && transformPass && !/\bNaN\b/.test(svg),
          hours: view.hours.length,
          failures: failures.length,
          transformPass,
          svgSha256: sha256(svg),
          evidence: item.entry.sha256,
          scope: 'current checkout SVG against frozen live data; deployed-browser evidence recorded separately',
        });
      }
  }
  for (const region of snapshot.regional) {
    if (region.status !== 'captured') {
      coverage.push({
        product: 'regional-map',
        region: region.region,
        model: region.model,
        status: region.status,
      });
      continue;
    }
    try {
      const pointer = await jsonOf(root, region.pointer);
      if (pointer.manifestSha256 !== region.manifest.sha256) throw new Error('Regional pointer/manifest hash mismatch');
      const manifest = validateReplayManifest(await jsonOf(root, region.manifest));
      if (!manifest) throw new Error('Invalid regional manifest');
      const gridFile = region.files.find((f) => f.path === 'grid.geojson'),
        grid = validateReplayGrid(await jsonOf(root, gridFile.entry), manifest.cellCount);
      for (const f of region.files)
        if (ok(f.entry) && f.expectedHash && f.expectedHash !== f.entry.sha256)
          throw new Error(`Published hash mismatch: ${f.path}`);
      const byUrl = new Map(region.files.map((f) => [f.entry.url, f.entry]));
      const dataset = openRegionalDatasetFromDocuments({
        bundleUrl: region.bundleUrl,
        manifest,
        grid,
        model: region.model,
        read: async (url) => {
          const entry = byUrl.get(url);
          if (!ok(entry)) throw new Error(`Uncaptured regional object ${url}`);
          return jsonOf(root, entry);
        },
      });
      for (const f of region.files.filter((f) => /^cell-\d+\.json.gz$/.test(f.path) && ok(f.entry))) {
        const cell = Number(/cell-(\d+)/.exec(f.path)[1]),
          p = await dataset.loadCellProfile(cell);
        if (!p) continue;
        let checks = 0,
          failures = [];
        for (const h of p.hours) {
          const map = await dataset.loadHour(h.validAt);
          if (!map) continue;
          for (const key of [
            'thermalVelocityV2Mps',
            'usableLiftTopV2M',
            'hcritWxtoflyM',
            'resolvedThermalTopM',
            'surfaceLclM',
            'mixedLayerLclM',
            'blMeanWindSpeedMps',
          ]) {
            if (!map[key]) continue;
            checks++;
            const a = scalar(h.soaring?.[key]),
              b = map[key][cell];
            if (a !== b) failures.push({ validAt: h.validAt, field: key, profile: a, map: b });
          }
        }
        regionalAudit.push({
          region: region.region,
          model: region.model,
          cell,
          position: grid.features[cell].properties,
          checks,
          failures,
          pass: !failures.length,
          evidence: f.entry.sha256,
        });
      }
      coverage.push({
        product: 'regional-map',
        region: region.region,
        model: region.model,
        status: 'internally-checked; external-image-only',
        referenceTime: manifest.case.referenceTime,
      });
    } catch (error) {
      regionalAudit.push({ region: region.region, model: region.model, pass: false, error: error.message });
      coverage.push({
        product: 'regional-map',
        region: region.region,
        model: region.model,
        status: 'unavailable',
        reason: error.message,
      });
    }
  }
  return { rendererAudit, regionalAudit, coverage };
}
