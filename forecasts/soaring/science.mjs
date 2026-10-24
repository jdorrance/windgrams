// Compatibility facade re-exporting extracted soaring science modules.
// Preserves all existing public exports while delegating each responsibility
// to its dedicated module.

export {
  CPD_J_PER_KG_K,
  EPSILON,
  GRAVITY_MPS2,
  LV_J_PER_KG,
  MAGNUS_A,
  MAGNUS_B_C,
  MAGNUS_ES0_HPA,
  POISSON_KAPPA,
  RD_J_PER_KG_K,
  VIRTUAL_TEMP_DELTA,
  computeMixedLayerLclM,
  dewPointFromMixingRatioC,
   geometricWFromOmegaMps,
  hypsometricSurfacePressureHpa,
  parcelLclAglM,
} from './thermodynamics.mjs';

export {
  LENSCHOW_F_MAX,
  LENSCHOW_PEAK_ZETA,
  WXTOFLY_SINK_MPS,
  computeLegacyThermalVelocityMps,
  computeThermalVelocityMps,
  computeUsableLiftTopV2M,
  lenschowNormalizedUpdraft,
  resolvedParcelDepthM,
} from './convective-lift.mjs';

export { computeBoundaryLayerWind } from './boundary-layer-wind.mjs';
export { computeExperimentalTerrainAdjustment } from './terrain-adjustment.mjs';
export { computeNativeGridConvergence } from './grid-kinematics.mjs';
export {
  SOARING_CONTRACT_VERSION,
  deriveDiagnosticsV2,
  metrics,
  v2LayerMetrics,
} from './diagnostics.mjs';
export { cellSource, deriveCell } from './grib-column.mjs';
export {
  assertAgreement,
  differences,
  metric,
  profileFor,
} from './audit-agreement.mjs';
