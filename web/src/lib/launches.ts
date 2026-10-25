// Launch records and the rules every writer and reader of them shares.
//
// A launch is split across two files so the forecast engine's catalogue stays
// exactly what the engine accepts:
//   forecasts/sites.json         identity the engine reads: slug, name, coordinates, time zone
//   web/src/data/launches.json   what only the website uses: facing, wind limits, notes
//
// This module is plain TypeScript with erasable syntax only, so the Worker,
// the Astro build, the browser and `node --test` all run it unchanged.

import { convertQuantity, formatQuantity, type UnitSystem } from "./units.ts";

export interface SiteEntry {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  timeZone: string;
}

export interface LaunchDetails {
  /** ISO 3166-1 alpha-2 country; empty for legacy records awaiting classification. */
  countryCode: string;
  /** Direction the launch faces (degrees true); also the centre of the wind window. */
  facingDeg: number | null;
  /** Half-width of the acceptable wind-direction arc around facingDeg, degrees. */
  windArcHalfWidthDeg: number | null;
  /** Acceptable surface wind speed range, mph. */
  windMinMph: number | null;
  windMaxMph: number | null;
  /** Gusts above this are out of limits, mph. */
  gustMaxMph: number | null;
  /** Short place label for cards, e.g. "Oregon". */
  region: string;
  /** Free-text notes shown on the launch page. */
  notes: string;
  source?: { name: string; url: string; checkedAt: string; license: string };
}

export interface Launch extends SiteEntry, LaunchDetails {}

export interface SitesFile {
  schemaVersion: 2;
  sites: SiteEntry[];
}

export interface LaunchesFile {
  schemaVersion: 1;
  launches: Record<string, LaunchDetails>;
}

export interface DirectionArc {
  fromDeg: number;
  toDeg: number;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_DETAILS: LaunchDetails = {
  countryCode: "",
  facingDeg: null,
  windArcHalfWidthDeg: null,
  windMinMph: null,
  windMaxMph: null,
  gustMaxMph: null,
  region: "",
  notes: "",
};

/** Time zones offered in the launch editor. */
export const TIME_ZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "America/Boise",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Asia/Yerevan",
];

export const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const normalize = (deg: number) => ((deg % 360) + 360) % 360;

export function compassPoint(deg: number): string {
  return COMPASS_16[Math.round(normalize(deg) / 22.5) % 16];
}

/** The acceptable wind arc for a launch; wraps through north when fromDeg > toDeg. */
export function windWindow(details: Pick<LaunchDetails, "facingDeg" | "windArcHalfWidthDeg">): DirectionArc | null {
  if (details.facingDeg === null || details.windArcHalfWidthDeg === null) return null;
  return {
    fromDeg: normalize(details.facingDeg - details.windArcHalfWidthDeg),
    toDeg: normalize(details.facingDeg + details.windArcHalfWidthDeg),
  };
}

export function inArc(directionDeg: number, arc: DirectionArc | null): boolean {
  if (arc === null) return false;
  const d = normalize(directionDeg);
  return arc.fromDeg <= arc.toDeg ? d >= arc.fromDeg && d <= arc.toDeg : d >= arc.fromDeg || d <= arc.toDeg;
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Joins the two files into launches, in sites.json order; details fall back to defaults. */
export function joinLaunches(sites: SitesFile, launches: LaunchesFile): Launch[] {
  return sites.sites.map((site) => ({ ...DEFAULT_DETAILS, ...launches.launches[site.slug], ...site }));
}

/** Cross-file consistency: every catalogued site has details and every detail has a site. */
export function consistencyErrors(sites: SitesFile, launches: LaunchesFile): string[] {
  const errors: string[] = [];
  const slugs = new Set(sites.sites.map((s) => s.slug));
  for (const slug of slugs) if (!(slug in launches.launches)) errors.push(`${slug}: missing from launches.json`);
  for (const slug of Object.keys(launches.launches)) if (!slugs.has(slug)) errors.push(`${slug}: in launches.json but not in sites.json`);
  return errors;
}

const num = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
const optionalNum = (value: unknown): number | null => value == null || (typeof value === "string" && value.trim() === "") ? null : num(value);
const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

/** Compact form values; keep the original stored mph when this text is unchanged. */
export function windLimitDisplayInput(valueMph: number | null, system: UnitSystem): string {
  if (valueMph === null) return "";
  return String(Number((convertQuantity(valueMph * 0.44704, "wind", system) ?? NaN).toFixed(1)));
}

export function windLimitFromDisplayInput(raw: string, system: UnitSystem, originalMph?: number | null): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (originalMph != null && value === Number(windLimitDisplayInput(originalMph, system))) return originalMph;
  return system === "metric" ? value / 1.609344 : value;
}

/**
 * Validates and normalizes a launch submitted by the admin form.
 * Returns the cleaned launch, or a list of human-readable errors.
 */
