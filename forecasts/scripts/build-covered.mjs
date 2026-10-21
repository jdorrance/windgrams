// Builds one model, leaving out launches the grid does not cover.
//
// meteo forecast build fails the whole model when any launch is outside the
// grid. That launch is removed and the build starts again. The first check
// happens on the first file, before profiles are written.
//
//   node scripts/build-covered.mjs --model hrdps-continental --sites sites.json --output data

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const COORDINATE = /\(([-0-9.]+),\s*([-0-9.]+)\) is outside the model grid/;
const NAMED = /build failed:\s+(.+?) is outside the model grid/;

/** The launch named in an "outside the model grid" error, or null. */
export function launchOutsideGrid(text, sites) {
  const coordinate = text.match(COORDINATE);
  if (coordinate) {
    const latitude = Number(coordinate[1]);
    const longitude = Number(coordinate[2]);
    return sites.find((site) => Math.abs(site.latitude - latitude) < 1e-4 && Math.abs(site.longitude - longitude) < 1e-4) ?? null;
  }
  const named = text.match(NAMED);
  if (!named) return null;
  return sites.find((site) => site.name === named[1]) ?? null;
}

/**
 * Runs `run` with the launches it can cover. `run` returns `{ status, text }`
 * and receives the launches still included.
 */
export async function buildCovered(model, sites, run, log = console.log) {
  let remaining = sites.slice();
  const dropped = [];
  for (;;) {
    if (remaining.length === 0) throw new Error(`${model}: every launch is outside the model grid`);
    const result = await run(remaining);
    if (result.status === 0) return { dropped, kept: remaining };
    const site = launchOutsideGrid(result.text, remaining);
    if (!site) throw new Error(result.text.trim() || `${model} build failed`);
    remaining = remaining.filter((item) => item.slug !== site.slug);
    dropped.push(site.slug);
    log(`${model}: skipping ${site.slug} (${site.name}), outside the model grid`);
  }
}

function runMeteo(model, output, catalogue) {
  const args = ["exec", "meteo", "forecast", "build", "--model", model, "--sites", catalogue, "--output", output, "--no-history"];
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, { env: process.env });
    let text = "";
    const take = (chunk) => {
      const line = chunk.toString();
      text += line;
      process.stdout.write(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (status) => resolve({ status: status ?? 1, text }));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      sites: { type: "string", default: "sites.json" },
      output: { type: "string", default: "data" },
    },
  });
  if (!values.model) throw new Error("usage: node scripts/build-covered.mjs --model SLUG --sites sites.json --output data");
  const catalogue = JSON.parse(readFileSync(values.sites, "utf8"));
  if (!Array.isArray(catalogue.sites)) throw new Error(`${values.sites} has no sites`);
  const directory = mkdtempSync(join(tmpdir(), "windgrams-sites-"));
  const result = await buildCovered(values.model, catalogue.sites, (sites) => {
    const path = join(directory, "sites.json");
    writeFileSync(path, JSON.stringify({ ...catalogue, sites }));
    return runMeteo(values.model, values.output, path);
  });
  if (result.dropped.length > 0) console.log(`${values.model}: built ${result.kept.length}, skipped ${result.dropped.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
