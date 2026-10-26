import { parsePoint, parseGrid, parseHourly, parsePeriods } from './nws-json.ts';
import type { ClientOptions, ForecastSite, JsonClient, RequestOptions } from '../supplemental.ts';
import type { NwsNumericField, NwsHour, NwsPeriod, NwsPointResponse, NwsLayer, NwsWeather, NwsGridLayer, NwsGridResponse, NwsPeriodsResponse, NwsHourlyResponse, NwsDocument, NwsBuildOptions, NwsProduct, NwsOfficeDocument, NwsSiteStatus, NwsOfficeStatus, NwsManifest } from './nws-types.ts';
import { errorMessage, object, mapRecord } from './json.ts';
import { surfaceLclM } from './thermodynamics.ts';
// National Weather Service (NOAA) point forecasts from api.weather.gov.
//
// For a launch's coordinates this collects:
//   - the forecast grid (forecastGridData): the same NDFD data behind the
//     forecast.weather.gov hourly graph, expanded to one row per hour
//   - the hourly forecast's short text ("Sunny", "Chance T-storms") per hour
//   - the 12-hour text periods ("Tonight: Mostly clear, ...")
// and, per forecast office, the latest Area Forecast Discussion (AFD) and,
// where the office issues one, the Soaring Forecast (SRG).
//
// No API key is needed. NWS asks every client to send a User-Agent that
// identifies the application and a way to contact its operator.

export const SCHEMA_VERSION = 1;
export const API = "https://api.weather.gov";
export const DEFAULT_USER_AGENT = "Windgrams/0.1";

const HOUR = 3_600_000;
const MAX_HOURS = 7 * 24;

// ── units ────────────────────────────────────────────────────────────────

// Every published field has one unit. NWS declares a unit (uom) per grid
// layer; anything not in this table fails loudly instead of being mislabeled.
const CONVERSIONS: Record<'speed' | 'temperature' | 'length' | 'percent' | 'angle' | 'index', Record<string, (value: number) => number>> = {
  speed: {
    "wmoUnit:km_h-1": (v) => v / 3.6,
    "wmoUnit:m_s-1": (v) => v,
    "wmoUnit:kn": (v) => v * 0.514444,
  },
  temperature: {
    "wmoUnit:degC": (v) => v,
    "wmoUnit:degF": (v) => ((v - 32) * 5) / 9,
  },
  length: {
    "wmoUnit:m": (v) => v,
    "wmoUnit:km": (v) => v * 1000,
    "wmoUnit:ft": (v) => v * 0.3048,
  },
  percent: { "wmoUnit:percent": (v) => v },
  angle: { "wmoUnit:degree_(angle)": (v) => v },
  index: { "nwsUnit:n/a": (v) => v, "wmoUnit:1": (v) => v },
};

// Published field -> [NWS grid layer, unit class, decimals].
export const FIELDS: Record<NwsNumericField, readonly [NwsGridLayer, keyof typeof CONVERSIONS, number]> = {
  temperatureC: ["temperature", "temperature", 1],
  dewpointC: ["dewpoint", "temperature", 1],
  relativeHumidityPct: ["relativeHumidity", "percent", 0],
  skyCoverPct: ["skyCover", "percent", 0],
  windDirectionDeg: ["windDirection", "angle", 0],
  windSpeedMps: ["windSpeed", "speed", 1],
  windGustMps: ["windGust", "speed", 1],
  precipitationProbabilityPct: ["probabilityOfPrecipitation", "percent", 0],
  thunderProbabilityPct: ["probabilityOfThunder", "percent", 0],
  lightningActivityLevel: ["lightningActivityLevel", "index", 0],
  mixingHeightM: ["mixingHeight", "length", 0],
  transportWindDirectionDeg: ["transportWindDirection", "angle", 0],
  transportWindSpeedMps: ["transportWindSpeed", "speed", 1],
  ceilingHeightM: ["ceilingHeight", "length", 0],
  visibilityM: ["visibility", "length", 0],
};

export const UNITS: Record<NwsNumericField | 'weather' | 'shortForecast', string> = {
  temperatureC: "°C",
  dewpointC: "°C",
  relativeHumidityPct: "%",
  skyCoverPct: "%",
  windDirectionDeg: "degrees true, direction the wind blows from",
  windSpeedMps: "m/s, 10 m above ground",
  windGustMps: "m/s, 10 m above ground",
  precipitationProbabilityPct: "%",
  thunderProbabilityPct: "%",
  lightningActivityLevel: "LAL 1-6 (1 = no thunderstorms, 6 = dry lightning)",
  mixingHeightM: "m above ground level",
  transportWindDirectionDeg: "degrees true, mean wind through the mixed layer",
  transportWindSpeedMps: "m/s, mean wind through the mixed layer",
  ceilingHeightM: "m above ground level",
  visibilityM: "m",
  weather: "NWS weather coverage and type, e.g. 'slight_chance thunderstorms'",
  shortForecast: "NWS hourly short text",
};

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Percentages and indices have no physical unit; NWS sometimes omits the uom
// on those layers (seen on probabilityOfThunder), and that is not ambiguous.
const UNITLESS = new Set(["percent", "index"]);

