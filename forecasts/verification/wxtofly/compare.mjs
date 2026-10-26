// Offline evidence comparison. Missing and incompatible data stay visible in coverage records.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { jsonOf, bytesOf, textOf, sha256 } from '../evidence-store.mjs';
import { FIELDS, EXCLUSIONS, REQUIRED_FAMILIES, scalar } from './fields.mjs';
import { parseBlipspot } from './html.mjs';
import { grouped } from './statistics.mjs';
import { inventoryCoverage } from './coverage.mjs';
import { buildCases } from './cases.mjs';
import { implementationIdentity } from './provenance.mjs';
import { auditProfile } from './science.mjs';
import { compareProfile } from './profiles.mjs';
import { buildFindings } from './findings.mjs';
import { auditPublishedViews } from './view-audit.mjs';
export { compareProfile } from './profiles.mjs';
import {
  compareRaobProfile,
  summarizeVerifications,
  MATCHED_RAOB_SITE_PAIRS,
  EVALUATOR_VERSION,
} from '../verify-observations.mjs';
import { assessForecastFreshness } from '@windgrams/data-client';

const ok = (e) => e?.status === 200;
const hourKey = (value) => Date.parse(value);
export async function compareReview({ snapshot: directory, output, archiveDays = 30, inspection }) {
  const root = resolve(directory),
    snapshotBytes = await readFile(join(root, 'snapshot.json')),
    snapshot = JSON.parse(snapshotBytes);
  if (snapshot.schemaVersion !== 1) throw new Error('Unsupported snapshot');
  if (!Number.isInteger(archiveDays) || archiveDays < 1 || archiveDays > 30)
    throw new Error('Archive window must be 1–30 days');
  const report = {
    schemaVersion: 1,
    evaluator: 'wxtofly-review/1.0.0',
    implementation: await implementationIdentity(),
    snapshotSha256: sha256(snapshotBytes),
    capturedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    dataUrl: snapshot.dataUrl,
    wxUrl: snapshot.wxUrl,
    archiveDays,
    checkout: snapshot.checkout,
    scope: 'All discovered shared products; forecast differences are not observation errors.',
    fields: FIELDS,
    fieldExclusions: EXCLUSIONS,
    requiredFamilies: REQUIRED_FAMILIES,
    coverage: [],
    rows: [],
    exclusions: [],
    events: [],
    timing: [],
    freshness: [],
    methodAudit: [],
    regionalAudit: [],
    rendererAudit: [],
    observations: {},
    findings: [],
    evidence: snapshot.resources,
    siteMatches: snapshot.matches,
    wxMapInventory: snapshot.wxMapInventory,
    limitations: [
      'WxToFly is a model forecast, not ground truth. Model/grid/terrain differences prevent a numerical-agreement pass threshold.',
      'Image-only upper-air, maps and soundings support qualitative review; no pixel-derived numbers enter quantitative scores.',
      'Unknown WxToFly initialization times prevent equal-lead comparisons.',
      'Archive availability bounds the retrospective study; one date cannot establish repeated weather-regime performance.',
      'Local checkout rendering/reference checks are separate from browser checks of the deployed application.',
    ],
  };
  // Fail closed if any captured successful object has changed, including rendered evidence.
  for (const entry of snapshot.resources) if (entry.file) await bytesOf(root, entry);
  for (const product of snapshot.wxProducts)
    if (ok(product.entry)) Object.assign(product, parseBlipspot(await textOf(root, product.entry), product.entry.url));
  const profiles = [];
  for (const model of snapshot.models) {
    let latest = null;
    for (const p of model.profiles) {
      if (!ok(p.entry)) continue;
      const profile = await jsonOf(root, p.entry);
      latest ??= profile;
      profiles.push({ profile, entry: p.entry, cohort: 'latest-live', eligible: model.stable && p.valid });
      if (model.stable && p.valid)
        report.methodAudit.push(...auditProfile(profile).map((c) => ({ ...c, evidence: p.entry.sha256 })));
    }
    if (latest) {
      const descriptor = snapshot.catalogue.models.find((m) => m.slug === model.slug);
      const assessment = assessForecastFreshness({
        referenceTime: latest.run.referenceTime,
        validUntil: latest.hours.at(-1)?.validAt,
        policy: descriptor,
        now: snapshot.startedAt,
        consistent: model.stable,
      });
      report.freshness.push({
        model: model.slug,
        referenceTime: model.referenceTime,
        generatedAt: model.generatedAt,
        stable: model.stable,
        runAgeHours: (Date.parse(snapshot.startedAt) - Date.parse(model.referenceTime)) / 3600000,
        lastValidAt: latest.hours.at(-1)?.validAt,
        assessment,
      });
    } else
      report.coverage.push({
        product: 'point-model',
        model: model.slug,
        status: 'unavailable-or-outside-shared-coverage',
        evidence: model.manifest,
      });
  }
  const from = Date.parse(snapshot.startedAt) - archiveDays * 86400000;
  for (const archive of snapshot.archives) {
    if (Date.parse(archive.referenceTime) < from) continue;
    for (const p of archive.profiles) {
      const profile = await jsonOf(root, p.entry);
      profiles.push({
        profile,
        entry: p.entry,
        cohort: 'retained-issued-archive',
        eligible: true,
        revision: archive.revisionId,
      });
    }
  }
  for (const match of snapshot.matches) {
    if (match.status !== 'matched') {
      report.coverage.push({
        product: 'location',
        site: match.site.slug,
        status: match.status,
        reason: match.reason,
        candidates: match.candidates,
      });
      continue;
    }
    const wx = snapshot.wxProducts.find((p) => p.id === match.wxId);
    const candidates = profiles.filter((p) => p.profile.site.id === match.site.slug);
    for (const item of candidates) {
      const evidence = { ours: item.entry.sha256, wx: wx.entry.sha256, oursUrl: item.entry.url, wxUrl: wx.entry.url };
      if (!item.eligible || !wx.stable || wx.status !== 'parsed') {
        report.coverage.push({
          product: 'blipspot/point',
          site: match.site.slug,
          model: item.profile.model,
          status: 'unavailable',
          reason: 'unstable or invalid capture',
          evidence,
        });
        continue;
      }
      const result = compareProfile(item.profile, wx, match, item.cohort, evidence);
      report.rows.push(...result.rows);
      report.exclusions.push(...result.excluded);
      report.events.push(...result.eventRows);
      report.timing.push(result.timing);
      report.coverage.push({
        product: 'blipspot/point',
        site: match.site.slug,
        model: item.profile.model,
        cohort: item.cohort,
        status: result.rows.length ? 'numerically-comparable' : 'no-exact-time-or-field-overlap',
        pairs: result.rows.length,
        wxDate: wx.date,
        wxReferenceTime: wx.referenceTime,
        ourReferenceTime: item.profile.run.referenceTime,
        revision: item.revision ?? null,
        evidence,
      });
    }
    report.coverage.push({
      product: 'windgram',
      site: match.site.slug,
      status: wx.windgram?.images.some(ok) ? 'visually-comparable' : 'unavailable',
      reason: 'Image date and axes require inspection; image is not treated as numeric profile',
      evidence: wx.windgram ?? null,
    });
    for (const name of wx.fieldNames) {
      if (!FIELDS.some((f) => f.wx === name) && !EXCLUSIONS[name])
        report.exclusions.push({
          site: match.site.slug,
          field: name,
          reason: 'unmapped provider field; no assumed equivalence',
          evidence: wx.entry.sha256,
        });
    }
  }
  // Keep latest mutually comparable forecasts separate from the latest-live cohort.
  const newest = new Map();
  for (const row of report.rows) {
    const key = [row.site, row.model, row.field, row.validAt].join('|');
    const old = newest.get(key);
    if (!old || Date.parse(row.referenceTime) > Date.parse(old.referenceTime)) newest.set(key, row);
  }
  report.latestMutual = [...newest.values()];
  report.summary = grouped(report.rows, ['cohort', 'model', 'wxModel', 'field', 'unit']);
  report.strictSameRun = {
    eligibleRows: report.rows.filter((row) => row.strictSameRunIssue === null).length,
    exclusions: Object.fromEntries(
      [...new Set(report.rows.map((row) => row.strictSameRunIssue).filter(Boolean))]
        .sort()
        .map((reason) => [reason, report.rows.filter((row) => row.strictSameRunIssue === reason).length]),
    ),
    note: 'Qualified forecast disagreements remain visible; they are not same-run comparisons or observation errors.',
  };
  report.bySite = grouped(report.rows, ['cohort', 'site', 'model', 'field', 'unit']);
  report.byLead = grouped(report.rows, ['cohort', 'model', 'leadBucket', 'field', 'unit']);
  report.byDay = grouped(report.rows, ['cohort', 'localDate', 'model', 'field', 'unit']);
  report.byRegion = grouped(report.rows, ['cohort', 'region', 'model', 'field', 'unit']);
  report.largestDifferences = Object.fromEntries(
    [...new Set(report.rows.map((r) => r.field))].map((f) => [
      f,
      report.rows
        .filter((r) => r.field === f)
        .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
        .slice(0, 5),
    ]),
  );
  const focus = new Set([
    'wa-blanchard',
    'wa-tiger-mountain',
    'wa-rampart-ridge',
    ...Object.values(report.largestDifferences)
      .flat()
      .map((r) => r.site),
  ]);
  report.focusSites = [...focus];
  const views = await auditPublishedViews(root, snapshot, profiles, focus);
  report.rendererAudit = views.rendererAudit;
  report.regionalAudit = views.regionalAudit;
  report.coverage.push(...views.coverage);
  const observations = [],
    rejected = [];
  for (const pair of MATCHED_RAOB_SITE_PAIRS) {
    const entry = snapshot.auxiliary.find(
      (e) => e.kind === 'raob-profile' && e.url.endsWith(`/sites/${pair.siteSlug}.json`) && ok(e),
    );
    if (!entry) continue;
    const raob = await jsonOf(root, entry);
    for (const item of profiles.filter((p) => p.profile.site.id === pair.siteSlug && p.eligible))
      for (const time of new Set(
        (raob.soundings ?? [])
          .filter((s) => Date.parse(s.validAt) >= from && Date.parse(s.validAt) <= Date.parse(snapshot.startedAt))
          .map((s) => s.validAt),
      )) {
        const result = compareRaobProfile(raob, item.profile, pair, time);
        if (result?.matched)
          observations.push({
            ...result,
            cohort: item.cohort,
            revision: item.revision ?? null,
            evidence: { ours: item.entry.sha256, observation: entry.sha256 },
          });
        else
          rejected.push({
            site: pair.siteSlug,
            model: item.profile.model,
            validAt: time,
            reason: result?.matchReason ?? 'no eligible observation/time/location match',
          });
      }
  }
  report.observations = {
    evaluatorVersion: EVALUATOR_VERSION,
    revisionPolicy: 'first-issued for retained history; latest-live separately labeled',
    summary: summarizeVerifications(observations),
    comparisons: observations,
    rejected,
    byCohort: Object.fromEntries(
      ['latest-live', 'retained-issued-archive'].map((c) => [
        c,
        summarizeVerifications(observations.filter((o) => o.cohort === c)),
      ]),
    ),
    limitation:
      'RAOB checks temperature, moisture and winds; does not directly verify thermal W*, lift ceilings or WxToFly model skill.',
  };
  report.methodAuditSummary = {
    checks: report.methodAudit.length,
    failures: report.methodAudit.filter((c) => !c.pass).length,
  };
  await inventoryCoverage(root, snapshot, report);
  buildCases(report, profiles, snapshot);
  report.gridMetadata = snapshot.catalogue.models.map((m) => ({
    model: m.slug,
    gridKm: m.gridKm,
    stepHours: m.stepHours,
    capabilities: m.capabilities,
  }));
  report.browserAudit = [];
  if (inspection) {
    const raw = await readFile(resolve(inspection));
    report.inspectionSha256 = sha256(raw);
    report.inspection = JSON.parse(raw);
    for (const e of report.inspection.resources ?? []) await bytesOf(root, e);
    report.evidence.push(...(report.inspection.resources ?? []));
    for (const observation of report.inspection.browser ?? []) {
      const item = profiles.find(
        (p) =>
          p.cohort === 'latest-live' &&
          p.profile.model === observation.model &&
          p.profile.site.id === observation.site &&
          p.profile.run.referenceTime === observation.referenceTime,
      );
      const hour = item?.profile.hours.find((h) => hourKey(h.validAt) === hourKey(observation.validAt));
      for (const v of observation.readings) {
        const [group, key] = v.field.split('.'),
          actual = scalar(hour?.[group]?.[key]);
        report.browserAudit.push({
          ...observation,
          readings: undefined,
          ...v,
          published: actual,
          pass: actual !== null && Math.abs(actual - v.siValue) <= v.tolerance,
          evidence: { browser: observation.evidence, profile: item?.entry.sha256 ?? null },
        });
      }
    }
  }
  report.findings = buildFindings(report, snapshot);
  report.coverageCounts = Object.fromEntries(
    [...new Set(report.coverage.map((c) => c.status))]
      .sort()
      .map((s) => [s, report.coverage.filter((c) => c.status === s).length]),
  );
  report.archiveCoverage = {
    from: new Date(from).toISOString(),
    to: snapshot.startedAt,
    runs: snapshot.archives.map((a) => ({
      model: a.model,
      referenceTime: a.referenceTime,
      revision: a.revisionId,
      profiles: a.profiles.length,
    })),
    wxArchive: snapshot.wxArchive,
    gaps: snapshot.gaps,
  };
  const destination = resolve(output ?? join(root, 'report'));
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
