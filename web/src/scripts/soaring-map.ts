import { Marker, type ExpressionSpecification, type GeoJSONSource, type GeoJSONSourceSpecification, type Map as MapLibreMap } from 'maplibre-gl';
import { formatQuantity } from '../lib/units.ts';
import { windBarbImage, windBarbs } from '../lib/map-wind.ts';
import { LAYER_SPECS, type Layer, type ReplayHour } from '../lib/soaring.ts';
import type { CrossSectionDoc, LaunchEntry, Grid } from '../lib/soaring-contracts.ts';
import { baseMap, onMapReady } from './map.ts';

export interface SoaringMapOptions {
  host: HTMLElement;
  bbox: [number, number, number, number];
  grid: Grid;
  siteCell: number;
  site: { slug?: string; name: string; latitude: number; longitude: number };
  launches: readonly LaunchEntry[];
  crossSectionDoc: CrossSectionDoc | null;
  onSelectCell: (cellIndex: number, launchSlug?: string) => void;
}

export interface SoaringMapState {
  hour: ReplayHour;
  layer: Layer;
  showBarbs: boolean;
  selectedCell: number;
}

const LIFT_TOP_LAYERS = new Set<Layer>([
  'usableLiftTopV2M',
  'usableLiftTopM',
  'hcritWxtoflyM',
  'dryHcritM',
  'resolvedThermalTopM',
]);

const QUALITY_SENSITIVE_LAYERS = new Set<Layer>([
  'thermalVelocityV2Mps',
  'thermalVelocityMps',
  'usableLiftTopV2M',
  'usableLiftTopM',
  'resolvedThermalTopM',
  'boundaryLayerTopM',
  'hcritWxtoflyM',
  'dryHcritM',
]);

