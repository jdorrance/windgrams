import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { packProviderArtifact } from './pack-provider.mjs';

test('provider artifacts cannot overwrite another model with seeded old data', t => {
  const root = mkdtempSync(join(tmpdir(), 'pack-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [
    'hrrr-conus/manifest.json', 'gfs/manifest.json', 'rrfs/manifest.json', 'geps/manifest.json', 'icon-eu/manifest.json',
    'history/hrrr-conus/run.json', 'history/gfs/run.json', 'history/rrfs/run.json', 'history/geps/run.json', 'history/icon-eu/run.json',
    'soaring/v1/regions.json', 'soaring/v1/regions-rrfs.json', 'soaring/v1/regions-icon-eu.json',
    'soaring/v1/north-live/index.json', 'soaring/v1/north-historical/index.json', 'soaring/v1/north-rrfs-live/index.json',
    'soaring/v1/armenia-icon-eu-live/index.json', 'soaring/v1/armenia-icon-eu-20261024/index.json',
    'site-context.json', 'site-context-armenia.json',
  ];
  for (const key of files) { const path = join(root, 'data', key); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{}'); }
  writeFileSync(join(root, 'data/soaring/v1/regions.json'), JSON.stringify({ regions: [{ id: 'north', caseId: 'north-live', nativeModels: [{ model: 'hrrr-conus', caseId: 'north-live' }] }, { id: 'historical', caseId: 'north-historical', nativeModels: [{ model: 'hrrr-conus', caseId: 'north-historical' }] }] }));
  // Current regional artifacts declare model ownership; paths do not encode policy.
  for (const [caseId, model] of [['north-rrfs-live', 'rrfs'], ['armenia-icon-eu-live', 'icon-eu'], ['armenia-icon-eu-20261024', 'icon-eu']]) {
    const dir = join(root, 'data/soaring/v1', caseId), bundle = `bundles/${'a'.repeat(64)}`;
    mkdirSync(join(dir, bundle), { recursive: true });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ bundle }));
    writeFileSync(join(dir, bundle, 'manifest.json'), JSON.stringify({ model }));
  }
  const expected = {
    'noaa-cloud': files.filter(key => !key.includes('rrfs') && !key.includes('geps') && !key.includes('icon-eu') && !key.startsWith('site-context')),
    rrfs: files.filter(key => key.includes('rrfs')),
    eccc: files.filter(key => key.includes('geps')),
    dwd: files.filter(key => key.includes('icon-eu') || key === 'site-context-armenia.json'),
  };
  for (const provider of Object.keys(expected)) {
    packProviderArtifact(provider, join(root, `slice-${provider}`), join(root, 'data'));
    for (const key of files) assert.equal(existsSync(join(root, `slice-${provider}`, key)), expected[provider].includes(key), `${provider}: ${key}`);
  }
});

test('provider packing omits retired live and historical grids while preserving point history', t => {
  const root = mkdtempSync(join(tmpdir(), 'pack-retired-grids-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data'), slice = join(root, 'slice');
  for (const key of ['hrrr-conus/manifest.json', 'history/hrrr-conus/evidence.json',
    'soaring/v1/north-sound-20261021-00z-live/index.json', 'soaring/v1/north-sound-expanded-v2/index.json',
    'soaring/v1/shenandoah-blue-ridge-20261021-00z/index.json']) {
    mkdirSync(dirname(join(data, key)), { recursive: true });
    writeFileSync(join(data, key), 'retained bytes');
  }
  const index = { trialRegionId: 'north-sound', regions: [{ id: 'north-sound', caseId: 'north-sound-20261021-00z-live' }] };
  writeFileSync(join(data, 'soaring/v1/regions.json'), JSON.stringify(index));
  packProviderArtifact('noaa-cloud', slice, data);
  assert.equal(existsSync(join(slice, 'soaring/v1/north-sound-20261021-00z-live')), false);
  assert.equal(existsSync(join(slice, 'soaring/v1/north-sound-expanded-v2')), false);
  assert.equal(existsSync(join(slice, 'soaring/v1/shenandoah-blue-ridge-20261021-00z')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(slice, 'soaring/v1/regions.json'))).regions, []);
  assert.equal(readFileSync(join(slice, 'history/hrrr-conus/evidence.json'), 'utf8'), 'retained bytes');
  assert.equal(readFileSync(join(data, 'soaring/v1/north-sound-expanded-v2/index.json'), 'utf8'), 'retained bytes');
});
