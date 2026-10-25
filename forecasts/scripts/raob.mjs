// Fetches the latest weather-balloon soundings for each launch's nearest
// upper-air station and, optionally, publishes them to the dataset store.
//
//   raob/sites/<slug>.json   the station's two latest soundings
//
// Usage:
//   node scripts/raob.mjs [--sites sites.json] [--output data] [--publish] [--notice]
//
// A launch with no station within 300 km is skipped. --notice prints a one-line
// summary per station as a GitHub Actions notice for live smoke checks.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseSites } from "@azohra/meteo.forecast";
import { storeFromEnv } from "./lib/store.mjs";
import { buildSiteDocument, createClient, fetchStationSoundings, nearestStation, paths, LOOKBACK_HOURS, SCHEMA_VERSION, SOURCE } from "./lib/raob.mjs";

const { values: args } = parseArgs({
  options: {
    sites: { type: "string", default: "sites.json" },
    output: { type: "string", default: "data" },
    publish: { type: "boolean", default: false },
    notice: { type: "boolean", default: false },
  },
});

const store = args.publish ? storeFromEnv() : null;
const sitesPath = resolve(args.sites);
const sites = parseSites(readFileSync(sitesPath, "utf-8"), sitesPath);
const getJson = createClient();
const now = Date.now();
const warn = (message) => console.warn(`WARN ${message}`);

async function write(key, document) {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const file = join(resolve(args.output), key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  if (store) await store.put(key, bytes);
}

const byStation = new Map();
for (const site of sites) {
  const station = nearestStation(site);
  if (!station) {
    console.log(`– ${site.slug}: no upper-air station within 300 km`);
    continue;
  }
  if (!byStation.has(station.id)) byStation.set(station.id, { station, sites: [] });
  byStation.get(station.id).sites.push({ site, station });
}

let failed = 0;
let requestFailures = 0;
const entries = [];
for (const { station, sites: stationSites } of byStation.values()) {
  const tried = [];
  const errors = [];
  const soundings = await fetchStationSoundings(station, getJson, { now, warn,
    onError: error => { requestFailures += 1; errors.push(error.message); }, log: (m) => (console.log(m), tried.push(m)) });
  for (const { site } of stationSites) entries.push({ slug: site.slug, station: station.id,
    ...(errors.length ? { ok: false, error: errors.join('; ') } : { ok: true, absent: soundings.length === 0 }) });
  if (soundings.length === 0) {
    failed += 1;
    console.error(`✗ ${station.id}: no sounding found in the last ${LOOKBACK_HOURS} hours`);
    // Stores expose put/get, so overwrite an old remote flight with an empty document.
    if (!errors.length) for (const { site, station: withDistance } of stationSites) {
      await write(paths.site(site.slug), buildSiteDocument({ site, station: withDistance, soundings, now }));
    }
    continue;
  }
  const summary = soundings.map((s) => `${s.validAt} ${s.levels.length} levels (${s.levels[0].heightM} m, ${s.levels[0].temperatureC}/${s.levels[0].dewPointC} °C, top ${s.levels.at(-1).pressureHpa} hPa)`).join("; ");
  console.log(`✓ ${station.id}: ${summary}`);
  if (args.notice) {
    const first = soundings[0].levels;
    const withDew = first.filter((l) => l.dewPointC !== null).length;
    const withWind = first.filter((l) => l.windSpeedMps !== null).length;
    console.log(`::notice title=${station.id} balloon::${summary}; dew point on ${withDew}, wind on ${withWind} levels. Tried: ${tried.join(" | ")}`);
  }
  for (const { site, station: withDistance } of stationSites) {
    await write(paths.site(site.slug), buildSiteDocument({ site, station: withDistance, soundings, now }));
  }
}
await write(paths.manifest(), { schemaVersion: SCHEMA_VERSION, source: SOURCE, generatedAt: new Date(now).toISOString(), sites: entries });
// A station with no flight in the archive is normal. Those launches have no
// balloon chart. It must not fail the publish.
if (failed > 0) console.warn(`WARN ${failed} station(s) had no sounding in the last ${LOOKBACK_HOURS} hours`);
if (requestFailures > 0) process.exitCode = 1;
