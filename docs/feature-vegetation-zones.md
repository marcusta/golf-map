# Plan: vegetation zones for lower vegetation in VSPro

**Status:** accepted 2026-09-16, implementation started the same day (waves 1 to 3)
**Date:** 2026-09-16, revised 2026-09-16 after review
**Scope:** `web` (a vegetation-zone area feature), `pipeline` (zone rasterizer, lidar shrub
proposals and `unity-zones-v1` export), `unity/Editor/GolfMap` (mask import, read-only overlay,
verification). Trees stay on `unity-trees-v1` and are out of scope.

## 1. Purpose

Bushes, ferns, tall grass and similar lower vegetation are placed in the GSPro/OPCD course
by Vegetation Studio Pro (VSPro) from rules, not from lidar stems. The rules live in a
VSPro vegetation package, and Arborist edits those packages as `.biome` files. What VSPro
lacks is a fast way to say where each rule set applies. Its own tools define areas as 3D
polygons in the Unity scene, which is slow to author and hard to keep in sync with the
2D course map.

This plan moves area authoring to the golf-map editor. A zone is a polygon with a zone
type. The pipeline turns the zones into VSPro texture masks. VSPro places the plants.
Fine tuning with 3D context happens later in Unity, but as a sidecar delta file overlaid on the
export, the same way manual tree edits work. golf-map stays the only editor of the features.

Biome definitions (which prefabs, spacing, scale, shader settings) stay in VSPro or
Arborist. golf-map never edits them.

## 2. What an Arborist biome is

`Birch Forest.biome` (2.0 MB, JSON) is a VSPro `VegetationPackagePro` serialized field for
field. Findings that matter for this plan:

- Top level: `PackageName`, `BiomeType` (an OPCD enum value such as
  `OPCD_TemperateDeciduousForest`), `BiomeSortOrder`, an empty `TextureMaskGroupList`,
  and a `VegetationInfoList` of `VegetationItemInfoPro` records.
- Each item carries the VSPro rule set: `SampleDistance` (grid spacing in metres, 7 to
  10 m for trees and 0.4 m for grass), `Density`, min and max scale, height and steepness
  rules, Perlin density noise, biome-edge rules, and texture mask include, exclude, scale
  and density rule lists (all empty in this file).
- Prefabs are referenced by asset path in `Address`. `PrefabGUID` is empty. Several names
  end in a space.
- `BillboardTexture` and `BillboardNormalTexture` hold the 1024 by 128 billboard atlas as
  `base64(uint32 length ‖ gzip(base64(PNG)))`.

A package is inert until something in the scene says where it applies.
Arborist does that with `BiomeMaskArea` polygons carrying the same `BiomeType`. This plan
replaces that step for lower vegetation.

## 3. Decisions

**D-VZ1. Texture masks, not biome mask areas, carry the drawn zones.** VSPro selects one
biome per point. Its blend distance lowers the winning biome's spawn probability inside the
band and never lets the losing biome spawn there, so every biome transition is a density
hole with terrain material showing through. Overlapping mask areas are exclusive by sort
order. No parameter changes this, because the exclusivity is in biome selection, not in the
item rules. Texture masks are sampled per item, additively, so two zones can both be
present at one point.

**D-VZ2. One package holds all lower vegetation and is the default biome.** Every zone's
items live in the same package, which covers the whole terrain. Each item has a texture
mask density rule against its zone channel and an include rule with a low threshold so it
spawns nowhere its channel is zero. An item that belongs to two zones has two rules. There
are no `BiomeMaskArea` objects for this layer.

**D-VZ3. The pipeline rasterizes zones into weights, not booleans.** A transition between
two zones is a crossfade of their density channels with a constant total. The rasterizer
decides overlap resolution, feather width and edge noise, so golf-map controls them.
VSPro only sees finished weights.

**D-VZ4. Polygons are the source of truth and rasters are derived.** The raster is regenerated
on every export and never edited by hand. Unity never writes features back. A later Unity zone
editor records its changes as a delta in `<course>-<terrain>-zone-edits.json` next to the export,
keyed by zone id, and the importer overlays that file before rasterizing in Unity or reports it
so the pipeline can. This mirrors `<course>-<terrain>-tree-edits.json`: no round trip, no
conflict rules, and nothing in the first iteration depends on it beyond stable ids.

**D-VZ5. Biome mask areas keep one job.** Switching whole packages where the two sides share
no items and a hard edge is acceptable, for example forest floor against open ground. That
is a later, separate export and not part of this plan.

**D-VZ6. Runtime spawn stays on.** Lower vegetation is never baked into persistent
vegetation storage, otherwise a zone edit needs a rebake. Trees remain baked from
`unity-trees-v1`.

