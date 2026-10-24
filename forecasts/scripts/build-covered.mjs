// Builds one model, leaving out launches the grid does not cover,
// then runs model-aware v2.1.0 soaring post-processing and 120-run (30-day) rolling history archival.
//
// meteo forecast build fails the whole model when any launch is outside the
// grid. That launch is removed and the build starts again. The first check
// happens on the first file, before profiles are written.
//
//   node scripts/build-covered.mjs --model hrdps-continental --sites sites.json --output data

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { postprocessPointForecast } from "../soaring/point-postprocess.mjs";
import { archiveModelRun, DEFAULT_MAX_ROLLING_RUNS } from "../verification/history.mjs";
import { configureModelFeeds, modelFeedEnvironment } from "./lib/model-feeds.mjs";
import { probeCycleReadiness } from "./check-readiness.mjs";
import { loadRrfsBuilder } from './lib/rrfs-builder.mjs';
import { validateRrfsProfile } from './validate-rrfs.mjs';
import { modelCoversSite } from './lib/model-coverage.mjs';

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

/**
 * Applies model-aware v2.1.0 soaring post-processing to all generated site profiles for `model`
 * and archives the run in the 120-run (30-day) rolling history directory.
 */
export function postprocessAndArchiveModelOutput(outputRoot, modelSlug, { maxRollingRuns = DEFAULT_MAX_ROLLING_RUNS } = {}) {
  const sitesDir = join(outputRoot, modelSlug, "sites");
  if (!existsSync(sitesDir)) return { postprocessedCount: 0, archived: null };

  const contextPath = join(outputRoot, "site-context.json");
  const contextDoc = existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : null;
  const elevations = contextDoc?.sites ?? {};

  let postprocessedCount = 0;
  for (const file of readdirSync(sitesDir)) {
    if (!file.endsWith(".json")) continue;
    const slug = file.slice(0, -5);
    const filePath = join(sitesDir, file);
    const rawDoc = JSON.parse(readFileSync(filePath, "utf8"));
    const launchElevationM = elevations[slug]?.elevation?.elevationM ?? null;
    const updatedDoc = postprocessPointForecast(rawDoc, { modelSlug, launchElevationM });
    writeFileSync(filePath, `${JSON.stringify(updatedDoc, null, 2)}\n`);
    postprocessedCount += 1;
  }

  const archived = archiveModelRun(outputRoot, modelSlug, {
    maxRollingRuns,
    pinnedRunKeys: ["20261021T000000Z", "20261021T060000Z"],
  });
  return { postprocessedCount, archived };
}

async function runMeteo(model, output, catalogue, referenceTime, maxSteps) {
  if (model === 'rrfs') {
    // The pinned package's CLI does not expose referenceTime. Use the same
    // builder directly so readiness and build cannot select different cycles.
    configureModelFeeds();
    const { build } = await loadRrfsBuilder();
    try {
      const built = await build({ sitesPath: catalogue, outputRoot: output, referenceTime, history: false, ...(maxSteps ? { maxSteps } : {}) });
      return { status: 0, text: built ? 'RRFS built' : 'RRFS already published' };
    } catch (error) {
      return { status: 1, text: `rrfs build failed: ${error.message}` };
    }
  }
  const args = ["exec", "meteo", "forecast", "build", "--model", model, "--sites", catalogue, "--output", output, "--no-history"];
  if (maxSteps) args.push('--max-steps', String(maxSteps));
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, { env: modelFeedEnvironment() });
    let text = "";
    const take = (chunk) => {
      const line = chunk.toString();
      text += line;
      process.stdout.write(line);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", error => resolve({ status: 1, text: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, text }));
  });
}