/** Fields the forecast is useless without: an unknown unit on these stops the launch. */
export const CORE_FIELDS = new Set(["temperatureC", "windSpeedMps", "windGustMps", "windDirectionDeg"]);

function converter(field: NwsNumericField, uom: string | null | undefined) {
  const [, unitClass] = FIELDS[field];
  if (uom == null && UNITLESS.has(unitClass)) return (v: number) => v;
  const fn = CONVERSIONS[unitClass][uom ?? ""];
  if (!fn) throw new Error(`${field}: unexpected NWS unit "${uom}" for a ${unitClass} value`);
  return fn;
}

export function convert(field: NwsNumericField, uom: string | null | undefined, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return round(converter(field, uom)(value), FIELDS[field][2]);
}

// ── time ─────────────────────────────────────────────────────────────────

/** ISO 8601 duration as used by NWS validTime intervals (P1DT6H, PT1H, P7D) -> ms. */
export function parseDuration(text: string) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(text);
  if (!match || text === "P" || text.endsWith("T")) throw new Error(`unsupported ISO 8601 duration "${text}"`);
  const [, days = "0", hours = "0", minutes = "0"] = match;
  return (Number(days) * 24 + Number(hours)) * HOUR + Number(minutes) * 60_000;
}

/** "2026-09-29T18:00:00+00:00/PT3H" -> { start, end } in epoch ms. */
export function parseValidTime(validTime: string) {
  const [startText, durationText] = validTime.split("/");
  const start = Date.parse(startText);
  if (Number.isNaN(start) || durationText === undefined) throw new Error(`unsupported validTime "${validTime}"`);
  return { start, end: start + parseDuration(durationText) };
}

const floorHour = (ms: number) => Math.floor(ms / HOUR) * HOUR;

/** Expands a grid layer's intervals to a Map of hour start (epoch ms) -> raw value. */
export function expandLayer<T>(layer: NwsLayer<T> | null | undefined): Map<number, T | null> {
  const hours = new Map<number, T | null>();
  for (const { validTime, value } of layer?.values ?? []) {
    const { start, end } = parseValidTime(validTime);
    for (let t = floorHour(start); t < end; t += HOUR) hours.set(t, value);
  }
  return hours;
}

/** NWS weather value (array of conditions) -> "chance rain_showers; slight_chance thunderstorms" or null. */
export function describeWeather(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((c: unknown) => (object(c) ? [c.coverage, c.intensity, c.weather] : []).filter(Boolean).join(" "))
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join("; ") : null;
}

// ── document assembly (pure) ─────────────────────────────────────────────

/**
 * Builds one launch's document from already-fetched API responses.
 * `hourly` and `forecast` may be null when those endpoints failed.
 *
 * A layer whose unit is not recognised is never published with a guessed
 * unit: a core field (wind, gust, direction, temperature) stops the launch,
 * any other field is left empty for this run with a warning.
 */
