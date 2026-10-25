import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const OBSERVATION_SOURCES = ['nws', 'ecmwf', 'raob'];

function execute(source, output) {
  return new Promise((resolveResult, reject) => {
    const script = fileURLToPath(new URL(`./${source}.mjs`, import.meta.url));
    const child = spawn(process.execPath, [script, '--output', output, '--publish'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolveResult() : reject(new Error(`${source} exited ${signal ?? code}`)));
  });
}

/** Independent hosts run together; wait for every source before reporting failure. */
export async function runObservations(output = 'data', run = execute) {
  return Promise.all(OBSERVATION_SOURCES.map(async source => {
    try { await run(source, output); return { source, ok: true }; }
    catch (error) { return { source, ok: false, error: error.message }; }
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string', default: 'data' } } });
  const results = await runObservations(values.output);
  for (const result of results) if (!result.ok) console.error(result.error);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
