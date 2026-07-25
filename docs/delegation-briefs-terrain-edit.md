# Delegation briefs — terrain edit: smooth/flatten the height map (T54–T56)

**Numbering collision (noted 2026-07-18 mid-wave):** clean-ortho independently took T54
(commit `1bc03816`, docs/reports/T54-report.md) before this wave kicked off. This wave's
commits keep their `T54:`/`T55a:`/`T55b:`/`T56:` prefixes; this wave's T54 report lives at
**docs/reports/T54-terrain-edit-report.md** to avoid overwriting. The next wave starts at
**T57**.

**Written 2026-07-18.** Goal: an editor tool to smooth/flatten DEM areas that lidar renders
noisy or wrong — parking lots and roads (car/vegetation spikes on hard surfaces), house
foundations (interpolated garbage under buildings), any pad that should have one even fall.
Edits are stored as **vector features replayed onto the DEM at build time** — never raster
mutations — so they survive lidar refetches and rebuilds, diff cleanly, and are undoable.

**Main use case (drives the architecture): a future Unity `.raw` heightmap exporter.** The
exporter does not exist yet; this wave prepares for it. Every DEM consumer — terrain-RGB
tiles, hillshade tiles, and the future `.raw` export — MUST go through the same edit-replay
step (`apply-dem-edits`, T54) so the smoothing/flattening transfers into the `.raw` file
identically to what the map shows. The raw `sources/dem.tif` stays pristine (single source
of truth = raw DEM + vector edits); edited DEMs are derived artifacts. Prior art for the
future exporter: `pipeline/gspro.py` already writes a square-extent 16-bit heightmap
(square-extent handling at gspro.py:80); Unity `.raw` is 16-bit little-endian, normalized to
a min/max height range, power-of-two-plus-one square resolution. **Not in this wave** — but
nothing in T54–T56 may bake edits into `sources/dem.tif`, or the exporter inherits a lie.

**Model tiers this wave** (retiered 2026-07-18 at kickoff: T55 split into T55a/T55b so the
pattern-following server half can run on Opus):

| Model   | Cost | Intelligence | Used for |
|---------|------|--------------|----------|
| Fable   | 2    | 9            | Numerical raster ops with real invariants (T54), novel draw-machinery integration (T55b), cross-system build integration (T56) |
| Opus    | 8    | 7            | Contained pattern-following server CRUD: migration + service + API + codegen (T55a) |

**Estimated agent cost** (units = size S:1 / M:2 / L:4 × model multiplier Fable:4 / Opus:1):

| Task | Title | Model | Size | Cost units |
|------|-------|-------|------|-----------|
| T54 | `apply-dem-edits`: plane-fit / median-smooth / feather | Fable | M | 8 |
| T55a | `terrain_edits` table + service + API (+ codegen) | Opus | M | 2 |
| T55b | Terrain-edit tool in the web editor | Fable | L | 16 |
| T56 | Build integration + fast re-terrain job | Fable | M | 8 |
| **Σ** | | | | **34** |

**Kickoff prompt (paste into a fresh session, fill in the task number):**

> Read task T\<n\> in docs/delegation-briefs-terrain-edit.md, then implement it.
> Follow the standing constraints and reporting protocol exactly: one commit starting `T<n>:`,
> write docs/reports/T\<n\>-report.md, do not spawn sub-agents, and stop when the report is
> written — no adjacent work.

**Standing constraints (all tasks):**
- House style per area AGENTS.md; colocated tests. Web tests from `web/` (`cd web && bun test`);
  server tests likewise colocated; respect the reactive-cascade gotcha (coalesce
  derived-geometry effects via `queueMicrotask`).
- Pipeline: pytest stays offline; raster tests use small synthetic in-memory/tmpdir GeoTIFFs
  (pattern: existing commands tests). numpy/rasterio/scipy only — no new deps without need.
- Verify every file:line reference against current code before relying on it — refs below
  were verified 2026-07-18 and drift.
- **No sub-agents.** Reporting protocol as in [delegation-briefs.md](delegation-briefs.md).

**Binding decisions (this wave):**
- **D-TE1** Edits are **site-scoped** (`site_id`), like all map data (site owns the map).
- **D-TE2** `sources/dem.tif` stays raw forever. Edits replay at consume time; the build
  materializes a scratch edited DEM and persists a copy as `sources/dem-edited.tif` (a cache,
  regenerable). Future `.raw` export reads via the same replay.
