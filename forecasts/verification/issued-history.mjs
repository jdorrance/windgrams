// Immutable issued revisions; compact scoring records are not source-column archives.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_MAX_ROLLING_RUNS = 120;
const runPattern = /^\d{8}T\d{6}Z$/;
const hashPattern = /^[a-f0-9]{64}$/;
const slugPattern = /^[a-zA-Z0-9_-]+$/;
const filePattern = /^(manifest\.json|(?:full-columns\/)?sites\/[a-zA-Z0-9_-]+\.json)$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const json = value => JSON.stringify(canonical(value)) + '\n';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const keyFor = reference => new Date(reference).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');

/** Pressure samples retained for scoring; never use this projection to rederive science. */
export function compactSiteDocForHistory(doc) {
  const keep = new Set([925, 850, 700, 600]);
  return { schemaVersion: doc.schemaVersion, model: doc.model, run: doc.run, site: doc.site, soaringMeta: doc.soaringMeta,
    hours: doc.hours.map(hour => ({ validAt: hour.validAt, surface: hour.surface, derived: hour.derived, soaring: hour.soaring,
      experimental: hour.experimental, ...(Array.isArray(hour.levels) ? { levels: hour.levels.filter((level, index) => index === 0 || keep.has(level.pressureHpa)) } : {}) })) };
}

function checkedManifest(manifest, model, runKey) {
  if (!slugPattern.test(model) || manifest.model !== model || !Number.isFinite(Date.parse(manifest.referenceTime))
    || keyFor(manifest.referenceTime) !== runKey || !Array.isArray(manifest.sites) || !manifest.sites.length
    || manifest.sites.some(site => typeof site.slug !== 'string' || !slugPattern.test(site.slug)) || new Set(manifest.sites.map(site => site.slug)).size !== manifest.sites.length) throw new Error('Invalid issued-history manifest');
}

// Early archives intentionally retained only selected sites. Validate the available
// evidence without inventing completeness; immutable revisions always require it.
function legacyFiles(directory, model, runKey) {
  if (!existsSync(join(directory, 'manifest.json'))) return [];
  const manifest = read(join(directory, 'manifest.json')); checkedManifest(manifest, model, runKey);
  const files = ['manifest.json'];
  if (existsSync(join(directory, 'sites'))) for (const name of regularFiles(join(directory, 'sites'))) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name) || !manifest.sites.some(site => `${site.slug}.json` === name)) throw new Error('Invalid legacy history site inventory');
    const profile = read(join(directory, 'sites', name));
    if (profile.model !== model || profile.site?.id !== name.slice(0, -5) || profile.run?.referenceTime !== manifest.referenceTime || !Array.isArray(profile.hours)) throw new Error(`Invalid legacy history profile identity: ${name}`);
    files.push(`sites/${name}`);
  }
  for (const file of files) if (!lstatSync(join(directory, file)).isFile() || lstatSync(join(directory, file)).isSymbolicLink()) throw new Error('Invalid legacy history entry');
  return files;
}

function regularFiles(directory, prefix = '') {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('History directories must not be symlinks');
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = prefix + entry.name;
    if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new Error(`Invalid history entry: ${file}`);
    return entry.isDirectory() ? regularFiles(join(directory, entry.name), `${file}/`) : [file];
  });
}

function verifyRevision(directory, model, runKey, revisionId) {
  if (!hashPattern.test(revisionId)) throw new Error('Invalid issued-history revision ID');
  const record = read(join(directory, 'revision.json'));
  const { revisionId: recorded, ...descriptor } = record;
  if (recorded !== revisionId || sha(json(descriptor)) !== revisionId || descriptor.schemaVersion !== 1
    || descriptor.representation !== 'compact-scoring' || !descriptor.files || !descriptor.sourceFiles) throw new Error('Invalid issued-history revision digest');
  if (JSON.stringify(regularFiles(directory).sort()) !== JSON.stringify(['revision.json', ...Object.keys(descriptor.files)].sort())) throw new Error('Unexpected issued-history revision contents');
  for (const [file, digest] of Object.entries(descriptor.files)) {
    if (!filePattern.test(file) || !hashPattern.test(digest) || sha(readFileSync(join(directory, file))) !== digest) throw new Error(`Corrupt issued-history file: ${file}`);
  }
  const manifest = read(join(directory, 'manifest.json'));
  checkedManifest(manifest, model, runKey);
  for (const { slug } of manifest.sites) {
    const profile = read(join(directory, 'sites', `${slug}.json`));
    if (profile.model !== model || profile.site?.id !== slug || profile.run?.referenceTime !== manifest.referenceTime || !Array.isArray(profile.hours)) throw new Error(`Invalid issued-history profile identity: ${slug}`);
  }
  const expected = ['manifest.json', ...manifest.sites.map(site => `sites/${site.slug}.json`)];
  if (JSON.stringify(Object.keys(descriptor.sourceFiles).sort()) !== JSON.stringify(expected.sort())
    || Object.values(descriptor.sourceFiles).some(digest => !hashPattern.test(digest))
    || descriptor.files['manifest.json'] !== descriptor.sourceFiles['manifest.json']) throw new Error('Incomplete issued-history source identity');
  for (const file of expected) if (!descriptor.files[file]) throw new Error(`Missing issued-history file: ${file}`);
  for (const file of Object.keys(descriptor.files)) {
    if (!expected.includes(file) && !(file.startsWith('full-columns/') && expected.includes(file.slice(13)))) throw new Error(`Unexpected issued-history file: ${file}`);
    if (file.startsWith('full-columns/') && descriptor.files[file] !== descriptor.sourceFiles[file.slice(13)]) throw new Error('Full-column source identity differs');
  }
  return record;
}

