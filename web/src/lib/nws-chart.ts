// Hourly NWS: surface/transport wind, mixing height AGL and weather probabilities.
// Source values stay SI; axes, tables and launch limits use the selected units.

import { HourlyChart, niceMax, type ChartSpec } from "./hourly-chart.ts";
import { compassPoint, inArc, type DirectionArc } from "./launches.ts";
import { convertQuantity, fmt, formatQuantity, getUnitSystem, unitLabel } from "./units.ts";

const windValue = (value: number | null) => convertQuantity(value, "wind");
const heightValue = (value: number | null) => convertQuantity(value, "elevation");
const temperatureValue = (value: number | null) => convertQuantity(value, "temperature");
const launchWind = (valueMph: number | null) => valueMph === null ? null : convertQuantity(valueMph / 2.2369362920544025, "wind");

export interface NwsHour {
  validAt: string;
  temperatureC: number | null;
  skyCoverPct: number | null;
  windDirectionDeg: number | null;
  windSpeedMps: number | null;
  windGustMps: number | null;
  precipitationProbabilityPct: number | null;
  thunderProbabilityPct: number | null;
  mixingHeightM: number | null;
  transportWindDirectionDeg: number | null;
  transportWindSpeedMps: number | null;
  shortForecast: string | null;
}

export interface ChartLaunch {
  windMinMph: number | null;
  windMaxMph: number | null;
  gustMaxMph: number | null;
  window: DirectionArc | null;
  windowLabel: string;
}

const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);

/** The launch's wind panel pieces shared by every hourly chart. */
export function windExtras(launch: ChartLaunch, directions: (number | null)[]) {
  return {
    band: launch.windMinMph !== null && launch.windMaxMph !== null ? { from: launchWind(launch.windMinMph)!, to: launchWind(launch.windMaxMph)! } : undefined,
    limit: launchWind(launch.gustMaxMph) ?? undefined,
    arrows: directions.map((deg) => ({ deg, inWindow: deg != null && inArc(deg, launch.window) })),
    legendTail: [
      ...(launch.windMinMph !== null && launch.windMaxMph !== null ? [{ label: `Launch range ${fmt(launchWind(launch.windMinMph))}–${fmt(launchWind(launch.windMaxMph))} ${unitLabel("wind")}`, kind: "band" as const, color: "var(--good)" }] : []),
      ...(launch.gustMaxMph !== null ? [{ label: `Gust limit ${fmt(launchWind(launch.gustMaxMph))} ${unitLabel("wind")}`, kind: "limit" as const, color: "var(--critical)" }] : []),
      ...(launch.window ? [{ label: `Wind from ${launch.windowLabel}`, kind: "arrow-in" as const, color: "var(--good)" },
      { label: "Wind from other directions", kind: "arrow-out" as const, color: "var(--muted)" }] : [{ label: "Wind direction", kind: "arrow-out" as const, color: "var(--muted)" }]),
    ],
  };
}

/** Height-axis bounds in the selected display units, with an exact top tick. */
export function feetAxis(values: (number | null)[]) {
  const metric = getUnitSystem() === "metric";
  const peak = Math.max(metric ? 500 : 2000, ...values.map((v) => v ?? 0));
  const step = peak > (metric ? 2500 : 8000) ? (metric ? 1000 : 4000) : (metric ? 500 : 2000);
  return { yMax: niceMax(peak, step), yStep: step };
}

