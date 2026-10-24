import { formatQuantity } from './units.ts';
// Weather-balloon soundings as Skew-T soundings, read for pilots.
//
// Three sources, all for the upper-air station nearest the launch:
//   - the balloon itself (raob/sites/<slug>.json: temperature, dew point, wind);
//   - the NWS Soaring Forecast's balloon table (temperature and wind only),
//     used when the balloon file is missing;
//   - the Soaring Forecast's model hours (9 AM to 6 PM; temperature and wind).
//
// For morning balloon soundings, the surface parcel starts at the NWS forecast
// high and is lifted via `parcelAscent` (dry-adiabatic up to LCL when moisture
// is present, moist-adiabatic above LCL, or dry-adiabatic throughout when
// dew point is absent in SRG tables) until buoyancy ceases or the profile
// ceiling is reached (which is then flagged as profile-limited).

import {
  findCloudLayers, findStableLayers, freezingLevel, isThermalTopProfileLimited, liftParcel, thermalTop, windAtHeight,
  type Finding, type Reading, type Sounding, type SoundingPoint,
} from "./skewt.ts";
import type { Srg, SrgProfile } from "./srg.ts";
import { compassPoint } from "./launches.ts";

const FT = 3.28084;
const MPH = 2.23694;
const KT = 0.514444;
const G = 9.80665;
const RD = 287.04;
/** Display ceiling: the flyable band and a margin (about 21,000 ft). */
const TOP_HPA = 450;

export interface RaobLevel {
  pressureHpa: number;
  heightM: number;
  temperatureC: number;
  dewPointC: number | null;
  windDirectionDeg: number | null;
  windSpeedMps: number | null;
}

export interface RaobDocument {
  schemaVersion: 1;
  generatedAt: string;
  station: { id: string; name: string; latitude: number; longitude: number; distanceKm: number; elevationM: number | null };
  soundings: { validAt: string; levels: RaobLevel[] }[];
}

export type SoundingKind = "balloon" | "model";

export interface Choice {
  id: string;
  kind: SoundingKind;
  validAt: string;
  sounding: Sounding;
  /** Surface temperature the thermal starts from, and where it comes from. */
  start: { temperatureC: number; source: "forecast-high" | "observed" };
  srgProfile: SrgProfile | null;
  hasDewPoint: boolean;
}

const f = (c: number) => formatQuantity(c, "temperature");
const ftText = (m: number) => formatQuantity(m, "elevation");
const referenceHeight = (m: number) => `${ftText(m)} MSL`;

function finish(points: SoundingPoint[], validAt: string, startC: number, hasDewPoint: boolean, topLabel: string): Sounding {
  const surface = points[0];
  const { parcel, lclM } = liftParcel(points, startC, surface.dewPointC);
  const top = thermalTop(parcel);
  const profileLimited = isThermalTopProfileLimited(parcel);
  const thermals = top !== null && top > surface.heightM + 100;
  return {
    validAt,
    modelElevationM: surface.heightM,
    points,
    parcel,
    lclM,
    boundaryLayerTopM: thermals ? top : null,
    thermalVelocityMps: 0,
    cloudBaseM: hasDewPoint ? lclM : null,
    usableLiftTopM: thermals ? top : null,
    thermalTopProfileLimited: profileLimited,
    capeJkg: null,
    inversions: findStableLayers(points),
    cloudLayers: hasDewPoint ? findCloudLayers(points) : [],
    freezingLevelM: freezingLevel(points),
    topM: points[points.length - 1].heightM,
    hasDewPoint,
    marks: {
      zoneTopM: thermals ? top : null,
      top: thermals ? { heightM: top, label: `${topLabel}${profileLimited ? " ≥ " : " ≈ "}${ftText(top)}` } : null,
      cloudBaseM: thermals && hasDewPoint && lclM !== null && lclM <= top + 100 ? lclM : null,
    },
  };
}

/** A balloon's sounding, with the thermal started from `startC` (the forecast high, or the observed surface). */
export function balloonSounding(sounding: RaobDocument["soundings"][number], startC: number | null): Sounding | null {
  const levels = sounding.levels.filter((l) => l.pressureHpa >= TOP_HPA);
  if (levels.length < 5) return null;
  const points: SoundingPoint[] = levels.map((l, i) => ({
    pressureHpa: l.pressureHpa,
    heightM: l.heightM,
    temperatureC: l.temperatureC,
    dewPointC: l.dewPointC ?? Number.NaN,
    windSpeedMps: l.windSpeedMps,
    windDirectionDeg: l.windDirectionDeg,
    surface: i === 0,
  }));
  const hasDew = points.filter((p) => Number.isFinite(p.dewPointC)).length >= points.length / 2;
  return finish(points, sounding.validAt, Math.max(startC ?? points[0].temperatureC, points[0].temperatureC), hasDew, "Thermals to");
}

