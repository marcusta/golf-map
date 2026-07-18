# T52 — Imported GeoJSON polygons land as smooth b-splines

**Model:** Fable · **Date:** 2026-07-18 · **Status:** done

**Feedback driving this (Marcus, Vreta pond screenshot):** (1) imported water
outlines look like pure polygons — they should be b-splines; (2) slightly
higher point density so the spline can follow the shoreline. T43's
straight-segment conversion was a deliberate stopgap to avoid a fitter
dependency; T40's `fitClosedBspline` supersedes that.

## What was built

### Fitter: optional `maxControls` cap (web/src/geo/spline-fit.ts)

- `fitClosedBspline(stroke, toleranceM, maxControls = 20)` — new optional
  third parameter. The default reproduces T40's exact 8 → 12 → 16 → 20
  adaptive ladder, so the freehand-trace (T40) and SAM (T45) callers are
  behaviorally unchanged (pinned by a byte-identical default-vs-explicit-20
  test plus the whole pre-existing T40/T45 suite).
- Above 20 the ladder turns geometric (×1.4, rounded up to a multiple of 4,
  always ending exactly at the cap): `controlLadder(256)` is 12 solves, not
  60 — the whole 21-polygon Vreta file fits in ~0.9 s.

### Import conversion: rings are fitted splines (web/src/import/geojson-parse.ts)

- `polygonToGeometry` now emits `curveType: 'bspline'` geometry: every ring
  — outer AND holes — is least-squares fitted through `fitClosedBspline`.
  Both wizard variants (file pick and the T50 Lantmäteriet fetch, whose
  `bufferPolyline` creek ribbons flow through the same `loadGeojsonText`
  path) get this for free, as do future fetch-osm / detect-trees /
  detect-water imports — intended per the brief. SVG import is untouched.
- **Tolerance `IMPORT_FIT_TOLERANCE_M = 1.5 m`** (vs the trace's 0.75 m):
  Hydrografi geometry is generalized — sparse, angular vertices sampled off
  a smooth shoreline — so the fit should smooth THROUGH the corners rather
  than reproduce them. At 0.75 m the fitter chases the corners (13/23 Vreta
  rings still over tolerance at cap, i.e. wasted controls); at 1.5 m all but
  cap-bound rings converge and the visual result is a soft shoreline that
  still tracks the source (numbers below).
- **Density: one control per `IMPORT_METERS_PER_CONTROL = 10 m` of ring
  perimeter, clamped to [8, 256]** (`importControlCap`, exported). The
  brief's suggested [8, 64] clamp fails on real data: the two long Vreta
  creek ribbons (2.3 km / 2.6 km perimeter, 2 m wide) deviate 4.2 m / 5.6 m
  at 64 controls — the ribbon visibly leaves its own bed. Deviation vs cap
  on those two ribbons (tol 1.5 m):

  | cap | #12 (2 345 m) | #16 (2 636 m) |
  |-----|--------------|--------------|
  | 64  | 4.22 m       | 5.64 m       |
  | 128 | 2.97 m       | 2.69 m       |
  | 192 | 1.84 m       | 1.90 m       |
  | 256 | 1.32 m       | 1.39 m       |

  ~10 m/control is where they hit their floor (~1 m = the half-width
  rounding of butt caps/sharp bends on a 2 m ribbon), hence 10 m/control and
  a 256 ceiling. 6–8 m/control bought nothing measurable over 10 on any
  Vreta ring; 12 m/control left 4 rings over tolerance.
- **Degenerate fallback — a feature is never dropped for fit reasons**: a
  ring whose fit is unusable (< 3 controls, i.e. < 3 distinct vertices
  after dedupe, or non-finite solver output) falls back to the
  straight-segment conversion expressed as all-corner b-spline controls
  (`corner: true` triplicates each control, and collinear window controls
  make every span a straight segment — exactly the source polygon). This
  keeps `curveType` geometry-consistent when one hole of a multi-ring
  polygon degenerates. Rings with < 3 vertices are dropped with a warning
  and a degenerate outer drops the polygon, exactly as before.

### Results on the real Vreta data (data/sources/88E5…AE/water-hydro.geojson)

Shipped constants, all 21 polygons (23 rings incl. 2 island holes), measured
both ways (source vertex → curve, and flattened curve → source polygon):

- **Ponds (12 polygons + 2 holes):** worst deviation 2.10 m (the cap-bound
  525 m pond #3), typical 1.2–1.5 m; e.g. the 46-vertex pond #0 → 56
  controls at 1.48 m, the 12-vertex pond #9 → 10 controls at 1.71 m.
- **Creek ribbons (9):** worst 1.83 m; the two long ribbons land at 1.72 m /
  1.39 m with 234 / 256 controls; curve → source stays at ~1.0 m — the
  intended rounding of the ribbon's square ends, the spline never leaves the
  bed.
- 1 643 source vertices → 1 050 controls; conversion of the whole file in
  ~0.9 s (synchronous in `build()`, i.e. on "Preview on map" — acceptable
  for a wizard step).
- Visual check (SVG overlay of source vs flattened fit): smooth shorelines
  through the angular source, no least-squares oscillation, corners rounded
  by ≤ ~2 m.

## Tests

`cd web && bun test`: **776 pass / 0 fail** (baseline 769, +7 new), both
typechecks clean (`check:client`, `check:test`).

- spline-fit: default cap byte-identical with explicit 20 (two strokes);
  raised cap converges (12-lobe stroke: > tol at 20, ≤ tol and 20 < n ≤ 64
  at cap 64, independently recomputed); control count never exceeds a
  sub-20 cap.
- geojson-parse: angular 12-gon pond → smooth bspline (no handles/corner
  flags) with every source vertex within 1.5 m of the flattened curve;
  holes fitted and preserved; `importControlCap` clamp table; a ~950 m
  wiggly shoreline gets > 20 controls while a small pond stays ≤ 20;
  unusable-fit ring falls back to exact all-corner controls (coordinates
  preserved, feature kept); degenerate hole/outer behavior unchanged.
- geojson-import.service: build test now asserts `curveType: 'bspline'`,
  hole preservation, and fitted controls near the source square.

## Notes / follow-ups

- Existing imported features are untouched — re-import (delete + fetch
  again) to get smooth shorelines on courses imported before T52.
- If a future import source is already smooth-and-dense (SAM masks come in
  via T45's own path, so not affected), 1.5 m may be looser than ideal;
  the constants are exported and trivially per-source-tunable.