export function validateLaunchInput(input: Record<string, unknown>, displayUnits: UnitSystem = "imperial"): { launch: Launch } | { errors: string[] } {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  const slug = typeof input.slug === "string" && input.slug.trim() !== "" ? input.slug.trim() : slugify(name);
  const latitude = num(input.latitude);
  const longitude = num(input.longitude);
  const timeZone = typeof input.timeZone === "string" ? input.timeZone : "";
  const facingDeg = optionalNum(input.facingDeg);
  const windArcHalfWidthDeg = optionalNum(input.windArcHalfWidthDeg);
  const windMinMph = optionalNum(input.windMinMph);
  const windMaxMph = optionalNum(input.windMaxMph);
  const gustMaxMph = optionalNum(input.gustMaxMph);
  const countryCode = typeof input.countryCode === "string" ? input.countryCode.trim().toUpperCase() : "";
  if (input.countryCode !== undefined && !/^[A-Z]{2}$/.test(countryCode)) errors.push("Country: two-letter code, e.g. US, AM or NZ.");
  const region = typeof input.region === "string" ? input.region.trim().slice(0, 80) : "";
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "";

  if (name.length < 2 || name.length > 80) errors.push("Name: 2–80 characters.");
  else if (!SLUG_PATTERN.test(slug)) errors.push("Slug: lowercase letters, digits and hyphens.");
  const hasLat = typeof input.latitude === "number" || (typeof input.latitude === "string" && input.latitude.trim() !== "");
  const hasLon = typeof input.longitude === "number" || (typeof input.longitude === "string" && input.longitude.trim() !== "");
  if (!hasLat || !hasLon) errors.push("Launch coordinates required: place it on the map or enter latitude and longitude.");
  else {
    if (!(latitude >= -90 && latitude <= 90)) errors.push("Latitude: −90° to 90°.");
    if (!(longitude >= -180 && longitude <= 180)) errors.push("Longitude: −180° to 180°.");
  }
  if (!isValidTimeZone(timeZone)) errors.push("Valid time zone required.");
  if (facingDeg !== null && !(facingDeg >= 0 && facingDeg < 360)) errors.push("Launch direction: 0°–359°.");
  if (windArcHalfWidthDeg !== null && !(windArcHalfWidthDeg >= 10 && windArcHalfWidthDeg <= 90)) errors.push("Wind arc half-width: 10°–90°.");
  const windBound = (valueMph: number) => formatQuantity(valueMph * 0.44704, "wind", displayUnits === "metric" ? 5 : 0, displayUnits);
  if (windMinMph !== null && !(windMinMph >= 0 && windMinMph <= 40)) errors.push(`Minimum wind: 0–${windBound(40)}.`);
  if (windMaxMph !== null && !(windMaxMph > 0 && windMaxMph <= 50)) errors.push(`Maximum wind: above 0, up to ${windBound(50)}.`);
  if (windMinMph !== null && windMaxMph !== null && windMinMph >= windMaxMph) errors.push("Minimum wind: below maximum wind.");
  if (gustMaxMph !== null && !(gustMaxMph >= 0 && (windMaxMph === null || gustMaxMph >= windMaxMph) && gustMaxMph <= 60)) errors.push(`Maximum gust: at least maximum wind, up to ${windBound(60)}.`);
  if (errors.length > 0) return { errors };

  return {
    launch: {
      slug,
      name,
      latitude: round5(latitude),
      longitude: round5(longitude),
      timeZone,
      countryCode,
      facingDeg: facingDeg === null ? null : Math.round(facingDeg),
      windArcHalfWidthDeg: windArcHalfWidthDeg === null ? null : Math.round(windArcHalfWidthDeg),
      windMinMph,
      windMaxMph,
      gustMaxMph,
      region,
      notes,
    },
  };
}

/**
 * Applies a create or an update to both files. Creating an existing slug or
 * updating a missing one is an error; a slug never changes on update.
 */
export function applyLaunch(
  sites: SitesFile,
  launches: LaunchesFile,
  launch: Launch,
  mode: "create" | "update",
): { sites: SitesFile; launches: LaunchesFile } | { error: string } {
  const exists = sites.sites.some((s) => s.slug === launch.slug);
  if (mode === "create" && exists) return { error: `A launch with slug "${launch.slug}" already exists.` };
  if (mode === "update" && !exists) return { error: `No launch with slug "${launch.slug}".` };

  const countryCode = launch.countryCode || launches.launches[launch.slug]?.countryCode || "";
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: "Country: two-letter code, e.g. US, AM or NZ." };
  const previousSite = sites.sites.find(s => s.slug === launch.slug);
  const site: SiteEntry = {
    ...previousSite,
    slug: launch.slug,
    name: launch.name,
    latitude: launch.latitude,
    longitude: launch.longitude,
    timeZone: launch.timeZone,
  };
  const details: LaunchDetails = {
    ...launches.launches[launch.slug],
    ...(launch.source ? { source: launch.source } : {}),
    countryCode,
    facingDeg: launch.facingDeg,
    windArcHalfWidthDeg: launch.windArcHalfWidthDeg,
    windMinMph: launch.windMinMph,
    windMaxMph: launch.windMaxMph,
    gustMaxMph: launch.gustMaxMph,
    region: launch.region,
    notes: launch.notes,
  };
  const nextSites = mode === "create" ? [...sites.sites, site] : sites.sites.map((s) => (s.slug === site.slug ? site : s));
  return {
    sites: { ...sites, sites: nextSites },
    launches: { ...launches, launches: { ...launches.launches, [launch.slug]: details } },
  };
}

/** Serializes a data file the way the repository stores it (2-space JSON, trailing newline). */
export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
