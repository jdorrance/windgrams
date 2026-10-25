import type { ClientOptions, ForecastSite, JsonClient, RequestOptions } from '../supplemental.ts';
import type { EcmwfSurfaceField, EcmwfAloftField, EcmwfField, EcmwfFieldSpec, OpenMeteoResponse, EcmwfRuns, EcmwfHour, EcmwfDocument, EcmwfBuildOptions, EcmwfSiteStatus, EcmwfManifest } from './ecmwf-types.ts';
import { errorMessage, object, mapRecord } from './json.ts';
// Open-Meteo surface and pressure-level feeds are acquired separately.
// This adapter derives only supported sparse-profile diagnostics. Forecast source
// identity, field units and missing values remain explicit in the output.

export const SCHEMA_VERSION = 1;
export const API = "https://api.open-meteo.com/v1/forecast";
export const SURFACE_MODEL = "ecmwf_ifs";
export const ALOFT_MODEL = "ecmwf_ifs025";
export const USER_AGENT = "Windgrams/0.1";
export const SOURCE = "ECMWF IFS (CC BY 4.0), via Open-Meteo.com";
const DAYS = 7;
const HOUR = 3_600_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** Model run metadata; the path follows Open-Meteo's per-model "static/meta.json" files. */
export const metaUrl = (model: string) => `https://api.open-meteo.com/data/${model}/static/meta.json`;

// document field -> [Open-Meteo variable, accepted units, decimals]
export const SURFACE_FIELDS: Readonly<Record<EcmwfSurfaceField, EcmwfFieldSpec>> = {
  temperatureC: ["temperature_2m", ["°C"], 1],
  dewPointC: ["dew_point_2m", ["°C"], 1],
  windSpeedMps: ["wind_speed_10m", ["m/s"], 1],
  windDirectionDeg: ["wind_direction_10m", ["°"], 0],
  windGustMps: ["wind_gusts_10m", ["m/s"], 1],
  cloudCoverPct: ["cloud_cover", ["%"], 0],
  cloudLowPct: ["cloud_cover_low", ["%"], 0],
  cloudMidPct: ["cloud_cover_mid", ["%"], 0],
  cloudHighPct: ["cloud_cover_high", ["%"], 0],
  precipitationMm: ["precipitation", ["mm"], 1],
  capeJkg: ["cape", ["J/kg"], 0],
  boundaryLayerHeightM: ["boundary_layer_height", ["m"], 0],
  shortwaveWm2: ["shortwave_radiation", ["W/m²", "W/m2"], 0],
};

export const ALOFT_FIELDS: Readonly<Record<EcmwfAloftField, EcmwfFieldSpec>> = {
  wind850SpeedMps: ["wind_speed_850hPa", ["m/s"], 1],
  wind850DirectionDeg: ["wind_direction_850hPa", ["°"], 0],
  height850M: ["geopotential_height_850hPa", ["m"], 0],
  wind700SpeedMps: ["wind_speed_700hPa", ["m/s"], 1],
  wind700DirectionDeg: ["wind_direction_700hPa", ["°"], 0],
  height700M: ["geopotential_height_700hPa", ["m"], 0],
};

/** A missing or oddly unitised core field fails the launch; any other field is left empty with a warning. */
export const CORE_FIELDS = new Set(["windSpeedMps", "windDirectionDeg", "windGustMps", "boundaryLayerHeightM", "cloudCoverPct"]);

export const UNITS: Record<EcmwfField, string> = {
  temperatureC: "°C", dewPointC: "°C", windSpeedMps: "m/s", windDirectionDeg: "° (from)", windGustMps: "m/s",
  cloudCoverPct: "%", cloudLowPct: "%", cloudMidPct: "%", cloudHighPct: "%", precipitationMm: "mm (previous hour)",
  capeJkg: "J/kg", boundaryLayerHeightM: "m above ground", shortwaveWm2: "W/m² (mean over the previous hour)",
  wind850SpeedMps: "m/s", wind850DirectionDeg: "° (from)", height850M: "m above sea level",
  wind700SpeedMps: "m/s", wind700DirectionDeg: "° (from)", height700M: "m above sea level",
};

export const paths = {
  site: (slug: string) => `ecmwf/sites/${slug}.json`,
  manifest: () => "ecmwf/manifest.json",
};

function query(site: ForecastSite, model: string, fields: Readonly<Record<string, EcmwfFieldSpec>>) {
  const hourly = Object.values(fields).map(([name]) => name).join(",");
  return `${API}?latitude=${site.latitude.toFixed(4)}&longitude=${site.longitude.toFixed(4)}&models=${model}&hourly=${hourly}&wind_speed_unit=ms&timeformat=unixtime&forecast_days=${DAYS + 1}`;
}
export const surfaceUrl = (site: ForecastSite) => query(site, SURFACE_MODEL, SURFACE_FIELDS);
export const aloftUrl = (site: ForecastSite) => query(site, ALOFT_MODEL, ALOFT_FIELDS);

