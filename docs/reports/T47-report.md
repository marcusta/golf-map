# T47 report — Lidar water drafts from class 9

## Summary

New `detect-water` pipeline command: derives draft `water` polygons from the
classified COPC lidar `fetch-lidar` already downloads, as the stand-in while
the Marktäcke vector entitlement (fetch-water's source) is inactive. The
signal is per-cell PRESENCE of class-9 (water) points — `grid_lidar_points`
with `classes=(9,)`, count path, no height math. Water absorbs NIR so returns
over open water are sparse: after thresholding presence ≥ 1 point/cell, a
GENEROUS binary closing (default 3 m radius, `--closing-radius`, disk-shaped
structuring element) knits the scattered hits into contiguous bodies, then a
small 3×3 opening kills lone stray returns; 8-connected
`rasterio.features.shapes` polygonizes, min-area (default 50 m² —
ponds, not puddles; `--min-area`) and simplification (0.5 m, `--simplify`)
finish. A per-polygon flatness sanity check (spread of class-9 cell mean
heights > 0.3 m, `--flatness-spread`) is REPORT-ONLY: it prints a warning
with the polygon's centroid, never filters. Output is the shared
fetch-water / fetch-osm / detect-trees convention: EPSG:3006
FeatureCollection, legacy `crs` member, `properties.type: "water"`,
`properties.source: "lidar-class9"`, Laserdata Skog attribution — consumed
unchanged by the T43 web draft-import wizard. No web UI (per the brief).

**Known limitation (per the brief):** creeks rarely carry class-9 returns —
`water_creek` is explicitly out of scope; `fetch-water` stays as-is for when
the Marktäcke entitlement is activated.

## Design

- **Shared machinery factored, not copied.** The T46 steps that follow the
  mask — 8-connected polygonize, min-area filter, topology-preserving
  simplify, `_each_polygon`/`_polygon_coordinates`, and the typed
  FeatureCollection writer — moved from `detect_trees.py` into a new
  `detect_common.py` (`mask_to_polygons`, `filter_and_simplify`,
  `build_feature_collection`, `STRUCTURE_8`, `LASERDATA_ATTRIBUTION`).
  `detect_trees.py` re-exports the moved names and `build_trees_geojson`
  became a one-line wrapper, so detect-trees behavior, its public API, and
  its tests are untouched. Each detector owns only what its mask MEANS
  (nDSM threshold vs class-9 presence) and its morphology recipe.
- **Closing is the load-bearing step, and it's a disk.** Sparse returns mean
  the presence grid is scattered single cells; closing with a circular
  structuring element of radius `closing_radius_m / resolution` cells
  bridges gaps up to ~2× the radius without growing square corners. Opening
  runs AFTER closing (same lesson as the T46 closing-first follow-up: an
  opening on sparse input annihilates everything) and uses the small 3×3
  block, so only strays that closed into nothing die.
- **Flatness check reads the grids already in hand.** `flatness_spreads`
  rasterizes each kept polygon (`rasterio.features.geometry_mask`,
  `all_touched`) against the class-9 sum/count grids from the single
  gridding pass — no second file read — and reports max−min of the per-cell
  mean z. Report-only per the brief: `cmd_detect_water` prints
  `warning: … kept anyway`, nothing is dropped.
- **No new dependencies, fully offline.** numpy/scipy/rasterio/shapely/laspy
  all already in `requirements.txt`; the command reads local files only.

## Files touched

- `pipeline/golfpipe/detect_common.py` (new) — shared
  mask → polygons → filter/simplify → typed-GeoJSON machinery (see Design).
- `pipeline/golfpipe/detect_water.py` (new) — `WATER_CLASSES = (9,)`,
  `disk_structure`, `water_mask` (presence → generous closing → 3×3
  opening), `flatness_spreads` (report-only diagnostics),
  `build_water_geojson`; defaults 3 m closing / 50 m² min-area / 0.5 m
  simplify / 0.3 m flatness spread.
- `pipeline/golfpipe/detect_trees.py` — slimmed to nDSM + canopy mask +
  a `build_trees_geojson` wrapper; shared steps now imported from
  `detect_common` (public names re-exported unchanged).
- `pipeline/golfpipe/commands.py` — `cmd_detect_water` beside
  `cmd_detect_trees` (grid class-9 → mask → polygonize → filter → flatness
  warnings → GeoJSON, with point/cell/polygon diagnostics printed).
- `pipeline/golfpipe/__main__.py` — `detect-water` subparser next to
  `detect-trees` (`--lidar`, `--bbox-3006`, `--resolution`,
  `--closing-radius`, `--min-area`, `--simplify`, `--flatness-spread`,
  `--out`), dispatch, docstring line.
- `pipeline/tests/test_detect_water.py` (new) — synthetic-LAS scenes at real
  SWEREF99 TM coordinates (offset-safe `_write_las` per
  test_detect_trees.py): sparse pond (returns every 3rd cell) closes into
  ONE polygon; a second sparse pond > 2× closing radius away stays a
  SEPARATE polygon; a 16 m² class-9 speck survives morphology but is
  dropped by min-area; class-2-only ground yields an empty collection; a
  tilted "pond" (1 m z-ramp) triggers the printed flatness warning yet
  still appears in the output (report-only proven); CRS/attribution/
  type/source/coordinate-range assertions; `water_mask` unit tests
  (knitting, stray kill, sub-bridging radius → empty); disk structure
  shape; CLI dispatch through `main()`.
- `docs/reports/T47-report.md` — this report.

No `pipeline/requirements.txt` change needed.

## Test results

`pipeline/.venv/bin/python -m pytest -q` (offline): **103 passed** (96
baseline + 7 new detect-water tests; zero regressions). detect-trees tests
run against the refactored shared helpers unmodified by this task.

## Deviations / interpretations

- The brief's "binary closing … before opening, then polygonize" is
  implemented exactly; the opening uses the small 3×3 block (not the
  generous disk) so it only removes strays, never erodes the closed body's
  interior.
- Flatness uses the spread of per-cell MEAN class-9 z inside the polygon
  (from the sum/count grids of the single gridding pass) as the "class-9
  z-spread" — a per-point spread would need a second full file scan for a
  report-only diagnostic.
- Morphological closing scallops the outermost ring of sparse sample cells
  (they survive closing but the following opening trims lone boundary
  cells); the tests assert on the consolidated body, matching real
  behavior.
- This commit also carries a concurrent same-tree T46 follow-up that landed
  in the identical files while T47 was being built (detect-trees closing-
  before-opening fix + `detect_trees.DEFAULT_RESOLUTION = 1.0` + its
  sparse-sampling regression test). It was entangled with the
  `detect_common` refactor in `detect_trees.py`/`commands.py`/`__main__.py`
  and could not be staged separately; all 103 tests are green with both.
- No real course run was made (pytest stays offline per the standing
  constraint); a live run is `fetch-lidar` → `detect-water --lidar …
  --bbox-3006 …` on the same box grid-dem uses.

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp
work in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, untracked migration `010_round_stimp.ts`) and
a T41 agent is working in `web/src/draw/`. Those were left untouched; only
T47's pipeline files (plus the entangled T46 follow-up noted above) were
staged explicitly by path.
