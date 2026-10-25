// Observation matching rules, evaluation targets and historical weather cases.
// Issued-run storage and retention are implemented in issued-history.mjs.

import { DEFAULT_MAX_ROLLING_RUNS } from './issued-history.mjs';
export { DEFAULT_MAX_ROLLING_RUNS, compactSiteDocForHistory, archiveModelRun, mergeHistoryArchives, archivedModelRuns } from './issued-history.mjs';

export const OBSERVATION_MATCHING_RULES = Object.freeze({
  schemaVersion: 3,
  raobExactTimeDeltaMinutes: 0,
  raobNearInitMaxTimeDeltaMinutes: 60, // Explicit f01 (+60 min) initialization-step fallback when f00 is not in site profile
  surfaceStationMaxTimeDeltaMinutes: 30,
  raobPreferredDistanceKm: 50.0,
  raobMaxSiteVerificationDistanceKm: 60.0,
  elevationDifferenceWarningM: 350.0,
  pressureLevelsEvaluatedHpa: [925, 850, 700, 600],
  leadTimeBuckets: [
    { id: 'f00-f06', minHours: 0, maxHours: 6, label: 'Near-Initialization / Nowcast (f00–f06)' },
    { id: 'f07-f12', minHours: 7, maxHours: 12, label: 'Short-Range (f07–f12)' },
    { id: 'f13-f24', minHours: 13, maxHours: 24, label: 'Day-1 Soaring Window (f13–f24)' },
    { id: 'f25-f48', minHours: 25, maxHours: 48, label: 'Day-2 Outlook (f25–f48)' },
  ],
});