/** Keep last-good model files intact until every profile is built and checked. */
export async function stageModelBuild(outputRoot, model, build, finish = postprocessAndArchiveModelOutput) {
  mkdirSync(outputRoot, { recursive: true });
  const staging = mkdtempSync(join(outputRoot, `.build-${model}-`));
  const current = join(outputRoot, model);
  const backup = join(staging, 'previous');
  try {
    const context = join(outputRoot, 'site-context.json');
    if (existsSync(context)) cpSync(context, join(staging, 'site-context.json'));
    const result = await build(staging);
    const manifestPath = join(staging, model, 'manifest.json');
    if (!existsSync(manifestPath)) {
      if (!existsSync(join(current, 'manifest.json'))) throw new Error(`${model}: no complete output or last-good manifest`);
      return { result, changed: false, post: { postprocessedCount: 0, archived: null } };
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.model !== model || !manifest.sites?.length || !Number.isFinite(Date.parse(manifest.referenceTime))) {
      throw new Error(`${model}: invalid staged manifest`);
    }
    for (const site of manifest.sites) {
      const document = JSON.parse(readFileSync(join(staging, model, 'sites', `${site.slug}.json`), 'utf8'));
      if (document.run?.referenceTime !== manifest.referenceTime) throw new Error(`${model}: ${site.slug} run differs from manifest`);
    }
    const oldManifest = join(current, 'manifest.json');
    if (existsSync(oldManifest) && Date.parse(JSON.parse(readFileSync(oldManifest, 'utf8')).referenceTime) > Date.parse(manifest.referenceTime)) {
      throw new Error(`${model}: refusing to replace a newer last-good run with ${manifest.referenceTime}`);
    }
    const post = finish(staging, model);
    if (model === 'rrfs') {
      for (const site of manifest.sites) {
        const document = JSON.parse(readFileSync(join(staging, model, 'sites', `${site.slug}.json`), 'utf8'));
        validateRrfsProfile(document, manifest.referenceTime, site.slug, { horizon: manifest.forecastHours });
      }
    }
    if (existsSync(current)) renameSync(current, backup);
    try { renameSync(join(staging, model), current); }
    catch (error) {
      if (existsSync(backup)) renameSync(backup, current);
      throw error;
    }
    // Archive against the real history root so retention includes previous runs.
    if (post.archived) post.archived = archiveModelRun(outputRoot, model, {
      pinnedRunKeys: ['20261021T000000Z', '20261021T060000Z'],
    });
    return { result, changed: true, post };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      sites: { type: "string", default: "sites.json" },
      output: { type: "string", default: "data" },
      'reference-time': { type: 'string' },
      'max-steps': { type: 'string' },
    },
  });
  if (!values.model) throw new Error("usage: node scripts/build-covered.mjs --model SLUG --sites sites.json --output data");
  if (values.model === 'icon-eu') {
    const args = [fileURLToPath(new URL('./build-icon.mjs', import.meta.url)), '--sites', values.sites, '--output', values.output];
    if (values['reference-time']) args.push('--reference-time', values['reference-time']);
    if (values['max-steps']) throw new Error('Use build-icon.mjs --hours for a separate trial dataset; production ICON requires all 78 hours');
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`ICON build exited ${code}`)));
    });
    return;
  }
  if (values['reference-time'] && values.model !== 'rrfs') throw new Error('--reference-time is supported for rrfs');
  const maxSteps = values['max-steps'] === undefined ? undefined : Number(values['max-steps']);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) throw new Error('--max-steps must be a positive integer');
  configureModelFeeds();
  let referenceTime = values['reference-time'];
  if (values.model === 'rrfs' && !referenceTime) {
    const readiness = await probeCycleReadiness('rrfs');
    if (!readiness.ready) throw new Error('RRFS has no complete pressure and surface run; keeping last-good output');
    referenceTime = readiness.selectedCycle.referenceTime;
    console.log(`rrfs: selected ${referenceTime}${readiness.fallback ? ' (previous complete cycle)' : ''}`);
  }
  const catalogue = JSON.parse(readFileSync(values.sites, "utf8"));
  if (!Array.isArray(catalogue.sites)) throw new Error(`${values.sites} has no sites`);
  const directory = mkdtempSync(join(tmpdir(), "windgrams-sites-"));
  try {
    const { result, post, changed } = await stageModelBuild(resolve(values.output), values.model, staging =>
      buildCovered(values.model, catalogue.sites.filter(site => modelCoversSite(values.model, site)), sites => {
        const path = join(directory, 'sites.json');
        writeFileSync(path, JSON.stringify({ ...catalogue, sites }));
        return runMeteo(values.model, staging, path, referenceTime, maxSteps);
      }));
    if (result.dropped.length > 0) console.log(`${values.model}: built ${result.kept.length}, skipped ${result.dropped.join(", ")}`);
    console.log(`${values.model}: ${changed ? `post-processed ${post.postprocessedCount} site profile(s) (contract v2.1.0)` : 'kept current last-good output'}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
