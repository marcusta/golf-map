"""The carry-over (`shape_carry`) on synthetic pairs of OPCD builds.

Each "build" is a scene of small Spline meshes saved as its own .blend, with the SVG it was built from and
that SVG's shape table (`<stem>-shapes.json`) beside it - the first in an export snapshot, the second next to
the .blend, as an export leaves them. Build B is build A as OPCD would rebuild it: the same shapes with ~1 mm
of vertex jitter (the same at a shared seam vertex, so B's own seams are closed), one re-filled inside the same
border, one with another border, one moved further, one shape edited. Seam clusters (meshes sharing border
vertices), well apart:

1. A1 | A2, both jittered: both swapped, back to build A's positions and UVs bit for bit; A2's new custom
   property is kept;
2. C1 | C2, C2 subdivided anew (another border): C2 'topology' and kept, C1 swapped, C2's vertices on their
   seam welded to C1's;
3. E1 | blend | F1, F1's shape edited (another fingerprint): F1 'shapeChanged', the blend 'shapeChanged' (it
   joins F1's shape) and welded to E1 where they meet, E1 swapped;
4. G1 | H1, G1 jittered, H1 bit-identical: G1 swapped, H1 'identical' and untouched;
5. an Outer_Deep_Sat fill piece | P1, both jittered: both swapped (the fill piece depends on P1's shape);
6. R1 | R2, R2 triangulated anew inside the same border: both swapped, R2 back to build A's quads;
7. a mesh only in B: 'new'; a mesh with one vertex 8 mm off: 'moved'.

The strict seam rule (`GOLFMAP_CARRY_SEAMS=strict`) on the same pair: clusters 2 and 3 stay as OPCD made
them ('seam'). Then the seams: every border vertex the cluster's meshes shared in B still coincides after the
swap (`shape_apply.slab_seam_check`: the same shared points, none open), the swap opened none, and the seam
check does see a 1 mm gap. Build C (B re-jittered) carries over from B's record: A1 / A2 get build A's mesh
again, so a shape that stays unchanged keeps one mesh across any number of builds.

No add-on needed. Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1 --python blender/tools/shape_carry_test.py
"""
import json
import os
import sys
import tempfile

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_apply as sa  # noqa: E402
import shape_carry as sc  # noqa: E402

FAILED = []
N = 2   # quads a side per patch


def check(what, got, want):
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + what + ("" if ok else f"  got {got!r}, want {want!r}"))
    if not ok:
        FAILED.append(what)


def jitter(seed, amp=0.001):
    """The same offset at the same location (rounded to 1 cm) in every mesh: OPCD's seams stay closed."""
    def f(x, y):
        h = (hash((round(x, 2), round(y, 2), seed)) & 0xFFFFFF) / 0xFFFFFF
        g = (hash((round(y, 2), round(x, 2), seed, 1)) & 0xFFFFFF) / 0xFFFFFF
        return (amp * (2 * h - 1) * 0.7, amp * (2 * g - 1) * 0.7)
    return f


def patch(name, x0, y0, size=4.0, shape_id=None, kind="mesh", parent=None, move=None, tris=False, props=None, n=N):
    """An (n x n)-quad patch with a UV map and a colour attribute, OPCD's custom properties."""
    me = bpy.data.meshes.new(name)
    verts = []
    for j in range(n + 1):
        for i in range(n + 1):
            x, y = x0 + size * i / n, y0 + size * j / n
            dx, dy = move(x, y) if move else (0.0, 0.0)
            verts.append((x + dx, y + dy, 0.0))
    faces = []
    for j in range(n):
        for i in range(n):
            a, b = j * (n + 1) + i, j * (n + 1) + i + 1
            c, d = (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i
            faces += [(a, b, c), (a, c, d)] if tris else [(a, b, c, d)]
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (co.x / 10.0, co.y / 10.0)
    col = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for c in col.data:
        c.color_srgb = (0.0, 1.0, 0.0, 1.0)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    obj["opcd_shape_id"] = shape_id or name
    obj["opcd_parent_id"] = parent or shape_id or name
    obj["opcd_kind"] = kind
    for k, v in (props or {}).items():
        obj[k] = v
    return obj


SHAPES = ["hole_1_1", "hole_1_2", "hole_1_3", "hole_1_4", "hole_1_5", "hole_1_6", "hole_1_7", "hole_1_8",
          "hole_1_9", "hole_1_a", "hole_1_b", "hole_1_c", "hole_1_d"]


def write_svg(path, fingerprints, mtime):
    paths = "\n".join(f'    <path id="{s}" style="fill:#000" d="M {i} 0 L {i + 1} 0 L {i} 1 Z"/>'
                      for i, s in enumerate(sorted(fingerprints)))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg">\n  <g id="layer1" inkscape:label="Hole1">\n'
                + paths + "\n  </g>\n</svg>\n")
    with open(sc.shapes_table_path(path), "w", encoding="utf-8") as f:
        json.dump({"format": sc.SHAPES_FORMAT, "svg": os.path.basename(path), "shapes": fingerprints}, f)
    os.utime(path, (mtime, mtime))


