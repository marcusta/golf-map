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
