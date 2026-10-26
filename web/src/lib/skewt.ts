import { convertQuantity, finiteScalar, formatQuantity, getUnitSystem, legacyMetresToFeet, mpsToMph } from "./units.ts";
import { publishedEffectiveCloudLimit, publishedLift } from "./published-lift.ts";
// One hour of a model profile as a sounding, and what it means for a pilot.
//
// The thermodynamics come from @azohra/meteo.briefing (the same lifted
// parcel and derived heights the soaring meteogram uses), so the Skew-T and
// the meteogram always agree. This module adds what a Skew-T reader looks
// for: inversions, cloud layers, the freezing level, winds at launch and at
// the top of the lift, and a plain-language reading of all of it.

import type { SiteForecast } from "@azohra/meteo.briefing/contract";
import { DRY_ADIABATIC_LAPSE_C_PER_M, lapseRateCPer1000Ft, parcelAscent, stabilityClass } from "@azohra/meteo.briefing/derive";
import { sampleWindAtHeight } from '@windgrams/meteorology';
import { GRAVITY_MPS2, RD_J_PER_KG_K } from '@windgrams/meteorology/thermodynamics';
import { compassPoint } from "./launches.ts";

type Hour = SiteForecast["hours"][number];
type Value = number | { p50: number | null; members?: number } | null | undefined;

/** Scalar value of a field: the number itself, or the ensemble median. */
export function scalar(v: Value): number | null {
  return finiteScalar(v);
}

export interface SoundingPoint {
  pressureHpa: number;
  /** Geopotential height, metres above mean sea level. */
  heightM: number;
  temperatureC: number;
  dewPointC: number;
  windSpeedMps: number | null;
  windDirectionDeg: number | null;
  /** Wind sampling height when it differs from the temperature anchor (model 10 m wind). */
  windHeightM?: number;
  /** The model surface values: temperature/moisture at 2 m, wind at windHeightM. */
  surface: boolean;
}

export interface ParcelSample {
  pressureHpa: number;
  heightM: number;
  parcelC: number;
  environmentC: number;
  /** Virtual-temperature excess with complete moisture; dry-temperature excess for a qualified dry curve. */
  buoyancyC: number;
}

/** Wind support is independent of whether temperature or dew point can be plotted. */
export type SoundingWindPoint = Pick<SoundingPoint, 'heightM' | 'windHeightM' | 'windSpeedMps' | 'windDirectionDeg'> & { pressureHpa?: number };

interface ParcelCurve {
  parcel: ParcelSample[];
  lclM: number | null;
  /** True when missing humidity limits the parcel curve to dry ascent. */
  dryParcelOnly: boolean;
}

export interface Layer {
  baseM: number;
  topM: number;
  kind: "inversion" | "stable" | "cloud";
  /** For inversions: warming across the layer, degC. */
  strengthC?: number;
  /** True when the layer starts at the ground. */
  grounded?: boolean;
}

export interface Sounding extends ParcelCurve {
  validAt: string;
  modelElevationM: number;
  /** Surface first, then the published levels upward. */
  points: SoundingPoint[];
  windPoints?: SoundingWindPoint[];
  boundaryLayerTopM: number | null;
  thermalVelocityMps: number | null;
  cloudBaseM: number | null;
  /** Model-derived near-saturation ceiling proxy when distinct from surface LCL. */
  effectiveCloudLimitM?: number | null;
  usableLiftTopM: number | null;
  /** True when lifted-parcel buoyancy stays positive through the highest available level. */
  thermalTopProfileLimited?: boolean;
  /** Surface-based CAPE the model published, J/kg. */
  capeJkg: number | null;
  inversions: Layer[];
  cloudLayers: Layer[];
  freezingLevelM: number | null;
  /** Highest published level. */
  topM: number;
  /** False when the source has no dew point (the line and cloud layers are not drawn). */
  hasDewPoint: boolean;
  /** What the chart marks: the shaded thermal zone, the top line and the cloud base. */
  marks: {
    zoneTopM: number | null;
    top: { heightM: number; label: string } | null;
    cloudBaseM: number | null;
  };
}

