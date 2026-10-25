import { fileURLToPath } from 'node:url';

/** One explicit dataset selection for the dev server, preview and page banner. */
export function localDataConfiguration(env = process.env) {
  const mode = env.WINDGRAMS_DATA_MODE ?? 'forecasts';
  if (mode !== 'forecasts' && mode !== 'fixtures') throw new Error('WINDGRAMS_DATA_MODE must be forecasts or fixtures');
  if (mode === 'fixtures' && env.PUBLIC_WINDGRAMS_DATA_BASE?.trim()) {
    throw new Error('Fixture mode serves local data; unset PUBLIC_WINDGRAMS_DATA_BASE.');
  }
  return {
    mode,
    sample: mode === 'fixtures',
    root: fileURLToPath(new URL(mode === 'fixtures' ? '../dev-data/' : '../../forecasts/data/', import.meta.url)),
  };
}
