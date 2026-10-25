import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSites } from '@azohra/meteo.forecast';

const launches = ['wa-blanchard', 'va-woodstock', 'am-hatis-300'];

export function smokeCatalogue(catalogue) {
  const available = parseSites(catalogue);
  return { ...catalogue, sites: launches.map(slug => {
    const site = available.find(site => site.slug === slug);
    if (!site) throw new Error(`Missing smoke launch: ${slug}`);
    return site;
  }) };
}

export function smokeArguments(probe, directory) {
  if (!['nws', 'ecmwf', 'raob', 'solar'].includes(probe)) throw new Error(`Unknown smoke probe: ${probe}`);
  const args = [fileURLToPath(new URL(`./${probe}.mjs`, import.meta.url)), '--sites', join(directory, 'sites.json'), '--output', join(directory, 'data')];
  if (['ecmwf', 'raob'].includes(probe)) args.push('--notice');
  if (probe === 'solar') args.push('--slug', 'wa-blanchard', '--radius-km', '2', '--max-distance-km', '20', '--ignore-areas');
  return args;
}

export function runBoundedProbe(args, timeoutMs = 90_000) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Probe failed (${result.signal ?? result.status}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'windgrams-smoke-'));
  try {
    const args = smokeArguments(process.argv[2], directory);
    writeFileSync(join(directory, 'sites.json'), JSON.stringify(smokeCatalogue(JSON.parse(readFileSync('sites.json', 'utf8')))));
    runBoundedProbe(args);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