def build(which, seed):
    """Build A (which='A') or a rebuild of it ('B', 'C') with jitter `seed`."""
    bpy.ops.wm.read_homefile(use_empty=True)
    rebuilt = which != "A"
    jit = jitter(seed) if rebuilt else None
    # 1. A1 | A2
    patch("Spline_hole_1_1_Fairway_-_Mesh", 0, 0, shape_id="hole_1_1", move=jit)
    patch("Spline_hole_1_2_Fairway_-_Mesh", 4, 0, shape_id="hole_1_2", move=jit,
          props={"opcd_build": which})
    # 2. C1 | C2 (C2 subdivided anew in a rebuild: another border)
    patch("Spline_hole_1_3_Rough_-_Mesh", 0, 10, shape_id="hole_1_3", move=jit)
    patch("Spline_hole_1_4_Rough_-_Mesh", 4, 10, shape_id="hole_1_4", move=jit, n=3 if rebuilt else N)
    # 3. E1 | blend | F1 (F1's shape edited in B)
    patch("Spline_hole_1_5_Rough_-_Mesh", 0, 20, shape_id="hole_1_5", move=jit)
    patch("Spline_hole_1_5_Rough_B_Fairway_-_Blend", 4, 20, size=1.0, shape_id="hole_1_5", kind="blend",
          parent="hole_1_5", move=jit)
    patch("Spline_hole_1_6_Fairway_-_Mesh", 5, 20, shape_id="hole_1_6", move=jit)
    # 4. G1 | H1 (H1 bit-identical)
    # (OPCD rebuilt H1 bit for bit, so G1's vertices on their shared seam came out where they were too)
    patch("Spline_hole_1_7_Green_-_Mesh", 0, 30, shape_id="hole_1_7",
          move=(lambda x, y: jit(x, y) if x < 3.9 else (0.0, 0.0)) if jit else None)
    patch("Spline_hole_1_8_Green_-_Mesh", 4, 30, shape_id="hole_1_8")
    # 5. a fill piece | P1
    patch("Spline_Outer_Deep_Sat_1_-_Mesh", 0, 40, shape_id="Outer_Deep_Sat_1", move=jit)
    patch("Spline_hole_1_b_Rough_-_Mesh", 4, 40, shape_id="hole_1_b", move=jit)
    # 6. R1 | R2 (R2 triangulated anew inside the same border)
    patch("Spline_hole_1_c_Semi_-_Mesh", 0, 70, shape_id="hole_1_c", move=jit)
    patch("Spline_hole_1_d_Semi_-_Mesh", 4, 70, shape_id="hole_1_d", move=jit, tris=rebuilt)
    # 7. the rest
    patch("Spline_hole_1_9_Tee_-_Mesh", 0, 50, shape_id="hole_1_9",
          move=(lambda x, y: (0.008, 0.0) if (x, y) == (0.0, 50.0) else (0.0, 0.0)) if rebuilt else None)
    if rebuilt:
        patch("Spline_hole_1_a_Bunker_-_Mesh", 0, 60, shape_id="hole_1_a")