/** A Soaring Forecast table (balloon or model hour) as a sounding: heights in feet, pressure from the hypsometric equation. */
export function srgSounding(profile: SrgProfile, stationElevationM: number, startC: number | null): Sounding | null {
  const rows = profile.rows.filter((r) => r.heightFt / FT >= stationElevationM - 30);
  if (rows.length < 5) return null;
  // Surface pressure from the standard atmosphere; a few hPa off changes nothing visible.
  let p = 1013.25 * (1 - 2.25577e-5 * (rows[0].heightFt / FT)) ** 5.25588;
  const points: SoundingPoint[] = [];
  rows.forEach((r, i) => {
    const z = r.heightFt / FT;
    if (i > 0) {
      const below = points[i - 1];
      p *= Math.exp((-G * (z - below.heightM)) / (RD * ((below.temperatureC + r.temperatureC) / 2 + 273.15)));
    }
    points.push({
      pressureHpa: p,
      heightM: z,
      temperatureC: r.temperatureC,
      dewPointC: Number.NaN,
      windSpeedMps: r.windSpeedKt === null ? null : r.windSpeedKt * KT,
      windDirectionDeg: r.windDirectionDeg,
      surface: i === 0,
    });
  });
  const kept = points.filter((pt) => pt.pressureHpa >= TOP_HPA);
  return finish(kept, profile.validAt, Math.max(startC ?? kept[0].temperatureC, kept[0].temperatureC), false, "Thermals to");
}

/** Is `iso` a morning launch (before local noon) at the station? */
export const isMorning = (iso: string, timeZone: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(iso))) < 12;

const localDate = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));

/**
 * Every sounding worth showing, in chronological order across balloon
 * observations and the Soaring Forecast's model hours.
 */
export function choices(doc: RaobDocument | null, srg: Srg | null, timeZone: string): Choice[] {
  const out: Choice[] = [];
  const high = (validAt: string) =>
    srg && srg.forecastMaxTempC !== null && srg.forecastDate === localDate(validAt, timeZone) && isMorning(validAt, timeZone) ? srg.forecastMaxTempC : null;
  for (const s of doc?.soundings ?? []) {
    const start = high(s.validAt);
    const sounding = balloonSounding(s, start);
    if (!sounding) continue;
    out.push({
      id: `balloon-${s.validAt}`,
      kind: "balloon",
      validAt: s.validAt,
      sounding,
      start: start !== null ? { temperatureC: start, source: "forecast-high" } : { temperatureC: sounding.points[0].temperatureC, source: "observed" },
      srgProfile: srg?.observed && Date.parse(srg.observed.validAt) === Date.parse(s.validAt) ? srg.observed : null,
      hasDewPoint: sounding.hasDewPoint,
    });
  }
  const elevationM = (srg?.stationElevationFt ?? 0) / FT || doc?.station.elevationM || 0;
  // A flight the archive does not have (or no balloon file at all): use the
  // Soaring Forecast's own copy of it.
  if (srg?.observed && elevationM && !out.some((c) => Date.parse(c.validAt) === Date.parse(srg.observed!.validAt))) {
    const start = high(srg.observed.validAt);
    const sounding = srgSounding(srg.observed, elevationM, start);
    if (sounding) {
      out.push({
        id: `balloon-${srg.observed.validAt}`,
        kind: "balloon",
        validAt: srg.observed.validAt,
        sounding,
        start: start !== null ? { temperatureC: start, source: "forecast-high" } : { temperatureC: sounding.points[0].temperatureC, source: "observed" },
        srgProfile: srg.observed,
        hasDewPoint: false,
      });
    }
  }
  for (const m of srg?.model ?? []) {
    if (!elevationM) break;
    const sounding = srgSounding(m, elevationM, null);
    if (!sounding) continue;
    out.push({ id: `model-${m.validAt}`, kind: "model", validAt: m.validAt, sounding, start: { temperatureC: sounding.points[0].temperatureC, source: "observed" }, srgProfile: m, hasDewPoint: false });
  }
  return out.sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt) || Number(a.kind === "model") - Number(b.kind === "model"));
}

/** An evening flight: the ground has already cooled, so the afternoon's thermals went higher than a thermal now would. */
function eveningText(s: Sounding, top: number, choice: Choice, time: Intl.DateTimeFormat) {
  if (s.thermalTopProfileLimited) {
    return `${time.format(new Date(choice.validAt))} station parcel: ${f(choice.start.temperatureC)} surface · buoyant through profile top ${referenceHeight(top)} (ceiling unresolved).`;
  }
  return `${time.format(new Date(choice.validAt))} station parcel: ${f(choice.start.temperatureC)} surface · top ${referenceHeight(top)}.`;
}

