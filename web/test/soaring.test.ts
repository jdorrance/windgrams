import test, { afterEach } from 'node:test';
import { setUnitSystem } from '../src/lib/units.ts';
afterEach(() => setUnitSystem('imperial'));
import assert from 'node:assert/strict';
import { availableReplayLayers, crossSectionHeightScale, refreshReplayLayerLabels } from '../src/lib/soaring.ts';
import { LAYER_SPECS, buildCrossSectionLinePath, defaultReplayQuery, displayMetric, forecastHourAtValidTime, historicalLabel, nativeModels, regionForCase, replayLocation, replaySelection, selectedState, setReplaySelectionQuery, type RegionCatalogue, type ReplayManifest, type ReplayHour } from '../src/lib/soaring.ts';

test('replay links preserve the project base and reject unknown cases', () => {
  assert.equal(replayLocation('?hour=27','/windgrams/data').root,'/windgrams/data/soaring/v1/north-sound-20261021-00z');
  assert.equal(replayLocation('?hour=27','/data').hour,27);
  assert.equal(replayLocation('?hour=NaN','/data').hour,20);
  assert.throws(()=>replayLocation('?case=../bad','/data'),/Unknown/);
  assert.match(historicalLabel('2026-10-21T00:00:00Z'),/Historical forecast.*HRRR.*2026-10-21.*00:00 UTC/);
});

test('regional layer choices omit absent native fields while keeping zero and later-hour data', () => {
  const hours = [
    { thermalVelocityV2Mps: [0, null], convergence10mX1e5: [null, null], w925Mps: [null], precipitationMmHr: [0, 0] },
    { thermalVelocityV2Mps: [1, 2], convergence10mX1e5: [null, null], blMeanWindSpeedMps: [null, 3] },
  ] as ReplayHour[];
  const layers = availableReplayLayers(hours);
  assert.ok(layers.includes('thermalVelocityV2Mps'));
  assert.ok(layers.includes('precipitationMmHr'));
  assert.ok(layers.includes('blMeanWindSpeedMps'));
  assert.ok(!layers.includes('convergence10mX1e5'));
  assert.ok(!layers.includes('w925Mps'));
  assert.ok(!layers.includes('capeJkg'));
});

test('regional initialization refreshes server-rendered layer captions from the saved unit system', () => {
  const options = [
    { value: 'thermalVelocityV2Mps', textContent: 'Thermal strength · ft/min' },
    { value: 'usableLiftTopV2M', textContent: 'Usable lift top · ft MSL' },
    { value: 'precipitationMmHr', textContent: 'Rain · in/h' },
    { value: 'wind10mSpeedMps', textContent: 'Surface wind · mph' },
  ];
  const ids = options.map(option => option.value);
  for (const region of ['armenia', 'north-sound']) {
    setUnitSystem('metric');
    refreshReplayLayerLabels(options);
    assert.deepEqual(options.map(option => option.textContent), ['Thermal strength · m/s', 'Usable lift top · m MSL', 'Rain · mm/h', 'Surface wind · km/h'], region);
    setUnitSystem('imperial');
    refreshReplayLayerLabels(options);
    assert.deepEqual(options.map(option => option.textContent), ['Thermal strength · ft/min', 'Usable lift top · ft MSL', 'Rain · in/h', 'Surface wind · mph'], region);
    assert.deepEqual(options.map(option => option.value), ids, 'unit captions preserve selected layer identifiers');
  }
});

