# Windgrams refactor: reviewed implementation plan

Reviewed October 24, 2026 against commit `28c4d4a`.

**Decision: approve the refactoring goals, with the corrections and gates below.**
This document supersedes the supplied plan. Approval covers the design; this review
does not implement the refactor. Numerical corrections, algorithm replacements and
dependency upgrades belong in separate changes from code extraction.

Implementation checkpoint, October 24: the calculation modules, chart geometry and
inspection modules, comparison view models, and page controllers are extracted.
Forecasts owns its pinned type-check dependencies and CI runs `check:types`.
Regression coverage includes explicit display units, contour threshold equality,
native-profile cache eviction, failed-load retries, and cached-page restoration.
The verification results below remain the original review baseline; subsequent
test additions are recorded with the implementation. The visual refinement plan
is a separate presentation change.

The goal is easier, safer development: one clear owner for each calculation and
contract, independently testable views, predictable asynchronous state, and forecast
publications whose implementation can be traced. Shorter files are a consequence,
not the acceptance criterion. Refactoring alone does not establish forecast skill.

## 1. Verified baseline

The current offline suites pass on Node 24: **175 forecast tests and 212 web tests**,
387 total. The Python ICON decoder has a separate CI job; it is outside this count
and was not rerun for this plan review. These totals are a baseline, not a permanent
test-count requirement or proof that the calculations are correct.

The original size estimates are stale:

- `web/src/scripts/soaring.ts`: 1,096 lines.
- `web/src/scripts/launch-page.ts`: 776 lines.
- `web/src/lib/windgram-view.ts`: 911 lines.
- `web/src/lib/windgram-chart.ts`: 528 lines; the windgram pair totals 1,439.
- `forecasts/soaring/science.mjs`: 827 lines.
- `forecasts/scripts/build-live-soaring.mjs`: 500 lines.
- `web/src/lib/skewt.ts`: 545 lines; `balloon.ts`: 349.

The main concentration of responsibilities is real. The claims that all seven
files are equally problematic, that the code has no async protection, or that the
comparison table is tested by regex-reading its controller are not supported by
the current repository. Existing tests import pure helpers in
[`web/src/lib/soaring.ts`](../web/src/lib/soaring.ts); the comparison renderer still
needs direct behavioral tests.

## 2. Corrections to the supplied plan

### 2.1 Preserve the existing science during extraction

The proposed `DRY_ADIABATIC_LAPSE_C_PER_M = 0.00976` is **not** the current value.
[`science.mjs`](../forecasts/soaring/science.mjs) imports it from the pinned
`@azohra/meteo.briefing` package. Version 0.6.2 uses **0.0098**. That package's
parcel solver derives its heat capacity as `g / lapse` to make its moist and dry
branches consistent. Substituting 0.00976 and a universal heat capacity of 1004
changes the parcel model.

The local backend's `Rd = 287.05` and the sounding code's `287.04` also differ.
The difference deserves documentation and a numerical impact study, not an
automatic replacement. Keep the current values, operation order, thresholds,
rounding and package versions during structural work. Keep the vendored legacy
derivation and its licence intact.

Separate three kinds of numbers:

- Physical parameters and approximations: gravity, gas constants, moisture formulas.
- Algorithm parameters: parcel lapse rate, Lenschow coefficients, solver tolerances.
- Product policy: the distinct 1 m/s and 1.143 m/s sink ceilings.

Keep Lenschow's maximum computed from its formula, as it is today, rather than
copying its rounded decimal into a constants file. Name and document empirical
thresholds; a rule requiring “zero magic numbers” is not a substitute for this.

### 2.2 Share conversions with explicit source units

`KT = 0.514444` and `KT = 1.943844…` represent opposite conversion directions.
Their names are ambiguous; their reciprocation is intentional.

Use explicit names such as `knotsToMps`, `mpsToKnots`, `feetToMetres` and
`feetPerMinuteToMps`. Reject `toBaseMps(ktOrMph)` without a source-unit argument.
[`units.ts`](../web/src/lib/units.ts) already provides `fromDisplayQuantity` for
editing values in the selected display system. Provider decoding must use fixed
source units, independent of the user's Imperial/Metric preference.

