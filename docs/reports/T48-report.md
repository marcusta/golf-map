# T48 report — Hydrografi Direkt creeks + water

## Summary

New `fetch-hydro` pipeline command against Lantmäteriet **Hydrografi Direkt**
(OGC API Features, `https://api.lantmateriet.se/ogc-features/v1/hydrografi`,
basic-auth via the same `LANTMATERIET_USER`/`PASS` creds as fetch-lidar).
Same CLI shape as fetch-water (`--bbox`/`--aoi`, `--out`, `--creek-width`,
default 2 m). Three collections are consumed: `StandingWater` +
`WatercoursePolygon` surfaces → `properties.type: "water"`, and
`WatercourseLine` centerlines shapely-buffered to `--creek-width` total width
→ `"water_creek"`; each type is unioned and exploded into disjoint polygons
(holes preserved). Output is the shared contract (EPSG:3006
FeatureCollection, legacy `crs` member, `© Lantmäteriet, Hydrografi Direkt`
attribution, `properties.source: "lantmateriet-hydrografi"`), consumed
unchanged by the T43 web draft-import wizard. Native GeoJSON in — no GPKG
parsing, no reprojection of feature coordinates (the API serves EPSG:3006
directly).

**This is the authoritative creek source.** At Landeryd, Marktäcke
(fetch-water) carries 26 water polygons and ZERO watercourse lines;
Hydrografi Direkt carries the same water bodies **plus 9 centerlines → 7
creek ribbons (~1.9 km of creek)**. fetch-water and detect-water remain as
alternates.

## Live investigation (2026-07-18)

- `/collections` (anonymous) lists **13 collections**, all
  `storageCrs` EPSG:3006: Crossing, DamOrWeir, Falls, LandWaterBoundary,
  Lock, Rapids, ShorelineConstructionLine, ShorelineConstructionPoint,
  Sluice, **StandingWater**, **WatercourseLine**, **WatercoursePolygon**,
  Wetland. The three bolded ones are consumed; Wetland deliberately not
  (not water per the feature-type palette).
- `/items` requires basic auth (401 anonymously) — the landing page and
  collections list do not.
- Requesting `?crs=<EPSG:3006 URI>` returns coordinates in the OFFICIAL
  EPSG:3006 axis order — **(northing, easting)** — confirmed via the
  `Content-Crs` header and coordinate magnitudes. `_swap_axes` flips every
  position to the (easting, northing) order the rest of the pipeline uses.
- `bbox` is interpreted as CRS84 lon/lat by default — callers pass WGS84
  boxes per aoi.py conventions, so no `bbox-crs` parameter is needed.
- Paging is via `rel: next` links (no `numberMatched`); next hrefs carry
  the full query string, so params are sent on page 1 only.

## Live smoke — Landeryd

`python -m golfpipe fetch-hydro --bbox 15.702822,58.346924,15.742544,58.367358 --out landeryd-hydro.geojson`

| collection | features intersecting bbox | output |
| --- | --- | --- |
| StandingWater | 22 | — |
| WatercoursePolygon | 3 | — |
| WatercourseLine | 9 | — |
| → `water` | 25 clipped surfaces | **26 merged polygons, 171 273 m²** |
| → `water_creek` (2 m width) | 9 lines → 7 after clip/union | **7 ribbons, 3 857 m² ≈ 1 929 m of creek** |

The 26 `water` polygons exactly match fetch-water's Marktäcke count for the
same bbox — good cross-source validation — and the 7 creek ribbons are the
new data Marktäcke could not provide. All output geometries valid, bounds
(541115, 6467549)–(543465, 6469850) sit inside the reprojected bbox.

## Design

- **HTTP behind the session seam.** `fetch_collection_geometries` takes an
  optional `session` (anything with `.get`), same pattern as stac.py /
  water.py; tests pass a stub, production uses `requests`. Credentials come
  from `stac._credentials()` and are checked BEFORE any request.