function revisionOrder(runRoot, model, runKey) {
  if (lstatSync(runRoot).isSymbolicLink()) throw new Error('History runs must not be symlinks');
  const directory = join(runRoot, 'revisions');
  const available = existsSync(directory) ? readdirSync(directory).filter(id => hashPattern.test(id)).sort() : [];
  for (const id of available) verifyRevision(join(directory, id), model, runKey, id);
  const index = existsSync(join(runRoot, 'index.json')) ? read(join(runRoot, 'index.json')) : null;
  if (index && (index.schemaVersion !== 1 || !Array.isArray(index.revisions) || new Set(index.revisions).size !== index.revisions.length
    || index.revisions.some(id => !available.includes(id)) || !index.revisions.includes(index.latest))) throw new Error('Invalid issued-history revision index');
  return [...(index?.revisions ?? []), ...available.filter(id => !index?.revisions.includes(id))];
}

function writeIndex(runRoot, revisions, latest = revisions.at(-1)) {
  const path = join(runRoot, 'index.json');
  const bytes = json({ schemaVersion: 1, revisions, latest });
  if (existsSync(path) && readFileSync(path, 'utf8') === bytes) return;
  const staging = mkdtempSync(join(runRoot, '.index-'));
  try { writeFileSync(join(staging, 'index.json'), bytes); renameSync(join(staging, 'index.json'), path); }
  finally { rmSync(staging, { recursive: true, force: true }); }
}

function prune(modelRoot, maxRollingRuns, pinnedRunKeys) {
  if (!Number.isSafeInteger(maxRollingRuns) || maxRollingRuns < 1) throw new Error('History retention must be a positive run count');
  if (!existsSync(modelRoot)) return;
  const rolling = readdirSync(modelRoot).filter(key => runPattern.test(key) && !pinnedRunKeys.includes(key)).sort();
  for (const key of rolling.slice(0, Math.max(0, rolling.length - maxRollingRuns))) rmSync(join(modelRoot, key), { recursive: true });
}

