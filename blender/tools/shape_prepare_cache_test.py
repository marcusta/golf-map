"""The per-mesh conform cache and the grid conform path, on synthetic scenes.

Vreta cannot show any of this - nothing there fails to project, no mesh arrives with a modifier and the
scene has no `Outer`. So this builds a four-object course by hand (a tilted `Terrain`, a flat `Outer`, two
Spline meshes - one of them hanging off the terrain so Afrod's retry fires - and an `Outerplot` mesh that
projects onto `Outer`) and runs `shape_prepare.conform_cached` over it several times against one cache:

1. cold: every mesh a miss;
2. warm, same inputs: every mesh a hit, the same state hashes, the same `fix_failed_projections` report,
   and no modifier left on the mesh that arrived with one;
3. the same mesh with another modifier stack: a miss, because the conform clears the stack and
   `capture_state` cannot see it;
4. `Outer` replaced: another env key, so the Outerplot mesh is conformed again onto the new one.

Then a second scene for the **grid conform path**: a synthetic inner-DEM sidecar and `.raw` whose heights
are a plane, written into a `terrain.obj` by `terrain_obj.py` and imported by OPCD's own Import Terrain OBJ,
so the Terrain the meshes conform onto is built by the real chain (Smooth modifier and all). Over it the
operator path and the grid path are run on the same meshes and compared:

5. the grid is recognised and matches the sidecar's frame and the `.raw` smoothed by Terrain Smooth;
6. the grid path puts every vertex of a mesh well inside the grid on that plane (1e-6), and leaves every
   array but the positions exactly as the operator does - including the smooth shading `project_mesh`
   presses `shade_smooth` for;
7. a mesh hanging off the grid comes out of both paths the same: the same number of missed vertices, the
   same 1 cm nudges from Afrod's retry, the same vertices left at the flatten depth;
8. an `Outerplot` mesh keeps the operator path (it projects onto `Outer`, not onto the grid);
9. the two paths are different env keys, so a cache warmed by one is never served to the other.

Needs the OPCD add-on (Afrod's `flatten_mesh` / `project_mesh` / `fix_failed_projections`), so no
--factory-startup. Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python-exit-code 1 --python blender/tools/shape_prepare_cache_test.py
"""
import json
import os
import sys
import tempfile

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_apply as sa  # noqa: E402
import shape_prepare as sp  # noqa: E402
import terrain_obj as to  # noqa: E402

FAILED = []
SMOOTH = 1.5
SEED = 0
TERRAIN_SHA = "t" * 40   # stands in for the OBJ's content hash: the same in every run here
A = "Spline_Fairway_A_-_Mesh"
B = "Spline_Green_B_-_Mesh"
C = "Outerplot_1"


def check(what, got, want):
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + what + ("" if ok else f"  got {got!r}, want {want!r}"))
    if not ok:
        FAILED.append(what)


def grid(name, x0, y0, x1, y1, zf, n=4):
    me = bpy.data.meshes.new(name)
    xs = [x0 + (x1 - x0) * i / n for i in range(n + 1)]
    ys = [y0 + (y1 - y0) * j / n for j in range(n + 1)]
    verts = [(x, y, zf(x, y)) for y in ys for x in xs]
    faces = [(j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i)
             for j in range(n) for i in range(n)]
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(modifier=None, outer_z=3.0):
    """A fresh scene. `modifier` is a modifier type put on mesh A (as a regenerated .blend can arrive with
    one); `outer_z` is the height of the outer-plot terrain the Outerplot mesh projects onto."""
    bpy.ops.wm.read_homefile(use_empty=True)
    for o in (grid("Terrain", 0, 0, 20, 20, lambda x, y: 5.0 + 0.05 * x + 0.02 * y, n=8),
              grid("Outer", 30, 0, 50, 20, lambda x, y: outer_z, n=4)):
        o.hide_set(True)                      # as OPCD's import leaves the terrain
    a = grid(A, 2, 2, 10, 10, lambda x, y: 0.0)
    grid(B, 15, 2, 25, 10, lambda x, y: 0.0)  # half of it hangs off the Terrain: those verts fail
    grid(C, 32, 2, 48, 10, lambda x, y: 0.0)
    if modifier:
        a.modifiers.new("Arrived", modifier)
    return a


def run(cache_dir, modifier=None, outer_z=3.0):
    """Conform the scene through the cache once.
    Returns (stats, fix report, state hash per object, env key, conform-target hashes)."""
    build(modifier=modifier, outer_z=outer_z)
    override = sp._view3d_override()
    targets, _ = sp.target_fingerprints()
    env = sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED, targets)
    fixed, restore = sp._count_fix_failed()
    if fixed is None:
        raise RuntimeError("Afrod's fix_failed_projections is not loaded: is the OPCD add-on enabled?")
    try:
        stats = sp.conform_cached(sp.conform_reach("afrod"), "afrod", override, SEED,
                                  sa.OpCache(cache_dir), env, fixed=fixed)
    finally:
        restore()
    hashes = {o.name: sa.state_hash(*sa.capture_state(o))
              for o in bpy.data.objects if o.type == "MESH" and o.name in (A, B, C)}
    return stats, dict(fixed), hashes, env, targets


