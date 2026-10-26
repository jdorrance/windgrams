import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginCapture, finishCapture, makeRequests, profileUrl, recordFailure, recordResponse } from './capture.mjs';
import { parsePointcast } from './schema.mjs';
import { sha256 } from '../evidence-store.mjs';

const selectedAt = '2026-10-25T18:00:00Z';
const site = (slug, index = 0) => ({
  slug,
  name: slug,
  latitude: 35 + index / 100,
  longitude: slug.startsWith('am-') ? 44 + index / 100 : -120 + index / 100,
  timeZone: slug.startsWith('am-') ? 'Asia/Yerevan' : 'America/Los_Angeles',
});
const baseline = (sites) => ({
  schemaVersion: 1,
  sites,
  matches: sites.map((value, index) => ({
    site: value,
    status: index < 35 ? 'matched' : 'outside-shared-coverage',
  })),
});
const response = () => ({
  status: 1,
  epochs: [1792864800, 1792868400],
  minheight: 100,
  ninterval: 150,
  level_interval: 150,
  u: [
    [10, 20],
    [20, 30],
  ],
  v: [
    [30, 40],
    [40, 50],
  ],
  tmps: [
    [150, 140],
    [160, 150],
  ],
  elevs: [10, 10],
  tmp2m: [150, 160],
  u10m: [10, 20],
  v10m: [30, 40],
  na: [],
});

async function temporaryCapture(t, source = baseline([site('wa-blanchard')])) {
  const directory = await mkdtemp(join(tmpdir(), 'xcskies-capture-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baselineRoot = join(directory, 'baseline'),
    root = join(directory, 'supplement');
  await mkdir(baselineRoot);
  const sourceBytes = JSON.stringify(source, null, 2) + '\n';
  await writeFile(join(baselineRoot, 'snapshot.json'), sourceBytes);
  const plan = await beginCapture({ baseline: baselineRoot, output: root, selectedAt });
  return { directory, baselineRoot, root, plan, sourceBytes };
}
async function journal(root) {
  return (await readFile(join(root, 'responses.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
}

test('plans 335 unique observed model/location requests from the 125-site frozen scope', () => {
  const sites = [
    site('wa-blanchard'),
    site('wa-tiger-mountain', 1),
    site('wa-rampart-ridge', 2),
    ...Array.from({ length: 82 }, (_, index) => site(`wa-launch-${index}`, index + 3)),
    ...Array.from({ length: 40 }, (_, index) => site(`am-launch-${index}`, index + 85)),
  ];
  const source = baseline(sites),
    before = structuredClone(source),
    requests = makeRequests(source, { selectedAt });
  assert.deepEqual(source, before);
  assert.equal(requests.length, 335);
  assert.equal(new Set(requests.map((request) => request.id)).size, 335);
  assert.equal(new Set(requests.map((request) => request.url)).size, 335);
  assert.deepEqual(
    Object.fromEntries(
      ['gfs', 'hrrr', 'rrfs', 'iconeu'].map((model) => [
        model,
        requests.filter((request) => request.model === model).length,
      ]),
    ),
    { gfs: 125, hrrr: 85, rrfs: 85, iconeu: 40 },
  );
  const pairs = { gfs: 'gfs', hrrr: 'hrrr-conus', rrfs: 'rrfs', iconeu: 'icon-eu' };
  for (const request of requests) {
    const original = sites.find((value) => value.slug === request.site.slug),
      url = new URL(request.url);
    assert.equal(request.ourModel, pairs[request.model]);
    assert.equal(Number(url.searchParams.get('lat')), original.latitude);
    assert.equal(Number(url.searchParams.get('lon')), original.longitude);
    assert.equal(request.sharedWithWxToFly, sites.indexOf(original) < 35);
    assert.equal(request.backdays, 1);
  }
  assert.deepEqual(
    new Set(requests.slice(0, 9).map((request) => request.site.slug)),
    new Set(['wa-blanchard', 'wa-tiger-mountain', 'wa-rampart-ridge']),
  );
});

test('uses an exact UTC anchor and observed one-day history URL; rejects unsupported requests', () => {
  const args = { model: 'gfs', latitude: 48.6097, longitude: -122.426, selectedAt };
  assert.equal(
    profileUrl(args),
    'https://n1.xcskies.com/profile/gfs/20261025/18/00?lat=48.6097&lon=-122.426&backdays=1',
  );
  assert.equal(profileUrl({ ...args, selectedAt: '2026-10-25T14:00:00-04:00' }), profileUrl(args));
  for (const invalid of [
    { selectedAt: '2026-10-25T18:01:00Z' },
    { selectedAt: '2026-10-25T18:00:01Z' },
    { selectedAt: '2026-10-25T18:00:00.001Z' },
    { selectedAt: 'not-a-date' },
    { selectedAt: '2026-10-25T18:00:00' },
    { model: 'unobserved-model' },
    { latitude: 91 },
    { longitude: Infinity },
    { backdays: 2 },
  ])
    assert.throws(() => profileUrl({ ...args, ...invalid }));
});

test('freezes baseline identity and prevents replacement of an existing capture plan', async (t) => {
  const { root, baselineRoot, plan, sourceBytes } = await temporaryCapture(t);
  assert.equal(plan.baseline.sha256, sha256(sourceBytes));
  assert.equal(await readFile(join(baselineRoot, 'snapshot.json'), 'utf8'), sourceBytes);
  const frozenPlan = await readFile(join(root, 'plan.json'), 'utf8');
  await assert.rejects(beginCapture({ baseline: baselineRoot, output: root, selectedAt }), { code: 'EEXIST' });
  assert.equal(await readFile(join(root, 'plan.json'), 'utf8'), frozenPlan);
});

test('stores only JSON response text and allowlisted metadata, never transport credentials', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    request = plan.requests[0];
  const text = JSON.stringify(response());
  const entry = await recordResponse(root, request, {
    text,
    finalUrl: request.url,
    retrievedAt: '2026-10-25T19:00:00Z',
    headers: { authorization: 'FAKE_AUTH_MARKER' },
    cookies: 'FAKE_COOKIE_MARKER',
    credentials: 'FAKE_CREDENTIAL_MARKER',
    account: 'FAKE_ACCOUNT_MARKER',
  });
  assert.equal(await readFile(join(root, entry.file), 'utf8'), text);
  assert.equal(entry.sha256, sha256(text));
  assert.equal(entry.bytes, Buffer.byteLength(text));
  assert.equal(entry.referenceTime, null);
  assert.equal(entry.httpStatus, null);
  assert.equal(entry.completeSurfaceColumns, true);
  const records = await journal(root);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], entry);
  for (const name of ['plan.json', 'responses.ndjson', entry.file])
    assert.doesNotMatch(await readFile(join(root, name), 'utf8'), /FAKE_(AUTH|COOKIE|CREDENTIAL|ACCOUNT)_MARKER/);
});

test('rejects mismatched URLs and non-JSON documents before recording an evidence object', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    request = plan.requests[0];
  await assert.rejects(
    recordResponse(root, request, { text: JSON.stringify(response()), finalUrl: request.url + '&other=1' }),
    /Response URL differs/,
  );
  await assert.rejects(
    recordResponse(root, request, { text: '<html>Sign in</html>', finalUrl: request.url }),
    /not JSON/,
  );
  assert.deepEqual(await readdir(join(root, 'objects')), []);
  await assert.rejects(readFile(join(root, 'responses.ndjson')), { code: 'ENOENT' });
});

test('preserves truncated responses as evidence while the scientific schema rejects them', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    request = plan.requests[0],
    raw = response();
  for (const key of ['u', 'v', 'tmps', 'elevs', 'tmp2m', 'u10m', 'v10m']) raw[key].pop();
  const text = JSON.stringify(raw),
    entry = await recordResponse(root, request, { text, finalUrl: request.url });
  assert.equal(entry.hourCount, 2);
  assert.equal(entry.completeSurfaceColumns, false);
  assert.equal(await readFile(join(root, entry.file), 'utf8'), text);
  assert.throws(
    () => parsePointcast(raw, { model: request.model, ...request.site, sourceUrl: request.url }),
    /1 columns for 2 epochs/,
  );
});

