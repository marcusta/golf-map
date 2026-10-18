"""Region entries of the op cache (shape_region + shape_apply.UnitRunner) on a synthetic pair of OPCD builds.

A course of three meshes: a big fill piece (`Outer_Deep_Sat`, random interior points like OPCD's, triangulated by
constrained Delaunay) with a hole for a far shape S1, that shape, and a rough strip R. A rock slab (`golfmap.cut_out`
with a dome rise) is cut across the fill piece and R, far from S1. Build B is build A after S1 was edited (made
bigger): the fill piece's half near S1 is refilled with new random points, the piece is renamed (OPCD renumbers),
its half around the slab is the same faces in the same order (what the carry-over's patch leaves); R is identical.

Checks:
1. build A, cold: the cut-out computes and stores an exact entry and a region entry (no "not local" reason);
2. build B: the exact entry misses (the fill piece changed), the region entry hits;
3. build B replayed = build B computed cold, order-free per mesh (shape_region.canonical_hash, custom normals
   included), and the slab's seams are closed;
4. build B again with the cache: the exact entry the region hit stored replays bit for bit;
5. build C (S1 moved next to the slab, the near half refilled): the region entry misses and it computes;
6. build D: B as OPCD really rebuilds it - the whole fill piece refilled with new random points - then the carry-over's
   patch (shape_patch) with build A's fill piece as donor: A's faces come back wherever they fit (all of the west
   half), the gaps round the bigger S1 are triangulated anew, the border is D's; the cut-out then hits by region and
   equals a cold compute of the patched D.

No add-on needed. Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_region_test.py
"""
import os
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_apply as sa  # noqa: E402
import shape_region as sreg  # noqa: E402

FAILED = []
FRAME = {"e0": 0.0, "n0": 0.0, "px": 0.0, "pz": 0.0, "py": 0.0, "minM": 0.0, "sideM": 100.0}
SEAM_X = 30.0   # the fill piece's two halves meet here (west: around the slab, east: around S1)


def check(what, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + what + ("" if ok else "  " + str(detail)))
    if not ok:
        FAILED.append(what)


def ground(x, y):
    return 10.0 + 0.05 * x + 0.03 * y + 0.4 * np.sin(x / 7.0) * np.cos(y / 5.0)


def triangulate(border_loops, points):
    """CDT of closed loops (outer first, holes after) and interior points: (verts xy, tris) inside the outer loop
    and outside the holes."""
    verts, edges = [], []
    for loop in border_loops:
        base = len(verts)
        verts += loop
        edges += [(base + i, base + (i + 1) % len(loop)) for i in range(len(loop))]
    verts += points
    out = delaunay_2d_cdt([Vector(v) for v in verts], edges, [], 0, 1e-9, True)
    co, _, faces, orig_verts = out[0], out[1], out[2], out[3]
    from shape_layers import point_in_polygon
    keep = []
    for f in faces:
        c = sum((co[i] for i in f), Vector((0, 0))) / len(f)
        if point_in_polygon(c.x, c.y, border_loops[0]) and not any(point_in_polygon(c.x, c.y, h) for h in border_loops[1:]):
            keep.append(list(f))
    return [(v.x, v.y) for v in co], keep


def rect(x0, y0, x1, y1, step):
    """Closed loop round a rectangle, a vertex every `step` m (counter-clockwise)."""
    def seg(a, b):
        n = max(1, int(round(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / step)))
        return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n)]
    return seg((x0, y0), (x1, y0)) + seg((x1, y0), (x1, y1)) + seg((x1, y1), (x0, y1)) + seg((x0, y1), (x0, y0))


def scatter(x0, y0, x1, y1, seed, avoid=(), spacing=1.1):
    rng = np.random.default_rng(seed)
    n = int((x1 - x0) * (y1 - y0) / spacing ** 2)
    pts = rng.uniform((x0 + 0.3, y0 + 0.3), (x1 - 0.3, y1 - 0.3), (n, 2))
    keep = np.ones(n, bool)
    for a in avoid:
        keep &= ~((pts[:, 0] > a[0] - 0.3) & (pts[:, 0] < a[2] + 0.3) & (pts[:, 1] > a[1] - 0.3) & (pts[:, 1] < a[3] + 0.3))
    return [tuple(p) for p in pts[keep].tolist()]