test('mountain transects keep terrain, launch, lift and cloud lines inside a stable horizon scale', () => {
  const nodes = [{ cellIndex: 1, modelElevationM: 3088, launchElevationM: 4000 }];
  const hours = [
    { resolvedThermalTopM: [20000, 3805], usableLiftTopV2M: [null, 3650], surfaceLclM: [null, 3900] },
    { resolvedThermalTopM: [null, 4700], usableLiftTopV2M: [null, 4500], surfaceLclM: [null, 5250] },
  ] as ReplayHour[];
  const metric = crossSectionHeightScale(nodes, hours, 'metric');
  const imperial = crossSectionHeightScale(nodes, hours, 'imperial');
  assert.equal(metric.maxAltM, 5500);
  assert.equal(imperial.maxAltM, metric.maxAltM, 'unit switching preserves the physical range');
  assert.deepEqual(crossSectionHeightScale(nodes, [...hours].reverse(), 'metric'), metric, 'every forecast hour shares one scale');
  const yOf = (heightM: number) => 300 * (1 - heightM / metric.maxAltM);
  assert.ok(yOf(3805) > 0 && yOf(5250) > 0);
  assert.ok(yOf(3805) > yOf(4700), 'different high tops remain distinct instead of flattening at the old ceiling');
  assert.equal(buildCrossSectionLinePath([{ distanceKm: 0 }, { distanceKm: 10 }], [3805, 4700], value => value, yOf), 'M0.0,92.5L10.0,43.6');
  for (const scale of [metric, imperial]) {
    assert.ok(scale.ticksM.length >= 3 && scale.ticksM.length <= 6);
    assert.ok(scale.ticksM.every((height, index) => Number.isFinite(height) && height <= scale.maxAltM && (!index || height > scale.ticksM[index - 1])));
  }
  assert.equal(crossSectionHeightScale([{ cellIndex: 0, modelElevationM: 500 }], [], 'metric').maxAltM, 3600, 'lowland minimum remains');
  assert.equal(crossSectionHeightScale([{ cellIndex: 0, modelElevationM: null }], [{ surfaceLclM: [NaN], resolvedThermalTopM: [Infinity] }] as ReplayHour[]).maxAltM, 3600);
});
test('RRFS live routes accept the 84-hour horizon and preserve explicit historical cases', () => {
  const caseId = 'north-sound-expanded-v2-rrfs-live';
  assert.equal(replayLocation(`?case=${caseId}&hour=84`, '/data').hour, 84);
  assert.equal(replayLocation(`?case=${caseId}&hour=85`, '/data').hour, 20);
  assert.throws(() => replayLocation('?case=../north-sound-expanded-v2-rrfs-live', '/data'), /Unknown/);
  assert.match(historicalLabel('2026-10-23T00:00:00Z', true, 'rrfs'), /Forecast run · RRFS/);
  const region = {
    id: 'north-sound', status: 'active-verified-trial', caseId: 'north-sound-expanded-v2-live',
    nativeModels: [{ model: 'hrrr-conus', caseId: 'north-sound-expanded-v2-live' }, { model: 'rrfs', caseId }],
  } as RegionCatalogue['regions'][number];
  const catalogue = { regions: [region] } as RegionCatalogue;
  assert.equal(defaultReplayQuery('?model=rrfs', catalogue).get('case'), caseId);
  assert.equal(defaultReplayQuery('', catalogue).get('case'), region.caseId);
  assert.equal(defaultReplayQuery('?case=north-sound-20261021-00z&model=rrfs', catalogue).get('case'), 'north-sound-20261021-00z');
  assert.equal(regionForCase(catalogue.regions, caseId), region);
  assert.throws(() => defaultReplayQuery('?model=gfs', catalogue), /unavailable/);
  const legacy = { ...region, nativeModels: undefined };
  assert.equal(nativeModels(legacy)[0].model, 'hrrr-conus');
  assert.throws(() => defaultReplayQuery('?model=rrfs', { regions: [legacy] } as RegionCatalogue), /unavailable/);
  assert.equal(defaultReplayQuery('?model=rrfs', { regions: [{ ...region, caseId: 'north-sound-20261021-00z' }] } as RegionCatalogue).get('case'), caseId);
  assert.throws(() => defaultReplayQuery('?model=rrfs', null), /unavailable/);
});
test('changing model retains the selected valid time across different initialization times', () => {
  const hrrr = [{ forecastHour: 2, validAt: '2026-10-23T20:00:00Z' }, { forecastHour: 3, validAt: '2026-10-23T21:00:00Z' }];
  const rrfs = [{ forecastHour: 8, validAt: '2026-10-23T20:00:00Z' }, { forecastHour: 9, validAt: '2026-10-23T21:00:00Z' }];
  assert.equal(forecastHourAtValidTime(hrrr, rrfs[1].validAt), 3);
  assert.equal(forecastHourAtValidTime(rrfs, hrrr[1].validAt), 9);
  assert.equal(forecastHourAtValidTime(rrfs, '2026-10-23T22:00:00Z'), 9);
  assert.equal(forecastHourAtValidTime(rrfs, 'invalid'), null);
});
test('changing model preserves the named launch using its new grid index', () => {
  const cells = [
    { cellIndex: 0, latitude: 48.6, longitude: -122.4 },
    { cellIndex: 1, latitude: 48.8, longitude: -122.1 },
  ];
  const launches = [{ slug: 'wa-big-j', cellIndex: 1, latitude: 48.801, longitude: -122.101 }];
  const query = new URLSearchParams('launch=wa-big-j&lat=48.6&lon=-122.4');
  const selection = replaySelection(query, cells, launches, 0);
  assert.deepEqual(selection, { cellIndex: 1, latitude: 48.801, longitude: -122.101, launchSlug: 'wa-big-j' });
  setReplaySelectionQuery(query, selection);
  const hrrr = replaySelection(query, [...cells].reverse().map((cell, cellIndex) => ({ ...cell, cellIndex })), [{ ...launches[0], cellIndex: 0 }], 1);
  assert.equal(hrrr.cellIndex, 0);
  assert.equal(hrrr.launchSlug, 'wa-big-j');
});
test('arbitrary coordinates resolve geographically and do not drift across repeated model switches', () => {
  const hrrr = [{ cellIndex: 0, latitude: 48.6, longitude: -122.4 }, { cellIndex: 1, latitude: 48.81, longitude: -122.11 }];
  const rrfs = [{ cellIndex: 0, latitude: 48.8, longitude: -122.1 }, { cellIndex: 1, latitude: 48.61, longitude: -122.41 }];
  const query = new URLSearchParams('case=north-sound-expanded-v2-live&valid=2026-10-23T20%3A00%3A00Z&lat=48.806&lon=-122.107');
  for (let i = 0; i < 4; i++) {
    const selection = replaySelection(query, i % 2 ? hrrr : rrfs, [], 0);
    assert.equal(selection.cellIndex, i % 2 ? 1 : 0);
    setReplaySelectionQuery(query, selection);
    assert.equal(query.get('lat'), '48.806');
    assert.equal(query.get('lon'), '-122.107');
    assert.equal(query.get('case'), 'north-sound-expanded-v2-live');
    assert.equal(query.get('valid'), '2026-10-23T20:00:00Z');
  }
});
test('unknown launches fall back to coordinates and stale launch indexes are remapped nearby', () => {
  const cells = [{ cellIndex: 0, latitude: 48.6, longitude: -122.4 }, { cellIndex: 1, latitude: 48.8, longitude: -122.1 }];
  const query = new URLSearchParams('launch=removed&lat=48.8&lon=-122.1');
  const selection = replaySelection(query, cells, [], 0);
  assert.equal(selection.cellIndex, 1);
  setReplaySelectionQuery(query, selection);
  assert.equal(query.has('launch'), false);
  for (const cellIndex of [0, 99]) {
    const launch = { slug: 'wa-big-j', cellIndex, latitude: 48.801, longitude: -122.101 };
    assert.equal(replaySelection(new URLSearchParams('launch=wa-big-j'), cells, [launch], 0).cellIndex, 1);
  }
});
test('location links reject invalid coordinates and do not snap distant locations to a region edge', () => {
  const cells = [{ cellIndex: 0, latitude: 48.6, longitude: -122.4 }, { cellIndex: 1, latitude: 48.8, longitude: -122.1 }];
  for (const query of ['', 'lat=&lon=', 'lat=0&lon=', 'lat=NaN&lon=-122.1', 'lat=Infinity&lon=-122.1',
    'lat=91&lon=-122.1', 'lat=48.8&lon=-181', 'lat=48.8', 'lon=-122.1', 'lat=0&lon=0', 'lat=48.86&lon=-122.1']) {
    assert.equal(replaySelection(new URLSearchParams(query), cells, [], 0).cellIndex, 0, query);
  }
  assert.equal(replaySelection(new URLSearchParams('lat=48.84&lon=-122.1'), cells, [], 0).cellIndex, 1);
  assert.throws(() => replaySelection(new URLSearchParams(), [], [], 0), /no valid grid/);
});
test('nearest grid selection uses physical distance at northern latitudes and across the date line', () => {
  const cells = [{ cellIndex: 0, latitude: 70.015, longitude: 0 }, { cellIndex: 1, latitude: 70, longitude: 0.03 }];
  assert.equal(replaySelection(new URLSearchParams('lat=70&lon=0'), cells, [], 0).cellIndex, 1);
  assert.equal(replaySelection(new URLSearchParams('lat=60&lon=179.99'), [
    { cellIndex: 0, latitude: 60, longitude: 179.8 }, { cellIndex: 1, latitude: 60, longitude: -179.99 },
  ], [], 0).cellIndex, 1);
});
test('zero, unavailable, insufficient levels, and no usable lift have distinct labels for v1 and v2 layers', () => {
  assert.equal(displayMetric(0,'thermalVelocityMps'),'0 ft/min');
  assert.equal(displayMetric(0.85,'thermalVelocityV2Mps'),'167 ft/min');
  assert.equal(displayMetric(null,'thermalVelocityMps'),'Unavailable');
  assert.equal(displayMetric(null,'thermalVelocityV2Mps'),'Unavailable');
  assert.equal(displayMetric(null,'thermalVelocityMps','insufficient-levels'),'Insufficient vertical coverage');
  assert.match(displayMetric(null,'usableLiftTopM'),/Below 197 ft\/min sink threshold/);
  assert.match(displayMetric(null,'usableLiftTopV2M'),/Below 197 ft\/min sink threshold/);
  assert.equal(displayMetric(724.5,'usableLiftTopM'),'2,377 ft MSL');
  assert.equal(displayMetric(465.5,'usableLiftTopV2M'),'1,527 ft MSL');
  assert.equal(displayMetric(981,'effectiveCloudLimitM'),'3,219 ft MSL');
});
test('one selected hour drives map, site cards, windgram, and sounding time with both v1 and v2 metrics', () => {
  const hours=[14,20,27].map((f,i)=>({
    forecastHour:f,
    validAt:new Date(Date.UTC(2026,9,21,f)).toISOString(),
    status:['valid'],
    thermalVelocityMps:[i],
    usableLiftTopM:[i?724.5:null],
    thermalVelocityV2Mps:[i?0.85:0],
    usableLiftTopV2M:[i?465.5:null],
  })) as ReplayHour[];
  const manifest={hours,siteCell:0,case:{site:{timeZone:'America/Los_Angeles'}}} as unknown as ReplayManifest;
  for(let i=0;i<hours.length;i++) {
    const state=selectedState(manifest,hours,hours[i].forecastHour);
    assert.equal(state.index,i);assert.equal(state.hour,hours[i]);
    assert.equal(state.siteStrength,`${Math.round(i * 196.8503937007874)} ft/min`);
  }
  assert.equal(selectedState(manifest,hours,20).siteStrengthV2,'167 ft/min');
  assert.equal(selectedState(manifest,hours,20).siteTopV2,'1,527 ft MSL');
  assert.match(selectedState(manifest,hours,20).validLabel,/1:00 PM PDT/);
  assert.throws(()=>selectedState(manifest,[],20),/does not match/);
});

