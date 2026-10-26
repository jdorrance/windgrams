// Independent raw-column diagnostic experiment. Never imports production derivation,
// reads a published thermal top/cloud cap, or replaces issued forecasts.
const finite = Number.isFinite;
const lapse = 0.0098;
const round = (value, places) => (value === null ? null : Number(value.toFixed(places)));
const dew = (value) =>
  finite(value.dewPointC)
    ? value.dewPointC
    : finite(value.temperatureC) && finite(value.dewPointDepressionC)
      ? value.temperatureC - value.dewPointDepressionC
      : null;

function lcl(temperature, dewPoint, ground) {
  if (![temperature, dewPoint, ground].every(finite)) return null;
  if (dewPoint >= temperature) return ground;
  const t = temperature + 273.15,
    d = dewPoint + 273.15;
  const condensationTemperature = 56 + 1 / (1 / (d - 56) + Math.log(t / d) / 800);
  return ground + (t - condensationTemperature) / lapse;
}

/** Independent implementation of the declared depth policy; branch provenance is part of the result. */
export function referenceParcelDepth(column, terrainM, deltaTC = 0) {
  const levels = (column.levels ?? [])
    .filter((level) => finite(level.heightM) && level.heightM > terrainM + 20)
    .sort((a, b) => a.heightM - b.heightM);
  const absent = (reason) => ({ depthM: null, branch: 'unavailable', reason, bracketM: null, topLimited: false });
  if (
    !finite(column.temperatureC) ||
    !finite(terrainM) ||
    !finite(deltaTC) ||
    !levels.length ||
    levels.some((level, index) => !finite(level.temperatureC) || (index && level.heightM <= levels[index - 1].heightM))
  )
    return absent('invalid-temperature-column');
  const points = levels.map((level) => ({
    z: level.heightM - terrainM,
    excess: column.temperatureC + deltaTC - lapse * (level.heightM - terrainM) - level.temperatureC,
  }));
  const crossing = points.findIndex((point) => point.excess <= 0);
  if (crossing === -1)
    return { depthM: points.at(-1).z, branch: 'sampled-column-top', bracketM: null, topLimited: true };
  if (crossing > 0) {
    const a = points[crossing - 1],
      b = points[crossing];
    // Zero of the line joining the two signed parcel-temperature excesses.
    return {
      depthM: (a.z * -b.excess + b.z * a.excess) / (a.excess - b.excess),
      branch: 'bracketed-parcel-crossing',
      bracketM: [a.z + terrainM, b.z + terrainM],
      topLimited: false,
    };
  }
  const first = points[0],
    sensible = column.sensibleHeatFluxWm2,
    latent = column.latentHeatFluxWm2;
  if (deltaTC <= 0) {
    if (![sensible, latent].every(finite)) return absent('missing-shallow-closure-heat-flux');
    if (sensible + 0.000245268 * (column.temperatureC + 273.15) * latent <= 0)
      return {
        depthM: 0,
        branch: 'nonpositive-virtual-heating',
        bracketM: [terrainM, terrainM + first.z],
        topLimited: false,
      };
  }
  if (finite(column.pblHeightM) && column.pblHeightM > 0) {
    const boost = deltaTC > 0 ? Math.min(250 * deltaTC, Math.max(0, first.z - column.pblHeightM)) : 0;
    return {
      depthM: Math.min(first.z, column.pblHeightM + boost),
      branch: 'native-pbl-shallow-closure',
      bracketM: [terrainM, terrainM + first.z],
      topLimited: false,
    };
  }
  if (!finite(sensible)) return absent('missing-shallow-closure-sensible-heat');
  const imposedExcess = Math.max(0, deltaTC + Math.min(1.5, Math.max(0, sensible) * 0.012));
  const deficit = deltaTC - first.excess;
  return {
    depthM: imposedExcess === 0 ? 0 : deficit <= imposedExcess ? first.z : (first.z * imposedExcess) / deficit,
    branch: 'sensible-heat-shallow-closure',
    bracketM: [terrainM, terrainM + first.z],
    topLimited: false,
  };
}

