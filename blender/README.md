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

## SVG -> `.blend` (OPCD) cannot be run headless

Checked 2026-10-14, because step 1 of [SHAPING-PLAN.md](SHAPING-PLAN.md) ("we have a new Blend file") is the
one manual step left before shaping. The OPCD panel's **Import SVG** and **Convert Materials and Cut** are
not in the add-on we have installed:

- `%APPDATA%\Blender Foundation\Blender\4.5\extensions\user_default\opcd_blender_tools` (OPCD **Mesh
  Editing** Tools 3.5.8, and 3.5.6 under Blender 5.2) has **no SVG code at all**: four case-insensitive
  `svg` matches in the whole add-on, all dead (the add-on's `category` string, a `display_debug` description
  whose panel block is commented out, two comments), no `import_curve`/SVG operator, no `subprocess` /
  `os.system` / `.exe` call, no `bpy.ops.wm.open_mainfile`/`append`/`link`, no template `.blend` name, and no
  SVG or course-folder property in `properties.py` (its only path property is `export_folder`). Its whole
  panel is the mesh-editing toolbox (`opcd.convertterrain`, `opcd.projectmesh`, bunkers, water, structures,
  paint, topology, `opcd.separatemesh`, `opcd.matchange`, FBX export ...).
- Those two buttons belong to the **OPCD conversion toolset**: `GSProSVGConvert.exe` turns the Inkscape SVG
  into the `-converted.svg` the importer needs, and the conversion add-on lives in
  `OPCDcourseconversion.blend`, **Blender 2.83 LTS only** (`D:\gspro_courses\gspro-docs\opcd\00-pipeline.md`
  steps 8/11/13 and `04-blender-conversion.md`). Neither `GSProSVGConvert.exe` nor
  `OPCDcourseconversion.blend` is on this machine (searched `D:\gspro`, `D:\gspro_courses`, `%LOCALAPPDATA%`,
  `%APPDATA%`, `C:\Program Files*`), and Vreta's `.blend`s are built by OPCD's own tooling outside Blender
  (`vreta.svg` 17:02 -> `vreta_svg_1988.blend` 17:09, AGENTS.md "Inkscape/OPCD web tools").

So there is nothing to drive with `blender -b`: the code is not here, and the version of Blender it needs is
not the one shaping runs in. A `blender/tools/opcd_build.py` is therefore not possible without the OPCD
conversion toolset installed; if it ever is, the blockers to expect are `ImportHelper.invoke`'s file browser
(call `execute` with `filepath=` instead, as `shape_prepare.py` already does for `opcd.convertterrain`) and
`bpy.context.space_data.clip_end`, which needs a 3D-View context override (`_view3d_override()`). Everything
*downstream* of the `.blend` already runs headless.

## Shaping: prepare

