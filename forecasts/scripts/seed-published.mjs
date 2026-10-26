import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { diagnosticMethodDowngrade } from './lib/diagnostic-completeness.mjs';
import { pointProduct } from './lib/artifact-products.mjs';
import { REGION_INDEXES } from './lib/model-coverage.mjs';
import { isRetiredRegionalCase, publicRegionCatalogue } from './lib/retired-regions.mjs';
// Copies an already published dataset onto disk so a builder that finds
// nothing new to write does not deploy an empty directory.
//
// Point models seed independently. Complete runs replace cached model trees;
// missing or failed feeds retain validated last-good data. Other models continue.
//
// Sunlight tiles are not part of any group.
//
//   node scripts/seed-published.mjs --output data --from "$METEO_DATA_BASE" --group eccc
//   node scripts/seed-published.mjs --list eccc

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { paths as ecmwfPaths } from "./lib/ecmwf.mjs";
import { retryingFetch } from "./lib/http.mjs";
import { paths as nwsPaths } from "./lib/nws.mjs";
import { paths as raobPaths } from "./lib/raob.mjs";
import { parseObservationManifest } from './lib/observation-manifest.mjs';
import { isPublishedCase } from './merge-soaring-regions.mjs';
import { mergeProviderHealth } from './lib/provider-health.mjs';

import { PROVIDER_GROUPS, selectModels, modelDescriptor } from '@windgrams/providers/registry';
import { stageModel, validateModelDirectory } from '@windgrams/pipeline';

export const GROUPS = { ...PROVIDER_GROUPS, soaring: [], observations: [], terrain: [] };

const JSON_START = /^[\[{]/;

export function groupNames() {
  return Object.keys(GROUPS);
}

function slugsOf(document) {
  const sites = Array.isArray(document?.sites) ? document.sites : [];
  return sites.map((site) => site?.slug).filter((slug) => typeof slug === "string" && slug !== "");
}

function officesOf(document) {
  const offices = Array.isArray(document?.offices) ? document.offices : [];
  return offices.map((office) => office?.office).filter((id) => typeof id === "string" && id !== "");
}

/**
 * The keys to copy for `group`. `get` returns the parsed JSON of a key, or
 * null when the live site has no such object. Throws when a read fails.
 */
export async function collectGroup(group, { get, getBytes, getCachedBytes, sites = [], models = GROUPS[group] }) {
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`unknown group "${group}". Known: ${groupNames().join(", ")}`);
  if (!Array.isArray(models) || models.some(model => !GROUPS[group].includes(model))) throw new Error(`Invalid model selection for ${group}`);
  const files = new Map();
  const take = async (key, expectedHash) => {
    if (key.endsWith('.gz') && !getBytes) throw new Error(`getBytes is required for compressed published files: ${key}`);
    // Only immutable bundle bytes are eligible. Fresh remote pointers supply
    // the manifest hash; that verified manifest supplies each file hash.
    const cached = expectedHash && getCachedBytes ? await getCachedBytes(key) : null;
    const validCache = cached != null && createHash('sha256').update(bytesOf(cached)).digest('hex') === expectedHash;
    const payload = validCache ? cached : getBytes ? await getBytes(key) : await get(key);
    if (payload === null) return null;
    const document = getBytes ? parseJsonBytes(payload, key) : payload;
    files.set(key, payload);
    return document;
  };
  const digest = key => createHash('sha256').update(bytesOf(files.get(key))).digest('hex');

  for (const model of models) {
    const manifest = await take(`${model}/manifest.json`);
    if (!manifest) continue;
    for (const slug of slugsOf(manifest)) {
      const profile = await take(`${model}/sites/${slug}.json`);
      if (!profile || !manifest.referenceTime || profile.run?.referenceTime !== manifest.referenceTime) {
        throw new Error(`Incomplete published ${model.toUpperCase()} run: ${slug}`);
      }
    }
    if (model === 'icon-eu') await take(`${model}/source.json`);
  }

  if (group === "soaring") {
    const indexes = await Promise.all(REGION_INDEXES.map(async entry => {
      const key = `soaring/v1/${entry.file}`, index = await take(key);
      if (!index) return index;
      const filtered = publicRegionCatalogue(index);
      if (filtered !== index) files.set(key, getBytes ? Buffer.from(JSON.stringify(filtered) + '\n') : filtered);
      return filtered;
    }));
    const caseIds = new Set();
    for (const r of indexes.flatMap(index => index?.regions ?? [])) {
      if (r?.status === "active-verified-trial" && typeof r.caseId === "string") {
        caseIds.add(r.caseId);
      }
      for (const native of r?.nativeModels ?? []) {
        if (typeof native.caseId === 'string') caseIds.add(native.caseId);
      }
    }
    const advertisedCases = new Set(caseIds);
    for (const caseId of caseIds) {
      if (isRetiredRegionalCase(caseId)) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) throw new Error(`Invalid soaring case id: ${caseId}`);
      const pointer = await take(`soaring/v1/${caseId}/index.json`);
      if (!pointer) {
        if (advertisedCases.has(caseId)) throw new Error(`Missing published soaring pointer: ${caseId}`);
        continue;
      }
      if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error(`Invalid soaring pointer: ${caseId}`);
      const bundleRoot = `soaring/v1/${caseId}/${pointer.bundle}`;
      const manifest = await take(`${bundleRoot}/manifest.json`, pointer.manifestSha256);
      if (!manifest || digest(`${bundleRoot}/manifest.json`) !== pointer.manifestSha256 || manifest.case?.id !== caseId) {
        throw new Error(`Incomplete or corrupt soaring manifest: ${caseId}`);
      }
      const names = Object.keys(manifest.files ?? {});
      if (!names.length) throw new Error(`Empty soaring bundle: ${caseId}`);
      for (const fileName of names) {
        if (!/^[a-zA-Z0-9.-]+$/.test(fileName)) throw new Error(`Invalid soaring bundle file: ${fileName}`);
        const key = `${bundleRoot}/${fileName}`;
        if (!await take(key, manifest.files[fileName]) || digest(key) !== manifest.files[fileName]) throw new Error(`Incomplete or corrupt soaring bundle: ${key}`);
      }
    }
  }

  if (group === "observations") {
    const nws = await take(nwsPaths.manifest());
    if (nws) {
      for (const slug of slugsOf(nws)) await take(nwsPaths.site(slug));
      for (const office of officesOf(nws)) await take(nwsPaths.office(office));
    }
    const ecmwf = await take(ecmwfPaths.manifest());
    if (ecmwf) for (const slug of slugsOf(ecmwf)) await take(ecmwfPaths.site(slug));
    const raob = await take(raobPaths.manifest());
    if (raob && !parseObservationManifest(raob, 'raob')) throw new Error('Invalid published balloon manifest');
    for (const site of raob?.sites ?? sites) if (!site.absent) await take(raobPaths.site(site.slug));
  }

  if (group === "terrain") await take("site-context.json");
  return files;
}