def z_of(name):
    return [round(v.co.z, 4) for v in bpy.data.objects[name].data.vertices]


with tempfile.TemporaryDirectory(prefix="golfmap_conform_cache_") as folder:
    cache_dir = os.path.join(folder, "conform-cache")

    # 1. Cold. Mesh A arrives with a modifier; the conform clears it before flattening.
    cold, fixed_cold, hash_cold, env, targets_cold = run(cache_dir, modifier="SMOOTH")
    check("cold: three meshes, all misses", (cold["meshes"], cold["hits"], cold["misses"]), (3, 0, 3))
    check("cold: the modifier the mesh arrived with is gone", len(bpy.data.objects[A].modifiers), 0)
    check("cold: Afrod's retry fired on the mesh hanging off the terrain", sorted(fixed_cold), [B])
    check("cold: and nudged more than one vertex", fixed_cold[B] > 1, True)
    check("cold: the Outerplot mesh landed on Outer", set(z_of(C)), {3.0})

    # 2. Warm, the same inputs: hits, and a report a cold run would not tell apart.
    warm, fixed_warm, hash_warm, env_warm, _ = run(cache_dir, modifier="SMOOTH")
    check("warm: the env key is unchanged", env_warm, env)
    check("warm: three meshes, all hits", (warm["meshes"], warm["hits"], warm["misses"]), (3, 3, 0))
    check("warm: every state hash is the cold one", hash_warm, hash_cold)
    check("warm: fix_failed_projections says exactly what the cold run said", fixed_warm, fixed_cold)
    check("warm: counted as a replayed retry", (warm["fixedHits"], warm["mismatches"]), (1, []))
    check("warm: the hit cleared the modifier the mesh arrived with",
          (warm["modifiersCleared"], len(bpy.data.objects[A].modifiers)), (1, 0))

    # 3. The same mesh, another stack. capture_state cannot see modifiers, so only the key's own
    #    modifier signature keeps this from being served A's result under a stack that was cleared.
    other, fixed_other, hash_other, _, _ = run(cache_dir, modifier="SUBSURF")
    check("another modifier stack: that mesh is a miss, the other two still hit",
          (other["hits"], other["misses"]), (2, 1))
    check("and its result is the same (the stack is cleared either way)", hash_other[A], hash_cold[A])
    none, fixed_none, hash_none, _, _ = run(cache_dir, modifier=None)
    check("no modifier at all: a third key, same result", (none["misses"], hash_none[A]), (1, hash_cold[A]))
    check("the retry report holds through all of it", (fixed_other, fixed_none), (fixed_cold, fixed_cold))

    # 4. A replaced outer terrain. Nothing about terrain.obj, the button, the smooth or the seed changed -
    #    only the object the Outerplot mesh is shrinkwrapped onto - so only the targets in the env key can
    #    tell the cache that its results are stale.
    lifted, _, hash_lifted, env_lifted, targets_lifted = run(cache_dir, modifier=None, outer_z=3.5)
    check("a replaced Outer is another target hash", targets_lifted["Outer"] != targets_cold["Outer"], True)
    check("  and so another env key", env_lifted != env, True)
    check("  while the key without the targets - what it used to be - cannot tell the two apart",
          sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED),
          sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED))
    check("so every mesh is conformed again", (lifted["hits"], lifted["misses"]), (0, 3))
    check("and the Outerplot mesh is on the new Outer", set(z_of(C)), {3.5})
    check("while the Spline meshes come out as before",
          (hash_lifted[A], hash_lifted[B]), (hash_cold[A], hash_cold[B]))


# ---------------------------------------------------------------- the grid conform path

GRID_RES = 9          # a 9x9 heightmap -> 5 nodes a side at Unity's "half", 1 m apart
GRID_SIDE = 4.0
GRID_STEP = 1e-5      # heightRangeM / 65535: every node height is then a short exact decimal, so the
CODE0, C_IX, C_IZ = 2000, 1000, 300   # OBJ's 7 significant digits carry it unrounded
D = "Spline_Inside_Fairway_-_Mesh"
E = "Spline_OffGrid_Rough_-_Mesh"


def plane_z(x, y):
    """The synthetic terrain: heights linear in the grid index, so a triangle interpolates them exactly.
    The OBJ puts node (iz, ix) at blend x = -ix*spacing, y = -iz*spacing (spacing 1 m here)."""
    return GRID_STEP * (CODE0 + C_IX * (-x) + C_IZ * (-y))


