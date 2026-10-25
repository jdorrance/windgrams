import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { nearestGridpoint, parseIdx } from '@azohra/meteo.grib';
import { parseSiteForecast } from '@azohra/meteo.briefing/contract';
import { DRY_ADIABATIC_LAPSE_C_PER_M, mixingRatioKgKg } from '@azohra/meteo.briefing/derive';
import { capture, captureAsset, inspectField } from './capture.mjs';
import { replay, verifyCapture } from './replay.mjs';
import { readJson, json } from './common.mjs';
import { EXTENDED_HRRR_PRESSURE_LEVELS, fields, selectRecords } from './fields.mjs';
import { projection, regionalGrid, storageIndex, storageCoordinates, wind } from './grid.mjs';
import {
  LENSCHOW_F_MAX,
  LENSCHOW_PEAK_ZETA,
  SOARING_CONTRACT_VERSION,
  WXTOFLY_SINK_MPS,
  assertAgreement,
  cellSource,
  computeBoundaryLayerWind,
  computeExperimentalTerrainAdjustment,
  computeLegacyThermalVelocityMps,
  computeMixedLayerLclM,
  computeNativeGridConvergence,
  computeThermalVelocityMps,
  computeUsableLiftTopV2M,
  deriveCell,
  differences,
  geometricWFromOmegaMps,
  metric,
  metrics,
  profileFor,
  resolvedParcelDepthM,
} from './science.mjs';
import {
  CONUS_REPLAY_INVENTORY,
  ICON_REPLAY_INVENTORY,
  computeImplementationCodeHashes,
  verifyInventoryImportCoverage,
} from './inventory.mjs';
import {
  extractEnsembleMedian,
  extractEnsembleSpread,
  extractModelMetadata,
  normalizeLaunchComparisonHour,
  summarizeModelWindowSpread,
} from './model-comparison.mjs';
import {
  deriveEnsembleSoaringDiagnostics,
  postprocessPointForecast,
} from './point-postprocess.mjs';
import {
  DEFAULT_MAX_ROLLING_RUNS,
  evaluateRaobMatch,
} from '../verification/history.mjs';
import {
  FEED_AVAILABILITY_SPECS,
  evaluateRegionalFreshness,
  selectTargetCycles,
} from '../scripts/check-readiness.mjs';
import { fixtureTransport } from './fixture-helper.mjs';
const c = await readJson(new URL('./cases/north-sound-20261021-00z.json',import.meta.url));
const expandedCase = await readJson(new URL('./cases/north-sound-expanded-v2.json',import.meta.url));
const real = await readJson(new URL('./fixtures/blanchard-raw.json',import.meta.url));
const golden = await readJson(new URL('./fixtures/blanchard-published.json',import.meta.url));
const quiet = () => {};
async function temporary(t) { const root=await mkdtemp(join(tmpdir(),'soaring-test-')); t.after(()=>rm(root,{recursive:true,force:true})); return root; }

test('real archived Blanchard columns reproduce every published hour exactly and compute consistent v2.1.0 diagnostics', () => {
  const results = real.hours.map(h => deriveCell(c,real.terrain,cellSource(c,real.grid,real.cell,h.forecastHour,h.raw),golden.run.generatedAt));
  const profile = profileFor(c,results[0].site,results.map(r=>r.hour),golden.run.generatedAt);
  assert.deepEqual(differences(profile,golden),[]);
  assert.ok(parseSiteForecast(profile));
  assert.equal(profile.hours[0].derived.thermalVelocityMps,0);
  assert.equal(profile.hours[6].derived.thermalVelocityMps,1.06);
  assert.equal(profile.hours[6].derived.usableLiftTopM,724.5);

  // Feedback 1: Audit v2 at Blanchard f20 (index 6) and across all 14 hours
  assert.equal(results[0].v2.contractVersion, SOARING_CONTRACT_VERSION);
  assert.equal(results[0].v2.resolvedThermalTopM, null);
  assert.equal(results[6].v2.resolvedThermalTopM, 504.3); // 221.7 m terrain + 282.6 m HPBL instead of 778.9 m 925 hPa jump
  assert.equal(results[6].v2.thermalVelocityV2Mps, 0.88);
  assert.equal(results[6].v2.usableLiftTopV2M, 470.2);
  assert.equal(results[6].v2.hcritWxtoflyM, 452.2);
  assert.equal(results[6].v2.dryHcritM, 470.2);
  assert.ok(results[6].v2.hcritWxtoflyM <= results[6].v2.usableLiftTopV2M);
  assert.ok(results[6].v2.usableLiftTopV2M <= results[6].v2.dryHcritM);
  assert.ok(results[6].v2.dryHcritM <= results[6].v2.resolvedThermalTopM);
  assert.ok(results[6].v2.thermalTopPlus1CM > results[6].v2.resolvedThermalTopM);
  assert.ok(Math.abs(WXTOFLY_SINK_MPS - 1.143) < 0.001);
  assert.equal(results[6].v2.surfaceLclM, 1315.0);
  assert.equal(results[6].v2.effectiveCloudLimitM, 1315.0);
  assert.equal(results[6].v2.mixedLayerLclM, 1602.3); // Log-pressure layer clipping; independent pressure-mass integration gives 1602.2853 m.
  assert.ok(results[6].v2.cuPotentialM < 0);
  assert.ok(results[6].v2.blMeanWindSpeedMps > 0);
  assert.ok(results[6].v2.blWindShearMps >= 0);

  // Verify invariant across all 14 hours
  for (const r of results) {
    if (!r.v2) continue;
    assert.equal(r.v2.verticalResolution.synthesizedLevels, 0);
    assert.equal(r.v2.verticalResolution.isSparseProfile, true);
    if (r.v2.usableLiftTopV2M !== null) assert.ok(r.v2.usableLiftTopV2M <= r.v2.resolvedThermalTopM);
    if (r.v2.hcritWxtoflyM !== null) assert.ok(r.v2.hcritWxtoflyM <= r.v2.resolvedThermalTopM);
    if (r.v2.dryHcritM !== null) assert.ok(r.v2.dryHcritM <= r.v2.resolvedThermalTopM);
  }

  // Feedback 5: Isolated experimental terrain adjustment
  const expTerrain = results[6].v2.experimental?.terrainAdjustment;
  assert.ok(expTerrain);
  assert.equal(expTerrain.experimental, true);
  assert.equal(expTerrain.rawMslHeightsPreserved, true);
  assert.equal(expTerrain.bracketsLaunchAltitude, true);
  assert.equal(expTerrain.launchElevationM, 378.5);
  assert.equal(expTerrain.modelElevationM, 221.7);
  assert.equal(expTerrain.launchWindSpeedMps, 2.47);

  const wTest = geometricWFromOmegaMps(-1.0, 925, 14.46);
  assert.ok(wTest > 0.08 && wTest < 0.12);
  const hourly=profile.hours.map(h=>({validAt:h.validAt,...Object.fromEntries(metrics.map(k=>[k,[metric(h,k)]]))}));
  assert.equal(assertAgreement(profile,hourly,0).valuesChecked,70);
  hourly[6].thermalVelocityMps[0] += .01;
  assert.throws(()=>assertAgreement(profile,hourly,0),/mismatch/);
});