/** True when the cache already holds something this group publishes. */
export function groupHasLocal(output, group) {
  if (!Object.hasOwn(GROUPS, group)) return false;
  if (GROUPS[group].some((model) => existsSync(join(output, model, "manifest.json")))) return true;
  if (group === "soaring") {
    const root = join(output, 'soaring', 'v1');
    for (const name of REGION_INDEXES.map(entry => entry.file)) {
      try {
        const regions = JSON.parse(readFileSync(join(root, name)));
        if (regions.regions.some(region => [region.caseId, ...(region.nativeModels ?? []).map(item => item.caseId)]
          .filter(Boolean).some(caseId => isPublishedCase(root, caseId)))) return true;
      } catch { /* Try other independently published model indexes. */ }
    }
    return false;
  }
  if (group === "observations") {
    return existsSync(join(output, nwsPaths.manifest())) || existsSync(join(output, ecmwfPaths.manifest())) || existsSync(join(output, "raob"));
  }
  if (group === "terrain") return existsSync(join(output, "site-context.json"));
  return false;
}

/**
 * Writes fetched documents. A model whose manifest came back replaces that
 * model directory, so a dropped launch does not keep a stale profile.
 */
export function applyGroup(output, group, files) {
  // Cached publication may be ahead of a lagging CDN. Seed immutable bytes, but
  // never move a known regional run or a newer model catalogue backward.
  if (group === 'soaring') files = monotonicSoaringSeed(output, files);
  if (group === 'observations') {
    let previous;
    try { previous = parseObservationManifest(JSON.parse(readFileSync(join(output, raobPaths.manifest()), 'utf8')), 'raob'); } catch { /* No prior attempt. */ }
    if (files.has(raobPaths.manifest())) {
      const manifest = parseObservationManifest(JSON.parse(bytesOf(files.get(raobPaths.manifest())).toString('utf8')), 'raob');
      if (!manifest) throw new Error('Invalid published balloon manifest');
      if (Date.parse(previous?.generatedAt) > Date.parse(manifest.generatedAt)) files = new Map([...files].filter(([key]) => !key.startsWith('raob/')));
      else for (const site of manifest.sites) if (site.absent) rmSync(join(output, raobPaths.site(site.slug)), { force: true });
    } else if (previous) {
      // Legacy CDNs have no attempt manifest; their older flights cannot undo one.
      files = new Map([...files].filter(([key, document]) => !key.startsWith('raob/sites/')
        || Date.parse(JSON.parse(bytesOf(document).toString('utf8')).generatedAt) > Date.parse(previous.generatedAt)));
    }
  }
  for (const model of GROUPS[group]) {
    if (!files.has(`${model}/manifest.json`)) continue;
    rmSync(join(output, model), { recursive: true, force: true });
  }
  // Content and manifests land before pointers, then regional catalogues. Raw
  // bytes are preserved because every soaring pointer/file is content hashed.
  const priority = key => /\/regions(?:-[a-z0-9-]+)?\.json$/.test(key) ? 3 : /\/index\.json$/.test(key) ? 2 : /\/manifest\.json$/.test(key) ? 1 : 0;
  for (const [key, document] of [...files].sort((a, b) => priority(a[0]) - priority(b[0]))) {
    const path = join(output, key);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, bytesOf(document)); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
}

