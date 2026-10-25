import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { selectModels } from '@windgrams/providers/registry';

/** Exercise the installed forecast CLI for each adapter that consumes its profiles. */
export function checkEngines({ sites = 'sites.json', output = 'data' } = {}, execute = spawnSync) {
  const manifestUrl = import.meta.resolve('@azohra/meteo.forecast/package.json');
  const manifest = JSON.parse(readFileSync(new URL(manifestUrl), 'utf8'));
  const cli = fileURLToPath(new URL(manifest.bin.meteo, manifestUrl));
  const models = selectModels({ product: 'processed-profile' }).map(model => model.id);
  for (const model of models) {
    const result = execute(process.execPath, [cli, 'forecast', 'build', '--model', model, '--sites', sites, '--output', output, '--dry-run'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${model} engine check failed (${result.signal ?? result.status})`);
  }
  return models;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { sites: { type: 'string', default: 'sites.json' }, output: { type: 'string', default: 'data' } } });
  checkEngines(values);
}