Step 2 of [SHAPING-PLAN.md](SHAPING-PLAN.md). `tools/shape_prepare.py` takes a fresh OPCD `.blend` (Spline
meshes flat, no Terrain), presses OPCD's **Import Terrain OBJ** (`opcd.convertterrain`, Terrain Smooth from the
scene, default 1.5) and **Conform to Terrain** with Selection = All (Afrod Mod v4's `wm.projectmesh`: project
onto Terrain, then retry vertices the projection missed; `--conform opcd` = the OPCD Base button, no retry;
`--conform grid` = the same outcome computed on the terrain's own grid, 7× faster cold), and saves a copy
`<name>.conformed.blend` next to the source. The source is never saved.

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b "D:/gspro_courses/vreta-opcd/vreta_svg_1985.blend" --python blender/tools/shape_prepare.py -- --json "D:/gspro_courses/vreta-opcd/vreta_svg_1985.conformed.json"
```

Flags: `--terrain` (default `terrain.obj` next to the `.blend`), `--out`, `--json`, `--seed` (Afrod's retry
nudges), `--limit N` (smoke test: first N meshes only), `--conform afrod|opcd|grid` (the third computes the
projection instead of casting it — "The grid conform path" below), `--no-conform-cache`,
`--conform-cache-dir`. The report
lists vertices left at the flatten depth
(-100 m) per object, timings and the Terrain's bounds. Vreta (996 meshes, 4.11 M vertices, 644 MB OBJ):
import 5 s, a cold conform 155 s through the operator or 20 s on the grid, no failures, 370 MB out.
Positions in EPSG:3006 map into the `.blend` with
`tools/shape_coords.py` (SHAPING-PLAN.md, "Coordinates").

### The per-mesh conform cache

A regenerated `.blend` is mostly the same flat meshes, but Conform to Terrain used to run again for all of
them (2.5 minutes on Vreta's 996). So prepare does not press the whole-scene button: it runs the operator's
own per-object body - the add-on's `flatten_mesh` → `project_mesh` (Shrinkwrap PROJECT +Z) →
`object.convert` → Afrod's `fix_failed_projections`, over the same objects in the same order - and caches
each mesh's result in `<blend folder>/shaping-staging/conform-cache/<key[:2]>/<key>.npz`.

- **Key:** the mesh's whole pre-conform state (`shape_apply.capture_state` + `state_hash`: positions,
  topology, every attribute incl. byte colours and custom normals, vertex groups, materials, custom props,
  matrix) + the terrain OBJ's **content** hash (sha1, remembered per size+mtime in
  `conform-cache/terrain-hash.json`, so an OBJ rewritten from the same heightmap keeps the cache) + the
  conform button + Terrain Smooth + `--seed` + Blender, `shape_prepare.py`, Afrod and OPCD `mesh_utils`
  sources. **Not** the object's name: a regenerated `.blend` that renamed or renumbered an otherwise
  identical mesh still hits (`cache.renamedHits` counts those).
- **Value:** only the arrays the conform changed (on Vreta just `position`), plus the result's `arrayKeys`,
  meta and state hash. A hit writes them over the input's own arrays with `shape_apply.apply_state` and
  checks the positions landed (`GOLFMAP_PREPARE_VERIFY_CACHE=1` re-hashes the whole state instead); a
  mismatch restores the input and conforms.
- Afrod's retry nudges are seeded **per mesh** from its state hash, not once per run, so no mesh's result
  depends on the ones before it. On Vreta nothing fails to project, so not a single random number is drawn.
- `--no-conform-cache` / `GOLFMAP_PREPARE_NO_CONFORM_CACHE=1` presses the operator button as before. The
  cache also turns itself off for a scene with pot bunkers (only the operator does its rename pass).
- Report `cache`: hits, misses, `renamedHits`, meshes, the 20 non-Spline objects the Afrod loop only
  converts, and hash / replay / compute / store seconds.

Vreta `vreta_svg_1988.blend` (996 Spline meshes, 4.11 M vertices, 644 MB OBJ, 51 MB of cache):

| run | import | conform | total | cache |
|---|---|---|---|---|
| the Conform All button (the run that built the existing `vreta_svg_1988.conformed.blend`) | 6.5 s | 148.5 s | **157.2 s** | - |
| cold, empty cache (two runs) | 5.1-5.9 s | 132-146 s | **139-154 s** | 0 hits, 996 misses (hash 7.2, compute 113-127, store 8.8) |
| warm, same `.blend` (two runs) | 5.1-5.6 s | 13.6-13.7 s | **20.7-21.4 s** | 996 hits (hash 7.3, replay 4.9) |
| `vreta_svg_1988.blend` against a cache warmed by `vreta_svg_1987.blend` | 5.2 s | 71.4 s | **78.5 s** | 526 hits, 470 misses |

A warm conform is 7 s hashing the 996 inputs (unavoidable - it is the key) plus 5 s writing the results back.
A cold one is a little faster than the button (the operator deselects all 1016 objects per mesh; this walks
them one at a time).

The 526 are exactly the meshes the two exports share byte for byte (a dump of both source `.blend`s: 548 of
1030 shared objects identical, of which 22 are the hidden OPCD template objects the conform never touches;
300 moved, 180 changed vertex count, 8 new, 2 gone). So the hit rate is simply how much of the course the
new SVG changed - between those two exports, half of it.

Equivalence (the speed-shim rule in [AGENTS.md](AGENTS.md)): the cold, warm and cross-version outputs and
the existing `vreta_svg_1988.conformed.blend` built by the operator have **identical state hashes for all
1039 mesh objects** and max |dx| = |dy| = |dz| = 0 over all 4.11 M vertices (`scratch` scripts
`dump_blend.py` / `diff_dumps.py`, run 2026-10-14).

#### Key, hit and terrain sidecar (2026-10-14)

**Key.** Two more things are in it, both of them silent staleness before:

- **Every conform target's state hash** (`shape_prepare.target_fingerprints`, `CONFORM_TARGETS` =
  `Outer`, `Terrain`). The Shrinkwrap's result is decided by the object it projects onto, and an
  Outerplot mesh projects onto `Outer`, which OPCD builds *inside* the `.blend` — the terrain OBJ's
  content hash says nothing about it, so a regenerated `.blend` with a new outer plot was served the old
  results. Vreta has no `Outer` (`conform targets Outer -, Terrain 07f70b941617` in the summary), so
  this costs it only the Terrain hash: **4.8–4.9 s** per run, the one new cost in the table below.
- **The mesh's modifier stack** (names + types). `capture_state` cannot see modifiers and the conform
  clears them before flattening, so two inputs that differ only in their stack hashed the same.

**Hit.** A hit now does the two things the operator's own per-object body does and the replay did not:

- it **clears the mesh's modifiers**, as `flatten`/`project` are preceded by `if o.modifiers:
  o.modifiers.clear()`. A mesh that arrived with a modifier used to keep it through a hit, so the hit
  and the miss left different objects behind (`cache.modifiersCleared` counts them);
- it adds the **`fixed` count stored with the result** — how many vertices Afrod's retry nudged when the
  result was computed — into the report, so `fixFailedProjections` on a warm run is what the cold run
  said (`cache.fixedHits` counts the results that carried one). The nudged positions and the `TempFix`
  vertex group were always replayed; only the count was lost, and the report was quietly wrong.

**Terrain sidecar.** Every run — cache or not — now writes `<name>.conformed.terrain.json`
(`golfmap-conformed-terrain-v1`): the content sha of the terrain.obj the conformed `.blend` holds, plus
the conform-target hashes. The report gained `terrainSha`, `terrainSidecar` and `conformTargets`; the
cache block gained `targets`, `targetHashS`, `fixedHits` and `modifiersCleared`.

Vreta `vreta_svg_1988.blend` (996 Spline meshes, 4.11 M vertices, 644 MB OBJ, 51 MB of cache), with the
target hash in the key:

| run | import | conform | total | cache |
|---|---|---|---|---|
| cold, empty cache | 5.4 s | 151.4 s | **160.6 s** | 0 hits, 996 misses (hash 7.4, targets 4.9, compute 128.9, store 9.0) |
| warm, same `.blend` | 5.6 s | 18.4 s | **25.9 s** | 996 hits (hash 7.2, targets 4.8, replay 4.9) |

Both runs' reports agree on `fixFailedProjections` (`{objects: 0, vertices: 0, byObject: {}}`),
`failedObjects`, `failures` and `unchanged`, and all **1039 mesh objects hash identically** to each
other and to the existing `vreta_svg_1988.conformed.blend` (built by the Conform All button).

Vreta cannot exercise any of this (nothing fails to project, no mesh arrives with a modifier, no
`Outer`), so there is a synthetic headless test — a tilted `Terrain`, a flat `Outer`, a Spline mesh
hanging off the terrain, an `Outerplot` mesh — over one cache (it also covers the grid path below):

```powershell
& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --python-exit-code 1 --python blender/tools/shape_prepare_cache_test.py
```

### Carry-over from the previous build (2026-10-18)

The conform cache and the op cache key on mesh state, and OPCD rebuilds every shape of the SVG on each
cloud build: an unchanged shape comes back with ~1 mm of vertex jitter (zero mean) or a new triangulation,
so a new `<prefix>_svg_<n>.blend` made both caches cold for the whole course (50-60 min of replay on Omberg)
even when a handful of shapes changed. svg_106 → svg_107 (154 → 309 SVG shapes): of the 276 common meshes
whose SVG shape was byte-identical, 62 came back bit-identical, 147 with the same topology and vertices up to
5 mm off (median 1.3 mm), 54 retriangulated, 13 moved more.

So before the conform `shape_prepare` (`tools/shape_carry.py`; the worker's prepare and the CLI run the same
`run`) puts the previous build's source mesh back for every mesh whose shape is unchanged:

- **Which shape is unchanged**: every SVG export writes `<stem>-shapes.json` beside the SVG (and into its
  export snapshot): per SVG id 12 hex of sha1 over the path's layer, style, fill-rule and `d`
  (docs/gspro/export.md "The shape table"). The table used is the one beside the SVG that built the .blend:
  of the SVGs next to it and in `export-history/`, the one that explains its shape ids best (on a tie the
  newest written before the .blend; OPCD's .blend can be older than the export that explains it best, when it
  was built from an SVG that was then overwritten). A mesh depends on its own shape; a blend (`_B_`) and an
  `Outer_Deep_Sat` fill piece also on every shape whose mesh shares a border vertex with it, and on that set
  (`depends_on`); a fill piece that borders only fill pieces depends on none. The ids stay the names; no
  fingerprint goes into a name.
- **Which mesh is the same**: same name, attributes, materials and vertex groups, and either the same topology
  with equal integer attributes and every vertex within 5 mm (`MAX_MOVE_M`) of the previous build's, or the
  same border (`match_border`: as many border vertices, each within 5 mm of its own old one) - OPCD fills an
  unchanged outline anew often (svg_108 → svg_107 on Omberg: 110 of the 150 meshes of another topology kept
  their border).
- **Seams**: OPCD's meshes tile the course, so both sides of every seam must come from one build. Every mesh
  that passes the checks above is swapped, and a kept neighbour that is not bit-identical (another
  triangulation, an edited shape, a fill piece, a new mesh) takes the swapped mesh's position at every border
  vertex they shared in OPCD's new build (the weld, `weld_plan`: as far as the swapped mesh moved, ~1 mm). It
  misses both caches anyway. The rule asked for first - swap a mesh only when every mesh sharing a border
  vertex with it is swapped too or bit-identical (`GOLFMAP_CARRY_SEAMS=strict`, `settle_clusters`) - swapped
  0 of 746 meshes on Omberg: every mesh is joined to every other through seams, so one retriangulated mesh
  blocks them all. After the swap and the weld, every border vertex pair that coincided in the new build is
  checked again (`seam_check`; a gap puts every swap and weld back - never expected), and after the conform
  `shape_apply.slab_seam_check` runs over the swapped meshes and their neighbours.

The swap writes the old arrays (positions, topology, UVs, paint) and keeps the new object's custom
properties; for an unchanged shape they are equal, so the mesh state is the old one bit for bit and both caches
hit. State lives in `shaping-staging/carry-over/`: `builds/<source stem>.json` (the SVG + shape table a build
was made from, per mesh its state hash after the carry-over, shape and neighbours) and `meshes/` (the states
by hash, shared between builds; the newest 4 build records are kept). The previous build is the newest record
of a source `.blend` older than this one. A carried mesh keeps the mesh of the build it was first carried from
for as long as its shape stays unchanged.

**Measured on Omberg (2026-10-18)**, svg_108 recorded, svg_107 prepared from it (15 of 317 shapes differ):
417 meshes swapped (144 of them retriangulated by OPCD inside the same border), 200 identical, 129 kept
(89 another border: 49 `Outer_Deep_Sat` fill pieces, 23 roughs, 8 roads; 22 new, 14 shape changed, 4
moved); 56 kept meshes welded (11 312 border vertices, ≤ 1.9 mm); after the conform 152 477 shared border points,
none open. The carry-over costs 10 s. **Conform cache: 617 of 746 hits with it, 200 without.** **Op cache, both
replays against only svg_108's 321 entries: 47 of 316 units hit with it (bunker recipes, ~4 s saved), 0
without - the replay stays ~2300 s of compute either way.** The units read neighbourhoods, not single meshes:
all 140 rock-slab cut-outs (2750 s) read the fill pieces and deep rough under the slab, every tee flatten the
rough around it, and those big meshes are exactly the ones whose border changes when any shape inside or next
to them is added or edited (OPCD re-cuts and renumbers its fill tiles). So the carry-over keeps the source
meshes stable but does not yet warm the replay; that needs the cut-outs (and tees) keyed on the part of a
mesh they read rather than on its whole state.

The report's `carryOver` has the counts per reason (`swapped`, `identical`, `new`, `noShape`,
`shapeChanged`, `topology`, `attributes`, `moved`, `seam`, `seamCheck`), a few examples each, every mesh's
code (`meshes`), how far the swapped meshes moved back, and the seam checks. `--no-carry-over` /
`GOLFMAP_PREPARE_NO_CARRY_OVER=1` keeps every mesh as OPCD built it. An SVG exported before the table existed
gets one with `bun run py gspro.py svg-shapes <svg>...`. Synthetic test (pairs of builds: a jittered pair
swapped, a mesh triangulated anew inside its border swapped, one with another border kept and welded to its
swapped neighbour, an edited shape and the blend joining it kept, a fill piece, a bit-identical neighbour, the
strict rule, the seams closed and a 1 mm gap seen, a third build carried from the second):

```powershell
& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --factory-startup --python-exit-code 1 --python blender/tools/shape_carry_test.py
```

### The grid conform path

The cache only helps the meshes that did not change. A cold conform — a first export, a new terrain, half a
course redrawn — still cost 0.13 s a mesh, and that is what `--conform grid` is for.

**Where those 0.13 s went.** Not into the Shrinkwrap. cProfile around the operator's own per-object body
(`_conform_one`) over 20 Spline meshes spanning the size range, cold: 4.21 s for 37 826 vertices (scratch
`profile_conform.py`, `conform-20.prof`):

| | s of 4.21 | share |
|---|---|---|
| `bpy.ops`'s own `view_layer.update()` — 119 calls, 33 ms each | 3.925 | **93.3 %** |
| the operators' C code (`_bpy.ops.call`), 60 calls — the Shrinkwrap evaluation among them | 0.126 | 3.0 % |
| the per-object select / active bookkeeping | 0.068 | 1.6 % |
| Afrod's `flatten_mesh` (a bmesh round trip) | 0.049 | 1.2 % |
| `capture_state` + `state_hash` (the cache key) | 0.042 | 1.0 % |
| `fix_failed_projections`' scan for missed vertices | 0.032 | 0.8 % |

Blender's `bpy.ops` wrapper calls `view_layer.update()` before **and** after every operator, and in this
scene — 1016 objects and a 4.2 M-vertex Terrain — each one costs 33 ms. The per-object body makes two
operator calls (`bpy.ops.object.shade_smooth()`, inside Afrod's `project_mesh`, and `object.convert`), so
four updates, 0.13 s: the whole per-mesh cost, to the millisecond. The projection is free by comparison and
does not scale with the mesh — `object.convert` costs the same 0.055–0.075 s for a 77-vertex blend as for a
15 329-vertex mesh. The **target's BVH is not rebuilt per object**: the first mesh costs 1.41 s instead of
0.147 s (the depsgraph's first evaluation of the new Shrinkwrap, which builds the tree over the Terrain's
8.4 M triangles) and every mesh after it the same flat 0.147 s.

**So the grid path computes the projection instead of casting it.** The terrain is our own regular grid
(`terrain_obj.py`), the flattened mesh's rays go straight up, and the Terrain is single-valued, so a
vertex's height is a cell lookup: `searchsorted` for the cell on each axis, the fractional position in it
for which of the cell's two triangles, that triangle's plane for the height. numpy does a whole mesh in one
pass, and `shape_prepare.conform_one_grid` does the rest of the operator's per-object body without an
operator at all — modifiers cleared, `Mesh.shade_smooth()` instead of the `shade_smooth` *operator*, no
`object.convert` (there is no modifier left to apply), and Afrod's retry reproduced for the vertices the
projection misses (the same 1 cm nudge in x then y out of the same seeded `random`, in vertex-index order,
then a second lookup; whatever still misses keeps the nudge and stays at the flatten depth).

The lookup maths lives in `terrain_obj.py` (`grid_axes`, `plane_height`) — the file that wrote the OBJ, so
the grid, the spacing, the origin, the negated x and `unity.position` are not restated. Two details:

- **Not the `.raw`.** OPCD's Import Terrain OBJ applies a **Smooth** modifier to the imported terrain
  (`use_y` only, factor = Terrain Smooth, default 1.5), so the Terrain in the `.blend` is up to **1.14 m**
  from the heightmap it came from (mean 15 mm on Vreta). The heights therefore come from the Terrain object
  itself — which is by definition the surface the Shrinkwrap's rays meet. The sidecar is still what proves
  the object *is* that grid: `terrain_grid` checks the node count, that one x runs down every column and one
  y across every row (Vreta: 2e-7 m), that the axes are where `grid_axes` puts them (0.49 mm — the OBJ's 7
  significant digits), and that the heights are the `.raw` put through `terrain_obj.smooth_grid` (0.78 mm).
  `smooth_grid` is that modifier: Blender accumulates each incident **edge's midpoint**, so the neighbours
  weigh `factor/2`, not `factor`, and the neighbours are the six the OBJ's two triangles a cell make — east,
  west, north, south and the **anti-diagonal** — fewer on the border.
- **The axes are not evenly spaced.** The OBJ's coordinates carry 7 significant digits, so a 2050 m side is
  quantised to 0.5 mm, and those quantised nodes are the triangle corners the rays actually meet. The cell
  comes from `searchsorted` over the Terrain's own node coordinates, not from dividing by the spacing.

`--conform grid`, or `GOLFMAP_PREPARE_GRID_CONFORM=1` (which `shape_prepare.run` reads, so the shaping
worker can be asked for it without a flag of its own). **The grid path is the default since 2026-10-14** (`--conform afrod` or `GOLFMAP_PREPARE_GRID_CONFORM=0` for the operator path). Meshes
that project onto `Outer`, carry shape keys, share their mesh datablock or sit under a non-identity
transform keep it per mesh (`grid_blocked`, counted in the report as `cache.operatorWhy`), and a scene with
pot bunkers keeps it entirely — only the operator's loop does its rename pass. Vreta needs none of those:
all 996 meshes take the grid path.

**Equivalence.** Not bit-identical, and it cannot be: the operator's rays start at the flatten depth, 100 m
below, and are cast in float32, where one step at 100 m is 7.6 µm. The grid path evaluates the same
triangle's plane in float64 and rounds once, so it is the *more* exact of the two and the gap is the
operator's own noise. Measured against that float64 plane on three meshes, the worst ones included (scratch
`exact_check.py`): the grid path lands on the **nearest float32 to the exact height at every vertex**
(within 0.5–1.9 µm, half a float32 step), the operator's rays on 18–28 float32 steps away (up to 36 µm).

Both paths run on every one of Vreta's 996 Spline meshes from the same input state in
one session (scratch `compare_paths.py`, 4 109 059 vertices):

| | |
|---|---|
| arrays that differ | **only `position`** — every other attribute, and every `capture_state` meta (counts, materials, vertex groups, custom props, matrix, active/render colour), identical on all 996 |
| max \|dx\|, \|dy\| | **0, exactly** |
| max \|dz\| | **3.81e-05 m** (38 µm, up to 28 float32 steps at the terrain's heights) |
| vertices bit-identical | 327 513 (8.0 %) |
| within 1e-5 m | 3 628 427 (**88.30 %**) |
| within 1e-3 m | 4 109 059 (**100 %**) |
| vertices on a cell diagonal | 243 — and the tie is moot: the two triangles' planes **agree exactly** on `fx + fz == 1` (both reduce to `(1-fx)·h10 + fx·h01`), so the lookup takes the first and Blender's watertight ray test takes whichever it likes, for the same height |
| `fix_failed_projections` | 0 both ways on every mesh (nothing on Vreta misses). On the synthetic test's mesh that does hang off the grid, the retry's nudged x and y are **bit-identical** — the same seeded `random` in vertex-index order, rounded to float32 where Afrod's `vert.co.x +=` rounds it |

And at the whole-file level (`dump_blend.py` / `diff_dumps.py` over the saved `.conformed.blend`s, 1039 mesh
objects each): the operator run of this refactored code has **identical state hashes for all 1039 objects**
to the existing `vreta_svg_1988.conformed.blend` the Conform All button built, so nothing about the operator
path moved; the grid run matches it on 43 (the 20 objects the Afrod loop only converts, the 22 hidden OPCD
template objects, the Terrain) and differs on the 996 Spline meshes in `position` alone — max |dx| = |dy| =
0, max |dz| = 3.8147e-05 — with no object differing in vertex/face/loop count, attribute set, materials,
vertex groups or custom props.

Which path produced a result is therefore part of the cache's env key (`cache_env_key`'s `path=`, plus
`terrain_obj.py`'s sha for the grid path) and of each mesh's key (`grid_blocked`'s answer, because two of
its reasons — a shared mesh, shape keys — are invisible to `capture_state`). Flipping the default can never
serve one path's results for the other's.

**Vreta, `vreta_svg_1988.blend`** (996 meshes, 4.11 M vertices, 644 MB OBJ, 51 MB of cache):

| run | import | conform | total | conform cache |
|---|---|---|---|---|
| operator, cold | 5.3 s | 155.0 s | **163.6 s** | 0 hits, 996 misses (hash 5.2, targets 3.5, **compute 137.8**, store 7.0) |
| operator, warm | 5.3 s | 12.5 s | **19.4 s** | 996 hits (hash 4.6, targets 3.4, replay 3.1) |
| **grid, cold** | 4.7 s | **15.9 s** | **22.7 s** | 0 hits, 996 misses (hash 4.8, targets 3.2, grid read 0.4, **compute 1.1**, store 5.4) |
| grid, warm | 4.7 s | 11.6 s | **18.3 s** | 996 hits (hash 4.4, targets 3.0, replay 3.0) |
| grid, `GOLFMAP_PREPARE_GRID_CONFORM=1` | 4.7 s | 11.6 s | **18.3 s** | the same key as `--conform grid`: 996 hits |
| grid, `--no-conform-cache` | 4.7 s | 13.7 s | **20.4 s** | off: 996 computed in 1.0 s, nothing stored |

The conform **compute goes from 137.8 s to 1.1 s** (125×) and a cold prepare from 163.6 s to 22.7 s. What
is left of a cold conform is the cache's own bookkeeping, not the conform: 4.8 s hashing the 996 inputs
(that *is* the key), 3.2 s hashing the conform targets, 5.4 s writing 51 MB of results — which is why
`--no-conform-cache` is now barely slower than a cold cached run, and a warm run (11.6 s, all of it hashing
and replay) barely faster. With the grid path the conform cache no longer pays for itself: skipping the two
hashes when there is nothing to store would take a cold grid conform to ~2 s. Not done here — the input
hash also seeds Afrod's retry per mesh — but it is the next thing to take.

**Flipping the default** costs one full refresh, once: the conformed meshes move by up to 38 µm, so every
mesh's state hash changes, and with it the shaping op cache (which keys on its input meshes) and the FBX
sync fingerprints — one whole shaping replay and one whole FBX/Unity re-import. Nothing is *wrong* after it
(the grid positions are the more exact ones), and nothing silently mixes: the path is in the conform cache's
key, so the first grid run recomputes the whole course and the file is wholly one path's. The path is
deliberately **not** in `shape_worker.conformed_stale`, so flipping does not throw away a
`.conformed.blend` that is otherwise still valid — the switch happens the next time prepare runs anyway.
So: flip it together with a full course refresh, not in the middle of a shaping session.

### terrain.obj without Unity

`tools/terrain_obj.py` writes the `terrain.obj` prepare imports straight from the inner heightmap `.raw` the
GSPro export already produces, instead of the manual Unity step (Terrain > Export To OBJ, Triangles, Half -
docs/workflows.md section 1 step 8). Pure Python + numpy, no bpy:

```bash
bun run py ../blender/tools/terrain_obj.py --sidecar "D:/gspro_courses/vreta-opcd/vreta-inner-dem-2050m.tif.json" --out "D:/gspro_courses/vreta-opcd/terrain.obj"
```

Flags: `--sidecar` (the inner `<prefix>-inner-dem-<side>m.tif.json`), `--out` (default `terrain.obj` next to
the sidecar), `--raw` (default the sidecar's `raw.file`), `--sample full|half|quarter|eighth|sixteenth`
(default `half`, Unity's resolution menu - what Vreta's OBJ used), `--json`. Vreta: 5.7 s, 644 MB.

What Unity's exporter writes, and what this reproduces: header `# Unity Terrain OBJ File`, CRLF, then all
`v`, all `vt`, all `f`; the heightmap at half resolution (2049 nodes a side out of the `.raw`'s 4097, corners
included, spacing `sideM/(grid-1)` = 2050/2048 m); vertices row-major with z (north) ascending and x
descending inside a row, **x negated** (Unity is left-handed), y = metres above the heightmap's `minM`, both
offset by the terrain's `unity.position` (zero for the inner terrain) - which is exactly
`shape_coords.py`'s `.blend` frame once `wm.obj_import` has mapped obj `x,y,z` to blend `x,-z,y`; `vt` =
`ix/(grid-1) iz/(grid-1)`; two triangles a cell, cells row-major, `(iz,ix) (iz+1,ix) (iz,ix+1)` and
`(iz,ix+1) (iz+1,ix) (iz+1,ix+1)`, 1-based `v/vt` pairs, no normals; numbers in C#'s `G7` (7 significant
digits, half away from zero - `decimal`, not `%g`).