// ── building ────────────────────────────────────────────────────────────────

/** Surface pressure from the lowest level by the hypsometric equation. */
export function surfacePressureHpa(surface: { heightM: number; temperatureC: number }, level: { pressureHpa: number; heightM: number; temperatureC: number }) {
  const meanK = (surface.temperatureC + level.temperatureC) / 2 + 273.15;
  return level.pressureHpa * Math.exp((GRAVITY_MPS2 * (level.heightM - surface.heightM)) / (RD_J_PER_KG_K * meanK));
}

/** The sounding for one hour, or null when the hour has too few levels to draw. */
export function buildSounding(profile: Pick<SiteForecast, "site">, hour: Hour): Sounding | null {
  const zs = profile.site.modelElevationM;
  const s = hour.surface;
  const ts = scalar(s.temperatureC);
  const tds = scalar(s.dewPointC);
  if (ts === null) return null;

  // Missing humidity limits the sounding; it does not erase temperature or wind.
  // Dew points become NaN (not drawn, no cloud layers), mirroring the balloon path,
  // and liftParcel then follows its qualified dry-parcel branch.
  const levels: SoundingPoint[] = [];
  for (const l of hour.levels ?? []) {
    const p = scalar(l.pressureHpa);
    const z = scalar(l.heightM);
    const t = scalar(l.temperatureC);
    const td = scalar(l.dewPointC);
    if (p === null || z === null || t === null || z <= zs + 5) continue;
    levels.push({ pressureHpa: p, heightM: z, temperatureC: t, dewPointC: td === null ? Number.NaN : Math.min(td, t), windSpeedMps: scalar(l.windSpeedMps), windDirectionDeg: scalar(l.windDirectionDeg), surface: false });
  }
  levels.sort((a, b) => a.heightM - b.heightM);
  if (levels.length < 2) return null;
  const hasDewPoint = tds !== null && levels.every(l => Number.isFinite(l.dewPointC));

  const modelPressure = finiteScalar((s as { surfacePressureHpa?: unknown }).surfacePressureHpa);
  // The parcel calculation retains its model-ground initialization convention.
  // The returned environmental point is moved to its measured 2 m height below.
  const surface: SoundingPoint = {
    pressureHpa: modelPressure !== null && modelPressure > 0 ? modelPressure : surfacePressureHpa({ heightM: zs, temperatureC: ts }, levels[0]),
    heightM: zs,
    temperatureC: ts,
    dewPointC: tds === null ? Number.NaN : Math.min(tds, ts),
    windSpeedMps: scalar(s.windSpeedMps),
    windDirectionDeg: scalar(s.windDirectionDeg),
    windHeightM: zs + 10,
    surface: true,
  };
  const parcelPoints = [surface, ...levels];
  const points = [{ ...surface, heightM: zs + 2, pressureHpa: pressureAtHeight(parcelPoints, zs + 2) }, ...levels];
  const windPoints: SoundingWindPoint[] = [
    { heightM: zs + 10, windSpeedMps: surface.windSpeedMps, windDirectionDeg: surface.windDirectionDeg },
    ...hour.levels.flatMap(level => {
      const heightM = scalar(level.heightM), pressureHpa = scalar(level.pressureHpa);
      return heightM !== null && heightM > zs ? [{ heightM,
        windSpeedMps: scalar(level.windSpeedMps), windDirectionDeg: scalar(level.windDirectionDeg),
        ...(pressureHpa !== null ? { pressureHpa } : {}) }] : [];
    }),
  ].sort((a, b) => a.heightM - b.heightM);
  const topM = levels[levels.length - 1].heightM;

  const { parcel, lclM, dryParcelOnly } = liftParcel(parcelPoints, ts, surface.dewPointC);

  const d = publishedLift(hour);
  const w = scalar(d.thermalVelocityMps);
  const bl = scalar(d.boundaryLayerTopM);
  const usable = scalar(d.usableLiftTopM);
  const base = scalar(d.cloudBaseM);
  const effLimit = scalar(publishedEffectiveCloudLimit(hour));
  const thermals = w !== null && w >= 0.1 && bl !== null;
  const zoneTop = thermals ? (usable ?? bl) : null;
  const profileLimited = isThermalTopProfileLimited(parcel);
  return {
    validAt: hour.validAt,
    modelElevationM: zs,
    points,
    windPoints,
    parcel,
    lclM,
    boundaryLayerTopM: bl,
    thermalVelocityMps: w,
    cloudBaseM: base,
    effectiveCloudLimitM: effLimit,
    usableLiftTopM: usable,
    thermalTopProfileLimited: profileLimited,
    capeJkg: scalar(s.capeJkg),
    inversions: findStableLayers(points),
    cloudLayers: hasDewPoint ? findCloudLayers(points) : [],
    freezingLevelM: freezingLevel(points),
    topM,
    hasDewPoint,
    dryParcelOnly,
    marks: {
      zoneTopM: zoneTop !== null && zoneTop > zs ? zoneTop : null,
      top: thermals && usable !== null ? { heightM: usable, label: `Top of lift ${formatQuantity(usable, "elevation")}` } : null,
      cloudBaseM: hasDewPoint && thermals && base !== null && base <= bl! + 100 ? base : null,
    },
  };
}

