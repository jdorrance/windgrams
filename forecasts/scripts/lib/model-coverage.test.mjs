import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelCoversSite, nwsCoversSite, regionSupportsModel } from './model-coverage.mjs';
const sites = JSON.parse(readFileSync(new URL('../../sites.json', import.meta.url))).sites;
const launches = JSON.parse(readFileSync(new URL('../../../web/src/data/launches.json', import.meta.url))).launches;

test('catalogued launches use covered providers and US observation feeds stay local', () => {
  for (const site of sites) {
    const country = launches[site.slug].countryCode;
    const armenia = country === 'AM', us = country === 'US';
    assert.equal(nwsCoversSite(site), us);
    for (const model of ['hrrr-conus', 'rrfs', 'hrdps-continental', 'rdps']) assert.equal(modelCoversSite(model, site), us);
    assert.equal(modelCoversSite('icon-eu', site), armenia);
    for (const model of ['gfs', 'gdps', 'geps']) assert.equal(modelCoversSite(model, site), true);
  }
});

test('native region model eligibility remains separate from point models', () => {
  const regions = JSON.parse(readFileSync(new URL('../../soaring/regions.json', import.meta.url))).regions;
  const active = regions.filter(region => region.status === 'active-verified-trial');
  assert.deepEqual(active.filter(region => regionSupportsModel(region, 'icon-eu')).map(region => region.id), ['armenia']);
  assert.deepEqual(active.filter(region => regionSupportsModel(region, 'rrfs')).map(region => region.id), ['north-sound', 'shenandoah-blue-ridge']);
  assert.ok(active.every(region => !regionSupportsModel(region, 'gfs')));
});
