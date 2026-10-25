// Unit conversions and formatting shared by the charts and tables.

export type UnitSystem = "imperial" | "metric";
export type QuantityKind = "elevation" | "distance" | "resolution" | "temperature" | "temperatureDelta" | "wind" | "barbWind" | "lift" | "rainRate" | "rainAmount" | "pressure" | "lapseRate";

export const isUnitSystem = (value: unknown): value is UnitSystem => value === "imperial" || value === "metric";

// Explicit physical conversion constants with unambiguous direction names.
export const METRES_PER_FOOT = 0.3048;
export const FEET_PER_METRE = 1 / METRES_PER_FOOT; // 3.280839895013123
export const LEGACY_FEET_PER_METRE = 3.28084;
export const KNOTS_PER_MPS = 3600 / 1852; // 1.9438444924406048
export const LEGACY_MPS_PER_KNOT = 0.514444;
export const LEGACY_KNOTS_PER_MPS = 1.9438444924406;
export const MPS_PER_MPH = 0.44704;
export const LEGACY_MPH_PER_MPS = 2.23694;
export const FPM_PER_MPS = 196.8503937007874;
export const LEGACY_FPM_PER_MPS = 196.850394;

export const feetToMetres = (feet: number): number => feet * METRES_PER_FOOT;
export const metresToFeet = (metres: number): number => metres * FEET_PER_METRE;
export const mpsToKnots = (mps: number): number => mps * KNOTS_PER_MPS;
export const knotsToMps = (knots: number): number => knots / KNOTS_PER_MPS;
// Preserve each existing decoder/display calculation during structural changes.
// Standardizing these rounded factors requires a separate numerical review.
export const legacyFeetToMetres = (feet: number): number => feet / LEGACY_FEET_PER_METRE;
export const legacyMetresToFeet = (metres: number): number => metres * LEGACY_FEET_PER_METRE;
export const legacyKnotsToMps = (knots: number): number => knots * LEGACY_MPS_PER_KNOT;
export const legacyMpsToKnots = (mps: number): number => mps * LEGACY_KNOTS_PER_MPS;
export const mphToMps = (mphValue: number): number => mphValue * MPS_PER_MPH;
export const mpsToMph = (mps: number): number => mps * LEGACY_MPH_PER_MPS;
export const feetPerMinuteToMps = (fpm: number): number => fpm / LEGACY_FPM_PER_MPS;
export const celsiusToFahrenheit = (celsius: number): number => (celsius * 9) / 5 + 32;
export const fahrenheitToCelsius = (fahrenheitValue: number): number => (fahrenheitValue - 32) / 1.8;

/**
 * Extracts a finite scalar number from either a plain number or an `@azohra/meteo.briefing`
 * `EnsembleValue` (`{ members, p50, ... }`), returning `null` on zero-member dropout or non-finite values.
 */
export function finiteScalar(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object" && "p50" in value) {
    const dist = value as { members?: unknown; p50?: unknown };
    if (typeof dist.members === "number" && dist.members <= 0) return null;
    return typeof dist.p50 === "number" && Number.isFinite(dist.p50) ? dist.p50 : null;
  }
  return null;
}

const quantityDefinitions = {
  // Inputs remain physical values: metres, kilometres, Celsius, m/s, mm, hPa,
  // and the source windgram lapse gradient in Celsius per 1,000 feet.
  elevation: { imperial: [FEET_PER_METRE, 0, "ft", 0], metric: [1, 0, "m", 0] },
  distance: { imperial: [1 / 1.609344, 0, "mi", 1], metric: [1, 0, "km", 1] },
  resolution: { imperial: [1 / 1.609344, 0, "mi", 1], metric: [1, 0, "km", 1] },
  temperature: { imperial: [1.8, 32, "°F", 0], metric: [1, 0, "°C", 0] },
  temperatureDelta: { imperial: [1.8, 0, "°F", 1], metric: [1, 0, "°C", 1] },
  wind: { imperial: [2.2369362920544025, 0, "mph", 0], metric: [3.6, 0, "km/h", 0] },
  barbWind: { imperial: [KNOTS_PER_MPS, 0, "kt", 1], metric: [1, 0, "m/s", 1] },
  lift: { imperial: [FPM_PER_MPS, 0, "ft/min", 0], metric: [1, 0, "m/s", 2] },
  rainRate: { imperial: [1 / 25.4, 0, "in/h", 2], metric: [1, 0, "mm/h", 1] },
  rainAmount: { imperial: [1 / 25.4, 0, "in", 2], metric: [1, 0, "mm", 1] },
  pressure: { imperial: [1 / 33.8638866667, 0, "inHg", 2], metric: [1, 0, "hPa", 0] },
  lapseRate: { imperial: [1.8, 0, "°F/1,000 ft", 1], metric: [1000 / 304.8, 0, "°C/km", 1] },
} as const;

export const isQuantityKind = (value: unknown): value is QuantityKind => typeof value === "string" && Object.hasOwn(quantityDefinitions, value);
export const unitLabel = (kind: QuantityKind, system: UnitSystem): string => quantityDefinitions[kind][system][2];
export const defaultQuantityDigits = (kind: QuantityKind, system: UnitSystem): number => quantityDefinitions[kind][system][3];

export function convertQuantity(value: number | null | undefined, kind: QuantityKind, system: UnitSystem): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const [scale, offset] = quantityDefinitions[kind][system];
  return value * scale + offset;
}

/** Convert an edited display value back to the original physical unit. */
export function fromDisplayQuantity(value: number | null | undefined, kind: QuantityKind, system: UnitSystem): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const [scale, offset] = quantityDefinitions[kind][system];
  return (value - offset) / scale;
}

export function formatQuantity(value: number | null | undefined, kind: QuantityKind, digits: number | undefined, system: UnitSystem): string {
  const converted = convertQuantity(value, kind, system);
  if (converted === null) return "—";
  return `${fmt(converted, digits ?? defaultQuantityDigits(kind, system))} ${unitLabel(kind, system)}`;
}

export function fmt(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(value)) return "–";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function relativeTime(iso: string, now: number): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
