import type { ThermalVelocityInput } from './types.js';
import { computeThermalVelocityMps as thermal } from './convective-lift.js';
export { deriveDiagnosticsV2 } from './diagnostics.js';
export { computeUsableLiftTopV2M } from './convective-lift.js';
export { computeExperimentalTerrainAdjustment } from './terrain-adjustment.js';
/** Calculate W* in m/s; missing flux, pressure or depth returns null, measured non-convective conditions return zero. */
export function computeThermalVelocityMps(input: ThermalVelocityInput): number | null { return thermal(input); }
