// Offline comparison of frozen PointCast responses and the original Windgrams evidence.
// Public contract, units and exclusions: README.md. No network or forecast recomputation.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { bytesOf, jsonOf, sha256 } from '../evidence-store.mjs';
import { parsePointcast, POINTCAST_DECODER, POINTCAST_FIELDS } from './schema.mjs';
import { renderReport } from './report.mjs';
import { groupCounts, buildFixedCases, buildCases, buildFindings } from './findings.mjs';
import { COMPARISON_FIELDS, compareProfiles } from './profiles.mjs';
import { parseRuntimeMetadata, runtimeIndex, auditRuntimeChanges, describeResponseChanges } from './routing.mjs';
export { COMPARISON_FIELDS, compareProfiles, interpolateAboveGround } from './profiles.mjs';
export { parseRuntimeMetadata } from './routing.mjs';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const unique = (values) => [...new Set(values)];

export function summarizeRows(rows) {
  const values = rows.map((row) => row.difference).filter(finite),
    absolute = values.map(Math.abs).sort((a, b) => a - b);
  const quantile = (probability) => {
    if (!absolute.length) return null;
    const index = (absolute.length - 1) * probability,
      low = Math.floor(index);
    return absolute[low] + (absolute[Math.ceil(index)] - absolute[low]) * (index - low);
  };
  return {
    count: values.length,
    meanDifference: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    meanAbsoluteDifference: values.length ? absolute.reduce((a, b) => a + b, 0) / values.length : null,
    medianAbsoluteDifference: quantile(0.5),
    p95AbsoluteDifference: quantile(0.95),
    maximumAbsoluteDifference: absolute.at(-1) ?? null,
    distinctSites: unique(rows.map((row) => row.site)).length,
    distinctSiteDays: unique(rows.map((row) => `${row.site}:${row.localDate}`)).length,
    distinctHours: unique(rows.map((row) => `${row.site}:${row.validAt}`)).length,
    note: 'Level/time/model samples are dependent. Distinct site-days are coverage counts, not independent observations.',
  };
}
function group(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(keys.map((name) => row[name]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => ({
      ...Object.fromEntries(keys.map((name, index) => [name, JSON.parse(key)[index]])),
      ...summarizeRows(values),
    }));
}

async function baselineProfiles(root, snapshot) {
  const profiles = [];
  for (const model of snapshot.models)
    for (const item of model.profiles) {
      if (item.entry?.status !== 200 || !model.stable || !item.valid) continue;
      profiles.push({ profile: await jsonOf(root, item.entry), entry: item.entry, cohort: 'latest-live' });
    }
  for (const archive of snapshot.archives ?? [])
    for (const item of archive.profiles) {
      if (item.entry?.status !== 200) continue;
      profiles.push({
        profile: await jsonOf(root, item.entry),
        entry: item.entry,
        cohort: 'retained-issued-archive',
        revision: archive.revisionId,
      });
    }
  return profiles;
}

/** Verify the frozen evidence, compare, and write report.json plus a standalone interactive index.html. */
export async function compareReview({ snapshot: directory, output, baseline: baselineOverride } = {}) {
  const root = resolve(directory),
    source = await readFile(join(root, 'snapshot.json')),
    snapshot = JSON.parse(source);
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.requests) || !Array.isArray(snapshot.responses))
    throw new Error('Unsupported XC capture manifest');
  const baselineRoot = resolve(baselineOverride ?? snapshot.baseline.path),
    baselineBytes = await readFile(join(baselineRoot, 'snapshot.json'));
  if (sha256(baselineBytes) !== snapshot.baseline.sha256) throw new Error('Baseline snapshot hash mismatch');
  const baseline = JSON.parse(baselineBytes),
    profiles = await baselineProfiles(baselineRoot, baseline);
  let discovery = snapshot.discovery;
  if (!Array.isArray(discovery)) {
    try {
      discovery = JSON.parse(await readFile(join(root, 'discovery/evidence.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      discovery = [];
    }
  }
  const runtimeMetadata = [];
  for (const entry of discovery) {
    if (!entry.file) continue;
    const bytes = await bytesOf(root, entry);
    if (entry.kind?.startsWith('runtimes-'))
      runtimeMetadata.push({ entry, index: runtimeIndex(parseRuntimeMetadata(bytes.toString('utf8'))) });
  }
  const report = {
    schemaVersion: 1,
    evaluator: 'xcskies-review/1.0.0',
    decoder: POINTCAST_DECODER,
    snapshotSha256: sha256(source),
    baselineSnapshotSha256: sha256(baselineBytes),
    capturedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    scope:
      'Frozen forecast disagreement, not observation error or model skill. Original Windgrams evidence retained unchanged.',
    fields: COMPARISON_FIELDS,
    providerFields: POINTCAST_FIELDS,
    requests: snapshot.requests,
    coverage: [],
    rows: [],
    exclusions: [],
    hourPairs: [],
    terrain: [],
    evidence: { xc: snapshot.responses, discovery, baseline: snapshot.baseline },
    limitations: [
      'XC Skies is another processed forecast, not an observation. There is no agreement threshold proving physical correctness.',
      'PointCast per-hour initialization and returned native cells are absent. Runtime metadata is retained as routing context, not substituted as proven profile provenance.',
      'XC historical hours were retrieved retrospectively; first-issued XC forecasts were not independently archived.',
      'Only locations with profiles in the original frozen Windgrams baseline can be paired. Additional XC sites are inventory coverage.',
      'Atmospheric comparisons use exact UTC and native Windgrams heights, with XC component/temperature interpolation between valid levels strictly above both displayed grounds. No extrapolation or terrain shift.',
      'XC displayed ground may be terrain-adjusted; native terrain provenance is unresolved.',
      'Surface scalar encodings, parcel velocity versus W*, conservative lift, shear indices, PBL depth, cloud fractions and precipitation intervals are excluded from direct scores.',
      'Lift and condensation heights are separate method-sensitive contrasts. The differently defined ceilings and cloud diagnostics are not numerically equivalent.',
      'Multiple levels, times, forecasts and models are dependent samples. Counts are not independent station-days or forecast-skill validation.',
    ],
  };
  for (const entry of snapshot.responses) if (entry.file) await bytesOf(root, entry);
  for (const request of snapshot.requests) {
    const candidates = snapshot.responses.filter((entry) => entry.id === request.id && entry.role === 'primary');
    if (candidates.length > 1) throw new Error(`Ambiguous primary responses for ${request.id}`);
    const response = candidates[0];
    const coverage = {
      site: request.site.slug,
      siteName: request.site.name,
      xcModel: request.model,
      model: request.ourModel,
      requestId: request.id,
      evidence: response?.sha256 ?? null,
    };
    if (!response?.file) {
      report.coverage.push({ ...coverage, status: 'unavailable', reason: response?.error ?? 'no-response' });
      continue;
    }
    if (response.url !== request.url || response.finalUrl !== request.url)
      throw new Error(`Request identity mismatch for ${request.id}`);
    let xc, raw;
    try {
      raw = await jsonOf(root, response);
      xc = parsePointcast(raw, {
        model: request.model,
        latitude: request.site.latitude,
        longitude: request.site.longitude,
        sourceUrl: request.url,
      });
    } catch (error) {
      report.coverage.push({ ...coverage, status: 'invalid-or-partial-response', reason: error.message });
      continue;
    }
    const eligible = profiles.filter(
      (item) => item.profile.site.id === request.site.slug && item.profile.model === request.ourModel,
    );
    const repeats = snapshot.responses.filter(
      (entry) => entry.id === request.id && entry.role !== 'primary' && entry.file,
    );
    const repeatChecks = [];
    for (const repeat of repeats) {
      const repeated = repeat.sha256 === response.sha256 ? raw : await jsonOf(root, repeat),
        valuesChanged = !isDeepStrictEqual(raw, repeated);
      repeatChecks.push({
        evidence: repeat.sha256,
        retrievedAt: repeat.retrievedAt,
        bytesChanged: repeat.sha256 !== response.sha256,
        valuesChanged,
        ...(valuesChanged ? describeResponseChanges(raw, repeated) : {}),
      });
    }
    const counts = {
      xcHours: xc.hours.length,
      firstValidAt: xc.hours[0].validAt,
      lastValidAt: xc.hours.at(-1).validAt,
      repeatedCaptureChanged: repeatChecks.some((check) => check.valuesChanged),
      repeatedCaptureBytesChanged: repeatChecks.some((check) => check.bytesChanged),
      repeatChecks,
    };
    if (!eligible.length) {
      report.coverage.push({
        ...coverage,
        ...counts,
        status: 'XC-inventory-only',
        reason: 'No matching model/site profile in original frozen Windgrams baseline.',
      });
      continue;
    }
    let pairs = 0,
      hours = 0;
    for (const item of eligible) {
      const result = compareProfiles(item.profile, xc, {
        request,
        response,
        cohort: item.cohort,
        runtimeMetadata,
        evidence: {
          ours: item.entry.sha256,
          xc: response.sha256,
          oursUrl: item.entry.url,
          xcUrl: request.url,
          ourRevision: item.revision ?? null,
        },
      });
      report.rows.push(...result.rows);
      report.exclusions.push(...result.exclusions);
      report.hourPairs.push(...result.hourPairs);
      pairs += result.rows.length;
      hours += result.hourPairs.length;
      report.terrain.push({
        ...coverage,
        cohort: item.cohort,
        referenceTime: item.profile.run.referenceTime,
        modelElevationM: item.profile.site.modelElevationM,
        xcMinimumElevationM: Math.min(...xc.hours.map((hour) => hour.modelElevationM).filter(finite)),
        xcMaximumElevationM: Math.max(...xc.hours.map((hour) => hour.modelElevationM).filter(finite)),
      });
    }
    report.coverage.push({
      ...coverage,
      ...counts,
      status: hours ? 'paired' : 'no-exact-UTC-overlap',
      pairs,
      matchedHourPairs: hours,
      ourProfiles: eligible.length,
    });
  }
  report.summary = group(report.rows, ['category', 'cohort', 'model', 'field', 'unit']);
  report.strictSameRun = {
    eligibleRows: report.rows.filter((row) => row.strictSameRunIssue === null).length,
    exclusions: Object.fromEntries(
      unique(report.rows.map((row) => row.strictSameRunIssue).filter(Boolean))
        .sort()
        .map((reason) => [reason, report.rows.filter((row) => row.strictSameRunIssue === reason).length]),
    ),
    note: 'The main rows describe qualified forecast disagreement. Only rows with verified equal initialization and compatible quantity can enter a strict same-run cohort.',
  };
  report.bySite = group(report.rows, ['category', 'cohort', 'site', 'model', 'field', 'unit']);
  report.byDay = group(report.rows, ['category', 'cohort', 'utcDate', 'model', 'field', 'unit']);
  report.bySiteDay = group(report.rows, ['category', 'cohort', 'site', 'utcDate', 'model', 'field', 'unit']);
  report.exclusionCounts = groupCounts(report.exclusions, 'reason');
  report.coverageCounts = groupCounts(report.coverage, 'status');
  report.sampleCounts = {
    requests: snapshot.requests.length,
    sitesRequested: unique(snapshot.requests.map((request) => request.site.slug)).length,
    sitesPaired: unique(report.hourPairs.map((row) => row.site)).length,
    modelsPaired: unique(report.hourPairs.map((row) => row.model)),
    hourPairs: report.hourPairs.length,
    uniqueSiteHours: unique(report.hourPairs.map((row) => `${row.site}:${row.validAt}`)).length,
    localSiteDays: unique(report.hourPairs.map((row) => `${row.site}:${row.localDate}`)).length,
    numericRows: report.rows.length,
    atmosphericRows: report.rows.filter((row) => row.category === 'atmosphere').length,
    methodSensitiveRows: report.rows.filter((row) => row.category === 'method-sensitive').length,
    firstValidAt: report.hourPairs.map((row) => row.validAt).sort()[0] ?? null,
    lastValidAt:
      report.hourPairs
        .map((row) => row.validAt)
        .sort()
        .at(-1) ?? null,
  };
  report.largestDifferences = Object.fromEntries(
    COMPARISON_FIELDS.map((field) => [
      field.id,
      report.rows
        .filter((row) => row.field === field.id)
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
        .slice(0, 10),
    ]),
  );
  report.archiveCoverage = (baseline.archives ?? []).map((archive) => ({
    model: archive.model,
    referenceTime: archive.referenceTime,
    revision: archive.revisionId,
    profiles: archive.profiles.length,
    matchedHourPairs: report.hourPairs.filter(
      (row) =>
        row.cohort === 'retained-issued-archive' &&
        row.model === archive.model &&
        Date.parse(row.referenceTime) === Date.parse(archive.referenceTime),
    ).length,
  }));
  report.runtimeAudit = auditRuntimeChanges(
    runtimeMetadata,
    snapshot.requests.map((request) => request.model),
  );
  report.repeatAudit = {
    checkedProducts: report.coverage.filter((item) => item.repeatChecks?.length).length,
    byteChangedProducts: report.coverage
      .filter((item) => item.repeatedCaptureBytesChanged)
      .map((item) => item.requestId),
    valueChangedProducts: report.coverage
      .filter((item) => item.repeatedCaptureChanged)
      .map((item) => ({
        requestId: item.requestId,
        site: item.site,
        model: item.model,
        primaryEvidence: item.evidence,
        checks: item.repeatChecks,
      })),
    scoringPolicy:
      'Primary frozen responses remain the comparison inputs. Repeated responses are separate change evidence and never replace them.',
  };
  report.fixedCases = buildFixedCases(report);
  report.cases = buildCases(report);
  report.findings = buildFindings(report);
  const destination = resolve(output ?? join(root, 'report'));
  report.evidenceLinks = {
    xc: `${relative(destination, root).split(sep).join('/') || '.'}/objects/`,
    ours: `${relative(destination, baselineRoot).split(sep).join('/') || '.'}/objects/`,
    baselineReport: relative(destination, join(baselineRoot, 'report/index.html')).split(sep).join('/'),
  };
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(destination, 'index.html'), renderReport(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--snapshot', '--output', '--baseline'].includes(args[index]) || !args[index + 1])
      throw new Error('Usage: compare.mjs --snapshot DIR [--output DIR] [--baseline DIR]');
    options[args[index].slice(2)] = args[index + 1];
  }
  if (!options.snapshot) throw new Error('--snapshot is required');
  const report = await compareReview(options);
  console.log(JSON.stringify({ sampleCounts: report.sampleCounts, coverageCounts: report.coverageCounts }));
}