def save(folder, name, mtime):
    path = os.path.join(folder, name)
    bpy.ops.wm.save_as_mainfile(filepath=path)
    os.utime(path, (mtime, mtime))
    return path


def positions(name):
    return sa.positions(bpy.data.objects[name]).copy()


def uvs(name):
    me = bpy.data.objects[name].data
    v = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers["UVMap"].data.foreach_get("uv", v)
    return v


A1, A2 = "Spline_hole_1_1_Fairway_-_Mesh", "Spline_hole_1_2_Fairway_-_Mesh"
C1, C2 = "Spline_hole_1_3_Rough_-_Mesh", "Spline_hole_1_4_Rough_-_Mesh"
E1, EB, F1 = "Spline_hole_1_5_Rough_-_Mesh", "Spline_hole_1_5_Rough_B_Fairway_-_Blend", "Spline_hole_1_6_Fairway_-_Mesh"
G1, H1 = "Spline_hole_1_7_Green_-_Mesh", "Spline_hole_1_8_Green_-_Mesh"
OUTER, TEE, NEW = "Spline_Outer_Deep_Sat_1_-_Mesh", "Spline_hole_1_9_Tee_-_Mesh", "Spline_hole_1_a_Bunker_-_Mesh"
P1, R1, R2 = "Spline_hole_1_b_Rough_-_Mesh", "Spline_hole_1_c_Semi_-_Mesh", "Spline_hole_1_d_Semi_-_Mesh"