/**
 * Lifts a thermal from the ground through a column, stepping every 25 m for
 * display curve rendering only (display interpolation between native model
 * levels does not resolve sub-grid inversions or extra vertical structure).
 */
export function liftParcel(points: SoundingPoint[], surfaceTempC: number, surfaceDewPointC: number): ParcelCurve {
  const surface = points[0];
  const zs = surface.heightM;
  const topM = points[points.length - 1].heightM;
  const dense: { heightM: number; temperatureC: number; dewPointC: number }[] = [];
  for (let z = zs + 25; z < topM; z += 25) {
    const env = environmentAtHeight(points, z);
    dense.push({ heightM: z, temperatureC: env.temperatureC, dewPointC: env.dewPointC });
  }
  for (const l of points.slice(1)) dense.push({ heightM: l.heightM, temperatureC: l.temperatureC, dewPointC: l.dewPointC });
  dense.sort((a, b) => a.heightM - b.heightM);
  // Missing humidity limits the curve to a dry-temperature comparison.
  if (!Number.isFinite(surfaceDewPointC) || points.some(point => !Number.isFinite(point.dewPointC))) {
    return { lclM: null, dryParcelOnly: true, parcel: [{ heightM: zs, temperatureC: surface.temperatureC }, ...dense].map(level => {
      const parcelC = surfaceTempC - DRY_ADIABATIC_LAPSE_C_PER_M * (level.heightM - zs);
      return { pressureHpa: pressureAtHeight(points, level.heightM), heightM: level.heightM,
        parcelC, environmentC: level.temperatureC, buoyancyC: parcelC - level.temperatureC };
    }) };
  }
  const dew = Math.min(surfaceDewPointC, surfaceTempC);
  const ascent = parcelAscent({ temperatureC: surfaceTempC, dewPointC: dew, elevationM: zs }, dense);
  return {
    lclM: ascent.lclM,
    dryParcelOnly: false,
    parcel: [
      { pressureHpa: surface.pressureHpa, heightM: zs, parcelC: surfaceTempC, environmentC: surface.temperatureC, buoyancyC: surfaceTempC - surface.temperatureC },
      ...ascent.levels.map((sample) => ({
        pressureHpa: pressureAtHeight(points, sample.heightM),
        heightM: sample.heightM,
        parcelC: sample.parcelTempC,
        environmentC: sample.envTempC,
        buoyancyC: sample.buoyancyC,
      })),
    ],
  };
}

