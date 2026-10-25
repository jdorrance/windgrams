import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSiteForecast } from "@azohra/meteo.briefing/contract";
import { buildWindgramView, heightToY, readWindgram, yToHeight } from "../src/lib/windgram-view.ts";
import { resolveWindgramPresentation, windgramPresentationKey } from "../src/lib/windgram-presentation.ts";

test("presentation uses the reference aspect ratio at phone and desktop widths", () => {
  const phone = resolveWindgramPresentation({ widthPx: 356, compact: true });
  assert.deepEqual([phone.left, phone.right, phone.plotWidth, phone.plotHeight, phone.height], [52, 8, 296, 267, 379]);
  const desktop = resolveWindgramPresentation({ widthPx: 1400, compact: false });
  assert.deepEqual([desktop.left, desktop.right, desktop.plotWidth, desktop.plotHeight, desktop.height], [80, 64, 656, 592, 704]);
  assert.equal(desktop.width, 800);
  for (const compact of [true, false]) for (const widthPx of [240, 320, 356, 390, 768, 800, 1400]) {
    const style = resolveWindgramPresentation({ widthPx, compact });
    assert.equal(style.width, Math.min(widthPx, 800));
    assert.equal(style.left + style.plotWidth + style.right, style.width);
    assert.equal(style.plotHeight, Math.max(160, Math.round(style.plotWidth * 592 / 656)));
    assert.equal(style.height, style.plotHeight + 112);
    assert.equal(style.fonts.primary, 12);
    assert.equal(style.fonts.secondary, 11);
    assert.equal(style.fonts.lift, 14);
    assert.equal(style.glyphs.barbStaff, compact ? 22 : 24);
    assert.equal(style.glyphs.minimumHorizontalSpacing, 40);
    assert.equal(style.glyphs.minimumVerticalSpacing, 28);
  }
});

test("altitude labels expand only the left margin when the normal axis is too narrow", () => {
  const options = { compact: true, widthPx: 356 };
  const ordinary = resolveWindgramPresentation({ ...options, altitudeLabels: ["1,149", "12,268"] });
  const wide = resolveWindgramPresentation({ ...options, altitudeLabels: ["−123,456"] });
  assert.equal(ordinary.left, 52);
  assert.ok(wide.left > ordinary.left);
  assert.equal(wide.right, ordinary.right);
  assert.equal(wide.width, ordinary.width);
  assert.equal(wide.top, ordinary.top);
  assert.equal(wide.bottomMargin, ordinary.bottomMargin);
  assert.equal(wide.plotWidth, ordinary.plotWidth - (wide.left - ordinary.left));
  assert.equal(windgramPresentationKey(options), windgramPresentationKey({ ...options }));
  assert.notEqual(windgramPresentationKey(options), windgramPresentationKey({ ...options, widthPx: 390 }));
});

test("width changes preserve native samples, physical readouts and normalized altitude mapping", () => {
  const profile = parseSiteForecast(JSON.parse(readFileSync(new URL("../dev-data-src/convective-cycle.profile.json", import.meta.url), "utf8")))!;
  const original = structuredClone(profile);
  const options = { compact: true, heightRange: "full" as const, timeZone: profile.site.timeZone };
  const narrow = buildWindgramView(profile, { ...options, widthPx: 356 });
  const wide = buildWindgramView(profile, { ...options, widthPx: 800 });
  const scrolled = buildWindgramView(profile, { ...options, widthPx: 356, heightPx: 300, maxHeightPx: 100 });
  assert.deepEqual(scrolled, narrow, "legacy height constraints never alter the scene");
  assert.deepEqual(wide.sampling, narrow.sampling);
  assert.deepEqual(wide.timeAxis.map(tick => tick.validAt), narrow.timeAxis.map(tick => tick.validAt));
  assert.equal(wide.floorM, narrow.floorM);
  assert.equal(wide.topM, narrow.topM);
  for (let i = 0; i <= 40; i++) {
    const height = narrow.floorM + (narrow.topM - narrow.floorM) * i / 40;
    const normalized = (view: typeof narrow) => (heightToY(view, height) - view.top) / view.plotHeight;
    assert.ok(Math.abs(normalized(narrow) - normalized(wide)) < 1e-12);
    assert.ok(Math.abs(yToHeight(narrow, heightToY(narrow, height)) - height) < 1e-8);
    for (const hourIndex of [0, Math.floor(narrow.hours.length / 2), narrow.hours.length - 1]) {
      assert.deepEqual(readWindgram(narrow, hourIndex, height), readWindgram(wide, hourIndex, height));
    }
  }
  assert.deepEqual(profile, original);
});
