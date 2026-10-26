import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertBody, fingerprintChecks, planAlertAction } from './report-served-failure.mjs';
import { rollbackEligible } from './monitor-served.mjs';

const failing = { ok: false, checkedAt: '2026-10-26T12:00:00Z', baseUrl: 'https://example.invalid/data', rollbackEligible: false,
  checks: [{ product: 'gfs', kind: 'point', status: 'stale', ok: false, reason: 'old' }, { product: 'hrrr-conus', kind: 'point', status: 'current', ok: true, reason: '' }] };
const now = Date.parse('2026-10-26T12:00:00Z');

test('rollback eligibility separates corrupt bytes from staleness', () => {
  assert.equal(rollbackEligible([{ kind: 'point', status: 'unavailable' }]), true);
  assert.equal(rollbackEligible([{ kind: 'regional', status: 'unavailable' }]), true);
  assert.equal(rollbackEligible([{ kind: 'point', status: 'stale' }, { kind: 'refresh', status: 'unavailable' }]), false);
});

test('alert planner creates once, suppresses repeats, comments on change, closes on recovery', () => {
  assert.deepEqual(planAlertAction({ report: failing, openIssue: null, now }), { action: 'create', fingerprint: 'gfs:point:stale' });
  const open = { number: 7, fingerprint: 'gfs:point:stale', lastCommentAt: '2026-10-26T11:00:00Z' };
  assert.equal(planAlertAction({ report: failing, openIssue: open, now }).action, 'none');
  const changed = { ...failing, checks: [...failing.checks, { product: 'rrfs', kind: 'point', status: 'unavailable', ok: false, reason: 'bad bytes' }] };
  assert.equal(planAlertAction({ report: changed, openIssue: open, now }).action, 'comment');
  const later = Date.parse('2026-10-27T12:00:01Z');
  assert.equal(planAlertAction({ report: failing, openIssue: open, now: later }).action, 'comment');
  assert.deepEqual(planAlertAction({ report: { ...failing, ok: true }, openIssue: open, now }), { action: 'close', issue: 7 });
  assert.deepEqual(planAlertAction({ report: { ...failing, ok: true }, openIssue: null, now }), { action: 'none' });
  assert.equal(fingerprintChecks(failing.checks), 'gfs:point:stale');
  assert.match(alertBody({ ...failing, rollbackEligible: true }, 'gfs:point:stale'), /previous complete publication/);
  assert.match(alertBody(failing, 'gfs:point:stale'), /cannot repair/);
});

function runAlertCli(t, { labels = [], createFailure = '', report = failing } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'served-alert-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, 'calls.jsonl');
  const state = join(root, 'labels.json');
  const reportPath = join(root, 'report.json');
  writeFileSync(log, '');
  writeFileSync(state, JSON.stringify(labels));
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(join(root, 'gh'), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.ALERT_TEST_LOG, JSON.stringify(args) + '\\n');
const labels = JSON.parse(readFileSync(process.env.ALERT_TEST_LABELS, 'utf8'));
if (args[0] === 'api') {
  console.log(labels.map(label => label.name).join('\\n'));
} else if (args[0] === 'label' && args[1] === 'create') {
  if (process.env.ALERT_TEST_CREATE_FAILURE !== 'permission') {
    labels.push({ name: args[2], color: args[args.indexOf('--color') + 1], description: args[args.indexOf('--description') + 1] });
    writeFileSync(process.env.ALERT_TEST_LABELS, JSON.stringify(labels));
  }
  if (process.env.ALERT_TEST_CREATE_FAILURE) {
    console.error(process.env.ALERT_TEST_CREATE_FAILURE);
    process.exitCode = 1;
  }
} else if (args[0] === 'issue' && args[1] === 'list') {
  console.log('[]');
} else if (args[0] === 'issue' && args[1] === 'create') {
  if (!labels.some(label => label.name.toLowerCase() === 'served-data')) {
    console.error('missing label');
    process.exitCode = 1;
  }
} else {
  console.error('Unexpected gh call: ' + args.join(' '));
  process.exitCode = 1;
}
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./report-served-failure.mjs', import.meta.url)), '--report', reportPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, ALERT_TEST_LOG: log, ALERT_TEST_LABELS: state, ALERT_TEST_CREATE_FAILURE: createFailure },
  });
  return {
    ...result,
    calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    labels: JSON.parse(readFileSync(state, 'utf8')),
  };
}

test('alert CLI creates a missing label before opening an issue', t => {
  const unrelated = { name: 'served-data-old', color: '123456', description: 'Keep this label' };
  const result = runAlertCli(t, { labels: [unrelated] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(args => args.slice(0, 2)), [['issue', 'list'], ['api', '--paginate'], ['label', 'create'], ['issue', 'create']]);
  assert.deepEqual(result.labels[0], unrelated);
  assert.equal(result.labels[1].name, 'served-data');
});

test('alert CLI preserves an existing label', t => {
  const label = { name: 'Served-Data', color: '123456', description: 'Custom description' };
  const result = runAlertCli(t, { labels: [label] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.labels, [label]);
  assert.ok(result.calls.some(args => args[0] === 'issue' && args[1] === 'create'));
  assert.ok(result.calls.every(args => args[0] !== 'label'));
});

test('alert CLI tolerates simultaneous label creation', t => {
  const result = runAlertCli(t, { createFailure: 'already exists' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter(args => args[0] === 'api').length, 2);
  assert.equal(result.calls.at(-1)[1], 'create');
  assert.equal(result.calls.at(-1)[0], 'issue');
});

test('alert CLI propagates label creation failures before opening an issue', t => {
  const result = runAlertCli(t, { createFailure: 'permission' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /permission/);
  assert.ok(result.calls.every(args => args[0] !== 'issue' || args[1] !== 'create'));
});

test('passing report does not create a label or issue', t => {
  const result = runAlertCli(t, { report: { ...failing, ok: true } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(args => args.slice(0, 2)), [['issue', 'list']]);
});
