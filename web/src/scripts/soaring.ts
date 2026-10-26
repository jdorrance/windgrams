import { formatQuantity, getUnitSystem } from '../lib/units.ts';
import { readRegionalJson } from '../lib/regional-data.ts';
import { openRegionalDataset } from '@windgrams/data-client/dataset';
import { parseModelCatalogue, type SiteForecast } from '@azohra/meteo.briefing/contract';
import { localDateKey } from '@azohra/meteo.briefing/derive';
import { DATA_BASE } from '../lib/site.ts';
import { windgramDayHours } from '../lib/windgram-view.ts';
import { windgramViewport } from '../lib/windgram-viewport.ts';
import { buildSounding, readSounding } from '../lib/skewt.ts';
import { SkewTChart } from '../lib/skewt-chart.ts';
import { renderCrossSectionSvg } from '../lib/cross-section-view.ts';
import {
  buildLaunchComparisonRows,
  buildRegionalLaunchTableRows,
  formatRegionalWind,
  renderMultimodelComparisonBody,
  renderRaobVerificationTable,
  renderRegionalLaunchesTables,
} from '../lib/launch-comparison.ts';
import {
  validateRegionCatalogue,
  validateCrossSectionDoc,
  validateLaunchesDoc,
  validateReplayAudit,
  validateVerificationDoc,
} from '../lib/soaring-contracts.ts';
import {
  LAYER_SPECS,
  PRIMARY_LAYERS,
  refreshReplayLayerLabels,
  crossSectionHeightScale,
  displayMetric,
  defaultReplayQuery,
  forecastHourAtValidTime,
  historicalLabel,
  legacyReplayModel,
  modelLabel,
  nativeModels,
  regionForCase,
  replayLocation,
  replaySelection,
  hourIndex,
  localTime,
  setReplaySelectionQuery,
  type Layer,
  type RegionCatalogue,
  type ReplayHour,
} from '../lib/soaring.ts';
import { createSoaringMap } from './soaring-map.ts';
import { createKeyedAsyncLoader, createWindgramController } from './windgram-controller.ts';
import { createPageLifecycle } from './page-lifecycle.ts';
import { createFreshnessNotice } from './freshness-notice.ts';
import { createRefreshHealthReader } from '../lib/refresh-health.ts';
import type { ProviderRefresh } from '@windgrams/contracts/provider-health';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => { const node = el(id); if (node) node.textContent = text; };

async function readOptional<T>(url: string, validate: (raw: unknown) => T | null, signal: AbortSignal): Promise<T | null> {
  try {
    const raw = await readRegionalJson(url, { signal });
    return validate(raw);
  } catch {
    return null;
  }
}

const fmtFt = (m: number | null | undefined) => formatQuantity(m, 'elevation');
const fmtM = (m: number | null | undefined, datum = 'MSL') => m == null ? 'Unavailable' : `${formatQuantity(m, 'elevation')} ${datum}`;

