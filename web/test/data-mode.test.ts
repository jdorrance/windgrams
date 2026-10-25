import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDataConfiguration } from '../config/data-mode.mjs';

test('real forecasts are the default and fixtures require explicit selection', () => {
  const real = localDataConfiguration({});
  assert.equal(real.sample, false);
  assert.ok(real.root.endsWith('/forecasts/data/'));
  const fixtures = localDataConfiguration({ WINDGRAMS_DATA_MODE: 'fixtures' });
  assert.equal(fixtures.sample, true);
  assert.ok(fixtures.root.endsWith('/web/dev-data/'));
  assert.throws(() => localDataConfiguration({ WINDGRAMS_DATA_MODE: 'fixture' }), /must be forecasts or fixtures/);
  assert.throws(() => localDataConfiguration({ WINDGRAMS_DATA_MODE: 'fixtures', PUBLIC_WINDGRAMS_DATA_BASE: 'https://real.example/data' }), /unset PUBLIC_WINDGRAMS_DATA_BASE/);
});
