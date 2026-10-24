// Writes data/runs.json from the manifests on disk.
//
// `meteo forecast runs-index` reads the live dataset (METEO_DATA_BASE), which
// during a publish is still the previous deploy. The pages read each model's
// own manifest, and this file is the same index shaped from the tree we are
// about to upload.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cataloguedModelSlugs } from "@azohra/meteo.forecast";
import { parseRunsIndexJson } from "@azohra/meteo.briefing/contract";

export function runsIndexFromDisk(output, slugs = [...new Set([...cataloguedModelSlugs(), 'icon-eu'])]) {
  const runs = {};
  for (const slug of slugs) {
    const path = join(output, slug, "manifest.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (typeof manifest.referenceTime !== "string" || typeof manifest.generatedAt !== "string") continue;
    runs[manifest.model ?? slug] = { referenceTime: manifest.referenceTime, generatedAt: manifest.generatedAt };
  }
  return { schemaVersion: 1, runs };
}

function main() {
  const { values } = parseArgs({ options: { output: { type: "string", default: "data" } } });
  const output = resolve(values.output);
  const document = runsIndexFromDisk(output);
  const text = `${JSON.stringify(document, null, 1)}\n`;
  if (parseRunsIndexJson(text) === null) throw new Error("runs.json fails the contract guard");
  const path = join(output, "runs.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`Wrote ${path} (${Object.keys(document.runs).length} model(s))`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}
