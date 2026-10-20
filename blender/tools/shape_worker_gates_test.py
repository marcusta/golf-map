"""The shaping worker's /sync gates on a synthetic course; no course files, no live worker.

Two meshes side by side (A: 1 m quads; B: half as tall quads, so every other vertex of B's left border sits on the
middle of one of A's border edges, a T-junction) and a test-only op kind (`test.shape`, registered here) that lifts a
whole mesh (a seam gap), lifts B's T-junction vertices, turns a mesh upside down, puts a NaN into it or only moves
its interior. Checks: a sync that opens a gap / a T-junction step / upside-down top faces / a NaN fails with 422 and a
message naming the objects and the EPSG:3006 spot, nothing is exported, the objects, the applied ops and the history
are back as before the sync; `allowGaps` exports anyway with warnings; a gap that was there before the sync is only a
warning; after all of it a sync still lands where a fresh full apply does.

Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_worker_gates_test.py
"""
import json
import os
import sys
import tempfile
from types import SimpleNamespace

import bpy
import bmesh
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import shape_apply as sa  # noqa: E402
import shape_layers as sl  # noqa: E402
import shape_worker as sw  # noqa: E402

A, B = "Spline_gateA_Rough_-_Mesh", "Spline_gateB_Rough_-_Mesh"
KIND = "test.shape"


# ---------------------------------------------------------------- the test op kind

def plan_test(ctx, op):
    t = op["target"]
    return [sa.Unit("*", [t], None, lambda margin=0.0: {t})], []


def op_test(ctx, op):
    units, _ = sa.plan_units(ctx, op)
    runs = []
    for unit in units:
        def compute():
            obj = bpy.data.objects[op["target"]]
            me = obj.data
            mode, dz = op["mode"], float(op.get("dz", 0.0))
            if mode == "flip":
                bm = bmesh.new()
                bm.from_mesh(me)
                bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
                bm.to_mesh(me)
                bm.free()
            elif mode != "none":
                co = sa.positions(obj).astype(np.float64)
                border = sa._boundary_mask(me)
                if mode == "lift":
                    co[:, 2] += dz
                elif mode == "inner":
                    co[~border, 2] += dz
                elif mode == "tj":  # B's left border vertices between A's: on the middle of A's edges
                    m = border & (np.abs(co[:, 0] - 4.0) < 1e-6) & (np.abs(co[:, 1] % 1.0 - 0.5) < 1e-6)
                    co[m, 2] += dz
                elif mode == "nan":
                    co[int(np.nonzero(~border)[0][0]), 0] = np.nan
                me.vertices.foreach_set("co", co.astype(np.float32).reshape(-1))
            me.update()
            return {"feature": op["id"], "targets": [obj.name], "seed": None, "mode": mode}
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, []


sl.OPS[KIND] = {"params": {}, "keys": {"target", "mode", "dz"}, "noSelect": True}
sa.RUNNERS[KIND] = op_test
sa.PLANNERS[KIND] = plan_test
sa.CUT_OPS = sa.CUT_OPS + (KIND,)  # its targets get the T-junction check, as a cut's do
_code_key = sa.op_code_key
sa.op_code_key = lambda kind: ({"key": "test-" + kind, "functions": 2, "lines": 0, "modules": [], "wholeFile": False}
                                if kind == KIND else _code_key(kind))


# ---------------------------------------------------------------- the course

