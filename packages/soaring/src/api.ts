import type { ThermalVelocityInput } from './types.js';
import { computeThermalVelocityMps as thermal } from './convective-lift.js';
export { deriveDiagnosticsV2 } from './diagnostics.js';
export { computeUsableLiftTopV2M } from './convective-lift.js';
export { computeExperimentalTerrainAdjustment } from './terrain-adjustment.js';
/** Calculate convective velocity W* in m/s from surface conditions and boundary-layer depth. */
export function computeThermalVelocityMps(input: ThermalVelocityInput): number { return thermal(input); }
