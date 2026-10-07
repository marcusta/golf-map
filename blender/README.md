# blender

Blender tooling for the OPCD/GSPro course stage, starting with bunkers.

## Bunker paint conventions

`conventions/bunker-channels.json` describes each way of vertex-painting bunkers and their
blend meshes:

- **Paint:** for a bunker, the colour of each ring counted in from its seam (`rings`) and the
  colours further in (`interior`). For a blend, the colour on the edge it shares with the
  bunker (`inner`) and on its outer edge (`outer`).
- **Materials:** for each paint channel, which material (`$bunker`, `$blend`, `$outer` or a
  material name) and which of its channels fills it in Unity, with an optional `tint` (a
  value below 1 darkens it, e.g. the fake rolled-lip shadow on black) and `blendStrength`.

Three conventions ship:

| id | Bunker paint | Blend paint | Notes |
|---|---|---|---|
| `golfmap` | red grass lip, green dirt face, black shadow lip (no 3D grass), blue sand | red adjoining surface, green longer darker grass, black the adjoining surface too (was: browning toward the bunker) | Canonical: what the shaping engine leaves after any recipe (see "Recipe library"). Grass lip and shadow copy `$outer` (for a bunker mesh: what most of its blends fade to), shadow tinted `[0.88, 0.85, 0.8]`; dirt face tinted `[1.25, 1.15, 1.1]` (a little brighter, toward brown-grey; `tint` is a number or `[r, g, b]`). Blend: every channel the surround's red on the surround's base settings (`base: $outer`), so rough -> strip is seamless and the 3D grass (Unity lip material) runs to the sand, as in Marcus's references (2026-09-29). Built in Unity (`golfmap.course.refresh`). |
| `opcd-default` | red rim, green, then blue floor | red at the bunker, black at the rough | What OPCD conform and Adjust Bunker Vertex Painting produce. |
| `ce-simgolf` | red, red, black rings, then green sand (blue wet floor optional) | red rough outside, blue browning grass at the bunker | ce.simgolf's setup: black is the lip without 3D grass, darken it to fake a rolled-lip shadow. Blend side not yet verified. |

The Unity window `GolfMap > Bunker Materials` builds materials from this file and checks
the paint (see `unity/README.md`).

## Paint report

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b "D:/gspro_courses/vreta-opcd/vreta_svg_1602.blend" --python blender/tools/bunker_paint_report.py -- --convention ce-simgolf
```

This prints, for each bunker, the colour share of each ring and of the interior, and for
each blend its inner and outer edge, plus the best-matching convention. Results are
`ok` / `!!` against the convention you pass with `--convention`, and `--json out.json`
also writes the results as JSON. It never saves the `.blend`.

## FBX sync

OPCD's Batch Export rewrites every course FBX (~800 on Vreta), so Unity reimports all of them. `tools/fbx_sync.py`
exports only the visible meshes that changed since the last export. It uses the same file names and exporter call
as OPCD, and the same folder: the OPCD tools' export folder, else `<blend folder>/fbx`.

- **Install:** Edit > Preferences > Add-ons > Install from Disk > `blender/tools/fbx_sync.py`. The panel is in the
  3D View sidebar, **GolfMap** tab.
- **First time:** if the folder already matches the `.blend` (e.g. right after an OPCD Batch Export), click
  **Mark all as exported**. Otherwise click **Export all FBX** once.
- **After that:** **Export changed FBX** (or **Preview** for a dry run). An object is exported when its evaluated
  mesh (positions, faces, UVs, colours, other attributes), world matrix or material slots changed, or when its
  FBX is missing. Fingerprints are kept in `<folder>/.golfmap-fbx-sync.json` (Unity skips dot files).
  Fingerprinting all ~800 meshes takes about 5 s.
- FBX whose mesh object no longer exists in the `.blend` are deleted (**Delete FBX of removed meshes**, on by
  default, applies to all three buttons). OPCD renumbers and merges meshes when it regenerates the `.blend`, so
  the folder would otherwise keep old meshes that Unity still treats as current.
- Meshes whose name starts with a **Skip** prefix are never exported (default `Gap_Issue`: OPCD's gap-check
  markers), and their FBX already in the folder are deleted like removed meshes. Comma-separated; kept in the
  add-on preferences. Headless: `--exclude`.
- The folder is remembered in the add-on preferences, because a regenerated `.blend` loses both the panel's
  and OPCD's folder setting.
- **Then in Unity:** `GolfMap > Meshes > Sync from FBX folder` (see
  [unity/README.md](../unity/README.md#course-meshes-fbx-sync)).

Headless (never saves the `.blend`):

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b course.blend --python blender/tools/fbx_sync.py -- --dry-run
```

Flags: `--folder`, `--baseline` (mark as exported), `--all`, `--keep-orphans`, `--json out.json`.
`tools/fbx_sync_test.py` checks it on a course file in a temp folder (`-- --compare <OPCD fbx folder>` also
compares file sizes with OPCD's export).

## Shaping: prepare

Step 2 of [SHAPING-PLAN.md](SHAPING-PLAN.md). `tools/shape_prepare.py` takes a fresh OPCD `.blend` (Spline
meshes flat, no Terrain), presses OPCD's **Import Terrain OBJ** (`opcd.convertterrain`, Terrain Smooth from the
scene, default 1.5) and **Conform to Terrain** with Selection = All (Afrod Mod v4's `wm.projectmesh`: project
onto Terrain, then retry vertices the projection missed; `--conform opcd` = the OPCD Base button, no retry),
and saves a copy `<name>.conformed.blend` next to the source. The source is never saved.

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b "D:/gspro_courses/vreta-opcd/vreta_svg_1985.blend" --python blender/tools/shape_prepare.py -- --json "D:/gspro_courses/vreta-opcd/vreta_svg_1985.conformed.json"
```

Flags: `--terrain` (default `terrain.obj` next to the `.blend`), `--out`, `--json`, `--seed` (Afrod's retry
nudges), `--limit N` (smoke test: first N meshes only). The report lists vertices left at the flatten depth
(-100 m) per object, timings and the Terrain's bounds. Vreta (776 meshes, 4.0 M vertices, 644 MB OBJ): import
5 s, conform 83 s, no failures, 370 MB out. Positions in EPSG:3006 map into the `.blend` with
`tools/shape_coords.py` (SHAPING-PLAN.md, "Coordinates").

## Shaping: apply

Step 3 of [SHAPING-PLAN.md](SHAPING-PLAN.md). `tools/shape_apply.py` opens the conformed cache, replays the
course's shaping layers (`docs/gspro/<course>/shaping/NN-*.json`, `golfmap-shaping-layer-v1`, file-name order),
writes a report and, with `--export`, the changed meshes' FBX into a staging folder. Never saves the `.blend`.

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b "D:/gspro_courses/vreta-opcd/vreta_svg_1985.conformed.blend" --python blender/tools/shape_apply.py -- --layers docs/gspro/vreta/shaping --export
```

