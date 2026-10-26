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
    if (country !== 'MX') for (const model of ['hrrr-conus', 'rrfs', 'hrdps-continental', 'rdps']) assert.equal(modelCoversSite(model, site), us);
    assert.equal(modelCoversSite('icon-eu', site), armenia);
    for (const model of ['gfs', 'gdps', 'geps']) assert.equal(modelCoversSite(model, site), true);
  }
});

test('Mexican point candidates follow geographic coverage before native-grid acquisition', () => {
  const regional = ['hrrr-conus', 'rrfs', 'hrdps-continental', 'rdps'];
  for (const [site, candidates] of [
    [{ slug: 'mx-north', latitude: 32, longitude: -116 }, regional],
    [{ slug: 'mx-central', latitude: 20.8, longitude: -103.8 }, ['hrdps-continental', 'rdps']],
    [{ slug: 'mx-south', latitude: 19, longitude: -100 }, []],
  ]) {
    assert.deepEqual(regional.filter(model => modelCoversSite(model, site)), candidates, site.slug);
    for (const model of ['gfs', 'gdps', 'geps']) assert.equal(modelCoversSite(model, site), true, `${site.slug}: ${model}`);
    assert.equal(modelCoversSite('icon-eu', site), false);
    assert.equal(nwsCoversSite(site), false);
  }
});

test('native region model eligibility remains separate from point models', () => {
  const regions = JSON.parse(readFileSync(new URL('../../soaring/regions.json', import.meta.url))).regions;
  const active = regions.filter(region => region.status === 'active-verified-trial');
  assert.deepEqual(active.filter(region => regionSupportsModel(region, 'icon-eu')).map(region => region.id), ['armenia']);
  for (const model of ['hrrr-conus', 'rrfs']) {
    assert.deepEqual(active.filter(region => regionSupportsModel(region, model)), []);
    for (const slug of ['wa-blanchard', 'va-woodstock']) assert.equal(modelCoversSite(model, sites.find(site => site.slug === slug)), true);
  }
  assert.ok(active.every(region => !regionSupportsModel(region, 'gfs')));
});
