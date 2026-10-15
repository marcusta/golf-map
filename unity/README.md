# unity

Unity editor scripts for getting golf-map output into an OPCD/GSPro course project.
Nothing here runs in the golf-map build. Copy `Editor/GolfMap/` into the OPCD base
project under `Assets/Editor/GolfMap/` (any folder named `Editor` works). The menu
items appear under `GolfMap`. [`install.json`](install.json) lists every folder that goes into a
course project; the `unity` MCP server's `unity_sync` does the copying, and the editor bridge
(`Editor/GolfMapBridge/`) lets an agent recompile, run menus, read the console and take
screenshots in the open editor. See [mcp/README.md](mcp/README.md), whose "Adding a command" has the two
retries that run a command a second time on their own (a job lost to a script reload, VSP's stalled job
lists) and the idempotence every command owes them.

Agent-facing per-tool notes moved from `AGENTS.md`: [docs/unity-tool-notes.md](../docs/unity-tool-notes.md); gotchas: [docs/unity-gotchas.md](../docs/unity-gotchas.md).

## Saving what a command changed: `save`

Every command that writes into the scene marks it dirty and leaves saving to the user. That cost 13 meshes
on 2026-10-09, when the editor crashed with the work only in memory. So **every** command takes
`save=false`: with `save: true` the command, **once it has succeeded**, saves every open scene that is
dirty and runs `AssetDatabase.SaveAssets()` for the assets it changed (terrain data, palettes, materials,
meshes), and reports `saved: { scenes: [<scene paths>], seconds }`.

`save` is the bridge dispatcher's, not each command's: when a job finishes successfully and its args carry
`save: true`, `BridgeServer` runs the registered command `golfmap.scene.save` (`GolfMapSceneSave.cs`) and
merges its answer into the response as `saved` - and into the result too, when the result is an object, so
a caller that sees only the result (`unity/mcp/bridge.ts` `run()`) gets it as well. It used to be threaded
through each command's own return sites by hand, and the ones that never got a wrapper - `roughgrass.plant`,
`powerlines.build`, `vehicles.build`, `look.apply`, `paint.apply`, `cti.apply`, `vegpalette.*`,
`meshes.materials`, `walls.colliders`, `terrain.restore`, `vsp.merge`, `trees.colliders` and others -
ignored `save: true` in silence.

- Default `false`: a call without `save` behaves exactly as before (dirty scene, "save it in Unity").
- A dry run never saves (`dryRun: true` in the args, or in the result - `golfmap.trees.plant check=true`
  reports it that way), and neither does a run that failed: one that throws never reaches the hook, and one
  that reports its own failure (`failed: true`, `golfmap.course.refresh` with a failed step) is left dirty
  on purpose. `saved.skipped` says which of the two it was.
- `golfmap.course.refresh` saves **once**, after its last step: the hook runs per top-level job, and the
  steps a command chains inside its own job are not jobs.
- A dirty scene that has never been saved has no file to save to; it is left alone and listed as
  `saved.skippedScenes` rather than failing the command (an untitled additive scene next to the course's).
- If the save itself fails, the command's result still stands and `saved.failed` carries the message (plus a
  console error): the work is not hidden because the saving went wrong.
- A project without `golfmap.scene.save` (the bridge folder alone, no GolfMap scripts) reports
  `saved: { skipped: "no golfmap.scene.save command" }`.
- Saving by itself, after a run without `save`: `unity_command golfmap.scene.save`, or the bridge's own
  course-agnostic `unity_command scene.save` (mcp/README.md).
- `golfmap.course.build` is the one exception, and it has its own argument for it: `saveBefore=true` saves
  the scene **before** the build, because the bundle is built from the file on disk. `save` on that command
  means the same as everywhere else - save again afterwards.

## Terrain Importer

`GolfMap > Terrain Importer` turns the course's GSPro export folder, the one the app writes
into the two GSPro terrains, doing the Unity half of the OPCD "LIDAR to TERRAIN" manual
(stage 6) automatically. Works for any course: everything is read from the export's
sidecars, nothing is named after a course.

1. In the app, export the inner heightmap, then the outer heightmap (the outer's sidecar
   then carries its Unity position), and the overlays you want (inner/outer orthophoto
   JPEGs; hillshades optional).
2. In Unity, open the importer, pick the folder, **Scan folder**. It lists what it found:
   the inner and outer heightmaps (`<course>-inner-dem-<side>m.raw` + `.tif.json`) and a
   picker per terrain for the overlay. Every orthophoto export comes as two or three JPEGs:
   the photo as-is, a `-terrain` twin darkened for the terrain shader (which lights the
   photo a second time and washes an untouched one out) and, with the panel's mesh texture
   on, a `-meshes` variant (8192 px): the darkened twin softened to ~1 m of detail, with the
   course's grass surfaces tinted dark green at 50 % and everything that isn't drawn (the Photoshop overlay step done automatically). The
   inner's is for the course meshes (the sun-lit tint lifts it); the outer's is the outer
   terrain's floor: as dark as its `-terrain` twin, with the colouring on top. The picker
   defaults to the `-terrain` twin for the inner and the `-meshes` variant for the outer,
   cleaned before pristine, hillshades last.
3. **Import terrains**. For each terrain it
   - copies the `.raw`, the sidecar and the picked overlay into
     `Assets/Terrain Backup/<course>/` and sets the overlay's Max Size to 8192 and its compression
     to high quality (the darkened twin has little tonal range and bands at default quality),
   - creates the `TerrainData` (`<course>_Lidar_Inner.asset` / `_Outer.asset`) with
     Width/Length = the square's side, Height = max − min, heightmap resolution 4097,
     reading the RAW as 16-bit little-endian ("Windows") and flipping it vertically,
   - paints the overlay tiled to the terrain size (TerrainLayer on 2018.3+, SplatPrototype
     on the 2018.2 base project),
   - creates `Terrain (Inner)` at the origin and `Plot (Outer)` at the sidecar's position
     (x/z half the side difference to the south-west, y the difference in minima) lowered
     by the **Outer sink** (default 0.5 m) so no outer ground shows through the inner —
     the manual's "lower the Y value until no blue shows".

Existing `Terrain (Inner)` / `Plot (Outer)` objects are replaced when the toggle is on.
Creation supports Undo. The importer does not touch other terrain settings (pixel error,
base map distance …); set those as the base project prefers.

### Updating the heights in place (golf-map's **Update terrain**)

The Terrain Importer builds the terrains. After that, a new heightmap (terrain edits, pads, digs) goes
onto the existing ones with `GolfMap > Terrain > Update heights from export`, or the bridge's
`golfmap.terrain.update [terrain=inner|outer|both] [outerSink] [dryRun=true] [save=true]`
(`save`: the new heights and the scene saved when the update succeeded, see ["Saving what a command changed"](#saving-what-a-command-changed-save)).

- **In place:** the same Terrain objects and TerrainData assets, so VSP systems, tree storage and
  references stay. Each TerrainData is backed up to `<course>/Backups/<data>-before-update-<time>.asset`
  first (`golfmap.terrain.restore` puts the heights back). The overlay texture is left alone.
- **Outer plot:** re-placed from the two sidecars, keeping the sink it has now (Vreta's is 2.214 m,
  lowered by hand) unless `outerSink` is given.
- **Report:** how far the ground moved on each terrain, and `outerShowsThrough` (the area where the outer
  plot's ground is at or above the inner's, measured on every run, dry runs included). A deep cut
  under an outer that doesn't carry the same edits shows through the rebuilt meshes there.
- **Conform:** an update undoes a `golfmap.terrain.conform`. Re-run the conform once the course meshes
  are rebuilt from the new terrain.

golf-map drives this with **Update terrain** (export kind `unity-terrain`;
CLI `bun run gspro:export -- <course> unity-terrain:inner`). The server exports the heightmap, finds the open
editor whose active course's export folder is the course's (through the same bridge client as the MCP
server), and runs the update. It refuses an inner heightmap older than the site's terrain edits (see
docs/gspro/export.md). Terrain › Export To OBJ for Blender stays manual.

### Sculpting in Unity, carried back to golf-map

Sculpt a terrain in Unity, then press **Pull from Unity** on the GSPro board's Terrain row
(export kind `unity-sculpt`, bridge `golfmap.terrain.capture terrain=inner|outer [threshold=0.01] [dryRun]`,
`GolfMapTerrainSculpt.cs`). A capture measures, per heightmap vertex:

    sculpt = current − reference + sculptIn − conform

| | |
|---|---|
| `reference` | the heights golf-map last put there. `golfmap.terrain.update` keeps a copy in `<course>/Reference/<terrain>-heights.asset` + `-reference.json`. A terrain imported before this existed needs one **Update terrain** first |
| `sculptIn` | the sculpt layer that export already contained (`gspro.py dem --sculpt` writes `<stem>-sculpt-in.raw`, and the update keeps a copy). This makes every capture the whole layer, so replacing the stored layer never loses earlier strokes |
| `conform` | what `golfmap.terrain.conform` raised under the meshes (`<terrain>-conform.bytes`, cleared by the next update). It is derived, not a sculpt |

Differences under 1 cm are heightmap quantisation. The outer's capture leaves out the inner square. The
capture goes to the export folder as `<prefix>-<terrain>-sculpt.raw` (float32 m, the heightmap's pixel grid,
north-up, cropped) + `.json` (golfmap-sculpt-v1). golf-map makes it a GeoTIFF and stores it as that terrain's
one `delta` terrain edit, replayed after every other edit. A capture with nothing sculpted removes the layer.
Then Apply to terrain, and Update terrain again. The layer is additive: regrading or digging under it
later keeps the sculpt as an offset on top.

Checked on Vreta by restoring an older terrain backup and capturing the difference. The extremes landed on
the known pad cut (+5.56 m) and fill (−2.76 m), and a spot check matched Unity's heights to 1.6 cm. With nothing
sculpted a capture finds 0 cells. Commands that save assets take the course folder as a string up front:
an asset save can reload the course asset and leave a held `GolfMapCourse` without a path.

### Heightmap sidecar: `<course>-<inner|outer>-dem-<side>m.tif.json`

Written by `pipeline/gspro.py dem` next to the `.tif` and the `.raw`:

| field | meaning |
|---|---|
| `terrain` | `inner` or `outer` |
| `square3006`, `centre3006`, `sideM` | the EPSG:3006 square the heightmap covers; `sideM` = Unity Terrain Width and Length |
| `minM`, `maxM`, `heightRangeM` | the range the RAW was scaled over; `heightRangeM` = Unity Terrain Height |
| `raw` | `file`, `size` (4097), `dtype` uint16, `byteOrder` little-endian, `rowOrder` north-up |
| `unity` | the import dialog values (`heightmapResolution`, `depth` 16, `byteOrder` Windows, `flipVertically` true) and `position`: `0,0,0` for the inner; for the outer, its transform with the inner at the origin (present when the inner sidecar was in the folder at export time) |

## Spelunk Scene

`GolfMap > Spelunk Scene` writes `<scene>.json` and `<scene>.md` to `<project>/GolfMapSpelunk/`
(or a folder you pick). It records what an exporter must match to fit the base project:

- terrains: size, position, heightmap and alphamap resolution, sampled height range,
  terrain layers, tree prototypes with instance counts per prototype, terrain shader
- every mesh: object path, tag, layer, vertex and triangle counts, UVs, world bounds,
  materials, collider type, physics material
- every collider: trigger flag, physics material and its asset path, convex flag
- custom MonoBehaviours: type, assembly, script path, serialized fields with values
- tag, layer, component, shader, material, physics-material and prefab-source counts
- project: tag list, layer table, sorting layers, render pipeline, color space, physics
  material assets, terrain assets, scenes, packages, scripts by folder, prefabs by folder

Run it on a course that already builds and plays in GSPro. The markdown is the summary,
the JSON has the full hierarchy. Objects with more than 200 children (a setting) list the
first 200 and summarize the rest by component signature, so a terrain with thousands of
placed trees does not produce a multi-megabyte report.

## Tree Planter

The planter is a scene component: a **GolfMap Trees** object per terrain (component
`GolfMapTrees`, `Runtime/GolfMap/GolfMapTrees.cs`, mirrored to `Assets/GolfMap/Runtime/`)
whose Inspector holds the settings, the Load and check / Plant / Clear buttons and the
tree editor. The settings are saved with the scene, so the inner and outer setups sit
side by side instead of one window being re-pointed. `GolfMap > Tree Planter` selects
the existing object (or creates the first); more come from `Add Component > GolfMap > Trees`.
The component carries only data: the editor-side logic is `GolfMapTreePlanter*.cs` and
the Inspector `GolfMapTreesInspector.cs`. See [MANUAL-PLANTING.md](MANUAL-PLANTING.md)
for the biome palette, size matching, prepared material colours, backup/restore and
separate inner/outer VSP setup. Install `GolfMapTreePlanter.cs`, `GolfMapBiome.cs`,
`GolfMapTreePlanterVsp.cs`, `GolfMapVspRig.cs`, `GolfMapTreesInspector.cs`, the runtime
component and `GolfMapBiomeAtlas.shader` together for VSP.

### Courses

Nothing in the tools names a course. Each course is a `GolfMapCourse` asset
(`Runtime/GolfMap/GolfMapCourse.cs`) saved as `Assets/GolfMap/<Course>/Course.asset`; the
folder it sits in is the course folder, holding `palette.json`, the fallback trees file, VSP
storage, catalogues and `Zones/`. The asset records the scene name, the pipeline export folder
and file prefix (`<prefix>-inner-trees.json` ...), and the inner terrain's names.
`GolfMapCourses.cs` resolves the active course: the one whose scene name matches the open
scene, else the only course in the project; a `GolfMap Trees` component can pin one
explicitly. A project with a single `Assets/GolfMap/<Course>/palette.json` and no course
asset is adopted on first use (Vreta was). **GolfMap > Course > New course for this scene**
creates one by hand. Reports go to `GolfMapSpelunk/<Course>_*.txt`.

### Palette panel

The `GolfMap Trees` Inspector has three panels: **Inner**, **Outer** and **Palette**. The
palette belongs to the course - both areas plant from it - so it sits beside the area panels,
not inside them, and its preview counts every area that has a survey loaded. **Palette**
(`GolfMapTreePalette.cs`) edits the course's `palette.json` in place: the broadleaf species weights (any species name; add and
remove), every matching rule, the seed, and each asset's enabled flag and pine weight.
The file stays the source of truth and both sides may edit it: the tab reloads when the file
changes on disk, and asks first when it holds unsaved edits. `GolfMapPalette`
(`GolfMapBiome.cs`) reads and writes through a lossless document (`GolfMapJsonDoc.cs`), so
keys the tools do not model (`catalogue`, `zones`, `originalPath`) survive, untouched numbers
keep their text, and the output matches the node scripts' `JSON.stringify(p,null,2)` - a
one-weight edit is a one-line diff.

