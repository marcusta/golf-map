---
name: grass-planting
description: Plant tall grass / lower vegetation (Vegetation Studio Pro grass) on a GSPro course built from golf-map - build or tune a grass palette from texture packs (RUSTIC Grass), generate where it grows by rule for the whole course (deep rough + OPCD Outer_Deep, near play, off tees/fairways/greens/semi/bunkers/water/roads/houses), import into Unity and verify with screenshots. Use for "plant grass", "tall grass", "fill the course with grass", "grass palette", "the grass is on the tee", "grass doesn't blend", or re-planting after course/mesh changes.
---

# Grass planting (tall rough)

End to end, agent-driven: the golf-map DB holds *where* (generated `vegetation_zone`
features), the Unity course folder holds *what* (the grass palette), VSP renders it.
Every step is a CLI or a bridge command; the `unity` MCP server drives Unity
(`unity/mcp/README.md`). Nothing here needs the web app or Unity focus.

## The loop (Vreta names; any course)

1. **Surface map** (once per Blender/mesh rebuild): `unity_command golfmap.surfaces.export
   {terrain: "inner"}` rasterizes the course meshes (`Spline_*`, `Gap_Issue_*`, classified by
   name) into `<export>/<prefix>-inner-surfaces.json/.bin/-preview.png`. The meshes are the
   truth: OPCD's Blender step fills everything outside the holes with `Outer_Deep_Sat` meshes
   and adds blend strips that are not features in the DB.
