// Host publication policy. This validates method availability without recalculating values.
import { parseAtmosphericColumn } from '@windgrams/contracts';
import { SOARING_CONTRACT_VERSION } from '@windgrams/soaring';
import { isEnsembleDocument, sourceFromPublishedDeterministicHour } from '@windgrams/soaring/compatibility';

/** Completeness callback for published point profiles under the current diagnostic method. */
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
    const source = parseAtmosphericColumn(sourceFromPublishedDeterministicHour(hour));
    const terrainM = profile.site?.modelElevationM;
    const canDeriveDiagnostics = source !== null && Number.isFinite(terrainM)
      && source.levels.filter(level => level.heightM > terrainM + 20).length >= 3;
    const hasFluxes = Number.isFinite(source?.sensibleHeatFluxWm2) && Number.isFinite(source?.latentHeatFluxWm2);
    if (hour.soaring === null) {
      if (canDeriveDiagnostics) throw new Error(`${at}: unexplained unavailable soaring diagnostics`);
      continue;
    }
    const diagnostics = hour.soaring;
    if (diagnostics?.contractVersion !== SOARING_CONTRACT_VERSION) throw new Error(`${at}: missing or outdated soaring method`);
    const velocity = diagnostics.thermalVelocityV2Mps;
    if ((velocity !== null && (!Number.isFinite(velocity) || velocity < 0))
      || !diagnostics.verticalResolution || diagnostics.verticalResolution.synthesizedLevels !== 0) throw new Error(`${at}: invalid soaring diagnostic structure`);
    if (source && !hasFluxes && velocity !== null) throw new Error(`${at}: missing heat flux cannot produce thermal velocity`);
    if (velocity === null) {
      if (canDeriveDiagnostics && hasFluxes) throw new Error(`${at}: unexplained unavailable thermal velocity`);
      for (const field of ['usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'buoyancyShearRatio']) {
        if (diagnostics[field] !== null) throw new Error(`${at}: ${field} requires thermal velocity`);
      }
    }
    for (const field of ['resolvedThermalTopM', 'usableLiftTopV2M', 'hcritWxtoflyM', 'dryHcritM', 'surfaceLclM', 'effectiveCloudLimitM', 'mixedLayerLclM']) {
      if (!Object.hasOwn(diagnostics, field) || diagnostics[field] !== null && !Number.isFinite(diagnostics[field])) throw new Error(`${at}: invalid ${field}`);
    }
  }
}
