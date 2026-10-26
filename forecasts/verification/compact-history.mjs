// Validate and migrate retained archive storage without changing issued bytes or retention.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { compressHistoryArchives } from './issued-history.mjs';

if (import.meta.main) {
  const { values } = parseArgs({ options: { data: { type: 'string', default: 'forecasts/data' } } });
  const started = performance.now();
  console.log(JSON.stringify({ ...compressHistoryArchives(resolve(values.data)), elapsedMs: Math.round(performance.now() - started) }));
}
