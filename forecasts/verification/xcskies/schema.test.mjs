import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePointcast, POINTCAST_FIELDS } from './schema.mjs';

const request = { model: 'gfs', latitude: 48.6097, longitude: -122.426 };
const fixture = () => ({
  status: 1,
  epochs: [1792864800, 1792868400],
  minheight: 100,
  ninterval: 150,
  level_interval: 150,
  u: [
    [0, 30, -99990],
    [0, 0, -99990],
  ],
  v: [
    [-40, 40, -99990],
    [0, 0, -99990],
  ],
  tmps: [
    [173, 150],
    [0, null],
  ],
  rhs: [
    [40, 50, 60],
    [0, 100, 90],
  ],
  dps: [
    [-153, 10],
    [0, -99990],
  ],
  vels: [
    [0, 12],
    [0, 20],
  ],
  elevs: [10, 10],
  vtops: [10, 50],
  bltops: [10, 60],
  dptops: [80, 40],
  cutops: [80, 70],
  dalrtops: [
    [100, 999, 17.3],
    [400, 900, 13],
  ],
  tmp2m: [172, 0],
  na: [],
});

test('decodes verified fields without confusing parcel dew point or surface encodings', () => {
  const raw = fixture(),
    original = structuredClone(raw),
    result = parsePointcast(raw, request);
  assert.deepEqual(raw, original, 'normalization must not mutate frozen source data');
  assert.equal(result.hours[0].validAt, '2026-10-24T18:00:00.000Z');
  assert.equal(result.hours[0].levels[0].temperatureC, 17.3);
  assert.equal(result.hours[0].levels[0].relativeHumidityPct, 40);
  assert.equal(result.hours[0].levels[0].parcelDewPointDepressionIndex, -15.3);
  assert.equal(result.hours[0].levels[0].dewPointC, undefined);
  assert.deepEqual(result.hours[0].surface, {});
  assert.equal(result.hours[0].rawSurface.tmp2m, 172);
  assert.equal(result.hours[1].diagnostics.usableLiftTopM, 500);
  assert.equal(result.hours[1].diagnostics.conservativeTopM, 400);
  assert.equal(result.hours[0].modelElevationM, 100);
  assert.equal(result.hours[0].levels[1].heightM, 250);
});

test('preserves zero and handles missing wind components without manufacturing vectors', () => {
  const { hours } = parsePointcast(fixture(), request);
  assert.equal(hours[0].levels[0].windSpeedMps, 4);
  assert.equal(hours[0].levels[0].windDirectionDeg, 0);
  assert.equal(hours[0].levels[1].windSpeedMps, 5);
  assert.equal(hours[0].levels[2].windSpeedMps, null);
  assert.equal(hours[1].levels[0].windSpeedMps, 0);
  assert.equal(hours[1].levels[0].windDirectionDeg, null);
  assert.equal(hours[1].levels[0].temperatureC, 0);
  assert.equal(hours[1].levels[1].temperatureC, null);
  assert.equal(hours[1].levels[1].parcelDewPointDepressionIndex, null);
});

test('rejects partial anonymous-style response rather than pairing truncated columns with full epochs', () => {
  const raw = fixture();
  raw.epochs = Array.from({ length: 138 }, (_, index) => 1792864800 + index * 3600);
  for (const key of ['u', 'v', 'tmps', 'rhs', 'dps', 'vels', 'elevs', 'vtops', 'bltops', 'dptops', 'cutops', 'tmp2m'])
    raw[key] = Array.from({ length: 37 }, () => structuredClone(raw[key][0]));
  raw.dalrtops = Array.from({ length: 138 }, () => [100, 999, 17.3]);
  assert.throws(() => parsePointcast(raw, request), /37 columns for 138 epochs/);
});

test('validates each supplied field, times, status and unresolved absence markers', () => {
  for (const mutate of [
    (raw) => {
      raw.tmp2m.pop();
    },
    (raw) => {
      raw.u[1].pop();
    },
    (raw) => {
      raw.v = raw.v.map((column) => column.slice(1));
    },
    (raw) => {
      raw.epochs[1] = raw.epochs[0];
    },
    (raw) => {
      raw.tmps[0][0] = '173';
    },
    (raw) => {
      raw.na = [1];
    },
    (raw) => {
      raw.ninterval = 0;
    },
    (raw) => {
      raw.status = 'subscription_required';
    },
  ]) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => parsePointcast(raw, request), /Invalid XC Skies PointCast/);
  }
});

test('does not infer initialization or native coordinates from the request', () => {
  const result = parsePointcast(fixture(), {
    ...request,
    sourceUrl: 'https://n1.xcskies.com/profile/gfs/20261025/18/00?lat=48.6097&lon=-122.426&backdays=1',
  });
  assert.equal(result.referenceTime, null);
  assert.equal(result.returnedCoordinates, null);
  assert.deepEqual(result.requestedCoordinates, { latitude: request.latitude, longitude: request.longitude });
  assert.equal(POINTCAST_FIELDS.find((field) => field.wire === 'vtops').comparability, 'not-equivalent');
});

test('keeps wind and diagnostic vertical grids separate when their spacing differs', () => {
  const raw = fixture();
  raw.level_interval = 200;
  const levels = parsePointcast(raw, request).hours[0].levels;
  assert.deepEqual(
    levels.map((level) => level.heightM),
    [100, 250, 300, 400, 500],
  );
  assert.equal(levels.find((level) => level.heightM === 250).windSpeedMps, null);
  assert.equal(levels.find((level) => level.heightM === 300).temperatureC, undefined);
});
