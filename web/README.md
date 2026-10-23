# Website

Static pages, served locally by Astro. `pnpm dev` serves `../forecasts/data` at `/data`.

For a local production preview, run `pnpm preview`. It builds the site, links the
complete local forecast dataset into `dist/data`, and starts the preview server.
This includes launch forecasts and soaring maps without copying the archive.
Build `forecasts/data` first as described in the repository README.

To check a project base path, use
`WINDGRAMS_BASE=/windgrams pnpm preview --host 127.0.0.1 --port 4323`.
Use the same base path when starting the preview and building the site; the
preview command handles both. `pnpm build` remains the production build command.

Forecast documents that are published (NWS, ECMWF, balloons, terrain, sunlight tiles) go through the dataset store in `forecasts/scripts/lib/store.mjs`. Local files are the built-in provider. A host that serves `/data` in production reads that same store; nothing here assumes a particular object-storage vendor.
