// Provider inventory entry point. Scientific comparison meanings live in definitions.mjs;
// this module owns availability and feed lifecycle evidence.
import { FEED_AVAILABILITY_SPECS, REGIONAL_FRESHNESS_DEADLINES } from '../scripts/check-readiness.mjs';

export { PROVIDER_COMPARISON_DEFINITIONS as DRJACK_WXTOFLY_COMPARISON } from './definitions.mjs';

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
