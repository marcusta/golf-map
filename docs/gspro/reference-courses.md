# Reference courses: how five good-looking GSPro courses are set up

Measured 2026-10-12 on the installed courses Tobacco Road, Royal New Kent (RNK), Pebble Beach (all
CE.Simgolf), Koasati Pines (GSPro/JPruitt10) and The Federal. Numbers are read out of the loaded
scenes, not estimated from pictures.

## How it was read

- The `.gspcrse` bundles are encrypted and were left alone. Each course was opened in **Arborist**
  (it loads any course) and read through the player bridge (`unity/ArboristMod`), with three
  read-only commands added for this: `look` (render settings, lights, cameras, post-processing and
  fog components, VSP settings per item, shader use), `mesh.bunkers` / `mesh.classes` / `material`
  (bunker rings, paint, material channels) and `veg.surfaces` (which painted vegetation stands on
  which mesh).
- GSPro's own light sliders per course are in the unencrypted `<course>.lrsV2` / `.lrsV35` next to
  the bundle (.NET BinaryFormatter, class `LightSettings`).
- Not readable in Arborist: components whose scripts Arborist lacks (`CourseOverrides` and one
  script on the main camera in every course). The course's own `Directional Light` is inactive in
  Arborist; in GSPro the sun is driven by the `.lrs` values below.
- CE's materials index into his own texture arrays (`CEArray_Detail_Textures_MAHS_2048`, 70
  slices; `CEArray_Normal_Textures_1024`, 35). Which picture a `DetailIndex` is was not identified.

## Light (GSPro `.lrs` + scene)

| | Tobacco Road | RNK | Koasati | The Federal | Pebble Beach |
|---|---|---|---|---|---|
| Enviro sky | on | off | off | off | on |
| SunIntensity | 1.2 | 1.2 | 1.2 | 1.35 | 1.1 |
| Sun colour (scene light) | 0.99/1.00/0.93 | 1.00/0.99/0.90 | 1.00/0.98/0.87 | 0.90/0.95/0.84 | 1.00/1.00/0.95 |
| Sun elevation (scene light x) | 47.7° | 45.6° | 50.7° | 60.2° | 72.5° |
| ShadowStrength (.lrs) | 0.99 | 0.65 | 0.86 | 0.72 | 0.89 |
| Shadow type / bias / normal bias | Soft / 0.175 / 0 | Soft / 0 / 0.5 | Soft / 0 / 0.25 | Soft / 0.05 / 1.01 | Soft / 1.06 / 1.01 |
| EnvIllumination | 1 | 1 | 1 | 1 | 1.2 |
| Ambient mode / intensity | Trilight / 1 | Trilight / 1 | Trilight / 1 | Trilight / 2.77 | Trilight / 1.2 |
| Ambient sky | 0.82 grey | 0.68/0.65/0.59 | 0.85/0.86/0.77 | 0.86/0.92/0.86 | 0.79/0.89/1.00 |
| Ambient equator | 0.63 grey | 0.64/0.62/0.50 | 0.49/0.61/0.61 | 0.54 grey | 0.30/0.24/0.18 |
| Ambient ground | 0.08 grey | 0.17 grey | 0.11/0.10/0.08 | 0.25 grey | 0.16/0.15/0.12 |
| Reflection intensity | 1 | 1 | 0 | 1 | 1 |
| Skybox (`Skybox/Cubemap`) exposure / tint | 0.58 / 0.50 | 0.77 / 0.53 | 1.15 / 0.45 | 0.53 / 0.53 (Panoramic) | 0.75 / 0.46-0.56 |
| SkyBoxBrightness (.lrs) | 0.43 | 0.53 | 0.45 | 0.50 | 0.52 |
| BlueTint (.lrs) | 2.82 | 2.82 | 1.35 | 1.35 | 2.58 |
| Saturation slider (.lrs) | 0.64 | 0.67 | 0.66 | 0.67 | 0.63 |
| Bloom slider (.lrs) | 2 (Enviro 1.0) | 2 | 2 | 0.65 | 2 |