Flags: `--only <layer>|<op>|<layer:op>,...`, `--dry-run` (resolve selectors only), `--svg` (default: the `.svg`
next to the `.blend` whose path ids explain most `opcd_shape_id`s), `--sidecar`, `--report` (default
`<blend folder>/shaping-staging/shaping-report.json`), `--export [folder]` (default
`<blend folder>/shaping-staging/fbx`; refuses a Unity project; the FBX and manifest entries of objects the run
removed, e.g. the originals `golfmap.split_surfaces` replaced, are deleted: report `export.removed`), `--render <folder>` (Workbench before/after PNG
per op: paint for recipes, grey at 5x relief for the rest), `--no-cache`, `--cache-dir` (default
`<blend folder>/shaping-staging/cache`).

- **Selectors** (`feature`, `type`, `hole`, `kind` mesh/blend/any, `object`) resolve by feature id through the
  SVG (`data-feature-id`, `data-type`, hole from `hole_<n>_` or the `Hole<n>` layer) and the objects'
  `opcd_parent_id`/`opcd_shape_id` (whole SVG ids, longest match: split pieces `_pieceK`, `_holeN`, `_0` map to
  their feature). OPCD's own `Outer_Deep_Sat_*` meshes map to nothing.
- **Ops:** `afrod.flattentees`, `afrod.cutcartpaths`, `afrod.smoothcartpaths` (params = `scene.opcdtools`
  props), `afrod.recipe` (a recipe per feature: an Afrod file through Afrod's JSON runner, one command per call,
  or a golfmap composite recipe, see "Composite and parameterised recipes"; `recipe` relative to
  `$GOLFMAP_AFROD_RECIPES` (default `D:/gspro/afrod-recipes`), then `blender/recipes/`, or a recipe library id;
  `overrides` = `{<param id>: value, ..., "seed": int}` for the library entry's params (the older form, raw
  `scene.opcdtools` props merged into every step, still works for Afrod recipes); a step that fails puts the
  feature back as it was and adds a `stepFailed` warning), and
  `golfmap.flatten_footprint` (`footprint3006`, `level` median/mean/min/plane, `falloffM` smoothstep band outside
  the footprint, `offsetM`: XY-only, so seams stay welded; `protect` = golf-map types never moved, default
  green, bunker, water/creek/lake incl. their blends: every weight is scaled by a smoothstep of the XY distance
  to the nearest protected vertex over `protectBandM` (default `falloffM`), and a footprint that covers a
  protected vertex is skipped with a warning), and `golfmap.weld_tjunctions` (select = the cut meshes; also run
  automatically after every `afrod.cutcartpaths` unless `"weld": false`: each boundary vertex the cut added
  that lies within 1 mm of a neighbour's boundary edge splits that edge there, so smoothcartpaths' ripple
  moves both alike; boundary slivers the cut leaves (a new vertex < 1 mm from a welded one) are merged first,
  and a neighbour vertex < 1 mm away with no partner is snapped; then the cut's paint, below), and
  `golfmap.split_surfaces` (a merged road of mixed surfaces cut into one object per surface; section "Shaping:
  surfaces of a merged road"), and `golfmap.path_edge_fade` (the fringe strips of gravel / dirt paths widened into the
  path and painted as a noisy red-grass / green-path ramp; section "Shaping: path edge fade"). Any op may set `maxDzWarnM` (CLI `--max-dz-warn`, default 0.5 m): larger moves become
  report `warnings` with EPSG:3006 position and nearest hole; every op reports `movedByType`. Each Afrod call runs once per feature with the
  feature's objects selected, `scene.opcdtools` reset to its defaults plus the op's params, and `random` +
  numpy seeded with the op's `seed`, else the feature number (`data-feature-no`, or the hex of feature-number
  names), else a CRC of the feature id (old index names).
- **The cut's paint** (`afrod.cutcartpaths` `cutPaint`: `auto` default, `restore`, `keep`): Afrod paints every
  vertex on a cut plane blue - concrete expansion joints, for a path material whose blue channel is a joint
  texture; on any other path the blue shows as streaks (green in Unity's path materials). `restore`: every
  corner the cut painted (exactly (0, 0, 1), and not blue before) gets the path's own paint back (a new vertex:
  interpolated along the old edge it split; an old vertex on the plane: its old colour). `keep`: the joints stay
  blue, and two guard cuts 3 cm either side of each joint (bisect of the faces around it; their vertices get
  the path's paint, the weld closes their T-junctions) keep the blue to a thin line instead of a gradient over the
  neighbouring faces (a whole end cap when the cut crosses its fan). `auto`: per path feature from its golf-map
  `surface`: the SVG shape's own `data-surface` (only a grass track has one; the hard roads of the `svg` export
  are one merged shape per network without it, their surfaces are in the sidecar `<stem>-paths.json`;
  `source: "svg"`), else the op's `pathSurfaces` {feature id: surface}, else the app
  database read-only (`$GOLFMAP_APP_DB`, default `data/app.sqlite`; what a hard road falls back to):
  concrete -> keep, else (asphalt, gravel, unknown) -> restore (`shape_layers.cut_paint_decision`). Report
  `runs[].post.cutPaint` per path: mode, source, surfaces, and per mesh new vertices, corners
  restored, joint vertices, blue corners before/after (Vreta, all 11 path units restore: 37 k corners restored,
  0 blue before and after). Concrete paths need the Unity path material's blue channel set to a joint texture
  (Unity side, not done).
