import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { localTimeToUtc, number, parseBlipspot, parseMapMenu, parseSounding } from './html.mjs';
import { FIELDS, wxValue, ourValue, windVector, circularDifference, sampleProfile } from './fields.mjs';
import { matchSites } from './matching.mjs';
import { createStore, bytesOf } from '../evidence-store.mjs';
import { captureReview } from './capture.mjs';
import { compareProfile, compareReview } from './compare.mjs';
import { referenceLcl, referenceCeiling, auditProfile } from './science.mjs';
import { buildWindgramView, heightToY, yToHeight } from '@windgrams/windgram/scene';
import { publishedLift } from '@windgrams/contracts/published-lift';
import { summarize } from './statistics.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wxtofly-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const table = (date = '24 Oct 2026', lead = '--h') =>
  `<h1>BLIPSPOT: ${date}</h1><table><tr><td>PNW_w2</td><td>gridpt=</td><td>1,2</td></tr><tr><td>Lat,Lon=</td><td>48.61,-122.40</td></tr><tr><td>VALID.TIME</td><td>14 PDT</td><td>15 PDT</td></tr><tr><td>ForecastPd</td><td>${lead}</td><td>${lead === '9h' ? '10h' : lead}</td></tr><tr><td>BL_Top_TI=0</td><td>1500</td><td>1800</td></tr><tr><td>BL_Depth_AGL</td><td>500</td><td>800</td></tr><tr><td>Temp@2m</td><td>50</td><td>-</td></tr><tr><td>Up_Velocity fpm</td><td>0</td><td>100</td></tr></table>`;
const match = { site: { slug: 'wa-blanchard', name: 'Blanchard' }, distanceKm: 1 };
function profile() {
  return {
    model: 'hrrr-conus',
    site: { id: 'wa-blanchard', modelElevationM: 100 },
    run: { referenceTime: '2026-10-24T12:00:00Z' },
    hours: [
      {
        validAt: '2026-10-24T21:00:00Z',
        surface: { windSpeedMps: 5, windDirectionDeg: 359, temperatureC: 10, dewPointC: 8, capeJkg: 0 },
        soaring: {
          thermalVelocityV2Mps: 1,
          resolvedThermalTopM: 1000,
          hcritWxtoflyM: 900,
          surfaceLclM: 500,
          mixedLayerLclM: 600,
          odPotentialM: 400,
          blMeanWindSpeedMps: 5,
          blMeanWindDirDeg: 10,
          buoyancyShearRatio: 2,
        },
      },
    ],
  };
}
function equivalent(p) {
  const h = p.hours[0];
  return {
    date: '2026-10-24',
    modelElevationM: 100,
    referenceTime: null,
    hours: [
      {
        validAt: h.validAt,
        leadHours: null,
        raw: {
          ...Object.fromEntries(FIELDS.map((f) => [f.wx, String((ourValue(h, f, 100) - f.offset) / f.scale)])),
          MaxSoar_AGL: '100',
        },
      },
    ],
  };
}