test('P2-1: cross-section line path uses iteration position instead of sparse or reordered nodeIndex', () => {
  const sparseNodes = [
    { nodeIndex: 0, distanceKm: 0 },
    { nodeIndex: 5, distanceKm: 10 },
    { nodeIndex: 12, distanceKm: 20 },
  ];
  const reorderedNodes = [
    { nodeIndex: 2, distanceKm: 0 },
    { nodeIndex: 0, distanceKm: 10 },
    { nodeIndex: 1, distanceKm: 20 },
  ];
  const vals = [1000, 1500, 2000];
  const xOf = (km: number) => km * 10;
  const yOf = (m: number) => 300 - m * 0.1;

  assert.equal(buildCrossSectionLinePath(sparseNodes, vals, xOf, yOf), 'M0.0,200.0L100.0,150.0L200.0,100.0');
  assert.equal(buildCrossSectionLinePath(reorderedNodes, vals, xOf, yOf), 'M0.0,200.0L100.0,150.0L200.0,100.0');
  assert.equal(buildCrossSectionLinePath(sparseNodes, [1000, null, 2000], xOf, yOf), 'M0.0,200.0M200.0,100.0');
});


test('unit selection preserves every map layer physical breakpoint and interpolated color', () => {
  const keys = Object.keys(LAYER_SPECS) as (keyof typeof LAYER_SPECS)[];
  const imperial = Object.fromEntries(keys.map(key => [key, LAYER_SPECS[key]]));
  setUnitSystem('metric');
  const metric = Object.fromEntries(keys.map(key => [key, LAYER_SPECS[key]]));
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);
  // Color interpolation consumes value * scale and correspondingly scaled stops.
  const colorAt = (value: number, spec: typeof LAYER_SPECS.thermalVelocityMps) => {
    const displayed = value * spec.scale;
    let high = spec.stops.findIndex(stop => stop >= displayed);
    if (high < 0) high = spec.stops.length - 1;
    const low = Math.max(0, high - 1);
    const fraction = high === low ? 0 : Math.max(0, Math.min(1, (displayed - spec.stops[low]) / (spec.stops[high] - spec.stops[low])));
    const rgb = (color: string) => [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
    const a = rgb(spec.colors[low]), b = rgb(spec.colors[high]);
    return a.map((value, channel) => value + (b[channel] - value) * fraction);
  };
  for (const key of keys) {
    const a = imperial[key], b = metric[key];
    assert.deepEqual(a.colors, b.colors, key);
    assert.ok(a.scale > 0 && b.scale > 0);
    a.stops.forEach((stop, i) => close(stop / a.scale, b.stops[i] / b.scale));
    const physical = a.stops.map(stop => stop / a.scale);
    for (const value of [...physical, ...physical.slice(1).map((value, i) => (value + physical[i]) / 2)]) {
      colorAt(value, a).forEach((channel, i) => close(channel, colorAt(value, b)[i]));
    }
  }
  assert.deepEqual(metric.thermalVelocityV2Mps.stops, [0, .5, 1, 2, 3]);
  metric.usableLiftTopV2M.stops.forEach((value, i) => close(value, [0, 304.8, 609.6, 1524, 3048][i]));
  metric.wind10mSpeedMps.stops.forEach((value, i) => close(value, [0, 8.04672, 19.312128, 32.18688, 48.28032][i]));
  assert.deepEqual(metric.precipitationMmHr.stops, [0, .2, 1, 3, 8]);
  assert.deepEqual(metric.capeJkg.stops, imperial.capeJkg.stops);
  assert.deepEqual(metric.sensibleHeatFluxWm2.stops, imperial.sensibleHeatFluxWm2.stops);
});

