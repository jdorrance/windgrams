// Narrow expected-change profile for visual QA, never a forecast transformation.
// Inputs: frozen baseline physics/view. Output: only the approved 2 m/10 m anchors.
import assert from 'node:assert/strict';

// Current readers retain more published extension fields than the pinned reader.
// Every retained addition must equal its frozen source; shared fields stay exact.
export function assertParsedSourceParity(previous, current, source) {
  const shared = structuredClone(current);
  assert.equal(current.hours.length, previous.hours.length, 'Parsed source hour count');
  for (const key of ['soaringMeta', 'source']) {
    if (Object.hasOwn(previous, key) || !Object.hasOwn(shared, key)) continue;
    assert.ok(Object.hasOwn(source, key), `Retained ${key} must exist in frozen source`);
    assert.deepEqual(shared[key], source[key], 'Retained metadata must match frozen source');
    delete shared[key];
  }
  shared.hours.forEach((hour, i) => {
    for (const key of Object.keys(hour.soaring ?? {})) {
      if (Object.hasOwn(previous.hours[i].soaring ?? {}, key)) continue;
      assert.ok(Object.hasOwn(source.hours[i].soaring ?? {}, key), `Retained soaring.${key} must exist in frozen source`);
      assert.deepEqual(hour.soaring[key], source.hours[i].soaring?.[key], `Retained soaring.${key} must match frozen source`);
      delete hour.soaring[key];
    }
    if (!previous.hours[i].soaring && hour.soaring && !Object.keys(hour.soaring).length) delete hour.soaring;
  });
  assert.deepEqual(shared, previous, 'Shared parsed source records');
}

export function surfaceAnchorPhysics(physics, modelTerrainM, classify) {
  return physics.map(hour => {
    const next = structuredClone(hour);
    const sample = next.sampling;
    for (const [key, offset] of [['temperatureC', 2], ['dewPointC', 2], ['relativeHumidityPercent', 2], ['windU', 10], ['windV', 10]]) {
      assert.equal(sample[key][0]?.altitudeM, modelTerrainM, `${key}: expected the old model-ground surface anchor`);
      sample[key][0].altitudeM += offset;
      sample[key].sort((a, b) => a.altitudeM - b.altitudeM);
    }
    const nodes = sample.temperatureC;
    sample.lapseCPer1000Ft = nodes.slice(0, -1).flatMap((a, i) => {
      const b = nodes[i + 1], dz = b.altitudeM - a.altitudeM;
      const value = Number.isFinite(a.value) && Number.isFinite(b.value) && dz !== 0
        ? (b.value - a.value) / dz * 1000 * (304.8 / 1000) : NaN;
      const upper = i < nodes.length - 2 && dz > 0.02 ? b.altitudeM - 0.01 : b.altitudeM;
      return [{ altitudeM: a.altitudeM, value }, { altitudeM: upper, value }];
    });
    next.lapseClasses = sample.lapseCPer1000Ft.map(node => classify(node.value));
    return next;
  });
}

// Evaluate changed inspector readings with the archived reader, using ONLY the
// independently constructed sampling above. Native model clouds/potential LCLs
// stay fixed; RH layers use the archived layer algorithm with shifted RH nodes.
export function surfaceAnchorView(view, expectedPhysics, moistLayers) {
  const byTime = new Map(expectedPhysics.map(hour => [hour.validAt, hour.sampling]));
  const sampling = view.hours.map(hour => byTime.get(hour.validAt));
  assert.ok(sampling.every(Boolean), 'Every displayed hour must have expected physics');
  const clouds = view.hours.flatMap((_, hourIndex) => {
    const old = view.clouds.filter(cloud => cloud.hourIndex === hourIndex);
    const humidity = moistLayers(sampling[hourIndex].relativeHumidityPercent, 94.00001)
      .filter(layer => layer.baseM < view.topM && layer.topM > view.floorM)
      .map(layer => ({ ...layer, hourIndex, kind: 'humidity', coverPercent: null }));
    return [...old.filter(cloud => cloud.kind === 'model'), ...humidity, ...old.filter(cloud => cloud.kind === 'potential')];
  });
  return { ...view, sampling, clouds };
}

export function recordAnchorDelta(summary, oldReading, nextReading) {
  summary.checkedReadings++;
  for (const key of ['temperatureF', 'speedKt', 'directionDeg', 'cloud', 'interpolated']) {
    if (!Object.is(oldReading[key], nextReading[key])) summary.changedFields[key] = (summary.changedFields[key] ?? 0) + 1;
  }
  if (oldReading.temperatureF !== null && nextReading.temperatureF !== null) {
    summary.maxTemperatureDifferenceC = Math.max(summary.maxTemperatureDifferenceC, Math.abs(nextReading.temperatureF - oldReading.temperatureF) / 1.8);
  }
  if ([oldReading.speedKt, nextReading.speedKt, oldReading.directionDeg, nextReading.directionDeg].every(Number.isFinite)) {
    const vector = reading => {
      const angle = reading.directionDeg * Math.PI / 180, speed = reading.speedKt / 1.9438444924406;
      return [-speed * Math.sin(angle), -speed * Math.cos(angle)];
    };
    const a = vector(oldReading), b = vector(nextReading);
    summary.maxWindVectorDifferenceMps = Math.max(summary.maxWindVectorDifferenceMps, Math.hypot(a[0] - b[0], a[1] - b[1]));
  }
}