Common to all five: Fill, Bunker, Grass3D and Green light intensities are 0 (sun + ambient only);
volume lighting and sun shafts on; Unity's own fog is **off**; rendering path Deferred; no HDR or
MSAA on the camera; `PostProcessLayer` antialiasing SMAA High.

## Fog

All use OPCD's `GradientFogGO` (object `GradientFog`), never `RenderSettings.fog`.

| | tint | intensity | start | end |
|---|---|---|---|---|
| Tobacco Road | 0.86/0.84/0.77 (warm) | 1.85 | 0 | 2000 |
| RNK | 0.49/0.55/0.56 (cool grey) | 2.2 | 0 | 3000 |
| Koasati | 0.75/0.83/0.81 | 5 | 150 | 5000 |
| The Federal | 0.91 grey | 1 | 500 | 1000 |
| Pebble Beach | 0.57/0.69/0.74 (blue) | 2.2 | 350 | 1000 |

`VolumetricLight` on the sun where present (RNK, Koasati, Federal): SampleCount 8, Scattering 0.01,
Extinction 0.01, SkyboxExtinction 0.5, MieG 0.15, Noise on (intensity 0.08, offset 0.4), MaxRayLength
500, renderer at Half resolution.

## Post-processing (PPSv2, one global volume, weight 1, priority 1)

The shared recipe: **ACES tonemapper in HDR grading, post exposure about +2, saturation about −30,
the blue mixer channel moved, lift/gamma/gain trackballs, AO with a warm dark colour, wide soft
bloom.** The tone curve rows below are overridden in every profile, but in the Post Processing
Stack v2 the tone curve parameters only act when the tonemapper is `Custom`; with `ACES` they
should be inert (from how PPSv2 works, not tested here). Do not spend time copying them.

| | Tobacco Road `CE_ACES_02092025_PPV` | RNK `v4_CE_RNK` | Koasati `v4_CE_Shadow` | Federal `v4_GoldenHour AI Help` | Pebble `v4_CE-PP Pebble 1` |
|---|---|---|---|---|---|
| Bloom intensity / threshold / softKnee / diffusion | 3.5 / 0.23 / 0.44 / 4.7 | 3 / 0.25 / 0.73 / 3 | 5 / 0.4 / 0.73 / 7 | 3 / 0.3 / 0.3 / 6 | 2 / 1 / 0.5 / 7.5 |
| Bloom colour | 0.76 grey | 0.76 grey | 0.76 grey | white | 0.76 grey |
| AO mode | ScalableAO, High | ScalableAO, High | MultiScaleVO | MultiScaleVO | MultiScaleVO, High |
| AO intensity / radius | 1.72 / 0.2 | 0.5 / 0.75 | 1.4 / 0.22 | 1.19 / – | 0.5 / 0.25 |
| AO colour | 0.19/0.17/0.12 | 0.22/0.21/0.21 | 0.13/0.12/0.11 | 0.26 grey | 0.28/0.25/0.10 |
| Post exposure | 2.1 | 2.0 | 2.23 | 2.2 | 2.05 |
| Saturation | −30.8 | −29 | −30.3 | −40 | −33.9 |
| Contrast | – | −2.6 | −4.1 | +30 | −4.1 |
| Temperature / tint | 9.3 / – | – | – | 5 / 2 | 16.1 / – |
| Hue shift | −2 | −6 | 1 | – | −2 |
| Tone curve toe strength / length | 0.20 / 0.60 | 0.08 / 0.60 | 0.08 / 0.60 | 0.08 / 0.60 | 0.38 / 0.66 |
| Tone curve shoulder strength / length / angle | 0.37 / 0 / 0.21 | 0 / 0.12 / 0.26 | 0 / 0.12 / 0.26 | 0 / 0.12 / 0.26 | 0.22 / 2.14 / 0.26 |
| Tone curve gamma | 0.61 | 0.58 | 0.58 | 0.58 | 0.58 |
| Mixer R (R,G,B in) | 109, 9, 0 | 94, 2, 0 | 92, 0, 0 | 84, 0, 2 | 84, 0, 0 |
| Mixer G | 0, 108, 7 | −1, 93, 0 | −10, 91, −3 | 0, 100, 0 | 0, 102, 0 |
| Mixer B | 0, 0, 119 | 0, 0, 61 | 0, 0, 56 | 4, −32, 124 | −2, −14, 115 |
| Lift (r,g,b,w) | 0.99, 1, 0.88, −0.14 | 0.93, 0.94, 1, −0.20 | 0.93, 0.94, 1, −0.05 | 0.96, 1, 0.93, 0.03 | 0.85, 1, 0.87, −0.04 |
| Gamma (r,g,b,w) | 0.98, 1, 0.91, −0.07 | 0.88, 0.88, 1, 0.09 | 1, 0.95, 0.86, −0.11 | 0.96, 1, 0.85, 0 | 1, 0.95, 0.99, −0.08 |
| Gain (r,g,b,w) | 0.91, 0.97, 1, −0.18 | 1, 0.92, 0.86, 0.09 | 0.91, 0.91, 1, −0.14 | 0.97, 0.59, 1, 0.21 | 1, 0.68, 0.87, 0.16 |
| Vignette intensity / smoothness | off | 0.305 / 0.12 | 0.358 / 0.1 | 0.2 / 0.31 | off |
| Extras | – | hueVsSat + lumVsSat curves | lumVsSat curve | DoF on (80 m, f/0.85, 92 mm), grain 0.14, chromatic 0.011 | – |

