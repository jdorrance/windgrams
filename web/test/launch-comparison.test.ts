import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLaunchComparisonRows,
  buildMultimodelComparisonRow,
  buildRegionalLaunchTableRows,
} from '../src/lib/launch-comparison.ts';
import {
  validateCrossSectionDoc,
  validateLaunchesDoc,
  validateReplayAudit,
  validateReplayGrid,
  validateVerificationDoc,
  type LaunchEntry,
} from '../src/lib/soaring-contracts.ts';
import {
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  feetPerMinuteToMps,
  feetToMetres,
  finiteScalar,
  knotsToMps,
  metresToFeet,
  mphToMps,
  mpsToKnots,
  mpsToMph,
  setUnitSystem,
} from '../src/lib/units.ts';
import type { ReplayHour } from '../src/lib/soaring.ts';

test('Stage 1: explicit source-unit conversions and finiteScalar respect ensemble dropout and reciprocation', () => {
  assert.ok(Math.abs(mpsToKnots(knotsToMps(25)) - 25) < 1e-12);
  assert.ok(Math.abs(metresToFeet(feetToMetres(5000)) - 5000) < 1e-9);
  assert.ok(Math.abs(fahrenheitToCelsius(celsiusToFahrenheit(18.5)) - 18.5) < 1e-12);
  assert.ok(Math.abs(mphToMps(10) - 4.4704) < 1e-9);
  assert.ok(Math.abs(mpsToMph(10) - 22.3694) < 1e-9);
  assert.ok(Math.abs(feetPerMinuteToMps(196.850394) - 1.0) < 1e-9);

  // Finite scalar accessor preserves zero, rejects NaN/Infinity, and respects zero-member ensemble dropout
  assert.equal(finiteScalar(0), 0);
  assert.equal(finiteScalar(12.4), 12.4);
  assert.equal(finiteScalar(Number.NaN), null);
  assert.equal(finiteScalar({ members: 21, p10: 1, p50: 3.5, p90: 6 }), 3.5);
  assert.equal(finiteScalar({ members: 0, p10: null, p50: null, p90: null }), null);
  assert.equal(finiteScalar({ members: 0, p10: 0, p50: 0, p90: 0 }), null);
});

test('Stage 1: download-boundary validators accept valid regional documents and reject malformed shapes', () => {
  const validGrid = validateReplayGrid(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'cell-0',
          properties: { cellIndex: 0, id: 'cell-0', gridIndex: 100, latitude: 48.6, longitude: -122.4, modelElevationM: 221.7 },
          geometry: { type: 'Polygon', coordinates: [[[-122.4, 48.6], [-122.3, 48.6], [-122.3, 48.7], [-122.4, 48.6]]] },
        },
      ],
    },
    1,
  );
  assert.equal(validGrid.features.length, 1);
  assert.throws(() => validateReplayGrid({ type: 'FeatureCollection', features: [] }, 1), /Invalid regional grid/);
  assert.throws(() => validateReplayGrid(validGrid, 2), /does not match manifest/);
  const second = structuredClone(validGrid.features[0]);
  second.properties.cellIndex = 1;
  second.properties.gridIndex = 101;
  const twoCells = { ...validGrid, features: [validGrid.features[0], second] };
  assert.equal(validateReplayGrid(twoCells, 2).features.length, 2);
  second.properties.latitude = Number.NaN;
  assert.throws(() => validateReplayGrid(twoCells, 2), /Invalid regional grid/);
  second.properties.latitude = 48.6;
  second.properties.cellIndex = 0;
  assert.throws(() => validateReplayGrid(twoCells, 2), /Invalid regional grid/);

  const audit = validateReplayAudit({
    sampledCell: { distanceKm: 1.58 },
    terrain: { modelElevationM: 221.7, launch: { elevationM: 378.5 } },
    mapProfileAgreement: { exact: true, hours: 14, valuesChecked: 644 },
    limitations: [],
  });
  assert.equal(audit.mapProfileAgreement.hours, 14);
  assert.throws(() => validateReplayAudit({}), /Invalid regional audit/);
  assert.throws(() => validateReplayAudit({ ...audit, terrain: { modelElevationM: 221.7 } }), /Invalid regional audit/);

  assert.equal(validateLaunchesDoc({ launches: 'not-an-array' }), null);
  assert.equal(validateCrossSectionDoc({ totalDistanceKm: 40, nodes: [{}] }), null);
  assert.equal(validateVerificationDoc({ observationVerificationSkill: { matchedPairs: 'bad' } }), null);
  const skill = { note: 'Matched soundings', matchedCount: 1, matchedPairs: [{ station: null, metrics: {} }] };
  assert.equal(validateVerificationDoc({ observationVerificationSkill: skill }), null);
});