test('completion requires every primary request, including explicit failures, and cannot overwrite a snapshot', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    [first, second, third] = plan.requests;
  await recordResponse(root, first, { text: JSON.stringify(response()), finalUrl: first.url });
  await recordResponse(root, second, { text: JSON.stringify(response()), finalUrl: second.url, role: 'check' });
  await assert.rejects(finishCapture(root), /pending requests/);
  await recordFailure(root, second, 'Provider unavailable');
  await assert.rejects(finishCapture(root), /pending requests/);
  await recordFailure(root, third, 'Delivery failed');
  const snapshot = await finishCapture(root),
    frozen = await readFile(join(root, 'snapshot.json'), 'utf8');
  assert.equal(snapshot.responses.length, 4);
  assert.equal(snapshot.requests.length, 3);
  assert.ok(snapshot.completedAt);
  await assert.rejects(finishCapture(root), { code: 'EEXIST' });
  await assert.rejects(recordFailure(root, first, 'Too late'), /complete/);
  await assert.rejects(recordResponse(root, first, { text: '{}', finalUrl: first.url }), /complete/);
  assert.equal(await readFile(join(root, 'snapshot.json'), 'utf8'), frozen);
});

test('capture completion rejects unplanned requests, ambiguous primaries and altered evidence', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    [first, ...rest] = plan.requests;
  await assert.rejects(finishCapture(root), /pending/);
  await assert.rejects(recordFailure(root, { ...first, id: 'other' }, 'No'), /outside the frozen/);
  const entry = await recordResponse(root, first, { text: JSON.stringify(response()), finalUrl: first.url });
  for (const request of rest) await recordFailure(root, request, 'Unavailable');
  await writeFile(join(root, entry.file), '{}');
  await assert.rejects(finishCapture(root), /hash mismatch/);
  await writeFile(join(root, entry.file), JSON.stringify(response()));
  await recordFailure(root, first, 'Duplicate primary');
  await assert.rejects(finishCapture(root), /ambiguous primary/);
});

test('malformed epoch metadata is preserved without claiming valid times', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    request = plan.requests[0];
  const entry = await recordResponse(root, request, { text: '{"epochs":["bad",1e100]}', finalUrl: request.url });
  assert.equal(entry.hourCount, 2);
  assert.equal(entry.firstValidAt, null);
  assert.equal(entry.lastValidAt, null);
});

test('journals transport errors with request identity and bounded messages without inventing response evidence', async (t) => {
  const { root, plan } = await temporaryCapture(t),
    request = plan.requests[0];
  const entry = await recordFailure(root, request, new Error('Request interrupted: ' + 'x'.repeat(400)));
  assert.equal(entry.id, request.id);
  assert.equal(entry.url, request.url);
  assert.equal(entry.role, 'primary');
  assert.equal(entry.error.length, 300);
  assert.match(entry.error, /^Error: Request interrupted:/);
  assert.equal(entry.file, undefined);
  assert.equal(entry.sha256, undefined);
  assert.deepEqual(await journal(root), [entry]);
  assert.deepEqual(await readdir(join(root, 'objects')), []);
});
