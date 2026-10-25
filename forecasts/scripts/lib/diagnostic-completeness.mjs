// Host publication policy. This validates method availability without recalculating values.
import { parseAtmosphericColumn } from '@windgrams/contracts';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { isEnsembleDocument, sourceFromPublishedDeterministicHour } from '@windgrams/soaring/compatibility';

/** Completeness callback for published point profiles; scientific method stays 2.1.0. */
export function validateCurrentDiagnostics(profile, _referenceTime, slug = profile.site?.id ?? 'profile') {
  const meta = profile.soaringMeta;
  if (meta?.contractVersion !== SOARING_CONTRACT_VERSION) throw new Error(`${slug}: missing or outdated soaring method`);
  if (isEnsembleDocument(profile)) {
    if (meta.modelKind !== 'ensemble-percentiles' || meta.nonlinearMedianPostprocessRefused !== true
      || meta.postprocessAction !== 'retained-upstream-member-percentiles') throw new Error(`${slug}: missing ensemble diagnostic policy`);
    // Upstream ensemble percentiles need no scalar soaring block. Never derive selected medians.
    return;
  }
  if (meta.modelKind !== 'deterministic-column') throw new Error(`${slug}: wrong soaring diagnostic kind`);
  for (const hour of profile.hours ?? []) {
    const at = `${slug} ${hour.validAt}`;
    if (!Object.hasOwn(hour, 'soaring')) throw new Error(`${at}: missing soaring diagnostics`);
    if (hour.soaring === null) {
      const source = parseAtmosphericColumn(sourceFromPublishedDeterministicHour(hour));
      if (source && Number.isFinite(profile.site?.modelElevationM)
        && source.levels.filter(level => level.heightM > profile.site.modelElevationM + 20).length >= 3) {
        throw new Error(`${at}: unexplained unavailable soaring diagnostics`);
      }
      continue;
    }
    const diagnostics = hour.soaring;
    if (diagnostics?.contractVersion !== SOARING_CONTRACT_VERSION) throw new Error(`${at}: missing or outdated soaring method`);
    if (!Number.isFinite(diagnostics.thermalVelocityV2Mps) || diagnostics.thermalVelocityV2Mps < 0
      || !diagnostics.verticalResolution || diagnostics.verticalResolution.synthesizedLevels !== 0) throw new Error(`${at}: invalid soaring diagnostic structure`);
    for (const field of ['resolvedThermalTopM', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'surfaceLclM', 'effectiveCloudLimitM', 'mixedLayerLclM']) {
      if (!Object.hasOwn(diagnostics, field) || diagnostics[field] !== null && !Number.isFinite(diagnostics[field])) throw new Error(`${at}: invalid ${field}`);
    }
  }
}
