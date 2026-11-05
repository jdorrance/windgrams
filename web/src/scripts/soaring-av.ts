/** Compose live or saved AV regional controls around one pinned dataset. */
import {
  openAvRegionalDataset,
  avModel,
  createAvSnapshotRepository,
  type AvSite,
  type AvSavedSnapshot,
} from '@windgrams/data-client/av';
import { createBrowserSnapshotStore } from '@windgrams/data-client/offline-browser';
import { modelDescriptor } from '@windgrams/providers/registry';
import { AV_REGIONS } from '../lib/av-regions.ts';
import { localTime, legacyReplayModel } from '../lib/soaring.ts';
import { createFreshnessNotice } from './freshness-notice.ts';
import { createPageLifecycle } from './page-lifecycle.ts';
import { createAvSoaringMap } from './soaring-av-map.ts';
import { createAvPointView } from './soaring-av-point.ts';
import { createAvRouteView } from './soaring-av-route.ts';
import { createAvLaunchTable } from './soaring-av-table.ts';
import { createAvOfflineControls } from './soaring-av-offline.ts';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => {
  const node = el(id);
  if (node) node.textContent = text;
};
const siteFor = (launch: {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}): AvSite => ({ ...launch, lat: launch.latitude, lon: launch.longitude });
function selectOptions(
  select: HTMLSelectElement,
  entries: readonly { value: string; label: string }[],
  value: string,
) {
  select.replaceChildren(
    ...entries.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      return option;
    }),
  );
  select.value = value;
}
export async function startAvSoaring(apiBaseUrl: string): Promise<boolean> {
  const query = new URLSearchParams(location.search),
    caseId = query.get('case');
  if (caseId && !caseId.endsWith('-live')) return false;
  const explicit = query.get('model') ?? (caseId ? legacyReplayModel(caseId) : undefined);
  if (explicit && !avModel(explicit)) return false;
  const region =
    AV_REGIONS.find((region) => region.id === query.get('region') || caseId?.startsWith(region.id)) ??
    AV_REGIONS.find((region) => region.id === (query.get('country') === 'US' ? 'north-sound' : 'armenia'))!;
  if (query.has('region') && !AV_REGIONS.some((region) => region.id === query.get('region')))
    throw new Error('AV regional geography unavailable');
  const model = explicit && avModel(explicit) ? explicit : region.models[0];
  if (!region.models.includes(model)) throw new Error('AV model does not cover this region');
  let timer: number | undefined,
    initialized = false;
  function stopPlay() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    set('replay-play', '▶ Play');
  }
  const lifetime = createPageLifecycle({
      onSuspend: stopPlay,
      onRestore() {
        if (initialized) render();
      },
    }),
    events = { signal: lifetime.signal },
    offline = !!query.get('offline');
  let saved: AvSavedSnapshot | null = null;
  if (offline) {
    const store = createBrowserSnapshotStore();
    lifetime.onDispose(() => {
      void store.close();
    });
    try {
      saved = await createAvSnapshotRepository(store, { apiBaseUrl, signal: lifetime.signal }).open(
        query.get('offline')!,
      );
      if (!saved) throw new Error('Saved AV profiles unavailable');
    } catch (error) {
      lifetime.dispose();
      throw error;
    }
  }
  let dataset: Awaited<ReturnType<typeof openAvRegionalDataset>>;
  try {
    dataset = await openAvRegionalDataset({
      apiBaseUrl,
      model,
      signal: lifetime.signal,
      offline,
      client: saved?.client,
    });
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
  if (lifetime.disposed) return true;
  const frames = dataset.mapFrames,
    launches = region.geography.launches.launches,
    primary = launches.find((launch) => launch.slug === region.primarySite) ?? launches[0];
  let index = Math.max(
    0,
    frames.findIndex((frame) => frame.id === saved?.inventory.frames[0]),
  );
  const initial =
    saved?.inventory.site ??
    (saved
      ? { ...siteFor(primary), slug: 'saved-point', name: 'Saved location', ...saved.inventory.points[0] }
      : siteFor(launches.find((launch) => launch.slug === query.get('launch')) ?? primary));
  const map = createAvSoaringMap(
    el('soaring-map'),
    region.bbox,
    dataset,
    (lat, lon) => {
      void points.select({
        slug: 'selected-point',
        name: 'Selected location',
        lat,
        lon,
        timeZone: initial.timeZone,
      });
    },
    offline,
  );
  const frame = () => frames[index];
  const points = createAvPointView({
    dataset,
    initialSite: initial,
    initialTime:saved?.inventory.pointTime,
    lifetime,
    mapTime: () => frame().validTime,
    selectMapTime(time) {
      const next = frames.findIndex((frame) => frame.validTime === time);
      if (next < 0) return false;
      selectFrame(next);
      return true;
    },
    onPoint(site) {
      map.select(site.lat, site.lon);
      el<HTMLSelectElement>('replay-launch-select').value = site.slug;
    },
    launchElevation: (site) => launches.find((launch) => launch.slug === site.slug)?.launchElevationM ?? null,
  });
  const route = createAvRouteView({
    dataset,
    region,
    frame,
    timeZone: () => points.site().timeZone,
    select: (site) => {
      void points.select(site);
    },
    lifetime,
    offline,
    saved: saved?.inventory.route,
  });
  const table = createAvLaunchTable({
    dataset,
    launches,
    frame,
    select: (site) => {
      void points.select(site);
    },
    lifetime,
    offline,
  });
  lifetime.onDispose(() => map.dispose());
  el('replay-content').hidden = false;
  el('replay-status').hidden = true;
  set('replay-title', `Soaring · ${region.name}`);
  set(
    'replay-run',
    `${model.toUpperCase()} · ${dataset.build.manifest.cycle} · AV${offline ? ' · SAVED NATIVE PROFILES' : ''}`,
  );
  createFreshnessNotice(
    el('replay-freshness'),
    () => ({
      referenceTime: dataset.build.manifest.cycle,
      validUntil: dataset.build.manifest.frames.at(-1)?.validTime,
      policy: modelDescriptor(model).catalogue,
      historical: offline,
    }),
    lifetime.signal,
  );
  set(
    'replay-legend',
    offline
      ? 'Saved native point and route profiles'
      : 'Terrain-column usable lift · 1.2 m/s sink · heights MSL. Point windgrams use native V2 diagnostics.',
  );
  for (const id of ['toggle-barbs', 'additional-layers']) el<HTMLInputElement>(id).closest('label')!.hidden = true;
  for (const id of ['regional-nws', 'model-information']) if (el(id)) el(id).hidden = true;
  el('launch-details-body').closest('details')!.hidden = true;
  const modelSelect = el<HTMLSelectElement>('replay-model-select'),
    regionSelect = el<HTMLSelectElement>('replay-region-select'),
    launchSelect = el<HTMLSelectElement>('replay-launch-select'),
    layerSelect = el<HTMLSelectElement>('replay-layer');
  selectOptions(
    modelSelect,
    region.models.map((value) => ({ value, label: value.toUpperCase() })),
    model,
  );
  selectOptions(
    regionSelect,
    AV_REGIONS.map((region) => ({ value: region.id, label: region.name })),
    region.id,
  );
  selectOptions(
    launchSelect,
    launches.map((launch) => ({ value: launch.slug, label: launch.name })),
    initial.slug,
  );
  selectOptions(
    layerSelect,
    Object.keys(dataset.build.templates).map((value) => ({
      value,
      label:
        value === 'precip-rate'
          ? 'Precipitation rate'
          : value === 'usable-lift-agl'
            ? 'Usable lift · 1.2 m/s · AGL'
            : 'Usable lift · 1.2 m/s · MSL',
    })),
    'usable-lift-msl',
  );
  const navigate = (key: string, value: string) => {
    const url = new URL(location.href);
    url.searchParams.delete('case');
    url.searchParams.set(key, value);
    if (key === 'region') url.searchParams.delete('model');
    location.assign(url);
  };
  modelSelect.addEventListener('change', () => navigate('model', modelSelect.value), events);
  regionSelect.addEventListener('change', () => navigate('region', regionSelect.value), events);
  launchSelect.addEventListener(
    'change',
    () => {
      const launch = launches.find((launch) => launch.slug === launchSelect.value);
      if (launch) void points.select(siteFor(launch));
    },
    events,
  );
  layerSelect.addEventListener('change', render, events);
  if (offline) {
    for (const select of [modelSelect, regionSelect, launchSelect, layerSelect]) select.disabled = true;
    el('launches-table').closest('section')!.hidden = true;
    el<HTMLButtonElement>('select-blanchard').disabled = true;
  }
  const slider = el<HTMLInputElement>('replay-hour');
  slider.min = '0';
  slider.max = String(frames.length - 1);
  slider.step = '1';
  function selectFrame(next: number) {
    index = Math.max(0, Math.min(frames.length - 1, next));
    points.setTime(frame().validTime);
    render();
    table.update();
  }
  slider.addEventListener('input', () => selectFrame(Number(slider.value)), events);
  el('replay-prev').addEventListener('click', () => selectFrame(index - 1), events);
  el('replay-next').addEventListener('click', () => selectFrame(index + 1), events);
  el('replay-play').addEventListener(
    'click',
    () => {
      if (timer !== undefined) {
        stopPlay();
        return;
      }
      set('replay-play', 'Pause');
      timer = window.setInterval(() => selectFrame((index + 1) % frames.length), 1500);
    },
    events,
  );
  el('select-blanchard').addEventListener(
    'click',
    () => {
      void points.select(siteFor(primary));
    },
    events,
  );
  createAvOfflineControls({
    apiBaseUrl,
    dataset,
    regionId: region.id,
    site: points.site,
    pointTime:points.time,
    frame,
    route: route.scope,
    lifetime,
    offline,
  });
  function render() {
    if (lifetime.disposed) return;
    slider.value = String(index);
    set('replay-valid', localTime(frame().validTime, points.site().timeZone));
    map.draw(frame().id, layerSelect.value);
    points.render();
    route.render();
  }
  initialized = true;
  render();
  table.update();
  void points.select(initial);
  return true;
}
