// Merges source launches into forecasts/sites.json and web/src/data/launches.json.
// Existing launch edits and other countries survive each import.
//
// flyingsites has no state field, so a launch is kept when its point falls
// inside one of the state outlines listed in STATE_ORDER.
//
// Usage (from forecasts/):
//   node scripts/import-flyingsites.mjs
//   node scripts/import-flyingsites.mjs --country=am
//   node scripts/import-flyingsites.mjs --country=us
// FLYINGSITES_US overrides the path to us.geojson.json.
// FLYINGSITES_AM overrides the reviewed Armenian catalogue, not a raw API dump.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_ORDER = ["VA", "WA", "MD", "NC", "OR"];
const DIRS = [
  ["N", 0],
  ["NE", 45],
  ["E", 90],
  ["SE", 135],
  ["S", 180],
  ["SW", 225],
  ["W", 270],
  ["NW", 315],
];

const round5 = (value) => Math.round(value * 1e5) / 1e5;

export function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > lat !== yj > lat;
    if (crosses && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, coordinates) {
  if (!pointInRing(lon, lat, coordinates[0])) return false;
  for (let hole = 1; hole < coordinates.length; hole += 1) {
    if (pointInRing(lon, lat, coordinates[hole])) return false;
  }
  return true;
}

export function pointInGeometry(lon, lat, geometry) {
  if (geometry.type === "Polygon") return pointInPolygon(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((polygon) => pointInPolygon(lon, lat, polygon));
  return false;
}

export function timeZoneFor(code, longitude) {
  if (code === "AM") return "Asia/Yerevan";
  if (code === "VA" || code === "MD" || code === "NC") return "America/New_York";
  if (code === "OR" && longitude > -117.25) return "America/Boise";
  return "America/Los_Angeles";
}

function angularDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function circularMean(degrees) {
  let x = 0;
  let y = 0;
  for (const deg of degrees) {
    const rad = (deg * Math.PI) / 180;
    x += Math.cos(rad);
    y += Math.sin(rad);
  }
  if (x === 0 && y === 0) return 0;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Facing and wind-window half-width from the compass flags (0 / 1 / 2). */
export function windFromFlags(properties) {
  const rated = DIRS.map(([key, deg]) => ({ deg, rank: Number(properties[key] ?? 0) })).filter((d) => d.rank > 0);
  const preferred = rated.filter((d) => d.rank === 2);
  const chosen = preferred.length > 0 ? preferred : rated;
  if (chosen.length === 0) return { facingDeg: null, windArcHalfWidthDeg: null };
  const facing = (Math.round((circularMean(chosen.map((d) => d.deg)) + 360) % 360) + 360) % 360;
  const spread = Math.max(...rated.map((d) => angularDistance(facing, d.deg)));
  return { facingDeg: facing === 360 ? 0 : facing, windArcHalfWidthDeg: Math.round(Math.min(90, Math.max(20, spread))) };
}

function coordSuffix(latitude, longitude) {
  const ns = latitude >= 0 ? "n" : "s";
  const ew = longitude >= 0 ? "e" : "w";
  return `${Math.round(Math.abs(latitude) * 100)}${ns}${Math.round(Math.abs(longitude) * 100)}${ew}`;
}

function notesFrom(properties) {
  const text = typeof properties.takeoff_description === "string" ? properties.takeoff_description : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}

export function buildCatalog(features, states) {
  const found = [];
  for (const feature of features) {
    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== "Point" || !Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [longitude, latitude] = coordinates;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const matches = STATE_ORDER.filter((code) => pointInGeometry(longitude, latitude, states[code].geometry));
    if (matches.length === 0) continue;
    const code = matches[0];
    const properties = feature.properties ?? {};
    const name = String(properties.name ?? "").trim().replace(/\s+/g, " ") || "Unnamed";
    found.push({
      code,
      name: name.slice(0, 80),
      latitude: round5(latitude),
      longitude: round5(longitude),
      timeZone: timeZoneFor(code, longitude),
      region: states[code].name,
      ...windFromFlags(properties),
      notes: notesFrom(properties),
    });
  }

  found.sort((a, b) => STATE_ORDER.indexOf(a.code) - STATE_ORDER.indexOf(b.code) || a.name.localeCompare(b.name) || a.latitude - b.latitude);

  const used = new Set();
  const sites = [];
  const launches = {};
  for (const site of found) {
    let slug = `${site.code.toLowerCase()}-${slugify(site.name) || "site"}`;
    if (used.has(slug)) slug = `${slug}-${coordSuffix(site.latitude, site.longitude)}`;
    used.add(slug);
    sites.push({
      slug,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      timeZone: site.timeZone,
    });
    launches[slug] = {
      countryCode: "US",
      facingDeg: site.facingDeg,
      windArcHalfWidthDeg: site.windArcHalfWidthDeg,
      windMinMph: null,
      windMaxMph: null,
      gustMaxMph: null,
      region: site.region,
      notes: site.notes,
    };
  }

  return {
    sitesFile: { schemaVersion: 2, sites },
    launchesFile: { schemaVersion: 1, launches },
  };
}

/** Import reviewed country records. Explicit slugs survive source-name changes. */
export function buildCountryCatalog(catalog) {
  const { countryCode, region, timeZone } = catalog;
  if (!/^[A-Z]{2}$/.test(countryCode) || !region || !timeZone) throw new Error("Country, region and time zone are required");
  new Intl.DateTimeFormat("en", { timeZone }).format();
  const sites = [];
  const launches = {};
  for (const record of catalog.launches ?? []) {
    const { slug, name, latitude, longitude, facingDeg = null, windArcHalfWidthDeg = null, notes = "", source } = record;
    if (!new RegExp(`^${countryCode.toLowerCase()}-[a-z0-9]+(?:-[a-z0-9]+)*$`).test(slug) || Object.hasOwn(launches, slug)) {
      throw new Error(`Invalid or duplicate launch slug: ${slug}`);
    }
    if (!name || name.length > 80 || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      throw new Error(`Invalid launch location: ${slug}`);
    }
    if ((facingDeg === null) !== (windArcHalfWidthDeg === null) || (facingDeg !== null && (!Number.isFinite(facingDeg) || facingDeg < 0 || facingDeg >= 360 || !Number.isFinite(windArcHalfWidthDeg) || windArcHalfWidthDeg < 0 || windArcHalfWidthDeg > 180))) {
      throw new Error(`Invalid launch directions: ${slug}`);
    }
    if (!source?.name || !/^https:\/\//.test(source.url) || !source.license || !/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt)) {
      throw new Error(`Launch attribution required: ${slug}`);
    }
    sites.push({ slug, name, latitude, longitude, timeZone });
    launches[slug] = {
      countryCode,
      facingDeg, windArcHalfWidthDeg,
      windMinMph: null, windMaxMph: null, gustMaxMph: null,
      region, notes, source,
    };
  }
  return { sitesFile: { schemaVersion: 2, sites }, launchesFile: { schemaVersion: 1, launches } };
}

/** Merge new entries and metadata; retained values include deliberate manual edits. */
export function mergeCatalogs(existing, incoming) {
  const sites = new Map((existing.sitesFile?.sites ?? []).map((site) => [site.slug, site]));
  for (const site of incoming.sitesFile.sites) sites.set(site.slug, { ...site, ...sites.get(site.slug) });
  const launches = { ...existing.launchesFile?.launches };
  for (const [slug, launch] of Object.entries(incoming.launchesFile.launches)) launches[slug] = { ...launch, ...launches[slug] };
  return {
    sitesFile: { ...existing.sitesFile, schemaVersion: 2, sites: [...sites.values()] },
    launchesFile: { ...existing.launchesFile, schemaVersion: 1, launches },
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const countries = process.argv.slice(2).length ? process.argv.slice(2).map((arg) => {
    if (!/^--country=(am|us)$/.test(arg)) throw new Error(`Unknown option: ${arg}. Use --country=am or --country=us.`);
    return arg.slice("--country=".length);
  }) : ["us", "am"];
  const sitesPath = resolve(HERE, "../sites.json");
  const launchesPath = resolve(HERE, "../../web/src/data/launches.json");
  let catalog = {
    sitesFile: JSON.parse(readFileSync(sitesPath, "utf-8")),
    launchesFile: JSON.parse(readFileSync(launchesPath, "utf-8")),
  };
  for (const country of new Set(countries)) {
    if (country === "us") {
      const usPath = process.env.FLYINGSITES_US ?? resolve(HERE, "../../../flyingsites/data/us.geojson.json");
      const states = JSON.parse(readFileSync(resolve(HERE, "data/us-states.json"), "utf-8")).states;
      const features = JSON.parse(readFileSync(usPath, "utf-8")).features ?? [];
      catalog = mergeCatalogs(catalog, buildCatalog(features, states));
    } else {
      const amPath = process.env.FLYINGSITES_AM ?? resolve(HERE, "data/armenia-launches.json");
      catalog = mergeCatalogs(catalog, buildCountryCatalog(JSON.parse(readFileSync(amPath, "utf-8"))));
    }
  }
  const { sitesFile, launchesFile } = catalog;
  writeJson(sitesPath, sitesFile);
  writeJson(launchesPath, launchesFile);
  const counts = Object.fromEntries([...STATE_ORDER, "AM"].map((code) => [code, 0]));
  for (const site of sitesFile.sites) {
    const code = site.slug.slice(0, 2).toUpperCase();
    if (code in counts) counts[code] += 1;
  }
  console.log(`✓ ${sitesFile.sites.length} launches; merged ${[...new Set(countries)].join(", ")}; existing edits retained`);
  for (const [code, count] of Object.entries(counts)) console.log(`  ${code}: ${count}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
