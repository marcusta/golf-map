"""golfmap.cut_out `rise` (shape_apply.rock_rise) on a synthetic lake: a rock slab in the middle, a ring of rough round
it with a channel to the shore (a shore notch drawn round a rock, Vreta hole 15), the lake bed around. Checks: the
rock's top and foot, nothing lowered, the seams closed (shared points keep one height), the ring and channel under
the water joined the lake and the rough above it stayed.
Run: "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python-exit-code 1 --python blender/tools/shape_rise_test.py"""
import os
import sys
import types
sys.path.insert(0, os.path.dirname(__file__))
import bpy
import numpy as np

bpy.ops.wm.read_factory_settings(use_empty=True)
N, STEP = 24, 1.0                       # grid -12..12 m
WATER, BED = 9.4, 7.6


def ground(x, y):
    r = max(abs(x), abs(y))
    return BED if r < 9 else BED + (r - 9) * 1.2      # a basin with banks from 9 m out


def region(cx, cy):
    r = max(abs(cx), abs(cy))
    if r < 2.0:
        return "rock"
    if r < 3.5 or (abs(cx) < 1.0 and cy > 0):          # the ring and the channel to the north shore
        return "ring"
    return "lake"


verts = [(i * STEP - 12, j * STEP - 12) for j in range(N + 1) for i in range(N + 1)]
faces = {"rock": [], "ring": [], "lake": []}
for j in range(N):
    for i in range(N):
        a = j * (N + 1) + i
        q = (a, a + 1, a + N + 2, a + N + 1)
        cx, cy = verts[a][0] + 0.5, verts[a][1] + 0.5
        faces[region(cx, cy)].append(q)
names = {"rock": "Spline_t1_Rock_-_Mesh", "ring": "Spline_t1_ring_Rough_-_Mesh", "lake": "Spline_t1_Water_Base_Lake_-_Mesh"}
objs = {}
for k, fs in faces.items():
    used = sorted({v for f in fs for v in f})
    remap = {v: n for n, v in enumerate(used)}
    me = bpy.data.meshes.new(names[k])
    me.from_pydata([(verts[v][0], verts[v][1], ground(*verts[v])) for v in used], [], [[remap[v] for v in f] for f in fs])
    col = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    for l in col.data:
        l.color_srgb = (1, 0, 0, 1) if k != "lake" else (0, 0.2, 0.6, 1)
    o = bpy.data.objects.new(names[k], me)
    bpy.context.collection.objects.link(o)
    o["opcd_kind"] = "mesh"
    objs[k] = o

import shape_apply as sa


def snapshot():
    return {n: sa.positions(bpy.data.objects[n]).copy() for n in names.values()}


before = snapshot()
key = lambda c: (round(c[0], 3), round(c[1], 3))
z_before = {}
for co in before.values():
    for c in co:
        z_before[key(c)] = float(c[2])
index = [{"name": names["rock"], "type": "rock"}, {"name": names["ring"], "type": "rough"}, {"name": names["lake"], "type": "water"}]
ctx = types.SimpleNamespace(index=index, by_name={r["name"]: r for r in index})
poly = [(-2.0, -2.0), (2.0, -2.0), (2.0, 2.0), (-2.0, 2.0)]
op = {"name": "t1", "rise": {"waterM": WATER, "topM": 0.9, "footM": 0.35, "apronM": 3.0, "noiseM": 0.1, "maxEdgeM": 0.5, "seed": 3}}
rep = sa.rock_rise(ctx, op, objs["rock"], poly)
print("rise", {k: rep[k] for k in ("topZ", "footZ", "bedZ", "lifted", "sunk")})

after = snapshot()
rock = after[names["rock"]]
assert abs(rep["topZ"] - (WATER + 0.9)) < 1e-6 and abs(rep["footZ"] - (WATER - 0.35)) < 1e-6, rep
assert rock[:, 2].max() > WATER + 0.6, f"the rock's top {rock[:, 2].max():.2f} does not stand out of the water"
assert rock[:, 2].min() >= WATER - 0.35 - 1e-4, f"the rock's foot {rock[:, 2].min():.2f} is below the foot"
# lift only: no point lower than the ground under it was
for n, co in after.items():
    for c in co:
        z0 = ground(c[0], c[1]) if key(c) not in z_before else z_before[key(c)]
        assert c[2] >= z0 - 1e-4, f"{n} lowered at {key(c)}: {z0:.3f} -> {c[2]:.3f}"
# seams: every point two meshes share has one height
heights = {}
for n, co in after.items():
    for c in co:
        heights.setdefault(key(c), set()).add(round(float(c[2]), 4))
split = {k: v for k, v in heights.items() if len(v) > 1}
assert not split, f"{len(split)} shared points with two heights, e.g. {list(split.items())[:3]}"
# T-junctions closed: every boundary point of the rock has a partner on another mesh
others = np.concatenate([sa.boundary_points(objs["lake"]), sa.boundary_points(objs["ring"])])
okeys = {key(c) for c in others}
lonely = [key(c) for c in sa.boundary_points(objs["rock"]) if key(c) not in okeys]
assert not lonely, f"{len(lonely)} rock border points without a partner, e.g. {lonely[:3]}"
# the ring and channel under the water joined the lake; what is left of the rough is above it
assert rep["sunk"] and rep["sunk"]["moved"].get(names["ring"], 0) > 0, rep["sunk"]
ring = bpy.data.objects[names["ring"]]
if len(ring.data.polygons):
    rc = sa.positions(ring)
    for p in ring.data.polygons:
        assert max(rc[v, 2] for v in p.vertices) >= WATER - sa.RISE_SINK_BELOW_M - 1e-6, "a rough face under the water stayed rough"
print(f"rise test passed: rock {rock[:, 2].min():.2f}-{rock[:, 2].max():.2f} m, sunk {rep['sunk']['moved']}, "
      f"lifted {rep['lifted']}")