Checked against Vreta's Sep 27 `terrain.obj` (`scratch` script `compare_obj.py`): same line count
(16 785 411), same 4 198 401 vertices and 8 388 608 faces, and **every `#`, `vt` and `f` line and every
vertex's x and z byte-identical**. Only the heights differ, by at most **0.63 mm** (mean 0.31 mm, 100 % under
1 mm): that is one step of Unity's own 16-bit height storage (`heightRangeM/65535` = 40.84988/65535 =
0.623 mm), which the heights went through on their way into the editor - ours come straight from the `.raw`.
The difference is uniform over the whole square (no vertex above 5 cm anywhere), so the Sep 27 OBJ still
matches the current `.raw` everywhere: no inner terrain edit has been applied since (the `.raw` is from the
same minute). A local patch of larger differences would be exactly that - a terrain edit applied after the
OBJ was exported - and not a bug.

End to end: preparing `vreta_svg_1988.blend` against the generated OBJ instead of Unity's (139.7 s, a full
recompute - the terrain hash is part of the conform-cache key) conforms all 996 meshes to within
**max |dz| = 0.633 mm** of the `.conformed.blend` built on Unity's OBJ (max |dx| = 0, max |dy| = 0.5 µm over
all 4.11 M vertices): the terrain difference, not amplified. Every custom prop, material and vertex count is
unchanged.