**Looks** (`GolfMapTreeLooks.cs`). A species' shapes - its prefabs, i.e. sizes and LOD sets -
draw with the same few materials, so material settings belong to the species, not to a
prefab. A look is a named set of copies of those materials plus a generated copy of each
shape pointing at them (VSP draws a prefab with that prefab's materials, so each copy is its
own VSP item; meshes and textures stay shared), under `<course>/Looks/<species>/<look>/`.
The `original` look is the source prefabs untouched. Looks are created, tuned, weighted and
shown in the Lab in [Vegetation Palettes](#vegetation-palettes-palette-editor); the panel lists
each species' looks with their weights and preview counts and opens it there (**Tune**). Save
records each look's material values in `palette.json` (`species.<label>.looks[].materials.<source
material guid>`: shader, floats, colours, vectors, textures by guid, keywords); **Regenerate**
recreates missing copies and writes the recorded values onto them, which is how a palette
rebuilds its looks in another project. Never edit the generated prefabs; stay on GSPro-safe
shader names (the Plant check covers look copies too).

Matching (`GolfMapBiomeMatcher`, mirrored by `tree-matching.mjs`; `biome-parity-fixtures.mjs
<trees> <out.tsv> [palette]` + `BiomeParityCheck.cs` prove the two agree): an asset without a
`species` races under its kind, so `speciesWeights` can carry `conifer`/`pine` as well as the
broadleaf species - a kind with no weighted species is matched as before. `selectionWeight`
on any asset shares its species' stems between the variants that fit (pine keeps its wider
0.5 band). `species.<label>.looks[] = {id, weight, shapes?}` splits a species between looks
(material settings, shared by all its shapes); the look is drawn on its own hash, so adding
one never moves a stem to another shape. All three are opt-in: a palette without them
matches exactly as it did.

**Tree species areas** override the palette's mix where you know better ("this grove is almost
only oaks"). Draw them in the web app (Vegetation mode, zone-type picker → **Trees → Tree
species area**) and give each a mix such as `oak=9, birch=1` (relative weights, names are the
palette's species labels). Export the trees again (the app passes `--course`): the file carries
the areas and every stem inside one names it (below). Inside an area every species of its mix
with an enabled asset of the stem's form races by the area's weight - no `speciesFitSlack`,
the fit only picks the size - and a stem the survey classed conifer (or broadleaf) keeps the
palette unless the area has **Also where the survey says conifer/broadleaf** (`ignoreKind`)
on. A stem with no such asset (a shrub-size stem, a conifer in a pure oak area) falls back
to the palette. A hand-picked species or asset still wins over the area. **Load and check**
lists each area's asked mix against what it got and warns about species with no enabled
asset; **Plant** applies it.

`rules.scaleJitter` (0.1 = ±10%) and `rules.maxLeanDeg` add cosmetic per-stem variety after
the fit, each on its own hash: neighbours of the same measured height, or pinned at
`minScale`/`maxScale`, stop looking like copies. Jitter may take a stem past the scale limits
by that fraction and never changes the pick or the review status; hand-edited stems keep their
exact size. The lean tilts the tree in its own frame (turning it turns the lean); Unity
terrain-tree planting cannot tilt and ignores it. Both default to 0.

After **Load and check**, the tab previews the draft against the survey: target share, the
share and count the matcher actually produces, the share at the last check, per-asset
counts, and how many stems would change asset. Weights are preferences - a species only
wins stems one of its assets fits within `speciesFitSlack` - so the preview, not the
weight, says what gets planted. Saving changes no planted tree; **Plant** applies it.

`GolfMap > Configure course planter` configures the active course's
inner import without planting. Use **Load and check**, then **Plant** manually.
An empty **Biome JSON** means the course's palette, `Assets/GolfMap/<Course>/palette.json`
(the Unity copy is the source of truth; `docs/gspro/vreta/palette.json` is a snapshot of it). Biome mode uses uniform scale and deterministic
species/size matching. Legacy lists remain available with biome mode switched off.

Outer files require a separate VSP system and inner-terrain exclusion. Both mesh
render distances are zero; billboard atlases use the prepared material tints.
Native TerrainInstances/GameObjects remain available for inner planting only when
billboard-only mode is off. Check terrain compatibility before using native trees.

### VSP rig shape (`GolfMapVspRig.cs`)

Systems the planter creates are built in the shape VSP's own *Add Vegetation Studio
Pro to scene* wizard produces, because that is what GSPro is written against:

- the object is **named `VegetationSystemPro`** — both of them. GSPro's shader-controller
  remap resolves the system by that name and null-refs on a renamed one, and the course
  then renders no vegetation at all (diagnosed by OPCD's John Meyer from the GreenKeeper
  logs). Duplicate sibling names are legal; nothing of ours identifies a system by name,
  the planter goes by its storage asset under `Assets/GolfMap/` plus a terrain
  bounds match (`IsGolfMapStorage`).
- it is a **child of the `VegetationStudioPro` manager object**, with `TerrainSystemPro`
  and `ColliderSystemPro` beside the storage.
- **no camera in the camera list.** VSP's `Reset()` seeds it with `Camera.main` as soon as
  the component is added; GSPro destroys the course camera on load and only falls back to
  its own when the list is empty, so a serialised camera leaves the system bound to a dead one.

`GolfMap > Fix vegetation systems for GSPro` brings scenes planted before this
into the same shape and prunes retired catalogue items; it is safe to re-run and reports
what it changed. Re-parenting never moves trees — stored instances are relative to
`VegetationSystemBounds`, not the transform.

Two systems are deliberate, not duplication: inner draws mesh LODs over 2050 m bounds,
outer draws billboards only over 5000 m with `PlantDistance` 0, and VSP settings,
bounds and storage are all per-system.

### Shader names GSPro can resolve

VSP picks a shader controller by **exact shader name**, matched against hard-coded lists
(`NatureManufacture Shaders/Trees/Tree {Bark,Leaves} {Metalic,Specular}`, `CTI/LOD {Bark,
Leaves,Bark Array}`, `Nature/SpeedTree`, TreeCreator, FAE, AM, Polygon). The Asset Store
VSP in this project ends its lookup with `return new DefaultShaderController()`, so a
shader it does not know is completely invisible in the editor.

GSPro ships a **forked** VSP runtime — it has `SetShaderControllers(GameObject _sourceLOD0)`,
`Arb_*ShaderController` and `useShaderControllerOverrides`, none of which exist in the
project's copy — and that lookup has no fallback. An unrecognised shader throws
`NullReferenceException` out of `VegetationItemModelInfo..ctor`, which aborts
`SetupVegetationItemModels` for the entire package: one renamed shader removes *every*
tree in that system from the course, with nothing in the Unity console. `PrepareBiome`
rejects unrecognised names before planting (`VspKnowsShader`; its allow-list is this
project's controllers plus the handful GSPro's newer build adds, `Cross Model Shader`
among them, which the palette's pines need). Colour belongs in the item's
shader-controller settings (what `Refresh vegetation from materials` syncs), not in a
renamed copy of an NM or CTI shader.

Forst's own CTI shaders are named `CTI/LOD Leaves 301` etc., which neither GSPro build
matches. `prepare-cti-trial.py` copies them under the stock `CTI/LOD Leaves`/`Bark`/`Bark
Array` names, and `golfmap.cti.status|apply|restore` swaps them onto the palette oaks and
birches reversibly, with a backup under `GolfMapSpelunk/cti-trial/`. `prepare-cti-maps.py`
tunes the look with texture copies (NM tint baked in, leaf reflection zeroed). See
[tree rendering fixes](../docs/tree-rendering-fixes.md) for the IL evidence, the result so
far and how restore handles the open editor.

`prepare-oak-nm-shader.py` moved the four `PF_Oak_* Terrain` prefabs off
`GolfMap/CTI Oak {Bark,Leaves} Tinted` onto NM's `Tree {Bark,Leaves} Metalic`, the way the
birches went earlier — decoding the CTI-packed normals (X in alpha, Y in green) and packing
bark AO and smoothness into NM's `_MetalicRAOGSmothnessA`. The stock oak materials were no
help: they use `CTI/LOD Bark 301` / `CTI/LOD Leaves 301`, which are not on GSPro's list
either. Both materials keep their path and guid, so prefabs, palette and catalogues still
resolve, but the catalogue caches `ShaderName` — run `Refresh vegetation from materials`
after any shader swap and it re-derives the moved items.

Oak reflection fix (2026-09-17, confirmed by Marcus in Unity; GSPro not yet checked):
`prepare-oak-specular.mjs UNITY_ROOT NEW_STAGE` stages the existing oak leaf material on
the stock NM `Tree_Leaves_Specular` shader with `_SpecularPower = 0` and
`_SmoothnessPower = 0`. The metallic shader retains dielectric reflection even at
metallic/smoothness zero and does not compile `_SPECULARHIGHLIGHTS_OFF`. The specular
shader permits zero reflectance in Unity 2018's desktop BRDF. This keeps the current
albedo, tints, normal map, clipping and wind, and carries the AO map's green channel
into `_AmbientOcclusionGSmoothnessA`. The stage includes an exact `before/` backup.
Apply only the staged `Oak Leaves.mat`, refresh vegetation from materials, and compare
the same oak at both angles in Unity when applying it to another setup.
Billboards need rebaking before export; GSPro appearance still needs verification.
See [tree rendering fixes](../docs/tree-rendering-fixes.md) for the exact change,
reproduction, rollback and recurring troubleshooting steps.

### Retired palette prefabs (`PruneCatalogues`)

VSP validates and builds models for **every** item in a package when the system loads,
planted or not. A prefab dropped from the palette stays in the `TreeCatalog` asset
forever — the planter only ever added items — and keeps logging its faults, which is
enough to take GSPro's shader-controller remap down with it. `VspRenderIssue` blocks
bad geometry at plant time (VSP draws only the first renderer per LOD, so the pre-`VS_`
poplars with 2–3 renderers per LOD came out as blobs), but it only sees the *current*
palette. So each plant now prunes catalogue items no instance in that storage still
references. An item that is still planted is never removed: to retire it, replant that
area with the new palette (Plant always replaces).

### Tree editor (manual fixes in the Scene view)

`GolfMapTreeEditor.cs` (+ `GolfMapTreeEdits.cs`) adds a **Tree editor** section to the
GolfMap Trees Inspector for PersistentStorage mode. With the trees file, terrain, biome
and the planted storage selected, **Start editing planted trees** (or `GolfMap > Tree
Editor`) indexes every planted stem and takes over the Scene view while the object is
selected, the way Unity's Terrain tools do. Selecting something else pauses the editor;
selecting the object again continues the same session (the Delete key never deletes the
object while editing).

- click a tree to select it (shift-click adds, Esc clears); nearby stems show as faint discs
- drag the position handle to move (snaps to the ground meshes/terrain on release), the red
  disc to rotate, the cube above the crown to resize height and crown radius together
- the Inspector shows height, crown radius, rotation, species and asset for a single selection;
  **Apply** re-matches the tree with the biome rules restricted to that species/asset
- **Delete** (button or key) removes the selection; **Click adds a tree** places a new stem of
  the chosen species/size where you click
- **Reset to survey** drops the record and re-places the tree as the survey has it

Every change is applied to VSP storage immediately and recorded in
`<course>-<terrain>-tree-edits.json` next to the trees file (one record per tree id:
`modify`, `delete` or `add`, with the resolved state and any species/asset/rotation
override). The planter applies that file on every **Load and check** / **Plant**, so
replanting, regenerating the survey or rebuilding the project keeps the manual work.
A record whose id no longer exists falls back to the nearest survey stem within 1 m of its
original position; unmatched records are reported and left in the file. There is no Unity
undo for editor changes: use Reset to survey or the planting backups.

### Refreshing after a material edit

`GolfMap > Refresh vegetation from materials` (`GolfMapVegetationRefresh.cs`)
picks up edits to leaf/bark materials **without replanting**. VSP stores the NM shader-controller
colours (bark `_Color`, leaf `_HealthyColor`/`_DryColor`) in the vegetation package and overrides
the prefab's material with them when it draws, so editing the `.mat` alone changes nothing on
screen; the rest of the material state (maps, smoothness, normals) is cached per item. The menu
item re-syncs those colours from the prefabs, then calls `RefreshVegetationSystem` + `ClearCache`
on every GolfMap system in the scene. It compares each storage package before and after and aborts
without saving if any instance moved. Billboards still need rebaking.

## Vegetation Palettes (palette editor)

`GolfMap > Vegetation Palettes` (`GolfMapVegPaletteWindow.cs`; model `GolfMapVegPalette.cs`,
scene side `GolfMapVegLive.cs`, CTI tint bakes `GolfMapVegBake.cs`, shared working copy + bridge commands `GolfMapVegSession.cs`)
tunes the course's lower vegetation (`grass-palette.json`: texture grass and mesh bushes) and
its tree looks (`palette.json`) in one window, with the result live in the Scene view.

**One list, one set of settings.** The left pane lists every grass palette with its items and
every tree species with its looks: thumbnail (grass: the greyscale texture VSP draws, tinted),
healthy/dry chips, a dot for unsaved edits, `×n` for an item several palettes list, `!` for an
item VSP does not have yet. An item listed in several palettes is one VSP item, so it is one
entry here: an edit changes it in every palette (Save writes all the file's copies); only its
binding weight (`maxDensity`) is per palette. Every entry has the same kinds of settings -
healthy/dry tint, bark, size, spacing, noise, shading, LOD, material floats - so a selection can
mix palettes, bushes and tree looks. Click selects, Ctrl-click adds, Shift-click adds a range,
clicking a palette or species takes all of it; arrows move, F (or double-click) goes there.

**Adjust together** grades the whole selection relative to where it stood when the first slider
moved: brightness, saturation, hue and warmth (linear light, on the healthy/dry/bark tints you
tick), height, width, density (instances per m²: spacing scales by 1/sqrt) and size spread (the
min..max scale range around its middle). Drag back to 0 to undo one slider; **Keep** makes the
result the new start, **Reset** goes back. Below it, every setting of the selection: a mixed
value shows a dash, setting it sets all. **Copy / Paste** copies one item's settings onto the
selection by kind (colours, size, placement, shading, rendering, material).

**Live.** Every change is pushed as the slider moves, without apply or replant:

Lower vegetation also supports `noiseCutoff` (0 disables it) and `noiseCutoffScale`
to leave open stretches between shrub groups. Equal clump settings align the
openings across species. `verticalOffset` lowers a canopy into the bank when
negative; it is in prefab-local metres and scales with the instance (for example,
−1.5 at 0.2 scale lowers it 0.3 m before additional scale variation). These values
are saved in `grass-palette.json` and survive Apply/Rebuild.

| Setting | How the scene follows |
|---|---|
| tints, darkening, root ambient, alpha cutoff, tint area scale | VSP shader-controller values + `RefreshMaterials` (instant) |
| width/height, scale, spacing, density, noise, slope, distance falloff | the item's cells cleared and respawned (`ClearCache` per item; throttled while dragging) |
| LOD factor, shadows | read at draw time |
| tree look colours and material floats | the look's material assets (the Lab draws them), then the planted trees' catalogue items: NM/CTI/SpeedTree controller values + VSP's material copies |
| bush material floats | VSP's material copies (and the course-local prefab copy when there is one) |
| texture white point, a bush's first material override | **Rebuild VSP** (save + `golfmap.grass.apply`, zones import + apply again when items were added/replaced) |
| binding weight, look weight | file only: re-bind + export zones / the next Plant |

Outer tree billboards keep their baked colours until a Plant with rebake. Nothing is written
until **Save** (minimal diffs: untouched numbers keep their text); **Revert** puts the saved values
back into the scene; Ctrl+Z undoes edits and the scene follows. **A/B** flips the scene between the
edits and the saved values. **Solo** hides every other lower-vegetation item while judging a few
(`EnableRuntimeSpawn`, put back on unsolo, close, scene save and script reload). **Go to** frames
the Scene view where the selection grows most (grass: the imported zone masks, densest first;
trees: planted instances) - click again for the next spot; **Views** saves Scene view positions
per course to come back to after each change. A file changed on disk (by hand, an agent, the Trees
Inspector) is reloaded and the scene follows it while nothing is pending in the window.

**Tree looks.** A species that plants with a pack's own materials is read-only: **Create a
tunable look** copies its materials and prefabs (`GolfMapLooks.Generate`; the source stays as
`original` at weight 0, so the next Plant uses the copy). An `original` whose materials are all the
course's own copies (`FoliageTrialV2`, the CTI trial) is tuned in place. **Duplicate** branches a
look, **Remove look** drops it from the palette (the last one returns the species to its source
materials), **Show in Lab** stands one plain instance per look and shape at the Scene view pivot
(rows = looks, columns = shapes by height) under `GolfMap Lab (not saved)`, never saved or built.
Values are read from the materials a look's prefabs really draw with: while a trial re-points them
outside the look folder (the CTI swap), the window says so - edits then change those materials in
place and Save does not record them in `palette.json`. Values that two looks share (the same
material or baked texture) are kept equal.

**CTI trees (baked tints).** The CTI shaders have no tint: their colour is the albedo texture
(`prepare-cti-maps.py` bakes source x tint into course copies). The editor treats that tint as the
leaves' healthy tint and the bark colour (`GolfMapVegBake.cs`): when a slider is let go (and the
value has settled for 0.35 s), it bakes the same formula in Unity - from the lossless source copy
prepare-cti-maps.py leaves in `GolfMapSpelunk/cti-trial/sources/` (bit-identical to its bake; without
it, from the DXT import) - compresses it to the live texture's format and copies it into the texture
the Lab and the planted trees draw (4K leaves: ~0.8 s). **Save** writes the PNG and records the tint
in `CTITrial/trial.json` (`source`, `tint`); a recorded tint wins when prepare-cti-maps.py runs again.
The birch bark samples a Texture2DArray (`CTI/LOD Bark Array`): its first bake makes a course copy
(`CTITrial/Textures/Birch Bark Array ... tinted.asset`, DXT5 like the source), points both birch bark
trial materials at it and records the override at once. Tick **bark** in Adjust together to grade it
with the leaves; a baked tint may go above 1 (brighter than the source).

Bridge (the same working copy as an open window): `golfmap.vegpalette.list` (entries, values,
unsaved, `vspDiffers` where VSP disagrees with the file), `.adjust {select, brightness, ..., set,
save}`, `.save`, `.revert`, `.spots {select, goto}`, `.look {action, species, ...}`, `.rebuild`,
`.show {select}` (open the window on a selection). Selection patterns: a palette key or glob
(`creek_bank/*`: its items), an item name or glob, `tree:<species>[/<look>]`, `trees`, `grass`, `all`.

## Vegetation Zones

`GolfMap > Vegetation Zones` (`GolfMapZoneImporter.cs`, VSP half in
`GolfMapZoneImporterVsp.cs`, model in `GolfMapZones.cs`, bridge commands in
`GolfMapZoneImporterBridge.cs`) imports a `unity-zones-v2` export (`gspro.py zones`, one per
terrain: `<course>-<inner|outer>-zones.json` plus `<course>-<inner|outer>-zones-<n>.png`,
next to the trees files in the export folder) into Vegetation Studio Pro texture masks.
Plan and format: `docs/feature-vegetation-zones.md`. A `unity-zones-v1` file is refused
("re-export zones from golf-map").

**One mask channel per VSP item, not per zone type.** VSP multiplies an item's texture-mask
density rules (`SpawnChance *= value/256 * DensityMultiplier` per rule) while include rules OR,
so an item bound to two channels would only grow where both are non-zero. Zone types have
**variants** (a named item mix each; a drawn zone picks type + variant, none = the type's Default
mix), and variants share items, so the pipeline bakes each item's final density (sum over the
type/variant slots binding it, times their `maxDensity`, clipped to 1) into its own channel and
the importer gives every item exactly one density and one include rule against it.

**Bush height** (`GolfMapZoneImporterHeight.cs`, D-VZ17): when a zone sets `heightMin`/`heightMax`, the
export has a `height` block and `<stem>-height.png`. The importer adds the group `golfmap-zone:height`
and, for every bush (prefab) item the block names, a twin item `<item> @height` (min = max scale 1, no
noise scale) with a density and an include rule on the item's own group, an exclude rule where the
height mask is 0 and a scale rule on it (`ScaleMultiplier` = 12.8 / the prefab's height at scale 1).
The item itself is excluded where the mask is above 0. The report lists the twins with the measured
heights, and items whose prefab gave no height. `golfmap.grass.apply` refreshes a twin from its item;
twins no export needs are removed at import.

1. Pick the zones JSON, **Load and check**. The importer validates the format, the plot,
   that every mask PNG exists and is square at `resolution`, that `items[]` texture/channel
   agree with `masks[].channels`, and the zone types, variants and zones (an unknown variant
   or source key is a warning, not an error). The summary lists, per zone type, the zone
   count per variant, and every item with its channel and sources. The terrain is matched by
   plot side (2050 m inner, 5000 m outer), and the VSP systems covering that terrain are
   listed the way the tree planter matches storage (terrain in the system's list, bounds =
   square + 1 m). The package defaults to the system's `Default`-biome package that is
   not a planter tree catalogue; both are popups if the guess is wrong. The tool never
   creates a system: plant trees first so `GolfMapVspRig` builds it.
2. **Preview import** shows what Import would change (groups to create, update and delete,
   rules to add, update and remove, bound, missing and unbound items) and writes nothing.
3. **Import masks and rules**:
   - copies each PNG to `Assets/GolfMap/<Course>/Zones/` and imports it readable,
     RGBA32, uncompressed, no mipmaps, clamp, linear, Max Size >= resolution (VSP samples
     masks on the CPU with `GetRawTextureData`, so nothing else works);
   - creates or updates, in place, one RGBAChannel **Texture Mask Group** per exported item,
     named `golfmap-zone:item:<item name>`, with the item's texture over the terrain's world
     rectangle and the group's channel selector set to the item's channel;
   - **deletes** every other `golfmap-zone:*` group (v1 per-type groups, items no longer
     exported, duplicates) and removes every rule, in any item's density, include, exclude or
     scale list, that points at a golfmap group other than that item's own. Groups are removed
     from the list directly: VSP's own `DeleteTextureMaskGroup` switches an item's include rules
     off when its list empties, which would let it carpet the terrain;
   - for every exported item found in the package (by `Name`: exact, then trimmed, since
     Arborist biomes carry trailing spaces) keeps exactly one **Density** rule (min 0, max 1,
     `DensityMultiplier` 1: the density is in the pixels) and one **Include** rule
     (`MinDensity` 0.02) against its own group, created or updated in place (matched by group
     id). Hand-authored rules (non-golfmap groups) and everything else on the item are untouched;
   - calls `RefreshVegetationSystem` + `ClearCache` on the system so runtime spawn picks
     the masks up, saves assets and marks the scene dirty (save it);
   - writes `<UnityProject>/GolfMapSpelunk/<Course>_zone_import.txt`: items bound
     (item <- sources), exported items missing from the package, package items with no export
     entry and what VSP will do with them, groups created/updated/deleted, rules
     removed/added/updated, rules pointing at groups the package does not have. The window
     shows the same summary.
4. **Draw zone outlines** draws every zone's rings in the Scene view with Handles in the
   zone type's colour at terrain height (plus the lift), with the zone id, type, variant and
   weight at the centroid (always, or on hover only). Read-only; it exists to check
   alignment against the terrain and the trees.

Unbound package items (no export entry) lose their golfmap rules. With include rules on and no
include rule left VSP spawns them **nowhere**: `UnityTerrainSampleJob` resets each spawn
location's `TextureMaskData` to 0, only a passing include sample sets it to 1, and
`FilterIncludeMaskJob` (scheduled whenever `UseTextureMaskIncludeRules` is on, rules or not)
excludes every location still at 0. A rule on a group the package no longer has is skipped the
same way. The report says per item which case applies; `golfmap.grass.apply` switches runtime
spawn on only for items with an include rule on an existing group.

Bridge (`unity_command`): `golfmap.zones.check` (`terrain=inner|outer` or `file`, `package`)
loads and returns the summary plus the import `plan`; `golfmap.zones.import` (same args,
`dryRun=false`) imports, and with `dryRun=true` validates the target and returns the plan
without writing anything. `save=true` on `zones.import` and `zones.patch` saves the scene and the package
asset once the import succeeded (["Saving what a command changed"](#saving-what-a-command-changed-save)).
The full result lists every texture, mask group, rule and bound item
(and a `status` repeating them); `brief=true` (both commands, default false) keeps the plan's
`summary`, `missing`, `unbound` and `dangling` and turns the other lists into counts, drops the
package list and cuts `status` to its first line. Agents should pass `brief=true`.

Woodland floor (D-VZ10): `woodland_floor` zones come from the pipeline's `woodland-features`
(one per closed stand, weight from the lidar understory) and arrive here like any other
type. Bind the understory items (ferns, blueberry, moss
clumps, deadwood, forest saplings) to it in the web zone-type panel; the importer does the
rest. The ground colour under the stands is not a VSP job: it is baked into the terrain
texture by the orthophoto export ("Forest floor under woodland stands" in the app's Export
to GSPro panel, `gspro.py ortho --floor-course`). The zones JSON and masks come from the
same panel's "Export inner/outer vegetation zones" buttons (after the heightmap). The
panel's "Remove buildings" (on by default) fills the photographed roofs and their shadows
from the ground round them, so the building planter's prefabs do not stand on a picture of
themselves.

Limits: VSP has no density floor, so a binding's `minDensity` is carried as information
only; the include threshold is fixed at 0.02. Groups are one texture each, and `Repeat` is
always 1. A mask pixel of 255 gives VSP a factor of 255/256.

## Trees file format: unity-trees-v1

Produced by `gspro.py trees` (the app's "Export inner/outer trees") from the lidar
`tree-stems.json` over one terrain square. Plain JSON that `JsonUtility` can parse:
objects and lists, no nested arrays.

```json
{
  "format": "unity-trees-v1",
  "plot": {
    "crs": "EPSG:3006",
    "terrain": "inner",
    "originX": 651200.0,
    "originY": 6403500.0,
    "sizeM": 1500,
    "minM": 12.4,
    "maxM": 71.9
  },
  "trees": [
    { "id": "epsg3006:651612.31:6404380.02", "x": 412.31, "z": 880.02, "h": 14.2, "r": 4.1, "g": 34.85, "k": 1, "bush": false, "area": "2ba54b9b" }
  ],
  "areas": [
    { "id": "2ba54b9b", "name": "Oak grove", "ignoreKind": false,
      "species": [{ "species": "oak", "weight": 9 }, { "species": "birch", "weight": 1 }],
      "stems": 129, "rings": [{ "nodes": [{ "x": 400.0, "z": 870.0 }] }] }
  ]
}
```

| field | meaning |
|---|---|
| `plot.terrain` | `inner` or `outer`; the planter switches billboards on for `outer` |
| `plot.originX/Y` | EPSG:3006 south-west corner of the square plot the heightmap was cut from |
| `id` | stable stem id (`epsg3006:<x>:<y>`), seeds per-stem randomness so re-planting keeps unchanged trees |
| `plot.sizeM` | plot side in metres, equals Unity Terrain Width and Length |
| `plot.minM/maxM` | elevation range the heightmap was normalised over; `maxM - minM` is Terrain Height |
| `x`, `z` | metres east and north of the plot origin, Unity terrain local x and z |
| `h` | stem height above ground, metres |
| `r` | crown radius, metres |
| `g` | ground elevation at the stem, metres RH2000; used for the alignment check |
| `k` | 0 broadleaf, 1 conifer, 2 unknown |
| `bush` | crown radius above 0.35 x height, a wide low crown |
| `area` | id of the tree species area the stem stands in (only with `--course`; absent = none) |
| `areas[]` | the course's tree species areas over this square (only with `--course`): `species` the mix, `ignoreKind` the survey-class switch, `stems` how many stems name it, `rings` the outline in plot metres, clipped to the square |

Trees outside the plot are dropped by the exporter. Coordinates assume the terrain object
sits at the plot's south-west corner with x pointing east and z pointing north, which is
what the OPCD heightmap import gives with "Flip Vertically" ticked.

Outer files leave out the stems on the inner square, and their crown kind is unknown
(`k` 2): the leaf-off orthophoto that classifies crowns only covers the inner square, so
the planter's unknown/broadleaf fallback dresses them.

## Building Planter

A building is two jobs: a flat pad on the terrain and a prefab on it. The pad is
the pipeline's business (`golfpipe building-pads` → terrain edits → the heightmap
you import), so import the heightmap **with the pads** before planting. The
prefab side mirrors the tree assignment flow:

1. `gspro.py buildings` (the app's building export) writes `<course>-<inner|outer>-buildings.json`
   (`unity-buildings-v1`, below) from the `fetch-buildings` survey.
2. Measure the building prefabs with **GolfMap → Export Asset Catalogue** over the building
   folders (it measures any prefab: `size` is the root-local bounds), and write a
   `golfmap-building-palette-v1` palette from it: `assets: [{ guid, name, path, lengthM, widthM,
   heightM, kinds: ["detached", "house", "yes"], axis: "x" | "z", enabled }]` — `lengthM` is the
   long side, `axis` which local axis it lies on; `kinds` are the OSM `building` values the
   prefab suits (empty = any). Optional `center: {x, z}` (plot metres; default the plot centre)
   and `rules` (see `building-matching.mjs`: `reviewRadiusM` 400, the `near`/`far` scale bands,
   weights, `unmeasuredHeightM`).
3. `node unity/match-building-palette.mjs <buildings.json> <palette.json> <report.json> [overrides.json]`
   scores every building on footprint length × width × height against the palette — XZ scale
   uniform (the prefab keeps its proportions), Y scale separate (the lidar height is real), both
   clamped to the `far` band, or the tight `near` band within `reviewRadiusM` of the course, where
   a bad fit becomes `review` instead of a stretch. Rotation is the survey's `yawDeg` (+90 for an
   `axis: "z"` prefab, +180 for an override `flip`). Overrides are keyed by building id:
   `{ "osm:way/123": { guid, footprintScale?, heightScale?, rotationY?, flip?, position? } }` or
   `{ exclude: true }`. Buildings near the course come out `review` on purpose: choose the prefab
   or model them by hand there, let the far ones through as `proposed`.
4. **GolfMap → Buildings → Plant from assignments** (`GolfMapBuildingPlanter.cs`): pick the survey,
   the report and the terrain; *Validate* checks the report's `sourceHash` against the survey, the
   plot against the terrain, every prefab, and probes the four rectangle corners of every building —
   a spread over 0.3 m means the pad is missing from the heightmap. *Plant* instantiates each
   `proposed`/`authored` (and, if ticked, `review`) building as a GameObject under
   `GolfMap Buildings` on the terrain, at the survey position on the terrain height, rotated and
   scaled per the report, with Undo, and writes `GolfMapSpelunk/<terrain>_building_import.txt`.
   Not VSP: buildings need their colliders.

## Buildings file format: unity-buildings-v1

Produced by `gspro.py buildings` over one terrain square, `plot` exactly as the trees file.
JsonUtility-shaped: no nulls in number fields (0 = unmeasured), the footprint a flat list.

```json
{
  "format": "unity-buildings-v1",
  "plot": { "crs": "EPSG:3006", "terrain": "outer", "originX": 651200.0, "originY": 6403500.0, "sizeM": 5000, "minM": 12.4, "maxM": 71.9 },
  "buildings": [
    { "id": "osm:way/192239176", "kind": "detached", "name": "", "x": 412.31, "z": 880.02,
      "lengthM": 12.4, "widthM": 8.1, "yawDeg": 327.5, "eaveM": 4.2, "ridgeM": 6.8,
      "heightM": 6.8, "heightSource": "lidar", "areaM2": 98.3,
      "footprint": [406.2, 876.0, 418.4, 876.0, 418.4, 884.1, 406.2, 884.1] }
  ]
}
```

| field | meaning |
|---|---|
| `id` | the OSM element (`osm:way/…`), stable across refreshes; overrides key on it |
| `kind` | the OSM `building` value (detached, garage, apartments, yes …) |
| `x`, `z` | rectangle centre, metres east/north of the plot origin (Unity terrain local x, z) |
| `lengthM`, `widthM` | the footprint's minimum rotated rectangle, long side first |
| `yawDeg` | Unity rotation about Y (clockwise from above) that turns local +x onto the long axis |
| `eaveM`, `ridgeM` | lidar roof heights (p20 / p95 of the nDSM inside the footprint), 0 when unmeasured |
| `heightM`, `heightSource` | ridge (`lidar`), else the OSM `height` tag (`tag`), else levels × 3 m (`levels`), else 0 (`none`) |
| `footprint` | the footprint ring, flat `x0, z0, x1, z1, …` in plot metres |

Outer files leave out the buildings on the inner square, like the trees file.

## Bunker Materials

`GolfMap > Bunker Materials` (`GolfMapBunkerMaterials.cs`, model in `GolfMapBunkerChannels.cs`)
matches bunker and bunker-blend materials to the vertex paint made in Blender. The paint
conventions come from `blender/conventions/bunker-channels.json`; copy it into the course
folder (`Assets/GolfMap/<Course>/bunker-channels.json`, the window's default) or pick it.

- **Check paint** (read-only) tallies each bunker's dominant vertex colour per ring counted
  in from its seam, and each blend's colour on the edge it shares with the bunker (within
  5 cm) and its outer edge, then scores every convention. A bunker painted the ce.simgolf way
  (red lip, black, green sand) on an OPCD default material (green = dirt) shows as `!!`.
  It also flags meshes whose renderer no longer shows the render material of their OPCD
  `ChannelMaterials` asset. Report: `GolfMapSpelunk/<Course>_bunker_paint.txt`.
- **Build and apply** works the way OPCD's own channel editor does. OPCD keeps, per mesh, a
  `MeshChannelMaterialsStore` pointing at a `ChannelMaterials` asset (render material plus a
  source material and source channel per paint channel), and the MAHS shader keeps each
  channel's settings under `_Red*`/`_Green*`/`_Blue*`/`_Black*`. The window creates, per
  original OPCD material, a render material whose channels are copied (properties and
  keywords) from the convention's sources, a matching `ChannelMaterials` asset, and points
  the renderer and the store at them. `$bunker`/`$blend` are the mesh's original material,
  `$outer` the source of the blend's original Black channel (not
  `BlendTarget.BlendToMaterialBlack`, which on Vreta names the Satellite-theme rough); for a bunker mesh,
  the `$outer` most of its blends have (by vertex count; the material name then ends `in <outer>`). A rule's
  `base` (default the mesh's own original) is the material the render copy starts from, i.e. where the settings
  outside the four channel blocks come from (`_SlopePower`: 0.678 on the rough, 0.2 on OPCD's bunker blend,
  enough to shade the strip differently from the rough beside it). A `tint` (the fake rolled-lip
  shadow) or `blendStrength` is baked into its own source material so an OPCD rebuild from
  the asset gives the same look. Output: `Assets/GolfMap/<Course>/Bunkers/<convention>/`.
  Originals are never edited; Undo works.
- **Restore OPCD materials** puts back the material and `ChannelMaterials` asset each mesh
  had before its first apply (`Bunkers/restore.json`).

Running OPCD's theme window (SetMeshMaterialv4) reassigns bunker materials; apply again
after it.

**Bunker edges like the references** (Marcus, 2026-09-29: dense grass right up to and over the sand, the strip
the same grass as the rough, no pale strip, no brown band). What made Vreta's edges wrong, and the fix for each:

| Seen | Cause (evidence) | Fix |
|---|---|---|
| Pale speckled strip round every bunker; white blades on the rough next to it | Every channel of the MAHS `_Sat` materials (rough, blend, bunker) with *Use Satellite for Base* takes its base colour from `_Satellite`, and Stix colours each blade by `_ColorMap` (`color = tex * lerp(main, sec)`, `GrassGeom.hlsl`): both are the `-meshes` export. Its sand ran ~1 m past the drawn outline (photo misregistration + the 1 m soften blur + bilinear sampling of 0.5 m texels): luma 82 vs 75 on the grass 0.5-1 m out | Pipeline **edge fill** (`gspro.py ortho --edge-fill`, default `bunker,path`): the `-meshes` file gets a band from 0.5 m inside to 1.25 m outside each bunker (from the outline out for paths, whose gravel left the same grey strip) filled from the grass beyond it, ramped in and out on the exact distance to the outline (a raster band edge showed as steps along paths) ([export.md](../docs/gspro/export.md)); `golfmap.orthos.update` copies it over the project's copy |
| Dark blue blocks on the cart paths (e.g. the path by hole 13's tees), forest paths near black | Tree shadows in the photo: the path concrete (`OPCD MAHS Concrete - Asphalt_Sat`, red/green *Use Satellite for Base*; the `*Concrete*` blends the same) takes its colour from the `-meshes` ortho, which caught every shadow on the paths (Vreta: path luma median 95, p10 36; shadow pixels blue, (B-R)/luma 0.4-1) | Pipeline **path fill** (`gspro.py ortho --path-fill`, default on): inside every path the shadow is lifted to the sunlit path colour round it, keeping the gravel's grain ([export.md](../docs/gspro/export.md)); `golfmap.orthos.update`. Since 2026-10-04 the path meshes draw their own surface without the satellite (`golfmap.paths.materials`, "Cart paths"); the fill still matters for `look=photo` |
| Brown dirt band, sparse blades on the rough side | `paint.json` `bunker-surround` painted black (`replace`): red down to ~0.1, so Stix (blade chance = red) thinned out and the rough's black channel (roots, debris) showed | Channel blue, mode `overlay` (red stays 1, the grass untouched); then off, see the next row |
| Root and twig streaks round every bunker, still there with the blue overlay | On `OPCD MAHS Rough No Mowlines_Sat` **blue and black draw the same ground**: base index 4 (dirt) with a root/twig detail (detail 20 / 22, opacity 0.5, 0.7 / 0.48 channel opacity), so moving the band from black to blue changed nothing. Probe: rough `c6_1` at 3b red 1, blue up to 0.38 | `bunker-surround` **`enabled: false`** (the rule stays in `paint.json` with its tuning): the rough is clean red up to the blend (Marcus prefers the rough's look). A wear band without roots would need a rough material whose blue channel is not the dirt base |
| Orange root streaks in a ring round 18_1c and 18_1d only, rough red 1 in the FBX, Blender and probe | A **VertexPainterPro stream** (OPCD hand paint, `VertexInstanceStream`) on `Spline_others_d4_piece4_Rough_-_Mesh`: 385 of 4 726 vertices black-ish (min red 0.1 near 18_1c). The renderer draws the stream's colours (`MeshRenderer.additionalVertexStreams`) instead of the mesh's, so FBX syncs and paint.json never touched it; this is the black band Marcus saw with ShowVertexColors | `golfmap.paint.streams` lists streams (`golfmap.paint.probe` now reports a stream's colours as `stream`); `remove=true` takes them off after saving each to `<course>/PaintedMeshes/streams/` (Undo works). Vreta: removed 2026-09-29 (save the scene to keep it) |
| Dirt band inside the bunker edge a dark, ruled stripe | The dirt face (golfmap green = the bunker's `Sand Raked Dirt Lip` red) takes its base colour from the ortho, which the edge fill made grass-coloured there; OPCD's paint puts it on exactly rings 0-2 (0.18 m) with a sharp step to the sand at ring 3 | Convention `tint` takes `[r, g, b]`: dirt `[1.25, 1.15, 1.1]` (a little brighter, toward brown-grey), shadow lip `[0.88, 0.85, 0.8]` (was 0.8). Blender: the bunker recipes end with `golfmap.edge_jitter` (blender/README.md), which makes the dirt/sand border ragged by about one ring, seeded per bunker |
| Stix grass stops at the strip | No `GrassRenderer` on the blends; and their red runs 1 -> 0 toward the sand, so blades by red would thin out exactly at the edge | `golfmap.roughgrass.plant` plants the blends on a lip material with even density (3D grass on the roughs) |
| Strip unlike the rough | The golfmap blend's black (the bunker end) was `$bunker` red, a dirt lip; the render material kept OPCD's blend settings (slope shading) | golfmap convention: every blend channel `$outer` red, `base: $outer`; the bunker's grass lip and shadow `$outer` instead of the rough by name | `blender/tools/bunker_paint_report.py` is the Blender twin of Check paint (same
file, rings and scores) for comparing a `.blend` with the Unity scene.

## 3D grass on the roughs

`GolfMap > Plant 3D grass to roughs` (`GolfMapRoughGrass.cs`, bridge `golfmap.roughgrass.plant
material=<name>`) adds a StixGames `GrassRenderer` (it brings `NatureMeshFilter` and `grassonoffnew`
with it) to every rough course mesh in the active scene - `Spline_*` meshes that `GolfMapSurfaces`
classifies as Rough, so `*_Rough_-_Mesh` and no blends - and sets its material to `NewRough` (found by
asset name; the bridge command takes another). Meshes that already have one only get the material, so
it is safe to re-run after a mesh rebuild. One Undo step. The type is looked up by name, so projects
without the StixGames Grass Shader still compile and the action reports it missing.

The blades take their colour from the material's `_ColorMap` (the terrain ortho), sampled at world
x/z divided by `_ColorMapTiling` (the floor colour by `_TerrainSize`). Both must equal the ortho's extent,
i.e. the inner terrain size (2050 on Vreta), not 2000: a few percent off shifts the lookup by tens of metres
across the course, and rough grass next to a path turns white where it picks up a bunker or cart path from
the ortho. The action sets both from the course's inner terrain on every run (logged, one Undo step with the
rest) and warns if that terrain is not square or not at the origin, which the shader cannot follow.

**Hand-tuned values: `<course>/stix.json`** (`golfmap-stix-v1`, `GolfMapStixSettings.cs`; the repo keeps the copy at
`docs/gspro/<course>/stix.json`). Its `rough` section (shader floats such as `_TargetDensity`, `_Softness00`,
`_MinHeight00`, `_MaxHeight00`) is set on the rough material on every `roughgrass.plant` run, before the lip material
is derived from it (so the lips follow: Vreta's 0.046 rough spacing makes the lips 0.032); `wispy` and `wispyFloor` are
set by `golfmap.wispy.build` on the materials it derives. Tune by hand in the editor, then write the values there, or a
rebuild of the derived materials loses them. `before` holds the values until the last tuning, for an A/B:
`golfmap.stix.apply which=before`, `golfmap.perf.report current=true rounds=3` (the baseline at the Scene view), then
`which=current` and the same report. Vreta 2026-10-14 below hole 3's tee: 73.2 ms before, 63.6 ms after (GPU 52 -> 42 ms;
editor numbers, for direction only).

**Bunker lips** (`lip=true`, the default; `golfmap.course.refresh` runs this as step `roughgrass.plant`, so a mesh
the sync re-adds gets its grass back): every bunker blend (`*_Bunker_-_Blend`) gets a `GrassRenderer` on
`<course>/Grass/<material> Lip.mat`, rebuilt from the rough material on every run (so it follows the rough's colour
map, colours and terrain scale; hand edits to it do not survive): `UNIFORM_DENSITY` instead of `VERTEX_DENSITY` (a
blend's red fades 1 -> 0 toward the sand, which would thin the blades to nothing at the edge), `_TargetDensity` x
`lipDensity` 0.7 (it is the blade spacing: 0.021 m vs 0.03 on the rough; ce.simgolf also ran lips denser), blade
heights x `lipHeight` 1.15, `_Disorder` x `lipDisorder` 1.5. The blades grow along the surface normal
(`GRASS_FOLLOW_SURFACE_NORMAL`), so on a lip that falls into the bunker they lean out over the sand. Bunker meshes
painted with a red grass-lip ring (golfmap convention; on Vreta only 18_1c) get a renderer on the rough material itself
(blades by red: the ring grows grass, the sand none). New renderers get their `NatureMeshFilter` cache built
(`ResetCache` + `GetMeshes`). `lip=false` removes the lip renderers again. Fairway-side bunkers get the fringe too
(OPCD's blends fade every bunker to the rough, so their strip is rough-coloured: a rough collar on the fairway).

After the pipeline re-exports the orthophoto, `golfmap.orthos.update` (`GolfMapTerrainImporter.cs`) copies the export
folder's `<prefix>-*-meshes.jpg` (`match=`) over the project's copy of the same name in place (same GUID), so the MAHS
materials' `_Satellite` and the Stix `_ColorMap` - on Vreta both `Assets/Terrain Backup/vreta/vreta-orto-l2-2025-8192-meshes.jpg` -
pick it up; the old file goes to `GolfMapSpelunk/ortho-backups/`. Files with no copy in the project are only listed.
Regenerate: `bun run gspro:export -- <course> ortho --tint`, then `golfmap.orthos.update`.

An export from another source has another file name (`-cleaned`, `-clean`), which `orthos.update` only lists.
`golfmap.orthos.apply file=<export .jpg>` puts that one file onto the texture the scene's renderers sample as
`_Satellite`, in place and with the same backup; the project asset keeps its own name. It refuses when the scene uses
several satellite textures (pass `target=<asset path>`). The web panel's **Inner cleaned photo → Unity meshes** runs the
export and this command in one job. Both take `save=true` (save the scene and the reimported texture asset when it
succeeded, ["Saving what a command changed"](#saving-what-a-command-changed-save)).

## Wispy rough

**Retired 2026-10-14 for Vreta**: the Stix floor and wisps below faded out at 50 m and popped in (Marcus), so
the scene's `GolfMap Wispy Rough` was cleared (`golfmap.wispy.clear`) and wispy rough is the VSP palette
`rough_wispy` alone, drawn to 300 m with distance copies (`copies` [30, 60] in `grass-palette.json`, every
layer thinning out from 15 % of its distance, `distanceFalloff` 0.15, so no layer ends in a line; a hard
`renderDistance` popped in). Do not run `golfmap.wispy.build` on Vreta; the tool stays for
other courses (deep rough only, `stix.json` wispy / wispyFloor values).

Links-style deep rough on part of a deep-rough mesh: a rough-height floor with thin, longer, sparser blades over
it, both Stix 3D grass coloured from the ortho. Where: hand-drawn vegetation zones of type `rough_wispy` ("Wispy
rough", a default zone type; it binds no VSP items, so on top of the tall rough it only takes that grass away).
`golfmap.wispy.build` (`GolfMapWispyRough.cs`) reads the outlines from the inner zones export, so update the zone
in Unity first (web "Update N zones" / `bun run zones -- update <course> <zone>`).

- **Deep rough only** (since 2026-10-14): a rough mesh under a zone keeps its own Stix and gets neither floor nor
  wisps of ours on top; there the zone's look is the VSP wispy grass alone (rough + floor + wisps was Stix planted
  two and three times over).
- **Its own mesh.** `GrassRenderer` draws the `MeshFilter` beside it and needs no `MeshRenderer`, so each zone gets
  an object under `GolfMap Wispy Rough` whose mesh (`<course>/WispyRough/<zone id>.asset`) is the deep course
  meshes' triangles under the zone, painted for Stix alone (blade chance = red), fading over the zone's feather
  (centred on the outline). The course meshes, their paint and materials are not touched, and nothing is
  tessellated outside the zone. Vertex spacing (~1.2 m) limits the edge and the drifts.
- **Two renderers, so the wisps are added.** The floor is `<course>/Grass/<rough> Wispy Floor.mat`, the rough's Stix
  material with the blades `floor` times as long (default 1.3: 0.18 m against the rough's 0.14 m; rebuilt from the
  rough's on every run), and it grows on the rough meshes under the zone too, over their own sward - two layers of
  floor grass there. `floor: 1` is the first version: the rough's own material asset, on deep rough only (blade
  for blade the rough's, but it read as plain rough: "golvet något högre", Marcus 2026-10-11).
  The wisps are a child object `Wisps` on a second copy of the mesh (`<zone id>-wisps.asset`, red = weight x drift
  noise: `patch`/`patchM`) with `<course>/Grass/<rough> Wispy.mat`, rebuilt from the rough's material on every run:
  the same blade made longer (`wispMin`/`wispMax` 0.20-0.38 m; 0.15-0.30 read as too short), thinner (`wispWidth` 6 mm), paler
  (`wispColor`/`wispSecColor`, multipliers on the ortho colour; defaults `1.3,1.25,1.0` / `0.95,0.88,0.62`) and
  spaced wider (`wisp` 0.15 = wisps per floor blade; 7 % at 4 mm read as too few and too thin beyond ~4 m).
  The first version put both in one material as two grass types; a blade point is then one type or the other, so
  the wisps thinned the floor and it read as shorter and sparser than the rough (Marcus, 2026-10-10).
- **Sunk VSP grass on top** (Marcus's trick): the zone type's palette (`rough_wispy` in grass-palette.json) holds
  tall texture-grass items planted below the ground with `verticalOffset` (negative, scaled with the instance): the
  card's dense clump base ends up under the mesh and only its thin tips come up through it, at random heights.
  VSP's grass patch is 0.4 m tall and both `height` and `verticalOffset` are in its own units, scaled together:
  the tips stand `(0.4 + verticalOffset) x height x scale` over the ground, so the offset must stay above -0.4
  (the first try, -0.6, hung every tuft under the mesh). Vreta: `Wispy rough - sunk wisps` (Grass Textures2/041,
  height 1.6, offset -0.22 = 55 % buried, spacing 0.46) and `- sunk seed tips` (Rustic Grass_06, height 1.85,
  offset -0.24, spacing 1.1), scale 0.7-1.6 plus height waves: tips of roughly 0.2-0.47 m. Density noise scale
  5 / 8: at 9 / 16 the tips stood in drifts with bare floor between, and more of them only filled the drifts
  (history: spacing 0.9 / 2.0, then 0.65 / 1.5 at height 1.4 / 1.6 - too few and too short). Bind with
  `bun run zones -- bind <course> rough_wispy --palette <file>`. Cream tints (`#a39c7e`, white point 0.85) on 0.6-0.8 wide
  cards read as pale clumps up close and as bright speckle from 50 m, where the Stix floor has faded out; now
  straw-green (`#7c8a58` / `#8c8a64`, white point 0.75), cards 0.45 / 0.4 wide.
- **On a rough mesh** the zone gets the longer floor and the wisps like deep rough (with `floor: 1` the wisps
  only: the rough has its Stix floor already). Other surfaces under a zone get nothing.
- **Tall grass still in the zone?** A hand-drawn replace zone takes the ground from the *generated* zones only;
  drawn zones add up (D-VZ14), so an older hand-drawn `rough_tall` zone under it keeps planting. Remove it, then
  export the zones again before judging in Unity.
- Not part of `golfmap.course.refresh` yet: re-run after a mesh rebuild. Not yet checked in GSPro, nor for frame
  rate or ball visibility.

## Cart paths

OPCD writes every path as one hard surface, concrete: its Satellite theme draws the path meshes
(`Spline_*_Concrete_-_Mesh`) with `OPCD MAHS Concrete - Asphalt_Sat`, colour from the `-meshes` ortho, so gravel, dirt
and asphalt were the same satellite-tinted concrete (with the photo's tree shadows), and the fringe strips OPCD builds
along each path (`Spline_<shape>_B_<Neighbour>_Concrete_-_Blend`) with `Blend_Concrete - Asphalt_Sat to Concrete -
Asphalt_Sat`: concrete on both edges, so the path ended in a razor-sharp line against the grass mesh beside the strip.
`golfmap.paths.materials` (`GolfMapPathMaterials.cs`) draws each path as its own surface and fades the strips:

- **Which surface.** golf-map's SVG export writes every road of a network as ONE shape (OPCD builds those best) and a
  sidecar `<prefix>-paths.json` next to the SVG (`golfmap-path-regions-v1`, `pipeline/gspro.py`): `shapes` = each
  shape's dominant surface (the Draw panel's Surface), `regions` = its pieces for Blender. OPCD names the meshes
  `Spline_<shape>_...`; the longest shape name that fits wins and the mesh wears that surface - unless the Blender
  shaping op `golfmap.split_surfaces` (blender/README.md) has cut a mixed shape apart, naming each part's surface right
  after the shape (`Spline_roads_124_gravel_0_Concrete_-_Mesh`, `Spline_roads_124_asphalt_B_Concrete_-_Blend`): that
  token wins. A mesh no shape names (older SVG, no sidecar) is the spec's `unknownSurface`; `sidecar=` points at
  another file. Vreta 2026-10-05: roads_124 (gravel lanes joining the asphalt) came through as 8 gravel + 3 asphalt
  meshes and 9 blends, the seam on the asphalt's kerb.
- **Path meshes**: `<course>/Paths/Surfaces/<surface>.mat`, a copy of OPCD's non-satellite twin `OPCD MAHS Concrete -
  Asphalt default` on the stock `OPCD 4 color Vert Paint MAHS` shader (so the MAHS knobs - near/far NRM, AO brightness,
  detail distance/opacity - and OPCD's channel tools keep working), all four channels set to the surface, satellite
  off. The surface's albedo, a MAHS map (metallic 0, AO from `occlusion`, height from `height`, smoothness x1) and its
  normal are appended as slices to copies of OPCD's `_DetailArray`/`_NormalArray` (`<course>/Paths/Arrays/`,
  `GolfMapTextureArrays.cs`, shared with the stone walls; every spec surface with textures gets a slice, in name order,
  so the arrays do not depend on which meshes a run touches - the detail copy holds ~290 MB of texels, 555 MB on disk as a text-serialized asset; OPCD's 118 MAHS materials
  all share one array set, checked). The copies sample their bytes linearly like OPCD's, so tints run darker than on a
  Standard material. Beyond `detailDistanceM` the shader's base blend takes over: base-array slice 6 repeated every
  2580 m (what OPCD's asphalt does), tinted to the surface's mean colour (albedo x AO, solved against the slice's mean),
  so a distant path keeps its colour and does not tile. Path meshes take the surface's `physicMaterial`.
- **Fringe strips fade into their neighbour.** A strip's paint is red on the path edge and black on the far edge (OPCD's
  blend convention; a strip faded by the Blender op `golfmap.path_edge_fade` is painted the other way, **green on the
  path edge and red on the far edge**, so Stix 3D grass - blade chance = vertex red - grows on its grassy part:
  the tool finds "path Green, far Red" from the paint, draws the surface on the green channel and leaves the far channel
  the neighbour's own red; `golfmap.roughgrass.plant` puts a Stix renderer on every `*_Concrete_-_Blend` with green paint); the tool checks it per strip (boundary vertices within 5 cm of the road meshes' boundary = path
  edge) and reports the tallies. It then casts rays down 15 cm past the far edge, takes the material of the mesh found
  there (the name's neighbour type preferred, e.g. `*_Deep_*` for `_B_Deep_`; course-local copies under
  `Assets/GolfMap/` skipped) and the paint channel that mesh shows there, and builds `<course>/Paths/Surfaces/<surface>
  to <neighbour material>.mat`: a copy of that material (its grass channels byte for byte the mesh's beside the strip),
  arrays swapped for the extended copies, the far channel (black) given the neighbour's painted channel (red on Vreta:
  a rough's black is roots and dirt), the path channel (red) the surface with its height map and
  `fringeBlendStrength`. MAHS mixes channels by height x paint x blend strength, so stones and grass interleave across
  the strip instead of a linear cross-fade. On the current meshes the strips are ~10 cm wide (Blender widens them later):
  judge the fade at 1.2 m eye height close up. Blends keep their collider physics. A `*Concrete*` blend whose OPCD
  channels name no concrete (a fairway blend OPCD named after the path it meets) is left alone.
- **Road to road**: a strip between two roads (`Spline_<shape>_B_Concrete_-_Blend`, path edge = its own road) whose
  rays land on another road fades into that road's surface (`<surface> to <other>.mat`, one per ordered pair: the
  owning road's surface material with the far channel the other surface). Pairs listed in `sharpPairs`
  (asphalt/concrete) and same-surface pairs keep a hard edge: the owning road's surface material. No road and no grass
  found: reported in `problems`, the strip wears its road's surface. (Not yet seen on Vreta: on the current meshes every
  `_B_Concrete_` strip, including the holes of `roads_124`, borders grass.)
- **Spec** `<course>/Paths/path-surfaces.json` (`golfmap-path-looks-v2`, written with defaults on the first run; a v1
  spec is moved to `path-surfaces.v1.bak.json`): per surface `albedo`, `normal`, `occlusion`/`height` (optional),
  `tileM`, `tint` (Detail Color Tint), `smoothness`, `nearNRMStrength`, `farNRMStrength`, `farNRMTilingM`,
  `aoBrightness`, `detailOpacity`, `detailDistanceM`, `fringeBlendStrength`, `physicMaterial`; top level
  `unknownSurface`, `sharpPairs`, `baseMaterial`. Every run rebuilds the materials from the spec (hand edits to them do
  not survive: tune the spec). Vreta defaults (2026-10-04, matched to the earlier looks at 1.7 m): gravel = NatureManufacture
  `T_Ground_Forest_Pebbles_Path_01` (A/N/AO/H) at 1.2 m, `#817f7a`; dirt = `GroundCracked01` at 3 m, `#665c4e`; asphalt
  = OPCD `Asphalt Clean` (albedo/normal/AO/height) at 4 m, `#626262`. Concrete, paving and wood are untuned defaults.
- `look=photo` puts OPCD's materials and the colliders' physic materials back from `<course>/Paths/paths.json`
  (what each object wore before); `dryRun` returns the plan (surfaces, each strip's paint, neighbour and material),
  `only` limits it to named objects.

`golfmap.course.refresh` runs this as step `paths.materials` after the bunker convention (OPCD's Set Default Materials
gives a re-added path mesh the satellite material again): `pathLook=surface` (default) or `pathLook=photo`. History:
2026-09-29 a plain copy of OPCD's non-satellite asphalt drew every path one flat pinkish grey, then a custom
`GolfMap/Path Surface` shader per surface lost OPCD's knobs; both retired. The pipeline's path fill (`gspro.py ortho
--path-fill`, above) still matters for `look=photo`.

### Drawn path transitions

Path transitions drawn in the web editor use red = grass, green = the path surface,
blue = bare brown dirt. `golfmap.path_transition` paints both the path piece and its
fringe in Blender; the FBX exports the `golfmap_path_transition` property.
`GolfMapPathTransitionMetadata` records that convention on import, including pieces
that have faded entirely to red and cannot be recognised from green paint alone.
The marker is removed on reimport when the source no longer carries it.

`golfmap.paths.materials` gives a painted piece its road's fringe material. Roads
with transitions get a separate `(transition dirt Blue)` material variant, so the
ordinary side-strip blend strength stays independent. Its blue channel uses the
course's dirt texture. Optional `transitions` settings in `Paths/path-surfaces.json`
are `dirtTint` (default `#595348`), `pathBlendStrength` (3), and `dirtBlendStrength` (1).
These settings survive rebuilds; change the spec rather than the generated material.
The same material is used across a matching piece/fringe seam. Paths retain their
existing collider physics: this feature changes appearance and grass density, not
GSPro lie classifications.

`golfmap.roughgrass.plant` recognises painted path meshes as well as their fringe
strips; only red grows Stix grass, so blue dirt stays bare. `only=<names>` optionally
scopes planting and removal to those objects. Removing transition paint and running
the normal refresh also removes obsolete path GrassRenderers. Course `.blend`
files, orthophotos and the Unity scene are not saved by this workflow.

### Worn gravel (wheel tracks)

A surface of `Paths/path-surfaces.json` may carry a `tracks` look: the same keys as the surface (what it leaves
out is the surface's own) plus `blendStrength` (1.5). `golfmap.paths.materials` draws it on the black channel of
that surface's red-grass / green-path strip materials (black is free there: the paint sums to one). The paint comes
from Blender: `golfmap.path_transition` takes the path's green out where the export's `wear` says wheels or feet
have packed the stones (blender/README.md "Shaping: path transitions"), on every gravel path drawn as a centreline
of 1.4 m or wider - two tracks from 1.8 m, one trodden middle below. Vreta's gravel: the Ground032 stones at 1.5 m
a repeat instead of 3.5, flatter normals, tint `#66625a`, the Ground032 height map so stones show through. A worn piece carries green paint, so it wears its road's
strip material; with no red on it, it gets no Stix renderer. A gravel path drawn as an outline has no
centreline and stays unworn.

## Vertex paint

`GolfMap > Vertex Paint > Apply paint.json` (`GolfMapVertexPaint.cs`, bridge `golfmap.paint.apply
[dryRun=true]`) generates vertex paint on the course meshes from `<course>/paint.json`
(`golfmap-paint-v1`, written with defaults on the first run; a dry run before that previews the defaults).
`Restore original meshes` (`golfmap.paint.restore`) puts the FBX meshes back.

How the paint reaches the game:

- **MAHS channels.** OPCD's `4 color Vert Paint MAHS` material draws one texture per paint channel. Course
  meshes are 100 % red except bunkers, blends and water. Rough's black channel is OPCD's dirt base (index 4)
  at about half opacity, so black on rough reads as a worn or dry patch. The shader blends in order: black ->
  red (by r) -> green (by g) -> blue (by b), each weighted by its own channel (times its height map and blend
  strength), black by `1 - (r+g+b)`. So a vertex (1, 0, 0.6) shows the blue channel over the red one while
  red, and with it the Stix grass, stays full.
- **Stix reads red only.** `NewRough` is `ONE_GRASS_TYPE` + `VERTEX_DENSITY`: a blade spawns with the
  probability of the vertex colour's **red** component. Black, green and blue all mean no grass, and a
  gradient thins the grass gradually.
- **The bake.** Stix draws from the mesh its `NatureMeshFilter` caches (`meshes`, serialized; on Vreta it is
  the FBX mesh itself, no normalisation). OPCD's own painter (VertexPainterPro) paints a
  `VertexInstanceStream`, which only the renderer sees, so Stix needs its SaveMesh "bake". This tool writes
  the baked result directly: a mesh copy per painted object in `<course>/PaintedMeshes/`, swapped into the
  `MeshFilter` (the `MeshCollider` keeps the FBX mesh), then `ResetCache` + `GetMeshes` on the
  `NatureMeshFilter`. A hand-painted `VertexInstanceStream` on the same object would draw over the copy;
  apply warns about it.
- **Reproducible.** Paint is always computed from the original FBX colours
  (`PaintedMeshes/restore.json` remembers each object's original), so re-running after tuning or after an
  FBX re-import gives the same result. Objects no rule touches any more go back to the FBX mesh. A painted
  copy whose asset is gone (deleted, or zeroed by a crash) leaves an empty MeshFilter: apply puts the original
  from `restore.json` back first and rebuilds the copy (reported under `healed`). Apply marks
  the scene dirty and does not save it: save the scene to keep the swaps.
- **Rewritten through the Mesh API.** An existing copy is refilled channel by channel (`Overwrite`), never with
  `EditorUtility.CopySerialized`: that kept the loaded mesh's old render buffers, so after a Blender shaping run
  changed an FBX's vertices the renderer drew the old triangles over the new vertices (flat white sheets and walls of
  stretched triangles over Vreta's pond klippa, 2026-09-29) while the collider had the right shape.
  `golfmap.materials.audit [under]` (read-only) lists renderers that may draw white or untextured (no mesh or
  material, default material, error shader, textureless materials, OPCD MAHS without satellite/arrays, renderer and
  collider meshes that differ).

Rules (only `kind: edge`, `edge: bunker` so far): paint `channel` onto the `surfaces` (GolfMapSurfaces
classes) within `widthM` of the outer edge of every bunker blend. World-anchored Perlin noise picks the
stretches where the rule applies (`coverage` share, `noiseM` long, `seed`), and a second octave varies how
far each spot reaches (35-100 % of `widthM`). The weight falls off smoothly from `strength` at the edge.
`mode` `replace` (default) lerps the colour toward the channel (lowering red: fewer Stix blades); `overlay`
(red, green or blue; not black) raises that channel and keeps the others, so red - the Stix blade chance - is
untouched: a colour-only band under full grass. A rough reshaped by the stone-wall ground draws stone on blue,
so blue rules skip those meshes.
Vreta's recipe (`bunker-surround`: rough, blue, overlay, 2.2 m, strength 0.9, coverage 0.55, 3.5 m; snapshot in `docs/gspro/vreta/paint.json`) is
**`enabled: false`** since 2026-09-29 (a rule with `enabled: false` is kept but not painted): the rough's blue channel is the same dirt base
with roots and twigs as its black, so the band still read as root streaks (Bunker Materials, table). Enabled it painted
about 5 850 vertices on 21 rough meshes. It was black `replace` until 2026-09-29: red fell to ~0.1 at the edge, so
the grass thinned into a brown band of roots and debris (the rough's black channel) with a few blades - the
opposite of the references (grass right to the edge). Marcus chose the rough's blue channel for the band; it now
changes only the ground colour under full-density grass. Many greenside bunkers border fairway or semi rough,
which have no Stix grass.

Vertex spacing limits the detail: fairway, rough, semi and deep are about 1.2 m, rough within 3 m of a
bunker about 0.8 m, bunkers 0.19 m and blends 0.09 m. Features under about 2 m do not survive on the grass
meshes. Check a result from above (`unity_screenshot` with a pitched `rotation`): at eye height from 10 m away,
a band this narrow is hidden behind the blades.

Read-only helpers: `golfmap.paint.survey` (per class: vertices, edge lengths, current paint, Stix setup,
bunker centres, `painterStreams`) and `golfmap.paint.probe x z r` (paint of every course mesh near a point; `stream`: the
colours of a VertexPainterPro stream on the renderer, which is what it draws). `golfmap.paint.streams [remove=true] [only=]`
lists (removes) those hand-paint streams: they outlive FBX syncs and paint.json and the probe's mesh colours never show them.

## Course meshes: FBX sync

`GolfMap > Meshes > Sync from FBX folder` (`GolfMapCourseMeshes.cs`, bridge `golfmap.meshes.sync`) keeps the
scene's course meshes in step with the FBX folder the Blender export writes into. The Blender side is
[`blender/tools/fbx_sync.py`](../blender/README.md#fbx-sync) ("Export changed FBX"), which only rewrites the FBX
of meshes that changed, so Unity only reimports those.

It does what deleting and re-adding the meshes by hand does, but only for the meshes that changed
(`save=true` saves the scene and the reimported assets when the sync succeeded, ["Saving what a command changed"](#saving-what-a-command-changed-save)):

- **Changed FBX** (size or time differs from the last sync, `<course>/meshes-sync.json`): the scene object is
  deleted and added again in the same place. Unity's in-place update of an overwritten FBX is not relied on;
  it left old geometry in the scene. After OPCD's own Batch Export every mesh counts as changed.
- **New FBX:** instantiated under the course's mesh parent the way OPCD's `GSP > Add OPCD Meshes` does. Added and
  replaced objects get a `MeshCollider`, then OPCD's `GameObject > Set Default Materials` runs on them (materials,
  channel store, physics material). It is checked: on a whole course at once (789 objects) OPCD left 668 on the
  material their FBX carries, so what still wears an FBX material goes again in batches of 50, then one by one
  (`opcdMaterials` in the result; any left is an error). `golfmap.meshes.materials` does the same for a scene
  already in that state; follow it with `golfmap.course.refresh skip=meshes.sync`.
- **FBX that is gone:** objects under the parent that show no current FBX (including painted copies of a deleted
  FBX, which keep rendering) are `stale`. The menu asks before deleting them; the bridge deletes with `prune=true`.
- **Leftovers:** an FBX that the Blender FBX sync's record (`<folder>/.golfmap-fbx-sync.json`) doesn't list is left
  over from an older `.blend`. It is never added and is reported with its scene objects; delete it from Blender
  (**Delete FBX of removed meshes**), then sync again. A record older than any FBX (OPCD's Batch Export bypasses
  it) is ignored.
- **Excluded:** FBX whose name starts with a prefix in the course's `meshExclude` (default `Gap_Issue`, OPCD's
  gap-check markers) are never added, even when OPCD's Batch Export writes them; objects showing one are stale.
- **Vertex paint** is applied again after any add or replace (`paint=false` skips it). That also reshapes the ground
  under stone walls (see Stone walls), and then the walls and boulders standing on a replaced or added mesh (one of
  its vertices in their area) are built again so their stones meet it; the rest keep theirs. The preview lists them
  as `wallsToRebuild`. An object whose collider shows a wall-ground copy maps to its FBX through the paint's
  `restore.json`, so it is never taken for stale.
- **First sync** (no record yet): nothing is replaced; the scene is taken as current and recorded. `GolfMap >
  Meshes > Rebuild all from FBX folder` (`replaceAll=true`) replaces every mesh.
- The parent and objects with children are never treated as course meshes. A parent that renders a mesh itself
  (e.g. made by dragging an FBX in and renaming it) is reported under `warnings`: it draws twice there. Water
  planes are the exception: OPCD's plane carries a child `Default Reflection Probe` and is still its FBX's object
  (before, a sync would have added `Spline_others_WaterPlane` a second time).

Folder, parent and exclusions come from the course asset (`meshFolder`, default `fbx` under Assets; `meshParent`,
default `Meshes`; `meshExclude`, default `Gap_Issue`); the bridge takes `folder`/`parent`/`exclude` overrides. `Preview sync` / `dryRun=true` shows the plan. Undo
covers the scene changes; the scene is marked dirty, not saved.

## Course refresh after a Blender shaping run

Step 5 of the [Blender shaping loop](../blender/SHAPING-PLAN.md). `GolfMap > Course > Refresh after Blender export`
(`GolfMapCourseRefresh.cs`, bridge `golfmap.course.refresh`) chains, in order: `meshes.sync` (prune; `folder`/`parent`
args; OPCD's Set Default Materials runs inside it on what it re-adds), the Bunker Materials convention
(`convention`, `conventionFile`; default the window's), `paths.materials` (cart path look, `pathLook=surface|photo`,
"Cart paths"), `paint.apply`, `roughgrass.plant` (Stix grass on the roughs
and bunker lips; `grassMaterial`, `lipGrass=false`), `terrain.conform mode=match` (`margin`,
`featherM`), `waterplanes.build` (every lake: a fresh OPCD `.blend` never has water planes - OPCD's Add Water Plane is a manual Blender step - so new lakes get one, ours are rebuilt keeping their lift, lakes another plane covers are left alone, and our stale planes plus any water plane whose mesh is gone - OPCD's after a new `.blend` - are deleted),
`creeks.import` (refit), `walls.build` and `surfaces.export`. `skip=<ids>` leaves steps out; a failed step stops the
rest unless `continueOnError`. Not automatic, listed under `pending`: grass zones (`bun run grass:zones -- <course>`,
then `golfmap.zones.import` + `golfmap.grass.apply`) and `props.place` (props moved by hand are kept now, but the
spec is still the only place a hand move is permanent).

`save=true` saves once, after the last step: the open dirty scenes and `AssetDatabase.SaveAssets()`, reported as
`saved: { scenes, seconds }`. The chained steps never save of their own (`save` is not passed down), a dry run never
saves, and a run with a failed step is left dirty on purpose - see ["Saving what a command changed"](#saving-what-a-command-changed-save).

`dryRun=true` (menu: *... (dry run)*) runs each step's own dry run where it changes nothing (meshes.sync without
importing, bunkers, paint, terrain match, water planes, creeks) and lists `walls.build` (its dry run prepares the stone
models) and `surfaces.export` as `would run`. Every plan is measured on the scene as it is, before the earlier steps.
The report goes to `<course>/refresh-report.json`; a dry run's to `GolfMapSpelunk/<Course>_refresh-report.dryrun.json`
(outside Assets). The scene is marked dirty, never saved.

### Per feature: `only=`

`golfmap.course.refresh only=<object names, comma-separated>` (object = FBX name without extension, e.g.
`only=Spline_hole_18_1c_Bunker_-_Mesh,Spline_hole_18_1c_B_Rough_Bunker_-_Blend`) is the fast path of the Terrain editor
→ Blender loop (the shaping worker's `changedObjects`). Same steps and report, but only for those objects and the
ground around them:

| Step | With `only=` |
|---|---|
| `meshes.sync` | just those FBX: `AssetDatabase.ImportAsset` each (no full Refresh), each named object deleted and added again (or added when the scene has none) whatever the sync record says, MeshCollider + OPCD's Set Default Materials on them; prunes only named objects whose FBX is gone; updates only their entries of `meshes-sync.json`. `unknown` lists names with neither FBX nor object |
| `bunkers.materials` | the convention on the bunker sets they belong to (`ApplyConvention(..., only)`: sets whose bunker/blend is named, or whose key `<key>_Bunker_-_Mesh` / `<key>_B_..._Bunker_-_Blend` gives); skipped when no bunker or blend is named |
| `paths.materials` | the cart path look on the named path meshes (`*Concrete*`); skipped when none is named |
| `paint.apply` | the named meshes and the course meshes whose bounds meet theirs + `featherM` + the rules' reach (`Apply(dryRun, only, within)`); bunker edges read from the blends there. Meshes outside keep their paint |
| `roughgrass.plant` | the whole course (cheap: only objects without a `GrassRenderer` get one; the lip material is rebuilt) |
| `terrain.conform mode=match` | only inside the union of their bounds + `featherM`: only the meshes over it rasterised, only that heightmap window read/written; the backup is that window's heights (`<course>/Backups/<terrain>-<stamp>-match.heights`, `golfmap.terrain.restore backup=<it>`) instead of a 36 MB TerrainData copy |
| `waterplanes.build` | a named `*_Water_Base_Lake_-_Mesh`: created if it has no plane, else rebuilt keeping its lift |
| `creeks.import` | only when a creek mesh is named: the creeks of the export with a point inside its bounds (+1 m) are refitted, no creek is removed |
| `walls.build` | only the walls/boulders whose bank meets them (`WallsOver` for objects in the scene, `WallsIn` on bounds for the others); else skipped |
| `surfaces.export` | when a rock slab (`*_Rock_-_Mesh`) is among them: run for the inner terrain as in a full refresh (`would run` on a dry run), and the `pending` list then names only the grass zones. Otherwise not run (whole-course export): status `pending` |

Where each object is (`where` in the report): the scene object (in a real run the union of the old and the new shape,
so ground a smaller bunker gave up is matched too), else its imported FBX (root at the origin, as the sync places it),
else the shaping report's place (`bounds.unity`) - that is how a dry run plans meshes Unity has not imported yet.
`dryRun=true` works with `only=`. The dry run above (Vreta 2026-09-28, 18_1c renamed so the scene had no object of
either name yet, bounds from the FBX): 0.41 s in all - sync 0.08 (2 to add), bunkers 0.07 (set `Spline_hole_18_1c`, not
in the scene yet), paint 0.13 (1 mesh in scope), terrain 0.08 (window 45 x 24 samples: 392 would fall, max 11 cm, 209
feathered); water, creeks and walls skipped as not concerned. A lake + creek + tee-bank rough in one call: 0.99 s (terrain
window 784 x 1336 samples, 0.4 s; creeks 1 of 13 refitted; wall `h13-front-tee` would be rebuilt).

Speed (Vreta, one bunker + its blend, 2026-09-29): 35 s before, ~3 s now (+ ~1 s when the terrain changes). What cost
it: every `yield` of the conform coroutine is an editor frame (1-2 s on this scene), so the conform yields only after
0.2 s of work (`Laps.Due`); the conform record `Reference/inner-conform.bytes` (16.6M entries, 133 MB) was read into a
dictionary and rewritten on every conform (~23 s): a windowed conform now looks up just its samples and appends their
totals (the last record of a sample wins; a big run rewrites, which compacts); the VSP refresh is the window's cells
(`RefreshTerrainArea` + `ClearCache(bounds)`) instead of `RefreshVegetationSystem` (1.4 s); Bunker Materials imports
its `restore.json` instead of a full `AssetDatabase.Refresh` (and not at all on `only=`). Each step's `result.timings`
(meshes.sync, bunkers.materials, terrain.conform) gives the seconds per part. What is left: `ImportAsset` of the FBX
(~0.6 s each), OPCD's Set Default Materials (0.2-1.1 s), `SaveAssets` (the 36 MB TerrainData, ~0.5 s).

`golfmap.terrain.conform mode=match` puts the terrain under the meshes at exactly `margin` below the mesh top, raising
**and** lowering (a dug bunker, a built-up tee), and fades the change out over `featherM` (default 2 m) outside the
meshes' footprint so no cliff is left. Backup first, as `mode=raise` (the default, unchanged). `save=true` saves the
scene and the changed TerrainData when the conform succeeded (["Saving what a command changed"](#saving-what-a-command-changed-save)). The dry run reports
`samplesRise`/`samplesFall` (under the meshes, changes over 1 mm), `featherRise`/`featherFall`, `maxRiseCm`/`maxFallCm`.
Vreta 2026-09-28: 16.6 M samples under meshes (OPCD's deep-rough fill covers almost the whole inner square),
11.2 M would fall (mean 2.1 cm, max 146.7 cm), 1 033 rise (max 157 cm), 39.7 k feathered.

## Review (changed places)

`GolfMap > Review` (`GolfMapReview.cs`) reads a shaping report (`shaping-report.json` from `shape_apply.py`,
`golfmap-shaping-report-v1`; default the last picked path, else `<course export folder>/shaping-staging/shaping-report.json`,
where `shape_apply` stages its output, else `<course export folder>/shaping-report.json`) and lists its `changedPlaces` grouped by hole:
a done tick per place (EditorPrefs, per report), **Go**, **Prev/Next** (skipping done ones). Go frames the Scene view
from its current heading, 35 deg down, far enough back to see the place's bounds. It also shows the last course
refresh's pending steps. A place (`object`, `featureId`, `type`, `hole`, `ops` shown as its note, `centre` and `bounds`
each as `{blend, epsg3006, unity}`) resolves to the scene object of that name (renderer bounds, `resolvedBy: object`),
else the report's own Unity bounds (`unity`), else the Blender bounds mapped as `(x, y, z) -> (-x, z, -y)` (checked:
object bounds and mapped Blender bounds agree to the millimetre), the height of both taken from the ground there, else
`centre3006` through the inner DEM sidecar. Older reports (`centreBlend`, `centre3006`, `bounds: {min, max}`) still load.

Bridge:
- `golfmap.review.list [report]` (read-only, with `resolvedBy` and `blendOffsetM`);
- `golfmap.review.goto index= | object= [report] [select]`: `object=<name>` is golf-map's "Show in Unity" - the
  report's place for that object when there is one (scene object first, else its coordinates, e.g. a renamed mesh
  before the refresh), else the scene object of that name without a report; a given report becomes the window's;
- `golfmap.review.load [path] [open=true] [items=false]`: loads a report into the window (opens it, remembers the path)
  and returns the place count per hole and how they resolve in the scene. Vreta 2026-09-28 (staged report, 421 places,
  scene not refreshed yet): 69 by object, 352 by the report's Unity coordinates; `goto object=Spline_hole_18_1c_Bunker_-_Mesh`
  framed the bunker from its coordinates (`resolvedBy: unity`).

## Creeks (R.A.M.)

`GolfMap > Creeks > Import creeks (R.A.M.)` (`GolfMapCreeks.cs`, bridge `golfmap.creeks.import
[file] [dryRun=true] [save=true]`; `save` also on `golfmap.creeks.water`, see
["Saving what a command changed"](#saving-what-a-command-changed-save)) turns golf-map's `<prefix>-inner-creeks.json` (unity-creeks-v1, the GSPro panel's
**Export creeks** / `gspro.py creeks`) into NatureManufacture R.A.M. splines: one `RamSpline` per creek under
**GolfMap Creeks**, named `Creek feature:<id>`.

- **Control points** are at the creek's water surface in inner-plot metres (the inner terrain sits at the
  origin; y = DEM height − the sidecar's `minM`), running downstream and never climbing, at most 10 m apart,
  with the creek's width in `w`. golf-map digs the bed below that same surface (**Dig creeks**), so the water
  only shows once the heightmap and the Blender meshes are rebuilt with the digs.
- **Profile**: each creek names a profile asset (default *Small Stream Profile*; a feature's `ramProfile`
  attribute picks another), applied the way R.A.M.'s own profile picker does it (`ResetToProfile`). It gives the
  mesh's shape; the look comes from `water`.
- **Water** (`water=lake`, the default): the creeks wear the lakes' water, not the profile's bright, foamy
  material. That is `<course>/Creeks/Creek water (lake).mat`, a copy of OPCD's `OPCD-WaterPlane_AquasLite` made
  on first use and then kept, so tune it there. Each creek's renderer anchors to the nearest lake plane's
  reflection probe (its box only covers the lake), so it reflects what that lake reflects. AQUAS samples its
  waves in world XZ, so the ripples drift one way and do not follow the flow. `water=profile` puts R.A.M.'s
  material back. `GolfMap > Creeks > Water like the lakes / Water from the R.A.M. profile` (bridge
  `golfmap.creeks.water water=lake|profile`) switches the look without refitting the creeks.
- **Fitted to the scene** (unless `fit=false`): the export gives the line, the course meshes under it
  (`Spline_*`, the terrain where there are none) give the height and width, so the water sits in the bed
  the scene actually has:
  - *height*: `aboveBedM` (0.15) over the lowest ground across the creek. Each point takes the highest bed along
    the stretch it stands for. The water is not forced to fall, because a bump would hold it up above its banks.
  - *crossings*: bed that stands 0.3 m above lower bed on both sides within 20 m (a path over a culvert, or an
    undug hump), ramps included. The water runs under it at the level either side, hidden. The report
    lists each one, since an undug stretch shows as dry bed.
  - *width*: at every metre, each side runs out to where the ground rises `buryM` (0.05) above the water,
    then `bankM` (2 m) further, stopping short of where the ground drops back under the water. The point is
    moved across to centre the water between its two sides, so the edges sit inside the banks with no gap
    under them.
  - *ends*: both ends run on along the line into the bank the same way.
  - A side or end that never meets a bank (flat ground, a creek into a pond or another creek) keeps the
    export's width or end. It is counted as `open`, and the report's `check` list gives its plot x, z. Where the
    ground beside a creek is not below the water, dig the creek deeper in golf-map.
- **Refit after a remodel**: the fit reads the scene, so rebuild the scene first, then run both steps again. The
  order: edit the creeks → **Dig creeks** → **Update terrain** → Blender meshes +
  `golfmap.meshes.sync` → **Export creeks** (the lines, `bun run gspro:export -- <course> creeks`) →
  **Import creeks**. A stale export shows as `groundAboveExportSurfaceM` far from 0 (its heights were measured
  against another heightmap zero). Its lines are what matter, and the fit replaces its heights.
- **Re-import** refills each spline's points in place and resets its transform. Hand edits to the points,
  and a spline object moved by hand, are not kept. Creeks no longer exported are removed.
- `trace=<creek id or part>` adds that creek's stations to the result (bed, water, banks, crossings), for
  working out a bad fit.
- R.A.M. is in Assembly-CSharp, so its types are found by name (the offline compile check can't see them).
- Skip OPCD's **Add Water Plane** for creeks: its one flat plane per mesh, at the lowest rim vertex, would sit
  under the bed upstream.

The report (`GolfMapSpelunk/<Course>_creeks.txt`) gives each creek's exported surface against the ground
under it (the highest collider straight down) and its fit: widths, how far the surface moved, the ends'
reach into the bank, open sides, the largest climb, crossings and the places to check. The exported surface
comes from the raw DEM and lands at or under the dug bed (Vreta after the 2026-09-26 remodel: median
0–24 cm under it), which is why the splines are fitted to the scene. Known gap: where creeks meet,
the end heights can differ by ~10 cm (each creek's profile is its own), and the splines are not joined
(R.A.M.'s beginning/ending spline connections).

## Water planes (lakes)

`GolfMap > Waterplanes > Build for selected mesh` builds the AQUAS water surface over one mesh at a time the way
OPCD's Blender **Add Water Plane** does (`opcd_blender_tools/operators/water.py`), from the meshes already in the
scene, so no Blender round trip. Click the mesh in the Scene view (a lake's `Water_Base`, or any other mesh to put
water on), run it, and the new plane is selected so its Y is at hand in the Inspector. A message in the Scene view
and the Console says what it built or why not. Select a plane (or its probe) and run it again to rebuild it from its
mesh. `GolfMap > Waterplanes > Build for all lakes` does every `*_Water_Base_Lake_-_Mesh` at once. Both are
`GolfMapWaterplanes.cs`, bridge `golfmap.waterplanes.build [dryRun] [selected] [only] [outsetM=2] [belowM=0.05]
[liftM=0.3] [replaceExisting] [prune] [save]` (`save=true`: the scene and the saved plane meshes written out when the
build succeeded, ["Saving what a command changed"](#saving-what-a-command-changed-save)):

- **Geometry**: the lake's `Spline_*_Water_Base_Lake_-_Mesh` (or the selected mesh), welded, every vertex put at one level = the lowest
  vertex on its edge (islands included) − `belowM`, then a flat ring `outsetM` wide around every edge so the plane
  runs in under the banks and blends. All red vertex colour, normals up, no UVs (the shader samples its waves in
  world XZ). Saved to `<course>/WaterPlanes/<key>_WaterPlane.asset`. On Vreta's `others_49` it gives the same
  21 502 vertices as OPCD's plane, 1 cm higher.
- **Rocks in the water**: a rock slab (`*_Rock_-_Mesh`, blender/README.md "Shaping: cut-outs", `rise`) that shares a
  vertex with the lake joins the plane (its triangles flattened in, so the water runs on round its foot and the rock
  stands through it), and every lake rim vertex within 2.5 m of a slab near the lake is left out of the level
  (reported `slabs`, `rimLeftOutNearSlabs`): a shore notch drawn round a rock lies down on the lake bed. Vreta's hole
  15 lake stood 1.5 m low on it (rim 7.66 m at the rock, the rest of the shore from 9.18 m), 2026-10-15.
- **Hand-set water levels: `<course>/water-levels.json`** (`golfmap-water-levels-v1`, repo copy
  `docs/gspro/<course>/water-levels.json`): `{"planes": {"<plane>": {"surfaceM": 9.553}}}`. The build gives a named
  plane the lift that puts its water there, whatever its level comes to, so a lake tuned by hand keeps its water
  through a rebuild, a new `.blend` and a fresh plane (reported `fixedLevel`); an explicit `liftM` still wins. Tune
  the plane's Y in the Inspector, then write `level + Y` there. Vreta hole 15_12: 9.553 (Marcus 2026-10-15; the bed's
  shelf lies at 9.6-9.7 m).
- **Object**: `<key>_WaterPlane` (e.g. `Spline_others_49_WaterPlane`; another mesh's name without `_-_Mesh`,
  e.g. `Spline_hole_17_12_Bunker_WaterPlane`) under **Waterplanes**, its transform `liftM`
  above the level, as the hand-made plane was raised. A MeshCollider, then OPCD's **Set Default Materials**, which
  keys on `_WaterPlane` in the name: material `OPCD-WaterPlane_AquasLite`, physic material `GSPwater` (what makes it
  a hazard in GSPro), and a child **Default Reflection Probe** at the plane's centre (realtime, refresh on awake,
  1024, HDR, box projection, box 15×100×15 m) that the renderer uses as its anchor override. The whole plane
  reflects that one cubemap.
- **Probe placement**: the build then moves the probe over open water (a point where the plane is the top surface
  and at least 0.3 m over the bed, so neither the outset ring under a bank nor a flooded margin), the one nearest the
  plane's centre, 1 m over the highest ground within its box,
  and renders it. At the bare bounds centre a curved creek's probe lands inside its inner bank. It then captures the
  ground from underneath, and the whole plane reflects black. Vreta's hole 15_5 creek and OPCD's `Spline_others`
  plane both had this. **GolfMap > Waterplanes > Place reflection probes** (bridge `golfmap.waterplanes.probes
  [only] [aboveM=1] [dryRun]`) does the same for planes already in the scene, OPCD's FBX planes included; its report
  says which probes were under the ground. A realtime probe refreshes on awake, so GSPro renders it where it is saved.
  In the editor a probe moved by hand keeps its old cubemap until something renders it, so the water looks unchanged.
- **Rebuild** refills the same mesh asset. The object, its material and its probe stay, and the probe is placed
  again (a hand-moved probe is not kept). A lift changed by hand (the object's local y) is kept unless `liftM` is given.
- **Covered lakes**: a lake that another water plane already covers (e.g. an OPCD FBX plane) is skipped.
  `replaceExisting=true` builds it anyway and switches the other plane off (it is not deleted).
- `dryRun` lists every lake with its level, surface, edge heights (`rimM`) and `rimBelowSurface`, the share of the
  edge below the water. There the plane shows over the bank unless the outset runs in under higher ground. It
  also lists the existing planes and what they cover. `prune` deletes planes built here whose lake is gone.
- **Creeks**: one level per plane is only right for still water. A `Water_Base_Creek` is built only when named in
  `only`, with a warning; use the R.A.M. creeks for water that falls.
- Water planes are named `Spline_*` but are not ground: terrain conform, surfaces export, the creek fit, vertex
  paint and the VSP tree planter leave them out (`GolfMapWaterplanes.IsWaterPlane`).

## Not built yet

- Historical note for the original tools: no Unity or C# compiler was installed on the dev
  machine. First run inside the OPCD project will show any API mismatch for its Unity
  version. Written for C# 6 so it compiles on the Unity 2018.2 base project; newer APIs
  (terrain layers, prefab roots, render pipeline, package listing) are behind version
  defines with 2018.2 fallbacks.

## Course props

`GolfMapProps.cs` places what `blender/tools/build_props.py` built into `<course>/Props/` (see
[blender/README.md](../blender/README.md#course-props-buildings-shelters-flags-cars-)):

- `golfmap.props.place` (GolfMap > Props > Place props from manifest): Standard materials from the manifest
  (albedo, normal map, metallic/occlusion/smoothness mask, cutout for netting) remapped onto the FBX by name, then
  every instance under `GolfMap Props/<Category>s/<asset>#<index>` at its EPSG:3006 position (inner DEM sidecar
  frame) on the highest collider below (course meshes, else terrain), rotated to its `yawDeg`. Buildings and
  structures get MeshColliders, small props box colliders or none; Unity-prefab assets keep their own. A realtime
  reflection probe (on awake) covers the area. Replaces what the last place made (`only=<ids>` just those), except
  the instances moved or rotated by hand (below). `dryRun=true` returns ground heights and the plan, `kept` instances
  included. `save=true` saves the scene when the place succeeded (["Saving what a command changed"](#saving-what-a-command-changed-save)).
  Report: `GolfMapSpelunk/<Course>_props.txt`. Warns when a
  building's footprint spans more than 1 m of ground (a pad or a plinth to check).
- Placed objects carry no custom component (GSPro would load it as a missing script); they are found by name.
- `golfmap.props.measure` (`folder` or `paths`): prefab sizes, LODs and colliders, for sizing prefab assets in a spec.
- Prefab assets (`prefab` instead of Blender parts, e.g. the vehicle pack's cars, the CE golf cart, a pack's hedge):
  `axis` = the prefab's forward axis (`x` default, `z` for most vehicle packs; `yawDeg` is its compass bearing),
  `recolor: [{material, color, as}]` = copies of named materials with another `_Color` under
  `<Props>/Materials/Recolor/`, swapped in on that asset's instances (grey/silver cars from a white body). The prefab's
  own root scale is kept (packs modelled in cm scale the root); `collider: box` adds one box to a prefab without
  colliders. Import pack subsets by dependency (prefab + what it references, with `.meta`), never over existing GUIDs.
- Low-poly vehicles (`GolfMapVehicles.cs`): the vehicle pack's prefabs are 30-43 renderers a car, so the spec
  places merged copies. `golfmap.vehicles.build` reads `<course>/Props/VehiclesLowPoly/vehicles.json` (from
  `blender/tools/vehicle_models_10k.py`, [blender/README.md](../blender/README.md#low-poly-vehicles)) and makes
  one prefab per entry beside it: the FBX under an empty root, each slot filled with the material of that name
  from the pack's prefab (so `recolor` still finds `BodyMat 5`, `Tocus_Body White`, `Cart Color` ...), Cast
  Shadows per object from the manifest. Re-running replaces the prefabs in place; scene instances follow.
  Compare old and new with `golfmap.props.measure` (size and centre must match) before placing.
- `golfmap.props.stats` (`group=Vehicles`, `transforms=true`): objects, renderers, shadow casters, triangles
  and materials per group and asset under `GolfMap Props`, missing materials, and per object position, yaw and
  height above the ground. Triangles are counted from each mesh's submeshes: in a built course static batching
  gives every renderer the whole combined mesh, and a sum of `sharedMesh.triangles` there is ~90x too high.
- Manifest materials can be `fade` (translucent Standard, e.g. ball-stop netting) or `cutout`.
- `golfmap.props.clear` deletes `GolfMap Props`. The `placed.json` record stays, so the next place still keeps what
  was moved by hand.

### A re-place keeps what was moved by hand

`props.place` used to rebuild every instance from the spec and drop every prop Marcus had moved or rotated in Unity
(three sessions lost to it). It now records what it placed, in `<course>/Props/placed.json`
(`golfmap-props-placed-v1`, written beside the manifest, never by hand): per instance the spec entry it came from
(`e`, `n`, `yawDeg`, `dz`, `scale`), the world transform it set (`pos`, `euler`, `scale`), the object name, and
whether that transform is the user's (`hand`); plus `specHashes` per asset. The rule
(`GolfMapPropsPlaced.cs`, mirrored and tested in [`props-matching.mjs`](props-matching.mjs) /
[`props-matching.test.mjs`](props-matching.test.mjs)):

| | |
|---|---|
| Matching | scene object → record by **object name** (trusted only there: the record was written by the place that made that object); a renamed object by the nearest unclaimed record within 2 m. Record → spec entry by the **nearest recorded spec position** (e, n), one to one, closest pair first, **no radius** - never by `#i`, which is the index the spec had when the prop was placed and shifts for every later instance as soon as one `place(...)` call is added or removed. Within one asset the instances stand far further apart than any hand nudge, so the unmoved ones pair at distance 0 and are consumed first and a moved one can only pair with what is left |
| Tolerance | 1 cm of position, 0.5° on any rotation axis (a tilt counts: the tool only ever sets yaw), 0.1 % of scale |
| Hand-placed | the instance stands somewhere else than the record says (`rule: hand-moved`), or an earlier place already kept it (`hand-kept`; `hand-recorded` when nothing is in the scene for it now) |
| Spec wins | a hand-placed instance whose **spec entry** moved more than the tolerance since it was recorded (`rule: spec-moved`): the user edited the `.gen.py`, so that is the newer intent. Also `no-record` (a new `place(...)` call) and `unmoved` |
| Added by hand | an instance in the scene **no record claims** - the tool never made it, so somebody duplicated it in Unity (`<asset>#3 (1)`). It is left exactly where it stands and nothing is placed for it: result `handAdded`. It is deliberately kept **out** of `placed.json`, because "no record claims it" is the rule that finds it, so every later place keeps it the same way (a record with `spec: null` would do the opposite - no spec entry could ever claim it, so the next place would drop it). Before this it paired with nothing and the replace destroyed it without a word; `keepHandEdits=false` still removes it |
| Dropped | a hand-placed instance the spec no longer has - that `place(...)` call is gone, or the manifest has lost the whole asset. The spec is the intent, so the object does go, but its asset, name and transform are listed as a warning in the report and under `droppedHand` in the result, to be carried into the `.gen.py` if it was wanted |
| Result | `kept` = how many kept their transform, `handPlaced` and `specWon` list them with the spec entry, where they stand and where the tool had put them; `handAdded` and `droppedHand` the two above; `placedRecord` is the sidecar's path. The report repeats it per line (`KEPT (hand-placed)`) |

Nothing is written back into `docs/gspro/<course>/*-props.gen.py`: that is still the only way to make a hand move
permanent across machines and through a `props.clear` + rebuilt spec, and the report's `handPlaced` is what to carry
into it (workflow 4 in [docs/workflows.md](../docs/workflows.md)). `keepHandEdits=false` is the old behaviour: every
instance from the spec. `only=<asset ids>` leaves the other assets' records untouched.

**A scene from before this existed has no record**, so a place would replace every prop from the spec and drop the
hand moves one last time. `golfmap.props.record` seeds `placed.json` from the props standing in the scene, touching
none of them: per asset, the instances are paired to the spec's entries by **nearest x/z**, one to one, closest pair
first, no radius (the same `PairNearest` the place uses), and each is recorded with the transform it has.
`mark=moved` (default) calls an instance hand-placed when it stands more than 1 cm from the spec entry it paired
with - x/z only, the one comparison that is a pure function of the spec, since the height comes from a raycast that
moves with the terrain. `mark=all` calls every instance hand-placed (the scene as it stands is what is wanted; no
prop is then re-grounded after a terrain change until its spec entry moves). A prop that was only **rotated** by hand
is not found by `mark=moved`: use `mark=all`, or capture it into the spec.

The object names must **not** be trusted here: `<asset>#<i>` is the index the spec had when the prop was placed, and
a single `place(...)` call added or removed shifts every later one. A first run that paired by name on Vreta reported
88 "hand moves" that were one index shift per asset (all 11 `range_mat` off by exactly 5.745-5.805 m with the same
yaw, a row of 10 `hedge_boxwood` off by 11.18 m, `bench_stone` by 187-522 m) and 98 instances "not in the scene".
So read the result's `pairing`: `indexStillRight` (paired instances whose name already matched their spec entry) and
`pairedByPosition` (the stale ones), plus `unpairedInstances` (in the scene, no spec entry left: `spec: null`,
`hand: true`, deleted by the next place), `notInScene` (spec entries with no instance) and a per-asset `assets`
breakdown of the same numbers. `handPlaced` and `rows` are then the real hand moves; `golfmap.props.place
{dryRun: true}` must bring them back as `kept`.

## Stone walls

Exposed rock can use `stoneAlbedo`, `stoneNormal` (imported as a normal map),
`stoneTileM` and `stoneColor` in the walls defaults. Course-owned copies append
rock albedo/MAHS and normal slices to the OPCD arrays, preserving the original
slices and shader. Blue paints the top and green paints a brighter steep-face
variant, fading between 35 and 60 degrees; both exclude generated tall grass.
This requires blue/green to be available on the affected course meshes.
`golfmap.walls.texture-survey` exports source texture previews;
`golfmap.walls.material-check` checks preserved array slices and nonempty rock
data after reload. `golfmap.paint.probe` reports all three mean colour channels.

A cliff's `roundTopM` adds a tangent circular shoulder and smooths across the
upper rim. `paintInsetM` pulls its paint inside the outline, and `grassPatches`
are feathered irregular ellipses `[E,N,radiusEast,radiusNorth]` that retain the
original grass paint. `paintOnly: true` preserves original mesh heights;
`placeStones: false` shapes/paints without generating a wall of blocks (clear
an old group once with `golfmap.walls.clear`). `placedColors: {id: [r,g,b]}`
matches existing stone groups through `golfmap.walls.colors` without changing
their transforms, and reapplies after builds.

`GolfMapWalls.cs` builds stone faces on steep banks, and `GolfMapWallGround.cs` reshapes the ground under them: the
raised tees of Vreta's 13th, whose downhill sides are dry-stone walls from foot to top edge. The lidar smooths such a
wall into a 45-60 deg bank and OPCD's ~1.2 m mesh grid into ~35 deg; no placement of stones on that bank reads as a
wall, so the meshes are reshaped first (ce.simgolf's rockwork in Blender, done in Unity: subdivide, pull steep, paint
the stone in).

- Spec `golfmap-walls-v1`, `<course>/stone-walls.json`, generated by `docs/gspro/<course>/stone-walls.gen.py --out
  <course folder>`: each wall as paired EPSG:3006 stations along its bank, the foot (`toe`) and the top edge (`lip`),
  traced on rays from the plateau's centre over the edited DEM; `stoneSets` (named lists of stones), `styles` (named
  presets), `defaults`, per-wall overrides (defaults, then the wall's style, then the wall); `boulders`, single big
  stones placed whole.
- Ground (`ground: true`): inside the vertex paint (`golfmap.paint.apply`, so also after every `golfmap.meshes.sync`),
  every course mesh the bank crosses is copied from its FBX mesh, subdivided there to `subdivideM`, raised (never
  lowered) to a terrace: the foot up to `baseInM` in, a face at `faceDeg`, then the plateau's height (measured on the
  original meshes just past the lip) out to `beyondM` past the lip, tapered over `taperM` at the ends. On rough meshes
  the face is painted `groundChannel` (blue), and the mesh gets a copy of its material (`<course>/Walls/<name>
  (stone).mat`) whose blue channel is `stoneMaterial`'s `stoneMaterialChannel` (OPCD's Mossy Rock): stone between the
  stones and no Stix grass. The copy goes into `PaintedMeshes/` like any painted mesh, the MeshCollider takes it (the
  ball meets the new ground), `restore.json` keeps the original mesh and material, `golfmap.paint.restore` puts both
  back. OPCD's theme window resets the material: run the paint again.
- Styles:
  - `wall` (a dry-stone wall, stenmur): courses up the face (`baseCourseM`, `courseM` high, beds jittered
    `bedJitterM`), each a run of wall stones `lengthRatio` x the course height long, their flattest side out, set
    `faceProudM` (+- `faceJitterM`) proud of the face's plane, beds along the batter, turned `spinDeg` at most; the top
    course cut to end `capM` over the plateau. Wall stones: `props_kit` `boulder` with `exponent` 2.5-3.6 (blocks with
    rounded edges), `flats` (face +y, beds +-z) and small `lumps`; which side is the face is read off the mesh.
  - `rose` (a stenröse, a heap of rounded stones): courses `courseStepM` apart so they nest, front stones on the face
    (`followBank`) standing `proudFrac` of their depth out, leaning `leanDeg` back, packed `gapM`, tops capped `capM`;
    `maxFill` stones behind where no ground reshaping lifted the plateau. Round `boulder`s.
- Stones: Blender-built (`props_kit` `boulder`: the kit's lichen granite, moss or ivy on faces pointing up) in the
  spec's `stonesFolder` (`<course>/Walls/Stones/`, from `docs/gspro/<course>/wall-stones.json` through
  `build_props.py`); materials and FBX import from that folder's manifest (`GolfMapProps.PrepareModels`). A stone may
  also be a `prefab`. The packs' photoscanned rocks (NatureManufacture Meadow) read as rubble.
- `golfmap.walls.build` (GolfMap > Walls > Build stone walls): runs the paint first when a wall has ground, then the
  stones, fitted to the course meshes (terrain where there are none), under `GolfMap Walls/<id>/<model>#<n>`,
  MeshColliders on Blender stones, no custom components. Rebuilds replace (`only=<ids>`); a wall's seed + `variant`
  gives the same stones every time, so hand edits to single stones are lost on a rebuild - a wall's stones have no
  identity in the spec (they are generated from its seed), so they get no `placed.json` record the way props do;
  capture a moved stone as a `pose` boulder instead (below). `profile=<wall id>` shows
  the bank as the meshes have it, `dryRun=true` the plan, `save=true` saves the scene when the build succeeded
  (["Saving what a command changed"](#saving-what-a-command-changed-save)). Report: `GolfMapSpelunk/<Course>_walls.txt`.
- `golfmap.walls.clear` (`only=<ids>`, `save`) deletes the stones (the ground stays: drop `ground` and paint again).
- `ground: false` on a wall turns its ground reshaping and rock paint off and keeps the rest of its entry. Vreta's
  `pond-klippa` and `h4-klippa-a` have it since 2026-09-29 (the klippa ground is left to the Blender shaping tools);
  the hole 13 tee walls keep theirs.
- Klippor (natural rock outcrops) are not built with reshaped ground: sharpening the mesh read as a boxy terrace. They are
  big closed rocks (NatureManufacture `Rock_01/03/05`, grass-top variants on the face) scaled to 5-8 m and sunk into the
  lidar knoll, placed as `boulders` (`docs/gspro/vreta/stone-walls.gen.py` `outcrop_rocks`). The pack's cliff pieces are
  one-sided facades, hollow from behind: `golfmap.props.measure` reports `face.oneSided` (~0.8 for them, ~0.05 closed).
- A boulder with `pose` (`dy` over the ground under its pivot, `euler`, `scale`) is placed exactly so: that is how stones
  moved by hand in Unity are kept (capture them into the generator before any rebuild). `golfmap.walls.capture
  [only=<id prefixes>] [all=true]` lists the boulders whose transform differs from where the spec puts them, with
  the pose to paste; an empty list after regenerating means the spec reproduces the scene.
- A stone may carry `tint`, `materialFloats` and `materialColors`: drawn with course copies of its materials under
  `<course>/Walls/Materials/` (e.g. less moss on the grass-top rocks: `_Snow_Amount`, `_SnowMaxAngle`).
- Colliders: every stone collider gets the spec's `physicMaterial` (`GSPstone`); GSPro reads bounce and roll off the
  collider's physics material, like the course meshes' `GSPrough`/`GSPfairway`. `golfmap.walls.colliders` sets it on
  everything already placed. Prefab colliders sit on their LOD0 child, not the root.
- Stone-painted course mesh (a wall-ground face) is class Rock (11) in the surface map, and the tall-grass rules keep off
  it. After removing wall ground, the terrain it lowered stays down: `golfmap.terrain.conform` with `x0/z0/x1/z1` raises it
  back in that area only; then `golfmap.surfaces.export` and `bun run grass:zones` so the grass returns.

## Hole navigator

`GolfMap > Scene View > Hole navigator` (`Editor/GolfMap/GolfMapHoleNavigator.cs`) is fast travel in the Scene view: a row per hole with a button per stop (**Tee**, **Aim 1..n**, **Green**). A click puts the eye over that point, 5 m above the ground (the toolbar's `m up`), tilted 10° down and looking along the direction of play: from the tee to the first aim point ahead of it (else the green), from an aim point to the next stop. **Green** stands 15 m behind the green centre and looks back down the hole (towards the last aim point, else the tee). `<` and `>` step through the course in playing order. **Tee** is the back tee unless the toolbar picks a tee by name.

The stops come from `<export folder>/<prefix>-holes.json` (golfmap-holes-v1: every tee, aim point and green centre in EPSG:3006, no heights). Write it again after they move in golf-map: `bun run py gspro.py holes --course <course> --out <export folder>/<prefix>-holes.json`. The window reloads the file when it gets focus. Bridge: `golfmap.holes {hole, point, tee, heightM}`, or no arguments for the list.

## Power lines

`golfmap.powerlines.build` (`Editor/GolfMap/GolfMapPowerLines.cs`) builds the course's `power_line` features (drawn in golf-map's Draw mode, one point per pole structure) as H-frame wooden pole lines under `GolfMap Power Lines`: two poles and a crossarm at every point, three hanging insulators, three sagging wires between structures.

1. Export the lines: `bun run py gspro.py power-lines --course <course> --out <export folder>/<prefix>-power-lines.json` (golfmap-power-lines-v1: each line's points in EPSG:3006).
2. `unity_command golfmap.powerlines.build {dryRun: true}`: per span its length, sag, pole height and the wires' least height over the ground. `noGround` lists points with no collider under them (outside both terrains); those structures are left out.
3. The same without `dryRun`. Defaults: 13 m poles 4.6 m apart, 9.6 m arm, wires 4.3 m apart, sag 2.2 % of the span. Where a span's wires would come within `minClearanceM` (6 m) of the ground, its two structures grow, up to 7 m: a long span over a hill usually means a pole was not drawn.
4. Meshes (`<line> poles/insulators/wires.asset`) and the three Standard materials go to `<course>/PowerLines/`. The materials are made once and then kept (`resetMaterials: true` puts the built-in look back). The poles carry a MeshCollider with `GSPwood`; the wires have no collider.

A rebuild replaces everything under `GolfMap Power Lines`. The trees export keeps survey stems out of the corridor (docs/gspro/export.md, `trees`); replant after drawing or moving a line.

## Course build (the GSPro course file)

`golfmap.course.build` (`GolfMapCourseBuild.cs`) does what `GSP > Build Course`'s Build button does, without the
window: saves the open scene (`saveBefore=true`, the default - the bundle is built from the file on disk, and
`saveBefore=false` refuses a dirty scene instead of saving it; it is NOT the other commands' `save`, which saves
after a command has succeeded), switches the four terrain colliders off as
the window does, runs OPCD's own builder (`BuildCourseDLL.Encryption`, reached by name) and puts the wind zone and the
VSP systems back after it. Output: `<courses dir>/<scene>/<scene>.gspcrse` (`dir`, default the folder saved in the
build window). It takes about 12 minutes, inside which the editor's main thread is OPCD's: no bridge command is
answered, and the call itself usually comes back as "still running".

**Progress while it runs: `golfmap.course.build.status`.** The build writes
`GolfMapSpelunk/<Course>_build-status.json` before it starts and at every milestone it can observe -
`{ running, pid, startedAt, seconds, phase, written, scene, lastResult }`, phases `starting`, `saving-scene`, `preparing`,
`building-bundle`, then `refreshing-vegetation` or `failed-restoring-wind`, and `done` / `failed` - so there is no
need to guess from the `.gspcrse`
mtime. `seconds` of a running build is counted from `startedAt` when the status is read, because the build cannot
update its own file through the long phase; `lastResult` is the last finished build's result (file, megabytes,
seconds) or its error, and is carried along while a new build runs. The file outlives a build that takes the editor
with it - and because the build holds the main thread to its end, it can never write "I stopped". That is what `pid`
is for: a file that says `running` from a process that is gone reads as phase **`interrupted`** (and `running: false`)
instead of building for ever, both in `golfmap.course.build.status` and in `bun unity/mcp/build-status.ts`.

The bridge may be as silent as the editor, so the file is also read straight off disk:
`bun unity/mcp/build-status.ts [project]`, and `unity_status` reports a running or lately finished build under
`courseBuild` (`unity/mcp/build-status.ts`, `readBuildStatus`). A project where no single `GolfMapCourse` claims the
scene builds as before, with a warning and no progress file.

## Performance ranking

What costs the most frame time on the course, ranked, per category, with the geometry behind it. Two measurers with the same categories and the same result file (`golfmap-perf-rank-v1`):

| | where | run |
|---|---|---|
| Unity editor | `Editor/GolfMap/GolfMapPerf.cs`, `GolfMapPerfWindow.cs` | `GolfMap > Performance Ranking`, or `unity_command golfmap.perf.report {rounds: 3, json: "<file>"}` |
| GSPro | `ArboristMod/perf.ts` (through the mod's `scene.geometry`, `scene.hide`, `veg.draw`, `fps`) | `bun unity/ArboristMod/perf.ts --rank --course <Course> --json <file> --md <file>` |

- **Categories** are rules in `Editor/GolfMap/GolfMapPerfCategories.json`, never object lists: course meshes by surface (`mesh.fairway`, `mesh.rough`, `mesh.path` ...), props by group, stone walls and rocks, water, power lines, wispy rough (regexes on the hierarchy path); Stix 3D grass, terrains and post-processing volumes (component types); the VSP systems per type (`vsp.course.grass|plant|tree|billboard|object`, in the game also `vsp.arborist.*`); all shadows. A renderer no rule catches is `other:<root object>` (numbered roots and `(Clone)` copies together: `FlagAssembly_#`, `teeMarker#`); the `other` rows under 0.5 % of the scene's triangles and renderers fold into one `other:small` row whose members are in the JSON. The report states what share of the renderers and triangles the rules caught. `other` rows are counted but only timed when asked for (`only: "other"`, `--only other`), which leaves about 30 timed rows. A new kind of object on a course = a new line in that file (tests: `bun test unity/perf-rank.test.ts`).
- **Viewpoints**: `docs/gspro/<course>/perf-views.json` (`golfmap-perf-views-v1`: name, position, rotation as pitch/yaw/roll, `eye` = metres over the ground). The game script reads it there; the editor reads a copy in the course folder (`Assets/GolfMap/<Course>/perf-views.json`) and measures the Scene view as it stands when there is none (`current: true`, the window's "current view only").
- **Geometry** per category: objects, renderers, triangles (every LOD level, and LOD0 alone), distinct meshes and materials, shadow casters, LODGroups; for VSP the items and stored instances, and in the editor what the camera drew of each type at each viewpoint (`inView`).
- **Cost**: frame time with everything on, then with exactly one category off, a fresh baseline every `baselineEvery` cases, `rounds` times over. A case is compared with the baselines just before and after it; the saving is the median over the rounds, in **milliseconds per frame** (they add up; the fps and the share of the frame are derived from it at that viewpoint). Overall = the mean over the viewpoints.
- `golfmap.perf.report` arguments: `views` (file), `view` (part of a name), `current`, `rounds` (0 = geometry only), `frames` per reading, `settle` frames at a new viewpoint, `width`/`height`, `only` (ids or their first part, or group names: `mesh`, `vsp`, `props.vehicles`, `Vegetation`), `json`. `golfmap.perf.hide {category}` / `golfmap.perf.show` switch one category off in the scene to look at the course without it (the window's Hide / Select buttons); nothing is saved, and a scene save or script reload puts it back.
- Side by side: `bun unity/ArboristMod/perf.ts --md <out.md> --from <editor.json> <game.json>`. The markdown opens with a summary (the five largest costs overall, each viewpoint's baseline and its three largest); tables are ordered by measured saving, then triangles, the `other` rows last.
- The game run ends with "Game left as found: yes" (`conditions.restoreCheck` in the JSON): nothing left hidden by `scene.hide` / `veg.draw`, shadow setting, quality level and vSync as at the start.

**Quick A/B: `golfmap.perf.quick view=<names, comma-separated>`** - the frame time at named viewpoints in 4-6 s each
(Vreta 2026-10-15: four views in 18.5 s): pose, wait until two short readings agree (VSP done loading; `settled`
false = read again), one 30-frame median with VSP CPU / render ms and the VSP grass instances and triangles drawn.
Nothing is switched off: measure the same views before and after one change. The first view after a script reload
is slow (900 ms frames while the editor warms up): read one view first. A `golfmap.perf.report` with every category
takes 10-20 minutes and holds the editor; `only` takes a list or a comma-separated string (before 2026-10-15 a list
read as no filter and timed every category). Never measure the Scene view as it stands (`current=true`) for an A/B:
it moves when someone works in the editor.

Reading the numbers:

- **The editor's are for ranking and geometry, the game's for fps.** The editor times the Scene view camera rendered off screen: no frame-rate cap, no GSPro systems (the Arborist vegetation, GSPro's sky and UI are not there), another field of view. Its triangle counts are the real meshes; a built course has static batches (below).
- **"not measurable"**: the saving is no larger than the noise (the median difference between one baseline and the next at that viewpoint) or than half the spread of its own rounds. A single 5 s reading in GSPro swings by several fps: raise `--rounds` before acting on a small number.
- **"at the cap"** (game): GSPro runs with vSync and sets it again every frame, so the frame rate stops at the display's refresh rate. A viewpoint whose baseline is at the cap measures nothing; a saving that reaches the cap is a floor (`>=`). Use a heavier viewpoint or a higher resolution; the script does not change the game's resolution. The script finds the cap by looking straight up at the sky for a moment (the display's reported refresh rate has been wrong) and puts the camera back; `--cap <fps>` overrides. If the sky reading is unsteady or no display refresh rate, the cap is unknown, nothing is marked "at the cap", and the script warns that something else is using the graphics card: those timings are not the game's own.
- **Static batching** (game): a batched renderer's mesh is the whole combined mesh, counted once per category, so those triangle counts are upper bounds (`<=` in the tables, `batchedRenderers` in the JSON).
- **VSP**: the game's rows (`veg.draw`) stop the drawing only, the cells stay loaded and culled; the editor's rows hide the items (`GolfMapVegPerf`), so they include VSP's CPU work for the type. Never measure after a `veg.set`: a refreshed system reloads its cells for minutes.
- Measure the game with Unity and Arborist closed (`pwsh unity/ArboristMod/apps.ps1 close`): they take the graphics card.
