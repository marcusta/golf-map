# T43 report — Water from national vector data + GeoJSON draft-import wizard

## Summary

Two parts. **Pipeline:** new `fetch-water` command that STAC-searches
Lantmäteriet's open vector catalog (`stac-vektor`, CC BY 4.0) for the
**Marktäcke** collection (Topografi 10 land cover, one zipped GeoPackage per
kommun), downloads + extracts, and writes one EPSG:3006 GeoJSON: water
polygons (objekttyp `Sjö`/`Anlagt vatten`/`Vattendragsyta`/`Hav`) →
`properties.type: "water"`, watercourse lines buffered by `--creek-width`
(default 2 m total) → `"water_creek"`. **Web:** a source-agnostic GeoJSON
draft-import wizard mirroring the SVG-import trio — pick `.geojson` →
bucket by a chosen property → assign buckets to feature types or skip →
dashed map preview → bulk-create. It is the import path for T44 (OSM) and
T46 (trees) output too.

## Entitlement finding (prominent)

Investigated live (read-only GETs, 2026-07-18):

- There is **no dedicated hydrography product** on the open vector catalog.
  `https://api.lantmateriet.se/stac-vektor/v1` serves six collections
  (kommun-lan-rike, fastighetsindelning, **marktacke**, ortnamn,
  belagenhetsadresser, byggnader); no `hydrografi` catalog exists at any
  probed endpoint, and no OGC API Features service for Topografi 10 is up.
  Marktäcke is the Topografi 10 land-cover layer and carries the water
  *surfaces*; watercourse *centerlines* live in the (non-open) Hydrografi
  theme — if the marktäcke GeoPackage carries no line layer, `fetch-water`
  simply emits no `water_creek` features and says so.
- **The account lacks download entitlement for Marktäcke.** Anonymous STAC
  search works, but `dl1.lantmateriet.se/mark/marktacke/marktacke_kn0580.zip`
  returns **403** with the repo's `LANTMATERIET_USER/PASS` basic auth (a
  ranged GET of a lidar COPC returned 206 with the same credentials, so the
  credentials themselves are fine). Same failure mode as the earlier
  Markhöjdmodell 403: the product must be activated for the account in
  Geotorget. **Action for Marcus:** activate "Marktäcke Nedladdning,
  vektor" (free, CC BY 4.0) in Geotorget; no code change needed after that.
- Per the brief's fallback, the GeoPackage reader is implemented against
  the documented format (GPKG = SQLite + GeoPackageBinary blobs) with
  offline fixtures; `cmd_fetch_water` maps a dl1 403 to a clear
  `WaterError` naming the Geotorget entitlement gap (test-pinned).

## Files touched

- `pipeline/golfpipe/stac.py` — `VEKTOR_STAC_URL`, `MARKTACKE_COLLECTION`,
  `search_marktacke()` (same anonymous-search/basic-auth-download seam).
- `pipeline/golfpipe/water.py` (new) — GeoPackageBinary parser (stdlib
  header parse + shapely WKB, no fiona/GDAL), zip→gpkg extraction with
  size-match skip, layer-agnostic `objekttyp` classification + bbox clip
  (rejects non-3006 srs), and GeoJSON building: water polygons unioned
  (kommun-split lakes merge) and exploded per disjoint polygon with holes;
  creek lines buffered width/2 per side and unioned so contiguous segments
  merge seamlessly. Output carries the legacy `crs` member
  (`urn:ogc:def:crs:EPSG::3006`) + CC BY attribution.
- `pipeline/golfpipe/commands.py` — `cmd_fetch_water` (search → download →
  extract → clip/classify → write), 403→`WaterError` mapping.
- `pipeline/golfpipe/__main__.py` — `fetch-water` subparser
  (`--bbox`/`--aoi`, `--workdir`, `--out`, `--creek-width`), dispatch,
  `WaterError` handling, docstring line.
- `pipeline/requirements.txt` — `shapely>=2,<3` (pure wheels bundling GEOS;
  the no-GDAL rule is unaffected — T46 planned to add it anyway).
