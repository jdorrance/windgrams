// Copies an already published dataset onto disk so a builder that finds
// nothing new to write does not deploy an empty directory.
//
// A live file replaces the cached one. A 404 leaves the cached file in place.
// A network failure after retries leaves the cache untouched when it already
// holds this group, and fails the run when it does not.
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
import { isPublishedCase } from './merge-soaring-regions.mjs';

/** Model slugs for each runner. Observations, soaring, and terrain publish no single model. */
export const GROUPS = {
  "noaa-cloud": ["hrrr-conus", "gfs"],
  rrfs: ["rrfs"],
  dwd: ["icon-eu"],
  eccc: ["hrdps-continental", "rdps", "gdps", "geps"],
  soaring: [],
  observations: [],
  terrain: [],
};

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
export async function collectGroup(group, { get, getBytes, getCachedBytes, sites = [] }) {
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`unknown group "${group}". Known: ${groupNames().join(", ")}`);
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

  for (const model of GROUPS[group]) {
    const manifest = await take(`${model}/manifest.json`);
    if (!manifest) continue;
    for (const slug of slugsOf(manifest)) {
      const profile = await take(`${model}/sites/${slug}.json`);
      if (['rrfs', 'icon-eu'].includes(model) && (!profile || profile.run?.referenceTime !== manifest.referenceTime)) {
        throw new Error(`Incomplete published ${model.toUpperCase()} run: ${slug}`);
      }
    }
    if (model === 'icon-eu') await take(`${model}/source.json`);
  }

  if (group === "soaring") {
    const regions = await take("soaring/v1/regions.json");
    const rrfsRegions = await take('soaring/v1/regions-rrfs.json');
    const iconRegions = await take('soaring/v1/regions-icon-eu.json');
    const caseIds = new Set();
    for (const r of [...(regions?.regions ?? []), ...(rrfsRegions?.regions ?? []), ...(iconRegions?.regions ?? [])]) {
      if (r?.status === "active-verified-trial" && typeof r.caseId === "string") {
        caseIds.add(r.caseId);
      }
      for (const native of r?.nativeModels ?? []) {
        if (typeof native.caseId === 'string') caseIds.add(native.caseId);
      }
    }
    const advertisedCases = new Set(caseIds);
    caseIds.add('north-sound-20261021-00z');
    for (const caseId of caseIds) {
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
    for (const site of sites) await take(raobPaths.site(site.slug));
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
    for (const name of ['regions.json', 'regions-rrfs.json', 'regions-icon-eu.json']) {
      try {
        const regions = JSON.parse(readFileSync(join(root, name)));
        if (regions.regions.some(region => [region.caseId, ...(region.nativeModels ?? []).map(item => item.caseId)]
          .filter(Boolean).some(caseId => isPublishedCase(root, caseId)))) return true;
      } catch { /* Try other independently published model indexes. */ }
    }
    return isPublishedCase(root, 'north-sound-20261021-00z');
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

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: "string", default: "data" },
      from: { type: "string" },
      group: { type: "string" },
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
  if (!values.group || !values.from) throw new Error("usage: node scripts/seed-published.mjs --output data --from URL --group GROUP");

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

  let files;
  try {
    files = await collectGroup(values.group, { getBytes, sites, getCachedBytes: key => {
      try { return readFileSync(join(output, key)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    } });
  } catch (error) {
    if (groupHasLocal(output, values.group)) {
      console.warn(`WARN keeping cached ${values.group}: ${error.message}`);
      return;
    }
    throw error;
  }
  applyGroup(output, values.group, files);
  console.log(`Seeded ${files.size} object(s) for ${values.group} from ${from}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
