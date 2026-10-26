// Exact-time, above-ground profile comparisons; no file IO or provider acquisition.
import { comparisonIssue } from '../comparability.mjs';
import { routingFor } from './routing.mjs';

const finite = Number.isFinite;
const iso = (value) => new Date(value).toISOString();
const wind = (level) =>
  !finite(level.windSpeedMps) || level.windSpeedMps < 0
    ? null
    : level.windSpeedMps === 0
      ? { u: 0, v: 0 }
      : finite(level.windDirectionDeg)
        ? {
            u: -level.windSpeedMps * Math.sin((level.windDirectionDeg * Math.PI) / 180),
            v: -level.windSpeedMps * Math.cos((level.windDirectionDeg * Math.PI) / 180),
          }
        : null;

export const COMPARISON_FIELDS = [
  {
    id: 'temperature',
    label: 'Upper-air temperature',
    unit: '°C',
    category: 'atmosphere',
    qualification: 'Environmental air at a shared MSL height; source grids, runs and interpolation can differ.',
  },
  {
    id: 'windVector',
    label: 'Upper-air wind vector distance',
    unit: 'm/s',
    category: 'atmosphere',
    qualification: 'Nonnegative distance between wind vectors, not signed speed bias.',
  },
  {
    id: 'windSpeed',
    label: 'Upper-air wind speed',
    unit: 'm/s',
    category: 'atmosphere',
    qualification: 'Speed of the interpolated wind components; not interpolation of scalar speed.',
  },
  {
    id: 'lift225',
    label: '225 ft/min ceiling vs XC usable lift',
    unit: 'm',
    category: 'method-sensitive',
    qualification:
      'Threshold equivalence is unverified: Windgrams 1.143 m/s; XC help approximately 1.2 m/s with inconsistent ft/min descriptions. XC vtops is the displayed red trace; any documented cloud cap is server-side and unverified.',
  },
  {
    id: 'lift1',
    label: '1 m/s ceiling vs XC usable lift',
    unit: 'm',
    category: 'method-sensitive',
    qualification: 'Different thresholds: Windgrams 1 m/s versus XC approximately 1.2 m/s; no exact equivalence.',
  },
  {
    id: 'thermalTop',
    label: 'Parcel thermal top',
    unit: 'm',
    category: 'method-sensitive',
    qualification:
      'Both are parcel diagnostics; their parcel and equilibrium algorithms are not established equivalent. Neither is native model PBL depth.',
  },
  {
    id: 'cloudBase',
    label: 'Potential surface LCL vs XC condensation height',
    unit: 'm',
    category: 'method-sensitive',
    qualification:
      'Windgrams potential surface LCL versus XC CCL-labeled height; not an ambient-cloud-base accuracy comparison.',
  },
];
const fieldById = new Map(COMPARISON_FIELDS.map((field) => [field.id, field]));

/** Interpolate one field between valid bracketing levels above BOTH grounds. Never extrapolate. */
export function interpolateAboveGround(levels, heightM, groundM, keys) {
  if (!finite(heightM) || !finite(groundM) || heightM <= groundM) return null;
  const usable = levels
    .filter(
      (level) => finite(level.heightM) && level.heightM > groundM && keys.every((key) => Object.hasOwn(level, key)),
    )
    .sort((a, b) => a.heightM - b.heightM);
  if (usable.some((level, index) => index > 0 && level.heightM === usable[index - 1].heightM)) return null;
  const exact = usable.find((level) => Math.abs(level.heightM - heightM) < 1e-7);
  if (exact)
    return keys.every((key) => finite(exact[key]))
      ? {
          values: Object.fromEntries(keys.map((key) => [key, exact[key]])),
          bracketM: [exact.heightM, exact.heightM],
          weight: 0,
        }
      : null;
  for (let index = 1; index < usable.length; index++) {
    const low = usable[index - 1],
      high = usable[index];
    if (low.heightM < heightM && heightM < high.heightM) {
      if (!keys.every((key) => finite(low[key]) && finite(high[key]))) return null;
      const weight = (heightM - low.heightM) / (high.heightM - low.heightM);
      return {
        values: Object.fromEntries(keys.map((key) => [key, low[key] + weight * (high[key] - low[key])])),
        bracketM: [low.heightM, high.heightM],
        weight,
      };
    }
  }
  return null;
}