Depth of field, grain and motion blur are present but off everywhere except The Federal.

## Which values to try first for the dense, dark forest look (a judgement, not a measurement)

Written 2026-10-13 after Vreta's ambient ground (0.50 → about 0.11) and saturation (−0.7 → −18) were
brought toward the references. Ordered by how much I expect each to change the picture:

1. **Shadow strength** (Vreta 0.556, references 0.65–0.99, the two forest courses 0.65 and 0.99).
   With the dark ambient ground it decides how black the forest floor and the inside of the wall get.
2. **Bloom threshold** (Vreta 1.2, CE's forest courses 0.23–0.25 at intensity 3–3.5, colour 0.76
   grey). Above 1 almost nothing blooms; at 0.25 every sunlit surface glows a little, which is the
   soft, slightly hazy light on grass and crowns. Pebble Beach is the one reference at 1.0.
3. **Fog** (references on the forest courses: start 0, end 2000–3000, intensity 1.85–2.2, a tint
   that is not white). It separates the near trees from the far wall; without it the wall reads flat.
4. **AO intensity and radius** together with the warm dark AO colour already set (Tobacco Road 1.72
   / 0.2, RNK 0.5 / 0.75): contact darkness under bushes and at trunk feet.
5. **Blue mixer and trackballs**: warmth only. RNK and Koasati pull blue down (61, 56) for a yellow
   warm picture; Tobacco Road pushes it up (119) and warms with temperature 9.3 instead. Taste.
6. **Sun elevation** (Vreta 34°, references 45–60°): a time-of-day choice the player can also move
   in GSPro; a lower sun gives longer shadows, so it is not obviously wrong for a forest course.
7. Tone curve: skip, see above.

Remaining saturation: Vreta is at −18, every reference is at −29 to −40.

## Vegetation Studio Pro

None of the five uses Arborist data (`IsArborist: false`); the course scenes carry their own VSP
(OPCD's build of it, same fields as Arborist's).

| | Tobacco Road | RNK | Koasati | The Federal | Pebble Beach |
|---|---|---|---|---|---|
| Painted (stored) instances | 17 547 | 4 057 326 | 1 713 | 3 407 041 | 2 379 |
| PlantDistance | 400 | 500 | 300 | 400 | 300 |
| Additional tree mesh distance | 100 | 150 | 100 | 150 | 300 |
| Additional billboard distance | 3000 | 3000 | 2250 | 2250 | 5000 |
| Shadows grass / plant / tree / billboard | off / off / on / off | same | same | same | same |

Grass and plant density 1 everywhere, LOD distance factor 1; cell size 100 and billboard cell 500
where checked (Tobacco Road, Koasati).

