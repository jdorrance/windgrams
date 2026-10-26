import { componentsToWind, windToComponents } from '@azohra/meteo.briefing/derive';
import { finite } from './thermodynamics.js';
import type { WindLevel, WindSample } from './types.js';

/**
 * Sample horizontal components at a height in metres MSL. Input order is free;
 * missing winds and duplicate heights block their adjacent intervals. No extrapolation.
 * Calm wind is zero speed with no direction. Surface nodes need their physical height.
 */
export function sampleWindAtHeight(levels: readonly WindLevel[], heightM: number): WindSample {
  const nodes = levels.filter(node => finite(node.heightM)).sort((a, b) => a.heightM - b.heightM);
  const upper = nodes.findIndex(node => node.heightM >= heightM);
  const exact = upper >= 0 && nodes[upper].heightM === heightM;
  const lower = exact ? upper : upper - 1;
  if (!finite(heightM) || lower < 0) return { status: 'unavailable', reason: 'outside-wind-support' };

  const a = nodes[lower], b = nodes[upper];
  if (nodes[lower - 1]?.heightM === a.heightM || nodes[upper + 1]?.heightM === b.heightM) {
    return { status: 'unavailable', reason: 'duplicate-height' };
  }
  const valid = (node: WindLevel): node is WindLevel & { windSpeedMps: number } =>
    finite(node.windSpeedMps) && node.windSpeedMps >= 0
      && (node.windSpeedMps === 0 || finite(node.windDirectionDeg));
  if (!valid(a) || !valid(b)) return { status: 'unavailable', reason: 'missing-bracket-wind' };

  if (exact) return { status: 'available', speedMps: a.windSpeedMps,
    directionDeg: a.windSpeedMps === 0 ? null : a.windDirectionDeg!, bracketMslM: [heightM, heightM] };
  const from = windToComponents(a.windSpeedMps, a.windSpeedMps === 0 ? 0 : a.windDirectionDeg!);
  const to = windToComponents(b.windSpeedMps, b.windSpeedMps === 0 ? 0 : b.windDirectionDeg!);
  const fraction = (heightM - a.heightM) / (b.heightM - a.heightM);
  const wind = componentsToWind(from.uMps + fraction * (to.uMps - from.uMps), from.vMps + fraction * (to.vMps - from.vMps));
  return { status: 'available', ...wind, directionDeg: wind.speedMps === 0 ? null : wind.directionDeg,
    bracketMslM: [a.heightM, b.heightM] };
}