export function buildSiteDocument({ site, point, grid, hourly, forecast, now = Date.now(), warn = console.warn }: NwsBuildOptions): NwsDocument {
  const props = grid.properties;
  const layers = {} as Record<NwsNumericField, { uom: string | null; hours: Map<number, number | null> }>;
  for (const [field, [layerName]] of (Object.entries(FIELDS) as [NwsNumericField, typeof FIELDS[NwsNumericField]][])) {
    const layer = props[layerName];
    const hours = expandLayer(layer);
    const uom = layer?.uom ?? null;
    const hasValues = [...hours.values()].some((v) => v !== null && v !== undefined);
    if (hasValues) {
      try {
        converter(field, uom);
      } catch (error) {
        if (CORE_FIELDS.has(field)) throw error;
        warn(`${site.slug}: ${errorMessage(error)}; ${field} left empty this run`);
        hours.clear();
      }
    }
    layers[field] = { uom, hours };
  }
  const weather = expandLayer(props.weather);

  const shortText = new Map<number, string | null>();
  for (const period of hourly?.properties?.periods ?? []) {
    shortText.set(floorHour(Date.parse(period.startTime)), period.shortForecast ?? null);
  }

  // The forecast spans the hours the core layers cover, from the current hour on.
  const covered = [...layers.temperatureC.hours.keys(), ...layers.windSpeedMps.hours.keys()];
  if (covered.length === 0) throw new Error("the forecast grid has no temperature or wind values");
  const first = floorHour(now);
  const last = Math.min(Math.max(...covered), first + (MAX_HOURS - 1) * HOUR);

  const pointProps = point.properties;
  const elevation = props.elevation;
  const gridElevationM = elevation?.value == null ? null : round(convert("ceilingHeightM", elevation.unitCode, elevation.value)!, 0);
  const roundedSurfaceLclM = (tempC: number | null, dewC: number | null, elevM: number) => {
    const lclM = surfaceLclM(tempC, dewC, elevM);
    return lclM === null ? null : round(lclM, 1);
  };

  const hours: NwsHour[] = [];
  for (let t = first; t <= last; t += HOUR) {
    const row = {
      validAt: new Date(t).toISOString(),
      ...mapRecord(layers, (field, { uom, hours: values }) => values.has(t) ? convert(field, uom, values.get(t)) : null),
      weather: describeWeather(weather.get(t)),
      shortForecast: shortText.get(t) ?? null,
    };
    hours.push({ ...row, soaring: {
      contractVersion: "2.0.0",
      modelKind: "surface-or-sparse-adapter",
      surfaceLclM: gridElevationM === null ? null : roundedSurfaceLclM(row.temperatureC, row.dewpointC, gridElevationM),
      modelBlTopM: gridElevationM !== null && typeof row.mixingHeightM === "number" ? round(gridElevationM + row.mixingHeightM, 1) : null,
      blMeanWindSpeedMps: row.transportWindSpeedMps ?? null,
      blMeanWindDirDeg: row.transportWindDirectionDeg ?? null,
      thermalVelocityV2Mps: null,
      usableLiftTopV2M: null,
      hcritWxtoflyM: null,
      dryHcritM: null,
      mixedLayerLclM: null,
      unsupportedDiagnostics: ["thermalVelocityV2Mps", "usableLiftTopV2M", "hcritWxtoflyM", "dryHcritM", "mixedLayerLclM"],
      unsupportedReason: "NWS NDFD grid lacks surface sensible/latent heat fluxes and vertical thermodynamic profile levels.",
    } });
  }
  if (!hours.some(hour => Number.isFinite(hour.temperatureC) || Number.isFinite(hour.windSpeedMps))) {
    throw new Error(`${site.slug}: NWS returned no temperature or wind forecast from now on`);
  }

  const periods = (forecast?.properties?.periods ?? []).map((p) => ({
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    isDaytime: p.isDaytime,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast,
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    source: "National Weather Service (NOAA), api.weather.gov",
    generatedAt: new Date(now).toISOString(),
    updateTime: props.updateTime ?? null,
    hourlyUpdateTime: hourly?.properties?.updateTime ?? null,
    periodsUpdateTime: forecast?.properties?.updateTime ?? null,
    soaringMeta: {
      contractVersion: "2.0.0",
      model: "nws",
      modelKind: "surface-or-sparse-adapter",
      supportedDiagnostics: ["surfaceLclM", "modelBlTopM", "blMeanWindSpeedMps", "blMeanWindDirDeg"],
      unsupportedDiagnostics: ["thermalVelocityV2Mps", "usableLiftTopV2M", "hcritWxtoflyM", "dryHcritM", "mixedLayerLclM"],
      unsupportedReason: "NWS NDFD grid lacks surface sensible/latent heat fluxes and vertical thermodynamic profile levels.",
      synthesizedLevels: 0,
    },
    site: {
      slug: site.slug,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      timeZone: site.timeZone,
    },
    grid: {
      office: pointProps.gridId,
      x: pointProps.gridX,
      y: pointProps.gridY,
      elevationM: gridElevationM,
    },
    pageUrl: forecastPageUrl(site),
    units: UNITS,
    hours,
    periods,
  };
}

export function forecastPageUrl(site: ForecastSite) {
  return `https://forecast.weather.gov/MapClick.php?lat=${site.latitude.toFixed(4)}&lon=${site.longitude.toFixed(4)}`;
}

export function buildManifest({ now = Date.now(), sites, offices }: { now?: number; sites: NwsSiteStatus[]; offices: NwsOfficeStatus[] }): NwsManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "National Weather Service (NOAA), api.weather.gov",
    generatedAt: new Date(now).toISOString(),
    sites,
    offices,
  };
}

export const paths = {
  manifest: () => "nws/manifest.json",
  site: (slug: string) => `nws/sites/${slug}.json`,
  office: (office: string) => `nws/offices/${office}.json`,
};

// ── network ──────────────────────────────────────────────────────────────

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * GET a JSON document from api.weather.gov. Returns null on 404; retries
 * transient failures (NWS answers occasional 500/503s); throws otherwise.
 */
