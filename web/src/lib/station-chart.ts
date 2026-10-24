// Station history on a 5-minute axis: mean wind, peak gust, temperature,
// dew point and solar radiation. Displays follow the selected unit system.

import { HourlyChart, niceMax, type ChartSpec } from "./hourly-chart.ts";
import { compassPoint, inArc } from "./launches.ts";
import { windExtras, type ChartLaunch } from "./nws-chart.ts";
import type { StationInterval } from "./station.ts";
import { convertQuantity, defaultQuantityDigits, fmt, formatQuantity, getUnitSystem, unitLabel } from "./units.ts";

const windValue = (value: number | null) => convertQuantity(value, "wind");
const temperatureValue = (value: number | null) => convertQuantity(value, "temperature");
const launchWind = (valueMph: number | null) => valueMph === null ? null : convertQuantity(valueMph / 2.2369362920544025, "wind");

const pressureValue = (hpa: number | null) => convertQuantity(hpa, "pressure");
const dir = (deg: number | null) => (deg == null ? "" : `${compassPoint(deg)} `);

/** Round display-unit ticks with at least two intervals around the data. */
export function temperatureAxis(values: (number | null)[]) {
  const known = values.filter((v): v is number => v != null);
  const step = getUnitSystem() === "metric" ? 5 : 10;
  if (known.length === 0) return getUnitSystem() === "metric" ? { yMin: 0, yMax: 25, yStep: step } : { yMin: 30, yMax: 80, yStep: step };
  let yMin = Math.floor(Math.min(...known) / step) * step;
  let yMax = Math.ceil(Math.max(...known) / step) * step;
  if (yMax - yMin < step * 2) yMax = yMin + step * 2;
  if (yMax === Math.max(...known)) yMax += step;
  return { yMin, yMax, yStep: step };
}

export function stationSpec(launch: ChartLaunch, stationName: string): ChartSpec<StationInterval> {
  return {
    emptyText: `${stationName} · Reports unavailable.`,
    minutesPerPoint: 5,
    label: `${stationName} · Past 12 hours · 5-minute reports. Left/right keys select a report.`,
    panels(points) {
      const wind = points.map((p) => windValue(p.windSpeedMps));
      const gust = points.map((p) => windValue(p.windGustMps));
      const windTop = niceMax(Math.max((launchWind(launch.gustMaxMph) ?? 0) + 5, ...[...wind, ...gust].map((v) => v ?? 0)), 5);
      const temperature = points.map((p) => temperatureValue(p.temperatureC));
      const dewPoint = points.map((p) => temperatureValue(p.dewPointC));
      const sun = points.map((p) => p.solarRadiationWm2);
      const extras = windExtras(launch, points.map((p) => p.windDirectionDeg));
      return [
        {
          title: "Wind at the station",
          unit: unitLabel("wind"),
          height: 170,
          yMax: windTop,
          yStep: windTop > 40 ? 10 : 5,
          series: [
            { key: "wind", label: "Wind", color: "var(--series-1)", values: wind },
            { key: "gust", label: "Gust", color: "var(--series-2)", values: gust },
          ],
          band: extras.band,
          limit: extras.limit,
          arrows: extras.arrows,
          legend: [
            { label: "Wind (5-min mean)", kind: "line", color: "var(--series-1)" },
            { label: "Gust (5-min peak)", kind: "line", color: "var(--series-2)" },
            ...extras.legendTail,
          ],
        },
        {
          title: "Temperature",
          unit: unitLabel("temperature"),
          height: 110,
          ...temperatureAxis([...temperature, ...dewPoint]),
          series: [
            { key: "temperature", label: "Temp", color: "var(--series-1)", values: temperature },
            { key: "dew", label: "Dew pt", color: "var(--series-2)", values: dewPoint },
          ],
          legend: [
            { label: "Temperature", kind: "line", color: "var(--series-1)" },
            { label: "Dew point", kind: "line", color: "var(--series-2)" },
          ],
        },
        {
          title: "Sunshine",
          unit: "W/m²",
          height: 100,
          yMax: niceMax(Math.max(400, ...sun.map((v) => v ?? 0)), 200),
          yStep: 200,
          series: [{ key: "sun", label: "Sunshine", color: "var(--series-1)", values: sun, area: true }],
        },
      ];
    },
    tooltip(p) {
      const inWindow = p.windDirectionDeg != null && inArc(p.windDirectionDeg, launch.window);
      return [
        { label: "Wind", value: `${dir(p.windDirectionDeg)}${fmt(windValue(p.windSpeedMps))} ${unitLabel("wind")}`, color: "var(--series-1)", extra: inWindow ? "✓" : undefined },
        { label: "Gust", value: `${fmt(windValue(p.windGustMps))} ${unitLabel("wind")}`, color: "var(--series-2)" },
        { label: "Temperature", value: `${fmt(temperatureValue(p.temperatureC))} ${unitLabel("temperature")}` },
        { label: "Dew point", value: `${fmt(temperatureValue(p.dewPointC))} ${unitLabel("temperature")}` },
        { label: "Humidity", value: `${fmt(p.humidityPct)}%` },
        { label: "Pressure", value: `${formatQuantity(p.pressureHpa, "pressure")}` },
        { label: "Sunshine", value: `${fmt(p.solarRadiationWm2)} W/m²` },
      ];
    },
    note: (p) => (p.windSpeedMps == null && p.temperatureC == null ? "Unavailable" : null),
    table: {
      columns: [`Wind (${unitLabel("wind")})`, "Gust", "Temp", "Dew pt", "Humidity", `Pressure (${unitLabel("pressure")})`, "Sun (W/m²)"],
      cells(p) {
        const inWindow = p.windDirectionDeg != null && inArc(p.windDirectionDeg, launch.window);
        return [
          `${dir(p.windDirectionDeg)}${fmt(windValue(p.windSpeedMps))}${inWindow ? " ✓" : ""}`,
          fmt(windValue(p.windGustMps)),
          `${fmt(temperatureValue(p.temperatureC))} ${unitLabel("temperature")}`,
          `${fmt(temperatureValue(p.dewPointC))} ${unitLabel("temperature")}`,
          `${fmt(p.humidityPct)}%`,
          fmt(pressureValue(p.pressureHpa), defaultQuantityDigits("pressure")),
          fmt(p.solarRadiationWm2),
        ];
      },
      footnote: `5-minute mean wind · Peak gust.${launch.window ? ` ✓ Launch window (${launch.windowLabel}).` : ""}`,
    },
  };
}

export class StationChart extends HourlyChart<StationInterval> {
  constructor(root: HTMLElement, launch: ChartLaunch, stationName: string, timeZone: string) {
    super(root, stationSpec(launch, stationName), timeZone);
  }
}
