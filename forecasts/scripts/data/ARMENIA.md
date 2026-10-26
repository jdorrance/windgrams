# Armenian launches

The Armenian catalogue contains 40 published free-flight takeoffs: 33 from Paragliding Earth, six additional Sky Club locations, and Armaghan from the Gegharkunik tourism guide. It covers the sources reviewed on 24 October 2026; local takeoffs outside those sources may be absent.

The importer reads `armenia-launches.json`, whose stable slugs identify the same launches across forecasts and website metadata. `armenia-pge-source.json` keeps all 34 PGE candidate records, including the original values behind corrections and exclusions. Imported coordinates and time zones go into `forecasts/sites.json`; launch descriptions and source links go into `web/src/data/launches.json`.

## Sources and freshness

- [Paragliding Earth country API](https://paraglidingearth.com/api/geojson/getCountrySites.php?iso=am): 34 records retrieved on 20 October 2026 in the adjacent `skyjuice` project. The saved response is 23,584 bytes, with SHA-256 `c43f06d91ecf7483ecd239aebd58b20c3d6fa6202ca812924675bb30ea50b4ba`. Its IDs, coordinates, names, reported elevations and direction flags agree with the detailed `flyingsites/data/am.geojson.json` catalogue. The detailed catalogue also contains older descriptions and comments used for the Nor Ughi correction and paramotor exclusion; their retrieval date is unavailable. Both hashes are recorded in the source snapshot.
- [Sky Club Armenia](https://skyclub.am/paragliding-guided-tours/flying-sites/): checked the club's Aparan, Gutan, Hatis, Sevan, Teghenis and Vedi pages on 24 October. Coordinates and short factual site descriptions supplement PGE. The website gives no last-updated date for these pages.
- [Gegharkunik tourism guide](https://developmentprinciples.org/wp-content/uploads/2021/05/Gegharqunik_Guide_book.pdf): printed page 32 lists Armaghan's takeoff at 40.066 N, 45.2102 E. Checked 24 October. The guide cites PGE for the site list and is older than the retained API snapshot.
- The adjacent `skyjuice` OSM extract was compared for Hatis and Sevan. Its Hatis polygon centre and Sevan point corroborate nearby locations. The launch catalogue uses the named takeoff sources above; the OSM geometry remains in the separate extract.

Attempts to refresh PGE on 24 October returned HTTP 503 from the `.com`, `www` and `.earth` API endpoints, including the lightweight query. The catalogue therefore uses the saved response identified above. Source dates describe the age of the records; pilots still need current local information about access and takeoff position.

## Coordinate and duplicate decisions

- **Nor Ughi (`am-nor-ughi`, PGE 14321):** the raw GeoJSON point is 39 N, 44 E, outside Armenia. The same record's takeoff description gives 39°56′41.16″ N, 44°40′34.03″ E, which converts to the catalogue's 39.94476667 N, 44.67611944 E. The reported 2167 m elevation is kept in the source evidence.
- **Hatis 500 (`am-hatis-500`, PGE 9305):** the catalogue uses Sky Club's named 500-above-valley takeoff at 40.294048 N, 44.697437 E. PGE places it about 275 m southwest and reports 1495 m; Sky Club reports 1890 m. Both heights have an unspecified vertical datum, so launch-height calculations use independent terrain. Hatis 300 and Hatis summit are separate locations.
- **Ulgyur (`am-ulgyur`, PGE 12015):** the catalogue uses Sky Club's coordinate for this named takeoff, 39.823449 N, 45.215636 E, about 330 m east of the PGE coordinate. The snapshot preserves the original coordinate.
- **Lernaglukh and Aparan:** PGE 9744 and 11564 are about 450 m apart and have different wind directions, so both are included. Sky Club's Aparan point is about 92 m north of Lernaglukh and corroborates that ridge.
- **Sevan Upper and Tsovagyugh:** the two included takeoffs are about 630 m apart and have different published directions.
- **Gutansar and Gutansar Summit:** the PGE NE takeoff and the club summit area are about 570 m apart and are listed separately.
- **Teghenis and Teghenis Summit:** both source locations are included, about 1.7 km apart.
- **Vedi:** Shaghap, Lanjanist, Shaman, Xaraba and Ulgyur have distinct coordinates and individual records.
- **Lusashogh and Lusashogh 2:** both are included, about 540 m apart; the latter has a west-facing source direction.

The import removes exact-coordinate duplicates and keeps nearby takeoff faces as distinct locations.

## Exclusions and unresolved fields

- **Aragatsotn 2 (PGE 15652):** excluded from the foot-launch catalogue. The detailed source explicitly identifies it as a paramotor field. The source record remains in `armenia-pge-source.json`.
- **Wind limits:** Armenian speed and gust limits are `null` because the source weather descriptions do not establish launch-specific operating limits.
- **Directions:** 22 launches have `null` facing and arc. Empty PGE compass flags stay unknown. Teghenis Summit's disjoint north/south/west description and Gutansar Summit's all-direction mountain description cannot identify one launch face, so those also stay unknown. Available PGE flags and the club's contiguous compass sectors supply the remaining 18 directions.
- **Elevations:** source-reported altitude is stored as `sourceElevationM` with `elevationDatum: "unknown"` in the review data. PGE's API labels the field ambiguously, and Hatis and Nor Ughi have material inconsistencies. Calculations use the independently sampled terrain elevations in `site-context.json`.
- **Access:** listings describe published takeoffs. Current permissions, closures and local briefings remain with site operators.

## Attribution and licences

PGE-derived records, source snapshots and their adaptations are © Paragliding Earth contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), as stated in the [PGE API documentation](https://paraglidingearth.com/api/). Adaptations include name normalization, the Nor Ughi coordinate correction, source links, record reconciliation and concise notes. Preserve attribution, the licence link and this change notice when redistributing those records.

Sky Club and the tourism guide retain copyright in their descriptions and pages. This catalogue records attributed names, coordinates and brief factual summaries. Source objects distinguish these records from the PGE extract. Application code retains its repository licence.

## Reimport

From `forecasts/`, import the bundled Armenian records with:

```sh
node scripts/import-flyingsites.mjs --country=am
```

This import works offline. `--country=us` imports the selected US states from `FLYINGSITES_US` or the adjacent `flyingsites` catalogue. With no arguments, the command also imports the reviewed New Zealand catalogue.

Imports add new slugs and missing metadata while preserving existing field values, manual launch notes, coordinates, wind settings and other countries. Apply reviewed corrections and removals directly to the retained records. Set `FLYINGSITES_AM` to import another reviewed catalogue with the same schema.