test('P1-1: usable-lift solver solves descending branch above zeta=0.3125 (F_max=2.03581321244618) and handles cloud caps and sink thresholds', () => {
  assert.equal(LENSCHOW_PEAK_ZETA, 0.3125);
  assert.equal(LENSCHOW_F_MAX, 2.03581321244618);

  // Ground 0 m, thermal depth 1,000 m, W* = 0.8 m/s, sink 1 m/s, cloud base 880 m -> analytical descending crossing 835.21 m
  const withCloud880 = computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.8, cloudBaseM: 880 }, 1.0);
  const withoutCloud = computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.8, cloudBaseM: null }, 1.0);
  assert.equal(Number(withCloud880.toFixed(2)), 835.21);
  assert.equal(Number(withoutCloud.toFixed(2)), 835.21);

  // Lift below sink everywhere (W* * F_max < sink) -> null
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.49, cloudBaseM: null }, 1.0), null);
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.56, cloudBaseM: null }, WXTOFLY_SINK_MPS), null);

  // Cloud below the first usable portion of the curve (W* = 0.5 m/s, cloud at 100 m; 0.5 * F(0.1) = 0.8546 < 1.0) -> null
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.5, cloudBaseM: 100 }, 1.0), null);
  // Cloud on ascending branch where lift IS already >= sink (W* = 0.9 m/s, cloud at 100 m; 0.9 * F(0.1) = 1.538 >= 1.0) -> 100 m
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.9, cloudBaseM: 100 }, 1.0), 100);

  // Lift remaining usable through the thermal top (W* * F(1) >= sink => ratio <= 0.8) -> capped by min(cloudBase, thermalTop)
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 1.5, cloudBaseM: null }, 1.0), 1000);
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 1.5, cloudBaseM: 750 }, 1.0), 750);
  assert.equal(computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 1.5, cloudBaseM: null }, WXTOFLY_SINK_MPS), 1000);

  // Both sink thresholds (1.0 m/s and 1.143 m/s / 225 ft/min)
  const top100 = computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.9, cloudBaseM: null }, 1.0);
  const top225 = computeUsableLiftTopV2M({ modelElevationM: 0, resolvedThermalTopM: 1000, thermalVelocityV2Mps: 0.9, cloudBaseM: null }, WXTOFLY_SINK_MPS);
  // Quartic roots with y = zeta^(1/3): 3.2 y^4 - 4 y + sink/W* = 0.
  assert.equal(Number(top100.toFixed(1)), 888.9);
  assert.equal(Number(top225.toFixed(1)), 827.2);
  assert.ok(top225 < top100);
});