- **The cut's slivers** (`afrod.cutcartpaths` `sliverM`, default 0.05 m, 0 = off; before the weld): a cut plane
  passing a few mm from a vertex leaves new vertices mm-cm from it, and smoothcartpaths' topological z smoothing
  (`vertices_smooth` x `smooth_path_amt`) then puts cm of height between them: near-vertical micro faces whose
  normals draw a dark triangular smudge across the path in GSPro (Vreta, hole 13 tees: 8 cm over 6 mm). Each cut
  vertex within `sliverM` (XY) of a vertex of one of its faces is merged into it (old vertex first, shortest pair
  first, chains capped at `sliverM`; boundary cut vertices only along the outline). Report
  `runs[].post.slivers` (Vreta: 1381 merged; path meshes' steep faces 1098 -> 37, shading faults 641 -> 106).
- **Path surface check** (`checks.pathSurface`, also in the worker's sync report; a `pathSurface` warning when
  anything is steep or faulty): per path mesh, edges < `sliverM`, steep faces (normal z < 0.5), shading faults
  (vertex normal > 20 deg off the plane of its edge neighbours) and bumps (> 3 cm off that plane; the lidar
  gives a conformed path some, so they are only counted), with the worst fault's EPSG:3006 and hole.
- **Report:** per op status, targets, objects changed, vertices moved, max |dz| (nearest old vertex in XY
  where the topology changed), seconds, recipe step trace; unresolved selectors; meshes of shaped types no op
  touched; seam gaps (boundary vertices coincident in XY, |dz| > 1 mm, whole course before vs after) and
  NaNs; `changedPlaces` for Unity's Review window: one place per op unit (a tee, a path, a pad, a recipe'd
  feature) with `object` (the unit's target, else the object it moved most: Review resolves places by it),
  `objects` (those it moved >= 1 cm or created; ripple below 1 cm is left out, and a unit with none is no place),
  `featureId(s)`, `type` (`footprint` / the op's `origin` for footprint ops, which name their feature), `hole`,
  `maxAbsDz`, `op`, `opKey`, `unit`, `note`, centre and bounds over all its objects in blend, EPSG:3006 and
  Unity coordinates; the older per-object list is `changedObjectsDetail`; position/colour hashes of the touched
  meshes (replays must match).
- **Headless shims** (only around Afrod calls, add-ons unchanged): Blender's `mesh.loopcut` crashes in
  background mode (its preview draw callback needs a region type), so Afrod's `loopcut` gets an equivalent
  bmesh edge-ring subdivide; Afrod's `get_loop_at_depth`/`get_boundary_loop` (`list(set)`) and Edit Mesh
  Tools' `collect_loops` (`set.pop()`) are made order-stable, otherwise seeded recipes still differ run to
  run; `find_closest_vert` keeps its KD tree (same answers, minutes faster on long roads). After a recipe the
  engine puts back what Afrod's `meshblendseparate` breaks: the mesh comes back as `<name>.001`, the blend as
  `<mesh base>Blend` with the mesh's `opcd_kind`.
- **Speed shims** (same results, checked: positions, colour and FBX-fingerprint hashes of all 776 Vreta meshes
  equal with and without them; `GOLFMAP_SHAPE_NO_FAST_SHIMS=1` turns them off): `find_nearby_vertices`
  (smoothcartpaths' ripple) keeps each Spline mesh's 2D KD tree while its XY is unchanged and skips meshes whose
  XY box is out of reach (it rebuilt one per mesh per path mesh); the knife cut tests "near the cut" with a set
  instead of a list; a cut's blue paint goes straight into the edit BMesh loops of its new vertices instead of
  `color_to_vertices`' Edit -> Object -> Edit round trip of every selected mesh (the cut only adds elements, so
  the order is what the round trip gives); `color_to_vertices` at full strength (recipes) writes the colour as
  arrays instead of a Python loop over every corner. The tee flatten already hides meshes out of its proportional
  reach so only those enter Edit Mode. Vreta, all layers, nothing cached: 312 s -> 153 s (cut 145 -> 53 s,
  smooth 84 -> 16 s). The cut's candidate search is ~3 % of its time and was left alone.
- **Op-result cache** (`<blend folder>/shaping-staging/cache`, CLI and worker): every op runs as units (one per
  feature group; `"*"` for footprint and weld ops). A unit's reads are its targets plus every Spline mesh within
  its reach (tee flatten: its proportional radius; cut: 1 m, the weld looks 0.5 m around; smooth: the smooth
  distance + 0.5 m; recipe: the feature's mesh and its blends; footprint: meshes whose box meets the footprint +
  falloff + protect band). Key = this file + shape_layers + Blender + Afrod/Edit Mesh Tools sources, the op's
  JSON (without id/note/provenance), the unit, seed, frame, for recipes the recipe file + shape_paint + library,
  and the full state hash (every attribute incl. selection, custom normals, byte colours, vertex groups,
  materials, props) of each read mesh. Value: the changed meshes' arrays that differ from the input (+ meta,
  created/removed names, the run record) as `.npz`. A replay is verified against the stored result hashes (a
  mismatch restores the inputs and computes). Anything an op changes outside its units' reads is reported as an
  `escape` warning and not cached. Report `cache`: hits, misses, replay/compute seconds. Vreta, all layers: 106
  units, 63 MB: CLI cold 153-166 s, warm 68 s (ops 106 hits: 11 s replay + 18 s hashing the inputs; the rest is
  the whole-course fingerprints and seam checks).
- Pure-Python parts (layer validation, SVG parsing, selectors, seeds, footprint maths) are in
  `tools/shape_layers.py`; tests: `python blender/tools/shape_layers_test.py`.

## Shaping: surfaces of a merged road

The SVG writes every touching road piece of any surface as one shape per network (`roads_124` on Vreta: 85
pieces, asphalt and gravel): OPCD's build needs the junction fillets dissolved inside one shape, and a per-surface
split in the SVG left slivers along seams through junctions (docs/gspro/export.md, "History"). So the split happens
on OPCD's meshes: `golfmap.split_surfaces` (`tools/shape_apply.py`; the geometry, pure Python, in
`tools/shape_surfaces.py`, tests `python blender/tools/shape_surfaces_test.py`). `shaping-global` emits it after
`paths-cut`/`paths-smooth` and before the footprints whenever a shape is mixed:

```json
{ "id": "paths-surfaces", "op": "golfmap.split_surfaces", "select": { "shape": ["roads_124"] } }
```

