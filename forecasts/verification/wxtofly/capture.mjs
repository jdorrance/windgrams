// Capture public products and optional local issued archives. Never rebuild or publish forecasts.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimCapture, createStore, textOf, jsonOf, readJsonResource, pool } from '../evidence-store.mjs';
import { references, parseBlipspot, parseMapMenu } from './html.mjs';
import { matchSites } from './matching.mjs';
import { captureRegionalBundles } from './regional-capture.mjs';
import { archivedModelRuns } from '../issued-history.mjs';
import { parsePublishedProfileJson } from '@windgrams/contracts/published-lift';
import { PROVIDER_GROUPS } from '@windgrams/providers/registry';

const ok = (entry) => entry?.status === 200;
const trim = (url) => url.replace(/\/$/, '');
export async function captureReview({
  siteUrl = 'https://jdorrance.github.io/windgrams/',
  dataUrl,
  wxUrl = 'http://wxtofly.net/',
  output,
  archiveRoot,
  archiveDays = 30,
  fetchImpl,
  log = console.log,
}) {
  if (!output) throw new Error('An output directory is required');
  if (!Number.isInteger(archiveDays) || archiveDays < 1 || archiveDays > 30)
    throw new Error('Archive window must be 1–30 days');
  const root = resolve(output);
  await claimCapture(root);
  const store = await createStore(root, { fetchImpl }),
    { take } = store;
  const startedAt = new Date().toISOString(),
    wxBase = trim(wxUrl);
  const snapshot = {
    schemaVersion: 1,
    startedAt,
    siteUrl,
    wxUrl,
    archiveDays,
    checkout: {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
      role: 'tooling only; scientific baseline is served bytes',
    },
    discovery: [],
    models: [],
    wxProducts: [],
    matches: [],
    regional: [],
    auxiliary: [],
    archives: [],
    gaps: [],
  };
  const json = (url, kind, fresh = false) => readJsonResource(store, url, { kind, fresh });
  log('Discovering served data origin and WxToFly inventory');
  const page = await take(siteUrl, { kind: 'website' });
  if (!ok(page)) throw new Error('Cannot read live website');
  const html = await textOf(root, page),
    scripts = references(html, siteUrl).filter((r) => r.tag === 'script');
  const candidates = new Set(dataUrl ? [trim(dataUrl)] : []);
  if (!dataUrl) {
    const seen = new Set();
    for (let depth = 0; depth < 3; depth++) {
      const batch = scripts.splice(0).filter((r) => !seen.has(r.url));
      for (const ref of batch) {
        seen.add(ref.url);
        const e = await take(ref.url, { kind: 'website-script' });
        if (!ok(e)) continue;
        const js = await textOf(root, e);
        for (const m of js.matchAll(/https?:\/\/[^\s"'`<>]+\/data\b[^\s"'`<>]*/g)) candidates.add(trim(m[0]));
        for (const m of js.matchAll(/["'](\.?\.?\/[^"']+\.js)["']/g))
          scripts.push({ url: new URL(m[1], ref.url).href });
      }
    }
    candidates.add(trim(new URL('data/', siteUrl.endsWith('/') ? siteUrl : siteUrl + '/').href));
  }
  let catalogue, sites;
  for (const candidate of candidates) {
    const a = await json(`${candidate}/models.json`, 'catalogue'),
      b = await json(`${candidate}/sites.json`, 'catalogue');
    snapshot.discovery.push({ candidate, models: a.entry, sites: b.entry });
    if (Array.isArray(a.value?.models) && Array.isArray(b.value?.sites)) {
      if (snapshot.dataUrl && snapshot.dataUrl !== candidate)
        throw new Error('Multiple valid data origins; specify --data-url');
      snapshot.dataUrl = candidate;
      catalogue = a.value;
      sites = b.value.sites;
    }
  }
  if (!snapshot.dataUrl) throw new Error('No validated data origin found; specify --data-url');
  const base = snapshot.dataUrl;
  snapshot.catalogue = catalogue;
  snapshot.sites = sites;
  const runs = await json(`${base}/runs.json`, 'runs');
  snapshot.runs = runs.entry;
  if (!runs.value?.runs)
    snapshot.gaps.push({ product: 'runs', reason: runs.error ?? 'Published run inventory unavailable' });
  for (const file of ['site-context.json', ...Object.keys(PROVIDER_GROUPS).map((g) => `health/${g}.json`)])
    snapshot.auxiliary.push((await json(`${base}/${file}`, 'context')).entry);
  // The Blipspot index contains geographic candidates across all published sites.
  const wxIndex = await take(`${wxBase}/blipspotBlanchard.html`, { kind: 'wx-index' });
  if (!ok(wxIndex)) throw new Error('Cannot discover WxToFly Blipspot index');
  const wxRefs = references(await textOf(root, wxIndex), wxIndex.url);
  const blips = wxRefs.filter(
    (r) => new URL(r.url).origin === new URL(wxBase).origin && /\/blipspot[^/]+\.html$/.test(new URL(r.url).pathname),
  );
  const wxCatalogue = await take(`${wxBase}/scripts/param_array.js`, { kind: 'wx-site-catalogue' });
  if (ok(wxCatalogue)) {
    const script = await textOf(root, wxCatalogue);
    // Extract literal catalogue records; never eval the provider's script.
    snapshot.wxSites = [
      ...script.matchAll(
        /my_ns_sitelist\["([^"]+)"\]\s*=\s*new Array\(\d+,\s*"[^"]+",\s*(-?[\d.]+),\s*(-?[\d.]+),\s*"([^"]+)",\s*"([^"]+)"\)/g,
      ),
    ].map((m) => ({ id: m[1], latitude: Number(m[2]), longitude: Number(m[3]), region: m[4], grid: m[5] }));
    for (const s of snapshot.wxSites) {
      const url = `${wxBase}/blipspot${encodeURI(s.id)}.html`;
      if (!blips.some((r) => r.url === url)) blips.push({ url });
    }
  }
  if (!blips.some((r) => r.url === wxIndex.url)) blips.push({ url: wxIndex.url });
  snapshot.wxProducts = await pool(blips, 3, async ({ url }, i) => {
    const id = decodeURIComponent(new URL(url).pathname.match(/blipspot(.+)\.html$/)[1]);
    let before = await take(url, { kind: 'wx-blipspot' }),
      after,
      parsed;
    for (let attempt = 0; attempt < 3; attempt++) {
      parsed = ok(before) ? parseBlipspot(await textOf(root, before), url) : null;
      after = await take(url, { kind: 'wx-blipspot-check', fresh: true });
      if (before.sha256 === after.sha256) break;
      if (attempt < 2) before = after;
    }
    if (i % 40 === 0) log(`WxToFly inventory ${i + 1}/${blips.length}`);
    return {
      id,
      kind: 'blipspot',
      entry: before,
      check: after,
      stable: ok(before) && before.sha256 === after?.sha256,
      ...parsed,
    };
  });
  snapshot.matches = matchSites(sites, snapshot.wxProducts);
  const matched = snapshot.matches.filter((m) => m.status === 'matched'),
    matchedIds = new Set(matched.map((m) => m.site.slug));
  log(`Matched ${matched.length}/${sites.length} launch identities; capturing live model profiles`);
  const modelSlugs = [
    ...new Set([...Object.keys(runs.value?.runs ?? {}), ...catalogue.models.map((model) => model.slug)]),
  ];
  if (modelSlugs.some((slug) => typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)))
    throw new Error('Invalid published model inventory');
  snapshot.models = await pool(modelSlugs, 3, async (slug) => {
    let selected;
    for (let attempt = 0; attempt < 3; attempt++) {
      const {
        entry: before,
        value: manifest,
        error,
      } = await json(`${base}/${slug}/manifest.json`, 'model-manifest', true);
      if (!manifest || !Array.isArray(manifest.sites) || !Number.isFinite(Date.parse(manifest.referenceTime))) {
        selected = {
          slug,
          manifest: before,
          profiles: [],
          stable: false,
          reason: error ?? 'manifest-unavailable-or-invalid',
          attempts: attempt + 1,
        };
        continue;
      }
      const profiles = await pool(
        manifest.sites.filter((s) => matchedIds.has(s?.slug)),
        4,
        async (s) => {
          const entry = await take(`${base}/${slug}/sites/${s.slug}.json`, {
            kind: 'point-profile',
            fresh: attempt > 0,
          });
          const profile = ok(entry) ? parsePublishedProfileJson(await textOf(root, entry)) : null;
          return {
            site: s.slug,
            entry,
            valid:
              !!profile &&
              profile.model === slug &&
              profile.site.id === s.slug &&
              profile.run.referenceTime === manifest.referenceTime,
          };
        },
      );
      const after = await take(before.url, { kind: 'model-manifest-check', fresh: true });
      selected = {
        slug,
        manifest: before,
        check: after,
        referenceTime: manifest.referenceTime,
        generatedAt: manifest.generatedAt,
        profiles,
        inventory: manifest.sites.map((s) => s.slug),
        stable: before.sha256 === after.sha256 && profiles.every((p) => p.valid),
        attempts: attempt + 1,
      };
      if (selected.stable) break;
    }
    log(`${slug}: ${selected.profiles.length} profiles; stable=${selected.stable}`);
    return selected;
  });
  for (const model of snapshot.models)
    if (!model.stable)
      snapshot.gaps.push({
        product: `model/${model.slug}`,
        reason: model.reason ?? 'publication-changed-or-invalid-profile',
      });
  for (const m of matched) {
    const product = snapshot.wxProducts.find((p) => p.id === m.wxId);
    const linked = references(await textOf(root, product.entry), product.entry.url).find(
      (r) => r.url.includes(`${encodeURI(m.wxId)}_iwindgram.html`) || r.url.endsWith(`/${m.wxId}_iwindgram.html`),
    );
    if (linked) {
      const entry = await take(linked.url, { kind: 'wx-windgram-page' }),
        images = [];
      if (ok(entry))
        for (const ref of references(await textOf(root, entry), entry.url).filter(
          (r) => r.tag === 'img' && /windgram.*\.png/.test(r.url),
        ))
          images.push(await take(ref.url, { kind: 'wx-windgram-image' }));
      product.windgram = { entry, images };
    }
  }
  log('Capturing definitions, regional bundles, soundings and archives');
  // Public menu scripts are retained as text; none of their JavaScript is executed.
  const wxDocs = [
    'windgramexplain.html',
    'scripts/param_array.js',
    'pic_time.js',
    'scripts/getdatetime.js',
    'wip.html',
    'fslsoundings.html',
    'textlinks.html',
    'RASP/PNW/menu.html',
    'RASP/PNW/indexd2.html',
    'RASP/TIGER/menu.html',
    'RASP/FRASER/menu.html',
  ];
  snapshot.wxDocuments = await pool(wxDocs, 3, async (path) =>
    take(`${wxBase}/${path}`, { kind: 'wx-definition-or-inventory' }),
  );
  for (const entry of snapshot.wxDocuments.filter(ok)) {
    const refs = references(await textOf(root, entry), entry.url);
    for (const ref of refs.filter(
      (r) => r.tag === 'iframe' || r.tag === 'frame' || (r.tag === 'img' && /locallapserate|barb/i.test(r.url)),
    )) {
      if (new URL(ref.url).origin === new URL(wxBase).origin)
        snapshot.auxiliary.push(await take(ref.url, { kind: 'wx-sounding-or-legend' }));
    }
    if (/indexd2\.html$/.test(entry.url))
      for (const ref of refs.filter((r) => r.tag === 'frame' && /menu/.test(r.url)))
        snapshot.wxDocuments.push(await take(ref.url, { kind: 'wx-definition-or-inventory' }));
  }
  // Enumerate image maps from the literal menu arrays, preserving their exact provider template.
  snapshot.wxMapInventory = [];
  for (const entry of [
    ...new Map(
      snapshot.wxDocuments.filter((e) => ok(e) && e.url.endsWith('/menu.html')).map((e) => [e.url, e]),
    ).values(),
  ]) {
    const s = await textOf(root, entry),
      region = /RASP\/([^/]+)\//.exec(entry.url)[1];
    const { parameters, times, grids, resolutions } = parseMapMenu(s);
    for (const grid of grids) {
      snapshot.wxMapInventory.push({
        region,
        grid,
        parameters,
        times,
        source: entry,
        resolution: resolutions[grid] ?? null,
        numericAvailability: 'no numeric map endpoint advertised in captured menu',
        imageTemplate: `${wxBase}/RASP/${region}/FCST/{parameter}.curr.{time}.${grid}.png`,
      });
      // All advertised parameters/hours in the grids used by shared launches.
      if (region === 'PNW' || (region === 'TIGER' && grid === 'w2')) {
        const assets = await pool(
          parameters.flatMap((parameter) => times.map((time) => ({ parameter, time }))),
          4,
          async (p) => ({
            ...p,
            entry: await take(`${wxBase}/RASP/${region}/FCST/${p.parameter}.curr.${p.time}.${grid}.png`, {
              kind: 'wx-regional-map',
            }),
          }),
        );
        snapshot.wxMapInventory.at(-1).assets = assets;
        log(`${region}/${grid}: ${assets.length} advertised image maps captured`);
      }
    }
  }
  const regions = await json(`${base}/soaring/v1/regions.json`, 'regional-catalogue');
  snapshot.regions = regions.entry;
  snapshot.regional = await captureRegionalBundles(store, base, regions.value, matched);
  // Freeze sparse guidance and observations for all matched launches, keeping their original wire formats.
  for (const product of ['nws', 'ecmwf', 'raob']) {
    snapshot.auxiliary.push((await json(`${base}/${product}/manifest.json`, `${product}-manifest`)).entry);
    const entries = await pool(matched, 4, async (m) =>
      take(`${base}/${product}/sites/${m.site.slug}.json`, { kind: `${product}-profile` }),
    );
    snapshot.auxiliary.push(...entries);
  }
  const archiveIndex = await take('http://windgrams.guiplot.com/', { kind: 'wx-archive-index' });
  snapshot.wxArchive = archiveIndex;
  if (!ok(archiveIndex) || /page not found/i.test(await textOf(root, archiveIndex)))
    snapshot.gaps.push({
      product: 'WxToFly archive',
      reason: `archive index HTTP ${archiveIndex.status}, but no usable archive catalogue; historical products are not assumed available`,
    });
  snapshot.auxiliary.push(
    await take('http://www.drjack.info/RASP/INFO/parameters.html', { kind: 'scientific-definition' }),
  );
  if (archiveRoot) {
    const from = Date.parse(startedAt) - archiveDays * 86400000;
    for (const model of modelSlugs) {
      let runs;
      try {
        runs = archivedModelRuns(archiveRoot, model, { maxRuns: 120 });
      } catch (error) {
        snapshot.gaps.push({ product: `archive/${model}`, reason: error.message });
        continue;
      }
      for (const run of runs) {
        const manifestPath = join(run.directory, 'manifest.json');
        let manifest;
        try {
          manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        } catch {
          continue;
        }
        if (Date.parse(manifest.referenceTime) < from || Date.parse(manifest.referenceTime) > Date.parse(startedAt))
          continue;
        const record = {
          model,
          runKey: run.runKey,
          revisionId: run.revisionId ?? 'legacy',
          referenceTime: manifest.referenceTime,
          profiles: [],
          source: 'local retained issued archive; not latest live publication',
        };
        record.manifest = await store.save(await readFile(manifestPath), {
          url: `archive:${relative(archiveRoot, manifestPath)}`,
          status: 200,
          retrievedAt: startedAt,
          kind: 'issued-manifest',
        });
        for (const file of await readdir(join(run.directory, 'sites'))) {
          if (!file.endsWith('.json')) continue;
          const slug = file.slice(0, -5);
          if (!matchedIds.has(slug)) continue;
          const path = join(run.directory, 'sites', file);
          record.profiles.push({
            site: slug,
            entry: await store.save(await readFile(path), {
              url: `archive:${relative(archiveRoot, path)}`,
              status: 200,
              retrievedAt: startedAt,
              kind: 'issued-profile',
            }),
          });
        }
        snapshot.archives.push(record);
      }
    }
  }
  snapshot.completedAt = new Date().toISOString();
  snapshot.resources = store.resources;
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  log(`Frozen ${store.resources.length} evidence records in ${root}`);
  return snapshot;
}
