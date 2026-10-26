// Turns a served-data monitor report into at most one tracked alert issue.
// Dedup contract: one open issue labelled `served-data`; its fingerprint is the
// sorted set of failing `product:kind:status` entries. A comment is added only
// when the fingerprint changes or 24 h passed since the last alert comment;
// a passing report closes the issue. The planner is pure so it is unit-tested;
// the CLI is a thin `gh` shell around it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ALERT_LABEL = 'served-data';
export const COMMENT_INTERVAL_MS = 24 * 3_600_000;

export function fingerprintChecks(checks) {
  return checks.filter(check => !check.ok).map(check => `${check.product}:${check.kind}:${check.status}`).sort().join('\n');
}

/**
 * Decide the alert action. `openIssue` is { number, fingerprint, lastCommentAt }
 * for the currently open served-data issue, or null. Returns an action object;
 * `none` means stay silent (identical failure recently reported).
 */
export function planAlertAction({ report, openIssue, now = Date.now() }) {
  if (report.ok) return openIssue ? { action: 'close', issue: openIssue.number } : { action: 'none' };
  const fingerprint = fingerprintChecks(report.checks ?? []);
  if (!openIssue) return { action: 'create', fingerprint };
  if (openIssue.fingerprint !== fingerprint) return { action: 'comment', issue: openIssue.number, fingerprint, reason: 'changed' };
  if (now - Date.parse(openIssue.lastCommentAt ?? '') >= COMMENT_INTERVAL_MS) return { action: 'comment', issue: openIssue.number, fingerprint, reason: 'reminder' };
  return { action: 'none', fingerprint };
}

export function alertBody(report, fingerprint) {
  const failing = (report.checks ?? []).filter(check => !check.ok);
  return [
    `Served-data check failed at ${report.checkedAt} for ${report.baseUrl}.`,
    '',
    ...failing.map(check => `- ${check.product} (${check.kind}): ${check.status}${check.reason ? ` — ${check.reason}` : ''}`),
    '',
    report.rollbackEligible
      ? 'Served bytes are invalid or unavailable: republishing the previous complete publication can repair this. See "Recover the previous complete publication" in forecasts/docs/operations.md.'
      : 'This is a freshness/cadence failure: republishing older data cannot repair it; check provider refreshes and scheduler delivery.',
    '',
    `Fingerprint: ${fingerprint.split('\n').join(', ')}`,
  ].join('\n');
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, env: process.env }).trim();
}

function currentOpenIssue() {
  const raw = gh(['issue', 'list', '--label', ALERT_LABEL, '--state', 'open', '--json', 'number,body,comments', '--limit', '5']);
  const issues = JSON.parse(raw || '[]');
  if (!issues.length) return null;
  const issue = issues[0];
  const fingerprint = /Fingerprint: (.+)/.exec(issue.body ?? '')?.[1]?.split(', ').join('\n') ?? '';
  const comments = [...(issue.comments ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { number: issue.number, fingerprint, lastCommentAt: comments[0]?.createdAt ?? null };
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: 'string' }, resolve: { type: 'boolean', default: false } } });
  if (!values.report) throw new Error('Use --report served-report.json [--resolve]');
  const report = JSON.parse(readFileSync(values.report, 'utf8'));
  const openIssue = currentOpenIssue();
  const plan = planAlertAction({ report, openIssue });
  if (plan.action === 'create') {
    gh(['issue', 'create', '--label', ALERT_LABEL, '--title', 'Served data check failing', '--body', alertBody(report, plan.fingerprint)]);
    console.log('Opened served-data alert issue.');
  } else if (plan.action === 'comment') {
    gh(['issue', 'comment', String(plan.issue), '--body', alertBody(report, plan.fingerprint)]);
    console.log(`Commented on served-data alert issue #${plan.issue} (${plan.reason}).`);
  } else if (plan.action === 'close' || (values.resolve && report.ok && openIssue)) {
    const number = plan.issue ?? openIssue.number;
    gh(['issue', 'close', String(number), '--comment', `Served-data check passing again at ${report.checkedAt}.`]);
    console.log(`Closed served-data alert issue #${number}.`);
  } else {
    console.log('No alert action (unchanged failure already reported, or no open issue).');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
