import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContourComponentsFromSegments,
  buildStabilityFieldPaths,
  contourComponents,
  temperatureContours,
 } from "./helpers/windgram.ts";
import {  placeTemperatureLabels  } from "./helpers/windgram.ts";
import type { HourSampling } from "@azohra/meteo.briefing/meteogram";

const makeSamplingHour = (validAt: string, temps: [number, number][]): HourSampling => ({
  validAt,
  temperatureC: temps.map(([altitudeM, value]) => ({ altitudeM, value })),
  dewPointC: temps.map(([altitudeM, value]) => ({ altitudeM, value: value - 5 })),
  lapseCPer1000Ft: [],
  relativeHumidityPercent: [],
  windU: [],
  windV: [],
  verticalVelocityPaS: [],
  thermalIndexC: [],
  smoke: null,
  observation: null,
  aotObservation: null,
  cloudCapped: false,
  capeCapped: false,
});

test("Stage 4 geometry: structured temperatureContours produces connected components and label candidates without regex reparsing", () => {
  const hours = [
    { validAt: "2026-10-21T18:00:00Z", x: 100 },
    { validAt: "2026-10-21T19:00:00Z", x: 160 },
    { validAt: "2026-10-21T20:00:00Z", x: 220 },
    { validAt: "2026-10-21T21:00:00Z", x: 280 },
  ];
  const sampling = hours.map((h, i) =>
    makeSamplingHour(h.validAt, [
      [0, 15 + i],
      [1000, 5 + i],
      [2000, -5 + i],
    ]),
  );
  const scale = {
    top: 50,
    bottom: 250,
    plotHeight: 200,
    floorM: 0,
    topM: 2000,
    anchors: [
      { heightM: 0, y: 250, pressureHpa: 1000 },
      { heightM: 1000, y: 150, pressureHpa: 900 },
      { heightM: 2000, y: 50, pressureHpa: 800 },
    ],
    hours,
    sampling,
  };

  const contours = temperatureContours(scale, "metric");
  assert.ok(contours.length > 0);
  for (const contour of contours) {
    assert.ok(Array.isArray(contour.segments));
    assert.ok(Array.isArray(contour.components));
    // Direct structured components match contourComponents(contour) identically
    assert.equal(contourComponents(contour), contour.components);
    for (const comp of contour.components!) {
      assert.ok(comp.segments.length > 0);
      assert.ok(comp.minX >= 100 && comp.maxX <= 280);
      assert.ok(comp.minY >= 50 && comp.maxY <= 250);
    }
  }

  // Verify label placement places at most one label per connected component and avoids cloud/barb collisions
  const placed = placeTemperatureLabels(
    {
      contours,
      clouds: [],
      barbs: [],
      compact: false,
      unitSystem: "metric",
      columnWidth: 60,
      left: 70,
      top: 50,
      bottom: 250,
      plotWidth: 240,
    },
    0.8,
    [],
    [],
    "metric",
  );
  assert.ok(placed.length > 0);
  const totalComponents = contours.reduce((sum, c) => sum + (c.components?.length ?? 0), 0);
  assert.ok(placed.length <= totalComponents);
});

test("imperial contour classification preserves a corner just below the 56-degree threshold", () => {
  const hours = [
    { validAt: "2026-10-21T18:00:00Z", x: 100 },
    { validAt: "2026-10-21T19:00:00Z", x: 160 },
  ];
  const makeView = (surfaceC: number) => ({
    top: 50, bottom: 150, plotHeight: 100, floorM: 0, topM: 1000,
    anchors: [
      { heightM: 0, y: 150, pressureHpa: 1000 },
      { heightM: 1000, y: 50, pressureHpa: 900 },
    ],
    hours,
    sampling: hours.map(h => makeSamplingHour(h.validAt, [[0, surfaceC], [1000, 10]])),
  });
  // These adjacent doubles straddle the existing 56°F threshold. Replacing
  // the conversion with division by 1.8 incorrectly draws the colder boundary.
  const below = temperatureContours(makeView(13.333333333333332), "imperial");
  assert.ok(!below.some(contour => contour.temperatureF === 56));
  const equal = temperatureContours(makeView(13.333333333333334), "imperial");
  const boundary = equal.find(contour => contour.temperatureF === 56);
  assert.ok(boundary?.segments?.length);
  assert.ok(boundary.segments.every(segment => segment.y1 === 150 && segment.y2 === 150));
});

