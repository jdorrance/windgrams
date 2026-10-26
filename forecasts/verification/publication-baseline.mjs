// Freeze the served baseline and selected regression profiles; never rebuild or deploy.
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { claimCapture, createStore, textOf, readJsonResource, pool } from './evidence-store.mjs';
import { references } from './wxtofly/html.mjs';
import { PROVIDER_GROUPS } from '@windgrams/providers/registry';
import { REGRESSION_SITES } from './definitions.mjs';
export { REGRESSION_SITES } from './definitions.mjs';

const trim = (value) => value.replace(/\/$/, '');
const validHours = (value) =>
  Array.isArray(value?.hours) &&
  value.hours.length > 0 &&
  value.hours.every(
    (hour, index, hours) =>
      typeof hour?.validAt === 'string' &&
      /(?:Z|[+-]\d\d:\d\d)$/.test(hour.validAt) &&
      Number.isFinite(Date.parse(hour.validAt)) &&
      (index === 0 || Date.parse(hour.validAt) > Date.parse(hours[index - 1].validAt)),
  );
/** Output is immutable. All manifest reads bracket profile capture; changed runs retry. */
export async function capturePublicationBaseline({
  siteUrl = 'https://jdorrance.github.io/windgrams/',
  dataUrl,
  output,
  siteSlugs = REGRESSION_SITES,
  fetchImpl,
  checkout = true,
}) {
  if (!output) throw new Error('An output directory is required');
  const root = resolve(output);
  await claimCapture(root, 'baseline.json');
  const store = await createStore(root, { fetchImpl });
  const result = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    siteUrl,
    scope: 'served inventory plus fixed regression profiles; not full forecast-skill review',
    checkout: checkout
      ? {
          head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          status: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }).trim(),
          role: 'implementation only; baseline is served bytes',
        }
      : null,
    discovery: [],
    models: [],
    regional: [],
    gaps: [],
  };
  const read = (url, kind) => readJsonResource(store, url, { kind, fresh: true });
  const page = await store.take(siteUrl, { kind: 'website' });
  if (page.status !== 200) throw new Error(`Website HTTP ${page.status}`);
  result.page = page;
  const queue = references(await textOf(root, page), siteUrl)
    .filter((ref) => ref.tag === 'script')
    .map((ref) => ref.url);
  const seen = new Set(),
    candidates = new Set(dataUrl ? [trim(dataUrl)] : []);
  for (let depth = 0; depth < 4; depth++) {
    for (const url of queue.splice(0)) {
      if (seen.has(url)) continue;
      seen.add(url);
      const entry = await store.take(url, { kind: 'client-script' });
      if (entry.status !== 200) continue;
      const js = await textOf(root, entry);
      if (!dataUrl)
        for (const match of js.matchAll(/https?:\/\/[^\s"'`<>]+\/data\b[^\s"'`<>]*/g)) candidates.add(trim(match[0]));
      for (const match of js.matchAll(/["'](\.?\.?\/[^"']+\.js)["']/g)) queue.push(new URL(match[1], url).href);
    }
  }
  if (!dataUrl) candidates.add(trim(new URL('data/', siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`).href));
  let catalogue;
  for (const base of candidates) {
    const models = await read(`${base}/models.json`, 'catalogue'),
      sites = await read(`${base}/sites.json`, 'sites');
    result.discovery.push({ base, models: models.entry, sites: sites.entry });
    if (!Array.isArray(models.value?.models) || !Array.isArray(sites.value?.sites)) continue;
    if (result.dataUrl && result.dataUrl !== base) throw new Error('Multiple valid origins: supply --data-url');
    result.dataUrl = base;
    catalogue = models.value;
    result.siteCount = sites.value.sites.length;
  }
  if (!result.dataUrl) throw new Error('No verified data origin');
  const base = result.dataUrl;
  const runs = await read(`${base}/runs.json`, 'runs');
  result.runs = runs.entry;
  const modelSlugs = [
    ...new Set([...Object.keys(runs.value?.runs ?? {}), ...catalogue.models.map((model) => model.slug)]),
  ];
  if (modelSlugs.some((slug) => typeof slug !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(slug)))
    throw new Error('Invalid published model inventory');
  result.models = await pool(modelSlugs, 3, async (slug) => {
    let captured;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await read(`${base}/${slug}/manifest.json`, 'model-manifest');
      if (
        !before.value ||
        !Array.isArray(before.value.sites) ||
        !Number.isFinite(Date.parse(before.value.referenceTime))
      ) {
        captured = {
          slug,
          manifest: before.entry,
          stable: false,
          reason: 'manifest-unavailable-or-invalid',
          attempts: attempt + 1,
        };
        continue;
      }
      const inventory = before.value.sites;
      const profiles = await pool(
        siteSlugs.filter((site) => inventory.some((item) => (item.slug ?? item.id ?? item) === site)),
        3,
        async (site) => {
          const { entry, value } = await read(`${base}/${slug}/sites/${site}.json`, 'regression-profile');
          const hours = Array.isArray(value?.hours) ? value.hours : [];
          return {
            site,
            entry,
            valid: Boolean(
              value &&
              validHours(value) &&
              value.model === slug &&
              value.site?.id === site &&
              value.run?.referenceTime === before.value.referenceTime,
            ),
            run: value?.run?.referenceTime ?? null,
            modelElevationM: value?.site?.modelElevationM ?? null,
            methodVersions: [...new Set(hours.map((hour) => hour?.soaring?.contractVersion).filter(Boolean))],
            nativeLevelCounts: [...new Set(hours.map((hour) => hour?.levels?.length).filter(Number.isFinite))],
          };
        },
      );
      const after = await read(`${base}/${slug}/manifest.json`, 'manifest-check');
      captured = {
        slug,
        referenceTime: before.value.referenceTime,
        generatedAt: before.value.generatedAt,
        manifest: before.entry,
        check: after.entry,
        profiles,
        stable: before.entry.sha256 === after.entry.sha256 && profiles.every((profile) => profile.valid),
        unrepresentedSites: siteSlugs.filter((site) => !profiles.some((profile) => profile.site === site)),
        attempts: attempt + 1,
      };
      if (captured.stable) break;
    }
    return captured;
  });
  const regions = await read(`${base}/soaring/v1/regions.json`, 'regions');
  result.regions = regions.entry;
  for (const region of regions.value?.regions ?? [])
    for (const model of region.nativeModels ?? []) {
      let captured;
      for (let attempt = 0; attempt < 3; attempt++) {
        const pointer = await read(`${base}/soaring/v1/${model.caseId}/index.json`, 'regional-pointer');
        const bundle = pointer.value?.bundle;
        const manifest =
          typeof bundle === 'string' && /^bundles\/[a-f0-9]{64}$/.test(bundle)
            ? await read(`${base}/soaring/v1/${model.caseId}/${bundle}/manifest.json`, 'regional-manifest')
            : null;
        const check = await read(pointer.entry.url, 'regional-pointer-check');
        captured = {
          region: region.id,
          model: model.model,
          caseId: model.caseId,
          entry: pointer.entry,
          check: check.entry,
          references: pointer.value,
          manifest: manifest?.entry ?? null,
          stable: Boolean(
            manifest?.value &&
            manifest.entry.sha256 === pointer.value?.manifestSha256 &&
            pointer.entry.sha256 === check.entry.sha256,
          ),
          attempts: attempt + 1,
        };
        if (captured.stable) break;
      }
      result.regional.push(captured);
    }
  const health = await read(`${base}/site-context.json`, 'site-context');
  result.context = health.entry;
  result.refreshStatus = await pool(Object.keys(PROVIDER_GROUPS), 3, async (provider) => ({
    provider,
    entry: (await read(`${base}/health/${provider}.json`, 'provider-health')).entry,
  }));
  for (const model of result.models)
    if (!model.stable)
      result.gaps.push({
        model: model.slug,
        reason: model.reason ?? 'publication-changed-or-profile-identity-mismatch',
      });
  for (const region of result.regional)
    if (!region.stable) result.gaps.push({ caseId: region.caseId, reason: 'regional-bundle-unavailable-or-changing' });
  result.finishedAt = new Date().toISOString();
  result.resources = store.resources;
  await writeFile(join(root, 'baseline.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--site-url': 'siteUrl', '--data-url': 'dataUrl', '--output': 'output' }[args[i]];
    if (!key || !args[i + 1])
      throw new Error('Usage: publication-baseline.mjs --output DIR [--site-url URL] [--data-url URL]');
    options[key] = args[i + 1];
  }
  const baseline = await capturePublicationBaseline(options);
  console.log(
    JSON.stringify(
      {
        output: resolve(options.output),
        dataUrl: baseline.dataUrl,
        models: baseline.models.map((model) => ({
          slug: model.slug,
          stable: model.stable,
          methods: [...new Set((model.profiles ?? []).flatMap((profile) => profile.methodVersions))],
        })),
        gaps: baseline.gaps,
      },
      null,
      2,
    ),
  );
}