- **D-TE3** Two operations only in v1: `plane` (least-squares plane fit — the "even fall"
  case, optional dead-flat) and `smooth` (circular median filter — kills spikes without
  smearing grade). Both feather over an edge band so no curb-cliffs.
- **D-TE4** Edits apply in `created_at` order (overlaps are order-dependent; deterministic).
- **D-TE5** Handoff format server→pipeline: GeoJSON FeatureCollection, WGS84 coordinates,
  per-feature `properties: { op, featherM, radiusM?, flat? }`; pipeline reprojects rings to
  the DEM CRS via `rasterio.warp.transform_geom`.

## Sequencing

```
T54 (pipeline, Fable)   ─┐
                          ├─→ T56 (build integration, Fable; needs T54 + T55a/b)
T55a (server, Opus) ─→ T55b (web, Fable — needs the generated API client)
T54 ∥ T55a — no shared files. Future wave: Unity .raw exporter (consumes T54's output).
```

---

### T54 · `apply-dem-edits` — plane-fit / median-smooth / feather — **Fable**

New pure module `pipeline/golfpipe/dem_edit.py` + CLI command `apply-dem-edits --input dem.tif
--edits edits.geojson --out edited.tif` (wire in `pipeline/golfpipe/__main__.py` next to
grid-dem; command entry in `commands.py` following the `cmd_grid_dem` pattern, commands.py:356).
Input DEM is the grid-dem output: float32, EPSG:3006, 0.5 m cells, interior nodata already
filled + 3×3 median (see cmd_grid_dem docstring, commands.py:363–366) — but do not assume
nodata-free: cells may still be nodata; exclude them from fits and give them zero feather
weight. Edits file per **D-TE5**; reproject each ring to the DEM's CRS, rasterize to a mask
with `rasterio.features.rasterize` (all-touched=False), apply in `created_at` order (the
server writes features pre-sorted; also sort defensively by a `createdAt` property).

**`plane`**: least-squares plane z = ax + by + c over valid in-mask cells (x/y in metres,
centered to keep the normal system conditioned), with **two rounds of outlier rejection**
(drop residuals > 2σ, refit) so cars/bushes don't tilt the lot; `flat: true` forces a = b = 0
(c = post-rejection mean). Degenerate masks (< 16 valid cells, or rank-deficient) skip the
edit with a warning to stdout — never crash a build over one bad polygon.
**`smooth`**: median filter with a circular footprint of radius `radiusM` (default 2 m,
converted to cells from the raster transform, minimum 1 cell) computed over the ORIGINAL
heights (reads may reach outside the mask so edges agree with surroundings; use
`scipy.ndimage.median_filter` with a disk footprint, or `generic_filter` — but benchmark:
masks are small, whole-raster filtering is wasteful; filter a mask-bbox window only).
**Feather** (both ops): weight w = clamp(dist_to_polygon_edge / featherM, 0, 1) via
`scipy.ndimage.distance_transform_edt` on the mask (cell-size-aware `sampling=`), output =
w·op + (1−w)·original; `featherM` default 2, 0 = hard edge. Write float32 GeoTIFF, same
profile/transform/nodata as input (mirror the profile-copy hygiene in `_fill_interior_nodata`,
commands.py:608–614). No edits / empty collection → byte-identical copy of the input.

Tests (`pipeline/tests/`, offline, synthetic rasters): plane on a noisy synthetic slope
recovers a/b/c within tolerance and outliers don't tilt it; `flat` zeroes the gradient;
median kills a single-cell spike but preserves a linear grade (endpoints unchanged);
feather is monotone from edge to interior and output == input outside mask ∪ feather band;
nodata cells pass through untouched; empty edits file → identical output; order-dependence
pinned (two overlapping edits applied in `createdAt` order).

**Done:** command produces an edited GeoTIFF per the semantics above; raw input never
modified; pytest green offline.

### T55 · Terrain-edit tool: `terrain_edits` table + editor UI — **split T55a/T55b**

Executed as two tasks: **T55a (Opus)** = the **Server** paragraph below (commit `T55a:`,
report `docs/reports/T55a-report.md`); **T55b (Fable)** = the **Web** paragraph (commit
`T55b:`, report `docs/reports/T55b-report.md`, runs after T55a — needs the generated client).