test('P1-2: height-integrated BL wind (retaining 80 m wind) and pressure-mass mixed parcel are invariant to equivalent resampling and clip shallow layers', () => {
  // Synthetic linear wind profile from 0 to 10 m/s over 500 m (eastward, 270 deg)
  const surfaceWind = { windSpeedMps: 0, windDirectionDeg: 270 };
  const levelsCoarse = [
    { heightM: 500, pressureHpa: 955, temperatureC: 15, dewPointC: 9, windSpeedMps: 10, windDirectionDeg: 270 },
    { heightM: 1000, pressureHpa: 900, temperatureC: 10, dewPointC: 6, windSpeedMps: 20, windDirectionDeg: 270 },
  ];
  const levelsResampled = [
    { heightM: 80, pressureHpa: 1003.6, temperatureC: 19.2, dewPointC: 11.52, windSpeedMps: 1.6, windDirectionDeg: 270 },
    ...levelsCoarse,
  ];

  // Over 500 m layer: height mean is 5.00 m/s with or without the 80 m intermediate sample
  const wind500Coarse = computeBoundaryLayerWind(0, surfaceWind, levelsCoarse, 500);
  const wind500Dense = computeBoundaryLayerWind(0, surfaceWind, levelsResampled, 500);
  assert.equal(Number(wind500Coarse.blMeanWindSpeedMps.toFixed(2)), 5.0);
  assert.equal(Number(wind500Dense.blMeanWindSpeedMps.toFixed(2)), 5.0);
  assert.equal(Number(wind500Coarse.blWindShearMps.toFixed(2)), 10.0);

  // Reducing the layer to 100 m clips at 100 m (where speed = 2.0 m/s), giving height mean 1.00 m/s instead of 5.00 m/s
  const wind100Coarse = computeBoundaryLayerWind(0, surfaceWind, levelsCoarse, 100);
  const wind100Dense = computeBoundaryLayerWind(0, surfaceWind, levelsResampled, 100);
  assert.equal(Number(wind100Coarse.blMeanWindSpeedMps.toFixed(2)), 1.0);
  assert.equal(Number(wind100Dense.blMeanWindSpeedMps.toFixed(2)), 1.0);
  assert.equal(Number(wind100Coarse.blTopWindSpeedMps.toFixed(2)), 2.0);
  assert.equal(Number(wind100Coarse.blWindShearMps.toFixed(2)), 2.0);

  // P2: Retain valid 80 m wind even when a pressure-level sample lies below 80 m (e.g., at 50 m)
  const lowLevelJetLevels = [
    { heightM: 50, pressureHpa: 1007, temperatureC: 19, dewPointC: 10, windSpeedMps: 0, windDirectionDeg: 270 },
    { heightM: 210, pressureHpa: 988, temperatureC: 17, dewPointC: 9, windSpeedMps: 10, windDirectionDeg: 270 },
  ];
  const with80m = computeBoundaryLayerWind(
    0,
    { windSpeedMps: 0, windDirectionDeg: 270 },
    [lowLevelJetLevels[0]],
    210,
    { windSpeedMps: 10, windDirectionDeg: 270 },
  );
  assert.ok(with80m.blMeanWindSpeedMps > 0);
  const jetWith210 = computeBoundaryLayerWind(
    0,
    { windSpeedMps: 0, windDirectionDeg: 270 },
    [
      { heightM: 50, pressureHpa: 1007, temperatureC: 19, dewPointC: 10, windSpeedMps: 0, windDirectionDeg: 270 },
      { heightM: 200, pressureHpa: 989, temperatureC: 17, dewPointC: 9, windSpeedMps: 0, windDirectionDeg: 270 },
    ],
    100,
    { windSpeedMps: 20.7, windDirectionDeg: 270 },
  );
  assert.equal(Number(jetWith210.blMeanWindSpeedMps.toFixed(2)), 6.90);

  // Coincident heights at 80 m are merged cleanly without zero-thickness NaN/division issues
  const coincident80 = computeBoundaryLayerWind(
    0,
    { windSpeedMps: 0, windDirectionDeg: 270 },
    [
      { heightM: 80, pressureHpa: 1003.6, temperatureC: 19.2, dewPointC: 11.5, windSpeedMps: 8, windDirectionDeg: 270 },
      { heightM: 160, pressureHpa: 994, temperatureC: 18.4, dewPointC: 11.0, windSpeedMps: 16, windDirectionDeg: 270 },
    ],
    160,
    { windSpeedMps: 8, windDirectionDeg: 270 },
  );
  assert.equal(Number(coincident80.blMeanWindSpeedMps.toFixed(2)), 8.0);

  // Turning winds: 10 m/s from South (180 deg, v=+10) at surface to 10 m/s from West (270 deg, u=+10) at 500 m
  const turningLevels = [{ heightM: 500, pressureHpa: 955, temperatureC: 15, dewPointC: 9, windSpeedMps: 10, windDirectionDeg: 270 }];
  const turningWind = computeBoundaryLayerWind(0, { windSpeedMps: 10, windDirectionDeg: 180 }, turningLevels, 500);
  assert.equal(Number(turningWind.blMeanWindSpeedMps.toFixed(2)), 7.07); // hypot(5, 5) = 7.071 m/s
  assert.equal(Number(turningWind.blMeanWindDirDeg.toFixed(1)), 225.0); // SW
  assert.equal(Number(turningWind.blWindShearMps.toFixed(2)), 14.14); // hypot(10, -10) = 14.142 m/s

  // Insufficient coverage returns null
  assert.equal(computeBoundaryLayerWind(0, { windSpeedMps: null, windDirectionDeg: 270 }, [], 500), null);
  assert.equal(computeBoundaryLayerWind(0, surfaceWind, [], 500), null);

  // Equivalent thermodynamic resampling preserves theta and mixing ratio as
  // linear functions of pressure, with log-pressure interpolation over height.
  // Keep the lowest level fixed so the inferred surface pressure stays fixed.
  const [lower, upper] = levelsCoarse;
  const p = Math.sqrt(lower.pressureHpa * upper.pressureHpa);
  const fraction = (lower.pressureHpa - p) / (lower.pressureHpa - upper.pressureHpa);
  const theta = level => (level.temperatureC + 273.15) * (1000 / level.pressureHpa) ** 0.2854;
  const mixedTheta = theta(lower) + fraction * (theta(upper) - theta(lower));
  const r0 = mixingRatioKgKg(lower.dewPointC, lower.pressureHpa);
  const r1 = mixingRatioKgKg(upper.dewPointC, upper.pressureHpa);
  const r = r0 + fraction * (r1 - r0), vaporPressure = r * p / (0.622 + r);
  const gamma = Math.log(vaporPressure / 6.1094);
  const intermediate = { heightM: 750, pressureHpa: p,
    temperatureC: mixedTheta * (p / 1000) ** 0.2854 - 273.15,
    dewPointC: 243.04 * gamma / (17.625 - gamma) };
  const equivalent = [lower, intermediate, upper];
  const lcl1000Coarse = computeMixedLayerLclM(0, 20, 12, levelsCoarse, 1000);
  const lcl1000Dense = computeMixedLayerLclM(0, 20, 12, equivalent, 1000);
  assert.ok(Math.abs(lcl1000Coarse - lcl1000Dense) < 1e-8);
  const lcl600Coarse = computeMixedLayerLclM(0, 20, 12, levelsCoarse, 600);
  const lcl600Dense = computeMixedLayerLclM(0, 20, 12, equivalent, 600);
  assert.ok(Math.abs(lcl600Coarse - lcl600Dense) < 1e-8);
  assert.notEqual(Math.round(lcl600Coarse), Math.round(lcl1000Coarse));
  assert.equal(computeMixedLayerLclM(0, 20, 12, [], 500), null);
});

