// Scientific meanings shared by inventory and comparison gates. No forecast derivation.
export const REGRESSION_SITES = Object.freeze([
  'wa-blanchard',
  'wa-tiger-mountain',
  'wa-rampart-ridge',
  'wa-mt-baker-summit',
]);
export const CONVERGENCE_DISTINCTION =
  'WxToFly cm/s convergence / wblmaxmin is geometric vertical velocity, not horizontal convergence (10⁻⁵ s⁻¹). Native-grid horizontal convergence has no verified WxToFly numeric equivalent.';

/** IDs encode meaning, not similar labels. A conversion cannot join different IDs. */
export const SCIENTIFIC_QUANTITIES = Object.freeze({
  verticalVelocity: { unit: 'm/s', meaning: 'Geometric vertical air velocity; positive upward.' },
  horizontalConvergence: { unit: 's⁻¹', meaning: 'Negative horizontal divergence of the wind; not vertical velocity.' },
  lift1: { unit: 'm', heightReference: 'MSL', sinkRateMps: 1, meaning: 'Usable lift ceiling at 1 m/s sink.' },
  lift225: {
    unit: 'm',
    heightReference: 'MSL',
    sinkRateMps: 1.143,
    meaning: 'Usable lift ceiling at 225 ft/min sink.',
  },
  xcLiftUnverified: {
    unit: 'm',
    heightReference: 'MSL',
    meaning: 'XC usable lift; exact sink threshold remains unverified.',
  },
  surfaceLcl: {
    unit: 'm',
    heightReference: 'MSL',
    meaning: 'Potential condensation level of a lifted surface parcel; not observed cloud base.',
  },
  mixedLcl: { unit: 'm', heightReference: 'MSL', meaning: 'Potential condensation level of a mixed-layer parcel.' },
  ccl: { unit: 'm', heightReference: 'MSL', meaning: 'Convective condensation level; not LCL.' },
  ambientCloudBase: {
    unit: 'm',
    heightReference: 'MSL',
    meaning: 'Environmental cloud-base diagnostic; distinct from potential parcel LCL.',
  },
  nativePblDepth: {
    unit: 'm',
    heightReference: 'AGL',
    meaning: 'Native model boundary-layer parameterization depth above its own terrain.',
  },
  thermalTop: {
    unit: 'm',
    heightReference: 'MSL',
    meaning: 'Resolved parcel thermal top; not native model PBL depth.',
  },
  xcThermalTopUnverified: {
    unit: 'm',
    heightReference: 'MSL',
    meaning: 'XC parcel top; equivalence to our parcel and closure policy is unverified.',
  },
});

