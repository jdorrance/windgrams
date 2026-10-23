# Website

Astro builds the static launch, regional soaring and About pages. Node 24 and pnpm 10.28.0 are the development toolchain.

## Run and preview

`pnpm dev` serves `../forecasts/data` at `/data`. Build that dataset using the [repository commands](../README.md).

`pnpm preview` builds the site, links the complete local dataset into `dist/data`, and starts Astro's preview server. Launch profiles, regional bundles and optional sunlight tiles share that link.

For the GitHub Pages path:

```sh
WINDGRAMS_BASE=/windgrams pnpm preview --host 127.0.0.1 --port 4323
```

`pnpm build` creates the production site. The Pages workflow adds the published forecast documents and excludes the larger history and sunlight trees.

## Display conventions

- Imperial is the default. The header setting persists in browser storage, with session storage and a `units` URL parameter as fallbacks. Switching units reloads the current page while retaining model, day, time and location parameters.
- Imperial uses ft, mi, °F, mph, ft/min, in or in/h, and inHg. Metric uses m, km, °C, km/h, m/s, mm or mm/h, and hPa. Lapse-rate labels use °F per 1,000 ft or °C/km. Temperature differences scale without an absolute-temperature offset.
- Wind barbs use knots in Imperial (half/full/flag: 5/10/50 kt) and m/s in Metric (2.5/5/25 m/s). General wind-speed labels use mph or km/h.
- Source JSON and diagnostic contracts retain their physical units, including metres, kilometres, °C, m/s, mm and hPa. Shared formatters convert the display; calculations, thresholds and stored forecasts stay unchanged. Saved launch wind limits remain mph; admin forms convert metric edits on save and preserve unchanged values exactly.
- Verbatim NWS bulletins retain their original units. CAPE uses J/kg, solar radiation uses W/m² and smoke uses µg/m³ in both settings.
- Windgram colors and breakpoints follow [WxToFly](http://wxtofly.net/windgramexplain.html). The mobile chart fits the selected day's hours.
- Background color represents lapse rate. White crosshatching marks RH above 94%; outlined clouds mark potential LCL.
- Paragliders use published `hcritWxtoflyM` at 225 ft/min sink. The blue line uses `usableLiftTopV2M` at 1 m/s. A missing 225 ft/min diagnostic leaves that symbol empty.
- Heights are MSL. Model terrain and catalogue launch elevation have separate references. Balloon times include local zone and UTC cycle.
- `published-lift.ts` selects the published diagnostic family. The same values drive the regional views, windgram and model sounding.

## Checks

```sh
pnpm test
pnpm check
pnpm build
```

`pnpm run dev-data` generates synthetic contract fixtures in `web/dev-data`; source attribution is in [dev-data-src/README.md](dev-data-src/README.md).

Station pages use the optional Worker at `/api/stations/<id>`. Its provider key stays in the Worker. GitHub Pages serves static weather data; station measurements depend on a connected API deployment.
