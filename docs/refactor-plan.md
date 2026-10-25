# Numerical compatibility and known issues

Changes to the forecast implementation can alter results even when the equations appear unchanged. Constants, operation order, interpolation, missing values and rounding all matter. This page records the numerical behavior that needs care during maintenance, including the retained parcel-depth closure boundary.

For package layout and development commands, use the [toolkit guide](toolkit.md) and [public interfaces](toolkit-contracts.md). The scientific quantities themselves are described in [soaring diagnostics](forecast-improvement-plan.md).

## Method 2.2.0: parcel depth and missing inputs

Method 2.2.0 corrects two numerical behaviors without extending the empirical shallow-layer heating assumption through the upper column.

For first-level height z₁ above terrain, the surface-to-level temperature deficit relative to a dry parcel is D₁ = T₁ − (Tₛ − Γd z₁). Linear interpolation gives D(z) = D₁ z/z₁. The existing heat-flux closure supplies a nonnegative surface excess E. Its capped stopping depth is z₁ min(1, E/D₁). Evaluate the cap before division: if E > 0 and D₁ ≤ E, the parcel reaches z₁. Thus D₁ approaching zero from above cannot cause depth to collapse to zero. No epsilon is needed. Zero imposed excess retains zero shallow depth. The existing model-PBL fallback and its +1°C sensitivity rule are unchanged.

Between upper levels, interpolate the signed parcel-temperature excess directly. A positive excess b₀ followed by a nonpositive b₁ brackets the crossing at z₀ + (z₁ − z₀) b₀/(b₀ − b₁). This remains defined for near-neutral layers and stays within the bracket. The old lapse-rate tolerance could return the lower level prematurely.

For terrain 0 m, sensible heat flux 100 W/m², latent flux 0 and no PBL depth:

```text
Height:       1,000 m   2,000 m   3,000 m
Temperature:     10°C       0°C     −10°C

Surface       Method 2.1.0      Method 2.2.0
19.700°C          1,000 m           1,000 m
19.795°C              0 m           1,000 m
19.805°C          3,000 m           3,000 m
```

The first-level-to-upper-column jump remains a property of the retained closure: below the first-level crossing the heat/PBL estimate is capped there; once the unboosted dry parcel clears it, the resolved environmental column determines the top. The upper column in this example cools at 10°C/km, slightly faster than the 9.8°C/km dry adiabat. Removing this branch transition would require a different physical closure, not another denominator tolerance. [Analytic tests](../packages/soaring/test/convective-inputs.test.mjs) cover neutral limits, zero/negative/latent heating, PBL and no-PBL branches, sensitivity warming, crossing resampling and elevation-datum invariance.

Missing source heat flux, precipitation, cloud cover and sea-level pressure survive compatibility reconstruction as null. W* requires both flux components, known nonnegative depth and positive surface pressure; missing inputs return null rather than zero. The existing optional-dew-point dry-air approximation remains explicit in the public API. Dependent ceilings and buoyancy/shear ratio stay null; independent surface LCL, pressure-level wind and supported layer means remain available. Member aggregation excludes unavailable values and counts measured zeros. The diagnostic validator accepts supported nulls and rejects fabricated W* or dependent lift.

This does not broaden the pinned production `SiteForecast` source contract: its required surface heat-flux fields must still be numeric or supported ensemble values. Full publication validation rejects a point profile with missing source fluxes before the diagnostic guard. Nullable results are supported by the reusable column and compatibility APIs; they do not authorize publishing an incomplete legacy-provider product. Supporting such products would require an explicit source-contract upgrade.

### Archived comparison and rollout

The [recorded comparison](../forecasts/soaring/fixtures/method-2.2-impact.json) pins source hashes and method-2.1.0 diagnostic hashes from commit `54bd70f846776cceb24a382a2e01e79b729f56e4`. [Its regression test](../forecasts/soaring/method-impact.test.mjs) recomputes method 2.2.0 from the same inputs. No rounded scalar diagnostic changed in 14 native HRRR columns, one native RRFS column, or three native ICON columns. Reconstructing 84 already-rounded RRFS published hours also produced no changes. The method label is excluded from this comparison. The synthetic missing-flux fixture changes only W* and buoyancy/shear ratio from zero to null; its already-null lift ceilings remain null.

These 18 native samples and 84 reconstructed hours do not establish operational frequency or forecast skill. The full-input examples did not exercise the corrected threshold; analytic and injected-missing-input tests establish the changed behavior. No archived issued forecast was rewritten.

New products use method 2.2.0. Complete retained point source profiles can be reprocessed for the same initialization; the operator archives the prior issued revision and rebuilds diagnostics. Regional products must be rebuilt and validated under the new method before replacing active pointers. Current-method publication checks reject older diagnostic methods rather than silently relabeling them. See [delivery operations](../forecasts/docs/operations.md#pages-delivery) for rollout and retention.

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