/** GET JSON with retries on rate limits and server errors; Open-Meteo's own error reason is kept. */
export function createClient({ fetchImpl = globalThis.fetch, retryDelayMs = 2000 }: ClientOptions = {}): JsonClient {
  return async function getJson(url: string): Promise<unknown> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response = null;
      try {
        response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        last = error;
      }
      if (response !== null) {
        if (response.ok) return await response.json();
        const body = await response.text().catch(() => "");
        let reason = "";
        try {
          const parsed: unknown = JSON.parse(body);
          reason = object(parsed) && typeof parsed.reason === "string" ? parsed.reason : "";
        } catch {
          reason = body.slice(0, 200);
        }
        last = new Error(`GET ${url.split("?")[0]} answered ${response.status}${reason ? `: ${reason}` : ""}`);
        if (!RETRYABLE.has(response.status)) throw last;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
    throw last;
  };
}

const round = (value: number | null | undefined, digits: number) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

const DRY_ADIABATIC_LAPSE_C_PER_M = 0.0098;
function computeSurfaceLclM(temperatureC: number | null, dewPointC: number | null, elevationM: number) {
  if (typeof temperatureC !== "number" || typeof dewPointC !== "number" || typeof elevationM !== "number") return null;
  if (!Number.isFinite(temperatureC) || !Number.isFinite(dewPointC) || !Number.isFinite(elevationM)) return null;
  if (dewPointC >= temperatureC) return round(elevationM, 1);
  const tk = temperatureC + 273.15;
  const tdk = dewPointC + 273.15;
  const tlcl = 1 / (1 / (tdk - 56) + Math.log(tk / tdk) / 800) + 56;
  const aglM = Math.max(0, (tk - tlcl) / DRY_ADIABATIC_LAPSE_C_PER_M);
  return round(elevationM + aglM, 1);
}

/** Reads one Open-Meteo response into { times (ms), columns: field -> values }, checking units. */
export function readResponse<K extends string>(response: OpenMeteoResponse, fields: Readonly<Record<K, EcmwfFieldSpec>>, { label, warn = () => {} }: { label: string; warn?: (message: string) => void }): { times: number[]; columns: Record<K, (number | null)[]> } {
  if (!response?.hourly || !Array.isArray(response.hourly.time)) throw new Error(`${label}: the response has no hourly data`);
  const units = response.hourly_units ?? {};
  if (units.time && units.time !== "unixtime") throw new Error(`${label}: expected unix times, got "${units.time}"`);
  const times = response.hourly.time.map((t) => t * 1000);
  if (response.hourly.time.some(t => typeof t !== 'number')
    || times.some((time, index) => !Number.isFinite(new Date(time).getTime()) || index > 0 && time <= times[index - 1])) {
    throw new Error(`${label}: hourly times must be valid and strictly increasing`);
  }
  const columns = {} as Record<K, (number | null)[]>;
  for (const [field, [name, accepted, digits]] of (Object.entries(fields) as [K, EcmwfFieldSpec][])) {
    const values = response.hourly[name];
    const unit = units[name];
    let problem = null;
    if (!Array.isArray(values)) problem = `${name} is missing`;
    else if (values.length !== times.length) problem = `${name} length differs from hourly times`;
    else if (!accepted.includes(unit ?? "")) problem = `${name} came in "${unit}", expected ${accepted.map((u) => `"${u}"`).join(" or ")}`;
    if (problem) {
      if (CORE_FIELDS.has(field)) throw new Error(`${label}: ${problem}`);
      warn(`${label}: ${problem}; left empty this run`);
      columns[field] = times.map(() => null);
      continue;
    }
    columns[field] = values.map((v) => round(typeof v === "number" ? v : null, digits));
  }
  return { times, columns };
}

