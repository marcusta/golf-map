# unity — AGENTS

For foliage/material problems, read [tree rendering fixes](../docs/tree-rendering-fixes.md)
first and record confirmed fixes there, including Unity versus GSPro verification.

C# editor scripts that move golf-map output into an OPCD/GSPro Unity course project. Nothing
here is part of the golf-map build; there is no Unity project in this repo. Feature docs:
[README.md](README.md) (terrain importer, spelunker, tree planter, building planter), [MANUAL-PLANTING.md](MANUAL-PLANTING.md)
(biome planting walkthrough), [CATALOGUE.md](CATALOGUE.md) (prefab catalogue).

Bunkers: `GolfMap > Bunker Materials` (`GolfMapBunkerMaterials.cs` + `GolfMapBunkerChannels.cs`) checks
vertex paint and builds copies of OPCD's `ChannelMaterials` from `bunker-channels.json` (owned by
[blender/](../blender/AGENTS.md); copy into `Assets/GolfMap/<Course>/` after an edit), with restore.

Vertex paint: `GolfMap > Vertex Paint` (`GolfMapVertexPaint.cs`, bridge `golfmap.paint.apply|restore|survey|probe`)
generates paint from `<course>/paint.json` into mesh copies under `<course>/PaintedMeshes/` and rebuilds the Stix
cache (the "bake"). Stix grass on rough reads only the **red** channel (blade chance); never paint the FBX meshes
in place. See [README.md](README.md#vertex-paint).

Course meshes after a Blender export: `golfmap.meshes.sync` (GolfMap > Meshes > Sync from FBX folder,
`GolfMapCourseMeshes.cs`) adds FBX without a scene object under the course's mesh parent (collider + OPCD's
`GameObject/Set Default Materials`, run on the selection), reports/prunes objects whose FBX is gone, and re-runs
vertex paint where a painted copy is older than its FBX. FBX overwritten in place update their objects by
themselves: never delete and re-drag. Blender side: `blender/tools/fbx_sync.py` exports only changed meshes.

Terrains after the first import: `golfmap.terrain.update` (GolfMap > Terrain > Update heights from export) puts a new heightmap export onto the existing terrains in place (backup, VSP refresh, outer sink kept); golf-map's "Heightmap → Unity" calls it.