### Grass

- Mostly **mesh grass** from NatureManufacture (`Prefab_grass_01_*`, `_02_*`, `_03_*`,
  `prefab_grass_meadow_*`, shader `NatureManufacture Shaders/Grass/Advanced Grass Specular`) on
  Tobacco Road and RNK; mostly **2D textures** (`Sea Grass_06/07/09`, `Wheat_03`, `Rustic Grass_03`,
  `grass_9`, shader `AwesomeTechnologies/Grass/Grass`) on The Federal and Pebble Beach; Koasati both.
- Sample distance 0.4–1.8 m is typical (RNK 0.4–0.7 on the big items, Federal 0.4–0.6, Pebble
  0.5–1.1, Tobacco Road looser at 0.6–3.5). Noise density scale 5 on nearly everything.
- Scale: short rough 0.25–0.4 (RNK Light Rough), ordinary 0.8–1.8, big tufts 3–4.5
  (`Prefab_grass_02_A_1`).
- Short grass gets a very small render distance factor (RNK Light Rough 0.10–0.25, Koasati Rustic
  Rough 0.02–0.07) so it only draws near the camera; taller grass 0.5–1.
- Rotation `FollowTerrainScale` almost everywhere. Item shadows mostly off.
- Tints are yellow-olive, not green: Tobacco Road `#99a153/#838c41`, `#a8a073/#9f9071`; RNK
  `#7f902c/#8e8b30`, `#bcba51/#a89f45`, dry meadow `#e5c362/#f7c66b`; Koasati `#b3c04f/#abb448`;
  Pebble `#577657/#3c6c3c`; Federal dark and grey `#475446`, `#4a633e`. Alpha cutoff 0.15–0.5 on mesh
  grass, 0.04–0.2 on textures; texture grass RandomDarkening 0.31, RootAmbient 0.63.
- RNK and The Federal **paint** their grass (millions of stored instances, Federal with runtime
  spawn off); Tobacco Road, Koasati and Pebble Beach spawn it by biome rule and paint only details.

### Trees

- Assets: NatureManufacture forest pines (`Prefab_Forest_pine_01/03/04/05/08`), `VS_prefab_0x_Poplar`,
  `DA_Forest_Tree_8722 / 16727` (also `_FALL`), `Canopy Bush`, `Canopy Tree *`, CE's own oaks,
  hickories, birches, junipers. Shaders `NatureManufacture Shaders/Trees/Tree_Leaves_Specular` and
  `Tree Bark Specular / Metalic`. The Federal and Pebble Beach add Arboreum (oaks, fir, Monterey
  cypress) and a few SpeedTree.
- A forest is three layers. RNK's numbers:
  - **Outer forest** (far wall): `Prefab_Forest_pine_05` 27 458 at sample 14.4 m, `VS_prefab_05_Poplar
    - 6k` 20 146 at 19.5 m, `DA_Forest_Tree_8722_FALL` 13 895 at 22.5 m, scale 0.8–1.35, render
    distance factor 0.61–0.74, **LODFactor 0.17–0.2** (drops to low LOD early).
  - **Forest** next to play: pines at 10–15 m, poplars 11–12 m, `Canopy Bush` 5 117 at 5 m and scale
    1.47–1.87 as the understory, LODFactor 0.57–0.91.
  - **Persistent** (hand-placed specimens): junipers at 7.6 m, pine_tree_00_B scale 1.2–2, Canopy
    Bush scale 2–3.
- Billboards: quality Normal, cutoff 0.2, desat 1, normal strength 1 nearly everywhere; **brightness
  is tuned per item, 0.25–1.1** (broadleaves 0.3–0.5, pines 0.5–0.95), tint pale yellow-green
  (`#c2cf9b`, `#d5ddbd`, `#e0e7c3`). Koasati and The Federal keep a separate billboard-only package
  (render distance factor 0, nothing stored) that mirrors the forest trees.
- Tree scale is modest: 0.8–1.2 for most, up to 1.7.

## Stix 3D grass on the meshes

