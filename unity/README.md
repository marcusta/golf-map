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
   picker per terrain for the overlay. Every orthophoto export comes as two JPEGs, the
   photo as-is and a `-terrain` twin darkened for the terrain shader (which lights the
   photo a second time and washes an untouched one out); the picker defaults to the
   `-terrain` twin, patched before pristine, hillshades last.
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

`GolfMap > Tree Planter` is the manual entry point. See [MANUAL-PLANTING.md](MANUAL-PLANTING.md)
for the biome palette, size matching, prepared material colours, backup/restore and
separate inner/outer VSP setup. Install `GolfMapTreePlanter.cs`, `GolfMapBiome.cs`,
`GolfMapTreePlanterVsp.cs` and `GolfMapBiomeAtlas.shader` together for VSP.

`GolfMap > Vreta > Configure manual biome planter` configures the current Vreta
inner import without planting. Use **Load and check**, then **Plant** manually.
The selected palette is `Assets/GolfMap/Vreta/palette.json` (copied from
`docs/gspro/vreta/palette.json`). Biome mode uses uniform scale and deterministic
species/size matching. Legacy lists remain available with biome mode switched off.

Outer files require a separate VSP system and inner-terrain exclusion. Both mesh
render distances are zero; billboard atlases use the prepared material tints.
Native TerrainInstances/GameObjects remain available for inner planting only when
billboard-only mode is off. Check terrain compatibility before using native trees.

### Tree editor (manual fixes in the Scene view)

`GolfMapTreeEditor.cs` (+ `GolfMapTreeEdits.cs`) adds a **Tree editor** section to the
planter window for PersistentStorage mode. With the trees file, terrain, biome and the
planted storage selected, **Start editing planted trees** indexes every planted stem and
takes over the Scene view:

- click a tree to select it (shift-click adds, Esc clears); nearby stems show as faint discs
- drag the position handle to move (snaps to the ground meshes/terrain on release), the red
  disc to rotate, the cube above the crown to resize height and crown radius together
- the window shows height, crown radius, rotation, species and asset for a single selection;
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

## Not built yet

- Historical note for the original tools: no Unity or C# compiler was installed on the dev
  machine. First run inside the OPCD project will show any API mismatch for its Unity
  version. Written for C# 6 so it compiles on the Unity 2018.2 base project; newer APIs
  (terrain layers, prefab roots, render pipeline, package listing) are behind version
  defines with 2018.2 fallbacks.
