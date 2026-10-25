# Changelog

## 0.1.0 (unreleased)

Initial version with NOAA/ECCC profile adapters, native ICON columns, supplemental forecasts, terrain products and a shared model registry.

The `/area` entry adds explicit run, bounds and hour selection for native ICON
columns. It preserves unavailable cells and source metadata, supports cancellation,
and supplies the existing ICON point and regional producer from one acquisition.
