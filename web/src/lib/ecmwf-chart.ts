// Hourly ECMWF IFS: surface/aloft wind, mixing depth AGL and cloud fractions.
// Source values stay SI; axes, tables and launch limits use the selected units.

import { HourlyChart, niceMax, type ChartSpec } from "./hourly-chart.ts";
import { compassPoint, inArc } from "./launches.ts";
import { feetAxis, windExtras, type ChartLaunch } from "./nws-chart.ts";
import { convertQuantity, defaultQuantityDigits, fmt, formatQuantity, getUnitSystem, unitLabel } from "./units.ts";

const windValue = (value: number | null) => convertQuantity(value, "wind");
const heightValue = (value: number | null) => convertQuantity(value, "elevation");
const temperatureValue = (value: number | null) => convertQuantity(value, "temperature");
const launchWind = (valueMph: number) => convertQuantity(valueMph / 2.2369362920544025, "wind")!;

export interface EcmwfHour {
  validAt: string;
  temperatureC: number | null;
  dewPointC: number | null;
  windSpeedMps: number | null;
  windDirectionDeg: number | null;
  windGustMps: number | null;
  cloudCoverPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  precipitationMm: number | null;
  capeJkg: number | null;
  boundaryLayerHeightM: number | null;
  shortwaveWm2: number | null;
  wind850SpeedMps: number | null;
  wind850DirectionDeg: number | null;
  height850M: number | null;
  wind700SpeedMps: number | null;
  wind700DirectionDeg: number | null;
  height700M: number | null;
}

export interface EcmwfSiteDocument {
  schemaVersion: 1;
  source: string;
  generatedAt: string;
  models: { surface: { id: string; label: string; run: string | null }; aloft: { id: string; label: string; run: string | null } };
  site: { slug: string; gridLatitude: number | null; gridLongitude: number | null; gridElevationM: number | null };
  hours: EcmwfHour[];
}

const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);
const rainValue = (mm: number | null) => convertQuantity(mm, "rainAmount");
const pressureLabel = (hpa: number) => formatQuantity(hpa, "pressure");

/** Mean pressure-level height rounded to 100 ft or 50 m for display. */
function levelHeight(values: (number | null)[]) {
  const known = values.filter((v): v is number => v != null);
  const height = known.length ? heightValue(known.reduce((a, b) => a + b, 0) / known.length) : null;
  const step = getUnitSystem() === "metric" ? 50 : 100;
  return height == null ? null : Math.round(height / step) * step;
}

