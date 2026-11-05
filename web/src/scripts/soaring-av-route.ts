/** Load at most sixteen native columns for one route hour, two requests at a time. */
import type { AvProfile, AvRegionalDataset, AvSite, AvSnapshotSelection } from '@windgrams/data-client/av';
import type { CrossSectionDoc } from '@windgrams/contracts/regional';
import { avProfilesToReplayHour } from '../lib/av-point-view.ts';
import { localTime, crossSectionHeightScale } from '../lib/soaring.ts';
import { renderCrossSectionSvg } from '../lib/cross-section-view.ts';
import type { AV_REGIONS } from '../lib/av-regions.ts';
import type { createPageLifecycle } from './page-lifecycle.ts';
const el = (id: string) => document.getElementById(id)!;
export function createAvRouteView(options: {
  dataset: AvRegionalDataset;
  region: (typeof AV_REGIONS)[number];
  frame: () => AvRegionalDataset['mapFrames'][number];
  timeZone: () => string;
  select: (site: AvSite) => void;
  lifetime: ReturnType<typeof createPageLifecycle>;
  saved?: AvSnapshotSelection['route'];
  offline: boolean;
}) {
  const { dataset, lifetime } = options;
  let busy = false,
    loadedFrame = '',
    doc: CrossSectionDoc | null = null,
    profiles: AvProfile[] = [];
  const all = options.region.geography.crossSection.nodes;
  const geography: NonNullable<AvSnapshotSelection['route']> = options.saved ?? {
    title: options.region.geography.crossSection.title,
    totalDistanceKm: options.region.geography.crossSection.totalDistanceKm,
    nodes: all
      .filter((_, i) => i === 0 || i === all.length - 1 || i % Math.ceil(all.length / 14) === 0)
      .map((node) => ({
        point: { lat: node.latitude, lon: node.longitude },
        distanceKm: node.distanceKm,
        waypointLabel: node.waypointLabel,
        launchElevationM: node.launchElevationM,
      })),
  };
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Load route profiles for this hour';
  button.hidden = options.offline && !options.saved;
  el('replay-cross-section').before(button);
  button.addEventListener(
    'click',
    () => {
      void load();
    },
    { signal: lifetime.signal },
  );
  async function load() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const frame = options.frame(),
      next: AvProfile[] = new Array(geography.nodes.length);
    let cursor = 0;
    const controller = new AbortController();
    try {
      const workers = Array.from({ length: 2 }, async () => {
        while (cursor < geography.nodes.length) {
          lifetime.signal.throwIfAborted();
          const i = cursor++;
          try {
            next[i] = await dataset.loadProfile(geography.nodes[i].point, [frame.id], controller.signal);
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        }
      });
      const results = await Promise.allSettled(workers),
        failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (next.some((profile) => profile.cell === null))
        throw new Error('Route extends outside native forecast coverage');
      if (lifetime.disposed) return;
      profiles = next;
      loadedFrame = frame.id;
      doc = {
        title: geography.title,
        totalDistanceKm: geography.totalDistanceKm,
        nodes: geography.nodes.map((node, i) => ({
          nodeIndex: i,
          distanceKm: node.distanceKm,
          latitude: node.point.lat,
          longitude: node.point.lon,
          waypointLabel: node.waypointLabel,
          launchElevationM: node.launchElevationM,
          cellIndex: i,
          gridIndex: profiles[i].cell!.index,
          modelElevationM: profiles[i].frames[0].profile.modelTerrainM,
        })),
      };
      render();
    } catch (error) {
      if (!lifetime.disposed)
        el('replay-cross-section').textContent =
          error instanceof Error ? error.message : 'Route profiles unavailable';
    } finally {
      busy = false;
      button.disabled = false;
    }
  }
  function render() {
    if (!doc || loadedFrame !== options.frame().id) {
      el('replay-cross-section').textContent = 'Load the route for the displayed map hour.';
      return;
    }
    const hour = avProfilesToReplayHour(profiles, loadedFrame);
    el('cross-section-route').textContent =
      `${doc.title} · ${localTime(hour.validAt, options.timeZone())} · ${doc.nodes.length} native columns`;
    el('replay-cross-section').replaceChildren(
      renderCrossSectionSvg(doc, hour, crossSectionHeightScale(doc.nodes, [hour]), -1, (cell) => {
        const node = doc!.nodes[cell];
        options.select({
          slug: 'route-point',
          name: node.waypointLabel ?? 'Route point',
          lat: node.latitude,
          lon: node.longitude,
          timeZone: options.timeZone(),
        });
      }),
    );
  }
  return { render, scope: () => (doc ? geography : undefined) };
}
