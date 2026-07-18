# Delegation briefs — create-draw speedups + auto-detect drafts (T38–T46)

**Written 2026-07-18.** Goal: make course creation dramatically faster — less per-shape
friction in the draw tool, plus auto-drafted features from lidar, national vector data, OSM,
and SAM segmentation. Full-auto CNN segmentation is deliberately deferred: every finished
course is a pixel-perfect labeled ortho, so training data accrues for free until then.

**Model tiers this wave** (Marcus's cost/intelligence register, higher = better):

| Model   | Cost | Intelligence | Used for |
|---------|------|--------------|----------|
| Fable   | 2    | 9            | Novel algorithms, cross-system integration, locked-spec work with real invariants (T40, T41, T43, T45, T46) |
| Opus    | 8    | 7            | Contained UX passes over existing patterns (T38, T39, T42, T44) |

*(2026-07-18: the three GPT-5.6 tasks — T41, T43, T46 — were retiered to Fable; spare Fable
budget available.)*

**Estimated agent cost** (units = task size S:1 / M:2 / L:4 × model multiplier Fable:4 /
Opus:1 — derived from the cost column above):

| Task | Title | Model | Size | Cost units |
|------|-------|-------|------|-----------|
| T38 | Sticky auto-continue | Opus | S | 1 |
| T39 | Keyboard type switching | Opus | S | 1 |
| T40 | Freehand trace → spline fit | Fable | L | 16 |
| T41 | Surround chains + merge | Fable | M | 8 |
| T42 | Stamp / duplicate-drag | Opus | M | 2 |
| T43 | Water + GeoJSON import wizard | Fable | L | 16 |
| T44 | OSM seed import | Opus | M | 2 |
| T45 | SAM click-to-feature | Fable | L | 16 |
| T46 | Lidar tree-canopy drafts | Fable | L | 16 |
| T47 | Lidar water drafts (class 9) | Fable | S | 4 |
| T48 | Hydrografi Direkt creeks + water | Fable | S | 4 |
| T49 | Feature provenance + ODbL posture | Fable | M | 8 |
| T50 | One-click water import (wizard fetch) | Fable | M | 8 |
| T51 | Keep lidar .laz; manual delete | Opus | M | 2 |
| **Σ** | | | | **104** |

**Kickoff prompt (paste into a fresh session, fill in the task number):**

> Read task T\<n\> in docs/delegation-briefs-create-draw.md, then implement it.
> Follow the standing constraints and reporting protocol exactly: one commit starting `T<n>:`,
> write docs/reports/T\<n\>-report.md, do not spawn sub-agents, and stop when the report is
> written — no adjacent work.

**Standing constraints (all tasks):**
- House style per area AGENTS.md; colocated tests. Run web tests from `web/`
  (`cd web && bun test`); respect the reactive-cascade gotcha (coalesce derived-geometry
  effects via `queueMicrotask`).
- Pipeline: pytest stays offline (HTTP behind seams, fixture responses); no GDAL dependency.
- Verify every file:line reference against current code before relying on it — this doc's
  refs were verified 2026-07-18 and drift.
- **No sub-agents.** Reporting protocol as in [delegation-briefs.md](delegation-briefs.md).
- **Wave-level open decision (flagged by T44):** durable provenance/attribution for imported
  features — `course_features` has no provenance column (schema.ts:135). OSM's ODbL
  (attribution + share-alike) must be resolved before any public distribution of OSM-derived
  course data. Until then provenance lives in the import GeoJSON only.

## Sequencing

```
Web lane (serial — T38–T42, T45 all touch draw-tool.service.ts):
  T38 → T39 → T42 → T40 → T41 → T45
                     └─ T40 blocks T45 (pure spline fitter is a hard dependency)

Pipeline lane (runs in parallel with the web lane):
  T43 → T44 → T46
   └─ T43's GeoJSON draft-import wizard is the import path for T44 + T46 output
      (their pipeline commands are otherwise independent)
```

Delivery priority for the auto-detect drafts (per Marcus): water (T43) → OSM (T44) →
SAM (T45) → trees (T46). CNN batch segmentation: later wave.

---

### T38 · Sticky auto-continue (chain-draw) — **Opus**

Closing a drawn ring drops back to select mode (`DrawState.closeDraft` `web/src/draw/draw-state.ts:130` calls `disarm()` :62), so drawing six bunkers means re-arming (N + type pick) six times. Make chain-draw **sticky by default — no toggle**: on successful close, clear `draft` and the mid-draw redo stack but stay in `'draw'` mode, so the next click starts the next shape of the same type (`drawType` lives on the service, `web/src/draw/draw-tool.service.ts:234`, and already persists across closes). Both close paths route through the service's `closeDraft()` :977 (click-near-start :498, Enter :898) — keep them and the `cursor.set(null)` untouched. Exits work unchanged because they all call `disarm`: Esc (`handleEscape` draw-state.ts:143 via `onEscape` service :461), 'B' box-select toggle (draw-state.ts:56), `deactivate` :445. The command-bar `newPoly` button (`web/src/app/command-bar.component.ts:603-612`) keys off `isDrawing` and correctly shows "Cancel drawing (Esc)" while armed-idle — no UI change. One interplay fix: while re-armed with an empty draft, Cmd+Z routes to the mid-draw stack and no-ops (service :877-887) — when `undoPoint()` returns null, fall through to committed `undo()` so the just-created feature is undoable without leaving chain mode (mirror Cmd+Y → `redo()` when `redoPoint()` returns false, :888). Tests (`web/tests/draw-state.test.ts`): rewrite 'closeDraft returns the ring and resets to select mode' :69 to assert draw mode retained + draft/redo cleared; add close → `addPoint` starts ring 2, and Esc-after-close exits.
**Done:** ring close re-arms same type; Esc/B/deactivate exit; Cmd+Z after a close undoes the created feature; web tests green.

### T39 · Keyboard feature-type switching — **Opus**

Web-only, small. Digit keys arm a draw feature type without opening the command-bar dropdown. Mapping (commit to this): digits follow panel order — `FEATURE_TYPES` (`web/src/draw/feature-palette.ts:5`, 15 types), `1`–`9` = tee…water, `0` = water_creek; the five rules/misc types (penalty_yellow, penalty_red, oob, path, outside) stay panel-only. Export the map as `DIGIT_FEATURE_TYPES` from feature-palette.ts so the panel and key handler share it.

Handle in `DrawToolService.onKeyDown` (`web/src/draw/draw-tool.service.ts:857`) — it already has the interaction-claim guard (`isMyClaim` :485) and the input/select/textarea guard (:859–864). Bare digits only: bail on `metaKey`/`ctrlKey`/`altKey` (⌘-1…9 is browser tab switching — never preventDefault there). Behavior mirrors the panel button exactly (`command-bar.component.ts:720`–`722`): selection non-empty → `retypeSelection(type)`, else `drawType.set(type)` — one behavior, keyed off selection, including mid-draw (no selection then, so it recolors the draft type). Conflicts checked: repo-wide grep shows no digit bindings anywhere; existing draw shortcuts are letters/Space/paging (`draw-tool.service.ts:871`–`936`); EditorModeService has no key handling; help-modal owns `?`/Escape only.

Surface it: digit badge on each mapped row in `buildFeaturePanel` (`command-bar.component.ts:703`, loop :706) and a Drawing help entry in `HELP` (`web/src/draw/draw-tool.ts:16`–`24`). Tests (`cd web && bun test`): mapping table pinned; keydown dispatch sets drawType, retypes when selected, ignores meta and inputs.

**Done:** digits switch/retype types; panel badges + help updated; web tests green.

### T40 · Freehand trace → spline fit — **Fable**

Add press-drag freehand tracing alongside click-to-place. Two parts.

**Pure fitter** — new `web/src/geo/spline-fit.ts`: `fitClosedBspline(stroke: Point[], toleranceM: number): { controls: Point[]; maxDeviation: number }`. Least-squares fit of a CLOSED uniform cubic b-spline (basis per `web/src/geo/bspline.ts:1-15`; chord-length parameterisation, wrap modulo n) with adaptive control count: start at 8, step up (8→12→16→20, cap 20) until maxDeviation ≤ toleranceM. Deviation = max distance from stroke samples to the fitted curve flattened via `flattenRing` (`web/src/geo/bezier.ts:99`) on a `curveType:'bspline'` ring. Pre-simplify the stroke with `rdpSimplify` (`web/src/draw/draw-state.ts:459`) at toleranceM/2 before fitting. All smooth controls — **no corner detection in v1** (T45 SAM click-assist reuses this fitter on raster-mask contours; keep it dependency-free, EPSG:3006 in/out).

**Interaction** — `web/src/draw/draw-tool.service.ts`: in draw mode `onMouseDown` currently bails (`:639`) leaving native dragPan. Change: while armed, left-mousedown does `preventDefault` + `dragPan.disable()` (marquee pattern `:653-658`) and samples pointermoves at ≥3 px screen spacing (converted via `lngLatToSweref99tm`). On mouseup, < 5 px total decays to a plain click — existing click-to-place, Shift-corner, and close-ring hit (`:497`, `CLOSE_RING_PX :93`) unchanged (cf. decay pattern `:762`). Pan while armed = middle-button escape hatch (comment `:704-709`). Fit with toleranceM = 0.75 (one named constant); ≥3 controls required, else discard. Commit through the `closeDraft` funnel (`:977`, state variant `:130`) → normal editable bspline feature, **one** history entry (`before: null`, `:988`). ESC mid-trace discards; live stroke preview via the draft overlay (`flattenOpenPath` path, `:1495` usage). Restore dragPan on mouseup/ESC/deactivate.

Tests (`web/tests/`, fitter colocated style per `draw-state.test.ts`): circle/ellipse/kidney synthetic strokes — returned `maxDeviation` ≤ tolerance AND matches independently recomputed deviation; control count in [8,20]; closed-ring correctness (no duplicate endpoint, flattened area ≈ stroke area); decay-to-click state test.

**Done:** drag traces a shape that lands as an editable ~8–20-control bspline; clicks behave exactly as before; fitter pure + exported; fit-quality and ring tests green.

### T41 · Surround chains + merged surrounds — **Fable**

Extend auto-surround (`autoSurroundSelection`, web/src/draw/draw-tool.service.ts:1095) two ways.

**Chain**: Shift-click on `surroundBtn` (web/src/draw/selection-panel.component.ts:272) walks `SURROUND_PAIRINGS` (web/src/draw/feature-palette.ts:106) to exhaustion — e.g. green → fairway(+0.5) → semi_rough(+1) → rough(+5) → deep_rough(+8) — each ring `offsetGeometry` (web/src/draw/draw-state.ts:608) of the *previous* ring by that step's `expandAmount`. Button label gains a "⇧ chain to Deep rough" hint via `selectionSurroundPairing` (draw-tool.service.ts:1129). If a step's offset returns null (collapse guard, draw-state.ts:586), stop the chain there, keep earlier rings. ONE history entry, selection = all new rings (mirror duplicateSelection:1066).

**Merge**: when ≥2 selected features share a `targetType`, produce ONE surround instead of N overlapping clones: flatten outlines via `flattenRing` (web/src/geo/bezier.ts:99), union with `polygon-clipping` (already a dep — web/package.json, pattern at shared/render/resolved-surface-stack.ts:1), offset each output ring with `offsetRingPoints` (draw-state.ts:562), rebuild as straight-segment `bezier` rings (corner anchors, no handles) run through `rdpSimplify` — do NOT depend on T40's bspline fitter. Union MultiPolygon → one feature per disjoint polygon; interior rings become holes. `holeId` = common source holeId, else null. Chain + merge compose (merge per ring level). No server/iOS changes.

Tests (web/tests/draw-surround.test.ts): chain emits correct type sequence/holeId in one history entry; two overlapping fairways yield one merged semi_rough; disjoint sources yield two; collapse mid-chain truncates cleanly.

**Done:** Shift-surround chains rings outward in one undo step; multi-select surrounds union into single merged rings; `bun test` green.

### T42 · Stamp: duplicate-drag + repeat placement — **Opus**

Web only, `web/src/draw/draw-tool.service.ts`. Modifier audit done — commit to **Alt**: alt-click cycles the hit stack (:514–531), alt+vertex-drag pulls handles (:678, checked before the body case), alt marquee = intersect (:768), but alt on the body-move path (:725–745) is unused, and meta is reserved as the pan escape hatch (:703–710). **Duplicate-drag:** alt+mousedown inside a selected feature starts a moveDrag-style gesture over *clones* — ghost via `dragGhost` (:579) with `translateGeometry` from source geometry (absolute dx/dy, no store reads mid-drag); a sub-threshold alt-drag must still decay to the alt-cycle click. On drop, `features.create({type, holeId, geometry})` (features.service.ts:248) per clone at the final translation, select clones, ONE history entry of create-diffs (`before: null`, `beforeVersion: null` — mirror `duplicateSelection` :1066–1086; `DUPLICATE_OFFSET_M` :100 and Cmd+D :892 stay as-is). **Repeat stamp:** after that drop enter stamp mode: mousedown on empty ground (currently marquee, :747–754) instead drags another copy anchored under the cursor; each drop creates + pushes its OWN history entry (one undo = one stamp, per history.ts's one-entry-per-user-action contract). Stamps inherit the source's `holeId`. Exit on Esc (insert ahead of marquee in the `onEscape` chain :460–481), tool deactivate, or arming a draw. Tests (colocated, `cd web && bun test`): clone translation correctness, stamp holeId inheritance, undo peels one stamp at a time then the original clone batch.
**Done:** alt-drag clones in one gesture; empty-ground drags stamp repeats until Esc; per-stamp undo; web tests green.

### T43 · Water from national vector data + GeoJSON draft-import wizard — **Fable**

Two parts; part 2 is shared plumbing reused by T44 (OSM) and T46 (lidar trees) — keep it strictly feature-source-agnostic.

**Pipeline.** New `fetch-water` command patterned on `cmd_fetch_ortho` (`pipeline/golfpipe/commands.py:92`) / `cmd_fetch_lidar` (`:145`), wired via the subparsers in `__main__.py:48`. Start with a short investigation: confirm which api.lantmateriet.se product serves Topografi 10 Nedladdning vector hydrography and whether the existing `LANTMATERIET_USER/PASS` basic-auth account has entitlement (STAC endpoints + download helpers: `pipeline/golfpipe/stac.py:23`, `:171`, `:212`); if the account lacks it, stop and flag in the report. Output one EPSG:3006 GeoJSON for a `--bbox`/`--aoi` area (aoi.py conventions): water polygons → `water`; watercourse lines buffered by `--creek-width` (metres, sane default) → `water_creek`; type in `properties.type`. Optional report-only cross-check against lidar class 9 (`grid_dem.py:36` `DEFAULT_CLASSES = (2, 9)`). Tests: fixture responses, HTTP behind a stac.py-style seam so pytest stays offline (per pipeline/AGENTS.md, no mocks elsewhere).

**Web wizard.** Mirror the SVG-import trio architecture exactly — read `web/src/import/svg-parse.ts` / `svg-import.service.ts` / `svg-import-panel.component.ts`: pure parse module + headless DI service (constructor takes the API client) + one panel component. Flow: pick `.geojson` → bucket by a chosen property → assign buckets to FEATURE_TYPES (`web/src/draw/feature-palette.ts:5`) or skip → map preview → accept bulk-creates against the `create` shape in `shared/api/course-features.gen.ts:41` (interactive analogue: `web/src/draw/features.service.ts:248`). Polygon/MultiPolygon rings (incl. holes) → bezier geometry as straight segments (corner anchors, no handles; cf. `subpathsToGeometries`, `svg-parse.ts:504`). Accept EPSG:3006 only; reject others clearly. No buffering in web — lines arrive pre-buffered. Tests per `web/tests/svg-import.service.test.ts` (fake `CourseFeaturesApi`): parse/mapping, geometry conversion, degenerate-ring warnings, partial-failure summary.

**Done:** `fetch-water` yields typed water GeoJSON for a real course bbox (or a documented entitlement flag); the wizard imports that file end-to-end into course features; pipeline + web tests green.

### T44 · OSM seed import — **Opus**

After T43 (its GeoJSON draft-import wizard is the sole consumer — no web UI here). New golfpipe command `fetch-osm` following the cmd_* split (logic in `pipeline/golfpipe/commands.py`, parsing in `__main__.py`; see `cmd_reproject_bbox` at commands.py:38 for the WGS84→EPSG:3006 path via rasterio — reuse `rasterio.warp.transform` for coordinates, no new geo deps, stdlib `json`+`urllib` for Overpass). Input: `--bbox` WGS84 (aoi.py conventions). Query Overpass for golf/terrain polygons; write a FeatureCollection of EPSG:3006 Polygons, each with a `type` property from the app's FEATURE_TYPES (web/src/draw/feature-palette.ts:5). Tag→type table: `golf=green`→green; `golf=tee`→tee; `golf=fairway`→fairway; `golf=bunker`→bunker; `golf=rough`→rough; `golf=water_hazard|lateral_water_hazard` and `natural=water`→water; `landuse=forest|natural=wood`→trees; anything else (incl. linear ways) skipped and logged. Assemble closed way rings and multipolygon relations: one Polygon per outer ring, inners as holes.

**Licensing — prominent:** OSM is ODbL: attribution + share-alike apply to derived databases. Every emitted feature carries provenance properties (`source:"osm"`, `osm_type`, `osm_id`, fetch date) plus a top-level `attribution` field; `CourseFeature` (server/services/course-features.service.ts:81, schema.ts:135) has no provenance column — do NOT add one; flag a wave-level decision on durable provenance/attribution before any public distribution.

Tests: tag-mapping units over fixture Overpass JSON (no network); ring closing; multipolygon-with-holes assembly; 3006 reprojection sanity.
**Done:** `fetch-osm` yields a wizard-importable GeoJSON for a real Swedish course fixture; pytest green.

### T45 · SAM click-to-feature assist — **Fable**

After T40 (hard dependency: the pure points→b-spline fitter — this task consumes it, never reimplements it). Click inside a bunker/green on the ortho → SAM segments → simplified contour → editable b-spline feature of the armed type.

**Prior art — port, don't rediscover.** Sidecar: `/Users/marcust/dev/SAM-test/server.py` works as-is — vendor it into `tools/sam-server/` (own `requirements.txt` + README; pipeline/ is the map pipeline, keep separate). Keep point mode, `MAX_INFERENCE_SIZE` 512, `mask_to_polygons` (cv2 findContours + approxPolyDP), `/segment`, `/health`, localhost CORS; drop text mode and the static mount. Weights (`sam3.pt`, 3.5 GB) are NOT committed — env-var path, README points at `/Users/marcust/dev/SAM-test/sam3.pt`. Client: port from `golf-map-2/webapp/frontend/src/editor/contourDetectionSAM3.ts` the crop→base64-JPEG→`/segment`→largest-polygon flow and health-gated init/retry; REDO its private RDP/dedupe using the repo's `rdpSimplify` (`web/src/draw/draw-state.ts:459`, epsilon in meters, post-CRS). SAM-only v1: skip the flood-fill/OpenCV fallbacks (`contourDetection.ts`/`contourDetectionCV.ts`) — health-gating (tool button disabled + hint while the sidecar is down) covers absence.

**Integration.** New `EditorTool` (`web/src/editor/tool.ts:100`): one import + one entry in `web/src/editor/tools/index.ts`, `panel` component with the armed-type picker (types from `web/src/draw/feature-palette.ts:5`; panel hosting is free — `web/src/draw/feature-dock.component.ts:274`). Pixel source: fetch ortho tiles directly at the manifest's ortho maxzoom via `tileUrlTemplate` (`web/src/map/map-style.ts:42`; mapKey/version from `TilesetService`) and compose a 512 px crop on an OffscreenCanvas centered on the click — never read the MapLibre canvas. Georeferencing is then exact slippy math: new pure `web/src/geo/webmercator-tiles.ts` (mirror iOS `WebMercatorTiles.swift` semantics), tile-pixel↔lng/lat, then `lngLatToSweref99tm` (`web/src/geo/transform.ts:151`). Pipeline: mask polygon px → EPSG:3006 → `rdpSimplify` (~0.4 m) → T40 fitter → `FeaturesService.create` (`web/src/draw/features.service.ts:248`) with `{crs:'EPSG:3006', curveType:'bspline'}` and the armed type; push one create diff (`before:null`, `web/src/draw/history.ts:40`) so ⌘Z works; create() selects it — immediately refinable in draw.

**Tests.** Tile-pixel↔EPSG:3006 round trip against a known control point; contour→simplify→fit round trip on a fixture mask (synthetic ellipse — area/point-count bounds); `/segment` contract test with a canned response (mocked fetch); health-gate state.

**Done:** click a bunker on a tiled course → armed-type b-spline feature appears, undoable, editable; sidecar vendored + documented; tool disabled cleanly when sidecar absent; web tests green.

### T46 · Lidar tree-canopy auto-draft — **Fable**

Pipeline-only: derive `trees` polygons from the classified COPC lidar `cmd_fetch_lidar` already downloads (`pipeline/golfpipe/commands.py:145`). New module `golfpipe/detect_trees.py` + subcommand `detect-trees` (wire in `__main__.py` next to `grid-dem`, `__main__.py:71`, dispatch ~`:203`; command fn in `commands.py` beside `cmd_grid_dem` at `:175`).

Method — nDSM, not class codes: Laserdata Skog typically does **not** classify vegetation; rely on height-above-ground of non-ground returns. Build (a) ground grid from `DEFAULT_CLASSES=(2, 9)` (`grid_dem.py:36`) via the existing `grid_lidar_points`/`build_dem_grid` path (`grid_dem.py:85`/`:150`); (b) surface grid = **max z per cell** over all returns except noise classes 7/18 — extend `grid_lidar_points` with a max-accumulator (`np.maximum.at`) or aggregation mode without disturbing the sum/count contract existing callers use. nDSM = surface − ground; threshold at `--min-height` (default 2.0 m); `scipy.ndimage` binary opening then closing (scipy already in `requirements.txt`) to kill noise and bridge adjacent crowns — closing is the dissolve, so 8-connected `rasterio.features.shapes` yields merged crown polygons directly. Then min-area filter (default ~25 m², flag) and simplify (~0.5 m tolerance) — add `shapely>=2,<3` to `requirements.txt` (pure wheels; the no-GDAL rule at `pipeline/AGENTS.md` is unaffected). Output: GeoJSON FeatureCollection, **EPSG:3006 coords**, each feature `properties: {"type": "trees"}` (`trees` is a real feature type — `server/services/course-features.service.ts:20`). Import into the editor goes via the T43 GeoJSON draft-import wizard (this doc) — no web UI here; the command is independent of T43.

Tests (`pipeline/tests/test_detect_trees.py`, synthetic LAS via the `_write_las` pattern in `test_grid_dem.py:18`): known canopy blob + below-threshold shrub + sub-min-area speck → exactly the expected polygons; interior clearing survives as a hole; output CRS/coords are 3006.

**Done:** `detect-trees` turns fetched COPC into importable `trees` GeoJSON; pytest green offline.

### T47 · Lidar water drafts from class 9 — **Fable**

*(Added 2026-07-18 after T43 landed: the account currently has NO Marktäcke vector
entitlement — Laserdata Skog lidar is the only live source. This derives draft water
polygons from the point cloud instead; `fetch-water` stays as-is for when the
entitlement is activated.)*

Pipeline-only. New `detect-water` command reusing T46's machinery (`detect_trees.py`
grid → morphology → `rasterio.features.shapes` → min-area → simplify → shared GeoJSON
writer — factor shared steps out rather than copy). Signal: per-cell PRESENCE of
class-9 points (`grid_lidar_points` count path with `classes=(9,)`), not height.
Water absorbs NIR so returns over open water are sparse — after thresholding presence
≥1 point/cell, apply generous binary closing (default ~3 m radius, flag-tunable) before
opening, then polygonize. `--min-area` default ~50 m² (ponds, not puddles). Optional
flatness sanity check per polygon (class-9 z-spread < ~0.3 m) to reject misclassified
noise — report-only, do not filter silently. Output `properties.type: "water"` in the
shared fetch-water/fetch-osm/detect-trees GeoJSON shape (EPSG:3006, legacy `crs`,
attribution). Known limitation, state it in the report: creeks rarely carry class-9
returns — `water_creek` is out of scope here. Tests (`pipeline/tests/test_detect_water.py`,
synthetic LAS per test_detect_trees.py's offset-safe `_write_las`): sparse-return pond
closes into one polygon; two ponds stay two; sub-min-area speck dropped; class-2-only
ground yields empty collection; CRS/shape of output.
**Done:** `detect-water` turns fetched COPC into importable `water` GeoJSON; pytest green offline.

### T48 · Hydrografi Direkt creeks + water — **Fable**

*(Added 2026-07-18 after the account gained "Hydrografi Direkt" — OGC API Features at
`https://api.lantmateriet.se/ogc-features/v1/hydrografi`. Live check confirmed Marktäcke
carries zero watercourse lines at Landeryd; this product is the authoritative creek source.
`fetch-water` (Marktäcke) and `detect-water` (lidar) remain as alternates.)*

Pipeline-only. New `fetch-hydro` command, same CLI shape as `fetch-water` (`--bbox`/`--aoi`,
`--out`, `--creek-width`). Start with a short LIVE investigation (basic-auth creds from .env):
GET the landing page + `/collections`, identify the watercourse-line and water-surface
collections and their supported CRS; confirm paging (`next` links) and `bbox`/`bbox-crs`
behavior. Then implement: fetch all items intersecting the bbox (paged), water surfaces →
`properties.type: "water"`, watercourse LINES buffered by `--creek-width` (default 2 m,
shapely) → `"water_creek"`, dissolve/union per type as fetch-water does, output the shared
GeoJSON contract (EPSG:3006, legacy `crs` member, attribution). Native GeoJSON in — no GPKG
parsing; reproject only if the API can't serve EPSG:3006 directly. HTTP behind the same
seam style as water.py/osm.py; pytest offline with fixture pages (including a multi-page
response). Live smoke against the Landeryd bbox in the report (expect the pond set fetch-water
found, plus creek ribbons if present).
**Done:** `fetch-hydro` yields wizard-importable water + water_creek GeoJSON for Landeryd; pytest green offline.

### T49 · Durable feature provenance + course-level ODbL posture — **Fable**

*(Added 2026-07-18, resolving the wave-level open decision flagged by T44.
**Decision (Marcus, binding):** OSM-derived features ARE allowed in published
courses. A course containing any ODbL feature becomes ODbL for its map data,
surfaced course-by-course with attribution — no publish blocking.)*

Scope as built: migration `011_feature_provenance.ts` adds nullable
`source`/`source_ref`/`license` TEXT columns to `course_features`;
`CourseFeaturesService.create()` accepts and rows expose
`source`/`sourceRef`/`license`; `geojsonByCourse` carries them in feature
properties and, when any feature has `license === 'ODbL'`, adds a top-level
`attribution` member ("© OpenStreetMap contributors, ODbL") to the
FeatureCollection so course bundles carry it (raw and resolved). Course
posture is DERIVED, never stored: `FeaturesService.hasOdblFeatures` (web)
drives an "ODbL map data" command-bar pill, an ODbL note in the publish
confirm dialog, and "© OpenStreetMap contributors" in the editor map's
status-bar attribution. The GeoJSON import wizard maps fetch-osm properties
(`source`/`osm_type`+`osm_id`→`sourceRef`) onto creates and defaults
`license` to 'ODbL' for `source: "osm"` when the file carries no license
property. iOS attribution display deferred (gap noted in the report).
**Done:** see docs/reports/T49-report.md.

### T50 · One-click water import in the web editor — **Fable**

*(Added 2026-07-18. **Decision (Marcus, binding):** the GeoJSON import wizard
keeps its file-pick variant AND gains a "Fetch from Lantmäteriet (water +
creeks)" variant that downloads, formats, and feeds the same
mapping/preview/accept flow — no manual file step.)*

Scope as built. **Server:** `HydroService` (server/services/hydro.service.ts)
+ descriptor `POST /course-features/fetch-hydro` (server/api/hydro.api.ts,
generated client shared/api/hydro.gen.ts) taking `courseId`. The WGS84 bbox
is derived server-side — course `georeference_json` `{bbox}` (EPSG:3006 →
WGS84) when present, else the site's tile_manifest asset `bounds` (site owns
the map), else a clear 409. Fetch semantics ported from
pipeline/golfpipe/hydro.py (T48): StandingWater + WatercoursePolygon as
water, WatercourseLine as creek centerlines, `crs=EPSG:3006` output with
(northing, easting) axis-order swap, `next`-link paging, EPSG:3006 bbox
clip (polygon-clipping for surfaces, Liang–Barsky for lines). Returns
PER-FEATURE water polygons + RAW centerlines with `suggestedCreekWidthM`
(2 m) and OGC-id sourceRefs — no union, so T49 provenance survives; creds
from server env with a repo-.env fallback; HTTP behind a fetchImpl seam
(offline tests incl. a multi-page fixture). **Web:** wizard section 1 is a
source picker (file input + fetch button);
`GeojsonImportService.fetchFromLantmateriet()` calls the endpoint, buffers
centerlines into ribbons via the new pure `bufferPolyline`
(web/src/geo/polyline-buffer.ts — open-line both-side offset, miter-clamped,
butt caps), and hands the synthesized EPSG:3006 FeatureCollection to the
EXISTING `loadGeojsonText` flow. Provenance per T49: `source
'lantmateriet-hydrografi'`, `source_ref` → `sourceRef`
(`provenanceFromProperties` extended), no license (matches hydro.py, which
emits attribution only). Also fixed in passing (found live on Vreta): both
import panels refreshed via `FeaturesService.reload()`, which no-ops when
the store never loaded — imports landed in the DB but rendered nothing;
panels now use the new `reloadOrLoad(courseId)`.
**Done:** see docs/reports/T50-report.md.

