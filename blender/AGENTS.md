# blender — AGENTS

Blender stage of golf-map → OPCD → GSPro: bunker tooling run on the OPCD course `.blend` (after SVG
import and conform) and the paint conventions shared with Unity. Not part of the build.
[README.md](README.md) = what exists and how to run it. [RESEARCH.md](RESEARCH.md) = OPCD/Afrod vs
Bunker Studio, ce.simgolf's method, the lip-tool plan, Vreta findings. Read both before bunker work.

## Layout

| Path | What |
|---|---|
| `conventions/bunker-channels.json` | Vertex-paint conventions (`opcd-default`, `ce-simgolf`, `golfmap` = the canonical roles shaping leaves): colour per ring/edge and which material channel fills each paint channel. Also read by `unity/Editor/GolfMap/GolfMapBunkerChannels.cs`; copy to `Assets/GolfMap/<Course>/` after an edit. |
| `tools/fbx_sync.py` (+ `fbx_sync_test.py`) | Add-on + headless: export only changed meshes to the FBX folder (OPCD names/settings, fingerprints in `<folder>/.golfmap-fbx-sync.json`). Unity counterpart: `golfmap.meshes.sync`. |
| `tools/bunker_paint_report.py` | Headless report: which convention each bunker/blend is painted with. Same rings and scores as Unity's **Check paint**. |
| `tools/shape_prepare.py` | Headless shaping step 2 ([SHAPING-PLAN.md](SHAPING-PLAN.md)): fresh OPCD `.blend` → OPCD's Import Terrain OBJ + Conform to Terrain → `<name>.conformed.blend` (never saves the source) + report. |
| `tools/shape_coords.py` | EPSG:3006 ↔ `.blend` x/y/z from the inner DEM sidecar (pure Python, self-test). |
| `tools/shape_apply.py` | Headless shaping step 3: replays `docs/gspro/<course>/shaping/NN-*.json` on the conformed cache (Afrod ops driven like the UI, seeded per feature; `golfmap.flatten_footprint` with protected play surfaces; `golfmap.weld_tjunctions`, automatic after `afrod.cutcartpaths` (after the cut's slivers are collapsed, `sliverM`), then the cut's paint restored or kept as crisp joints per path surface; `golfmap.split_surfaces` cutting a mixed-surface road into one object per surface; `golfmap.cut_out` lifting an EPSG:3006 outline (a rock slab) out of the meshes under it as its own `Spline_<name>_Rock_-_Mesh`, README "Shaping: cut-outs"; composite recipes through shape_studios) → `shaping-report.json` (per-op moves by type, warnings, seams/T-junctions, `changedPlaces` per op unit for Unity's Review) + changed FBX into a staging folder. Holds the headless/determinism shims for Afrod and Edit Mesh Tools, the exact speed shims (knife cut, paint, smooth ripple), the op units (`plan_units`: reads per feature group) and the op-result cache (`<blend folder>/shaping-staging/cache`, keyed on op + unit + input mesh state hashes; README "Shaping: apply"). Never saves the `.blend`. |
| `tools/shape_worker.py` | Long-running headless Blender on `127.0.0.1:8766` (`GOLFMAP_SHAPING_PORT`): `GET /status`, `POST /load`, `POST /sync` (restore affected meshes to before the first changed op, re-run only the units that reach them, export just their FBX + manifest), `POST /shutdown`. HTTP thread only queues; bpy runs on the main thread. README "Shaping worker". |
| `tools/shape_surfaces.py` (+ `shape_surfaces_test.py`) | Pure Python for `golfmap.split_surfaces` (a merged road of mixed surfaces cut into one object per surface): the `<svg stem>-paths.json` sidecar, surface regions and seams (rank, junction pieces, slits, nearest fill), fade lines. Tests: `python blender/tools/shape_surfaces_test.py`. README "Shaping: surfaces of a merged road". |
| `tools/shape_layers.py` (+ `shape_layers_test.py`) | Pure Python for the above: layer format validation, SVG parsing + SVG choice, selectors by feature id/type/hole, seeds, footprint maths. Tests: `python blender/tools/shape_layers_test.py`. |
| `recipes/library.json` (+ our recipes in `recipes/`) | Afrod recipe library: id, file (third-party ones stay in `$GOLFMAP_AFROD_RECIPES`), author, surfaces, join, what each colour means per mesh/blend, one default per surface, notes. README "Recipe library". |
| `tools/shape_recipes.py` (+ `shape_recipes_test.py`) | Pure Python: recipe formats (Afrod list / `golfmap-recipe-v1` steps from any toolset), step validation (studio steps first, one per recipe), library `params` -> step fields (`set`/`scale` by op, command or tag), `overrides` `{param: value, seed}`, paint-colour translation, `ringsFromSeam` inset shift, high-side maths. Tests: `python blender/tools/shape_recipes_test.py`. README "Composite and parameterised recipes". |
| `tools/shape_studios.py` | Bunker Studio and Shoreline Studio driven headless through their own operators (Preview -> Validate -> Apply) as recipe steps: scene props, the captured high side toward the hole's green, the scaled preset (faceSteepness / highSideStrength) swapped in only during the step, studio bookkeeping removed after Apply; blend row count for `ringsFromSeam`. |
| `tools/shape_edgefade.py` (+ `shape_edgefade_test.py`) | Pure Python for `golfmap.path_edge_fade` (a gravel / dirt path's fringe strip widened into the path and painted as a noisy red-grass / green-path ramp): value noise, `strip_value`, `paint`, param validation. Tests: `python blender/tools/shape_edgefade_test.py`. README "Shaping: path edge fade". |
| `tools/shape_paint.py` (+ `shape_paint_test.py`) | Paint normalisation: `remap_after_recipe(objects, recipe)` / `remap_opcd_default(objects)` rewrite a recipe's (or OPCD's) colours into the `golfmap` roles as a linear map of channel weights (sRGB bytes, no operators). Pure maths testable with plain Python. |
| `tools/vehicle_prefabs.py`, `tools/vehicle_models.py`, `tools/vehicle_models_10k.py` | Headless: a vehicle pack's Unity prefabs (30-43 renderers a car) merged into 2-renderer FBX with the pack's materials, plus ~10k-triangle background versions and `vehicles.json`. Work files in `tree-export/vehicles-lowpoly/`. README "Low-poly vehicles". Unity counterpart: `golfmap.vehicles.build` (`GolfMapVehicles.cs`). |
| `tools/build_props.py` + `tools/props_kit.py` | Headless: course props (buildings, shelters, cars, flags ...) from a spec (`docs/gspro/<course>/*-props.json`) into FBX + generated textures + a `golfmap-props-v1` manifest. Unity counterpart: `golfmap.props.place` (`GolfMapProps.cs`). |

## Environment

| | |
|---|---|
| Blender | `C:\Program Files\Blender Foundation\Blender 4.5\blender.exe` (4.5 LTS, Python 3.11). 5.2 also installed. OPCD needs 4.2.2+. |
| Course `.blend` | `D:\gspro_courses\vreta-opcd\vreta_svg_1988.blend` (Vreta, fresh from OPCD, ~190 MB; the shaping cache `vreta_svg_1988.conformed.blend` next to it has terrain.obj imported + conformed, ~370 MB). **Generated by OPCD's tools, so the name changes** — ask if it's gone. |
| Add-ons | OPCD Mesh Editing Tools 3.5.8 (+ Afrod panel), Bunker Studio 0.11.5, Shoreline Studio 0.5.5 in `%APPDATA%\Blender Foundation\Blender\4.5\extensions\user_default\` — read their source there. |
| Blender MCP | `mcp__Blender__*` needs Blender running with the MCP add-on; when it isn't connected, run headless (`blender -b file.blend --python script.py -- args`). |

## Rules

- **Never save the course `.blend` from a script.** Report only; geometry edits go on a copy or are run by the user in the UI.
- **Python 3.11:** no nested same-type quotes in f-strings, no `type` statements. Test headless before claiming a script works.
- **Pairing:** OPCD metadata first (`opcd_parent_id`, `opcd_kind` = `mesh`/`blend`); names as fallback (`<key>_Bunker_-_Mesh`, blends start with `<key>_`, incl. split `<key>_piece1_Rough_B_Bunker_-_Blend`). Unity only has names.
- **Paint colour** = dominant channel; black when max(r,g,b) < 0.25. Same rule in Unity — change both together.
- **Shaping ops must be exact and declare their reach.** A new op type needs a `plan_units` entry whose `reads` cover every mesh it can read or move (the op cache keys on them, the worker restores and re-runs by them); an op that moves a mesh outside them is reported as an `escape`. A speed shim must leave the positions, colour and FBX-fingerprint hashes of a full Vreta apply unchanged (compare with `GOLFMAP_SHAPE_NO_FAST_SHIMS=1`). Any edit to `shape_apply.py`/`shape_layers.py` invalidates the op cache (it keys on their source); recipe units also key on `shape_paint.py`, `shape_recipes.py`, the library and, with a studio step, `shape_studios.py`, the Bunker/Shoreline Studio sources and the SVG's greens.
- OPCD Unity model: each mesh has a `MeshChannelMaterialsStore` → `ChannelMaterials` (render material + per paint channel a source material/channel; MAHS shader keeps channels under `_Red*`/`_Green*`/`_Blue*`/`_Black*`). Never edit OPCD's original materials; build copies (Unity `GolfMap > Bunker Materials`).
