# T54 (terrain-edit wave) — `apply-dem-edits`: plane-fit / median-smooth / feather

**Status: built.** New pure module `pipeline/golfpipe/dem_edit.py` + CLI command
`golfpipe apply-dem-edits --input dem.tif --edits edits.geojson --out edited.tif`
replaying vector terrain edits onto a DEM per D-TE3/D-TE4/D-TE5. The raw input DEM is
never modified (D-TE2); the edited DEM is a derived artifact with the input's
profile/transform/nodata. This is the single replay step every DEM consumer
(tile-terrain, tile-hillshade in T56, the future Unity `.raw` exporter) goes through.

> **Numbering note:** the task id T54 in `docs/delegation-briefs-terrain-edit.md`
> collides with the already-committed T54 (clean-ortho, `1bc03816`,
> `docs/reports/T54-report.md`). This report is therefore named
> `T54-terrain-edit-report.md` instead of overwriting that file — see Deviations.

## Files touched

- `pipeline/golfpipe/dem_edit.py` — new pure module (loading/sorting, reprojection,
  plane fit, smooth, feather, replay engine)
- `pipeline/golfpipe/commands.py` — `cmd_apply_dem_edits` (I/O + profile hygiene),
  `shutil` + `dem_edit` imports
- `pipeline/golfpipe/__main__.py` — `apply-dem-edits` subparser, dispatch,
  `DemEditError` handling, docstring command list
- `pipeline/tests/test_dem_edit.py` — new offline test suite (15 tests, synthetic rasters)
- `docs/reports/T54-terrain-edit-report.md` — this report

## What was built

### `pipeline/golfpipe/dem_edit.py` (pure, offline-tested)

- **`load_edits(path)`** — parses the D-TE5 handoff: GeoJSON FeatureCollection, WGS84,
  per-feature `properties: { op, featherM, radiusM?, flat?, createdAt? }`. Defaults
  featherM 2, radiusM 2, flat false. Sorts defensively by `createdAt` (stable — the
  server writes pre-sorted; undated features keep file order, after dated ones).
  Malformed *files* raise `DemEditError` (CLI exit 1); malformed individual *features*
  (unknown op, non-polygon geometry, bad numbers) are skipped with a stdout warning —
  one bad polygon never crashes a build.
- **`reproject_edits(edits, dem_crs)`** — rings WGS84 → DEM CRS via
  `rasterio.warp.transform_geom`, per D-TE5.
- **`apply_edits(dem, transform, nodata, edits)`** — replays in order onto a float64
  working copy (D-TE4: each edit reads the running result of the previous ones, so
  overlaps are order-dependent but deterministic), returns float32. Masks rasterized
  with `rasterio.features.rasterize` (`all_touched=False`). All per-edit raster math
  runs on a mask-bbox window padded by max(feather, smooth radius) + 2 cells — masks
  are small, whole-raster filtering would be wasteful.
- **`plane`** — least-squares z = ax + by + c over valid in-mask cells, x/y in metres
  centered to keep the normal system conditioned, with two rounds of 2σ outlier
  rejection (a rejection pass that would leave < 16 samples is not taken); `flat: true`
  forces a = b = 0, c = post-rejection inlier mean. Degenerate masks (no cells, < 16
  valid cells, rank-deficient fit) skip the edit with a stdout warning.
- **`smooth`** — median filter with a circular footprint of radius `radiusM` converted
  to cells from the transform (minimum 1 cell, anisotropic-cell-aware), computed over
  the pre-this-edit heights; reads reach outside the mask so edges agree with the
  surroundings. Nodata-free windows take the fast `scipy.ndimage.median_filter` path;
  windows containing nodata fall back to `generic_filter` + `nanmedian` so the nodata
  value can't drag medians (all-nan neighborhoods pass through untouched).
- **Feather (both ops)** — w = clamp(dist_to_polygon_edge / featherM, 0, 1) via
  `distance_transform_edt` on the mask with cell-size `sampling=`; output =
  w·op + (1−w)·original; featherM 0 = hard edge. The band is *inside* the polygon
  (edt-on-mask), so cells outside the mask are always bit-identical. Nodata cells are
  excluded from fits and get zero feather weight; targets at w=0 are pinned to the
  original so pass-through cells come back bit-identical (no 0·nan poisoning).

### CLI / command

`cmd_apply_dem_edits` (commands.py, next to `cmd_grid_dem`) refuses `--out` == `--input`
(D-TE2), writes float32 with the input's profile/transform/nodata using the same
profile-copy hygiene as `_fill_interior_nodata` (drops blockxsize/blockysize/tiled),
prints applied-edit/changed-cell counts. **No edits / empty collection → byte-identical
copy of the input** (`shutil.copyfile`). Wired in `__main__.py` next to grid-dem;
`DemEditError` → stderr + exit 1.