test('P1-3: surface-density-consistent Deardorff W* is invariant to reference pressure and avoids upper-level pressure bias', () => {
  // Controlled dry example: 20 C, sensible heat 200 W/m2, latent heat 0, depth 1,000 m
  // At 1,000 hPa surface (with first upper level at 925 hPa): legacy gives 1.712 m/s, surface-consistent gives 1.777 m/s
  const legacy1000 = computeLegacyThermalVelocityMps(20, 200, 0, 1000, 925);
  const v21_1000 = computeThermalVelocityMps({
    surfaceTemperatureC: 20,
    sensibleHeatFluxWm2: 200,
    latentHeatFluxWm2: 0,
    boundaryLayerDepthM: 1000,
    surfacePressureHpa: 1000,
  });
  assert.equal(Number(legacy1000.toFixed(3)), 1.712);
  assert.equal(Number(v21_1000.toFixed(3)), 1.777);

  // At 800 hPa surface (elevated site with first upper level at 750 hPa): legacy gives 1.678 m/s, surface-consistent gives 1.914 m/s
  const legacy800 = computeLegacyThermalVelocityMps(20, 200, 0, 1000, 750);
  const v21_800 = computeThermalVelocityMps({
    surfaceTemperatureC: 20,
    sensibleHeatFluxWm2: 200,
    latentHeatFluxWm2: 0,
    boundaryLayerDepthM: 1000,
    surfacePressureHpa: 800,
  });
  assert.equal(Number(legacy800.toFixed(3)), 1.678);
  assert.equal(Number(v21_800.toFixed(3)), 1.914);

  // Exact invariance to arbitrary potential-temperature reference pressure (500, 850, 1000, 1013.25, 1015 hPa)
  for (const pRef of [500, 850, 1000, 1013.25, 1015]) {
    const wRef = computeThermalVelocityMps({
      surfaceTemperatureC: 20,
      sensibleHeatFluxWm2: 200,
      latentHeatFluxWm2: 0,
      boundaryLayerDepthM: 1000,
      surfacePressureHpa: 1000,
      referencePressureHpa: pRef,
    });
    assert.ok(Math.abs(wRef - v21_1000) < 1e-12);
  }

  // Insensitivity to which upper level is listed first when surface pressure is known
  const wFrom925 = computeThermalVelocityMps({
    surfaceTemperatureC: 20,
    sensibleHeatFluxWm2: 200,
    latentHeatFluxWm2: 0,
    boundaryLayerDepthM: 1000,
    surfacePressureHpa: 1000,
    firstLevel: { heightM: 750, pressureHpa: 925, temperatureC: 13 },
  });
  const wFrom850 = computeThermalVelocityMps({
    surfaceTemperatureC: 20,
    sensibleHeatFluxWm2: 200,
    latentHeatFluxWm2: 0,
    boundaryLayerDepthM: 1000,
    surfacePressureHpa: 1000,
    firstLevel: { heightM: 1450, pressureHpa: 850, temperatureC: 8 },
  });
  assert.ok(Math.abs(wFrom925 - wFrom850) < 1e-12);
});

test('Feedback 2: expanded 18-level HRRR field selection and 80 m wind match captured .idx inventory without synthetic levels', async () => {
  assert.equal(EXTENDED_HRRR_PRESSURE_LEVELS.length, 18);
  const idxBytes = await readFile(new URL('./fixtures/hrrr-20261021-00z-f20.idx', import.meta.url));
  const selected = selectRecords(parseIdx(idxBytes.toString()), expandedCase, 20);
  const byKey = Object.fromEntries(selected.map(s => [s.key, s]));
  assert.ok(byKey['u80m']?.record);
  assert.ok(byKey['v80m']?.record);
  assert.ok(byKey['1000.TMP']?.record);
  assert.ok(byKey['975.TMP']?.record);
  assert.ok(byKey['950.TMP']?.record);
  assert.ok(byKey['500.HGT']?.record);
  assert.ok(byKey['400.HGT']?.record);
  assert.ok(byKey['nativeCloudBaseM']?.record);
  assert.ok(byKey['nativeAdiabaticLclM']?.record);
});

