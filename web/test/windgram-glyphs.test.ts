import assert from "node:assert/strict";
import { test } from "node:test";
import {  barbGeometry, barbPaths  } from "./helpers/windgram.ts";
import {  cloudGlyphBounds, freezingGlyphBounds, windBarbGlyph, wingGlyphBounds  } from "./helpers/windgram.ts";
import {  resolveWindgramPresentation  } from "./helpers/windgram.ts";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);

test("structured wind geometry preserves the default paths used by other charts", () => {
  for (const speed of [0, 2.5, 5, 10, 25, 50, 75, 100]) for (const direction of [0, 35, 90, 180, 270, 359]) {
    const { staff, flags, calm } = barbGeometry(speed, direction);
    assert.deepEqual({ staff, flags, calm }, barbPaths(speed, direction));
  }
  assert.equal(barbGeometry(10, 0, 22).staff, "M0,0L0.0,-22.0");
  assert.equal(barbGeometry(10, 0, 24).staff, "M0,0L0.0,-24.0");
});

test("wind collision bounds include every rendered vertex and the full outline at every bearing", () => {
  for (const compact of [false, true]) for (const system of ["metric", "imperial"] as const) {
    const presentation = resolveWindgramPresentation({ compact, widthPx: compact ? 390 : 800 });
    for (const speedKt of [0, 5, 10, 45, 50, 75, 100]) for (let directionDeg = 0; directionDeg < 360; directionDeg += 15) {
      const glyph = windBarbGlyph({ x: 100, y: 200, speedKt, directionDeg }, presentation, system);
      const { x, y, width, height } = glyph.bounds;
      if (glyph.calm) {
        close(x, 95.95); close(y, 195.95); close(width, 8.1); close(height, 8.1);
      } else {
        const coordinates = [glyph.staff, ...glyph.flags].flatMap(path => {
          const values = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
          return Array.from({ length: values.length / 2 }, (_, i) => [values[2 * i], values[2 * i + 1]]);
        });
        for (const [px, py] of coordinates) {
          assert.ok(100 + px - 1.05 >= x - 1e-8 && 100 + px + 1.05 <= x + width + 1e-8);
          assert.ok(200 + py - 1.05 >= y - 1e-8 && 200 + py + 1.05 <= y + height + 1e-8);
        }
      }
    }
  }
});

test("glyph bounds account for curved clouds, wing extrema, and snowflake strokes", () => {
  const cloud = cloudGlyphBounds(100, 200, 0.5);
  assert.ok(cloud.x > 86 && cloud.x < 88, "cloud bounds follow the cubic outline, inside its control points");
  assert.ok(cloud.width > 26 && cloud.width < 29);
  close(cloud.y + cloud.height, 200.35);
  assert.deepEqual(wingGlyphBounds(100, 200), { x: 87.1, y: 191.1, width: 25.8, height: 19.8 });
  const freezing = freezingGlyphBounds(100, 200);
  close(freezing.x, 95.4); close(freezing.y, 195.94); close(freezing.width, 9.2); close(freezing.height, 8.12);
});
