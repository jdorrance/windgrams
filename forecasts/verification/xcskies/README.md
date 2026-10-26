# XC Skies PointCast evidence

This supplement decodes frozen PointCast responses for comparison with issued
Windgrams forecasts. XC Skies is another forecast, not an observation. The
original [WxToFly snapshot contract](../wxtofly/README.md) remains unchanged;
new captures and reports belong in a separate directory and reference the
original snapshot hash.

## Capture and reproduce

The browser's map click and **PointCast** action established these read-only
request shapes. These are observed application endpoints, not a promised public
API contract:

```text
GET https://n1.xcskies.com/pointinfo/{model}/{YYYYMMDD}/{HH}/00
    ?lat={latitude}&lon={longitude}&xcparam=xclift225&callback={jsonpName}
GET https://n1.xcskies.com/profile/{model}/{YYYYMMDD}/{HH}/00
    ?lat={latitude}&lon={longitude}&backdays=1
GET https://n1.xcskies.com/runtimes/all/{YYYYMMDDHH}/{hourCount}
    ?&callback=d3.jsonp.capture
```

The PointCast client derives the path date/hour from the current clock rounded
down to an hour. `backdays=1` adds the preceding day. The returned `epochs`
array owns actual valid times; neither the URL nor a successful HTTP response
guarantees requested coverage. Anonymous responses can have a full epoch axis
but truncated weather arrays. The decoder rejects that mismatch.

[`capture.mjs`](capture.mjs) owns response-only capture. `beginCapture` accepts
`{baseline, output, selectedAt}` where `selectedAt` is the explicit UTC request
anchor; omitted anchors use the current UTC hour. It creates an immutable plan
for the original 125-site publication: GFS everywhere, HRRR/RRFS at U.S. sites,
and ICON-EU at Armenian sites, totaling 335 location/model requests. These
geographic rules describe this publication's inventory, not arbitrary model
coverage polygons. A caller using its authorized browser session navigates to
each planned URL and supplies the JSON document text and verified final URL to
`recordResponse`. Authentication remains in the browser; no passwords, cookies,
request headers or account details are accepted or retained. `recordFailure`
accounts for unavailable products. `finishCapture` requires exactly one primary response or explicit failure per planned
request, verifies evidence hashes, and refuses to overwrite a completed snapshot.
Recording rejects requests outside the frozen plan and all writes after completion.

The store preserves JSON document text, not HTTP wire bytes or response headers.
Each record includes retrieval time, requested location/model, source URL,
SHA-256, array counts and valid-time range. Runtime metadata is captured around
collection and retained as **advertised routing context**, never silently
promoted to proven per-column initialization. Repeated response captures use a
non-primary role and remain evidence of changes during collection.

Reproduce the analysis entirely offline, from the repository root:

```sh
node forecasts/verification/xcskies/compare.mjs \
  --snapshot forecasts/.scientific-review/2026-10-25-xcskies
```

Use `--baseline DIR` when relocating the original evidence and `--output DIR`
for a separate reproduction. The baseline manifest hash must match. Outputs
are `report/report.json` and the standalone interactive `report/index.html`.
The 90 additional locations without frozen Windgrams profiles are inventory
only. The original 35 locations retain latest-live and issued-archive cohorts.

## Decoder boundary

[`parsePointcast`](schema.mjs) accepts parsed response JSON plus the requested
model, latitude, longitude and optional source URL. It returns UTC hours,
decoded profiles, provider height diagnostics, raw surface scalars and field
comparability metadata. Invalid, unavailable or truncated responses throw.
Every supplied temporal array must have exactly one column per epoch; each
matrix must be rectangular. Null and recognized missing sentinels remain
absent. Zero remains a value. Input data is never mutated.

The response supplies neither initialization time nor returned/native-cell
coordinates. Those values remain null. The client constructs the URL date/hour
from current wall-clock time rounded down to the hour; it is a request anchor,
not model initialization. Exact valid times can be compared, but equal model
names do not establish equal runs or lead times.

## Decoding evidence

The public renderer at
[`xcv3.5.8.js`](https://xcskies.com/static/xcv3.5.8.js?v=801af136533db6a7b8399aba1b86c514)
was frozen with SHA-256
`d2f37acfc5c508fd43a2f978ee3642b613c0d6c19466622c77cb3a20701962ac`.
The code is inspected as text, never executed. These named functions own the
evidence behind the decoder:

- `fetchNDayForecastCallback` divides the `u` and `v` matrices by 10 before
  deriving wind speed. `XC.unitApply` confirms the base wind unit is m/s.
- `NDayRoutePlot.prototype.drawContours` divides every contour matrix except
  `rhs` by 10, converting raw `-99990` to absence. `XC.unitsMapper`,
  `XC.unitApply` and `XC.pc.titles` identify temperatures as °C, velocities as
  m/s, humidity and cloud layers as percent, and the other parcel indices.
- `NDayRoutePlot.prototype.initdraw` constructs diagnostic heights as
  `minheight + index * ninterval`; wind heights use `level_interval`.
  Height traces multiply by the renderer's `hfactor = 10`. `dalrtops[][0]`
  is already in metres. Heights are absolute (MSL). Displayed `elevs` ground
  does not establish whether terrain is native-grid or terrain-adjusted.
- Surface arrays `tmp2m`, `u10m`, `v10m`, `wgust10m`, `cape`, `precip` and
  `sun` are preserved raw because this renderer does not establish their
  scalar encoding. Do not score them by guessing a scale from magnitude.

`POINTCAST_FIELDS` owns the exact decoded names, scales, units and scientific
qualifications. No second field mapping should silently override them.

## Comparison limits

Environmental temperature and wind components can be compared at exact UTC
times and matching MSL heights above both providers' ground. Use bracketed
interpolation only, without extrapolation, and do not turn absent upper-air
temperatures into surface values. PointCast levels are already sampled onto a
regular height grid; their presence does not prove native vertical resolution.

The `vels` field is parcel velocity, not W*. The `dps` field is parcel dew-point
depression, not environmental dew point. Provider help describes usable lift
as velocity approaching 1.2 m/s; it is not the Windgrams 1 m/s or 225 ft/min
(1.143 m/s) ceiling. Cloud-base help calls the level CCL, so it is not assumed
equivalent to surface or mixed-layer LCL. Boundary-layer tops, sensitivity and
cloud traces remain qualified provider diagnostics. Raw ground-coded ceiling
values are retained; they do not automatically become an observed no-lift event.

## Check

```sh
node --test forecasts/verification/xcskies/*.test.mjs
```

The offline tests cover truncation, matrix/time alignment, scaling, wind
vectors, missing versus zero, distinct vertical grids and unknown run identity.
Also run the [root checks](../../../README.md#development-checks) for integration.

`profiles.mjs` owns interpolation and normalized profile comparisons. `routing.mjs` owns change audits without treating advertised routing as verified initialization. `findings.mjs` owns interpretations; `compare.mjs` orchestrates the offline report.