test('Feedback 3 & 4: model-aware post-processing handles deterministic, GEPS ensemble, and sparse ECMWF/NWS adapters', () => {
  // Deterministic model preserves v1 derived and adds v2 soaring
  const detDoc = postprocessPointForecast(structuredClone(golden), { modelSlug: 'hrrr-conus', launchElevationM: 378.5 });
  assert.equal(detDoc.soaringMeta.contractVersion, SOARING_CONTRACT_VERSION);
  assert.equal(detDoc.soaringMeta.synthesizedLevels, 0);
  assert.equal(detDoc.hours[6].derived.usableLiftTopM, 724.5); // v1 untouched
  assert.equal(detDoc.hours[6].soaring.usableLiftTopV2M, 470.2); // v2 bounded by 504.3m resolved top
  // Published rounded temperature/dew point give 1315.3494 m by Bolton's LCL formula.
  assert.equal(detDoc.hours[6].soaring.surfaceLclM, 1315.3);
  assert.equal(detDoc.hours[6].soaring.effectiveCloudLimitM, 1315.0);

  // GEPS ensemble percentile document refuses nonlinear median post-processing
  const gepsDoc = {
    schemaVersion: 2,
    model: 'geps',
    run: { referenceTime: '2026-10-21T00:00:00Z', generatedAt: '2026-10-21T07:00:00Z', members: 21 },
    site: { id: 'wa-blanchard', name: 'Blanchard', latitude: 48.6, longitude: -122.4, modelElevationM: 94.3 },
    hours: [{ validAt: '2026-10-21T20:00:00Z', surface: { temperatureC: { members: 21, p10: 12, p25: 13, p50: 14, p75: 15, p90: 16 } }, levels: [], derived: {} }],
  };
  const gepsOut = postprocessPointForecast(gepsDoc, { modelSlug: 'geps' });
  assert.equal(gepsOut.soaringMeta.modelKind, 'ensemble-percentiles');
  assert.equal(gepsOut.soaringMeta.nonlinearMedianPostprocessRefused, true);
  assert.equal(gepsOut.hours[0].soaring, undefined);

  // Per-member ensemble derivation computes nonlinear diagnostics per member before percentiles
  const memberCols = [0, 1, 2].map(offset => {
    const src = structuredClone(real.hours[6].source);
    src.temperatureC += offset * 0.5;
    src.sensibleHeatFluxWm2 += offset * 20;
    return { source: src, v1Hour: golden.hours[6] };
  });
  const ensAgg = deriveEnsembleSoaringDiagnostics(memberCols, real.terrain, { launchElevationM: 378.5 });
  assert.equal(ensAgg.derivationRule, 'per-member-before-percentiles');
  assert.equal(ensAgg.memberCount, 3);
  assert.ok(ensAgg.thermalVelocityV2Mps.p50 >= ensAgg.thermalVelocityV2Mps.p10);
  assert.ok(ensAgg.usableLiftTopV2M.p90 <= ensAgg.resolvedThermalTopM.p90);
  assert.ok(ensAgg.effectiveCloudLimitM.p50 > 0);

  // Feedback 4: ECMWF and NWS keep unsupported W* and usableLiftTopM null
  const ecmwfDoc = postprocessPointForecast({
    models: { surface: { id: 'ecmwf_ifs', run: '2026-10-21T00:00:00Z' } },
    site: { slug: 'wa-blanchard', gridElevationM: 386 },
    hours: [{ validAt: '2026-10-21T20:00:00Z', temperatureC: 15, dewPointC: 7, boundaryLayerHeightM: 450, windSpeedMps: 3 }],
  }, { modelSlug: 'ecmwf' });
  assert.equal(ecmwfDoc.hours[0].soaring.thermalVelocityV2Mps, null);
  assert.equal(ecmwfDoc.hours[0].soaring.usableLiftTopV2M, null);
  assert.ok(ecmwfDoc.hours[0].soaring.surfaceLclM > 386);

  const nwsDoc = postprocessPointForecast({
    grid: { office: 'SEW', elevationM: 300 },
    site: { slug: 'wa-blanchard' },
    hours: [{ validAt: '2026-10-21T20:00:00Z', temperatureC: 14, dewpointC: 8, mixingHeightM: 500, transportWindSpeedMps: 4.2, transportWindDirectionDeg: 185 }],
  }, { modelSlug: 'nws' });
  assert.equal(nwsDoc.hours[0].soaring.thermalVelocityV2Mps, null);
  assert.equal(nwsDoc.hours[0].soaring.usableLiftTopV2M, null);
  assert.equal(nwsDoc.hours[0].soaring.blMeanWindSpeedMps, 4.2);
  assert.ok(nwsDoc.hours[0].soaring.surfaceLclM > 300);

  // Feedback 5: Unbracketed launch altitude returns null launchWindSpeedMps
  const unbracketed = computeExperimentalTerrainAdjustment(500, 180, real.hours[6].source, real.hours[6].source.levels);
  assert.equal(unbracketed.bracketsLaunchAltitude, false);
  assert.equal(unbracketed.launchWindSpeedMps, null);
});

test('Feedback 6 & 7: matched observation verification rules, 120-run (30-day) retention, and availability-aware readiness', () => {
  assert.equal(DEFAULT_MAX_ROLLING_RUNS, 120); // 30 days at 4 runs/day

  // Rejects legacy KUIL 00Z vs Blyn f14 (14h time mismatch + 113 km spatial separation)
  const badKuil = evaluateRaobMatch({
    distanceKm: 113,
    soundingValidAt: '2026-10-21T00:00:00Z',
    forecastValidAt: '2026-10-21T14:00:00Z',
    referenceTime: '2026-10-21T00:00:00Z',
  });
  assert.equal(badKuil.matched, false);
  assert.equal(badKuil.matchStatus, 'rejected-time-and-spatial-mismatch');

  // Accepts KMFR vs Woodrat Mountain (18 km, matched 00Z / f01 initialization window)
  const goodKmfr = evaluateRaobMatch({
    distanceKm: 18,
    soundingValidAt: '2026-10-21T00:00:00Z',
    forecastValidAt: '2026-10-21T01:00:00Z',
    referenceTime: '2026-10-21T00:00:00Z',
  });
  assert.equal(goodKmfr.matched, true);
  assert.equal(goodKmfr.leadTimeBucket, 'f00-f06');

  // Feedback 7: Complete-run availability (107 min for HRRR)
  assert.equal(FEED_AVAILABILITY_SPECS['hrrr-conus'].completeRunAvailabilityMinutes, 107);
  // At 00:15 UTC (15 min after 00Z init), 00Z HRRR is NOT yet available; primary candidate is 18Z from previous day
  const at0015 = selectTargetCycles('hrrr-conus', Date.parse('2026-10-21T00:15:00Z'));
  assert.equal(at0015.primaryCandidate.referenceTime, '2026-10-20T18:00:00Z');
  // At 01:55 UTC (115 min after 00Z init), 00Z HRRR complete run IS available
  const at0155 = selectTargetCycles('hrrr-conus', Date.parse('2026-10-21T01:55:00Z'));
  assert.equal(at0155.primaryCandidate.referenceTime, '2026-10-21T00:00:00Z');
  const freshness = evaluateRegionalFreshness('2026-10-21T12:00:00Z', Date.parse('2026-10-21T15:00:00Z'));
  assert.ok(freshness.every(r => r.meetsFreshnessDeadline));
});

test('independent dry-column numerical reference, zero flux, and column ceiling', () => {
  const source=structuredClone(real.hours[6].source);
  Object.assign(source,{temperatureC:20,dewPointDepressionC:20,sensibleHeatFluxWm2:100,latentHeatFluxWm2:0});
  source.levels=[500,1000,1500].map((z,i)=>({heightM:z,pressureHpa:[950,900,850][i],temperatureC:16-.006*z,dewPointDepressionC:20,windSpeedMps:2,windDirectionDeg:180}));
  const depth=4/(DRY_ADIABATIC_LAPSE_C_PER_M-.006);
  const w=Math.cbrt(.0075516/(293.15*(1015/950)**.28482)*100*depth);
  const hour=deriveCell(c,0,source,'2026-10-22T00:00:00Z').hour;
  assert.equal(hour.derived.boundaryLayerTopM,Math.round(depth*10)/10);
  assert.equal(hour.derived.thermalVelocityMps,Math.round(w*100)/100);
  source.sensibleHeatFluxWm2=-10;
  assert.equal(deriveCell(c,0,source,golden.run.generatedAt).hour.derived.thermalVelocityMps,0);
  assert.equal(deriveCell(c,0,source,golden.run.generatedAt).hour.derived.usableLiftTopM,null);
  source.temperatureC=50;
  assert.equal(deriveCell(c,0,source,golden.run.generatedAt).ceilingReached,true);
});

