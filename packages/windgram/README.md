# @windgrams/windgram

Render a forecast as a windgram: wind, temperature, clouds and usable lift over
time and height. Use SVG for reports, or mount an interactive chart in a browser.

Start with a validated forecast, such as one returned by
[`@windgrams/data-client`](../data-client/README.md):

```ts
import type { SiteForecast } from '@windgrams/contracts';
import { buildWindgramView } from '@windgrams/windgram/scene';
import { renderWindgramSvg } from '@windgrams/windgram/svg';

function chartSvg(profile: SiteForecast): string {
  const view = buildWindgramView(profile, {
    unitSystem: 'metric',
    timeZone: 'America/Los_Angeles',
    widthPx: 720,
    launch: { name: 'Blanchard', elevationM: 350 },
  });
  return renderWindgramSvg(view, { idPrefix: 'blanchard' });
}
```

The returned SVG includes its styles. Use a different `idPrefix` for every chart
in the same document. Keep the original view object when calling renderers or
inspection functions; copying its visible fields loses the internal scene data.

Single-day plots follow local daylight, retaining adjacent forecast samples for
interpolation. Polar dates keep their supplied hours.

## Interactive charts

Import `@windgrams/windgram/styles.css` once, then use
[`mountWindgram`](src/dom.ts) with an element, a view and a unique `idPrefix`.
The returned handle lets you select an hour, update the view and dispose of its
event listeners. Build a new view and call `update` when the forecast, units or
container width changes. Call `dispose` when removing the chart.

Pass a `readout` element to show inspected weather and `onSelectHour` to
synchronize other views. Inspection snaps to the published lift ceiling.
[`readWindgram`](src/scene.ts) also supports programmatic readings: its height
argument is metres MSL, missing measurements are `null`, and returned field
names specify their units. Readings keep those units when display units change.
The optional launch elevation supplies the AGL reference; otherwise the chart
uses model terrain.

[`/svg/external`](src/svg-external.ts) renders SVG using the shared stylesheet.
The SVG modules also render height axes, diagnostics, keys and wind barbs.
[`/format`](src/format.ts) provides unit conversions and labels, including
`gustNoun`, which names a gust reading by the document's declared
`semantics.gust` class and keeps the plain word when none is declared, while
[`/scene`](src/scene.ts) includes daylight filtering and height projection.
