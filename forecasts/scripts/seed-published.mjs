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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { paths as ecmwfPaths } from "./lib/ecmwf.mjs";
import { retryingFetch } from "./lib/http.mjs";
import { paths as nwsPaths } from "./lib/nws.mjs";
import { paths as raobPaths } from "./lib/raob.mjs";

/** Model slugs for each runner. Observations and terrain publish no model. */
export const GROUPS = {
  "noaa-cloud": ["hrrr-conus", "gfs"],
  rrfs: ["rrfs"],
  eccc: ["hrdps-continental", "rdps", "gdps", "geps"],
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
export async function collectGroup(group, { get, sites = [] }) {
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`unknown group "${group}". Known: ${groupNames().join(", ")}`);
  const files = new Map();
  const take = async (key) => {
    const document = await get(key);
    if (document === null) return null;
    files.set(key, document);
    return document;
  };

  for (const model of GROUPS[group]) {
    const manifest = await take(`${model}/manifest.json`);
    if (!manifest) continue;
    for (const slug of slugsOf(manifest)) await take(`${model}/sites/${slug}.json`);
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
  for (const [key, document] of files) {
    const path = join(output, key);
    mkdirSync(dirname(path), { recursive: true });
    const text = typeof document === "string" ? document : `${JSON.stringify(document)}\n`;
    writeFileSync(path, text);
  }
}

function rootUrl(from) {
  return from.replace(/\/+$/, "");
}

async function readJson(getBytes, key) {
  const bytes = await getBytes(key);
  if (bytes === null) return null;
  const text = bytes.toString("utf8").trimStart();
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
      list: { type: "boolean", default: false },
    },
  });
  if (values.list) {
    if (!values.group || !Object.hasOwn(GROUPS, values.group)) {
      console.error(`--list needs a group: ${groupNames().join(", ")}`);
      process.exit(1);
    }
    process.stdout.write(`${GROUPS[values.group].join(" ")}\n`);
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
    files = await collectGroup(values.group, { get: (key) => readJson(getBytes, key), sites });
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
