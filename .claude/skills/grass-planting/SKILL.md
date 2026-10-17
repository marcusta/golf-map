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
3. **Zones by rule, into Unity and the Arborist file - one click**: web Vegetation mode, command bar
   **Update vegetation** (or `bun run gspro:update -- <course> vegetation`). It
   runs every vegetation generator (`server/services/vegetation-generators.ts`: tall rough
   `pipeline/grass_zones.py` source `tall-grass`, then the woodland floor `pipeline/woodland_floor_zones.py`
   source `woodland-floor`, then the rocky lake shore `pipeline/rock_shore_zones.py` source `rock-shore`, then creek/pond banks `pipeline/creek_bank_zones.py` source `creek-bank`), replaces each one's generated zones (hand-drawn zones are never touched),
   exports `zones:inner`, and in the course's open Unity project runs `golfmap.zones.import` +
   `golfmap.grass.apply` (export job kind `vegetation`, `GsproExportService.plantVegetation`), then
   writes the Arborist file GSPro draws the bushes, the woodland floor's prefab plants and most trees
   from: `arborist.py lower` from the zones export, and with Unity open `golfmap.trees.dump` +
   `arborist.py trees` (`docs/gspro/arborist.md`, "Who writes the file"; a course without
   `docs/gspro/<course>/arborist-species.json` skips it). The
   report says what each did and warns on zones whose mix binds no items. Unity not open = exported
   only and the Arborist trees left as they were, reported. Same handler from the CLI: `bun run grass:zones -- <course> [--only <source>]
   [--dry-run] [--no-arborist]` (no Unity step, no Arborist trees). A new kind of vegetation = one more strategy in
   `VEGETATION_GENERATORS` (order = zone stack order; `--only X` re-runs X and every one after it).
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
5. **Unity** (done by Update vegetation; by hand after the CLI): `unity_command golfmap.zones.import
   {terrain: "inner", package: "GolfMap lower vegetation", brief: true}` (`brief: true` keeps the result short: counts, not every group and rule) then `unity_command golfmap.grass.apply`.
   A **new item** (a species just added to a palette) needs one more round: import binds masks only to
   items that exist, apply creates the item but turns spawning on only once it has rules - so
   import, apply ("added item ..."), import, apply. Update vegetation repeats the round by itself when
   apply reports an added/replaced item. The item also needs a mask channel first: re-export the zones
   (`grass:zones`) after binding it.
6. **Verify** (below), then ask the user to **save the scene** (package list, VSP settings).

## Where tall grass grows (pipeline/grass_zones.py, tests in pipeline/tests/test_grass_zones.py)

