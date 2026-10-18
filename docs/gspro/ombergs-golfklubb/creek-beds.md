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