export function createClient({ userAgent = DEFAULT_USER_AGENT, fetchImpl = globalThis.fetch, retryDelayMs = 2000 }: ClientOptions & { userAgent?: string } = {}): JsonClient {
  return async function getJson(url: string): Promise<unknown> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response = null;
      try {
        response = await fetchImpl(url, {
          headers: { "user-agent": userAgent, accept: "application/geo+json, application/ld+json;q=0.9" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        last = error; // network failure or timeout: retry
      }
      if (response !== null) {
        if (response.status === 404) return null;
        if (response.ok) return await response.json();
        last = new Error(`GET ${url} answered ${response.status}`);
        if (!RETRYABLE.has(response.status)) throw last;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw last;
  };
}

/** Fetches everything for one launch and builds its document. */
export async function fetchSiteDocument(site: ForecastSite, getJson: JsonClient, { now = Date.now(), warn = console.warn }: RequestOptions = {}): Promise<NwsDocument> {
  const rawPoint = await getJson(`${API}/points/${site.latitude.toFixed(4)},${site.longitude.toFixed(4)}`);
  if (rawPoint === null) throw new Error("NWS has no forecast point here (outside the US?)");
  const point = parsePoint(rawPoint);
  const { forecastGridData, forecastHourly, forecast } = point.properties;

  const rawGrid = await getJson(forecastGridData);
  if (rawGrid === null) throw new Error(`forecast grid not found: ${forecastGridData}`);

  const grid = parseGrid(rawGrid);
  const optional = async <T>(label: string, url: string, parse: (raw: unknown) => T | null): Promise<T | null> => {
    try {
      return parse(await getJson(url));
    } catch (error) {
      warn(`${site.slug}: ${label} unavailable (${errorMessage(error)}); continuing without it`);
      return null;
    }
  };
  const hourly = await optional("hourly forecast", forecastHourly, parseHourly);
  const periods = await optional("text forecast", forecast, parsePeriods);

  const document = buildSiteDocument({ site, point, grid, hourly, forecast: periods, now, warn });
  const ageHours = document.updateTime ? (now - Date.parse(document.updateTime)) / HOUR : Infinity;
  if (ageHours > 12) warn(`${site.slug}: NWS grid updateTime ${document.updateTime} is ${Math.round(ageHours)} h old`);
  return document;
}

/**
 * Latest product of a type (AFD, SRG) for an office, or null if the office
 * issues none. When `previous` is already that product it is returned as is,
 * without downloading the text again.
 */
export async function fetchLatestProduct(getJson: JsonClient, type: string, office: string, previous: NwsProduct | null = null): Promise<NwsProduct | null> {
  const list = await getJson(`${API}/products/types/${type}/locations/${office}`);
  const latest: unknown = object(list) && Array.isArray(list["@graph"]) ? list["@graph"][0] : undefined;
  if (!object(latest) || typeof latest.id !== "string") return null;
  if (previous?.id === latest.id && typeof previous.text === "string") return previous;
  const product = await getJson(`${API}/products/${latest.id}`);
  if (product === null) return null;
  if (!object(product) || !["id", "issuanceTime", "productText"].every(key => typeof product[key] === "string")) throw new Error("Invalid NWS text product");
  return {
    id: String(product.id),
    productCode: typeof product.productCode === "string" ? product.productCode : type,
    productName: typeof product.productName === "string" ? product.productName : null,
    issuanceTime: String(product.issuanceTime),
    text: String(product.productText),
  };
}

/**
 * The office's latest AFD and Soaring Forecast. `previous` is the office
 * document already published: products that have not changed are reused
 * without downloading them again, and a product NWS fails to serve keeps its
 * previous copy instead of disappearing from the site.
 *
 */
export async function fetchOfficeDocument(office: string, getJson: JsonClient, { now = Date.now(), warn = console.warn, previous = null }: RequestOptions & { previous?: NwsOfficeDocument | null } = {}): Promise<NwsOfficeDocument> {
  const products: NwsOfficeDocument["products"] = { afd: null, srg: null };
  // AFD: forecasters' reasoning. SRG: Soaring Forecast, only some offices issue it.
  for (const type of ["AFD", "SRG"]) {
    const key = type.toLowerCase() as "afd" | "srg";
    const before = previous?.office === office ? (previous.products?.[key] ?? null) : null;
    try {
      products[key] = await fetchLatestProduct(getJson, type, office, before);
    } catch (error) {
      warn(`${office}: ${type} unavailable (${errorMessage(error)})${before ? "; keeping the previous one" : ""}`);
      products[key] = before;
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "National Weather Service (NOAA), api.weather.gov",
    generatedAt: new Date(now).toISOString(),
    office,
    products,
  };
}

/** True when two office documents carry different products (by NWS product id). */
export function officeProductsChanged(before: NwsOfficeDocument | null | undefined, after: NwsOfficeDocument | null | undefined): boolean {
  return (["afd", "srg"] as const).some((key) => (before?.products?.[key]?.id ?? null) !== (after?.products?.[key]?.id ?? null));
}
