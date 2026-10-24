// Keep the package's catalogue and add the locally maintained DWD adapter.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packagedModelsPath } from '@azohra/meteo.forecast';
import { parseModelCatalogue } from '@azohra/meteo.briefing/contract';
import { ICON_FORECAST_HOURS, ICON_SEMANTICS } from './lib/icon-eu.mjs';

export const ICON_MODEL = Object.freeze({
  slug: 'icon-eu', label: 'ICON-EU', provider: 'DWD',
  gridKm: 6.5, stepHours: 1, horizonHours: Math.max(...ICON_FORECAST_HOURS),
  runIntervalHours: 6, typicalPublicationLagHours: 4,
  kind: 'deterministic', experimental: true,
  capabilities: {
    // These are terrain-following model levels with pressure at each cell,
    // rather than fixed isobaric surfaces.
    levels: true, pressureLevels: [], verticalVelocity: false,
    heatFluxes: true, ...ICON_SEMANTICS,
    cape: true, cin: true, pblHeight: true,
    cloudLayers: true, cloudProfile: false, smoke: false,
  },
});

export function modelsCatalogue(base = JSON.parse(readFileSync(packagedModelsPath(), 'utf8'))) {
  const result = { ...base, models: [...base.models.filter(model => model.slug !== 'icon-eu'), ICON_MODEL] };
  if (!parseModelCatalogue(result)) throw new Error('models.json fails the contract guard');
  return result;
}

function main() {
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'data' } } });
  const output = resolve(values.output);
  const document = modelsCatalogue();
  mkdirSync(output, { recursive: true });
  const path = join(output, 'models.json');
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Wrote ${path} (${document.models.length} forecast models)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
}