- **Input**: the sidecar `<svg stem>-paths.json` next to the SVG that built the `.blend` (`paths` names another,
  relative to the SVG's folder), `regions[<shape>].pieces` (surface, source, `for`, outline rings in SVG units,
  mapped into the `.blend` frame). `select` picks shapes (`shape` = SVG path ids; any selector works): every object
  OPCD built from a picked shape is split, the `_<n>_..._-_Mesh` pieces and the `_B_` / `_hole<k>_B_` blends. A
  shape the sidecar does not mark `mixed` is left alone (run `note`); a missing sidecar or shape is a `stepFailed`
  warning, nothing changed.
- **Regions** (`shape_surfaces.Regions`): surface rank asphalt, concrete, paving, wood, gravel, dirt (then others by
  name). A point is the highest-ranked surface of the pieces with a surface that cover it; else the surface of a
  derived piece covering it (a junction piece, `source: road-junctions`, or a piece without a surface): that goes to
  the surface its outline runs inside most (lengths within `junctionTie`, default 15 %, are a tie and the higher
  rank wins, so a T-junction's fillets widen the major road), and owns only its part outside the other roads'
  pieces (its 0.5 m legs inside the other road never become a strip of its surface along that kerb); else, not
  covered (the merge's closing filled it), the nearest region. Seams: the piece outlines cut at their crossings, a
  sub-segment with different surfaces on its two sides (so the higher road's own kerb); plus, where two surfaces
  face each other across uncovered ground narrower than `slitM` (0.8 m; the merge closes gaps up to 0.6 m), the
  slit's medial line, which is what the nearest-region fill splits it on. Chains have the lower surface on their
  left, Douglas-Peucker 5 mm.
- **Cut** (each road mesh of the shape): every chain end inside a face becomes a vertex first (the face poked, its
  centre moved there: chains meeting at a node inside a face would otherwise both stop at its edges); then each seam
  polyline goes in as an exact edge chain (`insert_polyline`: crossed edges split at the crossing, z linear,
  vertices within 0.5 mm passed through - positions are float32, ~0.1 mm apart at 1-2 km - consecutive crossings
  joined by a face split through the polyline's bends, z on the face plane), and so does a fade line `fadeM`
  (0.5 m) into the lower side (`Regions.fade_lines`, kept where it is 0.5 m from every fading seam and inside the
  lower region). Seam edges carry a mark (a temporary edge attribute). Then the cut's slivers collapse
  (`collapse_cut_slivers`, `sliverM` 0.05 m, marks kept), and `weld_tjunctions` (`weld`, default on) closes the
  T-junctions the cut left on the blends' inner edges and on the shape's other pieces.
- **Classes**: faces in components bounded by seam edges vote by an interior point's region (area weighted); a
  component the cut did not close off falls back to per-face points (`unsealedEdges` counts where the class then
  changes across an uncut edge, `unsealedAt` one of them). Small parts join the neighbour they share the longest
  edge with (`smallParts`, `why`): a connected part under `minPartM2` (1 m²) that does not carry on into another
  OPCD piece of the shape (`island`: e.g. a piece's end cap poking past the other road's kerb), and every part of a
  surface whose faces in one object add up to under `minPartM2` (`tinyObject`, also when it carries on). Blend faces
  take the class of the road face their inner edge lies on (then the same small-part rule among the blends); a face
  whose inner edge changes class (where a seam leaves the road) is split straight across the strip there
  (`acrossSplits`), the T-junction on its outer edge welded onto whatever lies outside (rough, Outer_Deep: those
  meshes change too).
- **Fade paint** (road meshes): on the lower surface's faces every corner within `fadeM` of a seam to a higher
  surface (in the object or across an OPCD piece boundary) gets its colour times distance / `fadeM`: red at 0.5 m,
  black at the seam, which the MAHS material Unity builds draws as own surface / the neighbour's. Asphalt / concrete
  seams get none (a crisp edge). Blends keep their paint. Run `parts[].fade = {to, vertices, corners}`.
- **Separate**: one object per (object, surface), `Spline_<shape>_<surface>_<rest of the OPCD name>`
  (`Spline_roads_124_gravel_3_Concrete_-_Mesh`, `Spline_roads_124_asphalt_B_Concrete_-_Blend`,
  `Spline_roads_124_asphalt_hole2_B_Concrete_-_Blend`), `opcd_shape_id` / `opcd_parent_id` with the surface after the
  shape (`roads_124_gravel_3`, blends `roads_124_gravel`), `opcd_kind`, materials and other props kept, plus
  `golfmap_surface` and `golfmap_split_from`; an object of one surface is renamed the same way. Custom normals are set
  per vertex from the mesh's smooth normals before the cut (OPCD's are those, within 0.2 deg), so both sides of a
  seam shade alike. The originals are removed: `--export` deletes their FBX, so does the worker's sync, and Unity's
  `golfmap.meshes.sync` prunes objects without an FBX.
- **Report** (`runs[0]`): `regions` (surfaces, the derived pieces' assignments with their lengths, seam metres per
  pair), `seamEdges` per pair (edges, metres, across pieces), per object `cut` (edge / face splits, nodes, outside,
  failed) and `classify`, `slivers`, `weld`, `parts` (name, from, surface, kind, faces, area, fade), `created` /
  `removed`; the op entry's `created` / `removed` / `objectsChanged`; one `changedPlaces` entry for the shape.
- **Reach** (`plan_units`): one unit per shape; reads = its objects + every Spline mesh within 1 m of their boxes
  (the welds). The cache key adds the shape's sidecar entry and `shape_surfaces.py`.
- **Vreta** (`vreta_svg_1985`, the whole global layer: split after the cut and smooth, then the lots and pads):
  roads_124's 16 objects -> 20 parts (asphalt 3 meshes + 6 blends, gravel 8 meshes + 3 blends), 30 seam chains (13
  of them slit lines), 25 fade lines, 107 m of seam in 293 edges; the op 13 s (20 s with the engine's bookkeeping),
  op-cache replay 4.7 s, a warm run hash-identical; a worker `/sync` of a changed `fadeM` re-runs it and the
  footprint units that reach its parts (25 units) in 40-60 s, and changing it back gives the fresh apply's
  all-mesh hash. Checked on the result: every road face's interior point lies in its part's region except the
  8 faces (0.2 m²) of two asphalt islands (0.11 and 0.10 m², piece end caps past a gravel kerb) that joined the
  gravel; 22 small blend faces (0.9 m²) follow the road part beside them rather than the pieces' outlines; one 0.43 m² gravel bit of a hole blend joined
  its asphalt (3.8 m of gravel road edge beside an asphalt blend); each original's area = its parts' within
  5e-4 m²; every part boundary edge off the original outline is matched by another part's (0 unmatched); smallest
  part 4.98 m² (a whole hole blend); fade corners within 0.002 of distance / 0.5, every seam corner black, every
  fade-line corner red; the FBX export lists the 20 new parts and deletes the 16 originals. Path surface check over
  the whole layer: 35 steep faces / 102 shading faults vs 34 / 101 without the split.
- **Normals caveat**: right after the split both sides' corner normals at a seam agree within 0.03 deg; the
  footprints after it move z and Blender re-derives each part's custom normals from its own faces, so after the
  whole layer they differ by up to 3.8 deg at the seam (as at any boundary between two OPCD meshes, whose custom
  normals each follow their own faces; not measured there).

## Shaping: path edge fade

A gravel or dirt path meets the grass along a fringe strip (`Spline_<shape>_<surface>_B_..._Blend`) one quad wide
(0.12 m on Vreta, vertices ~0.55 m apart along it) with a straight red -> black ramp. The path ends on a line, and the
3D grass planted on the strip follows its quads: a repeating squarish pattern. `golfmap.path_edge_fade`
(`tools/shape_apply.py`; the maths, pure Python, in `tools/shape_edgefade.py`, tests `python
blender/tools/shape_edgefade_test.py`) makes the edge irregular. `shaping-global` emits it as the last op of
`00-global.gen.json` whenever the course has a gravel or dirt path (`paths-edge-fade`, `select: {type: path}`), after
`paths-surfaces` (each part has its own surface by then) and after the lot / pad footprints (it works on the final
heights):

```json
{ "id": "paths-edge-fade", "op": "golfmap.path_edge_fade", "select": { "type": "path" } }
```

- **Units**: one per road shape (SVG path id): its path pieces and every blend object. The surface of an object is
  its `golfmap_surface` (set by `split_surfaces`), else the sidecar's surface of its shape when the shape is one
  surface; only `surfaces` (default gravel and dirt) are faded. An object that carries `golfmap_edge_fade` is skipped,
  so a replay is idempotent.
- **Geometry** (per path piece): the blend faces whose inner edge lies on the piece's boundary (within 1 mm) are its
  strip; strip and piece are joined and welded; every edge that crosses the line `widthM + 0.1` m from the seam is cut
  exactly there (no triangle reaches from the strip band deep into the path: a coarse wedge would carry its membership
  and paint across as a sawtooth), then every edge inside that zone is halved until it is at most `maxEdgeM`; the
  path faces whose centre is within the effective width of the seam move to the strip. The strip now reaches that far
  (`widthM`, default 0.3 m, at most 60 % of the piece's half width, so a narrow path keeps a core; a piece with less
  than 0.1 m to give is left alone) into the path, its outer edge (welded to the rough / deep / fairway mesh beside it)
  does not move, and the path loses that much mesh. Faces grow with 1 / `maxEdgeM`^2: default 0.3 m; Vreta's whole
  `roads_124` gravel (8 pieces, 3 blends, ~6 km of strip edge) takes ~70 s and ~0.4 M faces, at 0.2 m ~1.1 M. Raise
  `maxEdgeM` on a big course; Stix 3D grass runs on every triangle of the blend. The inner edge of the strip is a
  staircase at that resolution (invisible: the strip is pure path paint there).
- **Paint** (`shape_edgefade.strip_value`): the strip's colour is `red = 1 - s`, `green = s` with `s` a smoothstep of the
  distance from the strip's outer edge (0 = the outer edge, 1 = the inner edge), bent by a seeded fractal value noise of the
  world position (0.45 m, 0.17 m, 0.06 m octaves; `amplitude` 0.55 = how far, as a fraction of the width; tapered to
  nothing at both ends, so the strip's outer edge stays pure red and its inner edge pure green). The noise depends on the
  position only, so pieces that meet join up; the seed is the road shape's (`seed` on the op overrides).
- **Convention**: red = the neighbour's grass, green = the path surface. Stix 3D grass grows on red (its blade chance is
  the vertex red) and so thins out toward the gravel; MAHS's black stays 0, the two materials mix by paint alone. The rest
  of the blend object (strips of pieces the op did not reach) is converted to the same convention (`red = 1 - old red`,
  `green = old red`) so one object has one convention. Unity reads it from the paint: `golfmap.paths.materials` finds
  "path Green, far Red" and draws the surface on the green channel (the far channel is the neighbour's red, no copy), and
  `golfmap.roughgrass.plant` puts a Stix renderer (the rough material) on every path blend with green paint.
- **After**: the changed meshes are smooth shaded with their custom normals dropped, then `golfmap.weld_tjunctions`
  closes the T-junctions the subdivided outer edge made against the neighbours (`weld`, default on). Object names,
  the materials, the pairing keys stay; both objects get `golfmap_edge_fade` = `path-edge-fade-v1`.
- **Keys**: `widthM` (0.3), `maxEdgeM` (0.3), `amplitude` (0.55), `surfaces` (`["gravel", "dirt"]`), `weld` (true),
  `paths` (the road-surface sidecar, as for `split_surfaces`), `seed`. **Reach** (op cache, worker): the shape's objects
  plus whatever the weld can touch (their boxes + 1 m). Report `runs[]`: per piece `matched` / `stripFaces` /
  `pathFaces`, per blend `claimedFaces` / `faces` / `restFaces`, `welds`, `keptFadedCorners` (path corners that keep a
  paint other than plain red: the fade `split_surfaces` paints on a gravel part toward asphalt).
- **Limits**: a path piece keeps its own paint through the subdivision (plain red, or the fade toward another surface
  that `split_surfaces` painted on it); a strip whose inner edge does not sit on a piece's boundary (an unsplit mixed shape) is left alone; there
  is no face budget beyond `maxEdgeM`. `edge_fade_core(pieces, blends, ...)` takes the objects, so a quick check on
  imported FBX needs no replay (Vreta `roads_124`: 70 s).

## Recipe library

`recipes/library.json` (`golfmap-recipe-library-v1`) indexes the recipes a feature can get (Afrod files and our
golfmap composites, next section; `params`, `stepPaint` and the top-level `studioPaint` are described there): `id`, `name`,
`file` (relative to `$GOLFMAP_AFROD_RECIPES`, default `D:/gspro/afrod-recipes`, where third-party files stay
untouched; then `blender/recipes/`, ours), `author`, `surfaces` (bunker / lake / creek / path), `join`
(`last-blend` / `permanent` / `none`: what Afrod's join does to the blends), `paint` (per `mesh` and `blend`: what
each colour the recipe leaves means, as a golfmap role), `default` (one per surface) and `notes` (what the steps do
and why the mapping). Defaults: bunker `cesimgolf-conway`, lake `kaustin-lake-gradual`, creek
`golfmap-creek-narrow` (ours: kaustin's creek steps fail or leave Vreta's 2-3-ring creeks all grass), path
`raised-path-blitz` (paint kept; not run yet).

Every author paints differently (ce.simgolf: green sand, black shadow lip; kaustin: black = base material, red =
the adjoining grass, green = lip dirt; BLRK: black dirt; OPCD: red/green dirt, blue/black sand), so after a recipe
`tools/shape_paint.py` rewrites the paint into the `golfmap` convention's roles. A colour is weights over red,
green, blue plus black = 1 - r - g - b; a map is a linear map of the four weights, applied to the stored sRGB bytes
(what the FBX carries), so pure colours and their mixes map exactly.

- `remap_after_recipe(objects, recipe)` (`shape_apply.py` calls it after every `afrod.recipe` run; report
  `runs[].paint`): objects = the feature's mesh + blends after the recipe, recipe = library id or file path. The recipe's mesh map goes to the mesh; its blend map to the blend Afrod joined (the last by name
  with the mesh's `opcd_parent_id`); every other blend, and any part whose map is empty (reshape-only recipes),
  still has OPCD's paint and gets `opcdDefault` for the surface. A recipe missing from the library changes nothing
  and returns a warning.
- `remap_opcd_default(objects)`: OPCD's paint to golfmap roles for features no recipe painted (bunkers render as
  before under the golfmap materials: dirt rim, sand; lakes keep their layout; narrow creeks become dirt).
- Remapped objects get `golfmap_paint = "golfmap"`, `golfmap_paint_recipe` and `golfmap_paint_hash`; the default
  skips objects whose paint still matches the hash (both calls do: a second call maps nothing twice), so it is safe
  to run over the whole course after the recipes, and a snapshot restore that brings OPCD's paint back is remapped again.
- Tests: `python blender/tools/shape_paint_test.py` (maths, library, planning);
  `blender -b --factory-startup --python blender/tools/shape_paint_test.py` also runs the bpy part.
- Checked on `vreta_svg_1985.conformed.blend` (every bunker, lake and creek recipe through `shape_apply.py`, then
  the remap, rendered by role): grass lip outside, shadow or dirt band, sand / bed inside. Water has no Unity
  convention yet: lake and creek meshes keep OPCD's layout, their blends stay on grass channels.

## Composite and parameterised recipes

[SHAPING-PLAN.md](SHAPING-PLAN.md), "Composite and parameterised recipes". Code: `tools/shape_recipes.py` (pure:
formats, validation, params, colour translation; tests `python blender/tools/shape_recipes_test.py`),
`tools/shape_studios.py` (the studio drivers), `op_recipe` in `tools/shape_apply.py`.

- **Formats.** A recipe file is an Afrod recipe (`[{command: args}, ...]`, as before) or a golfmap recipe
  `{"format": "golfmap-recipe-v1", "steps": [{"op", "params", "tag"?, "ringsFromSeam"?, "paint"?}]}` with steps
  `bunkerstudio.shape`, `shorelinestudio.shape`, `afrod.<command>` (its args as in an Afrod file) and
  `golfmap.paint_map {map: {mesh, blend}}`, `golfmap.edge_jitter {amount 0.5, wavelengthM 0.6, grain 0.5, kinds [mesh],
  seed 0}` (the borders between differently painted rings made ragged: every vertex off the seam takes up to `amount`
  of its outer or inner neighbour ring's colour, chosen by seeded value noise over world XY - `wavelengthM` coherent
  wobble, `grain` per-vertex share - plus the op's seed; the seam ring never changes, so it still matches the blend;
  no global RNG. Runs after the feature's names are restored, so it must be the last step(s). Both golfmap bunker
  recipes end with it: OPCD's dirt band (rings 0-2, 0.18 m, then sand) ends a ring early or late along the edge). At most one studio step, and before any Afrod topology step (loop cut,
  join, separate, subdivide ...): the studios rebuild OPCD's untouched mesh + one-quad blend ring (an error
  otherwise). `ringsFromSeam: true` on an Afrod step shifts its ring insets (written for OPCD's one-row blend, ring
  1 = the seam) by the blend's real rows - 1, measured before the first Afrod step (Bunker Studio leaves four rows:
  +3); report `runs[].seamRing`.
- **Studio steps** run the add-ons' own operators headless (scene props set, the feature's mesh selected,
  Preview -> Validate -> Apply; their checks decide, the add-ons are not changed). `bunkerstudio.shape {preset
  (CLASSIC|PARKLAND|FLASHED|NATURAL|LINKS|POT), depth, edgeVariation, edgeDirt, highSide, highSpan,
  highSideStrength, faceSteepness}`: the public preset mode (the only one Bunker Studio validates on OPCD's split
  blend sets). High side = Bunker Studio's captured guide (`high_side_override`/`high_side_parent_id`/`high_center`,
  what its Capture Guide writes), set to the rim point facing the green: `highSide` `"green"` (default: the green of
  the bunker's hole nearest to it, from the SVG's green paths; no hole: the nearest green within 150 m; none: its
  automatic high side), a compass bearing, or `"auto"`; report `runs[].studio[].highSide` (green, bearing, rim
  point, centre). `faceSteepness` (face widths / it) and `highSideStrength` (high crown x it, high face tightened by
  it) scale the preset's values: Bunker Studio's receipt check compares a public preview with the preset, so the
  preset entry holds the scaled values only while the step runs. `shorelinestudio.shape {preset (Shoreline's ten),
  depth, bankSlope (degrees), strength}`: mode from the preset, no water-surface preview, no guide, `shape_seed` =
  the recipe seed. Seeds: Bunker Studio derives its variation from the parent id (no seed input), Shoreline from
  parent id + shape_seed; the Afrod steps after a studio step are re-seeded, so a replay is hash-identical (checked:
  every composite twice per seed, and a warm op-cache run equals the cold one). After Apply the studios' own
  bookkeeping (`*_applied` markers, `*_BASELINE__` meshes, empty preview collections) is removed: the engine keeps
  its own snapshots. A studio that refuses (Steward bounds, Shoreline preflight) leaves the feature unchanged.
