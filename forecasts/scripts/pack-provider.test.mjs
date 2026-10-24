import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('provider artifacts cannot overwrite another model with seeded old data', t => {
  const root = mkdtempSync(join(tmpdir(), 'pack-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['pack-provider.sh', 'pack-slice.sh']) cpSync(new URL(name, import.meta.url), join(root, 'scripts', name));
  const files = [
    'hrrr-conus/manifest.json', 'gfs/manifest.json', 'rrfs/manifest.json', 'geps/manifest.json', 'icon-eu/manifest.json',
    'history/hrrr-conus/run.json', 'history/gfs/run.json', 'history/rrfs/run.json', 'history/geps/run.json', 'history/icon-eu/run.json',
    'soaring/v1/regions.json', 'soaring/v1/regions-rrfs.json', 'soaring/v1/regions-icon-eu.json',
    'soaring/v1/north-live/index.json', 'soaring/v1/north-historical/index.json', 'soaring/v1/north-rrfs-live/index.json',
    'soaring/v1/armenia-icon-eu-live/index.json', 'soaring/v1/armenia-icon-eu-20261024/index.json',
    'site-context.json', 'site-context-armenia.json',
  ];
  for (const key of files) { const path = join(root, 'data', key); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{}'); }
  const expected = {
    'noaa-cloud': files.filter(key => !key.includes('rrfs') && !key.includes('geps') && !key.includes('icon-eu') && !key.startsWith('site-context')),
    rrfs: files.filter(key => key.includes('rrfs')),
    eccc: files.filter(key => key.includes('geps')),
    dwd: files.filter(key => key.includes('icon-eu') || key === 'site-context-armenia.json'),
  };
  for (const provider of Object.keys(expected)) {
    const result = spawnSync('sh', ['scripts/pack-provider.sh', provider, `slice-${provider}`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const key of files) assert.equal(existsSync(join(root, `slice-${provider}`, key)), expected[provider].includes(key), `${provider}: ${key}`);
  }
});