/** Compare one issued Windgrams profile to one normalized XC response at exact UTC times. */
export function compareProfiles(
  profile,
  xc,
  { request, response, cohort = 'latest-live', evidence = {}, runtimeMetadata = [] } = {},
) {
  const rows = [],
    exclusions = [],
    hourPairs = [],
    byTime = new Map(xc.hours.map((hour) => [Date.parse(hour.validAt), hour]));
  const site = request?.site ?? { slug: profile.site.id, name: profile.site.name, timeZone: profile.site.timeZone };
  const selected = Date.parse(response?.retrievedAt ?? request?.selectedAt ?? '');
  const timeZone = site.timeZone ?? 'UTC';
  for (const hour of profile.hours) {
    const xhour = byTime.get(Date.parse(hour.validAt));
    if (!xhour) {
      exclusions.push({
        site: site.slug,
        model: profile.model,
        cohort,
        validAt: hour.validAt,
        reason: 'no-exact-UTC-overlap',
      });
      continue;
    }
    const leadHours = (Date.parse(hour.validAt) - Date.parse(profile.run.referenceTime)) / 3600000;
    if (!finite(leadHours) || leadHours < 0) {
      exclusions.push({
        site: site.slug,
        model: profile.model,
        cohort,
        validAt: hour.validAt,
        reason: 'invalid-Windgrams-lead',
      });
      continue;
    }
    const ourGround = profile.site.modelElevationM,
      xcGround = xhour.modelElevationM;
    const ground = finite(ourGround) && finite(xcGround) ? Math.max(ourGround, xcGround) : null;
    const base = {
      id: `${site.slug}|${profile.model}|${cohort}|${profile.run.referenceTime}|${iso(hour.validAt)}`,
      site: site.slug,
      siteName: site.name,
      model: profile.model,
      xcModel: xc.model,
      cohort,
      validAt: iso(hour.validAt),
      utcDate: iso(hour.validAt).slice(0, 10),
      localDate: new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(hour.validAt)),
      referenceTime: profile.run.referenceTime,
      leadHours,
      xcReferenceTime: null,
      xcLeadHours: null,
      xcTimeClass: Date.parse(xhour.validAt) < selected ? 'retrospectively-retrieved' : 'future-at-retrieval',
      xcRouting: routingFor(xc.model, hour.validAt, runtimeMetadata, response?.retrievedAt),
      modelElevationM: ourGround,
      xcModelElevationM: xcGround,
      terrainDifferenceM: ground === null ? null : ourGround - xcGround,
      coordinates: {
        ours: { latitude: profile.site.latitude, longitude: profile.site.longitude },
        xcRequested: xc.requestedCoordinates,
      },
      comparability:
        'Same model family and exact valid UTC; initialization, native cell and terrain equality unproven.',
      evidence,
    };
    hourPairs.push({ ...base, ourLevelCount: hour.levels?.length ?? 0, xcLevelCount: xhour.levels.length });
    const rowBase = {
      hourPairId: base.id,
      site: base.site,
      model: base.model,
      cohort,
      validAt: base.validAt,
      utcDate: base.utcDate,
      localDate: base.localDate,
    };
    const add = (field, ours, theirs, details = {}) => {
      if (!finite(ours) || !finite(theirs)) {
        exclusions.push({ ...rowBase, field, reason: !finite(ours) ? 'Windgrams-value-missing' : 'XC-value-missing' });
        return;
      }
      const definition = fieldById.get(field);
      const quantity = field === 'cloudBase' ? 'surfaceLcl' : field;
      const xcQuantity =
        field === 'cloudBase'
          ? 'ccl'
          : field === 'thermalTop'
            ? 'xcThermalTopUnverified'
            : ['lift1', 'lift225'].includes(field)
              ? 'xcLiftUnverified'
              : quantity;
      const descriptor = { unit: definition.unit, heightReference: 'MSL', validAt: hour.validAt };
      const modelId = { 'hrrr-conus': 'hrrr', 'icon-eu': 'iconeu' }[profile.model] ?? profile.model;
      const strictSameRunIssue = comparisonIssue(
        {
          ...descriptor,
          quantity,
          model: modelId,
          referenceTime: profile.run.referenceTime,
          referenceTimeVerified: true,
        },
        {
          ...descriptor,
          quantity: xcQuantity,
          model: xc.model,
          referenceTime: xc.referenceTime,
          referenceTimeVerified: false,
        },
        { sameRun: true },
      );
      rows.push({
        ...rowBase,
        field,
        category: definition.category,
        unit: definition.unit,
        ours,
        xc: theirs,
        difference: ours - theirs,
        strictSameRunIssue,
        ...details,
      });
    };
    if (ground === null) exclusions.push({ ...rowBase, field: 'upper-air', reason: 'ground-reference-missing' });
    else
      for (const level of hour.levels ?? []) {
        if (!finite(level.heightM) || level.heightM <= ground) {
          exclusions.push({
            ...rowBase,
            field: 'upper-air',
            heightM: level.heightM,
            reason: 'level-at-or-below-either-ground',
          });
          continue;
        }
        const temperature = interpolateAboveGround(xhour.levels, level.heightM, ground, ['temperatureC']);
        if (temperature && finite(level.temperatureC))
          add('temperature', level.temperatureC, temperature.values.temperatureC, {
            heightM: level.heightM,
            xcBracketM: temperature.bracketM,
            xcInterpolationWeight: temperature.weight,
          });
        else
          exclusions.push({
            ...rowBase,
            field: 'temperature',
            heightM: level.heightM,
            reason: 'missing-value-or-no-above-ground-bracket',
          });
        const theirs = interpolateAboveGround(xhour.levels, level.heightM, ground, ['windUMps', 'windVMps']),
          ours = wind(level);
        if (theirs && ours) {
          const other = { u: theirs.values.windUMps, v: theirs.values.windVMps },
            details = {
              heightM: level.heightM,
              xcBracketM: theirs.bracketM,
              xcInterpolationWeight: theirs.weight,
              vectorComponents: { ours, xc: other },
            };
          add('windSpeed', Math.hypot(ours.u, ours.v), Math.hypot(other.u, other.v), details);
          add('windVector', Math.hypot(ours.u, ours.v), Math.hypot(other.u, other.v), {
            ...details,
            difference: Math.hypot(ours.u - other.u, ours.v - other.v),
          });
        } else
          exclusions.push({
            ...rowBase,
            field: 'windVector',
            heightM: level.heightM,
            reason: 'missing-value-or-no-above-ground-bracket',
          });
      }
    const soar = hour.soaring ?? {},
      diagnostics = xhour.diagnostics;
    for (const [field, ours, theirs] of [
      ['lift225', soar.hcritWxtoflyM, diagnostics.usableLiftTopM],
      ['lift1', soar.usableLiftTopV2M, diagnostics.usableLiftTopM],
      ['thermalTop', soar.resolvedThermalTopM, diagnostics.thermalTopM],
      ['cloudBase', soar.surfaceLclM, diagnostics.cloudBaseM],
    ])
      add(field, ours, theirs, {
        heightM: null,
        heightReference: 'MSL',
        oursAglM: finite(ours) && finite(ourGround) ? ours - ourGround : null,
        xcAglM: finite(theirs) && finite(xcGround) ? theirs - xcGround : null,
      });
  }
  return { rows, exclusions, hourPairs };
}