test('terrain masks inadequate coverage; missing inputs never become zero lift', () => {
  const source=structuredClone(real.hours[6].source);
  const heights=source.levels.map(l=>l.heightM).sort((a,b)=>a-b);
  const result=deriveCell(c,heights.at(-3),source,golden.run.generatedAt);
  assert.equal(result.status,'insufficient-levels'); assert.equal(result.hour,null);
  assert.equal(deriveCell(c,null,source,golden.run.generatedAt).status,'missing');
  const raw={...real.hours[6].raw,temperature:null};
  assert.equal(cellSource(c,real.grid,real.cell,20,raw),null);
  const optional={...real.hours[6].raw,'smoke.aot':null,pblHeightM:null};
  const without=cellSource(c,real.grid,real.cell,20,optional);
  assert.equal(without.smoke,undefined); assert.equal(without.pblHeightM,undefined);
});

test('Lambert geometry, native nearest cell, scanning orders, wind rotation, and native convergence', () => {
  const p=projection(real.grid), region=regionalGrid(real.grid,c);
  assert.equal(region.cells.length,2259); assert.equal(region.nearest.index,1779497);
  assert.equal(region.siteCell,1478);
  for (const cell of region.cells.filter((_,i)=>i%100===0)) {
    const [i,j]=p.fractional(cell.longitude,cell.latitude);
    assert.ok(Math.abs(i-Math.round(i))<1e-7); assert.ok(Math.abs(j-Math.round(j))<1e-7);
    assert.equal(storageIndex(real.grid,Math.round(i),Math.round(j)),cell.index);
    assert.equal(nearestGridpoint(real.grid,cell.latitude,cell.longitude).index,cell.index);
  }
  for (const jPointsAreConsecutive of [true,false]) for (const alternativeRowScanning of [true,false]) {
    const grid={...real.grid,ni:4,nj:3,jPointsAreConsecutive,alternativeRowScanning};
    const indices=[];for(let j=0;j<3;j++)for(let i=0;i<4;i++)indices.push(storageIndex(grid,i,j));
    assert.deepEqual(indices.sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i));
    assert.equal(storageIndex(grid,1,1),jPointsAreConsecutive?4:(alternativeRowScanning?6:5));
  }
  const rotated=wind(real.grid,real.grid.loV-20,0,10);
  const angle=20*Math.sin(38.5*Math.PI/180);
  assert.ok(Math.abs(rotated.windSpeedMps-10)<1e-12);
  assert.ok(Math.abs(rotated.windDirectionDeg-(180-angle))<1e-9);
  assert.equal(wind(real.grid,0,null,1),null);
  const zeroConv = computeNativeGridConvergence(real.grid, region.cells, new Array(region.cells.length).fill(5), new Array(region.cells.length).fill(3));
  assert.equal(zeroConv[region.siteCell], 0);
});

test('capture/replay is offline, deterministic, atomic, and rejects damaged inputs', async t => {
  const root=await temporary(t), cache=join(root,'cache'), output=join(root,'output');
  const small={...c,forecastHours:[14,20]};
  const transport=await fixtureTransport(small);
  const captured=await capture(small,cache,{fetchImpl:transport,log:quiet});
  const noNetwork=()=>{throw new Error('NETWORK DISABLED');};
  const resumed=await capture(small,cache,{fetchImpl:noNetwork,log:quiet});
  assert.deepEqual(captured,resumed);
  const oldFetch=globalThis.fetch;globalThis.fetch=noNetwork;t.after(()=>{globalThis.fetch=oldFetch;});
  const first=await replay(small,cache,output,{log:quiet});
  const second=await replay(small,cache,output,{log:quiet});
  assert.deepEqual(first.hashes,second.hashes);assert.equal(first.path,second.path);
  assert.equal(first.audit.mapProfileAgreement.exact,true);
  const publishedManifest = await readJson(join(first.path, 'manifest.json'));
  const publishedHours = await Promise.all(publishedManifest.hours.map(async hour => JSON.parse(gunzipSync(await readFile(join(first.path, hour.file))))));
  assert.ok(publishedManifest.hours.every(hour => hour.file.endsWith('.json.gz')));
  assert.ok(publishedHours.every(hour => hour.levelsByPressure === undefined));
  const cellProfile = JSON.parse(gunzipSync(await readFile(join(first.path, `cell-${publishedManifest.siteCell}.json.gz`))));
  const primaryProfile = await readJson(join(first.path, 'profile.json'));
  assert.deepEqual(cellProfile.hours, primaryProfile.hours);
  assert.ok(assertAgreement(cellProfile, publishedHours, publishedManifest.siteCell).exact);
  for (const [name, bytes] of Object.entries(publishedManifest.fileBytes)) assert.equal((await readFile(join(first.path, name))).byteLength, bytes, name);
  assert.equal((await readdir(output)).some(n=>n.startsWith('.staging')),false);
  const pointer=await readFile(join(output,c.id,'index.json'),'utf8');
  const manifestPath=join(cache,'capture.json'), original=await readFile(manifestPath);
  const broken=structuredClone(captured);broken.sources[1].records.splice(0,1);
  await writeFile(manifestPath,json(broken));await assert.rejects(verifyCapture(small,cache),/inventory/);
  await writeFile(manifestPath,original);
  await assert.rejects(verifyCapture({...small,referenceTime:'2026-10-20T00:00:00Z'},cache),/case\/run/);
  const record=captured.sources[1].records[0], path=join(cache,record.file), bytes=await readFile(path);
  const wrong=Buffer.from(bytes);wrong[16+16]=20;
  assert.throws(()=>inspectField(wrong,small,14),/Wrong run/);
  assert.throws(()=>inspectField(bytes,small,20),/forecast time/);
  assert.throws(()=>inspectField(bytes,small,14,'wrong-grid'),/grid/);
  assert.throws(()=>inspectField(bytes,small,14,undefined,fields(small,14)[1]),/variable\/level/);
  await writeFile(path,bytes.subarray(0,bytes.length-1));
  await assert.rejects(replay(small,cache,output,{log:quiet}),/Corrupt cache/);
  assert.equal(await readFile(join(output,c.id,'index.json'),'utf8'),pointer);
  await rm(path);await assert.rejects(verifyCapture(small,cache),/ENOENT/);
});

