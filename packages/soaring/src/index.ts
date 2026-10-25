export { SOARING_CONTRACT_VERSION } from './diagnostics.js';
export { deriveDiagnosticsV2, computeThermalVelocityMps, computeUsableLiftTopV2M, computeExperimentalTerrainAdjustment } from './api.js';
export type {
  BaselineLiftHour, DiagnosticOptions, SoaringDiagnostics, SoaringMetric, ThermalVelocityInput,
  UsableLiftInput, TerrainAdjustment, VerticalResolution,
} from './types.js';
