import { Marker, type GeoJSONSource, type ExpressionSpecification } from 'maplibre-gl';
import { parseSiteForecast, type SiteForecast } from '@azohra/meteo.briefing/contract';
import { baseMap, onMapReady } from './map.ts';
import { DATA_BASE } from '../lib/site.ts';
import { buildWindgramView } from '../lib/windgram-view.ts';
import { renderWindgramSvg, renderWindgramKey } from '../lib/windgram-chart.ts';
import { buildSounding, readSounding } from '../lib/skewt.ts';
import { SkewTChart } from '../lib/skewt-chart.ts';
import { compassPoint } from '../lib/launches.ts';
import {
  LAYER_SPECS,
  PRIMARY_LAYERS,
  buildCellSiteForecast,
  displayMetric,
  historicalLabel,
  replayLocation,
  selectedState,
  type Layer,
  type RegionCatalogue,
  type ReplayHour,
  type ReplayManifest,
} from '../lib/soaring.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => { const node = el(id); if (node) node.textContent = text; };

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Forecast data unavailable (${response.status}).`);
  return response.json();
}

async function readOptional<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
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
  publishedProfileComparison: { exact: boolean; differences: unknown[] }; limitations: string[];
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
interface LaunchEntry {
  slug: string; name: string; latitude: number; longitude: number; timeZone: string;
  cellIndex: number; gridIndex: number; distanceKm: number; launchElevationM: number | null; modelElevationM: number | null;
  facingDeg?: number; windArcHalfWidthDeg?: number; windMinMph?: number; windMaxMph?: number; gustMaxMph?: number;
  models: Record<string, {
    referenceTime?: string; modelElevationM?: number | null;
    hours: {
      validAt: string; tempC?: number | null; dewPointC?: number | null;
      windSpeedMps?: number | null; windDirectionDeg?: number | null; windGustMps?: number | null;
      cloudCoverPct?: number | null; pblHeightM?: number | null; sensibleHeatWm2?: number | null;
      wstarMps?: number | null; usableLiftTopM?: number | null;
      wstarV2Mps?: number | null; usableLiftTopV2M?: number | null; hcritWxtoflyM?: number | null;
      resolvedThermalTopM?: number | null; mixedLayerLclM?: number | null;
      experimentalTerrain?: ExperimentalTerrain | null;
      blTopM?: number | null; cloudBaseM?: number | null;
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
const MPS_TO_MPH = 2.23693629;
const MPS_TO_FPM = 196.850394;
const fmtFt = (m: number | null | undefined) => m == null ? '–' : `${Math.round(m * M_TO_FT).toLocaleString('en-US')} ft`;
const fmtM = (m: number | null | undefined, datum = 'MSL') => m == null ? 'Unavailable' : `${m.toFixed(1)} m ${datum} (${Math.round(m * M_TO_FT).toLocaleString('en-US')} ft)`;

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

  for (const ftVal of [0, 3000, 6000, 9000, 11500]) {
    const mVal = ftVal / M_TO_FT;
    const y = yOf(mVal);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(left)); line.setAttribute('x2', String(width - right));
    line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#888'); line.setAttribute('stroke-opacity', '0.2');
    svg.append(line);
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', String(left - 6)); lbl.setAttribute('y', String(y + 4));
    lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('font-size', '10'); lbl.setAttribute('fill', 'currentColor');
    lbl.textContent = `${(ftVal / 1000).toFixed(ftVal % 1000 ? 1 : 0)}k ft`;
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
    const resTop = hour.resolvedThermalTopM?.[ci] ?? hour.boundaryLayerTopM[ci];
    const wstar = hour.thermalVelocityV2Mps?.[ci] ?? hour.thermalVelocityMps[ci] ?? 0;

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
    const pts: string[] = [];
    nodes.forEach(n => {
      const v = vals[n.nodeIndex];
      if (v != null && Number.isFinite(v)) pts.push(`${xOf(n.distanceKm).toFixed(1)},${yOf(v).toFixed(1)}`);
    });
    if (pts.length < 2) return;
    const pl = document.createElementNS(ns, 'polyline');
    pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', color);
    pl.setAttribute('stroke-width', String(widthPx));
    if (dash) pl.setAttribute('stroke-dasharray', dash);
    pl.setAttribute('points', pts.join(' '));
    pl.setAttribute('pointer-events', 'none');
    svg.append(pl);
  };

  drawLine(nodes.map(n => hour.surfaceLclM?.[n.cellIndex] ?? hour.cloudBaseM[n.cellIndex]), '#7c689c', '5,3', 1.8);
  drawLine(nodes.map(n => hour.resolvedThermalTopM?.[n.cellIndex]), '#237e81', '', 2.4);
  drawLine(nodes.map(n => hour.usableLiftTopV2M?.[n.cellIndex] ?? hour.usableLiftTopM[n.cellIndex]), '#d99b26', '', 2.2);

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
    txt.textContent = `${n.waypointLabel} (${n.distanceKm.toFixed(0)} km)`;
    svg.append(txt);
  });

  const leg = document.createElementNS(ns, 'text');
  leg.setAttribute('x', String(left + 6)); leg.setAttribute('y', '16');
  leg.setAttribute('font-size', '10.5'); leg.setAttribute('fill', 'currentColor');
  leg.textContent = 'Teal: thermal top · Gold: usable lift top · Purple: potential cloud base · Dots: launches · Heights above sea level';
  svg.append(leg);

  return svg;
}

async function main() {
  const location = replayLocation(window.location.search, DATA_BASE);
  const pointer = await read<{ bundle: string }>(`${location.root}/index.json`);
  if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error('Invalid replay bundle pointer');
  const root = `${location.root}/${pointer.bundle}`;
  const manifest = await read<ReplayManifest>(`${root}/manifest.json`);
  if (manifest.schemaVersion !== 1 || manifest.case.id !== location.caseId) throw new Error('Replay manifest mismatch');
  const [grid, profileData, audit, hours, launchesDoc, crossSectionDoc, verificationDoc, regionsCatalogue] = await Promise.all([
    read<Grid>(`${root}/grid.geojson`),
    read<unknown>(`${root}/profile.json`),
    read<Audit>(`${root}/audit.json`),
    Promise.all(manifest.hours.map(h => read<ReplayHour>(`${root}/${h.file}`))),
    readOptional<LaunchesDoc>(`${root}/launches.json`),
    readOptional<CrossSectionDoc>(`${root}/cross-section.json`),
    readOptional<VerificationDoc>(`${root}/verification.json`),
    readOptional<RegionCatalogue>(`${DATA_BASE.replace(/\/$/, '')}/soaring/v1/regions.json`),
  ]);
  const blanchardProfile = parseSiteForecast(profileData);
  if (!blanchardProfile || blanchardProfile.hours.length !== hours.length || blanchardProfile.hours.some((h, i) => h.validAt !== hours[i].validAt)) {
    throw new Error('Invalid or unsynchronized Blanchard profile');
  }

  let requested = location.hour;
  let layer: Layer = 'thermalVelocityV2Mps';
  let selectedCell = manifest.siteCell;
  let showBarbs = true;
  let playTimer: number | null = null;

  const slider = el<HTMLInputElement>('replay-hour');
  const prev = el<HTMLButtonElement>('replay-prev');
  const next = el<HTMLButtonElement>('replay-next');
  const playBtn = el<HTMLButtonElement>('replay-play');
  const regionSelect = el<HTMLSelectElement>('replay-region-select');
  const launchSelect = el<HTMLSelectElement>('replay-launch-select');
  const barbsCheckbox = el<HTMLInputElement>('toggle-barbs');

  if (regionSelect && regionsCatalogue?.regions?.length) {
    regionSelect.replaceChildren();
    for (const r of regionsCatalogue.regions) {
      const opt = document.createElement('option');
      opt.value = r.caseId;
      const available = r.status === 'active-verified-trial';
      opt.textContent = `${r.name}${available ? '' : ' — unavailable'}`;
      opt.disabled = !available;
      if (r.caseId === location.caseId) opt.selected = true;
      regionSelect.append(opt);
    }
    regionSelect.addEventListener('change', () => {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('case', regionSelect.value);
      window.location.href = nextUrl.toString();
    });
  }

  slider.max = String(hours.length - 1);
  el('replay-content').hidden = false;
  set('replay-status', '');
  el('replay-status').hidden = true;
  set('replay-run', historicalLabel(manifest.case.referenceTime));
  set('select-blanchard', `Back to ${manifest.case.site.name}`);
  const activeRegionMeta = regionsCatalogue?.regions?.find(r => r.caseId === location.caseId);
  if (activeRegionMeta) {
    set('launches-heading', `Compare launches · ${activeRegionMeta.name}`);
  }
  if (crossSectionDoc) {
    set('cross-section-route', crossSectionDoc.nodes.filter(n => n.waypointLabel).map(n => n.waypointLabel).join(' → '));
  }
  if (launchesDoc?.nwsOffice?.office) {
    set('nws-afd-summary', `Area Forecast Discussion · NWS ${launchesDoc.nwsOffice.office}`);
  }

  const launches = launchesDoc?.launches ?? [];
  const launchByCell = new Map<number, LaunchEntry>();
  if (launches.length && launchSelect) {
    launchSelect.replaceChildren();
    for (const l of launches) {
      launchByCell.set(l.cellIndex, l);
      const opt = document.createElement('option');
      opt.value = l.slug;
      opt.textContent = l.name;
      if (l.slug === manifest.case.site.slug || l.cellIndex === manifest.siteCell) opt.selected = true;
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
      m.title = `${l.name} launch (${l.launchElevationM ?? '–'} m MSL)`;
      m.addEventListener('click', e => {
        e.stopPropagation();
        selectedCell = l.cellIndex;
        update();
      });
      new Marker({ element: m }).setLngLat([l.longitude, l.latitude]).addTo(map);
    }
  } else {
    const launch = manifest.case.site;
    const marker = document.createElement('div');
    marker.style.cssText = 'background:#111;border:3px solid white;border-radius:50%;width:17px;height:17px;box-shadow:0 0 0 2px #111';
    marker.title = 'Blanchard launch';
    new Marker({ element: marker }).setLngLat([launch.longitude, launch.latitude]).addTo(map);
  }

  let soundingChart = new SkewTChart(el('replay-sounding'), { name: manifest.case.site.name, elevationM: manifest.case.launchElevation.elevationM });
  let currentWindgramCell = -1;
  let currentView = buildWindgramView(blanchardProfile, {
    timeZone: manifest.case.site.timeZone,
    widthPx: 1100,
    launch: { elevationM: manifest.case.launchElevation.elevationM, name: 'Blanchard launch' },
  });
  let cursor: SVGRectElement | null = null;

  function renderActiveCellWindgram(activeProfile: SiteForecast, cellIdx: number, index: number) {
    const matchedLaunch = launchByCell.get(cellIdx);
    const launchMeta = matchedLaunch && matchedLaunch.launchElevationM != null
      ? { elevationM: matchedLaunch.launchElevationM, name: `${matchedLaunch.name} launch` }
      : cellIdx === manifest.siteCell
        ? { elevationM: manifest.case.launchElevation.elevationM, name: `${manifest.case.site.name} launch` }
        : null;

    if (currentWindgramCell !== cellIdx) {
      currentWindgramCell = cellIdx;
      currentView = buildWindgramView(activeProfile, {
        timeZone: manifest.case.site.timeZone,
        widthPx: 1100,
        launch: launchMeta,
      });
      el('replay-windgram').innerHTML = renderWindgramSvg(currentView, { idPrefix: 'soaring' });
      el('windgram-key').innerHTML = renderWindgramKey();
      const svg = el('replay-windgram').querySelector('svg')!;
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
      })) {
        cursor.setAttribute(key, String(value));
      }
      svg.append(cursor);
      svg.addEventListener('click', event => {
        const matrix = svg.getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        const clickedIdx = Math.max(0, Math.min(hours.length - 1, Math.floor((point.x - currentView.left) / (currentView.plotWidth / hours.length))));
        requested = hours[clickedIdx].forecastHour;
        update();
      });
    }
    if (cursor && currentView.hours[index]) {
      cursor.setAttribute('x', String(currentView.hours[index].x - currentView.plotWidth / hours.length / 2));
    }
  }

  const inv = verificationDoc?.hrrrWrfprsInventory;
  set('audit-summary', 'About this forecast');
  set(
    'audit-results',
    `${audit.mapProfileAgreement.valuesChecked} identical published values across ${audit.mapProfileAgreement.hours} hours. ` +
    `${audit.publishedProfileComparison.exact ? 'The saved October 21 profile matches exactly, excluding generation time.' : `${audit.publishedProfileComparison.differences.length} differences from the saved October 21 profile.`} ` +
    `Sample distance: ${audit.sampledCell.distanceKm.toFixed(2)} km. Model terrain: ${audit.terrain.modelElevationM} m; launch terrain: ${audit.terrain.launch.elevationM} m (raw MSL heights preserved). ` +
    (inv ? `HRRR wrfprs index inventory: ${inv.totalGribRecordsPerHour} records/hour (${inv.availablePressureLevelsCount} pressure levels available, including sub-925 hPa levels ${inv.availableSub925PressureLevelsHpa.join(', ')} hPa, 80 m AGL wind, and explicit cloud base/ceiling/LCL fields).` : ''),
  );
  for (const limitation of audit.limitations) {
    const li = document.createElement('li');
    li.textContent = limitation;
    el('audit-limitations').append(li);
  }
  el<HTMLAnchorElement>('audit-download').href = `${root}/audit.json`;

  // Populate Matched Observation Verification table & rejected KUIL notice
  const obsSkill = verificationDoc?.observationVerificationSkill;
  if (obsSkill && el('raob-table-body')) {
    const rejectedText = obsSkill.rejectedMismatchedComparisons?.map(r => `${r.stationId} vs ${r.siteSlug} (${r.matchStatus}: ${r.distanceKm} km, Δt=${r.timeDeltaMinutes} min)`).join(' · ') ?? '';
    set(
      'raob-meta',
      `${obsSkill.matchedCount} matched RAOB pairs (distance ≤ 60 km, valid time 2026-10-21 00:00Z). ` +
      (rejectedText ? `Excluded from site skill: ${rejectedText}.` : ''),
    );
    const tbody = el('raob-table-body');
    tbody.replaceChildren();
    for (const pair of obsSkill.matchedPairs) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><strong>${pair.station.id} &rarr; ${pair.siteName}</strong> <span class="muted">(${pair.station.distanceKm} km)</span></td>` +
        `<td><code>${pair.model}</code></td>` +
        `<td>${pair.regime} (${pair.leadTimeBucket})</td>` +
        `<td>${pair.metrics.temperatureMaeC?.toFixed(2) ?? '–'}°C (${pair.metrics.temperatureBiasC != null && pair.metrics.temperatureBiasC >= 0 ? '+' : ''}${pair.metrics.temperatureBiasC?.toFixed(2) ?? '–'}°C)</td>` +
        `<td>${pair.metrics.dewPointMaeC?.toFixed(2) ?? '–'}°C</td>` +
        `<td>${pair.metrics.windVectorRmseMps?.toFixed(2) ?? '–'} m/s</td>`;
      tbody.append(tr);
    }
  }
  if (verificationDoc?.wrfPilotDomain && el('wrf-lifecycle-summary')) {
    const w = verificationDoc.wrfPilotDomain;
    const lc = verificationDoc.lifecycleAudit ?? [];
    el('wrf-lifecycle-summary').innerHTML =
      `<p><strong>${w.label} (<code>${w.modelSlug}</code>):</strong> Pinned WRF-ARW ${w.wrfRelease} 3:1 nested domain — ` +
      `<code>d01</code> 3 km (${w.domains[0]?.eWe}×${w.domains[0]?.eSn}) &rarr; <code>d02</code> 1 km (${w.domains[1]?.eWe}×${w.domains[1]?.eSn}, ${w.domains[1]?.eVert} vertical levels, explicit convection <code>cu_physics=0</code>, ${w.physics.blPblPhysics}).</p>` +
      `<ul style="margin:.4rem 0 0;padding-left:1.1rem">${lc.map(item => `<li><code>${item.slug}</code>: catalogue sunset ${item.catalogueSunset}, official transition <strong>${item.officialTransition}</strong> &rarr; <code>${item.successor}</code> (${item.status})</li>`).join('')}</ul>`;
  }
  if (launchesDoc?.nwsOffice?.products?.afd?.text && el('nws-afd-text')) {
    set('nws-afd-text', launchesDoc.nwsOffice.products.afd.text.trim());
  }

  let ready = false;
  function update() {
    const state = selectedState(manifest, hours, requested), { hour, index } = state;
    requested = hour.forecastHour;
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', state.validLabel);
    prev.disabled = index === 0;
    next.disabled = index === hours.length - 1;
    set('replay-valid', state.validLabel);
    const properties = grid.features[selectedCell].properties;
    const matchedLaunch = launchByCell.get(selectedCell);
    const activeLabel = matchedLaunch?.name ?? (selectedCell === manifest.siteCell ? manifest.case.site.name : 'Selected location');
    set('cell-title', activeLabel);
    set(
      'cell-location',
      `${properties.latitude.toFixed(4)}°, ${properties.longitude.toFixed(4)}° · model terrain ${properties.modelElevationM ?? 'unavailable'} m MSL` +
      (matchedLaunch?.launchElevationM != null ? ` · 3DEP launch ${matchedLaunch.launchElevationM} m MSL` : ''),
    );

    if (launchSelect) {
      launchSelect.value = matchedLaunch?.slug ?? '';
    }

    const cellForecast = selectedCell === manifest.siteCell
      ? blanchardProfile!
      : buildCellSiteForecast(manifest, hours, selectedCell, properties, matchedLaunch?.name ?? `Cell ${properties.gridIndex}`) ?? blanchardProfile!;
    set('windgram-heading', `${activeLabel} · Windgram`);
    set('sounding-heading', `${activeLabel} · Sounding`);
    set('sounding-valid', state.validLabel);

    renderActiveCellWindgram(cellForecast, selectedCell, index);
    el('replay-windgram').dataset.validAt = hour.validAt;
    el('replay-sounding').dataset.validAt = hour.validAt;
    el('soaring-map').dataset.validAt = hour.validAt;

    const elevForSounding = matchedLaunch?.launchElevationM ?? (selectedCell === manifest.siteCell ? manifest.case.launchElevation.elevationM : properties.modelElevationM);
    soundingChart = new SkewTChart(el('replay-sounding'), { name: cellForecast.site.name, elevationM: elevForSounding });
    const builtSounding = buildSounding(cellForecast, cellForecast.hours[index]);
    soundingChart.set(builtSounding);
    if (builtSounding && el('sounding-findings')) {
      const reading = readSounding(builtSounding, elevForSounding);
      set('sounding-headline', reading.headline);
      const flist = el('sounding-findings');
      flist.replaceChildren();
      for (const f of reading.findings) {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${f.title}:</strong> ${f.text}`;
        flist.append(li);
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
    const hrrrLaunchHour = matchedLaunch?.models?.['hrrr-conus']?.hours?.find(mh => mh.validAt === hour.validAt);
    const expTerr = hrrrLaunchHour?.experimentalTerrain;
    const detailRows: [string, string][] = [
      ['Thermal strength W* (v2 / v1)', `${displayMetric(hour.thermalVelocityV2Mps?.[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])} · v1: ${displayMetric(hour.thermalVelocityMps[selectedCell], 'thermalVelocityMps', hour.status[selectedCell])}`],
      ['Usable-lift top (v2 / v1, 1.0 m/s)', `${displayMetric(hour.usableLiftTopV2M?.[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])} · v1: ${displayMetric(hour.usableLiftTopM[selectedCell], 'usableLiftTopM', hour.status[selectedCell])}`],
      ['WxToFly Hcrit (v2, 225 ft/min)', displayMetric(hour.hcritWxtoflyM?.[selectedCell], 'hcritWxtoflyM', hour.status[selectedCell])],
      ['Resolved thermal top (v2)', fmtM(hour.resolvedThermalTopM?.[selectedCell], 'MSL')],
      ['+1 °C thermal top sensitivity', fmtM(hour.thermalTopPlus1CM?.[selectedCell], 'MSL')],
      ['Baseline parcel top (v1)', fmtM(hour.boundaryLayerTopM[selectedCell], 'MSL')],
      ['HRRR model PBL (HPBL)', fmtM(hour.pblHeightM[selectedCell], 'AGL')],
      ['Surface LCL (Cu base)', fmtM(hour.surfaceLclM?.[selectedCell] ?? hour.cloudBaseM[selectedCell], 'MSL')],
      ['Mixed-layer LCL (zblcl, physical)', fmtM(hour.mixedLayerLclM?.[selectedCell], 'MSL')],
      ['Cu / OD potential', `${hour.cuPotentialM?.[selectedCell] != null ? `${hour.cuPotentialM[selectedCell]! >= 0 ? '+' : ''}${hour.cuPotentialM[selectedCell]!.toFixed(0)} m` : '–'} / ${hour.odPotentialM?.[selectedCell] != null ? `${hour.odPotentialM[selectedCell]! >= 0 ? '+' : ''}${hour.odPotentialM[selectedCell]!.toFixed(0)} m` : '–'}`],
      ['10 m wind (gust)', w10s != null && w10d != null ? `${compassPoint(w10d)} (${w10d.toFixed(0)}°) @ ${(w10s * MPS_TO_MPH).toFixed(1)} mph${w10g != null ? ` (gust ${(w10g * MPS_TO_MPH).toFixed(1)} mph)` : ''}` : 'Unavailable'],
      ['Experimental launch-alt wind', expTerr ? (expTerr.bracketsLaunchAltitude && expTerr.launchWindSpeedMps != null && expTerr.launchWindDirectionDeg != null ? `${compassPoint(expTerr.launchWindDirectionDeg)} (${expTerr.launchWindDirectionDeg.toFixed(0)}°) @ ${(expTerr.launchWindSpeedMps * MPS_TO_MPH).toFixed(1)} mph at ${expTerr.launchElevationM} m (raw MSL heights preserved)` : `Launch (${expTerr.launchElevationM} m) outside profile bracket`) : 'Select a named launch to inspect'],
      ['BL mean wind & shear', blws != null && blwd != null ? `${compassPoint(blwd)} (${blwd.toFixed(0)}°) @ ${(blws * MPS_TO_MPH).toFixed(1)} mph · shear ${blsh?.toFixed(1) ?? '–'} m/s (B/S ${bsr?.toFixed(2) ?? '–'})` : 'Unavailable'],
      ['925 hPa w & 10 m convergence', `${hour.w925Mps?.[selectedCell] != null ? `${hour.w925Mps[selectedCell]! >= 0 ? '+' : ''}${hour.w925Mps[selectedCell]!.toFixed(2)} m/s` : '–'} · ${hour.convergence10mX1e5?.[selectedCell] != null ? `${hour.convergence10mX1e5[selectedCell]! >= 0 ? '+' : ''}${hour.convergence10mX1e5[selectedCell]!.toFixed(1)} ×10⁻⁵ s⁻¹` : '–'}`],
      ['Sensible / latent heat flux', `${hour.sensibleHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} / ${hour.latentHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} W/m²`],
      ['Clouds (total / low / mid / high)', `${hour.cloudCoverPercent?.[selectedCell]?.toFixed(0) ?? '–'}% (${hour.lowCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.midCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.highCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}%)`],
    ];
    const primaryRows: [string, string][] = [
      ['Thermal strength', displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])],
      ['Usable lift top', displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])],
      ['Potential cloud base', fmtFt((hour.surfaceLclM ?? hour.cloudBaseM)[selectedCell])],
      ['Surface wind', w10s != null && w10d != null ? `${compassPoint(w10d)} ${(w10s * MPS_TO_MPH).toFixed(0)} mph${w10g != null ? ` · gusts ${(w10g * MPS_TO_MPH).toFixed(0)}` : ''}` : 'Unavailable'],
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
      ? 'Too little height data to estimate lift.'
      : hour.status[selectedCell] === 'missing'
        ? 'Lift forecast unavailable here.'
        : hour.ceilingReached[selectedCell] ? 'Thermal height may extend above the available data.' : '';
    set('cell-notice', notice);
    el('cell-notice').hidden = !notice;
    set(
      'cell-quality',
      `${hour.levelCount[selectedCell]} usable above-ground levels (sparse 9-level profile preserved; 0 synthetic levels). ` +
      (hour.ceilingReached[selectedCell]
        ? 'Thermal calculation reaches the sampled-column ceiling.'
        : hour.status[selectedCell] === 'valid'
          ? 'Thermal crossing lies within the sampled column.'
          : 'Lift diagnostics are masked.'),
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
      key.append(swatch, stop.toLocaleString('en-US'));
      scale.append(key);
    }
    const explanation = document.createElement('span');
    explanation.className = 'muted';
    const liftTopLayer = ['usableLiftTopV2M', 'usableLiftTopM', 'hcritWxtoflyM', 'dryHcritM', 'resolvedThermalTopM'].includes(layer);
    explanation.textContent = 'Gray: unavailable · Purple: limited height data' + (liftTopLayer ? ' · Beige: no usable lift' : '');
    if (layer === 'usableLiftTopV2M' || layer === 'usableLiftTopM') legendTitle.textContent += ' · 1.0 m/s sink';
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
        const wstar = hour.thermalVelocityV2Mps?.[ci] ?? hour.thermalVelocityMps[ci];
        const uTop = hour.usableLiftTopV2M?.[ci] ?? hour.usableLiftTopM[ci];
        const wxTop = hour.hcritWxtoflyM?.[ci];
        const rTop = hour.resolvedThermalTopM?.[ci];
        const v1Top = hour.boundaryLayerTopM[ci];
        const hpbl = hour.pblHeightM[ci];
        const lcl = hour.surfaceLclM?.[ci] ?? hour.cloudBaseM[ci];
        const cu = hour.cuPotentialM?.[ci];
        const od = hour.odPotentialM?.[ci];
        const ws = hour.wind10mSpeedMps?.[ci];
        const wd = hour.wind10mDirDeg?.[ci];
        const blw = hour.blMeanWindSpeedMps?.[ci];
        const bls = hour.blWindShearMps?.[ci];
        const conv = hour.convergence10mX1e5?.[ci];

        tr.innerHTML =
          `<td><strong>${l.name}</strong> <span class="muted">(${l.launchElevationM != null ? `${Math.round(l.launchElevationM)}m` : '–'} / ${l.modelElevationM != null ? `${Math.round(l.modelElevationM)}m` : '–'})</span></td>` +
          `<td>${wstar != null ? `${wstar.toFixed(2)} m/s (${Math.round(wstar * MPS_TO_FPM)})` : '–'}</td>` +
          `<td>${fmtFt(uTop)}</td>` +
          `<td>${fmtFt(wxTop)}</td>` +
          `<td>${rTop != null ? fmtFt(rTop) : '<span class="muted">Stable</span>'}</td>` +
          `<td>${fmtFt(v1Top)}</td>` +
          `<td>${hpbl != null ? `${Math.round(hpbl)} m` : '–'}</td>` +
          `<td>${fmtFt(lcl)}</td>` +
          `<td>${cu != null ? `${cu >= 0 ? '+' : ''}${cu.toFixed(0)}` : '–'} / ${od != null ? `${od >= 0 ? '+' : ''}${od.toFixed(0)} m` : '–'}</td>` +
          `<td>${ws != null && wd != null ? `${compassPoint(wd)} ${(ws * MPS_TO_MPH).toFixed(0)} mph` : '–'}</td>` +
          `<td>${blw != null ? `${(blw * MPS_TO_MPH).toFixed(0)} mph` : '–'} / ${bls != null ? `${bls.toFixed(1)} m/s` : '–'}</td>` +
          `<td>${conv != null ? `${conv >= 0 ? '+' : ''}${conv.toFixed(0)}` : '–'}</td>`;
        tr.addEventListener('click', () => {
          selectedCell = ci;
          update();
        });
        detailBody.append(tr);
        const simpleRow = document.createElement('tr');
        simpleRow.className = tr.className;
        const launchCell = document.createElement('td');
        const launchButton = document.createElement('button');
        launchButton.type = 'button'; launchButton.className = 'launch-link';
        launchButton.textContent = l.name;
        launchButton.addEventListener('click', () => { selectedCell = ci; update(); });
        launchCell.append(launchButton);
        simpleRow.append(launchCell);
        const readings = [
          displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[ci], 'thermalVelocityV2Mps', hour.status[ci]),
          displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[ci], 'usableLiftTopV2M', hour.status[ci]),
          fmtFt(lcl),
          ws != null && wd != null ? `${compassPoint(wd)} ${(ws * MPS_TO_MPH).toFixed(0)} mph` : 'Unavailable',
        ];
        for (const reading of readings) {
          const td = document.createElement('td'); td.textContent = reading; simpleRow.append(td);
        }
        simpleRow.addEventListener('click', event => {
          if (!(event.target as HTMLElement).closest('button')) { selectedCell = ci; update(); }
        });
        tbody.append(simpleRow);
      }
    }

    if (crossSectionDoc && el('replay-cross-section')) {
      const host = el('replay-cross-section');
      host.replaceChildren(
        renderCrossSectionSvg(crossSectionDoc, hour, selectedCell, ci => {
          selectedCell = ci;
          update();
        }),
      );
    }

    const activeLaunch = matchedLaunch ?? launches.find(l => l.slug === manifest.case.site.slug) ?? launches[0];
    if (activeLaunch && el('multimodel-table-body')) {
      const tbody = el('multimodel-table-body');
      tbody.replaceChildren();
      const modelLabels: [string, string][] = [
        ['hrrr-conus', 'HRRR'],
        ['hrdps-continental', 'HRDPS'],
        ['rdps', 'RDPS'],
        ['gdps', 'GDPS'],
        ['gfs', 'GFS'],
        ['ecmwf', 'ECMWF'],
        ['nws', 'NWS'],
      ];
      for (const [mslug, mlabel] of modelLabels) {
        const mdata = activeLaunch.models[mslug];
        if (!mdata) continue;
        const mh = mdata.hours.find(h => h.validAt === hour.validAt) ?? mdata.hours[0];
        if (!mh) continue;
        const isSparseAdapter = mslug === 'ecmwf' || mslug === 'nws';
        const wstarVal = isSparseAdapter ? null : (mh.wstarV2Mps ?? mh.wstarMps);
        const uTopVal = isSparseAdapter ? null : (mh.usableLiftTopV2M ?? mh.usableLiftTopM);
        const blTopVal = isSparseAdapter ? mh.blTopM : (mh.resolvedThermalTopM ?? mh.blTopM);
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td><strong>${mlabel}</strong></td>` +
          `<td>${mdata.referenceTime ? mdata.referenceTime.slice(5, 16).replace('T', ' ') + 'Z' : '–'}</td>` +
          `<td>${mdata.modelElevationM != null ? `${Math.round(mdata.modelElevationM)} m` : '–'}</td>` +
          `<td>${mh.tempC != null ? `${mh.tempC.toFixed(1)}°C` : '–'}${mh.dewPointC != null ? ` / ${mh.dewPointC.toFixed(1)}°C` : ''}</td>` +
          `<td>${mh.windDirectionDeg != null ? `${compassPoint(mh.windDirectionDeg)} ` : ''}${mh.windSpeedMps != null ? `${(mh.windSpeedMps * MPS_TO_MPH).toFixed(1)} mph` : '–'}${mh.windGustMps != null ? ` (g ${(mh.windGustMps * MPS_TO_MPH).toFixed(0)})` : ''}</td>` +
          `<td>${isSparseAdapter ? '<span class="muted" title="Unsupported: adapter lacks surface heat fluxes and dense vertical profile">Unavailable</span>' : (wstarVal != null ? `${wstarVal.toFixed(2)} m/s` : '–')}</td>` +
          `<td>${isSparseAdapter ? '<span class="muted" title="Unsupported: adapter lacks surface heat fluxes and dense vertical profile">Unavailable</span>' : fmtFt(uTopVal)}</td>` +
          `<td>${fmtFt(blTopVal)}${mh.pblHeightM != null ? ` (${Math.round(mh.pblHeightM)} m AGL)` : ''}</td>` +
          `<td>${fmtFt(mh.cloudBaseM)}${mh.cloudCoverPct != null ? ` (${Math.round(mh.cloudCoverPct)}%)` : ''}</td>`;
        tbody.append(tr);
      }
    }

    if (ready) {
      const arr = (hour[layer] as (number | null)[] | undefined) ?? hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps;
      const data = {
        ...grid,
        features: grid.features.map((f, i) => ({
          ...f,
          properties: {
            ...f.properties,
            quality: hour.status[i],
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
        const arrowFeatures = [];
        if (showBarbs) {
          for (let i = 0; i < grid.features.length; i += 3) {
            const ws = wsArr[i], wd = wdArr[i];
            if (ws == null || wd == null) continue;
            const c = grid.features[i].properties;
            const rad = ((wd + 180) * Math.PI) / 180;
            const lenDeg = Math.min(0.06, 0.012 + ws * 0.004);
            const dLon = (lenDeg * Math.sin(rad)) / Math.cos((c.latitude * Math.PI) / 180);
            const dLat = lenDeg * Math.cos(rad);
            arrowFeatures.push({
              type: 'Feature' as const,
              properties: { speedMps: ws },
              geometry: {
                type: 'LineString' as const,
                coordinates: [
                  [c.longitude, c.latitude],
                  [c.longitude + dLon, c.latitude + dLat],
                ],
              },
            });
          }
        }
        windSource.setData({ type: 'FeatureCollection', features: arrowFeatures });
      }
    }

    const url = new URL(window.location.href);
    url.searchParams.set('case', location.caseId);
    url.searchParams.set('hour', String(requested));
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
      id: 'wind-vectors-line',
      type: 'line',
      source: 'wind-vectors',
      paint: { 'line-color': '#1f2937', 'line-width': 1.5, 'line-opacity': 0.75 },
    });

    map.fitBounds([[west, south], [east, north]], { padding: 20, duration: 0 });
    map.on('click', 'lift-fill', event => {
      const index = event.features?.[0]?.properties?.cellIndex;
      if (typeof index === 'number') {
        selectedCell = index;
        update();
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
        selectedCell = found.cellIndex;
        update();
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
  el('select-blanchard').addEventListener('click', () => { selectedCell = manifest.siteCell; update(); });
  el('replay-windgram').addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  update();
}
main().catch(error => {
  console.error(error);
  set('replay-status', 'This forecast is unavailable. Please try again later.');
  el('replay-status').hidden = false;
  el('replay-status').setAttribute('role', 'alert');
});
