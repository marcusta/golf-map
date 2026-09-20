# Manual biome planting in Vreta

The planter is the Inspector of a **GolfMap Trees** scene object (one per terrain;
`GolfMap > Tree Planter` selects or creates it). Logic: `GolfMapTreePlanter.cs`. Install
it together with `GolfMapBiome.cs`, `GolfMapTreePlanterVsp.cs`, `GolfMapVspRig.cs`,
`GolfMapTreesInspector.cs` and `GolfMapBiomeAtlas.shader` under `Assets/Editor/GolfMap`,
and the component `GolfMapTrees.cs` under `Assets/GolfMap/Runtime`.
The VSP partial is now kept in this repository; do not maintain a separate older
copy with the same class/methods in the Unity project.

## Inner terrain

1. Open `Vreta_lidar_scene` and choose **GolfMap > Vreta > Configure manual biome planter**.
   This only configures the selected GolfMap Trees object; it does not import.
2. Set the inner trees JSON and its matching inner Terrain. The preset uses
   `Assets/GolfMap/Vreta/Vreta_trees.json` and `Vreta_lidar_inner`.
3. Leave **Use biome palette** on, with `Assets/GolfMap/Vreta/palette.json`.
   The source of this copied palette is `docs/gspro/vreta/palette.json`.
4. Use **PersistentStorage**. Existing Vreta storage is `GolfMap Vreta Trees`.
   Course mesh roots are used for ground placement, with terrain fallback.
5. **Load and check** reports alignment, match/review/unmatched counts and species mix.
   **Include imperfect/unknown fits** permits imperfect geometry fits and uncertain
   detector types. Turn it off to skip these. Unmatched stems are always skipped.
6. **Plant** runs manually. **Clear existing trees first** replaces source-42 trees
   in the selected storage; otherwise Plant appends and can create duplicates.
   The preset enables replacement. Other source IDs are retained.

This is a whole-file biome import. Planting the full inner file replaces the old
generic planting and the 118-tree trial when replacement is on. It does not read
the separate assignment review's authored overrides. Use the assignment importer
when you want to apply a reviewed subset or authored exceptions instead.

## Outer terrain (billboards only)

1. Select the outer trees JSON and its matching outer Terrain.
2. Assign the detailed terrain to **Inner terrain to exclude (outer)**. Its world
   X/Z footprint is excluded, even if the outer export still contains inner stems.
3. An export with `plot.terrain: "outer"` enforces **Billboards only**. Use
   **PersistentStorage**. Native TerrainInstances/GameObjects are rejected for this
   mode because these mixed assets are not guaranteed native billboard support.
4. Click **Create / select storage for this terrain**. It creates `GolfMap Outer
   Trees` and a separate storage asset, or selects the existing outer system.
   It does not plant trees and does not require clearing the inner storage selector.
   Save the scene after creating it. The billboard catalogue is created on Plant.
   To start fresh even when matching storage exists, click **Create new empty storage**.
   This always creates and selects a separate, uniquely named system and storage asset.
   Existing systems and their planted trees remain unchanged.
5. Set **Outer billboard distance (m)** (default 10,000) and leave **Rebake billboard
   colours** enabled when materials have changed. Load/check, then Plant.

Outer VSP uses PlantDistance=0 and AdditionalTreeMeshDistance=0, with billboards
enabled per item. The previous setting of only AdditionalTreeMeshDistance=0 still
allowed meshes inside PlantDistance. Uniform scaling avoids this VSP version's
billboard X/Y scale mismatch. The outer terrain's own height is sampled, including
its vertical sink; inner course meshes are not used there.

## Biome and colour

The supplied 18-asset palette retains the selected birches, oaks, elm, firs and
pines. It references the corrected oak/birch trial prefab copies. Broadleaf
preferences are oak 45%, elm 40%, birch 15%, subject to dimensional fit. These are
not quotas. Uniform scale limits are 0.75–1.4. Height and crown width jointly
determine the fit. Tall wide trees are not treated as shrubs merely because of the
detector's `bush` flag. Unknown outer trees can use either kind and are flagged for
review, rather than claiming known species.

The planter does not retint source assets on every run. Its biome references the
prepared prefab materials, including the approved middle-brightness pass. Missing
GUID/path pairs and missing/unsupported materials stop the import. Copying the
palette alone to another project is insufficient: its referenced assets and private
shader must also exist. See `docs/gspro/vreta/foliage-v2.md` for material preparation.

Outer diffuse atlases use a private bake shader that respects the oak leaf tint
and an average of NM healthy/dry tints. This is a distant approximation: it does
not reproduce location-dependent NM noise, wind, or identical lit highlights.
Original materials are not edited while baking. Verify colour and visibility in
GSPro before committing to a full outer course build.

## Before building the course for GSPro

Run **GolfMap > Vreta > Fix vegetation systems for GSPro** once on any scene planted
before `GolfMapVspRig.cs` existed. It renames each system object to `VegetationSystemPro`
(GSPro's shader-controller remap looks it up by that name and null-refs otherwise, and
then nothing renders), parents it under the `VegetationStudioPro` manager, adds the
missing `TerrainSystemPro`/`ColliderSystemPro`, removes the `Camera.main` entry VSP baked
into the camera list when the component was added, and prunes catalogue items nothing is
planted from. Save the scene afterwards, then build. Newly created systems already have
this shape.

**Retiring a prefab needs a replant.** Dropping an asset from the palette does not remove
it from the `TreeCatalog` asset, and VSP validates every item in the package at load — so
a bad prefab keeps erroring even with nothing planted from it. The prune only removes
items with no instances left, so replant that terrain with **Clear existing trees first**
enabled and the retired items go with it.

## Backups and checks

Replacement and Clear write storage snapshots under
`GolfMapSpelunk/PlantingBackups`. **Restore storage from planting backup** checks
the associated `.target` storage GUID before restoring. Keep both files together.
Storage restore does not undo catalogue/material changes. Plant supports Undo;
if a write/count check fails, the previous storage is restored automatically.

Verified: all three C# files compile against installed Unity 2018.2/VSP in C# 6.
The C# matcher matches the JS implementation for prefab, scale, rotation and review
status on all 24,421 Vreta stems. Run `unity/check-planter.ps1` for compilation;
`biome-parity-fixtures.mjs` and `BiomeParityCheck.cs` provide the cross-language check.
No full-course replant or outer billboard visual acceptance is implied by those checks.
