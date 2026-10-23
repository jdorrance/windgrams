// Provider field inventory, DrJack / WxToFly parameter equivalence matrix (v2.0.0),
// complete-run availability table (Feedback 7), and feed lifecycle audit.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_AVAILABILITY_SPECS, REGIONAL_FRESHNESS_DEADLINES } from '../scripts/check-readiness.mjs';

export const DRJACK_WXTOFLY_COMPARISON = [
  {
    parameter: 'W* (Convective velocity scale)',
    drjackId: 'wstar',
    wxtoflyUnit: 'ft/min (and kt/m·s⁻¹)',
    windgramsV1Field: 'derived.thermalVelocityMps',
    windgramsV2Field: 'thermalVelocityV2Mps',
    status: 'audited-consistent-in-v2',
    notes: 'Deardorff convective velocity scale driven by surface virtual heat flux (SHTFL + 0.61·cp/Lv·T·LHTFL) and resolvedDepthM (resolvedThermalTopM - terrainM). Fixes v1/v2 hybrid depth mismatch.'
  },
  {
    parameter: 'Boundary-layer top / thermal top',
    drjackId: 'hbl',
    wxtoflyUnit: 'ft MSL',
    windgramsV1Field: 'derived.boundaryLayerTopM & surface.pblHeightM',
    windgramsV2Field: 'resolvedThermalTopM / boundaryLayerTopM / pblHeightM',
    status: 'separated-in-v2',
    notes: 'v1 used dry parcel crossing with an index===0 jump to 925 hPa when stable. v2 resolves shallow convective boundary layers using HPBL and couples all v2 lift diagnostics to resolvedThermalTopM.'
  },
  {
    parameter: 'Height of critical updraft strength (Hcrit)',
    drjackId: 'experimental1 / hglider',
    wxtoflyUnit: 'ft MSL (225 ft/min = 1.143 m/s sink)',
    windgramsV1Field: 'derived.usableLiftTopM (1.0 m/s sink)',
    windgramsV2Field: 'usableLiftTopV2M (1.0 m/s) & hcritWxtoflyM (1.143 m/s / 225 fpm) & dryHcritM',
    status: 'audited-bounded-in-v2',
    notes: 'Evaluated using resolvedThermalTopM and thermalVelocityV2Mps so hcritWxtoflyM <= usableLiftTopV2M <= dryHcritM <= resolvedThermalTopM holds strictly by construction.'
  },
  {
    parameter: 'Cu cloud base (Surface LCL)',
    drjackId: 'zsfclcl',
    wxtoflyUnit: 'ft MSL',
    windgramsV1Field: 'derived.cloudBaseM (combined min of sfc LCL and first ΔTd<=0.5°C layer)',
    windgramsV2Field: 'surfaceLclM / cloudBaseM',
    status: 'separated-in-v2',
    notes: 'Bolton (1980) surface parcel LCL in meters MSL. Also supported on ECMWF and NWS surface adapters.'
  },
  {
    parameter: 'Cu potential (zsfclcldif)',
    drjackId: 'zsfclcldif',
    wxtoflyUnit: 'ft (BL top minus sfc LCL)',
    windgramsV1Field: null,
    windgramsV2Field: 'cuPotentialM (resolvedThermalTopM - surfaceLclM)',
    status: 'added-in-v2',
    notes: 'Positive values indicate thermal top exceeds surface LCL (cumulus formation likely); negative values indicate blue thermals capped below LCL.'
  },
  {
    parameter: 'Mixed-layer LCL & Overcast Development (OD) potential',
    drjackId: 'zblcl / zblcldif',
    wxtoflyUnit: 'ft MSL / ft',
    windgramsV1Field: null,
    windgramsV2Field: 'mixedLayerLclM / odPotentialM',
    status: 'audited-physical-in-v2',
    notes: 'Computed from boundary-layer mean potential temperature θ and water-vapor mixing ratio r referenced to surface pressure and lifted via Bolton LCL (unexplained 0.85 multiplier removed).'
  },
  {
    parameter: 'Boundary-layer average wind',
    drjackId: 'blwind',
    wxtoflyUnit: 'kt / mph & degrees true',
    windgramsV1Field: null,
    windgramsV2Field: 'blMeanWindSpeedMps / blMeanWindDirDeg',
    status: 'added-in-v2',
    notes: 'Vector average of Earth-rotated (u, v) from 10 m surface wind (and 80 m wind when present) through resolvedThermalTopM.'
  },
  {
    parameter: 'Wind at BL top & BL vertical wind shear',
    drjackId: 'bltopwind / blwindshear / bsratio',
    wxtoflyUnit: 'kt / m·s⁻¹ & dimensionless B/S ratio',
    windgramsV1Field: null,
    windgramsV2Field: 'blTopWindSpeedMps / blTopWindDirDeg / blWindShearMps / buoyancyShearRatio',
    status: 'added-in-v2',
    notes: 'Vector wind difference between 10 m and resolvedThermalTopM, plus Buoyancy/Shear ratio coupled to thermalVelocityV2Mps.'
  },
  {
    parameter: 'Geometric vertical velocity & BL max up/down motion',
    drjackId: 'wblmaxmin / press850..600',
    wxtoflyUnit: 'cm/s or ft/min',
    windgramsV1Field: 'levels[].verticalVelocityPaS (raw omega, Pa/s)',
    windgramsV2Field: 'maxUpwardVelocityMps / minDownwardVelocityMps / w925Mps / w850Mps',
    status: 'converted-in-v2',
    notes: 'Converts pressure vertical velocity ω (Pa/s) to geometric w = -ω / (ρ·g) using local pressure and dry air density ρ = p/(Rd·T).'
  },
  {
    parameter: 'Horizontal convergence on native grid',
    drjackId: 'wblmaxmin / convergence',
    wxtoflyUnit: '×10⁻⁵ s⁻¹',
    windgramsV1Field: null,
    windgramsV2Field: 'convergence10mX1e5 / convergence925X1e5',
    status: 'added-in-v2',
    notes: 'Computed directly on the native 3 km Lambert conformal grid using centered finite differences before reprojection.'
  }
];