- **Paint** stays in golfmap roles step by step: a studio's output is remapped right after it with the library's
  `studioPaint` (Bunker Studio: bunker red dirt / blue sand -> dirt / floor, blend red dirt fade -> browning, black
  grass -> adjoining, blend UV0 = its 3D-grass density, kept; Shoreline: zone colours red rim / green bank / blue bed
  / black deep -> grassLip / dirt / floor / floor, blends red -> adjoining; the preset's zone stops go into the run
  record); without a studio step OPCD's paint is mapped (opcdDefault) before the first Afrod step; an Afrod step's
  colour arguments (`vertex_paint_type`, `_to`, `_from`) are translated through its source's mesh map (the step's
  `paint`, else the entry's `stepPaint` by tag / op / `afrod`, else identity), so the result is canonical and the
  objects are marked golfmap at the end (no end-of-recipe remap).
- **Params.** Library entries declare `params: [{id, label, unit, min, max, step, default, maps: [{step, field,
  mode: set|scale}]}]`; `step` = a step op, an Afrod command name or a tag. A recipe op's `overrides` = `{<param id>:
  value, ..., "seed": int}` (what the web/server write): missing params take their default, out-of-range values are
  clamped with a warning, `seed` replaces the op's seed; other keys are raw `scene.opcdtools` overrides (Afrod
  recipes only). Report `runs[].params` and `runs[].paramMaps` (field before/after).
- **Library composites** (ours, `blender/recipes/`): `golfmap-bunker-studio-conway` (Bunker Studio Classic dig,
  high side toward the green, + Conway's lip stack without its dig and without its two inset-6 loop spacings,
  which folded the narrow end of hole_9_6c on Bunker Studio's rows; Conway's rim grass lip and shadow on the
  separated bunker; params depth, faceSteepness, highSideStrength, lipHeight, lipRaggedness, edgeDirt),
  `golfmap-creek-shoreline-meadow-brook` / `-maintained-drain` (Shoreline creek + golfmap-creek-narrow's bank paint;
  depth, bankSlope), `golfmap-lake-shoreline-overhang` (Shoreline Natural Pond + kaustin's overhang edge steps
  without his dig; depth, bankSlope, lipRaggedness). The defaults got params too: `cesimgolf-conway` (depth =
  bunkeredit dig, lipHeight, lipRaggedness), `kaustin-lake-gradual` (depth, lipHeight = bank raise),
  `golfmap-creek-narrow` (depth = x its steps, lipRaggedness).
- **Vreta** (`vreta_svg_1985.conformed.blend`, after the global layer): the bunker composite on all 35 bunkers,
  none refused, 2-3 s each (85 s; op cache warm 0.7 s); Meadow Brook on the 13 creeks: 6 shaped, 7 refused by
  Shoreline (5 OPCD split pieces without their own blend, 2 discontinuous blend seams, 1 uncovered boundary);
  Natural Pond + overhang on the 22 lakes: 20 shaped, others_18 refused by Shoreline, others_11e rolled back
  (Afrod's loop cut fails on it). Whole course cold 265 s, warm 75 s, identical hashes. Worker `/sync` of one
  bunker's params: 3.3 s. Extreme param combinations can exceed Bunker Studio's Steward bound (depth 0.7 +
  faceSteepness 1.3 + highSideStrength 1.6 on hole_18_1c): refused, feature unchanged, warning.

## Shaping worker

`tools/shape_worker.py` keeps a course shaped in a long-running headless Blender so the Terrain editor's edits
reach the meshes in seconds ([SHAPING-PLAN.md](SHAPING-PLAN.md), "Terrain editor -> Blender"). JSON over HTTP on
127.0.0.1 (`--port`, else `GOLFMAP_SHAPING_PORT`, else 8766):

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python blender/tools/shape_worker.py -- --port 8766 --blend "D:/gspro_courses/vreta-opcd/vreta_svg_1985.blend" --layers docs/gspro/vreta/shaping --fbx-folder "<Unity project>/Assets/fbx"
```

