import { publishedLiftFamily, type PublishedForecastHour } from '@windgrams/contracts/published-lift';
import { finiteScalar, formatQuantity } from './units.ts';

/** Explain published support metadata; never infer missing provenance or a quality score. */
export function forecastDataSupport(hour: PublishedForecastHour) {
  const sampling = hour.soaring?.verticalResolution?.sampling;
  const support = hour.soaring?.diagnosticSupport;
  const rows: [string, string][] = [];
  const height = (value: number | null | undefined, datum: string) => value == null ? 'unavailable' : `${formatQuantity(value, 'elevation')} ${datum}`.trim();
  if (sampling) {
    for (const [key, label] of [['temperature', 'Temperature'], ['moisture', 'Moisture'], ['wind', 'Wind']] as const) {
      const field = sampling[key];
      rows.push([`${label} profile`, `First native level: ${height(field.firstLevelAglM, 'above model ground')} · ${field.levelsInLowest1000M} native levels in the lowest ${formatQuantity(1000, 'elevation')} · largest measured gap there: ${height(field.maxGapInLowest1000M, '')}`]);
    }
  } else rows.push(['Native level support', 'Not published for this forecast. Smooth chart shading does not add measured levels.']);
  const pbl = finiteScalar(hour.surface.pblHeightM);
  rows.push(['Native model boundary-layer depth', height(pbl, 'above model ground')]);
  if (support) {
    const branch = {
      unavailable: 'Unavailable', 'non-convective': 'Non-convective',
      'model-pbl-fallback': 'Model boundary-layer fallback', 'heat-flux-fallback': 'Heat-flux fallback',
      'parcel-crossing': 'Parcel/environment crossing', 'profile-top': 'Limited by highest available level',
    }[support.thermalDepth.branch];
    const bracket = support.thermalDepth.bracketMslM;
    rows.push(['Thermal depth support', `${branch}${bracket ? ` · bracket: ${height(bracket[0], 'MSL')} to ${height(bracket[1], 'MSL')}` : ' · no crossing bracket'}`]);
    rows.push(['Cloud limit source', { 'baseline-cloud-base': 'Published baseline cloud-base diagnostic', 'surface-lcl': 'Surface-parcel LCL', unavailable: 'Unavailable' }[support.cloudLimit.source]]);
    rows.push(['Surface pressure', `${support.surfacePressure.valueHpa == null ? 'Unavailable' : formatQuantity(support.surfacePressure.valueHpa, 'pressure')} · ${support.surfacePressure.source === 'model' ? 'model pressure' : 'hypsometric estimate'}`]);
  } else if (publishedLiftFamily(hour) === 'v1-legacy') {
    rows.push(['Diagnostic support', 'Not published for this forecast; the earlier method (v1) lift diagnostics are shown instead.']);
  } else rows.push(['Diagnostic support', 'Not published for this forecast.']);
  // Consequential limitations stay visible outside the collapsed support details:
  // a fallback thermal top or sparse native sampling can move the headline heights.
  const branch = support?.thermalDepth.branch;
  const lowLevels = sampling?.temperature.levelsInLowest1000M;
  const sparse = hour.soaring?.verticalResolution?.isSparseProfile === true || (lowLevels != null && lowLevels <= 2);
  const caution = branch === 'model-pbl-fallback' || branch === 'heat-flux-fallback'
    ? 'Thermal top here comes from a fallback estimate, not a resolved parcel crossing — added model levels can move it substantially.'
    : sparse
      ? `Thermal estimates rest on sparse native levels${lowLevels != null ? ` (${lowLevels} in the lowest ${formatQuantity(1000, 'elevation')})` : ''}; added model levels can move them substantially.`
      : null;
  return {
    rows,
    caution,
    limit: support?.thermalDepth.topLimited ? 'Thermal depth reaches the highest available model level; its upper boundary is unresolved.' : null,
  };
}
