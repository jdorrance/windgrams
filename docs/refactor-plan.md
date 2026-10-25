# Numerical compatibility and known issues

Changes to the forecast implementation can alter results even when the equations appear unchanged. Constants, operation order, interpolation, missing values and rounding all matter. This page records the numerical behavior that needs care during maintenance, including a known parcel-depth discontinuity.

For package layout and development commands, use the [toolkit guide](toolkit.md) and [public interfaces](toolkit-contracts.md). The scientific quantities themselves are described in [soaring diagnostics](forecast-improvement-plan.md).

## Open: near-neutral parcel-depth discontinuity

Method 2.1.0 has a discontinuity in [`resolvedParcelDepthM`](../packages/soaring/src/convective-lift.ts). With terrain at 0 m, sensible heat flux 100 W/m², latent heat flux 0 and no PBL depth, use this environmental column:

```text
Height:       1,000 m   2,000 m   3,000 m
Temperature:     10°C       0°C     −10°C

Surface 19.700°C → resolved depth 1,000 m
Surface 19.795°C → resolved depth     0 m
Surface 19.805°C → resolved depth 3,000 m
```

The first-layer fallback returns zero when the dry-adiabatic lapse plus the surface-to-first-level environmental lapse is ≤0.00001°C/m. [Characterization tests](../forecasts/soaring/soaring.test.mjs) reproduce the threshold behavior and the separate branch that uses PBL depth. Its frequency and effect in operational forecasts still need measurement.

A correction needs an independently derived neutral-layer limit, tests on both sides of the threshold, and coverage of the PBL and heat-flux fallback branches. An archived-column comparison should show how often the correction changes thermal depth and downstream lift ceilings. The correction should also specify its method version and whether forecasts from the same initialization need rebuilding.

## Numerical compatibility

The dry parcel lapse is 0.0098°C/m. The backend and sounding calculations use gas constants of 287.05 and 287.04 J/(kg·K), respectively. Unifying those constants would be a numerical change, so it needs the same input-by-input comparison as an equation change.

The 1 m/s and 225 ft/min (1.143 m/s) sink ceilings describe different thresholds and must remain distinct. Ensemble diagnostics are derived per member before percentile reduction. Absent fields, null values and numerical zero also have different meanings; converting between them can make unsupported diagnostics appear available.

Model terrain, measured launch elevation, MSL heights and AGL depths are separate references. Model and observed soundings retain their own pressure anchors and valid times. Rendering interpolates for display while stored forecast values remain unchanged.

Shared plotting code needs to preserve each field's sampling and masks. Temperature contours connect point samples; lapse-rate shading represents intervals between levels. Their boundary and saddle rules can differ even when they use similar geometric primitives.

Scientific method versions, document schemas and package releases identify different changes. Reproducing a published value establishes numerical compatibility. Reproducing the source selection and bundle bytes establishes publication consistency. Neither substitutes for an observation-based estimate of forecast error.

## Tests and fixtures

Physical-property tests need a stated domain. Heat-flux monotonicity applies with the other convective inputs fixed. Increasing sink must not raise a finite ceiling, and usable ceilings must remain within the thermal top and effective cloud cap. Analytic examples also test Lenschow roots, pressure estimates, vector winds and pressure-mass parcel mixing.

[Fixture provenance](../forecasts/soaring/fixtures/README.md) distinguishes original inventories and decoded weather fields from synthetic GRIB transport and generated expectations. To regenerate an expectation, retain the input identity and timestamps and inspect the numerical differences. Reconstructing an 84-hour RRFS point publication requires the source inputs for all of those hours.

Full-column replay and [issued-history scoring](../forecasts/verification/README.md) need different archives. Scoring can use the compact issued records, but a method-impact study needs all the original source levels and fields.

Performance work should start with repeatable measurements of rendering time, selection latency, transferred bytes and cache growth. The [verification guide](toolkit-verification.md) describes the existing checks and their scope.
