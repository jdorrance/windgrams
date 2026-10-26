// Physical column sampling, interval lapse-rate reconstruction, moist-layer
// detection, and diagnostic strip alignment for Windgram charts.

import { lapseRateCPer1000Ft, relativeHumidityPercent, windToComponents } from "@azohra/meteo.briefing/derive";
import type { FieldNode, HourSampling, MetricStrip } from "@azohra/meteo.briefing/meteogram";
import { publishedEffectiveCloudLimit, publishedLift, type PublishedForecastHour as ProfileHour } from "@windgrams/contracts/published-lift";
import { finiteScalar } from "./windgram-format.ts";
import { timeGaps } from "./windgram-time-axis.ts";

export type Point = { x: number; y: number };

const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const round = (n: number) => Math.round(n * 100) / 100;

/** Linear interpolation in physical height. Never bridge an explicitly missing level. */
export function sampleHeight(nodes: readonly FieldNode[], heightM: number): number | null {
  if (!nodes.length || heightM < nodes[0].altitudeM || heightM > nodes[nodes.length - 1].altitudeM) return null;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (Math.abs(a.altitudeM - heightM) < 0.00001) {
      if (Number.isFinite(a.value)) return a.value;
      const next = nodes[i + 1];
      if (next && Math.abs(next.altitudeM - heightM) < 0.00001 && Number.isFinite(next.value)) return next.value;
      return null;
    }
    const b = nodes[i + 1];
    if (b && heightM > a.altitudeM && heightM < b.altitudeM) {
      if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;
      return a.value + (b.value - a.value) * (heightM - a.altitudeM) / (b.altitudeM - a.altitudeM);
    }
  }
  return null;
}

export function hourSampling(hour: ProfileHour, floorM: number, omegaPressureLevels?: readonly number[]): HourSampling {
  const levels = hour.levels
    .filter((l) => finite(finiteScalar(l.heightM)) && finiteScalar(l.heightM)! > floorM)
    .sort((a, b) => finiteScalar(a.heightM)! - finiteScalar(b.heightM)!);
  const nodes = (key: "temperatureC" | "dewPointC") => [
    { altitudeM: floorM + 2, value: finiteScalar(hour.surface[key]) ?? NaN },
    ...levels.map((l) => ({ altitudeM: finiteScalar(l.heightM)!, value: finiteScalar(l[key]) ?? NaN })),
  ].sort((a, b) => a.altitudeM - b.altitudeM);
  const temperatureC = nodes("temperatureC"), dewPointC = nodes("dewPointC");
  const wind = (speed: unknown, direction: unknown) => {
    const s = finiteScalar(speed), d = finiteScalar(direction);
    if (s === 0) return { uMps: 0, vMps: 0 };
    return s === null || s < 0 || d === null ? { uMps: NaN, vMps: NaN } : windToComponents(s, d);
  };
  const surface = hour.surface;
  const winds = [
    { altitudeM: floorM + 10, ...wind(surface.windSpeedMps, surface.windDirectionDeg) },
    // Incomplete 80 m measurements mark a gap; absent fields add no node.
    ...(surface.wind80mSpeedMps != null || surface.wind80mDirectionDeg != null
      ? [{ altitudeM: floorM + 80, ...wind(surface.wind80mSpeedMps, surface.wind80mDirectionDeg) }] : []),
    ...levels.map((l) => ({ altitudeM: finiteScalar(l.heightM)!, ...wind(l.windSpeedMps, l.windDirectionDeg) })),
  ].sort((a, b) => a.altitudeM - b.altitudeM);
  // Duplicate source heights leave the surrounding interpolation unavailable.
  for (let i = 0; i < winds.length; i++) {
    if ((i > 0 && winds[i - 1].altitudeM === winds[i].altitudeM) || winds[i + 1]?.altitudeM === winds[i].altitudeM) {
      winds[i].uMps = NaN;
      winds[i].vMps = NaN;
    }
  }
  // Represent temperature gradients as interval quantities, constant within each source interval.
  // Use a tiny step epsilon before interior upper endpoints so interval transitions stay sharp.
  const lastIdx = temperatureC.length - 2;
  const lapseCPer1000Ft = temperatureC.slice(0, -1).flatMap((a, i) => {
    const b = temperatureC[i + 1];
    if (!b) return [];
    const value =
      Number.isFinite(a.value) && Number.isFinite(b.value)
        ? lapseRateCPer1000Ft({ heightM: a.altitudeM, temperatureC: a.value }, { heightM: b.altitudeM, temperatureC: b.value }) ?? NaN
        : NaN;
    const upperAlt = i < lastIdx && b.altitudeM - a.altitudeM > 0.02 ? b.altitudeM - 0.01 : b.altitudeM;
    return [{ altitudeM: a.altitudeM, value }, { altitudeM: upperAlt, value }];
  });
  const usable = finiteScalar(publishedLift(hour).usableLiftTopM);
  const effectiveLimit = finiteScalar(publishedEffectiveCloudLimit(hour));
  return {
    validAt: hour.validAt,
    temperatureC,
    dewPointC,
    lapseCPer1000Ft,
    relativeHumidityPercent: temperatureC.map((p, i) => ({
      altitudeM: p.altitudeM,
      value: Number.isFinite(p.value) && Number.isFinite(dewPointC[i].value) ? relativeHumidityPercent(p.value, dewPointC[i].value) : NaN,
    })),
    windU: winds.map(p => ({ altitudeM: p.altitudeM, value: p.uMps })),
    windV: winds.map(p => ({ altitudeM: p.altitudeM, value: p.vMps })),
    verticalVelocityPaS: levels.map((l) => ({
      altitudeM: finiteScalar(l.heightM)!,
      value: !omegaPressureLevels || omegaPressureLevels.includes(finiteScalar(l.pressureHpa)!)
        ? finiteScalar(l.verticalVelocityPaS) ?? NaN : NaN,
    })),
    thermalIndexC: [],
    smoke:
      hour.smoke && finite(finiteScalar(hour.smoke.surfaceUgm3))
        ? { surfaceUgm3: finiteScalar(hour.smoke.surfaceUgm3)!, aot: finiteScalar(hour.smoke.aot) }
        : null,
    observation: null,
    aotObservation: null,
    cloudCapped: usable === null || effectiveLimit === null ? null : usable >= effectiveLimit - 1,
    capeCapped:
      finiteScalar(hour.surface.capeJkg) === null || finiteScalar(hour.surface.cinJkg) === null
        ? null
        : finiteScalar(hour.surface.cinJkg)! <= -50,
  };
}