function monotonicSoaringSeed(output, files) {
  const selected = new Map(files);
  const readFetched = key => {
    const value = files.get(key);
    return value == null ? null : parseJsonBytes(Buffer.from(bytesOf(value)), key);
  };
  const readCached = key => {
    try { return JSON.parse(readFileSync(join(output, key), 'utf8')); }
    catch { return null; }
  };
  const older = (next, previous, primary, secondary) => {
    const before = Date.parse(previous?.[primary]), after = Date.parse(next?.[primary]);
    if (!Number.isFinite(before)) return false;
    if (!Number.isFinite(after) || after < before) return true;
    if (after > before || !secondary) return false;
    const priorCreated = Date.parse(previous?.[secondary]), nextCreated = Date.parse(next?.[secondary]);
    return Number.isFinite(priorCreated) && (!Number.isFinite(nextCreated) || nextCreated < priorCreated);
  };
  for (const key of files.keys()) {
    const match = /^soaring\/v1\/([a-zA-Z0-9_-]+)\/index\.json$/.exec(key);
    if (match) {
      const next = readFetched(key), previous = readCached(key), root = `soaring/v1/${match[1]}`;
      if (!/^bundles\/[a-f0-9]{64}$/.test(next?.bundle) || !/^bundles\/[a-f0-9]{64}$/.test(previous?.bundle)) continue;
      const nextManifest = readFetched(`${root}/${next.bundle}/manifest.json`), priorManifest = readCached(`${root}/${previous.bundle}/manifest.json`);
      if ((diagnosticMethodDowngrade(nextManifest?.soaringContractVersion, priorManifest?.soaringContractVersion)
        && isPublishedCase(join(output, 'soaring/v1'), match[1]))
        || older({ referenceTime: nextManifest?.case?.referenceTime, capturedAt: nextManifest?.capturedAt },
        { referenceTime: priorManifest?.case?.referenceTime, capturedAt: priorManifest?.capturedAt }, 'referenceTime', 'capturedAt')) selected.delete(key);
    } else if (REGION_INDEXES.some(entry => key === `soaring/v1/${entry.file}`)
      && (diagnosticMethodDowngrade(readFetched(key)?.soaringContractVersion, readCached(key)?.soaringContractVersion)
        || older(readFetched(key), readCached(key), 'generatedAt'))) selected.delete(key);
  }
  return selected;
}

function rootUrl(from) {
  return from.replace(/\/+$/, "");
}

function bytesOf(document) {
  return Buffer.isBuffer(document) || typeof document === 'string' ? document : `${JSON.stringify(document)}\n`;
}