test('ignored ranges, wrong content ranges, partial responses leave no reusable asset', async t => {
  const root=await temporary(t), record={offset:10,length:4};
  for(const [name,status,body,range] of [['ignored',200,'1234','bytes 10-13/99'],['partial',206,'12','bytes 10-13/99'],['wrong',206,'1234','bytes 0-3/99']]) {
    await assert.rejects(captureAsset(root,name,'https://example.invalid',record,()=>{},async()=>new Response(body,{status,headers:{'content-range':range}})));
    assert.equal((await readdir(root)).includes(`${name}.json`),false);
  }
  assert.deepEqual(await readdir(root),[]);
});


test('convergence honors every scan order and signed grid spacing', () => {
  for (const jPointsAreConsecutive of [false,true]) for (const alternativeRowScanning of [false,true])
  for (const iScansNegatively of [false,true]) for (const jScansPositively of [false,true]) {
    const grid={ni:4,nj:3,dxM:3000,dyM:3000,jPointsAreConsecutive,alternativeRowScanning,iScansNegatively,jScansPositively};
    const cells=[],u=[],v=[];
    for(let j=0;j<3;j++) for(let i=0;i<4;i++) {
      const index=storageIndex(grid,i,j);
      assert.deepEqual(storageCoordinates(grid,index),[i,j]);
      cells.push({index}); u.push(-i*3000*(iScansNegatively?-1:1)*1e-5);v.push(-j*3000*(jScansPositively?1:-1)*2e-5);
    }
    assert.deepEqual(computeNativeGridConvergence(grid,cells,u,v),Array(12).fill(3));
  }
});

test('pressure-level wind and vertical motion below terrain are unavailable', () => {
  const sample=real.hours[6];
  const source=cellSource(c,real.grid,real.cell,sample.forecastHour,sample.raw);
  const result=deriveCell(c,1000,source,golden.run.generatedAt);
  assert.ok(result.v2);
  assert.equal(result.v2.wind925SpeedMps,null);
  assert.equal(result.v2.wind925DirDeg,null);
  assert.equal(result.v2.w925Mps,null);
  assert.ok(result.v2.wind850SpeedMps!==null);
});

test('Stage 0: characterizes near-neutral first-layer parcel depth behavior and defined-domain physical invariants', () => {
  const env = [
    { heightM: 1000, temperatureC: 10 },
    { heightM: 2000, temperatureC: 0 },
    { heightM: 3000, temperatureC: -10 },
  ];
  // Preserved v2.1.0 baseline characterization: near-neutral first-layer denominator guard (denom <= 1e-5)
  assert.equal(resolvedParcelDepthM(19.700, 100, 0, null, 0, env, 0), 1000);
  assert.equal(resolvedParcelDepthM(19.795, 100, 0, null, 0, env, 0), 0);
  assert.equal(resolvedParcelDepthM(19.805, 100, 0, null, 0, env, 0), 3000);
  // When model PBL height is present, the PBL fallback branch avoids the heat-flux denominator guard
  assert.equal(resolvedParcelDepthM(19.795, 100, 0, 650, 0, env, 0), 650);

  // Defined-domain invariant 1: W* is nondecreasing with sensible heat flux for fixed valid inputs
  let prevW = 0;
  for (const hs of [0, 25, 75, 150, 300, 500]) {
    const w = computeThermalVelocityMps({
      surfaceTemperatureC: 22,
      surfaceDewPointC: 10,
      sensibleHeatFluxWm2: hs,
      latentHeatFluxWm2: 40,
      boundaryLayerDepthM: 1200,
      surfacePressureHpa: 980,
    });
    assert.ok(w >= prevW);
    prevW = w;
  }

  // Defined-domain invariant 2 & 3: increasing sink rate never raises a finite usable ceiling,
  // and every finite usable ceiling is bounded by min(resolvedThermalTopM, effectiveCloudLimitM).
  for (const wstar of [0.6, 0.85, 1.2, 2.0, 3.2]) {
    for (const cloudCap of [null, 650, 1100, 1800]) {
      const top08 = computeUsableLiftTopV2M({ modelElevationM: 200, resolvedThermalTopM: 1400, thermalVelocityV2Mps: wstar, cloudBaseM: cloudCap }, 0.8);
      const top10 = computeUsableLiftTopV2M({ modelElevationM: 200, resolvedThermalTopM: 1400, thermalVelocityV2Mps: wstar, cloudBaseM: cloudCap }, 1.0);
      const topWx = computeUsableLiftTopV2M({ modelElevationM: 200, resolvedThermalTopM: 1400, thermalVelocityV2Mps: wstar, cloudBaseM: cloudCap }, WXTOFLY_SINK_MPS);
      const effectiveBound = cloudCap === null ? 1400 : Math.min(1400, cloudCap);
      for (const top of [top08, top10, topWx]) {
        if (top !== null) {
          assert.ok(top >= 200 && top <= effectiveBound + 1e-9);
        }
      }
      if (top10 !== null && top08 !== null) assert.ok(top10 <= top08 + 1e-9);
      if (topWx !== null && top10 !== null) assert.ok(topWx <= top10 + 1e-9);
    }
  }
});

