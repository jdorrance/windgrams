// Opt-in source experiment: capture normalized point/area columns without changing publication.
import { access, open, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { acquireNoaa } from '@windgrams/providers/noaa';
import { modelDescriptor } from '@windgrams/providers/registry';

export async function captureNoaaColumns(values, { acquire = acquireNoaa } = {}) {
  if (!values.model || !values['reference-time'] || !values.hours || !values.output || (!values.sites && !values.bounds)) {
    throw new Error('Required: --model hrrr-conus|rrfs|gfs --reference-time ISO-UTC --hours 1,2,... --sites catalogue.json and/or --bounds west,south,east,north --output new-file.json');
  }
  const catalogue = values.sites ? JSON.parse(await readFile(values.sites, 'utf8')) : null;
  const sites = catalogue ? (Array.isArray(catalogue) ? catalogue : catalogue.sites) : undefined;
  if (catalogue && !Array.isArray(sites)) throw new Error('--sites requires an array or a catalogue with sites');
  const schedule = modelDescriptor(values.model).forecastHours;
  const hours = values.hours === 'all' ? [...schedule] : values.hours.split(',').map(Number);
  const bounds = values.bounds?.split(',').map(Number);
  if (bounds && bounds.length !== 4) throw new Error('--bounds requires west,south,east,north');
  const output = resolve(values.output), lock = `${output}.capture.lock`;
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(lock, 'wx');
  try {
    // Reserve this experiment before downloading; concurrent captures cannot replace it.
    for (const file of [output, `${output}.metrics.json`]) {
      try { await access(file); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error(`EEXIST: experiment already exists: ${file}`);
    }
    const startedAt = new Date().toISOString(), start = performance.now();
    const acquisition = await acquire({
      model: values.model, referenceTime: values['reference-time'], forecastHours: hours,
      sites, bounds, cacheDir: resolve(values.cache ?? '.soaring-cache/normalized-noaa'), verticalMode: values.mode ?? 'legacy-pressure',
      ...(values.offline ? { fetchImpl: () => { throw new Error('Offline cache miss for the requested run/hour'); } } : {}),
    });
    const metrics = {
      startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start),
      sourceBytes: acquisition.assets.reduce((sum, asset) => sum + asset.size, 0), sourceAssets: acquisition.assets.length,
      offline: values.offline === true,
      fullHorizon: acquisition.hours.length === schedule.length && acquisition.hours.every((hour, index) => hour.forecastHour === schedule[index]),
      note: 'Source bytes include reused cache objects; elapsed time describes this invocation only.',
    };
    await writeFile(output, `${JSON.stringify(acquisition)}\n`, { flag: 'wx' });
    await writeFile(`${output}.metrics.json`, `${JSON.stringify(metrics, null, 2)}\n`, { flag: 'wx' });
    return {
      output, ...metrics, captureStatus: acquisition.completeness, publicationReady: false,
      mode: acquisition.verticalMode, cells: acquisition.cells.length, hours: acquisition.hours.length,
      missingColumns: acquisition.hours.reduce((count, hour) => count + hour.columns.filter(column => column === null).length, 0),
    };
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { ...Object.fromEntries(['model', 'reference-time', 'hours', 'sites', 'bounds', 'cache', 'mode', 'output'].map(name => [name, { type: 'string' }])), offline: { type: 'boolean' } } });
  console.log(JSON.stringify(await captureNoaaColumns(values), null, 2));
}
