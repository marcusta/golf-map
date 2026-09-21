# unity

Unity editor scripts for getting golf-map output into an OPCD/GSPro course project.
Nothing here runs in the golf-map build. Copy `Editor/GolfMap/` into the OPCD base
project under `Assets/Editor/GolfMap/` (any folder named `Editor` works). The menu
items appear under `GolfMap`.

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
   on, a `-meshes` variant: the darkened twin with the course's grass surfaces tinted dark
   green from its drawn features (the Photoshop overlay step done automatically), meant for
   the course meshes, not the terrain; the picker defaults to the `-terrain` twin, patched
   before pristine, then `-meshes`, hillshades last.
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

### Palette tab

The `GolfMap Trees` Inspector has two tabs. **Palette** (`GolfMapTreePalette.cs`) edits the
course's `palette.json` in place: the broadleaf species weights (any species name; add and
remove), every matching rule, the seed, and each asset's enabled flag and pine weight.
The file stays the source of truth and both sides may edit it: the tab reloads when the file
changes on disk, and asks first when it holds unsaved edits. `GolfMapPalette`
(`GolfMapBiome.cs`) reads and writes through a lossless document (`GolfMapJsonDoc.cs`), so
keys the tools do not model (`catalogue`, `zones`, `originalPath`) survive, untouched numbers
keep their text, and the output matches the node scripts' `JSON.stringify(p,null,2)` - a
one-weight edit is a one-line diff.

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
terrain with the new palette and **Clear existing trees first** on.

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

## Vegetation Zones

`GolfMap > Vegetation Zones` (`GolfMapZoneImporter.cs`, VSP half in
`GolfMapZoneImporterVsp.cs`, model in `GolfMapZones.cs`) imports a `unity-zones-v1`
export (`gspro.py zones`, one per terrain: `<course>-<inner|outer>-zones.json` plus
`<course>-<inner|outer>-zones-<n>.png`, next to the trees files in the export folder)
into Vegetation Studio Pro texture masks. Plan and format: `docs/feature-vegetation-zones.md`.

1. Pick the zones JSON, **Load and check**. The importer validates the format, the plot,
   that every mask PNG exists and is square at `resolution`, and that `zoneTypes[]`
   texture/channel agree with `masks[].channels`. The terrain is matched by plot side
   (2050 m inner, 5000 m outer), and the VSP systems covering that terrain are listed
   the way the tree planter matches storage (terrain in the system's list, bounds =
   square + 1 m). The package defaults to the system's `Default`-biome package that is
   not a planter tree catalogue; both are popups if the guess is wrong. The tool never
   creates a system: plant trees first so `GolfMapVspRig` builds it.
2. **Import masks and rules**:
   - copies each PNG to `Assets/GolfMap/<Course>/Zones/` and imports it readable,
     RGBA32, uncompressed, no mipmaps, clamp, linear, Max Size >= resolution (VSP samples
     masks on the CPU with `GetRawTextureData`, so nothing else works);
   - creates or updates, in place, one RGBAChannel **Texture Mask Group** per zone type,
     named `golfmap-zone:<key>`, with the texture over the terrain's world rectangle and
     the group's channel selector set to the zone type's channel;
   - for every `zoneTypes[].items` binding finds the item by `Name` in the package
     (exact, then trimmed: Arborist biomes carry trailing spaces) and creates or updates
     a **Density** rule (`DensityMultiplier` = `maxDensity`) and an **Include** rule
     (`MinDensity` 0.02) against that group. Rules are matched by group id, so re-import
     updates in place. Nothing else on the item is touched;
   - calls `RefreshVegetationSystem` + `ClearCache` on the system so runtime spawn picks
     the masks up, saves assets and marks the scene dirty (save it);
   - writes `<UnityProject>/GolfMapSpelunk/<Course>_zone_import.txt`: textures, groups
     created/updated, stale `golfmap-zone:*` groups for types no longer exported (left in
     place), items bound, items named in bindings but missing from the package, package
     items with no binding, channels no item uses. The window shows the same summary.
3. **Draw zone outlines** draws every zone's rings in the Scene view with Handles in the
   zone type's colour at terrain height (plus the lift), with the zone id, type and
   weight at the centroid (always, or on hover only). Read-only; it exists to check
   alignment against the terrain and the trees.

Limits: VSP's density rule has a multiplier only, so a binding's `minDensity` is stored
on the rule (`MinDensity`) but does not raise the floor; the include threshold is fixed
at 0.02. Groups are one texture each, and `Repeat` is always 1.

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

## Not built yet

- Historical note for the original tools: no Unity or C# compiler was installed on the dev
  machine. First run inside the OPCD project will show any API mismatch for its Unity
  version. Written for C# 6 so it compiles on the Unity 2018.2 base project; newer APIs
  (terrain layers, prefab roots, render pipeline, package listing) are behind version
  defines with 2018.2 fallbacks.