2. **Inputs for houses/roads** (once per site): `sources/<site>/buildings.geojson`
   (`cd pipeline && .venv/Scripts/python.exe -m golfpipe fetch-buildings --bbox <inner WGS84> --out
   ../data/sources/<site>/buildings.geojson --lidar ../data/sources/<site>/lidar/*.laz`) and
   `sources/<site>/roads-centerlines.geojson` (the app's road fetch / `fetch-roads
   --centerlines-out`). Golf-map `path` features count as roads too.
3. **Zones by rule**: `bun run grass:zones -- <course>` runs `pipeline/grass_zones.py`, replaces
   the course's generated `tall-grass` zones (hand-drawn zones are never touched) and re-exports
   `zones:inner`. `--dry-run` writes the GeoJSON only.
4. **Terrain under the meshes** (once per mesh rebuild or terrain re-import): `unity_command
   golfmap.terrain.conform {terrain: "inner"}` lifts the terrain to 1 cm under the course meshes (it
   backs up the TerrainData to `<course>/Backups/` first; `golfmap.terrain.restore {backup}` undoes).
   VSP plants grass on the *terrain*; where OPCD's coarse meshes bridge a ditch or dip, grass in the
   hollow is buried by the mesh - bare lines along mesh seams (Vreta: up to 15-50 cm, ~3 % of the
   grass area). OPCD scenes disable the inner Terrain component (never drawn; the meshes are the
   ground), so the terrain can hug the mesh; if it is drawn, the command keeps it below the mesh
   between samples too. Do NOT use OPCD's right-click "Conform Mesh To Terrain" for this: it moves the
   playing-surface meshes down instead and re-exports their FBX. VSP MeshTerrain (plant on the meshes)
   works in the editor but bakes 7M triangles and is untested in GSPro's forked VSP runtime.
5. **Unity**: `unity_command golfmap.zones.import {terrain: "inner", package: "GolfMap lower
   vegetation"}` then `unity_command golfmap.grass.apply {palette: "rough_tall"}`.
6. **Verify** (below), then ask the user to **save the scene** (package list, VSP settings).

## Where tall grass grows (pipeline/grass_zones.py, tests in pipeline/tests/test_grass_zones.py)

From the surface map the rules are a **weight field** (0..1 per 0.5 m cell), written as nested
contour bands (weights 0.1 ... 1.0, one `vegetation_zone` per band polygon, 1 m feather (`--band-feather`), 1 m noise).
The zone rasterizer keeps the maximum per slot (a type's Default or one of its variants), so the bands stack into one smooth ramp. Don't go
back to one polygon with a wide inward feather: it fades from *every* cut edge, so a narrow rough strip
between deep rough and a semi becomes a thin, dipping band - it reads as a hole along the mesh border.

- deep rough (per-hole `Deep` meshes + `Outer_Deep_Sat` fill): 1;
- rough: 1 at the deep border, falling to 0 at 1.5 m (`--spill`) - a tight, ragged line into the mown
  rough like real unmown rough (5 m read as a wide, patchy fade);
- times a ramp to 0 near each forbidden surface: zero within the clearance, full beyond clearance +
  ramp: tee/green 4 m + 4 m, fairway 3 + 3, semi/bunker 2 + 3, water 1.5 + 2, blend strips 1 + 2
  (`CLEARANCES` in grass_zones.py);
- times a 10 m ramp to 0 at the reach limit (75 m from rough/semi/fairway/green/tee/bunker);
- times a 1.5 m ramp to 0 at buildings (+4 m) and roads (half width + 1.5 m).
Tune with `--max-distance --spill --band-feather --building-margin --road-margin` (the clearances are constants). `ground.probe {x, z}` lists every collider and terrain height under a point, for "what is really here" questions.

Hand-drawn `rough_tall` zones also get the grass. Check them against the rules (overlay the
zone on the surface map) and ask before deleting; setting `weight 0` (`bun run zones -- set
<course> <id> --weight 0`) makes one inert and keeps it.

## The palette (`Assets/GolfMap/<Course>/grass-palette.json`, snapshot `docs/gspro/<course>/`)

`golfmap-grass-v1`: per zone type key, VSP texture grass items. `golfmap.grass.apply` makes a
**greyscale** copy of each source texture (levelled so bright blades sit near white) and colours
it with the item's `dry`/`healthy` tints through VSP's stock `AwesomeTechnologies/Grass/Grass`
shader (keep the stock shader: GSPro's VSP fork has no fallback for unknown shader names).
Palette-level: `tintAreaScale`, `plantDistance` (VSP grass/plant draw distance for the whole
system; Vreta 300 m - 200 m thinned out too soon), `distanceFalloff` (instances drop out between that
fraction and 1 of the draw distance: 0.75 = full density to 225 m, gone by 300 m, no pop line). Per
item: `width`, `height`, `minScale/maxScale`, `sampleDistance` (spacing; smaller = thicker),
`noiseDensityScale`, `maxSteepness` (default 75 degrees: grass must grow on steep banks; VSP's usual
30-40 leaves them bare), `lodFactor` (palette or item, default 5), `maxDensity` (the zone binding).

**Density lines ("pop-in" 5-20 m out)**: VSP draws texture grass with its `DefaultGrassPatch` mesh,
whose LODs drop blade cards (135 -> 63 -> 36 vertices) at ~5 m and ~18 m - a visible line where the
tall, sparse, bright items thin. `lodFactor` multiplies those distances (LOD switches at ~2.7, 9.1
and 27 m x factor x QualitySettings.lodBias). VSP gives every instance of an item the same switch
distances and its grass shader has no LOD cross-fade, so each switch is a ring - no noise setting
hides it. The dense base item is the one that shows: past its switch it thins and the straw behind
reads brighter (Vreta, factor 5: a line at ~45 m). The only clean fix is no LOD reduction inside the
draw distance: `lodFactor: 40` on every item (Vreta now). Cheap for the sparse accents; for the dense
base it costs vertices (135 per patch instead of 63/36 beyond the switch) - check GSPro frame rate;
the fallback is base `lodFactor` 12-15 (the ring moves to ~110-135 m, where it is hard to see). The textures are also imported
with mip "preserve coverage" at the alpha cutoff + trilinear (`GolfMapGrass.ImportSettings`), so
thin stems don't fade by mip level - a small effect next to the LODs. Check a fix by measuring,
not by eye: the share of bright pixels per distance band of the same screenshot, before/after. Items spawn only once a zone mask includes them.
Bind a zone type to the palette: `bun run zones -- bind <course> rough_tall --palette <file>`.

Vreta's `rough_tall`: Rustic Grass_15 (dense green base, spacing 0.35), Rustic Grass_07
(taller green), Rustic Grass_18 (dry straw, sparse), Sea Grass_09 (muted beige seed heads,
sparse). Greens carry the look; straw/seed heads are accents - bright white/yellow reads as
speckle from a distance.

Vreta's `rough_tall/fresh` variant (taller, fresh green, blades read one by one): Grass Textures/grass14
(base, spacing 0.3), grass24 (crossing blades), Grass Textures2/041 (tall wisps), Rustic Grass_06 (seed
tips); 1.1-1.4 m cards, one tint for base and crossing, `randomDarkening` 0.1, scale 0.8-1.25 and density
noise on the accents like the Default mix. A dense sward much darker than the ground turns the draw-distance
falloff (225-300 m, seen from high Scene-view cameras) into a hard line; keep it near the ground's
brightness (2026-09: tints lifted ~10 %, `#4d7944` base). **Texture shape decides
clumpiness**: VSP draws each instance as a star of cards, so a clump texture (dense centre, tapered
sides - Rustic 15, grass28) reads as a field of separate tufts however it is spaced or tinted. For a
continuous sward pick textures whose blades run evenly across the full card width.

**Colour against the ground, not by eye**: take a 30 m top-down shot over open tall grass with
the palette hidden (`golfmap.grass.apply {spawn: false}`) and shown, compare linear-space means of
the centre, scale the green items' tints by ground/grass (a few iterations) so the grass averages
to the ground colour; then it blends where VSP thins it with distance.

## Verify

- Bare line in the grass? Check the mask across it first (weight continuous = not the zones), then
  `ground.probe {x, z}` (mesh vs terrain height) and a screenshot with `hide: [mesh paths]` - grass
  visible with the mesh hidden means it is buried: run the terrain conform.
- Mask audit: the masks carry one channel per VSP item (`unity-zones-v2`; the JSON's `items` list
  names each item's texture and channel). Overlay an item's channel on the surface map; the
  density on forbidden classes and beyond 75 m must be ~0 (edge resampling residue only).
- Screenshots (`unity_screenshot`): `eye: 1.7` for a golfer's view (camera over the visible
  surface), `eye: 30-50` oblique for blending; a tee box, a fairway edge, a road and the
  original problem spot. After an apply/import VSP must re-spawn: `warmup` 20-80 (the bridge
  calls `[ExecuteInEditMode]` Update/LateUpdate itself; the first frames take ~0.5 s each).
  `golfmap.vsp` shows each system's cameras - no culling group means VSP has not updated yet.
- Show the user; iterate colours or rules; snapshot the palette into `docs/gspro/<course>/`.

**Bushes (prefab items)**: an item with `"prefab": "<asset path>"` instead of `"source"` is a VSP
*Plant* mesh (upright `RotateY`, no collider, casts shadows unless `"shadows": false`), drawn to
the same plant distance and bound to a zone channel like any grass item. It keeps the prefab's
materials; apply refuses a prefab with a shader GSPro's VSP does not know
(`GolfMapTreePlanter.VspKnowsShader` - an unknown one drops the whole package in GSPro).
`healthy`/`dry` go to the NM tree controller's leaf colours: NM's meadow bush materials carry
near-white tints, so untinted grey willows render saturated olive-yellow. The lit result is far
yellower than texture x tint (sun + translucency crush blue): a grey-green tint (`#7f9677`) made it
*worse* (saturation 0.86 vs the trees' 0.3-0.4); it takes a blue-lavender tint (`#869ad9`/`#8b9ad0`)
to land the willows at hue ~82, saturation ~0.45, between the nearby tree canopies. Tune by
measuring, not by eye: mean hue/saturation of screenshot regions (bush, grass, the neighbouring
rough, tree canopies), then fit a per-channel power law through two tint -> rendered points and
solve for the target; the grass shader is far from linear too (one linear-model step turned the
grass blue-grey). A prefab cannot be swapped under an existing item name (VSP keeps the old
model); use a new name.

Vreta's `shrub` (the bush thicket by the water on hole 10, Unity x 1080-1142, z 576-639, zone `35686b1b` on the outline of the
hand-drawn `rough_tall` zone `09585c23`): the palette holds only the bushes - NM Meadow grey willow
02/03/04/01 (scale ~0.65-1.2, spacing 2.45-4.2 m), Mountain hazel 00 (low) and 04 cluster, a sparse
maple bush 01. **The grass under the bushes is the tall rough's own items**, bound to `shrub` by name
(`bun run zones -- bind vreta shrub "Tall rough - green base=1" ... "Shrub thicket - grey willow round=1" ...`,
not `--palette`, which would bind the bushes only). The shrub zone sits on top at weight 1 and takes
the mask budget from the rough under it, but a shared item's channel is the sum of its slots, so the
rough grass runs through the thicket at full weight with no seam. A separate grass mix for the
thicket never matched: tuned by colour it read too bright/lime next to the rough, and darkened to
the orthophoto's thicket luminance (~0.55x the grass beside it) it read as a dark blot. Same grass +
bushes on top is what blends; tune the bushes' density for how dark it reads from far.

## Later: variety

Other lower vegetation = more zone types (`shrub` has a palette on Vreta; `fern`, `meadow`, `woodland_floor` exist)
with their own palettes in the same file and their own rules in grass_zones.py-style generators;
the mask budget lets a zone on top claim its weight first. Within one type, variants
(`bun run zones -- bind <course> rough_tall --variant dry <item>=0.6 ...`, then
`zones -- set <course> <zone> --variant dry`) give a zone its own item mix. An item shared by
variants is fine: its channel is the sum over the slots that bind it (D-VZ11).
