import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPARISON_FIELDS,
  compareProfiles,
  compareReview,
  interpolateAboveGround,
  parseRuntimeMetadata,
  summarizeRows,
} from './compare.mjs';
import { parsePointcast } from './schema.mjs';
import { sha256 } from '../evidence-store.mjs';

const validAt = '2026-10-24T21:00:00Z';
const site = {
  slug: 'wa-blanchard',
  name: 'Blanchard',
  latitude: 48.6097,
  longitude: -122.426,
  timeZone: 'America/Los_Angeles',
};
const request = {
  id: 'wa-blanchard:rrfs',
  site,
  model: 'rrfs',
  ourModel: 'rrfs',
  selectedAt: '2026-10-25T18:00:00Z',
  url: 'https://n1.xcskies.com/profile/rrfs/20261025/18/00?lat=48.6097&lon=-122.426&backdays=1',
};
const response = { retrievedAt: '2026-10-25T19:00:00Z' };
const components = (speed, direction) => ({
  windUMps: -speed * Math.sin((direction * Math.PI) / 180),
  windVMps: -speed * Math.cos((direction * Math.PI) / 180),
});
const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should equal ${expected}`);

function fixtures() {
  const profile = {
    schemaVersion: 1,
    model: 'rrfs',
    site: { id: site.slug, ...site, modelElevationM: 100 },
    run: { referenceTime: '2026-10-24T18:00:00Z' },
    hours: [
      {
        validAt,
        levels: [{ heightM: 250, temperatureC: 13.5, windSpeedMps: 10, windDirectionDeg: 0 }],
        surface: { temperatureC: 20, dewPointC: 10 },
        soaring: {
          hcritWxtoflyM: 450,
          usableLiftTopV2M: 500,
          resolvedThermalTopM: 550,
          surfaceLclM: 650,
          thermalVelocityV2Mps: 2,
          mixedLayerLclM: 700,
        },
      },
    ],
  };
  const raw = {
    status: 1,
    epochs: [Date.parse(validAt) / 1000],
    minheight: 100,
    ninterval: 100,
    level_interval: 100,
    u: [[0, 0, 0, 0]],
    v: [[-100, -100, -100, -100]],
    tmps: [[150, 140, 130, 120]],
    elevs: [15],
    vtops: [40],
    bltops: [50],
    dptops: [60],
    cutops: [70],
    vels: [[0, 10, 20, 0]],
    dps: [[-30, -20, -10, 0]],
    tmp2m: [200],
    u10m: [0],
    v10m: [-100],
    na: [],
  };
  const xc = parsePointcast(raw, { model: request.model, latitude: site.latitude, longitude: site.longitude });
  return { profile, raw, xc };
}

test('matches exact heights or adjacent brackets only within the range strictly above both grounds', () => {
  const levels = [
    { heightM: 100, temperatureC: 20 },
    { heightM: 200, temperatureC: 10 },
    { heightM: 300, temperatureC: 0 },
  ];
  assert.deepEqual(interpolateAboveGround(levels, 200, 150, ['temperatureC']), {
    values: { temperatureC: 10 },
    bracketM: [200, 200],
    weight: 0,
  });
  assert.deepEqual(interpolateAboveGround(levels, 250, 150, ['temperatureC']), {
    values: { temperatureC: 5 },
    bracketM: [200, 300],
    weight: 0.5,
  });
  for (const height of [50, 150, 175, 350])
    assert.equal(interpolateAboveGround(levels, height, 150, ['temperatureC']), null);
  assert.equal(
    interpolateAboveGround(levels, 250, 200, ['temperatureC']),
    null,
    'a bracket endpoint at the higher ground is inadmissible',
  );
  assert.equal(interpolateAboveGround(levels, 250, null, ['temperatureC']), null);
  assert.equal(
    interpolateAboveGround([...levels, levels[1]], 250, 150, ['temperatureC']),
    null,
    'duplicate heights have ambiguous brackets',
  );
});

test('does not bridge explicit missing samples inside a profile', () => {
  for (const missing of [null, undefined]) {
    const levels = [
      { heightM: 100, temperatureC: 10 },
      { heightM: 200, temperatureC: missing },
      { heightM: 300, temperatureC: 0 },
    ];
    for (const height of [150, 200, 250])
      assert.equal(interpolateAboveGround(levels, height, 0, ['temperatureC']), null);
    assert.equal(interpolateAboveGround(levels, 300, 0, ['temperatureC']).values.temperatureC, 0);
  }
  const grids = [
    { heightM: 100, temperatureC: 10 },
    { heightM: 150, windUMps: 2, windVMps: 3 },
    { heightM: 200, temperatureC: 0 },
  ];
  assert.equal(
    interpolateAboveGround(grids, 150, 0, ['temperatureC']).values.temperatureC,
    5,
    'a height belonging only to the wind grid does not create a missing native temperature sample',
  );
});

test('uses the higher terrain for comparison and excludes unavailable or out-of-range levels', () => {
  const { profile, xc } = fixtures();
  profile.hours[0].levels = [100, 150, 175, 200, 250, 450].map((heightM) => ({
    heightM,
    temperatureC: 13.5,
    windSpeedMps: 10,
    windDirectionDeg: 0,
  }));
  const result = compareProfiles(profile, xc, { request, response });
  assert.deepEqual(
    result.rows.filter((row) => row.field === 'temperature').map((row) => row.heightM),
    [200, 250],
  );
  assert.equal(result.hourPairs[0].terrainDifferenceM, -50);
  assert.deepEqual(
    result.rows.find((row) => row.field === 'temperature' && row.heightM === 250).xcBracketM,
    [200, 300],
  );
  assert.equal(result.exclusions.filter((row) => row.reason === 'level-at-or-below-either-ground').length, 2);
  xc.hours[0].modelElevationM = null;
  const missingGround = compareProfiles(profile, xc, { request, response });
  assert.equal(missingGround.rows.filter((row) => row.category === 'atmosphere').length, 0);
  assert.ok(missingGround.exclusions.some((row) => row.reason === 'ground-reference-missing'));
});

test('wind vector distance handles 359° versus 1° and interpolation averages components', () => {
  const { profile, xc } = fixtures();
  profile.hours[0].levels = [{ heightM: 200, temperatureC: 14, windSpeedMps: 10, windDirectionDeg: 359 }];
  Object.assign(xc.hours[0].levels[1], components(10, 1));
  const result = compareProfiles(profile, xc, { request, response });
  near(result.rows.find((row) => row.field === 'windVector').difference, 20 * Math.sin(Math.PI / 180));
  near(result.rows.find((row) => row.field === 'windSpeed').difference, 0);
  profile.hours[0].levels[0] = { heightM: 250, temperatureC: 13.5, windSpeedMps: 10, windDirectionDeg: 0 };
  Object.assign(xc.hours[0].levels[1], components(10, 359));
  Object.assign(xc.hours[0].levels[2], components(10, 1));
  const interpolated = compareProfiles(profile, xc, { request, response });
  const speed = interpolated.rows.find((row) => row.field === 'windSpeed');
  near(speed.xc, 10 * Math.cos(Math.PI / 180));
  near(speed.vectorComponents.xc.u, 0);
  assert.ok(speed.vectorComponents.xc.v < -9.99);
});

test('requires exact UTC overlap and valid nonnegative Windgrams leads', () => {
  const { profile, xc } = fixtures();
  xc.hours[0].validAt = '2026-10-24T21:01:00Z';
  const noOverlap = compareProfiles(profile, xc, { request, response });
  assert.equal(noOverlap.rows.length, 0);
  assert.equal(noOverlap.exclusions[0].reason, 'no-exact-UTC-overlap');
  xc.hours[0].validAt = '2026-10-24T21:00:00.000Z';
  profile.run.referenceTime = '2026-10-24T22:00:00Z';
  assert.equal(compareProfiles(profile, xc, { request, response }).exclusions[0].reason, 'invalid-Windgrams-lead');
});

test('keeps unequal lift and condensation definitions outside atmospheric scores', () => {
  const { profile, xc } = fixtures(),
    result = compareProfiles(profile, xc, { request, response });
  assert.deepEqual(
    new Set(result.rows.filter((row) => row.category === 'atmosphere').map((row) => row.field)),
    new Set(['temperature', 'windSpeed', 'windVector']),
  );
  for (const field of ['lift225', 'lift1', 'thermalTop', 'cloudBase'])
    assert.equal(result.rows.find((row) => row.field === field).category, 'method-sensitive');
  assert.match(COMPARISON_FIELDS.find((field) => field.id === 'lift225').qualification, /1\.143.*1\.2/);
  assert.match(COMPARISON_FIELDS.find((field) => field.id === 'cloudBase').qualification, /LCL.*CCL/);
  assert.ok(
    !result.rows.some((row) => /dewPoint|thermalVelocity|parcelVelocity|surfaceTemperature|mixedLcl/i.test(row.field)),
  );
  assert.equal(result.rows.find((row) => row.field === 'lift225').difference, 50);
  assert.equal(result.rows.find((row) => row.field === 'cloudBase').difference, 50);
});

test('changed or stable runtime routing never substitutes for PointCast initialization', () => {
  const { profile, xc } = fixtures(),
    key = `rrfs:${Date.parse(validAt) / 1000}`;
  const routing = (referenceTime, suffix) => ({
    entry: { sha256: suffix.repeat(64), retrievedAt: `2026-10-25T19:0${suffix === 'a' ? 0 : 1}:00Z` },
    index: new Map([[key, { referenceTime, state: 1 }]]),
  });
  const before = routing('2026-10-24T12:00:00.000Z', 'a'),
    after = routing('2026-10-24T18:00:00.000Z', 'b');
  let hour = compareProfiles(profile, xc, { request, response, runtimeMetadata: [before, after] }).hourPairs[0];
  assert.equal(hour.xcRouting.status, 'changed-during-capture');
  assert.equal(hour.xcRouting.referenceTime, null);
  assert.equal(hour.xcReferenceTime, null);
  assert.equal(hour.xcLeadHours, null);
  assert.equal(hour.xcTimeClass, 'retrospectively-retrieved');
  hour = compareProfiles(profile, xc, {
    request,
    response,
    runtimeMetadata: [before, routing(before.index.get(key).referenceTime, 'b')],
  }).hourPairs[0];
  assert.equal(hour.xcRouting.status, 'unchanged-routing-metadata');
  assert.equal(hour.xcReferenceTime, null);
  assert.equal(hour.xcLeadHours, null);
  assert.match(hour.xcRouting.interpretation, /not verified/);
});

test('agreeing runtime captures after a response do not bracket that response', () => {
  const { profile, xc } = fixtures(),
    key = `rrfs:${Date.parse(validAt) / 1000}`;
  const runtimeMetadata = ['2026-10-25T19:01:00Z', '2026-10-25T19:02:00Z'].map((retrievedAt, index) => ({
    entry: { retrievedAt, sha256: String(index).repeat(64) },
    index: new Map([[key, { referenceTime: '2026-10-24T18:00:00.000Z', state: 1 }]]),
  }));
  const hour = compareProfiles(profile, xc, { request, response, runtimeMetadata }).hourPairs[0];
  assert.equal(hour.xcRouting.status, 'not-bracketed');
  assert.equal(hour.xcRouting.bracketed, false);
  assert.equal(hour.xcRouting.routingTimesAgree, true);
  assert.equal(hour.xcReferenceTime, null);
  assert.equal(hour.xcLeadHours, null);
});

test('parses runtime JSONP as data and rejects executable or unexpected wrappers', () => {
  const payload = { runtimes: { rrfs: [{ epoch: Date.parse(validAt) / 1000, zday: '20261024', zrun: 12 }] } };
  assert.deepEqual(parseRuntimeMetadata(`d3.jsonp.capture(${JSON.stringify(payload)});`), payload.runtimes);
  for (const text of [
    `other.callback(${JSON.stringify(payload)});`,
    `d3.jsonp.capture(${JSON.stringify(payload)}); globalThis.executed = true;`,
    'd3.jsonp.capture({runtimes: (() => {})()});',
    'd3.jsonp.capture({"notRuntimes":{}});',
  ])
    assert.throws(() => parseRuntimeMetadata(text));
});

test('summaries separate differences and dependent coverage counts', () => {
  const rows = [-2, 0, 4].map((difference, index) => ({
    difference,
    site: 'a',
    localDate: '2026-10-24',
    validAt: index < 2 ? validAt : '2026-10-24T22:00:00Z',
  }));
  const summary = summarizeRows(rows);
  assert.equal(summary.count, 3);
  near(summary.meanDifference, 2 / 3);
  assert.equal(summary.meanAbsoluteDifference, 2);
  assert.equal(summary.medianAbsoluteDifference, 2);
  assert.equal(summary.maximumAbsoluteDifference, 4);
  assert.equal(summary.distinctSiteDays, 1);
  assert.equal(summary.distinctHours, 2);
  assert.match(summary.note, /dependent/);
  assert.equal(summarizeRows([]).meanDifference, null);
});

async function frozenReview(t) {
  const directory = await mkdtemp(join(tmpdir(), 'xcskies-compare-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baselineRoot = join(directory, 'baseline'),
    root = join(directory, 'xc');
  await Promise.all([
    mkdir(join(baselineRoot, 'objects'), { recursive: true }),
    mkdir(join(root, 'objects'), { recursive: true }),
  ]);
  const save = async (destination, data, url) => {
    const text = JSON.stringify(data),
      hash = sha256(text),
      file = `objects/${hash}`;
    await writeFile(join(destination, file), text);
    return { file, sha256: hash, bytes: Buffer.byteLength(text), status: 200, url };
  };
  const { profile, raw } = fixtures(),
    archived = structuredClone(profile);
  archived.run.referenceTime = '2026-10-23T18:00:00Z';
  const liveEntry = await save(baselineRoot, profile, 'https://example.test/rrfs/sites/wa-blanchard.json');
  const archiveEntry = await save(
    baselineRoot,
    archived,
    'archive:history/rrfs/20261023T180000Z/sites/wa-blanchard.json',
  );
  const baseline = {
    schemaVersion: 1,
    sites: [site],
    matches: [{ status: 'matched', site }],
    models: [{ slug: 'rrfs', stable: true, profiles: [{ site: site.slug, valid: true, entry: liveEntry }] }],
    archives: [
      {
        model: 'rrfs',
        referenceTime: archived.run.referenceTime,
        revisionId: 'first-issued',
        profiles: [{ site: site.slug, entry: archiveEntry }],
      },
    ],
  };
  const baselineText = JSON.stringify(baseline);
  await writeFile(join(baselineRoot, 'snapshot.json'), baselineText);
  const entry = {
    ...(await save(root, raw, request.url)),
    ...response,
    finalUrl: request.url,
    id: request.id,
    role: 'primary',
  };
  const snapshot = {
    schemaVersion: 1,
    startedAt: '2026-10-25T18:50:00Z',
    completedAt: '2026-10-25T19:01:00Z',
    baseline: { path: baselineRoot, sha256: sha256(baselineText) },
    requests: [request],
    responses: [entry],
    discovery: [],
  };
  await writeFile(join(root, 'snapshot.json'), JSON.stringify(snapshot));
  return { root, baselineRoot, entry, baselineText };
}

async function addEvidence(root, text, metadata) {
  const hash = sha256(text),
    file = `objects/${hash}`;
  await writeFile(join(root, file), text);
  return { file, sha256: hash, bytes: Buffer.byteLength(text), ...metadata };
}

async function addRepeat(root, entry, raw) {
  const snapshotPath = join(root, 'snapshot.json'),
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const repeated = await addEvidence(root, JSON.stringify(raw), {
    id: entry.id,
    role: 'check',
    url: entry.url,
    finalUrl: entry.finalUrl,
    retrievedAt: '2026-10-25T19:01:00Z',
  });
  snapshot.responses.push(repeated);
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  return repeated;
}

test('offline comparison is deterministic and keeps current versus first-issued archive cohorts', async (t) => {
  const { root, baselineRoot, baselineText } = await frozenReview(t);
  const first = await compareReview({ snapshot: root });
  const firstJson = await readFile(join(root, 'report/report.json'), 'utf8');
  const firstHtml = await readFile(join(root, 'report/index.html'), 'utf8');
  const second = await compareReview({ snapshot: root });
  assert.deepEqual(first, second);
  assert.equal(await readFile(join(root, 'report/report.json'), 'utf8'), firstJson);
  assert.equal(await readFile(join(root, 'report/index.html'), 'utf8'), firstHtml);
  assert.equal(await readFile(join(baselineRoot, 'snapshot.json'), 'utf8'), baselineText);
  assert.equal(first.sampleCounts.sitesPaired, 1);
  assert.equal(first.sampleCounts.hourPairs, 2);
  assert.deepEqual(new Set(first.rows.map((row) => row.cohort)), new Set(['latest-live', 'retained-issued-archive']));
  assert.equal(first.archiveCoverage[0].revision, 'first-issued');
  assert.equal(first.archiveCoverage[0].matchedHourPairs, 1);
  assert.ok(first.rows.every((row) => first.hourPairs.some((hour) => hour.id === row.hourPairId)));
});

test('offline comparison fails closed on modified forecast evidence or baseline identity', async (t) => {
  const { root, baselineRoot, entry, baselineText } = await frozenReview(t);
  const objectPath = join(root, entry.file),
    original = await readFile(objectPath, 'utf8');
  await writeFile(objectPath, original + ' ');
  await assert.rejects(compareReview({ snapshot: root }), /Evidence hash mismatch/);
  await writeFile(objectPath, original);
  await writeFile(join(baselineRoot, 'snapshot.json'), baselineText + ' ');
  await assert.rejects(compareReview({ snapshot: root }), /Baseline snapshot hash mismatch/);
});

test('repeat audit distinguishes reordered JSON bytes from changed forecast values', async (t) => {
  const { root, entry } = await frozenReview(t),
    raw = JSON.parse(await readFile(join(root, entry.file), 'utf8'));
  const repeated = await addRepeat(root, entry, Object.fromEntries(Object.entries(raw).reverse()));
  assert.notEqual(repeated.sha256, entry.sha256);
  const report = await compareReview({ snapshot: root }),
    check = report.coverage[0].repeatChecks[0];
  assert.equal(check.bytesChanged, true);
  assert.equal(check.valuesChanged, false);
  assert.equal(report.coverage[0].repeatedCaptureChanged, false);
  assert.equal(report.repeatAudit.checkedProducts, 1);
  assert.deepEqual(report.repeatAudit.byteChangedProducts, [request.id]);
  assert.deepEqual(report.repeatAudit.valueChangedProducts, []);
});

test('repeat audit reports changed fields and hours while keeping primary values in scores', async (t) => {
  const { root, entry } = await frozenReview(t);
  const before = await compareReview({ snapshot: root }),
    raw = JSON.parse(await readFile(join(root, entry.file), 'utf8'));
  raw.tmps[0][1] += 100;
  const repeat = await addRepeat(root, entry, raw),
    report = await compareReview({ snapshot: root });
  assert.deepEqual(report.rows, before.rows, 'repeat evidence must never replace the primary scoring input');
  const product = report.repeatAudit.valueChangedProducts[0],
    check = product.checks[0];
  assert.equal(product.requestId, request.id);
  assert.equal(product.primaryEvidence, entry.sha256);
  assert.equal(check.evidence, repeat.sha256);
  assert.equal(check.valuesChanged, true);
  assert.deepEqual(check.topLevelKeysChanged, ['tmps']);
  assert.equal(check.timelineChanged, false);
  assert.equal(check.changedHourCount, 1);
  assert.deepEqual(check.changedValidTimes, ['2026-10-24T21:00:00.000Z']);
  assert.deepEqual(check.byField, { tmps: 1 });
});

test('runtime audit separates age text from changed model cycles and readiness state', async (t) => {
  const { root } = await frozenReview(t),
    epoch = Date.parse(validAt) / 1000;
  const before = [0, 1, 2].map((index) => ({
    epoch: epoch + index * 3600,
    zday: '20261024',
    zrun: 12,
    state: index === 2 ? 0 : 1,
    updated: 'two hours ago',
  }));
  const after = structuredClone(before);
  for (const entry of after) entry.updated = 'three hours ago';
  after[1].zrun = 18;
  after[2].state = 1;
  const discovery = [];
  for (const [label, entries, retrievedAt] of [
    ['before', before, '2026-10-25T18:59:00Z'],
    ['after', after, '2026-10-25T19:01:00Z'],
  ])
    discovery.push(
      await addEvidence(root, `d3.jsonp.capture(${JSON.stringify({ runtimes: { rrfs: entries } })});`, {
        kind: `runtimes-${label}`,
        retrievedAt,
        url: `https://example.test/runtime-${label}`,
      }),
    );
  const snapshotPath = join(root, 'snapshot.json'),
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  snapshot.discovery = discovery;
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const report = await compareReview({ snapshot: root }),
    audit = report.runtimeAudit.models[0];
  assert.equal(report.runtimeAudit.status, 'repeated-routing-context');
  assert.equal(audit.model, 'rrfs');
  assert.equal(audit.beforeHours, 3);
  assert.equal(audit.afterHours, 3);
  assert.equal(audit.ageTextOnlyCount, 1);
  assert.equal(audit.changedRunHours, 1);
  assert.equal(audit.changedStateHours, 1);
  assert.equal(audit.changes.length, 2);
  assert.equal(audit.changes[0].referenceChanged, true);
  assert.equal(audit.changes[0].stateChanged, false);
  assert.equal(audit.changes[1].referenceChanged, false);
  assert.equal(audit.changes[1].stateChanged, true);
  assert.equal(report.hourPairs[0].xcRouting.bracketed, true);
  assert.equal(report.hourPairs[0].xcReferenceTime, null);
});
