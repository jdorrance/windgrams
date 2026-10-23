import { launchConditions, matchingHourIndex, peakLiftIndex, validDateKey } from "../lib/launch-forecast.ts";
import { parsePublishedProfileJson } from "../lib/published-lift.ts";
// Launch page: day tabs and a model switch scope the meteogram and the NWS
// charts below them. All forecast data is read from /data at view time, so the
// page is always as fresh as the dataset without rebuilding the site.

import { parseForecastManifestJson, parseModelCatalogueJson, parseSiteContextJson } from "@azohra/meteo.briefing/contract";
import type { ForecastManifest, ModelCatalogue, SiteForecast } from "@azohra/meteo.briefing/contract";
import { localDateKey, localHourOfDay, localInstantMs, runFreshness } from "@azohra/meteo.briefing/derive";
import { loadDocument } from "@azohra/meteo.briefing/transport";
import { buildWindgramView } from "../lib/windgram-view.ts";
import { mountWindgramInspector, renderWindgramDiagnosticsSvg, renderWindgramHeightAxisSvg, renderWindgramKey, renderWindgramSvg } from "../lib/windgram-chart.ts";
import { windWindow, compassPoint, type Launch } from "../lib/launches.ts";
import { EcmwfChart, type EcmwfSiteDocument } from "../lib/ecmwf-chart.ts";
import { NwsChart, type NwsHour } from "../lib/nws-chart.ts";
import { SkewTChart } from "../lib/skewt-chart.ts";
import { buildSounding, readSounding, type Finding, type Tone } from "../lib/skewt.ts";
import { choices as balloonChoices, readChoice, type Choice, type RaobDocument } from "../lib/balloon.ts";
import { parseSrg, type Srg } from "../lib/srg.ts";
import { fetchWithRetry } from "../lib/http.ts";
import { DATA_BASE } from "../lib/site.ts";
import { fmt, ft, relativeTime } from "../lib/units.ts";
import { Sunlight, type CloudSeries } from "./sunlight.ts";

// Short-range high-resolution models first, then regional, global, and the ensemble.
const MODEL_ORDER = ["hrrr-conus", "hrdps-continental", "rrfs", "rdps", "gfs", "gdps", "geps"];
const HOUR_MS = 3_600_000;
const DAY_START = 7;
const DAY_END = 21;
const DAYS = 7;

interface NwsSiteDocument {
  updateTime: string | null;
  generatedAt: string;
  grid: { office: string; x: number; y: number; elevationM: number | null };
  pageUrl: string;
  hours: NwsHour[];
  periods: { name: string; startTime: string; isDaytime: boolean; shortForecast: string; detailedForecast: string }[];
}

