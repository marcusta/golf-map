# Plan: vegetation zones for lower vegetation in VSPro

**Status:** proposed 2026-09-16, nothing built
**Date:** 2026-09-16
**Scope:** `web` (a vegetation-zone area feature), `pipeline` (zone rasterizer and
`unity-zones-v1` export), `unity/Editor/GolfMap` (mask import, polygon round trip).
Trees stay on `unity-trees-v1` and are out of scope.

## 1. Purpose

Bushes, ferns, tall grass and similar lower vegetation are placed in the GSPro/OPCD course
by Vegetation Studio Pro (VSPro) from rules, not from lidar stems. The rules live in a
VSPro vegetation package, and Arborist edits those packages as `.biome` files. What VSPro
lacks is a fast way to say where each rule set applies. Its own tools define areas as 3D
polygons in the Unity scene, which is slow to author and hard to keep in sync with the
2D course map.

This plan moves area authoring to the golf-map editor. A zone is a polygon with a zone
type. The pipeline turns the zones into VSPro texture masks. VSPro places the plants.
Edits made later in Unity flow back to golf-map as polygons, so both sides stay editable.

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

**D-VZ4. Polygons are the source of truth and rasters are derived.** Unity edits go back to
golf-map as polygons. The raster is regenerated on every export and never edited by hand.

**D-VZ5. Biome mask areas keep one job.** Switching whole packages where the two sides share
no items and a hard edge is acceptable, for example forest floor against open ground. That
is a later, separate export and not part of this plan.

**D-VZ6. Runtime spawn stays on.** Lower vegetation is never baked into persistent
vegetation storage, otherwise a zone edit needs a rebake. Trees remain baked from
`unity-trees-v1`.

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
| `priority` | integer used when overlapping zones are resolved by priority |

The site holds a zone-type table: `key`, display name, colour for the editor, and the
VSPro binding (texture index and channel). The table alone assigns zone types to
channels. Adding a fifth type adds a second texture.

The feature draws with the existing polygon tools, SAM outlines and Bezier editing, and
takes part in document-order layering like other areas. It has no gameplay meaning. Strategy
and clearance ignore it.

## 6. Rasterizer

Runs in the pipeline as `rasterize-zones` with the same plot definition as the heightmap
export (`plot.originX/Y`, `sizeM`, EPSG:3006). Output resolution is a parameter,
default 4096, giving 0.37 m per pixel on a 1500 m plot.

Per pixel, per zone polygon:

1. Signed distance to the polygon edge, negative inside.
2. If `noise` is set, perturb the distance by a Perlin field scaled to `noise` metres.
3. Map through the feather: `w = clamp(0.5 - d / feather, 0, 1)` times `weight`.

Per pixel, across zones of the same type: take the maximum. Across zone types: normalize
so the channels sum to at most one, and to exactly one where at least one zone is present.
When two types overlap at full weight, `priority` decides the ratio. The higher priority
keeps its weight and the lower fills the remainder. Equal priorities split evenly.

The result is one RGBA PNG per four zone types, 8 bits per channel, written next to the
`.raw` heightmap. A sidecar JSON records the plot, resolution, and the channel table so
Unity can build the mask groups without guessing.

The same weights can later write the terrain alphamap for rough and understory splat
layers, so the ground texture crossfades on the same curve as the plants. That is a
separate exporter step, not in the first wave.

## 7. Export formats

`unity-zones-v1`, plain JSON that `JsonUtility` parses:

```json
{
  "format": "unity-zones-v1",
  "plot": { "crs": "EPSG:3006", "originX": 651200.0, "originY": 6403500.0, "sizeM": 1500 },
  "masks": [
    { "file": "zones-0.png", "resolution": 4096,
      "channels": [ "rough_tall", "shrub", "fern", "meadow" ] }
  ],
  "zones": [
    { "id": "…", "zoneType": "shrub", "weight": 1.0, "feather": 2.0, "noise": 0.0,
      "priority": 0, "nodes": [ { "x": 412.3, "z": 880.0 } ] }
  ]
}
```

`nodes` are plot-local metres, x east and z north, the same convention as
`unity-trees-v1`. They are included so Unity can show and edit the polygons, not for
spawning.

## 8. Unity side

`GolfMap > Vegetation Zones`, in `unity/Editor/GolfMap`:

- Import: loads the PNGs as uncompressed or BC7 textures, creates or updates one texture
  mask group per channel in the target package, and sets each group's rectangle from the
  plot. Groups are matched by zone-type key stored in the group name, so re-import updates
  in place. The importer does not touch item rules. Those stay as authored in VSPro or Arborist.
- Polygon overlay: creates one editable polygon object per zone under a `GolfMapZones`
  parent, named by `id`, with a component holding the zone fields. These objects have no
  effect on VSPro. They exist so the user can edit a zone in the 3D view.
- Export: writes the polygons back as `unity-zones-v1` with ids intact. golf-map imports it
  and updates the matching features. When a zone is missing from the Unity export, golf-map reports it and keeps the feature.
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

- Whether the OPCD terrain uses splat layers for rough, which decides if the alphamap
  step in section 6 is worth building.
- Whether GSPro's VSPro build respawns from runtime rules at load or expects persistent
  storage for everything. If the latter, D-VZ6 needs a bake step in the Unity importer.
- How Arborist reads a package with populated `TextureMaskGroupList`, if a package edited
  by this tool is later opened in Arborist.

## 11. Waves

1. Editor: `vegetation_zone` feature with the fields in section 5 and a site zone-type
   table. Rendering in the editor as a tinted area.
2. Pipeline: `rasterize-zones` and the `unity-zones-v1` writer, sharing the plot with the
   `.raw` heightmap export. Validation renders under `docs/validation/vegetation-zones/`.
3. Unity: import, overlay, export. Verified in the OPCD project against a package with one
   bush item and one tall grass item.
4. Round trip: golf-map import of `unity-zones-v1`.
5. Optional: alphamap export from the same weights.
