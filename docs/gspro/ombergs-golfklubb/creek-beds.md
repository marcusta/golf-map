# Omberg creek beds

A creek 0.7 m wide and 0.7 m deep (Marcus, 2026-10-18, hole 17's creek `hole_17_233`) cannot be carried by the
course meshes: their triangles are 1.2 m, `terrain.obj` is a 0.74 m grid and Vertex paint features under 2 m do not
survive. The DEM (0.5 m, `creek-digs`) holds the groove; Blender cuts it into a mesh of its own.

**The chain**

1. `creek-digs`: `bun run terrain:generate -- "Ombergs Golfklubb" creek-digs --feature hole_17_233 --depth 0.7 --bank 40`
   (DEM: 0.55-0.73 m under the ground 3 m aside, about 1 m wide at half depth).
2. Blender: [shaping-pending/20-creek-beds.json](shaping-pending/20-creek-beds.json) (parked outside shaping/ until the worker is restarted and Marcus decides; move it back to shaping/ to apply), one `golfmap.cut_out` per creek: the corridor (the
   centerline +-1.2 m minus the ponds + 1.5 m: their meshes are protected) is cut out as
   `Spline_brook_h17_WaterBrook_-_Mesh`, refined to 0.2 m triangles and set to the edited DEM (`rise` mode `dem`, apron
   1 m, the granite shaping off). `WaterBrook` is the one surface a cut-out may give that holds a golf word (shape_layers
   `CUT_OUT_WATER_SURFACE`): Unity's `Classify` reads Water from it, so no vegetation grows in the creek.
   Then `golfmap.creek_channel` (`shape_creek.py`, [shaping-pending/20-creek-beds.json](shaping-pending/20-creek-beds.json) op `brook-h17-channel`)
   cuts the channel itself into that mesh: a flat bottom `depthM` 0.7 under the ground beside the creek (median of the bed vertices
   1.0-1.2 m from the line), `widthM` 0.7 wide, walls `wallM` 0.15, easing in over `rampM` 1.5 from each end; the mesh border is not
   moved. Needed because the DEM alone leaves a V (its 0.5 m cells and the 1 m bank taper): 0.3-0.4 m deep beside the line. Test on
   `svg_110.conformed`: bottom 0.7 m wide, walls 0.15 m, 0.7 m under the shoulder, the cut 8 s + the channel 0.03 s.
3. Unity (`paint.json` rule `creek-bed`, kind `object`, [unity/README.md](../../../unity/README.md) "Vertex paint"): black
   vertex paint from `fadeM` 0.5 inside the border (the bed meets the ground around it), on a copy of the nearest rough's
   material whose black channel draws pebbles (NatureManufacture River Auto Material `T_Ground_Pebbles_01`, 1.2 m a tile,
   tint 0.5/0.5/0.48). Black is no 3D grass. Baked into `PaintedMeshes/` by `golfmap.paint.apply`, which `course.refresh` runs.
4. R.A.M.: export + import creeks again so the water fits the new bed (`aboveBedM` 0.15 over its lowest ground).

**Order after the DB change**: Update terrain (the inner DEM the cut reads) -> terrain_obj -> the shaping run (worker restarted:
it imports `shape_layers` once) -> `golfmap.meshes.sync` / refresh -> `golfmap.paint.apply` -> `gspro:update creeks`.

**Another creek**: add its corridor as another op in the same layer (a new name `brook_<something>`), `--feature <shape>` the dig.
**Tune**: bed width = the corridor buffer; depth = `--depth`; pebbles/tint in `paint.json`, then `golfmap.paint.apply`.

**The water in it** (2026-10-19): the brook wears its own copy of R.A.M.'s water material, `Creek water (hole 17).mat` in the
course's Creeks folder (a copy of `Creek water (Small Stream Profile).mat`; colours `_DeepColor` 0.045/0.05/0.065 and `_ShalowColor`
0.07/0.075/0.09, `_Foam` 0.5, `_FoamCascade` 4, `_WaterSpeed` 0.3, `_Reflection` 0.45: the ponds' dark navy-grey, little white water). It is set on the feature,
so every `creeks.import` keeps it: `ramWaterMaterial` (asset path) and `ramAboveBedM` 0.25 (the water 0.25 m over the bed, +0.10 m on the
import's 0.15) -> the creeks export (`waterMaterial`, `aboveBedM`) -> `GolfMapCreeks`. The black paint stops 0.1 m under the grass level (paint.json
`belowM` 0.1, `softM` 0.08), so a grass lip stands at the top of the bank.

**Creek 575 at pond 239** (hole 9's outlet by the stone bridge, 2026-10-19): the profile's pale blue water lay as a hard
wedge on the pond's dark AQUAS water. Two fixes: creek 575 wears hole 17's material too (`ramWaterMaterial` set on the feature,
the same asset, so one material tunes both), and `creeks.import` now fades every creek's water out over a lake it runs into
(`pondFadeM` 2 m, vertex alpha; see [unity/README.md](../../../unity/README.md) "Creeks"). The white patch below the
bridge is fall G's cascade foam, not the seam.

**Where the black stops, per side** (feature `hole_17_233`, attributes `grassBelowLeftM` 0.3 and `grassBelowRightM` 0.2, left/right looking
downstream = looking north there: left = west): the paint rule `creek-bed` names the creek (`creek`), the creeks export carries the two numbers, and the
paint takes them per side of the creek's line (`belowM` 0.1 is the fallback, `softM` 0.08 the blend). `grassFrom: rough` gives the brook mesh the nearest
rough's Stix components (NatureMeshFilter, grassonoffnew, GrassRenderer), so its red lip grows the same 3D grass as the rough all the way to the black
edge, and the black (red 0) grows none.

**Hole 17's ponds, the light halo at the shore** (2026-10-19): the shallow shelf shows the lake bed's pale material through the water. paint.json rules
`pond-shore-230` / `pond-shore-231` (kind `object`, `shoreM` 0.6, `softM` 0.3): the bed vertices less than 0.6 m under the water's edge are painted red, and the
ponds' own copy of the lake material (`Assets/GolfMap/Omberg/Ponds/OPCD MAHS Water Base Lake_Sat (pond 17).mat`, the other lakes keep theirs) draws the nearest
rough's red channel (copyFromRough), the same grass as the bank, with green and blue 10 % darker (scaleGreen/scaleBlue 0.9). A steeper bank (the dig's
`digBankSlopeDeg`, shelf) would shorten the shelf itself but needs a terrain bake and the Blender replay: not done.