- `pipeline/tests/test_fetch_water.py` (new) — synthetic GPKG built with
  sqlite3 + hand-encoded GPB blobs; GPB round-trip (±envelope, empty flag,
  bad magic), classify/clip/hole tests, wrong-srs rejection, buffer-area
  and union tests, zip extraction/skip, stubbed-session end-to-end (output
  CRS/coords/types + auth), 403 entitlement message, no-items exit,
  `search_marktacke` catalog/collection pinning.
- `web/src/import/geojson-parse.ts` (new) — pure parse module:
  structure+CRS validation (EPSG:3006 only — `crs` member checked when
  present; without it, lon/lat-degree-looking and out-of-range coordinates
  are rejected with clear messages), MultiPolygon explosion, non-polygon
  skips with notes, property-key discovery (`type` first),
  `bucketByProperty` (suggestions: exact FEATURE_TYPE match, then the
  svg-import `suggestType` name tokens — reused, not duplicated),
  `polygonToGeometry` (straight-segment bezier rings, corner anchors, no
  handles, GeoJSON closing vertex dropped, degenerate rings → warnings).
- `web/src/import/geojson-import.service.ts` (new) — headless DI wizard
  state mirroring `SvgImportService` (constructor takes the API client;
  reuses its exported `BucketAssignment`/`BuildResult`/`ImportSummary`
  types so wizard output is shape-identical). No georeference step —
  coordinates are already EPSG:3006. `setPropertyKey` re-bins and
  re-prefills assignments; `build()` carries parse-time skips into the
  warnings; `confirmImport()` is the same 6-way bulk-create with
  partial-failure summary.
- `web/src/import/geojson-import-panel.component.ts` (new) — right-docked
  wizard panel mirroring `SvgImportPanelComponent` (same overlay laws,
  dashed magenta preview via `svc.built`, overlay id
  `geojson-import-preview`), plus a "bucket by property" select; bucket
  swatches follow the assigned type's palette fill.
- `web/src/course-detail/course-detail.component.ts` — spawns the panel
  into `editorCanvas` (same registration as the SVG panel).
- `web/src/app/command-bar.component.ts` — "Import GeoJSON" entry in the ⋯
  actions menu (Create only, `course-import-geojson-btn`), calling
  `GeojsonImportService.openFor(course.id)`.
- `web/tests/geojson-parse.test.ts`,
  `web/tests/geojson-import.service.test.ts` (new) — mirror the svg-import
  test pair: CRS accept/reject matrix, bucketing/suggestions, geometry
  conversion incl. holes, degenerate-ring warnings, preview invalidation,
  bulk-create counts + partial-failure summary (fake `CourseFeaturesApi`).
- `docs/reports/T43-report.md` — this report.

## Test results

`pipeline/.venv/bin/python -m pytest` (offline): **80 passed** (69 before,
+11 fetch-water tests; the stubbed-session pattern matches
`test_stac_download.py` — no network anywhere).

`cd web && bun test`: **674 pass, 0 fail** (6636 expect() calls, 51 files;
+23 tests across the two new files). `bun run check:client` (tsc --noEmit)
passes clean.

## Deviations / interpretations

- **Product interpretation:** the brief says "Topografi 10 Nedladdning
  vector hydrography". The open catalog exposes no hydrography theme;
  Marktäcke (the Topografi 10 land-cover layer, CC BY 4.0) is the
  open-vector product that carries water surfaces, so `fetch-water` is
  built on it. Creek centerlines may be absent from the open product —
  the command reports this per-run instead of failing.
- The optional lidar class-9 cross-check was not implemented (brief marks
  it optional/report-only; class 9 in `DEFAULT_CLASSES` already folds water
  into the DEM path).
- Real end-to-end download could not be exercised (403 above); the command
  is verified against fixture GPKG/zip/STAC responses end-to-end, and every
  network call goes through the existing stac.py session seam.
- Wizard UI was not driven in a live browser (needs server+auth+course, and
  the preview pane can't run MapLibre); the panel mirrors the proven SVG
  panel line-for-line and all service/parse logic is test-covered.

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp
work in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, and an untracked migration
`010_round_stimp.ts`). Those were left untouched; only T43's files were
staged explicitly by path.
