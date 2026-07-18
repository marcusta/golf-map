# T46 report — Lidar tree-canopy auto-draft

## Summary

New `detect-trees` pipeline command: derives draft `trees` polygons from the
classified COPC lidar `fetch-lidar` already downloads. Laserdata Skog does not
classify vegetation, so class codes can't select trees — instead the command
builds an nDSM (height above ground): ground grid = mean z of the
`DEFAULT_CLASSES=(2, 9)` returns via the exact `grid_lidar_points` /
`build_dem_grid` path grid-dem uses; surface grid = **max z per cell** over
all returns except noise classes 7/18; nDSM = surface − ground. Cells ≥
`--min-height` (default 2.0 m) are canopy; `scipy.ndimage` binary opening
(noise kill) then closing (crown dissolve) cleans the mask; 8-connected
`rasterio.features.shapes` polygonizes it (interior clearings survive as
holes); a min-area filter (default 25 m², `--min-area`) and shapely
simplification (default 0.5 m, `--simplify`) finish the polygons. Output is
one EPSG:3006 GeoJSON FeatureCollection with the legacy `crs` member and
`properties.type: "trees"` — the shared fetch-water / fetch-osm convention the
T43 web draft-import wizard consumes unchanged. No web UI (per the brief);
the command is independent of T43.

## Design

- **Max-accumulator without disturbing the sum/count contract.**
  `grid_lidar_points` gained keyword-only `aggregate="sum"|"max"` (max via
  `np.maximum.at`, cells never hit hold `-inf` and are masked by
  `count_grid > 0`), `classes=None` = all classification codes, and
  `exclude_classes` (applied after `classes`, used for noise 7/18). The
  default path is behavior-identical: same accumulators, same return 4-tuple,
  same count/transform/ClassCounts semantics — all pre-existing grid-dem
  tests pass untouched.
- **Morphology = the dissolve.** Opening then closing with a 3×3 full-block
  structure (8-connected, matching `connectivity=8` polygonization): opening
  kills isolated canopy cells, closing bridges 1–2-cell gaps so adjacent
  crowns come out of `rasterio.features.shapes` as one merged polygon, holes
  ≥ 3 cells wide (real clearings) survive.
- **No new dependencies.** scipy, shapely, rasterio, laspy all already in
  `requirements.txt` (shapely landed with T43); no GDAL, fully offline —
  detect-trees itself touches no network at all (input is local files).

## Files touched

- `pipeline/golfpipe/detect_trees.py` (new) — `build_ndsm` (clamps negative
  heights, masks no-surface/no-ground cells to 0), `canopy_mask`
  (threshold + opening + closing), `mask_to_polygons` (8-connected shapes →
  shapely), `filter_and_simplify`, `build_trees_geojson` (reuses `water`'s
  `GEOJSON_CRS_3006`; `properties.source: "lidar-ndsm"`, top-level
  attribution `© Lantmäteriet, Laserdata Skog (CC0)`).
- `pipeline/golfpipe/grid_dem.py` — `grid_lidar_points` aggregation mode /
  class-exclusion extension described above (existing callers untouched).
- `pipeline/golfpipe/commands.py` — `cmd_detect_trees` beside `cmd_grid_dem`
  (ground grid → max-z surface → nDSM → morphology → polygonize → filter →
  GeoJSON, with point/cell/polygon diagnostics printed).
- `pipeline/golfpipe/__main__.py` — `detect-trees` subparser next to
  `grid-dem` (`--lidar`, `--bbox-3006`, `--resolution`, `--min-height`,
  `--min-area`, `--simplify`, `--out`), dispatch, docstring line.
- `pipeline/tests/test_detect_trees.py` (new) — synthetic-LAS scene at real
  SWEREF99 TM coordinates (canopy blob with 4×4 interior clearing +
  below-threshold shrub + sub-min-area speck + class-18 noise block) →
  exactly one `trees` feature with the clearing as a hole, area ≈ 128 m²,
  coords in 3006; max-aggregate/exclude-classes unit test (max beats mean,
  class 7 excluded, `-inf` unhit cells, diagnostics still complete);
  bad-aggregate ValueError; `build_ndsm` clamp/mask matrix; opening/closing
  behavior; CLI dispatch through `main()`.
- `docs/reports/T46-report.md` — this report.

No `pipeline/requirements.txt` change needed.

