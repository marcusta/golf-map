"""Two guards of golfmap.cut_out's dem rise, on synthetic meshes (no course files):

1. the granite relief (shape_apply.dem_granite): faces that still flip after the 6 halvings get no relief at all -
   no face of the slab ends up turned over, and the report says how many vertices were reverted;
2. seams the dem rise opened fail the op: cut_out puts every mesh it can reach back as it was, removes the rock it
   made, and lets RiseSeamsOpen through (Applier.apply_op: status error).

Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_rise_revert_test.py
"""
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
bpy.ops.wm.read_factory_settings(use_empty=True)
import shape_apply as sa  # noqa: E402


def grid(name, x0, n, step):
    verts = [(x0 + i * step, j * step, 0.0) for i in range(n) for j in range(n)]
    faces = [(i * n + j, (i + 1) * n + j, (i + 1) * n + j + 1, i * n + j + 1) for i in range(n - 1) for j in range(n - 1)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj["opcd_kind"] = "mesh"
    return obj


class Steep:
    """A DEM sampler stand-in: a 72 degree face everywhere (z = 3 x), so the relief works on every vertex."""
    window = np.zeros((4, 4))
    res = (0.5, 0.5)

    def __call__(self, xy, grid=None):
        return 3.0 * np.asarray(xy, dtype=np.float64)[:, 0]


# 1. the relief: a displacement far larger than the 0.25 m faces, so halving alone cannot keep them the right way up
slab = grid("Spline_relief_Rock_-_Mesh", 0.0, 41, 0.25)
poly = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
co0 = sa.positions(slab).astype(np.float64)
p = sa.rise_params({"mode": "dem", "sharpen": 0, "facets": 0, "terrace": 0, "reliefM": 20.0, "falloffM": 1.0})
rep = sa.dem_granite(slab, poly, p, 7, Steep())
relief = rep["steps"]["relief"]
tri = sa._triangles(slab.data)
co1 = sa.positions(slab).astype(np.float64)
n0, n1 = sa._tri_normals(co0, tri), sa._tri_normals(co1, tri)
turned = int(((np.einsum("ij,ij->i", n0, n1) <= 0) & (np.linalg.norm(n0, axis=1) > 1e-12)).sum())
assert turned == 0, f"{turned} face(s) turned over"
assert relief["flips"] == 0 and "warning" not in relief, relief
assert relief["flippedAfterHalvings"] > 0 and relief["revertedVertices"] > 0, relief
assert np.allclose(co1[:, 2], co0[:, 2]), "the relief moves only in XY"
assert relief["maxDxy"] > 0.25, relief  # the rest kept its relief
print("relief:", {k: relief[k] for k in ("flippedAfterHalvings", "revertedVertices", "maxDxy")})

# 2. the put-back: the real cut (rock cut out of A, its border cut into A and B) with a rise that moves A's and B's
#    vertices and then finds seams open (the DEM read and the rise itself stand-ins)
bpy.data.objects.remove(slab)
a = grid("Spline_rise_a_Rough_-_Mesh", 20.0, 9, 1.0)
b = grid("Spline_rise_b_Rough_-_Mesh", 28.0, 9, 1.0)
before = {o.name: sa.state_hash(*sa.capture_state(o)) for o in (a, b)}
import shape_coords  # noqa: E402
frame = shape_coords.load_frame({"square3006": [500000, 6400000, 500100, 6400100], "minM": 0})
ctx = sa.build_ctx({}, frame)
outline = [shape_coords.from_blend(x, y, frame) for x, y in ((25.3, 2.3), (29.6, 2.3), (29.6, 5.6), (25.3, 5.6))]
op = {"id": "rise_x", "op": "golfmap.cut_out", "name": "rise_x", "outline3006": [list(p) for p in outline],
      "rise": {"mode": "dem"}}


def failing_rise(ctx, op, slab, poly):
    for o in (a, b, slab):
        co = sa.positions(o).astype(np.float64)
        co[:, 2] += 0.3
        o.data.vertices.foreach_set("co", co.astype(np.float32).reshape(-1))
        o.data.update()
    raise sa.RiseSeamsOpen(f"{slab.name}: 4 seam point(s) opened by the dem rise")


sa.dem_sampler = lambda ctx, box: (None, {})
sa.rock_rise = failing_rise
try:
    sa.cut_out(ctx, op)
except sa.RiseSeamsOpen as e:
    assert isinstance(e, RuntimeError)
else:
    raise AssertionError("RiseSeamsOpen was swallowed")
assert sa.cut_out_name(op) not in bpy.data.objects, "the rock the failed rise made is still there"
assert {n: sa.state_hash(*sa.capture_state(bpy.data.objects[n])) for n in before} == before, "meshes not put back"
print("PASS dem rise guards: relief reverts what still flips (no face turned over); open seams put the unit's meshes back")
