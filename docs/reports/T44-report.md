# T44 report — OSM seed import

## Summary

New `fetch-osm` pipeline command: queries the Overpass API for OpenStreetMap
golf + land-cover polygons in a `--bbox`/`--aoi` (WGS84) area, reprojects to
EPSG:3006, and writes one GeoJSON `FeatureCollection` importable end-to-end by
T43's web GeoJSON draft-import wizard (same output convention as `fetch-water`:
legacy `crs` member + `properties.type` naming an app FEATURE_TYPE). Tag→type:
`golf=green/tee/fairway/bunker/rough` → same; `golf=water_hazard` /
`golf=lateral_water_hazard` and `natural=water` → `water`; `landuse=forest` /
`natural=wood` → `trees`; anything else (incl. linear ways) skipped and logged.
Closed ways become one Polygon; `type=multipolygon` relations become one
Polygon per outer ring with inner rings assembled as holes.

## Licensing (prominent)

OSM is **ODbL** (attribution + share-alike on derived databases). Per the
brief, provenance lives in the emitted GeoJSON only — **no schema column was
added**. Every feature carries `properties.source: "osm"`, `osm_type`
(`way`/`relation`), `osm_id`, and `fetched` (ISO date); the collection carries
a top-level `attribution` field
(`© OpenStreetMap contributors, ODbL (opendatacommons.org/licenses/odbl)`).

**Flagged wave-level decision (unchanged from the brief):** `CourseFeature`
(`server/services/course-features.service.ts:81`, `server/db/schema.ts:135`)
has no provenance column. Durable provenance/attribution must be resolved
before any public distribution of OSM-derived course data. Until then
provenance survives only in the import GeoJSON and is dropped at feature
create time.

## Design

- **HTTP behind one seam.** `golfpipe.osm.fetch_overpass(query, url=…)` is the
  only network touch (stdlib `json` + `urllib`, per the brief — not `requests`
  / `stac.py`). `cmd_fetch_osm` takes an injectable `overpass_fetch` (default
  `osm.fetch_overpass`) so pytest passes a stub returning fixture JSON —
  offline, matching the `fetch-water` seam style.
- **No new geo deps.** Coordinate reprojection reuses `rasterio.warp.transform`
  (4326→3006), injected into `osm.assemble_features` as a `reproject` callable
  so the `osm` module stays rasterio-free. Ring assembly / hole nesting uses
  `shapely` (already a dep from T43).
- **Overpass `out geom;`** inlines each way/relation member's coordinates, so
  no separate node-id resolution is needed. `stitch_rings` joins split
  multipolygon member ways (either direction) into closed rings; inner rings
  become holes of the outer ring whose interior covers them.

## Files touched

- `pipeline/golfpipe/osm.py` (new) — Overpass query builder, urllib fetch seam
  (`OsmError` on `URLError`), `classify_osm_tags`, ring/multipolygon assembly
  (`stitch_rings`, `assemble_features`), and `build_osm_geojson` (ODbL
  provenance per feature + top-level attribution). Reuses `water`'s
  `GEOJSON_CRS_3006` / `SWEREF99_TM_SRID` / `write_geojson` to avoid drift.
- `pipeline/golfpipe/commands.py` — `cmd_fetch_osm` (query → fetch → assemble →
  reproject → write, with per-type counts + skipped-element log).
- `pipeline/golfpipe/__main__.py` — `fetch-osm` subparser
  (`--bbox`/`--aoi`, `--out`, `--overpass-url`), dispatch, `OsmError` handling,
  docstring line.
- `pipeline/tests/test_fetch_osm.py` (new) — tag-mapping matrix; query bbox
  order + `out geom`; `stitch_rings` (split/reversed ways, dangling drop);
  closed-way→polygon w/ provenance + 3006 sanity; relation multipolygon
  keeps hole; skip/log of open classified way vs silent unclassified;
  GeoJSON CRS/attribution/provenance; stubbed-Overpass end-to-end (green +
  water-with-hole + forest → `green`/`trees`/`water`, all 3006);
  empty-result path; `fetch_overpass` URLError→`OsmError`.
- `docs/reports/T44-report.md` — this report.

No `pipeline/requirements.txt` change needed (rasterio + shapely already
present; Overpass uses stdlib only).

## Test results

`pipeline/.venv/bin/python -m pytest -q` (offline): **90 passed** (80 baseline
+ 10 new fetch-osm tests). No network anywhere — the Overpass call is stubbed
and reprojection is local rasterio.

## Deviations / interpretations

- No real end-to-end Overpass call was made (pytest stays offline per the
  standing constraint); the command is verified against fixture Overpass JSON
  end-to-end through the injectable seam. A live run needs only network — the
  default `--overpass-url` points at `overpass-api.de`.
- The output is written even when Overpass returns nothing (an unmapped course
  is a valid, non-error outcome — unlike `fetch-water`, which `SystemExit`s on
  no STAC items); the command prints a "no polygons found" note in that case.

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp work
in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, untracked migration `010_round_stimp.ts`) and a
T42 agent is working in `web/src/draw/`. Those were left untouched; only T44's
files were staged explicitly by path.
