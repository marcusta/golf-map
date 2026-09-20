# GolfMap tools for Vreta

Installed from `D:/golf-map/unity/Editor/GolfMap`, then adapted locally for **Unity 2018.2.8f1 / C# 6**. Do not upgrade Unity: GSPro requires this version. The source checkout was not modified.

## Test import

Open `Assets/Terrain Backup/Vreta/Vreta_lidar_scene.unity`.

- **GolfMap > Vreta > Configure and import test trees** (Ctrl+Alt+G) loads the Vreta preset and replaces source 42 in its dedicated VSP storage.
- **GolfMap > Tree Planter** exposes the file, prefab lists, mesh roots, size limits, storage target and import controls.
- **Clear imported trees (source 42)** clears the assigned storage's GolfMap instances without requiring a trees file. Other source IDs survive. Undo is available.
- **GolfMap > Vreta > Verify imported trees and clear safety** (Ctrl+Alt+V) checks actual stored positions/counts and tests source-scoped clearing on an isolated copy, including a source-1 sentinel. It saves the scene after passing.
- **GolfMap > Spelunk Scene** produces a scene/project inventory under `GolfMapSpelunk`.

The Vreta preset uses Broadleaf_Desktop for broadleaf/unknown and Conifer_Desktop for conifers. Bush entries currently use the same kind mapping. Preset import selects active `Spline_` meshes excluding `Blend` objects; the editable mesh list accepts individual objects or roots. It probes only those meshes, taking the highest hit, with terrain height as fallback. Probe colliders are temporary and are removed after import. Neither tree prefab colliders nor unrelated objects can intercept probes.

24,421 exported stems share the original terrain's EPSG:3006 plot bounds. X/Z are metres east/north from the southwest corner; Y is sampled from the scene. Height and diameter determine independent Y and X/Z scales. The preset range 0.01–10 accommodates these test assets without clamping. Rotations and prefab choices use a stable per-stem seed; source order does not reshuffle them. Position-derived IDs are stable for unchanged detector coordinates, not a solution to matching moved detections between LiDAR reruns.

VSP configuration lives in the `GolfMap Vreta Trees` scene object and assets in `Assets/GolfMap/Vreta`. Imported catalog items have runtime spawning disabled and use persistent source **42**, reserved for this importer. In this VSP implementation, distance falloff is a draw-distance multiplier: **1** retains normal distance; 0 is incorrect.

## Rendering and limits

The installed VSP billboard generator derives the entire billboard's size from X scale. It does not retain independent height/width scale. This test therefore disables billboards and uses GPU-instanced mesh LODs with 3,000 m additional tree mesh distance. That also avoids the initial pale billboard appearance. Optimize draw distances and resolve billboard anisotropic sizing before treating this as a performance-tuned course. The generated billboard textures are retained in the catalog but unused.

The imported trees are a visual placement test. GSPro ball collisions/build/export have not been validated; the importer does not configure a collider system. Source tree-map errors (for example trees detected in playable areas) remain visible; no fairway exclusion or species-zone rules are applied. Reimport replaces source-42 hand edits as well, so edits intended to survive belong to another source or a future assignment file.

The legacy TerrainInstances and GameObjects modes remain available. Their **Clear ALL existing trees first** option has the original broad semantics, unlike source-scoped VSP clearing. Prefer PersistentStorage for this course. Mesh probing currently applies to PersistentStorage mode.

Alignment is blocked when mean terrain mismatch exceeds the configured tolerance. The report also shows outlier count/max. Vreta's initial mean was 0.04 m, maximum 2.31 m (two samples above 1 m). Plot dimension mismatch is rejected for VSP imports. Existing storage is never reinitialized; changed cell layouts need an explicit migration/new storage.

## Refreshing the input

Run `node GolfMapTools/export-vreta-trees.mjs [path/to/tree-stems.json]` from a shell with Node installed, then reimport in Unity. It uses `Vreta_inner_import.json` as the coordinate/elevation contract, validates the stem schema and assigns position IDs. Its default input is the Vreta course under `D:/golf-map/data/tiles/88E5F5B7-B1E6-4EBA-9D47-49B289C59EAE/`.

Next layer: species catalog mappings, deterministic per-kind/zone choices, and per-stem overrides. Those decisions can change prefab selection while keeping this import/clear path and survey positions/sizes.