test('launch sidecars validate nested comparison data before readers dereference it', () => {
  const validAt = '2026-10-21T20:00:00Z';
  const launch = {
    slug: 'test', name: 'Test', latitude: 48, longitude: -122, timeZone: 'America/Los_Angeles',
    cellIndex: 0, gridIndex: 100, distanceKm: 1,
    launchElevationM: null, modelElevationM: 400,
    models: {
      rrfs: {
        referenceTime: null, modelElevationM: null,
        hours: [{ validAt, tempC: null, wstarV2Mps: null, windSpeedSpreadMps: { p10: null, p90: null } }],
      },
      futureModel: { hours: [{ validAt }], providerMetadata: { retained: true } },
    },
  };
  const doc = { launches: [launch], nwsOffice: { office: 'SEW', products: { afd: { issuanceTime: validAt, text: 'Forecast discussion' } } } };
  const validated = validateLaunchesDoc(doc);
  assert.equal(validated, doc);
  assert.equal(buildLaunchComparisonRows(validated!.launches[0], validAt).length, 1);
  assert.equal(validateLaunchesDoc({ launches: [], nwsOffice: null })?.launches.length, 0);
  assert.equal(validateLaunchesDoc(null), null);
  for (const fields of [{ latitude: undefined }, { longitude: 181 }, { cellIndex: -1 }, { cellIndex: 0.5 }, { launchElevationM: '400' }]) {
    assert.equal(validateLaunchesDoc({ launches: [{ ...launch, ...fields }] }), null);
  }
  for (const series of [null, {}, { hours: null }, { hours: [null] }, { hours: [{ validAt: 42 }] },
    { hours: [{ validAt, tempC: 'warm' }] }, { hours: [{ validAt, tempC: Infinity }] },
    { hours: [{ validAt, tempSpreadC: { p10: 'cold', p90: 10 } }] },
    { hours: [{ validAt }], referenceTime: {} }]) {
    assert.equal(validateLaunchesDoc({ launches: [{ ...launch, models: { rrfs: series } }] }), null);
  }
  const terrain = { experimental: true, bracketsLaunchAltitude: true, launchElevationM: 500,
    modelElevationM: 400, terrainDeltaM: 100, launchWindSpeedMps: 4, launchWindDirectionDeg: 270,
    rawMslHeightsPreserved: true, assumptions: [] };
  const withTerrain = (value: unknown) => ({ launches: [{ ...launch, models: { rrfs: { hours: [{ validAt, experimentalTerrain: value }] } } }] });
  assert.ok(validateLaunchesDoc(withTerrain(terrain)));
  assert.ok(validateLaunchesDoc(withTerrain({ ...terrain, launchWindSpeedMps: null, launchWindDirectionDeg: null })));
  assert.equal(validateLaunchesDoc(withTerrain({ ...terrain, launchWindDirectionDeg: 'west' })), null);
  assert.equal(validateLaunchesDoc(withTerrain({ ...terrain, launchElevationM: undefined })), null);
  assert.equal(validateLaunchesDoc({ ...doc, nwsOffice: { products: { afd: { text: {} } } } }), null);
});

