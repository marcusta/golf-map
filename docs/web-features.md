# Web features (implementation notes)

Moved from web/AGENTS.md. Vegetation zones and roads/centerline notes live in [feature-vegetation-zones.md](feature-vegetation-zones.md) and [feature-roads-centerline.md](feature-roads-centerline.md).

## src/ layout

`app/` shell · `auth/` login+guard · `courses/` list · `sites/` (site setup page `/sites`, builder only: rename sites and courses, add a course on an existing site, detach, delete an empty site; `SitesService` also backs the new-course wizard's New site / Existing site step) · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `export/` (the GSPro dialog — seven tabs, each with its targets' rows (status + Update) and that area's single-file exports: SVG, inner/outer orthophoto JPEGs, inner/outer DEM GeoTIFFs over the two terrain squares, and GreenKeeper's .GKD into the course's GSPro folder; long explanations go behind `ui/info-tip.ts` (i) tips, only what the operator must act on stays in view — see below) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction; `tree-renderer.ts` is the three.js tree drawing shared with the vegetation scene) · `geo/` (bezier, bspline, transform) · `furniture/` · `vegetation/` (dev-only tree test scene) · `photos/` (reference photo browser, see below).

## Photos sub-mode (feature-reference-photos.md section 7)

`photos/` — browse and tag the site's reference photos from the iPhone capture
mode. A normal EditorTool (`photos`, not builder-only: the photo routes are
mounted in both modes). `PhotosService` holds the list (by the course's
`siteId`), the filter (hole, picked position + radius, tags any/all or
untagged), the List/Map view (localStorage) and the selection; tag/note/hole
saves are serialized and each computes its patch from the row the previous
save left. `photo-filter.ts` is the pure filter: "near hole" = the phone's
stored hole OR within `HOLE_NEAR_M` of the play line (tees → aim points → green
centre, from `FurnitureService`, which the tool loads itself). The dock hosts
`PhotosPanelComponent` (filters); `PhotoBrowserComponent`, spawned by
`CourseDetailComponent` into the editor canvas, draws the List catalog, the
Map view's photo card and the large viewer. `photos-overlay.ts` draws markers
and view wedges (dashed = heading not refined). Thumbnails are the 2048 px
previews, lazy-loaded; the server has no smaller size.

## Clean tool: PhotoCraft retouching on the pixels, image editor round trip

**Areas mode** (`clean/cleanup-areas.controller.ts`) draws and saves inclusion and protection polygons independently of photo edits. The effective preview and GeoJSON download both use `shared/cleanup-areas.ts`: union inclusions, then subtract all exclusions. Names, redraw, delete and session-local undo are available; drafts survive save errors. Boundary editing works without the assist sidecar. Server persistence is site-wide and versioned (`CleanupAreasService`, migration 027); operator steps and skill handoff are in [workflows.md](workflows.md#boundaries-for-ai-photo-cleanup).

The cleaned photo is one image per site on the server (`CleanedPhotoService`, [server-features.md](server-features.md)); operator steps in [workflows.md](workflows.md) section 6. The Clean tool edits its pixels directly: there is no queue and nothing to bake.

- **Pixel engine.** `clean/retouch-engine.ts` is the `RetouchEngine` interface and its worker-backed implementation; `clean/retouch.worker.ts` runs the wasm module in `clean/retouch-pkg/` (committed). The module is the crate `web/retouch-wasm`: a thin wrapper around PhotoCraft's engine (`D:\crafts\photocraft`, a path dependency) that holds the photo as a one-layer PhotoCraft document. Rebuild with `bun run retouch:build` (cwd `web/`; needs the PhotoCraft checkout, the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the version pinned in `Cargo.toml`); `cargo test` in the crate runs the tools natively.
- **Tools** (`CleanToolService.mode`): `clone` (`paint.cloneStamp`), `heal` (`paint.healingBrush`), `spot` (`paint.spotHealing`), `remove` (`paint.remove`), with PhotoCraft's own brush params in photo pixels (size in metres / the photo's metres per pixel). Clone and heal preview live (`begin` / `push` / `end`); spot and remove show a red band and run on release (`working`). `areas` is the cleanup boundaries below.
- **Loading.** On activation the worker fetches `GET /api/cleaned-photo/:courseId/pixels.rgb` (raw RGB, 201 MB) in strips into the engine (`photo`, `loadProgress`). `cleanedPhotoInfo` gives `bounds3006`, the square the pixels lie on.
- **Showing.** Every engine call returns the rectangle it changed with RGBA bytes whose alpha is 0 where the pixel equals the photo as loaded. `show()` puts them into canvas layers of 512 photo px (`clean/stamp-canvas-view.ts`, ids `clean-photo-<bx>-<by>`, below `features-fill`), so untouched ground stays the map's tiles.
- **Saving.** The same bytes go to `PUT /api/cleaned-photo/:courseId/pixels?x&y&w&h` (the `PixelSaver` seam), one request at a time, in order (`saveState`, `retrySave()`). The first save after a load adds `snapshot=1`: the server keeps the photo from before, so **Undo last session** (`undoLast`, `undoDepth`) steps back a whole session or an import and reloads the pixels.
- **Stroke undo.** Ctrl+Z / Ctrl+Shift+Z (`undoStroke` / `redoStroke`, `undoSteps` / `redoSteps`) step PhotoCraft's history; the restored rectangle is shown and saved like a stroke.

In the Clean panel (`clean/clean-panel.component.ts`), the rest of `CleanToolService`:

- **Download photo (PNG)** is a plain link (`exportUrl()`, `GET /api/cleaned-photo/:courseId/export.png`): no state, no request before the click.
- **Import a photo** (`importPhoto(file)`) goes through `PhotoImportClient` (`clean/clean-external.ts`), because `PUT /api/cleaned-photo/:courseId/import` is a raw route with no generated client and the upload needs progress (`XMLHttpRequest` behind the `UploadLike` seam, so tests need no network). It holds the tool's `applying` phase (`externalBusy` is `import`) and, on a change, loads the pixels again. `importSummaryText` (pure) makes the one-line result; a refusal (another pixel size, a stalled upload) shows the server's own message.
- **The push into Unity is not in this panel.** The command bar's **Update photo** runs the Photo target's whole chain (`GsproSyncService`, below); the panel keeps one hint line (`unity-apply-hint`) pointing at it. `CleanToolService` has no push of its own any more (its `applyInUnity()` and the `UnityOrthoApi` seam went with the button on 2026-10-14): the single file with options is the GSPro dialog's Photo tab → **→ Unity meshes** ([gspro/export.md](gspro/export.md)).

## The GSPro dialog: tabs of rows

`export/` (`GsproExportPanelComponent`, one instance spawned by `CourseDetailComponent`). The actions-menu row **GSPro…** (testid `course-export-gspro-btn`, with the stale count when known) opens it; the dialog keeps the testid `gspro-dialog` and its title is just **GSPro**.

- **Seven tabs, each sized to fit without scrolling** (Marcus wants logical tabs with a moderate amount in each, never one long scrolling board — the 2026-10-14 board that folded everything under "…" toggles was replaced the same day): **Terrain** (Terrain row; the two terrain squares; heightmap, → Unity, pull sculpt, hillshade), **Photo** (Photo row; photo settings, cleaning; orthophoto JPEGs, → Unity meshes), **Course** (Course shapes + Meshes rows; the SVG and the way into its test-variant panel; the shaping layers line), **Nature** (Vegetation, Trees, Creeks rows; zones, trees and creeks files), **Buildings** (Buildings + Props rows; building files; the props spec), **GreenKeeper** (Course file row; the GSPro course folder, Export GKD, the tee sets in GSPro) and **Course details** (name, location, designer, description, difficulty, keywords — written into the .GKD). Testids `gspro-tab-<tab>` / `gspro-pane-<tab>`; the active tab is kept while the page lives (Terrain first), and a tab with a stale, runnable row carries the caution dot (`gspro-export__tab-dot stale`).
- **A row per target**, at the top of its tab (testids `gspro-row-<id>`). Each row: a stale marker (theme `color-status-caution` / `-positive`, grey when blocked), the label with the target's one-line description behind its (i), the status line `gspro-status-<id>` — `2 h ago · 14 features changed (bunkers, paths, tees)` / `· up to date` / `never`, the absolute time in its title — and one primary **Update** (`gspro-update-<id>`, `POST /gspro-sync/update`, the last run's seconds as "about 40 s" in its title). The row's `note`, `manual` and `blocked` show under it in that order: `gspro-note-<id>` (the row's own extra state as the server words it — only **Props** has one, "3 hand-placed props are kept on update" / "no placed.json yet: the first update records the scene before placing"), `then: …` (`gspro-manual-<id>`), and the blocked reason with Update disabled (`gspro-blocked-<id>`).
- **The Buildings tab's Props group** names the spec (`docs/gspro/<course>/*-props.gen.py`) as the only permanent place for a hand move, with the long version — what `placed.json` keeps and what it does not — behind its (i).
- **The header** carries the export folder (still one folder for every row), **Update all stale** (`gspro-update-stale`, target `'stale'`, off when nothing is stale and runnable), the **Unity chip** (`Unity: vreta_v4_2025_12_02 · course Vreta`, else `Unity: not open for this course` with every editor that answered in its title) and the shaping worker in one word (`Blender: loaded`).
- **The update job** (`gspro-job`): one line (queued behind …, Updating …, Updated … in 39 s), the phase list and each finished target's report collapsed with the last one open. `JobPhasesComponent` (`export/job-phases.component.ts`) draws `JobPhase[]` the way the Terrain editor has always drawn a shaping job's — `✓ / … / ✗ / – / ·`, detail, seconds — and is the one place that drawing lives for new code (the terrain panel keeps its own copy).
- **`GsproSyncService`** (`export/gspro-sync.service.ts`, DI singleton, API client injected like `GsproExportService`): `status`, `job`, `running`, `staleCount`, `error`, `loading`, `tick`, `courseId`; `openFor(courseId)`, `close()`, `refresh(courseId)`, `update(courseId, target | 'stale')` (starts, polls `GET /gspro-sync/job` every 1.5 s through queued → running to the end, then refreshes; false on a refusal or a failed job), `target(id)`, `unityLabel()`, `unityTitle()`, `queuedBehind()`. It re-reads the board every 30 s while the dialog is open, since the edits that make a row stale happen in the other modes.
    - **`running` is derived** (a `Computed` over the start request and the job's status), so nothing can leave the board busy for the session — every Update button, the 30 s re-read and `update()` itself hang off it.
    - **The poll is hardened like the shaping one's** (`ShapingService.poll`, mirrored because the two loops share nothing but the retry): a failed poll is retried — the job runs on in the server — and after three in a row `error` reads `Lost contact with the server (…) — still trying…`, cleared by the next poll that answers. Only a 404 ends the follow: the job is marked failed with "the server may have restarted", and a later status read cannot put it back as running.
    - **Only the newest status read lands.** Each `refresh` takes a sequence number, so a slow one (a course switch, or the post-run re-read against the 30 s tick) cannot show another course's rows or put back the stale count a run just cleared.
    - `update()` called while a job runs sets `error` to `A GSPro update is already running: <step>` — the caller's dialog has the reason instead of a bare failure. The words the rows are written in are pure functions next to it: `agoLabel`, `whenLabel`, `aboutLabel`, `secsLabel`, `changedLabel`, `kindLabel`, `rowStatusLabel`.
- **The two halves open together.** `GsproExportService` still owns the folder, the course details and every single-file export (unchanged behaviour: the heightmaps, the per-terrain **Heightmap → Unity** (`gspro-inner-unity` / `gspro-outer-unity`, `runUnityTerrain(terrain)` — one terrain on its own, where the row's Update does both and re-exports what reads the heightmap), the hillshades and the Pull-from-Unity sculpt captures under Terrain, the vintage picker, cleaning boxes, the plain/cleaned JPEGs and "→ Unity meshes" under Photo, the SVG with its exclusions and bisect under Course shapes, the zones/trees/buildings/creeks files under their rows, and the GSPro course folder + Tees mapping + Course details + .GKD under Course file). The panel bridges the two services, so opening either half opens the other and closing closes both — the command bar can open the board with `GsproSyncService.openFor(courseId)` alone.
- Server side, and what each target's Update chain does: [gspro/export.md](gspro/export.md) "The GSPro status board: `GsproSyncService`".

### The GSPro group in the command bar

The board is one of **two** places a push into GSPro starts from; the other is the command bar's right end (Create mode, builder only, `app/command-bar.component.ts` `buildGspro`). The right-hand panels have no push buttons at all any more — they edit, the bar pushes.

- **GSPro** (`gspro-board-btn`, title "Open the GSPro status board") is permanent in every Create sub-mode and carries the stale count in its label (`GSPro · 6`, `gspro-stale-badge`). The count is read when the course opens and again at the end of every run below — no timer; the board itself polls while it is open.
- **One or two contextual Update buttons** before it, named exactly like the board's rows, each `aria-busy` while its own run goes and all of them off while any GSPro job runs (the board's, the shaping worker's, a planting). Which shows follows the sub-mode and the selection:

| Sub-mode | Selection | Button | What it runs |
|---|---|---|---|
| Terrain editor | — | **Update terrain** | `update('terrain')` (the chain bakes unapplied terrain edits itself) |
| Terrain editor | nothing in "Shape in Blender" | **Update meshes** | `update('meshes')` |
| Terrain editor | a feature with a recipe | **Update meshes (this feature)** | `ShapingService.apply(courseId, <ids>)` — the Shape section's old button, scope = the selection; off while the recipe save is still in flight (`TerrainEditToolService.saving`) |
| Draw | a path | **Update paths** | `ShapingService.apply(…, { paths: true })` (unchanged flow, new label) |
| Draw | a rock slab / bunker / pond / creek | **Update meshes (this feature)** | the same feature-scoped shaping run |
| Draw | anything else | **Update shapes** | `update('shapes')`; its report ends with the manual Blender step |
| Vegetation | — | **Update vegetation** | `PlantVegetationService.plant` behind its confirm |
| Vegetation | zones | **Update zone** / **Update N zones** | `PlantVegetationService.update`; a result with `needsPlanting` offers Update vegetation instead (its `reason`, then the whole planting on OK) |
| Clean photo | — | **Update photo** | `CleanToolService.settled()` first (a failed save stops it: "Some changes are not saved yet"), then `update('photo')` |
| Furniture | — | **Update course file** | `update('course-file')` |
| Furniture | — | **Update props** (`gspro-update-props-btn`) | `update('props')` — the spec, the Blender models and the place in Unity; the dialog's detail lists every `kept: <name> moved by hand <m> m / <deg>°` |

Until 2026-10-14 these three were "Plant for GSPro", "Update N zones for GSPro" and the Clean panel's "Apply in Unity".

- The outcome is the result dialog the bar already used for planting: the job's `results[].report` as the detail (only its own job's — a refused update leaves the previous run's job in hand), the target's `manual` step and — only when something really went into Unity and no `Saved …` line says the chain saved it itself — "Save the scene in Unity to keep it.".
- **Whether Unity was pushed is read off the job, not off the word "Unity"** (`pushedIntoUnity` / `needsSceneSave`, exported for their test): a phase whose id ends in `:unity` (`terrain:unity`, `meshes:unity`, the shaping job's `unity`) decides — `done` is a push, `skipped` is not — and only a chain with no Unity phase of its own falls back to the report, then to a push's own line (`Unity (vreta_v4): …`, `Unity inner: …`, either behind a chain's `inner: ` prefix). The chains' "Not in Unity: …", "Still manual in Unity: …" and "there is no Unity push for the outer terrain" never count.
- While a run goes, the button's label is its own job's `step`: the board job's for the `update(target)` buttons, the shaping job's phase for the two that run `ShapingService.apply` themselves (**Update paths**, **Update meshes (this feature)**).
- The Terrain editor's panel still **shows** a shaping run: the selection's phases under the Shape section (`terrain-shape-job`) and a course-wide run's under the edit list (`terrain-edit-meshes-job`, which also picks up a run started elsewhere through `ShapingService.resume`). Only the buttons moved.

## Rules lines live in Furniture

The penalty areas and OOB (`RULES_TYPES` in `draw/feature-palette.ts`) are
drawn and edited in Furniture mode, not Draw. There is one polygon engine:
`FurnitureToolService` runs `DrawToolService` in its `rules` scope
(`activate(ctx, { scope: 'rules', toolId, yieldTo })`), which hit-tests and
creates only those types (OOB by its line, not its inside), keeps nice
rendering with the penalty outlines stroked, has its own undo history, and
leaves presses on furniture markers (and everything while a placement is
armed) to the Furniture tool. Draw (`surfaces` scope) puts them, and the
vegetation zones, in `FeaturesService.modeHiddenTypes`: off the map, out of
hit tests, the type picker and the stack panel. `resolveSurfaceStack` passes them through like
OOB, so a higher shape never trims them away.

## Editor-only visibility for holes and Roughs

In Draw, select a hole (or drawing group) under **Scope** in Feature stack,
then use the **Shapes in this hole** eye (`stack-hole-toggle`) to hide/show
all of its shapes. Hidden shapes leave the map, hit tests and selection;
their individual eye settings are preserved when the hole is shown again.
This uses `FeaturesService.hiddenHoleIds`, editor-only session state, and
also covers shapes added to that hole while it is hidden. **Shift+H** shows
the hidden holes again. The planner and GSPro export still include them.

The stack panel's "Roughs layer" eye (`FeaturesService.roughsLayerHidden`)
drops every `layer: 'roughs'` feature from the overlay and hit tests, but only
while the editor owns the overlay (`attachOverlay(map, { editor: true })`,
from `editor/toolbar.component.ts`). The planner attaches without the flag, so
it always draws the roughs; the GSPro SVG export reads stored features on the
server. Session-only, never persisted.

## Map performance measurement

The map's top-right `FPS` control has a water shader toggle, live map renders per second, and a 10-second benchmark. Benchmarking requests continuous renders in both water modes and retains the last on/off results. Keep the same camera and loaded course data between runs. Moving the camera, hiding the tab, changing water mode, or closing the panel cancels a run. Average FPS and p95 frame intervals measure map render cadence, not GPU execution time. The live rate includes idle time; a still map can report zero. The water toggle lasts for the map service session and defaults to on after a reload.

The same control is available in `/dev/water.html`, a synthetic pond and creek preview. Its results do not represent full-course performance.

## Vegetation test scene (dev only)

URL: `http://localhost:5173/dev/vegetation` (vite dev; `dev/vegetation.html`, entry `src/vegetation/main.ts`). Plain three.js, no MapLibre, no login. Not in the production build unless `WEB_DEV_PAGES=1`.

Contents (`src/vegetation/vegetation-stems.ts`): 400 x 400 m ground with a generated grass tile (`grass-texture.ts`); a lineup at y = 0 of every species x variant (broadleaf, spruce, pine x 4) at 15 m plus one shrub; a size ladder at y = 40 (broadleaf and spruce at 2, 5, 10, 20, 30 m); a 200-stem mixed stand at 8 to 25 m north of the ladder, with the layer's `adjustStand`; a strip of 30 shrubs south of the lineup. Conifers use connected branch meshes and three folded surfaces per needle spray; medium LOD keeps two surfaces at every attachment. Each species has four forms batched separately. Conifers use a deterministic 70% pine / 30% spruce mix. Shrubs use woody stems and folded leaf meshes, with a reduced mesh beyond 45 m. The panel has a form inspector, a hide-controls button, camera presets (3/10/40/150/600 m), sun azimuth/elevation with three time-of-day presets (the first matches the ortho-derived layer default), forced LOD band, sway, wireframe, HTML name tags over the lineup and ladder stems, a 1:1 atlas viewer and frame stats. Controls persist in localStorage (`vegetation-scene`); `?lod=`, `?preset=<m>`, `?sway=0` and `?labels=0` override them.

- Add an asset type to the lineup: append to `lineupEntries()` in `vegetation-stems.ts` (species/variant pair, or a height under 4 m for a shrub); `tests/vegetation-stems.test.ts` counts the entries.
- Regenerate the tree textures: `bun scripts/gen-tree-textures.ts` (writes `public/trees/`; `--only <name>` for one atlas). The impostor atlas is baked at runtime from those textures.
- The map layer accepts `?treeLod=<fullM>[,<halfM>]` on the planner URL in dev builds to pull the LOD bands in; `e2e/tests/30-individual-trees.spec.ts` uses it on SwiftShader. `e2e/tests/31-vegetation-scene.spec.ts` cycles the presets and writes screenshots to `docs/validation/vegetation/`.

## Closing shapes and drawing groups

Polygon drafts close within 24 screen pixels of their first node; hovering
inside that radius snaps the preview to the start and enlarges the node.
Alt/Option-click places the final point and closes (at least three points);
Shift+Alt-click keeps that final point sharp. Enter still closes without adding
a point, and paths keep their open-centerline gestures.

Feature stack normally shows **Draw on**, the **Scope** filter and the
scope's feature rows. **Edit layer order…** opens a separate mode with one
**Layers · top to bottom** list: course level, every playable hole and named
drawing group, then Roughs. Select a layer and
use **Move up / Move down**; the same buttons move groups across holes and
reorder playable-hole layers. Course level stays fixed at the top of these
scopes and Roughs stays fixed at the bottom. Hole numbers and SVG/mesh names
never change when a layer moves. The order saves immediately and is kept
after reload; the GSPro Shapes row becomes stale for a layer-order change.

The order editor has its own selection: changing it preserves the draw
target, content filter and selected shapes. **Done · back to contents**
returns to the same feature list. Selecting a shape on the map follows its
layer in the content filter. Selecting Roughs in **Draw on**
chooses Rough when the current type cannot live there; other rough types
stay as chosen. Choosing a non-rough type later returns to course level.
Expand **Drawing groups (SVG only)** to add a named group or rename/delete
the group shown by **Scope**. Delete is disabled while it holds shapes.
Groups are not playable holes and never enter their sidebar or par/counts;
their shapes export to SVG, but never to GreenKeeper's GKD (including water,
penalty areas and OOB).

## Power lines in Draw

`power_line` ("Power line"; `shared/features/power-line.ts`) is a Draw-mode line type: pick it in the type panel, press the path button (it stays a power line, as Creek stays a creek), click one point per pole, Enter. It is a centerline feature with an 8 m corridor (`DEFAULT_POWER_LINE_WIDTH_M`), violet on the map. It is no surface: not in the surface stack (`OVERLAY_TYPES`), the lie map or the SVG. The GSPro trees export leaves out every survey stem inside the corridor (docs/gspro/export.md, `trees`); the points are where Unity's `golfmap.powerlines.build` stands its pole structures (unity/README.md "Power lines").

## Rock slabs in Draw

`rock_slab` ("Rock slab", Swedish berghäll; `shared/features/rock-slab.ts`) is a Draw-mode surface type like the roughs: pick it in the type panel (no digit key), press N, click the outline's points (Shift = corner) and Enter or click the first point, or drag it freehand. The selection panel's "Rock slab" section edits `marginM` (how far the cut-out reaches past the outline, 0-5 m, default 1.5) and `uvM` (texture tile size, default 4 m) on every selected slab; clearing a box drops the key. It is no OPCD surface: `gspro.py svg` leaves it out and `shaping-global` writes a `golfmap.cut_out` op for it (docs/gspro/export.md), applied by the command bar's Update meshes. The planner reads it as rough (unknown types do), iOS draws it in the fallback grey.

## Union in Draw

Select two or more shapes (Cmd/Ctrl+click) and press **Union** in the selection panel. The shape selected first takes the merged outline and keeps its id, type, hole, layer, attributes and slot in the stack; the others are deleted. One undo puts them all back. `draw/shape-union.ts` unions the sampled outlines with polygon-clipping (holes kept) and builds the result from the shapes' own control points: the controls away from the crossings stay exactly where they were drawn, each crossing becomes a corner control, and the stretch next to a crossing gets a few new controls fitted to the exact outline (within 0.4 m). When that cannot be done (very sparse controls, near-tangent crossings) it falls back to a fresh smooth B-spline fit (0.25 m, up to one control per 3 m); plain polygons stay polygons. Shapes that do not overlap or touch, and roads/paths (centerlines), are refused with a notice. The same function from the command line: `bun run features:union -- <course> <shape> <shape> [...] [--dry-run]` (first shape survives; the old shapes go to `data/backups/features-union/`).

## Picking shapes in Import GeoJSON

A fetch (Lantmäteriet water, OpenStreetMap, roads) or a picked file is built at once and drawn on the map; there is no preview button. Every shape starts picked. A click on a shape picks or drops it (grey when dropped), and **All**/**None** set them all; one line says `3 of 12 picked · 2 on the course`, and **Import N features** creates only the picked ones. A shape the course already has, the same `source` + `sourceRef` (or one created from the same file in this wizard), is grey and cannot be picked, so nothing is imported twice. After an import the shapes stay on the map, and the next ones can be picked from the same fetch. While the shapes are on the map the wizard takes the map's clicks (`geojson-import-pick`) and hands them back to the tool that had them when it closes. A Hydrografi shape split in parts (a MultiPolygon, or cut by the map's edge) numbers its parts `<ref>#1`, `#2`…; an import from before that stored the bare ref, which covers every part. The build, the duplicate check and the click test are in `import/geojson-build.ts`. `bun run water:import -- <course>` lists the Hydrografi shapes (number, area, place, ref, new or on course) and imports `--pick 3,5` (numbers or refs) or `--all`, with `--dry-run`.

## Pond edges in the Terrain editor

The **Ponds** line at the top of the panel (shown when the course has ponds; one line folded, e.g. `▸ Ponds · 1/2 fitted · next: fit edges`) unfolds into the five steps with a button each: 1 Edges (Fit), 2 Steep bank (45° all, optional), 3 Dig (re-dig counted when a dig is older than the pond's fit: `waterEdgeAt` on the feature), 4 Terrain and 5 Meshes (the GSPro board's updates); the explanations are tooltips. After a GeoJSON import that brought water, the result shows one line with **Fit edges**, which opens Terrain edit and starts the walk-through. **Fit** in the checklist, or **Fit edge to water** in a pond dig's form (the pencil on its row), asks `PondEdgeService` (`/pond-edge/propose`, `/propose-all`) for each pond's water edge: found on the orthophoto between the lidar's open water and the drawn line (`pipeline/golfpipe/water_edge.py`). The proposal draws on the map in red, with the lidar's water dashed yellow (`TerrainEditView.pondEdge`, roles `pond-proposed` / `pond-lidar`). The panel's Water edge section gives the numbers and the stretches that kept the drawn line (no clear edge on the photo: reeds, shade). **Accept** fits it with `fitPondEdge` (`terrain-edit/pond-edge-fit.ts`, the draw tool's B-spline fitter) and stores it through the ordinary feature update. **Skip**/**Discard** moves on; **Undo the edge fit** puts the old outline back. With all ponds, the biggest change comes first. `bun run water:edge` is the same service and fit from the command line. The same form carries **Bank above water (°)** (`digBankAboveDeg`): the outline is the water's edge, the bank outside comes down to the water at that angle, and the water plane is set at the dig's level.