export function ecmwfSpec(launch: ChartLaunch): ChartSpec<EcmwfHour> {
  let label850 = `Wind at ${pressureLabel(850)}`;
  let label700 = `Wind at ${pressureLabel(700)}`;
  return {
    emptyText: "ECMWF forecast unavailable.",
    panels(hours) {
      const h850 = levelHeight(hours.map((h) => h.height850M));
      const h700 = levelHeight(hours.map((h) => h.height700M));
      label850 = h850 ? `Wind at ${pressureLabel(850)} (~${fmt(h850)} ${unitLabel("elevation")})` : `Wind at ${pressureLabel(850)}`;
      label700 = h700 ? `Wind at ${pressureLabel(700)} (~${fmt(h700)} ${unitLabel("elevation")})` : `Wind at ${pressureLabel(700)}`;
      const wind = hours.map((h) => windValue(h.windSpeedMps));
      const gust = hours.map((h) => windValue(h.windGustMps));
      const aloft = hours.map((h) => windValue(h.wind850SpeedMps));
      const windTop = niceMax(Math.max(launchWind(launch.gustMaxMph) + 5, ...[...wind, ...gust, ...aloft].map((v) => v ?? 0)), 5);
      const bl = hours.map((h) => heightValue(h.boundaryLayerHeightM));
      const extras = windExtras(launch, hours.map((h) => h.windDirectionDeg));
      return [
        {
          title: "Wind",
          unit: unitLabel("wind"),
          height: 190,
          yMax: windTop,
          yStep: windTop > 40 ? 10 : 5,
          series: [
            { key: "wind", label: "Wind", color: "var(--series-1)", values: wind },
            { key: "gust", label: "Gust", color: "var(--series-2)", values: gust },
            { key: "aloft", label: pressureLabel(850), color: "var(--series-3)", values: aloft },
          ],
          band: extras.band,
          limit: extras.limit,
          arrows: extras.arrows,
          legend: [
            { label: `Wind (${formatQuantity(10, "elevation")} AGL)`, kind: "line", color: "var(--series-1)" },
            { label: "Gust", kind: "line", color: "var(--series-2)" },
            { label: label850, kind: "line", color: "var(--series-3)" },
            ...extras.legendTail,
          ],
        },
        {
          title: "Boundary-layer height",
          unit: `${unitLabel("elevation")} AGL`,
          height: 130,
          ...feetAxis(bl),
          series: [{ key: "bl", label: "Boundary layer", color: "var(--series-1)", values: bl, area: true }],
        },
        {
          title: "Clouds",
          unit: "%",
          height: 130,
          yMax: 100,
          yStep: 50,
          series: [
            { key: "low", label: "Low", color: "var(--series-1)", values: hours.map((h) => h.cloudLowPct) },
            { key: "mid", label: "Mid", color: "var(--series-2)", values: hours.map((h) => h.cloudMidPct) },
            { key: "high", label: "High", color: "var(--series-3)", values: hours.map((h) => h.cloudHighPct) },
          ],
          legend: [
            { label: "Low cloud", kind: "line", color: "var(--series-1)" },
            { label: "Mid cloud", kind: "line", color: "var(--series-2)" },
            { label: "High cloud", kind: "line", color: "var(--series-3)" },
          ],
        },
      ];
    },
    tooltip(h) {
      const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
      return [
        { label: "Wind", value: `${dir(h.windDirectionDeg)}${fmt(windValue(h.windSpeedMps))} ${unitLabel("wind")}`, color: "var(--series-1)", extra: inWindow ? "✓" : undefined },
        { label: "Gust", value: `${fmt(windValue(h.windGustMps))} ${unitLabel("wind")}`, color: "var(--series-2)" },
        { label: label850.replace("Wind at ", ""), value: `${dir(h.wind850DirectionDeg)}${fmt(windValue(h.wind850SpeedMps))} ${unitLabel("wind")}`, color: "var(--series-3)" },
        { label: label700.replace("Wind at ", ""), value: `${dir(h.wind700DirectionDeg)}${fmt(windValue(h.wind700SpeedMps))} ${unitLabel("wind")}` },
        { label: "Boundary layer", value: `${fmt(heightValue(h.boundaryLayerHeightM))} ${unitLabel("elevation")}` },
        { label: "Cloud low / mid / high", value: `${fmt(h.cloudLowPct)} / ${fmt(h.cloudMidPct)} / ${fmt(h.cloudHighPct)}%` },
        { label: "Precipitation", value: `${formatQuantity(h.precipitationMm, "rainAmount")}` },
        { label: "CAPE", value: `${fmt(h.capeJkg)} J/kg` },
        { label: "Temp / dew point", value: `${fmt(temperatureValue(h.temperatureC))} / ${fmt(temperatureValue(h.dewPointC))} ${unitLabel("temperature")}` },
      ];
    },
    table: {
      columns: [`Wind (${unitLabel("wind")})`, "Gust", `${pressureLabel(850)} (${unitLabel("wind")})`, `${pressureLabel(700)} (${unitLabel("wind")})`, `BL height (${unitLabel("elevation")})`, "Low", "Mid", "High", `Precip (${unitLabel("rainAmount")})`, "CAPE", "Temp"],
      cells(h) {
        const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
        return [
          `${dir(h.windDirectionDeg)}${fmt(windValue(h.windSpeedMps))}${inWindow ? " ✓" : ""}`,
          fmt(windValue(h.windGustMps)),
          `${dir(h.wind850DirectionDeg)}${fmt(windValue(h.wind850SpeedMps))}`,
          `${dir(h.wind700DirectionDeg)}${fmt(windValue(h.wind700SpeedMps))}`,
          fmt(heightValue(h.boundaryLayerHeightM)),
          `${fmt(h.cloudLowPct)}%`,
          `${fmt(h.cloudMidPct)}%`,
          `${fmt(h.cloudHighPct)}%`,
          fmt(rainValue(h.precipitationMm), defaultQuantityDigits("rainAmount")),
          fmt(h.capeJkg),
          `${fmt(temperatureValue(h.temperatureC))} ${unitLabel("temperature")}`,
        ];
      },
      footnote: `✓ Launch window (${launch.windowLabel}). Precipitation: prior hour.`,
    },
  };
}

export class EcmwfChart extends HourlyChart<EcmwfHour> {
  constructor(root: HTMLElement, launch: ChartLaunch, timeZone: string) {
    super(root, ecmwfSpec(launch), timeZone);
  }
}