test('cross-section sidecars require usable map coordinates and indexed profile samples', () => {
  const node = { nodeIndex: 0, gridIndex: 100, distanceKm: 0, cellIndex: 0, latitude: 48, longitude: -122, modelElevationM: null, launchElevationM: null, waypointLabel: null };
  const doc = { title: 'Test transect', totalDistanceKm: 5, nodes: [node, { ...node, distanceKm: 5, cellIndex: 1, waypointLabel: 'End' }], futureMetadata: true };
  assert.equal(validateCrossSectionDoc(doc), doc);
  assert.equal(validateCrossSectionDoc(null), null);
  for (const fields of [{ latitude: undefined }, { latitude: NaN }, { latitude: 91 }, { cellIndex: -1 },
    { cellIndex: 0.5 }, { distanceKm: -1 }, { modelElevationM: '400' }, { waypointLabel: {} }]) {
    assert.equal(validateCrossSectionDoc({ ...doc, nodes: [node, { ...node, ...fields }] }), null);
  }
  assert.equal(validateCrossSectionDoc({ ...doc, totalDistanceKm: -5 }), null);
});

test('verification sidecars reject nested collections that would break the optional panels', () => {
  const skill = {
    note: 'Matched soundings', matchedCount: 0, matchedPairs: [],
    rejectedMismatchedComparisons: [{ id: 'rejected', stationId: 'KUIL', siteSlug: 'test', matchStatus: 'rejected', reason: 'Distance', distanceKm: 80, timeDeltaMinutes: -60 }],
  };
  const doc = {
    hrrrWrfprsInventory: { totalGribRecordsPerHour: 711, availablePressureLevelsCount: 42, availableSub925PressureLevelsHpa: [1000], explicitCloudAndStabilityFields: [] },
    wrfPilotDomain: { modelSlug: 'wrf', label: 'WRF trial', wrfRelease: '4.6',
      domains: [{ id: 'd01', dxM: 3000, eWe: 100, eSn: 100, eVert: 60 }, { id: 'd02', dxM: 1000, eWe: 100, eSn: 100, eVert: 60 }],
      physics: { blPblPhysics: 'MYNN', mpPhysics: 'Thompson' } },
    observationVerificationSkill: skill,
    futureMetadata: { retained: true },
  };
  assert.equal(validateVerificationDoc(doc), doc);
  assert.ok(validateVerificationDoc({}));
  assert.equal(validateVerificationDoc(null), null);
  for (const domains of [null, {}, [null], [{ dxM: '3000' }], [{ dxM: 0 }], [{ dxM: Infinity }]]) {
    assert.equal(validateVerificationDoc({ ...doc, wrfPilotDomain: { ...doc.wrfPilotDomain, domains } }), null);
  }
  for (const rejected of [{}, [null], [{ stationId: 'KUIL', distanceKm: null, timeDeltaMinutes: 60 }],
    [{ stationId: 'KUIL', distanceKm: 80, timeDeltaMinutes: '60' }]]) {
    assert.equal(validateVerificationDoc({ ...doc, observationVerificationSkill: { ...skill, rejectedMismatchedComparisons: rejected } }), null);
  }
  assert.equal(validateVerificationDoc({ ...doc, hrrrWrfprsInventory: { availablePressureLevelsCount: '42' } }), null);
});

test('regional summary and detail rows share explicit units despite the global preference', () => {
  const launch: LaunchEntry = {
    slug: 'test', name: 'Test', latitude: 48, longitude: -122, timeZone: 'America/Los_Angeles',
    cellIndex: 0, gridIndex: 100, distanceKm: 0, launchElevationM: 500, modelElevationM: 400, models: {},
  };
  const hour = {
    status: ['valid'], thermalVelocityMps: [1], thermalVelocityV2Mps: [1],
    usableLiftTopM: [1000], usableLiftTopV2M: [1000], boundaryLayerTopM: [1100],
    pblHeightM: [700], cloudBaseM: [1200], wind10mSpeedMps: [5], wind10mDirDeg: [270],
  } as ReplayHour;
  try {
    setUnitSystem('imperial');
    const metric = buildRegionalLaunchTableRows([launch], hour, 0, 'metric')[0];
    assert.deepEqual(metric.simpleReadings, ['1.00 m/s', '1,000 m MSL', '1,200 m', 'W 18 km/h']);
    assert.equal(metric.detailCells.wstarText, '1.00 m/s');
    assert.equal(metric.detailCells.usableLiftTopText, '1,000 m');
    hour.usableLiftTopV2M![0] = null;
    assert.equal(buildRegionalLaunchTableRows([launch], hour, 0, 'metric')[0].simpleReadings[1], 'Below 1.00 m/s sink threshold');
    setUnitSystem('metric');
    const imperial = buildRegionalLaunchTableRows([launch], hour, 0, 'imperial')[0];
    assert.equal(imperial.simpleReadings[0], '197 ft/min');
    assert.equal(imperial.simpleReadings[1], 'Below 197 ft/min sink threshold');
  } finally {
    setUnitSystem('imperial');
  }
});

