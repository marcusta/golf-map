"""golfmap.path_kerb's cut (shape_apply._kerb_cut) leaves no n-gon that can fold: a concave road piece, a lip line cut
into it, its outer vertices dropped like the kerb's lip - no upside-down face, as Blender (and the FBX, use_triangles)
triangulates it. Vreta's road 124 had 176 of them on one piece before the cut's n-gons were ear-clipped while flat.

    blender.exe -b --factory-startup --python-exit-code 1 --python blender/tools/shape_kerb_cut_test.py
"""

import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import shape_apply as sa  # noqa: E402


def l_piece():
    """An L-shaped asphalt piece as ONE concave n-gon (8 m arms, 2 m wide)."""
    outline = [(0, 0), (8, 0), (8, 2), (2, 2), (2, 8), (0, 8)]
    me = bpy.data.meshes.new("Spline_roads_1_asphalt_0_Concrete_-_Mesh")
    me.from_pydata([(x, y, 0.0) for x, y in outline], [], [list(range(len(outline)))])
    me.update()
    ob = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def down_faces(ob):
    me = ob.data
    me.calc_loop_triangles()
    co = np.array([v.co[:] for v in me.vertices])
    n = 0
    for t in me.loop_triangles:
        a, b, c = (co[i] for i in t.vertices)
        cr = np.cross(b - a, c - a)
        if np.linalg.norm(cr) > 1e-9 and cr[2] < 0:
            n += 1
    return n


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    ob = l_piece()
    # the lip line: 0.12 m inside the outer edges of the L's inner corner side, as path_kerb cuts it
    line = [(7.9, 1.88), (1.88, 1.88), (1.88, 7.9)]
    run = sa._kerb_cut([ob], [line])
    me = ob.data
    assert all(len(p.vertices) == 3 for p in me.polygons), "the cut piece keeps an n-gon"
    # the lip's drop: the vertices on the outer (inner-corner) edges 4.5 cm down
    for v in me.vertices:
        if (abs(v.co.y - 2.0) < 1e-6 and v.co.x >= 2.0) or (abs(v.co.x - 2.0) < 1e-6 and v.co.y >= 2.0):
            v.co.z -= 0.045
    me.update()
    n = down_faces(ob)
    print("kerb cut:", run.get("triangulated"), "n-gons triangulated,", len(me.polygons), "faces,", n, "upside down")
    assert run.get("triangulated", 0) >= 1, run
    assert n == 0, f"{n} upside-down faces after the drop"
    print("shape_kerb_cut_test: ok")


main()
