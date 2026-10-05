# Unity gotchas (full text)

Full text of the gotchas indexed in [unity/AGENTS.md](../unity/AGENTS.md). Each bullet was learned the hard way.

- **Bushes white when seen towards the sun.** NatureManufacture's foliage shader draws both leaf faces with
  the front face's normal unless `_BackFaceMirrorNormal` is 1, and some leaf materials are glossy; back
  faces then light as if facing the sun, with a grazing sheen. Fix per palette item with a `"material"`
  override block (GolfMapGrass header), which draws course-local prefab/material copies - never edit the
  pack's materials in place.
- **VSP stuck on "The previously scheduled job ... You must call JobHandle.Complete()".** VSP completes
  the jobs one Update schedules in the next LateUpdate; an asset refresh between the two can orphan
  them, and from then on every frame and every command that refreshes VSP throws. A script reload
  (`unity_sync push` with a compile) clears it; `golfmap.vsp.reset` disables and re-enables the systems.
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
  settings, not a renamed shader copy. The one safe rename is *to* a stock name GSPro already
  matches: Forst's `CTI/LOD Leaves 301` etc. are unknown to both GSPro builds (checked by IL), so
  the CTI trial copies them as `CTI/LOD Leaves`/`Bark`/`Bark Array` (`prepare-cti-trial.py`,
  `golfmap.cti.*`, [tree rendering fixes](../docs/tree-rendering-fixes.md)). Forst's
  `VSPro_CTIShaderController` package is C# and never reaches GSPro.
- **Forst trees (birch, oak) draw with CTI - the standard since 2026-09-27** (confirmed in
  GreenKeeper, whose VSP matches the GSPro release's lookup). Still named "trial" in code and
  folders. Tune their colour in the palette editor (a tint baked into the `CTITrial/Textures`
  albedo copy) or `prepare-cti-maps.py`, never by putting an NM material back on a Forst
  prefab. Looks are trial-aware: a Regenerate keeps look prefabs on their trial materials.
  A new trial swap needs its own "to" material (restore reverses swaps in memory).
- **Putting asset files back under an open 2018.2 editor does not reload them.** A loaded prefab or
  ScriptableObject keeps its in-memory state through a file replace and forced reimport, and the
  next `SaveAssets` writes it back over the file. Revert in memory, or `Resources.UnloadAsset`
  (not for GameObjects) after copying, then check memory against disk. After that, VSP can
  still draw from stale managed state until a script reload (`GolfMapCtiTrial.cs` does both).
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
- **VSP's shader controllers overwrite material properties on VSP's own material copies.** A live change
  to a controlled property must go into the item's controller settings, or `RefreshMaterials` puts the old
  value straight back: NM tree (`HealtyColor` sic, `DryColor`, `BarkColor`, wind floats), CTI (`_HueVariation`,
  `_TranslucencyStrength`, `_Cutoff` for leaves and bark, wind), SpeedTree (`_Color`, `_HueVariation`), VSP
  grass (tints, darkening, root ambient, cutoff, tint area scale). `GolfMapVegLive.ControllerProperty` maps them.
  Other floats live on VSP's copies until the system is rebuilt from the prefab.
- **`Graphics.CopyTexture` in 2018.2 is two half-copies.** Into a readable Texture2DArray it updates the CPU
  data (saved with the asset) but not the GPU: call `Apply(false)` after. From a texture just compressed with
  `EditorUtility.CompressTexture` it copies stale GPU texels: `Apply(false)` the source first. A script reload
  puts textures' GPU copies back to the files (unsaved bakes are queued again, `GolfMapVegSession.Ensure`).
- **Asset copies leave a `GolfMapCourse` reference stale** (no asset path; `GolfMapCourses.Folder` throws).
  Resolve the course folder before copying, or load the course again after (`GolfMapVegSession.Course()`).
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
- **`GolfMapTrees` must live outside an Editor folder.** The runtime component is saved in the scene, so `Assets\GolfMap\Runtime\` mirrors `unity/Runtime/GolfMap/` (see `unity/install.json`); the editor scripts mirror into `Assets\Editor\...`.
