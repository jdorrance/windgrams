// Publishes sites.json to the dataset store.
//
// The engine never writes sites.json: it is the one root file the operator
// uploads, unchanged. This script validates it, uploads it, and reads it back
// to confirm the bytes match.
//
// The store comes from WINDGRAMS_STORE (default "file", which needs
// WINDGRAMS_DATA_DIR). Register another provider with registerStoreProvider.
//
// Usage: node scripts/publish-sites.mjs [path/to/sites.json]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSites } from "@azohra/meteo.forecast";
import { storeFromEnv } from "./lib/store.mjs";

let store;
try {
  store = storeFromEnv();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const path = resolve(process.argv[2] ?? "sites.json");
const bytes = readFileSync(path);
const sites = parseSites(bytes.toString("utf-8"), path); // throws on an invalid catalogue

await store.put("sites.json", bytes);
const echoed = await store.get("sites.json");
if (echoed === null || !echoed.equals(bytes)) {
  console.error("✗ Read-back of sites.json does not match what was uploaded");
  process.exit(1);
}

console.log(`✓ Published sites.json to ${store.name}/sites.json (${sites.length} launch(es))`);
