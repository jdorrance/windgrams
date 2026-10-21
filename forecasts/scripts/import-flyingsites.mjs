// Builds forecasts/sites.json and web/src/data/launches.json from the US
// paragliding takeoffs in the sibling flyingsites catalog.
//
// flyingsites has no state field, so a launch is kept when its point falls
// inside one of the state outlines listed in STATE_ORDER.
//
// Usage (from forecasts/):
//   node scripts/import-flyingsites.mjs
// FLYINGSITES_US overrides the path to us.geojson.json.

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
  if (chosen.length === 0) return { facingDeg: 0, windArcHalfWidthDeg: 45 };
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
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
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
      facingDeg: site.facingDeg,
      windArcHalfWidthDeg: site.windArcHalfWidthDeg,
      windMinMph: 5,
      windMaxMph: 15,
      gustMaxMph: 20,
      region: site.region,
      notes: site.notes,
    };
  }

  return {
    sitesFile: { schemaVersion: 2, sites },
    launchesFile: { schemaVersion: 1, launches },
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const usPath = process.env.FLYINGSITES_US ?? resolve(HERE, "../../../flyingsites/data/us.geojson.json");
  const states = JSON.parse(readFileSync(resolve(HERE, "data/us-states.json"), "utf-8")).states;
  const features = JSON.parse(readFileSync(usPath, "utf-8")).features ?? [];
  const { sitesFile, launchesFile } = buildCatalog(features, states);
  const sitesPath = resolve(HERE, "../sites.json");
  const launchesPath = resolve(HERE, "../../web/src/data/launches.json");
  writeJson(sitesPath, sitesFile);
  writeJson(launchesPath, launchesFile);
  const counts = Object.fromEntries(STATE_ORDER.map((code) => [code, 0]));
  for (const site of sitesFile.sites) {
    const code = site.slug.slice(0, 2).toUpperCase();
    if (code in counts) counts[code] += 1;
  }
  console.log(`✓ ${sitesFile.sites.length} launches from ${usPath}`);
  for (const code of STATE_ORDER) console.log(`  ${code} ${states[code].name}: ${counts[code]}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