The numbers below (and every generator's) are config: `pipeline/vegetation-rules/<source>.json`, bound to the
constants named here at import; a course overrides any of them in its `vegetation-rules.json` (pipeline/AGENTS.md
"Vegetation rules"). Change a default in the JSON, not in the .py. `bun run vegetation:rules -- <course>` lists them.

From the surface map the rules are a **weight field** (0..1 per 0.5 m cell), written as nested
contour bands (weights 0.1 ... 1.0, one `vegetation_zone` per band polygon, 0.5 m feather (`--band-feather`, centred on the
edge), no zone noise: the field's own edges are ragged, and zone noise wobbled bare patches into the deep rough along every
rough and path).
The zone rasterizer keeps the maximum per slot (a type's Default or one of its variants), so the bands stack into one smooth ramp. Don't go
back to one polygon with a wide inward feather: it fades from *every* cut edge, so a narrow rough strip
between deep rough and a semi becomes a thin, dipping band - it reads as a hole along the mesh border.

- deep rough (per-hole `Deep` meshes + `Outer_Deep_Sat` fill): 1;
- rough: the grass grows right up to it and spills in a foot or so (`--spill` 0.3 m: noise decides where
  it reaches the rough's first cell, rarely the second; 1.5 m and 5 m read as a wide fade);
- times a ramp to 0 near each forbidden surface: zero within the clearance, full beyond clearance +
  ramp: tee/green 4 m + 4 m, fairway 3 + 3, semi/bunker 2 + 3, water 1.5 + 2, blend strips 1 + 2
  (`CLEARANCES` in grass_zones.py) - **only where the deep rough meets that surface itself**. Where mown
  rough lies between (1 m starts to count, 2 m is enough: `ROUGH_BUFFER_M`), the rough is the buffer and
  the clearance does not reach through it (a tee in a 3 m ring of rough used to leave ~5 m of bare deep
  rough around the ring);
- rock slabs (surface class `slab`: a mesh cut out by Blender's `golfmap.cut_out`, `Spline_<name>_Rock_-_Mesh`):
  bare, no clearance around them; grass reaches in over its edge whatever lies beside it (taking it only
  from deep rough left a straight bare mesh edge where a slab met mown rough)
  (`SLAB_FRINGE_M` 0.4 m x 0..2 by noise: most edge cells, so no mesh edge shows; 0.6 m took a metre all
  round, half of a 5 m slab) and patches cover `SLAB_PATCH_COVER` 15 % of it (exempt from the minimum zone
  area). Where a slab lies in mown rough, a ragged skirt of grass also grows out into the rough
  (`SLAB_SKIRT_M` 0.5 m x 0..2 by noise), so the rock's edge is broken up from both sides. The painted klippor (`rock`) keep their 0.2 m clearance;
- times a 10 m ramp to 0 at the reach limit (75 m from rough/semi/fairway/green/tee/bunker);
- **thinner far from play** (`Rules.far_start/far_ramp/far_weight`, `--far-start --far-ramp --far-weight`): from 30 m from
  play (same six surfaces) the weight falls over 10 m to 0.56. The mask value is VSP's density (spawn chance x
  value/256), so that is a little over half the plants; `far_weight` is also a band level, so the zones carry
  exactly it. A course can thin nearer as well (`Rules.near_*`, `--near-start --near-ramp --near-weight`), which
  multiplies with the far rule, so nothing gets thicker; it sets that in `docs/gspro/<course>/vegetation-rules.json`
  (flags per generator source, passed by Update vegetation and `grass:zones` before any CLI flag). **Vreta: near
  18 / 4 / 0.6, far 40 / 10 / 0.5** = 0.6 of the tall rough beyond 20 m from play and 0.3 beyond 50 m, for frame
  time (2026-10-15; before that near 8 / 4 / 0.5 with the code's far rule: 0.5 from 10 m, 0.28 from 40 m, the near
  rule alone -0.48 M of 3.25 M VSP grass instances by the masks). Only the
  generated Default mix thins: the far mix, the verge, hand-drawn zones and the creek banks keep their weight (a
  thinner creek zone would hand the rest of the mask budget to the tall rough under it);
- **the far mix** (`rough_tall/far`, `Rules.out_start/out_ramp`, `--out-start`): from 40 m from play the ordinary
  mix hands over, across 40-50 m, to the type's `far` variant, written as its own nested bands above the ordinary
  ones (it claims its share of the mask budget first, the ordinary mix keeps the rest, so the two cross-fade and
  add up to the unthinned field). Only on a course whose zone type binds items to a variant `far`
  (`bun run zones -- bind <course> rough_tall --variant far --name "..." --palette <file>`); without it the
  ordinary mix grows to the reach limit and the run says so. The area is defined by distance from play, not by
  the drawn `oob` ring: Vreta's ring holds the western holes only (half the fairways lie outside it). Hand-drawn
  zones and the woodland floor sit above it as before;
- **the dark mix** (`rough_tall/dark`, and `rough_tall/far_dark` for the far mix; `Rules.dark_light/dark_dark`,
  `--dark-light --dark-dark`): the grass must sit at the brightness of the ground under it, and OPCD's
  Outer_Deep_Sat fill shows the orthophoto, so a dark crop field and a pale meadow are the same mesh class.
  `golfmap.surfaces.ground` (also run by `golfmap.surfaces.export`, so every course refresh) renders the ground
  straight down with VSP off into `<prefix>-<terrain>-surfaces-ground.png` on the surface map's grid; its linear
  luminance, smoothed (sigma 4 m), hands each mix over to its dark variant between dark_light and dark_dark,
  written as bands above the others like the far mix. Only where the course binds the variant. Omberg
  (2026-10-17): 0.056 / 0.046 (deep rough on holes 1/5 0.056-0.064, the crop fields 0.043-0.047, a pale meadow
  0.066 in that render - it has no post-processing, so its contrast is lower than a Scene-view shot's); the dark
  items are the green ones with the tints from before the x1.75 lift, the accents shared by name;
- times a 1.5 m ramp to 0 at buildings (+4 m);
- paths and roads are **not in the weight field**: it runs on under them (the path mesh's `other` cells and
  OPCD's seam of single `blend` cells along it take the surface beside the path - as blend strips they
  pushed the grass 1-3 m back), and the app's drawn `path` outlines (+ `--path-margin`, 0.15 m: at 0 the blades leaning over read as slightly too much on the road) and the road
  centerlines (half width + 0.5 m; only where the road is not also drawn as a path - the survey's line lies
  a metre off the drawing and left 1-2 m bare along it) are cut out of the band polygons as vectors (`ways_cut`). The grass
  edge is then the path's edge exactly; cutting by 0.5 m cells left bare strips beside a path and grass
  half across it. On `gravel` and `dirt` paths a tuft grows a foot onto the path here and there: discs of
  ~0.4 m on the outline (big enough to hold one 0.5 m mask pixel), one per ~9 m of edge (`TUFT_*`); noise blobs of cells closed a 1.5 m path.
  Hard paths get none.
- the **verge** of a gravel or dirt path (`rough_tall/verge`, `VERGE_*` in grass_zones.py): an unmown strip of straw and
  weeds beside it, written as `blend: mix` zones of the same source, so the tall rough under it keeps growing. Deep
  rough only, 1.8 m x 0.4..1.6 by noise, 3/4 of the length, none within 4 m of semi/fairway/green/tee/bunker or 2 m
  of water, its feet 0.35 m off the path. Mown rough is cut right up to the gravel: a verge there (first pass, 0.8 m)
  read as weeds on a kept lawn, and with tufts of its own it closed a 2 m path. The mix is bound by name
  (`zones -- bind <course> rough_tall --variant verge "<item>=<density>" ...`); Vreta: blond green foot 0.7, straw
  blades 0.6, seed tips 0.5, wisps 0.4, tall green 0.3, dry umbels 0.2, brown tufts 0.12, dark seed stems 0.1,
  thistle heads 0.08 (the first mix, without the green foot, read as brown bushes).
Tune with `--max-distance --spill --band-feather --building-margin --road-margin --path-margin --far-start --far-ramp --far-weight --near-start --near-ramp --near-weight --out-start` (the clearances are constants).
History: grass first grew onto paths and tee boxes (not ok), then the margins left bare deep-rough bands
(1 m path margin + ramp + noise, tee clearance through the rough: not ok either) - keep the borders tight. `ground.probe {x, z}` lists every collider and terrain height under a point, for "what is really here" questions.

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
`renderDistance` (metres, palette or item; 0 = the full `plantDistance`): how far the item draws (VSP's
render distance factor = this / plant distance). `copies` (item, metres, e.g. `[15, 30]`): stingreye's
trick, the item again as `"<name> @15m"` / `@30m` drawn only that far, so the grass is denser near the
camera; the copies take their base's mask rules (no mask channel of their own; the zone import keeps
them) and are removed when the palette drops them. **Never end grass in a hard line**: a short
`renderDistance` (45 / 90 m on Vreta's creek and tall rough, 2026-10-15) popped in and left banks bare
in GreenKeeper. Thin it with an early `distanceFalloff` instead (0.15 = each instance culled at a
random 15-100 % of its distance, so the density falls evenly from 45 m to 300 m); a copy thins the
same way from 15 % of its own distance (a 15 m copy from 2 m), so copies add no line either.
**Green is the bulk, straw/brown the accent** (Marcus): copies go on the green items only (Vreta's
tall rough mixes: the carpet item `[15, 30]`, the other green ones `[30]`, about 3x at 3 m and 1x at
30 m; GreenKeeper 4K 99/92 with them), and the green tints sit close to the ground mesh as rendered,
or the grass shows where it thins (compare a Scene-view shot with `golfmap.vegperf.hide
{wholeSystem: true}` against one with it on; item hides do not reach the screenshot).

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

Vreta's `rough_tall/far` (2026-10-13, the ground beyond 40 m from play, ~150 000 m2 = a quarter of the tall
rough): the Default mix's textures and tints (`Far rough - green base / tall green / dry straw`, own items: size
and spacing are per item) as few, large cards - width 2.0 / 1.9 m (twice the Default's), height 0.75 / 1.2 / 1.15,
spacing 1.15 / 2.4 / 3.6 m: about 0.9 instances per m2 against the Default's ~5. `distanceFalloff` 0.4 (instances
drop out from 120 m instead of 225 m), `lodFactor` 12. Seen in Unity only from 40-80 m: reads as grass, no seam
found; not seen in GSPro.

**Uneven height (2026-10-13)**: a tall mix read as one even carpet at one height. VSP scales an instance by
random(`minScale`, `maxScale`) x a Perlin wave (`noiseScaleMin..Max`, one lattice cell per `noiseScaleScale`
metres, no offset), so items with the same `noiseScaleScale` rise and fall together, and Perlin values crowd
the middle: 0.45..1.6 gives mostly 0.85..1.2. Now, per palette: the dense base varies in small patches
(`noiseScaleScale` 6-7, range 0.35..1.7, random scale narrowed to 0.75..1.3 so the patches show), every other
item has its own wave size (11, 13, 17, 19, 23, 29, 31 m) and a wider range (0.3..1.9), and the tall middle
items stand in clumps (`noiseCutoff` 0.3-0.35 at a scale of their own: an instance spawns only where that noise
is above the cutoff, about 10-15 % fewer). Spacing untouched, so never more instances. Not the low creek palette,
not the woodland floor plants.

**Thinner creek stands (2026-10-13, Marcus: "very thick" right of hole 6)**: `Creek reed - upright blades`
spacing 0.38 -> 0.5, `broad leaves` 0.8 -> 1.0, `Creek thicket - grass base` 0.36 -> 0.48, `grass tall`
0.65 -> 0.82, `grass fine` 0.8 -> 1.0, the two giants 1.25 -> 1.5: 39 % fewer visible reed instances at his
spot. Items are shared by name (one VSP item per name), so `reed_wet`, `vass` and `thicket_wet` thinned with
them; `lush_low` has its own items and did not. His three zones overlap there (reed + thicket both at full
weight: drawn zones add up), which is half of why it was so thick.

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
to the ground colour; then it blends where VSP thins it with distance. Measure at the user's spot
inside the course (hole deep rough), not the densest mask spot (often an outer field). `randomDarkening`
is the *floor*, not the amount: the shader multiplies each instance by saturate(random + value), so 0.2
leaves a fifth of the blades near black - raise it to lighten the dark mix close up (Omberg 0.3,
2026-10-17: close-up p10 +27 %, the 30 m oblique mean only +8 %; it lifts top-down shots much more).

**Tuning loop without apply**: `golfmap.vegpalette.adjust {select, brightness|saturation|hue|warmth
|height|width|density|spread, set: {role: value}}` changes the working copy and the scene at once (colours
graded in linear light: `brightness: -0.15` = x0.85 linear), `golfmap.vegpalette.spots {select, goto: 0}`
frames where it grows, screenshot, measure, repeat (the live push reaches an item's distance copies too); `golfmap.vegpalette.save` writes grass-palette.json
(every palette listing a shared item; minimal diff) or `.revert` puts it back. The user does the same in
`GolfMap > Vegetation Palettes` (`golfmap.vegpalette.show {select}` opens it on what you changed). Texture
white point and a bush's first `material` override still need `golfmap.vegpalette.rebuild` (= apply).

## Verify

- **Mask registration**: VSP reads the mask as Unity pixel `round(metres / px)` (nearest, no filtering;
  `TextureMask.cs`), so PNG pixel (col, row) stands for the point (col, row + 1) px from the north-west
  corner. `gspro._fill_even_odd` fills by that point. PIL's polygon fill (used until 2026-10) leaked up
  to a pixel west and south: grass 0.5 m onto the north/east side of every path, tee and green, bare on
  the other. At 4096 px over 2050 m an edge is still only good to +-0.25 m (one mask pixel).

- Grass across a path although no zone overlaps it? Sample the item masks on the path (pixel = metres / (side / resolution),
  rows from the north edge). Vreta 2026-10-11: an itemless zone (an old `lidar-woodland` proposal, `woodland_floor`
  Default, weight 0.3) lay over the path, and the edge blend of a hand-drawn blond patch beside it handed that weight
  to the blond mix. The blend now leaves slots that bind no items alone (`render_zone_masks(planted=...)`). A drawn
  patch against a path also needs `--feather 0.5`: the feather is centred on the edge, so 2 m puts a metre of grass
  on the gravel.
- Bare line in the grass? Check the mask across it first (weight continuous = not the zones), then
  `ground.probe {x, z}` (mesh vs terrain height) and a screenshot with `hide: [mesh paths]` - grass
  visible with the mesh hidden means it is buried: run the terrain conform.
- Mask audit: the masks carry one channel per VSP item (`unity-zones-v2`; the JSON's `items` list
  names each item's texture and channel). Overlay an item's channel on the surface map; the
  density on forbidden classes and beyond 75 m must be ~0 (edge resampling residue only).
- VSP stuck throwing "The previously scheduled job ... You must call JobHandle.Complete()" on every
  frame and every apply (seen after an asset refresh mid-frame): a script reload clears it (any
  `unity_sync push` that compiles); `golfmap.vsp.reset` disables/re-enables the systems.
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
hand-drawn `rough_tall` zone `09585c23`): the palette holds only the bushes. Mix since 2026-10-11:
grey willow 02/03/04/01 (spacing 3.6-5.5 m, each its own tint), hazel 00/04-cluster/01 (3.6-4.2 m),
maple bush 01/02 (5 m), the cottonwood canopy as a bush (5 m) and a sparse birch sapling (11 m); scale
~0.5-1.3 with height waves (`noiseScaleMin/Max` 0.65-1.4, scale 9), a different `noiseDensityScale`
per item so species drift, the creek thicket's material blocks. The first mix was 3/4 willow at
2.45-4.2 m, one tint (`#869acd`), scale 0.65-1.2 and no height waves: "the same bush over and over",
blue-grey, in visible rows. **The grass under the bushes is the tall rough's own items**, bound to `shrub` by name
(`bun run zones -- bind vreta shrub "Tall rough - green base=1" ... "Shrub thicket - grey willow round=1" ...`,
not `--palette`, which would bind the bushes only). The shrub zone sits on top at weight 1 and takes
the mask budget from the rough under it, but a shared item's channel is the sum of its slots, so the
rough grass runs through the thicket at full weight with no seam. A separate grass mix for the
thicket never matched: tuned by colour it read too bright/lime next to the rough, and darkened to
the orthophoto's thicket luminance (~0.55x the grass beside it) it read as a dark blot. Same grass +
bushes on top is what blends; tune the bushes' density for how dark it reads from far.

## Creek banks (`creek_bank` zones, pipeline/creek_bank_zones.py)

Tall, uneven grass from the water's edge up to the top of the bank, and in clumps out into the water,
on the creeks a builder marks. A `water_creek` or `water` feature's attributes (a `water` polygon is a
dug pond or channel, e.g. Vreta's `0d59098f`; shared/features/creek-vegetation.ts):
`bankVeg` = the palette (`default` or a `creek_bank` variant key; absent = not planted), `bankVegCover`
0..1 (share of the water covered, default 0.5), `bankVegMaxM` (cap on how far up the bank, default 4.5 m),
`bankVegWetM` (how far up the bank the palette's `_wet` water plants reach, default 1 m; the panel's
"Water plants up the bank", shown for palettes with a `_wet` half; its hand-over ramp and edge noise
shrink with it, so 0.3-0.5 m keeps reeds in the water and on the waterline).
Mark them point-and-click in the web **Vegetation** mode (click a creek or water, ⌘/Ctrl-click for more;
the selection panel shows only "Bank vegetation": palette + water cover %; the shape stays read-only
there) or Draw's selection panel, or `bun run zones -- creek <course> <id> --palette reed [--cover 0.4]`
(`zones -- creeks <course>` lists both types). Cattails without bushes = `reed`; with willows = `thicket`.

- `grass:zones` runs the creek generator after the tall rough (source `creek-bank`, always second, so
  the creek zones sit on top and claim the banks; `--only creek-bank` re-runs just them). It needs the
  surface map and the terrain's DEM tif next to it (the edited DEM: creek digs included).
- Bank = ground next to the water at >= 10 degrees, connected to the water through such ground (walking
  out, the bank ends where it flattens), min 1 m, max `bankVegMaxM`; weight 1 there, fading over 1 m
  past the top with +-0.8 m of smooth noise (ragged edge). Vreta's ditches are wide Vs (the ground rises
  ~16 degrees for ~6 m each side): the first 6 m cap read "slightly too wide", 4.5 m is the default now.
- Paths: OPCD's path meshes are NOT in the surface map (the cells under a cart path classify as the deep
  or rough below it), so both generators read the app's `path` features. Creek grass is zero within
  1.2 m of a path (a ~1 m card leans: a zone that stops at the path edge still hangs over it) and full
  0.8 m further; the tall rough grows up to the path's edge (above).
- Wet split: when `creek_bank` has a `<palette>_wet` variant, the water and the lower bank (1 m from the
  water, a ragged hand-over over 0.6 m) get that mix and the rest of the bank the palette's own. Vreta
  `reed_wet` = cattails (Dry Cattails 05/01, spacing ~1, scale 0.95-1.35: sparser hid under the base),
  reed plumes (muted `#636b50`, whitePoint 0.75: brighter read as wheat), broad leaves and the base;
  `reed` (upper) = the base, broad leaves, the lush palette's tall arching grass and the brown tufts.
  Items both bind (the base) run through the split with no seam. The web picker hides `_wet` variants;
  bind one with `zones -- bind <course> creek_bank --variant reed_wet --palette <file>`.
- Vreta `vass` / `vass_wet` (common reed, Phragmites - "vass"; the pond `0d59098f`, section `a81ef9ae`,
  2026-09-27, tuned against a phone photo of the pond: mostly fresh yellow-green reed, sparser tan
  plumes, patchy, wind-bent): `vass` = `reed` as is; `vass_wet` = `reed_wet`'s items **thinned in the
  binding** (`maxDensity` 0.2-0.3 in the palette file - Unity ignores it, `zones -- bind --palette`
  bakes it into the mask, so `reed_wet` stays as approved; now 0.13-0.2) plus the `Creek vass - *` items:
  the reed stand in three copies of one texture (Grass Textures2/013; 2.6 / 3.0 / 3.4 m cards, tints
  `#97a76d` warm / `#8ba06f` / `#7f996b` cool, spacing 2.08 each = the one stand's density at 1.2, density
  noise 13 / 9 / 7 - "copy the species with hue and length variations, same total"), leafy reed (Rustic
  Grass_11 2.6 m, 1.9, `#8ea06d`), plumes (Grass Textures2/014 3.3 m, 2.25, `#a6a17a`) and winter reed (Dry
  Grass_12 2.8 m, 3.75, `#9c9673`); scale 0.7-1.5, height waves 0.7-1.3. On the pond `bankVegWetM` 0.4 and
  `bankVegMaxM` 2: the first pass (1 m wet reach, 4.5 m bank) read "too much up on the bank" and "too thick". Tall because it stands on the bed: the pond is dug 1.65 m
  (2 m shelf at 0.25 m), so 2-4.5 m cards clear the water by 2-3 m. Colour path: a beige tint first
  rendered orange wheat (hue 37, sat 0.45), pale greys rendered white (2x the fairway's luminance),
  a fitted per-channel power law gave lime (sat 0.5); what blends is the lime tints desaturated to 72 %
  in linear light and x0.85: reed mean luminance 1.16x the fairway beside it, hue ~58. That was one
  direction: from the user's camera (looking north up the pond, Scene view pivot 784.6/12.1/631.1, rotation
  4/3/0) the same tints read 1.95x (p90 2.9x) - tall cards lit through by the sun. Now x0.6 linear, chroma
  x1.25 (stand `#6b804c` / `#758646` / `#607b4a`, leafy `#6e8049`, plumes `#858056`, winter `#7d7752`):
  1.08x (p90 1.46x) there, 0.41x from the south end (between the tall rough ~0.4x and the fairway). Tall
  grass differs ~2.5x by view direction, so measure both ways and pick the compromise. Measure the
  reed and the fairway in the same shot (`eye 4.9` from the pond's south end, and `eye 1.7` from the
  bank), never by eye.
- Water: shore-to-mid-stream score + noise, thresholded to exactly `bankVegCover` (specks < 0.5 m2
  dropped): grows in from both banks, open strip down the middle. VSP plants on the terrain, which the
  conform leaves at the bed, and 1.2-1.9 m cards stand out of 0.3-0.7 m of water.
- Kept off tees/greens (2 + 2 m), fairways (1 + 1.5), semis/bunkers, paths (above) and "other" meshes,
  other water, buildings, roads. grass_zones.py drops its water clearance along marked creeks so the
  tall rough runs up to them and fills in where the bank grass fades.
- Palettes are `creek_bank/<variant>` in grass-palette.json; bind with
  `zones -- bind <course> creek_bank --variant lush --name "Lush tall grass" --palette <file>` (the name
  is what the panel shows). Vreta: `lush` (Rustic 23 broad blades base, Rustic 11, Dune Grass 04, Grass
  Textures2/026 reed-canary heads) and `reed` (Dune Grass 02 base, 010 broad leaves, 024 plumes, Dry
  Cattails 05/01); 1.15-1.9 m cards, scale 0.7-1.35 plus height-wave noise (`noiseScaleMin/Max/Scale`)
  for the uneven top. Colour: the first pass was 2x darker than the rough from 25 m (dense tall grass
  shades itself); tints x1.45 (linear) fixed that but read lime, 55 % saturation read grey - ~78 % of the
  saturation with red -4 % / blue +4 % read pale and minty next to the standard tall rough. Now: the
  standard rough's hue, then darker and more olive still (base `#516f44`/`#547247`: vivid greens read
  brighter than the standard rough's `#588b3f` in the render because the creek cards stand taller in the light), plus a shared sparse,
  patchy `Creek - brown dead grass` item (Rustic Grass_19, `#6e5a3e`, spacing 2.2, density noise 24) in
  both palettes for brown touches (2026-09). That olive pass then read too dark against the fairway from a
  golfer's view on 18 (bank luminance ~0.4x the ground beside it): the lush greens went x1.56 linear in
  two steps (x1.3 still read "a little too dark"), hue kept (broad blades `#648854`, tall arching `#6b8e5b` -
  shared with `reed` - fine blades `#719663`), and the shared brown tufts / canary heads x1.15 (`#756043`,
  `#717654`); banks now ~0.8x the fairway beside them, p90 at the ground's (2026-09-26). Tune the creek
  palettes only; `rough_tall` is the reference.
- Vreta `lush_low` ("Lush grasses", 2026-09-28): `lush` cut down to a cleaner ~0.2-0.35 m bank sward
  for ponds and creeks, taller than cut rough. Same textures and tints as `lush`, own items (`Creek lush
  low - *`: an item's size is per item, so shared names would resize `lush`): cards 0.26-0.32 m (accents
  canary heads 0.4 m, brown tufts 0.28 m), scale 0.8-1.2, height waves 0.8-1.25, squatter (width
  0.45-0.5) and denser (base spacing 0.18) so the short blades still close up; heads/tufts sparser
  (3.2 / 2.8) for a tidier look. First pass, not yet tuned against the fairway in a render.
- The creek zone type is added to a course on first use (a course seeded before it existed).
- Sections (one creek, several looks): draw a **hand-drawn `creek_bank` vegetation zone** (web Draw:
  vegetation zone, type Creek bank, the variant = the palette) over a stretch. The banks of every creek
  inside it get that palette (an unmarked creek or water is planted there only; a section's variant must be a
  palette with items - `creek_bank` Default is empty on Vreta, so a Default section plants nothing), blending into the creek's own
  over 2 m with +-1.5 m of noise; later sections on top. It is an instruction, not a planting: the zones
  export skips hand-drawn creek_bank zones (`gspro.py cmd_zones`, it says so in its report). This keeps
  the creek one feature, so its dig and R.A.M. spline are untouched.
- Vreta 18 (creek 573fe06b, 2026-09 photos from the app, `bun run photos-pull`): the stretch that splits
  the fairways, around the brick bridge (Unity x < ~1040), is clean grass = `lush`; from the bridge east
  along the right of 18 to the green it is a willow/birch thicket in the ditch = section `98207ef6`,
  `thicket`. `thicket` (upper bank) = the lush items; `thicket_wet` = its own `Creek thicket - willow *`
  items (the NM grey willow prefabs, NOT the hole-10 `Shrub thicket` items: scale 1.0-1.6, spacing
  1.9-2.8, tint `#6f8aa0` - hole 10's lavender `#869acd` at scale ~0.9 read small, sparse and grey-blue
  here) over the lush base grass and brown tufts.
  Seen towards the sun they read almost white: NM's `Tree_Leaves_Specular` draws both leaf faces with
  the front normal (`_BackFaceMirrorNormal` 0), so back faces light as if facing the sun, and the
  willow material is glossy (`_SmoothnessPower` 1). The items carry `"material": {"_BackFaceMirrorNormal":
  1, "_SmoothnessPower": 0.1, "_SpecularPower": 0.05, "_Smooothness": 0.1}` (the last is the LOD cross
  shader's, sic): apply draws course-local copies (`<course>/Grass/Prefabs/<item>.prefab` + material
  copies), the NM assets stay untouched. Measure backlit shots (mean luminance / share of pixels > 0.6
  over the bushes), and force a VSP rebuild (`golfmap.grass.refresh` or apply) before judging a
  material change - VSP keeps its own material copies.
  Species/height (2026-09): willow x4, maple bush 01/02, hazel 01/00/04-cluster (all NM, same material
  block) and a sparse birch sapling (the `Looks/birch/darker` prefab, its own tints), scale 0.5-1.7 plus
  height-wave noise. Blend by measurement against the rough in the same shot (linear luminance, mean and
  p90): the first willows were ~4x darker than the rough; sun-side highlights must not exceed the rough's
  p90 (lime read) - tint `#a9b8b6` (the leaf texture is yellow-green, so a blue-grey tint renders neutral
  green). The thicket has its own grass items (`Creek thicket - grass *`, lush tints x1.4 linear): under
  the bushes' shade the shared lush grass read too dark, and the lush palette elsewhere stays as approved.
  Height: the thicket grasses scale 0.55-1.3 with height waves 0.65-1.4 (`noiseScaleScale` 10), plus two
  "giant" items (Rustic 11 / Dune Grass 04 at scale 1.25-1.7, ~1.9-2.6 m, patchy density noise 14) for
  stands 50-100 % taller. Cattails of its own in the wet mix (Dry Cattails 05/01, scale 0.6-1.8,
  ~1.1-3.2 m). Broadleaf: CESimgolf `Cottonwood-Giant-Canopy PREFAB` as a bush - NM leaf shader, so the
  same material block and tints work; ~11 m canopy -> scale 0.2-0.32 (2-3.5 m); its CollisionObject1
  sphere has no renderer (VSP colliders are off). Untinted it read yellow-lime: tint `#9a9ea4`. The path to the wooden footbridge stops at the ditch in
  the app, so the thicket closes the crossing; extend the path over the creek to keep it clear.

## Woodland floor (`woodland_floor/<variant>` zones, pipeline/woodland_floor_zones.py)

What grows under the trees, by which trees stand there and what the ground is like. Runs after the tall
rough (it takes the ground from it under the trees) and before the creek banks; `--only woodland-floor`.
Inputs sit next to the surface map: the DEM and the planted trees (`<prefix>-<terrain>-trees.json`; no
trees file = no floor, with a warning). Rules, constants and the Vreta numbers behind them are in the
module doc; in short:

- **Where**: canopy closure (crown discs smoothed over 6 m) above 0.15..0.4, on deep rough only, with
  the tall rough's clearances, within 50 m of play (`--reach`; the floor is geometry, and 150 m doubled
  it), paths cut out. A lone tree or a loose row keeps the tall rough. Trees standing in mown rough get
  no floor: the rough is the surface.
