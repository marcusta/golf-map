# unity — AGENTS

C# editor scripts that move golf-map output into an OPCD/GSPro Unity course project (Unity 2018.2, C# 6). Nothing here is part of the golf-map build; the Unity project lives outside the repo and is driven through `unity/mcp/` (the `unity` MCP server).

Read first for foliage/material problems: [tree rendering fixes](../docs/tree-rendering-fixes.md); record confirmed fixes there, with the Unity versus GSPro verification.

## Pointers

- Feature docs (terrain importer, spelunk, tree planter, palette editor, zones, buildings, bunkers, cart paths, vertex paint (materials, previews), FBX sync, creeks, water planes, props, stone walls): [README.md](README.md). Biome planting walkthrough: [MANUAL-PLANTING.md](MANUAL-PLANTING.md). Prefab catalogue: [CATALOGUE.md](CATALOGUE.md).
- Per-tool agent notes (bunker/paint/path rules, sync, refresh, creeks, props, walls, zone CLI, palette bridge): [docs/unity-tool-notes.md](../docs/unity-tool-notes.md).
- Grass (where it grows, palette, loop): `.claude/skills/grass-planting/SKILL.md`; palette-building facts in its `references/unity-grass-palette.md`.
- Multi-step loops (Update terrain / Pull from Unity / conform order, zones → plant, props/walls hand-edit capture before re-place): [docs/workflows.md](../docs/workflows.md).
- Arborist (a Unity player, not the editor): the mod in [ArboristMod/](ArboristMod/README.md) has its own bridge and `call.ts`; the `unity` MCP tools never reach it. Start at [docs/gspro/arborist.md](../docs/gspro/arborist.md).
- Course build without the GSP > Build Course window: `golfmap.course.build` (`Editor/GolfMap/GolfMapCourseBuild.cs`; saves the scene, runs OPCD's builder, about 12 minutes during which the editor does not answer: call with a long timeout).
- What costs frame rate, ranked per category, in the editor and in GSPro: [README.md](README.md#performance-ranking) (`golfmap.perf.report`, `ArboristMod/perf.ts --rank`; categories are rules in `Editor/GolfMap/GolfMapPerfCategories.json`).
- Script copies, project paths, versions: [install.json](install.json), `unity/mcp/README.md`, root AGENTS.md.
- Matcher tests: `bun test unity/building-matching.test.mjs unity/tree-matching.test.mjs unity/props-matching.test.mjs`; performance ranking model: `bun test unity/perf-rank.test.ts`. Course-less compile check: `unity/check-planter.ps1 [-UnityProject <path>]` (add new files to its list; writes `tree-export/`).
- New bridge commands: `[BridgeCommand]` static methods in `Editor/GolfMap/GolfMapBridgeCommands.cs` or beside the tool they wrap; keep `Editor/GolfMapBridge/` free of `GolfMap.Editor` references.

## Workflow (every session)

1. `unity_sync` mode `check` before any change: another agent or the user may have edited the Unity copy. `unity-changed`/`unity-only`: `pull` into the repo first. `conflict`: diff, merge in the repo, `push` with `force`.
2. Edit in the repo, then sync to Unity (`.meta` files stay Unity's and out of the repo).
3. `unity_sync` mode `push` recompiles and returns compile errors and new console errors; stack-trace line numbers match the repo file once synced.
4. Verify yourself: `unity_menu`, `unity_command`, `unity_console since=<seq>`, `unity_scene`, `unity_screenshot`. Ask the user only for what needs a human eye or a modal dialog.
5. Pass `project` when more than one editor is open.

## Gotchas

One line per gotcha: leading word, when it bites. Full text of each: [docs/unity-gotchas.md](../docs/unity-gotchas.md) (same bold words).

Kept inline (tool behaviour, bites while editing the tools):
- **FBX sync**: an overwritten FBX does not update its scene object in place (old geometry, z-fighting); `golfmap.meshes.sync` deletes and re-adds the object. Test sync changes with real geometry changes, checked in the scene.
- **Water planes**: `Spline_*`-named but not ground; keep `IsWaterPlane` out of every ground/course-mesh filter.
- **Stone walls**: two styles, `wall` (dry-stone, flat-faced stones) and `rose` (stenröse, heap of rounded stones); both wanted, Vreta tee walls are real walls. Capture stones moved by hand as `pose` in the generator before any rebuild.
- **Vertex paint**: Unity never moves or adds course-mesh vertices and paints them only as temporary previews (colour-only copies under `<course>/PaintedMeshes/`, gone at the next FBX import); rules and wall ground are Blender layers 80-walls / 90-paint (`gspro.py shaping-walls` / `shaping-paint`). Unity keeps the materials (`golfmap.paint.materials`: creek bed, pond shore, wall stone). Stix rough grass reads only the red channel.
- **Path materials**: change the spec `<course>/Paths/path-surfaces.json`; built materials are rebuilt from it.
- **No course names in code**: paths, scene and terrain names come from the active `GolfMapCourse` (`GolfMapCourses.Require()` / `.For(component)`).

Indexed (read the full text before touching the area):
- **Bushes white** towards the sun: `_BackFaceMirrorNormal`, glossy leaf materials; fix with a palette `material` override.
- **VSP stuck on JobHandle.Complete()**: asset refresh between VSP's Update and LateUpdate; `golfmap.vsp.reset` or a script reload.
- **VSP draws nothing** after a refresh until its Update runs; unfocused 2018 editor never ticks it, use bridge `screenshot`/`editor.tick`.
- **VSP plants on the terrain**, players see the meshes: `golfmap.terrain.conform`, then `UnityTerrain.RefreshTerrainData()` after any heightmap change.
- **Screenshot ground heights**: `eye=<m>` is over the collider surface, not the heightmap.
- **palette.json**: never `JsonUtility`; go through `GolfMapPalette.Load/Save`.
- **VSP cell edges**: whole-metre stems sit on 100 m cell edges; keep the 1 cm nudge in `PlantStorage`.
- **One object, two panels**: single `GolfMap Trees` object, role-fixed inner/outer; no append mode, no editable terrain/storage field.
- **Planter is a scene component**: settings live on `GolfMapTrees`; call `Dirty()` after changing them from code.
- **Tree edits file** `<course>-<terrain>-tree-edits.json`: a replant or survey regeneration keeps it; `golfmap.trees.edit` writes it by tree id.
- **Arborist models** in the palette (`arborist:<label>`, models.json beside palette.json): no prefab and never in VSP; their trees exist only in `<prefix>-<terrain>-placements.json`. Keep Unity's palette.json/models.json equal to docs/gspro/<course>/.
- **Arborist proxies** (`golfmap.trees.proxies`, menu GolfMap > Trees > Show Arborist proxies): Scene-view-only stand-ins for `arborist:` placements; the tree editor edits them as tree-edit records only (no replant). Never turn them into scene objects. [README](README.md#arborist-proxies).
- **Routing file** `<prefix>-<terrain>-routing.json` (`bun run arborist -- route`): with one, the planter stores only vsp models routed `own`; the rest are placements only. No routing file = every vsp model stored (Vreta); the app removes the file of a course whose vegetation-rules.json has no `routing`. A routing older than the trees export or the tree edits (a Unity-side edit) is planted with a WARNING to route again. `golfmap.trees.edits.applied` returns the trees after `GolfMapTreeEdits.Apply` (parity test `unity/tests/tree-edits-parity.test.ts`).
- **VSP draws one mesh per LOD**: multi-renderer LODs render as blobs; use `VS_` or baked variants.
- **VegetationSystemPro name**: GSPro resolves the system by that exact name; build via `GolfMapVspRig.cs`, find systems by storage asset.
- **Copied tree shader names**: never rename; GSPro's forked VSP throws and drops every tree in the package. Stock names only.
- **Forst CTI trees**: tune colour through the palette editor or `prepare-cti-maps.py`, never an NM material.
- **Asset files replaced** under an open 2018.2 editor do not reload; revert in memory or `Resources.UnloadAsset`.
- **Catalogue item outlives the palette**: `GolfMapVspRig.PruneCatalogues` on plant; retiring a planted item means replanting.
- **Persistent storage / source 42 / report path**: storage is never reinitialised; imported trees carry VSP source id 42.
- **Controller-owned properties**: VSP overwrites material properties on its copies; change the item's controller settings (`GolfMapVegLive.ControllerProperty`).
- **Graphics.CopyTexture** (2018.2): `Apply(false)` the Texture2DArray after, and the source before when just compressed.
- **Asset copies** leave a `GolfMapCourse` reference stale; resolve the course folder first.
- **Leaf colour edits** need `Refresh vegetation from materials`; **`_BackFaceMirrorNormal`** stays 0 on leaves (birch excepted).
- **Foliage diagnosis**: probe with pure red/black tints, not by eye.
- **Zone masks** are sampled on the CPU: RGBA32, uncompressed; never "correct" the channel remap in `TextureMask.cs`.
- **One mask channel per item**: never `DeleteTextureMaskGroup` (turns off the include filter, item spawns everywhere).
- **GolfMapTrees runtime folder**: lives outside Editor so the scene saves it.