/** Where a lifted thermal stops: the first height above the ground where it is no longer warmer than the air. */
export function thermalTop(parcel: ParcelSample[]): number | null {
  let rising = false;
  for (let i = 1; i < parcel.length; i += 1) {
    const a = parcel[i - 1];
    const b = parcel[i];
    if (b.buoyancyC > 0) rising = true;
    if (rising && b.buoyancyC <= 0) {
      const f = a.buoyancyC / (a.buoyancyC - b.buoyancyC);
      return a.heightM + f * (b.heightM - a.heightM);
    }
  }
  return rising ? parcel[parcel.length - 1].heightM : null;
}

/** True when a buoyant parcel reaches the top of the sampled profile without crossing to non-positive buoyancy. */
export function isThermalTopProfileLimited(parcel: ParcelSample[]): boolean {
  let rising = false;
  for (let i = 1; i < parcel.length; i += 1) {
    const b = parcel[i];
    if (b.buoyancyC > 0) rising = true;
    if (rising && b.buoyancyC <= 0) return false;
  }
  return rising && parcel.length > 1 && parcel[parcel.length - 1].buoyancyC > 0;
}

// ── interpolation (linear in log-pressure, as the chart draws) ──────────────

function bracket(points: SoundingPoint[], z: number) {
  let i = 0;
  while (i < points.length - 2 && points[i + 1].heightM < z) i += 1;
  const a = points[i];
  const b = points[i + 1];
  return { a, b, f: (z - a.heightM) / (b.heightM - a.heightM) };
}

export function pressureAtHeight(points: SoundingPoint[], z: number) {
  const { a, b, f } = bracket(points, z);
  return Math.exp(Math.log(a.pressureHpa) + f * (Math.log(b.pressureHpa) - Math.log(a.pressureHpa)));
}

export function heightAtPressure(points: SoundingPoint[], p: number) {
  let i = 0;
  while (i < points.length - 2 && points[i + 1].pressureHpa > p) i += 1;
  const a = points[i];
  const b = points[i + 1];
  const f = (Math.log(p) - Math.log(a.pressureHpa)) / (Math.log(b.pressureHpa) - Math.log(a.pressureHpa));
  return a.heightM + f * (b.heightM - a.heightM);
}

export function environmentAtHeight(points: SoundingPoint[], z: number) {
  const { a, b, f } = bracket(points, z);
  const lerp = (x: number, y: number) => x + f * (y - x);
  return { temperatureC: lerp(a.temperatureC, b.temperatureC), dewPointC: lerp(a.dewPointC, b.dewPointC) };
}

/** Wind at a height in metres MSL, interpolated only within the available wind column. */
export function windAtHeight(points: readonly SoundingWindPoint[], z: number): { speedMps: number; directionDeg: number | null } | null {
  const wind = sampleWindAtHeight(points.map(point => ({ ...point, heightM: point.windHeightM ?? point.heightM })), z);
  return wind.status === 'available' ? { speedMps: wind.speedMps, directionDeg: wind.directionDeg } : null;
}

// ── features ────────────────────────────────────────────────────────────────

/**
 * Layers where temperature does not fall with height: inversions (it rises)
 * and stable, nearly isothermal layers (it falls by less than 0.3 °C per
 * 1000 ft, a tenth of a dry thermal's cooling). Both act as a lid on thermals.
 */
export function findStableLayers(points: SoundingPoint[]): Layer[] {
  const layers: Layer[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const lapse = lapseRateCPer1000Ft(a, b);
    if (lapse === null) continue;
    const kind = lapse > 0 ? "inversion" : lapse > -0.3 ? "stable" : null;
    if (!kind) continue;
    const prev = layers[layers.length - 1];
    if (prev && Math.abs(prev.topM - a.heightM) < 1) {
      prev.topM = b.heightM;
      if (kind === "inversion") prev.kind = "inversion";
      prev.strengthC = Math.max(0, (prev.strengthC ?? 0) + (b.temperatureC - a.temperatureC));
    } else {
      layers.push({ baseM: a.heightM, topM: b.heightM, kind, strengthC: Math.max(0, b.temperatureC - a.temperatureC), grounded: a.surface });
    }
  }
  return layers;
}