test('legacy tables preserve missing versus zero, infer terrain and only derive consistent runs', () => {
  const p = parseBlipspot(table(), 'https://example.test/blipspotBlanchard.html');
  assert.equal(p.status, 'parsed');
  assert.equal(p.hours[0].validAt, '2026-10-24T21:00:00.000Z');
  assert.equal(p.modelElevationM, 304.8);
  assert.equal(p.referenceTime, null);
  assert.equal(number(p.hours[0].raw['Up_Velocity fpm']), 0);
  assert.equal(number(p.hours[1].raw['Temp@2m']), null);
  assert.equal(parseBlipspot(table('24 Oct 2026', '9h'), 'x').referenceTime, '2026-10-24T12:00:00.000Z');
  for (const v of ['', ' ', '-', '--h', 'NaN', 'Infinity', '1 mph']) assert.equal(number(v), null);
  assert.equal(parseBlipspot(table('31 Feb 2026'), 'x').status, 'unparsed');
});
test('UTC conversion disambiguates daylight-saving transitions and validates dates', () => {
  assert.equal(localTimeToUtc('2026-11-01', 1, 'PDT'), '2026-11-01T08:00:00.000Z');
  assert.equal(localTimeToUtc('2026-11-01', 1, 'PST'), '2026-11-01T09:00:00.000Z');
  assert.equal(localTimeToUtc('2026-03-08', 3, 'PDT'), '2026-03-08T10:00:00.000Z');
  assert.equal(localTimeToUtc('2026-10-24', 24, 'PDT'), '2026-10-25T07:00:00.000Z');
  for (const args of [
    ['bad', 1, 'UTC'],
    ['2026-02-30', 1, 'UTC'],
    ['2026-10-24', 25, 'PDT'],
    ['2026-10-24', 1, 'local'],
  ])
    assert.equal(localTimeToUtc(...args), null);
});
test('printed units normalize to SI without turning absence into zero', () => {
  assert.equal(
    wxValue(
      { raw: { 'Temp@2m': '32' } },
      FIELDS.find((f) => f.id === 'temperature2m'),
    ),
    0,
  );
  assert.equal(wxValue({ raw: { '10M_Wind_Sp_Kt': '1' } }, FIELDS[0]), 1852 / 3600);
  assert.equal(wxValue({ raw: { '10M_Wind_Sp_Kt': '-' } }, FIELDS[0]), null);
});
test('aliases require coordinates and cannot silently match launch to landing zone', () => {
  const s = { slug: 'wa-tiger-mountain', name: 'Tiger Mountain', latitude: 47.5, longitude: -122 };
  assert.equal(matchSites([s], [{ id: 'Tiger', latitude: 47.51, longitude: -122 }])[0].status, 'matched');
  assert.equal(matchSites([s], [{ id: 'TigerLZ', latitude: 47.5, longitude: -122 }])[0].status, 'ambiguous');
  assert.equal(matchSites([s], [{ id: 'Tiger', latitude: 49, longitude: -122 }])[0].status, 'ambiguous');
  assert.equal(
    matchSites(
      [s],
      [
        { id: 'Tiger', latitude: 47.5, longitude: -122 },
        { id: 'Tiger Mountain', latitude: 47.5, longitude: -122 },
      ],
    )[0].status,
    'ambiguous',
  );
});
test('identical normalized inputs give zero differences; mismatched times and missing lift are explicit', () => {
  const p = profile(),
    w = equivalent(p),
    r = compareProfile(p, w, match, 'test', {});
  assert.ok(r.rows.length > 12);
  for (const row of r.rows) assert.ok(Math.abs(row.difference) < 1e-10, row.field);
  w.hours[0].validAt = '2026-10-24T22:00:00Z';
  const mismatch = compareProfile(p, w, match, 'test', {});
  assert.equal(mismatch.rows.length, 0);
  assert.equal(mismatch.excluded[0].reason, 'no-exact-valid-time');
  w.hours[0].validAt = p.hours[0].validAt;
  w.hours[0].raw.MaxSoar_AGL = '0';
  p.hours[0].soaring.hcritWxtoflyM = null;
  assert.equal(compareProfile(p, w, match, 'test', {}).eventRows[0].ours, false);
  delete p.hours[0].soaring;
  assert.equal(compareProfile(p, w, match, 'test', {}).eventRows[0].ours, null);
});
test('wind comparisons wrap around north and suppress direction in calm air', () => {
  assert.equal(circularDifference(359, 1), -2);
  assert.equal(circularDifference(1, 359), 2);
  assert.deepEqual(windVector(0, 10), { u: -0, v: -0 });
  const p = profile(),
    w = equivalent(p);
  w.hours[0].raw['10M_Wind_Dir'] = '1';
  const r = compareProfile(p, w, match, 'test', {});
  assert.equal(r.rows.find((r) => r.field === 'wind10mDirection').difference, -2);
  assert.ok(r.rows.find((r) => r.field === 'wind10mVector').difference < 0.18);
  p.hours[0].surface.windSpeedMps = 1;
  const calm = compareProfile(p, w, match, 'test', {});
  assert.ok(!calm.rows.some((r) => r.field === 'wind10mDirection'));
  assert.ok(calm.excluded.some((r) => r.reason.includes('≤1 m/s')));
});
test('vertical interpolation uses wind components, shared above-ground brackets and never extrapolates', () => {
  const levels = [
    { heightM: 100, temperatureC: 10, dewPointC: 5, windSpeedMps: 10, windDirectionDeg: 350 },
    { heightM: 300, temperatureC: 8, dewPointC: 3, windSpeedMps: 10, windDirectionDeg: 10 },
  ];
  const p = sampleProfile(levels, 200, 50);
  assert.equal(p.temperatureC, 9);
  assert.ok(Math.abs(p.windDirectionDeg) < 1e-9);
  assert.ok(p.windSpeedMps < 10);
  assert.equal(p.interpolated, true);
  assert.equal(sampleProfile(levels, 50, 50), null);
  assert.equal(sampleProfile(levels, 400, 50), null);
  assert.equal(sampleProfile(levels, 200, 250), null);
  assert.equal(sampleProfile(levels, 200, 150), null, 'below-ground lower bracket cannot be used');
});
test('menu and sounding parsers do not execute scripts and cover both map resolutions', () => {
  const m = parseMapMenu(
    `myparamlist=new Array('nope1','wstar');presslevels=new Array('press850');mytimes=new Array('0800lst');mygrids=new Array('d2','w2');resolution['d2']='4 km';`,
  );
  assert.deepEqual(m.parameters, ['wstar', 'press850']);
  assert.deepEqual(m.grids, ['d2', 'w2']);
  const s = parseSounding(
    `soundrow['mb']['9250']=925; soundrow['ft']['9250']=1000; soundrow['tempC']['9250']=10; soundrow['speed']['9250']=10; throw new Error('must not execute');`,
  );
  assert.equal(s.levels[0].heightM, 304.8);
  assert.equal(s.levels[0].windSpeedMps, (10 * 1852) / 3600);
});
test('content hashes reject tampering and reuse exact immutable bytes', async (t) => {
  const root = await workspace(t),
    store = await createStore(root),
    a = await store.save(Buffer.from('evidence'), { url: 'test' }),
    b = await store.save(Buffer.from('evidence'), { url: 'test2' });
  assert.equal(a.sha256, b.sha256);
  assert.equal((await bytesOf(root, a)).toString(), 'evidence');
  await writeFile(join(root, a.file), 'tampered');
  await assert.rejects(bytesOf(root, a), /hash mismatch/);
});
test('capture retries changing publications and records unresolved instability; comparison reproduces offline', async (t) => {
  const root = await workspace(t),
    counts = new Map(),
    fetchImpl = async (input) => {
      const url = new URL(input),
        path = url.pathname,
        n = (counts.get(path) ?? 0) + 1;
      counts.set(path, n);
      let body,
        status = 200;
      if (path === '/') body = '<html>live</html>';
      else if (path === '/data/models.json') body = { models: [] };
      else if (path === '/data/sites.json') body = { sites: [] };
      else if (path === '/data/runs.json') body = { runs: {} };
      else if (path === '/blipspotBlanchard.html') body = table() + `<!-- revision ${n < 3 ? n : 3} -->`;
      else if (path === '/scripts/param_array.js') body = '';
      else {
        body = 'not found';
        status = 404;
      }
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
  const options = {
    siteUrl: 'https://source.test/',
    wxUrl: 'https://wx.test/',
    output: root,
    fetchImpl,
    log: () => {},
  };
  const s = await captureReview(options);
  assert.equal(s.wxProducts[0].stable, true);
  assert.equal(counts.get('/blipspotBlanchard.html'), 4);
  await assert.rejects(captureReview(options), /already exists/);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Offline comparison attempted network');
  };
  try {
    const a = await compareReview({ snapshot: root }),
      b = await compareReview({ snapshot: root });
    assert.deepEqual(a, b);
  } finally {
    globalThis.fetch = savedFetch;
  }
  const other = await workspace(t);
  let calls = 0;
  await captureReview({
    ...options,
    output: other,
    fetchImpl: async (input) =>
      new URL(input).pathname === '/blipspotBlanchard.html'
        ? new Response(table() + `<!-- ${++calls} -->`)
        : fetchImpl(input),
  });
  const changed = JSON.parse(await readFile(join(other, 'snapshot.json')));
  assert.equal(changed.wxProducts[0].stable, false);
});
test('independent physical references and renderer readouts use model terrain and published values', async () => {
  assert.equal(referenceLcl(10, 10, 300), 300);
  assert.ok(referenceLcl(10, 5, 300) > 300);
  assert.equal(referenceCeiling(100, 100, 3, null, 1), null);
  assert.ok(referenceCeiling(100, 1200, 1, null, 1.143) <= referenceCeiling(100, 1200, 1, null, 1));
  const p = JSON.parse(
    gunzipSync(
      await readFile(new URL('../../../web/test/fixtures/windgram-visual/dog-hrrr-conus.json.gz', import.meta.url)),
    ),
  );
  const view = buildWindgramView(p, {
    unitSystem: 'metric',
    timeZone: p.site.timeZone,
    widthPx: 375,
    hours: { dateKey: '2026-10-24', timeZone: p.site.timeZone },
    launch: { elevationM: 645.5 },
  });
  assert.ok(view.hours.length > 0);
  for (const h of view.hours) {
    const original = p.hours.find((o) => o.validAt === h.validAt);
    assert.equal(h.thermalVelocityMps, publishedLift(original).thermalVelocityMps);
    assert.equal(h.usableLiftTopM, publishedLift(original).usableLiftTopM);
  }
  assert.ok(Math.abs(yToHeight(view, heightToY(view, 1000)) - 1000) < 1e-9);
  assert.equal(view.ground.source, 'launch');
  assert.ok(auditProfile(p).length > 0);
  const stats = summarize([
    { difference: -2, site: 'a', localDate: '2026-10-24' },
    { difference: 4, site: 'a', localDate: '2026-10-24' },
  ]);
  assert.equal(stats.meanDifference, 1);
  assert.equal(stats.meanAbsoluteDifference, 3);
  assert.equal(stats.distinctSiteDays, 1);
});