def make_mesh(name, verts_xy, tris, kind="mesh", shape_id=None, colour=(1.0, 0.0, 0.0, 1.0)):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x, y, 0.0) for x, y in verts_xy], [], tris)   # flat, as OPCD's source; conform() lifts it
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for c in col.data:
        c.color_srgb = colour
    me.update()
    # OPCD's meshes carry custom normals (straight up on the flat source: one value); the conform leaves the values
    me.normals_split_custom_set_from_vertices([(0.0, 0.0, 1.0)] * len(me.vertices))
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj["opcd_kind"] = kind
    obj["opcd_shape_id"] = shape_id or name
    obj["opcd_parent_id"] = shape_id or name
    return obj


def half(x0, x1, holes, seed):
    """One half of the fill piece: its border (with the seam at SEAM_X a vertex every 1 m) and random points."""
    loops = [rect(x0, 0.0, x1, 40.0, 1.0)] + [rect(*h, 1.0)[::-1] for h in holes]
    return triangulate(loops, scatter(x0, 0.0, x1, 40.0, seed, avoid=holes))


def fill_piece(name, west, east):
    """The fill piece = the west half's vertices and faces first, then the east half's (seam vertices merged)."""
    (wv, wt), (ev, et) = west, east
    verts = list(wv)
    key = {(round(x, 6), round(y, 6)): i for i, (x, y) in enumerate(wv)}
    remap = []
    for x, y in ev:
        k = (round(x, 6), round(y, 6))
        if k not in key:
            key[k] = len(verts)
            verts.append((x, y))
        remap.append(key[k])
    tris = wt + [[remap[i] for i in t] for t in et]
    return make_mesh(name, verts, tris, shape_id="Outer_Deep_Sat_0_0")


def conform():
    """What the conform does to the flat source: every vertex onto the ground (the custom normals' values stay)."""
    for o in sa.spline_meshes():
        co = sa.positions(o).copy()
        co[:, 2] = ground(co[:, 0], co[:, 1])
        o.data.vertices.foreach_set("co", co.ravel())
        o.data.update()


def build(which, west_seed=None, lift=True):
    """Build A, B or C (see the module doc)."""
    bpy.ops.wm.read_homefile(use_empty=True)
    s1 = {"A": (48.0, 28.0, 54.0, 34.0), "B": (44.0, 26.0, 56.0, 36.0), "C": (17.0, 18.0, 22.0, 22.0)}[which[0]]
    r_box = (0.0, 0.0, 8.0, 40.0)    # the rough strip along the west edge: x 0..8
    west_holes = [s1] if which == "C" else []
    east_holes = [s1] if which != "C" else []
    west = half(8.0, SEAM_X, west_holes, seed=west_seed or (11 if which != "C" else 31))
    east = half(SEAM_X, 60.0, east_holes, seed={"A": 21, "B": 22, "C": 21}[which[0]])
    name = "Spline_Outer_Deep_Sat_0_0_piece1_-_Mesh" if which == "A" else "Spline_Outer_Deep_Sat_0_0_piece2_-_Mesh"
    fill_piece(name, west, east)
    rv, rt = triangulate([rect(*r_box, 1.0)], scatter(*r_box, seed=5))
    make_mesh("Spline_others_1_Rough_-_Mesh", rv, rt, shape_id="others_1")
    sv, st = triangulate([rect(*s1, 1.0)], scatter(*s1, seed=7))
    make_mesh("Spline_hole_1_1_Fairway_-_Mesh", sv, st, shape_id="hole_1_1")
    if lift:
        conform()


# the slab: across the rough's east edge (x = 8) into the fill piece, 5 x 4 m (far from S1 in A and B)
OUTLINE = [(5.3, 12.2), (10.7, 12.6), (11.1, 16.4), (6.2, 16.9), (5.1, 14.4)]
OP = {"id": "rock-1", "op": "golfmap.cut_out", "name": "rock_one",
      "outline3006": [[-x, -y] for x, y in OUTLINE],   # shape_coords.to_blend(e, n) = (-e, -n) in this frame
      "rise": {"topM": 0.6, "apronM": 2.0, "noiseM": 0.1, "maxEdgeM": 0.6, "seed": 3}}


def run_op(cache_dir):
    ctx = sa.build_ctx({}, FRAME)
    runner = sa.UnitRunner(sa.OpCache(cache_dir) if cache_dir else None)
    ctx.runner = runner
    runner.begin_op(0, "global:" + OP["id"])
    runs, _ = sa.op_cut_out(ctx, OP)
    return runner, runs


def canon():
    return {o.name: sreg.canonical_hash(*sa.capture_state(o)) for o in sa.spline_meshes()}


def canon_no_names():
    return sorted(canon().values())


