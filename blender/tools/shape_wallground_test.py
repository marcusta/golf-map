"""golfmap.wall_ground (shape_wallground.py) on a synthetic course: two meshes side by side (a rough west of x = 0, a
fairway east of it, 1.2 m triangles) whose seam runs straight across two banks - a lidar-smoothed ramp 0 -> 1.2 m
at y 0-2.4 (a terrace wall) and 1.2 -> 2.4 m at y 7.2-9.6 (a cliff with a rounded top, an outline and a grass
patch) - and a third rough 50 m away. The fairway's seam vertices sit 2e-5 m off the rough's (OPCD's float noise).

Checks, through shape_apply's unit runner as the orchestrated op runs: after each op no seam open (slab_seam_check),
no T-junction (tjunction_check: no unpartnered boundary vertex on a neighbour's edge), one height per shared point;
the terrace's heights at every vertex equal Unity's profile computed by hand (foot 0, top 1.2 = the ground beyondM
past the lip, face 60 deg from baseInM, taper 1.5 m) within 1 mm; the far mesh untouched; the stone paint on the
rough only (the fairway keeps its red); no degenerate triangle. Also the pure parts: System.Random's first double
for seed 1, the layer validation.

Run: "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_wallground_test.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import numpy as np

bpy.ops.wm.read_factory_settings(use_empty=True)

import shape_apply as sa          # noqa: E402
import shape_layers as sl         # noqa: E402
import shape_wallground as wg     # noqa: E402

FRAME = {"e0": 1000.0, "n0": 2000.0, "sideM": 200.0, "minM": 0.0, "px": 0.0, "py": 0.0, "pz": 0.0}
STEP = 1.2
TAN60 = math.tan(math.radians(60))
failures = []


def check(ok, msg):
    print(("ok   " if ok else "FAIL ") + msg)
    if not ok:
        failures.append(msg)


def ground(y):
    if y <= 0:
        return 0.0
    if y <= 2.4:
        return 0.5 * y
    if y <= 7.2:
        return 1.2
    if y <= 9.6:
        return 1.2 + 0.5 * (y - 7.2)
    return 2.4


def grid_mesh(name, x0, nx, y0, ny, seam_dx=0.0):
    verts = []
    for j in range(ny + 1):
        for i in range(nx + 1):
            x, y = x0 + i * STEP, y0 + j * STEP
            if seam_dx and i == 0:
                x += seam_dx
            verts.append((x, y, ground(y)))
    faces = []
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            b, c, d = a + 1, a + nx + 2, a + nx + 1
            faces += [(a, b, c), (a, c, d)] if (i + j) % 2 == 0 else [(a, b, d), (b, c, d)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    col = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    col.data.foreach_set("color_srgb", np.tile([1.0, 0.0, 0.0, 1.0], len(col.data)).astype(np.float32))
    me.update()
    vn = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertex_normals.foreach_get("vector", vn)
    me.normals_split_custom_set_from_vertices([tuple(v) for v in vn.reshape(-1, 3).tolist()])   # as OPCD's meshes
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o["opcd_kind"] = "mesh"
    return o


ROUGH, FAIR, FAR = "Spline_hole_1_1_Rough_-_Mesh", "Spline_hole_1_2_Fairway_-_Mesh", "Spline_hole_2_3_Rough_-_Mesh"
grid_mesh(ROUGH, -6.0, 5, -3.6, 13)
grid_mesh(FAIR, 0.0, 5, -3.6, 13, seam_dx=2e-5)
grid_mesh(FAR, 50.0, 5, -3.6, 6)
far_before = sa.positions(bpy.data.objects[FAR]).copy()
far_faces = len(bpy.data.objects[FAR].data.polygons)


def epsg(x, y):
    return [FRAME["e0"] - x, FRAME["n0"] - y]   # the inverse of shape_coords.to_blend in this frame


TERRACE = {
    "id": "t-wall", "op": "golfmap.wall_ground", "wall": "t-wall", "seed": 7,
    "toe3006": [epsg(x, 0.0) for x in (-5.0, 0.0, 5.0)], "lip3006": [epsg(x, 2.0) for x in (-5.0, 0.0, 5.0)],
    "ground": {"profile": "terrace", "faceDeg": 60.0, "baseInM": 0.2, "beyondM": 0.5, "taperM": 1.5, "subdivideM": 0.35,
               "paintFeatherM": 0.25, "paintInsetM": 0.0, "minFaceM": 0.35, "jitterDeg": 0.0, "roundTopM": 0.0,
               "groundChannel": "blue", "paintOnly": False, "stoneFace": True},
}
CLIFF = {
    "id": "c-klippa", "op": "golfmap.wall_ground", "wall": "c-klippa", "seed": 984,
    "toe3006": [epsg(x, 7.2) for x in (-4.0, 0.0, 4.0)], "lip3006": [epsg(x, 9.2) for x in (-4.0, 0.0, 4.0)],
    "outline3006": [epsg(-3.0, 7.6), epsg(3.0, 7.6), epsg(3.0, 9.4), epsg(-3.0, 9.4)],
    "grassPatches3006": [epsg(-1.5, 8.5) + [0.6, 0.5]],
    "ground": {"profile": "cliff", "faceDeg": 70.0, "baseInM": 0.2, "beyondM": 1.0, "taperM": 2.5, "subdivideM": 0.35,
               "paintFeatherM": 0.5, "paintInsetM": 0.2, "minFaceM": 0.35, "jitterDeg": 10.0, "roundTopM": 0.5,
               "groundChannel": "blue", "paintOnly": False, "stoneFace": True},
}

# ---- pure parts
check(abs(wg.DotNetRandom(1).next_double() - 534011718 / 2147483647) < 1e-12, "System.Random(1) first double")
check(wg.validate_params(TERRACE) == [] and wg.validate_params(CLIFF) == [], "the test ops validate")
bad = dict(TERRACE, lip3006=TERRACE["lip3006"][:2], ground=dict(TERRACE["ground"], groundChannel="pink", faceDeg="x"))
check(len(wg.validate_params(bad)) == 3, "a bad op lists its problems: " + "; ".join(wg.validate_params(bad)))
if "golfmap.wall_ground" in sl.OPS:
    check(sl.validate_op(TERRACE) == [] and sl.validate_op(CLIFF) == [], "shape_layers validates the ops")
else:
    print("note shape_layers.OPS has no golfmap.wall_ground yet: its validation is skipped")

# ---- the op wired into shape_apply as the orchestrator registers it (if shape_apply does not have it yet)
if "golfmap.wall_ground" not in sa.RUNNERS:
    def _plan(ctx, op):
        return wg.plan_wall_ground(ctx, op, sa.Unit, sa.near_boxes)

    def _run(ctx, op):
        units, problems = sa.plan_units(ctx, op)
        return wg.op_wall_ground(ctx, op, units, sa.weld_tjunctions, sa.slab_seam_check, sa.tjunction_check), problems
    sa.PLANNERS["golfmap.wall_ground"] = _plan
    sa.RUNNERS["golfmap.wall_ground"] = _run
    print("note shape_apply has no golfmap.wall_ground yet: registered here")

index = [{"name": n, "shapeId": None, "parentId": None, "kind": "mesh", "svgId": None, "type": t, "featureIds": [], "hole": None}
         for n, t in ((ROUGH, "rough"), (FAIR, "fairway"), (FAR, "rough"))]
ctx = sa.Ctx(bpy.context.scene, index, {}, None, FRAME)


def apply(op, i):
    ctx.runner.begin_op(i, "walls/" + op["id"])
    runs, _ = sa.RUNNERS[op["op"]](ctx, op)
    ctx.forget()
    assert len(runs) == 1, runs
    r = runs[0]
    print({k: r.get(k) for k in ("result", "error", "targets", "levels", "edgesHalved", "verticesAdded", "raised",
                                 "lowered", "painted", "maxRaiseM", "maxLowerM", "profile", "tJunctions", "weld")})
    w = r.get("weld") or {}
    check(w.get("tJunctions", 0) == 0 and w.get("edgesSplit", 0) == 0,
          f"{op['id']}: both sides of the seam split alike (the weld found nothing to close: {w})")
    return r


def seams_closed(label):
    objs = [bpy.data.objects[n] for n in (ROUGH, FAIR)]
    rep = sa.slab_seam_check(objs)
    check(rep["open"] == 0 and rep["points"] > 20, f"{label}: no open seam ({rep})")
    tj = sa.tjunction_check([ROUGH, FAIR])
    on = sum(v["onEdge"] for v in tj.values())
    check(on == 0, f"{label}: no T-junction ({tj})")
    # one height per shared point (XY within 1e-4)
    a = sa.boundary_points(bpy.data.objects[ROUGH])
    b = sa.boundary_points(bpy.data.objects[FAIR])
    kd = sa._xy_kd(b)
    worst, pairs = 0.0, 0
    for p in a:
        for _, j, _ in kd.find_range((float(p[0]), float(p[1]), 0.0), 1e-4):
            pairs += 1
            worst = max(worst, abs(float(b[j][2]) - float(p[2])))
    check(pairs > 20 and worst <= 1e-4, f"{label}: {pairs} shared border points, worst height difference {worst:.6f} m")
    for n in (ROUGH, FAIR):
        me = bpy.data.objects[n].data
        me.calc_loop_triangles()
        co = sa.positions(bpy.data.objects[n]).astype(np.float64)
        tv = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", tv)
        tv = tv.reshape(-1, 3)
        area = np.linalg.norm(np.cross(co[tv[:, 1]] - co[tv[:, 0]], co[tv[:, 2]] - co[tv[:, 0]]), axis=1) / 2
        check(area.min() > 1e-6, f"{label}: {n} smallest triangle {area.min():.2e} m2")


# ---- the terrace
r = apply(TERRACE, 0)
check(r["result"] == ["FINISHED"] and set(r["targets"]) >= {ROUGH, FAIR} and FAR not in r["targets"],
      f"terrace ran on the rough and the fairway, not the far mesh ({r['targets']})")
seams_closed("terrace")
face_top = 0.2 + 1.2 / TAN60
worst, n_checked, n_raised = 0.0, 0, 0
for n in (ROUGH, FAIR):
    co = sa.positions(bpy.data.objects[n]).astype(np.float64)
    for x, y, z in co.tolist():
        if y > 6.0:
            continue          # the cliff's side
        z0 = ground(y)
        exp = z0
        s = x + 5.0
        if 0.0 <= s <= 10.0 and 0.2 <= y <= 2.5:
            target = (y - 0.2) * TAN60 if y <= face_top else 1.2
            lift = (target - z0) * min(max(min(s, 10.0 - s) / 1.5, 0.0), 1.0)
            if lift > 0.005:
                exp = z0 + lift
        if exp != z0:
            n_raised += 1
        worst = max(worst, abs(z - exp))
        n_checked += 1
check(worst < 1e-3 and n_raised > 50, f"terrace heights match the hand profile: {n_checked} vertices, {n_raised} raised, "
                                      f"worst {worst * 1000:.3f} mm")
far = bpy.data.objects[FAR]
check(len(far.data.polygons) == far_faces and np.array_equal(sa.positions(far), far_before), "the far mesh is untouched")


def corner_colours(n):
    a = bpy.data.objects[n].data.color_attributes["Col"]
    buf = np.empty(len(a.data) * 4, dtype=np.float32)
    a.data.foreach_get("color_srgb", buf)
    return buf.reshape(-1, 4)


rc, fc = corner_colours(ROUGH), corner_colours(FAIR)
stone = (rc[:, 2] > 0.02) | (rc[:, 1] > 0.02)
check(stone.sum() > 20, f"the rough's face is painted ({int(stone.sum())} corners blue/green)")
check(np.allclose(fc, [1.0, 0.0, 0.0, 1.0]), "the fairway keeps its red (no stone paint off rough / deep)")
check((rc[:, 1] > 0.5).sum() > 0, "the steep face's stone turned green (stoneFace)")
me = bpy.data.objects[ROUGH].data
check(me.has_custom_normals and wg.VN_LAYER not in me.attributes, "custom normals kept, the temporary layer gone")

# ---- the cliff (a smoke run of the cliff path: rounded top, outline, grass patch, jitter)
r = apply(CLIFF, 1)
check(r["result"] == ["FINISHED"] and r["raised"] > 0 and r["painted"] > 0,
      f"cliff ran: raised {r['raised']}, lowered {r['lowered']}, painted {r['painted']}")
seams_closed("cliff")
check(len(far.data.polygons) == far_faces and np.array_equal(sa.positions(far), far_before), "the far mesh is still untouched")
check(np.allclose(corner_colours(FAIR), [1.0, 0.0, 0.0, 1.0]), "the fairway still keeps its red")

if failures:
    raise AssertionError(f"shape_wallground_test: {len(failures)} FAILED: " + "; ".join(failures))
print("shape_wallground_test: all passed")