| Call | Does | Answers |
|---|---|---|
| `GET /status` | never waits | `state` (`starting` / `ready` / `busy` / `error`), `phase`, `blend`, `conformed`, `layersDir`, `fbxFolder`, `appliedOps`, `lastRun`, `error` |
| `POST /load {blend?, layersDir?, fbxFolder?, cache?, syncFbx?}` | opens `<name>.conformed.blend` (runs shape_prepare first when it is missing or older than the source `.blend`; `blend` may name either), applies every layer through the op cache, writes `shaping-staging/shaping-report.json`; `syncFbx` also brings `fbxFolder` in step with the whole course | `appliedOps`, `errors`, `warnings`, `cache`, `hash`, `timings`, `seconds` |
| `POST /sync {dryRun?}` | re-reads the layers, diffs the ops by `layer:id` + content, restores the affected meshes, re-runs what reaches them, seam-checks, exports their FBX (fbx_sync exporter, fingerprints and manifest, so a later full fbx_sync agrees) and deletes the FBX of meshes that are gone (e.g. blends a `meshblendjoinpermanent` recipe merged). The first sync after a load also exports every mesh whose fingerprint differs from the folder's manifest (all of them when it has none), so Unity is in step on first use | `changedObjects` (incl. removed), `exported`, `removed` (FBX names), `seconds`, `report: {warnings, seams, changedPlaces, changedObjectsDetail}` (places of the ops this sync ran), plus `changedOps`, `restorePoint`, `affectedObjects`, `rerunUnits`, `ranOps`, `cache`, `hash`; `dryRun` stops after the plan. Also written to `shaping-staging/shaping-sync.json` |
| `POST /shutdown` | stops the worker | |

