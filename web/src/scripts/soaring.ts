import { formatQuantity, getUnitSystem } from '../lib/units.ts';
import { fetchWithRetry } from "../lib/http.ts";
import { Marker, type GeoJSONSource, type ExpressionSpecification } from 'maplibre-gl';
import { parseSiteForecast, type SiteForecast } from '@azohra/meteo.briefing/contract';
import { baseMap, onMapReady } from './map.ts';
import { DATA_BASE } from '../lib/site.ts';
import { buildWindgramView } from '../lib/windgram-view.ts';
import { windgramViewport } from '../lib/windgram-viewport.ts';
import { renderWindgramSvg, renderWindgramKey } from '../lib/windgram-chart.ts';
import { buildSounding, readSounding } from '../lib/skewt.ts';
import { SkewTChart } from '../lib/skewt-chart.ts';
import { compassPoint } from '../lib/launches.ts';
import { windBarbs, windBarbImage } from '../lib/map-wind.ts';
import {
  LAYER_SPECS,
  PRIMARY_LAYERS,
  buildCellSiteForecast,
  buildCrossSectionLinePath,
  displayMetric,
  defaultReplayQuery,
  forecastHourAtValidTime,
  historicalLabel,
  modelLabel,
  nativeModels,
  regionForCase,
  replayLocation,
  replayModel,
  replaySelection,
  selectedState,
  setReplaySelectionQuery,
  type Layer,
  type RegionCatalogue,
  type ReplayHour,
  type ReplayManifest,
} from '../lib/soaring.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => { const node = el(id); if (node) node.textContent = text; };

async function read<T>(url: string): Promise<T> {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`Forecast data unavailable (${response.status}).`);
  return response.json();
}

async function readOptional<T>(url: string): Promise<T | null> {
  try {
    const response = await fetchWithRetry(url);
    return response.ok ? (await response.json() as T) : null;
  } catch {
    return null;
  }
}

interface Cell { cellIndex: number; id: string; gridIndex: number; latitude: number; longitude: number; modelElevationM: number | null }
interface Grid { type: 'FeatureCollection'; features: { type: 'Feature'; id: string; properties: Cell; geometry: { type: 'Polygon'; coordinates: number[][][] } }[] }
interface Audit {
  sampledCell: { distanceKm: number }; terrain: { modelElevationM: number; launch: { elevationM: number }; differenceM: number; rawMslHeightsPreserved?: boolean };
  mapProfileAgreement: { exact: boolean; hours: number; valuesChecked: number };
  publishedProfileComparison: { applicable?: boolean; exact: boolean | null; differences: unknown[] }; limitations: string[];
}
interface ExperimentalTerrain {
  experimental: boolean;
  launchElevationM: number;
  modelElevationM: number;
  terrainDeltaM: number;
  bracketsLaunchAltitude: boolean;
  launchWindSpeedMps: number | null;
  launchWindDirectionDeg: number | null;
  rawMslHeightsPreserved: boolean;
  assumptions: string[];
}
interface PercentileSpread {
  p10: number | null;
  p90: number | null;
}
interface LaunchEntry {
  slug: string; name: string; latitude: number; longitude: number; timeZone: string;
  cellIndex: number; gridIndex: number; distanceKm: number; launchElevationM: number | null; modelElevationM: number | null;
  facingDeg?: number; windArcHalfWidthDeg?: number; windMinMph?: number; windMaxMph?: number; gustMaxMph?: number;
  models: Record<string, {
    referenceTime?: string; modelElevationM?: number | null;
    hours: {
      validAt: string; tempC?: number | null; tempSpreadC?: PercentileSpread | null; dewPointC?: number | null;
      windSpeedMps?: number | null; windSpeedSpreadMps?: PercentileSpread | null; windDirectionDeg?: number | null; windGustMps?: number | null;
      cloudCoverPct?: number | null; pblHeightM?: number | null; sensibleHeatWm2?: number | null;
      wstarMps?: number | null; wstarLegacySpreadMps?: PercentileSpread | null;
      usableLiftTopM?: number | null; usableLiftLegacySpreadM?: PercentileSpread | null;
      wstarV2Mps?: number | null; wstarSpreadMps?: PercentileSpread | null;
      usableLiftTopV2M?: number | null; usableLiftSpreadM?: PercentileSpread | null;
      hcritWxtoflyM?: number | null;
      resolvedThermalTopM?: number | null; thermalTopSpreadM?: PercentileSpread | null;
      surfaceLclM?: number | null; effectiveCloudLimitM?: number | null; cloudLimitSpreadM?: PercentileSpread | null;
      mixedLayerLclM?: number | null;
      experimentalTerrain?: ExperimentalTerrain | null;
      blTopM?: number | null; blTopLegacySpreadM?: PercentileSpread | null;
      cloudBaseM?: number | null;
    }[];
  }>;
}
interface LaunchesDoc {
  launches: LaunchEntry[];
  raob?: { station: { id: string; name: string; distanceKm: number; elevationM: number }; soundings: { validAt: string }[] };
  nwsOffice?: { office: string; products: { afd?: { issuanceTime: string; text: string } | null } };
}
interface TransectNode {
  nodeIndex: number; distanceKm: number; latitude: number; longitude: number;
  cellIndex: number; gridIndex: number; modelElevationM: number | null;
  waypointLabel: string | null; launchElevationM: number | null;
}
interface CrossSectionDoc { title: string; totalDistanceKm: number; nodes: TransectNode[] }
interface MatchedRaobPair {
  model: string; siteSlug: string; siteName: string; regime: string; region: string;
  station: { id: string; name: string; distanceKm: number; elevationM: number };
  modelElevationM: number | null; elevationDeltaM: number | null;
  soundingValidAt: string; forecastValidAt: string; leadTimeBucket: string;
  metrics: { levelsCompared: number; temperatureMaeC: number | null; temperatureBiasC: number | null; dewPointMaeC: number | null; windVectorRmseMps: number | null };
}
interface RejectedComparison {
  id: string; stationId: string; siteSlug: string; matchStatus: string; distanceKm: number; timeDeltaMinutes: number; reason: string;
}
interface VerificationDoc {
  evaluatedAt?: string;
  hrrrWrfprsInventory?: { totalGribRecordsPerHour: number; availablePressureLevelsCount: number; availableSub925PressureLevelsHpa: number[]; explicitCloudAndStabilityFields: string[] };
  lifecycleAudit?: { slug: string; catalogueSunset: string; officialTransition: string; successor: string; status: string }[];
  observationVerificationSkill?: {
    note: string;
    matchedCount: number;
    matchedPairs: MatchedRaobPair[];
    rejectedMismatchedComparisons: RejectedComparison[];
  };
  kuilRaobComparison?: { station: { id: string; name: string; distanceKm: number; elevationM: number }; soundingValidAt: string; levelComparisons: { pressureHpa: number; kuilObsTempC: number; kuilObsDewPointC: number; kuilObsWindSpeedMps: number; kuilObsWindDirDeg: number; hrrrBlynF14TempC: number; hrrrBlynF14DewPointC: number; hrrrBlynF14WindSpeedMps: number; hrrrBlynF14WindDirDeg: number; tempDeltaC: number }[] };
  wrfPilotDomain?: { modelSlug: string; label: string; wrfRelease: string; domains: { id: string; dxM: number; eWe: number; eSn: number; eVert: number }[]; physics: { blPblPhysics: string; mpPhysics: string } };
}

