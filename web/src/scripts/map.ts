// MapLibre maps, the same basemap stack as the adjacent skyjuice app:
// OpenTopoMap contours by default, Mapterhorn hillshade over streets, plain
// streets, or an offline grey grid. WebGL draws the tiles.

import {
  Map,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSourceSpecification,
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(mapWorkerUrl);

export interface MarkerSpec {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface BaseMapOptions {
  /** [longitude, latitude]. */
  center?: [number, number];
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  /** South-west and north-east corners, [longitude, latitude]. */
  maxBounds?: [[number, number], [number, number]];
  /** When false, the wheel zooms the map only while it is focused. */
  scrollZoom?: boolean;
}

type BasemapId = "opentopo" | "terrain" | "streets" | "offline";

const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: "opentopo", label: "OpenTopo" },
  { id: "terrain", label: "Terrain" },
  { id: "streets", label: "Streets" },
  { id: "offline", label: "Offline" },
];

const STREET_TILES = ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"];
const OPENTOPO_TILES = [
  "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
  "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
  "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
];
const STREET_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
const OPENTOPO_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>, SRTM · © <a href="https://opentopomap.org" target="_blank" rel="noopener noreferrer">OpenTopoMap</a> (CC-BY-SA)';
const TERRAIN_ATTRIBUTION =
  '<a href="https://www.mapterhorn.com" target="_blank" rel="noopener noreferrer">Mapterhorn</a> hillshade';

const style: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#edf1f5" } }],
};

const WORLD = (zoom: number) => 256 * 2 ** zoom;

/** Web Mercator pixel, origin at the north-west, matching the sunlight tiles. */
export function worldPixel(latitude: number, longitude: number, zoom: number) {
  const scale = WORLD(zoom);
  const sin = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/** Geographic edges of one XYZ tile. */
export function tileLngLatBounds(x: number, y: number, zoom: number) {
  const west = (x / 2 ** zoom) * 360 - 180;
  const east = ((x + 1) / 2 ** zoom) * 360 - 180;
  const mercatorLat = (pixelY: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * pixelY) / WORLD(zoom)))) * 180) / Math.PI;
  return { west, east, north: mercatorLat(y * 256), south: mercatorLat((y + 1) * 256) };
}

function whenStyleReady(map: MapLibreMap, run: () => void) {
  if (map.isStyleLoaded()) run();
  else map.once("load", run);
}

/** Insert basemap rasters under the sunlight overlay when that layer exists. */
function beforeOverlay(map: MapLibreMap) {
  return map.getLayer("sunlight") ? "sunlight" : undefined;
}

function ensureRaster(map: MapLibreMap, id: string, tiles: string[], attribution: string, opacity: number, maxzoom: number) {
  if (map.getSource(id)) return;
  map.addSource(id, { type: "raster", tiles, tileSize: 256, attribution, maxzoom });
  map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } }, beforeOverlay(map));
}

function ensureHillshade(map: MapLibreMap) {
  if (map.getSource("mapterhorn")) return;
  map.addSource("mapterhorn", {
    type: "raster-dem",
    url: "https://tiles.mapterhorn.com/tilejson.json",
    tileSize: 512,
    attribution: TERRAIN_ATTRIBUTION,
  });
  map.addLayer({ id: "hillshade", type: "hillshade", source: "mapterhorn", paint: { "hillshade-shadow-color": "#473B24" } }, beforeOverlay(map));
}

function applyBasemap(map: MapLibreMap, basemap: BasemapId) {
  if (basemap === "streets" || basemap === "terrain") ensureRaster(map, "osm", STREET_TILES, STREET_ATTRIBUTION, 0.9, 19);
  if (basemap === "opentopo") ensureRaster(map, "opentopo", OPENTOPO_TILES, OPENTOPO_ATTRIBUTION, 1, 17);
  if (basemap === "terrain") ensureHillshade(map);
  const visibility: Record<string, "visible" | "none"> = {
    osm: basemap === "streets" || basemap === "terrain" ? "visible" : "none",
    opentopo: basemap === "opentopo" ? "visible" : "none",
    hillshade: basemap === "terrain" ? "visible" : "none",
  };
  for (const [id, value] of Object.entries(visibility)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
  }
}

function basemapControl(map: MapLibreMap) {
  const control = document.createElement("div");
  control.className = "maplibregl-ctrl";
  const select = document.createElement("select");
  select.className = "map-basemap";
  select.setAttribute("aria-label", "Basemap");
  for (const choice of BASEMAPS) {
    const option = document.createElement("option");
    option.value = choice.id;
    option.textContent = choice.label;
    option.selected = choice.id === "opentopo";
    select.appendChild(option);
  }
  select.addEventListener("change", () => applyBasemap(map, select.value as BasemapId));
  control.appendChild(select);
  return control;
}

