import { test } from "node:test";
import assert from "node:assert/strict";
import { barbPaths } from "../src/lib/wind-barb.ts";
import { barbPaths as skewTBarbPaths } from "../src/lib/skewt-chart.ts";

test("calm winds have a circle, starting a half feather at 2.5 knots", () => {
  assert.deepEqual(barbPaths(0, 0), { staff: "", flags: [], calm: true });
  assert.deepEqual(barbPaths(2.499, 123), { staff: "", flags: [], calm: true });
  assert.equal(barbPaths(2.5, 0).calm, false);
  assert.deepEqual(barbPaths(2.5, 0), barbPaths(5, 0));
});

test("half, full and pennant feathers retain the standard 5/10/50-knot values", () => {
  const half = barbPaths(5, 0);
  const full = barbPaths(10, 0);
  const pennant = barbPaths(50, 0);
  assert.equal(half.flags.length, 1);
  assert.equal(full.flags.length, 1);
  assert.equal(pennant.flags.length, 1);
  assert.ok(!half.flags[0].endsWith("Z"));
  assert.ok(!full.flags[0].endsWith("Z"));
  assert.ok(pennant.flags[0].endsWith("Z"));
  // A half feather is shorter than a full feather, and a standalone half
  // starts below the staff tip so 5 kt cannot be mistaken for 10 kt.
  assert.equal(half.flags[0], "M0.0,-18.0L5.0,-19.5");
  assert.equal(full.flags[0], "M0.0,-22.0L9.0,-25.0");
  const seventyFive = barbPaths(75, 0);
  assert.equal(seventyFive.flags.filter((f) => f.endsWith("Z")).length, 1);
  assert.equal(seventyFive.flags.filter((f) => !f.endsWith("Z")).length, 3);
  assert.equal(barbPaths(100, 0).flags.filter((f) => f.endsWith("Z")).length, 2);
});

test("speeds round to the nearest 5 knots at the feather and pennant boundaries", () => {
  for (const [speed, rounded] of [[7.499, 5], [7.5, 10], [12.499, 10], [12.5, 15], [47.499, 45], [47.5, 50], [52.499, 50], [52.5, 55]]) {
    assert.deepEqual(barbPaths(speed, 35), barbPaths(rounded, 35), `${speed} → ${rounded}`);
  }
});

test("the staff points toward the meteorological wind source in screen coordinates", () => {
  const endpoint = (direction: number) => {
    const values = barbPaths(10, direction).staff.split("L")[1].split(",").map(Number);
    return values.map((n) => Math.abs(n) < 0.05 ? 0 : n);
  };
  assert.deepEqual(endpoint(0), [0, -22]);
  assert.deepEqual(endpoint(90), [22, 0]);
  assert.deepEqual(endpoint(180), [0, 22]);
  assert.deepEqual(endpoint(270), [-22, 0]);
  assert.deepEqual(endpoint(360), endpoint(0));
});

test("Skew-T preserves its public helper export", () => {
  assert.equal(skewTBarbPaths, barbPaths);
});
