"""course_check on a synthetic course: two meshes meeting at a seam, then the faults it must find.

    blender -b --factory-startup --python-exit-code 1 --python blender/tools/course_check_test.py
"""

import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import course_check  # noqa: E402


def grid(name, x0, x1, z_at_seam=0.0, flip=False):
    """A 2 x 2 m strip of quads from x0 to x1 (y 0..2), its x=1 column at z_at_seam (the seam)."""
    xs = [x0, (x0 + x1) / 2, x1]
    verts = [(x, y, z_at_seam if abs(x - 1.0) < 1e-9 else 0.0) for y in (0.0, 1.0, 2.0) for x in xs]
    faces = []
    for j in range(2):
        for i in range(2):
            a = j * 3 + i
            f = (a, a + 1, a + 4, a + 3)
            faces.append(tuple(reversed(f)) if flip and (i, j) == (0, 0) else f)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def reset():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def run(case):
    report = course_check.check()
    got = sorted((f["type"], f["severity"]) for f in report["findings"])
    print(case, got)
    return report, got


def main():
    reset()
    grid("Spline_hole_1_1_Fairway_-_Mesh", -1.0, 1.0)
    grid("Spline_hole_1_2_Rough_-_Mesh", 1.0, 3.0)
    report, got = run("whole")
    assert report["ok"] and got == [], got
    assert report["totals"]["pairsChecked"] == 1, report["totals"]

    reset()
    grid("Spline_hole_1_1_Fairway_-_Mesh", -1.0, 1.0)
    grid("Spline_hole_1_2_Rough_-_Mesh", 1.0, 3.0, z_at_seam=0.06)
    report, got = run("step")
    assert got == [("step", "error")], got
    assert report["findings"][0]["hole"] == "1"

    reset()
    grid("Spline_hole_1_3_Bunker_-_Mesh", -1.0, 1.0)
    grid("Spline_hole_1_3_B_Rough_Bunker_-_Blend", 1.0, 3.0, z_at_seam=0.03)
    report, got = run("bunker lip")
    assert got == [("step-lip", "info")] and report["ok"], got

    reset()
    grid("Spline_hole_1_1_Fairway_-_Mesh", -1.0, 1.0, flip=True)
    grid("Spline_hole_1_2_Rough_-_Mesh", 1.0, 3.0)
    report, got = run("flipped")
    assert got == [("flipped", "error")], got
    print("course_check_test: ok")


main()