Tests: `python blender/tools/terrain_obj_test.py` (synthetic `.raw` -> OBJ and back: block order, CRLF, axes
and handedness, north-up row flip, uvs, winding, sampling step, terrain position, `G7` digits, guards).

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
  meshes (replays must match); `phases` = the seconds the ops' own numbers leave out (`snapshot` and `diff`
  per op, `fingerprints`, `seamCheck`, `checks`, `places`, `hashes`), printed with the report's path.
- **Headless shims** (only around Afrod calls, add-ons unchanged): Blender's `mesh.loopcut` crashes in
  background mode (its preview draw callback needs a region type), so Afrod's `loopcut` gets an equivalent
  bmesh edge-ring subdivide; Afrod's `get_loop_at_depth`/`get_boundary_loop` (`list(set)`) and Edit Mesh
  Tools' `collect_loops` (`set.pop()`) are made order-stable, otherwise seeded recipes still differ run to
  run; `find_closest_vert` keeps its KD tree (same answers, minutes faster on long roads). After a recipe the
  engine puts back what Afrod's `meshblendseparate` breaks: the mesh comes back as `<name>.001`, the blend as
  `<mesh base>Blend` with the mesh's `opcd_kind`.
- **Speed shims** (same results, checked: positions, colour and FBX-fingerprint hashes of all Vreta meshes
  equal with and without them; `GOLFMAP_SHAPE_NO_FAST_SHIMS=1` turns them off): `find_nearby_vertices`
  (smoothcartpaths' ripple) keeps each Spline mesh's 2D KD tree while its XY is unchanged and skips meshes whose
  XY box is out of reach (it rebuilt one per mesh per path mesh); the knife cut tests "near the cut" with a set
  instead of a list; a cut's blue paint goes straight into the edit BMesh loops of its new vertices instead of
  `color_to_vertices`' Edit -> Object -> Edit round trip of every selected mesh (the cut only adds elements, so
  the order is what the round trip gives); `color_to_vertices` at full strength (recipes) writes the colour as
  arrays instead of a Python loop over every corner. The tee flatten already hides meshes out of its proportional
  reach so only those enter Edit Mode. Vreta, the Afrod ops, nothing cached: 312 s -> 153 s (cut 145 -> 53 s,
  smooth 84 -> 16 s). The cut's candidate search is ~3 % of its time and was left alone.
- **Speed shims of our own ops** (2026-10-14; same rule, same switch). `weld_tjunctions` (the T-junction weld
  behind `golfmap.cut_out`, `golfmap.path_edge_fade` and `golfmap.split_surfaces`) read the boundary of every
  neighbour of every named mesh - a slab's four cut meshes have ~270 neighbours each because a cut mesh's box
  spans the course - and put all of it into a KD tree and a segment grid. Its answers can only come from within
  a millimetre of one of the named mesh's own boundary vertices, so: the boundary points and edges are kept per
  call (one read per neighbour, forgotten when the weld changes a mesh); a neighbour whose box holds none of the
  1 m cells of those vertices (nor a neighbouring cell) is left out entirely (a summed-area table over the cells
  answers all ~996 boxes at once, `_cell_cover`); and of the ones that stay, only the points in those cells and
  the segments whose padded box covers one of the 2 m cells `_segment_grid` looks up are offered. Every dropped
  point or segment is further than the tolerance from every own vertex, and a dropped segment can only have been
  one the all-segments arithmetic rejected, so the chosen edge and `t` are the same. `tjunction_check` (the
  report's T-junction check, which measures every unpartnered vertex against every neighbour segment) uses the
  same neighbour filter. `collapse_cut_slivers` finds the cut's new vertices by matching positions (a cut leaves
  the old ones exactly where they were, so an exact match settles all but a few hundred, which are then measured
  against the old positions in their box) instead of a KD tree over every vertex of the mesh, and only the faces
  of a cut vertex offer pairs - the candidate list is sorted by (distance, indices), so which face offers a pair
  first never mattered. `golfmap.cut_out`'s border check filters the neighbours' boundary points the same way.
  `shape_transition.apply` gets the array path (next section). `diff`, `seam_check` and `tjunction_check` build
  their KD trees from `tolist()` instead of numpy scalars (same tree, no boxing). Vreta, all three layers,
  nothing cached: the whole run 1768 s -> 944 s, the ops' own seconds 1165 -> 468 s (transitions 494 -> 94 s,
  the 37 cut-outs 451 -> 184 s, edge fade 64 -> 48 s, surfaces 34 -> 23 s), and the report's `checks` phase,
  where the T-junction check takes the same filter, 555 -> 379 s. With `GOLFMAP_SHAPE_NO_FAST_SHIMS=1` the
  same run takes 2112 s
  (ops 1460 s; it also drops the older Afrod shims, so smoothcartpaths goes 29 -> 145 s) and leaves exactly
  the same geometry: all-mesh position and colour hashes equal, the position hash of each of the 659 touched
  meshes equal, 13 warnings of the same kinds, 0 seam gaps of 1664 pairs, the same 41 T-junction objects and
  the same path-surface counts. The FBX fingerprints differ for a few cut meshes in `custom_normal` only,
  which two runs of the same code do as well (section "Shaping: cut-outs").
