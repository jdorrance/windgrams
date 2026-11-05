/** Save the displayed run's selected point and loaded route as verified native profiles. */
import {
  createAvSnapshotRepository,
  type AvRegionalDataset,
  type AvSite,
  type AvSnapshotSelection,
} from '@windgrams/data-client/av';
import { createBrowserSnapshotStore } from '@windgrams/data-client/offline-browser';
import { AV_COMPARE_LAYERS } from './soaring-av-table.ts';
import type { createPageLifecycle } from './page-lifecycle.ts';
export function createAvOfflineControls(options: {
  apiBaseUrl: string;
  dataset: AvRegionalDataset;
  regionId: string;
  site: () => AvSite;
  pointTime:()=>string;
  frame: () => AvRegionalDataset['mapFrames'][number];
  route: () => AvSnapshotSelection['route'];
  lifetime: ReturnType<typeof createPageLifecycle>;
  offline: boolean;
}) {
  const { dataset, lifetime } = options,
    model = dataset.build.manifest.model,
    slot = `${model}-${options.regionId}`,
    notice = document.getElementById('cell-notice')!;
  const link = document.createElement('a'),
    url = new URL(location.href);
  link.textContent = options.offline ? 'Return to live forecast' : 'Open saved point and route profiles';
  if (options.offline) url.searchParams.delete('offline');
  else url.searchParams.set('offline', slot);
  link.href = url.href;
  notice.after(link);
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Save point and loaded route profiles';
  button.hidden = options.offline;
  notice.after(button);
  button.addEventListener(
    'click',
    async () => {
      button.disabled = true;
      const site = options.site(),
        route = options.route(),
        points = [{ lat: site.lat, lon: site.lon }, ...(route?.nodes.map((node) => node.point) ?? [])].filter(
          (point, i, all) => all.findIndex((other) => point.lat === other.lat && point.lon === other.lon) === i,
        );
      const store = createBrowserSnapshotStore();
      try {
        const repo = createAvSnapshotRepository(store, {
          apiBaseUrl: options.apiBaseUrl,
          signal: lifetime.signal,
        });
        const snapshot = await repo.save(slot, {
          model,
          build: dataset.build,
          site,
          pointTime:options.pointTime(),
          route,
          points,
          frames: [options.frame().id],
          layers: AV_COMPARE_LAYERS,
        });
        notice.textContent = `Saved native profiles · ${site.name}${route ? ` and ${route.title}` : ''} · ${(snapshot.inventory.totalBytes / 1048576).toFixed(1)} MiB`;
      } catch (error) {
        notice.textContent = error instanceof Error ? error.message : 'Offline save failed';
      } finally {
        notice.hidden = false;
        button.disabled = false;
        await store.close();
      }
    },
    { signal: lifetime.signal },
  );
}
