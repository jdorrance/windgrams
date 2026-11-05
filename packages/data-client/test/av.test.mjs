import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAvClient, avProfileToPublishedSiteForecast } from '@windgrams/data-client/av';
import { createForecastClient } from '@windgrams/data-client';
import { avFetch, createAvFixture, point, fixture } from './av-fixture.mjs';
const site = { ...point, slug: 'dog', name: 'Dog Mountain', timeZone: 'America/Los_Angeles' };
test('AV profiles pin the run, retain every native level and batch the full horizon', async () => {
  const transport = avFetch(),
    client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const build = await client.pin('gfs'),
    profile = await client.profile(build, point),
    published = avProfileToPublishedSiteForecast(profile, site);
  assert.equal(profile.frames.length, 24);
  assert.equal(transport.calls.length, 3);
  assert.equal(published.hours.length, 24);
  assert.equal(published.site.id, 'dog');
  assert.equal(published.site.modelElevationM, fixture.site.modelElevationM);
  assert.equal(published.hours[0].levels.length, fixture.hours[0].levels.length);
  assert.equal(published.hours[0].levels[0].heightM, fixture.hours[0].levels[0].heightM);
  assert.ok(transport.calls.slice(1).every((url) => url.includes('/runs/test-build/profile?')));
  assert.ok(published.hours[0].soaring && Object.hasOwn(published.hours[0].soaring, 'thermalVelocityV2Mps'));
});
test('AV response selection and provenance cannot drift from the pinned build', async () => {
  for (const mutation of [
    (p) => ({ ...p, buildId: 'other' }),
    (p) => ({ ...p, lat: p.lat + 0.001 }),
    (p) => ({ ...p, source: { ...p.source, provenanceSha256: 'f'.repeat(64) } }),
    (p) => ({ ...p, frames: p.frames.slice(1) }),
  ]) {
    const transport = avFetch(createAvFixture(), mutation),
      client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: transport.fetch });
    await assert.rejects(client.profile(await client.pin('gfs'), point), /pinned|selection/);
  }
});
test('explicit AV configuration routes supported profiles and preserves other-model legacy transport', async () => {
  const transport = avFetch(),
    calls = [];
  const client = createForecastClient({
    baseUrl: 'https://legacy.test/data',
    avApiBaseUrl: 'https://av.test',
    sites: [site],
    fetch: async (url, ...rest) => {
      calls.push(String(url));
      return String(url).startsWith('https://av.test')
        ? transport.fetch(url, ...rest)
        : new Response('', { status: 404 });
    },
  });
  const result = await client.loadProfile('gfs', 'dog');
  assert.equal(result.document.model, 'gfs');
  assert.equal(result.stale, false);
  assert.equal((await client.loadProfile('hrrr', 'dog')).miss, 'absent');
  assert.ok(calls.filter((url) => url.startsWith('https://legacy.test')).every((url) => url.includes('/hrrr/')));
  await assert.rejects(client.loadProfile('rrfs', 'unknown'), /coordinates unavailable/);
});
test('AV adapters retain partial humidity, wind, source pressure and nullable surface values', async () => {
  const data = createAvFixture(1),
    frame = data.profile.frames[0];
  frame.profile.levels[1].dewPointC = null;
  frame.profile.levels[1].uWindMps = null;
  frame.layers['mslp-hpa'] = { ...frame.layers['mslp-hpa'], value: null, status: 'unavailable' };
  const transport = avFetch(data),
    client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: transport.fetch });
  const profile = avProfileToPublishedSiteForecast(await client.profile(await client.pin('gfs'), point), site);
  assert.equal(profile.hours[0].levels.length, frame.profile.levels.length);
  assert.equal(profile.hours[0].levels[1].dewPointC, null);
  assert.equal(profile.hours[0].levels[1].windSpeedMps, null);
  assert.equal(profile.hours[0].surface.seaLevelPressureHpa, null);
  assert.equal(profile.hours[0].surface.surfacePressureHpa, 1000);
});
test('AV scalar requests respect aggregate budgets and never round point coordinates', async () => {
  const transport = avFetch(),
    client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: transport.fetch }),
    build = await client.pin('gfs');
  const points = Array.from({ length: 40 }, (_, i) => ({ lat: 40 + i * 0.000000017, lon: -122.123456789 }));
  const results = await client.samples(
    build,
    points,
    [build.manifest.frames[0].id],
    build.manifest.surfaces[0].layers.slice(0, 10),
  );
  assert.equal(results.length, 40);
  assert.equal(results[1].lat, points[1].lat);
  assert.equal(transport.calls.length, 3);
  assert.ok(
    transport.calls.slice(1).every((url) => new URL(url).searchParams.get('points').split(';').length <= 25),
  );
});
test('independent regional callers retain independent cancellation and a shared completed cache', async () => {
  const { openAvRegionalDataset } = await import('@windgrams/data-client/av');
  const source = avFetch(createAvFixture(1));
  let releases = [];
  const fetch = async (url, init) =>
    String(url).includes('/profile?')
      ? new Promise((resolve, reject) => {
          releases.push(() => source.fetch(url).then(resolve, reject));
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        })
      : source.fetch(url);
  const dataset = await openAvRegionalDataset({ apiBaseUrl: 'https://av.test', model: 'gfs', fetch }),
    a = new AbortController(),
    b = new AbortController();
  const first = dataset.loadProfile(point, undefined, a.signal),
    second = dataset.loadProfile(point, undefined, b.signal);
  a.abort(new Error('first closed'));
  await assert.rejects(first, /first closed/);
  releases[1]();
  assert.equal((await second).frames.length, 1);
  const count = source.calls.length;
  assert.equal((await dataset.loadProfile(point)).frames.length, 1);
  assert.equal(source.calls.length, count);
  const c = new AbortController();
  c.abort(new Error('joined closed'));
  assert.throws(() => dataset.loadProfile(point, undefined, c.signal), /joined closed/);
});
test('AV admission errors split only sample-limit responses and keep rate limiting explicit', async () => {
  for (const code of ['sample-limit', 'rate-limit']) {
    const source = avFetch(createAvFixture(1));
    let attempts = 0;
    const client = createAvClient({
      apiBaseUrl: 'https://av.test',
      fetch: async (url, init) => {
        if (String(url).includes('/samples?') && ++attempts === 1)
          return Response.json({ title: code }, { status: 429 });
        return source.fetch(url, init);
      },
    });
    const build = await client.pin('gfs'),
      points = [point, { ...point, lat: point.lat + 0.001 }];
    const result = client.samples(build, points, ['f001'], ['thermal-velocity']);
    if (code === 'sample-limit') {
      assert.equal((await result).length, 2);
      assert.equal(attempts, 3);
    } else {
      await assert.rejects(result, /429/);
      assert.equal(attempts, 1);
    }
  }
});
test('AV raw profiles preserve nullable P/H/T slots and unknown ground without inventing a published datum', async () => {
  const data = createAvFixture(1),
    frame = data.profile.frames[0];
  frame.profile.levels[0].temperatureC = null;
  frame.profile.levels[1].heightM = null;
  frame.profile.levels[2].pressureHpa = null;
  const source = avFetch(data),
    client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: source.fetch }),
    build = await client.pin('gfs'),
    raw = await client.profile(build, point);
  assert.equal(raw.frames[0].profile.levels.length, frame.profile.levels.length);
  const published = avProfileToPublishedSiteForecast(raw, site);
  assert.equal(published.hours[0].levels[0].temperatureC, null);
  assert.equal(published.hours[0].levels[1].heightM, null);
  assert.equal(published.hours[0].levels[2].pressureHpa, null);
  frame.profile.modelTerrainM = null;
  frame.profile.status = 'unavailable';
  const unknown = await client.profile(build, point);
  assert.equal(unknown.frames[0].profile.levels.length, frame.profile.levels.length);
  assert.equal(unknown.frames[0].profile.surfacePressureHpa, 1000);
  assert.throws(() => avProfileToPublishedSiteForecast(unknown, site), /no native model terrain/);
});
test('AV consumer adapters preserve Blanchard and Aparan native profiles and published V2 diagnostics', async () => {
  const { readFileSync } = await import('node:fs'),
    { gunzipSync } = await import('node:zlib');
  const sources = [
    JSON.parse(
      readFileSync(new URL('../../../forecasts/soaring/fixtures/rrfs-blanchard-published.json', import.meta.url)),
    ),
    JSON.parse(
      gunzipSync(
        readFileSync(
          new URL('../../../web/test/fixtures/windgram-visual/aparan-icon-eu.json.gz', import.meta.url),
        ),
      ),
    ),
  ];
  for (const source of sources) {
    const data = createAvFixture(source.hours.length, source),
      transport = avFetch(data),
      client = createAvClient({ apiBaseUrl: 'https://av.test', fetch: transport.fetch }),
      build = await client.pin(source.model),
      location = { lat: source.site.latitude, lon: source.site.longitude },
      profile = avProfileToPublishedSiteForecast(await client.profile(build, location), {
        ...location,
        slug: source.site.id,
        name: source.site.name,
        timeZone: source.site.timeZone,
      });
    assert.equal(profile.hours.length, source.hours.length);
    for (let i = 0; i < profile.hours.length; i++) {
      const got = profile.hours[i],
        expected = source.hours[i];
      assert.equal(Date.parse(got.validAt), Date.parse(expected.validAt));
      assert.equal(got.levels.length, expected.levels.length);
      assert.equal(
        got.soaring.thermalVelocityV2Mps,
        expected.soaring?.thermalVelocityV2Mps ?? expected.derived.thermalVelocityMps,
      );
      assert.equal(
        got.soaring.usableLiftTopV2M,
        expected.soaring?.usableLiftTopV2M ?? expected.derived.usableLiftTopM,
      );
      for (let j = 0; j < got.levels.length; j++) {
        assert.equal(got.levels[j].heightM, expected.levels[j].heightM);
        assert.equal(got.levels[j].temperatureC, expected.levels[j].temperatureC);
        assert.ok(Math.abs(got.levels[j].windSpeedMps - expected.levels[j].windSpeedMps) < 1e-9);
      }
    }
  }
});