## Test results

`pipeline/.venv/bin/python -m pytest -q` (offline): **96 passed** (90 baseline
+ 6 new detect-trees tests). Existing `test_grid_dem.py` regression-checked
unmodified against the extended `grid_lidar_points`.

## Deviations / interpretations

- The LAS fixture helper computes header offsets from the data minimum
  (test_grid_dem's `_write_las` hardcodes offset 0, which overflows int32 for
  realistic ~6.47e6 m northings at 1 mm scale). Test-fixture-only change; the
  shared pattern is otherwise identical.
- The class-18 noise fixture block is deliberately larger than min-area
  (36 m²) so the test fails loudly if class exclusion ever breaks, rather
  than the noise being silently absorbed by the area filter.
- No real course run was made (pytest stays offline per the standing
  constraint); a live run is `fetch-lidar` → `detect-trees --lidar … 
  --bbox-3006 …` on the same box grid-dem uses.

## Real-data fix (addendum, same day)

The first real-data smoke (Landeryd half-tile, `m21c011-646_54.copc.laz`,
bbox-3006 `541140,6467550,543440,6469850`) exposed a bug the synthetic tests
missed: 1,697,094 raw canopy cells collapsed to 38,665 (15 polygons, ~9.7k m²)
— a ~98% kill on real forest. Root cause: Laserdata Skog is ~1–2 pts/m², so at
the 0.5 m default resolution ~30–40% of forest cells hold no surface return;
the thresholded mask is salt-and-pepper and running binary **opening first**
annihilates it (a 3×3 erosion needs a full 9-cell true neighborhood:
0.65⁹ ≈ 2% survival — matching the observed 2.3%). Fixed in a follow-up
commit:

- `canopy_mask` now runs **closing first** (bridge sampling holes, dissolve
  crowns), **then opening** (noise kill); doc comments updated.
- detect-trees' default `--resolution` is now **1.0 m**
  (`detect_trees.DEFAULT_RESOLUTION`; ≈1–2 pts per 1 m² cell) — grid-dem's
  own 0.5 m default is untouched.
- New regression tests: a sparse mask at 65% fill must survive morphology
  ≥85% consolidated (old order left 90/900 cells), and an end-to-end LAS
  fixture sampled at ~1.4 pts/m² (35% empty cells, deterministic seed) must
  yield ONE crown polygon of ≈484 m² — both fail on the opening-first order.

Re-run on the same real half-tile after the fix: **1,040,369 raw canopy
cells → 1,392,375 after morphology (~1.39 km², 26% of the 5.29 km² bbox);
2,651 polygons, 1,545 kept ≥ 25 m²** (961 at 25–100 m² — individual
crowns/clusters along fairways, 116 ≥ 1,000 m² forest blocks, largest
0.34 km²; 2,937 interior clearings preserved as holes). Note: total canopy
came out an order above the smoke's ~10⁵ m² guess — 26% cover is plausible
for this forest-ringed tile, and the raw (pre-morphology) count already sits
at 1.04×10⁶ m², so the mass is real returns ≥ 2 m, not morphology invention
(closing adds ~34% over raw, opening pulls edge dilation back).

Suite after fix: **105 passed** offline (the concurrently-built T47
detect-water + shared `detect_common.py` refactor landed in the working tree
meanwhile; its tests are included in that count and stay green — the fix was
applied on top of the refactored `canopy_mask` without breaking it).

## Working-tree caveat (for the reviewer)

Other active sessions have uncommitted changes in this tree (round-stimp work
in `server/`, `ios/`, `shared/`, `web/tests/round-sg.test.ts`,
`docs/reports/T35-report.md`, untracked migration `010_round_stimp.ts`) and a
T40 agent is working in `web/src/`. Those were left untouched; only T46's
files were staged explicitly by path.

The fix's code hunks landed via T47's commit `88281c77`, not a standalone
T46 commit: the concurrent detect-water session refactored the same three
files (`detect_common.py` extraction) and committed while this fix was
in flight in the shared working tree; its commit message explicitly notes
it "carries the entangled concurrent T46 follow-up in the same files
(closing-before-opening canopy mask, DEFAULT_RESOLUTION 1.0,
sparse-sampling regression test)". The `T46: fix` commit therefore
contains this report addendum only; blame for the canopy-mask fix points
at `88281c77`.
