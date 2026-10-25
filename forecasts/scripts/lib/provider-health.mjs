// Per-model refresh attempts, independent of immutable forecast/run timestamps.
// The provider workflow owns one health/<group>.json writer; publication merges attempts.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROVIDER_GROUPS } from '@windgrams/providers/registry';

const outcomes = new Set(['running', 'updated', 'retained', 'unavailable']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const message = value => value == null ? null : String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000);

/** Null rejects unknown group/model ownership, malformed lifecycle times or outcomes. */
export function parseProviderHealth(raw, group) {
  const models = Object.hasOwn(PROVIDER_GROUPS, group) ? PROVIDER_GROUPS[group] : null;
  if (!models || !object(raw) || raw.schemaVersion !== 1 || raw.group !== group || !object(raw.models)) return null;
  const parsed = {};
  for (const [model, entry] of Object.entries(raw.models)) {
    if (!models.includes(model) || !object(entry) || !instant(entry.attemptedAt) || !outcomes.has(entry.outcome)
      || !(entry.reason === null || typeof entry.reason === 'string' && entry.reason.length <= 1000)
      || !(entry.completedAt === null || instant(entry.completedAt))
      || !(entry.lastSuccessfulRefreshAt === null || instant(entry.lastSuccessfulRefreshAt))) return null;
    if ((entry.outcome === 'running') !== (entry.completedAt === null)
      || entry.completedAt !== null && Date.parse(entry.completedAt) < Date.parse(entry.attemptedAt)
      || entry.lastSuccessfulRefreshAt !== null && Date.parse(entry.lastSuccessfulRefreshAt) > Date.parse(entry.completedAt ?? entry.attemptedAt)
      || entry.outcome === 'updated' && entry.lastSuccessfulRefreshAt !== entry.completedAt) return null;
    parsed[model] = { attemptedAt: entry.attemptedAt, completedAt: entry.completedAt, lastSuccessfulRefreshAt: entry.lastSuccessfulRefreshAt, outcome: entry.outcome, reason: entry.reason };
  }
  return { schemaVersion: 1, group, models: parsed };
}

/** Newer attempts win independently of forecast acceptance; old failures cannot erase success. */
export function mergeProviderHealth(current, incoming, group) {
  const next = parseProviderHealth(incoming, group);
  const previous = current == null ? { schemaVersion: 1, group, models: {} } : parseProviderHealth(current, group);
  if (!next || !previous) throw new Error(`Invalid provider health for ${group}`);
  const models = { ...previous.models };
  for (const [model, entry] of Object.entries(next.models)) {
    const before = models[model];
    const newer = !before || Date.parse(entry.attemptedAt) > Date.parse(before.attemptedAt)
      || Date.parse(entry.attemptedAt) === Date.parse(before.attemptedAt)
        && entry.completedAt !== null && (before.completedAt === null || Date.parse(entry.completedAt) >= Date.parse(before.completedAt));
    const winner = newer ? entry : before;
    const successes = [entry.lastSuccessfulRefreshAt, before?.lastSuccessfulRefreshAt].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a));
    models[model] = { ...winner, lastSuccessfulRefreshAt: successes[0] ?? null };
  }
  return { schemaVersion: 1, group, models };
}

export function readProviderHealth(output, group) {
  if (!Object.hasOwn(PROVIDER_GROUPS, group)) throw new Error(`Unknown provider group: ${group}`);
  const path = join(output, 'health', `${group}.json`);
  if (!existsSync(path)) return null;
  const document = parseProviderHealth(JSON.parse(readFileSync(path, 'utf8')), group);
  if (!document) throw new Error(`Invalid provider health: ${path}`);
  return document;
}

function save(output, group, model, entry) {
  const document = mergeProviderHealth(readProviderHealth(output, group), { schemaVersion: 1, group, models: { [model]: entry } }, group);
  const path = join(output, 'health', `${group}.json`), temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
  return document.models[model];
}

/** Call before acquisition so a terminated job leaves an observable unfinished attempt. */
export function beginProviderAttempt(output, group, model, attemptedAt) {
  const previous = readProviderHealth(output, group)?.models[model];
  return save(output, group, model, { attemptedAt, completedAt: null, lastSuccessfulRefreshAt: previous?.lastSuccessfulRefreshAt ?? null, outcome: 'running', reason: null });
}

export function finishProviderAttempt(output, group, model, attemptedAt, completedAt, outcome, reason = null) {
  const previous = readProviderHealth(output, group)?.models[model];
  return save(output, group, model, {
    attemptedAt, completedAt, outcome, reason: message(reason),
    lastSuccessfulRefreshAt: outcome === 'updated' ? completedAt : previous?.lastSuccessfulRefreshAt ?? null,
  });
}

/** Regional/validation failures degrade only their model, even after point acquisition succeeded. */
export function finishProviderStages(output, group, stages, { now = () => new Date().toISOString() } = {}) {
  if (!Object.hasOwn(PROVIDER_GROUPS, group)) return [];
  const failures = stages.filter(stage => !stage.ok && ['regional', 'validate'].includes(stage.stage));
  const updated = [];
  for (const model of PROVIDER_GROUPS[group]) {
    const relevant = failures.filter(stage => stage.stage !== 'regional' || group !== 'noaa-cloud' || model === 'hrrr-conus');
    if (!relevant.length) continue;
    const previous = readProviderHealth(output, group)?.models[model];
    if (!previous) continue; // Missing acquisition health remains a separate monitor failure.
    const reason = [previous.reason, ...relevant.map(stage => `${stage.stage}: ${stage.reason ?? 'stage failed'}`)].filter(Boolean).join('; ');
    const outcome = previous.outcome === 'unavailable' ? 'unavailable' : 'retained';
    finishProviderAttempt(output, group, model, previous.attemptedAt, now(), outcome, reason);
    updated.push(model);
  }
  return updated;
}