First move helpers without changing their values. Standardizing legacy rounded
conversion factors is a later, measured change because it can move rounding and
classification boundaries. Keep temperature and temperature-difference conversion
distinct. Pressure, altitude and lapse-rate inputs must retain explicit units.

### 2.3 Reuse the existing ensemble contract

The pinned package already exposes `Scalar`, `EnsembleValue`, percentile helpers,
and ensemble/dropout guards. Its contract includes member counts and a defined
zero-member, all-null dropout. The proposed all-optional `EnsembleDistribution`
would weaken those guarantees.

Add a narrow finite-value accessor only where the existing helpers need one.
Preserve distributions until the consumer explicitly needs a median or spread.
Do not treat missing data as zero, average compass bearings as linear numbers, or
derive nonlinear ensemble physics from a median column. Member-level derivation
must precede percentile reduction, as in
[`point-postprocess.mjs`](../forecasts/soaring/point-postprocess.mjs).

The original claim that `published-lift.ts` duplicates `scalar()` is incorrect.
That module owns diagnostic-family selection. Field **absence**, explicit `null`,
zero, and an unsupported diagnostic can have different meanings. Preserve each
consumer's present fallback rules before considering a common policy; the
comparison table and `publishedLift()` do not currently apply identical rules.

### 2.4 A compatibility barrel does not preserve provenance

Keeping exports in `science.mjs` preserves import paths. It does not make newly
extracted files part of the implementation identity. Both
[`replay.mjs`](../forecasts/soaring/replay.mjs) at line 245 and
[`icon-replay.mjs`](../forecasts/soaring/icon-replay.mjs) at line 98 hash explicit
source-file lists. Extracted code and shared constants must enter those lists.

Introduce a deterministic implementation inventory, shared where appropriate by
the HRRR/RRFS and ICON publishers. Cover owned derivation, normalization and
publication dependencies, relevant lockfiles, and the native decoder's pinned
requirements. Audit current coverage as well as newly moved files. Use stable
relative paths, sorted entries and source bytes; exclude caches, timestamps and
unrelated files. Test that changing an inventoried implementation file changes
the fingerprint. A documented explicit inventory with an import-coverage check
is sufficient; a general-purpose module loader is unnecessary.

Keep implementation identity separate from refresh policy. The current bundle
freshness check primarily considers run, contract and integrity. Decide explicitly
when an algorithm revision rebuilds an existing run; harmless source rearrangement
should not accidentally trigger a large provider download. Source changes alter
manifest hashes and bundle names even when numerical payloads remain identical.

### 2.5 Extract geometry before replacing algorithms

The two contour implementations share machinery, but have different contracts:

- Stability reconstructs interval lapse measurements at layer centres, preserves
  inversion boundaries, spans full columns, and retains valid half-columns beside
  missing neighbours. Its threshold/domain rings use even-odd fill.
- Temperature samples point temperatures between forecast centres, preserves open
  curves, and drops interpolation cells with missing corners.
- Resolutions, coordinate spaces, endpoint quantization and time-gap rules differ.

These differences are visible in
[`windgram-view.ts`](../web/src/lib/windgram-view.ts), particularly the stability
reconstruction, `buildStabilityFieldPaths` and `temperatureContours` functions.
Replacing both with a 160-line generic engine is an unsupported estimate and an
algorithm change. A flat `Float64Array` is an optimization choice, not an
architectural requirement; converting `null` to numeric zero would be a serious bug.

Approve removing the SVG path-to-regex-to-components round trip in
[`windgram-chart.ts`](../web/src/lib/windgram-chart.ts). Have temperature geometry
return structured segments/components and label candidates, then render paths
from that structure. Preserve existing endpoint joining and rounding first.
Union-find is a valid connectivity tool; deleting it is not itself a goal.

Only share lower-level interpolation or topology helpers after the separate
engines have demonstrated parity. Keep their samplers, masks, domain boundaries,
resolution and saddle policy explicit. Changing a saddle decider, simplifier or
quantization tolerance requires its own geometry review.

