# unity

Unity editor scripts for getting golf-map output into an OPCD/GSPro course project.
Nothing here runs in the golf-map build. Copy `Editor/GolfMap/` into the OPCD base
project under `Assets/Editor/GolfMap/` (any folder named `Editor` works). The menu
items appear under `GolfMap`. [`install.json`](install.json) lists every folder that goes into a
course project; the `unity` MCP server's `unity_sync` does the copying, and the editor bridge
(`Editor/GolfMapBridge/`) lets an agent recompile, run menus, read the console and take
screenshots in the open editor. See [mcp/README.md](mcp/README.md).

## Terrain Importer

`GolfMap > Terrain Importer` turns the folder the app's **Export to GSPro** panel writes
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
   on, a `-meshes` variant (4096 px): the darkened twin softened to ~1 m of detail, with the
   course's grass surfaces tinted dark green at 50 % and everything that isn't drawn (the Photoshop overlay step done automatically). The
   inner's is for the course meshes (the sun-lit tint lifts it); the outer's is the outer
   terrain's floor: as dark as its `-terrain` twin, with the colouring on top. The picker
   defaults to the `-terrain` twin for the inner and the `-meshes` variant for the outer,
   patched before pristine, hillshades last.
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

### Updating the heights in place (golf-map's "Heightmap → Unity")

The Terrain Importer builds the terrains. After that, a new heightmap (terrain edits, pads, digs) goes
onto the existing ones with `GolfMap > Terrain > Update heights from export`, or the bridge's
`golfmap.terrain.update [terrain=inner|outer|both] [outerSink] [dryRun=true]`.

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

golf-map's GSPro panel drives this with **Inner/Outer heightmap → Unity** (export kind `unity-terrain`;
CLI `bun run gspro:export -- <course> unity-terrain:inner`). The server exports the heightmap, finds the open
editor whose active course's export folder is the course's (through the same bridge client as the MCP
server), and runs the update. It refuses an inner heightmap older than the site's terrain edits (see
docs/gspro/export.md). Terrain › Export To OBJ for Blender stays manual.

### Sculpting in Unity, carried back to golf-map

Sculpt a terrain in Unity, then press **Inner/Outer Unity sculpt → golf-map** in golf-map's GSPro panel
(export kind `unity-sculpt`, bridge `golfmap.terrain.capture terrain=inner|outer [threshold=0.01] [dryRun]`,
`GolfMapTerrainSculpt.cs`). A capture measures, per heightmap vertex:

    sculpt = current − reference + sculptIn − conform

| | |
|---|---|
| `reference` | the heights golf-map last put there. `golfmap.terrain.update` keeps a copy in `<course>/Reference/<terrain>-heights.asset` + `-reference.json`. A terrain imported before this existed needs one Heightmap → Unity first |
| `sculptIn` | the sculpt layer that export already contained (`gspro.py dem --sculpt` writes `<stem>-sculpt-in.raw`, and the update keeps a copy). This makes every capture the whole layer, so replacing the stored layer never loses earlier strokes |
| `conform` | what `golfmap.terrain.conform` raised under the meshes (`<terrain>-conform.bytes`, cleared by the next update). It is derived, not a sculpt |

Differences under 1 cm are heightmap quantisation. The outer's capture leaves out the inner square. The
capture goes to the export folder as `<prefix>-<terrain>-sculpt.raw` (float32 m, the heightmap's pixel grid,
north-up, cropped) + `.json` (golfmap-sculpt-v1). golf-map makes it a GeoTIFF and stores it as that terrain's
one `delta` terrain edit, replayed after every other edit. A capture with nothing sculpted removes the layer.
Then Apply to terrain, and the heightmap → Unity again. The layer is additive: regrading or digging under it
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
scene side `GolfMapVegLive.cs`, shared working copy + bridge commands `GolfMapVegSession.cs`)
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

**Tree looks.** A species that plants with its pack's own materials is read-only: **Create a
tunable look** copies its materials and prefabs (`GolfMapLooks.Generate`; the source stays as
`original` at weight 0, so the next Plant uses the copy). **Duplicate** branches a look, **Remove
look** drops it from the palette (the last one returns the species to its source materials),
**Show in Lab** stands one plain instance per look and shape at the Scene view pivot (rows =
looks, columns = shapes by height) under `GolfMap Lab (not saved)`, never saved or built. Values
are read from the materials a look's prefabs really draw with: while a trial re-points them
outside the look folder (the CTI swap), the window says so - edits then change those materials in
place and Save does not record them in `palette.json`.

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
without writing anything.

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
    { "id": "epsg3006:651612.31:6404380.02", "x": 412.31, "z": 880.02, "h": 14.2, "r": 4.1, "g": 34.85, "k": 1, "bush": false }
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
  `BlendTarget.BlendToMaterialBlack`, which on Vreta names the Satellite-theme rough). A `tint` (the fake rolled-lip
  shadow) or `blendStrength` is baked into its own source material so an OPCD rebuild from
  the asset gives the same look. Output: `Assets/GolfMap/<Course>/Bunkers/<convention>/`.
  Originals are never edited; Undo works.
