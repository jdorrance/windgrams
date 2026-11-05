/** AV raster overlay over the shared basemap; point clicks preserve exact coordinates. */
import { Marker, type RasterTileSource } from 'maplibre-gl';
import { baseMap, onMapReady } from './map.ts';
import type { AvRegionalDataset } from '@windgrams/data-client/av';
export function createAvSoaringMap(
  host: HTMLElement,
  bbox: [number, number, number, number],
  dataset: AvRegionalDataset,
  onPoint: (lat: number, lon: number) => void,
  offline = false,
) {
  const [w, s, e, n] = bbox,
    map = baseMap(host, {
      center: [(w + e) / 2, (s + n) / 2],
      zoom: 8,
      basemap: offline ? 'offline' : 'opentopo',
    });
  let frame = '',
    layer = '',
    drawnLayer = '',
    ready = false,
    disposed = false;
  const marker = new Marker().setLngLat([(w + e) / 2, (s + n) / 2]).addTo(map);
  const draw = () => {
    if (!ready || disposed || !frame || !layer || offline) return;
    if (drawnLayer === layer && map.getSource('av-raster')) {
      (map.getSource('av-raster') as RasterTileSource).setTiles([dataset.tileUrl(frame, layer)]);
      return;
    }
    drawnLayer = layer;
    if (map.getLayer('av-raster')) map.removeLayer('av-raster');
    if (map.getSource('av-raster')) map.removeSource('av-raster');
    map.addSource('av-raster', {
      type: 'raster',
      tiles: [dataset.tileUrl(frame, layer)],
      tileSize: 256,
      minzoom: 0,
      maxzoom: dataset.tileMaxZoom(layer),
    });
    map.addLayer({
      id: 'av-raster',
      type: 'raster',
      source: 'av-raster',
      paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 0 },
    });
  };
  onMapReady(map, () => {
    if (disposed) return;
    ready = true;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 20, duration: 0 },
    );
    draw();
  });
  map.on('click', (event) => {
    if (!offline) onPoint(event.lngLat.lat, event.lngLat.lng);
  });
  return {
    draw(nextFrame: string, nextLayer: string) {
      if (frame === nextFrame && layer === nextLayer) return;
      frame = nextFrame;
      layer = nextLayer;
      draw();
    },
    select(lat: number, lon: number) {
      marker.setLngLat([lon, lat]);
    },
    dispose() {
      disposed = true;
      marker.remove();
      map.remove();
    },
  };
}