Live smoke (not in pytest): 200×200-cell 0.5 m synthetic DEM, WGS84 edits file with an
overlapping flat plane + smooth — exit 0, 3,600 cells changed, pad σ 0.363 → 0.00001 m,
CRS/transform/nodata preserved, input bytes untouched.

## Tests

`cd pipeline && ./.venv/bin/python -m pytest -q` → verbatim summary line:

```
164 passed, 31 warnings in 2.41s
```

(149 baseline + 15 new, zero regressions, fully offline.) `tests/test_dem_edit.py`
covers everything the brief lists: plane on a noisy slope recovers the true plane
within 2 cm and 10 planted +3 m outliers don't tilt it; `flat` zeroes the gradient
(post-fit σ < 1e-4, value ≈ mask mean); median kills a single-cell +5 m spike while a
linear grade passes through unchanged (mask-edge endpoints exact); feather weight is
monotone from edge to interior along a transect, reaches exactly 1 in the deep
interior, and output == input everywhere outside the mask; nodata cells pass through
bit-identical while surrounding valid cells edit; empty edits file → byte-identical
output; order-dependence pinned (two overlapping `createdAt`-ordered flats differ per
order, each deterministic) and `load_edits` re-sorts a reversed file; degenerate masks
(< 16 cells, rank-deficient/collinear) and unknown ops warn + skip; full `main()` CLI
run with real WGS84 reprojection checks profile preservation and that the input file's
bytes never change; bad edits file exits 1.

## Deviations from the brief

- **Report filename / task-number collision.** The brief assigns T54 but T54 was
  already used by clean-ortho (committed `1bc03816` with `docs/reports/T54-report.md`).
  The commit message keeps the instructed `T54:` prefix; the report is written as
  `T54-terrain-edit-report.md` so the existing committed report is not destroyed.
  Recommend renumbering T55a/T55b/T56 (e.g. to T57+) before kickoff — those do not
  collide today, but the wave doc's numbering does.
- The brief's verified-2026-07-18 line refs had drifted as predicted:
  `cmd_grid_dem` is at commands.py:357 (docstring :364–367) and
  `_fill_interior_nodata` at :693–731 (not :356 / :608–614). Semantics matched;
  patterns followed from current code.

## Under-specified points and what was chosen

- **"Computed over the ORIGINAL heights" (smooth) vs. createdAt ordering.** Read as:
  each edit's op reads the heights as they were *before that edit* (the running result
  of earlier edits), not the pristine input — otherwise D-TE4's order-dependence for
  overlaps could not exist. "Original" contrasts with reading progressively-smoothed
  in-mask values during one filter pass. Pinned by the order-dependence test.
- **Feather band location.** `distance_transform_edt` *on the mask* yields distances
  for in-mask cells only, so the ramp lives inside the polygon (interior = full op,
  edge band → original). Cells outside the mask are always bit-identical — consistent
  with the brief's "output == input outside mask ∪ feather band" test (band ⊆ mask).
- **`flat` + rejection.** The plane fit (with rejection) runs first so cars/bushes are
  rejected by the fitted slope; `flat` then takes the inliers' mean. A rank-deficient
  fit skips the edit even when `flat` (brief: "rank-deficient → skip"); a mean would
  technically exist, but a mask degenerate enough to be rank-deficient (a line of
  cells) isn't a pad worth flattening silently.
- **Unknown op / bad params** = warn + skip (not a hard error), matching the
  "never crash a build over one bad polygon" posture; a *structurally* invalid edits
  file (not a FeatureCollection, unreadable) is a hard `DemEditError`.
- **Top-level format is strict**: only a FeatureCollection is accepted (D-TE5 names it
  exactly; the producer is our own server, so leniency would just hide T55/T56 bugs).

## Open concerns for the reviewer

- A concurrent session is building `apply-ortho-patches` in the same two shared files
  (`__main__.py`, `commands.py`). This commit stages only the T54 hunks of those files
  (index-level partial staging); their uncommitted work remains in the working tree.
- `generic_filter` + `nanmedian` (the nodata-window smooth path) is Python-callback
  slow, ~O(window × footprint). Fine for pad-sized masks at 0.5 m; if someone ever
  smooths a whole fairway that overlaps nodata, this is the knob to revisit.
- Rectangles/edits are assumed near-cell-aligned only in tests; the engine itself
  handles arbitrary polygons/MultiPolygons. Holes in polygons work via rasterize but
  have no dedicated test.
- T56 should pass the *enabled* edits pre-sorted (D-TE4) and can rely on the empty-file
  byte-identical guarantee to make "zero edits" a pure copy step — or skip the command
  entirely, as its brief already says.