export function baseMap(element: HTMLElement, options: BaseMapOptions = {}) {
  if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
  const map = new Map({
    container: element,
    style,
    center: options.center ?? [0, 0],
    zoom: options.zoom ?? 2,
    minZoom: options.minZoom ?? 2,
    maxZoom: options.maxZoom ?? 17,
    maxBounds: options.maxBounds,
    bearing: 0,
    pitch: 0,
    maxPitch: 0,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
    fadeDuration: 0,
    attributionControl: { compact: false },
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.addControl({ onAdd: () => basemapControl(map), onRemove: () => undefined }, "top-right");
  if (!options.scrollZoom) {
    map.scrollZoom.disable();
    element.addEventListener("focusin", () => map.scrollZoom.enable());
    element.addEventListener("focusout", () => map.scrollZoom.disable());
  }
  map.on("load", () => applyBasemap(map, "opentopo"));
  return map;
}

/** Runs once the style exists, so layers can be added under or over the basemap. */
export function onMapReady(map: MapLibreMap, run: () => void) {
  whenStyleReady(map, run);
}

function dot(fill: string, radius: number, title?: string) {
  const element = document.createElement("span");
  element.className = "map-dot";
  element.style.width = element.style.height = `${radius * 2}px`;
  element.style.background = fill;
  if (title) element.title = title;
  return new Marker({ element, anchor: "center" });
}

export function mountLaunchMap(element: HTMLElement, markers: MarkerSpec[]) {
  const map = baseMap(element);
  const bounds = new MapLibreBounds();
  for (const m of markers) {
    bounds.extend(m.longitude, m.latitude);
    const link = document.createElement("a");
    link.href = `/launches/${m.slug}`;
    link.textContent = m.name;
    dot("#1c5cab", 8)
      .setLngLat([m.longitude, m.latitude])
      .setPopup(new Popup({ offset: 16, closeButton: false }).setDOMContent(link))
      .addTo(map);
  }
  if (markers.length === 0) map.jumpTo({ center: [-116.2, 43.6], zoom: 8 });
  else if (markers.length === 1) map.jumpTo({ center: [markers[0].longitude, markers[0].latitude], zoom: 10 });
  else map.fitBounds(bounds.toArray(), { padding: 40, maxZoom: 10, duration: 0 });
  return map;
}

/** Click to place a point; returns a setter for typed coordinates. */
export function mountPicker(element: HTMLElement, onPick: (lat: number, lon: number) => void, others: MarkerSpec[]) {
  const map = baseMap(element, { scrollZoom: true, center: [-116.1, 43.62], zoom: 9 });
  for (const m of others) dot("#898781", 6, m.name).setLngLat([m.longitude, m.latitude]).addTo(map);
  let marker: Marker | null = null;
  const place = (lat: number, lon: number, pan: boolean) => {
    if (!marker) marker = dot("#eb6834", 9).setLngLat([lon, lat]).addTo(map);
    else marker.setLngLat([lon, lat]);
    if (pan) map.jumpTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 13) });
  };
  map.on("click", (event) => {
    place(event.lngLat.lat, event.lngLat.lng, false);
    onPick(event.lngLat.lat, event.lngLat.lng);
  });
  return {
    set(lat: number, lon: number) {
      if (Number.isFinite(lat) && Number.isFinite(lon)) place(lat, lon, true);
    },
    clear() {
      marker?.remove();
      marker = null;
    },
    invalidate() {
      map.resize();
    },
  };
}

/** Credit line for a source that has no picture of its own. */
export function addAttribution(map: MapLibreMap, id: string, attribution: string) {
  whenStyleReady(map, () => {
    if (map.getSource(id)) return;
    const source: GeoJSONSourceSpecification = { type: "geojson", data: { type: "FeatureCollection", features: [] }, attribution };
    map.addSource(id, source);
    map.addLayer({ id, type: "circle", source: id, paint: { "circle-opacity": 0 } });
  });
}

class MapLibreBounds {
  private west = Infinity;
  private south = Infinity;
  private east = -Infinity;
  private north = -Infinity;
  extend(longitude: number, latitude: number) {
    this.west = Math.min(this.west, longitude);
    this.south = Math.min(this.south, latitude);
    this.east = Math.max(this.east, longitude);
    this.north = Math.max(this.north, latitude);
  }
  toArray(): [[number, number], [number, number]] {
    return [
      [this.west, this.south],
      [this.east, this.north],
    ];
  }
}