Creeks: `GolfMap > Creeks` (`GolfMapCreeks.cs`, bridge `golfmap.creeks.import`) builds one R.A.M. `RamSpline` per creek
from `<prefix>-inner-creeks.json` at the water surface golf-map digs the bed below. R.A.M. types are resolved by name.
See [README.md](README.md#creeks-ram).

Buildings (`GolfMapBuildingPlanter.cs`, `building-matching.mjs` + `match-building-palette.mjs`) follow the
tree assignment pattern — offline matcher writes a report keyed by stable id, overrides persist, the Unity
window validates then applies — but plant plain GameObjects under the terrain, never VSP (colliders). The
flat pad under each building is a pipeline terrain edit baked into the heightmap, not a Unity step; the
planter's corner probe warns when it is missing (expected for outer buildings: pads are inner terrain only). Matcher tests: `bun test unity/building-matching.test.mjs`
(node:test files run under `bun test`; `node` is not on this machine's PATH).

## Where the scripts run

The **repo is the source of truth**. The scripts are used from a copy inside the Unity project:

| | |
|---|---|
| Current Unity project | `D:\gspro_courses\vreta_v4_2025_12_02` (Vreta, GSPro base project v4 2025-12-02) |
| Script copy | [`install.json`](install.json) maps repo folders to project folders (any course project): `Assets\Editor\GolfMapBridge\` mirrors `unity/Editor/GolfMapBridge/`, `Assets\Editor\GolfMap\` mirrors `unity/Editor/GolfMap/`; `Assets\GolfMap\Runtime\` mirrors `unity/Runtime/GolfMap/` (the `GolfMapTrees` component must live outside an Editor folder to be saved in the scene) |
| Unity version | 2018.2.8f1 — C# 6 only, `TerrainLayer` absent (SplatPrototype), Vegetation Studio Pro installed |
| Export folder (planter input) | `D:\gspro_courses\vreta-opcd\` — `vreta-{inner,outer}-trees.json`, `vreta-{inner,outer}-zones.json` + `-zones-<n>.png`, DEM `.raw`/`.tif.json`, orthos |
| Course assets in Unity | `Assets/GolfMap/Vreta/` — `Course.asset` (`GolfMapCourse`: scene, export folder/prefix, terrain names; its folder *is* the course folder), `palette.json`, `Vreta_trees.json`, `ImportedTreeStorage*.asset`, `TreeCatalog*.asset`, `Zones/` (imported zone masks) |
| Terrains in scene | `Terrain (Inner)` (2050 m, origin) and `Plot (Outer)` (5000 m, offset); outer trees plant as VSP billboards, excluding the inner square |

## Workflow (every session)

The `unity` MCP server (`unity/mcp/`, [README](mcp/README.md)) drives the open editor through the
editor bridge (`Editor/GolfMapBridge/`, installed with the other scripts). Use it instead of copying
files by hand and asking the user for console output. Everything below works for any course project;
pass `project` when more than one editor is open.

1. **Before changing anything, `unity_sync` mode `check`.** Another agent or the user may have edited
   the Unity copy directly. `unity-changed` / `unity-only` files: `pull` them into the repo first.
   A `conflict` (both sides differ from the last sync, or never synced): diff the two files, merge in
   the repo, then `push` with `force`. Line-ending-only differences are not reported.
2. **Edit in the repo**, never only in the Unity project.
3. **`unity_sync` mode `push`** copies the edits in, recompiles without focusing Unity and returns
   compile errors plus new console errors. `.meta` files stay Unity's; never add them to the repo.
4. Run and verify yourself: `unity_menu` (returns the console lines it caused), `unity_command`
   (`golfmap.course`, and whatever planter steps get registered), `unity_console since=<seq>`,
   `unity_scene`, `unity_screenshot`. Ask the user only for what needs a human eye or a modal dialog.
5. Without an open editor (or before the bridge is in a project): `unity/check-planter.ps1
   [-UnityProject <path>]` compiles the scripts against that project's Unity/VSP assemblies with the
   C# 6 compiler (Unity version read from `ProjectVersion.txt`). Add new files to its list. It writes
   into `tree-export/` (gitignored, create it if missing).
6. Stack trace line numbers match the repo file once synced.

Course exports (the app's GSPro Export panel) run from the command line too, through the same
service: `bun run gspro:export -- status <course>` shows the export folder, ortho vintages and
exported files; `bun run gspro:export -- <course> dem zones trees:outer ...` exports (no terrain =
both, `dem` first on a new course). Then import in Unity with bridge commands, e.g.
`golfmap.zones.check` / `golfmap.zones.import` with `terrain: inner|outer` (the window's Load and
check / Import without the window; `dryRun: true` on import returns the plan without writing). Check
before import: it reports missing packages and items and the groups/rules the import would change.

Lower vegetation (tall rough grass etc.) is a **grass palette**: `<course>/grass-palette.json`
(`golfmap-grass-v1`, snapshot in `docs/gspro/<course>/`), built into VSP by `GolfMapGrass.cs`
(`golfmap.grass.apply`): greyscale copies of the source textures (RUSTIC Grass PSDs) under
`<course>/Grass/Textures/`, texture grass items on the stock `AwesomeTechnologies/Grass/Grass` shader in a
`GolfMap lower vegetation` package (Default biome) on the terrain's system, coloured by the items'
dry/healthy tints. An item with a `prefab` instead of a `source` texture is a mesh bush (VSP Plant,
own materials, shader checked against GSPro's VSP): the `shrub` palette's willow thicket. Loop: apply -> `bun run zones -- add <course> <zoneType> --from-feature <id>` and
`bun run zones -- bind <course> <zoneType> --palette <grass-palette.json>` -> `bun run gspro:export --
<course> zones:inner` -> `golfmap.zones.import` (terrain, package) -> apply again (items spawn only once a
zone mask includes them: an include rule on a group that exists in the package). Tune colours against the ground, not by eye: compare a 30 m top-down shot with
the palette hidden (`golfmap.grass.apply spawn=false`) and shown, and scale the tints by the ground/grass
ratio; the green items carry the match, straw/seed-head items stay sparse, muted accents. A palette's
`distanceFalloff` thins the grass towards the draw distance instead of a pop line. **Where** tall grass
grows is generated for the whole course by rule - see the `grass-planting` skill
(`.claude/skills/grass-planting/SKILL.md`): `golfmap.surfaces.export` (surface map from the built
meshes: OPCD's `Outer_Deep_Sat` fill is not a DB feature) -> `bun run grass:zones -- <course>` ->
`golfmap.zones.import` -> `golfmap.grass.apply`.

New bridge commands go in `Editor/GolfMap/GolfMapBridgeCommands.cs` (or next to the tool they wrap)
as `[BridgeCommand]` static methods; the bridge and MCP server pick them up with no change.
The bridge itself stays course-agnostic: no `GolfMap.Editor` references in `Editor/GolfMapBridge/`.

## Gotchas learned the hard way

- **VSP draws nothing after a refresh until its Update runs.** It is `[ExecuteInEditMode]` and only
  re-culls/spawns in Update/LateUpdate; a focused editor ticks it (a user fixes a blank VSP with a small
  pan), an unfocused 2018 editor never does - `QueuePlayerLoopUpdate` and dirtying objects do not help.
  The bridge's `screenshot` (`warmup`) and `editor.tick` call Update/LateUpdate on every active
  `[ExecuteInEditMode]` behaviour themselves and nudge the view. After an apply/import the first frames
  are slow (VSP spawning). `golfmap.vsp` shows each system's cameras (no culling group = not updated).
- **VSP plants on the terrain, the player sees the meshes.** The inner Terrain component is disabled in
  OPCD scenes (collider + VSP ground only); where a course mesh bridges a dip, grass is buried under it.
  `golfmap.terrain.conform` lifts the terrain to 1 cm under the meshes (backup + `golfmap.terrain.restore`);
  re-run after a mesh rebuild or a terrain re-import. VSP caches the heightmap in its `UnityTerrain`
  component: after any heightmap change call `UnityTerrain.RefreshTerrainData()`, a system refresh is not
  enough.
- **Screenshot ground heights:** `eye=<m>` places the camera over the visible surface (collider raycast:
  course meshes sit ~2 m above `Terrain.SampleHeight` on Vreta), not the terrain heightmap.
- **Never read or write `palette.json` with `JsonUtility`.** It drops keys it has no field for (`zones`,
  `catalogue`, `originalPath`) and cannot hold the species map. Go through `GolfMapPalette.Load/Save`;
  the node scripts and the Palette tab edit the same file, and saves must stay minimal diffs.
- **No course names in code.** Paths, scene and terrain names come from the active `GolfMapCourse`
  (`GolfMapCourses.Require()` / `.For(component)`, `Folder`, `PalettePath`, `ExportFile`, `ReportPath`).
  Vreta is the test bed, not a constant; a new tool that needs a course file asks the course for it.

- **VSP cell edges.** VSP resolves a world position to a vegetation cell with a zero-size
  `Rect` and a strict overlap test, both in its own `AddVegetationItemInstance` and in the planter's
  pre-check. Survey stems use whole-metre coordinates and cells are 100 m, so thousands of trees sit
  exactly on an edge and would match no cell. The planter nudges those 1 cm into the nearest cell
  (`GolfMapTreePlanterVsp.cs`, `PlantStorage`). Keep that when touching cell lookup.
- **One object, two panels, role-fixed.** The scene's single `GolfMap Trees` object carries an inner
  `GolfMapTrees` component and an outer one hidden with `HideInInspector`; the inner's Inspector shows them as
  the Inner | Outer tabs (`Host`/`Outer`/`Active`). The user wants one editor, not two scene objects. The
  component's `role` decides terrain, trees file, billboards-only, the excluded inner square and the storage
  (`SyncRole`/`SyncStorage`, resolved each repaint, never hand-picked), and Plant always replaces source 42.
  Both rules exist because a hand-pointed single component planted every inner tree twice (appended copy at a
  slightly different scale = "double rendered with a tiny offset"). Do not reintroduce an append mode or an
  editable terrain/storage field; `Doubles()` finds and `RemoveDoubles()` cleans up what older versions left.
- **The planter is a scene component.** `GolfMapTrees` (runtime, data only) holds the settings per area;
  `GolfMapTreePlanter` (editor, `ScriptableObject`, `HideAndDontSave`, one per component via `For()`) holds
  the loaded survey, biome matches and the editing session so they survive Inspector churn; its settings
  members are properties forwarding to the component. `GolfMapTreesInspector` only forwards
  `OnInspectorGUI`/`OnSceneGUI`. Settings changed from code must call `Dirty()` so the scene saves them.
- **Manual tree edits live in `<course>-<terrain>-tree-edits.json`** next to the trees file, written
  by the Scene-view tree editor (`GolfMapTreeEditor.cs`, model in `GolfMapTreeEdits.cs`). `LoadFile`
  overlays it on the survey before matching, so every planting path honours it. Never let a replant
  or survey regeneration discard that file. The editor has no Unity undo by design (a full storage
  undo snapshot per edit is too slow); it re-adds instances through the same helpers planting uses.
- **VSP draws one mesh per LOD** (the LOD group's first renderer) with the instance transform only. Prefabs
  with several renderers per LOD, a tilted mesh object or a non-identity root (NM's "High Quality" poplars)
  render as flat blobs. Use NM's `VS_` or baked variants; `PrepareBiome` rejects offenders in storage mode.
- **GSPro expects the wizard's rig.** A course VSP system must be **named `VegetationSystemPro`**
  (GSPro's shader-controller remap resolves it by name and null-refs on a renamed one - no
  vegetation renders at all; diagnosed by OPCD's John Meyer from the GreenKeeper logs), be a child of
  the `VegetationStudioPro` manager object, carry `TerrainSystemPro`/`ColliderSystemPro`, and hold no
  camera in its camera list - VSP's `Reset()` seeds that list with `Camera.main` on `AddComponent`,
  and GSPro destroys the course camera on load. `GolfMapVspRig.cs` builds that shape for anything the
  planter creates and fixes older scenes from the menu. Never create a `VegetationSystemPro` without
  going through it, and never identify one by GameObject name: inner and outer share it, so the
  planter matches on its storage asset under `VretaFolder` plus terrain bounds (`IsGolfMapStorage`).
- **Never rename a copied tree shader.** VSP picks a shader controller by *exact* shader name
  (`ShaderSelector` against the lists in `NMTreeShaderControler`/`CTIShaderController`/`Speedtree`).
  This project's Asset Store VSP falls back to `DefaultShaderController`, so an unknown name is
  invisible in the editor - but **GSPro ships a forked VSP runtime** (`SetShaderControllers(GameObject
  _sourceLOD0)`, `Arb_*ShaderController`, `useShaderControllerOverrides`; none exist in the project
  copy) whose lookup has no fallback and throws `NullReferenceException` out of
  `VegetationItemModelInfo..ctor`, aborting `SetupVegetationItemModels` for the *whole package*. One
  renamed shader silently removes every tree in that system from the course. `PrepareBiome` now
  rejects unrecognised shader names (`VspKnowsShader`). Tint through the item's shader-controller
  settings, not a renamed shader copy.
- **A catalogue item outlives the palette.** VSP validates and builds models for every item in a
  package at load, planted or not, so a retired prefab keeps logging faults and can break GSPro's
  shader-controller remap. `VspRenderIssue` only sees the current palette, so every plant calls
  `GolfMapVspRig.PruneCatalogues` to drop items no instance still references. Items that are still
  planted are kept - retiring one means replanting that area (Plant always replaces).
- Persistent storage is never reinitialised over an existing package; inner and outer use
  separate VSP systems and storage assets, matched to their terrain by bounds.
- Imported trees carry VSP source id 42; clear/replace only touch that source.
- The planter writes a report to `<UnityProject>/GolfMapSpelunk/<Course>_tree_import.txt` after each plant.
- **Planted materials must keep a stock shader name.** VSP picks a shader controller by name and GSPro's
  build has no fallback: a custom name (e.g. the retired `GolfMap/Tree Leaves No Spec`) stops the whole
  package loading, silently. The Plant check rejects it; don't work around it.
- **Leaf colour edits need a VSP refresh.** For items on the NM "Nature Manufacture tree" controller, VSP
  draws with the colours stored in the catalogue, not the `.mat`. Use `GolfMap > Refresh
  vegetation from materials` (or the planter's refresh button) after editing `_HealthyColor`/`_DryColor`;
  a replant is only needed for palette changes.
- **Leave `_BackFaceMirrorNormal` at 0 on leaf materials** (birch is the one exception). The leaf meshes
  here carry outward-bent normals; mirroring back faces points them into the canopy and darkens whole
  clusters (seen on elm and oak).
- **Diagnose foliage by probe, not by eye.** Set the tint to pure red/black and refresh: what doesn't
  change isn't drawn by that material, and colour that survives black albedo is lighting, not tint.
  Tint by measured texture (`prepare-foliage-luma.py`, `prepare-foliage-highlight-rolloff.py`) rather
  than guessed values.
- **Zone masks are sampled by VSP on the CPU.** `GolfMap > Vegetation Zones` (`GolfMapZoneImporter*.cs`,
  `GolfMapZones.cs`) imports the `unity-zones-v2` PNGs as readable RGBA32, uncompressed, no mipmaps,
  clamp, and checks the result is `TextureFormat.RGBA32` at the export resolution: a platform override
  or a compressed format makes `GetRawTextureData` return garbage, not an error. The channel selector
  follows VSP's inspector (0 R, 1 G, 2 B, 3 A); `TextureMask.cs` re-maps it for the RGBA32 byte order,
  so never "correct" it.
- **One mask channel per VSP item, never per zone type.** VSP multiplies density rules, so an item with
  two density rules only grows where both masks are non-zero; zone type variants share items. The
  pipeline bakes each item's density into its own channel, and every exported item gets exactly one
  density rule (multiplier 1) and one include rule against its group `golfmap-zone:item:<item>` (found
  by name; rules by `TextureMaskGroupID`, so re-import updates in place). Every other `golfmap-zone:*`
  group and every rule pointing at one is deleted; hand-authored rules stay. Never delete a group with
  VSP's `DeleteTextureMaskGroup`: it turns `UseTextureMaskIncludeRules` off when the include list
  empties, and an item without the include filter spawns everywhere. With the filter on and no live
  include rule it spawns nowhere (`FilterIncludeMaskJob`), which is what unbound items rely on.
  `golfmap.zones.import dryRun=true` (or the window's Preview import) shows the plan without writing.
  The zone tool never creates a VSP system: it lists the systems whose bounds match the terrain and
  refuses otherwise. Report: `GolfMapSpelunk/<Course>_zone_import.txt`.
