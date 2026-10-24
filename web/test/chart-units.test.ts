import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { setUnitSystem } from "../src/lib/units.ts";
import { nwsSpec, windExtras, type ChartLaunch, type NwsHour } from "../src/lib/nws-chart.ts";
import { ecmwfSpec, type EcmwfHour } from "../src/lib/ecmwf-chart.ts";
import { stationSpec } from "../src/lib/station-chart.ts";
import type { StationInterval } from "../src/lib/station.ts";

afterEach(() => setUnitSystem("imperial"));
const launch: ChartLaunch = { windMinMph: 5, windMaxMph: 15, gustMaxMph: 20, window: { fromDeg: 270, toDeg: 0 }, windowLabel: "W–N" };
const nws: NwsHour = { validAt: "2026-10-23T18:00:00Z", temperatureC: 20, skyCoverPct: 25, windDirectionDeg: 300, windSpeedMps: 10,
  windGustMps: 15, precipitationProbabilityPct: 5, thunderProbabilityPct: 0, mixingHeightM: 1000, transportWindDirectionDeg: 300, transportWindSpeedMps: 12, shortForecast: "Clear" };
const ecmwf: EcmwfHour = { ...nws, dewPointC: 10, cloudCoverPct: 25, cloudLowPct: 10, cloudMidPct: 20, cloudHighPct: 30,
  precipitationMm: 25.4, capeJkg: 500, boundaryLayerHeightM: 1000, shortwaveWm2: 500, wind850SpeedMps: 20, wind850DirectionDeg: 300,
  height850M: 1500, wind700SpeedMps: 25, wind700DirectionDeg: 270, height700M: 3000 };
const station = { ...nws, dewPointC: 10, humidityPct: 50, pressureHpa: 1013.25, solarRadiationWm2: 500 } as StationInterval;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);

test("NWS and ECMWF chart data, wind limits, legends and tables share the selected system", () => {
  const imperialNws = nwsSpec(launch);
  const imperial = imperialNws.panels([nws]);
  assert.equal(imperial[0].unit, "mph");
  close(imperial[0].series[0].values[0]!, 22.369362920544025);
  assert.equal(imperial[0].limit, 20);
  assert.equal(imperial[0].arrows![0].inWindow, true, "300° is within the launch sector");
  assert.match(imperialNws.tooltip(nws).find((row) => row.label === "Temperature")!.value, /68 °F/);
  const imperialEcmwf = ecmwfSpec(launch);
  imperialEcmwf.panels([ecmwf]);
  assert.match(imperialEcmwf.tooltip(ecmwf).find((row) => row.label === "Precipitation")!.value, /1.00 in/);
  assert.ok(imperialEcmwf.table!.columns.some((label) => label.includes("25.10 inHg")));
  setUnitSystem("metric");
  const metricNws = nwsSpec(launch);
  const metric = metricNws.panels([nws]);
  assert.equal(metric[0].unit, "km/h");
  assert.equal(metric[1].unit, "m AGL");
  assert.equal(metric[0].series[0].values[0], 36);
  assert.equal(metric[1].series[0].values[0], 1000);
  close(metric[0].limit!, 20 * 1.609344);
  close(windExtras(launch, [300]).band.from, 5 * 1.609344);
  assert.equal(metric[0].arrows![0].inWindow, true, "unit selection preserves the direction window");
  assert.equal(metricNws.tooltip(nws).find((row) => row.label === "Wind")!.extra, "✓");
  assert.match(metricNws.tooltip(nws).find((row) => row.label === "Temperature")!.value, /20 °C/);
  assert.match(metricNws.table!.columns.join(" "), /Wind \(km\/h\).*Mixing ht \(m\)/);
  const metricEcmwf = ecmwfSpec(launch);
  const aloft = metricEcmwf.panels([ecmwf])[0];
  assert.equal(aloft.series[2].values[0], 72);
  assert.ok(aloft.legend!.some((item) => item.label === "Wind at 850 hPa (~1,500 m)"));
  assert.match(metricEcmwf.tooltip(ecmwf).find((row) => row.label === "Precipitation")!.value, /25.4 mm/);
  assert.doesNotMatch(JSON.stringify([metricNws.table, metricEcmwf.table, metricNws.tooltip(nws), metricEcmwf.tooltip(ecmwf)]), /mph|inHg|°F|\bft\b/);
});

test("station plots, hover values and pressure table convert without changing source reports", () => {
  const imperial = stationSpec(launch, "Test station");
  assert.equal(imperial.panels([station])[1].series[0].values[0], 68);
  assert.match(imperial.tooltip(station).find((row) => row.label === "Pressure")!.value, /29.92 inHg/);
  setUnitSystem("metric");
  const metric = stationSpec(launch, "Test station");
  const panels = metric.panels([station]);
  assert.equal(panels[0].series[0].values[0], 36);
  assert.equal(panels[1].series[0].values[0], 20);
  assert.equal(panels[1].unit, "°C");
  assert.equal(panels[1].yStep, 5);
  assert.match(metric.tooltip(station).find((row) => row.label === "Pressure")!.value, /1,013 hPa/);
  assert.ok(metric.table!.columns.includes("Pressure (hPa)"));
  assert.equal(station.pressureHpa, 1013.25);
  assert.equal(station.temperatureC, 20);
});

test("unknown launch limits retain weather without bands, thresholds or suitability marks", () => {
  const unknown = { windMinMph: null, windMaxMph: null, gustMaxMph: null, window: null, windowLabel: "unknown" };
  const extras = windExtras(unknown, [0, 300, null]);
  assert.equal(extras.band, undefined);
  assert.equal(extras.limit, undefined);
  assert.ok(extras.arrows.every(arrow => !arrow.inWindow));
  assert.equal(extras.legendTail.length, 1);
  for (const spec of [nwsSpec(unknown), ecmwfSpec(unknown), stationSpec(unknown, "Station")]) {
    const panel = spec.panels([ecmwf as never])[0];
    assert.ok(Number.isFinite(panel.yMax));
    assert.equal(panel.band, undefined);
    assert.equal(panel.limit, undefined);
    assert.ok(spec.tooltip(ecmwf as never).every(row => row.extra !== "✓"));
  }
});