test('Stage 1 & 5: implementation inventories cover all relative imports and change hashes when any extracted module changes', () => {
  const conusCoverage = verifyInventoryImportCoverage(CONUS_REPLAY_INVENTORY);
  const iconCoverage = verifyInventoryImportCoverage(ICON_REPLAY_INVENTORY);
  assert.ok(conusCoverage.verifiedFiles >= 15);
  assert.ok(iconCoverage.verifiedFiles >= 15);

  const baselineHashes = computeImplementationCodeHashes(CONUS_REPLAY_INVENTORY);
  assert.ok(baselineHashes['thermodynamics.mjs']);
  assert.ok(baselineHashes['convective-lift.mjs']);
  assert.ok(baselineHashes['boundary-layer-wind.mjs']);
  assert.ok(baselineHashes['diagnostics.mjs']);

  const mutatedHashes = computeImplementationCodeHashes(CONUS_REPLAY_INVENTORY, relPath =>
    relPath === 'thermodynamics.mjs' ? Buffer.from('// modified implementation\n') : Buffer.from(relPath),
  );
  const untouchedHashes = computeImplementationCodeHashes(CONUS_REPLAY_INVENTORY, relPath => Buffer.from(relPath));
  assert.notEqual(mutatedHashes['thermodynamics.mjs'], untouchedHashes['thermodynamics.mjs']);
});

test('Stage 2: model-comparison normalizer preserves ensemble dropout, scalar wind direction, V2/legacy separation, and sparse adapters', () => {
  // Zero-member ensemble dropout returns null rather than zero
  assert.equal(extractEnsembleMedian({ members: 0, p10: null, p50: null, p90: null }), null);
  assert.equal(extractEnsembleMedian({ members: 0, p10: 0, p50: 0, p90: 0 }), null);
  assert.equal(extractEnsembleSpread({ members: 0, p10: 1, p90: 5 }), null);

  // GEPS legacy-only hour preserves scalar windDirectionDeg (209 deg) and keeps V2 fields null
  const gepsLegacyHour = normalizeLaunchComparisonHour('geps', {
    validAt: '2026-10-21T21:00:00Z',
    surface: {
      temperatureC: { members: 20, p10: 10.1, p50: 12.4, p90: 14.2 },
      dewPointC: { members: 20, p10: 4.0, p50: 6.1, p90: 8.0 },
      windSpeedMps: { members: 20, p10: 2.1, p50: 4.5, p90: 7.3 },
      windDirectionDeg: 209,
      cloudCoverPercent: { members: 20, p10: 10, p50: 35, p90: 80 },
    },
    derived: {
      thermalVelocityMps: { members: 20, p10: 0.4, p50: 1.1, p90: 1.6 },
      usableLiftTopM: { members: 20, p10: 450, p50: 780, p90: 1120 },
      boundaryLayerTopM: { members: 20, p10: 600, p50: 950, p90: 1300 },
      cloudBaseM: { members: 20, p10: 900, p50: 1250, p90: 1600 },
    },
  });
  assert.equal(gepsLegacyHour.windDirectionDeg, 209);
  assert.equal(gepsLegacyHour.wstarV2Mps, null);
  assert.equal(gepsLegacyHour.wstarSpreadMps, null);
  assert.equal(gepsLegacyHour.wstarMps, 1.1);
  assert.deepEqual(gepsLegacyHour.wstarLegacySpreadMps, { p10: 0.4, p90: 1.6 });

  // Deterministic explicit V2 null vs absent V2
  const detWithV2Null = normalizeLaunchComparisonHour('hrrr-conus', {
    validAt: '2026-10-21T20:00:00Z',
    surface: { temperatureC: 15, dewPointC: 8, windSpeedMps: 3, windDirectionDeg: 240 },
    derived: { thermalVelocityMps: 1.06, usableLiftTopM: 724.5, boundaryLayerTopM: 778.9, cloudBaseM: 1315.0 },
    soaring: { thermalVelocityV2Mps: 0.42, usableLiftTopV2M: null, resolvedThermalTopM: 480.0, surfaceLclM: 1315.3, effectiveCloudLimitM: 980.0 },
  });
  assert.equal(Object.hasOwn(detWithV2Null, 'usableLiftTopV2M'), true);
  assert.equal(detWithV2Null.usableLiftTopV2M, null);
  assert.equal(detWithV2Null.usableLiftTopM, 724.5);

  const detWithoutV2 = normalizeLaunchComparisonHour('hrrr-conus', {
    validAt: '2026-10-21T20:00:00Z',
    surface: { temperatureC: 15, dewPointC: 8, windSpeedMps: 3, windDirectionDeg: 240 },
    derived: { thermalVelocityMps: 1.06, usableLiftTopM: 724.5, boundaryLayerTopM: 778.9, cloudBaseM: 1315.0 },
  });
  assert.equal(Object.hasOwn(detWithoutV2, 'usableLiftTopV2M'), false);

  // Sparse adapter keeps W* and usableLiftTop null
  const ecmwfNorm = normalizeLaunchComparisonHour('ecmwf', {
    validAt: '2026-10-21T20:00:00Z',
    temperatureC: 16.2,
    dewPointC: 7.4,
    windSpeedMps: 3.8,
    windDirectionDeg: 215,
    soaring: { surfaceLclM: 1480.0, modelBlTopM: 920.0 },
  });
  assert.equal(ecmwfNorm.wstarMps, null);
  assert.equal(ecmwfNorm.usableLiftTopM, null);
  assert.equal(ecmwfNorm.surfaceLclM, 1480.0);
  assert.equal(ecmwfNorm.blTopM, 920.0);

  const meta = extractModelMetadata({ site: { gridElevationM: 386 }, models: { surface: { run: '2026-10-21T00:00:00Z' } } }, 'ecmwf');
  assert.equal(meta.modelKind, 'surface-or-sparse-adapter');
  assert.equal(meta.modelElevationM, 386);
  const summary = summarizeModelWindowSpread('ecmwf', { site: { gridElevationM: 386 } }, []);
  assert.equal(summary.status, 'unavailable');
  assert.equal(summary.peakWstarV2Mps, null);
});
