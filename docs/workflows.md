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
10. **After conform** (redo all of these after any later terrain change): **Plant vegetation** (workflow 2), `golfmap.props.place` (workflow 4 first), anything checked by screenshot. Done when the `pending` steps are done and verified in a screenshot.
11. **Save the scene** (ask the user; the commands mark it dirty, never save). Done when the title bar loses the `*`.

A terrain change after step 9 = back to step 4 (capture), then 5-11 in order. Unity sculpts and anything hand-placed in the scene are the only things a re-run can lose.

## 2. New vegetation area in the web editor → visible in Unity

> "I drew a vegetation area… but it doesn't show up. What more is needed?" / "When I add a new veg area in golf-map editor, what is the way to get it to show in Unity?"

Drawing stores the zone in `data/app.sqlite` only; nothing reaches Unity until it is exported and imported.
Batch: the user prefers several zone edits, then one update/replant, not one per edit.

1. **Draw** in web Vegetation mode: pick the zone type (and variant) in the command bar's zone-type picker, draw. Done when the zone shows in the stack panel with the intended type/variant.
2. **Check the type grows something**: a zone type or variant with no items bound plants nothing (the planting report warns "binds no items"). Bind: `bun run zones -- bind <course> <type> [--variant <v>] --palette <file>` or `<item>=<weight> ...` ([grass-planting skill](../.claude/skills/grass-planting/SKILL.md)). Done when the variant picker no longer says Default is empty for it.
3. Repeat 1-2 for every area in the batch.
4. **Into Unity**, with the course's Unity project open:
   - Only drawn zones changed, item bindings unchanged: select the zones, command bar **Update in Unity** (`vegetation-update` job: `gspro.py zones-patch` → `golfmap.zones.patch`, only their window respawns). Done when the result dialog reports the zones patched and no terrain skipped.
   - Bindings changed, a new item, generated zones stale, the first planting, or Update says to: command bar **Plant vegetation** (job `vegetation`).
     It runs the generators → `zones:inner` export → `golfmap.zones.import {terrain: "inner", package: "GolfMap lower vegetation"}` → `golfmap.grass.apply`, a second round for new items.
     CLI without Unity: `bun run grass:zones -- <course>`, then those two `unity_command`s (import, apply, import, apply for a new item).
     Done when the report says imported + applied with no unbound-item warnings.
   - The outer terrain is not refreshed by Plant vegetation: `bun run gspro:export -- <course> zones:outer`, then `golfmap.zones.import {terrain: "outer"}` + `golfmap.grass.apply {terrain: "outer"}`. <!-- VERIFY: whether the user plants zones on the outer at all -->
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

## 6. Clean the photo in an external image editor

For trees, shadows and people that are quicker to remove in Photoshop-style tools than in the Clean tool. Builder mode, a built map. The export is the cleaned photo (pristine + every baked patch) as one square 8192 px PNG; the import stores only the pixels you changed, as one `raster` entry in the ortho patch log. Plan and decisions: [feature-ortho-export-import.md](feature-ortho-export-import.md).

1. **Export.** Clean tool › **External edit** › **Export cleaned photo (PNG)**. Bake pending edits first: unbaked ones are not in the export. 15 to 20 s; longer when the server must replay the patch log first (mask patches re-run LaMa). Done when the export is listed with a Download link.
2. **Edit** a copy of the PNG (Download, or the file in `exports/<n>/`; the server refuses an import against an export whose hash changed). Save as **PNG at the unchanged size** (8192 × 8192, or the frame's `size`), 8 bit RGB, **no colour-profile conversion** (no convert to sRGB, no embedded-profile change: it shifts every pixel and the whole frame reads as changed). Pixels within 2 levels per channel of the export count as unchanged, and changed regions under 4 pixels are dropped as noise. The panel and the server take PNG only (a JPEG edit goes through the CLI with an explicit tolerance). Done when the edited PNG has the export's size.
3. **Import.** Pick the export the file was edited from (**Edited from**, the latest by default), then the file; the upload starts at once. The server compares, bakes and retiles inside the request, so a large change takes minutes. Done when the summary reads **Imported as patch N** (changed pixels, box in metres, tiles rewritten) and the map shows the new photo with "Show cleaned photo" on. **No changes found** means nothing was stored.
   - The patch is **one bounding box** around everything you changed: two edits at opposite ends of the course retile every tile between them. The summary warns above 30 % of the frame. Import far-apart edits as separate files, each a copy of the export holding only its own edits.
   - **Revert last patch** undoes the import (replays the log without it and deletes `patches/<n>.png`). Done when the baked-patch count drops by one.
4. **Repeat.** Export again (the new export holds the import and any Clean-tool patches since), edit, import against that export. An import against an older export still lands: it carries only its own changes.
5. **Onto the Unity course meshes.** With the course's Unity project open: Clean tool › **Apply in Unity** (bakes pending edits first; the patched photo as the darkened, green-tinted `-meshes` texture, no building removal or forest floor), or export panel › Cleaned orthophoto textures › **Inner cleaned photo → Unity meshes** (the same with the panel's brightness, tint and two cleaning boxes). Both run the `unity-ortho` job: render, then `golfmap.orthos.apply` with the `-meshes` file. Done when the report's last lines name the Unity texture it was put onto; then save the Unity project (ask the user).

Files, under `data/sources/<siteId>/`: `sim-frame.json` (the frame), `exports/<n>/` (`ortho-sim-<n>.png`, `ortho-sim-<n>.pgw` world file in EPSG:3006, `export.json`; kept, never rewritten), `patches/patches.json` + `patches/<seq>.png` (the log; an import's PNG is RGBA, cropped to the change), `patches/.incoming/` (the upload while it is processed). The pristine `ortho-<vintage>.tif` is never changed; `ortho-<vintage>.patched.tif` is the replayed result.

**The frame is fixed on the first export** and shared by every later export and import. It is the inner terrain square, `manifest.terrain.inner.square3006`, at 8192 px: the square every GSPro ortho export and the Unity textures are rendered over, so an edited export lines up with them pixel for pixel. A site built before the manifest carried that square gets its `bounds` squared instead (side rounded up to 10 m), which need not be the terrain square. A frame made that way, or made before 2026-10-07 (Vreta's first export: 2090 m round the 2050 m terrain), stays as it is: imports against it still land in the right place, since the patch is stored georeferenced, but its PNG is not the Unity texture's grid. To move a site to the terrain square, import every outstanding edit first, then delete `sim-frame.json` and `exports/` by hand (this orphans the old exports) and export again; or write the frame by hand before the first export:

```json
{ "extent3006": [529030, 6486669, 531080, 6488719], "size": 8192 }
```

`extent3006` is `[west, south, east, north]` in EPSG:3006 metres (there is no CRS field; it is always read as 3006) and must be a **square**: east minus west equals north minus south to within 1 µm, and both are positive. `size` is the pixels per side, a positive whole number. The square to copy is the one the texture was exported over: `manifest.terrain.inner.square3006` in `data/tiles/<siteId>/manifest.json`, or the `--square-3006` of the `gspro.py ortho` run. Ground in the frame that the photo does not cover exports black; photo outside the frame cannot be edited. Done when the first `exports/1/export.json` carries your `extent3006` and `size`.

Import without the browser upload (same service, same patch entry): `bun run ortho:import -- <course> <edited.png> [--export <n>] [--tolerance <t>]`, then **Refresh** in the Clean panel. An upload that brings no bytes for 30 s is answered 408 with how far it got.

Without the server: `export-ortho-square` and `import-ortho-square` in [pipeline/README.md](../pipeline/README.md).