- **Which floor** (variants, the forestry ground-vegetation types cut down to four): `fern` where water
  gathers (wetness index, not on slopes), `heath` on dry knolls (terrain position, mostly under
  conifers), else `bilberry` under conifers and `herb` under broadleaves. Patches of ~15 m with ragged,
  cross-fading borders, and inside each patch pockets of ~5 m of the other floors at 40 % of the weight
  (`POCKET_*`): one floor per area read as too uniform. Knoll/hollow and wetness come from
  `pipeline/terrain_fields.py`.
- **`edge`**: brush along a stand's rim towards open ground. **`brush`**: saplings and 0.5-1.5 m bushes
  in drifts inside what is decidedly forest (crown cover over 25 m above 0.28..0.38; Vreta's planted
  floor has a median of 0.31), not in a tree corridor between two holes. Spacing 3.5-6.5 m per item. Both are written as `blend: mix` zones, so the floor under them keeps growing.
- **Tree kind** is the planted trees' `k` (leaf-off crown colour) and the tree species areas. Where the
  kind is wrong the floor is wrong the same way the planted trees are: fix it with a tree area.
- **Vreta's mixes** (2026-10-10, NM Mountain Environment plants): `heath` = heather x2, lingonberry, dry
  bilberry, a pine seedling, tall rough straw at 0.25; `bilberry` = bilberry carpet and tall bilberry,
  lingonberry 0.3, ferns 0.08, tall rough base 0.12; `herb` = tall rough base 0.5 / tall green 0.15,
  ferns 0.1 + 0.05 (no bushes: herb is also what a corridor gets); `fern` = CESimgolf Common Fern x2
  (scale 1.8-3.2: the prefab is 0.25 m tall; spacing 1.5 / 1.9, 0.9 read as too many), creek lush grass
  0.5 / 0.25; `edge` = hazel x2, birch sapling, young pine; `brush` = low hazel, hazel shoot, birch
  sapling at scale 0.15-0.32 (the prefab is 4.7 m), pine sapling, young pine. Items shared with other
  mixes are bound by name with a density (`zones -- bind <course> woodland_floor --variant <key>
  "<item>=<density>" ...`), as for `shrub`.