- **Server-side bbox filter is intersects, so clip client-side.**
  `clip_geometries` intersects each geometry with the EPSG:3006 box and
  keeps only non-empty parts of the right dimension (a river crossing the
  course or a lake shore can extend kilometres beyond the request).
- **401/403 is an entitlement message, not a stack trace.** Raised as
  `HydroError` naming the Geotorget product ("Hydrografi Nedladdning,
  direkt"), since the landing page being anonymous makes this failure mode
  confusing otherwise.
- **Paging is capped.** `MAX_PAGES = 100` guards against a next-link loop;
  `DEFAULT_PAGE_LIMIT = 1000` keeps a course-sized bbox to one page per
  collection.
- **Union recipe identical to fetch-water.** Surfaces unioned (StandingWater
  and WatercoursePolygon overlap where a pond feeds a widened watercourse)
  then exploded via the shared `_each_polygon`/`_polygon_coordinates`
  helpers; lines buffered by `creek_width_m / 2` per side, unioned so
  contiguous network segments merge seamlessly.

## Files touched

- `pipeline/golfpipe/hydro.py` (new) — API constants, `_swap_axes`,
  `_next_link`, `fetch_collection_geometries` (paged, authed, axis-swapped),
  `clip_geometries`, `build_hydro_geojson`; live-investigation notes in the
  module docstring.
- `pipeline/golfpipe/commands.py` — `cmd_fetch_hydro` beside
  `cmd_fetch_water` (fetch 3 collections → reproject bbox → clip → build →
  `write_geojson`, with per-collection and per-type counts printed).
- `pipeline/golfpipe/__main__.py` — `fetch-hydro` subparser (`--bbox`/`--aoi`,
  `--out`, `--creek-width`), dispatch, `HydroError` handler, docstring line.
- `pipeline/tests/test_fetch_hydro.py` (new) — fully offline via stub
  session: axis-swap unit tests; paged fetch following a `rel: next` link
  (params only on page 1, auth on every call); missing-credentials raise
  before any request; 401 → Geotorget-naming `HydroError`; endless
  next-link loop aborts; null geometries skipped; clip
  drops-far/cuts-straddling/filters-by-kind; build (union, holes, CRS,
  attribution, ~2000 m² ribbon area for a 1 km line at 2 m width); and a
  `cmd_fetch_hydro` end-to-end over a multi-page stub asserting type counts
  and that the (northing, easting) service order never leaks into output.
- `docs/reports/T48-report.md` — this report.

No `pipeline/requirements.txt` change (requests + shapely already there).

## Test results

`pipeline/.venv/bin/python -m pytest -q` (offline): **115 passed** (105
baseline after T46+T47 landed + 10 new fetch-hydro tests; zero regressions).

## Deviations / interpretations

- Task handover: a previous agent was stopped mid-task with `hydro.py`,
  `test_fetch_hydro.py` and the commands/__main__ wiring already written but
  unverified against the tree T46/T47 had since landed in. The takeover
  found no conflicts (T47's `detect_common` refactor touched different
  code); the work was verified as-is — full suite green, live collections
  list re-confirmed, live Landeryd smoke run — rather than rewritten.
- `Wetland` exists in the service but is not fetched; the brief asks for
  watercourse lines + water surfaces only.
- "25 source → 26 merged" at Landeryd is not a bug: one fetched surface is
  a multi-part after clipping, and the union step explodes multiparts into
  one feature per disjoint polygon.
- `clip_geometries` drops degenerate intersection products (e.g. a line
  touching the bbox corner yielding a Point) by keeping only the matching
  geometry types — same dimensionality rule fetch-water's clipping applies.

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp
work in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, untracked migration `010_round_stimp.ts`) and
a T45 agent is working in `web/` + `tools/`. Those were left untouched; only
T48's pipeline files and this report were staged explicitly by path.
