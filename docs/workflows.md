# Workflows

Multi-step loops that span the web editor, the pipeline, Blender and Unity. Each step ends with **Done when**.
Unity commands run through the `unity` MCP server (`unity_command <name> {args}`); pass `project` when more than one editor is open.
Course paths (export folder, Unity project, `.blend`) are in the root [AGENTS.md](../AGENTS.md).

## 1. Terrain round-trip and order of operations

> "We import roads and then you smooth the DEM? Then we need to retransform that into raw and reimport?" / "finish terrain and conform first… anything done after conform has to be redone"

Two terrains, two pipelines ([export.md](gspro/export.md) "Terrain squares"):

| | Inner | Outer |
|---|---|---|
| Area | map area square, 10 m side step, tight round the course | 5 km square centred on the inner |
| DEM | build lidar, 0.5 m; edits baked by **Apply to terrain** into `sources/<site>/dem-edited.tif` | Laserdata Skog lidar, 1 m, fetched once into `sources/<site>/outer-*`; export replays enabled edits fresh |
| Roads | yes, within ~200 m of playing surfaces | no |
| Export kinds | `dem:inner`, `unity-terrain:inner`, `unity-sculpt:inner` | same with `:outer`; needs the inner sidecar exported first |

Order (each later step invalidates the ones after it, never the ones before):

1. **Roads in** (inner only): web GeoJSON import panel, **Fetch roads (OSM + NVDB)**, import the corridors as `path`. Done when the roads show as `path` features within 200 m of play.
2. **Generated edits**: web Terrain editor › Generate › **Road grades** (one `corridor` edit per road: smoothed along, level across), **Generate building pads**, and the pond/bunker/creek digs as needed. Each run replaces only its own previous edits. Done when they are listed under "Edits on this site".
3. **Hand edits** in the Terrain editor. Done when listed and enabled.
4. **Capture any Unity sculpt first**: if the terrain was sculpted in Unity since its last Heightmap → Unity, run `bun run gspro:export -- <course> unity-sculpt:inner` (and `:outer`), or the panel's **Inner/Outer Unity sculpt → golf-map** (bridge `golfmap.terrain.capture`). The next update overwrites uncaptured strokes (a backup stays in `<course>/Backups/`). Done when the report shows the captured cells and a "Unity sculpt" edit is listed (0 cells = nothing sculpted).
   - "No reference for the inner terrain": the terrain never got a Heightmap → Unity; do step 6 once, then sculpt.