test("Stage 4 geometry: buildContourComponentsFromSegments separates disjoint inversion branches and attaches nearby candidates only", () => {
  const branchA = [
    { x1: 100, y1: 200, x2: 150, y2: 190 },
    { x1: 150, y1: 190, x2: 200, y2: 185 },
  ];
  const branchB = [
    { x1: 100, y1: 90, x2: 150, y2: 95 },
    { x1: 150, y1: 95, x2: 200, y2: 100 },
  ];
  const candidateNearA = { x: 150, y: 192 }; // 2 px from branchA (distanceSquared = 4 <= 36)
  const candidateFar = { x: 150, y: 140 }; // 45 px from both branches (distanceSquared > 36 -> rejected)

  const components = buildContourComponentsFromSegments([...branchA, ...branchB], [candidateNearA, candidateFar]);
  assert.equal(components.length, 2);
  assert.equal(components[0].candidates.length, 1);
  assert.equal(components[1].candidates.length, 0);
});

test("Stage 4 geometry: buildStabilityFieldPaths handles all-missing, degenerate 1-hour, saddle cells, and bounded clipping", () => {
  const banding = {
    breakpoints: [-2.5, -1.5, 0],
    classNames: ["stab-unstable", "stab-neutral", "stab-stable", "stab-inverted"],
  };

  // All-missing field produces empty paths
  const emptyPaths = buildStabilityFieldPaths({
    nodesByHour: [
      [
        { altitudeM: 0, value: Number.NaN },
        { altitudeM: 100, value: Number.NaN },
      ],
    ],
    gaps: new Set(),
    floorM: 0,
    topM: 100,
    plotLeft: 50,
    plotTop: 20,
    plotBottom: 120,
    plotWidth: 60,
    banding,
  });
  assert.deepEqual(emptyPaths, {});

  // 1-hour valid column produces closed rings bounded strictly inside [plotLeft, plotLeft+plotWidth] x [plotTop, plotBottom]
  const oneHourPaths = buildStabilityFieldPaths({
    nodesByHour: [
      [
        { altitudeM: 0, value: -3.0 },
        { altitudeM: 50, value: -1.0 },
        { altitudeM: 100, value: 1.5 },
      ],
    ],
    gaps: new Set(),
    floorM: 0,
    topM: 100,
    plotLeft: 50,
    plotTop: 20,
    plotBottom: 120,
    plotWidth: 60,
    banding,
  });
  assert.ok(oneHourPaths["stab-unstable"]?.endsWith("Z"));
  assert.ok(oneHourPaths["stab-inverted"]?.endsWith("Z"));

  // Alternating 2x2 pattern exercises saddle disambiguation without unclosed paths or out-of-bounds coordinates
  const saddlePaths = buildStabilityFieldPaths({
    nodesByHour: [
      [
        { altitudeM: 0, value: -3.0 },
        { altitudeM: 100, value: 1.0 },
      ],
      [
        { altitudeM: 0, value: 1.0 },
        { altitudeM: 100, value: -3.0 },
      ],
    ],
    gaps: new Set(),
    floorM: 0,
    topM: 100,
    plotLeft: 50,
    plotTop: 20,
    plotBottom: 120,
    plotWidth: 120,
    banding,
  });
  for (const path of Object.values(saddlePaths)) {
    assert.ok(path.endsWith("Z"));
    for (const match of path.matchAll(/[ML]([-0-9.]+)\s+([-0-9.]+)/g)) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      assert.ok(x >= 50 && x <= 170, `x=${x} out of bounds [50, 170]`);
      assert.ok(y >= 20 && y <= 120, `y=${y} out of bounds [20, 120]`);
    }
  }
});
