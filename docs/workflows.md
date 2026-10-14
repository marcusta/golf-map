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
4. **Pull from Unity first** (sculpt capture): if the terrain was sculpted in Unity since its last **Update terrain**, run `bun run gspro:export -- <course> unity-sculpt:inner` (and `:outer`), or the GSPro board's Terrain row **Pull from Unity** (bridge `golfmap.terrain.capture`). The next update overwrites uncaptured strokes (a backup stays in `<course>/Backups/`). Done when the report shows the captured cells and a "Unity sculpt" edit is listed (0 cells = nothing sculpted).
   - "No reference for the inner terrain": the terrain never had an **Update terrain**; do step 6 once, then sculpt.
5. **Apply to terrain** (Terrain editor button): bakes every enabled edit into the inner `dem-edited.tif`. Done when the Apply finishes; step 6 refusing with "stale" means it did not.
6. **The heightmaps into Unity**: `bun run gspro:export -- <course> unity-terrain:inner unity-terrain:outer`. Exports `.raw` + sidecar, then runs `golfmap.terrain.update` in the editor whose active course's export folder matches, in place, backup first, and keeps a reference for the next capture. Refuses a stale inner (go back to 5). Done when the report lists how far the ground moved and `outerShowsThrough` is ~0.
   - 409 "no open Unity editor": open the course project with its GolfMap course active (`unity_command golfmap.course`).
   - "The course is not a saved asset": the `GolfMapCourse` held by the command has no asset path. Save the course asset (`GolfMap/Course/Select active course`, then File › Save Project; for a new scene `GolfMap/Course/New course for this scene`) and run again. <!-- VERIFY: exact fix the user applied; a stale reference after an asset copy also clears with a script reload (unity_sync push) -->
   - The update undoes any earlier `golfmap.terrain.conform`: steps 8-9 must follow.
7. **Re-export what reads the sidecar** when the inner's `minM` moved (the report warns): `bun run gspro:export -- <course> trees buildings zones creeks gkd`, then replant trees / `golfmap.creeks.import`. Done when each export succeeds without a sidecar warning. <!-- VERIFY: which of these the user actually re-runs when minM is unchanged -->
   - **Steps 5-7 in one go: Update terrain.** The command bar's **Update terrain** in the Terrain editor (or `bun run gspro:update -- <course> terrain`) is exactly 5, 6 and 7 as one phased job — it bakes the unapplied edits itself, exports and pushes both heightmaps, and re-runs the files that read the sidecar; it saves the Unity scene and says so. Read 5-7 as what it does, and as what to run by hand when one phase fails. Done when every phase in the result dialog is ok.
8. **Meshes onto the new ground** (Blender): write `terrain.obj` from the exported heightmap — `bun run py ../blender/tools/terrain_obj.py --sidecar <export dir>/<prefix>-inner-dem-<side>m.tif.json --out <export dir>/terrain.obj` (the same file Unity's Terrain › Export To OBJ wrote, to within 1 mm; no editor needed, blender/README.md "terrain.obj without Unity"), then `blender -b <course>.blend --python blender/tools/shape_prepare.py` (OPCD Import Terrain OBJ + Conform to Terrain → `<name>.conformed.blend`; unchanged meshes come from the per-mesh conform cache, ~20 s instead of ~150 s), then shaping apply (the command bar's **Update meshes**, or `shape_apply.py`) → changed FBX ([SHAPING-PLAN.md](../blender/SHAPING-PLAN.md)). Done when `shaping-report.json` has no failures and the FBX are written.
9. **Conform + course refresh**: `unity_command golfmap.course.refresh {dryRun: true}`, then without `dryRun` (menu `GolfMap/Course/Refresh after Blender export`).
   - Chains meshes.sync, bunker materials, path materials, paint, rough grass, `golfmap.terrain.conform mode=match`, water planes, creeks refit, walls, surfaces.export.
   - Terrain changed but no new meshes: `unity_command golfmap.terrain.conform {terrain: "inner"}` alone (`golfmap.terrain.restore {backup}` undoes).
   - Never OPCD's right-click "Conform Mesh To Terrain": it moves the meshes down instead.
   - Done when `<course>/refresh-report.json` shows every step ok; its `pending` list is what remains.