/** Run time (ISO) from a model's metadata, or null. */
export function runFromMeta(meta: unknown) {
  const t = object(meta) ? meta.last_run_initialisation_time : undefined;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return null;
  const date = new Date(t * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(".000Z", "Z") : null;
}

/**
 * Builds a launch's document from the two responses (aloft may be null when
 * that request failed). Hours run from the current hour for DAYS days.
 * Supported soaring diagnostics (`surfaceLclM`, `modelBlTopM`) are derived,
 * while unsupported flux/profile diagnostics (`thermalVelocityV2Mps`, `usableLiftTopV2M`)
 * are kept explicitly `null`.
 */
export function buildSiteDocument({ site, surface, aloft, runs = {}, now = Date.now(), warn = () => {} }: EcmwfBuildOptions): EcmwfDocument {
  const s = readResponse(surface, SURFACE_FIELDS, { label: `${site.slug} ${SURFACE_MODEL}`, warn });
  let a = null;
  if (aloft) {
    try {
      a = readResponse(aloft, ALOFT_FIELDS, { label: `${site.slug} ${ALOFT_MODEL}`, warn });
    } catch (error) {
      warn(`${errorMessage(error)}; winds aloft left empty this run`);
    }
  }
  const aloftIndex = new Map((a?.times ?? []).map((t, i) => [t, i]));
  const start = Math.floor(now / HOUR) * HOUR;
  const end = start + DAYS * 24 * HOUR;
  const gridElevationM = typeof surface.elevation === "number" && Number.isFinite(surface.elevation) ? surface.elevation : null;
  const hours: EcmwfHour[] = [];
  s.times.forEach((t, i) => {
    if (t < start || t > end) return;
    const j = aloftIndex.get(t);
    const row = {
      validAt: new Date(t).toISOString().replace(".000Z", "Z"),
      ...mapRecord(SURFACE_FIELDS, field => s.columns[field][i]),
      ...mapRecord(ALOFT_FIELDS, field => j === undefined ? null : a!.columns[field][j]),
    };
    // Open-Meteo pads hours past a model's horizon with nulls: skip hours with no core data.
    if (row.windSpeedMps === null && row.boundaryLayerHeightM === null && row.cloudCoverPct === null) return;
    hours.push({ ...row, soaring: {
      contractVersion: "2.0.0",
      modelKind: "surface-or-sparse-adapter",
      surfaceLclM: gridElevationM === null ? null : computeSurfaceLclM(row.temperatureC, row.dewPointC, gridElevationM),
      modelBlTopM: gridElevationM !== null && typeof row.boundaryLayerHeightM === "number" ? round(gridElevationM + row.boundaryLayerHeightM, 1) : null,
      blMeanWindSpeedMps: null,
      blMeanWindDirDeg: null,
      thermalVelocityV2Mps: null,
      usableLiftTopV2M: null,
      hcritWxtoflyM: null,
      dryHcritM: null,
      mixedLayerLclM: null,
      unsupportedDiagnostics: ["thermalVelocityV2Mps", "usableLiftTopV2M", "hcritWxtoflyM", "dryHcritM", "mixedLayerLclM"],
      unsupportedReason: "ECMWF Open-Meteo feed lacks surface sensible/latent heat fluxes and dense vertical thermodynamic levels.",
    } });
  });
  if (hours.length === 0) throw new Error(`${site.slug}: ECMWF returned no forecast hours from now on`);
  return {
    schemaVersion: SCHEMA_VERSION,
    source: SOURCE,
    generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    soaringMeta: {
      contractVersion: "2.0.0",
      model: "ecmwf",
      modelKind: "surface-or-sparse-adapter",
      supportedDiagnostics: ["surfaceLclM", "modelBlTopM"],
      unsupportedDiagnostics: ["thermalVelocityV2Mps", "usableLiftTopV2M", "hcritWxtoflyM", "dryHcritM", "mixedLayerLclM"],
      unsupportedReason: "ECMWF Open-Meteo feed lacks surface sensible/latent heat fluxes and dense vertical thermodynamic levels.",
      synthesizedLevels: 0,
    },
    models: {
      surface: { id: SURFACE_MODEL, label: "ECMWF IFS 9 km", run: runs.surface ?? null },
      aloft: { id: ALOFT_MODEL, label: "ECMWF IFS 0.25°", run: runs.aloft ?? null },
    },
    site: {
      slug: site.slug,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      timeZone: site.timeZone,
      gridLatitude: surface.latitude ?? null,
      gridLongitude: surface.longitude ?? null,
      gridElevationM,
    },
    units: UNITS,
    hours,
  };
}

/** Fetches both responses (and run times, best effort) for one launch and builds its document. */
export async function fetchSiteDocument(site: ForecastSite, getJson: JsonClient, { now = Date.now(), warn = () => {} }: RequestOptions = {}): Promise<EcmwfDocument> {
  const surface = parseOpenMeteoResponse(await getJson(surfaceUrl(site)));
  let aloft = null;
  try {
    aloft = parseOpenMeteoResponse(await getJson(aloftUrl(site)));
  } catch (error) {
    warn(`${site.slug}: ${ALOFT_MODEL} unavailable (${errorMessage(error)}); winds aloft left empty this run`);
  }
  const run = async (model: string) => runFromMeta(await getJson(metaUrl(model)).catch(() => null));
  const runs = { surface: await run(SURFACE_MODEL), aloft: await run(ALOFT_MODEL) };
  return buildSiteDocument({ site, surface, aloft, runs, now, warn });
}

export function buildManifest({ now = Date.now(), sites, runs = {} }: { now?: number; sites: EcmwfSiteStatus[]; runs?: EcmwfRuns }): EcmwfManifest {
  return { schemaVersion: SCHEMA_VERSION, source: SOURCE, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"), runs, sites };
}

/** Verify the transport shape; individual weather values are normalized by readResponse. */
function parseOpenMeteoResponse(raw: unknown): OpenMeteoResponse {
  if (!object(raw) || !object(raw.hourly) || !Array.isArray(raw.hourly.time) || !raw.hourly.time.every(value => typeof value === 'number')
    || !Object.values(raw.hourly).every(Array.isArray)
    || (raw.hourly_units !== undefined && (!object(raw.hourly_units) || !Object.values(raw.hourly_units).every(value => typeof value === 'string')))
    || !['latitude', 'longitude', 'elevation'].every(key => raw[key] == null || typeof raw[key] === 'number')) throw new Error('Invalid Open-Meteo response');
  return raw as unknown as OpenMeteoResponse;
}
