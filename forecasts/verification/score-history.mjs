// Offline, bounded comparison of issued forecasts against supplied observation records.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { archivedModelRuns } from './history.mjs';
import { EVALUATOR_VERSION, MATCHED_RAOB_SITE_PAIRS, compareRaobProfile, summarizeVerifications } from './verify-observations.mjs';

/** Explicit UTC window and 1–120 runs/model; scores stored values without derivation or downloads. */
export function scoreHistory({ dataRoot, observationsRoot = dataRoot, models = ['hrrr-conus', 'rrfs', 'rdps'], from, to, maxRuns = 30, pairs = MATCHED_RAOB_SITE_PAIRS }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 120 * 86400000) throw new Error('Scoring requires an ordered UTC observation window of at most 120 days');
  if (!Array.isArray(models) || !models.length || models.length > 12 || new Set(models).size !== models.length) throw new Error('Scoring requires 1–12 distinct models');
  const runs = models.flatMap(model => archivedModelRuns(dataRoot, model, { maxRuns }));
  const comparisons = [], missing = { observationDocuments: 0, issuedProfiles: 0 };
  const observations = new Map();
  for (const pair of pairs) {
    const path = join(observationsRoot, 'raob', 'sites', `${pair.siteSlug}.json`);
    if (!existsSync(path)) { missing.observationDocuments++; continue; }
    const document = JSON.parse(readFileSync(path, 'utf8'));
    document.soundings = (document.soundings ?? []).filter(sounding => Date.parse(sounding.validAt) >= start && Date.parse(sounding.validAt) <= end);
    if (document.soundings.length > 241) throw new Error('Observation window exceeds 241 soundings per site');
    observations.set(pair.siteSlug, document);
  }
  for (const run of runs) for (const pair of pairs) {
    const observationsDoc = observations.get(pair.siteSlug);
    if (!observationsDoc) continue;
    const path = join(run.directory, 'sites', `${pair.siteSlug}.json`);
    if (!existsSync(path)) { missing.issuedProfiles++; continue; }
    const profile = JSON.parse(readFileSync(path, 'utf8'));
    for (const time of new Set(observationsDoc.soundings.map(sounding => sounding.validAt))) {
      const compared = compareRaobProfile(observationsDoc, profile, pair, time);
      if (compared?.matched) comparisons.push({ ...compared, issuedRunKey: run.runKey, issuedRevisionId: run.revisionId });
    }
  }
  return { schemaVersion: 1, evaluatorVersion: EVALUATOR_VERSION, status: comparisons.length ? 'matched-comparisons' : 'no-matched-observations',
    note: 'Retrospective comparisons of issued values. Independent station-days describe coverage, not prospective skill or promotion eligibility.',
    acquisition: 'offline', forecastValues: 'as-issued', revisionPolicy: 'first-issued', observationWindow: { from, to },
    limits: { maxRunsPerModel: maxRuns, maxWindowDays: 120 }, models, selectedRuns: runs.map(({ directory, ...run }) => run), missing,
    ...summarizeVerifications(comparisons), comparisons };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { data: { type: 'string', default: 'data' }, observations: { type: 'string' },
      models: { type: 'string', default: 'hrrr-conus,rrfs,rdps' }, from: { type: 'string' }, to: { type: 'string' },
      'max-runs': { type: 'string', default: '30' }, report: { type: 'string' } } });
    const report = scoreHistory({ dataRoot: resolve(values.data), observationsRoot: resolve(values.observations ?? values.data),
      models: values.models.split(','), from: values.from, to: values.to, maxRuns: Number(values['max-runs']) });
    const text = JSON.stringify(report, null, 2) + '\n';
    if (values.report) writeFileSync(resolve(values.report), text);
    else process.stdout.write(text);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
