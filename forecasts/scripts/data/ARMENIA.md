# Armenian launches

Reviewed 24 October 2026. The catalogue contains 40 published free-flight launch points: 33 Paragliding Earth records, six additional Sky Club takeoffs and Armaghan from the Gegharkunik tourism guide. This is coverage of the reviewed public sources, rather than a claim that every takeoff in Armenia is documented.

`armenia-launches.json` is the reviewed import input. Slugs are explicit and stable. `armenia-pge-source.json` preserves all 34 PGE candidate records and the evidence behind corrections and exclusions. `forecasts/sites.json` contains coordinates and time zones; launch metadata and source links are in `web/src/data/launches.json`.

## Sources and freshness

- [Paragliding Earth country API](https://paraglidingearth.com/api/geojson/getCountrySites.php?iso=am): 34 records, retrieved 20 October 2026 in the adjacent `skyjuice` project. The retained response is 23,584 bytes, SHA-256 `c43f06d91ecf7483ecd239aebd58b20c3d6fa6202ca812924675bb30ea50b4ba`. Every ID, coordinate, name, reported elevation and direction flag agrees with the detailed `flyingsites/data/am.geojson.json` catalogue. Its older descriptions/comments supply the Nor Ughi correction and paramotor exclusion; their retrieval date is unavailable. The source snapshot records both hashes. Refresh attempts on 24 October returned HTTP 503 from the `.com`, `www` and `.earth` API endpoints, including the lightweight query.
- [Sky Club Armenia](https://skyclub.am/paragliding-guided-tours/flying-sites/): checked the club's Aparan, Gutan, Hatis, Sevan, Teghenis and Vedi pages on 24 October. Coordinates and short factual site descriptions supplement PGE. The website gives no last-updated date for these pages.
- [Gegharkunik tourism guide](https://developmentprinciples.org/wp-content/uploads/2021/05/Gegharqunik_Guide_book.pdf): printed page 32 lists Armaghan's takeoff at 40.066 N, 45.2102 E. Checked 24 October. The guide cites PGE for the site list and is older than the retained API snapshot.
- The adjacent `skyjuice` OSM extract was compared for Hatis and Sevan. Its Hatis polygon centre and Sevan point are nearby corroboration, not additional named takeoffs. OSM geometry was not copied into this catalogue.

Source dates describe catalogue freshness. They establish neither present access permission nor on-site survey accuracy.

## Coordinate and duplicate decisions

- **Nor Ughi (`am-nor-ughi`, PGE 14321):** the raw GeoJSON point is 39 N, 44 E, outside Armenia. The same record's takeoff description gives 39°56′41.16″ N, 44°40′34.03″ E. Converted to 39.94476667 N, 44.67611944 E. The claimed 2167 m elevation is retained only in source evidence.
- **Hatis 500 (`am-hatis-500`, PGE 9305):** use Sky Club's explicitly named 500-above-valley takeoff, 40.294048 N, 44.697437 E. PGE places it about 275 m southwest and reports 1495 m; Sky Club reports 1890 m. Both reported heights have an unspecified vertical datum. Neither becomes a launch-height reference. Hatis 300 and Hatis summit remain separate locations.
- **Ulgyur (`am-ulgyur`, PGE 12015):** use Sky Club's coordinate for this named takeoff, 39.823449 N, 45.215636 E, about 330 m east of the PGE coordinate. Original coordinates survive in the snapshot.
- **Lernaglukh and Aparan:** PGE 9744 and 11564 are about 450 m apart with different source wind directions. Keep both. Sky Club's Aparan point is about 92 m north of Lernaglukh and corroborates that ridge; it does not justify a third takeoff.
- **Sevan Upper and Tsovagyugh:** about 630 m apart, with different published directions. Keep both.
- **Gutansar and Gutansar Summit:** about 570 m apart. Keep the PGE NE takeoff and the club summit area separately.
- **Teghenis and Teghenis Summit:** about 1.7 km apart. Keep both source locations.
- **Vedi:** Shaghap, Lanjanist, Shaman, Xaraba and Ulgyur have distinct published coordinates. Retain them individually.
- **Lusashogh and Lusashogh 2:** about 540 m apart; the latter has a west-facing source direction. Keep both.

No exact-coordinate duplicates remain. Distance alone does not identify a duplicate on a mountain with several takeoff faces.

## Exclusions and unresolved fields

- **Aragatsotn 2 (PGE 15652):** excluded from the foot-launch catalogue. The detailed source explicitly identifies it as a paramotor field. The source record remains in `armenia-pge-source.json`.
- **Wind limits:** all new Armenian speed/gust limits are `null`. Source weather descriptions are observations, not established launch limits.
- **Directions:** 22 launches have `null` facing and arc. Empty PGE compass flags stay unknown. Teghenis Summit's disjoint north/south/west description and Gutansar Summit's all-direction mountain description cannot identify one launch face, so those also stay unknown. Available PGE flags and the club's contiguous compass sectors supply the remaining 18 directions.
- **Elevations:** source-reported altitude is retained as `sourceElevationM` with `elevationDatum: "unknown"` in review data only. PGE's API labels the field ambiguously, and Hatis/Nor Ughi have material inconsistencies. Independent terrain elevations belong in `site-context.json`; the import never turns catalogue altitude into MSL or AGL.
- **Access:** listings describe published takeoffs. Current permissions, closures and local briefings remain with site operators.

## Attribution and licences

PGE-derived records, source snapshots and their adaptations are © Paragliding Earth contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), as stated in the [PGE API documentation](https://paraglidingearth.com/api/). Adaptations include name normalization, the Nor Ughi coordinate correction, source links, record reconciliation and concise notes. Preserve attribution, the licence link and this change notice when redistributing those records.

Sky Club and the tourism guide retain copyright in their descriptions and pages. This catalogue records attributed names, coordinates and brief factual summaries; it does not reproduce their prose. Source objects distinguish these records from the PGE extract. Application code retains its repository licence.

## Reimport

From `forecasts/`, run `node scripts/import-flyingsites.mjs --country=am`. The reviewed source is bundled; sibling repositories and a network connection are unnecessary. `--country=us` refreshes the selected US states from `FLYINGSITES_US` or the adjacent `flyingsites` catalogue. With no arguments, both sources are merged.

Imports add new slugs and missing metadata. Existing field values, manual launch notes, coordinates, wind settings and other countries remain intact. To adopt a reviewed source correction for an existing slug, edit that retained record deliberately; a reimport never silently replaces it. Source removal also requires an explicit review and edit. `FLYINGSITES_AM` can select another reviewed catalogue with the same schema.
