import test from 'node:test';
import assert from 'node:assert/strict';
import { parcelLclAglM, geometricWFromOmegaMps, computeBoundaryLayerWind, computeMixedLayerLclM } from '@windgrams/meteorology';
import { sunPosition, sunVector, sunriseSunset } from '@windgrams/meteorology/sun';

test('LCL anchors saturated parcels at ground and preserves missing values', () => {
  assert.equal(parcelLclAglM(20,20),0);
  assert.equal(parcelLclAglM(null,10),null);
  assert.ok(parcelLclAglM(20,10)>1000);
});

test('omega sign and physical density are retained', () => {
  assert.ok(geometricWFromOmegaMps(-1,850,10)>0);
  assert.equal(geometricWFromOmegaMps(-1,0,10),null);
  assert.equal(Math.abs(geometricWFromOmegaMps(0,850,10)),0);
});

test('boundary-layer averaging uses wind vectors across north', () => {
  const result=computeBoundaryLayerWind(100,{windSpeedMps:10,windDirectionDeg:350},
    [{heightM:1100,windSpeedMps:10,windDirectionDeg:10}],1100);
  assert.ok(result);
  assert.ok(result.blMeanWindDirDeg<1e-9 || result.blMeanWindDirDeg>359.999999);
  assert.ok(result.blMeanWindSpeedMps>9.8 && result.blMeanWindSpeedMps<10);
});

test('a zero-depth boundary layer retains the surface wind and parcel LCL', () => {
  const terrainM = 650;
  const surfaceWind = { windSpeedMps: 12, windDirectionDeg: 270 };
  const levels = [{ heightM: 1650, pressureHpa: 850, temperatureC: 10, dewPointC: 5,
    windSpeedMps: 30, windDirectionDeg: 180 }];
  const wind = computeBoundaryLayerWind(terrainM, surfaceWind, levels, terrainM);
  assert.ok(wind);
  assert.ok(Math.abs(wind.blMeanWindSpeedMps - 12) < 1e-12);
  assert.ok(Math.abs(wind.blTopWindSpeedMps - 12) < 1e-12);
  assert.equal(wind.blMeanWindDirDeg, 270);
  assert.equal(wind.blTopWindDirDeg, 270);
  assert.equal(wind.blWindShearMps, 0);
  assert.equal(computeMixedLayerLclM(terrainM, 20, 10, levels, terrainM),
    terrainM + parcelLclAglM(20, 10));
});

test('solar exports work without browser globals in both hemispheres', () => {
  const ms=Date.parse('2026-10-25T00:00:00Z');
  const position=sunPosition(ms,-43.5,172.6);
  const vector=sunVector(position);
  assert.ok(Math.abs(Math.hypot(...vector)-1)<1e-12);
  const events=sunriseSunset(Date.parse('2026-10-24T11:00:00Z'),Date.parse('2026-10-25T11:00:00Z'),-43.5,172.6);
  assert.ok(events && events.sunrise<events.sunset);
});