/** LCL and environmental 0.5°C dew-point-depression crossing are separate inputs to the legacy cloud cap. */
export function referenceCloudCap(column, terrainM) {
  const surfaceDew = dew(column),
    surfaceLclM = lcl(column.temperatureC, surfaceDew, terrainM);
  const levels = (column.levels ?? [])
    .filter((level) => finite(level.heightM) && level.heightM > terrainM + 20)
    .sort((a, b) => a.heightM - b.heightM);
  const nodes = [{ heightM: terrainM, temperatureC: column.temperatureC, dewPointC: surfaceDew }, ...levels];
  let saturationHeightM = null,
    saturationBracketM = null,
    moistureGap = false;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index],
      d = dew(node),
      depression = d === null ? null : node.temperatureC - d;
    if (depression === null || !finite(depression)) {
      moistureGap = true;
      continue;
    }
    if (depression > 0.5) continue;
    if (index === 0) {
      saturationHeightM = terrainM;
      saturationBracketM = [terrainM, terrainM];
      break;
    }
    const previous = nodes[index - 1],
      previousDew = dew(previous);
    if (previousDew === null || moistureGap) {
      moistureGap = true;
      break;
    }
    const previousDepression = previous.temperatureC - previousDew;
    saturationHeightM =
      previous.heightM +
      ((node.heightM - previous.heightM) * (previousDepression - 0.5)) / (previousDepression - depression);
    saturationBracketM = [previous.heightM, node.heightM];
    break;
  }
  const effectiveCloudLimitM =
    moistureGap || surfaceLclM === null
      ? null
      : saturationHeightM === null
        ? surfaceLclM
        : Math.max(terrainM, Math.min(surfaceLclM, saturationHeightM));
  return {
    surfaceLclM,
    saturationHeightM,
    saturationBracketM,
    effectiveCloudLimitM,
    moistureGap,
    interpretation: 'Potential parcel condensation and a sampled ambient saturation proxy, not observed cloud.',
  };
}

function surfacePressure(column, terrainM) {
  if (finite(column.surfacePressureHpa) && column.surfacePressureHpa > 0)
    return { pressureHpa: column.surfacePressureHpa, source: 'supplied-surface-pressure' };
  const first = (column.levels ?? [])
    .filter((level) => finite(level.heightM) && level.heightM > terrainM + 20)
    .sort((a, b) => a.heightM - b.heightM)[0];
  if (!first || ![first.pressureHpa, first.temperatureC, column.temperatureC].every(finite) || first.pressureHpa <= 0)
    return { pressureHpa: null, source: 'unavailable' };
  return {
    pressureHpa:
      first.pressureHpa *
      Math.exp(
        (9.80665 * (first.heightM - terrainM)) / (287.05 * (273.15 + (first.temperatureC + column.temperatureC) / 2)),
      ),
    source: 'hypsometric-first-level',
  };
}

function velocity(column, depth, pressure) {
  if (
    ![column.temperatureC, column.sensibleHeatFluxWm2, column.latentHeatFluxWm2, depth, pressure].every(finite) ||
    depth < 0 ||
    pressure <= 0
  )
    return null;
  const t = column.temperatureC + 273.15,
    d = dew(column);
  const td = d === null ? null : Math.min(column.temperatureC, d),
    e = td === null ? 0 : 6.112 * Math.exp((17.67 * td) / (td + 243.5));
  if (e >= pressure) return null;
  const mixing = (0.622 * e) / (pressure - e),
    specific = mixing / (1 + mixing),
    delta = (1 - 0.622) / 0.622;
  // Surface density and virtual potential-temperature reference factors cancel.
  const heating =
    ((1 + delta * specific) * column.sensibleHeatFluxWm2) / 1004 + (delta * t * column.latentHeatFluxWm2) / 2501000;
  return Math.cbrt(Math.max(0, ((9.80665 * depth * 287.05) / (pressure * 100)) * heating));
}