export const HISTORICAL_CASE_REGIMES = [
  {
    caseId: 'north-sound-20261021-00z',
    regime: 'blue-thermals-under-cirrus',
    region: 'North Sound, WA',
    primarySite: 'wa-blanchard',
    referenceTime: '2026-10-21T00:00:00Z',
    validWindowUtc: ['2026-10-21T14:00:00Z', '2026-10-22T03:00:00Z'],
    holdoutRole: 'baseline-verification',
    terrainMismatchM: -156.8,
    stationExposure: 'KUIL RAOB 170 km WSW: coastal marine context, outside the 60 km matching gate. KBLI 22 km NNW: lowland bay exposure. Frozen Blanchard MRDEM30 elevation 378.5 m MSL; HRRR terrain 221.7 m MSL.',
    summary: 'Light southerly flow under high cirrus, with a shallow HRRR boundary layer and weak afternoon thermals. The archived-column regression records calculated diagnostics.'
  },
  {
    caseId: 'north-sound-mountain-alpine-20261021-06z',
    regime: 'alpine-high-terrain-masking',
    region: 'North Cascades, WA',
    primarySite: 'wa-black-mountain',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T16:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'terrain-masking-holdout',
    terrainMismatchM: -412.4,
    stationExposure: 'Black Mountain launch at 1,386.7 m MSL vs 3 km smoothed model terrain (~974 m); tests 900/875 hPa lowest-above-ground level handling.',
    summary: 'High-elevation Cascade launch where 925 hPa lies below model terrain, testing minimum above-ground level masking and sub-ridge convergence.'
  },
  {
    caseId: 'strait-sea-breeze-convergence-20261021-06z',
    regime: 'strait-marine-breeze',
    region: 'Olympic Peninsula / Strait of Juan de Fuca, WA',
    primarySite: 'wa-blyn',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T18:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'convergence-holdout',
    terrainMismatchM: -189.0,
    stationExposure: 'Blyn launch (471 m MSL) overlooking Sequim Bay and Strait of Juan de Fuca; KUIL is 113 km W (rejected by spatial gate for local site verification).',
    summary: 'Strait marine layer abutting Olympic foothills with sharp horizontal moisture and sensible heat flux gradients between water and terrain.'
  },
  {
    caseId: 'tiger-puget-trough-20261021-06z',
    regime: 'puget-lowland-stratus-burnoff',
    region: 'Central Puget Sound / Issaquah Alps, WA',
    primarySite: 'wa-tiger-mountain',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T15:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'regional-expansion-tier-1',
    terrainMismatchM: -215.3,
    stationExposure: 'KSEA / KRNT lowland terminals 25 km W; NWS SEW AFD notes patchy morning LIFR fog scattering 18–20Z with light W/NW afternoon wind.',
    summary: 'Morning lowland inversion and shallow fog clearing midday into modest afternoon thermals across the Issaquah Alps.'
  },
  {
    caseId: 'columbia-gorge-gap-flow-20261021-06z',
    regime: 'gorge-pressure-gradient',
    region: 'Columbia River Gorge, WA/OR',
    primarySite: 'wa-bingen',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T15:00:00Z', '2026-10-22T03:00:00Z'],
    holdoutRole: 'regional-expansion-tier-2',
    terrainMismatchM: -178.2,
    stationExposure: 'KDLS The Dalles & KTTD Troutdale cross-Gorge pressure gradient pair; steep canyon walls unresolved at 3 km.',
    summary: 'Cross-Cascade pressure gradient through the Columbia Gorge testing BL wind shear and low-level channelized wind.'
  },
  {
    caseId: 'east-cascades-chelan-20261021-06z',
    regime: 'east-slope-dry-thermals',
    region: 'East Cascades / Chelan, WA',
    primarySite: 'wa-chelan-butte',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T16:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'regional-expansion-tier-3',
    terrainMismatchM: -310.5,
    stationExposure: 'KEAT Pangborn Memorial & Chelan Butte isolated 1,180 m prominence above Lake Chelan cold pool.',
    summary: 'Higher sensible heat flux and large dew-point depression on the lee side of the Cascades producing high dry LCL and blue thermals.'
  },
  {
    caseId: 'oregon-desert-abert-rim-20261021-06z',
    regime: 'high-desert-deep-convection',
    region: 'South-Central Oregon Outback',
    primarySite: 'or-abert-rim-walkup',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T17:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'ceiling-reached-test',
    terrainMismatchM: -145.0,
    stationExposure: 'KREO Rome / KLMT Klamath Falls high-plateau exposure (~1,500–2,200 m MSL); tests 600 hPa ceilingReached flag.',
    summary: 'High-elevation arid plateau where afternoon thermals approach the upper pressure-level sampling ceiling (650–600 hPa).'
  },
  {
    caseId: 'rogue-valley-woodrat-20261021-06z',
    regime: 'valley-inversion-break',
    region: 'Applegate / Rogue Valley, OR',
    primarySite: 'or-woodrat-mountain',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T17:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'inversion-break-holdout',
    terrainMismatchM: -265.0,
    stationExposure: 'KMFR Medford RAOB 18 km NE in adjacent valley; primary matched balloon-to-launch verification site in the western catalogue.',
    summary: 'Strong nocturnal valley inversion in the Rogue/Applegate basin eroded by afternoon heating along south-west facing slopes.'
  },
  {
    caseId: 'shenandoah-massanutten-20261021-06z',
    regime: 'appalachian-ridge-thermal',
    region: 'Shenandoah Valley, VA',
    primarySite: 'va-woodstock',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T14:00:00Z', '2026-10-21T23:00:00Z'],
    holdoutRole: 'regional-expansion-tier-4-va',
    terrainMismatchM: -195.4,
    stationExposure: 'KIAD Sterling RAOB & KRNK Blacksburg RAOB (56 km from va-eagle-rock); narrow ridge geometry smoothed in 3 km HRRR vs 3DEP.',
    summary: 'Eastern US ridge launch testing HRRR vs GFS/ECMWF boundary-layer wind alignment and dry afternoon thermals.'
  },
  {
    caseId: 'blue-ridge-tater-hill-20261021-06z',
    regime: 'blue-ridge-upslope-convergence',
    region: 'Blue Ridge Mountains, NC',
    primarySite: 'nc-tater-hill-boone',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T14:00:00Z', '2026-10-21T23:00:00Z'],
    holdoutRole: 'regional-expansion-tier-4-nc',
    terrainMismatchM: -210.0,
    stationExposure: 'KGSO Greensboro / KRNK Blacksburg RAOBs; high-elevation Blue Ridge escarpment.',
    summary: 'Southern Appalachian thermal + upslope regime comparing HRRR 3 km with GFS and ECMWF IFS.'
  },
  {
    caseId: 'north-sound-frontal-approach-20261022-21z',
    regime: 'pre-frontal-overcast-rain-transition',
    region: 'North Sound, WA',
    primarySite: 'wa-blanchard',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-22T16:00:00Z', '2026-10-23T03:00:00Z'],
    holdoutRole: 'poor-soaring-rain-holdout',
    terrainMismatchM: -156.8,
    stationExposure: 'NWS SEW AFD: weak cold front Thursday Oct 22 bringing increased low/mid cloud cover, onshore flow, and light Olympic/Cascade showers.',
    summary: 'Day-2 transition from Wednesday blue thermals to Thursday marine cloud, overcast development, and shut-down soaring conditions.'
  },
  {
    caseId: 'north-cascade-sauk-shear-20261021-06z',
    regime: 'valley-to-crest-wind-shear',
    region: 'Skagit Valley / North Cascades, WA',
    primarySite: 'wa-sauk-mountain',
    referenceTime: '2026-10-21T06:00:00Z',
    validWindowUtc: ['2026-10-21T16:00:00Z', '2026-10-22T02:00:00Z'],
    holdoutRole: 'shear-sensitivity-holdout',
    terrainMismatchM: -340.2,
    stationExposure: 'Skagit River valley floor (~40 m) to Sauk Mountain launch (1,326.9 m); tests buoyancy-to-shear ratio and mountain-valley decoupling.',
    summary: 'Sharp relief above the Skagit River testing vertical wind shear and thermal depth sensitivity between valley floor and ridge top.'
  }
];

