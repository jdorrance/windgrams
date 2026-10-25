import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteForecast } from '@azohra/meteo.briefing/contract';
export interface ProfileDiagnosticContext { modelSlug: string; launchElevationM: number | null; inputStage: 'upstream-derived' }
export interface ProfileDiagnosticStrategy {
  id: string; version: string;
  derive(profile: SiteForecast, context: ProfileDiagnosticContext): SiteForecast;
}
/** Rewrite stored profiles with the supplied strategy and return the count. The strategy determines which baseline fields are retained. */
export function postprocessProfiles(outputRoot: string, modelSlug: string, strategy: ProfileDiagnosticStrategy): number {
  if (!strategy.id || !strategy.version) throw new Error('Diagnostics require an explicit implementation identity');
  const directory = join(outputRoot, modelSlug, 'sites');
  if (!existsSync(directory)) return 0;
  const contextPath = join(outputRoot, 'site-context.json');
  const context = existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, 'utf8')) : null;
  let count = 0;
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) continue;
    const slug = file.slice(0, -5), path = join(directory, file);
    const document = JSON.parse(readFileSync(path, 'utf8')) as SiteForecast;
    const updated = strategy.derive(document, { modelSlug, launchElevationM: context?.sites?.[slug]?.elevation?.elevationM ?? null, inputStage: 'upstream-derived' });
    writeFileSync(path, JSON.stringify(updated) + '\n');
    count++;
  }
  return count;
}