Short grass is Stix (`StixGames.GrassShader.GrassRenderer` + `NatureMeshFilter`, shader `Stix
Games/Grass Forward Only`, keywords `VERTEX_DENSITY`, `GRASS_PBR_LIGHTING`,
`GRASS_HYBRID_NORMAL_LIGHTING`, shadow casting off). It sits on rough, deep rough, pinestraw, water
base and on **fairway blends and bunker blends**; not on bunker meshes (one exception on RNK, a
bunker-named mesh with a deep rough material), fairways, greens or tees.

| material | blade heights (types 0/1/2) | width | TargetDensity | fade | disorder |
|---|---|---|---|---|---|
| `3dg - TR Rough` (2 types) | 0.03–0.05 / 0.01–0.03 | 0.008 | 0.05 | 10–40 m, LOD max 2 | 2.26 |
| `3dg - TR Deep Rough` (3 types) | – / 0.10–0.16 / 0.22–0.32 | 0.008 | 0.10 | 20–75 m, LOD max 3 | 2.3 |
| `3dg - F Rough` (RNK) | 0.04–0.08 / 0.01–0.03 / 0.02–0.05 | 0.008 | 0.04 | 10–40 m | 2.2 |
| `3dg - F Deep Rough` (RNK) | – / 0.09–0.15 / 0.28–0.44 | 0.01 | 0.099 | 10–60 m | 1.55 |

`NatureMeshFilter`: MeshSubdivision 1, EdgeSplitThreshold 1.5, MinEdgeSize 0.8, NormalizeTriangleSizes
off. `DisableGrassRenderer` maxDistance 300. Blade colours are yellow-green (`#b0c05f` / `#6b7829`,
second type straw `#c5bea0` / `#b6a98e`); the colour map is the course's satellite image.

## Bunkers

Every course mesh carries VertexPainterPro runtime components (`ShowVertexColors`, `AddPalette`,
`VertexInstanceStream`): 87 of 114 bunkers on Tobacco Road and 67 of 110 on RNK have **hand paint in
a stream on the renderer**, on top of what the recipe painted. `mesh.bunkers` reads the stream.

### Royal New Kent: the terraced lip (110 bunkers, 60 with a blend strip)

Seam spacing along the edge: median 9.9 cm (7.7–12.1). Normals match across the seam (0°).

Blend strip, counted out from the bunker, three rows at fixed widths:

| ring | from seam | height vs seam | paint |
|---|---|---|---|
| 0 (seam) | 0 | 0 | red |
| 1 | 2.1 cm | +3.0 cm | red 43 % / blue 57 %, random per vertex |
| 2 | 7.1 cm | +6.8 cm | green 59 % / blue 41 % |
| 3 (meets the rough) | 12.0 cm | +8.2 cm (5.8–13.6 over the course) | green |

Bunker, counted in from the seam:

| ring | from seam | height vs seam | paint |
|---|---|---|---|
| 0 | 0 | 0 | red |
| 1 | 1.0 cm | −1.9 cm | red 67 % / green 33 %, random |
| 2 | 3.0 cm | −4.6 cm | green 83 % / red 16 % |
| 3 | 5.5 cm | −6.8 cm | green |
| 4 | 11.6 cm | −10.4 cm | green |
| 5 | 22.6 cm | −14.9 cm (−11.6 to −20.8) | green |
| 6 | 39.5 cm | −20.3 cm | green |
| 7 | 69 cm | −27.6 cm | green, blue begins |
| 8–10 | 1.0 / 1.35 / 1.7 m | −35 / −41 / −46 cm | blue share 16 → 48 % |

So the edge is a rolled lip of about 15 cm in 17.5 cm (rough at +8 cm, 12 cm outside; sand at −7 cm,
5.5 cm inside), no vertical wall, no overhang, and the face keeps falling gently to about −45 cm at
1.7 m. Ring spacing roughly doubles inward. No black anywhere in RNK.

Materials (shader `OPCD/OPCD 4 color Vert Paint MAHS steep flat slope`):

