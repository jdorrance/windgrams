import { convertQuantity, getUnitSystem, type UnitSystem } from "./units.ts";

/** WxToFly's local lapse-rate scale, in °C per 1,000 ft.
 * Boundaries and interior RGB colors are taken from its published legend:
 * http://wxtofly.net/images/locallapserates.png
 * The −0.5 tick lies inside the single −1.2 to 0 stable-purple band.
 */
export const WINDGRAM_STABILITY = [
  { className: "very-unstable", maxLapse: -3, color: "#ff3c39", range: "≤ −3" },
  { className: "unstable", maxLapse: -2.5, color: "#ff9900", range: "−3 to −2.5" },
  { className: "conditional-strong", maxLapse: -2, color: "#ffbaff", range: "−2.5 to −2" },
  { className: "conditional", maxLapse: -1.5, color: "#cdbeff", range: "−2 to −1.5" },
  { className: "near-neutral", maxLapse: -1.2, color: "#fff2e6", range: "−1.5 to −1.2" },
  { className: "stable", maxLapse: 0, color: "#7b7de6", range: "−1.2 to 0" },
  { className: "inverted", maxLapse: .5, color: "#cdcecd", range: "0 to 0.5" },
  { className: "strong-inversion", maxLapse: Infinity, color: "#9c999c", range: "> 0.5" },
] as const;

export const WINDGRAM_STABLE_COLOR = WINDGRAM_STABILITY[5].color;

/** Display boundaries only; the source scale and classification remain physical. */
export function stabilityRange(index: number, system: UnitSystem = getUnitSystem()): string {
  const value = (n: number) => Number(convertQuantity(n, "lapseRate", system)!.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 }).replace("-", "−");
  if (index === 0) return `≤ ${value(WINDGRAM_STABILITY[0].maxLapse)}`;
  if (index === WINDGRAM_STABILITY.length - 1) return `> ${value(WINDGRAM_STABILITY[index - 1].maxLapse)}`;
  return `${value(WINDGRAM_STABILITY[index - 1].maxLapse)} to ${value(WINDGRAM_STABILITY[index].maxLapse)}`;
}
