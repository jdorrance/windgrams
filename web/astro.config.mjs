// @ts-check
import { defineConfig } from "astro/config";
import devData from "./integrations/dev-data.mjs";

// WINDGRAMS_SITE is the public origin, including a project-site repo path
// (https://owner.github.io/windgrams). WINDGRAMS_BASE is "/" or "/windgrams".
// Local `pnpm dev` leaves both unset.
const site = process.env.WINDGRAMS_SITE || "https://example.com";
const base = !process.env.WINDGRAMS_BASE || process.env.WINDGRAMS_BASE === "/"
  ? "/"
  : `/${process.env.WINDGRAMS_BASE.replace(/^\/+|\/+$/g, "")}`;

export default defineConfig({
  // Static pages. Forecast documents are copied to dist/data at publish time.
  output: "static",
  site,
  base,
  trailingSlash: "ignore",
  // Compression drops the line break between a word and a link that starts the
  // next source line ("under the<a>…"), gluing them together on the page.
  compressHTML: false,
  integrations: [devData({ root: "../forecasts/data" })],
  vite: {
    // Launch pages are built from ../forecasts/sites.json.
    server: { fs: { allow: [".."] } },
    // The sunlight map's 3D view (three.js, ~560 kB, ~140 kB gzipped) is its own
    // chunk, downloaded only when someone opens the 3D view.
    build: { chunkSizeWarningLimit: 650 },
  },
});