interface NwsOfficeDocument {
  office: string;
  products: {
    afd: { issuanceTime: string; text: string } | null;
    srg: { issuanceTime: string; text: string } | null;
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const launch = JSON.parse($("launch-config").textContent ?? "{}") as Launch;
const tz = launch.timeZone;
const arc = windWindow(launch);
let sample = false;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetchWithRetry(`${DATA_BASE}/${path}`);
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

const inDay = (validAt: string, dateKey: string) => {
  if (localDateKey(validAt, tz) !== dateKey) return false;
  const hour = localHourOfDay(validAt, tz);
  return hour >= DAY_START && hour <= DAY_END;
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
  b.addEventListener("click", onClick);
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
// After the day's flying hours, open on tomorrow.
let day = validDateKey(requestedDay) ? requestedDay : localHourOfDay(new Date().toISOString(), tz) > DAY_END ? currentDays[1] : currentDays[0];
let model: string | null = manualModel ? requestedModel : null;
let catalogue: ModelCatalogue | null = null;
let launchElevationM: number | null = null;
// Manifests are small and say which hours each model covers; a model's profile
// is only downloaded when it is selected.
const manifests = new Map<string, ForecastManifest>();
const pendingProfiles = new Map<string, Promise<void>>();
const profiles = new Map<string, { profile: SiteForecast; referenceTime: string; generatedAt: string; stale: boolean } | null>();
let nws: NwsSiteDocument | null = null;
let chart: NwsChart | null = null;
let ecmwf: EcmwfSiteDocument | null = null;
let skewt: SkewTChart | null = null;

let skewtHours: SiteForecast["hours"] = [];
let ecmwfChart: EcmwfChart | null = null;
let clearWindgramInspector: (() => void) | null = null;
const sunlight = new Sunlight(launch);

async function profileFor(slug: string) {
  if (!profiles.has(slug)) {
    if (!pendingProfiles.has(slug)) pendingProfiles.set(slug, (async () => {
      const loaded = await loadDocument({ guard: parsePublishedProfileJson, supportedSchemaVersion: 2, fetch: (url) => fetchWithRetry(url), baseUrl: DATA_BASE, modelSlug: slug, siteSlug: launch.slug }).catch(() => null);
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
  const text = await fetchWithRetry(`${DATA_BASE}/${slug}/manifest.json`)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  const manifest = text ? parseForecastManifestJson(text) : null;
  if (manifest && manifest.sites.some((s) => s.slug === launch.slug)) manifests.set(slug, manifest);
}

/** True when the model's published run has hours inside the pilots' day for `dateKey`. */
function covers(slug: string, dateKey: string) {
  const m = manifests.get(slug);
  if (!m) return false;
  const reference = Date.parse(m.referenceTime);
  const first = reference + m.firstForecastHour * HOUR_MS;
  const last = reference + m.lastForecastHour * HOUR_MS;
  return first <= localInstantMs(dateKey, DAY_END, tz) && last >= localInstantMs(dateKey, DAY_START, tz);
}

function modelLabel(slug: string) {
  return modelEntry(slug)?.label.replace(" CONUS", "").replace(" continental", "") ?? slug;
}

async function selectModel(slug: string) {
  model = slug;
  $("meteogram").classList.add("is-loading");
  render();
  await profileFor(slug);
  if (model === slug) { $("meteogram").classList.remove("is-loading"); render(); }
}

// ── rendering ────────────────────────────────────────────────────────────

function renderDayTabs() {
  const host = $("day-tabs");
  const restoreFocus = host.contains(document.activeElement);
  const scrollLeft = host.scrollLeft;
  host.replaceChildren(
    ...days.map((key) => {
      const hasModel = MODEL_ORDER.some((slug) => covers(slug, key));
      const hasNws = nws?.hours.some((h) => inDay(h.validAt, key)) ?? false;
      const hasEcmwf = ecmwf?.hours.some((h) => inDay(h.validAt, key)) ?? false;
      return button(dayLabel(key), daySub(key), key === day, !hasModel && !hasNws && !hasEcmwf, () => {
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
  const host = $<HTMLSelectElement>("model-select");
  host.replaceChildren(
    ...available.map((slug) => {
      const entry = modelEntry(slug);
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = `${modelLabel(slug)}${entry ? ` · ${entry.gridKm} km${entry.kind === "ensemble" ? " ens." : ""}` : ""}`;
      option.selected = slug === model;
      return option;
    }),
  );
  host.disabled = available.length === 0;
  if (!available.length) host.add(new Option("No models available", ""));
}

$<HTMLSelectElement>("model-select").addEventListener("change", (event) => { manualModel = true; void selectModel((event.target as HTMLSelectElement).value); });

function renderMeteogram() {
  const frame = $("meteogram");
  const meta = $("meteogram-meta");
  const title = $("meteogram-title");
  const key = $("meteogram-key");
  const diagnostics = $("meteogram-diagnostics");
  const details = $("meteogram-details");
  const axis = $("meteogram-height-axis");
  clearWindgramInspector?.();
  clearWindgramInspector = null;
  key.replaceChildren();
  diagnostics.replaceChildren();
  axis.replaceChildren();
  details.hidden = true;
  axis.hidden = true;
  const loaded = model ? profiles.get(model) : null;
  const entry = model ? modelEntry(model) : null;
  title.textContent = entry
    ? `Soaring meteogram · ${entry.label}, ${entry.gridKm} km${entry.kind === "ensemble" ? " ensemble" : ""}`
    : "Soaring meteogram";

  if (!loaded) {
    meta.textContent = "";
    const loading = model !== null ? !profiles.has(model) : modelsLoading;
    frame.innerHTML = `<p class="chart-status">${loading ? "Loading the model forecast…" : "Model forecasts for this launch are not published yet."}</p>`;
    if (!loading && model) {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'button secondary'; retry.textContent = 'Retry forecast';
      retry.addEventListener('click', () => { profiles.delete(model!); void selectModel(model!); });
      frame.append(retry);
    }
    return;
  }

  const freshness = entry
    ? runFreshness({ referenceTime: loaded.referenceTime, generatedAt: loaded.generatedAt }, entry, new Date().toISOString(), { currentIntervals: 1, staleAfterIntervals: 3 })
    : "current";
  const run = new Date(loaded.referenceTime);
  meta.textContent = `Run ${run.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ${String(run.getUTCHours()).padStart(2, "0")}Z · published ${relativeTime(loaded.generatedAt)}${
    freshness === "stale" ? " · older than expected" : freshness === "delayed" ? " · newer run is late" : ""
  }${loaded.stale ? " · update in progress" : ""}`;

  const hours = loaded.profile.hours.filter((h) => inDay(h.validAt, day));
  if (hours.length === 0) {
    const other = MODEL_ORDER.find((slug) => slug !== model && covers(slug, day));
    frame.innerHTML = "";
    const p = document.createElement("p");
    p.className = "chart-status";
    p.textContent = `${modelLabel(model ?? "")} does not reach this day. `;
    if (other) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "button secondary";
      b.textContent = `Show ${modelLabel(other)}`;
      b.addEventListener("click", () => selectModel(other));
      p.appendChild(b);
    }
    frame.appendChild(p);
    return;
  }

  const width = Math.max(frame.clientWidth || 640, 320);
  const compact = window.matchMedia("(max-width: 640px)").matches;
  const view = buildWindgramView(loaded.profile, {
    timeZone: tz,
    hours,
    launch: launchElevationM != null ? { name: launch.name, elevationM: launchElevationM } : null,
    launchWindows: [arc],
    capabilities: entry?.capabilities,
    widthPx: width,
    compact,
    heightPx: window.innerHeight,
  });
  frame.innerHTML = renderWindgramSvg(view, { idPrefix: `mg-${launch.slug}` });
  diagnostics.innerHTML = renderWindgramDiagnosticsSvg(view, { idPrefix: `mg-details-${launch.slug}` });
  key.innerHTML = renderWindgramKey();
  details.hidden = false;
  axis.innerHTML = compact ? renderWindgramHeightAxisSvg(view) : "";
  axis.hidden = !compact;
  clearWindgramInspector = mountWindgramInspector(frame, null, view, validAt => {
    const i = skewtHours.findIndex(h => h.validAt === validAt);
    if (i >= 0) showSkewTHour(i);
  });
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  for (const [key, value] of Object.entries({ y: view.top, width: view.columnWidth, height: view.plotHeight, fill: '#fff', 'fill-opacity': .06, stroke: '#203747', 'stroke-width': 2, 'pointer-events': 'none', 'data-selected-hour': '' })) marker.setAttribute(key, String(value));
  frame.querySelector('svg')!.append(marker);
  frame.dataset.columnWidth = String(view.columnWidth);
  frame.dataset.plotLeft = String(view.left);
  frame.dataset.axisWidth = String(compact ? view.left : 0);
  diagnostics.dataset.plotLeft = String(compact ? 102 : view.left);
  // The SVG has only a viewBox; pin it to the scene's pixel size so narrow
  // screens scroll sideways instead of shrinking the chart.
  for (const svg of [frame.querySelector("svg"), diagnostics.querySelector("svg")]) {
    const box = svg?.viewBox.baseVal;
    if (svg && box && box.width > 0) svg.style.width = `${box.width}px`;
  }
  updateHourMarker(true);
  syncWindgramScroll(frame, diagnostics);
}

function renderNws() {
  const meta = $("nws-meta");
  const link = $("nws-link") as HTMLAnchorElement;
  if (!nws) {
    meta.textContent = "";
    link.hidden = true;
    $("nws-charts").innerHTML = `<p class="chart-status">The National Weather Service forecast is not published yet.</p>`;
    return;
  }
  meta.textContent = `Grid ${nws.grid.office} ${nws.grid.x},${nws.grid.y}${
    nws.grid.elevationM != null ? ` (grid elevation ${fmt(ft(nws.grid.elevationM))} ft)` : ""
  } · updated ${nws.updateTime ? relativeTime(nws.updateTime) : "–"}`;
  link.href = nws.pageUrl;
  link.hidden = false;
  if (!chart) {
    chart = new NwsChart($("nws-charts"), chartLaunch(), tz);
  }
  chart.setHours(nws.hours.filter((h) => inDay(h.validAt, day)));
}

/** The selected model's total cloud cover (ensemble median), for dimming the sunlight map. */
function cloudsFor(slug: string | null): CloudSeries | null {
  const loaded = slug ? profiles.get(slug) : null;
  const entry = slug ? modelEntry(slug) : null;
  if (!slug || !loaded) return null;
  const points: CloudSeries["points"] = [];
  for (const hour of loaded.profile.hours) {
    const v = hour.surface.cloudCoverPercent;
    const percent = typeof v === "number" ? v : v.p50;
    if (percent != null) points.push({ ms: Date.parse(hour.validAt), fraction: percent / 100 });
  }
  return points.length ? { label: `${modelLabel(slug)}${entry ? ` ${entry.gridKm} km` : ""}`, points } : null;
}

const chartLaunch = () => ({
  windMinMph: launch.windMinMph,
  windMaxMph: launch.windMaxMph,
  gustMaxMph: launch.gustMaxMph,
  window: arc,
  windowLabel: `${compassPoint(launch.facingDeg)} ±${launch.windArcHalfWidthDeg}°`,
});

function renderEcmwf() {
  const meta = $("ecmwf-meta");
  if (!ecmwf) {
    meta.textContent = "";
    $("ecmwf-charts").innerHTML = `<p class="chart-status">The ECMWF forecast is not published yet.</p>`;
    return;
  }
  const run = ecmwf.models.surface.run ? `Run ${String(new Date(ecmwf.models.surface.run).getUTCHours()).padStart(2, "0")}Z · ` : "";
  const grid = ecmwf.site.gridElevationM != null ? ` · grid point at ${fmt(ft(ecmwf.site.gridElevationM))} ft` : "";
  meta.textContent = `IFS 9 km · ${run}fetched ${relativeTime(ecmwf.generatedAt)}${grid}`;
  if (!ecmwfChart) ecmwfChart = new EcmwfChart($("ecmwf-charts"), chartLaunch(), tz);
  ecmwfChart.setHours(ecmwf.hours.filter((h) => inDay(h.validAt, day)));
}

// ── Skew-T ────────────────────────────────────────────────────────────────

const TONE_ICON: Record<Tone, string> = { good: "✓", neutral: "•", caution: "!", warning: "⚠" };
const hourFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: tz });

function updateHourMarker(reveal = false) {
  const i = skewtHours.findIndex(h => h.validAt === selectedValidAt);
  const frame = $('meteogram');
  const marker = frame.querySelector('[data-selected-hour]');
  marker?.setAttribute('visibility', i < 0 ? 'hidden' : 'visible');
  if (i >= 0) {
    const columnWidth = Number(frame.dataset.columnWidth);
    const left = Number(frame.dataset.plotLeft) + i * columnWidth;
    marker?.setAttribute('x', String(left));
    const axisWidth = Number(frame.dataset.axisWidth);
    if (reveal && axisWidth > 0) {
      if (left < frame.scrollLeft + axisWidth) frame.scrollLeft = Math.max(0, left - axisWidth);
      else if (left + columnWidth > frame.scrollLeft + frame.clientWidth) frame.scrollLeft = left + columnWidth - frame.clientWidth;
    }
  }
  if (selectedValidAt) frame.dataset.validAt = selectedValidAt;
}

function renderConditions(hour: SiteForecast['hours'][number], index: number) {
  const label = hourFormat.format(new Date(hour.validAt));
  const slider = $<HTMLInputElement>('forecast-hour');
  slider.max = String(skewtHours.length - 1); slider.value = String(index);
  slider.setAttribute('aria-valuetext', label);
  $('forecast-hour-label').textContent = label;
  $<HTMLButtonElement>('forecast-hour-prev').disabled = index === 0;
  $<HTMLButtonElement>('forecast-hour-next').disabled = index === skewtHours.length - 1;
  $('forecast-hour-panel').hidden = false;
  $('forecast-hour-panel').dataset.validAt = hour.validAt;
  const conditions = launchConditions(hour, launch, launchElevationM);
  const host = $('forecast-conditions'); host.replaceChildren();
  for (const [label, value] of conditions.values) {
    const group = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value; group.append(dt, dd); host.append(group);
  }
  $('forecast-wind-note').textContent = conditions.issues.join(' · ');
  $('forecast-wind-note').hidden = !conditions.issues.length;
}

function showSkewTHour(index: number) {
  const loaded = model ? profiles.get(model) : null;
  const hour = skewtHours[index];
  if (!loaded || !hour) return;
  selectedValidAt = hour.validAt;
  renderConditions(hour, index);
  updateHourMarker(true);
  $('skewt-chart').dataset.validAt = hour.validAt;
  const url = new URL(location.href);
  url.searchParams.set('day', day); url.searchParams.set('model', model!); url.searchParams.set('time', hour.validAt);
  history.replaceState(null, '', url);
  const slider = $<HTMLInputElement>("skewt-hour");
  slider.value = String(index);
  const label = hourFormat.format(new Date(hour.validAt));
  $("skewt-hour-label").textContent = label;
  slider.setAttribute("aria-valuetext", label);
  const sounding = buildSounding(loaded.profile, hour);
  if (!skewt) skewt = new SkewTChart($("skewt-chart"), { name: launch.name, elevationM: launchElevationM });
  skewt.set(sounding, { name: launch.name, elevationM: launchElevationM });
  const list = $("skewt-findings");
  list.replaceChildren();
  if (!sounding) {
    $("skewt-headline").textContent = "The model has too few levels this hour to draw a sounding.";
    return;
  }
  const reading = readSounding(sounding, launchElevationM);
  $("skewt-headline").textContent = reading.headline;
  renderFindings(list, reading.findings);
}

function renderFindings(list: HTMLElement, findings: Finding[]) {
  list.replaceChildren();
  for (const f of findings) {
    const li = document.createElement("li");
    li.className = `finding finding-${f.tone}`;
    const icon = document.createElement("span");
    icon.className = "finding-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = TONE_ICON[f.tone];
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = f.title;
    const p = document.createElement("p");
    p.textContent = f.text;
    body.append(title, p);
    li.append(icon, body);
    list.appendChild(li);
  }
}

// ── Weather balloon ───────────────────────────────────────────────────────

let balloonChart: SkewTChart | null = null;
let refreshBalloon: (() => void) | null = null;

function legendItem(label: string, swatch: string) {
  const li = document.createElement("li");
  li.innerHTML = swatch;
  li.appendChild(document.createTextNode(label));
  return li;
}

function renderBalloon(doc: RaobDocument | null, srgText: string | null) {
  let srg: Srg | null = null;
  try {
    srg = srgText ? parseSrg(srgText) : null;
  } catch {
    srg = null;
  }
  const list = balloonChoices(doc, srg, tz);
  const root = $("balloon");
  if (list.length === 0) {
    refreshBalloon = null;
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const station = doc?.station;
  $("balloon-title").textContent = `Weather balloon sounding · ${station?.name ?? "nearest station"}${station ? ` (${station.id})` : ""}`;
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", timeZoneName: "short", timeZone: tz });
  const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: tz });
  const tabs = $("balloon-tabs");

  const show = (choice: Choice) => {
    refreshBalloon = () => show(choice);
    for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.id === choice.id));
    if (!balloonChart) balloonChart = new SkewTChart($("balloon-chart"), { name: launch.name, elevationM: launchElevationM });
    balloonChart.set(choice.sounding, { name: launch.name, elevationM: launchElevationM });
    const reading = readChoice(choice, srg, launchElevationM, tz);
    $("balloon-headline").textContent = reading.headline;
    renderFindings($("balloon-findings"), reading.findings);
    const legend = $("balloon-legend");
    legend.replaceChildren(
      legendItem("Temperature", `<span class="key-line" style="color:var(--series-2)"></span>`),
      ...(choice.hasDewPoint ? [legendItem("Dew point", `<span class="key-line" style="color:var(--series-3)"></span>`)] : []),
      legendItem(choice.start.source === "forecast-high" ? "Thermal from the forecast high" : "Rising thermal", `<span class="key-line key-dash"></span>`),
      legendItem("Thermal zone", `<span class="key-swatch skewt-key-zone"></span>`),
      legendItem("Inversion (lid)", `<span class="key-swatch skewt-key-lid"></span>`),
    );
    const when = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: tz }).format(new Date(choice.validAt));
    const utc = new Date(choice.validAt).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const elevation = choice.sounding.modelElevationM;
    $("balloon-meta").textContent =
      choice.kind === "balloon" ? `Sounding valid ${when} · ${utc}` : `NWS model forecast for ${when}`;
    $("balloon-note").textContent =
      choice.kind === "balloon"
        ? `The balloon station is ${station ? `${station.name}, ${station.distanceKm} km from ${launch.name},` : "at the airport"} at ${fmt(ft(elevation))} ft MSL${
            choice.hasDewPoint ? "" : ". This is the Soaring Forecast's copy of the flight, without humidity"
          }. Heights are above mean sea level, not above the launch. Times identify the nominal observation cycle, not the exact balloon release. ${choice.start.source === "forecast-high" ? "The dashed line estimates a thermal rising from the station at the forecast high. " : ""}Balloon data: NWS, via the Iowa Environmental Mesonet.`
        : "A model hour for the station from the NWS Soaring Forecast: temperature and wind only, so no clouds are shown. Heights are above mean sea level.";
  };

  tabs.replaceChildren(
    ...list.map((choice) => {
      const b = button(choice.kind === "balloon" ? day.format(new Date(choice.validAt)) : hour.format(new Date(choice.validAt)), choice.kind === "balloon" ? "balloon" : "NWS model", false, false, () => show(choice));
      b.dataset.id = choice.id;
      return b;
    }),
  );
  show(list.findLast(choice => choice.kind === "balloon") ?? list[list.length - 1]);
}

function renderSkewT() {
  const status = $("skewt-status");
  const body = $("skewt-body");
  const loaded = model ? profiles.get(model) : null;
  const entry = model ? modelEntry(model) : null;
  const hours = loaded ? loaded.profile.hours.filter((h) => inDay(h.validAt, day)) : [];
  if (!loaded || hours.length === 0) {
    body.hidden = true;
    status.hidden = false;
    status.textContent = !model
      ? modelsLoading ? "Loading the sounding…" : "Model forecasts for this launch are not published yet."
      : !loaded
        ? profiles.has(model) ? "The sounding is unavailable for this model. Try another model." : "Loading the sounding…"
        : `${modelLabel(model)} has no upper-air levels for this day.`;
    skewtHours = [];
    $("forecast-hour-panel").hidden = true;
    updateHourMarker();
    return;
  }
  status.hidden = true;
  body.hidden = false;
  const run = new Date(loaded.referenceTime);
  $("skewt-meta").textContent = `${entry ? `${entry.label}, ${entry.gridKm} km` : model} · run ${String(run.getUTCHours()).padStart(2, "0")}Z`;
  skewtHours = hours;
  $<HTMLInputElement>('skewt-hour').max = String(hours.length - 1);
  showSkewTHour(matchingHourIndex(hours, selectedValidAt, tz));
}

$<HTMLInputElement>("skewt-hour").addEventListener("input", (e) => showSkewTHour(Number((e.target as HTMLInputElement).value)));
$("skewt-best").addEventListener("click", () => showSkewTHour(peakLiftIndex(skewtHours, tz)));

$<HTMLInputElement>('forecast-hour').addEventListener('input', e => showSkewTHour(Number((e.target as HTMLInputElement).value)));
$('forecast-hour-prev').addEventListener('click', () => showSkewTHour(Number($<HTMLInputElement>('forecast-hour').value) - 1));
$('forecast-hour-next').addEventListener('click', () => showSkewTHour(Number($<HTMLInputElement>('forecast-hour').value) + 1));
$('forecast-hour-peak').addEventListener('click', () => showSkewTHour(peakLiftIndex(skewtHours, tz)));

function render() {
  renderDayTabs();
  renderModelSelect(MODEL_ORDER.filter((slug) => manifests.has(slug)));
  renderMeteogram();
  renderSkewT();
  renderNws();
  renderEcmwf();
  sunlight.setDay(day, cloudsFor(model));
}

function renderText(office: NwsOfficeDocument | null) {
  const list = $("nws-periods");
  list.replaceChildren();
  for (const period of nws?.periods ?? []) {
    const li = document.createElement("li");
    const h = document.createElement("h3");
    h.textContent = period.name;
    const p = document.createElement("p");
    p.textContent = period.detailedForecast;
    li.append(h, p);
    list.appendChild(li);
  }
  if (!nws?.periods.length) list.innerHTML = `<li class="muted">No text forecast available.</li>`;

  const products = $("nws-products");
  products.replaceChildren();
  const add = (label: string, product: { issuanceTime: string; text: string } | null | undefined) => {
    if (!product) return;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${label} · issued ${relativeTime(product.issuanceTime)}`;
    const pre = document.createElement("pre");
    pre.className = "product";
    pre.textContent = product.text;
    details.append(summary, pre);
    products.appendChild(details);
  };
  add("Soaring Forecast", office?.products.srg);
  add(`Area Forecast Discussion (NWS ${office?.office ?? ""})`, office?.products.afd);
}

async function chooseDefaultModel() {
  const candidates = MODEL_ORDER.filter(slug => manifests.has(slug) && profiles.get(slug) !== null);
  const choice = manualModel && model ? model : candidates.find(slug => covers(slug, day)) ?? candidates[0];
  if (!choice || (choice === model && (profiles.has(choice) || pendingProfiles.has(choice)))) return;
  await selectModel(choice);
  if (!manualModel && profiles.get(choice) === null) await chooseDefaultModel();
}

export async function start() {
  const raobPromise = getJson<RaobDocument>(`raob/sites/${launch.slug}.json`);
  const metadata = Promise.all([
    getJson<unknown>('models.json').then(doc => { catalogue = doc ? parseModelCatalogueJson(JSON.stringify(doc)) : null; renderModelSelect(MODEL_ORDER.filter(slug => manifests.has(slug))); if (model && profiles.get(model)) renderMeteogram(); }),
    getJson<unknown>('site-context.json').then(doc => {
      const context = doc ? parseSiteContextJson(JSON.stringify(doc)) : null;
      launchElevationM = context?.sites[launch.slug]?.elevation.elevationM ?? null;
      if (launchElevationM != null) {
        const sourceId = context?.sites[launch.slug]?.elevation.source;
        const source = context?.sources.find(source => source.id === sourceId);
        $('launch-elevation').textContent = `${fmt(ft(launchElevationM))} ft MSL`;
        $('launch-elevation-source').textContent = source ? `Terrain estimate from ${source.product}${source.kind === 'surfaceModel' ? '; includes vegetation' : ''}.` : 'Terrain estimate at the saved launch coordinates.';
        $('launch-elevation-item').hidden = false;
      }
      refreshBalloon?.();
      if (model && profiles.get(model)) { renderMeteogram(); renderSkewT(); }
    }),
  ]);
  const nwsTask = (async () => {
    nws = await getJson<NwsSiteDocument>(`nws/sites/${launch.slug}.json`);
    renderDayTabs(); renderNws();
    const office = nws ? await getJson<NwsOfficeDocument>(`nws/offices/${nws.grid.office}.json`) : null;
    renderText(office);
    const raob = await raobPromise;
    renderBalloon(raob?.schemaVersion === 1 ? raob : null, office?.products.srg?.text ?? null);
  })();
  const ecmwfTask = getJson<EcmwfSiteDocument>(`ecmwf/sites/${launch.slug}.json`).then(doc => {
    ecmwf = doc?.schemaVersion === 1 ? doc : null; renderDayTabs(); renderEcmwf();
  });
  await Promise.all(MODEL_ORDER.map(async slug => {
    await loadManifest(slug);
    renderDayTabs(); renderModelSelect(MODEL_ORDER.filter(slug => manifests.has(slug)));
    await chooseDefaultModel();
  }));
  modelsLoading = false;
  if (model && !manifests.has(model)) { manualModel = false; model = null; }
  await chooseDefaultModel();
  render();
  await Promise.all([metadata, nwsTask, ecmwfTask]);
  if (sample) $('sample-notice').hidden = false;
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderMeteogram, 150);
});

// Compact charts use different label gutters. Preserve both full labels at the
// start, then align their hours while panning without feeding clamped scrolls back.
const syncedScrollPositions = new WeakMap<HTMLElement, number>();
function syncWindgramScroll(from: HTMLElement, to: HTMLElement) {
  const details = $<HTMLDetailsElement>("meteogram-details");
  if (details.hidden || !details.open || to.clientWidth === 0) return;
  const offset = Number(to.dataset.plotLeft ?? 0) - Number(from.dataset.plotLeft ?? 0);
  const wanted = from.scrollLeft === 0 ? 0 : from.scrollLeft + offset;
  const next = Math.max(0, Math.min(to.scrollWidth - to.clientWidth, wanted));
  if (Math.abs(to.scrollLeft - next) < .5) return;
  to.scrollLeft = next;
  syncedScrollPositions.set(to, to.scrollLeft);
}
for (const [from, to] of [["meteogram", "meteogram-diagnostics"], ["meteogram-diagnostics", "meteogram"]]) {
  $(from).addEventListener("scroll", () => {
    const source = $(from);
    const syncedPosition = syncedScrollPositions.get(source);
    syncedScrollPositions.delete(source);
    if (syncedPosition !== undefined && Math.abs(source.scrollLeft - syncedPosition) < .5) return;
    syncWindgramScroll(source, $(to));
  }, { passive: true });
}
$<HTMLDetailsElement>("meteogram-details").addEventListener("toggle", () => {
  syncWindgramScroll($("meteogram"), $("meteogram-diagnostics"));
});