def main():
    cache = tempfile.mkdtemp(prefix="gm-region-")
    print("1. build A, cold")
    build("A", lift=False)
    donor = ("Spline_Outer_Deep_Sat_0_0_piece1_-_Mesh", sa.capture_state(bpy.data.objects["Spline_Outer_Deep_Sat_0_0_piece1_-_Mesh"]))
    conform()
    r, runs = run_op(cache)
    st = r.summary()
    check("A computes", st["misses"] == 1 and st["hits"] == 0, st)
    check("A stores a region entry", st.get("regionStored", 0) == 1 and not st.get("regionNotLocal"), st)
    check("A's cut finished", runs and runs[0].get("result") == ["FINISHED"], runs and runs[0].get("error"))

    print("2. build B against A's cache")
    build("B")
    r, runs = run_op(cache)
    st = r.summary()
    check("B misses the exact entry and hits the region entry", st["hits"] == 0 and st.get("regionHits", 0) == 1, st)
    check("the run record names B's fill piece",
          "Spline_Outer_Deep_Sat_0_0_piece2_-_Mesh" in runs[0].get("targets", []), runs[0].get("targets"))
    warm = canon()
    warm_state = {o.name: sa.state_hash(*sa.capture_state(o)) for o in sa.spline_meshes()}
    seams = sa.slab_seam_check(list(sa.spline_meshes()))
    check("B's seams closed after the replay", seams["open"] == 0, seams)
    slab = bpy.data.objects.get("Spline_rock_one_Rock_-_Mesh")
    check("the slab names B's meshes", slab is not None and "piece2" in slab.get("golfmap_cut_from", ""),
          slab and slab.get("golfmap_cut_from"))

    print("3. build B computed cold")
    build("B")
    run_op(None)
    cold = canon()
    check("the same meshes", sorted(cold) == sorted(warm), (sorted(cold), sorted(warm)))
    for n in sorted(cold):
        check(f"{n}: replay = cold compute (order-free)", cold[n] == warm.get(n))
    no_cn = lambda: {o.name: sreg.canonical_hash(*sa.capture_state(o), skip=(sreg.CUSTOM_NORMAL_KEY,)) for o in sa.spline_meshes()}
    cold_geo = no_cn()

    print("4. build B again with the cache: the exact entry")
    build("B")
    r, _ = run_op(cache)
    st = r.summary()
    check("an exact hit", st["hits"] == 1 and st.get("regionHits", 0) == 0, st)
    again = {o.name: sa.state_hash(*sa.capture_state(o)) for o in sa.spline_meshes()}
    check("bit for bit the region replay's result", again == warm_state)
    check("geometry = cold", no_cn() == cold_geo)

    print("5. build C: S1 next to the slab")
    build("C")
    r, _ = run_op(cache)
    st = r.summary()
    check("C misses both and computes", st["hits"] == 0 and st.get("regionHits", 0) == 0 and st["misses"] == 1, st)

    print("6. build D: the fill piece refilled all over, patched from A's")
    import shape_patch

    def build_d():
        build("B", west_seed=12, lift=False)
        fill = bpy.data.objects["Spline_Outer_Deep_Sat_0_0_piece2_-_Mesh"]
        st = sa.capture_state(fill)
        got, info = shape_patch.patch(st, [donor])
        check("D's fill piece patched", got is not None, info)
        if got is None:
            return None
        border_before = sorted(map(tuple, np.round(sa.boundary_points(fill)[:, :2], 6).tolist()))
        sa.apply_state(fill.name, *got)
        border_after = sorted(map(tuple, np.round(sa.boundary_points(fill)[:, :2], 6).tolist()))
        check("the patch keeps D's border", border_before == border_after)
        conform()
        return info

    info = build_d()
    if info:
        print("  patch:", {k: v for k, v in info.items() if k != "vmap"})
        check("most faces are A's", info["kept"] > 0.7 * info["faces"], info)
        r, _ = run_op(cache)
        st = r.summary()
        check("D hits by region", st.get("regionHits", 0) == 1 and st["hits"] == 0, st)
        warm = canon()
        build_d()
        run_op(None)
        cold = canon()
        check("D replayed = D computed cold (order-free)", warm == cold,
              [n for n in cold if cold[n] != warm.get(n)])
        check("D's seams closed", sa.slab_seam_check(list(sa.spline_meshes()))["open"] == 0)

    if FAILED:
        print(f"FAILED: {len(FAILED)}")
        for f in FAILED:
            print("  " + f)
        sys.exit(1)
    print("all ok")


main()
