# Web features (implementation notes)

Moved from web/AGENTS.md. Vegetation zones and roads/centerline notes live in [feature-vegetation-zones.md](feature-vegetation-zones.md) and [feature-roads-centerline.md](feature-roads-centerline.md).

## src/ layout

`app/` shell · `auth/` login+guard · `courses/` list · `sites/` (site setup page `/sites`, builder only: rename sites and courses, add a course on an existing site, detach, delete an empty site; `SitesService` also backs the new-course wizard's New site / Existing site step) · `course-detail/` · `editor/` (toolbar + `tools/`) · `draw/` (SVG feature drawing, history/undo) · `import/` (SVG orthophoto trace import) · `export/` (GSPro/OPCD export panel: SVG, inner/outer orthophoto JPEGs, inner/outer DEM GeoTIFFs over the two terrain squares, and GreenKeeper's .GKD into the course's GSPro folder; long explanations go behind `ui/info-tip.ts` (i) tips, only what the operator must act on stays in view) · `measure/` · `analysis/` (green slope) · `planner/` (strategy: overlay, gates, plan service) · `player/` (club config) · `map/` (MapLibre style/tiles/interaction; `tree-renderer.ts` is the three.js tree drawing shared with the vegetation scene) · `geo/` (bezier, bspline, transform) · `furniture/` · `vegetation/` (dev-only tree test scene) · `photos/` (reference photo browser, see below).

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

## Clean tool: PhotoCraft retouching on the pixels, image editor round trip, Apply in Unity

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
- **Apply in Unity** (`applyInUnity()`): waits for the saves, then starts the GSPro export job `unity-ortho` on the built vintage's `.cleaned.tif` (`api.gsproExport`, behind the `UnityOrthoApi` seam) and polls it; `externalBusy` is `unity`, the outcome goes to `unityMessage`. The job applies the `-meshes` variant (darkened, grass surfaces tinted green) with server defaults and no building removal or forest floor; the export panel's own button is the one with options ([gspro/export.md](gspro/export.md)).

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

## Hiding the Roughs layer is editor-only

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

## Power lines in Draw

`power_line` ("Power line"; `shared/features/power-line.ts`) is a Draw-mode line type: pick it in the type panel, press the path button (it stays a power line, as Creek stays a creek), click one point per pole, Enter. It is a centerline feature with an 8 m corridor (`DEFAULT_POWER_LINE_WIDTH_M`), violet on the map. It is no surface: not in the surface stack (`OVERLAY_TYPES`), the lie map or the SVG. The GSPro trees export leaves out every survey stem inside the corridor (docs/gspro/export.md, `trees`); the points are where Unity's `golfmap.powerlines.build` stands its pole structures (unity/README.md "Power lines").

## Rock slabs in Draw

`rock_slab` ("Rock slab", Swedish berghäll; `shared/features/rock-slab.ts`) is a Draw-mode surface type like the roughs: pick it in the type panel (no digit key), press N, click the outline's points (Shift = corner) and Enter or click the first point, or drag it freehand. The selection panel's "Rock slab" section edits `marginM` (how far the cut-out reaches past the outline, 0-5 m, default 1.5) and `uvM` (texture tile size, default 4 m) on every selected slab; clearing a box drops the key. It is no OPCD surface: `gspro.py svg` leaves it out and `shaping-global` writes a `golfmap.cut_out` op for it (docs/gspro/export.md), applied by the Terrain editor's Apply to meshes. The planner reads it as rough (unknown types do), iOS draws it in the fallback grey.
