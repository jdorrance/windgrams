# New Zealand launches

[`new-zealand-launches.json`](new-zealand-launches.json) contains 143 published
takeoff locations across six browsing regions. It supplies names, coordinates,
time zones and source links to the shared launch importer. Club guides govern
current access and site procedures; this catalogue supplies forecast locations.

From the repository root:

```sh
node forecasts/scripts/import-flyingsites.mjs --country=nz
```

The import works offline and preserves existing edits. `FLYINGSITES_NZ` selects
another reviewed catalogue. Each record can override the catalogue's region and
time zone. These mainland records use `Pacific/Auckland`, including daylight
saving. Chatham Island records would use `Pacific/Chatham`.

## Source review

The [Paragliding Earth country API](https://paraglidingearth.com/api/geojson/getCountrySites.php?iso=nz&style=detailled)
returned HTTP 503 on 25 October 2026. The bundled
[`new-zealand-pge-source.json`](new-zealand-pge-source.json) preserves the 149-record
snapshot from [pg-flying-sites commit cb100dc](https://github.com/jdorrance/pg-flying-sites/blob/cb100dcdb7fffbcdb5431ca103b21956627cafb2/data/nz.geojson.json),
archived on 22 February 2026. Its retrieval date is unknown. The reviewed
catalogue records its byte count and SHA-256; tests verify both record coverage
and the snapshot hash. `checkedAt` dates the review, rather than the upstream data.

The review checked coordinate ranges, duplicate identities, source descriptions,
direction flags and these current guides:

- [NZHGPA](https://nzhgpa.org.nz/flying-in-nz/) and its [club directory](https://nzhgpa.org.nz/local-clubs/).
- [Auckland](https://www.cloudbase.org.nz/site-guide), including the closed-site list.
- [Bay of Plenty](https://bophgpg.org.nz/flying-sites/).
- [Tasman](https://thgpc.org.nz/index.php?page=sites).
- [Canterbury](https://www.chgpc.org.nz/flying-sites/).
- [Southern Club](https://southernclub.co.nz/visiting-pilots/).

Named club listings corroborate the established sites. Other published PGE
locations remain source-based; their takeoff positions and access await local
confirmation. NZHGPA intentionally leaves some sites unpublished. This inventory
covers the retained public source, with the exclusions below.

## Review decisions

- **Mauao / Mount Maunganui (15168):** excluded while the
  [council closure](https://www.tauranga.govt.nz/council/mauao-landslide/artmid/28899/articleid/12937)
  remains in force.
- **Long Bay North (14782):** excluded; the
  [Auckland club guide](https://www.cloudbase.org.nz/site-guide/site-cemetery/flying-site-long-bay)
  lists the park's launches as closed.
- **Ōpōtiki Airport (15928)** and **Auckland Gliding Club (20022):** excluded.
  The former is a winch-only development site; the latter lacks a documented
  foot launch.
- **Cascade Saddle — Pylon (11726, 14239):** withheld. The identically named
  records lie about 6 km apart and have no takeoff descriptions.
- **Barnicoat:** uses the [club's launch coordinate and NNW–NNE sector](https://www.thgpc.org.nz/index.php?page=barnicoat).
  The source snapshot retains the original point about 155 m north.
- **Nearby takeoffs:** Muriwai, Karioitahi and the two Glover Park records retain
  separate identities. Their source coordinates and descriptions identify
  different launch positions.

Display names receive spelling, capitalization and Māori diacritic corrections;
explicit slugs remain stable. Source heights retain an unknown vertical datum.
Forecasts use independently measured terrain. Contiguous compass flags provide
directions; separated faces and empty flags remain unknown. Wind-speed limits
remain empty. Old source airspace rules and access instructions stay in the
snapshot; launch notes point to current local guidance.

## Attribution

PGE records, this snapshot and their adaptations are © Paragliding Earth
contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/),
as stated on [Paragliding Earth](https://paraglidingearth.com/). Adaptations include
the exclusions, normalized names, regional grouping, direction arcs, brief notes
and Barnicoat correction. Preserve this attribution, licence and change notice
when redistributing the records. Club pages retain their own copyright; linked
facts and short summaries supplement the catalogue. Application code retains
the repository licence.
