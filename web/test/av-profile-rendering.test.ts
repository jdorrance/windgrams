import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avProfileToPublishedSiteForecast } from '@windgrams/data-client/av';
import { buildWindgramView, readWindgram } from '@windgrams/windgram/scene';
import { PACKAGED_MODEL_CATALOGUE } from '@windgrams/providers/registry';
import { createAvFixture, fixture, point } from '../../packages/data-client/test/av-fixture.mjs';

test('native RRFS omega survives beyond the legacy pressure-level subset', () => {
  const { profile } = createAvFixture(1, { ...fixture, model: 'rrfs' });
  for (const level of profile.frames[0].profile.levels) level.omegaPaS = -2;
  const level = { pressureHpa: 500, heightM: 5600, temperatureC: -15, dewPointC: -25, uWindMps: 3, vWindMps: -2, omegaPaS: -2 };
  profile.frames[0].profile.levels.push(level);
  const published = avProfileToPublishedSiteForecast(profile, { ...point, slug: 'dog', name: 'Dog Mountain', timeZone: 'America/Los_Angeles' });
  const options = { timeZone: 'America/Los_Angeles', unitSystem: 'metric' as const, heightRange: 'full' as const, hours: published.hours };
  const native = buildWindgramView(published, options);
  assert.equal(readWindgram(native, 0, level.heightM).verticalVelocityPaS, -2);
  const capabilities = PACKAGED_MODEL_CATALOGUE.models.find(model => model.slug === 'rrfs')!.capabilities;
  assert.ok(!capabilities.verticalVelocityLevels!.includes(500));
  const legacy = buildWindgramView(published, { ...options, capabilities });
  assert.equal(readWindgram(legacy, 0, level.heightM).verticalVelocityPaS, null);
});
