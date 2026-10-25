import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAtmosphericColumn, parseNormalizedColumnRecord } from '@windgrams/contracts';
import { publishedLift } from '@windgrams/contracts/published-lift';
import { validateReplayGrid, validateReplayAudit, validateLaunchesDoc, validateCrossSectionDoc, validateVerificationDoc } from '@windgrams/contracts/regional';

const validAt = '2026-10-25T12:00:00Z';
const column = () => ({ validAt, temperatureC:20, dewPointC:10, windSpeedMps:0, windDirectionDeg:0,
  sensibleHeatFluxWm2:null, latentHeatFluxWm2:0, levels:[] });
const normalized = () => ({ schemaVersion:1, column:column(), modelElevationM:2000,
  provenance:{
    sources:[{ id:'sfc', provider:'fixture', product:'surface', model:'test', referenceTime:null, acquiredAt:validAt, gridId:'grid-a' },
      { id:'aloft', provider:'fixture', product:'upper-air', model:'test', referenceTime:'2026-10-25T00:00:00Z', acquiredAt:validAt, gridId:'grid-b' }],
    fieldSemantics:{ sensibleHeatFluxWm2:{ sourceRunId:'sfc', sourceField:'heat', unit:'W/m2', sampling:'derived', positiveDirection:'upward', timeSupport:{kind:'mean',start:'2026-10-25T11:00:00Z',end:validAt} } },
    gridCell:{id:'cell',latitude:-43,longitude:172,gridIndex:0},
    capabilities:{verticalCoordinates:'surface-only',ensemble:'deterministic',fields:{sensibleHeatFluxWm2:'unknown',latentHeatFluxWm2:'available'}},
  } });

test('normalized contracts preserve null, zero, source identities and original objects', () => {
  const input=normalized();
  assert.equal(parseNormalizedColumnRecord(input),input);
  assert.equal(input.column.sensibleHeatFluxWm2,null);
  assert.equal(input.column.latentHeatFluxWm2,0);
  assert.equal(input.provenance.sources[0].referenceTime,null);
  assert.equal(input.provenance.sources[1].gridId,'grid-b');
});

test('lineage rejects unknown source references and inverted statistical intervals', () => {
  const input=normalized();
  input.provenance.fieldSemantics.sensibleHeatFluxWm2.sourceRunId='missing';
  assert.equal(parseNormalizedColumnRecord(input),null);
  input.provenance.fieldSemantics.sensibleHeatFluxWm2.sourceRunId='sfc';
  input.provenance.fieldSemantics.sensibleHeatFluxWm2.timeSupport.start='2026-10-25T13:00:00Z';
  assert.equal(parseNormalizedColumnRecord(input),null);
});

test('native model identifiers and physical pressures survive without level synthesis', () => {
  const input=column();
  input.levels=[{modelLevel:62,pressureHpa:742.32,heightM:2531.7,temperatureC:8,dewPointDepressionC:4,windSpeedMps:2,windDirectionDeg:190}];
  assert.equal(parseAtmosphericColumn(input),input);
  assert.equal(input.levels.length,1);
  assert.equal(input.levels[0].pressureHpa,742.32);
  input.levels[0].heightM=Number.NaN;
  assert.equal(parseAtmosphericColumn(input),null);
});

test('schema checks retain unknown metadata and nested identities without weakening known fields', () => {
  const input = normalized();
  input.column.providerMetadata = { calibration: 'native' };
  input.provenance.sources[0].endpoint = { region: 'global' };
  const levels = input.column.levels;
  const sources = input.provenance.sources;
  const accepted = parseNormalizedColumnRecord(input);
  assert.equal(accepted, input);
  assert.equal(accepted.column.levels, levels);
  assert.equal(accepted.provenance.sources, sources);
  assert.deepEqual(accepted.column.providerMetadata, { calibration: 'native' });
  input.column.nativeLfcM = 'high';
  assert.equal(parseNormalizedColumnRecord(input), null);
  delete input.column.nativeLfcM;
  delete input.column.dewPointC;
  assert.equal(parseNormalizedColumnRecord(input), null, 'moisture remains required');
});

test('diagnostic selection preserves explicit V2 nulls and legacy fallback', () => {
  const derived={thermalVelocityMps:2,boundaryLayerTopM:2000,usableLiftTopM:1800,cloudBaseM:1500};
  assert.equal(publishedLift({derived}),derived);
  const actual=publishedLift({derived,soaring:{thermalVelocityV2Mps:0,usableLiftTopV2M:null,surfaceLclM:1400}});
  assert.deepEqual(actual,{thermalVelocityMps:0,boundaryLayerTopM:null,usableLiftTopM:null,cloudBaseM:1400});
});

test('regional boundary validators retain strict required data and nullable sidecars', () => {
  assert.throws(()=>validateReplayGrid({type:'FeatureCollection',features:[]}));
  assert.equal(validateLaunchesDoc({launches:[{}]}),null);
});

test('sidecar validators reject formerly unchecked declared fields', () => {
  const launch = { slug: 'test', name: 'Test', latitude: 45, longitude: 10, timeZone: 'UTC',
    cellIndex: 0, gridIndex: 1, distanceKm: 0, launchElevationM: null, modelElevationM: null, models: {} };
  assert.equal(validateLaunchesDoc({ launches: [launch] }).launches[0], launch);
  for (const field of ['timeZone', 'gridIndex', 'distanceKm']) {
    assert.equal(validateLaunchesDoc({ launches: [{ ...launch, [field]: undefined }] }), null);
  }
  const node = { nodeIndex: 0, distanceKm: 0, latitude: 45, longitude: 10, cellIndex: 0, gridIndex: 1,
    modelElevationM: null, waypointLabel: null, launchElevationM: null };
  assert.equal(validateCrossSectionDoc({ totalDistanceKm: 1, nodes: [node, node] }), null, 'title is required');
  assert.equal(validateVerificationDoc({ lifecycleAudit: [{ slug: 'test' }] }), null);
  assert.equal(validateVerificationDoc({ hrrrWrfprsInventory: { availablePressureLevelsCount: 42 } }), null);
  assert.throws(() => validateReplayAudit({ sampledCell: { distanceKm: 0 },
    terrain: { modelElevationM: 10, launch: { elevationM: 20 }, rawMslHeightsPreserved: 'yes' },
    mapProfileAgreement: { exact: true, hours: 1, valuesChecked: 1 }, limitations: [] }));
});