/** Reconstruct the colour field from interval centres. Source lapse rates stay
 * layer averages; this interpolation is only for drawing. Keep the edge of
 * each valid run, and pin zero crossings to the source inversion boundaries.
 */
export function stabilityDisplayNodes(intervals: readonly FieldNode[]): FieldNode[] {
  const nodes: FieldNode[] = [];
  for (let i = 0; i + 1 < intervals.length; i += 2) {
    const { altitudeM: base, value } = intervals[i];
    const upper = intervals[i + 2]?.altitudeM ?? intervals[i + 1].altitudeM;
    if (!Number.isFinite(value)) {
      nodes.push({ altitudeM: base, value: NaN }, { altitudeM: upper, value: NaN });
      continue;
    }
    const previous = intervals[i - 2]?.value, next = intervals[i + 2]?.value;
    if (!Number.isFinite(previous)) nodes.push({ altitudeM: base, value });
    else if (previous * value <= 0 && previous !== value) nodes.push({ altitudeM: base, value: 0 });
    nodes.push({ altitudeM: (base + upper) / 2, value });
    if (!Number.isFinite(next)) nodes.push({ altitudeM: upper, value });
  }
  return nodes;
}

/** All crossing branches, including an inversion's second crossing. */
export function crossings(nodes: readonly FieldNode[], target: number): number[] {
  const heights: number[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || a.value === b.value) continue;
    if (target < Math.min(a.value, b.value) || target > Math.max(a.value, b.value)) continue;
    const z = a.altitudeM + (b.altitudeM - a.altitudeM) * (target - a.value) / (b.value - a.value);
    if (!heights.some((h) => Math.abs(h - z) < 0.01)) heights.push(z);
  }
  return heights;
}

/** Contiguous portions of a profile above a cloud-evidence threshold. */
export function moistLayers(nodes: readonly FieldNode[], threshold: number) {
  const layers: { baseM: number; topM: number; coverPercent: number }[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || Math.max(a.value, b.value) < threshold) continue;
    let baseM = a.altitudeM, topM = b.altitudeM;
    if (a.value < threshold) baseM += (topM - baseM) * (threshold - a.value) / (b.value - a.value);
    if (b.value < threshold) topM = a.altitudeM + (b.altitudeM - a.altitudeM) * (threshold - a.value) / (b.value - a.value);
    if (topM - baseM < 1) continue;
    const last = layers[layers.length - 1];
    if (last && Math.abs(last.topM - baseM) < 1) {
      last.topM = topM;
      last.coverPercent = Math.max(last.coverPercent, a.value, b.value);
    } else {
      layers.push({ baseM, topM, coverPercent: Math.max(a.value, b.value) });
    }
  }
  return layers;
}

