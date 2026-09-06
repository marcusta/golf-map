# unity

Unity editor scripts for getting golf-map output into an OPCD/GSPro course project.
Nothing here runs in the golf-map build. Copy `Editor/GolfMap/` into the OPCD base
project under `Assets/Editor/GolfMap/` (any folder named `Editor` works). Two menu
items appear under `GolfMap`.

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

`GolfMap > Tree Planter` reads a `unity-trees-v1` file and plants prefabs on a Terrain.

1. Pick the trees file and the terrain.
2. Assign prefab lists per crown kind: broadleaf, conifer, unknown, bush. Unknown falls
   back to broadleaf, bush falls back to the kind list.
3. Load and check. The window reports how many trees fall inside the terrain and compares
   each tree's exported ground elevation with the terrain height at that point. A mean
   mismatch above the tolerance means the terrain and the trees file were cut from
   different plots, or the heightmap was imported without Flip Vertically. Planting is
   refused until the mismatch is fixed or overridden.
4. Plant. Two modes:
   - Terrain instances: `TreeInstance` entries on the terrain. Batched, LOD, billboards.
     Prefabs must be terrain-tree compatible.
   - GameObjects: one prefab instance per tree under a `GolfMapTrees` parent, snapped to
     the terrain height.

Each tree's height scale is `h / prefabHeight` and width scale is `2r / prefabWidth`,
both clamped to the min and max scale settings. Prefab size comes from its renderer
bounds, measured once per prefab. Prefab choice and rotation come from a seeded random
generator, so re-planting after a pipeline rerun keeps unchanged trees the same. Both
modes support Undo.

## Trees file format: unity-trees-v1

Produced by the pipeline from `tree-stems.json` (not yet written, see below). Plain JSON
that `JsonUtility` can parse: objects and lists, no nested arrays.

```json
{
  "format": "unity-trees-v1",
  "plot": {
    "crs": "EPSG:3006",
    "originX": 651200.0,
    "originY": 6403500.0,
    "sizeM": 1500,
    "minM": 12.4,
    "maxM": 71.9
  },
  "trees": [
    { "x": 412.31, "z": 880.02, "h": 14.2, "r": 4.1, "g": 34.85, "k": 1, "bush": false }
  ]
}
```

| field | meaning |
|---|---|
| `plot.originX/Y` | EPSG:3006 south-west corner of the square plot the heightmap was cut from |
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

## Not built yet

- Pipeline command that writes `unity-trees-v1` from `tree-stems.json` plus a plot
  definition. It belongs with the `.raw` heightmap exporter so both use one plot
  (docs/delegation-briefs-terrain-edit.md, "Future wave: Unity .raw exporter").
- Nothing here has been compiled: no Unity or C# compiler is installed on the dev
  machine. First run inside the OPCD project will show any API mismatch for its Unity
  version. Targets Unity 2020.3 or later; package listing needs 2021.1 or later and falls
  back to dumping `Packages/manifest.json`.
