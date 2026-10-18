"""The op cache's hash memo (shape_apply.UnitRunner) on a synthetic scene: keys equal to the un-memoised ones,
reads the runner already hashed are not captured again, a replay leaves the memo right, GOLFMAP_SHAPE_VERIFY_HASH_MEMO
catches an edit made behind the runner's back, an outside ctx.forget() / an exception drops the memo, and the
worker's history copies only what a hit writes and still restores it.

Run: "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_hashmemo_test.py"""

import os
import shutil
import sys
import tempfile

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_apply as sa  # noqa: E402

FAILS = []


def check(cond, what):
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        FAILS.append(what)


def grid(name, x0):
    me = bpy.data.meshes.new(name)
    vs, fs = [], []
    n = 6
    for j in range(n):
        for i in range(n):
            vs.append((x0 + i, j, 0.0))
    for j in range(n - 1):
        for i in range(n - 1):
            a = j * n + i
            fs.append((a, a + 1, a + n + 1, a + n))
    me.from_pydata(vs, [], fs)
    me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o["opcd_kind"] = "mesh"
    return o


def lift(name, dz):
    def compute():
        me = bpy.data.objects[name].data
        co = np.empty(len(me.vertices) * 3, np.float32)
        me.vertices.foreach_get("co", co)
        co[2::3] += dz
        me.vertices.foreach_set("co", co)
        me.update()
        return {"feature": name, "targets": [name], "result": ["FINISHED"]}
    return compute


def fresh(names):
    return {n: sa.state_hash(*sa.capture_state(bpy.data.objects[n])) for n in names if n in bpy.data.objects}


bpy.ops.wm.read_factory_settings(use_empty=True)
for i, n in enumerate("ABCD"):
    grid("Spline_%s_Rough_-_Mesh" % n, i * 5.0)
A, B, C, D = ("Spline_%s_Rough_-_Mesh" % n for n in "ABCD")
original = {n: sa.capture_state(bpy.data.objects[n]) for n in (A, B, C, D)}
tmp = tempfile.mkdtemp(prefix="hashmemo-")
OP = {"id": "t", "op": "golfmap.weld_tjunctions", "select": {"type": "rough"}}
PLAN = [("u1", [A], {A, B}, lift(A, 0.5)), ("u2", [B], {A, B, C}, lift(B, 0.25)), ("u3", [C], {A, C, D}, lift(C, 0.0)),
        ("u4", [A], {A, D}, lift(A, -0.125))]


def new_ctx(history=None):
    ctx = sa.build_ctx({}, {"frame": "test"})
    ctx.runner = sa.UnitRunner(sa.OpCache(tmp), history)
    return ctx


def run_all(ctx, expect_keys=None):
    keys = []
    r = ctx.runner
    r.begin_op(0, "t:t")
    for uid, targets, reads, compute in PLAN:
        unit = sa.Unit(uid, targets, None, (lambda reads: lambda margin=0.0: set(reads))(reads))
        want = r.key(ctx, OP, unit, fresh(sorted(reads)))   # the un-memoised key
        keys.append(want)
        r.run(ctx, OP, unit, compute)
        check(os.path.isfile(r.cache.path(want)), f"{uid}: stored / found under the un-memoised key")
    r.end_op([A, B])
    if expect_keys is not None:
        check(keys == expect_keys, "the same keys as the first run")
    return keys


def reset(ctx):
    for n, st in original.items():
        sa.apply_state(n, *st)
    ctx.forget()   # outside the runner: drops the memo


try:
    os.environ["GOLFMAP_SHAPE_VERIFY_HASH_MEMO"] = "1"
    print("cold run (verify on)")
    ctx = new_ctx()
    keys = run_all(ctx)
    s = ctx.runner.stats
    check(s["misses"] == 4 and s["hits"] == 0, f"4 misses ({s['misses']}, {s['hits']} hits)")
    check(s["memoHits"] > 0 and s["memoVerified"] == s["memoHits"], f"memo used and verified ({s['memoHits']} hits)")
    after_cold = fresh([A, B, C, D])

    print("warm run (verify on)")
    reset(ctx)
    check(ctx.runner.memo == {}, "ctx.forget() dropped the memo")
    m0 = dict(ctx.runner.stats)
    run_all(ctx, keys)
    s = ctx.runner.stats
    check(s["hits"] - m0["hits"] == 4, f"4 hits ({s['hits'] - m0['hits']})")
    check(fresh([A, B, C, D]) == after_cold, "the warm run left the same meshes")
    check(s["memoHits"] - m0["memoHits"] >= 4, f"reads after a replay come from the memo ({s['memoHits'] - m0['memoHits']})")

    print("warm run, verify off: a memo hit is neither captured nor hashed")
    os.environ.pop("GOLFMAP_SHAPE_VERIFY_HASH_MEMO")
    reset(ctx)
    ctx = new_ctx()
    run_all(ctx, keys)
    s = ctx.runner.stats
    reads_total = sum(len(r) for _, _, r, _ in PLAN)
    check(s["memoMisses"] == 4 and s["memoHits"] == reads_total - 4,
          f"each mesh hashed once ({s['memoMisses']} misses, {s['memoHits']} memo hits of {reads_total} reads)")

    print("an edit behind the runner's back")
    os.environ["GOLFMAP_SHAPE_VERIFY_HASH_MEMO"] = "1"
    reset(ctx)
    ctx = new_ctx()
    run_all(ctx, keys)
    me = bpy.data.objects[D].data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co[2] += 1.0
    me.vertices.foreach_set("co", co)
    me.update()
    unit = sa.Unit("u5", [D], None, lambda margin=0.0: {D})
    ctx.runner.begin_op(1, "t:t2")
    try:
        ctx.runner.run(ctx, OP, unit, lift(D, 0.0))
        check(False, "verify raises on a stale memo")
    except RuntimeError as e:
        check("hash memo stale" in str(e), "verify raises on a stale memo: " + str(e)[:80])
    check(ctx.runner.memo == {}, "the memo is dropped after the error")
    ctx.runner.run(ctx, OP, unit, lift(D, 0.0))
    check(ctx.runner.memo.get(D, ("",))[0] == fresh([D])[D], "then D is hashed afresh")

    print("an exception in a unit drops the memo")
    def boom():
        raise ValueError("boom")
    try:
        ctx.runner.run(ctx, OP, sa.Unit("u6", [A], None, lambda margin=0.0: {A}), boom)
    except ValueError:
        pass
    check(ctx.runner.memo == {}, "memo empty after the exception")

    print("worker history: a hit copies only what it writes, and restores it")
    reset(ctx)
    hist = sa.History()
    ctx = new_ctx(hist)
    run_all(ctx, keys)
    copies = sorted(m.name for m in bpy.data.meshes if m.name.startswith("gmsnap."))
    check(sorted(hist.entries) == [A, B], f"history holds the written meshes only ({sorted(hist.entries)})")
    check(len(copies) == 2, f"two snapshot meshes kept ({len(copies)}), the rest freed")
    hist.restore(A, 0)
    hist.restore(B, 0)
    check(fresh([A, B]) == {n: sa.state_hash(*original[n]) for n in (A, B)}, "restore puts A and B back to the input")
    s = ctx.runner.stats
    check(s["keyHistorySeconds"] >= 0 and "keyCaptureSeconds" in s and "loadSeconds" in s, "the key split is reported")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

if FAILS:
    print("%d failed" % len(FAILS))
    sys.exit(1)
print("all passed")
