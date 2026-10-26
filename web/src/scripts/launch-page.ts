import { forecastCapabilities, launchCountry, defaultSoaringRegion, shortModelLabel } from "../lib/forecast-capabilities.ts";
import { forecastCoversWindow, initialForecastDay, launchDayWindow, launchConditions, matchingHourIndex, peakLiftIndex, validDateKey } from "../lib/launch-forecast.ts";
import { forecastDataSupport } from "../lib/forecast-data-support.ts";
// Launch page: day tabs and a model switch scope the meteogram and the NWS
// charts below them. All forecast data is read from /data at view time, so the
// page is always as fresh as the dataset without rebuilding the site.

import { parseForecastManifestJson, parseModelCatalogueJson, parseSiteContextJson } from "@azohra/meteo.briefing/contract";
import type { ForecastManifest, ModelCatalogue, SiteForecast } from "@azohra/meteo.briefing/contract";
import { localDateKey, localInstantMs } from "@azohra/meteo.briefing/derive";
import { createForecastClient } from "@windgrams/data-client";
import { windgramHours } from "../lib/windgram-view.ts";
import { windgramViewport } from "../lib/windgram-viewport.ts";
import { windWindow, type Launch } from "../lib/launches.ts";
import type { EcmwfSiteDocument } from "../lib/ecmwf-chart.ts";
import { SkewTChart } from "../lib/skewt-chart.ts";
import { buildSounding, readSounding } from "../lib/skewt.ts";
import type { RaobDocument } from "../lib/balloon.ts";
import { fetchWithRetry } from "../lib/http.ts";
import { DATA_BASE } from "../lib/site.ts";
import { formatQuantity, relativeTime } from "../lib/units.ts";
import { Sunlight } from "./sunlight.ts";
import { createBalloonSection, renderFindingsList } from "./balloon-section.ts";
import {
  buildCloudSeriesForSunlight,
  createNwsEcmwfSections,
  type NwsOfficeDocument,
  type NwsSiteDocument,
} from "./nws-ecmwf-sections.ts";
import { createWindgramController } from "./windgram-controller.ts";
import { createPageLifecycle } from "./page-lifecycle.ts";
import { createFreshnessNotice } from './freshness-notice.ts';
import { createRefreshHealthReader } from '../lib/refresh-health.ts';
import type { ProviderRefresh } from '@windgrams/contracts/provider-health';

// Short-range high-resolution models first, then regional, global, and the ensemble.

const DAYS = 7;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const launch = JSON.parse($("launch-config").textContent ?? "{}") as Launch;
const tz = launch.timeZone;
const capabilities = forecastCapabilities(launch);
try { sessionStorage.setItem("windgrams-country", launchCountry(launch)); } catch { /* Storage is optional. */ }
const nav = $<HTMLAnchorElement>("soaring-nav-link");
if (nav) {
  const target = new URL(nav.href);
  const country = launchCountry(launch);
  target.searchParams.set('country', country);
  const region = defaultSoaringRegion(country);
  if (region) target.searchParams.set('region', region);
  nav.href = target.toString();
}
const MODEL_ORDER = capabilities.models;
const arc = windWindow(launch);
let sample = false;
let fullWindgramProfile = false;
let resizeTimer = 0;
const lifetime = createPageLifecycle({
  onSuspend() { window.clearTimeout(resizeTimer); sunlight.suspend(); },
  onRestore() { sunlight.resume(); render(); },
});
const eventOptions = { signal: lifetime.signal };
const forecastClient = createForecastClient({ baseUrl: DATA_BASE, signal: lifetime.signal });
const readRefreshHealth = createRefreshHealthReader({ baseUrl: DATA_BASE, signal: lifetime.signal });

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetchWithRetry(`${DATA_BASE}/${path}`, { signal: lifetime.signal });
    if (response.headers.get("x-sample-data")) sample = true;
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function dayLabel(dateKey: string) {
  if (dateKey === currentDays[0]) return "Today";
  if (dateKey === currentDays[1]) return "Tomorrow";
  const date = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date);
}

