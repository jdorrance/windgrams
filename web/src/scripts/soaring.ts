import { formatQuantity, getUnitSystem } from '../lib/units.ts';
import { createReplayProfileCache, readRegionalJson } from '../lib/regional-data.ts';
import { parsePublishedProfileJson } from '../lib/published-lift.ts';
import { type SiteForecast } from '@azohra/meteo.briefing/contract';
import { DATA_BASE } from '../lib/site.ts';
import { windgramDayHours } from '../lib/windgram-view.ts';
import { windgramViewport } from '../lib/windgram-viewport.ts';
import { buildSounding, readSounding } from '../lib/skewt.ts';
import { SkewTChart } from '../lib/skewt-chart.ts';
import { compassPoint } from '../lib/launches.ts';
import { renderCrossSectionSvg } from '../lib/cross-section-view.ts';
import {
  buildLaunchComparisonRows,
  buildRegionalLaunchTableRows,
  renderMultimodelComparisonBody,
  renderRaobVerificationTable,
  renderRegionalLaunchesTables,
} from '../lib/launch-comparison.ts';
import {
  validateCrossSectionDoc,
  validateLaunchesDoc,
  validateReplayAudit,
  validateReplayGrid,
  validateVerificationDoc,
} from '../lib/soaring-contracts.ts';
import {
  LAYER_SPECS,
  PRIMARY_LAYERS,
  availableReplayLayers,
  refreshReplayLayerLabels,
  buildCellSiteForecast,
  crossSectionHeightScale,
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
import { createSoaringMap } from './soaring-map.ts';
import { createKeyedAsyncLoader, createWindgramController } from './windgram-controller.ts';
import { createPageLifecycle } from './page-lifecycle.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => { const node = el(id); if (node) node.textContent = text; };

const read = readRegionalJson;

async function readOptional<T>(url: string, validate?: (raw: unknown) => T | null): Promise<T | null> {
  try {
    const raw = await read<unknown>(url);
    return validate ? validate(raw) : (raw as T);
  } catch {
    return null;
  }
}

const fmtFt = (m: number | null | undefined) => formatQuantity(m, 'elevation');
const fmtM = (m: number | null | undefined, datum = 'MSL') => m == null ? 'Unavailable' : `${formatQuantity(m, 'elevation')} ${datum}`;

async function main() {
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
  set('map-barb-units', getUnitSystem() === 'metric' ? '· 2.5 / 5 / 25 m/s' : '· 5 / 10 / 50 kt');
  const regionsCatalogue = await readOptional<RegionCatalogue>(`${DATA_BASE.replace(/\/$/, '')}/soaring/v1/regions.json`);
  if (lifetime.disposed) return;
  const query = defaultReplayQuery(window.location.search, regionsCatalogue);
  const location = replayLocation(query.toString(), DATA_BASE);
  const pointer = await read<{ bundle: string }>(`${location.root}/index.json`);
  if (lifetime.disposed) return;
  if (!/^bundles\/[a-f0-9]{64}$/.test(pointer.bundle)) throw new Error('Invalid replay bundle pointer');
  const root = `${location.root}/${pointer.bundle}`;
  const manifest = await read<ReplayManifest>(`${root}/manifest.json`);
  if (lifetime.disposed) return;
  if (manifest.schemaVersion !== 1 || manifest.case.id !== location.caseId) throw new Error('Replay manifest mismatch');
  const activeModel = replayModel(manifest);
  const activeRegionMeta = regionForCase(regionsCatalogue?.regions ?? [], location.caseId);
  const optionalBundle = <T>(name: string, validate?: (raw: unknown) => T | null) =>
    manifest.files && !Object.hasOwn(manifest.files, name)
      ? Promise.resolve<T | null>(null)
      : readOptional<T>(`${root}/${name}`, validate);
  const [rawGrid, profileData, rawAudit, hours, launchesDoc, crossSectionDoc, verificationDoc] = await Promise.all([
    read<unknown>(`${root}/grid.geojson`),
    read<unknown>(`${root}/profile.json`),
    read<unknown>(`${root}/audit.json`),
    Promise.all(manifest.hours.map(h => read<ReplayHour>(`${root}/${h.file}`))),
    optionalBundle('launches.json', validateLaunchesDoc),
    optionalBundle('cross-section.json', validateCrossSectionDoc),
    optionalBundle('verification.json', validateVerificationDoc),
  ]);
  if (lifetime.disposed) return;
  const grid = validateReplayGrid(rawGrid, manifest.cellCount);
  const audit = validateReplayAudit(rawAudit);
  const blanchardProfile = parsePublishedProfileJson(JSON.stringify(profileData));
  const crossSectionScale = crossSectionDoc ? crossSectionHeightScale(crossSectionDoc.nodes, hours) : null;
  if (
    !grid ||
    !audit ||
    !blanchardProfile ||
    blanchardProfile.model !== activeModel ||
    blanchardProfile.hours.length !== hours.length ||
    blanchardProfile.hours.some((h, i) => h.validAt !== hours[i].validAt)
  ) {
    throw new Error('Invalid or unsynchronized regional profile');
  }

  const selectedValidHour = forecastHourAtValidTime(hours, query.get('valid'));
  let requested = selectedValidHour ?? location.hour;
  if (selectedValidHour === null && !query.has('hour') && location.caseId.endsWith('-live')) {
    requested = hours.reduce((best, h) => Math.abs(Date.parse(h.validAt) - Date.now()) < Math.abs(Date.parse(best.validAt) - Date.now()) ? h : best).forecastHour;
  }
  const availableLayers = new Set(availableReplayLayers(hours));
  const defaultLayer: Layer = PRIMARY_LAYERS.find(candidate => availableLayers.has(candidate)) ?? [...availableLayers][0] ?? 'thermalVelocityV2Mps';
  let layer: Layer = defaultLayer;
  const layerSelect = el<HTMLSelectElement>('replay-layer');
  for (const option of [...layerSelect.options]) if (!availableLayers.has(option.value as Layer)) option.remove();
  refreshReplayLayerLabels(layerSelect.options);
  layerSelect.value = layer;

  const launches = launchesDoc?.launches ?? [];
  const launchByCell = new Map(launches.map(launch => [launch.cellIndex, launch]));
  let selection = replaySelection(query, grid.features.map(feature => feature.properties), launches, manifest.siteCell);
  let selectedCell = selection.cellIndex;
  const launchForCell = (cellIndex: number) =>
    (cellIndex === selection.cellIndex && selection.launchSlug ? launches.find(launch => launch.slug === selection.launchSlug) : undefined)
    ?? launchByCell.get(cellIndex);

  let showBarbs = true;
  let fullWindgramProfile = false;
  let firstVisibleHour = 0;
  let lastVisibleHour = hours.length - 1;

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
    if (remoteProfileLoader) {
      void remoteProfileLoader.select(cellIndex);
    }
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
  const profileCache = new Map<number, SiteForecast | null>();
  const remoteProfiles = manifest.cellProfiles ? createReplayProfileCache(root, manifest) : null;
  const remoteProfileLoader = remoteProfiles
    ? createKeyedAsyncLoader<number, SiteForecast>({
        load: async cellIndex => {
          const cached = remoteProfiles.cached(cellIndex);
          if (cached) return cached;
          const cellProps = grid.features[cellIndex]?.properties;
          if (!cellProps) return null;
          return await remoteProfiles.load(cellIndex, cellProps.gridIndex);
        },
        onActiveComplete: cellIndex => {
          if (selectedCell === cellIndex) update();
        },
      })
    : null;
  lifetime.onDispose(() => remoteProfileLoader?.dispose());

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

  const inv = activeModel === 'hrrr-conus' ? verificationDoc?.hrrrWrfprsInventory : undefined;
  set('audit-summary', 'About this forecast');
  set(
    'audit-results',
    `${audit.mapProfileAgreement.valuesChecked.toLocaleString('en-US')} map/profile values checked · ${audit.mapProfileAgreement.hours} hours. Sample ${formatQuantity(audit.sampledCell.distanceKm, 'distance')}. Terrain: model ${formatQuantity(audit.terrain.modelElevationM, 'elevation')} / launch ${formatQuantity(audit.terrain.launch.elevationM, 'elevation')} MSL.${inv ? ` ${inv.availablePressureLevelsCount} pressure levels available.` : ''}`,
  );
  el('audit-limitations').replaceChildren();
  el<HTMLAnchorElement>('audit-download').href = `${root}/audit.json`;

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
    set('wrf-lifecycle-summary', `WRF-ARW pilot configuration · planned North Sound grids: ${grids}.`);
  }
  if (launchesDoc?.nwsOffice?.products?.afd?.text && el('nws-afd-text')) {
    set('nws-afd-text', launchesDoc.nwsOffice.products.afd.text.trim());
  }

  function update() {
    if (lifetime.disposed) return;
    const properties = grid!.features[selectedCell].properties;
    const matchedLaunch = launchForCell(selectedCell);
    const activeLabel = matchedLaunch?.name ?? (selectedCell === manifest.siteCell ? manifest.case.site.name : 'Selected location');
    if (
      remoteProfiles &&
      remoteProfileLoader &&
      !remoteProfiles.cached(selectedCell) &&
      !remoteProfileLoader.isPending(selectedCell) &&
      !remoteProfileLoader.hasFailed(selectedCell)
    ) {
      void remoteProfileLoader.select(selectedCell);
    }
    if (!remoteProfiles && !profileCache.has(selectedCell)) {
      if (profileCache.size >= 32) profileCache.delete(profileCache.keys().next().value!);
      profileCache.set(selectedCell, buildCellSiteForecast(manifest, hours, selectedCell, properties, activeLabel));
    }
    const cellForecast = remoteProfiles ? remoteProfiles.cached(selectedCell) : profileCache.get(selectedCell);
    // The map keeps its entire forecast horizon; the chart follows the selected
    // local day's daylight. Later days remain reachable through these controls.
    firstVisibleHour = 0;
    lastVisibleHour = hours.length - 1;
    const state = selectedState(manifest, hours, requested), { hour, index } = state;
    requested = hour.forecastHour;
    slider.min = String(firstVisibleHour);
    slider.max = String(lastVisibleHour);
    slider.value = String(index);
    slider.setAttribute('aria-valuetext', state.validLabel);
    prev.disabled = index === firstVisibleHour;
    next.disabled = index === lastVisibleHour;
    set('replay-valid', state.validLabel);
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
    set('sounding-valid', state.validLabel);
    if (cellForecast) {
      const dayHours = windgramDayHours(cellForecast, hours[index].validAt, manifest.case.site.timeZone);
      windgramController.render({
        cacheKey: selectedCell,
        profile: cellForecast,
        timeZone: manifest.case.site.timeZone,
        hours: dayHours,
        selectedValidAt: hours[index]?.validAt ?? null,
        fullProfile: fullWindgramProfile,
        idPrefix: 'soaring',
        launch: windgramLaunch(selectedCell),
        desktopWidthPx: 1100,
        onSelectHour: validAt => {
          const clickedHour = hours.find(h => h.validAt === validAt);
          if (!clickedHour) return;
          requested = clickedHour.forecastHour;
          update();
        },
      });
    } else {
      windgramController.clear();
      set(
        'replay-windgram',
        remoteProfileLoader?.isPending(selectedCell) ? 'Loading profile…' : 'A complete profile is unavailable at this location.',
      );
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
      ['Cu / OD potential', `${hour.cuPotentialM?.[selectedCell] != null ? `${hour.cuPotentialM[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.cuPotentialM[selectedCell], 'elevation')}` : '–'} / ${hour.odPotentialM?.[selectedCell] != null ? `${hour.odPotentialM[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.odPotentialM[selectedCell], 'elevation')}` : '–'}`],
      [`Wind at ${formatQuantity(10, 'elevation')} AGL (gust)`, w10s != null && w10d != null ? `${compassPoint(w10d)} (${w10d.toFixed(0)}°) @ ${formatQuantity(w10s, 'wind')}${w10g != null ? ` (gust ${formatQuantity(w10g, 'wind')})` : ''}` : 'Unavailable'],
      ['Launch-elevation wind · experimental', expTerr ? (expTerr.bracketsLaunchAltitude && expTerr.launchWindSpeedMps != null && expTerr.launchWindDirectionDeg != null ? `${compassPoint(expTerr.launchWindDirectionDeg)} (${expTerr.launchWindDirectionDeg.toFixed(0)}°) @ ${formatQuantity(expTerr.launchWindSpeedMps, 'wind')} at ${formatQuantity(expTerr.launchElevationM, 'elevation')} MSL` : `Launch (${formatQuantity(expTerr.launchElevationM, 'elevation')}) outside profile bracket`) : 'Select a launch'],
      ['BL mean wind & shear', blws != null && blwd != null ? `${compassPoint(blwd)} (${blwd.toFixed(0)}°) @ ${formatQuantity(blws, 'wind')} · shear ${formatQuantity(blsh, 'wind')} (B/S ${bsr?.toFixed(2) ?? '–'})` : 'Unavailable'],
      [`Vertical motion at ${formatQuantity(925, 'pressure')} / convergence`, `${hour.w925Mps?.[selectedCell] != null ? `${hour.w925Mps[selectedCell]! >= 0 ? '+' : ''}${formatQuantity(hour.w925Mps[selectedCell], 'lift')}` : '–'} · ${hour.convergence10mX1e5?.[selectedCell] != null ? `${hour.convergence10mX1e5[selectedCell]! >= 0 ? '+' : ''}${hour.convergence10mX1e5[selectedCell]!.toFixed(1)} ×10⁻⁵ s⁻¹` : '–'}`],
      ['Sensible / latent heat flux', `${hour.sensibleHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} / ${hour.latentHeatFluxWm2?.[selectedCell]?.toFixed(0) ?? '–'} W/m²`],
      ['Clouds (total / low / mid / high)', `${hour.cloudCoverPercent?.[selectedCell]?.toFixed(0) ?? '–'}% (${hour.lowCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.midCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}% / ${hour.highCloudPercent?.[selectedCell]?.toFixed(0) ?? '–'}%)`],
    ];
    const primaryRows: [string, string][] = [
      ['Thermal strength', displayMetric((hour.thermalVelocityV2Mps ?? hour.thermalVelocityMps)[selectedCell], 'thermalVelocityV2Mps', hour.status[selectedCell])],
      ['Usable lift top', displayMetric((hour.usableLiftTopV2M ?? hour.usableLiftTopM)[selectedCell], 'usableLiftTopV2M', hour.status[selectedCell])],
      ['Potential cloud base', fmtFt((hour.surfaceLclM ?? hour.cloudBaseM)[selectedCell])],
      ['Surface wind', w10s != null && w10d != null ? `${compassPoint(w10d)} ${formatQuantity(w10s, 'wind')}${w10g != null ? ` · gusts ${formatQuantity(w10g, 'wind')}` : ''}` : 'Unavailable'],
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
      key.append(swatch, stop.toLocaleString('en-US', { maximumFractionDigits: 2 }));
      scale.append(key);
    }
    const explanation = document.createElement('span');
    explanation.className = 'muted';
    const liftTopLayer = ['usableLiftTopV2M', 'usableLiftTopM', 'hcritWxtoflyM', 'dryHcritM', 'resolvedThermalTopM'].includes(layer);
    explanation.textContent = 'Gray: unavailable · Purple: limited height data' + (liftTopLayer ? ' · Beige: below sink threshold' : '');
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

  function move(delta: number) {
    const index = selectedState(manifest, hours, requested).index;
    requested = hours[Math.max(firstVisibleHour, Math.min(lastVisibleHour, index + delta))].forecastHour;
    update();
  }

  slider.addEventListener('input', () => { requested = hours[Number(slider.value)].forecastHour; update(); }, eventOptions);
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
          const idx = selectedState(manifest, hours, requested).index;
          requested = hours[idx >= lastVisibleHour ? firstVisibleHour : idx + 1].forecastHour;
          update();
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
  console.error(error);
  set('replay-status', 'Forecast unavailable.');
  el('replay-status').hidden = false;
  el('replay-status').setAttribute('role', 'alert');
});
