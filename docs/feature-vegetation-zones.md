# Plan: vegetation zones for lower vegetation in VSPro

**Status:** accepted 2026-09-16, implementation started the same day (waves 1 to 3)
**Date:** 2026-09-16, revised 2026-09-16 after review
**Scope:** `web` (a vegetation-zone area feature), `pipeline` (zone rasterizer, lidar shrub
proposals and `unity-zones` export, v2 since D-VZ11), `unity/Editor/GolfMap` (mask import, read-only overlay,
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
no items and a hard edge is acceptable. That is a later, separate export and not part of this
plan.
Revised 2026-09-23: forest floor against open ground was the example here and is no longer one.
It is a zone type in the one package (D-VZ10), because a biome edge is a density hole (D-VZ1)
and the woodland edge is exactly where the understory should thin out, not stop.

**D-VZ6. Runtime spawn stays on.** Lower vegetation is never baked into persistent
vegetation storage, otherwise a zone edit needs a rebake. Trees remain baked from
`unity-trees-v1`.

**D-VZ7. Lidar proposes shrub zones, people accept them.** The canopy step already produces a
normalised surface model and tree polygons. Cells between `--min-height` (default 0.5 m) and
`--max-height` (default 3 m) that lie outside the tree polygons are cleaned and polygonised the
way `trees-features` does and imported as generated features with source `lidar-lowveg` and
zone type `shrub`. They are ordinary zones afterwards: editable, deletable, re-importable by
source. Nothing is placed from lidar directly.
Revised 2026-09-22: from `--lidar` the proposal counts returns 0.5 to 3 m above the ground grid
per cell (at least 3 over the 3x3 cells around it) instead of reading the canopy grid, which keeps
one return per cell and drops everything under 1 m. Trees still come from the canopy grid, and
nothing is proposed within 10 m of a detected roof, because garden objects read as shrubs. On
Vreta's inner square this gave 64 proposals against 110 from the grid, with the housing areas
cleared and the hedges kept.

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

**D-VZ10. Lidar proposes woodland floor, and the texture follows it.** Under a closed stand
the ground is needle litter, moss, blueberry and fern, not meadow. `woodland-features` turns
the cleaned canopy grid into one polygon per stand: cells of 3 m and up, closed by 5 m so
crowns up to about 10 m apart join, nothing within 5 m of a roof, stands under 0.25 ha or
under 50 % canopy cover dropped, grown 2 m past the outer crowns. They are imported as zones
of type `woodland_floor` with source `lidar-woodland`, like the shrub proposals (D-VZ7). The
weight comes from the understory: the share of cells with a return 0.5 to 3 m above ground,
1 at a fifth of the cells, never under 0.3, so a sparse spruce floor spawns fewer ferns than
a birch stand full of scrub (Vreta's leaf-off scan: 1 to 13 % across 14 stands, 204 ha). The
same polygons drive the terrain texture: with an ortho, each stand gets `floorColor`, the
median of the warm, mid-bright pixels inside it. On Vreta the lidar gaps showed leaning crowns
in the newer, non-true ortho, so the pixels that count are the ground the photo does show:
tracks, clearings, windthrow. `clean-ortho --woodland` repaints the stand with world-anchored
noise in the palette floor colour mixed half and half with that sample (`--floor-mix`),
outside the playable corridor and outside `--keep` polygons (roads).
Revised 2026-09-23: in the app, "Regenerate trees" makes the stands (the `canopy` step's
`--woodland-out`, imported as generated `lidar-woodland` zones), and the GSPro board
paints the floor during the orthophoto export (`gspro.py ortho --floor-course`, keeping the
drawn playable surfaces, bunkers, paths and water) and exports the zone masks for Unity.
`clean-ortho --woodland` stays for GeoTIFF work outside the app. Buildings are painted
over, since Unity puts a prefab on the pad. The tree palette's own woodland flag
(`woodlandRadiusM` / `woodlandMinNeighbours`, per stem) is a separate test on the stems and
is not derived from these polygons.

**D-VZ11. Zones pick a variant, and the masks carry one channel per item.** Added 2026-09-24.
A zone type can hold named variants (Tall rough: Lush, Dry straw), each with its own item
bindings, next to the type's own bindings, which are the Default variant. A drawn zone picks its
type and, optionally, a variant (`zoneVariant`). The first plan gave each variant a mask channel
and bound the variant's items to it. VSPro rules that out: an item's texture mask density rules
multiply (`VegetationCellSpawner.cs` runs every rule, and `TextureMask.cs` does
`SpawnChance *= value / 256 * DensityMultiplier`), while include rules OR. An item bound to two
channels, which variants sharing an item always are, then spawns only where both channels are
non-zero. This also broke the "an item that belongs to two zones has two rules" line in D-VZ2.
So the rasterizer resolves the stack per slot (a type's Default, or one of its variants) exactly
as in section 6, then sums each item's density over the slots that bind it
(`weight × maxDensity`, clipped to 1). It writes one channel per item. Unity gives each item
one density rule (multiplier 1, since the density is baked into the pixels) and one include rule
against its own channel. The zone type's texture and channel no longer matter, and channels are
allocated per item on every export (`unity-zones-v2`).

**D-VZ12. Zones add up: Mix and extra palettes.** Added 2026-09-27. Two cases the stack could
not say: a pond with its own palette and reeds or lily pads growing in parts of it, and tall
grass with rocks scattered through it. In both, the lower palette must keep growing where the
upper one is. With D-VZ3's budget the later zone took its weight from the one below, so the
reeds pushed the pond palette out.
A zone now has `blend`: `replace` (absent, the old rule) or `mix`. A mix zone raises its own slot
exactly as before but takes nothing from the budget, so the zones below keep their share and both
slots are non-zero there. Their items then sum per item as in D-VZ11 (an item in both mixes gets
both densities, clipped to 1). A replace zone above a mix zone still cuts it, so the stack order
keeps its meaning. Replace stays the default because the generators rely on it: the creek-bank
zones sit on top of the tall rough and claim the bank, and the rough fills in where they fade.
A zone can also plant several palettes on one footprint: `extraPalettes` lists more slots with a
weight factor each, and they rasterize as mix layers on the zone's own weight raster
(`weight × feather ramp × factor`), before the zone's primary palette takes its share. That is
the same as drawing the same polygon again as a mix zone, without the copy to keep in sync.
Feature attributes are flat scalars (server), so `extraPalettes` is one string,
`"shrub/rocks=0.4, fern"`: comma-separated `<type>[/<variant>][=<weight 0..1>]`, the pipeline's
slot notation (`shared/features/zone-layers.ts`, mirrored in `gspro.py`).
Hand-drawn `creek_bank` zones are still creek sections (they pick a creek's bank palette and are
not rasterized), whatever their blend; their extra palettes are ignored with them.

**D-VZ13. Update selected zones without planting everything.** Added 2026-09-27. Planting runs
the generators, rasterizes every zone into all the 4096 masks, and has Unity reimport all of them
and respawn the whole terrain. For an edit to a few drawn zones only their area needs any of that.
"Update N zones" (until 2026-10-14 "Update for GSPro") on the selected zones re-rasterizes the window they cover, now and in the last
export (the rows of the zones JSON, so a moved zone's old spot clears), plus zones that export has
and the course no longer has. The window is exact: each zone's weight still comes from its own
crop, clipped only to the window plus its `feather / 2 + noise`, beyond which a pixel's weight does
not depend on the edge. The stack is resolved per pixel, so the patched masks equal a full export
(tested pixel for pixel, also on Vreta). Unity reimports only the textures that changed and clears
VSP's cache only in the window. On Vreta a 68 m zone took 2.4 s in the pipeline and 3.5 s for the
whole job with nothing to change, against minutes for a planting. The channel layout cannot move
in a patch: when the zone types' item bindings changed since a terrain's export, that terrain is
skipped (the outer, which planting does not refresh, often is), and when every terrain is, the
job asks for Update vegetation. Unity must be open first, so the export and the scene cannot drift
apart silently. Since 2026-10-13 the job then writes the Arborist file's lower vegetation again
(`arborist.py lower`, about 10 s on Vreta), since that file carries the inner masks themselves.
Revised 2026-09-27: a hand-drawn creek_bank zone is a creek section only within a creek's or
water's bank reach + 10 m of it (`gspro.creek_section_ids`, the creek-bank generator's own
`near_sections` reach); farther away it plants its palette like any zone. A section plants
nothing itself: the creek-bank generator does, from its palette. So when the selection holds a
hand-drawn creek_bank zone, the update runs that generator first (only it, the last in the
stack, about 4 s on Vreta). A generator replaces its zones under new ids, so the patch matches
zones the export has not seen against vanished rows by content: an identical one is the same
zone renamed and patches nothing, the rest (and any zone drawn since the export, selected or
not) are patched in. On Vreta, switching a pond's section to Lush patched 111 zones (529
renamed) in 35 s, with Unity respawning 748 x 133 m in 2.2 s.

**D-VZ14. Drawn zones sit over generated ones and add up with each other; a hole is a folder.**
Added 2026-09-27. Two things made filing zones under holes go wrong. The export stacks by group
(holes 1, 2, ... then course level on top), so a zone moved into a hole dropped under every
course-level zone, and the generated ones (tall rough, creek banks, lidar) are all course level.
And each planting re-inserts the generated zones at the top of the course-level stack, so they
already beat the drawn zones there. On Vreta the one drawn shrub thicket lost about 3,100 m² to
them. The hole field also sat next to the stack panel's scope filter, two lookalike "Course level
(top)" selects, and picking Course level in the wrong one moved the zone back (the edit history
showed each move to hole 15 undone that way within seconds).
The rule now is: drawn zones first, in any order. Each paints its palettes at its weight, and the
same palette twice takes the maximum. Where they overlap, all of them grow. A drawn zone's `blend`
says what it does to the generated vegetation under it: `replace` takes its weight of that ground
(two overlapping drawn replace zones take the larger weight, not the sum), and `mix` ("Add to it")
grows on top of it. The generated zones then share what is left with the section 6 budget in their
own stack order, so creek banks still claim over tall rough. Order among drawn zones, and their
hole, change nothing, so a zone's hole is only where it is filed. The web says so: the selection
panel calls it "Hole (folder)", the Vegetation stack panel defaults to "All zones, by hole" with a
heading per hole and each zone named by what it plants ("Creek bank · Vass (common reed) + 1 ·
adds"), and zones get no raise/lower verbs.

**D-VZ15. The woodland floor is generated per floor type from the trees and the terrain.** Added
2026-10-10. The lidar stands of D-VZ10 say where a wood is, and stay as they are: they paint the
floor texture. They never planted anything, because `woodland_floor` had no items and the tall
rough sits above them in the stack. So under the trees there was tall rough near play and bare
ground beyond it.
A third generator, `pipeline/woodland_floor_zones.py` (source `woodland-floor`), now writes the
planting. It runs between the tall rough and the creek banks, so the floor takes the ground from
the tall rough under the trees and a creek bank takes it from the floor. Where the floor is comes
from the planted trees (canopy closure from their crowns), not from the stand polygons: a stand of
123 ha is one polygon, and a clearing in it should keep the tall rough.
What grows is one of four variants per point, chosen from the conifer share of the trees around it
and from the terrain (`pipeline/terrain_fields.py`: knoll or hollow, wetness, slope): `heath`,
`bilberry`, `herb`, `fern`. They follow the ground-vegetation types Swedish forestry sorts stands
by. Each patch holds pockets of the other three, since one floor per area read as too uniform.
Two more are mix zones (D-VZ12): `edge`, the brush along a stand's rim, and `brush`, saplings and
low bushes in drifts inside closed forest. Nothing is planted further than 50 m from play.
The terrain was tried first as a driver of the open tall rough and dropped there: on Vreta's 20 ha
of open deep rough, wetness and terrain position rank-correlate only about 0.1 with greenness in
the orthophoto. Under the trees it separates cleanly: 84 % of the hand-drawn rock slabs sit on
knolls (34 % of the deep rough does), and canopy cover falls from 64 % in the driest fifth of the
ground to 21 % in the wettest.
Deadwood and stones are not in it: VSP in GSPro takes foliage shaders only (section 8).

**D-VZ16. A zone's mix blends into its neighbours; its coverage does not move.** Added 2026-10-11.
Patched fields (hand-drawn `rough_tall/<variant>` zones tiling a deep rough) met each other and
the generated tall rough along a line: they were drawn with a 0.5 m feather, because a feather is
centred on the edge and a wide one spills the grass onto the path or mown rough beside the field
and thins it inside. So the two jobs are split. `feather` still says how the zone ends against
nothing. `edgeBlend` (metres) says how wide its mix fades into whatever grows next to it.
After the stack is resolved, the slots are diffused around the edge of every zone that has an
edge blend (`render_zone_masks`, `_blend_zone_tile`): each slot is blurred with a Gaussian of
`edgeBlend / 4`, and every pixel's slots are scaled back to the sum they had. So only the mix
changes. A mix reaches only where something grew already: two tiled patches cross-fade with a
constant total, a patch and the generated fill beside it grade into each other, and beside bare
ground nothing changes. Each slot's blurred weight is also multiplied by `exp(1.2 x its own value
noise)`, so the line where two mixes are even wanders by a few metres instead of following the
drawn edge. The blend works within `1.5 x edgeBlend` of the zone's edge, in 1024 px tiles, only
where such a zone reaches.
Absent, `edgeBlend` is 8 m for a drawn zone that replaces and 0 for generated and mix zones. A
drawn replace zone set to 0 keeps its border as drawn, also against a neighbour that blends (it
closes the band within 12 m of its edge). Set it in the selection panel ("Blend into neighbours",
empty = default) or `bun run zones -- set <course> <zone> --edge-blend <m|default>`. The zone rows
carry `edgeBlend`; Unity ignores it.
The first version rendered the stack a second time with the blend as each zone's feather and
scaled it to the plain stack's sum, 4 m wide. Two things were wrong with it: a linear 4 m ramp
along a smooth outline still read as a line, and inside a field's rim against mown rough the
generated tall rough under the patch came back in (the patch gave up half its weight at its own
edge, and the fill under it took it). On Vreta's inner square 63 zones blend and the export
takes about 2 minutes (78 s before the blur).

**D-VZ17. A zone sets how tall its bushes grow.** Added 2026-10-11. A hedge that screens a green
is 2 to 3 m and closed; the same willows in a thicket by a ditch are knee to head high with
openings. Sizes were per item (`minScale`/`maxScale` times a noise scale), so a height meant a
palette per height, in scale factors nobody can read as metres. A zone now has `heightMin` and
`heightMax` (metres, both or neither, at most 12; `shared/features/zone-height.ts`): "Bush height"
in the selection panel, `--height 2-3` in the zones CLI.
The export writes one more mask, `<stem>-height.png`, 8-bit grey at half the density masks'
resolution: 0 where no zone sets a height, else the height as `value / 256 x 12.8 m`
(`render_zone_heights`). Inside a zone the height is value noise between min and max, one value
every 3 m, skewed towards the min (power 2.2): most bushes stay low and the max shows as bumps a
few metres across. An even spread read as one level line along the hedge. Where two heights
overlap, the zone with the larger weight decides.
In Unity the height is VSP's texture mask scale rule (`Scale *= value / 256 x ScaleMultiplier`,
applied before the item's own random scale). A mask can only multiply and an item's own size
varies several times over, so the item cannot be held in a range. Each bush (prefab) item that a
zone with a height can plant gets a twin, `<item> @height`: a copy with min = max scale 1 and no
noise scale, on the item's own density mask, with `ScaleMultiplier = 12.8 / the prefab's height at
scale 1` (LOD0 mesh top plus the vertical offset, measured by the importer). The twin is excluded
where the height mask is 0 and the item where it is above 0, so one of the two grows at any point.
Texture grass keeps its size. The export's `height` block names the mask and the items of every
palette such a zone plants; when that list changes (the first height on a palette, the last one
gone) a patch stops and asks for Update vegetation, since Unity needs other items. After that,
changing a height or moving the zone is an "Update N zones".
Limits: one range for every species in the zone; a height changes size, not spacing, so a closed
screen still needs a dense palette (Vreta's `shrub/dense`); a prefab with no readable LOD0 mesh
keeps the palette's sizes (reported at import); the palette editor's live edits reach a twin at the
next Apply.

**D-VZ18. Update vegetation does only what changed.** Added 2026-10-15. One drawn zone on hole
10's pond switched from Tall rough to Creek bank · Lush took 3 min 22 s: the three generators
(35 + 41 + 9 s) always ran, since their output is database rows with no fingerprint, and any zone
change moved the zones stamp, so all 26 4096-px masks were rasterized again (82 s) and Unity
imported and applied them whole (16 + 17 s). Two changes, no new button:
- A generator runs only when something it reads changed (`VegetationGenerator.reads`,
  `GsproExportService.generatorFingerprint`, kept in `<course>-inner-vegetation-<source>.inputs.json`
  next to the export): its command, the surface map, the DEM sidecar and tif, the buildings and
  roads, the planted trees (woodland floor), the course's rules file (in the command), the feature
  types its script queries (paths; water and creeks for the tall rough and the creek banks), the
  hand-drawn creek_bank zones (creek sections; the tall rough lifts its water clearance there),
  the zone types it reads, its scripts' mtimes, and its own zones as they are now. A drawn zone of
  any other type invalidates none of them; the woodland floor reads no zones at all. A skipped
  generator's zones stay, lifted back above an earlier generator's new ones
  (`CourseFeaturesService.raiseGenerated`), so the stack is what a full run leaves.
- When Unity has the last inner export with the grass palette as it is now, the zone types are
  unchanged (by content: `updated_at` has whole seconds) and only some zones differ by content
  from what the masks were made of (`<zones>.json.index.json`, the zones' content digests in
  stack order), `gspro.py zones-patch` re-rasterizes those (D-VZ13's matching by content handles
  a generator's renamed zones) and `golfmap.zones.patch` respawns only that window. The full path
  stays for everything else, each with its reason in the report (`inner: no patch - ...`): no zone
  changed (then Unity imports and applies the unchanged export, which also carries palette edits),
  the zone types, the palette, the heightmap sidecar or the stack order changed, more than 200
  zones changed, no index yet (the first planting after this change), or the patch refused.
The report ends with where the time went (`Time: tall rough unchanged, ..., zones patch 5.0 s,
Unity patch 0.8 s, Arborist 14.6 s - 22.3 s in all`).
Measured on Vreta 2026-10-15, Unity open, nothing else running:
- one drawn Tall rough zone's weight changed: **22.3 s** (was 3 min 22 s for a zone edit). No
  generator ran; the patch re-rasterized a 29 x 37 m window (1 of 27 textures changed) in 5.0 s,
  Unity respawned it in 0.8 s, the Arborist file (lower vegetation + 64 854 trees out of the scene)
  took 14.6 s, now the largest step. Setting it back: 22.2 s.
- one creek section's weight changed (a hand-drawn creek_bank zone near water): **80.5 s**. The
  tall rough (34 s) and the creek banks (10 s) read sections and ran again, the woodland floor did
  not; the patch matched their 3211 renamed zones by content in 16 s, found no mask to change, and
  Unity took nothing in. Setting it back: 73.7 s.
- nothing changed: 37 s (every generator and the masks unchanged; Unity's import + apply 19.6 s, the
  Arborist file 14.9 s).

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
| `edgeBlend` | width in metres over which the mix fades into neighbouring vegetation (D-VZ16); absent = 8 for a drawn replace zone, else 0 |
| `heightMin`, `heightMax` | metres the zone's bushes are scaled to (D-VZ17); both or neither, absent = the palette's sizes |

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

Layers (D-VZ12): `blend` (`replace` | `mix`, absent = replace) and `extraPalettes` (a string,
see D-VZ12) are two more per-feature attributes, edited in the selection panel as Overlap and
"Also plants". The export's zone rows carry both (`extraPalettes` as
`[{zoneType, variant, weight}]`); Unity ignores them, since the masks already hold the result.

Variants (D-VZ11): `course_zone_types.variants_json` holds `[{key, name, items}]` per type
(migration 022). The type's own `items` are the Default mix. A zone's optional `zoneVariant`
attribute names a variant key, and absent or empty means Default. The selection panel shows a
Variant select when the chosen type has variants, and changing the type resets it. The
zone-type panel no longer shows texture and channel, because the export allocates channels per
item.

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

Revised 2026-09-24 (D-VZ11): "zone type" above reads "slot", meaning a type's Default or one
of its variants, so two variants of one type crossfade like two types.
Revised 2026-09-27 (D-VZ12): a mix zone takes nothing from the budget, so the slots can sum above
one where a mix zone overlaps others; a zone's extra palettes are mix layers on its own weight
raster, scaled by their factor, applied before its primary slot claims its share.
Revised 2026-09-27 (D-VZ14): the budget above is for the generated zones only. Drawn zones are
applied first and add up (maximum per slot); their replace weights, combined as a maximum, are
taken out of the budget the generated zones start with. The slot weights are
then projected onto items: `density(item) = min(1, Σ weight(slot) × maxDensity(item, slot))`
over the slots that bind the item. Every bound item gets a channel, even one with no coverage
on this terrain, so the Unity import always replaces its rules.

The result is one RGBA PNG per four items, 8 bits per channel, written next to the
`.raw` heightmap, plus the `unity-zones-v2` JSON. The alphamap idea from the first draft is
dropped: the terrain importer sets a single splat prototype carrying the ortho, so there
are no rough or understory splat layers to drive.

## 7. Export formats

The first version, `unity-zones-v1`, was plain JSON that `JsonUtility` parses (no dictionaries, arrays of
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

Superseded 2026-09-24 by `unity-zones-v2` (D-VZ11). The mask channels name items, not zone
types. A top-level `items` list gives each item's `texture`, `channel` and the `sources` (slot
keys `type` or `type/variant`) that bind it. Zone types lose `texture` and `channel` and gain
`variants: [{key, name, items}]`. Zones gain `variant` (`""` for Default). The Unity importer
accepts v2 only.

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
- Since v2 (D-VZ11), there is one group per item, named `golfmap-zone:item:<item>`. Every
  other `golfmap-zone:*` group (the v1 per-type groups, and items no longer exported) is
  deleted, and every rule that points at one is removed, so no leftover density rule can
  multiply an item away.

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

## 12. Implementation notes: server

Moved from server/AGENTS.md.


`vegetation_zone` is an ordinary area feature type (appended to `FEATURE_TYPES`
so the web's digit shortcuts keep their bindings; `TYPE_Z_ORDER` puts it above
`green` and below `trees`) with no gameplay meaning — `shared/strategy/lie.ts`
maps it to `rough` explicitly and `shared/render/resolved-surface-stack.ts`
passes it through unclipped, since it is an overlay, not a surface. Its
per-feature fields live in `attributes_json`: `zoneType` (required, the key
into the course's zone-type table), `zoneVariant` (optional string, a variant
key of that type; absent or `''` = the type's Default mix; like `zoneType` not
checked against the table), `weight` (0..1, default 1), `feather` (m,
default 2) and `noise` (m, default 0), plus `blend` (`replace` | `mix`,
default replace) and `extraPalettes` (a string of comma-separated
`<type>[/<variant>][=<weight>]`, since attributes are flat scalars;
`shared/features/zone-layers.ts`, D-VZ12). The numeric keys may be absent and then
mean their defaults; a zone with no `zoneType` (or a non-string `zoneVariant`,
another `blend`, an `extraPalettes` that does not parse)
is rejected on create, on an attributes update and in the generated-features
import (the lidar `lidar-lowveg` proposals, D-VZ7, arrive through that route
with the same property names).
Overlap between zone types is resolved by document order (`stackKey`) — there
is no priority field.

`tree_area` (a tree species area, `shared/features/tree-areas.ts`) is the same
kind of overlay (after `vegetation_zone` in `TYPE_Z_ORDER`, in `OVERLAY_TYPES`,
no gameplay meaning): the Unity tree planter gives the survey stems inside it
the area's species mix instead of the palette's. Attributes: `species`
(required, comma-separated `<species>[=<weight>]`, palette labels read
lower-cased, weight default 1, no repeats, some weight > 0), optional `name` and
`ignoreKind` (boolean); anything else in the mix is rejected on create, update
and the generated-features import. The GSPro trees export passes `--course` so
`gspro.py trees` writes the areas into the trees file (`docs/gspro/export.md`).

Migration 019 adds `course_zone_types` (the course's legend: `key` unique per
course, `name`, `color`, `texture_index` + `channel` unique per course — four
channels per mask texture — `sort_order` and `items_json`, the VSPro item
bindings `[{ item, minDensity, maxDensity }]` from D-VZ9). `ZoneTypesService`
**seeds the defaults** (`rough_tall`, `shrub`, `fern`, `meadow` on texture
0, channels 0..3, and `woodland_floor` on texture 1 channel 0, D-VZ10) on a
course's first `listByCourse`, so nothing has to run a bootstrap step;
`addDefaults` is the same insert for the panel's button and fills in only the
keys a course is missing (a preset whose slot is taken goes to the first free one). `create` without an explicit slot
takes the lowest free (texture, channel). Migration 022 adds `variants_json`
(`variants: [{ key, name, items }]` on create/update/read): named alternative
item mixes a zone picks with `zoneVariant`; the type's own `items` are the
Default mix. Variant keys match `^[a-z0-9_]+$` and are unique within the type
(a repeat is a `ConflictError`, 409), names are non-empty, items are validated
like `items`; malformed JSON in the column reads as `[]`. Since the zones
export gives every bound item its own mask channel (unity-zones-v2), a type's
`texture_index`/`channel` are legacy: still stored, unique and returned, but
ignored by the pipeline and not shown in the web panel. `bun run zones --`
(`scripts/vegetation-zones.ts`) lists/sets zone variants (`--variant`) and
binds a variant's items (`bind --variant <key>`, creating it if missing).
No `version` column and no optimistic
locking — a short course-level legend, unlike the feature stack. The API
(`/api/zone-types*`) mounts in **both** modes, like the features it belongs to.

## 13. Implementation notes: web

Moved from web/AGENTS.md.

`zones/` — `ZoneTypesService` (the course's zone-type legend, loaded with the
features in `editor/toolbar.component.ts`) and `ZoneTypesPanelComponent` (the
table editor: colour, the VSPro item bindings of the type's "Default" mix, and
its named variants, each with its own bindings; item inputs autocomplete from
a `<datalist>` of every item name in the table). No mask texture/channel
inputs: the export gives every bound item its own channel. "Add variant"
creates `New variant` under a key slugged once and made unique in the type
(`uniqueVariantKey`) — renaming later changes the name only, so zones stay
bound. The panel is spawned by `CourseDetailComponent` and opened from the
Vegetation mode's zone-type picker ("Edit zone types…") or the selection
panel's zone section.

`vegetation_zone` is a feature type in `draw/feature-palette.ts`
(`VEGETATION_TYPES`; no digit shortcut; mirrored by hand into
`mobile/course/feature-colors.ts`), drawn and edited in Vegetation mode only
(see below).
Its attributes (`zoneType`, `zoneVariant`, `weight`, `feather`, `noise`,
`blend`, `extraPalettes`) are
edited in the selection panel's "Vegetation zone" section and saved through
`features.update(id, { attributes })`, which replaces the whole object — the
section always sends all seven keys. "Generated vegetation under it"
(`zone-blend-select`, attribute `blend`) is Replace it / Add to it: drawn zones
always add up with each other (D-VZ14); "Also plants" lists `extraPalettes`
(`shared/features/zone-layers.ts`) as rows of type, variant, weight and
Remove, and every edit writes the whole string back. A zone's hole is only
where it is filed (D-VZ14): with only zones selected the move select reads
"Hole (folder)" with a hint and no Roughs, and the Vegetation stack panel
defaults to `ALL_ZONES_KEY` ("All zones, by hole": a heading per hole, rows
named by what the zone plants), keeps it when a zone is selected, and shows
no reorder verbs for zones. The Variant select (`zone-variant-select`:
"Default" = `''` plus the type's variants) is hidden while the type has none;
changing the zone type also resets `zoneVariant` to `''`. `FeaturesService.create`
fills in the zone defaults (first zone type, Default variant, weight 1, feather
2 m, noise 0) for any zone that reaches it without a `zoneType`, so freshly
drawn, duplicated, stamped and retyped zones are all valid server-side;
duplicate/paste copy attributes generically, variant included. The overlay fill
uses `featureFillColorExpression`, which paints a zone in its zone type's own
colour (`properties.zoneColor`; variants share it, `properties.zoneVariant`
carries the key) and everything else from the palette.

`tree_area` (tree species area, `shared/features/tree-areas.ts`) is the other
`VEGETATION_TYPES` entry, picked from the zone-type picker's **Trees** section
(`tree-area-pick`). Like a zone-type pick, `DrawToolService.chooseTreeArea`
converts the selected zones (a retype, one undo entry) or, with none selected
or while drawing, arms the next shape. A zone-type pick in turn converts
selected areas into zones of that type and otherwise arms a zone. The
attributes of both types ride along (history snapshots restore the type only),
so undo gets either back as it was. A new or converted area starts with the
mix edited last (`drawTreeMix`, default `oak`). The selection panel's "Tree species area"
section edits `name`, the mix (`species`, one row per species: name with a
datalist of `SUGGESTED_TREE_SPECIES`, weight, share, remove; rows are refreshed
in place so focus survives a save; a mix of zeros is not saved) and
`ignoreKind`. The stack panel labels it "<name> · oak 90% · birch 10%";
`buildLieMap` skips it.

### Vegetation mode

The zones are drawn and edited in the Vegetation sub-mode
(`zones/vegetation-tool.ts`), the draw engine in its `vegetation` scope
(`activate(ctx, { scope: 'vegetation', toolId })`, one history per scope,
`scopeOwnsType` decides what each scope hits, picks and marquees). There the
course features (`modeBackdropTypes` in `FeaturesService`) paint as a faint
outline with no fill, out of hit tests and the stack panel, and the command
bar swaps the feature-type picker for a zone-type picker
(`DrawToolService.chooseZoneType`: the next zone's type, or retype the
selected zones). Outside Vegetation mode the zones, drawn and generated, are
in `modeHiddenTypes` by type — the default that `resetModeView()` restores at
the end of every draw-engine span — so Draw, Furniture, the other tools and
the planner never show them. The dock hosts the selection and stack panels
for Vegetation as for Draw.

Of the backdrop, Vegetation still selects the creeks and water
(`scopeSelectsType`; `takesBankVeg` in shared/features/creek-vegetation.ts)
so their bank vegetation is set point-and-click: a click takes a hand-drawn
zone first, then the water, then generated zones (`vegetationHitOrder`: the
generated creek-bank zones lie over the water they came from). A backdrop
row is read-only there: `editableSelected`/`editableSelectedFeatures` leave
out `modeBackdropTypes` (no handles, move, duplicate, retype), and delete and
stack reorder skip it, so the selection panel shows only "Bank vegetation"
and a hint that the shape is Draw's.

The command bar's **Generated** toggle (`generated-vegetation-btn`, Vegetation
mode only, shown when the course has generated zones) hides or shows every
generated vegetation source at once (`FeaturesService.setGeneratedVegetationShown`:
tall rough, creek banks, lidar woodland floor), leaving the zones drawn by
hand. It is the same `hiddenSources` state as the stack panel's group-row
eyes. Why: drawn zones add up with each other (D-VZ14), and an old hand-drawn
tall-rough zone under a new wispy one was invisible among the generated bands
(Vreta, 2026-10-10).

The command bar's **Update vegetation** (Vegetation mode only; "Plant for
GSPro" until 2026-10-14) runs the server's `vegetation` export job through
`zones/plant-vegetation.service.ts`
(start, or follow the planting already running; poll to the end): every
vegetation generator whose inputs changed, the zones export, the import into the open Unity
project (or, when only some zones changed, a patch of just those, D-VZ18), and the Arborist file in the GSPro course folder (its lower
vegetation from the zones export; its trees out of the Unity scene, so only
with Unity open; [gspro/arborist.md](gspro/arborist.md), "Who writes the file").
Then the features reload and the job's report is shown; the result dialog's
body says in one line each what Unity and the Arborist file got
(`arboristOutcome`). With zones
selected, **Update N zones** (`update-zones-btn`, `PlantVegetationService.update`)
runs the `vegetation-update` job for just them (`GsproExportService.updateZones`:
`gspro.py zones-patch` per exported terrain, then `golfmap.zones.patch`, then
`arborist.py lower` when the inner masks changed). It runs
no generators and has no confirm; the result dialog warns when a terrain was
skipped. A zone
type whose Default mix binds nothing starts new and retyped zones on its
first variant (`ZoneTypesService.startVariantOf`), and the Variant picker
says so on Default; creek_bank's `<palette>_wet` halves are not offered
(`pickableVariantsOf`).