10. **After conform** (redo all of these after any later terrain change): **Update vegetation** (workflow 2), **Update props** (workflow 4; hand-moved props are kept), anything checked by screenshot. Done when the `pending` steps are done and verified in a screenshot.
11. **Save the scene.** Every command that writes into the scene takes `save: true`: it then saves the open dirty scenes and the assets it changed once it has succeeded, and reports `saved: {scenes, seconds}` (a dry run and a failed run never save; `golfmap.course.refresh` saves once, after its last step). The ask is for commands run **without** it: they mark the scene dirty and never save, so ask the user (or run `unity_command scene.save`). Done when the title bar loses the `*`.

A terrain change after step 9 = back to step 4 (capture), then 5-11 in order. Unity sculpts and anything hand-placed in the scene are the only things a re-run can lose.

## 2. New vegetation area in the web editor → visible in Unity and GSPro

> "I drew a vegetation area… but it doesn't show up. What more is needed?" / "When I add a new veg area in golf-map editor, what is the way to get it to show in Unity?"

Drawing stores the zone in `data/app.sqlite` only; nothing reaches Unity or the Arborist file until it is exported and imported.
Batch: the user prefers several zone edits, then one update/replant, not one per edit.

1. **Draw** in web Vegetation mode: pick the zone type (and variant) in the command bar's zone-type picker, draw. Done when the zone shows in the stack panel with the intended type/variant.
2. **Check the type grows something**: a zone type or variant with no items bound plants nothing (the planting report warns "binds no items"). Bind: `bun run zones -- bind <course> <type> [--variant <v>] --palette <file>` or `<item>=<weight> ...` ([grass-planting skill](../.claude/skills/grass-planting/SKILL.md)). Done when the variant picker no longer says Default is empty for it.
3. Repeat 1-2 for every area in the batch.
4. **Into Unity and the Arborist file**, with the course's Unity project open. GSPro draws the vegetation from two places: the course's own VSP (grass, the trees and plants kept there) and `arboristdata.dat` in the GSPro course folder (bushes, the woodland floor, most trees; [arborist.md](gspro/arborist.md)). Both buttons write both:
   - Only drawn zones changed, item bindings unchanged: select the zones, command bar **Update N zones** (`update-zones-btn`; `vegetation-update` job: `gspro.py zones-patch` → `golfmap.zones.patch`, only their window respawns → `arborist.py lower`, about 10 s). Done when the result dialog reports the zones patched, no terrain skipped and "Arborist lower vegetation written".
   - Bindings changed, a new item, generated zones stale, the first planting, or Update says to: command bar **Update vegetation** (`plant-vegetation-btn`; job `vegetation`).
     It runs the generators → `zones:inner` export → `golfmap.zones.import {terrain: "inner", package: "GolfMap lower vegetation"}` → `golfmap.grass.apply`, a second round for new items → `arborist.py lower` → `golfmap.trees.dump` + `arborist.py trees`.
     Unity not open: the zones are exported, the Arborist file gets its lower vegetation, its trees stay as they were, and the report says so.
     CLI without Unity: `bun run grass:zones -- <course>` (zones export + `arborist.py lower`), then those two `unity_command`s (import, apply, import, apply for a new item); the Arborist file alone: `bun run gspro:export -- <course> arborist`.
     Done when the report says imported + applied with no unbound-item warnings, and "Arborist lower vegetation written" and "Arborist trees written" (a course without `docs/gspro/<course>/arborist-species.json`: "Arborist: not used by this course").
   - A warning that the trees Arborist draws in place of the course's own changed: run the two `golfmap.vsp.trees.trim` commands it names, then save and build ([arborist.md](gspro/arborist.md), "The ring rule").
   - The outer terrain is not refreshed by Update vegetation: `bun run gspro:export -- <course> zones:outer`, then `golfmap.zones.import {terrain: "outer"}` + `golfmap.grass.apply {terrain: "outer"}`. <!-- VERIFY: whether the user plants zones on the outer at all -->
5. **Verify**: `unity_screenshot` over the zone with `warmup` 20-80 (an unfocused 2018 editor never ticks VSP on its own); `golfmap.vsp` lists the item spawning with mask rules. Done when the grass/bushes are visible in the screenshot.
   - Bare where the mask says it should grow: run `golfmap.terrain.conform` (grass buried under the meshes).
   - VSP throws `JobHandle.Complete()` every frame: `golfmap.vsp.reset` or any `unity_sync push`.