function ceiling(terrain, depth, wstar, cap, sink) {
  if (![terrain, depth, wstar].every(finite) || depth <= 0 || wstar <= 0) return null;
  const upper = Math.min(terrain + depth, finite(cap) ? cap : terrain + depth);
  const xcap = Math.cbrt((upper - terrain) / depth),
    peak = Math.cbrt(5 / 16),
    target = sink / wstar;
  const f = (x) => 4 * x - 3.2 * x ** 4;
  if (xcap <= 0 || target > f(peak)) return null;
  if (xcap <= peak) return f(xcap) >= target ? upper : null;
  if (target <= f(1)) return upper;
  let low = peak,
    high = 1;
  for (let i = 0; i < 70; i++) {
    const mid = (low + high) / 2;
    if (f(mid) >= target) low = mid;
    else high = mid;
  }
  return Math.min(upper, terrain + depth * ((low + high) / 2) ** 3);
}

/** Accept only source weather and model terrain. Extra published diagnostics have no effect. */
export function referenceDiagnostics(column, terrainM) {
  const thermal = referenceParcelDepth(column, terrainM),
    plus1 = referenceParcelDepth(column, terrainM, 1);
  const clouds = referenceCloudCap(column, terrainM),
    pressure = surfacePressure(column, terrainM);
  const wstar = round(velocity(column, thermal.depthM, pressure.pressureHpa), 2);
  return {
    resolvedThermalTopM: round(thermal.depthM > 0 ? terrainM + thermal.depthM : null, 1),
    thermalTopPlus1CM: round(plus1.depthM > 0 ? terrainM + plus1.depthM : null, 1),
    thermalVelocityV2Mps: wstar,
    surfaceLclM: round(clouds.surfaceLclM, 1),
    effectiveCloudLimitM: round(clouds.effectiveCloudLimitM, 1),
    usableLiftTopV2M: clouds.moistureGap
      ? null
      : round(ceiling(terrainM, thermal.depthM, wstar, clouds.effectiveCloudLimitM, 1), 1),
    hcritWxtoflyM: clouds.moistureGap
      ? null
      : round(ceiling(terrainM, thermal.depthM, wstar, clouds.effectiveCloudLimitM, 1.143), 1),
    support: { thermal, plus1, clouds, pressure },
  };
}

/** Controlled loss-of-resolution experiment: select existing nodes; never invent finer weather. */
export function compareDownsampling(column, terrainM, retainedIndices) {
  if (
    !Array.isArray(retainedIndices) ||
    retainedIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= column.levels.length) ||
    new Set(retainedIndices).size !== retainedIndices.length
  )
    throw new Error('Downsampling needs unique existing level indices');
  const dense = referenceDiagnostics(column, terrainM),
    sampled = referenceDiagnostics(
      { ...column, levels: retainedIndices.map((index) => column.levels[index]) },
      terrainM,
    );
  const differences = Object.fromEntries(
    Object.keys(dense)
      .filter((key) => key !== 'support')
      .map((key) => [key, finite(dense[key]) && finite(sampled[key]) ? sampled[key] - dense[key] : null]),
  );
  const retainedLevels = retainedIndices.map((index) => ({
    index,
    modelLevel: column.levels[index].modelLevel ?? null,
    pressureHpa: column.levels[index].pressureHpa ?? null,
    heightM: column.levels[index].heightM,
    aglM: column.levels[index].heightM - terrainM,
  }));
  return {
    nativeLevelCount: column.levels.length,
    retainedLevelCount: retainedIndices.length,
    retainedIndices,
    retainedLevels,
    dense,
    sampled,
    differences,
    conclusion:
      'Sampling sensitivity of this source column and diagnostic policy, not an observation error or forecast skill estimate.',
  };
}