### 2.6 Preserve the differences between model and observed soundings

Balloon code already shares parcel, wind, inversion and cloud helpers with Skew-T.
Further small helpers are useful. A configurable `SoundingNarrator` framework is
not justified by the present duplication.

Model labels follow published diagnostics. Balloon and SRG parcel estimates use
station observations, sometimes heated to a forecast high, and can remain buoyant
through the last measured level. SRG pressure reconstruction starts with a
standard-atmosphere anchor and integrates upward; model surface-pressure estimates
use an upper model anchor. Share mathematical primitives only while preserving
these anchors, assumptions, missing-data rules and uncertainty statements.

Extracting `formatThermalLead` with clear branches is reasonable. Preserve station
versus launch reference, profile-limited bounds, observation time, and source
attribution. Keep pilot-facing wording terse.

### 2.7 Replace unsafe interpolation, not every DOM construction style

Dynamic table text should use text nodes. Existing `renderFindings()` already does
this safely; rewriting it to save lines is cosmetic. Audited SVG strings with
escaped text and sanitized identifiers can remain. Interactive cross-sections can
retain DOM construction and event handlers while their geometry becomes pure.

A small DOM helper is optional. Specify text handling, `0`, `null`, boolean
properties, attributes and event ownership. Arbitrary attributes and URL strings
remain security boundaries. A generic `h()` or `svgTag()` does not automatically
prevent injection. Test hostile names and metadata as literal text, approved URL
protocols, and safe SVG identifiers. This distinction follows the
[MDN guidance on HTML insertion and text content](https://developer.mozilla.org/en-US/docs/Web/API/Element/innerHTML).

### 2.8 Keep request behavior and lifecycle explicit

The application already deduplicates profile requests, checks the active model or
cell before applying completions, bounds native profile caching, and implements
timeouts/retries. Preserve those mechanisms instead of replacing them blindly.

Separate serializable selection, loaded resources, and view lifetime. A small
reducer or transition functions are enough; neither an immutable-store class nor
a new UI framework is required. Avoid copying forecast arrays on every selection.

Classify optional absence, unsupported capability, cancellation, transient failure
and invalid data separately. Show concise status and a retry route where useful.
The regional failed-cell set currently suppresses retries until reload; improve
that in a distinct behavior change with tests. Use an injectable diagnostic sink
for tests rather than a blanket `DEBUG_WINDGRAMS` exception. Expected cancellation
and optional products should not create error noise. DOM debug attributes alone
are not an error-handling design.

### 2.9 Replace arbitrary line caps with dependency rules

Reject mandatory 350-line files, 60-line functions and promises that every frontend
file will fall below 300 lines. Those targets encourage fragmentation and compressed
formatting. Treat size and complexity as review signals.

Enforce type checks, no dependency cycles, explicit module boundaries, intentional
promise handling, and safe rendering on new or touched code. Adopt a pinned lint
tool only with a small agreed rule set. Expand gradually; keep repository-wide
formatting out of extraction commits. Simplify nested conditional prose when it
helps a reader; do not replace it with opaque dispatch machinery just to pass lint.

## 3. Scientific issue found during this review

The proposed universal warmer-surface monotonicity test does not pass the existing
implementation. This review independently reproduced the following result from
`resolvedParcelDepthM` in `science.mjs`:

```text
Terrain: 0 m
Sensible heat: 100 W/m²; latent heat: 0; PBL depth: unavailable
Environment: (1,000 m, 10°C), (2,000 m, 0°C), (3,000 m, −10°C)

Surface 19.700°C -> resolved depth 1,000 m
Surface 19.795°C -> resolved depth     0 m
Surface 19.805°C -> resolved depth 3,000 m
```

The near-neutral first-layer denominator guard at lines 440–444 returns zero.
This is an existing numerical discontinuity. Its prevalence in real forecasts has
not been measured in this review.

**Create a separate science-correction change before treating monotonicity as a
universal green gate.** Preserve this reproducer, derive the intended neutral-layer
limit independently, test both sides of the threshold and the PBL/heat-flux fallback
branches, then compare affected archived columns. Record resulting numerical
changes and the algorithm-version/refresh decision. Do not change constants,
rewrite the solver, or refresh expected outputs merely to make the test pass.
Unrelated UI extraction can proceed while that correction is reviewed.

Other properties need defined domains:

- W* is nondecreasing with sensible heat when depth, pressure, temperature,
  moisture and latent heat are fixed and inputs are valid. This is not a universal
  claim about a coupled weather forecast.
- Increasing sink cannot raise a finite usable ceiling. A transition to `null`
  means no usable ceiling; it is not a numeric altitude of zero.
- A finite usable ceiling is bounded by the thermal top and a finite effective
  cloud cap. With no cloud cap, use the thermal top. Test both the solver's input
  and the orchestrator that supplies the effective cap.
- Preserve independent analytic/reference tests for Lenschow roots, pressure
  estimates, height-weighted vector winds and pressure-mass parcel mixing.

## 4. Target ownership and dependency boundaries

These are ownership boundaries, not a quota of files. Combine adjacent small
modules when doing so makes the dependency graph clearer.

### Forecast pipeline

1. **Provider input:** GRIB/native-grid decoding, field identities, units and
   interval semantics. HRRR, RRFS, ICON and sparse surface products retain their
   distinct adapters.
2. **Pure science:** thermodynamics; convective lift and parcel-depth policy;
   boundary-layer vector wind; native-grid kinematics; experimental terrain
   interpolation. Inputs explicitly distinguish MSL heights and AGL depths.
3. **Diagnostic composition:** V2 calculation order, quality flags, optional
   values and publication rounding. Keep this separate from acquisition and I/O.
4. **Contracts and comparison normalization:** validated profile/sidecar shapes,
   diagnostic-family accessors, model metadata and normalized individual hours.
5. **Publication and audit:** map/profile assembly and agreement, implementation
   identity, content hashes, staging, atomic pointers, retention and delivery.

Suggested extraction targets include `thermodynamics.mjs`, `convective-lift.mjs`,
`boundary-layer-wind.mjs`, `grid-kinematics.mjs`, `terrain-adjustment.mjs`,
`diagnostics.mjs`, `grib-column.mjs` and `audit-agreement.mjs`. Keep a temporary
`science.mjs` export facade for existing consumers. Avoid a catch-all `core.mjs`.

Publication and verification can share normalized-hour accessors. They must retain
different orchestration: publication matches exact valid timestamps; verification
postprocesses inputs, selects an evaluation window and aggregates matched samples.
The verification code lives under `forecasts/verification/`, not `scripts/`.

### Browser

1. **Resource boundary:** fetch/decompression, runtime validation, bounded caching,
   request deduplication and resource status. Reuse `http.ts` and `regional-data.ts`.
2. **Selection:** model, valid time/date, region, location/cell, layer and height
   range. Extend the existing pure `lib/soaring.ts` selection helpers.
3. **View models:** comparison rows, sounding findings and chart scenes. Inputs
   include explicit formatting context; output contains no HTML side effects.
4. **Geometry:** physical sampling, vertical scale, daylight/source-hour mapping,
   stability and temperature geometry, labels and symbols.
5. **Rendering and interaction:** SVG/DOM output, MapLibre adapter, inspector,
   panels and disposal. Thin page scripts connect these pieces.

Keep `windgram-time-axis`, `windgram-scale`, sampling, geometry and inspection
separate where useful. The original sampling module proposal combines unrelated
calendar policy with atmospheric interpolation.

`timeAxis` includes unavailable daylight ticks. `hours` and `sampling` contain real
source data. A shared windgram widget must preserve that distinction. Its narrow
interface can be `render`, `select` and `dispose`; callers keep day selection,
full-horizon navigation and diagnostics scrolling policies.

Make units explicit at the page-to-view boundary. The current renderer and scene
builder read global preferences, so neither is fully pure yet. Preserve the
intentional 5°C versus 8°F displayed contour intervals while keeping source values
unchanged. Pure science and geometry must not import storage, DOM or page controllers.

Do not introduce a cross-root shared package by default. The repository has two
independent pnpm installs. If a truly shared runtime module is justified, first
specify its owner, consumer resolution, type checking, lockfiles, provenance and
CI/Pages path filters. Never import Node forecast modules into the browser bundle.

## 5. Execution sequence and merge gates

Each numbered stage is a reviewable unit of work, potentially several small PRs.
Keep extraction, behavior fixes, formatting and optimization distinguishable.

### Stage 0 — Record behavior and unresolved issues

- Freeze the starting commit, package versions, available source-fixture hashes,
  representative numerical outputs and representative mobile/desktop images.
- Record the neutral-layer discontinuity above as a separate correction. Establish
  the intended diagnostic fallback rules where comparison and chart consumers differ.
- Add missing async-selection and comparison characterization tests before moving
  those responsibilities. Keep the existing chart and physics tests.
- Record scene build/label time, SVG size, selection latency, transferred bytes and
  cache growth for representative HRRR, RRFS, ICON and ensemble cases. Use fixed
  fixtures and viewports; choose budgets from repeatable measurements.

**Gate:** a documented baseline and reproducible defect cases. Expected outputs
must not be regenerated from changed code to declare the baseline correct.

### Stage 1 — Contracts, provenance and gradual type checking

- Extract owned sidecar and view types from page scripts. Reuse upstream schemas
  and types; distinguish wire formats from normalized internal data.
- Add bounded validators at download boundaries for required identities, dimensions,
  timestamps and fields. Preserve optional legacy documents and explicit nulls.
  Validate once per load, not repeatedly during rendering of large arrays.
- Audit finite scalar extraction and explicit source-unit conversions. Migrate
  call sites without changing numeric policy or weakening ensemble dropout handling.
- Add implementation-inventory coverage before moving backend helpers.
- Introduce a separate forecast `check:types` command with pinned TypeScript and
  Node types, NodeNext resolution, `allowJs`, `checkJs`, `noEmit` and strict checking.
  Start with a small owned-module slice, then expand through its callers and tests.
  Exclude data, caches, generated files and vendored snapshots. Do not satisfy the
  checker with broad `any` casts or blanket suppressions.

TypeScript supports checking JavaScript with `checkJs` and `allowJs`; this does not
validate runtime JSON or GRIB. See the
[TypeScript option documentation](https://www.typescriptlang.org/tsconfig/checkJs.html).
Keep runtime guards alongside static types. `forecasts` currently uses `check` for
site validation, so retain that command rather than silently replacing it.

**Gate:** unchanged accepted payloads and values, documented malformed-input
behavior, type checks on the adopted slice, and a test proving extracted source
changes affect implementation identity.

### Stage 2 — Comparison normalization and presentation

- Extract a pure model-hour normalizer and a separate metadata accessor.
- Keep file reads, postprocessing, valid-time selection and verification aggregation
  in their existing orchestration layers.
- Extract browser comparison rows separately from DOM rendering. Rows/cells carry
  value, quantity, availability, diagnostic family, provenance and matching spread.
- Convert externally supplied table strings to text nodes. Preserve source URLs and
  model-specific unsupported states.

Cover deterministic V2, absent V2, explicit V2 null, GEPS legacy and V2 percentiles,
zero-member dropout, scalar wind direction, calm/zero values, ECMWF/NWS sparse
data, ICON, missing matching times and mixed run initializations. A p10–p90 band
must describe the same diagnostic as its centre. Preserve surface LCL versus
effective cloud ceiling and launch versus model terrain.

**Gate:** current publication rows and verification aggregates agree with frozen
expectations; hostile display strings remain literal. Any policy discrepancy
discovered here gets a separate regression and behavior-fix commit.

### Stage 3 — Frontend panels, state transitions and lifetime

- Extract comparison, RAOB and cross-section views, then NWS/ECMWF and balloon
  sections. Keep cross-section click selection and accessibility.
- Separate serializable selection from resources and imperative handles. Introduce
  explicit transitions without deep-copying profiles or building a store framework.
- Extract the MapLibre adapter. Preserve cached GeoJSON/barb updates; selecting a
  chart hour must not recreate the map or refetch an unchanged native profile.
- Extract shared windgram lifecycle only after both callers have tests. Preserve
  independent diagnostics scrolling on mobile and the regional full-horizon slider.
- Give owners a disposal path for listeners, inspectors, observers, timers, markers
  and map resources. Define request invalidation without cancelling a request that
  another consumer still needs.

**Gate:** delayed A→B→A requests, reversed completion order, day changes during
loads, manual model selection during catalogue arrival, retry and disposal tests
all pass. Old completions cannot change active selection or clear a newer request's
loading state. The regional failed-profile retry improvement lands separately.

### Stage 4 — Windgram extraction, then structured geometry

- First move time-axis, scale, sampling, label placement and inspector code with
  compatibility exports and unchanged algorithms.
- Pass unit/format context explicitly and keep physical versus screen coordinates
  clearly named. Preserve missing-data masks and existing numerical precision.
- In a subsequent change, return structured temperature segments/components,
  candidate anchors and bounds. Let SVG rendering consume those structures and
  remove the SVG regex parser. Preserve current connectivity tolerance.
- Consider shared edge/topology helpers only after the two engines pass parity.
  Keep a full engine rewrite, typed-array optimization or new saddle policy optional.

**Gate:** exact physical readings/source times and matching gap behavior, plus
geometry comparisons within documented existing rounding tolerances. Review the
representative images and performance measurements. Smaller source files alone
do not meet this gate.

### Stage 5 — Backend science and publication extraction

This can proceed alongside the frontend stages once Stage 1 and the relevant
baseline tests are complete.

- Move pure functions by the ownership boundaries above, preserving imports through
  the facade, operation order, policy, rounding, extension fields and legacy output.
- Separate GRIB array extraction from atmospheric calculation and audit comparison.
- Keep experimental launch-height interpolation separate from authoritative MSL
  heights. Keep native-grid convergence and wind rotation in their proper adapter.
- Expand type checking through extracted functions, orchestration and call sites.
- Update implementation inventories in the same changes that move files.

**Gate:** offline HRRR, RRFS and ICON replay, exact map/profile agreement, sparse
and ensemble adapter tests, and unchanged numerical payloads. Manifest source
hashes and derived bundle identities may change; list the allowed metadata changes
explicitly. Repeating the same inputs under the same new implementation must still
produce identical bytes. Numerical corrections remain separate from this stage.

### Stage 6 — Delivery, documentation and enforceable boundaries

- Run the complete Node suites, web checks, forecast type checks, site validation,
  synthetic-data generation, production build and offline Python decoder tests.
- Test the built static site under `/windgrams/`, including raw `.gz` files and
  already HTTP-decoded responses, relative data URLs and partial provider failures.
- Verify staged publication, atomic pointers, seeded immutable-file reuse, hash
  rejection, provider overlay merging and current/previous bundle retention.
- Retain the complete Pages artifact-size guard. Exercise a production-like cached
  forecast build/replay after backend changes; a successful code-only Pages push
  reuses data and does not prove the changed producer works.
- Update module ownership, public commands, fixture provenance and algorithm notes.
  Correct stale delivery text, including the 48-hour retention description in
  `docs/soaring-replay.md`, which differs from current two-bundle retention.
- Add agreed dependency/lint gates incrementally and remove obsolete compatibility
  exports only once all consumers have migrated.

**Gate:** the browser and producer consume the same contracts, existing data remains
readable, and production-like output passes the normal publication validators.
Document how to revert the code and retain a compatible prior data bundle. A
rollback must not point at an artifact already removed by retention.

## 6. Required verification matrix

### Numerical and data-contract checks

- Immutable recorded source columns, independent analytic expectations, and generated
  integration outputs have separate roles. Keep all three visible in the test design.
- Preserve scalar/ensemble null semantics, per-member derivation, pressure-mass
  mixing, vector wind averaging, earth-relative direction, and MSL/AGL references.
- Cover HRRR pressure levels, split RRFS fields and intervals, native ICON pressure
  and terrain, sparse surface-only products, and incomplete vertical profiles.
- Test explicit invalid inputs and physical domains for each proposed property.
  Use fixed seeds for generated cases and retain minimized failures as regressions.
- Numerical parity, internal agreement and forecast skill are different checks.
  Skill reports require fixed matched observations and evaluation windows.

### Geometry checks

- Exercise all corner classifications, both saddle connectivities, equality at
  thresholds, plateaus, loops, holes, clipping and touching-boundary cases.
- Cover all-missing fields, missing vertical intervals, missing forecast times,
  adjacent valid/missing columns, and one-hour/degenerate inputs.
- Check connected-component identity, label membership, tiny branches and rounding
  collisions without reparsing rendered SVG.
- Define whether each mask represents a missing source interval, vertex or cell.
  Test the **filled result after holes and masks**, not a blanket assertion that
  every individual threshold ring has zero area in every NaN-containing cell.
- Check closure, boundedness and supported intersection/touching behavior from
  geometry. A trailing SVG `Z` is not proof of valid topology. Preserve the existing
  half-column policy where it applies.

### Browser and interaction checks

Use a small deterministic fixture matrix and automated browser smoke tests, with
fixed local data rather than live weather requests. Include portrait phones at
320 and 390 pixels, landscape, and desktop. Keep visual comparisons focused on
material chart behavior; allow documented font/rasterization differences.

Preserve these current user-visible contracts:

- Chart height stays stable as mobile browser chrome opens/closes; width/orientation
  changes refit it.
- Both mobile height modes retain the local daylight axis. Missing morning/evening
  coverage is hatched and unselectable; it creates no synthetic forecast samples.
- Full height changes altitude extent; focused mode retains the launch/model floor
  and day-based upper limit. Source-hour indices and diagnostics remain aligned.
- AGL inspection snaps to the published blue lift ceiling and uses the same ground
  reference in both height modes. Missing or clipped ceilings retain their behavior.
- Each connected temperature line has at most one label; preserve omission when
  no readable placement fits. Inversion branches and missing gaps remain distinct.
  Smoothed colours preserve source lapse measurements.
- Native ICON pressures, map cells, source profiles and selected valid times agree.
  Armenia retains its region/model defaults and US-only capabilities remain scoped.
- The regional slider spans the full forecast horizon; its chart shows the selected
  local day. Preserve `Asia/Yerevan`, US DST and midnight transitions.
- Unit selection preserves physics and persists through the existing storage/URL
  fallbacks. Source ingestion never follows the display preference.
- Touch dragging scrolls; tapping selects/pins; keyboard navigation, Escape and
  cleanup work. Day tabs and model selection retain focus and compact layout.

Measure render work and memory after repeated selection, not just the initial
screenshot. Retain the eight-profile native cache and on-demand cell loading;
the refactor must not eagerly download the whole vertical grid or increase mobile
work merely to make the code appear more uniform.

## 7. Fixture policy

`forecasts/soaring/fixture-helper.mjs` already exists. It creates synthetic transport
using retained real metadata and decoded values. Preserve its purpose and the
provenance documented in
[`forecasts/soaring/fixtures/README.md`](../forecasts/soaring/fixtures/README.md).

A deterministic regeneration command is useful only for fixtures with complete,
identified inputs. The full RRFS publication has 84 hours; the retained raw RRFS
column is not enough to reconstruct that entire publication. `skill-report.json`
also needs archived forecasts, observations, station matching and a fixed window.

For each regenerable fixture, record input hashes, generator/version, fixed time
inputs and its intended test role. `--check` compares without overwriting. Updating
expected outputs is an explicit reviewed operation with a numerical diff. Do not
rewrite immutable observations or archived baselines, and do not generate both
the expected and actual scientific answer from the same function under test.

## 8. Completion standard

The refactor is complete when responsibility and dependency boundaries are clear,
important behavior can be tested without booting a page or writing an entire
bundle, async work has defined ownership, numerical/source semantics remain
traceable, and both static delivery and forecast production are verified.

Each change should state: what responsibility moved, what behavior stayed fixed,
what evidence demonstrates that, and any intentional behavior change that received
separate review. No universal line quota, test-count target or blanket promise of
“zero regression” substitutes for those results.