const M_TO_FT = 3.280839895;
const fmtFt = (m: number | null | undefined) => formatQuantity(m, 'elevation');
const fmtM = (m: number | null | undefined, datum = 'MSL') => m == null ? 'Unavailable' : `${formatQuantity(m, 'elevation')} ${datum}`;

function renderCrossSectionSvg(
  doc: CrossSectionDoc,
  hour: ReplayHour,
  selectedCell: number,
  onSelectCell: (cellIndex: number) => void,
): SVGSVGElement {
  const width = 980, height = 300, left = 56, right = 24, top = 26, bottom = 46;
  const plotW = width - left - right, plotH = height - top - bottom;
  const maxAltM = 3600;
  const xOf = (km: number) => left + (km / Math.max(1, doc.totalDistanceKm)) * plotW;
  const yOf = (m: number) => top + plotH - Math.min(1, Math.max(0, m / maxAltM)) * plotH;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.cssText = 'width:100%;min-width:680px;height:auto;border:1px solid var(--rule);border-radius:6px;background:var(--surface)';

  for (const mVal of (getUnitSystem() === 'metric' ? [0, 1000, 2000, 3000, 3500] : [0, 3000, 6000, 9000, 11500].map(ft => ft / M_TO_FT))) {
    const y = yOf(mVal);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(left)); line.setAttribute('x2', String(width - right));
    line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#888'); line.setAttribute('stroke-opacity', '0.2');
    svg.append(line);
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', String(left - 6)); lbl.setAttribute('y', String(y + 4));
    lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('font-size', '10'); lbl.setAttribute('fill', 'currentColor');
    lbl.textContent = formatQuantity(mVal, 'elevation');
    svg.append(lbl);
  }

  const nodes = doc.nodes;
  nodes.forEach((n, idx) => {
    const ci = n.cellIndex;
    const x = xOf(n.distanceKm);
    const prevX = idx === 0 ? left : (xOf(nodes[idx - 1].distanceKm) + x) / 2;
    const nextX = idx === nodes.length - 1 ? width - right : (x + xOf(nodes[idx + 1].distanceKm)) / 2;
    const colW = Math.max(6, nextX - prevX);
    const terrM = n.modelElevationM ?? 0;
    const resTop = (hour.resolvedThermalTopM ?? hour.boundaryLayerTopM)[ci];
    const wstar = (hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci] ?? 0;

    if (resTop != null && resTop > terrM && wstar > 0) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(prevX)); rect.setAttribute('y', String(yOf(resTop)));
      rect.setAttribute('width', String(colW)); rect.setAttribute('height', String(Math.max(0, yOf(terrM) - yOf(resTop))));
      rect.setAttribute('fill', wstar >= 1.5 ? '#e8bc52' : '#289b9c');
      rect.setAttribute('fill-opacity', String(Math.min(0.42, 0.12 + wstar * 0.16)));
      svg.append(rect);
    }

    if (ci === selectedCell) {
      const sel = document.createElementNS(ns, 'rect');
      sel.setAttribute('x', String(prevX)); sel.setAttribute('y', String(top));
      sel.setAttribute('width', String(colW)); sel.setAttribute('height', String(plotH));
      sel.setAttribute('fill', '#237e81'); sel.setAttribute('fill-opacity', '0.12');
      sel.setAttribute('stroke', '#237e81'); sel.setAttribute('stroke-width', '1.5');
      svg.append(sel);
    }

    const hit = document.createElementNS(ns, 'rect');
    hit.setAttribute('x', String(prevX)); hit.setAttribute('y', String(top));
    hit.setAttribute('width', String(colW)); hit.setAttribute('height', String(plotH));
    hit.setAttribute('fill', 'transparent'); hit.style.cursor = 'pointer';
    hit.addEventListener('click', () => onSelectCell(ci));
    svg.append(hit);
  });

  const drawLine = (vals: (number | null | undefined)[], color: string, dash = '', widthPx = 2) => {
    const d = buildCrossSectionLinePath(nodes, vals, xOf, yOf);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', String(widthPx));
    if (dash) path.setAttribute('stroke-dasharray', dash);
    path.setAttribute('d', d); path.setAttribute('pointer-events', 'none');
    svg.append(path);
  };

  drawLine(nodes.map(n => (hour.surfaceLclM ?? hour.cloudBaseM)[n.cellIndex]), '#7c689c', '5,3', 1.8);
  drawLine(nodes.map(n => hour.resolvedThermalTopM?.[n.cellIndex]), '#237e81', '', 2.4);
  drawLine(nodes.map(n => (hour.usableLiftTopV2M ?? hour.usableLiftTopM)[n.cellIndex]), '#d99b26', '', 2.2);

  const terrPts = [
    `${left},${top + plotH}`,
    ...nodes.map(n => `${xOf(n.distanceKm).toFixed(1)},${yOf(n.modelElevationM ?? 0).toFixed(1)}`),
    `${width - right},${top + plotH}`,
  ];
  const poly = document.createElementNS(ns, 'polygon');
  poly.setAttribute('points', terrPts.join(' '));
  poly.setAttribute('fill', '#4b5563'); poly.setAttribute('fill-opacity', '0.45');
  poly.setAttribute('stroke', '#374151'); poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('pointer-events', 'none');
  svg.append(poly);

  nodes.forEach(n => {
    if (!n.waypointLabel) return;
    const x = xOf(n.distanceKm);
    if (n.launchElevationM != null) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(yOf(n.launchElevationM)));
      dot.setAttribute('r', '4'); dot.setAttribute('fill', '#111'); dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '1.5');
      dot.setAttribute('pointer-events', 'none');
      svg.append(dot);
    }
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(x)); txt.setAttribute('y', String(height - 16));
    txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('font-size', '10.5'); txt.setAttribute('font-weight', '600');
    txt.setAttribute('fill', 'currentColor');
    txt.textContent = `${n.waypointLabel} (${formatQuantity(n.distanceKm, 'distance')})`;
    svg.append(txt);
  });

  const leg = document.createElementNS(ns, 'text');
  leg.setAttribute('x', String(left + 6)); leg.setAttribute('y', '16');
  leg.setAttribute('font-size', '10.5'); leg.setAttribute('fill', 'currentColor');
  leg.textContent = 'Teal: thermal top · Gold: usable lift top · Purple: potential cloud base · Dots: launches · MSL';
  svg.append(leg);

  return svg;
}

