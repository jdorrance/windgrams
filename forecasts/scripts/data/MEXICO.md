# Mexico launches

[`mexico-launches.json`](mexico-launches.json) contains 75 published takeoff
locations across 26 Mexican states. It supplies names, coordinates, explicit
local time zones and source links to the shared importer. These are forecast
locations; local pilots and operators govern current access and site procedures.

From the repository root:

```sh
node forecasts/scripts/import-flyingsites.mjs --country=mx
```

The import works offline and preserves existing edits. `FLYINGSITES_MX` selects
another reviewed catalogue. Each Mexican record supplies its own IANA time zone;
there is no country-wide zone fallback. The [operator guide](../../docs/operations.md#launch-catalogue)
describes publication and forecast availability. Mexico has point forecasts and
ordinary launch markers, with no regional soaring grid.

## Source and geographic review

[`mexico-pge-source.json`](mexico-pge-source.json) preserves the exact 84-record
Paragliding Earth snapshot in [pg-flying-sites commit cb100dc](https://github.com/jdorrance/pg-flying-sites/blob/cb100dcdb7fffbcdb5431ca103b21956627cafb2/data/mx.geojson.json),
archived on 22 February 2026. Its upstream retrieval date is unknown. The reviewed
catalogue records its byte count and SHA-256; tests account for every source ID
once, either included or excluded. `checkedAt` is the review date, not the source
data's age. The [country API](https://paraglidingearth.com/api/geojson/getCountrySites.php?iso=mx&style=detailled)
returned HTTP 503 when checked on 26 October 2026.

Review covered coordinate ranges, state boundaries, duplicate identities, source
descriptions, compass flags and the local sources below. The 2020 INEGI state
boundaries distributed by [geoBoundaries](https://www.geoboundaries.org/api/current/gbOpen/MEX/ADM1/)
were used for state labels; the exact download and hash are recorded in the
catalogue. Boca Paila Dune lies about 71 m outside that generalized shoreline and
Playa La Mancha less than 1 m outside; their coastal source points are retained,
not snapped to a boundary. Their exact takeoffs await local confirmation.

The reviewed simplified boundary assigns the Cantil/Vergel point to Jalisco and
the San Antonio de las Alazanas point to Nuevo León, rather than inferring their
states from the approach or namesake town. These points are only about 51 m and
102 m inside those boundaries; the source coordinates have limited precision.
Treat those browsing labels as geographic classifications awaiting local confirmation.

Time zones follow [IANA's Mexico definitions](https://data.iana.org/time-zones/tzdb/northamerica):
central Mexico, interior Nuevo León/Coahuila/Durango, interior Chihuahua, Sonora,
Baja California, Baja California Sur/Nayarit, Campeche and Quintana Roo use their
respective named zones. None of the retained Nayarit points is in Bahía de
Banderas, and none of the retained mainland northern points is in a border
municipality requiring a seasonal border zone. Tests cover fixed mainland time
and Baja California's seasonal change.

## Local corroboration

Checked on 26 October 2026; most pages give no publication date. This is targeted
documentary review, not exhaustive verification of current access or every
takeoff coordinate. Other retained locations remain explicitly source-based.

- **El Peñón and La Torre:** [Club Peñón](https://clubpenon.org/pages/club-rules),
  the [FLUMEN operator FAQ](https://www.parapentevalledebravo.com/experiencias/faq)
  and the [BHGC club guide](https://www.bhgc.org/sites/mexico/index.html)
  distinguish these launches. BHGC's La Torre point is close to the archive.
- **Gravedad Cero and La Ceja, Tapalpa:** the
  [Jalisco club catalogue](https://vuelolibrejalisco.com/despegues) supplies matching
  or nearby coordinates; [Parapente Jalisco](https://parapentejalisco.com/sitios-para-volar-parapente-jalisco.php)
  distinguishes La Ceja, and the [2026 event organizer](https://airtribune.com/srs-2026-6/info/details__organizer-2716)
  identifies Gravedad Cero. Keep both takeoffs, approximately 756 m apart.
- **La Salina:** the [operator](https://flylasalina.wordpress.com/) announced its
  October 2026 fly-in on 17 September 2026. This corroborates current operation,
  but does not independently verify the archived coordinate.
- **Tinaja and Nogalera:** [PAPANLAC](https://www.papanlac.com.mx/) lists takeoff
  coordinates within a metre of the archive. Its indexed page was readable;
  direct retrieval returned HTTP 502. Its conflicting Mirador/Rinconada entries
  are handled separately below.
- **La Cumbre:** the [local operator](https://parapentecolima.com/despegues.php)
  gives a takeoff coordinate about 4 m from the archive. Its southwest direction
  conflicts with the source's preferred southeast flag; direction remains unknown.

## Review decisions

Nine source records are withheld; machine-readable reasons and evidence links
are owned by the catalogue's `excluded` list.

- **Cantil de las Águilas / Vergel de la Sierra (11634, 15193):** retain 11634 as
  `mx-cantil-de-las-aguilas`; exclude 15193 as an alias. Points are 22 m apart and
  both descriptions identify the hotel grass launch. Size and orientation differ
  between the descriptions, so the direction remains unknown.
- **El Mirador (6797) and Rinconada (14249):** withhold pending local identity and
  closure clarification. PAPANLAC labels Mirador inactive but gives a coordinate
  near the archived Rinconada; its Rinconada section repeats Tinaja coordinates.
  The closure cannot safely be assigned to one of these source records.
- **Rayones (22993):** withhold because the club's takeoff coordinate is about
  2.25 km from the source. Hang-gliding foot launches remain in scope.
- **Cantamar (10722):** withhold because the source contributor explicitly lacked
  the GPS location, and an independent exact takeoff point was not established.
- **Cerro Pelón Alternate el Peñón (21435):** exclude as an apparent landing-area
  record, within 100 m of the BHGC guide's Cerro Pelón landing zone.
- **Lampazos (21436) and San Pedro (21437):** withhold these empty alternate-site
  records until their launch-versus-landing identity can be established.
- **Tulum (18116):** withhold for unresolved permission and takeoff location;
  the source itself questions permission and its position does not reconcile
  with the description near the ruins. It is not classified as known closed.

Other nearby points remain separate, including La Jolla / La Barreta and
Cuervitos / Cuervos. Source coordinates are unchanged. Display names receive
capitalization and Spanish diacritic corrections; explicit slugs remain stable.
Source elevations retain an unknown vertical datum and never become forecast
terrain. Contiguous, bounded compass flags supply direction arcs; broad or
conflicting flags, unresolved multiple faces, and missing directions remain null.
Speed and gust limits remain null. Historical operating advice stays in the
snapshot; launch notes link to local guidance or state the need for confirmation.

## Attribution

PGE records, this snapshot and their adaptations are © Paragliding Earth
contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), as
stated by [PGE](https://paraglidingearth.com/api/). Adaptations include exclusions,
duplicate reconciliation, normalized names, state and time-zone assignments,
direction arcs and concise notes. Preserve attribution, licence and this change
notice when redistributing the records. INEGI administrative boundaries were
consulted via geoBoundaries under CC BY 3.0 IGO; geometry is not redistributed
here. Club and operator pages retain their own copyrights. Application code
retains the repository licence.