def write_terrain(folder):
    """A synthetic inner-DEM sidecar + `.raw` -> `terrain_obj.py` -> `terrain.obj`: the real chain, so the
    frame, the negated x and the sampling step are not restated here."""
    side = (GRID_RES - 1) // 2 + 1
    codes = np.zeros((GRID_RES, GRID_RES), np.uint16)
    for iz in range(side):
        for ix in range(side):   # the .raw's row 0 is north, and `half` reads every second sample
            codes[2 * (side - 1 - iz), 2 * ix] = CODE0 + C_IX * ix + C_IZ * iz
    codes.tofile(os.path.join(folder, "h.raw"))
    doc = {"crs": "EPSG:3006", "terrain": "inner", "sideM": GRID_SIDE, "minM": 10.0,
           "maxM": 10.0 + GRID_STEP * 65535, "heightRangeM": GRID_STEP * 65535,
           "unity": {"heightmapResolution": GRID_RES, "position": {"x": 0.0, "y": 0.0, "z": 0.0}},
           "raw": {"file": "h.raw", "size": GRID_RES}}
    path = os.path.join(folder, "course-inner-dem-4m.tif.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    obj = os.path.join(folder, "terrain.obj")
    to.run(path, obj, sample="half")
    return path, obj


def run_grid_scene(cache_dir, obj_path, frame, raw_path, use_grid):
    """Build the scene, import the terrain OBJ with OPCD's own button and conform it once.
    Returns (stats, fix report, the grid's checks, env key, per-object state)."""
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.context.scene.opcd_tools.terrainsmooth = SMOOTH
    bpy.context.scene.opcdtools.terrainsmooth = SMOOTH
    outer = grid("Outer", -14.0, -3.0, -10.0, -1.0, lambda x, y: 3.0, n=2)
    grid(D, -1.2, -1.2, -2.8, -2.8, lambda x, y: 0.0, n=3)      # well inside the grid
    grid(E, -3.0, -1.2, -5.2, -2.8, lambda x, y: 0.0, n=4)      # half of it off the grid's east edge
    grid(C, -13.5, -2.5, -10.5, -1.5, lambda x, y: 0.0, n=2)    # an Outerplot mesh, onto Outer
    outer.hide_set(True)
    override = sp._view3d_override()
    sp.import_terrain(obj_path, override)
    g, checks = sp.terrain_grid("Terrain", frame, SMOOTH, raw_path)
    if g is None:
        raise RuntimeError("no terrain grid: " + str(checks.get("why")))
    targets, _ = sp.target_fingerprints()
    path = "grid" if use_grid else "operator"
    env = sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED, targets, path)
    fixed, restore = sp._count_fix_failed()
    try:
        stats = sp.conform_cached(sp.conform_reach("afrod"), "afrod", override, SEED,
                                  sa.OpCache(cache_dir), env, fixed=fixed, grid=g if use_grid else None)
    finally:
        restore()
    state = {n: sa.capture_state(bpy.data.objects[n]) for n in (D, E, C)}
    return stats, dict(fixed), checks, env, state


def positions(state, name):
    return state[name][1][sa.POSITION_KEY].reshape(-1, 3).astype(np.float64)