- `CE_White_Bunker_Sand`: red = lip soil (detail 4, base 2, tiling 0.9, grey 0.72, blend strength
  2.9); green = sand (detail 32, base 4, tiling 0.5, blend strength 8, colour 0.93); blue = the same
  sand at tiling 1 with a cool tint 0.79/0.91/0.95 (the bunker floor); black unused.
- `F BLEND Sand` (the strip): red = the same lip soil (detail 4) at blend strength 10; green = rough
  grass (detail 54, tiling 5.3, 0.83/0.91/0.48); blue = a second grass (detail 8, tiling 3,
  1.0/0.95/0.56, yellower); black unused. The strip also carries Stix grass (`3dg - F Rough`).

### Tobacco Road: sandy waste edges (114 bunker meshes, no blend strips)

Bunkers meet rough and deep rough directly. Seam spacing median 15.4 cm.

| ring | from seam | height vs seam | paint |
|---|---|---|---|
| 0 | 0 | 0 | red 69 % / green 31 % |
| 1 | 5.3 cm | −5.0 cm | green 56 % / black 25 % / red 19 % |
| 2 | 12.8 cm | −10.6 cm | green 88 % / red 11 % |
| 3 | 25 cm | −16 cm | green |
| 4 | 45 cm | −22 cm | green |
| 5 | 74 cm | −26 cm | green |
| 6–10 | 1.15 – 3.3 m | −33 to −56 cm | blue share 8 → 59 % |

`TR Sand`: red and black = ochre soil (detail 34, base 2, tiling 3.5, colour 0.75/0.60/0.20; red at
blend strength 10, black at 0.001); green = sand (detail 44, base 5, tiling 6.3); blue = the same sand
at tiling 3.5 for the floor.

### Grass growing in the sand

Not a material effect. It is two things on top of each other:

1. **A patch painted red inside the bunker mesh** (64 of Tobacco Road's bunkers have some, 9 456
   vertices in all): red is the ochre soil channel, so the sand turns to bare ground there.
2. **VSP mesh grass painted onto that patch by hand** (the `Persistent Biome`, runtime spawn rules
   not involved): on Tobacco Road's bunker meshes 1 729 × `Prefab_grass_01_4` (scale 1.38–1.78),
   495 × `Prefab_grass_02_A_1_COLLIDER` (the big tuft, scale 1.6–4.2; a collider variant by its name),
   123 × `prefab_grass_meadow_03_5`, a few heath, willow and bushes.

The same bunker class is also used as bare ground under trees (waste areas with a mix of red and
green paint and sparse painted grass).

## For our Afrod / shaping recipes

We already replay `cesimgolf-Conway_Bunker_Standard.json` (`blender/recipes/golfmap-bunker-studio-conway.json`).
What the measurements add:

- **A target to verify against.** The RNK tables above are the finished result of his method; a
  recipe run can be checked ring by ring (distance, height, paint share) instead of by eye.
- **The lip is in the blend as much as in the bunker.** Three blend rows at 2 / 7 / 12 cm raised
  3 / 7 / 8 cm; our Bunker Studio step leaves four rows at other widths, so `ringsFromSeam` gives the
  right ring but not his geometry. A metric step (rows by distance from the seam, the plan in
  `blender/RESEARCH.md`) can hit these numbers directly.
- **Paint is mixed per vertex, not banded**: rings 1–2 on both sides are a random mix of two
  colours (43–67 %), which is what `randomvertexpaintloop` with `random_amt` 1 gives. Our
  `golfmap.edge_jitter` does a similar job; the shares above are the calibration.
- **RNK's blend convention is red at the seam, blue next, green at the rough**, and no black. In
  `blender/conventions/bunker-channels.json` the `ce-simgolf` blend entry (`inner: blue`, `outer:
  red`, unverified) does not match RNK; not changed here.
- **Seam density**: 8–12 cm between seam vertices on RNK, 13–24 cm on Tobacco Road.
- **Grass islands** need no mesh work: red paint inside the bunker plus painted VSP grass.

Not measured: the same rings on Pebble Beach, Koasati and The Federal; which textures the detail
indices are; what `CourseOverrides` holds.