export const FEED_LIFECYCLE_AUDIT = {
  auditedAt: '2026-10-22T12:00:00Z',
  completeRunAvailabilitySpecs: FEED_AVAILABILITY_SPECS,
  regionalFreshnessDeadlines: REGIONAL_FRESHNESS_DEADLINES,
  findings: [
    {
      slug: 'nam',
      catalogueSunsetDate: '2026-10-06',
      officialUpdatedTransitionDate: '2026-11-03',
      successor: 'rrfs',
      sourceUrl: 'https://forecast.weather.gov/product.php?format=CI&glossary=1&issuedby=WSH&product=PNS&site=AFC&version=5',
      action: 'Updated local catalogue lifecycle documentation; Windgrams runtime MODEL_ORDER already excludes nam and nam-conus-nest in favor of hrrr-conus and rrfs.'
    },
    {
      slug: 'nam-conus-nest',
      catalogueSunsetDate: '2026-10-06',
      officialUpdatedTransitionDate: '2026-11-03',
      successor: 'rrfs',
      sourceUrl: 'https://forecast.weather.gov/product.php?format=CI&glossary=1&issuedby=WSH&product=PNS&site=AFC&version=5',
      action: 'Excluded from new regional soaring pipelines; retained only as historical metadata entry.'
    },
    {
      slug: 'hrdps-west',
      catalogueSunsetDate: '2027-09-30',
      officialUpdatedTransitionDate: 'Fall 2027 (ECCC experimental datamart removal)',
      successor: 'hrdps-continental',
      sourceUrl: 'https://eccc-msc.github.io/open-data/msc-data/nwp_hrdps/readme_hrdps-datamart-alpha_en/',
      action: 'Audited rotated lat-lon 0.009° (1 km) footprint: covers North Sound/BC border (47.8°–49.0°N) with 9 pressure levels (925–600 hPa) and no vertical velocity (omegaLevels=[]). Treated strictly as an optional point comparison, not regional foundation.'
    }
  ]
};

export function parseHrrrIdxInventory(idxText) {
  const lines = idxText.trim().split(/\r?\n/).filter(Boolean);
  const records = lines.map(line => {
    const [recNum, offset, datePart, variable, level, forecast] = line.split(':');
    return { recordNumber: Number(recNum), offset: Number(offset), datePart, variable, level, forecast };
  });
  const pressureLevelsHpa = [...new Set(
    records
      .filter(r => r.level.endsWith(' mb') && ['TMP', 'DPT', 'HGT', 'UGRD', 'VGRD', 'VVEL'].includes(r.variable))
      .map(r => Number(r.level.replace(' mb', '')))
  )].sort((a, b) => b - a);
  const lowLevelSub925Hpa = pressureLevelsHpa.filter(p => p > 925);
  const explicitCloudAndStabilityFields = records.filter(r =>
    (r.variable === 'HGT' && ['cloud base', 'cloud ceiling', 'cloud top', 'level of adiabatic condensation from sfc', 'level of free convection', 'equilibrium level', '0C isotherm'].includes(r.level)) ||
    ['MAXUVV', 'MAXDVV', 'DZDT', 'CAPE', 'CIN', 'HPBL', 'PLPL'].includes(r.variable)
  ).map(r => ({ variable: r.variable, level: r.level, forecast: r.forecast }));

  return {
    totalRecordsInWrfprs: records.length,
    availablePressureLevelsHpa: pressureLevelsHpa,
    ingestedV1PressureLevelsHpa: [925, 900, 875, 850, 800, 750, 700, 650, 600],
    expandedV2PressureLevelsHpa: [1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 700, 650, 600, 550, 500, 450, 400],
    unharvestedLowPressureLevelsHpa: lowLevelSub925Hpa,
    has80mWind: records.some(r => r.variable === 'UGRD' && r.level === '80 m above ground'),
    explicitCloudAndStabilityFields
  };
}