- **Op-result cache** (`<blend folder>/shaping-staging/cache`, CLI and worker): every op runs as units (one per
  feature group; `"*"` for footprint and weld ops). A unit's reads are its targets plus every Spline mesh within
  its reach (tee flatten: its proportional radius; cut: 1 m, the weld looks 0.5 m around; smooth: the smooth
  distance + 0.5 m; recipe: the feature's mesh and its blends; footprint: meshes whose box meets the footprint +
  falloff + protect band). Key = this file + shape_layers + Blender + Afrod/Edit Mesh Tools sources, the op's
  JSON (without id/note/provenance), the unit, seed, frame, for recipes the recipe file + shape_paint + library,
  for a `rise.mode` dem cut-out the DEM window it samples (not the whole DEM; "rise.mode dem" below),
  and the full state hash (every attribute incl. selection, custom normals, byte colours, vertex groups,
  materials, props) of each read mesh. Value: the changed meshes' arrays that differ from the input (+ meta,
  created/removed names, the run record) as `.npz`. A replay is verified against the stored result hashes (a
  mismatch restores the inputs and computes). Anything an op changes outside its units' reads is reported as an
  `escape` warning and not cached. Report `cache`: hits, misses, replay/compute seconds. Vreta, all three
  layers (2026-10-14, 218 units, 1.1 GB of entries - the folder keeps every earlier engine's too, 10 GB on
  this machine, and nothing prunes them): CLI cold 944 s, warm 584-590 s and bit-equal to the cold run
  (all 218 hits: 32-35 s replay + 43-47 s hashing the inputs, ops 91-97 s). What is left of a warm run is the report's
  own work, `phases` `checks` 400 s of it: `path_surface_check` and `tjunction_check` over the path meshes the
  transitions refine to 2.4 M vertices. `neighbour_planes`' `np.add.at` is the single biggest line there; a
  stable sort by vertex plus `np.add.reduceat` would sum in the same order for the same result.
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
- **Ragged seams** (`raggedM`, default 0.3 m; 0 = the straight kerb): a gravel or dirt road meets asphalt,
  concrete or paving in a hard but uneven edge, not a fade, as on a Swedish farm road's mouth: the seam chain is
  resampled every 10 cm (above the 5 cm sliver collapse) and moved off the kerb by `shape_surfaces.ragged_offset`:
  gravel dragged out onto the hard road in lobes (0.15..1 x `raggedM`, broad ones ~1.3 m apart with ~0.45 m ones
  on them) and the asphalt edge crumbled a few cm either way, tapered to nothing over 0.5 m at an open chain's
  ends so it still meets the outline where the kerb does. A point whose lobe would leave the hard road or come
  within 0.25 m of its far side is pulled back (and its five neighbours on each side with it); a chain that would
  cross itself is retried at half the reach, twice, then left straight. Classification answers by the ragged
  line within reach of it, the fade lines stay offsets of the kerb. Report `regions.ragged` = `{chains, straight,
  halved, pulledBack, reachM}`. Fixed per chain (the seed is the chain's surfaces and start point).
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

## Shaping: cut-outs (rock slabs)

Something that is no drawn feature but needs its own mesh, e.g. a rock slab in the rough that gets a rock material
and the `GSPstone` physics material in Unity. `golfmap.cut_out` (`tools/shape_apply.py`) cuts an outline into the
course meshes and lifts the inside out as one new object. Hand layer, one op per outline
(`docs/gspro/<course>/shaping/20-rocks.json`):

```json
{ "id": "hall-h11-north", "op": "golfmap.cut_out", "name": "hall_h11_north",
  "outline3006": [[530110.5, 6487074.6], [530112.0, 6487075.19], [530114.23, 6487074.93]] }
```

- **Cut**: every visible Spline mesh under the outline (meshes and blends, any surface) gets the outline as an exact
  edge chain (`insert_polyline`, as `split_surfaces`; the ring goes in twice from opposite starts so it closes), then
  the cut's slivers collapse (`sliverM`, 0.05 m) and `weld_tjunctions` runs on the cut meshes (`weld`, default on).
  An outline that covers a vertex of a `protect` type (default green, bunker, water) cancels the op with a warning.
- **Separate**: the faces inside leave their meshes, which keep their names, ids, materials and paint. They are
  joined into `Spline_<name>_<surface>_-_Mesh` (`surface` default `Rock`), welded along the old mesh borders inside
  the outline. Props: `opcd_kind` mesh, `opcd_shape_id` = `name`, `golfmap_surface`, `golfmap_cut_from`. The new
  object carries the first source's material until Unity gives it its own.
- **UVs**: the new object gets planar UVs (or box UVs, `uv` below), one tile per `uvM` metres (default 4): OPCD's meshes have none, and
  the rock material Unity puts on a slab needs them. Unity: `golfmap.slabs.materials` (`GolfMapRockSlabs.cs`) gives
  every `*_Rock_-_Mesh` the material and physics material of `<course>/rock-slabs.json`; `golfmap.course.refresh`
  runs it after the mesh sync (step `slabs.materials`), so a re-synced slab keeps its rock look and `GSPstone`.
  A slab must not carry OPCD's `MeshChannelMaterialsStore`: OPCD's Set Default Materials reads every store of the
  scene on each run and logs ~40 "Material doesn't have a ... property" errors (`_RedHeightTexture`,
  `_TerrainSize`, `_RedOverallColor` ...) per slab that has one. Slabs are left out of that menu's selection, and
  the store is removed by `slabs.materials` and before each Set Default Materials our tools run
  (`GolfMapRockSlabs.StripChannelStores`); `golfmap.materials.audit` lists any that has one.
- **Border**: both sides share the cut's vertices, so there is no gap and no T-junction; custom normals come from the
  smooth normals before the cut on both sides. Run `border` = `{vertices, unmatched, maxAbsDz}` (0 unmatched
  expected), `areaCheckM2` (area before - inside - outside, 0 expected), `sources[]` (per source mesh: faces and area
  taken, the cut's stats).
- **Names**: `name` is lower-case words joined by `_`; neither it nor `surface` may contain a golf surface word
  (deep, rough, semi, fairway, green, tee, bunker, water, creek, lake): Unity's `GolfMapSurfaces.Classify` reads the
  class off the name, and a rock must come out as Other (vegetation keeps off it).
- **Keep the outline off other meshes' edges**: a corner that pokes 1 cm into the next mesh takes a sliver of it
  (report `sources[]` with a tiny `areaOutM2`). Move the corner.
- **Reach** (`plan_units`): one unit per op; reads = every Spline mesh within 1 m of the outline's box (with `rise`,
  1 m + `apronM`) and every mesh within 1 m of those meshes' boxes: the welds run on the whole boundary of the meshes
  they are given and split their neighbours' edges anywhere along it (Omberg hall-58 escaped its reads into lake-bed
  pieces and a gravel path ~20 m off the apron, so it was never cached).