export const PROVIDER_COMPARISON_DEFINITIONS = [
  {
    parameter: 'W* (Convective velocity scale)',
    drjackId: 'wstar',
    wxtoflyUnit: 'ft/min (and kt/m·s⁻¹)',
    windgramsV1Field: 'derived.thermalVelocityMps',
    windgramsV2Field: 'thermalVelocityV2Mps',
    status: 'method-dependent-comparison',
    notes:
      'Deardorff convective velocity scale driven by surface virtual heat flux (SHTFL + 0.61·cp/Lv·T·LHTFL) and resolvedDepthM (resolvedThermalTopM - terrainM). Fixes v1/v2 hybrid depth mismatch.',
  },
  {
    parameter: 'Parcel thermal top',
    drjackId: 'hbl',
    wxtoflyUnit: 'ft MSL',
    windgramsV1Field: 'derived.boundaryLayerTopM & surface.pblHeightM',
    windgramsV2Field: 'resolvedThermalTopM',
    status: 'separated-in-v2',
    notes:
      'v1 used dry parcel crossing with an index===0 jump to 925 hPa when stable. v2 resolves shallow convective boundary layers using HPBL and couples all v2 lift diagnostics to resolvedThermalTopM.',
  },
  {
    parameter: 'Native model PBL depth',
    drjackId: null,
    wxtoflyUnit: null,
    windgramsV1Field: 'surface.pblHeightM',
    windgramsV2Field: 'surface.pblHeightM (m AGL)',
    status: 'no-equivalent-wxtofly-field',
    notes: SCIENTIFIC_QUANTITIES.nativePblDepth.meaning,
  },
  {
    parameter: 'Height of critical updraft strength (Hcrit)',
    drjackId: 'experimental1 / hglider',
    wxtoflyUnit: 'ft MSL (225 ft/min = 1.143 m/s sink)',
    windgramsV1Field: 'derived.usableLiftTopM (1.0 m/s sink)',
    windgramsV2Field: 'usableLiftTopV2M (1.0 m/s) & hcritWxtoflyM (1.143 m/s / 225 fpm) & dryHcritM',
    status: 'distinct-sink-thresholds',
    notes:
      'Evaluated using resolvedThermalTopM and thermalVelocityV2Mps so hcritWxtoflyM <= usableLiftTopV2M <= dryHcritM <= resolvedThermalTopM holds strictly by construction.',
  },
  {
    parameter: 'Cu cloud base (Surface LCL)',
    drjackId: 'zsfclcl',
    wxtoflyUnit: 'ft MSL',
    windgramsV1Field: 'derived.cloudBaseM (combined min of sfc LCL and first ΔTd<=0.5°C layer)',
    windgramsV2Field: 'surfaceLclM',
    status: 'separated-in-v2',
    notes: 'Bolton (1980) surface parcel LCL in meters MSL. Also supported on ECMWF and NWS surface adapters.',
  },
  {
    parameter: 'Cu potential (zsfclcldif)',
    drjackId: 'zsfclcldif',
    wxtoflyUnit: 'ft (BL top minus sfc LCL)',
    windgramsV1Field: null,
    windgramsV2Field: 'cuPotentialM (resolvedThermalTopM - surfaceLclM)',
    status: 'added-in-v2',
    notes:
      'Positive values indicate thermal top exceeds surface LCL (cumulus formation likely); negative values indicate blue thermals capped below LCL.',
  },
  {
    parameter: 'Mixed-layer LCL & Overcast Development (OD) potential',
    drjackId: 'zblcl / zblcldif',
    wxtoflyUnit: 'ft MSL / ft',
    windgramsV1Field: null,
    windgramsV2Field: 'mixedLayerLclM / odPotentialM',
    status: 'method-dependent-comparison',
    notes:
      'Computed from boundary-layer mean potential temperature θ and water-vapor mixing ratio r referenced to surface pressure and lifted via Bolton LCL (unexplained 0.85 multiplier removed).',
  },
  {
    parameter: 'Boundary-layer average wind',
    drjackId: 'blwind',
    wxtoflyUnit: 'kt / mph & degrees true',
    windgramsV1Field: null,
    windgramsV2Field: 'blMeanWindSpeedMps / blMeanWindDirDeg',
    status: 'added-in-v2',
    notes:
      'Vector average of Earth-rotated (u, v) from 10 m surface wind (and 80 m wind when present) through resolvedThermalTopM.',
  },
  {
    parameter: 'Wind at BL top & BL vertical wind shear',
    drjackId: 'bltopwind / blwindshear / bsratio',
    wxtoflyUnit: 'kt / m·s⁻¹ & dimensionless B/S ratio',
    windgramsV1Field: null,
    windgramsV2Field: 'blTopWindSpeedMps / blTopWindDirDeg / blWindShearMps / buoyancyShearRatio',
    status: 'added-in-v2',
    notes:
      'Vector wind difference between 10 m and resolvedThermalTopM, plus Buoyancy/Shear ratio coupled to thermalVelocityV2Mps.',
  },
  {
    parameter: 'Geometric vertical velocity & BL max up/down motion',
    drjackId: 'wblmaxmin / press850..600',
    wxtoflyUnit: 'cm/s or ft/min',
    windgramsV1Field: 'levels[].verticalVelocityPaS (raw omega, Pa/s)',
    windgramsV2Field: 'maxUpwardVelocityMps / minDownwardVelocityMps / w925Mps / w850Mps',
    status: 'converted-in-v2',
    notes:
      'Converts pressure vertical velocity ω (Pa/s) to geometric w = -ω / (ρ·g) using local pressure and dry air density ρ = p/(Rd·T).',
  },
  {
    parameter: 'Horizontal convergence on native grid',
    drjackId: null,
    wxtoflyUnit: null,
    windgramsV1Field: null,
    windgramsV2Field: 'convergence10mX1e5 / convergence925X1e5',
    status: 'no-equivalent-wxtofly-field',
    notes: CONVERGENCE_DISTINCTION,
  },
];