export function nwsSpec(launch: ChartLaunch): ChartSpec<NwsHour> {
  return {
    emptyText: "NWS forecast unavailable.",
    panels(hours) {
      const wind = hours.map((h) => windValue(h.windSpeedMps));
      const gust = hours.map((h) => windValue(h.windGustMps));
      const transport = hours.map((h) => windValue(h.transportWindSpeedMps));
      const windTop = niceMax(Math.max((launchWind(launch.gustMaxMph) ?? 0) + 5, ...[...wind, ...gust, ...transport].map((v) => v ?? 0)), 5);
      const mixing = hours.map((h) => heightValue(h.mixingHeightM));
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
            { key: "transport", label: "Transport", color: "var(--series-3)", values: transport },
          ],
          band: extras.band,
          limit: extras.limit,
          arrows: extras.arrows,
          legend: [
            { label: `Wind (${formatQuantity(10, "elevation")} AGL)`, kind: "line", color: "var(--series-1)" },
            { label: "Gust", kind: "line", color: "var(--series-2)" },
            { label: "Transport wind (mixed layer)", kind: "line", color: "var(--series-3)" },
            ...extras.legendTail,
          ],
        },
        {
          title: "Mixing height",
          unit: `${unitLabel("elevation")} AGL`,
          height: 130,
          ...feetAxis(mixing),
          series: [{ key: "mixing", label: "Mixing height", color: "var(--series-1)", values: mixing, area: true }],
        },
        {
          title: "Clouds & storms",
          unit: "%",
          height: 130,
          yMax: 100,
          yStep: 50,
          series: [
            { key: "sky", label: "Sky cover", color: "var(--series-1)", values: hours.map((h) => h.skyCoverPct) },
            { key: "precip", label: "Precipitation", color: "var(--series-2)", values: hours.map((h) => h.precipitationProbabilityPct) },
            { key: "thunder", label: "Thunder", color: "var(--series-3)", values: hours.map((h) => h.thunderProbabilityPct) },
          ],
          legend: [
            { label: "Sky cover", kind: "line", color: "var(--series-1)" },
            { label: "Chance of precipitation", kind: "line", color: "var(--series-2)" },
            { label: "Chance of thunder", kind: "line", color: "var(--series-3)" },
          ],
        },
      ];
    },
    tooltip(h) {
      const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
      return [
        { label: "Wind", value: `${dir(h.windDirectionDeg)}${fmt(windValue(h.windSpeedMps))} ${unitLabel("wind")}`, color: "var(--series-1)", extra: inWindow ? "✓" : undefined },
        { label: "Gust", value: `${fmt(windValue(h.windGustMps))} ${unitLabel("wind")}`, color: "var(--series-2)" },
        { label: "Transport", value: `${dir(h.transportWindDirectionDeg)}${fmt(windValue(h.transportWindSpeedMps))} ${unitLabel("wind")}`, color: "var(--series-3)" },
        { label: "Mixing height", value: `${fmt(heightValue(h.mixingHeightM), 0)} ${unitLabel("elevation")}` },
        { label: "Sky cover", value: `${fmt(h.skyCoverPct)}%` },
        { label: "Precip / thunder", value: `${fmt(h.precipitationProbabilityPct)}% / ${fmt(h.thunderProbabilityPct)}%` },
        { label: "Temperature", value: `${fmt(temperatureValue(h.temperatureC))} ${unitLabel("temperature")}` },
      ];
    },
    note: (h) => h.shortForecast,
    table: {
      columns: [`Wind (${unitLabel("wind")})`, "Gust", `Transport (${unitLabel("wind")})`, `Mixing ht (${unitLabel("elevation")})`, "Sky", "Precip", "Thunder", "Temp", "Forecast"],
      cells(h) {
        const inWindow = h.windDirectionDeg != null && inArc(h.windDirectionDeg, launch.window);
        return [
          `${dir(h.windDirectionDeg)}${fmt(windValue(h.windSpeedMps))}${inWindow ? " ✓" : ""}`,
          fmt(windValue(h.windGustMps)),
          `${dir(h.transportWindDirectionDeg)}${fmt(windValue(h.transportWindSpeedMps))}`,
          fmt(heightValue(h.mixingHeightM)),
          `${fmt(h.skyCoverPct)}%`,
          `${fmt(h.precipitationProbabilityPct)}%`,
          `${fmt(h.thunderProbabilityPct)}%`,
          `${fmt(temperatureValue(h.temperatureC))} ${unitLabel("temperature")}`,
          h.shortForecast ?? "",
        ];
      },
      textColumns: [8],
      footnote: launch.window ? `✓ Launch window (${launch.windowLabel}).` : undefined,
    },
  };
}

/** The NWS panel, as used on the launch page. */
export class NwsChart extends HourlyChart<NwsHour> {
  constructor(root: HTMLElement, launch: ChartLaunch, timeZone: string) {
    super(root, nwsSpec(launch), timeZone);
  }
}