async function main() {
  const requestQuery = new URLSearchParams(window.location.search);
  if (!requestQuery.has('country') && !requestQuery.has('case') && !requestQuery.has('region')) {
    try {
      const saved = sessionStorage.getItem('windgrams-country');
      if (saved && /^[A-Z]{2}$/.test(saved)) requestQuery.set('country', saved);
    } catch { /* Storage is optional. */ }
  }
  const country = requestQuery.get('country');
  if (country && /^[A-Z]{2}$/.test(country)) {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country;
    set('replay-title', `Soaring · ${name}`);
    const link = el('replay-launches').querySelector('a')!;
    const url = new URL(link.href);
    url.searchParams.set('country', country);
    link.href = url.toString();
    link.textContent = `${name} launches`;
  }
  let playTimer: number | null = null;
  let resizeTimer = 0;
  let initialized = false;
  const lifetime = createPageLifecycle({
    onSuspend() {
      window.clearTimeout(resizeTimer);
      if (playTimer !== null) {
        window.clearInterval(playTimer);
        playTimer = null;
        set('replay-play', '▶ Play');
      }
    },
    onRestore() { if (initialized) update(); },
  });
  const eventOptions = { signal: lifetime.signal };
  const modelCatalogue = readOptional(`${DATA_BASE.replace(/\/$/, '')}/models.json`, parseModelCatalogue, lifetime.signal);
  set('map-barb-units', getUnitSystem() === 'metric' ? '· 2.5 / 5 / 25 m/s' : '· 5 / 10 / 50 kt');
  const regionsCatalogue = await readOptional<RegionCatalogue>(`${DATA_BASE.replace(/\/$/, '')}/soaring/v1/regions.json`, validateRegionCatalogue, lifetime.signal);
  if (lifetime.disposed) return;
  const query = defaultReplayQuery(requestQuery.toString(), regionsCatalogue);
  const location = replayLocation(query.toString(), DATA_BASE);
  const dataset = await openRegionalDataset({ baseUrl: DATA_BASE, caseId: location.caseId, model: legacyReplayModel(location.caseId), signal: lifetime.signal });
  if (lifetime.disposed) return;
  const { manifest, grid } = dataset;
  const root = dataset.identity.bundleUrl;
  const activeModel = dataset.identity.model;
  const catalogue = await modelCatalogue;
  if (lifetime.disposed) return;
  const historical = !location.caseId.endsWith('-live');
  let refreshHealth: ProviderRefresh | null = null;
  const freshnessNotice = createFreshnessNotice(el('replay-freshness'), () => ({
    referenceTime: manifest.case.referenceTime,
    validUntil: manifest.hours.at(-1)?.validAt,
    policy: catalogue?.models.find(model => model.slug === activeModel),
    historical,
    refresh: refreshHealth,
  }), lifetime.signal);
  freshnessNotice.refresh();
  if (!historical) void createRefreshHealthReader({ baseUrl: DATA_BASE, signal: lifetime.signal })(activeModel).then(health => {
    if (lifetime.disposed) return;
    refreshHealth = health;
    freshnessNotice.refresh();
  });
  const activeRegionMeta = regionForCase(regionsCatalogue?.regions ?? [], location.caseId);
  const optionalBundle = <T>(name: string, validate: (raw: unknown) => T | null) =>
    manifest.files && !Object.hasOwn(manifest.files, name)
      ? Promise.resolve<T | null>(null)
      : readOptional<T>(`${root}/${name}`, validate, lifetime.signal);
  const hours = manifest.hours;
  const selectedValidHour = forecastHourAtValidTime(hours, query.get('valid'));
  let requested = selectedValidHour ?? location.hour;
  if (selectedValidHour === null && !query.has('hour') && location.caseId.endsWith('-live')) {
    requested = hours.reduce((best, h) => Math.abs(Date.parse(h.validAt) - Date.now()) < Math.abs(Date.parse(best.validAt) - Date.now()) ? h : best).forecastHour;
  }
  const initialIndex = hourIndex(hours, requested);
  const [initialHour, launchesDoc, crossSectionDoc, verificationDoc] = await Promise.all([
    dataset.loadHour(hours[initialIndex].validAt),
    optionalBundle('launches.json', validateLaunchesDoc),
    optionalBundle('cross-section.json', validateCrossSectionDoc),
    optionalBundle('verification.json', validateVerificationDoc),
  ]);
  if (lifetime.disposed) return;
  if (!initialHour) throw new Error('Selected forecast hour unavailable');
  let displayedHour = initialHour;
  let crossSectionScale = crossSectionDoc ? crossSectionHeightScale(crossSectionDoc.nodes, [initialHour]) : null;
  const availableLayers = new Set((Object.keys(LAYER_SPECS) as Layer[]).filter(key => Array.isArray(initialHour[key])));
  const defaultLayer: Layer = PRIMARY_LAYERS.find(candidate => availableLayers.has(candidate)) ?? [...availableLayers][0] ?? 'thermalVelocityV2Mps';
  let layer: Layer = defaultLayer;
  const layerSelect = el<HTMLSelectElement>('replay-layer');
  for (const option of [...layerSelect.options]) if (!availableLayers.has(option.value as Layer)) option.remove();
  refreshReplayLayerLabels(layerSelect.options);
  layerSelect.value = layer;

  const launches = launchesDoc?.launches ?? [];
  const launchByCell = new Map(launches.map(launch => [launch.cellIndex, launch]));
  let selection = replaySelection(query, grid.features.map(feature => feature.properties), launches, manifest.siteCell, grid);
  let selectedCell = selection.cellIndex;
  const launchForCell = (cellIndex: number) =>
    (cellIndex === selection.cellIndex && selection.launchSlug ? launches.find(launch => launch.slug === selection.launchSlug) : undefined)
    ?? launchByCell.get(cellIndex);

  let showBarbs = true;
  let fullWindgramProfile = false;
  const firstVisibleHour = 0;
  const lastVisibleHour = hours.length - 1;

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
      nextUrl.searchParams.delete('country');
      nextUrl.searchParams.delete('region');
      nextUrl.searchParams.delete('hour');
      window.location.href = nextUrl.toString();
    }, eventOptions);
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
    }, eventOptions);
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
  el('regional-nws').hidden = !launchesDoc?.nwsOffice?.products?.afd?.text;
  el('regional-observations').hidden = !verificationDoc?.observationVerificationSkill;
  const modelInformation = el('wrf-lifecycle-summary').closest<HTMLElement>('.reality-card');
  if (modelInformation) modelInformation.hidden = !verificationDoc?.wrfPilotDomain;
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

  function selectCell(cellIndex: number, launchSlug?: string) {
    if (lifetime.disposed) return;
    const cell = grid!.features[cellIndex]?.properties;
    if (!cell || cell.cellIndex !== cellIndex) return;
    const launch = launchSlug ? launches.find(entry => entry.slug === launchSlug && entry.cellIndex === cellIndex) : launchByCell.get(cellIndex);
    selectedCell = cellIndex;
    selection = {
      cellIndex,
      latitude: launch?.latitude ?? cell.latitude,
      longitude: launch?.longitude ?? cell.longitude,
      launchSlug: launch?.slug,
    };
    void profileLoader.select(cellIndex);
    update();
  }

  const soaringMap = createSoaringMap({
    host: el('soaring-map'),
    bbox: manifest.case.bbox,
    grid,
    siteCell: manifest.siteCell,
    site: manifest.case.site,
    launches,
    crossSectionDoc,
    onSelectCell: selectCell,
  });
  lifetime.onDispose(() => soaringMap.dispose());

  const soundingChart = new SkewTChart(el('replay-sounding'), {
    name: manifest.case.site.name,
    elevationM: manifest.case.launchElevation.elevationM,
  });
  lifetime.onDispose(() => soundingChart.dispose());
  let selectedProfile: { cellIndex: number; profile: SiteForecast | null; error: unknown } | null = null;
  const profileLoader = createKeyedAsyncLoader<number, SiteForecast>({
    load: cellIndex => dataset.loadCellProfile(cellIndex),
    onActiveComplete: (cellIndex, profile, error) => {
      selectedProfile = { cellIndex, profile, error };
      update();
    },
  });
  const hourLoader = createKeyedAsyncLoader<number, ReplayHour>({
    load: async index => {
      const hour = await dataset.loadHour(hours[index].validAt);
      if (!hour) throw new Error('Forecast hour unavailable');
      return hour;
    },
    onActiveComplete: (_index, hour) => {
      if (!hour) {
        set('cell-notice', 'Forecast unavailable for this hour. Try another hour.');
        el('cell-notice').hidden = false;
        return;
      }
      displayedHour = hour;
      if (crossSectionDoc) {
        const scale = crossSectionHeightScale(crossSectionDoc.nodes, [hour]);
        if (!crossSectionScale || scale.maxAltM > crossSectionScale.maxAltM) crossSectionScale = scale;
      }
      update();
    },
  });
  lifetime.onDispose(() => { profileLoader.dispose(); hourLoader.dispose(); });

  const windgramController = createWindgramController({
    host: el('replay-windgram'),
    axisHost: el('replay-height-axis'),
    keyHost: el('windgram-key'),
    fullProfileButton: el('windgram-full-profile'),
  });
  lifetime.onDispose(() => windgramController.dispose());

  function windgramLaunch(cellIdx: number) {
    const matchedLaunch = launchForCell(cellIdx);
    return matchedLaunch && matchedLaunch.launchElevationM != null
      ? { elevationM: matchedLaunch.launchElevationM, name: `${matchedLaunch.name} launch` }
      : cellIdx === manifest.siteCell
        ? { elevationM: manifest.case.launchElevation.elevationM, name: `${manifest.case.site.name} launch` }
        : null;
  }

  set('audit-summary', 'About this forecast');
  el('audit-limitations').replaceChildren();
  el<HTMLAnchorElement>('audit-download').href = `${root}/audit.json`;
  void optionalBundle('audit.json', raw => { try { return validateReplayAudit(raw); } catch { return null; } }).then(audit => {
    if (lifetime.disposed) return;
    el('audit-limitations').replaceChildren(...(audit?.limitations ?? []).map(limitation => {
      const item = document.createElement('li');
      item.textContent = limitation;
      return item;
    }));
    set('audit-results', audit
      ? `Grid point ${formatQuantity(audit.sampledCell.distanceKm, 'distance')} from launch · Model ground ${formatQuantity(audit.terrain.modelElevationM, 'elevation')} MSL · Launch ${formatQuantity(audit.terrain.launch.elevationM, 'elevation')} MSL`
      : 'Forecast details unavailable.');
  });

  const obsSkill = verificationDoc?.observationVerificationSkill;
  if (obsSkill && el('raob-table-body')) {
    const date = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const observationDays = [...new Set(obsSkill.matchedPairs.map(pair => pair.soundingValidAt.slice(0, 10)))].filter(day => Number.isFinite(Date.parse(day))).sort();
    const firstDay = observationDays[0], lastDay = observationDays.at(-1);
    const observationDates = firstDay ? `${date.format(new Date(firstDay))}${lastDay !== firstDay ? `–${date.format(new Date(lastDay!))}` : ''} UTC` : '';
    const evaluatedAt = verificationDoc?.evaluatedAt;
    const evaluated = evaluatedAt && Number.isFinite(Date.parse(evaluatedAt)) ? ` · evaluated ${date.format(new Date(evaluatedAt))} UTC` : '';
    const rejectedText = obsSkill.rejectedMismatchedComparisons?.map(r => `${r.stationId}: ${formatQuantity(r.distanceKm, 'distance')}, ${r.timeDeltaMinutes} min offset`).join(' · ') ?? '';
    set(
      'raob-meta',
      `Historical observations${observationDates ? ` · ${observationDates}` : ''}${evaluated} · ${obsSkill.matchedCount} matched station pairs.` +
      (rejectedText ? ` Excluded pairs: ${rejectedText}.` : ''),
    );
    renderRaobVerificationTable(el('raob-table-body'), obsSkill.matchedPairs);
  }
  if (verificationDoc?.wrfPilotDomain && el('wrf-lifecycle-summary')) {
    const w = verificationDoc.wrfPilotDomain;
    const grids = w.domains.map(domain => formatQuantity(domain.dxM / 1000, 'resolution')).join(' → ');
    set('wrf-lifecycle-summary', `Planned WRF-ARW trial over North Sound, with grid spacing of ${grids}.`);
  }
  if (launchesDoc?.nwsOffice?.products?.afd?.text && el('nws-afd-text')) {
    set('nws-afd-text', launchesDoc.nwsOffice.products.afd.text.trim());
  }

  function update() {
    if (lifetime.disposed) return;
    const properties = grid!.features[selectedCell].properties;
    const matchedLaunch = launchForCell(selectedCell);
    const activeLabel = matchedLaunch?.name ?? (selectedCell === manifest.siteCell ? manifest.case.site.name : 'Selected location');
    if (profileLoader.getActiveKey() !== selectedCell) void profileLoader.select(selectedCell);
    const cellForecast = selectedProfile?.cellIndex === selectedCell ? selectedProfile.profile : null;
    const index = hourIndex(hours, requested);
    slider.min = String(firstVisibleHour);
    slider.max = String(lastVisibleHour);
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', localTime(hours[index].validAt, manifest.case.site.timeZone));
    prev.disabled = index === firstVisibleHour;
    next.disabled = index === lastVisibleHour;
    if (hourLoader.getActiveKey() !== index) void hourLoader.select(index);
    if (displayedHour.validAt !== hours[index].validAt) {
      if (hourLoader.isPending(index)) {
        set('cell-notice', 'Loading forecast…');
        el('cell-notice').hidden = false;
      }
      return;
    }
    const hour = displayedHour;
    const validLabel = localTime(hour.validAt, manifest.case.site.timeZone);
    requested = hour.forecastHour;
    set('replay-valid', validLabel);
    set('cell-title', activeLabel);
    set(
      'cell-location',
      `${properties.latitude.toFixed(4)}°, ${properties.longitude.toFixed(4)}° · Model terrain ${fmtM(properties.modelElevationM)}` +
      (matchedLaunch?.launchElevationM != null ? ` · Launch terrain ${fmtM(matchedLaunch.launchElevationM)}` : ''),
    );

    if (launchSelect) {
      launchSelect.value = matchedLaunch?.slug ?? '';
    }

    set('windgram-heading', `${activeLabel} · Windgram`);
    set('sounding-heading', `${activeLabel} · Sounding`);
    set('sounding-valid', validLabel);
    if (cellForecast) {
      const dayHours = windgramDayHours(cellForecast, hours[index].validAt, manifest.case.site.timeZone);
      windgramController.render({
        cacheKey: selectedCell,
        profile: cellForecast,
        timeZone: manifest.case.site.timeZone,
        hours: dayHours,
        dateKey: localDateKey(hours[index].validAt, manifest.case.site.timeZone),
        selectedValidAt: hours[index]?.validAt ?? null,
        fullProfile: fullWindgramProfile,
        idPrefix: 'soaring',
        launch: windgramLaunch(selectedCell),
        onSelectHour: validAt => {
          const clickedHour = hours.find(h => h.validAt === validAt);
          if (!clickedHour) return;
          selectHour(clickedHour.forecastHour);
        },
      });
    } else {
      windgramController.clear();
      const error = selectedProfile?.cellIndex === selectedCell ? selectedProfile.error : null;
      set('replay-windgram', profileLoader.isPending(selectedCell) ? 'Loading profile…'
        : error ? `Profile unavailable: ${error instanceof Error ? error.message : String(error)}`
          : 'A complete profile is unavailable at this location.');
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
    const surfaceWind = formatRegionalWind(w10s, w10d);
    const surfaceWindBearing = formatRegionalWind(w10s, w10d, { bearing: true });
    const meanWind = formatRegionalWind(blws, blwd, { bearing: true });
    const launchWind = expTerr?.bracketsLaunchAltitude
      ? formatRegionalWind(expTerr.launchWindSpeedMps, expTerr.launchWindDirectionDeg, { bearing: true }) : null;
    const detailRows: [string, string][] = [
      ['Thermal strength · current / legacy', `${displayMetric(hour.thermalVelocityV2Mps?.[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])} · v1: ${displayMetric(hour.thermalVelocityMps[selectedCell], 'thermalVelocityMps', hour.status[selectedCell])}`],
      [`Usable lift top · ${formatQuantity(1, 'lift')} sink`, `${displayMetric(hour.usableLiftTopV2M?.[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])} · v1: ${displayMetric(hour.usableLiftTopM[selectedCell], 'usableLiftTopM', hour.status[selectedCell])}`],
      [`Paraglider ceiling · ${formatQuantity(1.143, 'lift')} sink`, displayMetric(hour.hcritWxtoflyM?.[selectedCell], 'hcritWxtoflyM', hour.status[selectedCell])],
      ['Thermal top (parcel)', fmtM(hour.resolvedThermalTopM?.[selectedCell], 'MSL')],
      [`Thermal top · +${formatQuantity(1, 'temperatureDelta')} sensitivity`, fmtM(hour.thermalTopPlus1CM?.[selectedCell], 'MSL')],
      ['Parcel top · legacy', fmtM(hour.boundaryLayerTopM[selectedCell], 'MSL')],
      [`${modelLabel(activeModel)} model boundary-layer depth`, fmtM(hour.pblHeightM[selectedCell], 'AGL')],
      ['Potential cloud base (surface LCL)', fmtM((hour.surfaceLclM ?? hour.cloudBaseM)[selectedCell], 'MSL')],
      ['Effective cloud limit (model near-saturation proxy)', fmtM((hour.effectiveCloudLimitM ?? hour.cloudBaseM)[selectedCell], 'MSL')],
      ['Mixed-layer cloud base', fmtM(hour.mixedLayerLclM?.[selectedCell], 'MSL')],
      ['Cu / OD potential', `${hour.cuPotentialM?.[selectedCell] != null ? `${hour.cuPotentialM[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.cuPotentialM[selectedCell], 'elevation')}` : '–'} / ${hour.odPotentialM?.[selectedCell] != null ? `${hour.odPotentialM[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.odPotentialM[selectedCell], 'elevation')}` : '–'}`],
      [`Wind at ${formatQuantity(10, 'elevation')} above model ground (gust)`, surfaceWindBearing ? `${surfaceWindBearing}${w10g != null ? ` (gust ${formatQuantity(w10g, 'wind')})` : ''}` : 'Unavailable'],
      ['Estimated wind at launch elevation · experimental', expTerr ? `${launchWind ?? 'Wind unavailable'} at launch (${formatQuantity(expTerr.launchElevationM, 'elevation')} MSL)${launchWind ? ' · local terrain flow unresolved' : ''}` : 'Select a launch'],
      ['BL mean wind & shear', meanWind ? `${meanWind} · shear ${formatQuantity(blsh, 'wind')} (B/S ${bsr?.toFixed(2) ?? '–'})` : 'Unavailable'],
      [`Vertical motion at ${formatQuantity(925, 'pressure')} / convergence`, `${hour.w925Mps?.[selectedCell] != null ? `${hour.w925Mps[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.w925Mps[selectedCell], 'lift')}` : '–'} · ${hour.convergence10mX1e5?.[selectedCell] != null ? `${hour.convergence10mX1e5[selectedCell]! >= 0 ? '+' : ''}${hour.convergence10mX1e5[selectedCell]!.toFixed(1)} ×10⁻⁵ s⁻¹` : '–'}`],
      ['Sensible / latent heat flux', `${hour.sensibleHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} / ${hour.latentHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} W/m²`],
      ['Clouds (total / low / mid / high)', `${hour.cloudCoverPercent?.[selectedCell]?.toFixed(0) ?? '–'}% (${hour.lowCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.midCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.highCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}%)`],
    ];
    const primaryRows: [string, string][] = [
      ['Thermal strength', displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])],
      ['Usable lift top', displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])],
      ['Potential cloud base', fmtFt((hour.surfaceLclM ?? hour.cloudBaseM)[selectedCell])],
      ['Model surface wind · 10 m', surfaceWind ? `${surfaceWind}${w10g != null ? ` · gusts ${formatQuantity(w10g, 'wind')}` : ''}` : 'Unavailable'],
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
      ? 'Too few forecast levels to estimate lift.'
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
      key.append(swatch, stop.toLocaleString('en-US', { maximumFractionDigits: 2 }));
      scale.append(key);
    }
    const explanation = document.createElement('span');
    explanation.className = 'muted';
    explanation.textContent = 'Gray: unavailable · Purple: limited height data';
    if (layer === 'usableLiftTopV2M' || layer === 'usableLiftTopM') legendTitle.textContent += ` · ${formatQuantity(1, 'lift')} sink`;
    legend.append(legendTitle, scale, explanation);

    if (launches.length && el('launches-table-body') && el('launch-details-body')) {
      renderRegionalLaunchesTables(
        el('launches-table-body'),
        el('launch-details-body'),
        buildRegionalLaunchTableRows(launches, hour, selectedCell),
        selectCell,
      );
    }

    if (crossSectionDoc && el('replay-cross-section')) {
      const host = el('replay-cross-section');
      host.replaceChildren(
        renderCrossSectionSvg(crossSectionDoc, hour, crossSectionScale!, selectedCell, ci => {
          selectCell(ci);
        }),
      );
    }

    const activeLaunch = matchedLaunch;
    const multimodelBody = el('multimodel-table-body');
    if (multimodelBody) {
      if (activeLaunch) {
        renderMultimodelComparisonBody(multimodelBody, buildLaunchComparisonRows(activeLaunch, hour.validAt));
      } else {
        multimodelBody.replaceChildren();
      }
    }

    soaringMap.update({
      hour,
      layer,
      showBarbs,
      selectedCell,
    });

    const url = new URL(window.location.href);
    url.searchParams.set('case', location.caseId);
    url.searchParams.set('model', activeModel);
    url.searchParams.set('hour', String(requested));
    url.searchParams.set('valid', hour.validAt);
    setReplaySelectionQuery(url.searchParams, selection);
    window.history.replaceState(null, '', url);
  }

  function selectHour(forecastHour: number) {
    requested = forecastHour;
    void hourLoader.select(hourIndex(hours, requested));
    update();
  }

  function move(delta: number) {
    const index = hourIndex(hours, requested);
    selectHour(hours[Math.max(firstVisibleHour, Math.min(lastVisibleHour, index + delta))].forecastHour);
  }

  slider.addEventListener('input', () => selectHour(hours[Number(slider.value)].forecastHour), eventOptions);
  prev.addEventListener('click', () => move(-1), eventOptions);
  next.addEventListener('click', () => move(1), eventOptions);
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (playTimer !== null) {
        window.clearInterval(playTimer);
        playTimer = null;
        playBtn.textContent = '▶ Play';
      } else {
        playBtn.textContent = '⏸ Pause';
        playTimer = window.setInterval(() => {
          const idx = hourIndex(hours, requested);
          selectHour(hours[idx >= lastVisibleHour ? firstVisibleHour : idx + 1].forecastHour);
        }, 900);
      }
    }, eventOptions);
  }
  if (launchSelect) {
    launchSelect.addEventListener('change', () => {
      const found = launches.find(l => l.slug === launchSelect.value);
      if (found) {
        selectCell(found.cellIndex, found.slug);
      }
    }, eventOptions);
  }
  if (barbsCheckbox) {
    barbsCheckbox.addEventListener('change', () => {
      showBarbs = barbsCheckbox.checked;
      update();
    }, eventOptions);
  }
  el<HTMLInputElement>('additional-layers').addEventListener('change', event => {
    const enabled = (event.target as HTMLInputElement).checked;
    const select = el<HTMLSelectElement>('replay-layer');
    select.querySelector('optgroup')?.remove();
    if (enabled) {
      const group = document.createElement('optgroup');
      group.label = 'Additional layers';
      for (const spec of Object.values(LAYER_SPECS)) {
        if (PRIMARY_LAYERS.includes(spec.id) || !availableLayers.has(spec.id)) continue;
        const option = document.createElement('option');
        option.value = spec.id; option.textContent = spec.label;
        group.append(option);
      }
      select.append(group);
    } else if (!PRIMARY_LAYERS.includes(layer)) {
      layer = defaultLayer;
    }
    select.value = layer;
    update();
  }, eventOptions);
  el<HTMLSelectElement>('replay-layer').addEventListener('change', event => {
    layer = (event.target as HTMLSelectElement).value as Layer;
    update();
  }, eventOptions);
  el('select-blanchard').addEventListener('click', () => selectCell(manifest.siteCell, manifest.case.site.slug), eventOptions);
  let viewport = windgramViewport();
  window.addEventListener('resize', () => {
    const next = windgramViewport();
    if (next === viewport) return;
    viewport = next;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(update, 150);
  }, eventOptions);
  el('windgram-full-profile').addEventListener('click', () => {
    fullWindgramProfile = !fullWindgramProfile;
    update();
  }, eventOptions);
  initialized = true;
  update();
}

main().catch(error => {
  if (error instanceof Error && error.name === 'AbortError') return;
  console.error(error);
  set('replay-status', 'Regional map unavailable.');
  el('replay-run').hidden = true;
  el('replay-launches').hidden = false;
  el('replay-status').hidden = false;
  el('replay-status').setAttribute('role', 'alert');
});