- **Restore OPCD materials** puts back the material and `ChannelMaterials` asset each mesh
  had before its first apply (`Bunkers/restore.json`).

Running OPCD's theme window (SetMeshMaterialv4) reassigns bunker materials; apply again
after it. `blender/tools/bunker_paint_report.py` is the Blender twin of Check paint (same
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

## Vertex paint

`GolfMap > Vertex Paint > Apply paint.json` (`GolfMapVertexPaint.cs`, bridge `golfmap.paint.apply
[dryRun=true]`) generates vertex paint on the course meshes from `<course>/paint.json`
(`golfmap-paint-v1`, written with defaults on the first run; a dry run before that previews the defaults).
`Restore original meshes` (`golfmap.paint.restore`) puts the FBX meshes back.

How the paint reaches the game:

- **MAHS channels.** OPCD's `4 color Vert Paint MAHS` material draws one texture per paint channel. Course
  meshes are 100 % red except bunkers, blends and water. Rough's black channel is OPCD's dirt base (index 4)
  at about half opacity, so black on rough reads as a worn or dry patch.
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
  FBX re-import gives the same result. Objects no rule touches any more go back to the FBX mesh. Apply marks
  the scene dirty and does not save it: save the scene to keep the swaps.

Rules (only `kind: edge`, `edge: bunker` so far): paint `channel` onto the `surfaces` (GolfMapSurfaces
classes) within `widthM` of the outer edge of every bunker blend. World-anchored Perlin noise picks the
stretches where the rule applies (`coverage` share, `noiseM` long, `seed`), and a second octave varies how
far each spot reaches (35-100 % of `widthM`). The weight falls off smoothly from `strength` at the edge.
Vreta's first recipe (`bunker-surround`: rough, black, 2.2 m, strength 0.9, coverage 0.55, 3.5 m) paints
about 5 900 vertices on 20 of the 60 rough meshes. Many greenside bunkers border fairway or semi rough,
which have no Stix grass.

Vertex spacing limits the detail: fairway, rough, semi and deep are about 1.2 m, rough within 3 m of a
bunker about 0.8 m, bunkers 0.19 m and blends 0.09 m. Features under about 2 m do not survive on the grass
meshes. Check a result from above (`unity_screenshot` with a pitched `rotation`): at eye height from 10 m away,
a band this narrow is hidden behind the blades.

Read-only helpers: `golfmap.paint.survey` (per class: vertices, edge lengths, current paint, Stix setup,
bunker centres) and `golfmap.paint.probe x z r` (paint of every course mesh near a point).

## Course meshes: FBX sync

`GolfMap > Meshes > Sync from FBX folder` (`GolfMapCourseMeshes.cs`, bridge `golfmap.meshes.sync`) keeps the
scene's course meshes in step with the FBX folder the Blender export writes into. The Blender side is
[`blender/tools/fbx_sync.py`](../blender/README.md#fbx-sync) ("Export changed FBX"), which only rewrites the FBX
of meshes that changed, so Unity only reimports those.

It does what deleting and re-adding the meshes by hand does, but only for the meshes that changed:

- **Changed FBX** (size or time differs from the last sync, `<course>/meshes-sync.json`): the scene object is
  deleted and added again in the same place. Unity's in-place update of an overwritten FBX is not relied on;
  it left old geometry in the scene. After OPCD's own Batch Export every mesh counts as changed.
- **New FBX:** instantiated under the course's mesh parent the way OPCD's `GSP > Add OPCD Meshes` does. Added and
  replaced objects get a `MeshCollider`, then OPCD's `GameObject > Set Default Materials` runs on them (materials,
  channel store, physics material).
- **FBX that is gone:** objects under the parent that show no current FBX (including painted copies of a deleted
  FBX, which keep rendering) are `stale`. The menu asks before deleting them; the bridge deletes with `prune=true`.
- **Leftovers:** an FBX that the Blender FBX sync's record (`<folder>/.golfmap-fbx-sync.json`) doesn't list is left
  over from an older `.blend`. It is never added and is reported with its scene objects; delete it from Blender
  (**Delete FBX of removed meshes**), then sync again. A record older than any FBX (OPCD's Batch Export bypasses
  it) is ignored.
- **Excluded:** FBX whose name starts with a prefix in the course's `meshExclude` (default `Gap_Issue`, OPCD's
  gap-check markers) are never added, even when OPCD's Batch Export writes them; objects showing one are stale.
