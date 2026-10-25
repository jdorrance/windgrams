import { test } from "node:test";
import assert from "node:assert/strict";
import { createWindgramViewport, type ViewportSize } from "../src/lib/windgram-viewport.ts";

test("scrolling browser chrome and keyboard changes preserve mobile chart dimensions across redraws", () => {
  let size: ViewportSize = { width: 390, height: 700, orientation: "portrait-primary" };
  const read = createWindgramViewport(() => size);
  const initial = read();
  for (const height of [760, 780, 700, 400, 760]) {
    size = { ...size, height };
    assert.equal(read(), initial);
    assert.equal(read().height, 700);
  }
  size = { width: 780, height: 390, orientation: "landscape-primary" };
  assert.notEqual(read(), initial);
  assert.equal(read().portrait, false);
  assert.equal(read().height, 390);
  assert.equal(read().compact, true);
  size = { ...size, height: 430 };
  assert.equal(read().height, 390);
});

test("height-only changes retain desktop identity while width changes update the chart", () => {
  let size = { width: 1200, height: 900 };
  const read = createWindgramViewport(() => size);
  const initial = read();
  assert.equal(initial.compact, false);
  size = { ...size, height: 800 };
  assert.equal(read(), initial);
  assert.equal(read().height, 900);
  size = { width: 600, height: 700 };
  assert.equal(read().compact, true);
  assert.equal(read().width, 600);
  size = { width: 400, height: 650 };
  assert.equal(read().height, 650);
});

test("tablet keyboards and landscape phone heights never change the compact mode", () => {
  for (const width of [844, 900, 960, 961]) {
    let size: ViewportSize = { width, height: 700, orientation: "landscape-primary" };
    const read = createWindgramViewport(() => size);
    const initial = read();
    assert.equal(initial.compact, width <= 960);
    size = { ...size, height: 500 };
    assert.equal(read(), initial);
    assert.equal(read().compact, initial.compact);
    assert.equal(read().height, initial.height);
  }
});
