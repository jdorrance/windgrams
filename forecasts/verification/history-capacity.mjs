// Offline storage rehearsal. Shifted runs are synthetic workload, never forecast-verification evidence.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { MODELS } from '@windgrams/providers/registry';
import { archiveModelRun, archivedModelRuns, copyIssuedHistoryTree, mergeHistoryArchives } from './issued-history.mjs';
import { OPERATOR_HISTORY_POLICY } from './history-policy.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const runKey = date => date.toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
const timed = fn => { const start = performance.now(), result = fn(); return { elapsedMs: Math.round(performance.now() - start), result }; };

function inventory(root) {
  let bytes = 0, expandedBytes = 0, allocatedBytes = 0, files = 0;
  const digest = createHash('sha256');
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      if (entry.isDirectory()) visit(path, `${name}/`);
      else if (entry.isFile()) { const stat = statSync(path); const content = readFileSync(path); bytes += stat.size; expandedBytes += name.endsWith('.json.gz') ? content.readUInt32LE(content.length - 4) : stat.size; allocatedBytes += stat.blocks * 512; files++; digest.update(`${name}\0${sha(content)}\n`); }
      else throw new Error(`Unsupported rehearsal file: ${path}`);
    }
  }
  visit(root);
  return { bytes, expandedBytes, allocatedBytes, files, treeSha256: digest.digest('hex') };
}

function synthesize({ source, output, model }) {
  const descriptor = MODELS.find(entry => entry.id === model), manifest = json(join(source, model, 'manifest.json'));
  const profiles = manifest.sites.map(({ slug }) => {
    const path = join(source, model, 'sites', `${slug}.json`), bytes = readFileSync(path);
    return { slug, sha256: sha(bytes), bytes: bytes.length, document: JSON.parse(bytes) };
  });
  const target = join(output, model); mkdirSync(join(target, 'sites'), { recursive: true });
  const end = new Date('2026-10-26T00:00:00Z'), runs = [];
  for (let day = 0; runs.length < 123; day++) for (const hour of [...descriptor.cyclesUtc].reverse()) {
    const date = new Date(end.getTime() - day * 86400000); date.setUTCHours(hour);
    if (date <= end) runs.push(date);
    if (runs.length === 123) break;
  }
  runs.reverse();
  const pins = [runKey(runs[0]), runKey(runs[1])], policy = { ...OPERATOR_HISTORY_POLICY, pinnedRunKeys: pins };
  let archiveMs = 0, sourceBytes = 0, revisions = 0;
  const firstIssued = [];
  for (const [index, date] of runs.entries()) {
    const referenceTime = date.toISOString(), delta = date.getTime() - Date.parse(manifest.referenceTime);
    const shifted = { ...manifest, referenceTime, generatedAt: new Date(date.getTime() + 3600000).toISOString(), diagnosticBuild: { workload: 'synthetic-capacity-only', revision: 0 } };
    save(join(target, 'manifest.json'), shifted);
    for (const { slug, document } of profiles) {
      const hours = document.hours.map(hour => ({ ...hour, validAt: new Date(Date.parse(hour.validAt) + delta).toISOString() }));
      const bytes = JSON.stringify({ ...document, run: { ...document.run, referenceTime, generatedAt: shifted.generatedAt }, hours }) + '\n';
      sourceBytes += Buffer.byteLength(bytes); writeFileSync(join(target, 'sites', `${slug}.json`), bytes);
    }
    const archived = timed(() => archiveModelRun(output, model, policy)); archiveMs += archived.elapsedMs; revisions++;
    firstIssued.push({ runKey: archived.result.runKey, revisionId: archived.result.revisionId });
    // One repair per ten runs, preserving every first issue and source weather.
    if (index % 10 === 0) {
      shifted.diagnosticBuild.revision = 1; save(join(target, 'manifest.json'), shifted);
      const repair = timed(() => archiveModelRun(output, model, policy)); archiveMs += repair.elapsedMs; revisions++;
    }
  }
  const retained = readdirSync(join(output, 'history', model)).filter(name => /^\d{8}T\d{6}Z$/.test(name)).sort();
  if (retained.length !== 122 || pins.some(pin => !retained.includes(pin))) throw new Error(`${model}: retention rehearsal failed`);
  return { model, sites: profiles.length, cyclesUtc: descriptor.cyclesUtc, generatedRuns: runs.length, retainedRuns: retained.length,
    retainedUtcDays: new Set(retained.map(key => key.slice(0, 8))).size, pinnedRunKeys: pins, generatedRevisions: revisions,
    sourceBytes, archiveMs, firstIssued: firstIssued.filter(issue => retained.includes(issue.runKey)),
    sourceManifest: { sha256: sha(readFileSync(join(source, model, 'manifest.json'))), referenceTime: manifest.referenceTime },
    sourceMethods: [...new Set(profiles.map(({ document }) => document.soaringMeta?.contractVersion ?? 'unrecorded'))],
    sourceProfiles: profiles.map(({ document, ...profile }) => profile) };
}

