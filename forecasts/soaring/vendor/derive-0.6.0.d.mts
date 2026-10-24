import type { DeterministicSiteForecast } from '@azohra/meteo.briefing/contract';

/**
 * Type boundary for the unchanged, pinned 0.6.0 implementation alongside this file.
 * Callers supply normalized scalar source columns; the vendored function produces
 * the deterministic public contract checked by the offline replay fixtures.
 * Keep this declaration separate so type-checking cannot rewrite the baseline.
 */
export declare function deriveSiteForecast(
  source: Record<string, any>,
  model: string,
  semantics: Record<string, string>,
): DeterministicSiteForecast;
