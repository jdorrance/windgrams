// Operator budgets stay sequential; each model has independent last-good recovery.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { PROVIDER_GROUPS, modelDescriptor } from '@windgrams/providers/registry';
import { executeModelTasks, validateModelDirectory } from '@windgrams/pipeline';
import { buildModel } from './build-covered.mjs';
import { validateIconDataset } from './build-icon.mjs';
import { beginProviderAttempt, finishProviderAttempt } from './lib/provider-health.mjs';

async function buildProviderModel(options) {
  if (options.model !== 'icon-eu') return buildModel(options);
  // Keep the native operator's acquisition, validation and transaction intact.
  const command = fileURLToPath(new URL('./build-icon.mjs', import.meta.url));
  await new Promise((resolveCommand, reject) => {
    const child = spawn(process.execPath, [command, '--output', resolve(options.output ?? 'data'), '--sites', resolve(options.sites ?? 'sites.json')], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveCommand() : reject(new Error(`ICON build ${signal ? `terminated by ${signal}` : `exited ${code}`}`)));
  });
  return validateIconDataset(resolve(options.output ?? 'data'), JSON.parse(readFileSync(resolve(options.sites ?? 'sites.json'), 'utf8')).sites);
}

export async function runProvider(group, options = {}, { build = buildProviderModel, validate = validateModelDirectory, now = () => new Date().toISOString() } = {}) {
  const models = Object.hasOwn(PROVIDER_GROUPS, group) ? PROVIDER_GROUPS[group] : null;
  if (!models) throw new Error(`Unknown provider group: ${group}`);
  const output = resolve(options.output ?? 'data');
  const results = [];
  for (const model of models) {
    const attemptedAt = now();
    beginProviderAttempt(output, group, model, attemptedAt);
    const [result] = await executeModelTasks([{ model,
      build: () => build({ ...options, model }),
      lastGood: async () => model === 'icon-eu' && validate === validateModelDirectory
        ? validateIconDataset(output, JSON.parse(readFileSync(resolve(options.sites ?? 'sites.json'), 'utf8')).sites)
        : validate(output, { model, expectedForecastHours: modelDescriptor(model).forecastHours }),
    }], 1);
    finishProviderAttempt(output, group, model, attemptedAt, now(), result.status, result.error ?? null);
    results.push(result);
  }
  return results;
}
async function main() {
  const { values } = parseArgs({ options: { group: { type: 'string' }, sites: { type: 'string', default: 'sites.json' }, output: { type: 'string', default: 'data' }, 'readiness-attempts': { type: 'string' }, 'readiness-delay-ms': { type: 'string' } } });
  const results = await runProvider(values.group, values);
  for (const result of results) console.log(`${result.model}: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
  const degraded = results.filter(result => result.status !== 'updated');
  for (const result of degraded) console.warn(`::warning::${result.model} refresh ${result.status}; see health/${values.group}.json and provider logs.`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${values.group} refresh\n\n${results.map(result => `- ${result.model}: ${result.status}`).join('\n')}\n`);
  // Pack all successfully built/retained models even when one first run failed.
  if (results.length && results.every(result => result.status === 'unavailable')) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
