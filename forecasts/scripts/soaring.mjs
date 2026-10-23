#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readJson } from '../soaring/common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Soaring replay requires Node 24 (same runtime as CI)');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    case: { type: 'string' }, cache: { type: 'string' }, output: { type: 'string' },
    model: { type: 'string' }, 'reference-time': { type: 'string' },
  } });
  const [command] = positionals;
  if (!['capture','replay'].includes(command) || positionals.length !== 1 || !/^[a-z0-9-]+$/.test(values.case ?? '')) {
    throw new Error('Usage: soaring.mjs capture|replay --case north-sound-20261021-00z [--cache DIR] [--output DIR]');
  }
  let c = await readJson(resolve(root, 'soaring/cases', `${values.case}.json`));
  if (values.model || values['reference-time']) {
    const { buildLiveCaseSpec } = await import('./build-live-soaring.mjs');
    c = buildLiveCaseSpec(c, values['reference-time'] ?? c.referenceTime, values.model ?? 'hrrr-conus');
  }
  const cache = resolve(values.cache ?? resolve(root, '.soaring-cache', c.id));
  if (command === 'capture') {
    const { capture } = await import('../soaring/capture.mjs');
    await capture(c, cache);
    console.log(`Capture complete: ${cache}`);
  } else {
    // No fetch implementation is imported or called by replay.
    const { replay } = await import('../soaring/replay.mjs');
    const output = resolve(values.output ?? resolve(root, 'data/soaring/v1'));
    const result = await replay(c, cache, output);
    console.log(`Replay complete: ${result.path}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