with tempfile.TemporaryDirectory(prefix="golfmap_grid_conform_") as folder:
    sidecar_path, obj_path = write_terrain(folder)
    frame = to.frame_from_sidecar(to.load_sidecar(sidecar_path), "half")
    raw_path = os.path.join(folder, "h.raw")
    check("the synthetic terrain is 5 nodes a side, 1 m apart", (frame["grid"], frame["spacingM"]), (5, 1.0))
    check("sidecar_for finds it next to the OBJ", sp.sidecar_for(obj_path), sidecar_path)

    op_stats, op_fixed, checks, op_env, op_state = run_grid_scene(
        os.path.join(folder, "cache-op"), obj_path, frame, raw_path, use_grid=False)
    gr_stats, gr_fixed, checks, gr_env, gr_state = run_grid_scene(
        os.path.join(folder, "cache-grid"), obj_path, frame, raw_path, use_grid=True)

    # 5. the Terrain OPCD imported really is the grid the sidecar describes
    check("the grid is the sidecar's frame", (checks["side"], checks["frameGrid"]), (5, 5))
    check("  its nodes are where the frame puts them (within the OBJ's 7 digits)",
          max(checks["axisUDevM"], checks["axisVDevM"]) < 1e-6, True)
    check("  and its heights are the .raw smoothed by Terrain Smooth",
          checks["rawDevM"] < 1e-6 and "rawWarning" not in checks, True)
    check("  one x down every column, one y across every row",
          max(checks["columnXSpreadM"], checks["rowYSpreadM"]) < 1e-6, True)

    # 6. the mesh inside the grid: on the plane, and everything but the positions is the operator's
    co = positions(gr_state, D)
    check("the grid path put every vertex of the inside mesh on the terrain's plane",
          float(np.abs(co[:, 2] - plane_z(co[:, 0], co[:, 1])).max()) < 1e-6, True)
    # The operator's rays start 100 m below (the flatten depth) and are cast in float32, so one step of
    # float32 at 100 m - 7.6 um - is the best they can do, whatever the terrain's own scale is. That, not a
    # difference in what is computed, is the whole gap between the two paths.
    op_dev = float(np.abs(positions(op_state, D)[:, 2] - plane_z(co[:, 0], co[:, 1])).max())
    check("the operator's Shrinkwrap lands on it only within the float32 of its 100 m ray",
          (op_dev < 1e-4, op_dev > 1e-6), (True, True))
    for name in (D, E):
        same = [k for k in op_state[name][1]
                if k != sa.POSITION_KEY and np.array_equal(op_state[name][1][k], gr_state[name][1][k])]
        check("every array but the positions is the operator's on " + name.split("_")[1],
              (sorted(op_state[name][1]) == sorted(gr_state[name][1]),
               len(same), len(op_state[name][1]) - 1, op_state[name][0] == gr_state[name][0]),
              (True, len(op_state[name][1]) - 1, len(op_state[name][1]) - 1, True))
    check("  including the smooth shading project_mesh presses shade_smooth for",
          (all(p.use_smooth for p in bpy.data.objects[D].data.polygons),
           "sharp_face" in [a.name for a in bpy.data.objects[D].data.attributes]),
          (True, False))

    # 7. the mesh hanging off the grid: Afrod's retry, reproduced
    off_op, off_gr = positions(op_state, E), positions(gr_state, E)
    check("the mesh hanging off the grid missed the same vertices both ways",
          (op_fixed.get(E), gr_fixed.get(E)), (op_fixed.get(E), op_fixed.get(E)))
    check("  and it did miss some", (gr_fixed.get(E) or 0) > 0, True)
    check("  the same ones are left at the flatten depth",
          (sorted(np.flatnonzero(off_gr[:, 2] < -99.0).tolist())
           == sorted(np.flatnonzero(off_op[:, 2] < -99.0).tolist()),
           int(np.count_nonzero(off_gr[:, 2] < -99.0)) > 0), (True, True))
    check("  with the same 1 cm nudges in x and y, bit for bit (the same seeded random, in vertex order,"
          " rounded to float32 where Afrod's `vert.co.x +=` rounds it)",
          float(np.abs(off_op[:, :2] - off_gr[:, :2]).max()), 0.0)
    check("  and the rest of it on the terrain, to the same float32 ray's accuracy",
          float(np.abs(off_op[:, 2] - off_gr[:, 2]).max()) < 1e-4, True)

    # 8. an Outerplot mesh is not on the grid, so it keeps the operator path - byte for byte
    check("the Outerplot mesh kept the operator path",
          (gr_stats["gridMeshes"], gr_stats["operatorMeshes"], gr_stats["operatorWhy"]),
          (2, 1, {"projects onto Outer": 1}))
    check("  and came out identical to the operator run",
          sa.state_hash(*gr_state[C]), sa.state_hash(*op_state[C]))
    check("the operator path counts no grid meshes",
          (op_stats["gridMeshes"], op_stats["operatorMeshes"], op_stats["operatorWhy"]), (0, 3, {}))
    check("  and grid_blocked says why for the Outerplot mesh",
          sp.grid_blocked(bpy.data.objects[C], sp.terrain_grid("Terrain")[0]), "projects onto Outer")

    # 9. the path is in the env key, so neither path is ever served the other's results
    check("the two paths are different env keys", gr_env != op_env, True)
    again, _, _, env_again, _ = run_grid_scene(os.path.join(folder, "cache-grid"), obj_path, frame,
                                               raw_path, use_grid=True)
    # all three, the Outerplot mesh included: its operator result was stored under the grid path's key, and
    # the key says it is the one the grid path turns away (`grid_blocked`), so it is the right result for it
    check("the grid path hits its own cache", (env_again, again["hits"], again["misses"]), (gr_env, 3, 0))
    crossed, _, _, _, _ = run_grid_scene(os.path.join(folder, "cache-grid"), obj_path, frame,
                                         raw_path, use_grid=False)
    check("  but the operator path is not served it", (crossed["hits"], crossed["misses"]), (0, 3))

print(("FAILED: " + ", ".join(FAILED)) if FAILED else "all conform cache and grid conform checks passed")
sys.exit(1 if FAILED else 0)
