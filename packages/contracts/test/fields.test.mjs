import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fieldDefinition, readRegionalField, heightAboveGround } from '../dist/fields.js';
import { regionalWireSchemas } from '../dist/regional-types.js';
import { gridWireSchema } from '../dist/regional-documents.js';
import { columnWireSchema } from '../dist/atmosphere.js';

test('field readers preserve zero, missing data and independent surface fields', () => {
  const hour = { status: ['valid', 'insufficient-levels', 'missing'],
    thermalVelocityV2Mps: [0, 2, null], usableLiftTopV2M: [null, null, null], wind10mSpeedMps: [0, 3, 4] };
  assert.deepEqual(readRegionalField(hour, 'thermalVelocityV2Mps', 0), { status: 'valid', value: 0 });
  assert.deepEqual(readRegionalField(hour, 'thermalVelocityV2Mps', 1), { status: 'insufficient-profile', value: null });
  assert.deepEqual(readRegionalField(hour, 'usableLiftTopV2M', 0), { status: 'missing', value: null });
  assert.deepEqual(readRegionalField(hour, 'wind10mSpeedMps', 2), { status: 'valid', value: 4 });
  assert.deepEqual(readRegionalField(hour, 'w925Mps', 0), { status: 'unsupported', value: null });
  assert.throws(() => readRegionalField(hour, 'wind10mSpeedMps', 3), /Invalid regional cell/);
  assert.throws(() => fieldDefinition('constructor'), /Unknown regional field/);
  assert.equal(fieldDefinition('hcritWxtoflyM').sinkMps, 1.143);
  assert.equal(fieldDefinition('pblHeightM').heightReference, 'model-AGL');
  assert.ok(Object.isFrozen(fieldDefinition('pblHeightM')));
});

test('AGL conversions keep source terrain and below-ground ceilings explicit', () => {
  const model = { kind: 'model', elevationM: 220, verticalDatum: 'MSL', source: 'model', resolutionM: 3000 };
  const terrain = { ...model, kind: 'terrain', elevationM: 500, source: 'survey', resolutionM: 10 };
  assert.equal(heightAboveGround(470, 'MSL', model).heightM, 250);
  const result = heightAboveGround(470, 'MSL', terrain);
  assert.equal(result.heightM, -30);
  assert.equal(result.belowGround, true);
  assert.equal(result.heightMslM, 470);
  assert.deepEqual(result.reference, terrain);
  assert.equal(heightAboveGround(null, 'MSL', terrain), null);
  assert.throws(() => heightAboveGround(470, 'ellipsoid', terrain), /compatible vertical datums/);
  assert.throws(() => heightAboveGround(NaN, 'MSL', terrain), /finite elevations/);
});

test('wire schemas are regenerated from the runtime schema sources', () => {
  const generated = JSON.parse(readFileSync(new URL('../dist/wire-schemas.json', import.meta.url)));
  assert.deepEqual(generated, { ...regionalWireSchemas(), grid: gridWireSchema(), column: columnWireSchema() });
  assert.equal(generated.manifest.properties.fileBytes.type, 'object');
});
