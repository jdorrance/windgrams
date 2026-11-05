/** Debounced launch comparisons; retain eight displayed hours and cancel superseded requests. */
import type { AvRegionalDataset, AvSite, AvSample } from '@windgrams/data-client/av';
import { componentsToWind } from '@azohra/meteo.briefing/derive';
import { formatRegionalWind } from '../lib/launch-comparison.ts';
import { formatQuantity } from '../lib/units.ts';
import type { AV_REGIONS } from '../lib/av-regions.ts';
import type { createPageLifecycle } from './page-lifecycle.ts';
export const AV_COMPARE_LAYERS = [
  'thermal-velocity',
  'usable-lift-msl',
  'surface-lcl-msl',
  'wind-10m-u',
  'wind-10m-v',
] as const;
export function createAvLaunchTable(options: {
  dataset: AvRegionalDataset;
  launches: (typeof AV_REGIONS)[number]['geography']['launches']['launches'];
  frame: () => AvRegionalDataset['mapFrames'][number];
  select: (site: AvSite) => void;
  lifetime: ReturnType<typeof createPageLifecycle>;
  offline: boolean;
}) {
  let token = 0,
    delay = 0,
    request: AbortController | null = null;
  const cache = new Map<string, AvSample[]>(),
    { lifetime, dataset, launches } = options;
  lifetime.onDispose(() => {
    request?.abort();
    clearTimeout(delay);
  });
  async function load() {
    request?.abort();
    request = new AbortController();
    const frame = options.frame(),
      current = ++token;
    try {
      let samples = cache.get(frame.id);
      if (!samples) {
        samples = await dataset.sample(
          launches.map((launch) => ({ lat: launch.latitude, lon: launch.longitude })),
          [frame.id],
          AV_COMPARE_LAYERS,
          request.signal,
        );
        cache.set(frame.id, samples);
        while (cache.size > 8) cache.delete(cache.keys().next().value!);
      }
      if (lifetime.disposed || current !== token) return;
      const interpolated = samples.some((sample) =>
        sample.frames.some((frame) => Object.values(frame.layers).some((value) => value.interpolated)),
      );
      document.getElementById('launches-heading')!.textContent =
        `${interpolated ? 'Interpolated launch samples' : 'Launch samples'} · map ceiling at 1.2 m/s sink`;
      const body = document.getElementById('launches-table-body')!;
      body.dataset.validAt = frame.validTime;
      body.hidden = false;
      body.setAttribute('aria-busy', 'false');
      body.replaceChildren(
        ...samples.map((sample, i) => {
          const row = document.createElement('tr'),
            launch = launches[i],
            fields = sample.frames[0].layers,
            u = fields['wind-10m-u'].value,
            v = fields['wind-10m-v'].value;
          const wind = u === null || v === null ? null : componentsToWind(u, v);
          const values = [
            launch.name,
            formatQuantity(fields['thermal-velocity'].value, 'lift'),
            fields['usable-lift-msl'].status === 'no-usable-lift'
              ? 'No usable lift'
              : formatQuantity(fields['usable-lift-msl'].value, 'elevation'),
            formatQuantity(fields['surface-lcl-msl'].value, 'elevation'),
            wind
              ? (formatRegionalWind(wind.speedMps, wind.speedMps === 0 ? null : wind.directionDeg) ??
                'Unavailable')
              : 'Unavailable',
          ];
          for (const value of values) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.append(cell);
          }
          const button = document.createElement('button');
          button.textContent = launch.name;
          button.addEventListener(
            'click',
            () =>
              !lifetime.disposed &&
              options.select({
                slug: launch.slug,
                name: launch.name,
                lat: launch.latitude,
                lon: launch.longitude,
                timeZone: launch.timeZone,
              }),
          );
          row.firstElementChild!.replaceChildren(button);
          return row;
        }),
      );
    } catch (error) {
      if (current === token && !request.signal.aborted) {
        const body = document.getElementById('launches-table-body')!;
        body.replaceChildren();
        body.hidden = false;
        body.setAttribute('aria-busy', 'false');
        const notice = document.getElementById('cell-notice')!;
        notice.textContent = error instanceof Error ? error.message : 'Launch samples unavailable';
        notice.hidden = false;
      }
    }
  }
  return {
    update() {
      if (options.offline) return;
      token++;
      request?.abort();
      const body = document.getElementById('launches-table-body')!;
      body.hidden = true;
      body.setAttribute('aria-busy', 'true');
      clearTimeout(delay);
      delay = window.setTimeout(() => {
        void load();
      }, 150);
    },
  };
}