**D-VZ7. Lidar proposes shrub zones, people accept them.** The canopy step already produces a
normalised surface model and tree polygons. Cells between `--min-height` (default 0.5 m) and
`--max-height` (default 3 m) that lie outside the tree polygons are cleaned and polygonised the
way `trees-features` does and imported as generated features with source `lidar-lowveg` and
zone type `shrub`. They are ordinary zones afterwards: editable, deletable, re-importable by
source. Nothing is placed from lidar directly.

**D-VZ8. Per terrain, like trees.** Vreta has a 2050 m inner and a 5000 m outer terrain with
separate VSPro systems. The rasterizer and the export run once per terrain square, with the
outer excluding the inner square, exactly as `trees` does. Masks are bound to that terrain's
package.

**D-VZ9. The importer wires the rules.** The export carries an item binding table
(vegetation item name in the package, zone type, density range). The importer creates or
updates the texture mask density and include rules for those items and reports items the
package lacks, items with no binding, and channels no item uses. Everything else about an
item (prefab, spacing, scale, shader) stays as authored in VSPro or Arborist. The binding
table is edited in the web zone-type panel, so the mapping lives with the course, not in
the Unity scene.

## 4. VSPro mechanics used

- A texture mask group binds one texture channel over a world rectangle. A texture
  provides four channels, so four zone types per texture. A group can hold several
  textures with their own rectangles, which allows tiling a plot when one texture is too
  coarse.
- Item rules reference a group. The density rule scales spawn probability by the sampled
  value between a min and a max density. The include rule spawns only above a threshold.
  The scale rule shrinks or grows instances by the sampled value and is available for
  edge tapering when wanted.
- VSPro samples the mask bilinearly at spawn time, on a worker thread, once per cell, and
  caches the result until it clears the cell. Cost is one texture read per rule per candidate sample point. A polygon
  mask costs a point-in-polygon test per overlapping polygon and scales with node count.
- Render cost does not depend on the mask type. It depends on instance counts, set by each
  item's `SampleDistance` and `Density`.

## 5. Data model in golf-map

A new area feature, `vegetation_zone`, in the feature stack. Fields:

| field | meaning |
|---|---|
| `id` | stable id, carried through export and back from Unity |
| `zoneType` | string key into the site's zone-type table |
| `weight` | zone strength inside the polygon, 0 to 1, default 1 |
| `feather` | crossfade width in metres at the edge, default 2 |
| `noise` | edge noise amplitude in metres, default 0 |

The course holds a zone-type table: `key`, display name, colour for the editor, the
VSPro binding (texture index and channel) and the item bindings from D-VZ9. The table
alone assigns zone types to channels. Adding a fifth type adds a second texture.

Landed in wave 1 as: the four per-feature fields in the existing
`course_features.attributes_json`, and the zone-type table as
`course_zone_types` (migration 019), whose four defaults the server seeds on a
course's first list of the table.

The feature draws with the existing polygon tools, SAM outlines and Bezier editing, and
takes part in document-order layering like other areas, which is also how overlapping zones
of different types are resolved: the later feature wins the overlap (there is no separate
priority field). It has no gameplay meaning. Strategy and clearance ignore it. `weight`,
`feather` and `noise` are per-feature properties edited in the selection panel; `zoneType`
is chosen from the course's table.

## 6. Rasterizer