- **Threads:** the HTTP server only queues jobs (and answers `/status` from a copy); every bpy call runs on the
  main thread's job loop, one job at a time.
- **Snapshots:** before each op, the state of every mesh the op then changes is kept as a mesh copy (Blender
  shares the arrays until one side changes, so this costs little): the state of any mesh at any op boundary
  is known, which includes "after the global layers" and "after all layers" (the live meshes).
- **Sync:** p = the first op that differs. The affected set starts with the footprints (reads and writes) of
  the changed, added and removed ops (the previous run's records plus the new plan with 1 m margin) and grows
  through every later unit whose footprint meets it. Those meshes go back to their state before op p; then, in
  layer order from p, every changed op runs and every unchanged op re-runs only its units in the closure. That
  is exactly what a fresh full apply does to them (checked by hash). A unit that reaches outside the set, or an
  op that moves meshes outside its units' reads, makes the worker open the `.blend` again and apply everything
  (fast from the op cache) and export whatever differs from the manifest (`fullReload` says why).
- The `.blend` is never saved (only shape_prepare writes the conformed cache, as on its own). `fbxFolder` may
  be the Unity project's (that is the point); test against a scratch folder.
- FBX go through this repo's `tools/fbx_sync.py` loaded by path (`shape_apply.fbx_sync_module()`): an enabled
  fbx_sync add-on copy in Blender's addons folder shadows `import fbx_sync` and may be older (the one on the
  Vreta machine exports the Gap_Issue markers). Reinstall the add-on from the repo file so UI and worker agree.

