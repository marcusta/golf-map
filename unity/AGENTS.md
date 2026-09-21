# unity — AGENTS

For foliage/material problems, read [tree rendering fixes](../docs/tree-rendering-fixes.md)
first and record confirmed fixes there, including Unity versus GSPro verification.

C# editor scripts that move golf-map output into an OPCD/GSPro Unity course project. Nothing
here is part of the golf-map build; there is no Unity project in this repo. Feature docs:
[README.md](README.md) (terrain importer, spelunker, tree planter, building planter), [MANUAL-PLANTING.md](MANUAL-PLANTING.md)
(biome planting walkthrough), [CATALOGUE.md](CATALOGUE.md) (prefab catalogue).

Buildings (`GolfMapBuildingPlanter.cs`, `building-matching.mjs` + `match-building-palette.mjs`) follow the
tree assignment pattern — offline matcher writes a report keyed by stable id, overrides persist, the Unity
window validates then applies — but plant plain GameObjects under the terrain, never VSP (colliders). The
flat pad under each building is a pipeline terrain edit baked into the heightmap, not a Unity step; the
planter's corner probe warns when it is missing. Matcher tests: `bun test unity/building-matching.test.mjs`
(node:test files run under `bun test`; `node` is not on this machine's PATH).

## Where the scripts run

The **repo is the source of truth**. The scripts are used from a copy inside the Unity project:

| | |
|---|---|
| Current Unity project | `D:\gspro_courses\vreta_v4_2025_12_02` (Vreta, GSPro base project v4 2025-12-02) |
| Script copy | `D:\gspro_courses\vreta_v4_2025_12_02\Assets\Editor\GolfMap\` mirrors `unity/Editor/GolfMap/`; `Assets\GolfMap\Runtime\` mirrors `unity/Runtime/GolfMap/` (the `GolfMapTrees` component must live outside an Editor folder to be saved in the scene) |
| Unity version | 2018.2.8f1 — C# 6 only, `TerrainLayer` absent (SplatPrototype), Vegetation Studio Pro installed |
| Export folder (planter input) | `D:\gspro_courses\vreta-opcd\` — `vreta-{inner,outer}-trees.json`, `vreta-{inner,outer}-zones.json` + `-zones-<n>.png`, DEM `.raw`/`.tif.json`, orthos |
| Course assets in Unity | `Assets/GolfMap/Vreta/` — `Course.asset` (`GolfMapCourse`: scene, export folder/prefix, terrain names; its folder *is* the course folder), `palette.json`, `Vreta_trees.json`, `ImportedTreeStorage*.asset`, `TreeCatalog*.asset`, `Zones/` (imported zone masks) |
| Terrains in scene | `Terrain (Inner)` (2050 m, origin) and `Plot (Outer)` (5000 m, offset); outer trees plant as VSP billboards, excluding the inner square |

## Workflow (every session)

1. **Before changing anything, diff both copies.** Another agent or the user may have edited
   the Unity copy directly. Compare every file in `unity/Editor/GolfMap/` against the Unity
   `Assets/Editor/GolfMap/` copy, and `unity/Runtime/GolfMap/` against `Assets/GolfMap/Runtime/`
   (`cmp` per file). If the Unity side is newer, bring it into the
   repo first. Files that exist only in Unity get copied into the repo.
2. **Edit in the repo**, never only in the Unity project.
3. **After each edit that should be tested, copy the changed file(s) into the Unity copy**
   (plain file copy; Unity recompiles on focus). Leave the `.meta` files in the Unity project alone
   and do not add `.meta` files to the repo.
4. Compile check without opening Unity: `unity/check-planter.ps1` builds the planter files (planter, VSP
   partial, biome, edits, editor, verification, Inspector, runtime component, building planter, zone importer) against the installed
   Unity/VSP assemblies with the C# 6 compiler.
   Add new planter partials to its file list. It writes into `tree-export/` (gitignored, create it if missing).
5. The user tests in the Unity editor and reports console output / screenshots. Read the stack
   trace's line numbers against the repo file (the copies are identical).

## Gotchas learned the hard way

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
  `GolfMapZones.cs`) imports the `unity-zones-v1` PNGs as readable RGBA32, uncompressed, no mipmaps,
  clamp, and checks the result is `TextureFormat.RGBA32` at the export resolution: a platform override
  or a compressed format makes `GetRawTextureData` return garbage, not an error. The channel selector
  follows VSP's inspector (0 R, 1 G, 2 B, 3 A); `TextureMask.cs` re-maps it for the RGBA32 byte order,
  so never "correct" it. Mask groups are found by name (`golfmap-zone:<key>`) and item rules by
  `TextureMaskGroupID`, which is how re-import updates in place; the density rule only has a
  multiplier, so a binding's `minDensity` is recorded but cannot raise the floor. The zone tool never
  creates a VSP system: it lists the systems whose bounds match the terrain and refuses otherwise.
  Report: `GolfMapSpelunk/<Course>_zone_import.txt`.