Runs in `gspro.py zones`, once per terrain, with the same square and sidecar checks as
`trees` (`_square_3006_extent`, the heightmap sidecar's `square3006`). Output resolution
is a parameter, default 4096, giving 0.5 m per pixel on the 2050 m inner square. It reuses
the tint step's ring flattening (`_ring_px`, bezier and B-spline) and paints in the same
north-up pixel frame as the terrain texture.

Per zone polygon, in document order:

1. Fill the polygon (even-odd for multi-ring) into a boolean raster.
2. Signed distance from a Euclidean distance transform of the filled raster and its
   complement, negative inside. This is a filled raster plus two `distance_transform_edt`
   calls, not a per-pixel per-polygon loop.
3. If `noise` is set, perturb the distance by a value-noise field scaled to `noise` metres.
4. Map through the feather: `w = clamp(0.5 - d / feather, 0, 1)` times `weight`.

Per pixel, across zones of the same type: take the maximum. Across zone types in document
order: a later zone's weight claims its share first and earlier types keep only what is
left, so the channels never sum to more than one. There is no scaling up: a lone zone at
weight 0.3 stays 0.3, and a feather ramp stays a ramp. Where nothing is drawn every
channel is zero.

The result is one RGBA PNG per four zone types, 8 bits per channel, written next to the
`.raw` heightmap, plus the `unity-zones-v1` JSON. The alphamap idea from the first draft is
dropped: the terrain importer sets a single splat prototype carrying the ortho, so there
are no rough or understory splat layers to drive.

## 7. Export formats

`unity-zones-v1`, plain JSON that `JsonUtility` parses (no dictionaries, arrays of
records only):

```json
{
  "format": "unity-zones-v1",
  "plot": { "crs": "EPSG:3006", "terrain": "inner", "originX": 651200.0, "originY": 6403500.0,
            "sizeM": 2050, "minM": 12.3, "maxM": 71.8 },
  "masks": [
    { "file": "vreta-inner-zones-0.png", "resolution": 4096,
      "channels": [ "rough_tall", "shrub", "fern", "meadow" ] }
  ],
  "zoneTypes": [
    { "key": "shrub", "name": "Shrubs", "color": "#6b8f3a", "texture": 0, "channel": 1,
      "items": [ { "item": "Hazel bush", "minDensity": 0.0, "maxDensity": 1.0 } ] }
  ],
  "zones": [
    { "id": "…", "zoneType": "shrub", "weight": 1.0, "feather": 2.0, "noise": 0.0,
      "rings": [ { "nodes": [ { "x": 412.3, "z": 880.0 } ] } ] }
  ]
}
```

`nodes` are plot-local metres, x east and z north, the same convention as
`unity-trees-v1`, flattened to straight segments and simplified to 1 m. They are included
so Unity can draw the polygons in the Scene view, not for spawning. `plot` matches the
trees export field for field so the importer's terrain match by bounds is shared.

## 8. Unity side

`GolfMap > Vegetation Zones`, in `unity/Editor/GolfMap`:

- Import: loads the PNGs as readable RGBA32 textures (VSPro samples masks on the CPU, and
  `GetPixelBilinear` on compressed formats in Unity 2018.2 is not something to rely on;
  try BC7 only if bundle size forces it and verify sampling first), creates or updates one
  texture mask group per channel in the terrain's package, and sets each group's rectangle
  from the plot. Groups are matched by zone-type key stored in the group name, so re-import
  updates in place.
- Rules: applies the `zoneTypes[].items` bindings (D-VZ9) as texture mask density and
  include rules on the named items, updating in place when the rule already points at the
  group. Writes a report next to the tree import report listing unmatched items, unbound
  items and unused channels.
- Overlay: draws one polygon per zone in the Scene view with Handles, coloured by zone type,
  from the export's `rings`. Read-only in this iteration; it exists to check alignment against
  the terrain and the trees. The later zone editor (D-VZ4) builds on it.
- Preview: after import, calls VSPro's clear-cache so the changed masks respawn.

## 9. Limits and numbers

- 4096 square over 1500 m is 0.37 m per pixel. A 2 m feather spans about 5 pixels. Below
  1 m features, tile with 2048 textures per group.
- A 4096 RGBA texture is 64 MB uncompressed in the bundle. Try BC7 first and fall back to
  uncompressed only if the ramps band visibly.
- Simplify polygons to 1 m tolerance on export. Node counts do not affect spawn cost with
  texture masks, but they affect the Unity overlay and the round-trip file size.
- Four rules per item is still cheaper at spawn than one polygon test.

## 10. Open questions

- Whether GSPro's VSPro build respawns from runtime rules at load or expects persistent
  storage for everything. If the latter, D-VZ6 needs a bake step in the Unity importer.
  Settled by the wave 0 spike below before anything depends on it.
- Whether readable RGBA32 masks at 4096 are acceptable in the course bundle (64 MB each)
  or 2048 must do. Also part of wave 0.
- How Arborist reads a package with populated `TextureMaskGroupList`, if a package edited
  by this tool is later opened in Arborist.

Answered: the OPCD terrain in this project has no splat layers for rough. The terrain
importer sets a single splat prototype carrying the ortho (`GolfMapTerrainImporter.cs`),
so the alphamap step is dropped.

## 11. Waves

0. Spike, by hand in the OPCD project: one grass item and one bush item, one hand-painted
   RGBA mask as a texture mask group with density and include rules, build, load in GSPro.
   Settles runtime spawn, readable texture size and D-VZ1 in one go. Does not block waves
   1 and 2, which are pure golf-map work.
1. Editor: `vegetation_zone` feature with the fields in section 5 and a course zone-type
   table with item bindings. Rendering in the editor as a tinted area.
2. Pipeline: `gspro.py zones` (rasterizer and `unity-zones-v1` writer, per terrain) and
   `golfpipe lowveg-features` (D-VZ7 shrub proposals). Validation renders under
   `docs/validation/vegetation-zones/`.
3. Unity: import, rule wiring, read-only overlay, report. Verified in the OPCD project
   against a package with one bush item and one tall grass item.
4. Later: Unity zone editor writing `<course>-<terrain>-zone-edits.json` (D-VZ4).
