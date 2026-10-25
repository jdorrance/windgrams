import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultReplayQuery, historicalLabel, hourIndex, nativeModels, normalizeReplayManifest, replayLocation, replayModel, replaySelection,
  setReplaySelectionQuery, type Grid, type RegionCatalogue, type ReplayManifest } from '../src/lib/soaring.ts';

test('published catalogues introduce a region and model without an application allowlist', () => {
  const catalogue = { trialRegionId:'new-zealand', regions:[{id:'new-zealand',status:'active-verified-trial',caseId:'nz-south-native-live',
    nativeModels:[{model:'nz-regional',caseId:'nz-south-native-live'}]}] } as RegionCatalogue;
  const query=defaultReplayQuery('',catalogue);
  assert.equal(query.get('case'),'nz-south-native-live');
  assert.equal(replayLocation(query.toString(),'/windgrams/data').root,'/windgrams/data/soaring/v1/nz-south-native-live');
  assert.equal(defaultReplayQuery('?case=old-nz-run&model=unavailable',catalogue).get('case'),'old-nz-run');
  assert.throws(()=>replayLocation('?case=https://example.com/data','/data'));
});

test('unknown regional identities stay unknown; documented archives retain their model', () => {
  const unknown={case:{id:'future-region'}} as ReplayManifest;
  assert.equal(replayModel(unknown),'unknown');
  assert.match(historicalLabel('2026-10-25T00:00:00Z'),/Unknown model/);
  assert.equal(replayModel({case:{id:'north-sound-20261021-00z'}} as ReplayManifest),'hrrr-conus');
  assert.equal(replayModel({case:{id:'north-sound-expanded-v2-rrfs-live'}} as ReplayManifest),'rrfs');
  assert.deepEqual(nativeModels({caseId:'future-region'} as RegionCatalogue['regions'][number]),[]);
});

test('the host adds archive identity before the generic profile cache sees a manifest', () => {
  const legacy = { case: { id: 'north-sound-20261021-00z' }, hours: [] } as unknown as ReplayManifest;
  const normalized = normalizeReplayManifest(legacy);
  assert.equal(normalized.model, 'hrrr-conus');
  assert.equal(normalized.case, legacy.case);
  assert.equal(normalized.hours, legacy.hours);
  assert.equal(legacy.model, undefined);
  const current = { ...legacy, model: 'future-model' };
  assert.equal(normalizeReplayManifest(current), current);
  assert.equal(normalizeReplayManifest({ ...legacy, case: { ...legacy.case, id: 'unknown-archive' } }).model, undefined);
});

test('selection uses the actual published lead times, including zero and long/coarse horizons', () => {
  const hours=[0,3,6,120,240,384].map(forecastHour=>({forecastHour}));
  assert.equal(replayLocation('?case=global-live&hour=384','/data').hour,384);
  assert.equal(hourIndex(hours,384),5);
  assert.equal(hourIndex(hours,500),5);
  assert.equal(hourIndex(hours,0),0);
  assert.equal(hourIndex(hours,5),2);
  assert.equal(hourIndex([{forecastHour:12},{forecastHour:6}],9),1,'equidistant selections prefer the earlier lead');
});

function gridAt(longitude:number): Grid {
  const cells=[{cellIndex:0,id:'a',gridIndex:100,latitude:-43,longitude,modelElevationM:200},
    {cellIndex:1,id:'b',gridIndex:200,latitude:-42,longitude,modelElevationM:300}];
  return {type:'FeatureCollection',features:cells.map(properties=>({type:'Feature',id:properties.id,properties,
    geometry:{type:'Polygon',coordinates:[[[longitude-.3,properties.latitude-.3],[longitude+.3,properties.latitude-.3],
      [longitude+.3,properties.latitude+.3],[longitude-.3,properties.latitude+.3],[longitude-.3,properties.latitude-.3]]]}}))};
}

test('native cell footprints replace a fixed kilometre radius and preserve the geographic anchor', () => {
  const grid=gridAt(172), cells=grid.features.map(feature=>feature.properties);
  const query=new URLSearchParams('lat=-41.8&lon=172.2');
  const selection=replaySelection(query,cells,[],0,grid);
  assert.equal(selection.cellIndex,1,'point is within its native cell but over 5 km from the centre');
  setReplaySelectionQuery(query,selection);
  assert.equal(query.get('lat'),'-41.8');
  assert.equal(query.get('lon'),'172.2');
  assert.equal(replaySelection(new URLSearchParams('lat=-41.65&lon=172'),cells,[],0,grid).cellIndex,0,'outside polygon stays outside');
  const changedGrid=gridAt(172.1);
  assert.equal(replaySelection(query,changedGrid.features.map(f=>f.properties),[],0,changedGrid).latitude,-41.8);
});

test('stale named-launch indexes are remapped by the published native footprint', () => {
  const grid=gridAt(172), cells=grid.features.map(feature=>feature.properties);
  const selection=replaySelection(new URLSearchParams('launch=new-launch'),cells,
    [{slug:'new-launch',cellIndex:0,latitude:-41.8,longitude:172.2}],0,grid);
  assert.equal(selection.cellIndex,1);
  assert.equal(selection.launchSlug,'new-launch');
});
