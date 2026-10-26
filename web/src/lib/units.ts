// The application owns preferences; reusable formatting requires explicit units.
import * as format from '@windgrams/windgram/format';
import { isUnitSystem, type UnitSystem, type QuantityKind } from '@windgrams/windgram/format';
export { isUnitSystem, isQuantityKind, fmt, gustNoun, feetToMetres, metresToFeet, mpsToKnots, knotsToMps, mphToMps, mpsToMph, feetPerMinuteToMps, celsiusToFahrenheit, fahrenheitToCelsius, legacyFeetToMetres, legacyMetresToFeet, legacyKnotsToMps, finiteScalar, type UnitSystem, type QuantityKind, type GustSemantics } from '@windgrams/windgram/format';
export const UNIT_STORAGE_KEY = "windgrams:units";
let memoryPreference: UnitSystem | null = null;

function persistedUnitSystem(): UnitSystem | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(UNIT_STORAGE_KEY);
    if (isUnitSystem(stored)) {
      // A readable but blocked store can contain an obsolete choice. Only a
      // writable shared store takes priority over this tab's session fallback.
      window.localStorage.setItem(UNIT_STORAGE_KEY, stored);
      return stored;
    }
  } catch { /* Local storage may be readable while refusing writes. */ }
  try {
    const stored = window.sessionStorage.getItem(UNIT_STORAGE_KEY);
    if (isUnitSystem(stored)) return stored;
  } catch { /* The URL and memory still work with all storage blocked. */ }
  return null;
}

/** The URL carries the preference when browser storage is unavailable. */
export function getUnitSystem(): UnitSystem {
  if (memoryPreference) return memoryPreference;
  if (typeof window === "undefined") return "imperial";
  try {
    const requested = new URL(window.location.href).searchParams.get("units");
    if (isUnitSystem(requested)) return memoryPreference = requested;
  } catch { /* A partial browser context can still use storage. */ }
  return memoryPreference = persistedUnitSystem() ?? "imperial";
}

/** Returns whether the choice will survive a reload without a URL parameter. */
export function setUnitSystem(system: UnitSystem): boolean {
  memoryPreference = system;
  if (typeof window === "undefined") return false;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try { window[name].setItem(UNIT_STORAGE_KEY, system); }
    catch { /* Keep the session's in-memory choice when storage is blocked. */ }
  }
  // Verify with the same priority as reload, including read-only fallbacks.
  return persistedUnitSystem() === system;
}


export const unitLabel = (kind: QuantityKind, system = getUnitSystem()) => format.unitLabel(kind, system);
export const defaultQuantityDigits = (kind: QuantityKind, system = getUnitSystem()) => format.defaultQuantityDigits(kind, system);
export const convertQuantity = (value: number | null | undefined, kind: QuantityKind, system = getUnitSystem()) => format.convertQuantity(value, kind, system);
export const fromDisplayQuantity = (value: number | null | undefined, kind: QuantityKind, system = getUnitSystem()) => format.fromDisplayQuantity(value, kind, system);
export const formatQuantity = (value: number | null | undefined, kind: QuantityKind, digits?: number, system = getUnitSystem()) => format.formatQuantity(value, kind, digits, system);

export const relativeTime = (iso: string, now = Date.now()) => format.relativeTime(iso, now);