test('map values, units, references, and sink diagnostics switch together', () => {
  assert.equal(displayMetric(2, 'thermalVelocityV2Mps'), '394 ft/min');
  assert.equal(displayMetric(10, 'wind10mSpeedMps'), '22 mph');
  assert.equal(displayMetric(25.4, 'precipitationMmHr'), '1.00 in/h');
  assert.equal(LAYER_SPECS.w925Mps.legend, 'Pressure level: 27.32 inHg');
  assert.equal(LAYER_SPECS.hcritWxtoflyM.legend, 'WxToFly sink threshold: 225 ft/min');
  setUnitSystem('metric');
  assert.equal(displayMetric(2, 'thermalVelocityV2Mps'), '2.00 m/s');
  assert.equal(displayMetric(10, 'wind10mSpeedMps'), '36 km/h');
  assert.equal(displayMetric(1000, 'usableLiftTopV2M'), '1,000 m MSL');
  assert.equal(displayMetric(1000, 'pblHeightM'), '1,000 m AGL');
  assert.equal(displayMetric(25.4, 'precipitationMmHr'), '25.4 mm/h');
  assert.equal(displayMetric(null, 'usableLiftTopV2M'), 'Below 1.00 m/s sink threshold');
  assert.equal(displayMetric(null, 'hcritWxtoflyM'), 'Below 1.14 m/s sink threshold');
  assert.equal(LAYER_SPECS.w925Mps.legend, 'Pressure level: 925 hPa');
  assert.equal(LAYER_SPECS.hcritWxtoflyM.legend, 'WxToFly sink threshold: 1.14 m/s');
  assert.doesNotMatch(Object.values(LAYER_SPECS).map(spec => `${spec.label} ${spec.legend} ${spec.format(1)}`).join(' '), /\bft\b|mph|inHg|\bin\/h/);
});

