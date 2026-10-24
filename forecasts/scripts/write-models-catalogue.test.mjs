import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packagedModelsPath } from '@azohra/meteo.forecast';
import { parseModelCatalogue } from '@azohra/meteo.briefing/contract';
import { modelsCatalogue, ICON_MODEL } from './write-models-catalogue.mjs';

test('local ICON catalogue preserves every packaged model and observation entry', () => {
  const base = JSON.parse(readFileSync(packagedModelsPath(), 'utf8'));
  const original = structuredClone(base);
  const result = modelsCatalogue(base);
  assert.deepEqual(base, original);
  assert.deepEqual(result.models.filter(model => model.slug !== 'icon-eu'), base.models.filter(model => model.slug !== 'icon-eu'));
  assert.deepEqual(result.smokeModels, base.smokeModels);
  assert.deepEqual(result.observationModels, base.observationModels);
  assert.ok(parseModelCatalogue(result));
  assert.deepEqual(modelsCatalogue(result), result);
});

test('ICON capabilities describe the delivered native-level hourly product', () => {
  assert.equal(ICON_MODEL.provider, 'DWD');
  assert.equal(ICON_MODEL.gridKm, 6.5);
  assert.equal(ICON_MODEL.horizonHours, 78);
  assert.equal(ICON_MODEL.runIntervalHours, 6);
  assert.equal(ICON_MODEL.capabilities.levels, true);
  assert.deepEqual(ICON_MODEL.capabilities.pressureLevels, []);
  assert.equal(ICON_MODEL.capabilities.gust, 'hourMax');
  assert.equal(ICON_MODEL.capabilities.precipitation, 'windowMeanRate');
  assert.equal(ICON_MODEL.capabilities.heatFluxes, true);
  assert.equal(ICON_MODEL.capabilities.verticalVelocity, false);
  assert.equal(ICON_MODEL.capabilities.cloudProfile, false);
});