6. **Save the scene**: pass `save: true` to the last import/apply, or ask the user (workflow 1, step 11). Done when saved.

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
| `golfmap.props.place [only=<asset>]` | **none: hand moves are kept** (see below). Only a prop whose spec entry moved more than 1 cm / 0.5° since it was placed goes back to the spec | `place(...)` calls in `docs/gspro/<course>/*-props.gen.py` (the only permanent, machine-independent place) |
| `golfmap.walls.build [only=<id>]` | single stones/boulders moved | `pose {dy, euler, scale}` in `docs/gspro/<course>/stone-walls.gen.py` (e.g. `H4_POSES`) |
| `golfmap.creeks.import` | spline points and moved spline objects | the creek feature in the web editor |
| `golfmap.waterplanes.build` | a moved reflection probe (the plane's lift is kept) | not capturable |
| `golfmap.paths.materials`, rough grass lip material | edits to the built materials | `<course>/Paths/path-surfaces.json` / the command's args |

`golfmap.course.refresh` never runs `props.place` (listed as pending) but does run `walls.build` near changed meshes and `creeks.import`.
Tree replants keep `<course>-<terrain>-tree-edits.json`: no capture needed there.

### Props: a re-place keeps what was moved by hand

Every `golfmap.props.place` records what it placed in `<course>/Props/placed.json` (per instance: the spec entry it came from, the world transform it set, and whether that transform is the user's). The next place compares and **keeps the user's transform** for any instance that is not where the tool left it; the spec takes an instance back only when the spec entry itself moved more than 1 cm / 0.5° / 0.1 % of scale since it was recorded. Instances are matched by asset and nearest recorded position, not by `#i`. Details and the decision table: [unity/README.md](../unity/README.md#a-re-place-keeps-what-was-moved-by-hand).

**Once per course, on a scene from before this existed**: there is no record yet, so a place would drop the hand moves one last time. `unity_command golfmap.props.record` seeds `<course>/Props/placed.json` from the props standing in the scene without touching any of them: per asset it pairs the instances to the spec's entries by nearest x/z, one to one, closest pair first (never by the object name's `#i`, which is the index the spec had when the prop was placed - a first version that trusted the names reported 88 "hand moves" on Vreta that were one index shift per asset). `mark=moved`, the default, marks the ones more than 1 cm off the spec entry they paired with; `mark=all` marks every instance, which also stops any prop being re-grounded after a terrain change until its spec entry moves; a prop only **rotated** by hand needs `mark=all` or the spec. Done when `pairing.pairedByPosition` plus `indexStillRight` covers the props in the scene, `unpairedInstances` and `notInScene` are empty or explained, `handPlaced` matches what the user remembers moving, and the next dry run shows them as `kept`.

**The loop is one button: Update props.** Furniture mode's **Update props** (`gspro-update-props-btn`), the GSPro board's **Props** row, or `bun run gspro:update -- <course> props` runs the whole chain as one phased job: each `docs/gspro/<course>/*-props.gen.py` under the pipeline venv's Python, `build_props.py` in Blender into `<Unity project>/Assets/GolfMap/<Course>/Props`, then `golfmap.props.record` (only when that folder has no `placed.json` yet) and `golfmap.props.place {save: true}`. The result dialog lists every `kept: <name> moved by hand <m> m / <deg>°`, warns per `specWon` / `handAdded` / `droppedHand`, and says the scene was saved. A spec or Blender script that has not changed since the last run is skipped (`unchanged: …`; `--force` builds anyway), and with no Unity editor open the spec is still written and the other two phases are skipped. The board's Props row carries the state to know before pressing it: "3 hand-placed props are kept on update", or that there is no `placed.json` yet ([export.md](gspro/export.md), "The props chain in full"). The commands below are what it runs, and what to run by hand when one phase fails.

Then the normal loop after moving props in Unity, by hand, is:

1. **Dry run**: `unity_command golfmap.props.place {dryRun: true}` (or `only: "<asset>"`). Its `rows` carry `kept: true` and a `rule` per instance; `kept` counts them. Done when every prop you moved shows `kept: true` and nothing you did not move does.
2. **Place**: the same without `dryRun` (add `save: true` to save the scene in the same call). Check `kept`, `handPlaced` and `specWon` in the result, `GolfMapSpelunk/<Course>_props.txt` (`KEPT (hand-placed)` lines with both transforms) and a `unity_screenshot`. Done when the props stand where the user left them.
   - `specWon` is the list to read out loud: those are hand moves the spec overrode because the `.gen.py` moved them too.
   - A warning per hand-placed instance the spec no longer has (a `place(...)` call removed).
   - `keepHandEdits: false` is the old behaviour (everything from the spec) if a clean rebuild is wanted.

**Carrying hand moves into the spec** is still needed to make them permanent - another machine, a `props.clear` plus a rebuilt spec, and a `build_props.py` run that renumbers instances all read the spec, not `placed.json`. The result's `handPlaced` rows have everything for it:

1. **Write back** into `docs/gspro/<course>/*-props.gen.py`, comment "set by hand in Unity <date>":
   - position: EPSG:3006 E = Unity x + inner sidecar `square3006[0]`, N = Unity z + `square3006[1]` (`GolfMapProps.cs`); `place()` takes e/n relative to the script's `E0, N0`.
   - yaw: `place()` sets Unity yaw = `yawDeg − 90` for prefab `axis: x` and Blender assets (`sx > 0` in the place report's `axis`), `yawDeg + 90` for mirrored Blender assets, `yawDeg` for `axis: z`; invert that. <!-- VERIFY: memory note says Blender assets use spec = Unity yaw − 90; check sx on Vreta's report before trusting either -->
   - height: `dz` = lift above the ground mode the spec uses.
   Done when the script holds every captured transform.
2. **Rebuild the spec + models**: **Update props** does this (and the place after it). By hand: `pipeline/.venv/Scripts/python.exe docs/gspro/<course>/clubhouse-props.gen.py` from the repo root (writes `*-props.json`), then `"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/<course>/clubhouse-props.json --out "<Unity project>/Assets/GolfMap/<Course>/Props"`. Done when `<course>/Props/props.json` is rewritten.
3. **Dry run, then place** as above. The spec now sits where the prop stands, so the plan shows `rule: spec-moved` (or `unmoved`) and nothing moves: that is the proof the capture is right. Done when positions/yaws/heights in the plan match what was in the scene (within a few cm / 0.5°).
4. **Save the scene** (`save: true`, or ask the user; workflow 1, step 11).

Reading the transforms out of the scene by hand still works when `placed.json` is missing (the first place after this existed, or another machine): `unity_scene` / `unity_command scene.find` under `/GolfMap Props`, `scene.inspect` (Transform) per instance, then the write-back above.

### Walls: capture the stone as a pose

Walls get no such record: a wall's stones are generated from its seed and have no identity in the spec, so there is nothing to key a hand move to. Capture a moved stone as `pose` (e/n of the pivot, `dy` over the ground under it, Euler, scale) in `stone-walls.gen.py`, run it with `--out "<Unity course folder>"`, then `golfmap.walls.build {only: "<wall id>", dryRun: true}`, then for real. A boulder with a `pose` is placed exactly so on every rebuild.

## 5. A path changed surface → Blender → Unity

Only for a changed **Path surface** (Draw mode's selection panel). A moved or redrawn path, a new road, and a grass track made a hard path (or back: a grass track is built as rough) need the SVG export and the OPCD build.

1. Draw mode: select a path, command bar **Update paths** (`update-paths-btn`; `ShapingService.apply` with `paths`). It runs, in order:
   - `gspro.py svg --paths-only`: rewrites `<prefix>-paths.json` next to the exported SVG, the SVG itself untouched. Its report names the shapes that changed surface and warns about what a surfaces-only update cannot carry.
   - `gspro.py shaping-global` and the shaping worker's sync: `golfmap.split_surfaces` re-cuts the roads of mixed surfaces; only what changed is re-shaped (any other shaping not yet applied goes with it).
   - `golfmap.course.refresh only=<changed objects> skip=paths.materials`, then `golfmap.paths.materials` over every path mesh (also when Blender changed nothing: a whole road given another surface).
2. Done when the result dialog says **Paths updated in Unity** with no warnings and its `Path meshes:` line shows the surfaces. Then save the scene (ask the user; workflow 1, step 11).

Needs the SVG exported once, the course's `.blend` and its Unity project open, like **Update meshes (this feature)** on a feature with a Blender recipe.

## 6. Clean the photo, in the editor or an image editor, and put it into Unity

The cleaned photo is **one image per site**: `data/sources/<siteId>/ortho-<vintage>.cleaned.tif`, 8192 x 8192 px on the inner terrain square (the square of every GSPro ortho export and of the Unity textures). It is made from the pristine photo the first time anything touches it. The Clean tool, an import and an undo all change that file directly; there is no edit log, nothing to bake and nothing to export before importing. Builder mode, a built map.

1. **Clean in the editor.** Create › Clean photo. The photo's pixels load (a few seconds; about 15 s the very first time, when the file is made). Then paint with PhotoCraft's tools: **Clone** and **Heal** (Alt-click a source, drag), **Spot** (paint over a blemish), **Remove** (paint over or loop around an object). Every stroke changes the photo and is saved at once: the status line reads "All changes saved". Ctrl+Z / Ctrl+Shift+Z undo and redo strokes. Done when the status line reads "All changes saved" and the map shows the result with "Show cleaned photo" on.
2. **Or edit outside.** Clean panel › **Download photo (PNG)** (about 10 to 20 s). Edit it in any image editor and save it at **8192 x 8192 px, uncropped**, as PNG, JPEG or TIFF. Then **Import a photo**: the image becomes the cleaned photo, whatever is on it. An image with transparency is laid over the photo. Done when the line under the input reads "Imported: N pixels changed".
   - A PNG edit changes only what you edited and imports in seconds. A JPEG, or a save with a colour-profile conversion, changes every pixel: it still imports, but every map tile is re-cut (about 45 s on Vreta) and the photo takes the editor's colours.
   - Another pixel size is refused with the two sizes in the message.
   - Do not pick the file while the editor is still writing it: the upload stops and is answered after 30 s with how far it got.
3. **Undo last session** puts back the photo from before the last editing session (everything painted since the tool last loaded the photo) or import, up to 5 steps. Done when the count beside the button drops by one.
4. **Onto the Unity course meshes.** With the course's Unity project open: command bar **Update photo** (the Photo target's whole chain through the GSPro status board — the cleaned photo as the darkened, green-tinted `-meshes` texture onto the course meshes, no building removal or forest floor, plus the outer terrain's texture), or the board's Photo row › **Inner cleaned photo → Unity meshes** for the single file with the panel's brightness, tint and two cleaning boxes. Both run the `unity-ortho` job: render, then `golfmap.orthos.apply` with the `-meshes` file. About 40 s. Done when the result dialog's report names the Unity texture it was put onto; the chain saves the scene itself and says so (`Saved …`), else it asks (workflow 1, step 11).

Without the browser: `bun run photo -- info|export|import|undo <course> [file]` (`scripts/cleaned-photo.ts`, the same service), then **Refresh** in the Clean panel.

Files, under `data/sources/<siteId>/`: `ortho-<vintage>.cleaned.tif` (the photo), `cleaned-history/<n>.tif` (the photo before each of the last 5 changes: the undo steps), `cleaned-work/` (the kept download PNG, uploads and edit batches while they are processed). The pristine `ortho-<vintage>.tif` is never changed. Map tiles of the cleaned photo: `data/tiles/<siteId>/ortho-sim/` (only tiles a change touched; the rest fall back to the pristine tiles, and are a little sharper at the deepest zooms than the 8192 px photo).

Left from the patch-log model this replaced (2026-10-08), safe to delete by hand once the cleaned photo looks right: `ortho-<vintage>.patched.tif`, `patches/`, `exports/`, `sim-frame.json`. A site that had a `.patched.tif` got its cleaned photo from it, so those edits are in the photo.


### Boundaries for AI photo cleanup

Clean photo › **Areas** stores the cleanup scope separately from course features and photo edits. **Area to clean** includes ground, and cleanup there is limited to the mapped tees, fairways, roughs and greens. **Clean everything** includes ground and cleans all of it, whatever course feature is mapped there or none (trees standing just outside a drawn rough, for example). **Keep unchanged** excludes ground, regardless of drawing order and of either other kind. With no included areas, nothing is eligible. The green preview is the union of both including kinds with every protected area cut out; purple on top of it marks the Clean everything part; orange marks protected ground. These boundaries guide external cleanup, not the manual stamp or inpainting tools.

Choose **Area to clean**, **Clean everything** or **Keep unchanged**; the map cursor becomes a crosshair. Drag to trace a boundary or click separate corners, then **Finish area** (or Enter) to save. Left-drag draws while a draft is active; Ctrl/Cmd-drag pans. The panel shows the number of corners placed. Backspace removes the last corner and Escape cancels a draft. Select a saved area to rename, redraw or delete it. **Undo area change** restores the previous set during the current editing session. Areas persist in the server database, belong to the site's shared photo, and are visible to every course on that site. Concurrent changes are rejected rather than overwritten; cancel the draft and **Reload areas** before retrying.

**Download cleanup boundary** exports the effective WGS84 MultiPolygon as GeoJSON, including protected holes, as the feature with `properties.type` `cleanup`. When a Clean everything area is drawn, a second feature of type `cleanup-force` holds the part of it to clean regardless of course features (protected ground cut out of it too). The cleanup skill can pass this file directly to `cleanup.py maps --cleanup-aoi <file> --aoi-crs EPSG:4326`, along with the original image, course surface geometry and the image's exact EPSG:3006 frame. It must not use this boundary's bounding box as the image frame. This only defines where edits are allowed; no image generation runs when saving or downloading a boundary. Review the composed result, import it through **Import a photo**, then **Update photo** as above.

Authenticated builder APIs: `GET /api/cleanup-areas?courseId=<id>` reads the versioned source areas; `POST /api/cleanup-areas` saves `{courseId, version, areas}`; `GET /api/cleanup-areas/export?courseId=<id>` returns the effective GeoJSON. The export carries `siteId` and `version` so a cleanup job can record exactly which saved scope it used.

## 7. A rock slab (berghäll) in the ground

> "There is berghällar here in reality" / "a bit too small" / "too dark, doesn't look like the granite on hole 10"

A low slab of bedrock lying in the slope, with grass growing in over its edges. It is a piece of the course meshes cut out into its own mesh (`Spline_hall_<n>_Rock_-_Mesh`), not boulders placed on the ground (a klippa or a stone wall: workflow 4, `golfmap.walls.build`).

1. **Draw it.** Web Draw mode, feature type **Rock slab**, the outline of the rock seen in the orthophoto. Selection panel: **Margin** (default 1.5 m: the cut-out reaches that far beyond the drawing; an outline traced tight to the visible rock read too small in game) and **Texture tile** (default 4 m). Done when the slab shows on the map.
   - It is no OPCD surface: it is not in the SVG. Slabs are kept 0.8 m apart; a later one is trimmed, or skipped with a warning when nothing sensible is left.
   - Keep it 2 m or more off semi rough, tees and greens: nearer than that the tall grass cannot cover its edge (the surfaces' clearance wins) and a bare mesh edge shows.
2. **Rock material, once per course.** `unity_command golfmap.slabs.materials {material: "<asset path of a tiling rock material>"}` writes `<course>/rock-slabs.json` (Vreta: `Assets/GolfMap/Vreta/Walls/granite_boulder (rock color pond-klippa).mat`, physics `GSPstone`). Done when the result lists the material and `physicMaterial`.
3. **Shape, sync, replant: one command.** `bun run shaping -- <course>` (or the command bar's **Update meshes**, or **Update meshes (this feature)** with the slab selected in Draw mode): regenerates the layers (one `golfmap.cut_out` per slab, last in `00-global.gen.json`), replays them in Blender, exports the changed FBX, runs `golfmap.course.refresh only=<changed>` (slab material and physics, surface map re-exported because a slab is among them), then plants the vegetation again so the tall grass leaves the rock but for a fringe over its edge and some patches. `--dry-run` first shows what would change. Done when every phase is `ok` and "Surface map and grass" names the slab.
   - Never drive the shaping worker by hand without regenerating the layers first: the `.gen.json` files on disk can be older than the database, and a sync then puts older meshes into Unity.
4. **Verify.** `unity_screenshot` with `restore: true` (the user's Scene view stays where it was), from 25 m up and from a golfer's eye: rock colour against the course's other granite, no straight bare mesh edge, grass patches. `ground.probe {x, z}` on the slab must hit the slab mesh first, the terrain 1 cm under it. Then ask the user to save the scene (workflow 1, step 11).

A slab drawn before this workflow existed may sit in a hand layer (`docs/gspro/<course>/shaping/20-rocks.json`, Vreta's two); the same slab drawn in the app as well would be cut twice: remove it from one.

Not built yet: added geometry (a slab keeps the meshes' ~1.2 m triangles and heights), and none of it has been checked in the GSPro runtime.
