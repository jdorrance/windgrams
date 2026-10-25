# API conventions

Each package exposes a small set of named entry points through its `exports`
map. Public types describe the values a caller needs; decoding helpers, provider
file formats and chart geometry stay inside their packages. New exports should
serve a concrete use in an application or another package.

## Types and values

Use shared domain types when passing weather data between packages. Field names
carry units where practical, such as `temperatureC` and `windSpeedMps`. Height
fields also need a reference: model terrain, launch terrain or mean sea level.
A zero, an explicit `null` and an absent field can have different meanings; each
API documents the cases it accepts and returns.

External data enters as `unknown` and is validated before calculations or display.
Provider results identify whether they contain atmospheric columns or already
processed profiles, along with the implementation that produced them. Custom
adapters supply their own model IDs and provenance. The Azohra compatibility
adapter records its dependency version in its more specific result type.

Network operations accept cancellation. Mounted charts provide disposal for
listeners and other resources. Applications choose when to cancel requests,
release components and refresh cached data.

## Generated declarations

The TypeScript compiler emits JavaScript and declarations together. Runtime
schemas define the types of validated documents. Edit those sources when an API
changes; `dist/` is generated output.

`pnpm check` checks declarations, exports, package dependencies and boundary rules,
including unintended package-owned `any` types. `pnpm test:consumer` compiles and
runs an external example against the packed libraries. It also checks that
private imports and invalid inputs fail to compile. See
[development checks](../README.md#development-checks) for the full command set.

## Terminology

- **Position:** latitude and longitude in degrees, with east-positive longitude.
- **Coverage:** a model's geographic footprint. Native cells determine which
  requested positions can actually be sampled.
- **Run:** a model initialization. Acquisition and publication have their own
  timestamps.
- **Freshness:** the age of a run and how much forecast coverage remains at a
  given time. The reader also checks that manifests and profiles refer to the
  same run.
- **Column:** atmospheric samples at one position and valid time.
- **Profile:** a published forecast containing multiple hours for one site and
  model.
- **Diagnostic:** a calculated weather quantity, with its method and availability.
- **Scene:** a chart prepared for rendering and inspection through the public API.
- **Native resolution:** the spacing of the source grid.
- **Sampling spacing:** the distance between requested samples. Denser sampling
  still uses the same underlying source grid.

MSL heights are measured from mean sea level. AGL heights name the terrain they
use as zero. Model terrain and measured launch elevation may differ; boundary-layer
depth and lift altitude also use different references. Convert display units and
host-specific coordinate formats when data enters or leaves the application.