/**
 * Layers where the model column is within 1 °C of saturation (a model-derived
 * near-saturation proxy for cloud layers, rather than an observed cloud base).
 */
export function findCloudLayers(points: SoundingPoint[]): Layer[] {
  const layers: Layer[] = [];
  points.forEach((p, i) => {
    if (!(p.temperatureC - p.dewPointC <= 1)) return;
    const below = i > 0 ? (points[i - 1].heightM + p.heightM) / 2 : p.heightM;
    const above = i < points.length - 1 ? (points[i + 1].heightM + p.heightM) / 2 : p.heightM;
    const prev = layers[layers.length - 1];
    if (prev && prev.topM >= below - 1) prev.topM = above;
    else layers.push({ baseM: below, topM: above, kind: "cloud", grounded: p.surface });
  });
  return layers;
}

/** Lowest height where the temperature falls through 0 °C. */
export function freezingLevel(points: SoundingPoint[]): number | null {
  if (points[0].temperatureC <= 0) return points[0].heightM;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a.temperatureC > 0 && b.temperatureC <= 0) return a.heightM + ((0 - a.temperatureC) / (b.temperatureC - a.temperatureC)) * (b.heightM - a.heightM);
  }
  return null;
}

// ── plain words ────────────────────────────────────────────────────────────────

export type Tone = "good" | "neutral" | "caution" | "warning";

export interface Finding {
  key: "thermals" | "top" | "clouds" | "lid" | "wind" | "storms" | "stability";
  title: string;
  text: string;
  tone: Tone;
}

export interface Reading {
  headline: string;
  findings: Finding[];
}

export const feet = (m: number) => Math.round(legacyMetresToFeet(m) / 100) * 100;
const heightText = (m: number) => {
  const step = getUnitSystem() === "metric" ? 50 : 100;
  const height = convertQuantity(m, "elevation")!;
  return `${(Math.round(height / step) * step).toLocaleString("en-US")} ${getUnitSystem() === "metric" ? "m" : "ft"}`;
};
const referenceHeightText = (m: number) => formatQuantity(m, "elevation");
/** One wording for model, balloon and hovered sounding winds. */
export function windText(wind: ReturnType<typeof windAtHeight>): string {
  if (!wind) return 'unavailable';
  if (mpsToMph(wind.speedMps) < 2) return 'calm';
  const direction = wind.directionDeg === null ? 'Direction unavailable' : compassPoint(wind.directionDeg);
  return `${direction} ${formatQuantity(wind.speedMps, 'wind')}`;
}

/** Thermal strength words for Deardorff's w* (m/s). */
export function strengthWords(wStar: number | null): { word: string; tone: Tone } {
  if (wStar === null) return { word: "unavailable", tone: "neutral" };
  if (wStar < 1) return { word: "weak", tone: "neutral" };
  if (wStar < 1.5) return { word: "weak", tone: "neutral" };
  if (wStar < 2.5) return { word: "moderate", tone: "good" };
  if (wStar < 3.5) return { word: "strong", tone: "good" };
  return { word: "very strong", tone: "caution" };
}

const STABILITY_WORDS: Record<string, string> = {
  "very-unstable": "Very unstable",
  unstable: "Unstable",
  "conditional-strong": "Conditionally unstable",
  conditional: "Moderately unstable",
  "near-neutral": "Near neutral",
  stable: "Stable",
  inverted: "Inversion",
  "strong-inversion": "Strong inversion",
};