- **Colour and light** of the NM small plants (shader `Advanced Grass Specular`): untouched they glow
  lime-yellow in sun. Every such item carries `"material": {"_BackFaceMirrorNormal": 1,
  "_SmoothnessPower": 0.1, "_AmbientOcclusionPower": 0.8}` and tints: bilberry and lingonberry
  `#7f9a72` / `#8a9470` (deep green), ferns `#a3b89b` / `#98a48c` with AO 1, heather its own near-neutral
  `#bdb6b6` / `#a59f9a` (the bilberry green turned its flowers brown). `golfmap.grass.apply` sends the
  tints through VSP's NM grass controller (`HealthyColorTint`/`DryColorTint`); setting the material's
  own colours does nothing, VSP overwrites them when it draws.
- **VSP takes foliage only**: stumps, logs, branches and ground rocks are on Unity's `Standard` shader,
  which `golfmap.grass.apply` refuses (GSPro's VSP does not know it). Deadwood and stones need to be
  scene objects, not palette items. NM's `Prefab_grass_02_*` tufts render straw yellow.
- The brush was first too thin to notice (thresholds 0.35..0.5 and 6-11 m spacing: 1 ha of drifts on
  20 ha of floor). Now 3 ha at more than half weight; judge it at its densest spots (the mask's item
  channel, or `golfmap.vegpalette.spots`), a random forest view may hold none.
- Open: nothing is tuned against the ground by measurement yet; frame cost not compared before/after.

## Rocky lake shore (`rock_shore/<variant>` zones, pipeline/rock_shore_zones.py)

Bare rock with grass in its cracks, scrub hugging it, heath on the thin soil, where a course meets a big
lake over granite (Omberg's 14th green on the cliffs along Vättern, 2026-10-16). Runs after the woodland
floor and before the creek banks; `--only rock-shore`. Only on the shore: within 40 m of the largest water
body (2 ha or more) and on or within 10 m of a rock slab cut into its own mesh (surface class Slab); a rock
in the woods gets nothing. Slope from the DEM at 0.5 m (ledges are a metre or two). Rules and constants in
the module doc; tuning flags `--lake-reach --slab-reach --crack-cover --heath-cover --scrub-band --shore-band`
(or the course's vegetation-rules.json, key `rock-shore`).

- `crack` (mix): VSP texture grass and moss on ~35 % of the slab, favouring ledges, none on faces over 70°,
  plus a ragged fringe in over its edge and a skirt beside it. `grass` (mix): under and between the scrub.
  Both at about 1.75x the tall rough's texture density.
- `heath`: sparse patches on the ledges and 3 m out. Heather and lingonberry are `prefabItemsInVsp` on
  Omberg, so the course's VSP draws them, not Arborist.
- `scrub` (replace): Arborist bushes 0.5-8 m out from the slab (full to 2.5 m, 0.3 at 8 m) and along the
  lake within 25 m, in clumps that close up against the rock.
- Omberg's palettes `rock_shore/crack|heath|scrub|grass` in its grass-palette.json, bound with
  `zones -- bind <course> rock_shore --variant <v> --palette docs/gspro/<course>/grass-palette.json`.
- The trees export keeps every lidar stem on a `riseMode: dem` slab (its scrub and low pines); other slabs
  still drop stems under 6 m as rocks.

## Patched fields (hand-drawn variant zones inside a deep rough field)

A deep rough field that should read as several covers is a set of **hand-drawn** `rough_tall/<variant>`
zones tiling it. Vreta, between 15 and 17 (deep_rough `eb42b6b1`, `39609929`, `9224059c`, 2026-10-10,
from the 26 Sept reference photos): `blond` (closed straw sward on an olive foot - the `fresh` textures
and density, straw tints), `hummock` (low dull tussocks along the rim and the pale north band) and
`weedy` (thistle heads, dark seed stems, dry umbels over an olive base).

- **Re-planting keeps them**: Update vegetation / `grass:zones` replace generated zones only, and a drawn
  replace zone takes its ground from the generated tall rough under it. Checked by a real re-plant: same
  zone ids, standard tall rough 0.00 in the fields' mask.
- **Soft borders are the default**: a drawn replace zone's mix fades into its neighbours (other
  patches, the generated tall rough, the woodland floor) over `edgeBlend` metres, 8 m when unset,
  along a border that wanders; only the mix changes, so the field still ends at its `feather`
  against a path or mown rough (D-VZ16 in `docs/feature-vegetation-zones.md`). Hard border:
  `bun run zones -- set <course> <zone> --edge-blend 0`; wider: a number; back to default:
  `--edge-blend default`. Keep the patches' `--feather 0.5`: that is the edge against bare ground.
  History: 4 m with a straight linear ramp read as "still a rather hard line".
- **Bush height per zone**: `bun run zones -- set <course> <zone> --height 2-3.5` (or "Bush height" in the
  selection panel; `none` clears it) scales the zone's bushes to that many metres, mostly near the min with
  bumps up to the max; grass is not touched (D-VZ17). The first height on a palette needs Update vegetation
  (or `gspro:export zones:<terrain>`, `golfmap.zones.import`, `golfmap.grass.apply`): the importer makes
  `<item> @height` twins. Later changes go through **Update N zones**. A height is size, not spacing: for a
  closed screen use a dense palette (Vreta: `shrub/dense`, cottonwood canopy and grey willow at 2.4-3.4 m
  spacing with no density noise; hole 5's hedge by the green).
- **Tile, never overlap**: drawn zones add up, so two overlapping patches plant double. Cut the field
  into disjoint polygons and load them in one go: `bun run zones -- add <course> rough_tall
  --from-geojson <file> --feather 0.5 --noise 0` (`properties.variant` per polygon).
- **Patches for another field**: `pipeline/rough_patches.py <out.geojson> <preview.png> <deep_rough id>`
  reads them off the orthophoto (dark + textured = weedy, pale mottled + a ragged rim = hummock, rest
  blond); look at the preview before adding. Seeded per field id, so a re-run on a planted field gives a
  new layout: remove that field's patch zones first. A patch is an ordinary zone in the web editor.
- **A moved field outline does not move its patches**: they are copies of the outline at the time. After
  reshaping the deep rough, remove the field's patch zones and cut it again.
- **Colour targets** (same shot, linear luminance, against the mown rough beside the field): blond ~2.0x,
  hue ~44, less saturated than the rough; hummock ~1.0-1.2x (first pass rendered as bare red soil: brown
  tufts sparse, tussock tint light); weedy ~0.8x the blond. Open: hummocks read as a flat mat at eye height.

## Later: variety

Other lower vegetation = more zone types (`shrub` has a palette on Vreta; `fern`, `meadow`, `woodland_floor` exist)
with their own palettes in the same file and their own rules in grass_zones.py-style generators;
the mask budget lets a zone on top claim its weight first. Within one type, variants
(`bun run zones -- bind <course> rough_tall --variant dry <item>=0.6 ...`, then
`zones -- set <course> <zone> --variant dry`) give a zone its own item mix. An item shared by
variants is fine: its channel is the sum over the slots that bind it (D-VZ11).
