"""Headless smoke test of golfmap.paint (shape_paintop.py) on tiny Spline_* meshes, through shape_apply's unit runner
and op cache:

    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 \
        --python blender/tools/shape_paintop_test.py

An object rule (a creek bed's border fade), a road rule (the R.A.M. roads export) and a stroke (a circle, overlay),
checked against hand-computed colours; a fairway in the road's reach, a R.A.M. road object and an unrelated mesh stay
as they are; an edited roads export re-keys the road units (cache miss), an unchanged one replays from the cache."""
import json
import os
import sys
import tempfile
import traceback

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_apply as sa  # noqa: E402
import shape_paintop as po  # noqa: E402

FRAME = {"e0": 1000.0, "n0": 5000.0, "sideM": 100.0, "minM": 0.0, "px": 0.0, "py": 0.0, "pz": 0.0}
TOL = 1.0 / 255 + 1e-6


def grid(name, x0, y0, nx, ny, step=0.5, colour=(1.0, 0.0, 0.0, 1.0)):
    verts = [(x0 + i * step, y0 + j * step, 0.0) for j in range(ny) for i in range(nx)]
    faces = [(j * nx + i, j * nx + i + 1, (j + 1) * nx + i + 1, (j + 1) * nx + i) for j in range(ny - 1) for i in range(nx - 1)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    buf = np.tile(np.array(colour, dtype=np.float32), len(me.loops))
    col.data.foreach_set("color_srgb", buf)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def colour_at(ob, x, y):
    me = ob.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    v = int(np.argmin((co[:, 0] - x) ** 2 + (co[:, 1] - y) ** 2))
    assert abs(co[v, 0] - x) < 1e-4 and abs(co[v, 1] - y) < 1e-4, (ob.name, x, y)
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", lv)
    buf = np.empty(len(me.loops) * 4, dtype=np.float32)
    me.color_attributes["Col"].data.foreach_get("color_srgb", buf)
    return buf.reshape(-1, 4)[lv == v][0]


def check(label, got, want):
    if not np.allclose(np.asarray(got)[:len(want)], want, atol=TOL):
        raise AssertionError(f"{label}: got {np.round(got, 4).tolist()}, want {want}")
    print(f"  ok {label}: {np.round(got, 3).tolist()}")


def roads_file(folder, y_plot):
    with open(os.path.join(folder, "t-inner-ramroads.json"), "w") as f:
        json.dump({"format": "unity-ramroads-v1", "plot": {"terrain": "inner"},
                   "roads": [{"id": "path_1", "surface": "gravel", "widthM": 4.0, "points": [[-1.0, y_plot], [21.0, y_plot]]}]}, f)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    tmp = tempfile.mkdtemp(prefix="paintop-")
    with open(os.path.join(tmp, "t-inner-dem-100m.tif.json"), "w") as f:
        json.dump({"square3006": [1000, 5000, 1100, 5100]}, f)
    roads_file(tmp, 5.0)   # plot z 5 -> .blend y -5; plot x -1..21 -> .blend x 1..-21

    rough = grid("Spline_hole_1_1_Rough_-_Mesh", -10.0, -10.0, 21, 21)
    fairway = grid("Spline_hole_1_2_Fairway_-_Mesh", -20.0, -10.0, 17, 21, colour=(0.0, 1.0, 0.0, 1.0))
    bed = grid("Spline_cb_WaterBrook_-_Mesh", -24.0, -4.0, 9, 9)
    ram = grid("RAM road path_1", -10.0, -6.0, 21, 3)
    other = grid("Spline_hole_2_1_Rough_-_Mesh", -60.0, -60.0, 5, 5)

    ctx = sa.Ctx(bpy.context.scene, [], {}, None, FRAME)
    ctx.dem_sidecar = os.path.join(tmp, "t-inner-dem-100m.tif.json")
    runner = sa.UnitRunner(sa.OpCache(os.path.join(tmp, "cache")), None)
    runner.code_keys[po.KIND] = {"key": "paintop-test"}
    ctx.runner = runner

    def apply(op):
        runner.begin_op(0, "paint:" + op["id"])
        runs, problems = po.op_paint(ctx, op)
        return runs, problems, runner.records["paint:" + op["id"]]

    ops = [
        {"id": "paint-creek-bed", "op": po.KIND, "rule": {"id": "creek-bed", "kind": "object", "match": "_WaterBrook_-_Mesh",
                                                          "channel": "black", "strength": 1.0, "fadeM": 0.5}},
        {"id": "paint-ram-roads", "op": po.KIND, "rule": {"id": "ram-roads", "kind": "road", "surfaces": ["Rough", "Deep"],
                                                          "channel": "black", "strength": 1, "insetM": 0.4, "fadeM": 1.0}},
        {"id": "paint-stroke-dry", "op": po.KIND, "rule": {"id": "dry", "kind": "stroke", "geometry": "circle",
                                                           "centre3006": [1002.0, 5002.0], "radiusM": 1.0, "featherM": 1.0,
                                                           "channel": "blue", "mode": "overlay"}},
    ]
    for op in ops:
        errs = po.pr.validate(op["rule"])
        assert not errs, errs

    print("object rule")
    runs, problems, rec = apply(ops[0])
    assert not problems and [r["feature"] for r in runs] == [bed.name], (runs, problems)
    assert rec[bed.name]["writes"] == [bed.name], rec
    check("bed border stays red", colour_at(bed, -24.0, -2.0), [1, 0, 0, 1])
    check("bed 0.5 m in: black", colour_at(bed, -23.5, -2.0), [0, 0, 0, 1])
    check("bed centre: black", colour_at(bed, -20.0 - 2.0, -2.0), [0, 0, 0, 1])

    print("road rule")
    runs, problems, rec = apply(ops[1])
    assert not problems, problems
    assert sorted(r["feature"] for r in runs) == [rough.name], runs   # fairway: other surface; RAM / far mesh: never
    check("on the centreline: black", colour_at(rough, -5.0, -5.0), [0, 0, 0, 1])
    check("1.5 m off: black", colour_at(rough, -5.0, -6.5), [0, 0, 0, 1])
    t = 0.4
    check("2 m off: fading", colour_at(rough, -5.0, -7.0), [1 - (1 - t * t * (3 - 2 * t)), 0, 0, 1])
    check("3 m off: red", colour_at(rough, -5.0, -8.0), [1, 0, 0, 1])
    check("fairway untouched", colour_at(fairway, -15.0, -5.0), [0, 1, 0, 1])
    check("RAM road object untouched", colour_at(ram, -5.0, -5.0), [1, 0, 0, 1])

    print("stroke")
    runs, problems, rec = apply(ops[2])
    assert [r["feature"] for r in runs] == [rough.name], runs
    check("circle inside: blue raised, red kept", colour_at(rough, -2.0, -2.0), [1, 0, 1, 1])
    check("circle 0.5 m out: half", colour_at(rough, -0.5, -2.0), [1, 0, 0.5, 1])
    check("circle 1 m out: none", colour_at(rough, 0.0, -2.0), [1, 0, 0, 1])
    check("far mesh untouched", colour_at(other, -59.0, -59.0), [1, 0, 0, 1])

    print("export file keys the road units")
    for o in (rough, fairway, bed, ram, other):   # back to the start, as a replay from the conformed cache
        col = o.data.color_attributes["Col"]
        c = (0.0, 1.0, 0.0, 1.0) if o is fairway else (1.0, 0.0, 0.0, 1.0)
        col.data.foreach_set("color_srgb", np.tile(np.array(c, dtype=np.float32), len(o.data.loops)))
    runner.invalidate()
    hits = runner.stats["hits"]
    apply(ops[1])
    assert runner.stats["hits"] == hits + 1, runner.stats
    check("replayed from the cache", colour_at(rough, -5.0, -5.0), [0, 0, 0, 1])
    rough.data.color_attributes["Col"].data.foreach_set("color_srgb", np.tile(np.array((1, 0, 0, 1), dtype=np.float32), len(rough.data.loops)))
    runner.invalidate()
    roads_file(tmp, 8.0)   # the road moved 3 m: plot z 8 -> .blend y -8
    misses = runner.stats["misses"]
    apply(ops[1])
    assert runner.stats["misses"] == misses + 1, runner.stats
    check("old centreline: red again", colour_at(rough, -5.0, -5.0), [1, 0, 0, 1])
    check("new centreline: black", colour_at(rough, -5.0, -8.0), [0, 0, 0, 1])
    runs, problems, _ = apply({"id": "paint-lakebed", "op": po.KIND, "rule": {"id": "lakebed", "kind": "lakebed"}})
    assert runs == [] and problems == [], (runs, problems)   # no big lake on this course: nothing, quietly
    runs, problems, _ = apply({"id": "paint-x", "op": po.KIND, "rule": {"id": "x", "kind": "object", "match": "Brook",
                                                                        "belowM": 0.1, "creek": "feature:none"}})
    assert runs == [] and len(problems) == 1 and "creeks" in problems[0], problems
    dep = po.dependency(ops[1], tmp)
    assert dep["file"] == "t-inner-ramroads.json" and dep["sha"], dep
    print("shape_paintop_test: all ok")


try:
    main()
except Exception:
    traceback.print_exc()
    sys.exit(1)