test('invalid time columns are not removed or shifted; contradictory lead metadata stays ambiguous', () => {
  const h = table().replace('<td>15 PDT</td>', '<td>unknown time</td>');
  const p = parseBlipspot(h, 'x');
  assert.equal(p.status, 'unparsed');
  assert.equal(p.hours[1].raw['Up_Velocity fpm'], '100');
  assert.equal(p.hours[1].validAt, null);
  assert.equal(
    parseBlipspot(table('24 Oct 2026', '9h').replace('<td>10h</td>', '<td>12h</td>'), 'x').status,
    'ambiguous-run',
  );
  const repeated = table().replace('<td>15 PDT</td>', '<td>15 PDT</td><td>VALID.TIME</td><td></td>');
  assert.equal(parseBlipspot(repeated, 'x').hours.length, 2);
});

test('a moving model manifest retries the whole profile cohort and validates initialization', async (t) => {
  const root = await workspace(t),
    fixture = JSON.parse(
      gunzipSync(
        await readFile(new URL('../../../web/test/fixtures/windgram-visual/dog-hrrr-conus.json.gz', import.meta.url)),
      ),
    );
  fixture.site.id = 'wa-blanchard';
  let count = 0,
    selected;
  const fetchImpl = async (input) => {
    const path = new URL(input).pathname;
    let body,
      status = 200;
    if (path === '/') body = '<html>live</html>';
    else if (path === '/data/models.json')
      body = { models: [{ slug: 'hrrr-conus', runIntervalHours: 6, typicalPublicationLagHours: 3 }] };
    else if (path === '/data/sites.json')
      body = { sites: [{ slug: 'wa-blanchard', name: 'Blanchard', latitude: 48.61, longitude: -122.4 }] };
    else if (path === '/data/runs.json') body = { runs: { 'hrrr-conus': {} } };
    else if (path === '/data/hrrr-conus/manifest.json') {
      count++;
      selected = count === 1 ? '2026-10-24T00:00:00Z' : '2026-10-24T06:00:00Z';
      body = { referenceTime: selected, sites: [{ slug: 'wa-blanchard' }] };
    } else if (path === '/data/hrrr-conus/sites/wa-blanchard.json') {
      body = structuredClone(fixture);
      body.run.referenceTime = selected;
    } else if (path === '/blipspotBlanchard.html') body = table();
    else {
      body = 'missing';
      status = 404;
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  const s = await captureReview({
    siteUrl: 'https://ours.test/',
    wxUrl: 'https://wx.test/',
    output: root,
    fetchImpl,
    log: () => {},
  });
  assert.equal(count, 4);
  assert.equal(s.models[0].stable, true);
  assert.equal(s.models[0].referenceTime, '2026-10-24T06:00:00Z');
  assert.ok(s.models[0].profiles.every((p) => p.valid));
});

test('regional capture retries changing pointers and excludes unbound manifests', async (t) => {
  const { captureRegionalBundles } = await import('./regional-capture.mjs');
  const { sha256 } = await import('../evidence-store.mjs');
  const root = await workspace(t),
    manifest = JSON.stringify({ hours: [], files: {} }),
    hash = sha256(manifest);
  let pointerReads = 0;
  const store = await createStore(root, {
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('/index.json')
          ? JSON.stringify({ bundle: `bundles/${(++pointerReads === 1 ? 'a' : 'b').repeat(64)}`, manifestSha256: hash })
          : manifest,
      ),
  });
  const catalogue = {
    regions: [{ id: 'region', bbox: [-180, -90, 180, 90], nativeModels: [{ caseId: 'case', model: 'hrrr' }] }],
  };
  const [record] = await captureRegionalBundles(store, 'https://test.invalid/data', catalogue, []);
  assert.equal(record.attempts, 2);
  assert.equal(record.stable, true);
  assert.equal(record.status, 'outside-shared-coverage');
  const bad = await createStore(await workspace(t), {
    fetchImpl: async (url) =>
      new Response(
        url.endsWith('/index.json')
          ? JSON.stringify({ bundle: `bundles/${'a'.repeat(64)}`, manifestSha256: '0'.repeat(64) })
          : manifest,
      ),
  });
  const [unbound] = await captureRegionalBundles(bad, 'https://test.invalid/data', catalogue, []);
  assert.equal(unbound.attempts, 3);
  assert.equal(unbound.stable, false);
  assert.equal(unbound.status, 'unavailable');
});