function daySub(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`));
}

function nextDateKeys(count: number) {
  const keys: string[] = [];
  for (let t = Date.now(); keys.length < count; t += 3_600_000) {
    const key = localDateKey(new Date(t).toISOString(), tz);
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

const dayWindows = new Map<string, ReturnType<typeof launchDayWindow>>();
function dayWindow(dateKey: string) {
  if (!dayWindows.has(dateKey)) dayWindows.set(dateKey, launchDayWindow(launch, dateKey));
  return dayWindows.get(dateKey)!;
}
const inDay = (validAt: string, dateKey: string) => {
  if (localDateKey(validAt, tz) !== dateKey) return false;
  const time = Date.parse(validAt), window = dayWindow(dateKey);
  return time >= window.startMs && time <= window.endMs;
};

function button(label: string, sub: string | null, pressed: boolean, disabled: boolean, onClick: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (sub) {
    const small = document.createElement("small");
    small.textContent = sub;
    b.appendChild(small);
  }
  b.setAttribute("aria-pressed", String(pressed));
  b.disabled = disabled;
  b.addEventListener("click", onClick, eventOptions);
  return b;
}

// ── state ────────────────────────────────────────────────────────────────

const currentDays = nextDateKeys(DAYS);
const query = new URLSearchParams(location.search);
const requestedDay = query.get('day');
const days = validDateKey(requestedDay) && !currentDays.includes(requestedDay) ? [...currentDays, requestedDay].sort() : currentDays;
let selectedValidAt: string | null = query.get('time');
const requestedModel = query.get('model');
let manualModel = MODEL_ORDER.includes(requestedModel ?? '');
let modelsLoading = true;
let manualDay = validDateKey(requestedDay);
let day = validDateKey(requestedDay) ? requestedDay : initialForecastDay(launch);
let model: string | null = manualModel ? requestedModel : null;
let catalogue: ModelCatalogue | null = null;
let launchElevationM: number | null = null;
// Manifests are small and say which hours each model covers; a model's profile
// is only downloaded when it is selected.
const manifests = new Map<string, ForecastManifest>();
const pendingProfiles = new Map<string, Promise<void>>();
const profiles = new Map<string, { profile: SiteForecast; referenceTime: string; generatedAt: string; stale: boolean } | null>();
const refreshHealth = new Map<string, ProviderRefresh>();
const freshnessNotice = createFreshnessNotice($('forecast-freshness'), () => {
  const loaded = model ? profiles.get(model) : null;
  return loaded ? {
    referenceTime: loaded.referenceTime,
    validUntil: loaded.profile.hours.at(-1)?.validAt,
    policy: model ? modelEntry(model) : null,
    consistent: !loaded.stale,
    refresh: model ? refreshHealth.get(model) : null,
  } : null;
}, lifetime.signal);
let nws: NwsSiteDocument | null = null;
let ecmwf: EcmwfSiteDocument | null = null;
let skewt: SkewTChart | null = null;
let skewtHours: SiteForecast["hours"] = [];
let modelSelectionToken = 0;

const sunlight = new Sunlight(launch);
const balloonSection = createBalloonSection({
  launchName: launch.name,
  timeZone: tz,
  getLaunchElevationM: () => launchElevationM,
});
const nwsEcmwfSections = createNwsEcmwfSections({
  launch,
  arc,
  timeZone: tz,
  nwsEnabled: capabilities.nws,
  inDay,
});
const windgramController = createWindgramController({
  host: $("meteogram"),
  axisHost: $("meteogram-height-axis"),
  keyHost: $("meteogram-key"),
  fullProfileButton: $("windgram-full-profile"),
  diagnosticsHost: $("meteogram-diagnostics"),
  detailsElement: $<HTMLDetailsElement>("meteogram-details"),
});
lifetime.onDispose(() => {
  modelSelectionToken += 1;
  windgramController.dispose();
  balloonSection.dispose();
  nwsEcmwfSections.dispose();
  skewt?.dispose();
  sunlight.dispose();
});

function persistSelection() {
  const url = new URL(location.href);
  url.searchParams.set('day', day);
  if (model) url.searchParams.set('model', model);
  else url.searchParams.delete('model');
  if (selectedValidAt && Number.isFinite(Date.parse(selectedValidAt))) url.searchParams.set('time', selectedValidAt);
  else url.searchParams.delete('time');
  history.replaceState(null, '', url);
}

async function profileFor(slug: string) {
  if (!profiles.has(slug)) {
    if (!pendingProfiles.has(slug)) pendingProfiles.set(slug, (async () => {
      const loaded = await forecastClient.loadProfile(slug, launch.slug).catch(() => null);
      if (lifetime.disposed) return;
      const valid = loaded && !('miss' in loaded) && loaded.document.model === slug && loaded.document.site.id === launch.slug;
      profiles.set(slug, valid ? {
        profile: loaded.document,
        referenceTime: loaded.document.run.referenceTime,
        generatedAt: loaded.document.run.generatedAt,
        stale: loaded.stale,
      } : null);
    })().finally(() => pendingProfiles.delete(slug)));
    await pendingProfiles.get(slug);
  }
  return profiles.get(slug) ?? null;
}

function modelEntry(slug: string) {
  return catalogue?.models.find((m) => m.slug === slug) ?? null;
}

async function loadManifest(slug: string) {
  const text = await fetchWithRetry(`${DATA_BASE}/${slug}/manifest.json`, { signal: lifetime.signal })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  const manifest = text ? parseForecastManifestJson(text) : null;
  if (lifetime.disposed) return;
  if (manifest && manifest.sites.some((s) => s.slug === launch.slug)) manifests.set(slug, manifest);
}

/** Published daylight coverage is the same on every screen. */
function covers(slug: string, dateKey: string) {
  const m = manifests.get(slug);
  return m ? forecastCoversWindow(m, dayWindow(dateKey)) : false;
}

function modelLabel(slug: string) {
  return modelEntry(slug)?.label.replace(" CONUS", "").replace(" continental", "") ?? shortModelLabel(slug);
}

async function selectModel(slug: string) {
  if (lifetime.disposed) return;
  const token = ++modelSelectionToken;
  model = slug;
  $("meteogram").classList.add("is-loading");
  render();
  await profileFor(slug);
  if (token === modelSelectionToken && model === slug) {
    $("meteogram").classList.remove("is-loading");
    render();
  }
}

// ── rendering ────────────────────────────────────────────────────────────

function renderDayTabs() {
  if (lifetime.disposed) return;
  const host = $("day-tabs");
  const restoreFocus = host.contains(document.activeElement);
  const scrollLeft = host.scrollLeft;
  host.replaceChildren(
    ...days.map((key) => {
      const hasModel = MODEL_ORDER.some((slug) => covers(slug, key));
      const hasNws = nws?.hours.some((h) => inDay(h.validAt, key)) ?? false;
      const hasEcmwf = ecmwf?.hours.some((h) => inDay(h.validAt, key)) ?? false;
      return button(dayLabel(key), daySub(key), key === day, !hasModel && !hasNws && !hasEcmwf, () => {
        manualDay = true;
        day = key;
        selectedValidAt = null;
        if (model && !covers(model, day)) { manualModel = false; void chooseDefaultModel(); }
        render();
      });
    }),
  );
  host.scrollLeft = scrollLeft;
  if (restoreFocus) host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  const date = new Date(`${day}T12:00:00Z`);
  const dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(localInstantMs(day, 12, tz))).find((p) => p.type === "timeZoneName")?.value ?? tz;
  $("forecast-date").textContent = `${dateLabel} · ${zone}`;
}

function renderModelSelect(available: string[]) {
  if (lifetime.disposed) return;
  const host = $<HTMLSelectElement>("model-select");
  host.replaceChildren(
    ...available.map((slug) => {
      const entry = modelEntry(slug);
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = `${modelLabel(slug)}${entry ? ` · ${formatQuantity(entry.gridKm, "resolution")}${entry.kind === "ensemble" ? " ens." : ""}` : ""}`;
      option.selected = slug === model;
      return option;
    }),
  );
  host.disabled = available.length === 0;
  if (!available.length) host.add(new Option("No models available", ""));
  const caption = host.value ? shortModelLabel(host.value) : "—";
  $("model-selected-name").textContent = caption;
  $("model-selected-name").dataset.compact = String(caption.length > 5);
  host.title = host.selectedOptions[0]?.textContent ?? "Forecast model";
}

$<HTMLSelectElement>("model-select").addEventListener("change", (event) => { manualModel = true; void selectModel((event.target as HTMLSelectElement).value); }, eventOptions);

function selectedWindgramHours(profile: SiteForecast) {
  return windgramHours(profile, {
    timeZone: tz,
    hours: { dateKey: day, timeZone: tz },
  });
}

function renderMeteogram() {
  if (lifetime.disposed) return;
  freshnessNotice.refresh();
  const frame = $("meteogram");
  const meta = $("meteogram-meta");
  const title = $("meteogram-title");
  windgramController.clear();
  $("windgram-full-profile").hidden = true;
  const loaded = model ? profiles.get(model) : null;
  const entry = model ? modelEntry(model) : null;
  title.textContent = entry
    ? `Soaring meteogram · ${entry.label}, ${formatQuantity(entry.gridKm, "resolution")}${entry.kind === "ensemble" ? " ensemble" : ""}`
    : "Soaring meteogram";

  if (!loaded) {
    meta.textContent = "";
    const loading = model !== null ? !profiles.has(model) : modelsLoading;
    const statusP = document.createElement("p");
    statusP.className = "chart-status";
    statusP.textContent = loading ? "Loading forecast…" : "Forecast unavailable.";
    frame.replaceChildren(statusP);
    if (!loading && model) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'button secondary'; retry.textContent = 'Retry forecast';
      retry.addEventListener('click', () => { profiles.delete(model!); void selectModel(model!); }, eventOptions);
      frame.append(retry);
    }
    return;
  }

  const run = new Date(loaded.referenceTime);
  meta.textContent = `Run ${run.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${String(run.getUTCHours()).padStart(2, "0")}Z · published ${relativeTime(loaded.generatedAt)}`;

  const hours = selectedWindgramHours(loaded.profile);
  if (hours.length === 0 && !loaded.profile.hours.some(hour => localDateKey(hour.validAt, tz) === day)) {
    const other = MODEL_ORDER.find((slug) => slug !== model && covers(slug, day));
    frame.replaceChildren();
    const p = document.createElement("p");
    p.className = "chart-status";
    p.textContent = `${modelLabel(model ?? "")} coverage ends before this day. `;
    if (other) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "button secondary";
      b.textContent = `Show ${modelLabel(other)}`;
      b.addEventListener("click", () => selectModel(other), eventOptions);
      p.appendChild(b);
    }
    frame.appendChild(p);
    return;
  }

  windgramController.render({
    profile: loaded.profile,
    timeZone: tz,
    hours,
    dateKey: day,
    selectedValidAt,
    fullProfile: fullWindgramProfile,
    idPrefix: `mg-${launch.slug}`,
    launch: launchElevationM != null ? { name: launch.name, elevationM: launchElevationM } : null,
    launchWindows: arc ? [arc] : [],
    capabilities: entry?.capabilities,
    cursorStyle: { fill: '#fff', fillOpacity: 0.04, stroke: '#203747' },
    onSelectHour: validAt => {
      const i = skewtHours.findIndex(h => h.validAt === validAt);
      if (i >= 0) showSkewTHour(i);
    },
  });
}

// ── Skew-T ────────────────────────────────────────────────────────────────

const hourFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });

function replaceDetails(host: HTMLElement, rows: readonly (readonly [string, string])[]) {
  host.replaceChildren(...rows.map(([label, value]) => {
    const group = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    group.append(dt, dd);
    return group;
  }));
}

function renderConditions(hour: SiteForecast['hours'][number], index: number) {
  const label = hourFormat.format(new Date(hour.validAt)).replace(":00", "");
  const slider = $<HTMLInputElement>('forecast-hour');
  slider.max = String(skewtHours.length - 1); slider.value = String(index);
  slider.setAttribute('aria-valuetext', label);
  $('forecast-hour-label').textContent = label;
  $<HTMLButtonElement>('forecast-hour-prev').disabled = index === 0;
  $<HTMLButtonElement>('forecast-hour-next').disabled = index === skewtHours.length - 1;
  $('forecast-hour-panel').hidden = false;
  $('forecast-conditions-panel').hidden = false;
  $('forecast-hour-panel').dataset.validAt = hour.validAt;
  const profile = model ? profiles.get(model)?.profile : undefined;
  const conditions = launchConditions(hour, launch, launchElevationM, profile?.site.modelElevationM ?? null, profile?.semantics?.gust ?? null);
  replaceDetails($('forecast-conditions'), conditions.values);
  $('forecast-wind-note').textContent = conditions.issues.join(' · ');
  $('forecast-wind-note').hidden = !conditions.issues.length;
  $('forecast-wind-basis').textContent = conditions.windBasis;
  const support = forecastDataSupport(hour);
  replaceDetails($('forecast-data-support'), support.rows);
  $('forecast-data-limit').textContent = support.limit ?? '';
  $('forecast-data-limit').hidden = support.limit === null;
  $('forecast-sampling-caution').textContent = support.caution ?? '';
  $('forecast-sampling-caution').hidden = support.caution === null;
}

function showSkewTHour(index: number) {
  if (lifetime.disposed) return;
  const loaded = model ? profiles.get(model) : null;
  const hour = skewtHours[index];
  if (!loaded || !hour) return;
  selectedValidAt = hour.validAt;
  renderConditions(hour, index);
  windgramController.select(selectedValidAt, true);
  $('skewt-chart').dataset.validAt = hour.validAt;
  persistSelection();
  const slider = $<HTMLInputElement>("skewt-hour");
  slider.value = String(index);
  const label = hourFormat.format(new Date(hour.validAt)).replace(":00", "");
  $("skewt-hour-label").textContent = label;
  slider.setAttribute("aria-valuetext", label);
  const sounding = buildSounding(loaded.profile, hour);
  if (!skewt) skewt = new SkewTChart($("skewt-chart"), { name: launch.name, elevationM: launchElevationM });
  skewt.set(sounding, { name: launch.name, elevationM: launchElevationM });
  const list = $("skewt-findings");
  list.replaceChildren();
  $("skewt-dew-legend").hidden = sounding !== null && !sounding.hasDewPoint;
  if (!sounding) {
    $("skewt-headline").textContent = "Too few forecast levels to draw a sounding.";
    return;
  }
  const reading = readSounding(sounding, launchElevationM);
  $("skewt-headline").textContent = reading.headline;
  renderFindingsList(list, reading.findings);
}

function renderSkewT() {
  if (lifetime.disposed) return;
  const status = $("skewt-status");
  const body = $("skewt-body");
  const loaded = model ? profiles.get(model) : null;
  const entry = model ? modelEntry(model) : null;
  const hours = loaded ? selectedWindgramHours(loaded.profile).filter(hour => inDay(hour.validAt, day)) : [];
  if (!loaded || hours.length === 0) {
    body.hidden = true;
    status.hidden = false;
    status.textContent = !model
      ? modelsLoading ? "Loading the sounding…" : "Forecast unavailable."
      : !loaded
        ? profiles.has(model) ? "Sounding unavailable. Select another model." : "Loading the sounding…"
        : `${modelLabel(model)} upper-air data unavailable for this day.`;
    skewtHours = [];
    $("forecast-hour-panel").hidden = true;
    $("forecast-conditions-panel").hidden = true;
    windgramController.select(selectedValidAt);
    return;
  }
  status.hidden = true;
  body.hidden = false;
  const run = new Date(loaded.referenceTime);
  $("skewt-meta").textContent = `${entry ? `${entry.label}, ${formatQuantity(entry.gridKm, "resolution")}` : model} · run ${String(run.getUTCHours()).padStart(2, "0")}Z`;
  skewtHours = hours;
  $<HTMLInputElement>('skewt-hour').max = String(hours.length - 1);
  showSkewTHour(matchingHourIndex(hours, selectedValidAt, tz));
}

$<HTMLInputElement>("skewt-hour").addEventListener("input", (e) => showSkewTHour(Number((e.target as HTMLInputElement).value)), eventOptions);
$("skewt-best").addEventListener("click", () => showSkewTHour(peakLiftIndex(skewtHours, tz)), eventOptions);

$<HTMLInputElement>('forecast-hour').addEventListener('input', e => showSkewTHour(Number((e.target as HTMLInputElement).value)), eventOptions);
$('forecast-hour-prev').addEventListener('click', () => showSkewTHour(Number($<HTMLInputElement>('forecast-hour').value) - 1), eventOptions);
$('forecast-hour-next').addEventListener('click', () => showSkewTHour(Number($<HTMLInputElement>('forecast-hour').value) + 1), eventOptions);
$('forecast-hour-peak').addEventListener('click', () => showSkewTHour(peakLiftIndex(skewtHours, tz)), eventOptions);

function render() {
  if (lifetime.disposed) return;
  persistSelection();
  renderDayTabs();
  renderModelSelect(MODEL_ORDER.filter((slug) => manifests.has(slug)));
  renderSkewT();
  renderMeteogram();
  nwsEcmwfSections.renderNws(nws, day);
  nwsEcmwfSections.renderEcmwf(ecmwf, day);
  sunlight.setDay(
    day,
    buildCloudSeriesForSunlight(
      model,
      model ? profiles.get(model) : null,
      model ? modelEntry(model) : null,
      model ? modelLabel(model) : "",
    ),
  );
}

async function chooseDefaultModel() {
  if (lifetime.disposed) return;
  const candidates = MODEL_ORDER.filter(slug => manifests.has(slug) && profiles.get(slug) !== null);
  const choice = manualModel && model ? model : candidates.find(slug => covers(slug, day)) ?? candidates[0];
  if (!choice || (choice === model && (profiles.has(choice) || pendingProfiles.has(choice)))) return;
  await selectModel(choice);
  if (!manualModel && profiles.get(choice) === null) await chooseDefaultModel();
}

/** Re-read provider health; the reader's TTL bounds this to one request per group per 5 minutes. */
async function loadRefreshHealth() {
  await Promise.all(MODEL_ORDER.map(async slug => {
    const health = await readRefreshHealth(slug);
    if (lifetime.disposed) return;
    if (health) refreshHealth.set(slug, health); else refreshHealth.delete(slug);
    if (model === slug) freshnessNotice.refresh();
  }));
}
window.addEventListener('pageshow', () => { void loadRefreshHealth(); }, eventOptions);

export async function start() {
  if (lifetime.disposed) return;
  const raobPromise = capabilities.raob ? getJson<RaobDocument>(`raob/sites/${launch.slug}.json`) : Promise.resolve(null);
  const metadata = Promise.all([
    loadRefreshHealth(),
    getJson<unknown>('models.json').then(doc => { if (lifetime.disposed) return; catalogue = doc ? parseModelCatalogueJson(JSON.stringify(doc)) : null; renderModelSelect(MODEL_ORDER.filter(slug => manifests.has(slug))); if (model && profiles.get(model)) renderMeteogram(); }),
    getJson<unknown>('site-context.json').then(doc => {
      if (lifetime.disposed) return;
      const context = doc ? parseSiteContextJson(JSON.stringify(doc)) : null;
      launchElevationM = context?.sites[launch.slug]?.elevation.elevationM ?? null;
      if (launchElevationM != null) {
        const sourceId = context?.sites[launch.slug]?.elevation.source;
        const source = context?.sources.find(source => source.id === sourceId);
        $('launch-elevation').textContent = `${formatQuantity(launchElevationM, "elevation")} MSL`;
        $('launch-elevation-source').textContent = source ? `${source.product}${source.kind === 'surfaceModel' ? ' (includes vegetation)' : ''}.` : 'Terrain elevation at launch coordinates.';
        $('launch-elevation-item').hidden = false;
      }
      balloonSection.refresh();
      if (model && profiles.get(model)) { renderSkewT(); renderMeteogram(); }
    }),
  ]);
  const nwsTask = (async () => {
    if (!capabilities.nws) return;
    nws = await getJson<NwsSiteDocument>(`nws/sites/${launch.slug}.json`);
    if (lifetime.disposed) return;
    renderDayTabs(); nwsEcmwfSections.renderNws(nws, day);
    const office = nws ? await getJson<NwsOfficeDocument>(`nws/offices/${nws.grid.office}.json`) : null;
    nwsEcmwfSections.renderText(nws, office);
    const raob = await raobPromise;
    balloonSection.render(raob?.schemaVersion === 1 ? raob : null, office?.products.srg?.text ?? null);
  })();
  const ecmwfTask = getJson<EcmwfSiteDocument>(`ecmwf/sites/${launch.slug}.json`).then(doc => {
    if (lifetime.disposed) return;
    ecmwf = doc?.schemaVersion === 1 ? doc : null; renderDayTabs(); nwsEcmwfSections.renderEcmwf(ecmwf, day);
  });
  await Promise.all(MODEL_ORDER.map(async slug => {
    await loadManifest(slug);
    if (lifetime.disposed) return;
    renderDayTabs(); renderModelSelect(MODEL_ORDER.filter(slug => manifests.has(slug)));
    await chooseDefaultModel();
  }));
  if (lifetime.disposed) return;
  modelsLoading = false;
  if (!manualDay && !MODEL_ORDER.some(slug => covers(slug, day))) {
    day = currentDays.find(key => key >= day && MODEL_ORDER.some(slug => covers(slug, key))) ?? day;
    selectedValidAt = null;
  }
  if (model && !manifests.has(model)) { manualModel = false; model = null; }
  await chooseDefaultModel();
  render();
  await Promise.all([metadata, nwsTask, ecmwfTask]);
  if (lifetime.disposed) return;
  if (sample) $('sample-notice').hidden = false;
}

let viewport = windgramViewport();
window.addEventListener("resize", () => {
  const next = windgramViewport();
  if (next === viewport) return;
  viewport = next;
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { renderDayTabs(); renderSkewT(); renderMeteogram(); }, 150);
}, eventOptions);
$("windgram-full-profile").addEventListener("click", () => {
  fullWindgramProfile = !fullWindgramProfile;
  renderSkewT();
  renderMeteogram();
}, eventOptions);
