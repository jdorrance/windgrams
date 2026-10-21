// Site-wide settings shown in the header, titles, and page descriptions.
export const SITE_NAME = "Windgrams";
export const SITE_TAGLINE = "Soaring forecasts for paragliding launches";

// Vite sets this to "/" or "/<repo>/", with a trailing slash. A project-site
// Pages deploy needs the prefix; a user site or a custom domain stays at "/".
const rawBase = import.meta.env?.BASE_URL;
export const BASE_URL = !rawBase || rawBase === "/" ? "/" : rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

/** Where forecast documents are served. Local dev serves forecasts/data here. */
export const DATA_BASE = `${BASE_URL}data`;

/** An in-app path, prefixed for a project site. `href()` is the home page. */
export function href(path = ""): string {
  const clean = path.replace(/^\/+/, "");
  return clean ? `${BASE_URL}${clean}` : BASE_URL;
}