**Server**: migration `server/db/migrations/012_terrain_edits.ts` — table `terrain_edits`
(id, site_id FK, op `'plane'|'smooth'`, params_json (featherM, radiusM?, flat?), rings_json
(EPSG:3006 straight-segment rings — mirror `course_features` geometry storage, schema.ts:135),
enabled (default 1), created_at, updated_at, version). Schema interface in
`server/db/schema.ts`, service `server/services/terrain-edits.service.ts` +
`server/api/terrain-edits.api.ts` with list-by-site / create / update / remove, following
the sites API shape (server/api/sites.api.ts:40) incl. version-conflict checks. Regenerate
`shared/api/*.gen.ts` per the existing codegen flow.

**Web**: a dedicated `TerrainEditToolService` owning its own `DrawState` instance
(web/src/draw/draw-state.ts) for polygon drafting — do **NOT** add a pseudo-type to
`FEATURE_TYPES` (web/src/draw/feature-palette.ts) or route through `features.create`; the
draw funnel to commit is your own: on `closeDraft` (state variant per DrawState; service
funnel precedent at web/src/draw/draw-tool.service.ts:1314) POST to the terrain-edits API
with the current op/params. Arm it as a tool via `EditorModeService`
(web/src/editor/editor-mode.service.ts:22 — armed-tool id doubles as interaction mode,
:31) with a command-bar entry next to the existing tool sections
(web/src/app/command-bar.component.ts). Render edit polygons as a distinct overlay on the
editor canvas (web/src/map/editor-canvas.component.ts) — dashed outline + op glyph, visually
unmistakable from course features; hidden outside the terrain tool. Panel (dock or popover,
reuse the collapsible-dock/popover primitives from the builder-v2 work): list of edits for
the site with op, params (featherM, radiusM, flat), enabled toggle, delete; and an **"Apply
to terrain"** button that is a stub until T56 (disabled with a tooltip, or hidden behind the
T56 wiring — leave one clearly-marked seam). Edits are site-scoped: resolve siteId the same
way the map-build UI does (web/src/map-build/map-build.service.ts).

Tests: server service CRUD + version conflicts (colocated, pattern of existing service
tests); web — draft→create payload mapping, enabled/delete flows, overlay visibility gating
(`cd web && bun test`).

**Done:** can draw a parking-lot polygon in the editor, pick plane/smooth + feather, see it
listed/toggleable/deletable, persisted site-scoped; `bun test` + server tests green.

### T56 · Build integration + fast re-terrain — **Fable**

**Full build**: in `MapBuildService.run` (server/services/map-build.service.ts:259), after
grid-dem persists `sources/dem.tif` (:299–301), export the site's enabled `terrain_edits`
(T55 service) as the **D-TE5** GeoJSON to `work/terrain-edits.geojson` (WGS84 — rings are
stored EPSG:3006, reproject server-side with the existing proj helpers or emit 3006 and
reproject pipeline-side; D-TE5 says WGS84, stick to it), run `apply-dem-edits` (T54) to
`work/dem-edited.tif`, persist a copy as `sources/dem-edited.tif` (**D-TE2**), and point the
existing `tile-terrain` (:323) and `tile-hillshade` (:326) invocations at the edited DEM.
Zero enabled edits → skip the step, use the raw DEM (identical behavior to today). Add the
step to `BUILD_STEPS`/`BuildStep` (:14–26) so the progress UI shows it — check the web
build-progress component tolerates the new step label.

**Fast re-terrain** (the editing loop — no lidar/ortho refetch): new job kind that requires
persisted `sources/dem.tif` (fail with an actionable message if missing), then runs only:
export edits → `apply-dem-edits` → `tile-terrain` → `tile-hillshade` → install of just those
two layers. `install` currently takes all layers (:329) — extend it (pipeline
`install.py`) so ortho/manifest are optional and existing installed layers are left
untouched; verify what `cmd_manifest` (commands.py:711) derives from the DEM/tiles before
deciding whether re-terrain must regenerate the manifest (terrain zooms 12/16 are unchanged
constants, :323 — if the manifest embeds no height-derived stats, leave it). Expose as an
API action + wire the T55 "Apply to terrain" button to it, reusing the map-build job
plumbing (job row, progress polling, build-progress UI) rather than inventing a second job
system — a new `kind` column or a step-subset flag on `map_build_jobs` (schema.ts:326),
your call, but reuse the runner seam so tests inject a fake runner as today.

