# Changelog

## 0.1.0 (unreleased)

Initial version with thermal, lift-ceiling, cloud and wind diagnostics, plus postprocessing for point profiles and ensembles.

Diagnostic method 2.3.0 uses supplied model surface pressure in diagnostic
composition, retaining hypsometric estimation when absent. Point reconstruction
preserves that pressure and native model-level IDs. Support metadata records
native sampling geometry, thermal-depth branch, cloud-cap source and pressure
source. Invalid nonascending/duplicate parcel levels are rejected.

Experimental wind now places 10 m wind at model terrain + 10 m, records its
explicit launch-ground-elevation target and valid bracket, and excludes missing
or duplicate wind brackets and extrapolation. Calm direction remains unknown.
Published thermal/cloud MSL heights are unchanged by the wind experiment.

Diagnostic method 2.2.0 removes the near-neutral parcel-depth zero cliff and
interpolates upper-layer crossings without a lapse-rate epsilon. Missing heat
flux, pressure or layer depth now yields null W*, including the public
`computeThermalVelocityMps` return type. Dependent ceilings and buoyancy/shear
ratios preserve that absence; measured zero remains zero. The compatibility
parcel-depth helper also returns null when its required inputs are unavailable.
See [method changes and archived comparison](../../docs/refactor-plan.md).