export const PROMOTION_GATES = {
  schemaVersion: 2,
  daytimeWindVectorErrorReductionTargetPct: 10.0,
  minProspectiveIndependentDays: 30,
  rollingRunsRetentionCount: DEFAULT_MAX_ROLLING_RUNS,
  morningDeliveryDeadlineLocalHour: 8,
  morningDeliveryReliabilityTargetPct: 95.0,
  requireNoMaterialWorseningCloudBaseOrHazardWind: true,
  requireMatchedTimeAndLocationVerification: true,
};

export function runKeyFromIso(referenceTime) {
  return referenceTime.replace(/[-:]/g, '').replace('.000Z', 'Z');
}

export function leadTimeBucketForHours(leadHours) {
  if (typeof leadHours !== 'number' || !Number.isFinite(leadHours) || leadHours < 0) return 'unknown';
  for (const bucket of OBSERVATION_MATCHING_RULES.leadTimeBuckets) {
    if (leadHours >= bucket.minHours && leadHours <= bucket.maxHours) return bucket.id;
  }
  return 'f49+';
}

/**
 * Evaluates whether a forecast hour and RAOB sounding satisfy spatial and temporal matching gates.
 */
export function evaluateRaobMatch({ distanceKm, soundingValidAt, forecastValidAt, referenceTime }) {
  const obsMs = Date.parse(soundingValidAt);
  const fcstMs = Date.parse(forecastValidAt);
  const refMs = referenceTime ? Date.parse(referenceTime) : NaN;
  const timeDeltaMinutes = Number.isFinite(obsMs) && Number.isFinite(fcstMs)
    ? Math.abs(fcstMs - obsMs) / 60000
    : Infinity;
  const leadTimeHours = Number.isFinite(fcstMs) && Number.isFinite(refMs)
    ? (fcstMs - refMs) / 3600000
    : null;

  const spatialMatched = Number.isFinite(distanceKm) && distanceKm >= 0 && distanceKm <= OBSERVATION_MATCHING_RULES.raobMaxSiteVerificationDistanceKm;
  const exactTimeMatched = timeDeltaMinutes <= OBSERVATION_MATCHING_RULES.raobExactTimeDeltaMinutes;
  const validLead = leadTimeHours !== null && leadTimeHours >= 0;
  const nearInitTimeMatched = timeDeltaMinutes <= OBSERVATION_MATCHING_RULES.raobNearInitMaxTimeDeltaMinutes && validLead && leadTimeHours <= 1;

  let matchStatus = 'matched';
  if (!validLead) {
    matchStatus = 'rejected-invalid-initialization';
  } else if (!spatialMatched && !exactTimeMatched && !nearInitTimeMatched) {
    matchStatus = 'rejected-time-and-spatial-mismatch';
  } else if (! exactTimeMatched && !nearInitTimeMatched) {
    matchStatus = 'rejected-time-mismatch';
  } else if (!spatialMatched) {
    matchStatus = 'rejected-spatial-distance';
  }

  return {
    matched: matchStatus === 'matched',
    matchStatus,
    matchTier: exactTimeMatched ? 'exact-valid-time' : nearInitTimeMatched ? 'near-init-f01-60min' : 'unmatched',
    distanceKm,
    timeDeltaMinutes,
    leadTimeHours,
    leadTimeBucket: leadTimeBucketForHours(leadTimeHours),
  };
}

export function windVectorComponents(speedMps, directionDeg) {
  const rad = (directionDeg * Math.PI) / 180;
  return [-speedMps * Math.sin(rad), -speedMps * Math.cos(rad)];
}

export function vectorWindErrorMps(fcstSpeed, fcstDir, obsSpeed, obsDir) {
  const [uf, vf] = windVectorComponents(fcstSpeed, fcstDir);
  const [uo, vo] = windVectorComponents(obsSpeed, obsDir);
  return Math.hypot(uf - uo, vf - vo);
}