function liWords(li: number): { text: string; tone: Finding["tone"] } {
  if (li >= 3) return { text: "Very stable aloft", tone: "good" };
  if (li >= 0) return { text: "Stable aloft", tone: "good" };
  if (li >= -3) return { text: "Slightly unstable · Cu growth possible", tone: "caution" };
  if (li >= -6) return { text: "Unstable · storm potential", tone: "warning" };
  return { text: "Very unstable · strong storm potential", tone: "warning" };
}

const SOARING_TONE: Record<string, Finding["tone"]> = { excellent: "good", good: "good", fair: "neutral", poor: "caution", none: "caution" };

/** What a balloon or model-hour sounding means for a pilot launching at `launchM`. */
export function readChoice(choice: Choice, srg: Srg | null, launchM: number | null, timeZone: string): Reading {
  const s = choice.sounding;
  const findings: Finding[] = [];
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const top = s.marks.zoneTopM;
  const station = s.modelElevationM;
  const fromHigh = choice.start.source === "forecast-high";
  const morning = choice.kind === "balloon" && isMorning(choice.validAt, timeZone);
  const profileLimited = Boolean(s.thermalTopProfileLimited);

  // Thermals
  if (top !== null) {
    const lead = profileLimited
      ? fromHigh
        ? `Forecast high ${f(choice.start.temperatureC)} · parcel buoyant through profile top ${referenceHeight(top)} (≥ ${ftText(top - station)} above station · ceiling unresolved).`
        : choice.kind === "model"
          ? `NWS ${time.format(new Date(choice.validAt))} · surface ${f(choice.start.temperatureC)} · parcel buoyant through profile top ${referenceHeight(top)} (ceiling unresolved).`
          : eveningText(s, top, choice, time)
      : fromHigh
        ? `Forecast high ${f(choice.start.temperatureC)} · parcel top ${referenceHeight(top)} · ${ftText(top - station)} above station.`
        : choice.kind === "model"
          ? `NWS ${time.format(new Date(choice.validAt))} · surface ${f(choice.start.temperatureC)} · parcel top ${referenceHeight(top)}.`
          : eveningText(s, top, choice, time);
    let text = lead;
    if (fromHigh && srg?.maxThermalHeightFt) text += ` NWS top ${ftText(srg.maxThermalHeightFt / FT)}${srg.maxLiftFpm ? ` · lift ${formatQuantity(srg.maxLiftFpm / 196.850394, "lift")}` : ""}.`;
    const tone = fromHigh && srg?.soaringIndex ? SOARING_TONE[srg.soaringIndex.toLowerCase()] ?? "neutral" : "neutral";
    findings.push({ key: "thermals", title: fromHigh && srg?.soaringIndex ? `Thermals: ${srg.soaringIndex}` : "Thermals", text, tone });
  } else {
    findings.push({
      key: "thermals",
      title: "Thermals",
      text: morning && !fromHigh ? "Stable morning parcel · forecast-high estimate unavailable." : `Stable surface parcel at ${f(choice.start.temperatureC)}.`,
      tone: "neutral",
    });
  }

  // Trigger (the morning Soaring Forecast)
  if (fromHigh && srg?.triggerTempC != null) {
    findings.push({
      key: "thermals",
      title: "When they start",
      text: `NWS trigger ${f(srg.triggerTempC)}${srg.triggerTime ? ` · ${time.format(new Date(srg.triggerTime))}` : ""}.`,
      tone: "neutral",
    });
  }

  // Launch
  if (launchM !== null && top !== null) {
    if (profileLimited) {
      if (top < launchM + 150) {
        findings.push({
          key: "top",
          title: "Launch reference",
          text: `Profile ends at ${referenceHeight(top)}, near or below launch elevation ${referenceHeight(launchM)} · thermal ceiling unresolved.`,
          tone: "neutral",
        });
      } else {
        findings.push({
          key: "top",
          title: "Launch reference",
          text: `Parcel remains buoyant at profile top ${referenceHeight(top)} (≥ ${ftText(top - launchM)} above launch elevation ${referenceHeight(launchM)} · ceiling unresolved).`,
          tone: "neutral",
        });
      }
    } else if (top < launchM + 150) {
      findings.push({ key: "top", title: "Launch reference", text: `Station parcel top near or below launch elevation ${referenceHeight(launchM)}.`, tone: "neutral" });
    } else {
      findings.push({ key: "top", title: "Launch reference", text: `Station parcel top ${ftText(top - launchM)} above launch elevation ${referenceHeight(launchM)}.`, tone: "neutral" });
    }
  }

  // Clouds
  if (choice.hasDewPoint && top !== null && s.lclM !== null) {
    if (s.lclM <= top + 100) {
      findings.push({ key: "clouds", title: "Clouds", text: `Cu possible · base ${referenceHeight(s.lclM)}.`, tone: "good" });
    } else if (profileLimited) {
      findings.push({
        key: "clouds",
        title: "Clouds",
        text: `LCL ${referenceHeight(s.lclM)} above profile top ${referenceHeight(top)} · cloud reach unresolved.`,
        tone: "neutral",
      });
    } else {
      findings.push({ key: "clouds", title: "Clouds", text: `Blue thermals · LCL ${referenceHeight(s.lclM)} above parcel top.`, tone: "neutral" });
    }
  } else if (!choice.hasDewPoint) {
    findings.push({ key: "clouds", title: "Clouds", text: "Humidity unavailable · cloud estimate unavailable.", tone: "neutral" });
  }
  const deck = s.cloudLayers.find((l) => !l.grounded);
  if (deck) findings.push({ key: "clouds", title: "Cloud layer", text: `Near-saturated layer ${ftText(deck.baseM)}–${referenceHeight(deck.topM)}.`, tone: "caution" });

  // Lids
  const grounded = s.inversions.find((l) => l.grounded);
  if (grounded) {
    findings.push({
      key: "lid",
      title: "Valley inversion",
      text: `Surface inversion to ${referenceHeight(grounded.topM)}${morning ? " · heating needed" : ""}.`,
      tone: "neutral",
    });
  }
  const lid = s.inversions.find((l) => !l.grounded && l.baseM <= (top ?? station) + (morning ? 600 : 1500));
  if (lid) findings.push({ key: "lid", title: lid.kind === "inversion" ? "Inversion" : "Stable layer", text: `${ftText(lid.baseM)}–${referenceHeight(lid.topM)} · thermal cap.`, tone: "neutral" });

  // Wind
  const at = (z: number) => windAtHeight(s.points, z);
  const words = (w: { speedMps: number; directionDeg: number } | null) => (!w ? "–" : w.speedMps * MPH < 2 ? "calm" : `${compassPoint(w.directionDeg)} ${formatQuantity(w.speedMps, "wind")}`);
  const heights = [launchM ?? station + 600, top ?? station + 2000];
  const [low, high2] = heights.map(at);
  const wind = [`${referenceHeight(heights[0])}: ${low ? words(low) : "unavailable"}.`];
  if (Math.abs(heights[1] - heights[0]) > 1) wind.push(`${referenceHeight(heights[1])}: ${high2 ? words(high2) : "unavailable"}.`);
  findings.push({ key: "wind", title: "Station profile wind", text: wind.join(" "), tone: "neutral" });

  // Stability and storms
  const li = choice.srgProfile?.liftedIndex ?? null;
  if (li !== null) {
    const w = liWords(li);
    const cape = choice.srgProfile?.capeJkg;
    findings.push({ key: "storms", title: "Storms", text: `Lifted index ${li > 0 ? "+" : ""}${li}: ${w.text}.${cape != null && cape > 0 ? ` CAPE ${Math.round(cape)} J/kg.` : ""}`, tone: w.tone });
  }
  if (fromHigh && srg?.overdevelopment && srg.overdevelopment.toLowerCase() !== "none") {
    findings.push({ key: "storms", title: "Overdevelopment", text: `NWS Cu overdevelopment: ${srg.overdevelopment}.`, tone: "warning" });
  }
  if (s.freezingLevelM !== null && s.freezingLevelM > station + 100) {
    findings.push({ key: "stability", title: "Freezing level", text: `${referenceHeight(s.freezingLevelM)}.`, tone: "neutral" });
  }

  let headline: string;
  if (top === null) headline = "Stable surface parcel.";
  else if (profileLimited) {
    headline = fromHigh
      ? `At forecast high ${f(choice.start.temperatureC)} · thermals ≥ ${referenceHeight(top)} (profile-limited)${choice.hasDewPoint && s.lclM !== null ? (s.lclM <= top + 100 ? ` · Cu base ${referenceHeight(s.lclM)}` : " · cloud reach unresolved") : ""}.`
      : `Thermals ≥ ${referenceHeight(top)} (profile-limited) · ${time.format(new Date(choice.validAt))}.`;
  } else if (fromHigh) headline = `At forecast high ${f(choice.start.temperatureC)} · thermals to ${referenceHeight(top)}${choice.hasDewPoint && s.lclM !== null ? (s.lclM <= top + 100 ? ` · Cu base ${referenceHeight(s.lclM)}` : " · blue") : ""}.`;
  else headline = `Thermals to ${referenceHeight(top)} · ${time.format(new Date(choice.validAt))}.`;
  return { headline, findings };
}
