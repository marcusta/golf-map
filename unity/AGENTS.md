# unity — AGENTS

C# editor scripts that move golf-map output into an OPCD/GSPro Unity course project. Nothing
here is part of the golf-map build; there is no Unity project in this repo. Feature docs:
[README.md](README.md) (terrain importer, spelunker, tree planter), [MANUAL-PLANTING.md](MANUAL-PLANTING.md)
(biome planting walkthrough), [CATALOGUE.md](CATALOGUE.md) (prefab catalogue).

## Where the scripts run

The **repo is the source of truth**. The scripts are used from a copy inside the Unity project:

| | |
|---|---|
| Current Unity project | `D:\gspro_courses\vreta_v4_2025_12_02` (Vreta, GSPro base project v4 2025-12-02) |
| Script copy | `D:\gspro_courses\vreta_v4_2025_12_02\Assets\Editor\GolfMap\` mirrors `unity/Editor/GolfMap/` |
| Unity version | 2018.2.8f1 — C# 6 only, `TerrainLayer` absent (SplatPrototype), Vegetation Studio Pro installed |
| Export folder (planter input) | `D:\gspro_courses\vreta-opcd\` — `vreta-{inner,outer}-trees.json`, DEM `.raw`/`.tif.json`, orthos |
| Course assets in Unity | `Assets/GolfMap/Vreta/` — `palette.json`, `Vreta_trees.json`, `ImportedTreeStorage*.asset`, `TreeCatalog*.asset` |
| Terrains in scene | `Terrain (Inner)` (2050 m, origin) and `Plot (Outer)` (5000 m, offset); outer trees plant as VSP billboards, excluding the inner square |

## Workflow (every session)

1. **Before changing anything, diff both copies.** Another agent or the user may have edited
   the Unity copy directly. Compare every file in `unity/Editor/GolfMap/` against the Unity
   `Assets/Editor/GolfMap/` copy (`cmp` per file). If the Unity side is newer, bring it into the
   repo first. Files that exist only in Unity get copied into the repo.
2. **Edit in the repo**, never only in the Unity project.
3. **After each edit that should be tested, copy the changed file(s) into the Unity copy**
   (plain file copy; Unity recompiles on focus). Leave the `.meta` files in the Unity project alone
   and do not add `.meta` files to the repo.
4. Compile check without opening Unity: `unity/check-planter.ps1` builds the planter files against the
   installed Unity/VSP assemblies with the C# 6 compiler.
5. The user tests in the Unity editor and reports console output / screenshots. Read the stack
   trace's line numbers against the repo file (the copies are identical).

## Gotchas learned the hard way

- **VSP cell edges.** VSP resolves a world position to a vegetation cell with a zero-size
  `Rect` and a strict overlap test, both in its own `AddVegetationItemInstance` and in the planter's
  pre-check. Survey stems use whole-metre coordinates and cells are 100 m, so thousands of trees sit
  exactly on an edge and would match no cell. The planter nudges those 1 cm into the nearest cell
  (`GolfMapTreePlanterVsp.cs`, `PlantStorage`). Keep that when touching cell lookup.
- Persistent storage is never reinitialised over an existing package; inner and outer use
  separate VSP systems and storage assets, matched to their terrain by bounds.
- Imported trees carry VSP source id 42; clear/replace only touch that source.
- The planter writes a report to `<UnityProject>/GolfMapSpelunk/Vreta_tree_import.txt` after each plant.
