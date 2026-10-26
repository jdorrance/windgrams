import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { convertQuantity, formatQuantity, fromDisplayQuantity, getUnitSystem, gustNoun, setUnitSystem, UNIT_STORAGE_KEY, unitLabel, type QuantityKind } from "../src/lib/units.ts";
import { validateLaunchInput, windLimitDisplayInput, windLimitFromDisplayInput } from "../src/lib/launches.ts";

afterEach(() => setUnitSystem("imperial"));

const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`);

test("physical quantities convert into familiar pilot units", () => {
  const values: [QuantityKind, number, number, number][] = [
    ["elevation", 304.8, 1000, 304.8],
    ["distance", 1.609344, 1, 1.609344],
    ["resolution", 3, 3 / 1.609344, 3],
    ["temperature", 0, 32, 0],
    ["temperatureDelta", 1, 1.8, 1],
    ["wind", 0.44704, 1, 1.609344],
    ["barbWind", 1, 1.9438444924406048, 1],
    ["lift", 0.00508, 1, 0.00508],
    ["rainRate", 25.4, 1, 25.4],
    ["rainAmount", 25.4, 1, 25.4],
    ["pressure", 1013.25, 1013.25 / 33.8638866667, 1013.25],
    ["lapseRate", 3, 5.4, 3 * 1000 / 304.8],
  ];
  for (const [kind, source, imperial, metric] of values) {
    close(convertQuantity(source, kind, "imperial"), imperial);
    close(convertQuantity(source, kind, "metric"), metric);
    close(fromDisplayQuantity(imperial, kind, "imperial"), source);
    close(fromDisplayQuantity(metric, kind, "metric"), source);
  }
});

test("formatting uses quantity precision and preserves missing data", () => {
  assert.equal(formatQuantity(1.93, "lift", undefined, "imperial"), "380 ft/min");
  assert.equal(formatQuantity(1.93, "lift", undefined, "metric"), "1.93 m/s");
  assert.equal(formatQuantity(1013.25, "pressure", undefined, "imperial"), "29.92 inHg");
  assert.equal(formatQuantity(0.25, "rainAmount", undefined, "imperial"), "0.01 in");
  assert.equal(formatQuantity(1, "temperatureDelta", 2, "imperial"), "1.80 °F");
  for (const missing of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(convertQuantity(missing, "wind"), null);
    assert.equal(fromDisplayQuantity(missing, "wind"), null);
    assert.equal(formatQuantity(missing, "wind"), "—");
  }
  assert.equal(formatQuantity(0, "temperature", undefined, "metric"), "0 °C");
});

test("gust wording names the declared class and leaves an undeclared document with the plain word", () => {
  assert.equal(gustNoun("hourMax"), "hour-max gust");
  assert.equal(gustNoun("instant"), "gust sample");
  assert.equal(gustNoun(null), "gust");
  assert.equal(gustNoun(undefined), "gust");
});

test("a chosen unit system also drives callers without explicit options", () => {
  setUnitSystem("metric");
  assert.equal(getUnitSystem(), "metric");
  assert.equal(unitLabel("wind"), "km/h");
  assert.equal(formatQuantity(10, "wind"), "36 km/h");
  setUnitSystem("imperial");
  assert.equal(formatQuantity(10, "wind"), "22 mph");
});

const memoryStore = (initial?: string, writable = true) => {
  let value = initial ?? null;
  return {
    getItem: (key: string) => key === UNIT_STORAGE_KEY ? value : null,
    setItem: (_key: string, next: string) => { if (!writable) throw new Error("Storage blocked"); value = next; },
  };
};
let moduleId = 0;
async function withBrowser(browser: object, run: (units: typeof import("../src/lib/units.ts")) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: browser, configurable: true });
  try {
    const units = await import(`../src/lib/units.ts?preference-test=${++moduleId}`);
    run(units);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("saved preference survives page loads with a session fallback", async () => {
  const localStorage = memoryStore("imperial", false);
  const sessionStorage = memoryStore();
  const browser = { location: { href: "https://example.com/launches/edith?model=rrfs&day=2026-10-23&time=18#forecast" }, localStorage, sessionStorage };
  await withBrowser(browser, (units) => {
    assert.equal(units.getUnitSystem(), "imperial");
    assert.equal(units.setUnitSystem("metric"), true);
  });
  await withBrowser(browser, (units) => assert.equal(units.getUnitSystem(), "metric"));
});

test("URL preference supports blocked storage and preserves an in-memory choice", async () => {
  const browser = {
    location: { href: "https://example.com/launches/edith?model=rrfs&units=metric" },
    get localStorage() { throw new Error("Storage blocked"); },
    get sessionStorage() { throw new Error("Storage blocked"); },
  };
  await withBrowser(browser, (units) => {
    assert.equal(units.getUnitSystem(), "metric");
    assert.equal(units.setUnitSystem("imperial"), false);
    assert.equal(units.getUnitSystem(), "imperial");
  });
});

test("writable local storage overrides a stale read-only session preference", async () => {
  await withBrowser({ location: { href: "https://example.com/" }, localStorage: memoryStore(), sessionStorage: memoryStore("imperial", false) }, (units) => {
    assert.equal(units.setUnitSystem("metric"), true);
    assert.equal(units.getUnitSystem(), "metric");
  });
});

test("a preference changed in another tab overrides this tab's stale session on reload", async () => {
  const localStorage = memoryStore("imperial");
  const tabA = { location: { href: "https://example.com/about" }, localStorage, sessionStorage: memoryStore("imperial") };
  const tabB = { location: { href: "https://example.com/soaring" }, localStorage, sessionStorage: memoryStore("imperial") };
  await withBrowser(tabA, (units) => assert.equal(units.getUnitSystem(), "imperial"));
  await withBrowser(tabB, (units) => assert.equal(units.setUnitSystem("metric"), true));
  await withBrowser(tabA, (units) => {
    assert.equal(units.getUnitSystem(), "metric");
    assert.equal(units.setUnitSystem(units.getUnitSystem()), true);
  });
  assert.equal(localStorage.getItem(UNIT_STORAGE_KEY), "metric");
  assert.equal(tabA.sessionStorage.getItem(UNIT_STORAGE_KEY), "metric");
});

test("stale read-only stores request a URL fallback", async () => {
  const localStorage = memoryStore("imperial", false);
  const sessionStorage = memoryStore("imperial", false);
  await withBrowser({ location: { href: "https://example.com/" }, localStorage, sessionStorage }, (units) => {
    assert.equal(units.getUnitSystem(), "imperial");
    assert.equal(units.setUnitSystem("metric"), false);
    assert.equal(units.getUnitSystem(), "metric");
  });
  await withBrowser({ location: { href: "https://example.com/?units=metric" }, localStorage, sessionStorage }, (units) => {
    assert.equal(units.getUnitSystem(), "metric");
  });
});

test("invalid saved preferences default to imperial", async () => {
  await withBrowser({ location: { href: "https://example.com/?units=unknown" }, localStorage: memoryStore("unknown"), sessionStorage: memoryStore() }, (units) => {
    assert.equal(units.getUnitSystem(), "imperial");
  });
});

const launchInput = {
  name: "Edith", latitude: 38.84, longitude: -78.57, timeZone: "America/New_York", facingDeg: 300,
  windMinMph: 5, windMaxMph: 15, gustMaxMph: 20,
};

test("unchanged form limits retain exact stored mph across repeated metric round trips", () => {
  for (const units of ["metric", "imperial"] as const) {
    for (const source of [0, 5, 15, 20, 17.138893]) {
      let stored = source;
      for (let attempt = 0; attempt < 10; attempt++) {
        const displayed = windLimitDisplayInput(stored, units);
        stored = windLimitFromDisplayInput(displayed, units, stored)!;
      }
      assert.equal(stored, source);
    }
  }
});

test("edited metric limits retain fractional mph and physical comparisons", () => {
  const edited = windLimitFromDisplayInput("25", "metric", 15)!;
  close(edited, 25 / 1.609344);
  const valid = validateLaunchInput({ ...launchInput, windMaxMph: edited }, "metric");
  assert.ok("launch" in valid);
  assert.equal(valid.launch.windMaxMph, edited);
  close(convertQuantity(valid.launch.windMaxMph * 0.44704, "wind", "metric"), 25);
  const invalid = validateLaunchInput({ ...launchInput,
    windMinMph: windLimitFromDisplayInput("30", "metric"),
    windMaxMph: windLimitFromDisplayInput("29.9", "metric"),
  }, "metric");
  assert.ok("errors" in invalid);
  assert.ok(invalid.errors.includes("Minimum wind: below maximum wind."));
});

test("blank wind inputs stay missing and validation uses selected units", () => {
  for (const raw of ["", "  ", "NaN", "Infinity"]) assert.equal(windLimitFromDisplayInput(raw, "metric", 5), null);
  const blank = validateLaunchInput({ ...launchInput, windMinMph: windLimitFromDisplayInput("", "metric", 5) }, "metric");
  assert.ok("launch" in blank);
  assert.equal(blank.launch.windMinMph, null);
  const invalid = validateLaunchInput({ ...launchInput, windMinMph: 100 }, "metric");
  assert.ok("errors" in invalid);
  assert.match(invalid.errors[0], /km\/h/);
  assert.doesNotMatch(invalid.errors[0], /mph/);
  assert.equal(windLimitFromDisplayInput("0", "metric"), 0);
});
