// Site-wide settings shown in the header, titles, and page descriptions.
export const SITE_NAME = "Windgrams";
export const SITE_TAGLINE = "Soaring forecasts for paragliding launches";

// Vite sets this to "/" or "/<repo>/", with a trailing slash. A project-site
// Pages deploy needs the prefix; a user site or a custom domain stays at "/".
const rawBase = import.meta.env?.BASE_URL;
export const BASE_URL = !rawBase || rawBase === "/" ? "/" : rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

/** Where forecast documents are served. Local dev serves forecasts/data here. */
export function resolveDataBase(configured: string | undefined, siteBase: string): string {
  if (!configured?.trim()) return `${siteBase}data`;
  const value = configured.trim();
  if (value.startsWith('//') || /[?#\\]/.test(value)) throw new Error('Data origin must be an HTTP(S) URL or root-relative path.');
  if (value.startsWith('/')) {
    // An empty prefix represents datasets served directly at the site root.
    return value.replace(/\/+$/, '');
  }
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Data origin must be an HTTP(S) URL or root-relative path.');
  return value.replace(/\/+$/, '');
}
export const DATA_BASE = resolveDataBase(import.meta.env?.PUBLIC_WINDGRAMS_DATA_BASE, BASE_URL);

/** An in-app path, prefixed for a project site. `href()` is the home page. */
export function href(path = ""): string {
  const clean = path.replace(/^\/+/, "");
  return clean ? `${BASE_URL}${clean}` : BASE_URL;
}