async function main() {
  set("map-barb-units", getUnitSystem() === "metric" ? "· 2.5 / 5 / 25 m/s" : "· 5 / 10 / 50 kt");
  const regionsCatalogue = await readOptional<RegionCatalogue>(`${DATA_BASE.replace(/\/$/, '')}/soaring/v1/regions.json`);
  const query = defaultReplayQuery(window.location.search, regionsCatalogue);
  const location = replayLocation(query.toString(), DATA_BASE);
  const pointer = await read<{ bundle: string }>(`${location.root}/index.json`);
  if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error('Invalid replay bundle pointer');
  const root = `${location.root}/${pointer.bundle}`;
  const manifest = await read<ReplayManifest>(`${root}/manifest.json`);
  if (manifest.schemaVersion !== 1 || manifest.case.id !== location.caseId) throw new Error('Replay manifest mismatch');
  const activeModel = replayModel(manifest);
  const activeRegionMeta = regionForCase(regionsCatalogue?.regions ?? [], location.caseId);
  const [grid, profileData, audit, hours, launchesDoc, crossSectionDoc, verificationDoc] = await Promise.all([
    read<Grid>(`${root}/grid.geojson`),
    read<unknown>(`${root}/profile.json`),
    read<Audit>(`${root}/audit.json`),
    Promise.all(manifest.hours.map(h => read<ReplayHour>(`${root}/${h.file}`))),
    readOptional<LaunchesDoc>(`${root}/launches.json`),
    readOptional<CrossSectionDoc>(`${root}/cross-section.json`),
    readOptional<VerificationDoc>(`${root}/verification.json`),
  ]);
  const blanchardProfile = parseSiteForecast(profileData);
  if (!blanchardProfile || blanchardProfile.model !== activeModel || blanchardProfile.hours.length !== hours.length || blanchardProfile.hours.some((h, i) => h.validAt !== hours[i].validAt)) {
    throw new Error('Invalid or unsynchronized regional profile');
  }

  const selectedValidHour = forecastHourAtValidTime(hours, query.get('valid'));
  let requested = selectedValidHour ?? location.hour;
  if (selectedValidHour === null && !query.has('hour') && location.caseId.endsWith('-live')) {
    requested = hours.reduce((best, h) => Math.abs(Date.parse(h.validAt) - Date.now()) < Math.abs(Date.parse(best.validAt) - Date.now()) ? h : best).forecastHour;
  }
  let layer: Layer = 'thermalVelocityV2Mps';
  const launches = launchesDoc?.launches ?? [];
  const launchByCell = new Map(launches.map(launch => [launch.cellIndex, launch]));
  let selection = replaySelection(query, grid.features.map(feature => feature.properties), launches, manifest.siteCell);
  let selectedCell = selection.cellIndex;
  const launchForCell = (cellIndex: number) =>
    (cellIndex === selection.cellIndex && selection.launchSlug ? launches.find(launch => launch.slug === selection.launchSlug) : undefined)
    ?? launchByCell.get(cellIndex);
  function selectCell(cellIndex: number, launchSlug?: string) {
    const cell = grid.features[cellIndex]?.properties;
    if (!cell || cell.cellIndex !== cellIndex) return;
    const launch = launchSlug ? launches.find(entry => entry.slug === launchSlug && entry.cellIndex === cellIndex) : launchByCell.get(cellIndex);
    selectedCell = cellIndex;
    selection = {
      cellIndex,
      latitude: launch?.latitude ?? cell.latitude,
      longitude: launch?.longitude ?? cell.longitude,
      launchSlug: launch?.slug,
    };
    update();
  }
  let showBarbs = true;
  let playTimer: number | null = null;

  const slider = el<HTMLInputElement>('replay-hour');
  const prev = el<HTMLButtonElement>('replay-prev');
  const next = el<HTMLButtonElement>('replay-next');
  const playBtn = el<HTMLButtonElement>('replay-play');
  const regionSelect = el<HTMLSelectElement>('replay-region-select');
  const modelSelect = el<HTMLSelectElement>('replay-model-select');
  const launchSelect = el<HTMLSelectElement>('replay-launch-select');
  const barbsCheckbox = el<HTMLInputElement>('toggle-barbs');

  if (regionSelect && regionsCatalogue?.regions?.length) {
    regionSelect.replaceChildren();
    if (!activeRegionMeta) {
      const current = document.createElement('option');
      current.textContent = `${manifest.case.site.name} · archived forecast`;
      current.value = '';
      current.selected = true;
      current.disabled = true;
      regionSelect.append(current);
    }
    for (const r of regionsCatalogue.regions) {
      const opt = document.createElement('option');
      opt.value = r.id;
      const available = r.status === 'active-verified-trial';
      opt.textContent = `${r.name}${available ? '' : ' — unavailable'}`;
      opt.disabled = !available;
      if (r.id === activeRegionMeta?.id) opt.selected = true;
      regionSelect.append(opt);
    }
    regionSelect.addEventListener('change', () => {
      const nextUrl = new URL(window.location.href);
      setReplaySelectionQuery(nextUrl.searchParams, selection);
      const region = regionsCatalogue.regions.find(r => r.id === regionSelect.value)!;
      const selected = nativeModels(region).find(entry => entry.model === activeModel) ?? nativeModels(region)[0];
      nextUrl.searchParams.set('case', selected.caseId);
      nextUrl.searchParams.set('model', selected.model);
      nextUrl.searchParams.delete('hour');
      window.location.href = nextUrl.toString();
    });
  }
  if (modelSelect) {
    const models = activeRegionMeta ? nativeModels(activeRegionMeta) : [{ model: activeModel, caseId: location.caseId }];
    modelSelect.replaceChildren();
    for (const entry of models) {
      const option = document.createElement('option');
      option.value = entry.model;
      option.textContent = modelLabel(entry.model);
      option.selected = entry.model === activeModel;
      modelSelect.append(option);
    }
    modelSelect.disabled = models.length < 2;
    modelSelect.addEventListener('change', () => {
      const selected = models.find(entry => entry.model === modelSelect.value)!;
      const nextUrl = new URL(window.location.href);
      setReplaySelectionQuery(nextUrl.searchParams, selection);
      nextUrl.searchParams.set('case', selected.caseId);
      nextUrl.searchParams.set('model', selected.model);
      nextUrl.searchParams.delete('hour');
      window.location.href = nextUrl.toString();
    });
  }

  slider.max = String(hours.length - 1);
  el('replay-content').hidden = false;
  set('replay-status', '');
  el('replay-status').hidden = true;
  set('replay-run', historicalLabel(manifest.case.referenceTime, location.caseId.endsWith('-live'), activeModel));
  set('select-blanchard', `Back to ${manifest.case.site.name}`);
  if (activeRegionMeta) {
    set('launches-heading', `Compare launches · ${activeRegionMeta.name}`);
  }
  if (crossSectionDoc) {
    set('cross-section-route', crossSectionDoc.nodes.filter(n => n.waypointLabel).map(n => n.waypointLabel).join(' → '));
  }
  if (launchesDoc?.nwsOffice?.office) {
    set('nws-afd-summary', `Area Forecast Discussion · NWS ${launchesDoc.nwsOffice.office}`);
  }

  if (launches.length && launchSelect) {
    launchSelect.replaceChildren();
    for (const l of launches) {
      const opt = document.createElement('option');
      opt.value = l.slug;
      opt.textContent = l.name;
      if (l.slug === launchForCell(selectedCell)?.slug) opt.selected = true;
      launchSelect.append(opt);
    }
  }

  const [west, south, east, north] = manifest.case.bbox;
  const map = baseMap(el('soaring-map'), { center: [(west + east) / 2, (south + north) / 2], zoom: 8 });

  if (launches.length) {
    for (const l of launches) {
      const m = document.createElement('div');
      const isPrimary = l.slug === manifest.case.site.slug || l.cellIndex === manifest.siteCell;
      m.style.cssText = `background:${isPrimary ? '#111' : '#237e81'};border:2.5px solid white;border-radius:50%;width:${isPrimary ? 17 : 13}px;height:${isPrimary ? 17 : 13}px;box-shadow:0 0 0 1.5px #111;cursor:pointer`;
      m.title = `${l.name} launch (${formatQuantity(l.launchElevationM, 'elevation')} MSL)`;
      m.addEventListener('click', e => {
        e.stopPropagation();
        selectCell(l.cellIndex, l.slug);
      });
      new Marker({ element: m }).setLngLat([l.longitude, l.latitude]).addTo(map);
    }
  } else {
    const launch = manifest.case.site;
    const marker = document.createElement('div');
    marker.style.cssText = 'background:#111;border:3px solid white;border-radius:50%;width:17px;height:17px;box-shadow:0 0 0 2px #111';
    marker.title = `${launch.name} launch`;
    new Marker({ element: marker }).setLngLat([launch.longitude, launch.latitude]).addTo(map);
  }

  const soundingChart = new SkewTChart(el('replay-sounding'), { name: manifest.case.site.name, elevationM: manifest.case.launchElevation.elevationM });
  const profileCache = new Map<number, SiteForecast | null>();
  const windgramHost = el('replay-windgram');
  const windgramAxis = el('replay-height-axis');
  let currentWindgramCell = -1;
  let currentWindgramLayout = '';
  let currentWindgramHour = -1;
  let fullWindgramProfile = false;
  let currentView = buildWindgramView(blanchardProfile, {
    timeZone: manifest.case.site.timeZone,
    widthPx: 1100,
    launch: { elevationM: manifest.case.launchElevation.elevationM, name: `${manifest.case.site.name} launch` },
  });
  let cursor: SVGRectElement | null = null;

  function renderActiveCellWindgram(activeProfile: SiteForecast, cellIdx: number, index: number) {
    const { compact, height: heightPx } = windgramViewport();
    el('windgram-full-profile').hidden = !compact;
    el('windgram-full-profile').setAttribute('aria-pressed', String(fullWindgramProfile));
    const widthPx = compact ? Math.max(windgramHost.clientWidth || 320, 240) : 1100;
    const layout = compact ? `compact:${widthPx}:${heightPx}:${fullWindgramProfile}` : 'desktop';
    const matchedLaunch = launchForCell(cellIdx);
    const launchMeta = matchedLaunch && matchedLaunch.launchElevationM != null
      ? { elevationM: matchedLaunch.launchElevationM, name: `${matchedLaunch.name} launch` }
      : cellIdx === manifest.siteCell
        ? { elevationM: manifest.case.launchElevation.elevationM, name: `${manifest.case.site.name} launch` }
        : null;

    const rebuilt = currentWindgramCell !== cellIdx || currentWindgramLayout !== layout;
    if (rebuilt) {
      currentWindgramCell = cellIdx;
      currentWindgramLayout = layout;
      currentView = buildWindgramView(activeProfile, {
        timeZone: manifest.case.site.timeZone,
        widthPx,
        compact,
        heightRange: fullWindgramProfile ? 'full' : 'soaring',
        heightPx,
        launch: launchMeta,
      });
      windgramHost.innerHTML = renderWindgramSvg(currentView, { idPrefix: 'soaring' });
      windgramAxis.replaceChildren();
      windgramAxis.hidden = true;
      el('windgram-key').innerHTML = renderWindgramKey();
      const svg = windgramHost.querySelector('svg')!;
      const box = svg.viewBox.baseVal;
      if (box.width > 0) svg.style.width = `${box.width}px`;
      windgramHost.dataset.axisWidth = '0';
      cursor = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({
        y: currentView.top,
        height: currentView.plotHeight,
        width: currentView.plotWidth / hours.length,
        fill: '#237e81',
        'fill-opacity': 0.08,
        stroke: '#237e81',
        'stroke-width': 2,
        'pointer-events': 'none',
        'data-selected-hour': '',
      })) {
        cursor.setAttribute(key, String(value));
      }
      svg.append(cursor);
      svg.addEventListener('click', event => {
        if (currentView.compact && event.clientX - windgramHost.getBoundingClientRect().left < currentView.left) return;
        const matrix = svg.getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        const clickedIdx = Math.max(0, Math.min(hours.length - 1, Math.floor((point.x - currentView.left) / (currentView.plotWidth / hours.length))));
        requested = hours[clickedIdx].forecastHour;
        update();
      });
    }
    if (cursor && currentView.hours[index]) {
      const left = currentView.hours[index].x - currentView.columnWidth / 2;
      cursor.setAttribute('x', String(left));
      if (windgramHost.scrollWidth > windgramHost.clientWidth + 1 && (rebuilt || currentWindgramHour !== index)) {
        const right = left + currentView.columnWidth;
        if (left < windgramHost.scrollLeft + currentView.left + 16) {
          windgramHost.scrollLeft = Math.max(0, left - currentView.left - 16);
        } else if (right > windgramHost.scrollLeft + windgramHost.clientWidth - 16) {
          windgramHost.scrollLeft = right - windgramHost.clientWidth + 16;
        }
      }
    }
    currentWindgramHour = index;
  }

  const inv = activeModel === 'hrrr-conus' ? verificationDoc?.hrrrWrfprsInventory : undefined;
  set('audit-summary', 'About this forecast');
  set('audit-results', `${audit.mapProfileAgreement.valuesChecked.toLocaleString('en-US')} map/profile values checked · ${audit.mapProfileAgreement.hours} hours. Sample ${formatQuantity(audit.sampledCell.distanceKm, 'distance')}. Terrain: model ${formatQuantity(audit.terrain.modelElevationM, 'elevation')} / launch ${formatQuantity(audit.terrain.launch.elevationM, 'elevation')} MSL.${inv ? ` ${inv.availablePressureLevelsCount} pressure levels available.` : ''}`);
  el('audit-limitations').replaceChildren();
  el<HTMLAnchorElement>('audit-download').href = `${root}/audit.json`;

  // Observation checks belong to the dated report, including on archived runs.
  const obsSkill = verificationDoc?.observationVerificationSkill;
  if (obsSkill && el('raob-table-body')) {
    const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const observationDays = [...new Set(obsSkill.matchedPairs.map(pair => pair.soundingValidAt.slice(0, 10)))].filter(day => Number.isFinite(Date.parse(day))).sort();
    const firstDay = observationDays[0], lastDay = observationDays.at(-1);
    const observationDates = firstDay ? `${date.format(new Date(firstDay))}${lastDay !== firstDay ? `–${date.format(new Date(lastDay!))}` : ''} UTC` : '';
    const evaluatedAt = verificationDoc?.evaluatedAt;
    const evaluated = evaluatedAt && Number.isFinite(Date.parse(evaluatedAt)) ? ` · evaluated ${date.format(new Date(evaluatedAt))} UTC` : '';
    const rejectedText = obsSkill.rejectedMismatchedComparisons?.map(r => `${r.stationId}: ${formatQuantity(r.distanceKm, "distance")}, ${r.timeDeltaMinutes} min offset`).join(' · ') ?? '';
    set(
      'raob-meta',
      `Historical observations${observationDates ? ` · ${observationDates}` : ''}${evaluated} · ${obsSkill.matchedCount} matched station pairs.` +
      (rejectedText ? ` Excluded pairs: ${rejectedText}.` : ''),
    );
    const tbody = el('raob-table-body');
    tbody.replaceChildren();
    for (const pair of obsSkill.matchedPairs) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><strong>${pair.station.id} &rarr; ${pair.siteName}</strong> <span class="muted">(${formatQuantity(pair.station.distanceKm, "distance")})</span></td>` +
        `<td><code>${pair.model}</code></td>` +
        `<td>${pair.regime} (${pair.leadTimeBucket})</td>` +
        `<td>${formatQuantity(pair.metrics.temperatureMaeC, "temperatureDelta", 2)} (${pair.metrics.temperatureBiasC != null && pair.metrics.temperatureBiasC >= 0 ? '+' : ''}${formatQuantity(pair.metrics.temperatureBiasC, "temperatureDelta", 2)})</td>` +
        `<td>${formatQuantity(pair.metrics.dewPointMaeC, "temperatureDelta", 2)}</td>` +
        `<td>${formatQuantity(pair.metrics.windVectorRmseMps, "wind", 2)}</td>`;
      tbody.append(tr);
    }
  }
  if (verificationDoc?.wrfPilotDomain && el('wrf-lifecycle-summary')) {
    const w = verificationDoc.wrfPilotDomain;
    const grids = w.domains.map(domain => formatQuantity(domain.dxM / 1000, 'resolution')).join(' → ');
    set('wrf-lifecycle-summary', `WRF-ARW pilot configuration · planned North Sound grids: ${grids}.`);
  }
  if (launchesDoc?.nwsOffice?.products?.afd?.text && el('nws-afd-text')) {
    set('nws-afd-text', launchesDoc.nwsOffice.products.afd.text.trim());
  }

  let ready = false;
  let drawnHour: ReplayHour | undefined, drawnLayer: Layer | undefined, drawnBarbs: boolean | undefined;
  function update() {
    const state = selectedState(manifest, hours, requested), { hour, index } = state;
    requested = hour.forecastHour;
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', state.validLabel);
    prev.disabled = index === 0;
    next.disabled = index === hours.length - 1;
    set('replay-valid', state.validLabel);
    const properties = grid.features[selectedCell].properties;
    const matchedLaunch = launchForCell(selectedCell);
    const activeLabel = matchedLaunch?.name ?? (selectedCell === manifest.siteCell ? manifest.case.site.name : 'Selected location');
    set('cell-title', activeLabel);
    set(
      'cell-location',
      `${properties.latitude.toFixed(4)}°, ${properties.longitude.toFixed(4)}° · Model terrain ${fmtM(properties.modelElevationM)}` +
      (matchedLaunch?.launchElevationM != null ? ` · Launch terrain ${fmtM(matchedLaunch.launchElevationM)}` : ''),
    );

    if (launchSelect) {
      launchSelect.value = matchedLaunch?.slug ?? '';
    }

    if (!profileCache.has(selectedCell)) {
      if (profileCache.size >= 32) profileCache.delete(profileCache.keys().next().value!);
      profileCache.set(selectedCell, buildCellSiteForecast(manifest, hours, selectedCell, properties, activeLabel));
    }
    const cellForecast = profileCache.get(selectedCell);
    set('windgram-heading', `${activeLabel} · Windgram`);
    set('sounding-heading', `${activeLabel} · Sounding`);
    set('sounding-valid', state.validLabel);
    if (cellForecast) {
      renderActiveCellWindgram(cellForecast, selectedCell, index);
    } else {
      currentWindgramCell = -1;
      currentWindgramHour = -1;
      cursor = null;
      set('replay-windgram', 'A complete profile is unavailable at this location.');
      windgramAxis.replaceChildren();
      windgramAxis.hidden = true;
      set('windgram-key', '');
    }
    el('replay-windgram').dataset.validAt = hour.validAt;
    el('replay-sounding').dataset.validAt = hour.validAt;
    el('soaring-map').dataset.validAt = hour.validAt;

    const elevForSounding = matchedLaunch?.launchElevationM ?? (selectedCell === manifest.siteCell ? manifest.case.launchElevation.elevationM : properties.modelElevationM);
    const builtSounding = cellForecast ? buildSounding(cellForecast, cellForecast.hours[index]) : null;
    soundingChart.set(builtSounding, { name: activeLabel, elevationM: elevForSounding });
    const findings = el('sounding-findings');
    findings.replaceChildren();
    set('sounding-headline', 'Sounding unavailable at this location.');
    if (builtSounding) {
      const reading = readSounding(builtSounding, elevForSounding);
      set('sounding-headline', reading.headline);
      for (const f of reading.findings) {
        const li = document.createElement('li');
        const title = document.createElement('strong');
        title.textContent = `${f.title}: `;
        li.append(title, f.text);
        findings.append(li);
      }
    }

    const values = el('cell-values');
    const extraValues = el('cell-extra-values');
    values.replaceChildren();
    extraValues.replaceChildren();
    const w10s = hour.wind10mSpeedMps?.[selectedCell];
    const w10d = hour.wind10mDirDeg?.[selectedCell];
    const w10g = hour.windGustMps?.[selectedCell];
    const blws = hour.blMeanWindSpeedMps?.[selectedCell];
    const blwd = hour.blMeanWindDirDeg?.[selectedCell];
    const blsh = hour.blWindShearMps?.[selectedCell];
    const bsr = hour.buoyancyShearRatio?.[selectedCell];
    const modelLaunchHour = matchedLaunch?.models?.[activeModel]?.hours?.find(mh => mh.validAt === hour.validAt);
    const expTerr = modelLaunchHour?.experimentalTerrain;
    const detailRows: [string, string][] = [
      ['Thermal strength · current / legacy', `${displayMetric(hour.thermalVelocityV2Mps?.[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])} · v1: ${displayMetric(hour.thermalVelocityMps[selectedCell], 'thermalVelocityMps', hour.status[selectedCell])}`],
      [`Usable lift top · ${formatQuantity(1, 'lift')} sink`, `${displayMetric(hour.usableLiftTopV2M?.[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])} · v1: ${displayMetric(hour.usableLiftTopM[selectedCell], 'usableLiftTopM', hour.status[selectedCell])}`],
      [`Paraglider ceiling · ${formatQuantity(1.143, 'lift')} sink`, displayMetric(hour.hcritWxtoflyM?.[selectedCell], 'hcritWxtoflyM', hour.status[selectedCell])],
      ['Thermal top', fmtM(hour.resolvedThermalTopM?.[selectedCell], 'MSL')],
      [`Thermal top · +${formatQuantity(1, 'temperatureDelta')} sensitivity`, fmtM(hour.thermalTopPlus1CM?.[selectedCell], 'MSL')],
      ['Parcel top · legacy', fmtM(hour.boundaryLayerTopM[selectedCell], 'MSL')],
      [`${modelLabel(activeModel)} model boundary-layer depth`, fmtM(hour.pblHeightM[selectedCell], 'AGL')],
      ['Potential cloud base (surface LCL)', fmtM((hour.surfaceLclM ?? hour.cloudBaseM)[selectedCell], 'MSL')],
      ['Effective cloud limit (model near-saturation proxy)', fmtM((hour.effectiveCloudLimitM ?? hour.cloudBaseM)[selectedCell], 'MSL')],
      ['Mixed-layer cloud base', fmtM(hour.mixedLayerLclM?.[selectedCell], 'MSL')],
      ['Cu / OD potential', `${hour.cuPotentialM?.[selectedCell] != null ? `${hour.cuPotentialM[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.cuPotentialM[selectedCell], "elevation")}` : '–'} / ${hour.odPotentialM?.[selectedCell] != null ? `${hour.odPotentialM[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.odPotentialM[selectedCell], "elevation")}` : '–'}`],
      [`Wind at ${formatQuantity(10, 'elevation')} AGL (gust)`, w10s != null && w10d != null ? `${compassPoint(w10d)} (${w10d.toFixed(0)}°) @ ${formatQuantity(w10s, "wind")}${w10g != null ? ` (gust ${formatQuantity(w10g, "wind")})` : ''}` : 'Unavailable'],
      ['Launch-elevation wind · experimental', expTerr ? (expTerr.bracketsLaunchAltitude && expTerr.launchWindSpeedMps != null && expTerr.launchWindDirectionDeg != null ? `${compassPoint(expTerr.launchWindDirectionDeg)} (${expTerr.launchWindDirectionDeg.toFixed(0)}°) @ ${formatQuantity(expTerr.launchWindSpeedMps, "wind")} at ${formatQuantity(expTerr.launchElevationM, "elevation")} MSL` : `Launch (${formatQuantity(expTerr.launchElevationM, "elevation")}) outside profile bracket`) : 'Select a launch'],
      ['BL mean wind & shear', blws != null && blwd != null ? `${compassPoint(blwd)} (${blwd.toFixed(0)}°) @ ${formatQuantity(blws, "wind")} · shear ${formatQuantity(blsh, "wind")} (B/S ${bsr?.toFixed(2) ?? '–'})` : 'Unavailable'],
      [`Vertical motion at ${formatQuantity(925, 'pressure')} / convergence`, `${hour.w925Mps?.[selectedCell] != null ? `${hour.w925Mps[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.w925Mps[selectedCell], "lift")}` : '–'} · ${hour.convergence10mX1e5?.[selectedCell] != null ? `${hour.convergence10mX1e5[selectedCell]! >= 0 ? '+' : ''}${hour.convergence10mX1e5[selectedCell]!.toFixed(1)} ×10⁻⁵ s⁻¹` : '–'}`],
      ['Sensible / latent heat flux', `${hour.sensibleHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} / ${hour.latentHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} W/m²`],
      ['Clouds (total / low / mid / high)', `${hour.cloudCoverPercent?.[selectedCell]?.toFixed(0) ?? '–'}% (${hour.lowCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.midCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.highCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}%)`],
    ];
    const primaryRows: [string, string][] = [
      ['Thermal strength', displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])],
      ['Usable lift top', displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])],
      ['Potential cloud base', fmtFt((hour.surfaceLclM ?? hour.cloudBaseM)[selectedCell])],
      ['Surface wind', w10s != null && w10d != null ? `${compassPoint(w10d)} ${formatQuantity(w10s, "wind")}${w10g != null ? ` · gusts ${formatQuantity(w10g, "wind")}` : ''}` : 'Unavailable'],
      ['Cloud cover', displayMetric(hour.cloudCoverPercent?.[selectedCell], 'cloudCoverPercent')],
    ];
    if (!['thermalVelocityV2Mps', 'usableLiftTopV2M', 'surfaceLclM', 'wind10mSpeedMps', 'cloudCoverPercent'].includes(layer)) {
      primaryRows.push([LAYER_SPECS[layer].label, displayMetric((hour[layer] as (number | null)[] | undefined)?.[selectedCell], layer)]);
    }
    for (const [host, rows] of [[values, primaryRows], [extraValues, detailRows]] as const) {
      for (const [label, value] of rows) {
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = label; dd.textContent = value;
        host.append(dt, dd);
      }
    }
    const notice = hour.status[selectedCell] === 'insufficient-levels'
      ? 'Lift unavailable · limited vertical data.'
      : hour.status[selectedCell] === 'missing'
        ? 'Lift unavailable.'
        : hour.ceilingReached[selectedCell] ? 'Thermals extend beyond profile top.' : '';
    set('cell-notice', notice);
    el('cell-notice').hidden = !notice;
    set(
      'cell-quality',
      `${hour.levelCount[selectedCell]} profile levels. ` +
      (hour.ceilingReached[selectedCell]
        ? 'Thermals reach profile ceiling.'
        : hour.status[selectedCell] === 'valid'
          ? 'Thermal top inside profile.'
          : 'Lift unavailable.'),
    );

    const spec = LAYER_SPECS[layer] ?? LAYER_SPECS.thermalVelocityV2Mps;
    const legend = el('replay-legend');
    legend.replaceChildren();
    const legendTitle = document.createElement('strong');
    legendTitle.textContent = spec.label;
    const scale = document.createElement('div');
    scale.className = 'legend-scale';
    for (const [i, stop] of spec.stops.entries()) {
      const key = document.createElement('span'), swatch = document.createElement('span');
      key.className = 'legend-key'; swatch.className = 'legend-swatch';
      swatch.style.background = spec.colors[i];
      key.append(swatch, stop.toLocaleString('en-US', {maximumFractionDigits: 2}));
      scale.append(key);
    }
    const explanation = document.createElement('span');
    explanation.className = 'muted';
    const liftTopLayer = ['usableLiftTopV2M', 'usableLiftTopM', 'hcritWxtoflyM', 'dryHcritM', 'resolvedThermalTopM'].includes(layer);
    explanation.textContent = 'Gray: unavailable · Purple: limited height data' + (liftTopLayer ? ' · Beige: below sink threshold' : '');
    if (layer === 'usableLiftTopV2M' || layer === 'usableLiftTopM') legendTitle.textContent += ` · ${formatQuantity(1, 'lift')} sink`;
    legend.append(legendTitle, scale, explanation);

    if (launches.length && el('launches-table-body')) {
      const tbody = el('launches-table-body');
      tbody.replaceChildren();
      const detailBody = el('launch-details-body');
      detailBody.replaceChildren();
      for (const l of launches) {
        const ci = l.cellIndex;
        const tr = document.createElement('tr');
        if (ci === selectedCell) tr.className = 'is-selected';
        const wstar = (hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci];
        const uTop = (hour.usableLiftTopV2M ?? hour.usableLiftTopM)[ci];
        const wxTop = hour.hcritWxtoflyM?.[ci];
        const rTop = hour.resolvedThermalTopM?.[ci];
        const v1Top = hour.boundaryLayerTopM[ci];
        const hpbl = hour.pblHeightM[ci];
        const lcl = (hour.surfaceLclM ?? hour.cloudBaseM)[ci];
        const cu = hour.cuPotentialM?.[ci];
        const od = hour.odPotentialM?.[ci];
        const ws = hour.wind10mSpeedMps?.[ci];
        const wd = hour.wind10mDirDeg?.[ci];
        const blw = hour.blMeanWindSpeedMps?.[ci];
        const bls = hour.blWindShearMps?.[ci];
        const conv = hour.convergence10mX1e5?.[ci];

        tr.innerHTML =
          `<td><strong>${l.name}</strong> <span class="muted">(${l.launchElevationM != null ? `${formatQuantity(l.launchElevationM, "elevation")}` : '–'} / ${l.modelElevationM != null ? `${formatQuantity(l.modelElevationM, "elevation")}` : '–'})</span></td>` +
          `<td>${wstar != null ? `${formatQuantity(wstar, "lift")}` : '–'}</td>` +
          `<td>${fmtFt(uTop)}</td>` +
          `<td>${fmtFt(wxTop)}</td>` +
          `<td>${rTop != null ? fmtFt(rTop) : '<span class="muted">Stable</span>'}</td>` +
          `<td>${fmtFt(v1Top)}</td>` +
          `<td>${hpbl != null ? formatQuantity(hpbl, "elevation") : '–'}</td>` +
          `<td>${fmtFt(lcl)}</td>` +
          `<td>${cu != null ? `${cu >= 0 ? '+' : ''}${formatQuantity(cu, "elevation")}` : '–'} / ${od != null ? `${od >= 0 ? '+' : ''}${formatQuantity(od, "elevation")}` : '–'}</td>` +
          `<td>${ws != null && wd != null ? `${compassPoint(wd)} ${formatQuantity(ws, "wind")}` : '–'}</td>` +
          `<td>${blw != null ? `${formatQuantity(blw, "wind")}` : '–'} / ${bls != null ? formatQuantity(bls, "wind") : '–'}</td>` +
          `<td>${conv != null ? `${conv >= 0 ? '+' : ''}${conv.toFixed(0)}` : '–'}</td>`;
        tr.addEventListener('click', () => {
          selectCell(ci, l.slug);
        });
        detailBody.append(tr);
        const simpleRow = document.createElement('tr');
        simpleRow.className = tr.className;
        const launchCell = document.createElement('td');
        const launchButton = document.createElement('button');
        launchButton.type = 'button'; launchButton.className = 'launch-link';
        launchButton.textContent = l.name;
        launchButton.addEventListener('click', () => selectCell(ci, l.slug));
        launchCell.append(launchButton);
        simpleRow.append(launchCell);
        const readings = [
          displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci], 'thermalVelocityV2Mps', hour.status[ci]),
          displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[ci], 'usableLiftTopV2M', hour.status[ci]),
          fmtFt(lcl),
          ws != null && wd != null ? `${compassPoint(wd)} ${formatQuantity(ws, "wind")}` : 'Unavailable',
        ];
        for (const reading of readings) {
          const td = document.createElement('td'); td.textContent = reading; simpleRow.append(td);
        }
        simpleRow.addEventListener('click', event => {
          if (!(event.target as HTMLElement).closest('button')) selectCell(ci, l.slug);
        });
        tbody.append(simpleRow);
      }
    }

    if (crossSectionDoc && el('replay-cross-section')) {
      const host = el('replay-cross-section');
      host.replaceChildren(
        renderCrossSectionSvg(crossSectionDoc, hour, selectedCell, ci => {
          selectCell(ci);
        }),
      );
    }

    const activeLaunch = matchedLaunch;
    el('multimodel-table-body')?.replaceChildren();
    if (activeLaunch && el('multimodel-table-body')) {
      const tbody = el('multimodel-table-body');
      tbody.replaceChildren();
      const modelLabels: [string, string][] = [
        ['hrrr-conus', 'HRRR'],
        ['rrfs', 'RRFS'],
        ['hrdps-continental', 'HRDPS'],
        ['rdps', 'RDPS'],
        ['gdps', 'GDPS'],
        ['gfs', 'GFS'],
        ['geps', 'GEPS median'],
        ['ecmwf', 'ECMWF'],
        ['nws', 'NWS'],
      ];
      for (const [mslug, mlabel] of modelLabels) {
        const mdata = activeLaunch.models[mslug];
        if (!mdata) continue;
        const mh = mdata.hours.find(h => h.validAt === hour.validAt);
        if (!mh) continue;
        const isSparseAdapter = mslug === 'ecmwf' || mslug === 'nws';
        const isLegacyOnlyEnsemble = mslug === 'geps' && mh.wstarV2Mps == null && mh.usableLiftTopV2M == null && mh.resolvedThermalTopM == null;
        const wstarVal = isSparseAdapter ? null : (mh.wstarV2Mps ?? (isLegacyOnlyEnsemble ? null : mh.wstarMps));
        const uTopVal = isSparseAdapter ? null : (mh.usableLiftTopV2M ?? (isLegacyOnlyEnsemble ? null : mh.usableLiftTopM));
        const blTopVal = isSparseAdapter ? mh.blTopM : (mh.resolvedThermalTopM ?? (isLegacyOnlyEnsemble ? null : mh.blTopM));
        const surfaceLclVal = Object.hasOwn(mh, 'surfaceLclM') ? mh.surfaceLclM : (isSparseAdapter ? mh.cloudBaseM : null);
        const effCloudLimitVal = isSparseAdapter ? null : (Object.hasOwn(mh, 'effectiveCloudLimitM') ? mh.effectiveCloudLimitM : mh.cloudBaseM);

        const spreadText = (spread: PercentileSpread | null | undefined, kind: 'lift' | 'elevation') =>
          spread && spread.p10 != null && spread.p90 != null
            ? ` <span class="muted" title="Ensemble p10–p90 range">(${formatQuantity(spread.p10, kind)}–${formatQuantity(spread.p90, kind)})</span>`
            : '';

        const cloudParts: string[] = [];
        if (surfaceLclVal != null) cloudParts.push(`LCL ${fmtFt(surfaceLclVal)}`);
        if (effCloudLimitVal != null && (surfaceLclVal == null || Math.abs(effCloudLimitVal - surfaceLclVal) > 1)) {
          cloudParts.push(`${isLegacyOnlyEnsemble ? 'v1 ' : ''}limit ${fmtFt(effCloudLimitVal)}${spreadText(mh.cloudLimitSpreadM, 'elevation')}`);
        }
        const cloudLabel = (cloudParts.length ? cloudParts.join(' · ') : '–') + (mh.cloudCoverPct != null ? ` (${Math.round(mh.cloudCoverPct)}%)` : '');

        const wstarCell = isSparseAdapter
          ? '<span class="muted" title="Surface forecast · thermal profile unavailable">Unavailable</span>'
          : wstarVal != null
            ? `${formatQuantity(wstarVal, "lift")}${spreadText(mh.wstarSpreadMps, 'lift')}`
            : (isLegacyOnlyEnsemble && mh.wstarMps != null
                ? `<span class="muted" title="Legacy v1 ensemble diagnostic (v2 member derivation unavailable)">v1: ${formatQuantity(mh.wstarMps, "lift")}${spreadText(mh.wstarLegacySpreadMps, 'lift')}</span>`
                : '–');

        const uTopCell = isSparseAdapter
          ? '<span class="muted" title="Surface forecast · thermal profile unavailable">Unavailable</span>'
          : uTopVal != null
            ? `${fmtFt(uTopVal)}${spreadText(mh.usableLiftSpreadM, 'elevation')}`
            : (isLegacyOnlyEnsemble && mh.usableLiftTopM != null
                ? `<span class="muted" title="Legacy v1 ensemble diagnostic (v2 member derivation unavailable)">v1: ${fmtFt(mh.usableLiftTopM)}${spreadText(mh.usableLiftLegacySpreadM, 'elevation')}</span>`
                : '–');

        const blTopCell = blTopVal != null
          ? `${fmtFt(blTopVal)}${spreadText(mh.thermalTopSpreadM, 'elevation')}${mh.pblHeightM != null ? ` (${formatQuantity(mh.pblHeightM, "elevation")} AGL)` : ''}`
          : (isLegacyOnlyEnsemble && mh.blTopM != null
              ? `<span class="muted" title="Legacy v1 ensemble parcel top (v2 member derivation unavailable)">v1: ${fmtFt(mh.blTopM)}${spreadText(mh.blTopLegacySpreadM, 'elevation')}</span>`
              : '–');

        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td><strong>${mlabel}</strong></td>` +
          `<td>${mdata.referenceTime ? mdata.referenceTime.slice(5, 16).replace('T', ' ') + 'Z' : '–'}</td>` +
          `<td>${mdata.modelElevationM != null ? formatQuantity(mdata.modelElevationM, "elevation") : '–'}</td>` +
          `<td>${mh.tempC != null ? formatQuantity(mh.tempC, "temperature", 1) : '–'}${mh.dewPointC != null ? ` / ${formatQuantity(mh.dewPointC, "temperature", 1)}` : ''}</td>` +
          `<td>${mh.windDirectionDeg != null ? `${compassPoint(mh.windDirectionDeg)} ` : ''}${mh.windSpeedMps != null ? `${formatQuantity(mh.windSpeedMps, "wind")}` : '–'}${mh.windGustMps != null ? ` (g ${formatQuantity(mh.windGustMps, "wind")})` : ''}</td>` +
          `<td>${wstarCell}</td>` +
          `<td>${uTopCell}</td>` +
          `<td>${blTopCell}</td>` +
          `<td>${cloudLabel}</td>`;
        tbody.append(tr);
      }
    }

    if (ready) map.setFilter('selected-outline', ['==', ['get', 'cellIndex'], selectedCell]);
    if (ready && (hour !== drawnHour || layer !== drawnLayer || showBarbs !== drawnBarbs)) {
      drawnHour = hour; drawnLayer = layer; drawnBarbs = showBarbs;
      const arr = (hour[layer] as (number | null)[] | undefined) ?? [];
      const data = {
        ...grid,
        features: grid.features.map((f, i) => ({
          ...f,
          properties: {
            ...f.properties,
            quality: arr[i] === undefined ? 'missing' : ['thermalVelocityV2Mps', 'thermalVelocityMps', 'usableLiftTopV2M', 'usableLiftTopM', 'resolvedThermalTopM', 'boundaryLayerTopM', 'hcritWxtoflyM', 'dryHcritM'].includes(layer) ? hour.status[i] : (arr[i] === null ? 'missing' : 'valid'),
            value: arr[i] === null || arr[i] === undefined ? null : arr[i]! * spec.scale,
          },
        })),
      };
      (map.getSource('lift') as GeoJSONSource).setData(data);
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
        const barbs = windBarbs(showBarbs ? grid.features.map(f => f.properties) : [], wsArr, wdArr);
        for (const { properties: { icon, barbSpeed } } of barbs.features) {
          if (!map.hasImage(icon)) map.addImage(icon, windBarbImage(barbSpeed), { pixelRatio: 2 });
        }
        windSource.setData(barbs);
      }
    }

    const url = new URL(window.location.href);
    url.searchParams.set('case', location.caseId);
    url.searchParams.set('model', activeModel);
    url.searchParams.set('hour', String(requested));
    url.searchParams.set('valid', hour.validAt);
    setReplaySelectionQuery(url.searchParams, selection);
    window.history.replaceState(null, '', url);
  }

  onMapReady(map, () => {
    map.addSource('lift', { type: 'geojson', data: grid });
    map.addLayer({ id: 'lift-fill', type: 'fill', source: 'lift', paint: { 'fill-opacity': 0.72 } });
    map.addLayer({ id: 'lift-grid', type: 'line', source: 'lift', paint: { 'line-color': '#32464e', 'line-width': 0.45, 'line-opacity': 0.35 } });
    map.addLayer({ id: 'blanchard-outline', type: 'line', source: 'lift', filter: ['==', ['get', 'cellIndex'], manifest.siteCell], paint: { 'line-color': '#111', 'line-width': 3 } });
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
        selectCell(index);
      }
    });
    map.on('mouseenter', 'lift-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'lift-fill', () => { map.getCanvas().style.cursor = ''; });
    ready = true;
    update();
  });

  function move(delta: number) {
    const index = selectedState(manifest, hours, requested).index;
    requested = hours[Math.max(0, Math.min(hours.length - 1, index + delta))].forecastHour;
    update();
  }

  slider.addEventListener('input', () => { requested = hours[Number(slider.value)].forecastHour; update(); });
  prev.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (playTimer !== null) {
        window.clearInterval(playTimer);
        playTimer = null;
        playBtn.textContent = '▶ Play';
      } else {
        playBtn.textContent = '⏸ Pause';
        playTimer = window.setInterval(() => {
          const idx = selectedState(manifest, hours, requested).index;
          requested = hours[(idx + 1) % hours.length].forecastHour;
          update();
        }, 900);
      }
    });
  }
  if (launchSelect) {
    launchSelect.addEventListener('change', () => {
      const found = launches.find(l => l.slug === launchSelect.value);
      if (found) {
        selectCell(found.cellIndex, found.slug);
      }
    });
  }
  if (barbsCheckbox) {
    barbsCheckbox.addEventListener('change', () => {
      showBarbs = barbsCheckbox.checked;
      update();
    });
  }
  el<HTMLInputElement>('additional-layers').addEventListener('change', event => {
    const enabled = (event.target as HTMLInputElement).checked;
    const select = el<HTMLSelectElement>('replay-layer');
    select.querySelector('optgroup')?.remove();
    if (enabled) {
      const group = document.createElement('optgroup');
      group.label = 'Additional layers';
      for (const spec of Object.values(LAYER_SPECS)) {
        if (PRIMARY_LAYERS.includes(spec.id)) continue;
        const option = document.createElement('option');
        option.value = spec.id; option.textContent = spec.label;
        group.append(option);
      }
      select.append(group);
    } else if (!PRIMARY_LAYERS.includes(layer)) {
      layer = 'thermalVelocityV2Mps';
    }
    select.value = layer;
    update();
  });
  el<HTMLSelectElement>('replay-layer').addEventListener('change', event => {
    layer = (event.target as HTMLSelectElement).value as Layer;
    update();
  });
  el('select-blanchard').addEventListener('click', () => selectCell(manifest.siteCell, manifest.case.site.slug));
  el('replay-windgram').addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  let resizeTimer = 0;
  let viewport = windgramViewport();
  window.addEventListener('resize', () => {
    const next = windgramViewport();
    if (next === viewport) return;
    viewport = next;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(update, 150);
  });
  el('windgram-full-profile').addEventListener('click', () => {
    fullWindgramProfile = !fullWindgramProfile;
    update();
  });
  update();
}
main().catch(error => {
  console.error(error);
  set('replay-status', 'Forecast unavailable.');
  el('replay-status').hidden = false;
  el('replay-status').setAttribute('role', 'alert');
});