- **Time**: 2-7 s a slab (Vreta's 37: 184 s uncached, 5.0 s each), most of it still `weld_tjunctions` and the
  cut's two `insert_polyline` passes over the meshes under the box. It was 10-20 s before the weld's neighbour
  filters (README "Speed shims of our own ops"), and 260 s a slab before the 2 m segment grid
  (`_segment_grid`) replaced measuring every unpartnered vertex against every neighbour edge. What is left of the
  weld is reading the boundary of the neighbours that survive the filter, once per slab; a boundary cache that
  survived a whole op (with a forget on every mesh the engine changes) would take that out too.
- **Not reproducible to the bit: the custom normals** (found 2026-10-14; it was an open question before). Two
  runs of the same code give a different FBX fingerprint for a few of the cut meshes and slabs (4 of 1037 in one
  pair, e.g. `Spline_hall_217_Rock_-_Mesh`), and the only thing that differs is the `custom_normal` attribute
  (CORNER, INT16_2D) that `_drop_cut_attrs` writes with `normals_split_custom_set_from_vertices`: Blender
  encodes a custom normal against the mesh's own computed normals, which it sums in parallel, so a corner here
  and there lands on the next int16 step. Positions, colour bytes and every other attribute are equal, and so is
  the result of a replay (the cache stores what it computed). A run with and without the speed shims differs the
  same way and no more: 15 of 1037 fingerprints over all of `00-global` with all 1037 position and colour hashes
  equal, and of five slab cut-outs re-run with every attribute hashed, the one mesh that differed differed in
  `custom_normal` only. It costs a re-export of those meshes, no gap.
- **`rise`** (a klippa instead of a flat slab; from the feature's `rise*` attributes, shared/features/rock-slab.ts):
  `{topM, waterM?, footM 0.35, apronM 3, noiseM 0.22, maxEdgeM 0.35, seed}`. After the cut the slab is refined to
  `maxEdgeM` (the cut keeps OPCD's ~1.2 m triangles) and the ground within `apronM` to twice that, T-junctions
  closed, then every vertex of the slab and of the meshes within reach (not green, bunker, tee, path) goes to
  `max(z, target(x, y))`: inside the outline a rounded rise (`1 - (1 - t)^2.4` of the distance in, over the
  inradius) from the foot (`footM` under `waterM`) to the top (`topM` over `waterM`, or over the highest ground on
  the outline without water) plus lumpy noise (2.2 / 0.9 / 0.35 m) of `noiseM`; outside a shoal / apron falling from
  the foot to the lowest ground within `apronM`. Lift only and one height per XY, so the vertices two meshes share move
  alike and no seam opens. With `waterM`, the faces of the meshes around that end up wholly under the water and
  connect to the lake (flood from the lake's and its blends' boundary, within `apronM` + 12 m) join the lake mesh,
  with the lake's paint: a shore notch drawn round a rock leaves rough on the lake bed, and the tall grass grew up
  through the water there. Report `rise` = `{topZ, footZ, bedZ, inradiusM, refinePasses, weld, lifted, maxLiftM,
  sunk}`. Unity's water plane takes a slab standing in a lake into the plane and leaves the rim beside it out of the
  level (unity/README.md "Water planes"). Vreta hall_247 (hole 15's lake, 2026-10-15): the slab lay on the dug lake
  bed in a notch of the shore and the plane followed it down to 7.91 m; with `rise` {waterM 9.43, topM 0.9} the rock
  stands 9.08-10.40 m, 3126 faces of the rough ring and channel round it joined the lake, 0 seam gaps.
- **`rise.mode` `dem`** (a cliff; feature attribute `riseMode: 'dem'`, default `dome` = the klippa above):
  `{mode: "dem", waterM?, apronM 3, noiseM 0, maxEdgeM 0.3, seed}`, no `topM` / `footM` (validation refuses them;
  the generator leaves them out with a warning). Why: Omberg's 14th green stands on a granite cliff that drops ~13 m
  almost straight into Vättern. The lidar DEM (0.5 m) has it, the course meshes lose it: Blender's terrain is the
  half-resolution heightmap (0.737 m grid), OPCD's Terrain Smooth rounds it, the meshes have ~1.2 m triangles. On
  Omberg's biggest shore cliff (36 x 113 m box, 22 m drop) the DEM has 1979 cells of >= 55° (steepest 80°), the
  conformed terrain 730 faces (steepest 67°), its heights on the cliff above the water 0.3-0.5 m off the DEM (p95);
  the OPCD meshes over it are smoother still. After the same refinement as a dome (the slab to `maxEdgeM`, the apron ring to twice that, T-junctions
  closed; here with bmesh's `use_single_edge`, so no zero-area sliver is left to stand up as a vertical face) every
  vertex of the slab goes to the DEM's height at its XY, up or down, and the vertices of the meshes within `apronM`
  outside the outline (not green, bunker, tee, path) blend from the DEM at the outline to their own height at `apronM`
  (smoothstep). One height per XY, so shared vertices move alike; a vertex shared with a green, bunker, tee or path
  keeps its height (`pinned`). Paths joined the kept types on 2026-10-17: 33 of Omberg's shore and outcrop slabs had
  their 3 m apron over the gravel road, which came out refined and pulled toward the DEM with 851 steep faces and
  4773 shading faults (the `pathSurface` check; dark smudges in GSPro). `waterM` joins the faces left under the water to the lake, as above. The DEM is the inner
  heightmap export next to the .blend, `<prefix>-inner-dem-<side>m.tif` (the `--sidecar`'s `.tif`; the edited DEM, so
  a lake bed is already dug), bilinear between pixel centres, z = H - `minM` + `unity.position.y`
  (`shape_coords`); on Omberg's conformed terrain that frame puts the DEM within 1.7 cm (p90, median 1 mm) of
  terrain.obj's vertices, and a half-pixel shift either way fits worse. It is read in Blender's own Python (numpy +
  zlib: classic TIFF, strips or tiles, deflate, predictor 1 or 3, the file the pipeline writes; bit-exact against
  rasterio, the whole 3020² band in 0.2 s) because the worker may run where there is no pipeline venv; only the
  blocks under the op's window are read, and the window is cached per DEM content. The op cache keys on that
  window only (`dem_window_sha`: the outline's box + `apronM` + 1 m + `DEM_PAD_PX`, its heights as read, rows and
  columns and the pixel grid; the frame with `minM` keys every unit anyway), so a DEM edit re-cuts only the dem
  slabs whose window it touches. Until 2026-10-17 the key was the whole file's sha1: digging one Omberg pond 2 m
  re-cut all 141 slabs (10-75 s each, most of an hour). Omberg svg_106 (CLI, 2026-10-17): cold 3427 s (cut-outs
  1521 s); then the DEM dug 2 m in a 20 x 20 m square 500 m from every slab: 261/261 units hit, the cut-outs 30 s,
  the run 1139 s (key hashing 609 s, checks 345 s) and hash-identical to the cold run. A window that cannot be read (outside the DEM, a TIFF the
  reader refuses) keys on the whole file's sha1 and the cut cancels. A terrain.obj older than the DEM (a lake dug
  since) shows as the slab standing below or above its neighbours: re-prepare first. Report `rise` = `{mode, dem,
  demSha, window, windowSha, slabZ,
  maxUpM, maxDownM, moved, pinned, steepFaces (>= 55°), maxSlopeDeg, seams {points, open, maxDz}, sunk, ...}`;
  `seams.open` > 0 is a warning. Test: `blender/tools/shape_cliff_test.py` (a 10 m step in a synthetic DEM across
  an outline over a plane of 1.2 m triangles; 0.5 s). On Omberg (a 20 x 8 m outline on a 52° bank of hole 1's
  rough, 164 m²): 11 199 faces, cut 4.0 s + rise 4.5 s, 0 unmatched border vertices, 0 open seams over the course.
- **Granite shaping of a dem slab** (on by default; `rise` keys, each 0 = off): the DEM alone read as rounded dough
  in Unity (0.5 m cells, mostly interpolated across the faces), and granite is blocky, in ledges, broken facets and
  crisp edges. Only the slab's interior moves, with a smooth falloff from 0 on the outline to 1 at `falloffM` (1.5) in:
  the outline ring, the apron and every vertex another mesh shares stay exactly as the plain dem rise leaves them.
  Seeded by `seed` (default from the name), deterministic, in this order:
  1. `sharpen` 0.8, `sharpenRadiusM` 2: unsharp mask of the DEM on its own grid, z + 0.8 (z - blur(z)), Gaussian
     sigma = radius / 2: steeper faces, crisper crests (it overshoots a perfect step: 3.2 m on the test's 10 m step);
  2. `facets` 0.6, `facetM` 2.5: Voronoi cells (one jittered seed per 2.5 m square), each cell's heights pulled 60 %
     toward the least-squares plane of its sharpened DEM heights: planar blocks, broken edges where cells meet;
  3. `terrace` 0.5, `terraceStepM` 1, `terraceMaxDeg` 60: ledges, z pulled halfway toward a stepped profile (flat
     tread, soft riser in the last 35 % of a step, the levels offset per facet so no ledge is one contour) where the
     sharpened DEM is under 60° (fading over the 10° below), so the big faces stay faces. After the facets, which
     would flatten the ledges again;
  4. `reliefM` 0.35, `reliefMinDeg` 55: on the faces (the sharpened DEM over 55°, fading in over 50-60°) the vertices
     move horizontally along the face's outward normal by 3-octave 3D value noise (3 / 1.2 / 0.5 m), so a wall is not
     smooth; a face that would flip has its vertices' move halved, up to 6 times, and what still flips is reported
     (and warned);
  5. `hardEdgeDeg` 35: the rock's normals split by angle (sharp edges, smooth faces, no custom normals), so the facets
     light as crisp edges; the FBX exporter writes the split corner normals (Unity must import normals, not
     calculate them).
  Report `rise.granite` = `{vertices, before / after {meanSlopeDeg, steepShare}, steps {sharpen, facets, terrace,
  relief: {maxDz, maxDxy, meanSlopeDeg [before, after], steepShare [before, after], flips ...}}, hardEdges
  {sharpEdges}, seconds}` (mean slope area-weighted, steepShare = the area share of faces >= 55°). Omberg hall-58
  (the 14th green's cliff and rock shore, 8134 m², 547 513 faces, 271 273 interior vertices): mean slope 24.4° ->
  27.3 (sharpen) -> 27.5 (facets) -> 29.8 (terrace) -> 29.9° (relief), steep share 8.6 % -> 14.0 -> 12.3 -> 21.9 ->
  21.4 %, max dz 0.96 / 1.08 / 0.33 m, relief 0.25 m sideways at most, 0 flips, 1357 cells, 56 099 sharp edges, 0
  open seams; the op 90 s (cut 11 s, rise 70 s, most of it the refinement and welds).
- **A cliff into a lake** (`waterM` with mode dem): the outline may run out over the meshes of the lake the water
  join targets (the water mesh with the most vertices within the apron, and every object of its drawn shape: its
  pieces and blends). The rock takes the bed faces it covers, which go to the dug DEM, so the face runs on down
  under the water instead of a band of lake bed standing above it (the dark jagged line Omberg's 14th green showed
  at the waterline); the lake keeps its name, material and paint and meets the rock along an ordinary cut seam.
  Tees join the protected types for such a slab (when the op sets no `protect`), and every other water - ponds,
  creeks - still cancels it. The slab's material and collections come from its first source that is no lake bed.
  Report `lake` = the lake's objects.
- **`uv` `box`** (feature attribute `uvMode: 'box'`, default `planar`): every face of the slab projected on the
  plane of its dominant normal axis (top faces XY, steep faces YZ or XZ), `uvM` metres a tile, so a cliff's faces
  carry the rock texture unstretched instead of a top-down smear. The seams between projections do not show on rock.
  Set again after a rise, on the refined mesh.
- **Vreta** (`vreta_svg_1985`, two slabs east of hole 11's green, out of `Spline_Outer_Deep_Sat_3_5_piece2_-_Mesh`):
  41.6 m² / 92 faces and 54.2 m² / 115 faces, border 57 and 61 vertices with 0 unmatched, 0 new seam gaps and 0
  T-junctions over the course, 1.9 s each, op-cache replay 0.1 s with the fresh apply's all-mesh hash. The op only
  cuts: the faces keep the source's ~1.2 m triangles and heights.

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
  and paint across as a sawtooth; an edge with both ends inside the zone that leaves it on the way - OPCD's rungs
  straight across a narrow path, seam to seam - is first split where it is farthest out, so it crosses too: unsplit,
  its halves put teeth to the path's middle, Vreta roads_141/143/145 until 2026-10-15, test
  `shape_edgefade_rungs_test.py`), then every edge inside that zone is halved until it is at most `maxEdgeM`; the
  path faces whose centre is within the effective width of the seam move to the strip. The strip now reaches that far
  (`widthM`, default 0.3 m, at most 60 % of the piece's half width - measured at its vertices and edge midpoints, as a
  path of rungs has every vertex on a seam - so a narrow path keeps a core; a piece with less
  than 0.1 m to give is left alone) into the path, its outer edge (welded to the rough / deep / fairway mesh beside it)
  does not move, and the path loses that much mesh. Faces grow with 1 / `maxEdgeM`^2: default 0.3 m; Vreta's whole
  `roads_124` gravel (8 pieces, 3 blends, ~6 km of strip edge) takes ~40 s and ~0.4 M faces, at 0.2 m ~1.1 M. Raise
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
  imported FBX needs no replay (Vreta `roads_124`: 12 s, 5.5 s of it the five phases the run reports and the
  rest its weld). The whole op on Vreta (18 road shapes) takes 48 s uncached, 21 s of that the units
  themselves and the rest the op cache hashing the state of everything their welds can reach.

## Shaping: rounded hard-road edge

`golfmap.path_kerb` (`tools/shape_kerb.py`, tests `python blender/tools/shape_kerb_test.py`): an asphalt road is
laid 4-5 cm thick and rolled out at its edge, so in reality it ends in a rounded lip above the verge, dirt and shadow
in its angle and grass leaning over it; OPCD's road, fringe strip and grass meet flush and read as a flat line.
`shaping-global` emits it after the footprints whenever a path is asphalt, concrete or paving:

```json
{ "id": "paths-kerb", "op": "golfmap.path_kerb", "select": { "type": "path" } }
```

- **Strips**: per road shape, on every blend of a hard surface (`surfaces`, default asphalt, concrete, paving; the
  surface as `golfmap.path_edge_fade` reads it), the faces with a vertex on a hard piece's boundary and the rest on
  no road mesh (a strip between two roads stays flat). Each rung (road edge to grass edge, ~0.12 m) is cut `cuts`
  times (default 3).
- **Lip line**: the strips' inner edges, chained and offset `roadM` (default 0.12 m) into the road, are cut into the
  road pieces with split_surfaces' cut (`_kerb_cut`: exact edge chains, sliver collapse, T-junction weld, custom
  normals from before the cut), so the lip starts there.
- **Drop**: every piece and strip vertex closer than W = strip width + `roadM` to the grass edge drops `depthM`
  (default 0.045) x profile(1 - d / W), a quarter ellipse; every vertex of any mesh at the same place (within 1 mm:
  the verge welded to the strip, a gravel piece at a junction) drops the same, so nothing opens and the verge slopes
  back up over its first row of faces (~1 m). Omberg `roads_1f`: flat 0.27 m in on the asphalt, -0.6 cm at the
  road edge, -2.0 cm mid-strip, -4.5 cm at the grass edge.
- **Paint** (strips, `strip_paint`): green = the road surface from the inner edge, a dark band a third of the way
  in from the grass (what r + g leaves: MAHS black, the neighbour's dirt), red = grass at the outer edge reaching
  10-45 % up in tufts. That is the green/red fringe convention: Unity's `golfmap.paths.materials` gives the strip
  "<surface> to <neighbour>" and `golfmap.roughgrass.plant` grows Stix on its red, so grass leans over the edge.
- Strip objects get smooth shading, custom normals dropped; names and materials stay. Blends carry `golfmap_kerb`
  = `path-kerb-v2`. Report: per blend `strip`, `rungs`, `outer`, `painted`; `lipLines`, `cut`, `moved` per object.
  The path check counts more steep faces on the cut pieces (Omberg `roads_1f` 29 -> 77, all millimetre slivers
  along the lip line; shading faults 11 -> 14). Afrod's `raised_path_blitz` recipe does a lip on a single closed
  path mesh, but its loopcut finds no loop on OPCD's road pieces (2026-10-17), hence this op.

## Shaping: path transitions

`golfmap.path_transition` runs last: after path surface splitting, edge fade and the rock slab cut-outs (a
road's box spans the course, so every cut-out reads the road meshes; painted first, a paint tweak re-cut every slab). Worker sync
diffs the sidecar's transition content as well as the generated op, so edits and
removals replay this paint operation even when the generated op itself is unchanged.
Other sidecar metadata does not trigger this replay. The worker clears cached
sidecar documents before planning. `shape_worker_transition_test.py` verifies actual
isolated worker load/sync/edit/removal, unchanged skips and baseline restoration.
It reads the
`transitions` entries in `<svg stem>-paths.json`: each entry supplies its merged SVG
`shape`, source `featureId`, `widthM`, sampled `centerline3006`, and transition specs.
`centerGrassReachM` extends a centre-only grass tongue longitudinally before the
resolved start station, toward `startM - direction * centerGrassReachM`; the main
transition start does not move. Zero (the default) disables that extension.
Nearest centreline segment projection supplies station and signed lateral distance;
curved paths therefore follow the exported curve, without a principal-axis estimate.

The generated op selects path shapes; optional `paths` overrides the sidecar and
`maxEdgeM` (default 0.3 m, allowed 0.05–2 m) controls local interior triangle refinement.
Patterns are `soft-fade`, `overgrown-gravel` and `wheel-tracks`. The main length
establishes the pattern, the hold retains it, and the final fade completes an ending
of `grass`. Grass remains grass through the source feature end; `continue` retains
the established pattern through that end. Paint is R grass,
G path surface, B brown dirt, quantized to RGB bytes whose sum is 255. Both path
and fringe are painted in place. An affected path piece's whole remaining surface
becomes G path (Unity's existing path material maps all its old channels to that
same surface); unaffected pieces retain their original paint and material. Shared
vertices copy the path's actual bytes;
the fringe otherwise retains its transverse grass ramp. No faces transfer between
objects and no original vertex moves. Existing UVs, corner colours, material indices,
smooth flags and source corner normals interpolate onto new triangles.

**Grass middle.** A gravel track's `wear` (export `surface: gravel-track`) carries `grassMiddle` = `{halfWidthM,
edgeM, taperM, spans: [[a, b], ...]}`: `shape_transition.grass_middle` paints that share red (grass) in a ragged
strip down the middle between the tracks, wandering with them, only inside the spans and narrowing to nothing over
`taperM` at each span end, with a bald patch here and there; the rest of the path is G path less the wear. The red
on the road mesh is what Unity grows Stix grass on (unity/README.md "Worn gravel").

**Wear.** An entry may also carry `wear` (`tracks` 1 or 2, `trackWidthM`, `trackSpacingM`, `edgeM` = how far past
the track's width it fades out, `strength`, `seed`; `pipeline/gspro.py` `_path_wear` writes it for every gravel
centreline path of 1.4 m or wider: from 1.8 m two wheel tracks with loose gravel on both shoulders and in a string
down the middle, one trodden band below; the generated op then asks for `maxEdgeM` 0.2 so the string survives), with or without transitions. `shape_transition.wear` gives the share
of the path surface that is packed at a station and lateral distance (ragged, wandering, coming and going, none on
the outer 0.2 m), and that share of the green byte is removed: the bytes then sum to less than 255, which is MAHS's
black, where Unity draws the surface's `tracks` look (unity/README.md "Worn gravel"). Red and blue are not touched,
so Stix grass and transition dirt stay as they were. A worn path outside its transitions is sampled as all path; a
transition of any entry wins over another entry's wear. Wear refines the whole path to `maxEdgeM`.

Centrelines are indexed in a grid of band-sized cells (`LineIndex`) behind a box of their own (a point outside
it needs no grid lookup), and paint is memoised per position.

**The array path** (a speed shim, `GOLFMAP_SHAPE_NO_FAST_SHIMS=1` leaves it out and runs the scalar one below
it). Wear refines every gravel path to `maxEdgeM`, so Vreta's 15 road shapes come out of this op with 2.4 M
vertices and 4.5 M triangles: per vertex and per corner Python objects cost 494 s. `_object_fast` does the same
work on numpy arrays - the paint is sampled once per vertex into an array instead of being looked up per corner
and per refinement pass (and only for the vertices inside some centreline's box), the longest-edge choice and
the red-green face split run over all faces at once (`SPLIT_PARTS` is the scalar path's part order per set of
split edges), the corner normals, UVs and colours are interpolated and written as arrays, the new mesh is built
with `foreach_set` instead of `from_pydata`, and the fringes' seam tree is built once (the meshes are painted
first, so rebuilding it after each of them was wasted) - in 93 s. Every float is the one the scalar path
computes: mathutils' `length_squared` is a double sum of float products, `normalized()` scales by
`float32(1 / float32(sqrt(exact double dot)))`, a midpoint is a float32 average, a barycentric midpoint a double
average (both exact), and the colours go through the same float32 -> byte conversion. Checked against the scalar
path on the fixture (whole mesh state equal, UVs, two materials, mixed smooth flags, custom normals, every
pattern, wear, 2 to 12 refinement passes) and on a full Vreta apply (all 996 meshes' position and colour hashes
equal).

Refinement bisects shared interior edges instead of using bmesh n-gon triangulation,
avoiding new collinear slivers. Existing object boundaries remain unchanged, so their
paint resolution depends on their original vertices. Zero-area source triangles
and float-precision output slivers of cross-product area at most 1e-9 m² are omitted.
At most twelve refinement passes run; highly coarse input or very long
boundary triangles may remain coarser than `maxEdgeM`. Other custom mesh attributes
are not transferred. Overlapping transitions use sidecar order, first match wins.
Only vertices within half the path width plus 0.25 metres and the longitudinal span
are sampled (including the tongue's longitudinal extension and the ending's
continuation to the source feature end). Coincident seam paint
uses a 1 mm spatial tolerance, accommodating FBX coordinate roundoff. A shape unit
declares all its meshes and fringes as reads; its cache key
includes the transition sidecar content and the transition/noise module sources.
Identical direct replay skips objects carrying the same transition hash; changed
specs are replayed from the shaping engine's prior snapshot.

Validation: `blender -b --factory-startup --python blender/tools/shape_transition_test.py`
creates synthetic meshes and scratch FBX under `data/path-transition-fixture`, checks
the actual edge-fade-to-transition chain from original red path paint, curved
projection, pattern/seed differences, unchanged original positions, outside surface
convention, nearby parallel path exclusion, submillimetre seam bytes, triangle area,
finite unit normals and direct replay idempotence. It also renders three top-down
emission views of the resulting vertex colours.
It never opens or saves a course `.blend`.

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

Path transition sync also compares the SVG sidecar's `transitions` content, so
sidecar-only edits/removals replay the transition op. Other sidecar metadata does
not trigger that replay. Regression (temporary synthetic fixture, automatically
removed):

```powershell
& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --factory-startup --python-exit-code 1 --python blender/tools/shape_worker_transition_test.py
```

`tools/shape_worker.py` keeps a course shaped in a long-running headless Blender so the Terrain editor's edits
reach the meshes in seconds ([SHAPING-PLAN.md](SHAPING-PLAN.md), "Terrain editor -> Blender"). JSON over HTTP on
`--host` (else `GOLFMAP_SHAPING_HOST`, else 127.0.0.1) and `--port` (else `GOLFMAP_SHAPING_PORT`, else 8766):

```bash
"C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python blender/tools/shape_worker.py -- --port 8766 --blend "D:/gspro_courses/vreta-opcd/vreta_svg_1985.blend" --layers docs/gspro/vreta/shaping --fbx-folder "<Unity project>/Assets/fbx"
```

A `/load` or `/sync` is a **job**: the call answers at once and the work goes on in the main thread, so a sync that
takes an hour holds no connection. `?wait=1` on either POST keeps the old blocking behaviour — the answer is the
run itself — which is what `curl` by hand wants.

| Call | Does | Answers |
|---|---|---|
| `GET /status` | never waits | `state` (`starting` / `ready` / `busy` / `error`), `phase`, `blend`, `conformed`, `layersDir`, `fbxFolder`, `appliedOps`, `lastRun`, `error`, `host`, `port`, `pid`, `queued`, and `job` = the running (else last) one: `{id, kind, state: running\|succeeded\|failed, phase, startedAt, seconds, result, error}`, where `result` is what the blocking call would have answered |
| `GET /job/<id>` | never waits | that job in the same shape (404 when this worker never ran it; the last 20 are kept) |
| `POST /load {blend?, layersDir?, fbxFolder?, cache?, syncFbx?}` | opens `<name>.conformed.blend` (runs shape_prepare first when it is missing or older than the source `.blend`; `blend` may name either), applies every layer through the op cache, writes `shaping-staging/shaping-report.json`; `syncFbx` also brings `fbxFolder` in step with the whole course | `202 {job, kind, state: "running"}`; the job's `result`: `appliedOps`, `errors`, `warnings`, `cache`, `hash`, `timings`, `seconds` |
| `POST /sync {dryRun?}` | re-reads the layers, diffs the ops by `layer:id` + content, restores the affected meshes, re-runs what reaches them, seam-checks, exports their FBX (fbx_sync exporter, fingerprints and manifest, so a later full fbx_sync agrees) and deletes the FBX of meshes that are gone (e.g. blends a `meshblendjoinpermanent` recipe merged). The first sync after a load also exports every mesh whose fingerprint differs from the folder's manifest (all of them when it has none), so Unity is in step on first use | `202 {job, kind, state: "running"}`; the job's `result`: `changedObjects` (incl. removed), `exported`, `removed` (FBX names), `seconds`, `report: {warnings, seams, changedPlaces, changedObjectsDetail}` (places of the ops this sync ran), plus `changedOps`, `restorePoint`, `affectedObjects`, `rerunUnits`, `ranOps`, `cache`, `hash`; `dryRun` stops after the plan. Also written to `shaping-staging/shaping-sync.json` |
| `POST /shutdown` | stops the worker; always waits | `{ok: true}` |

- **One job at a time**: a POST while one is going is `409 {error, job, kind, state}` — it is never queued behind it.
  `/shutdown` always gets through.
- **A shared secret**: with `--token <t>` (else `GOLFMAP_SHAPING_TOKEN`) every request must carry it as
  `X-Golfmap-Token`, or it is `401` and the connection is closed. The server sends the same env var's value; it
  spawns the worker with it in the environment rather than on the command line, where a process list would show it.

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

#### When /load re-prepares (2026-10-14)

`/load` re-prepares when `shape_worker.conformed_stale(source, conformed)` says so, which is now three
inputs instead of one:

- the conformed `.blend` is missing;
- the source course `.blend` is newer (OPCD regenerated it — which also covers `Outer`, since that
  object lives in the source file);
- **`terrain.obj` holds other bytes than the ones the cache was conformed against.** `terrain_obj.py`
  rewrites it from every DEM export, so its mtime moves on its own and a mtime test would re-conform the
  whole course for nothing; the sha in `<name>.conformed.terrain.json` (or `terrainSha` in the prepare
  report next to it) is what is compared. Only a conformed `.blend` that never recorded a sha falls back
  to the mtime. Before this, a regenerated terrain was *never* noticed: the course kept being shaped
  against the old heights.

The `prepared` block of a `/load` result gained `stale` (why it re-prepared) and `terrainSha`.

```powershell
& 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe' -b --factory-startup --python-exit-code 1 --python blender/tools/shape_worker_stale_test.py
```

On the real files, the existing `vreta_svg_1988.conformed.blend` (no sidecar, a report from before the
field) stays valid: terrain.obj is older than it, so the mtime fallback says "not stale" and nobody pays
a 2.5-minute conform for this change.

### A worker on another machine

`--host 0.0.0.0` (plus `--token`, since the port is then reachable from the network) lets a golf-map server on
another machine drive it: point that server's `GOLFMAP_SHAPING_URL` at `http://<host>:8766` and give both sides the
same `GOLFMAP_SHAPING_TOKEN`. The server only ever STARTS a worker when nothing answers on that URL and the command
it runs is local, so start the remote one by hand (and leave `GOLFMAP_SHAPING_URL` unset on the machine that is to
start its own).

The paths go over the wire as text (`blend`, `layersDir`, `fbxFolder` in `/load`), so they have to name the same
files on the worker's machine. Nothing in the worker, `shape_apply` or `fbx_sync` assumes a drive letter, so either
way works:

- the **same mount on both sides** — `D:\gspro_courses\...` on the one, the same letter mapped to the share on the
  other — and nothing else to set, or
- **UNC paths**: `GOLFMAP_SHAPING_BLEND=\\host\share\gspro_courses\vreta-opcd\vreta_svg_1988.blend`,
  `GOLFMAP_SHAPING_FBX_FOLDER=\\host\share\vreta_v4\Assets\fbx`, `GOLFMAP_SHAPING_LAYERS_ROOT=\\host\share\docs\gspro`.
  The staging the worker writes next to the `.blend` (`shaping-staging/`: the op cache, shape_prepare's conformed
  cache and the reports) then lives on the share as well — slower on a cold load, but correct, and its
  `os.replace` of a cache entry stays within the one share.

A mapped drive letter only exists for the session that mapped it: a worker started as a service or a scheduled task
sees no `Z:\`, so use UNC there. The share must allow writing — the worker writes the conformed cache, the staging
and the FBX.

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
  The `plank_sign` part (square wooden post, a plank screwed to its front, `face` and `back` each mapped once) is
  Omberg's tee sign: `docs/gspro/ombergs-golfklubb/tee-signs/tee-signs.gen.py` writes one per tee group (tees on
  one box or within 10 m share a plank; number, a dot and length per tee, par, index) straight as a props spec,
  installed with `clubhouse/install.ps1` (its docstring has the commands).
- **Then in Unity:** `golfmap.props.place` (GolfMap > Props), see [unity/README.md](../unity/README.md#course-props).

## Low-poly vehicles

A vehicle pack's prefab is 30-43 renderers a car (every door, window and wheel part its own object), each
casting a shadow. Parked cars are background props, so the course places merged copies instead: 2 renderers
(`<id>_body`, `<id>_details`), the pack's own materials on the slots (recolours by material name keep working),
same origin, size and axes as the pack's prefab. Three steps, all headless, work files in the git-ignored
`tree-export/vehicles-lowpoly/` (`--work`):

```
python blender/tools/vehicle_prefabs.py --project <Unity project> --prefab "Assets/Vehicles/Prefabs/Small Sedan White.prefab" --prefab "Assets/Vehicles/Prefabs/Hatchback White.prefab" --prefab "Assets/Vehicles/Prefabs/Hatchback Black.prefab" --prefab "Assets/CESimgolf 3D Assets/Course Items/Golf Cart/golf-cart-ezgo.prefab"
blender -b --factory-startup --python blender/tools/vehicle_models.py
blender -b --factory-startup --python blender/tools/vehicle_models_10k.py
```

- `vehicle_prefabs.py` (plain Python) reads the prefabs' YAML and `.meta` GUIDs into `prefabs.json`: hierarchy,
  transforms, mesh and material per renderer. `--spec <props spec>` instead of `--prefab` takes the prefabs of the
  spec's `vehicle` assets (a spec that still names the pack's prefabs, not the low-poly ones).
- `vehicle_models.py` rebuilds each prefab in its root space from the source FBX meshes and merges it:
  `<id>_lowpoly.fbx` (sedan 19 341, hatchback 26 129, golf cart 3 956 triangles: only hidden parts dropped),
  `vehicles-lowpoly.json`, `renders/<id>_compare.png`. The golf cart's prefab uses this file.
- `vehicle_models_10k.py` makes the cars' background versions (`sedan_tocus_10k.fbx` 11 177, `hatchback_10k.fbx`
  10 405 triangles; from 19 483 and 26 423): faces no outside viewer can see removed by a ray test, the cabin
  lining behind the glass and the underside reduced, the hatchback's rims rebuilt as plain spoked rims; and
  writes `vehicles.json` (`golfmap-vehicles-v1`: prefab name, FBX, source prefab, slots, `castShadows`).
  `--shadows body` lets the bodies cast shadows; the default `none` is what Vreta uses.
- What the scripts know about a pack (hidden parts, body materials, reduction per part) is in their `MODELS`
  lists; a new vehicle prefab needs an entry in both, and in `PREFABS` of the 10k script. Look at the compare
  sheet of every model after a change: collapse on spoked rims fills the gaps, planar dissolve wipes the sedan's
  door strips and makes tyres lumpy (all three are off for that reason).
- Unity mesh order facts the rebuild relies on (checked against `golfmap.props.measure`: bounds equal to 0.1 mm):
  Unity negates x on FBX import, a mesh's submeshes follow the first use of each material in polygon order, and
  with `bake_space_transform` Blender (x, y, z) arrives as Unity (-x, z, -y).
- **Then in Unity:** copy the FBX files named in `vehicles.json` and `vehicles.json` itself into
  `<course>/Props/VehiclesLowPoly/`, run `golfmap.vehicles.build`, point the spec's vehicle assets at
  `<course>/Props/VehiclesLowPoly/<name>.prefab` (see [unity/README.md](../unity/README.md#course-props)).