def grid(name, x0, nx, ny, dx, dy):
    verts = [(x0 + i * dx, j * dy, 0.0) for i in range(nx) for j in range(ny)]
    faces = [(i * ny + j, (i + 1) * ny + j, (i + 1) * ny + j + 1, i * ny + j + 1)
             for i in range(nx - 1) for j in range(ny - 1)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj["opcd_kind"] = "mesh"
    return obj


def state(name):
    return sa.state_hash(*sa.capture_state(bpy.data.objects[name]))


def expect_refused(worker, body, *needles):
    """The sync fails its gates: 422, the message names what and where, nothing changes."""
    before = {n: state(n) for n in (A, B)}
    ops = [r["canon"] for r in worker.ops]
    hist = {n: [e[:2] for e in lst] for n, lst in worker.history.entries.items()}
    manifest = open(MANIFEST, encoding="utf-8").read()
    fbx = sorted(os.listdir(FBX))
    try:
        worker.sync(body)
    except sw.HttpError as e:
        msg = str(e)
        assert e.code == 422, (e.code, msg)
    else:
        raise AssertionError("the sync passed its gates")
    for needle in needles + ("EPSG:3006", "nothing was exported", "allowGaps"):
        assert needle in msg, (needle, msg)
    assert {n: state(n) for n in (A, B)} == before, "objects not put back"
    assert [r["canon"] for r in worker.ops] == ops, "applied ops not put back"
    assert {n: [e[:2] for e in lst] for n, lst in worker.history.entries.items()} == hist, "history not put back"
    assert open(MANIFEST, encoding="utf-8").read() == manifest and sorted(os.listdir(FBX)) == fbx, "something was exported"
    assert worker.get_status()["lastRun"]["error"] == msg
    return msg


with tempfile.TemporaryDirectory(prefix="golfmap_gates_worker_") as folder:
    try:
        layers = os.path.join(folder, "layers")
        os.makedirs(layers)
        FBX = os.path.join(folder, "fbx")
        MANIFEST = os.path.join(FBX, ".golfmap-fbx-sync.json")
        svg = os.path.join(folder, "fixture.svg")
        dem = os.path.join(folder, "fixture-inner-dem-20m.tif.json")
        blend = os.path.join(folder, "fixture.conformed.blend")
        with open(svg, "w") as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg"><path id="rough_fixture" '
                    'data-type="rough" data-feature-id="fixture" d="M 0 0 L 8 0 L 8 4 Z"/></svg>')
        with open(dem, "w") as f:
            json.dump(dict(square3006=[500000, 6400000, 500020, 6400020], minM=0), f)

        def write_layer(a, b):
            ops = [dict(id="a1", op=KIND, target=A, **a), dict(id="b1", op=KIND, target=B, **b)]
            with open(os.path.join(layers, "00-test.json"), "w") as f:
                json.dump(dict(format="golfmap-shaping-layer-v1", id="test", ops=ops), f)

        bpy.ops.wm.read_factory_settings(use_empty=True)
        grid(A, 0.0, 5, 5, 1.0, 1.0)
        grid(B, 4.0, 5, 9, 1.0, 0.5)
        bpy.ops.wm.save_as_mainfile(filepath=blend)  # the synthetic fixture only, never a course file
        write_layer(dict(mode="inner", dz=0.2), dict(mode="none"))
        worker = sw.Worker(SimpleNamespace(port=0, blend=blend, layers=layers, fbx_folder=FBX, svg=svg,
                                           sidecar=dem, no_cache=False))
        loaded = worker.load({})
        assert not loaded["errors"], loaded["errors"]
        first = worker.sync({})  # first sync after a load: the FBX folder in step with the course
        assert sorted(first["exported"]) == sorted([A + ".fbx", B + ".fbx"]), first["exported"]

        # 1. a whole mesh lifted 5 cm: a seam gap with its neighbour
        write_layer(dict(mode="lift", dz=0.05), dict(mode="none"))
        msg = expect_refused(worker, {}, "seam gap 5.0 cm between", A, B)
        expect_refused(worker, {})  # again: the worker still holds the state before, so the same refusal
        print("refused:", msg)

        # 2. allowGaps: exported anyway, the failure a warning
        lifted = worker.sync({"allowGaps": True})
        gates = lifted["report"]["gates"]
        assert not gates["ok"] and gates["allowGaps"] and lifted["exported"] == [A + ".fbx"], (gates, lifted["exported"])
        assert [f["type"] for f in gates["failures"]] == ["seamGap"], gates
        assert gates["failures"][0]["epsg3006"] and gates["limits"] == {"gapM": 0.01, "tJunctionM": 0.01}
        assert any(w.startswith("allowGaps: exported anyway: seam gap 5.0 cm") for w in gates["warnings"]), gates

        # 3. the gap was there before: B's interior moving is no reason to refuse
        write_layer(dict(mode="lift", dz=0.05), dict(mode="inner", dz=0.1))
        inner = worker.sync({})
        gates = inner["report"]["gates"]
        assert gates["ok"] and not gates["failures"] and inner["exported"] == [B + ".fbx"], (gates, inner["exported"])
        assert sorted({f["type"] for f in gates["preExisting"]}) == ["seamGap", "tJunction"], gates["preExisting"]
        assert all(w.startswith("already there before this sync: ") for w in gates["warnings"]), gates["warnings"]

        # 4. the gap closed again, then a T-junction step of 3 cm on B
        write_layer(dict(mode="inner", dz=0.2), dict(mode="inner", dz=0.1))
        closed = worker.sync({})
        assert closed["report"]["gates"]["ok"] and not closed["report"]["gates"]["preExisting"], closed["report"]["gates"]
        write_layer(dict(mode="inner", dz=0.2), dict(mode="tj", dz=0.03))
        print("refused:", expect_refused(worker, {}, "T-junction step 3.0 cm on " + B))

        # 5. upside-down faces on top of A
        write_layer(dict(mode="flip"), dict(mode="inner", dz=0.1))
        print("refused:", expect_refused(worker, {}, "upside-down face(s) on top of " + A))

        # 6. a vertex without a position
        write_layer(dict(mode="nan"), dict(mode="inner", dz=0.1))
        print("refused:", expect_refused(worker, {}, "vertices without a position (NaN) in " + A))

        # 7. after the refusals a sync still lands where a fresh full apply does
        write_layer(dict(mode="inner", dz=0.3), dict(mode="none"))
        last = worker.sync({})
        assert last["report"]["gates"]["ok"] and sorted(last["exported"]) == sorted([A + ".fbx", B + ".fbx"]), last
        synced = sa.hash_all()
        worker.load({})
        assert sa.hash_all() == synced, "the synced course differs from a fresh full apply"
        print("PASS worker gates: gap, T-junction, upside-down and NaN refused with objects, ops and history put back "
              "and nothing exported; allowGaps exports with warnings; pre-existing gaps only warn; consistent after")
    finally:
        bpy.ops.wm.read_factory_settings(use_empty=True)  # release the fixture before Windows removes the folder