/** Identical issued content is idempotent. A changed method/build/content adds a revision. */
export function archiveModelRun(dataRoot, modelSlug, { maxRollingRuns = DEFAULT_MAX_ROLLING_RUNS, pinnedRunKeys = [], retainFullColumns = false } = {}) {
  if (!slugPattern.test(modelSlug)) throw new Error('Invalid history model');
  if (!Number.isSafeInteger(maxRollingRuns) || maxRollingRuns < 1) throw new Error('History retention must be a positive run count');
  const modelRoot = join(dataRoot, modelSlug), manifestPath = join(modelRoot, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = read(manifestPath), runKey = keyFor(manifest.referenceTime);
  checkedManifest(manifest, modelSlug, runKey);
  if (retainFullColumns && !pinnedRunKeys.includes(runKey)) throw new Error('Full source columns require an explicitly pinned run');
  const payloads = { 'manifest.json': readFileSync(manifestPath) }, sourceFiles = {}, methods = new Set();
  sourceFiles['manifest.json'] = sha(payloads['manifest.json']);
  for (const { slug } of manifest.sites) {
    const file = `sites/${slug}.json`, bytes = readFileSync(join(modelRoot, file)), document = JSON.parse(bytes);
    if (document.model !== modelSlug || document.site?.id !== slug || document.run?.referenceTime !== manifest.referenceTime || !Array.isArray(document.hours)) throw new Error(`Invalid issued profile: ${slug}`);
    sourceFiles[file] = sha(bytes);
    payloads[file] = Buffer.from(json(compactSiteDocForHistory(document)));
    methods.add(document.soaringMeta?.contractVersion ?? 'unrecorded');
    if (retainFullColumns) payloads[`full-columns/${file}`] = bytes;
  }
  const descriptor = { schemaVersion: 1, representation: 'compact-scoring', sourceFiles,
    files: Object.fromEntries(Object.entries(payloads).map(([file, bytes]) => [file, sha(bytes)])), methods: [...methods].sort(), build: manifest.diagnosticBuild ?? null };
  const revisionId = sha(json(descriptor)), runRoot = join(dataRoot, 'history', modelSlug, runKey), revisionsRoot = join(runRoot, 'revisions');
  mkdirSync(revisionsRoot, { recursive: true });
  const revisions = revisionOrder(runRoot, modelSlug, runKey), destination = join(revisionsRoot, revisionId);
  const created = !existsSync(destination);
  if (created) {
    const staging = mkdtempSync(join(revisionsRoot, '.pending-'));
    try {
      for (const [file, bytes] of Object.entries(payloads)) { mkdirSync(dirname(join(staging, file)), { recursive: true }); writeFileSync(join(staging, file), bytes); }
      writeFileSync(join(staging, 'revision.json'), json({ ...descriptor, revisionId }));
      verifyRevision(staging, modelSlug, runKey, revisionId);
      renameSync(staging, destination);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  } else verifyRevision(destination, modelSlug, runKey, revisionId);
  // Re-archiving an older revision must not move latest backwards.
  const previousLatest = existsSync(join(runRoot, 'index.json')) ? read(join(runRoot, 'index.json')).latest : revisions.at(-1);
  if (!revisions.includes(revisionId)) revisions.push(revisionId);
  writeIndex(runRoot, revisions, created ? revisionId : previousLatest ?? revisionId);
  prune(join(dataRoot, 'history', modelSlug), maxRollingRuns, pinnedRunKeys);
  return { model: modelSlug, referenceTime: manifest.referenceTime, runKey, revisionId, created, siteCount: manifest.sites.length, maxRollingRuns };
}

/** Validate all incoming revisions before copying; never replace an issued revision or legacy root. */
export function mergeHistoryArchives(incomingRoot, outputRoot, model, { maxRollingRuns = DEFAULT_MAX_ROLLING_RUNS, pinnedRunKeys = ['20261021T000000Z', '20261021T060000Z'] } = {}) {
  if (!slugPattern.test(model)) throw new Error('Invalid history model');
  if (!Number.isSafeInteger(maxRollingRuns) || maxRollingRuns < 1) throw new Error('History retention must be a positive run count');
  const incoming = join(incomingRoot, 'history', model), output = join(outputRoot, 'history', model);
  if (!existsSync(incoming)) return { copiedRevisions: 0 };
  if (lstatSync(incoming).isSymbolicLink() || existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('History model directories must not be symlinks');
  const runs = readdirSync(incoming).filter(key => runPattern.test(key)).sort();
  const plans = runs.map(runKey => {
    const source = join(incoming, runKey), target = join(output, runKey);
    const ids = revisionOrder(source, model, runKey), existing = existsSync(target) ? revisionOrder(target, model, runKey) : [];
    const legacy = legacyFiles(source, model, runKey);
    legacyFiles(target, model, runKey);
    for (const file of legacy) if (existsSync(join(target, file)) && sha(readFileSync(join(source, file))) !== sha(readFileSync(join(target, file)))) throw new Error(`Conflicting legacy history: ${model}/${runKey}/${file}`);
    return { runKey, source, target, ids, existing, legacy };
  });
  let copiedRevisions = 0;
  for (const { runKey, source, target, ids, existing, legacy } of plans) {
    mkdirSync(join(target, 'revisions'), { recursive: true });
    // Legacy archives have no digest receipt. Preserve an existing legacy issue unchanged.
    for (const file of legacy) if (!existsSync(join(target, file))) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      cpSync(join(source, file), join(target, file), { errorOnExist: true, force: false });
    }
    for (const id of ids) {
      if (existing.includes(id)) continue;
      const staging = mkdtempSync(join(target, 'revisions', '.merge-'));
      try { cpSync(join(source, 'revisions', id), staging, { recursive: true }); verifyRevision(staging, model, runKey, id); renameSync(staging, join(target, 'revisions', id)); }
      finally { rmSync(staging, { recursive: true, force: true }); }
      copiedRevisions++;
    }
    // Retain the original issue; advance latest only when the incoming chain knows the current latest.
    const added = ids.filter(id => !existing.includes(id));
    const order = [...existing, ...added];
    const oldLatest = existsSync(join(target, 'index.json')) ? read(join(target, 'index.json')).latest : existing.at(-1);
    const sourceLatest = existsSync(join(source, 'index.json')) ? read(join(source, 'index.json')).latest : ids.at(-1);
    const latest = !oldLatest || ids.includes(oldLatest) && ids.indexOf(sourceLatest) > ids.indexOf(oldLatest) ? sourceLatest : oldLatest;
    if (order.length) writeIndex(target, order, latest);
  }
  prune(output, maxRollingRuns, pinnedRunKeys);
  return { copiedRevisions };
}

/** Read bounded run roots for offline scoring. First-issued avoids replacing issued evidence with repairs. */
export function archivedModelRuns(dataRoot, model, { maxRuns = 30 } = {}) {
  if (!slugPattern.test(model) || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > DEFAULT_MAX_ROLLING_RUNS) throw new Error('Invalid bounded history request');
  const root = join(dataRoot, 'history', model);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(key => runPattern.test(key)).sort().slice(-maxRuns).map(runKey => {
    const runRoot = join(root, runKey), ids = revisionOrder(runRoot, model, runKey);
    if (existsSync(join(runRoot, 'manifest.json'))) { checkedManifest(read(join(runRoot, 'manifest.json')), model, runKey); return { model, runKey, revisionId: 'legacy', directory: runRoot }; }
    if (!ids.length) throw new Error(`No issued revision for ${model}/${runKey}`);
    return { model, runKey, revisionId: ids[0], directory: join(runRoot, 'revisions', ids[0]) };
  });
}
