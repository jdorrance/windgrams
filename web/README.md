# Website

Static pages, served locally by Astro. `pnpm dev` builds a sample dataset and serves it at `/data`.

Forecast documents that are published (NWS, ECMWF, balloons, terrain, sunlight tiles) go through the dataset store in `forecasts/scripts/lib/store.mjs`. Local files are the built-in provider. A host that serves `/data` in production reads that same store; nothing here assumes a particular object-storage vendor.