Clients: web picks the new tiles up via the manifest/tileset flow
(web/src/map/tileset.service.ts:29–31) — verify tile URLs aren't cached stale (check server
cache headers for /tiles; bust via manifest revision if needed). iOS needs nothing: bundles
re-download via the existing course-list re-download menu.

Tests: service test with injected fake runner pinning the full-build arg chain now containing
apply-dem-edits with the edited-DEM path threaded into tile-terrain/tile-hillshade; zero-edits
skip; re-terrain job runs exactly the subset and fails cleanly without `sources/dem.tif`;
install partial-layer behavior (pipeline pytest).

**Done:** full build replays edits into terrain+hillshade tiles; "Apply to terrain" re-tiles
in one short job without refetching; raw `sources/dem.tif` untouched; server + pipeline + web
tests green.

---

## Future wave (not now): Unity `.raw` exporter — OPCD/GSPro recipe (verified 2026-07-18)

Reference material in `gspro-files/`: `LIDAR_TO_TERRAIN_FREE_PROCESS.pdf` (the OPCD manual
QGIS/CloudCompare workflow our pipeline replaces) and
`QGIS_Support_Files/QGIS 3.28.14 Folders/Heightmap/INNER/INNER-TIFtoRAW-Heightmap.bat`,
whose entire conversion is one GDAL call:

```
gdal_translate -of ENVI -ot UInt16 -scale MIN MAX 0 65535 -outsize 4097 4097 -r bilinear in.tif out.raw
```

So the exporter (`export-unity-raw`) replicates exactly that with rasterio/numpy — **input
MUST be the `apply-dem-edits` output** (or run the replay itself), never the raw DEM:

- **Plot**: clip the DEM to a SQUARE inner plot (side in whole metres — OPCD rounds to a
  5/10 m multiple; course perimeter + 50–75 m buffer). Square-extent prior art: gspro.py:80.
  OPCD also cuts an optional 2×-side "outer" plot at coarser res for background scenery —
  support via a `--outer-scale` flag, same code path.
- **Encoding**: bilinear-resample to **4097×4097** (Unity heightmap resolution 4097),
  normalize `[min, max] → [0, 65535]`, UInt16 **little-endian** ("Windows" byte order in
  Unity's import dialog), headerless — raw pixels only (the .bat writes ENVI/EHdr then
  deletes the `.hdr`/`.xml` sidecars; we just write the bytes). Keep rows **north-up**: the
  OPCD Unity import ticks **Flip Vertically**, so matching GDAL's native row order keeps our
  files drop-in compatible with their documented import settings.
- **Sidecar JSON** (replaces OPCD's hand-filled `MinMax.xlsx`): `minM`, `maxM` (pre-scale
  height range), `plotSizeM`, `resolution: 4097`, plus the Unity Terrain Settings they map
  to — Terrain Width/Length = `plotSizeM`, Terrain Height = `maxM − minM`, import settings
  (Bit 16 / 4097² / Windows byte order / Flip Vertically ✓). Import dialog reference:
  PDF p.23.
- **Overlay export** (same wave, optional): the persisted ortho GeoTIFF clipped to the same
  plot → 8192 px JPG q95 as the Unity terrain texture (OPCD's `TIFtoJPG.bat` equivalent) —
  we skip their Google/Bing XYZ screenshotting entirely since we have real orthos.
- **Class caveat**: OPCD's CloudCompare merge keeps lidar classes ground+water (and
  optionally roads 11 / bridges 17); our `grid-dem` uses `DEFAULT_CLASSES`
  (pipeline/golfpipe/grid_dem.py) — check whether bridges/roads classes matter for the
  target course before export, or expose `--classes` through to a dedicated export DEM.

Everything upstream of that one GDAL call in the PDF (CloudCompare merge/filter/rasterize,
QGIS clipping, CRS wrangling) is already covered natively by fetch-lidar → grid-dem →
apply-dem-edits. Scope the exporter together with whatever Unity-side tooling is wanted.
