# Manual biome planting in Vreta

The planter is the Inspector of the scene's one **GolfMap Trees** object
(`GolfMap > Tree Planter` selects or creates it). It has two panels, picked with the tabs at
the top, and a coloured bar says which one is open:

- **Inner** (green) - the course area on the inner terrain, mesh trees.
- **Outer** (blue) - the surrounding plot, billboards only, inner square excluded.

Each panel keeps its own settings, so a change is always "for inner" or "for outer".
(Internally the object carries one `GolfMapTrees` component per area; the outer one is hidden
from the Inspector.)
The role fixes everything that used to be picked by hand, which is what made double
planting possible: the terrain (course asset's inner/outer terrain names), the trees file
(`<prefix>-<inner|outer>-trees.json` from the export folder), billboards-only, the excluded
inner square and the VSP storage (the one GolfMap system laid out for that terrain). A file
whose `plot.terrain` names the other area is refused.

Logic: `GolfMapTreePlanter.cs`. Install
it together with `GolfMapBiome.cs`, `GolfMapTreePlanterVsp.cs`, `GolfMapVspRig.cs`,
`GolfMapTreesInspector.cs` and `GolfMapBiomeAtlas.shader` under `Assets/Editor/GolfMap`,
and the component `GolfMapTrees.cs` under `Assets/GolfMap/Runtime`.
The VSP partial is now kept in this repository; do not maintain a separate older
copy with the same class/methods in the Unity project.

## Inner area

1. Open the course scene and choose **GolfMap > Tree Planter**. **GolfMap > Configure course
   planter** resets the selected area's settings to the course defaults; it does not import.
2. Terrain, trees file and storage are shown read-only. Tick **Custom trees file** only to
   plant a different inner survey; the fallback trees file is used when the export is missing.
3. Leave **Use biome palette** on. An empty **Biome JSON** means the course's own
   `palette.json`, which is the source of truth.
4. Course mesh roots are used for ground placement, with terrain fallback.
5. **Load and check** reports alignment, match/review/unmatched counts, species mix and
   doubled trees.
   **Include imperfect/unknown fits** permits imperfect geometry fits and uncertain
   detector types. Turn it off to skip these. Unmatched stems are always skipped.
6. **Plant inner** always replaces the area's source-42 trees (it asks first and writes a
   backup). It never appends. Other source IDs are retained.

This is a whole-file biome import. Manual edits from the Scene-view tree editor are overlaid
on the survey, so a replant keeps them.

## Outer area (billboards only)

1. Open the **Outer** panel. The outer terrain and the inner square to exclude come from the
   course asset; the inner footprint is excluded even if the outer export contains inner stems.
2. PersistentStorage is enforced. Native TerrainInstances/GameObjects are rejected for this
   mode because these mixed assets are not guaranteed native billboard support.
3. The storage is created on the first **Plant outer**, together with the billboard
   catalogue. Save the scene afterwards.
4. Set **Outer billboard distance (m)** (default 10,000) and leave **Rebake billboard
   colours** enabled when materials have changed. Load/check, then Plant.

## Doubled trees

Trees that look double-rendered with a tiny offset are two stored instances of the same stem:
an appended second planting (older planter versions), or the other area's survey planted into
this area's terrain. **Check for doubled trees** counts both kinds per storage; **Remove
doubled trees...** keeps the newest copy of each stem in the area's own storage and removes
every source-42 instance other GolfMap storages hold inside the area, after backing each
storage up. Plant refuses while another storage still holds trees in the area. Several
systems laid out for the same terrain are reported as an error: keep one, **Delete storage...**
the rest.

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
The atlas is flat albedo x tint, without the AO and self-shadowing a mesh crown gets, so
an ungraded bake reads brighter than the inner trees: **Billboard brightness** (default 0.45, a linear-light multiplier like the terrain photo's `--darken` 0.4)
and **Billboard saturation** (default 0.85) in the Outer panel are baked in at the next
Plant with Rebake on. VSP's billboard shader also shifts each SpeedTree towards the
material's `_HueVariation` colour by up to that colour's alpha, on top of the atlas: the outer
sync grades that target like the atlas, otherwise the shifted trees read white. For the inner, a look's **Tint saturation x** scales the saturation
of its leaf and bark tint colours (then *Apply to course*).
Original materials are not edited while baking. Verify colour and visibility in
GSPro before committing to a full outer course build.

## Before building the course for GSPro

Run **GolfMap > Fix vegetation systems for GSPro** once on any scene planted
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
items with no instances left, so replant that area (Plant always replaces)
and the retired items go with it.

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
