import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePublicationBaseline } from './publication-baseline.mjs';

test('baseline retries moving manifests and verifies profile run/site identity', async () => {
  const output = await mkdtemp(join(tmpdir(), 'windgrams-baseline-'));
  let manifestReads = 0,
    profileReads = 0;
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const json = (value) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/') return new Response('<script src="/client.js"></script>');
    if (path === '/client.js') return new Response('const data="https://test.invalid/weather/data";');
    if (path.endsWith('/models.json')) return json({ models: [{ slug: 'hrrr' }] });
    if (path.endsWith('/sites.json')) return json({ sites: [{ slug: 'wa-blanchard' }] });
    if (path.endsWith('/runs.json')) return json({ runs: { hrrr: {} } });
    if (path.endsWith('/manifest.json'))
      return json({
        referenceTime: ++manifestReads === 1 ? '2026-10-26T00:00:00Z' : '2026-10-26T06:00:00Z',
        sites: [{ slug: 'wa-blanchard' }],
      });
    if (path.endsWith('/sites/wa-blanchard.json'))
      return json({
        model: 'hrrr',
        site: { id: 'wa-blanchard', modelElevationM: 100 },
        run: { referenceTime: ++profileReads === 1 ? '2026-10-26T00:00:00Z' : '2026-10-26T06:00:00Z' },
        hours: [{ validAt: '2026-10-26T12:00:00Z', levels: [{}, {}], soaring: { contractVersion: '2.2.0' } }],
      });
    return new Response('missing', { status: 404 });
  };
  try {
    const result = await capturePublicationBaseline({
      siteUrl: 'https://test.invalid/',
      dataUrl: 'https://test.invalid/weather/data',
      output,
      fetchImpl,
      checkout: false,
    });
    assert.equal(result.models[0].attempts, 2);
    assert.equal(result.models[0].stable, true);
    assert.equal(result.models[0].referenceTime, '2026-10-26T06:00:00Z');
    assert.deepEqual(result.models[0].profiles[0].methodVersions, ['2.2.0']);
    assert.ok(result.resources.every((resource) => resource.retrievedAt && resource.sha256));
    assert.equal(JSON.parse(await readFile(join(output, 'baseline.json'))).models[0].stable, true);
    await assert.rejects(capturePublicationBaseline({ output, fetchImpl, checkout: false }), { code: 'EEXIST' });
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('unresolved mismatched profile identities are explicit gaps after bounded retries', async () => {
  const output = await mkdtemp(join(tmpdir(), 'windgrams-baseline-'));
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    const value = path.endsWith('/models.json')
      ? { models: [{ slug: 'hrrr' }] }
      : path.endsWith('/sites.json')
        ? { sites: [] }
        : path.endsWith('/manifest.json')
          ? { referenceTime: '2026-10-26T00:00:00Z', sites: [{ slug: 'wa-blanchard' }] }
          : path.includes('/sites/')
            ? { model: 'hrrr', site: { id: 'wrong-location' }, run: { referenceTime: '2026-10-26T00:00:00Z' } }
            : {};
    return new Response(path === '/' ? '<html></html>' : JSON.stringify(value));
  };
  try {
    const result = await capturePublicationBaseline({
      siteUrl: 'https://test.invalid/',
      dataUrl: 'https://test.invalid/data',
      output,
      fetchImpl,
      checkout: false,
    });
    assert.equal(result.models[0].attempts, 3);
    assert.equal(result.models[0].stable, false);
    assert.equal(result.gaps[0].reason, 'publication-changed-or-profile-identity-mismatch');
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