- **Vertex paint** is applied again after any add or replace (`paint=false` skips it).
- **First sync** (no record yet): nothing is replaced; the scene is taken as current and recorded. `GolfMap >
  Meshes > Rebuild all from FBX folder` (`replaceAll=true`) replaces every mesh.
- The parent and objects with children are never treated as course meshes. A parent that renders a mesh itself
  (e.g. made by dragging an FBX in and renaming it) is reported under `warnings`: it draws twice there.

Folder, parent and exclusions come from the course asset (`meshFolder`, default `fbx` under Assets; `meshParent`,
default `Meshes`; `meshExclude`, default `Gap_Issue`); the bridge takes `folder`/`parent`/`exclude` overrides. `Preview sync` / `dryRun=true` shows the plan. Undo
covers the scene changes; the scene is marked dirty, not saved.

## Creeks (R.A.M.)

`GolfMap > Creeks > Import creeks (R.A.M.)` (`GolfMapCreeks.cs`, bridge `golfmap.creeks.import
[file] [dryRun=true]`) turns golf-map's `<prefix>-inner-creeks.json` (unity-creeks-v1, the GSPro panel's
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
  order: edit the creeks → **Dig creeks** → Apply to terrain → **Inner heightmap → Unity** → Blender meshes +
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
[liftM=0.3] [replaceExisting] [prune]`:

- **Geometry**: the lake's `Spline_*_Water_Base_Lake_-_Mesh` (or the selected mesh), welded, every vertex put at one level = the lowest
  vertex on its edge (islands included) − `belowM`, then a flat ring `outsetM` wide around every edge so the plane
  runs in under the banks and blends. All red vertex colour, normals up, no UVs (the shader samples its waves in
  world XZ). Saved to `<course>/WaterPlanes/<key>_WaterPlane.asset`. On Vreta's `others_49` it gives the same
  21 502 vertices as OPCD's plane, 1 cm higher.
- **Object**: `<key>_WaterPlane` (e.g. `Spline_others_49_WaterPlane`; another mesh's name without `_-_Mesh`,
  e.g. `Spline_hole_17_12_Bunker_WaterPlane`) under **Waterplanes**, its transform `liftM`
  above the level, as the hand-made plane was raised. A MeshCollider, then OPCD's **Set Default Materials**, which
  keys on `_WaterPlane` in the name: material `OPCD-WaterPlane_AquasLite`, physic material `GSPwater` (what makes it
  a hazard in GSPro), and a child **Default Reflection Probe** at the plane's centre (realtime, refresh on awake,
  1024, HDR, box projection, box 15×100×15 m) that the renderer uses as its anchor override. The whole plane
  reflects that one cubemap.
- **Rebuild** refills the same mesh asset. The object, its material and its probe stay, and the probe moves to
  the new centre. A lift changed by hand (the object's local y) is kept unless `liftM` is given.
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
  reflection probe (on awake) covers the area. Replaces what the last place made (`only=<ids>` just those).
  `dryRun=true` returns ground heights and the plan. Report: `GolfMapSpelunk/<Course>_props.txt`. Warns when a
  building's footprint spans more than 1 m of ground (a pad or a plinth to check).
- Placed objects carry no custom component (GSPro would load it as a missing script); they are found by name.
- `golfmap.props.measure` (`folder` or `paths`): prefab sizes, LODs and colliders, for sizing prefab assets in a spec.
- Prefab assets (`prefab` instead of Blender parts, e.g. the vehicle pack's cars, the CE golf cart, a pack's hedge):
  `axis` = the prefab's forward axis (`x` default, `z` for most vehicle packs; `yawDeg` is its compass bearing),
  `recolor: [{material, color, as}]` = copies of named materials with another `_Color` under
  `<Props>/Materials/Recolor/`, swapped in on that asset's instances (grey/silver cars from a white body). The prefab's
  own root scale is kept (packs modelled in cm scale the root); `collider: box` adds one box to a prefab without
  colliders. Import pack subsets by dependency (prefab + what it references, with `.meta`), never over existing GUIDs.
- Manifest materials can be `fade` (translucent Standard, e.g. ball-stop netting) or `cutout`.
- `golfmap.props.clear` deletes `GolfMap Props`.

## Stone walls

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
  gives the same stones every time, so hand edits to single stones are lost on a rebuild. `profile=<wall id>` shows
  the bank as the meshes have it, `dryRun=true` the plan. Report: `GolfMapSpelunk/<Course>_walls.txt`.
- `golfmap.walls.clear` (`only=<ids>`) deletes the stones (the ground stays: drop `ground` and paint again).