test('Stage 2: comparison view-model handles deterministic V2, absent V2, explicit V2 null, GEPS legacy/V2 spreads, ECMWF/NWS sparse, and ICON-EU', () => {
  const validAt = '2026-10-21T20:00:00Z';
  const launch: LaunchEntry = {
    slug: 'wa-blanchard',
    name: 'Blanchard <script>alert(1)</script>',
    latitude: 48.6,
    longitude: -122.4,
    timeZone: 'America/Los_Angeles',
    cellIndex: 0,
    gridIndex: 100,
    distanceKm: 1.5,
    launchElevationM: 378.5,
    modelElevationM: 221.7,
    models: {
      'icon-eu': {
        referenceTime: '2026-10-21T00:00:00Z',
        modelElevationM: 210.0,
        hours: [
          {
            validAt,
            tempC: 16.0,
            dewPointC: 8.0,
            windSpeedMps: 4.0,
            windDirectionDeg: 270,
            wstarV2Mps: 1.4,
            usableLiftTopV2M: 1150,
            resolvedThermalTopM: 1320,
            surfaceLclM: 1600,
            effectiveCloudLimitM: 1600,
          },
        ],
      },
      'hrrr-conus': {
        referenceTime: '2026-10-21T00:00:00Z',
        modelElevationM: 221.7,
        hours: [
          {
            validAt,
            tempC: 14.5,
            dewPointC: 7.2,
            windSpeedMps: 0,
            windDirectionDeg: 180,
            cloudCoverPct: 0,
            // Explicit V2 null on usableLiftTopV2M must NOT fall back to legacy usableLiftTopM (724.5)
            wstarMps: 1.06,
            usableLiftTopM: 724.5,
            blTopM: 778.9,
            wstarV2Mps: 0.45,
            usableLiftTopV2M: null,
            resolvedThermalTopM: 504.3,
            surfaceLclM: 1315.0,
            effectiveCloudLimitM: 981.0,
          },
        ],
      },
      rdps: {
        referenceTime: '2026-10-21T00:00:00Z',
        modelElevationM: 240.0,
        hours: [
          {
            validAt,
            tempC: 13.0,
            windSpeedMps: 3.2,
            windDirectionDeg: 225,
            // Absent V2 properties fall back to v1 fields on deterministic models
            wstarMps: 1.15,
            usableLiftTopM: 810.0,
            blTopM: 920.0,
            cloudBaseM: 1400.0,
          },
        ],
      },
      geps: {
        referenceTime: '2026-10-21T00:00:00Z',
        modelElevationM: 94.3,
        hours: [
          {
            validAt,
            tempC: 13.5,
            dewPointC: 8.5,
            windSpeedMps: 4.2,
            windDirectionDeg: 209,
            wstarMps: 1.2,
            wstarLegacySpreadMps: { p10: 0.6, p90: 1.8 },
            usableLiftTopM: 760,
            usableLiftLegacySpreadM: { p10: 500, p90: 1050 },
            blTopM: 910,
            blTopLegacySpreadM: { p10: 650, p90: 1200 },
            wstarV2Mps: null,
            wstarSpreadMps: null,
            usableLiftTopV2M: null,
            usableLiftSpreadM: null,
            resolvedThermalTopM: null,
            thermalTopSpreadM: null,
            surfaceLclM: null,
            effectiveCloudLimitM: 1120,
            cloudLimitSpreadM: { p10: 850, p90: 1450 },
          },
        ],
      },
      ecmwf: {
        referenceTime: '2026-10-21T00:00:00Z',
        modelElevationM: 386.0,
        hours: [
          {
            validAt,
            tempC: 15.2,
            dewPointC: 7.0,
            windSpeedMps: 3.1,
            windDirectionDeg: 240,
            blTopM: 836.0,
            surfaceLclM: 1412.0,
            effectiveCloudLimitM: null,
          },
        ],
      },
    },
  };

  const rows = buildLaunchComparisonRows(launch, validAt, 'metric');
  assert.equal(rows.length, 5);

  const [iconRow, hrrrRow, rdpsRow, gepsRow, ecmwfRow] = rows;
  assert.equal(iconRow.modelLabel, 'ICON-EU');
  assert.equal(iconRow.wstar.family, 'v2');
  assert.equal(iconRow.wstar.primaryText, '1.40 m/s');

  // HRRR explicit V2 null stays unavailable ('–') instead of silently showing legacy 724.5 m
  assert.equal(hrrrRow.wstar.primaryText, '0.45 m/s');
  assert.equal(hrrrRow.usableLiftTop.family, 'unavailable');
  assert.equal(hrrrRow.usableLiftTop.primaryText, '–');
  // Calm 0 m/s wind and 0% cloud cover are preserved as real zeroes
  assert.ok(hrrrRow.windText.includes('0 km/h'));
  assert.equal(hrrrRow.cloudCoverSuffix, ' (0%)');
  // Surface LCL (1315 m) and distinct effective cloud limit (981 m) are both shown
  assert.equal(hrrrRow.cloudSegments.length, 2);
  assert.ok(hrrrRow.cloudSegments[0].text.includes('1,315 m'));
  assert.ok(hrrrRow.cloudSegments[1].text.includes('981 m'));

  // RDPS absent V2 falls back to legacy deterministic fields
  assert.equal(rdpsRow.wstar.primaryText, '1.15 m/s');
  assert.equal(rdpsRow.usableLiftTop.primaryText, '810 m');

  // GEPS legacy-only ensemble labels v1 diagnostics and attaches matching legacy p10-p90 spread
  assert.equal(gepsRow.wstar.family, 'v1-legacy');
  assert.equal(gepsRow.wstar.primaryText, 'v1: 1.20 m/s');
  assert.equal(gepsRow.wstar.spreadText, '(0.60 m/s–1.80 m/s)');
  assert.equal(gepsRow.usableLiftTop.family, 'v1-legacy');
  assert.equal(gepsRow.usableLiftTop.primaryText, 'v1: 760 m');
  assert.equal(gepsRow.usableLiftTop.spreadText, '(500 m–1,050 m)');
  assert.ok(gepsRow.windText.startsWith('SSW '));

  // When GEPS has member-level V2 diagnostics, V2 center and V2 spread are used without 'v1:' prefix
  const gepsV2Row = buildMultimodelComparisonRow(
    'geps',
    'GEPS median',
    '2026-10-21T00:00:00Z',
    94.3,
    {
      validAt,
      wstarV2Mps: 1.35,
      wstarSpreadMps: { p10: 0.85, p90: 1.95 },
      usableLiftTopV2M: 890,
      usableLiftSpreadM: { p10: 620, p90: 1140 },
      resolvedThermalTopM: 1020,
      thermalTopSpreadM: { p10: 750, p90: 1280 },
      surfaceLclM: 1340,
      effectiveCloudLimitM: 1100,
      cloudLimitSpreadM: { p10: 900, p90: 1300 },
    },
    'metric',
  );
  assert.equal(gepsV2Row.wstar.family, 'v2');
  assert.equal(gepsV2Row.wstar.primaryText, '1.35 m/s');
  assert.equal(gepsV2Row.wstar.spreadText, '(0.85 m/s–1.95 m/s)');

  // ECMWF sparse adapter reports 'Unavailable' for W* and usableLiftTop while preserving surfaceLclM and blTopM
  assert.equal(ecmwfRow.wstar.family, 'unsupported');
  assert.equal(ecmwfRow.wstar.primaryText, 'Unavailable');
  assert.equal(ecmwfRow.usableLiftTop.family, 'unsupported');
  assert.equal(ecmwfRow.usableLiftTop.primaryText, 'Unavailable');
  assert.equal(ecmwfRow.thermalTop.primaryText, '836 m');
  assert.equal(ecmwfRow.cloudSegments[0].text, 'LCL 1,412 m');
});