export function linearPath(points: readonly (Point | null)[]): string {
  let open = false;
  return points
    .map((p) => {
      if (!p) {
        open = false;
        return "";
      }
      const cmd = open ? "L" : "M";
      open = true;
      return `${cmd}${round(p.x)},${round(p.y)}`;
    })
    .join("");
}

/** Keep optional diagnostics aligned when the upstream scene drops a missing hour. */
export function alignedDiagnostics(
  strips: readonly MetricStrip[],
  sourceTimes: readonly string[],
  hours: readonly ProfileHour[],
  left: number,
  pitch: number,
): MetricStrip[] {
  const gaps = timeGaps(hours);
  if (!gaps.size && sourceTimes.length === hours.length && sourceTimes.every((t, i) => t === hours[i].validAt)) return [...strips];
  const indices = hours.map((h) => sourceTimes.indexOf(h.validAt));
  const sourceValue = (h: ProfileHour, key: MetricStrip["key"]): unknown => {
    switch (key) {
      case "pressure": return h.surface.seaLevelPressureHpa;
      case "precipitation": return h.surface.precipitationMmHr;
      case "cloudCover": return h.surface.cloudCoverPercent;
      case "cape": return h.surface.capeJkg;
      case "smoke": return h.smoke?.surfaceUgm3;
      case "thermalStrength": return publishedLift(h).thermalVelocityMps;
      default: return null;
    }
  };
  return strips.map((strip) => {
    const values = indices.map((index) => (index < 0 ? null : strip.values[index] ?? null));
    const y = (value: number) =>
      strip.top + strip.height * (1 - clamp((value - strip.minimum) / Math.max(0.001, strip.maximum - strip.minimum), 0, 1));
    const points = values.flatMap((value, i): (Point | null)[] => {
      const p = value === null ? null : { x: left + pitch * (i + 0.5), y: y(value) };
      return gaps.has(i) ? [null, p] : [p];
    });
    const runs: Point[][] = [];
    let run: Point[] = [];
    for (const p of points) {
      if (!p) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(p);
      }
    }
    if (run.length) runs.push(run);
    const areaPath = runs
      .filter((r) => r.length > 1)
      .map((r) => linearPath([{ x: r[0].x, y: strip.top + strip.height }, ...r, { x: r[r.length - 1].x, y: strip.top + strip.height }]) + "Z")
      .join("");
    const bands: { upper: Point[]; lower: Point[] }[] = [];
    let band: (typeof bands)[number] | null = null;
    hours.forEach((hour, i) => {
      if (gaps.has(i)) band = null;
      const value = sourceValue(hour, strip.key);
      if (!value || typeof value !== "object" || !("p25" in value) || !("p75" in value) || values[i] === null) {
        band = null;
        return;
      }
      const lo = finiteScalar(value.p25), hi = finiteScalar(value.p75), divisor = strip.key === "pressure" ? 10 : 1;
      if (lo === null || hi === null) {
        band = null;
        return;
      }
      if (!band) {
        band = { upper: [], lower: [] };
        bands.push(band);
      }
      band.upper.push({ x: left + pitch * (i + 0.5), y: y(hi / divisor) });
      band.lower.push({ x: left + pitch * (i + 0.5), y: y(lo / divisor) });
    });
    const cells =
      strip.cells &&
      indices.map((index, i) => {
        const cell = index < 0 ? null : strip.cells![index];
        return cell ? { ...cell, x: left + pitch * i, width: pitch } : null;
      });
    const rows = strip.rows?.map((row) => ({
      ...row,
      cells: indices.map((index, i) => {
        const cell = index < 0 ? null : row.cells[index];
        return cell ? { ...cell, x: left + pitch * i, width: pitch } : null;
      }),
    }));
    return {
      ...strip,
      values,
      linePath: linearPath(points),
      areaPath,
      bandPath:
        bands
          .filter((b) => b.upper.length > 1)
          .map((b) => linearPath([...b.upper, ...b.lower.reverse()]) + "Z")
          .join("") || null,
      cells,
      rows,
      dots: runs.filter((r) => r.length === 1).map((r) => r[0]),
    };
  });
}