test('omitted map ceiling diagnostics remain unavailable while supplied nulls retain their meaning', () => {
  for (const system of ['imperial', 'metric'] as const) {
    setUnitSystem(system);
    for (const layer of ['usableLiftTopM', 'usableLiftTopV2M', 'hcritWxtoflyM', 'resolvedThermalTopM'] as const) {
      assert.equal(displayMetric(undefined, layer), 'Unavailable', `${layer} omitted in ${system}`);
      assert.equal(displayMetric(null, layer, 'missing'), 'Unavailable');
      assert.equal(displayMetric(null, layer, 'insufficient-levels'), 'Insufficient vertical coverage');
    }
    assert.equal(displayMetric(null, 'resolvedThermalTopM'), 'Stable');
    assert.match(displayMetric(null, 'hcritWxtoflyM'), /^Below /);
  }
});

test('Armenia regional links select ICON-EU and retain its full forecast horizon', () => {
  const region = { id: 'armenia', status: 'active-verified-trial', caseId: 'armenia-icon-eu-live', nativeModels: [{ model: 'icon-eu', caseId: 'armenia-icon-eu-live' }] } as RegionCatalogue['regions'][number];
  const catalogue = { regions: [region] } as RegionCatalogue;
  const query = defaultReplayQuery('?region=armenia&model=icon-eu', catalogue);
  assert.equal(query.get('case'), 'armenia-icon-eu-live');
  assert.equal(replayLocation(`?${query}&hour=120`, '/data').hour, 120);
  assert.equal(replayLocation(`?${query}&hour=121`, '/data').hour, 20);
  assert.equal(regionForCase(catalogue.regions, 'armenia-icon-eu-live'), region);
  assert.match(historicalLabel('2026-10-24T00:00:00Z', true, 'icon-eu'), /ICON-EU/);
  assert.throws(() => defaultReplayQuery('?region=armenia&model=rrfs', catalogue), /unavailable/);
  assert.throws(() => defaultReplayQuery('?region=armenia', null), /unavailable/);
  assert.throws(() => defaultReplayQuery('?region=unknown', catalogue), /unavailable/);
});