function parseJsonBytes(bytes, key) {
  const text = (key.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString("utf8").trimStart();
  if (!JSON_START.test(text)) throw new Error(`${key} was not JSON`);
  return JSON.parse(text);
}

/** Recover complete point models independently, before attempting new acquisition. */
export async function seedPublishedGroup(output, group, options) {
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`unknown group "${group}"`);
  if (!GROUPS[group].length) {
    try {
      const files = await collectGroup(group, options);
      applyGroup(output, group, files);
      return { objects: files.size, outcomes: [{ model: group, status: 'seeded' }] };
    } catch (error) {
      if (groupHasLocal(output, group)) return { objects: 0, outcomes: [{ model: group, status: 'retained', error: error.message }] };
      throw error;
    }
  }
  let objects = 0;
  const outcomes = [];
  for (const model of GROUPS[group]) {
    const completeness = { model, expectedForecastHours: modelDescriptor(model).forecastHours };
    try {
      const files = await collectGroup(group, { ...options, models: [model] });
      if (!files.has(`${model}/manifest.json`)) {
        if (!existsSync(join(output, model))) { outcomes.push({ model, status: 'absent' }); continue; }
        validateModelDirectory(output, completeness);
        outcomes.push({ model, status: 'retained' });
        continue;
      }
      let current = false;
      try { current = pointProduct(output, model, options.sites ?? [], { retained: true }).methodVersion === SOARING_CONTRACT_VERSION; }
      catch { /* The staged source may repair an absent or invalid cache. */ }
      const profiles = [...files].filter(([key]) => key.startsWith(`${model}/sites/`));
      if (current && profiles.some(([, value]) => {
        const profile = parseJsonBytes(Buffer.from(bytesOf(value)), 'profile.json');
        return diagnosticMethodDowngrade(profile.soaringMeta?.contractVersion, SOARING_CONTRACT_VERSION);
      })) {
        outcomes.push({ model, status: 'retained', reason: 'Published origin has an older diagnostic method' });
        continue;
      }
      await stageModel({ outputRoot: output, ...completeness,
        build: async staging => applyGroup(staging, group, files), finish: () => null });
      objects += files.size;
      outcomes.push({ model, status: 'seeded' });
    } catch (error) {
      try {
        validateModelDirectory(output, completeness);
        outcomes.push({ model, status: 'retained', error: error.message });
      } catch {
        // Invalid generated cache cannot be overlaid onto a healthy deployment.
        // A fresh provider build can recreate this model independently.
        rmSync(join(output, model), { recursive: true, force: true });
        outcomes.push({ model, status: 'unavailable', error: error.message });
      }
    }
  }
  return { objects, outcomes };
}

/** Try every selected provider even when another has no recoverable publication. */
export async function seedPublishedGroups(output, groups, options, seed = seedPublishedGroup) {
  if (groups.some(group => !Object.hasOwn(GROUPS, group))) throw new Error('Unknown seed group.');
  const results = [];
  for (const group of new Set(groups)) {
    try { results.push({ group, ...await seed(output, group, options) }); }
    catch (error) { results.push({ group, objects: 0, outcomes: [{ model: group, status: 'unavailable', error: error.message }] }); }
  }
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: "string", default: "data" },
      from: { type: "string" },
      group: { type: "string", multiple: true },
      all: { type: 'boolean', default: false },
      'best-effort': { type: 'boolean', default: false },
      sites: { type: "string", default: "sites.json" },
      list: { type: "string" },
    },
  });
  if (values.list) {
    if (!Object.hasOwn(GROUPS, values.list)) {
      console.error(`--list needs a group: ${groupNames().join(", ")}`);
      process.exit(1);
    }
    process.stdout.write(`${GROUPS[values.list].join(" ")}\n`);
    return;
  }
  if ((!values.group?.length && !values.all) || !values.from || (values.group?.length && values.all)) {
    throw new Error('usage: node scripts/seed-published.mjs --output data --from URL (--group GROUP... | --all) [--best-effort]');
  }

  const output = resolve(values.output);
  const from = rootUrl(values.from);
  const sitesPath = resolve(values.sites);
  const sites = existsSync(sitesPath) ? JSON.parse(readFileSync(sitesPath, "utf8")).sites ?? [] : [];
  const getBytes = async (key) => {
    const response = await retryingFetch()(`${from}/${key}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${key} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };

  const results = await seedPublishedGroups(output, values.all ? groupNames() : values.group, { getBytes, sites, getCachedBytes: key => {
      try { return readFileSync(join(output, key)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    } });
  for (const group of values.all ? Object.keys(PROVIDER_GROUPS) : values.group.filter(group => Object.hasOwn(PROVIDER_GROUPS, group))) {
    try {
      const key = `health/${group}.json`, bytes = await getBytes(key);
      if (bytes === null) continue;
      const path = join(output, key);
      const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      const next = mergeProviderHealth(previous, JSON.parse(bytes), group);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(next) + '\n');
    } catch (error) { console.warn(`Health seed retained for ${group}: ${error.message}`); }
  }
  for (const result of results) {
    for (const outcome of result.outcomes) if (outcome.error) {
      const message = `${outcome.model} ${outcome.status}: ${outcome.error}`;
      console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}` : `WARN ${message}`);
    }
    console.log(`Seeded ${result.objects} object(s) for ${result.group} from ${from}`);
  }
  if (!values['best-effort'] && results.some(result => result.outcomes.some(outcome => outcome.status === 'unavailable'))) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