/** What the sounding means for a pilot launching at `launchM` (m MSL). */
export function readSounding(sounding: Sounding, launchM: number | null): Reading {
  const findings: Finding[] = [];
  const launch = launchM ?? sounding.modelElevationM;
  const w = sounding.thermalVelocityMps;
  const bl = sounding.boundaryLayerTopM;
  const top = sounding.usableLiftTopM;
  const hasThermals = bl !== null && w !== null && w >= 0.1;

  // Thermals
  if (w === null) {
    findings.push({ key: "thermals", title: "Thermals", text: "Unavailable", tone: "neutral" });
  } else if (!hasThermals) {
    findings.push({ key: "thermals", title: "Thermals", text: "Minimal thermal lift", tone: "neutral" });
  } else {
    const { word, tone } = strengthWords(w);
    findings.push({
      key: "thermals",
      title: "Thermals",
      text: `${word[0].toUpperCase()}${word.slice(1)} · w* ${formatQuantity(w, "lift")}`,
      tone,
    });
  }

  // Top of lift
  if (hasThermals) {
    if (top === null) {
      findings.push({ key: "top", title: "Top of lift", text: `Mixing top ${heightText(bl!)} MSL · Climb ceiling unavailable`, tone: "neutral" });
    } else if (top <= launch + 150) {
      findings.push({ key: "top", title: "Top of lift", text: `Lift ${heightText(top)} MSL · Near launch`, tone: "caution" });
    } else {
      findings.push({ key: "top", title: "Top of lift", text: `Lift ${heightText(top)} MSL · ${heightText(top - launch)} above launch`, tone: "good" });
    }
  }

  // Clouds
  const base = sounding.cloudBaseM;
  if (hasThermals && !sounding.hasDewPoint) {
    findings.push({
      key: "clouds",
      title: "Cloud base",
      text: "Unavailable · Humidity missing",
      tone: "neutral",
    });
  } else if (hasThermals && base !== null && base <= bl! + 100) {
    const low = base < launch + 300;
    findings.push({
      key: "clouds",
      title: "Clouds",
      text: low
        ? `Cloud base ${heightText(base)} MSL · Near launch`
        : `Cumulus base ${heightText(base)} MSL`,
      tone: low ? "caution" : "good",
    });
  } else if (hasThermals) {
    findings.push({
      key: "clouds",
      title: "Clouds",
      text: `Blue thermals${sounding.lclM !== null ? ` · LCL ${heightText(sounding.lclM)} MSL` : ""}`,
      tone: "neutral",
    });
  }
  // A saturated layer at the cumulus base is the cumulus itself, not a separate deck.
  const cumulus = hasThermals && base !== null && base <= bl! + 100;
  const deck = sounding.cloudLayers.find((l) => !l.grounded && !(cumulus && l.baseM <= base! + 300));
  if (deck) {
    findings.push({ key: "clouds", title: "Cloud layer", text: `Cloud layer ${heightText(deck.baseM)}–${heightText(deck.topM)} MSL · Shading`, tone: "caution" });
  }

  // Lids
  const grounded = sounding.inversions.find((l) => l.grounded);
  if (grounded) {
    findings.push({
      key: "lid",
      title: "Ground inversion",
      text: `Surface inversion to ${heightText(grounded.topM)} MSL`,
      tone: "neutral",
    });
  }
  const ceiling = (hasThermals ? bl! : sounding.modelElevationM) + 600;
  const lid = sounding.inversions.find((l) => !l.grounded && l.baseM <= ceiling);
  if (lid) {
    findings.push({
      key: "lid",
      title: lid.kind === "inversion" ? "Inversion" : "Stable layer",
      text: `${lid.kind === "inversion" ? "Inversion" : "Stable layer"} ${heightText(lid.baseM)}–${heightText(lid.topM)} MSL · Thermal cap`,
      tone: "neutral",
    });
  }

  // Wind
  // Aloft: the top of the lift, or about 3,000 ft above launch when there are no thermals.
  const topHeight = hasThermals ? (top ?? bl!) : launch + 900;
  const surfaceWindHeight = sounding.points[0].windHeightM ?? sounding.modelElevationM;
  const windPoints = sounding.windPoints ?? sounding.points;
  const windReference = launchM ?? surfaceWindHeight;
  const atLaunch = windAtHeight(windPoints, windReference);
  const atTop = windAtHeight(windPoints, topHeight);
  const windParts: string[] = [];
  if (launchM !== null) {
    if (atLaunch) windParts.push(`Experimental free-air wind estimate at launch elevation (${referenceHeightText(launchM)} MSL): ${windText(atLaunch)}. This is not the model surface wind. Local terrain flow is unresolved.`);
    else if (launchM < sounding.modelElevationM) windParts.push(`Launch wind unavailable (${referenceHeightText(launchM)} MSL) · Below model ground.`);
    else windParts.push(`Wind unavailable at launch elevation (${referenceHeightText(launchM)} MSL).`);
  }
  if (launchM === null || !atLaunch) {
    const surfaceWind = windAtHeight(windPoints, surfaceWindHeight);
    if (surfaceWind) windParts.push(`Model surface (${formatQuantity(surfaceWindHeight - sounding.modelElevationM, "elevation")} AGL): ${windText(surfaceWind)}.`);
  }
  if (topHeight !== windReference) {
    windParts.push(atTop ? `Aloft (${heightText(topHeight)} MSL): ${windText(atTop)}.` : `Aloft (${heightText(topHeight)} MSL): Unavailable.`);
  }
  windParts.push(`Model terrain: ${referenceHeightText(sounding.modelElevationM)} MSL.`);
  findings.push({ key: "wind", title: "Wind", text: windParts.join(" "), tone: "neutral" });

  // Storms: the model's CAPE counts energy for air lifted to condensation. On a
  // blue day the thermals themselves stop short of that, so the risk is real
  // only where something else lifts the air (higher terrain, convergence).
  const cape = sounding.capeJkg;
  if (cape !== null && cape >= 100) {
    const high = cape >= 500;
    if (cumulus) {
      findings.push({
        key: "storms",
        title: high ? "Storm risk" : "Cloud growth",
        text: high
          ? `CAPE ${Math.round(cape)} J/kg · Thunderstorm growth potential`
          : `CAPE ${Math.round(cape)} J/kg · Cumulus growth potential`,
        tone: high ? "warning" : "caution",
      });
    } else if (high) {
      findings.push({
        key: "storms",
        title: "Unstable air aloft",
        text: `CAPE ${Math.round(cape)} J/kg · Storm potential with terrain or convergence lift`,
        tone: "caution",
      });
    }
  }

  // Stability of the thermal layer
  if (hasThermals && bl! > sounding.modelElevationM + 200) {
    const env = environmentAtHeight(sounding.points, bl!);
    const lapse = lapseRateCPer1000Ft({ heightM: sounding.modelElevationM, temperatureC: sounding.points[0].temperatureC }, { heightM: bl!, temperatureC: env.temperatureC });
    if (lapse !== null) {
      const words = STABILITY_WORDS[stabilityClass(lapse)] ?? "";
      findings.push({ key: "stability", title: "Air", text: `${words} · ${formatQuantity(lapse, "lapseRate")}`, tone: "neutral" });
    }
  }

  return { headline: headline(sounding, findings, hasThermals), findings };
}

function headline(sounding: Sounding, findings: Finding[], hasThermals: boolean) {
  if (sounding.thermalVelocityMps === null) return "Thermals: Unavailable";
  if (!hasThermals) return "Minimal thermal lift";
  const parts: string[] = [];
  const { word } = strengthWords(sounding.thermalVelocityMps);
  const top = sounding.usableLiftTopM;
  parts.push(top !== null ? `${word[0].toUpperCase()}${word.slice(1)} thermals · ${heightText(top)}` : `Thermals ${word}`);
  const clouds = findings.find((f) => f.key === "clouds");
  if (clouds?.title === "Clouds") parts.push(clouds.text.startsWith("Blue") ? "Blue thermals" : `Cumulus base ${heightText(sounding.cloudBaseM!)}`);
  const warn = findings.find((f) => f.tone === "warning");
  let text = parts.join(", ");
  if (warn) text += ` · ${warn.title}`;
  return `${text}.`;
}
