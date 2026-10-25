# Changelog

## 0.1.0 (unreleased)

Initial version with thermal, lift-ceiling, cloud and wind diagnostics, plus postprocessing for point profiles and ensembles.

Diagnostic method 2.2.0 removes the near-neutral parcel-depth zero cliff and
interpolates upper-layer crossings without a lapse-rate epsilon. Missing heat
flux, pressure or layer depth now yields null W*, including the public
`computeThermalVelocityMps` return type. Dependent ceilings and buoyancy/shear
ratios preserve that absence; measured zero remains zero. The compatibility
parcel-depth helper also returns null when its required inputs are unavailable.
See [method changes and archived comparison](../../docs/refactor-plan.md).