5. **Apply to terrain** (Terrain editor button): bakes every enabled edit into the inner `dem-edited.tif`. Done when the Apply finishes; step 6 refusing with "stale" means it did not.
6. **Heightmap → Unity**: `bun run gspro:export -- <course> unity-terrain:inner unity-terrain:outer` (or the panel's **Inner/Outer heightmap → Unity**). Exports `.raw` + sidecar, then runs `golfmap.terrain.update` in the editor whose active course's export folder matches, in place, backup first, and keeps a reference for the next capture. Refuses a stale inner (go back to 5). Done when the report lists how far the ground moved and `outerShowsThrough` is ~0.
   - 409 "no open Unity editor": open the course project with its GolfMap course active (`unity_command golfmap.course`).
   - "The course is not a saved asset": the `GolfMapCourse` held by the command has no asset path. Save the course asset (`GolfMap/Course/Select active course`, then File › Save Project; for a new scene `GolfMap/Course/New course for this scene`) and run again. <!-- VERIFY: exact fix the user applied; a stale reference after an asset copy also clears with a script reload (unity_sync push) -->
   - The update undoes any earlier `golfmap.terrain.conform`: steps 8-9 must follow.
7. **Re-export what reads the sidecar** when the inner's `minM` moved (the report warns): `bun run gspro:export -- <course> trees buildings zones creeks gkd`, then replant trees / `golfmap.creeks.import`. Done when each export succeeds without a sidecar warning. <!-- VERIFY: which of these the user actually re-runs when minM is unchanged -->
8. **Meshes onto the new ground** (Blender): Unity Terrain › Export To OBJ to `terrain.obj` next to the course `.blend` (manual), then `blender -b <course>.blend --python blender/tools/shape_prepare.py` (OPCD Import Terrain OBJ + Conform to Terrain → `<name>.conformed.blend`), then shaping apply (Terrain editor's shaping button, or `shape_apply.py`) → changed FBX ([SHAPING-PLAN.md](../blender/SHAPING-PLAN.md)). Done when `shaping-report.json` has no failures and the FBX are written. <!-- VERIFY: OBJ export menu path and whether the export folder or the .blend folder is where terrain.obj must land -->
9. **Conform + course refresh**: `unity_command golfmap.course.refresh {dryRun: true}`, then without `dryRun` (menu `GolfMap/Course/Refresh after Blender export`).
   - Chains meshes.sync, bunker materials, path materials, paint, rough grass, `golfmap.terrain.conform mode=match`, water planes, creeks refit, walls, surfaces.export.
   - Terrain changed but no new meshes: `unity_command golfmap.terrain.conform {terrain: "inner"}` alone (`golfmap.terrain.restore {backup}` undoes).
   - Never OPCD's right-click "Conform Mesh To Terrain": it moves the meshes down instead.
   - Done when `<course>/refresh-report.json` shows every step ok; its `pending` list is what remains.
10. **After conform** (redo all of these after any later terrain change): **Plant for GSPro** (workflow 2), `golfmap.props.place` (workflow 4 first), anything checked by screenshot. Done when the `pending` steps are done and verified in a screenshot.
11. **Save the scene** (ask the user; the commands mark it dirty, never save). Done when the title bar loses the `*`.

A terrain change after step 9 = back to step 4 (capture), then 5-11 in order. Unity sculpts and anything hand-placed in the scene are the only things a re-run can lose.

## 2. New vegetation area in the web editor → visible in Unity and GSPro

> "I drew a vegetation area… but it doesn't show up. What more is needed?" / "When I add a new veg area in golf-map editor, what is the way to get it to show in Unity?"

Drawing stores the zone in `data/app.sqlite` only; nothing reaches Unity or the Arborist file until it is exported and imported.
Batch: the user prefers several zone edits, then one update/replant, not one per edit.

1. **Draw** in web Vegetation mode: pick the zone type (and variant) in the command bar's zone-type picker, draw. Done when the zone shows in the stack panel with the intended type/variant.
2. **Check the type grows something**: a zone type or variant with no items bound plants nothing (the planting report warns "binds no items"). Bind: `bun run zones -- bind <course> <type> [--variant <v>] --palette <file>` or `<item>=<weight> ...` ([grass-planting skill](../.claude/skills/grass-planting/SKILL.md)). Done when the variant picker no longer says Default is empty for it.
3. Repeat 1-2 for every area in the batch.
4. **Into Unity and the Arborist file**, with the course's Unity project open. GSPro draws the vegetation from two places: the course's own VSP (grass, the trees and plants kept there) and `arboristdata.dat` in the GSPro course folder (bushes, the woodland floor, most trees; [arborist.md](gspro/arborist.md)). Both buttons write both:
   - Only drawn zones changed, item bindings unchanged: select the zones, command bar **Update for GSPro** (`vegetation-update` job: `gspro.py zones-patch` → `golfmap.zones.patch`, only their window respawns → `arborist.py lower`, about 10 s). Done when the result dialog reports the zones patched, no terrain skipped and "Arborist lower vegetation written".
   - Bindings changed, a new item, generated zones stale, the first planting, or Update says to: command bar **Plant for GSPro** (job `vegetation`).
     It runs the generators → `zones:inner` export → `golfmap.zones.import {terrain: "inner", package: "GolfMap lower vegetation"}` → `golfmap.grass.apply`, a second round for new items → `arborist.py lower` → `golfmap.trees.dump` + `arborist.py trees`.
     Unity not open: the zones are exported, the Arborist file gets its lower vegetation, its trees stay as they were, and the report says so.
     CLI without Unity: `bun run grass:zones -- <course>` (zones export + `arborist.py lower`), then those two `unity_command`s (import, apply, import, apply for a new item); the Arborist file alone: `bun run gspro:export -- <course> arborist`.
     Done when the report says imported + applied with no unbound-item warnings, and "Arborist lower vegetation written" and "Arborist trees written" (a course without `docs/gspro/<course>/arborist-species.json`: "Arborist: not used by this course").
   - A warning that the trees Arborist draws in place of the course's own changed: run the two `golfmap.vsp.trees.trim` commands it names, then save and build ([arborist.md](gspro/arborist.md), "The ring rule").
   - The outer terrain is not refreshed by Plant for GSPro: `bun run gspro:export -- <course> zones:outer`, then `golfmap.zones.import {terrain: "outer"}` + `golfmap.grass.apply {terrain: "outer"}`. <!-- VERIFY: whether the user plants zones on the outer at all -->
5. **Verify**: `unity_screenshot` over the zone with `warmup` 20-80 (an unfocused 2018 editor never ticks VSP on its own); `golfmap.vsp` lists the item spawning with mask rules. Done when the grass/bushes are visible in the screenshot.
   - Bare where the mask says it should grow: run `golfmap.terrain.conform` (grass buried under the meshes).
   - VSP throws `JobHandle.Complete()` every frame: `golfmap.vsp.reset` or any `unity_sync push`.
6. **Save the scene** (ask the user). Done when saved.

## 3. Edit Unity editor scripts: repo first, then sync

> "make edits here in our file structure but after each edit you copy the change into the unity project"

1. **Check for drift**: `unity_sync {mode: "check"}`. `unity-changed`/`unity-only` → `pull` first; `conflict` → diff, merge in the repo, later `push` with `force`. Done when the check reports only repo-side or no changes.
2. **Edit in the repo**: [unity/Editor/GolfMap/](../unity/Editor/GolfMap/) (runtime: `unity/Runtime/GolfMap/`; bridge: `unity/Editor/GolfMapBridge/`), C# 6, Unity 2018.2 APIs, no course names in code. Never edit the copy under `Assets/Editor/GolfMap`. Done when the edit is saved in the repo.
3. **Offline compile (optional, no editor needed)**: `pwsh unity/check-planter.ps1 [-UnityProject <path>]`; a new `.cs` file goes into its file list. Done when it prints "Compiled planter against installed Unity/VSP assemblies". <!-- VERIFY: the list lags the folder (e.g. GolfMapZoneImporterPatch.cs, GolfMapProps helpers); add missing files when they matter -->
4. **Push**: `unity_sync {mode: "push"}` copies [install.json](../unity/install.json)'s folders and recompiles. Done when it returns no compile errors and no new console errors.
5. **Verify in the editor**: run it (`unity_command <name>` / `unity_menu <path>`), then `unity_console {since: <seq>}`, `unity_scene`, `unity_screenshot`. Test with a real change of the kind the user makes, judged by the scene. Done when the scene shows the intended result.
6. **Course data is not synced**: specs and assets under `Assets/GolfMap/<Course>/` are copied by their own step (e.g. `blender/conventions/bunker-channels.json` by hand; `stone-walls.gen.py --out <course folder>`; props via `build_props.py --out`). An asset file replaced under the open 2018.2 editor does not reload: a loaded prefab/ScriptableObject keeps its memory state and the next `SaveAssets` writes it back. Revert in memory or `Resources.UnloadAsset` after copying, then a script reload (`unity_sync push`) for VSP ([unity-gotchas.md](unity-gotchas.md)). `palette.json` only through `GolfMapPalette.Load/Save`. Done when memory matches disk (re-read via the command that uses it).
7. `.meta` files stay Unity's: never add them to the repo. Done when `git status` shows no `.meta` under `unity/`.

## 4. Re-running a placement tool without losing hand edits

> Props moved/rotated by hand in Unity were lost in 3 sessions when `props.place` re-placed them.

Generators that rebuild scene objects from a spec and drop hand edits:

| Command | Hand edits lost | Where to capture |
|---|---|---|
| `golfmap.props.place [only=<asset>]` | every instance of the assets placed (`GolfMap Props/<Category>s/<asset>#<i>`) | `place(...)` calls in `docs/gspro/<course>/*-props.gen.py` |
| `golfmap.walls.build [only=<id>]` | single stones/boulders moved | `pose {dy, euler, scale}` in `docs/gspro/<course>/stone-walls.gen.py` (e.g. `H4_POSES`) |
| `golfmap.creeks.import` | spline points and moved spline objects | the creek feature in the web editor |
| `golfmap.waterplanes.build` | a moved reflection probe (the plane's lift is kept) | not capturable |
| `golfmap.paths.materials`, rough grass lip material | edits to the built materials | `<course>/Paths/path-surfaces.json` / the command's args |

`golfmap.course.refresh` never runs `props.place` (listed as pending) but does run `walls.build` near changed meshes and `creeks.import`.
Tree replants keep `<course>-<terrain>-tree-edits.json`: no capture needed there.

Props (same pattern for walls):

1. **Find what was hand-edited**: `unity_scene` / `unity_command scene.find` under `/GolfMap Props`; read each transform with `scene.inspect` (Transform). Done when every instance of the assets to re-place has position + yaw.
2. **Match to the spec** by asset and nearest position, not by `#i` (indices go stale after spec edits). Done when each scene object maps to one `place(...)` line.
3. **Write back** into `docs/gspro/<course>/*-props.gen.py`, comment "set by hand in Unity <date>":
   - position: EPSG:3006 E = Unity x + inner sidecar `square3006[0]`, N = Unity z + `square3006[1]` (`GolfMapProps.cs`); `place()` takes e/n relative to the script's `E0, N0`.
   - yaw: `place()` sets Unity yaw = `yawDeg − 90` for prefab `axis: x` and Blender assets (`sx > 0` in the place report's `axis`), `yawDeg + 90` for mirrored Blender assets, `yawDeg` for `axis: z`; invert that. <!-- VERIFY: memory note says Blender assets use spec = Unity yaw − 90; check sx on Vreta's report before trusting either -->
   - height: `dz` = lift above the ground mode the spec uses.
   Done when the script holds every captured transform.
4. **Rebuild the spec + models**: `pipeline/.venv/Scripts/python.exe docs/gspro/<course>/clubhouse-props.gen.py` from the repo root (writes `*-props.json`), then `"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/<course>/clubhouse-props.json --out "<Unity project>/Assets/GolfMap/<Course>/Props"`. Done when `<course>/Props/props.json` is rewritten.
5. **Dry run**: `unity_command golfmap.props.place {dryRun: true, only: "<asset>"}`. Done when positions/yaws/heights in the plan match the captured ones (within a few cm / 0.5°).
6. **Place**: same without `dryRun`; check `GolfMapSpelunk/<Course>_props.txt` and a `unity_screenshot`. Done when the props stand where the user left them.
7. **Save the scene** (ask the user).

Walls: capture moved stones as `pose` (e/n of the pivot, `dy` over the ground under it, Euler, scale) in `stone-walls.gen.py`, run it with `--out "<Unity course folder>"`, then `golfmap.walls.build {only: "<wall id>", dryRun: true}`, then for real.

## 5. A path changed surface → Blender → Unity

Only for a changed **Path surface** (Draw mode's selection panel). A moved or redrawn path, a new road, and a grass track made a hard path (or back: a grass track is built as rough) need the SVG export and the OPCD build.

1. Draw mode: select a path, command bar **Update paths in Unity** (`update-paths-btn`; `ShapingService.apply` with `paths`). It runs, in order:
   - `gspro.py svg --paths-only`: rewrites `<prefix>-paths.json` next to the exported SVG, the SVG itself untouched. Its report names the shapes that changed surface and warns about what a surfaces-only update cannot carry.
   - `gspro.py shaping-global` and the shaping worker's sync: `golfmap.split_surfaces` re-cuts the roads of mixed surfaces; only what changed is re-shaped (any other shaping not yet applied goes with it).
   - `golfmap.course.refresh only=<changed objects> skip=paths.materials`, then `golfmap.paths.materials` over every path mesh (also when Blender changed nothing: a whole road given another surface).
2. Done when the result dialog says **Paths updated in Unity** with no warnings and its `Path meshes:` line shows the surfaces. Then save the scene (ask the user).

Needs the SVG exported once, the course's `.blend` and its Unity project open, like the Terrain editor's **Shape in Blender**.

## 6. Clean the photo, in the editor or an image editor, and put it into Unity

The cleaned photo is **one image per site**: `data/sources/<siteId>/ortho-<vintage>.cleaned.tif`, 8192 x 8192 px on the inner terrain square (the square of every GSPro ortho export and of the Unity textures). It is made from the pristine photo the first time anything touches it. The Clean tool, an import and an undo all change that file directly; there is no edit log, nothing to bake and nothing to export before importing. Builder mode, a built map.

1. **Clean in the editor.** Create › Clean photo. The photo's pixels load (a few seconds; about 15 s the very first time, when the file is made). Then paint with PhotoCraft's tools: **Clone** and **Heal** (Alt-click a source, drag), **Spot** (paint over a blemish), **Remove** (paint over or loop around an object). Every stroke changes the photo and is saved at once: the status line reads "All changes saved". Ctrl+Z / Ctrl+Shift+Z undo and redo strokes. Done when the status line reads "All changes saved" and the map shows the result with "Show cleaned photo" on.
2. **Or edit outside.** Clean panel › **Download photo (PNG)** (about 10 to 20 s). Edit it in any image editor and save it at **8192 x 8192 px, uncropped**, as PNG, JPEG or TIFF. Then **Import a photo**: the image becomes the cleaned photo, whatever is on it. An image with transparency is laid over the photo. Done when the line under the input reads "Imported: N pixels changed".
   - A PNG edit changes only what you edited and imports in seconds. A JPEG, or a save with a colour-profile conversion, changes every pixel: it still imports, but every map tile is re-cut (about 45 s on Vreta) and the photo takes the editor's colours.
   - Another pixel size is refused with the two sizes in the message.
   - Do not pick the file while the editor is still writing it: the upload stops and is answered after 30 s with how far it got.
3. **Undo last session** puts back the photo from before the last editing session (everything painted since the tool last loaded the photo) or import, up to 5 steps. Done when the count beside the button drops by one.
4. **Onto the Unity course meshes.** With the course's Unity project open: Clean panel › **Apply in Unity** (the cleaned photo as the darkened, green-tinted `-meshes` texture, no building removal or forest floor), or export panel › Cleaned orthophoto textures › **Inner cleaned photo → Unity meshes** (the same with the panel's brightness, tint and two cleaning boxes). Both run the `unity-ortho` job: render, then `golfmap.orthos.apply` with the `-meshes` file. About 40 s. Done when the report's last lines name the Unity texture it was put onto; then save the Unity project (ask the user).

Without the browser: `bun run photo -- info|export|import|undo <course> [file]` (`scripts/cleaned-photo.ts`, the same service), then **Refresh** in the Clean panel.

Files, under `data/sources/<siteId>/`: `ortho-<vintage>.cleaned.tif` (the photo), `cleaned-history/<n>.tif` (the photo before each of the last 5 changes: the undo steps), `cleaned-work/` (the kept download PNG, uploads and edit batches while they are processed). The pristine `ortho-<vintage>.tif` is never changed. Map tiles of the cleaned photo: `data/tiles/<siteId>/ortho-sim/` (only tiles a change touched; the rest fall back to the pristine tiles, and are a little sharper at the deepest zooms than the 8192 px photo).

Left from the patch-log model this replaced (2026-10-08), safe to delete by hand once the cleaned photo looks right: `ortho-<vintage>.patched.tif`, `patches/`, `exports/`, `sim-frame.json`. A site that had a `.patched.tif` got its cleaned photo from it, so those edits are in the photo.


### Boundaries for AI photo cleanup

Clean photo › **Areas** stores the cleanup scope separately from course features and photo edits. **Area to clean** includes ground, and cleanup there is limited to the mapped tees, fairways, roughs and greens. **Clean everything** includes ground and cleans all of it, whatever course feature is mapped there or none (trees standing just outside a drawn rough, for example). **Keep unchanged** excludes ground, regardless of drawing order and of either other kind. With no included areas, nothing is eligible. The green preview is the union of both including kinds with every protected area cut out; purple on top of it marks the Clean everything part; orange marks protected ground. These boundaries guide external cleanup, not the manual stamp or inpainting tools.

Choose **Area to clean**, **Clean everything** or **Keep unchanged**; the map cursor becomes a crosshair. Drag to trace a boundary or click separate corners, then **Finish area** (or Enter) to save. Left-drag draws while a draft is active; Ctrl/Cmd-drag pans. The panel shows the number of corners placed. Backspace removes the last corner and Escape cancels a draft. Select a saved area to rename, redraw or delete it. **Undo area change** restores the previous set during the current editing session. Areas persist in the server database, belong to the site's shared photo, and are visible to every course on that site. Concurrent changes are rejected rather than overwritten; cancel the draft and **Reload areas** before retrying.

**Download cleanup boundary** exports the effective WGS84 MultiPolygon as GeoJSON, including protected holes, as the feature with `properties.type` `cleanup`. When a Clean everything area is drawn, a second feature of type `cleanup-force` holds the part of it to clean regardless of course features (protected ground cut out of it too). The cleanup skill can pass this file directly to `cleanup.py maps --cleanup-aoi <file> --aoi-crs EPSG:4326`, along with the original image, course surface geometry and the image's exact EPSG:3006 frame. It must not use this boundary's bounding box as the image frame. This only defines where edits are allowed; no image generation runs when saving or downloading a boundary. Review the composed result, import it through **Import a photo**, then use **Apply in Unity** as above.

Authenticated builder APIs: `GET /api/cleanup-areas?courseId=<id>` reads the versioned source areas; `POST /api/cleanup-areas` saves `{courseId, version, areas}`; `GET /api/cleanup-areas/export?courseId=<id>` returns the effective GeoJSON. The export carries `siteId` and `version` so a cleanup job can record exactly which saved scope it used.

## 7. A rock slab (berghäll) in the ground

> "There is berghällar here in reality" / "a bit too small" / "too dark, doesn't look like the granite on hole 10"

A low slab of bedrock lying in the slope, with grass growing in over its edges. It is a piece of the course meshes cut out into its own mesh (`Spline_hall_<n>_Rock_-_Mesh`), not boulders placed on the ground (a klippa or a stone wall: workflow 4, `golfmap.walls.build`).

1. **Draw it.** Web Draw mode, feature type **Rock slab**, the outline of the rock seen in the orthophoto. Selection panel: **Margin** (default 1.5 m: the cut-out reaches that far beyond the drawing; an outline traced tight to the visible rock read too small in game) and **Texture tile** (default 4 m). Done when the slab shows on the map.
   - It is no OPCD surface: it is not in the SVG. Slabs are kept 0.8 m apart; a later one is trimmed, or skipped with a warning when nothing sensible is left.
   - Keep it 2 m or more off semi rough, tees and greens: nearer than that the tall grass cannot cover its edge (the surfaces' clearance wins) and a bare mesh edge shows.
2. **Rock material, once per course.** `unity_command golfmap.slabs.materials {material: "<asset path of a tiling rock material>"}` writes `<course>/rock-slabs.json` (Vreta: `Assets/GolfMap/Vreta/Walls/granite_boulder (rock color pond-klippa).mat`, physics `GSPstone`). Done when the result lists the material and `physicMaterial`.
3. **Shape, sync, replant: one command.** `bun run shaping -- <course>` (or the Terrain editor's shaping button): regenerates the layers (one `golfmap.cut_out` per slab, last in `00-global.gen.json`), replays them in Blender, exports the changed FBX, runs `golfmap.course.refresh only=<changed>` (slab material and physics, surface map re-exported because a slab is among them), then plants the vegetation again so the tall grass leaves the rock but for a fringe over its edge and some patches. `--dry-run` first shows what would change. Done when every phase is `ok` and "Surface map and grass" names the slab.
   - Never drive the shaping worker by hand without regenerating the layers first: the `.gen.json` files on disk can be older than the database, and a sync then puts older meshes into Unity.
4. **Verify.** `unity_screenshot` with `restore: true` (the user's Scene view stays where it was), from 25 m up and from a golfer's eye: rock colour against the course's other granite, no straight bare mesh edge, grass patches. `ground.probe {x, z}` on the slab must hit the slab mesh first, the terrain 1 cm under it. Then ask the user to save the scene.

A slab drawn before this workflow existed may sit in a hand layer (`docs/gspro/<course>/shaping/20-rocks.json`, Vreta's two); the same slab drawn in the app as well would be cut twice: remove it from one.

Not built yet: added geometry (a slab keeps the meshes' ~1.2 m triangles and heights), and none of it has been checked in the GSPro runtime.
