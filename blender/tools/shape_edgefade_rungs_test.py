"""golfmap.path_edge_fade on a narrow path made of rungs (OPCD's quads straight across, seam to seam): the strip
must stay a band along the edge and the path keep its core, no teeth to the middle (Vreta roads_145, 2026-10-15).
Run: "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python-exit-code 1 --python blender/tools/shape_edgefade_rungs_test.py"""
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
import bpy

HALF, STRIP, STEP, LENGTH = 0.75, 0.12, 0.5, 10.0
bpy.ops.wm.read_factory_settings(use_empty=True)


def make(name, rows, kind, red_of):
    n = int(LENGTH / STEP) + 1
    verts = [(i * STEP, y, 0.01 * i) for i in range(n) for y in rows]
    k = len(rows)
    faces = []
    for i in range(n - 1):
        for j in range(k - 1):
            a = i * k + j
            faces.extend([(a, a + k, a + k + 1, a + 1)] if kind == "blend" else [(a, a + k, a + k + 1), (a, a + k + 1, a + 1)])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    col = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    for loop in me.loops:
        r = red_of(me.vertices[loop.vertex_index].co.y)
        col.data[loop.index].color_srgb = (r, 0, 0, 1)
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj["opcd_kind"] = kind
    return obj


# the path: vertices on its two edges only, every triangle from one seam to the other
path = make("Path", [-HALF, HALF], "mesh", lambda y: 1)
# OPCD's blend convention before the fade: red 1 on the seam, 0 on the grass side
left = make("BlendL", [-HALF - STRIP, -HALF], "blend", lambda y: 1 if abs(abs(y) - HALF) < 1e-6 else 0)
right = make("BlendR", [HALF, HALF + STRIP], "blend", lambda y: 1 if abs(abs(y) - HALF) < 1e-6 else 0)

import shape_apply as sa
rep = sa.edge_fade_core([path], [left, right], width=0.3, max_edge=0.3, amplitude=0.55, seed=7, weld=False)
piece = rep["pieces"]["Path"]
assert piece.get("pathFaces"), rep
eff = piece["widthM"]

me = path.data
edges = {}
for p in me.polygons:
    for k in range(len(p.vertices)):
        e = tuple(sorted((p.vertices[k], p.vertices[(k + 1) % len(p.vertices)])))
        edges[e] = edges.get(e, 0) + 1
side = [me.vertices[i].co for e, c in edges.items() if c == 1 for i in e
        if 1e-3 < me.vertices[i].co.x < LENGTH - 1e-3]
assert side, "the path lost its sides"
inner = min(HALF - abs(v.y) for v in side)
outer = max(HALF - abs(v.y) for v in side)
# the path's edge goes no deeper than the zone (width + margin) + one refinement step (its inner side is a staircase
# at maxEdgeM by design, README "Shaping: path edge fade")
assert outer <= eff + sa.EDGE_FADE_ZONE_MARGIN_M + 0.3 + 1e-3,     f"a tooth reaches {outer:.3f} m into a {2 * HALF} m path (width {eff}): the strip cut the path"
# and the path's middle is path all the way along: no strip face reaches across it
from mathutils.geometry import intersect_point_tri_2d
me.calc_loop_triangles()
tris = [[me.vertices[i].co.to_2d() for i in t.vertices] for t in me.loop_triangles]
from mathutils import Vector
gaps = [x / 20 for x in range(5, int(LENGTH * 20) - 4)
        if not any(intersect_point_tri_2d(Vector((x / 20, 0)), *t) for t in tris)]
assert not gaps, f"the strip cuts the path's middle at x = {gaps[:8]}"
print(f"edge fade on rungs passed: path edge {inner:.3f}-{outer:.3f} m from the seam, width {eff}")