Measured on Vreta (`vreta_svg_1985.conformed.blend`, 776 meshes; 32 ops, 106 units):

| | seconds |
|---|---|
| `/load`, nothing cached | 131-155 (open 2, apply 125; `cache: false` 129-147) |
| `/load`, all cached | 44-48 (replay 12, input hashes 20) |
| + 69 feature recipes (35 bunkers, 22 lakes, 13 creeks), recipes cold / all cached | 128 / 68 |
| first `/sync` after a load, empty FBX folder (776 FBX) | 18 |
| `/sync`, one bunker's recipe changed (restore 2 meshes, recipe, 2 FBX) | 3.1 (client 5.9 incl. the all-mesh hash) |
| `/sync`, the same back | re-run 1.8; a lake back to its cached recipe 3.8 (blend FBX deleted again) |
| `/sync`, one lot footprint's level/falloff (123 meshes restored, 28 units re-run, 15 changed) | 31 |

Determinism: after each of those syncs, the all-mesh positions and colour hashes equal a fresh full apply of the
same layers with the cache off, and switching back gives the original hashes byte for byte.

## Planned

A bunker lip tool on top of the Afrod operators, with Bunker Studio's preview, validate
and restore workflow:
- metric lip stacks (ce.simgolf's recipe expressed in metres from the seam rather than as
  ring indices)
- lip height that varies around the rim, raised inside-out or outside-in, with an automatic
  pull-back so faces don't stretch the texture
- automatic normal transfer across seams
- a one-click satellite reference material for fixing perimeters
- painting driven by the shared conventions file

## Course props (buildings, shelters, flags, cars ...)

`tools/build_props.py` + `tools/props_kit.py` build every prop of a course area from a spec, headless, in about 15 s:

```bash
python docs/gspro/vreta/clubhouse-props.gen.py        # measurements -> docs/gspro/vreta/clubhouse-props.json
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python blender/tools/build_props.py -- --spec docs/gspro/vreta/clubhouse-props.json --out "<Unity project>/Assets/GolfMap/Vreta/Props"
```

- **Spec** (`golfmap-props-spec-v1`): `assets` (parametric parts: `building` with gable/mono roofs, openings,
  cladding, gutters, solar arrays; `veranda`, `steps`, `shelter`, `gazebo`, `drape` (paving laid on the DEM),
  `car2`, `flagpole`, `hedge`, `rock`, `boulder` (a round field stone, moss or ivy on top; with `exponent`, `flats` and `lumps` a wall stone: a block with rounded edges, a flat face and beds), `net_poles` ...) and `instances` (EPSG:3006 `e`/`n`, `yawDeg` = compass
  bearing of the asset's local +x, `ground` max/min/centre/median, `dz`, optional `scale`). An asset with
  `prefab` instead of `parts` is a Unity prefab already in the course project (e.g. a vegetation pack's hedge).
- The Vreta generator documents where every number comes from: lidar roof fits (positions, footprints, eave and
  ridge heights), the 2025 ortho (buildings newer than the lidar, flags, parked cars in `clubhouse-cars.json`) and
  the 2026-09-26 reference photos (looks). The ortho shows shadows as dark patches: check against a photo before
  drawing paving.
- **Out:** `Models/<id>.fbx` (one mesh per asset, material names only), `Textures/` (generated albedo, normal
  and Standard metallic/occlusion/smoothness masks, sized in metres; only the materials the assets use), `props.json`
  (`golfmap-props-v1`). The stone walls' boulders are such a build too: `docs/gspro/vreta/wall-stones.json` (from
  `stone-walls.gen.py`) into `<course>/Walls/Stones`, used by `golfmap.walls.build` (unity/README.md "Stone walls").
  `--preview` renders each asset, `--layout --ortho <png> --ortho-bounds x0,y0,x1,y1` renders the whole area over
  an ortho, `--only a,b` rebuilds just those.
- **Photo textures:** a material spec `photo:<path>` / `photoblocks:<path>:<courses>:<blocks>:<colours>` takes
  a texture pack's photo under the Unity project's `Assets/` (found from `--out`, else `$GOLFMAP_UNITY_PROJECT`)
  and keeps only its relief; the colours come from the spec (`photoblocks` recolours each block from a palette).
  Nothing from the pack is copied into the repo. Built outside a Unity project, those materials are skipped and
  only an asset that uses one fails (the 18th's footbridge: `splitface_block`, `concrete_weathered`).
- **Printed faces (signs):** the spec's `materials: {name: {image, smoothness}}` adds materials whose albedo is a
  finished picture (`image` relative to the spec), copied into `Textures/` as is. The `tee_sign` part (post, arm,
  curved brace, a board of any `outline` hung under the arm) maps its `face` material once over the board, UV
  0..1, readable from both sides. Vreta's 18 hole boards: `docs/gspro/vreta/hole-signs.gen.py` (par/index from the
  app, tee lengths from the club's card, hole view from the 2025 ortho, sign + bench spot by the yellow tee) writes
  the pictures to `data/props/<site>/hole-signs/` and `hole-signs.json`; run it before `clubhouse-props.gen.py`.
- **Then in Unity:** `golfmap.props.place` (GolfMap > Props), see [unity/README.md](../unity/README.md#course-props).