export function createSoaringMap(options: SoaringMapOptions) {
  const { host, bbox, grid, siteCell, site, launches, crossSectionDoc, onSelectCell } = options;
  const [west, south, east, north] = bbox;
  const map: MapLibreMap = baseMap(host, { center: [(west + east) / 2, (south + north) / 2], zoom: 8 });
  const markers: Marker[] = [];
  const cellCoordinates = grid.features.map(feature => feature.properties);

  if (launches.length) {
    for (const l of launches) {
      const m = document.createElement('div');
      const isPrimary = l.slug === site.slug || l.cellIndex === siteCell;
      m.style.cssText = `background:${isPrimary ? '#111' : '#237e81'};border:2.5px solid white;border-radius:50%;width:${isPrimary ? 17 : 13}px;height:${isPrimary ? 17 : 13}px;box-shadow:0 0 0 1.5px #111;cursor:pointer`;
      m.title = `${l.name} launch (${formatQuantity(l.launchElevationM, 'elevation')} MSL)`;
      m.addEventListener('click', e => {
        e.stopPropagation();
        onSelectCell(l.cellIndex, l.slug);
      });
      markers.push(new Marker({ element: m }).setLngLat([l.longitude, l.latitude]).addTo(map));
    }
  } else {
    const marker = document.createElement('div');
    marker.style.cssText = 'background:#111;border:3px solid white;border-radius:50%;width:17px;height:17px;box-shadow:0 0 0 2px #111';
    marker.title = `${site.name} launch`;
    markers.push(new Marker({ element: marker }).setLngLat([site.longitude, site.latitude]).addTo(map));
  }

  let ready = false;
  let disposed = false;
  let pendingState: SoaringMapState | null = null;
  let drawnHour: ReplayHour | undefined;
  let drawnLayer: Layer | undefined;
  let drawnBarbs: boolean | undefined;

  function applyState(state: SoaringMapState) {
    if (disposed) return;
    pendingState = state;
    if (!ready) return;

    const { hour, layer, showBarbs, selectedCell } = state;
    map.setFilter('selected-outline', ['==', ['get', 'cellIndex'], selectedCell]);
    if (hour === drawnHour && layer === drawnLayer && showBarbs === drawnBarbs) return;

    drawnHour = hour;
    drawnLayer = layer;
    drawnBarbs = showBarbs;
    const spec = LAYER_SPECS[layer] ?? LAYER_SPECS.thermalVelocityV2Mps;
    const liftTopLayer = LIFT_TOP_LAYERS.has(layer);
    const qualitySensitive = QUALITY_SENSITIVE_LAYERS.has(layer);
    const arr = (hour[layer] as (number | null)[] | undefined) ?? [];

    const data = {
      ...grid,
      features: grid.features.map((f, i) => ({
        ...f,
        properties: {
          ...f.properties,
          quality:
            arr[i] === undefined
              ? 'missing'
              : qualitySensitive
                ? hour.status[i]
                : arr[i] === null
                  ? 'missing'
                  : 'valid',
          value: arr[i] === null || arr[i] === undefined ? null : arr[i]! * spec.scale,
        },
      })),
    };
    (map.getSource('lift') as GeoJSONSource | undefined)?.setData(data as GeoJSONSourceSpecification['data']);
    const expression = [
      'case',
      ['==', ['get', 'quality'], 'missing'], '#9ca3af',
      ['==', ['get', 'quality'], 'insufficient-levels'], '#9573b2',
      ['==', ['get', 'value'], null], liftTopLayer ? '#e5d9bd' : '#9ca3af',
      ['interpolate', ['linear'], ['coalesce', ['get', 'value'], 0], ...spec.stops.flatMap((v, i) => [v, spec.colors[i]])],
    ] as ExpressionSpecification;
    map.setPaintProperty('lift-fill', 'fill-color', expression);
    map.setFilter('selected-outline', ['==', ['get', 'cellIndex'], selectedCell]);

    const windSource = map.getSource('wind-vectors') as GeoJSONSource | undefined;
    if (windSource) {
      const useBlWind = layer === 'blMeanWindSpeedMps';
      const wsArr = (useBlWind ? hour.blMeanWindSpeedMps : hour.wind10mSpeedMps) ?? [];
      const wdArr = (useBlWind ? hour.blMeanWindDirDeg : hour.wind10mDirDeg) ?? [];
      const barbs = windBarbs(showBarbs ? cellCoordinates : [], wsArr, wdArr);
      for (const { properties: { icon, barbSpeed } } of barbs.features) {
        if (!map.hasImage(icon)) map.addImage(icon, windBarbImage(barbSpeed), { pixelRatio: 2 });
      }
      windSource.setData(barbs);
    }
  }

  onMapReady(map, () => {
    if (disposed) return;
    map.addSource('lift', { type: 'geojson', data: grid as GeoJSONSourceSpecification['data'] });
    map.addLayer({ id: 'lift-fill', type: 'fill', source: 'lift', paint: { 'fill-opacity': 0.72 } });
    map.addLayer({ id: 'lift-grid', type: 'line', source: 'lift', paint: { 'line-color': '#32464e', 'line-width': 0.45, 'line-opacity': 0.35 } });
    map.addLayer({ id: 'blanchard-outline', type: 'line', source: 'lift', filter: ['==', ['get', 'cellIndex'], siteCell], paint: { 'line-color': '#111', 'line-width': 3 } });
    map.addLayer({ id: 'selected-outline', type: 'line', source: 'lift', paint: { 'line-color': '#fff', 'line-width': 2.2 } });

    if (crossSectionDoc) {
      map.addSource('transect', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: crossSectionDoc.nodes.map(n => [n.longitude, n.latitude]),
          },
        },
      });
      map.addLayer({
        id: 'transect-line',
        type: 'line',
        source: 'transect',
        paint: { 'line-color': '#111', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.75 },
      });
    }

    map.addSource('wind-vectors', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'wind-vectors-barbs',
      type: 'symbol',
      source: 'wind-vectors',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-size': 0.85,
        'icon-padding': 1,
        'icon-allow-overlap': false,
      },
    });

    map.fitBounds([[west, south], [east, north]], { padding: 20, duration: 0 });
    map.on('click', 'lift-fill', event => {
      const index = event.features?.[0]?.properties?.cellIndex;
      if (typeof index === 'number') {
        onSelectCell(index);
      }
    });
    map.on('mouseenter', 'lift-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'lift-fill', () => { map.getCanvas().style.cursor = ''; });
    ready = true;
    if (pendingState) applyState(pendingState);
  });

  return {
    update: applyState,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const marker of markers) marker.remove();
      markers.length = 0;
      map.remove();
    },
  };
}