with tempfile.TemporaryDirectory(prefix="golfmap_carry_") as folder:
    staging = os.path.join(folder, "shaping-staging")
    t = 1_800_000_000
    fp_a = {s: "%012x" % i for i, s in enumerate(SHAPES)}
    fp_b = dict(fp_a, hole_1_6="ffffffffffff")
    write_svg(os.path.join(folder, "export-history", "s1", "course.svg"), {k: v for k, v in fp_a.items() if k != "hole_1_a"}, t)

    # Build A: nothing to carry over from; its record is written.
    build("A", 0)
    src_a = save(folder, "course_svg_1.blend", t + 100)
    rep_a, fin_a = sc.carry_over(src_a, staging)
    rec_a = fin_a()
    check("A: nothing before it", (rep_a["used"], "no previous build" in rep_a.get("skipped", "")), (False, True))
    check("A: built from the snapshot SVG", os.path.relpath(rep_a["svg"], folder), os.path.join("export-history", "s1", "course.svg"))
    check("A: recorded", os.path.isfile(rec_a["record"]), True)
    pos_a = {n: positions(n) for n in (A1, A2, G1, TEE, OUTER, R1, R2)}
    faces_a = len(bpy.data.objects[R2].data.polygons)
    uv_a = {n: uvs(n) for n in (A1, A2)}

    # Build B from the next export (next to the .blend). First with the strict seam rule (nothing recorded).
    write_svg(os.path.join(folder, "course.svg"), fp_b, t + 200)
    build("B", 1)
    src_b = save(folder, "course_svg_2.blend", t + 300)
    os.environ[sc.SEAMS_ENV] = "strict"
    rep_s, _ = sc.carry_over(src_b, staging)
    del os.environ[sc.SEAMS_ENV]
    codes = {n: d["code"] for n, d in rep_s["meshes"].items()}
    check("strict: a retriangulated neighbour blocks its cluster", (codes[C2], codes[C1], rep_s["meshes"][C1].get("blockedBy")),
          ("topology", "seam", C2))
    check("strict: so does an edited shape, through the blend", (codes[F1], codes[EB], codes[E1]),
          ("shapeChanged", "shapeChanged", "seam"))
    check("strict: counts", rep_s["counts"], {"identical": 1, "moved": 1, "new": 1, "seam": 2,
                                              "shapeChanged": 2, "swapped": 7, "topology": 1})
    check("strict: nothing welded", rep_s["weld"]["meshes"], 0)

    # The weld: every unchanged mesh swapped, a kept neighbour's seam vertices follow it (the snap of seams between
    # kept meshes and the patch off here; they are checked after build C).
    os.environ[sc.PATCH_ENV] = "0"
    build("B", 1)
    src_b = save(folder, "course_svg_2.blend", t + 300)
    pos_b = {n: positions(n) for n in (A1, A2, C1, C2, F1)}
    seams_b = {k: sa.slab_seam_check([bpy.data.objects[n] for n in v])
               for k, v in {"A": (A1, A2), "C": (C1, C2), "E": (E1, EB, F1), "G": (G1, H1), "O": (OUTER, P1),
                            "R": (R1, R2)}.items()}
    rep_b, fin_b = sc.carry_over(src_b, staging)
    del os.environ[sc.PATCH_ENV]
    codes = {n: d["code"] for n, d in rep_b["meshes"].items()}
    check("B: used, from build A", (rep_b["used"], os.path.basename(rep_b["previous"]["source"])), (True, "course_svg_1.blend"))
    check("B: built from the SVG next to it", rep_b["svgRel"], "course.svg")
    check("B: 1. jittered pair swapped", (codes[A1], codes[A2]), ("swapped", "swapped"))
    check("B: 2. another border kept, its neighbour swapped", (codes[C2], codes[C1]), ("topology", "swapped"))
    check("B: 3. edited shape and the blend joining it kept, the neighbour swapped", (codes[F1], codes[EB], codes[E1]),
          ("shapeChanged", "shapeChanged", "swapped"))
    check("B: 4. next to a bit-identical mesh", (codes[G1], codes[H1]), ("swapped", "identical"))
    check("B: 5. the fill piece and its neighbour swapped", (codes[OUTER], codes[P1]), ("swapped", "swapped"))
    check("B: 6. triangulated anew inside the same border: swapped, back to build A's quads",
          (codes[R1], codes[R2], rep_b["meshes"][R2].get("retriangulated"), len(bpy.data.objects[R2].data.polygons)),
          ("swapped", "swapped", True, faces_a))
    check("B: 7. moved, new", (codes[TEE], codes[NEW]), ("moved", "new"))
    check("B: counts", (rep_b["counts"], rep_b["retriangulated"]), ({"identical": 1, "moved": 1, "new": 1,
                                                                     "shapeChanged": 2, "swapped": 9, "topology": 1}, 1))
    check("B: swapped back to build A bit for bit",
          all(np.array_equal(positions(n), pos_a[n]) for n in (A1, A2, G1, OUTER, R1, R2)), True)
    check("B: UVs too", all(np.array_equal(uvs(n), uv_a[n]) for n in (A1, A2)), True)
    check("B: the kept meshes on a swapped one's seam are welded (C2, the blend), the rest untouched",
          ({n: d.get("welded") for n, d in rep_b["meshes"].items() if d.get("welded")}, np.array_equal(positions(F1), pos_b[F1])),
          ({C2: 2, EB: 1}, True))
    moved = np.sqrt(((positions(C2) - pos_b[C2]) ** 2).sum(1))
    check("B: the weld moved C2's seam vertices only, by under 1 mm",
          (int((moved > 0).sum()) <= 2, float(moved.max()) < 1e-3), (True, True))
    check("B: the new custom property kept", (bpy.data.objects[A2]["opcd_build"], rep_b["propsDiffer"]), ("B", 1))
    check("B: the swap opened no seam", rep_b["seams"]["openedBySwap"], 0)
    check("B: the jitter moved them back by under 1 mm", 0 < rep_b["swappedMoveMm"]["max"] < 1.0, True)
    for k, v in {"A": (A1, A2), "C": (C1, C2), "E": (E1, EB, F1), "G": (G1, H1), "O": (OUTER, P1),
                 "R": (R1, R2)}.items():
        got = sa.slab_seam_check([bpy.data.objects[n] for n in v])
        check(f"B: cluster {k}: the shared border points still coincide, none open",
              (got["points"], got["open"]), (seams_b[k]["points"], 0))
    check("B: a shared seam has its N+1 vertices", seams_b["A"]["points"], N + 1)
    # The seam check does see a seam a swap would open: C1 moved 1 mm away from C2.
    objs = {n: bpy.data.objects[n] for n in (C1, C2)}
    names, pairs = sc.seam_pairs({n: sc._boundary(o) for n, o in objs.items()})
    me = objs[C1].data
    keep = sa.positions(objs[C1]).copy()
    co = keep.copy()
    co[:, 0] += 0.001
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    check("seam check: a 1 mm gap on the C1 | C2 seam is found", sc.seam_check(objs, pairs, names, [C1]),
          {C1: 2, C2: 2})
    me.vertices.foreach_set("co", keep.ravel())
    me.update()
    rec_b = fin_b()
    doc_b = json.load(open(rec_b["record"], encoding="utf-8"))
    check("B: the record holds the swapped state", doc_b["meshes"][A1]["sha"],
          sa.state_hash(*sa.capture_state(bpy.data.objects[A1])))
    check("B: blends record the shapes they join", doc_b["meshes"][EB]["shapes"], ["hole_1_5", "hole_1_6"])
    check("B: fill pieces record the shapes they border", doc_b["meshes"][OUTER]["shapes"], ["hole_1_b"])

    # Build C: B re-jittered, the same SVG. Carries over from B's record, which holds build A's mesh.
    build("C", 2)
    src_c = save(folder, "course_svg_3.blend", t + 400)
    rep_c, fin_c = sc.carry_over(src_c, staging)
    codes_c = {n: d["code"] for n, d in rep_c["meshes"].items()}
    check("C: from build B", os.path.basename(rep_c["previous"]["source"]), "course_svg_2.blend")
    check("C: the pair swapped again, to build A's mesh", (codes_c[A1], codes_c[A2],
          all(np.array_equal(positions(n), pos_a[n]) for n in (A1, A2))), ("swapped", "swapped", True))
    check("C: the shape edited in B is unchanged since B", codes_c[F1] != "shapeChanged", True)
    # the snap of seams between kept meshes and the patch run by default (shape_region_test.py checks the patch's
    # geometry): within 5 mm, no seam opened
    sn = rep_c.get("snap") or {}
    check("C: the snap ran, within 5 mm", ("vertices" in sn and sn.get("maxMm", 0.0) <= 5.0, "patch" in rep_c), (True, True))
    open_c = {k: sa.slab_seam_check([bpy.data.objects[n] for n in v])["open"]
              for k, v in {"A": (A1, A2), "C": (C1, C2), "E": (E1, EB, F1), "G": (G1, H1), "O": (OUTER, P1),
                           "R": (R1, R2)}.items()}
    check("C: no seam open after the snap and the patch", open_c, {k: 0 for k in open_c})
    fin_c()

    # Off: nothing touched.
    build("C", 3)
    src_d = save(folder, "course_svg_4.blend", t + 500)
    before = positions(A1)
    rep_d, _ = sc.carry_over(src_d, staging, enabled=False)
    check("off: skipped, nothing swapped", (rep_d["used"], np.array_equal(positions(A1), before)), (False, True))

    # Pure parts.
    names, pairs = sc.seam_pairs({"a": (np.array([0, 1]), np.array([[0.0, 0.0], [1.0, 0.0]])),
                                  "b": (np.array([5, 6]), np.array([[0.00005, 0.0], [3.0, 0.0]]))})
    check("seam_pairs across a cell edge", pairs.tolist(), [[0, 0, 1, 5]])
    check("settle_clusters cascades through a chain",
          sc.settle_clusters({"x", "y", "z"}, set(), {"x": {"y"}, "y": {"x", "z"}, "z": {"y", "w"}})[0], set())
    w = sc.weld_plan(np.array([[0, 3, 1, 7], [1, 7, 2, 4], [0, 5, 2, 9]]), swapped={0}, frozen={2})
    check("weld_plan: a kept vertex follows the swapped one through its group, a frozen one stays", w, {1: [(7, 0, 3)]})
    check("settle_clusters keeps a cluster bordered by identical meshes",
          sc.settle_clusters({"x", "y"}, {"w"}, {"x": {"y", "w"}, "y": {"x"}})[0], {"x", "y"})

print("FAILED: " + ", ".join(FAILED) if FAILED else "all passed")
sys.exit(1 if FAILED else 0)