export async function rehearseHistoryCapacity({ source, output }) {
  if (existsSync(output)) throw new Error('Rehearsal output must not already exist');
  const space = statfsSync(resolve(output, '..')), availableBytes = space.bavail * space.bsize;
  if (availableBytes < 40 * 1024 ** 3) throw new Error('Rehearsal requires 40 GiB of scratch space; source archives are never modified');
  mkdirSync(output, { recursive: true });
  const data = join(output, 'source');
  const report = { schemaVersion: 1, kind: 'synthetic-storage-rehearsal-not-forecast-evidence', startedAt: new Date().toISOString(),
    assumptions: { source, historyPolicy: OPERATOR_HISTORY_POLICY, repairEveryRuns: 10, extraOldPins: 2,
      weather: 'Original published weather reused; initialization and valid times shifted together. Weather is not historical evidence.',
      cadence: 'Configured native model cycles; 120 rolling runs plus two older pins. Twice-daily models span 60 days.',
      storage: 'Real files and gzip/tar round trips. Report both a four-copy logical baseline and a separate production bound using immutable hard links; never assume APFS clone savings.' },
    host: { platform: process.platform, node: process.version, availableBytes }, models: [] };
  const start = performance.now(), queue = MODELS.map(model => model.id);
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length) {
      const model = queue.shift();
      const result = await new Promise((accept, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { source, output: data, model } });
        worker.once('message', accept); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`Rehearsal worker failed: ${model}`)); });
      });
      report.models.push(result); save(join(output, 'progress.json'), report);
      console.log(`${model}: ${result.retainedRuns} runs, ${result.sites} sites, archive ${(result.archiveMs / 1000).toFixed(1)}s`);
    }
  }));
  report.synthesisMs = Math.round(performance.now() - start);
  report.models.sort((a, b) => a.model.localeCompare(b.model));
  return measureHistoryCapacity({ data, output, report });
}

/** Recheck a materialized synthetic workload with the current storage implementation. */
export function measureHistoryCapacity({ data, output, report }) {
  const restored = join(output, 'restored'), merged = join(output, 'merged'), candidate = join(output, 'candidate');
  report.history = inventory(join(data, 'history')); report.dataset = inventory(data);
  const tar = join(output, 'cache.tar.zst');
  report.pack = timed(() => execFileSync('tar', ['--zstd', '-cf', tar, '-C', data, '.'])); delete report.pack.result;
  report.cacheBytes = statSync(tar).size;
  mkdirSync(restored); report.restore = timed(() => execFileSync('tar', ['-xf', tar, '-C', restored])); delete report.restore.result;
  report.restored = inventory(restored);
  if (report.dataset.treeSha256 !== report.restored.treeSha256) throw new Error('Cache restore changed issued bytes');
  mkdirSync(merged);
  const merge = () => report.models.map(({ model, pinnedRunKeys }) => mergeHistoryArchives(restored, merged, model, { ...OPERATOR_HISTORY_POLICY, pinnedRunKeys }));
  report.coldMerge = timed(merge);
  report.warmMerge = timed(merge);
  report.merged = inventory(join(merged, 'history'));
  if (report.history.treeSha256 !== report.merged.treeSha256) throw new Error('Archive merge changed issued bytes');
  report.stage = timed(() => {
    cpSync(restored, candidate, { recursive: true, filter: path => relative(restored, path).split('/')[0] !== 'history' });
    copyIssuedHistoryTree(join(restored, 'history'), join(candidate, 'history'));
  }); delete report.stage.result;
  report.staged = inventory(candidate);
  if (report.dataset.treeSha256 !== report.staged.treeSha256) throw new Error('Publication staging changed issued bytes');
  report.firstIssued = timed(() => report.models.map(({ model, firstIssued }) => {
    const selected = archivedModelRuns(merged, model, { maxRuns: 120 });
    if (selected.some(run => firstIssued.find(issue => issue.runKey === run.runKey)?.revisionId !== run.revisionId)) throw new Error('First-issued revision changed');
    return { model, selectedRuns: selected.length, verified: true };
  }));
  report.modelStorage = report.models.map(({ model }) => ({ model, ...inventory(join(data, 'history', model)) }));
  report.budgets = { cacheLimitBytes: 10_000_000_000,
    cacheIncompressibleUpperBoundBytes: report.dataset.bytes + report.dataset.files * 1024,
    publicationHistoryLogicalPeakBytes: 4 * report.history.bytes,
    publicationHistorySharedPeakBytes: 3 * report.history.allocatedBytes,
    note: 'Logical peak allows retained dataset, candidate, and two provider artifact sets. Shared peak conservatively omits the candidate revision duplicate; add live products, one provider download, dependencies and reserve. Synthetic weather may overcompress across runs: use the incompressible tar upper bound for cache budgeting, not the measured tar ratio.' };
  report.completedAt = new Date().toISOString();
  save(join(output, 'report.json'), report);
  return report;
}

if (!isMainThread) parentPort.postMessage(synthesize(workerData));
else if (import.meta.main) {
  const { values } = parseArgs({ options: { source: { type: 'string', default: 'forecasts/data' }, output: { type: 'string' }, measure: { type: 'string' } } });
  if (!values.output) throw new Error('Usage: node forecasts/verification/history-capacity.mjs --source DATA --output NEW_SCRATCH_DIRECTORY');
  if (values.measure) {
    const source = resolve(values.measure), output = resolve(values.output), report = json(join(source, 'progress.json'));
    if (report.kind !== 'synthetic-storage-rehearsal-not-forecast-evidence' || report.models.length !== MODELS.length) throw new Error('Measurement requires a complete synthetic workload');
    if (existsSync(output)) throw new Error('Measurement output must not already exist');
    mkdirSync(output, { recursive: true });
    measureHistoryCapacity({ data: join(source, 'source'), output, report: { ...report, measurementStartedAt: new Date().toISOString() } });
  } else await rehearseHistoryCapacity({ source: resolve(values.source), output: resolve(values.output) });
}