### T51 · Keep lidar .laz after builds; manual delete — **Opus**

*(Added 2026-07-18. **Decision (Marcus, binding):** .laz files are multi-use
assets — detect-trees, detect-water, future tooling — so map builds must stop
auto-deleting them. They are kept after the DEM build and deleted manually per
course, when done, via a "Delete lidar files" entry in the editor's ⋯ menu.)*

Scope as built. **Server:** `MapBuildService.run()` relocates the fetched
`.laz` from the ephemeral workdir into a persistent `data/sources/<siteId>/lidar/`
IMMEDIATELY after `fetch-lidar` succeeds (a cross-device-safe move — rename with
copy+unlink EXDEV fallback, overwriting same-named immutable Lantmäteriet tiles),
so they survive later-step failures; the workdir teardown no longer removes them.
New `lidarInfo(courseId)` (file names + total bytes, resolves course→site WITHOUT
minting a site) and `deleteLidar(courseId)` (rm the dir, returns freed bytes)
service methods, exposed as `GET /mapbuild/lidar` + `POST /mapbuild/lidar/delete`
in `map-build.api.ts` (regenerated `map-build.gen.ts`). **Web:** command-bar ⋯
menu gains "Delete lidar files (X.X GB)" next to Import GeoJSON — shown only when
`lidarInfo` reports files, with a danger-confirm naming the size and a
ConfirmService result notice (freed bytes / error). Added a `trash-2` icon and a
`formatBytes` helper. **Pipeline:** detect-trees/detect-water can now be pointed
at `data/sources/<mapKey>/lidar/` (no pipeline changes this task).
**Done:** see docs/reports/T51-report.md.
