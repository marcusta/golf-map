"""Is the course whole in Blender? Read-only checks of the course meshes (Spline_*, Gap_Issue_*), the Blender half of
Unity's `golfmap.course.check` (unity/Editor/GolfMap/GolfMapCourseCheck.cs), which checks the scene as the ball meets
it. Here the geometry is exact, so the findings name the Blender objects and the vertex where it goes wrong:

- seams: boundary vertices of two meshes coincident in XY (shape_apply.seam_check) at different heights - a step
  or a vertical slit between the meshes; a bunker's sand up to 6 cm under its own blend ring is its lip (info);
- T-junctions (shape_apply.tjunction_check, --tjunctions): a mesh's border vertex on the middle of a neighbour's
  border edge, off it in height - a hairline crack that shading shows;
- upside-down faces on top (world normal pointing down and the first face a ray from above meets): Unity's
  rays and the ball pass through them;
- vertices without a position (NaN), non-manifold edges (3+ faces), degenerate faces (no area).

Only the play area is checked: the play-surface meshes the holes' play lines cross (--play-lines, a
golfmap-play-lines-v1 file: every tee -> aim points -> green of every course on the site; not Outer_Deep, the big
others_* roughs or roads) and --buffer metres (100) round them, the same rule as Unity's check. Without play lines:
inside the course boundary (the largest ring of a golfmap-oob-v1 file, EPSG:3006) and --margin metres round it. Findings: type, severity (error / warn / info), note, objects,
EPSG:3006, Unity (x, y, z) = Blender (-x, z, -y); `changedPlaces` for Unity's GolfMap > Review.

Headless on any course .blend (OPCD's build, the conformed cache); never saves it:

    blender -b <course>.blend --python blender/tools/course_check.py -- [--play-lines <prefix>-play-lines.json]
        [--buffer 100] [--boundary <prefix>-oob.json] [--margin 50] [--sidecar <inner dem .tif.json>] [--tjunctions]
        [--out course-check-blender.json]

The shaping worker runs the same `check()` on the shaped course it holds (POST /check): the shaped meshes exist
only there and in the FBX, never in a saved .blend.
"""

import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import shape_apply as sa  # noqa: E402
import shape_coords  # noqa: E402

FORMAT = "golfmap-course-check-v1"
STEP_WARN_M = 0.01      # a seam step this high is a warning ...
STEP_ERROR_M = 0.05     # ... and this high an error (Unity's check uses the same)
BUNKER_LIP_M = 0.06
DOWN_NZ = -0.05         # a face whose unit normal z is below this points down
DEGENERATE_M2 = 1e-8
SLIVER_M2 = 0.01        # upside-down faces under this much area in one place are a warning, not an error


def course_meshes():
    return [o for o in bpy.data.objects
            if o.type == "MESH" and (o.name.startswith("Spline") or o.name.startswith("Gap_Issue"))]


def is_bunker_pair(a, b):
    sand = lambda n: n.endswith("_Bunker_-_Mesh")  # noqa: E731
    ring = lambda n: n.endswith("_Bunker_-_Blend")  # noqa: E731
    return (sand(a) and ring(b)) or (ring(a) and sand(b))


def hole_of(name):
    parts = name.split("_")
    return parts[2] if len(parts) > 3 and parts[1] == "hole" and parts[2].isdigit() else None


# ---------------------------------------------------------------- the area

def load_ring(path, frame):
    """The largest ring of a golfmap-oob-v1 file, in .blend x, y (numpy (N, 2))."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    best, best_area = None, 0.0
    for ring in doc.get("rings") or []:
        if len(ring) < 3:
            continue
        xy = np.array([shape_coords.to_blend(float(e), float(n), frame) for e, n, *_ in ring])
        area = abs(np.dot(xy[:, 0], np.roll(xy[:, 1], -1)) - np.dot(xy[:, 1], np.roll(xy[:, 0], -1))) / 2
        if area > best_area:
            best, best_area = xy, area
    return best


class Area:
    """Inside the ring or within `margin` of it; everything when there is no ring."""

    def __init__(self, ring=None, margin=50.0):
        self.ring, self.margin = ring, margin
        if ring is not None:
            self.a, self.b = ring, np.roll(ring, -1, axis=0)
            self.lo, self.hi = ring.min(axis=0) - margin, ring.max(axis=0) + margin

    def inside(self, x, y):
        if self.ring is None:
            return True
        if x < self.lo[0] or y < self.lo[1] or x > self.hi[0] or y > self.hi[1]:
            return False
        a, b = self.a, self.b
        crosses = ((a[:, 1] > y) != (b[:, 1] > y)) & (x < a[:, 0] + (y - a[:, 1]) / np.where(b[:, 1] == a[:, 1], 1e-12, b[:, 1] - a[:, 1]) * (b[:, 0] - a[:, 0]))
        if int(crosses.sum()) % 2:
            return True
        ab = b - a
        t = np.clip(((x - a[:, 0]) * ab[:, 0] + (y - a[:, 1]) * ab[:, 1]) / np.maximum((ab ** 2).sum(axis=1), 1e-12), 0, 1)
        d = np.hypot(a[:, 0] + ab[:, 0] * t - x, a[:, 1] + ab[:, 1] * t - y)
        return float(d.min()) <= self.margin

    def touches(self, obj):
        if self.ring is None:
            return True
        box = sa.bbox_xy(obj)
        if not box:
            return False
        x0, y0, x1, y1 = box
        return x1 >= self.lo[0] and x0 <= self.hi[0] and y1 >= self.lo[1] and y0 <= self.hi[1]


PLAY_LINE_STEP_M = 0.5


def is_play_surface(name):
    """A mesh the play lines can make the play area: a hole's own surfaces (its rough and deep too), rock slabs and
    water - not OPCD's Outer_Deep fill, the big others_* roughs (touching one would take all of it) or roads."""
    if name.startswith(("Spline_others_", "Spline_Outer", "Gap_Issue")) or "Concrete" in name or "Cart" in name:
        return False
    if "Deep" in name and not name.startswith("Spline_hole_"):
        return False
    return any(k in name for k in ("Green", "Fairway", "Tee", "Semi", "Bunker", "Rough", "Deep", "Water", "Creek",
                                   "Lake", "_Rock_", "Blend"))


def load_play_lines(path, frame):
    """A golfmap-play-lines-v1 file's lines in .blend x, y, and its course / hole counts."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    lines, holes = [], 0
    for c in doc.get("courses") or []:
        for h in c.get("holes") or []:
            holes += 1
            for line in h.get("lines") or []:
                pts = [shape_coords.to_blend(float(e), float(n), frame) for e, n, *_ in line]
                if len(pts) >= 2:
                    lines.append(pts)
    return lines, len(doc.get("courses") or []), holes


class PlayArea:
    """The play-surface meshes a ray from above every PLAY_LINE_STEP_M along the play lines meets first, and `buffer`
    metres round them (nearest vertex in plan: OPCD meshes are dense enough for a buffer of tens of metres)."""

    def __init__(self, lines, objs, buffer=100.0):
        from mathutils.kdtree import KDTree
        depsgraph = bpy.context.evaluated_depsgraph_get()
        scene = bpy.context.scene
        names = {o.name for o in objs}
        picked = set()
        for line in lines:
            for (ax, ay), (bx, by) in zip(line, line[1:]):
                n = max(1, int(math.ceil(math.hypot(bx - ax, by - ay) / PLAY_LINE_STEP_M)))
                for k in range(n + 1):
                    x, y = ax + (bx - ax) * k / n, ay + (by - ay) * k / n
                    hit, _loc, _n, _i, hobj, _m = scene.ray_cast(depsgraph, (x, y, 10000.0), (0.0, 0.0, -1.0), distance=20000.0)
                    if hit and hobj is not None and hobj.name in names and is_play_surface(hobj.name):
                        picked.add(hobj.name)
        self.buffer, self.picked = buffer, sorted(picked)
        pts = np.concatenate([world(bpy.data.objects[n])[:, :2] for n in self.picked]) if self.picked else np.zeros((0, 2))
        self.kd = KDTree(len(pts))
        for i, (x, y) in enumerate(pts):
            self.kd.insert((float(x), float(y), 0.0), i)
        self.kd.balance()
        self.lo = pts.min(axis=0) - buffer if len(pts) else np.zeros(2)
        self.hi = pts.max(axis=0) + buffer if len(pts) else np.zeros(2)

    def inside(self, x, y):
        if x < self.lo[0] or y < self.lo[1] or x > self.hi[0] or y > self.hi[1]:
            return False
        _co, _i, d = self.kd.find((float(x), float(y), 0.0))
        return d is not None and d <= self.buffer

    def touches(self, obj):
        box = sa.bbox_xy(obj)
        if not box:
            return False
        x0, y0, x1, y1 = box
        return x1 >= self.lo[0] and x0 <= self.hi[0] and y1 >= self.lo[1] and y0 <= self.hi[1]


# ---------------------------------------------------------------- the checks

def world(obj):
    m = np.array(obj.matrix_world)
    return sa.positions(obj).astype(np.float64) @ m[:3, :3].T + m[:3, 3]


def object_checks(objs, area, add):
    """NaN, non-manifold edges, degenerate faces, upside-down faces on top."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene
    totals = {"nonManifoldEdges": 0, "degenerateFaces": 0}
    for obj in objs:
        me = obj.data
        if not len(me.vertices):
            continue
        co = world(obj)
        if not np.isfinite(co).all():
            add("nan", "error", "vertices without a position", [obj.name], co[np.isfinite(co).all(axis=1)].mean(axis=0) if np.isfinite(co).any() else None)
            continue
        le = np.empty(len(me.loops), dtype=np.int32)
        me.loops.foreach_get("edge_index", le)
        uses = np.bincount(le, minlength=len(me.edges))
        nm = int((uses > 2).sum())
        totals["nonManifoldEdges"] += nm
        me.calc_loop_triangles()
        if not len(me.loop_triangles):
            continue
        tv = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("vertices", tv)
        tv = tv.reshape(-1, 3)
        tp = np.empty(len(me.loop_triangles), dtype=np.int32)
        me.loop_triangles.foreach_get("polygon_index", tp)
        cr = np.cross(co[tv[:, 1]] - co[tv[:, 0]], co[tv[:, 2]] - co[tv[:, 0]])
        ln = np.linalg.norm(cr, axis=1)
        totals["degenerateFaces"] += int((ln * 0.5 < DEGENERATE_M2).sum())
        down = np.nonzero((ln * 0.5 >= DEGENERATE_M2) & (cr[:, 2] < DOWN_NZ * ln))[0]
        if not len(down):
            continue
        centres = co[tv[down]].mean(axis=1)
        top, area_m2 = [], 0.0
        for k, c in zip(down, centres):
            if not area.inside(c[0], c[1]):
                continue
            hit, loc, _n, index, hobj, _m = scene.ray_cast(depsgraph, (c[0], c[1], c[2] + 500.0), (0.0, 0.0, -1.0), distance=600.0)
            # the first face from above is this one (or nothing above it reaches lower): it is on top
            if not hit or (hobj is not None and hobj.name == obj.name and index == int(tp[k])) or loc[2] < c[2] - 0.01:
                top.append(c)
                area_m2 += float(ln[k]) * 0.5
        if top:
            # slivers (a cut's leftovers) under SLIVER_M2 show at most as a speck; the ball cannot pass through them
            add("flipped", "error" if area_m2 >= SLIVER_M2 else "warn",
                f"{len(top)} upside-down faces ({area_m2:.3f} m2) on top: rays and the ball see through them",
                [obj.name], np.mean(top, axis=0))
    return totals


def seam_checks(objs, area, add):
    """Coincident border vertices of two meshes at different heights."""
    names = [o.name for o in objs]
    res = sa.seam_check(names)
    pairs = res["pairs"]
    for key, rec in sorted(pairs.items()):
        if not rec["gaps"] or rec["maxAbsDz"] <= STEP_WARN_M or "at" not in rec:
            continue
        a, b = key.split("|")
        x, y = rec["at"]
        if not area.inside(x, y):
            continue
        dz = rec["maxAbsDz"]
        if is_bunker_pair(a, b) and dz <= BUNKER_LIP_M:
            sev, kind, note = "info", "step-lip", f"bunker lip up to {dz * 100:.0f} cm, {rec['gaps']} vertices"
        else:
            sev = "error" if dz >= STEP_ERROR_M else "warn"
            kind, note = "step", f"seam step up to {dz * 100:.0f} cm at {rec['gaps']} of {rec['vertices']} shared border vertices"
        z = height_at(a, x, y)
        add(kind, sev, note, [a, b], (x, y, z))
    return {"pairsChecked": len(pairs), "pairsWithGaps": sum(1 for r in pairs.values() if r["gaps"]),
            "unmatchedBorderVertices": sum(res["unmatched"].values())}


def tjunction_checks(objs, area, add):
    out = sa.tjunction_check([o.name for o in objs])
    for name, rec in sorted(out.items()):
        if not rec.get("gaps") or rec["maxAbsDz"] <= STEP_WARN_M or "at" not in rec:
            continue
        x, y = rec["at"]
        if not area.inside(x, y):
            continue
        dz = rec["maxAbsDz"]
        add("tjunction", "error" if dz >= STEP_ERROR_M else "warn",
            f"border vertices on a neighbour's edge {dz * 100:.0f} cm off it ({rec['gaps']} of {rec['onEdge']})", [name], (x, y, height_at(name, x, y)))
    return {"objects": len(out), "gaps": sum(r.get("gaps", 0) for r in out.values())}


def height_at(name, x, y):
    obj = bpy.data.objects.get(name)
    if obj is None:
        return 0.0
    co = world(obj)
    return float(co[np.argmin((co[:, 0] - x) ** 2 + (co[:, 1] - y) ** 2), 2])


# ---------------------------------------------------------------- the report

def check(boundary=None, margin=50.0, sidecar=None, tjunctions=False, names=None, play_lines=None, buffer=100.0):
    """Run the checks on the open scene -> report dict (format golfmap-course-check-v1, layer blender)."""
    t0 = time.time()
    frame = None
    if sidecar:
        frame = shape_coords.load_frame(sidecar)
    else:
        try:
            frame = shape_coords.load_frame(shape_coords.find_sidecar(os.path.dirname(bpy.data.filepath) or "."))
        except (FileNotFoundError, OSError):
            frame = None
    area, area_note = None, None
    if play_lines and frame:
        lines, n_courses, n_holes = load_play_lines(play_lines, frame)
        play = PlayArea(lines, [o for o in course_meshes() if names is None or o.name in names], buffer)
        if play.picked:
            area = play
            area_note = (f"{os.path.basename(play_lines)}: {len(play.picked)} play-surface meshes under {len(lines)} play lines "
                         f"({n_holes} holes, {n_courses} course{'' if n_courses == 1 else 's'}) + {buffer:g} m")
    ring = None
    if area is None:
        ring = load_ring(boundary, frame) if boundary and frame else None
        area = Area(ring, margin)
        area_note = (os.path.basename(boundary) + f" + {margin:g} m") if ring is not None else "no boundary: every course mesh"
    objs = [o for o in course_meshes() if (names is None or o.name in names) and area.touches(o)]
    findings = []

    def add(kind, severity, note, objects, at):
        x, y, z = (float(at[0]), float(at[1]), float(at[2])) if at is not None else (0.0, 0.0, 0.0)
        f = {"type": kind, "severity": severity, "note": note, "objects": objects,
             "hole": next((h for h in map(hole_of, objects) if h), None),
             "blend": [round(x, 3), round(y, 3), round(z, 3)], "unity": [round(-x, 2), round(z, 2), round(-y, 2)]}
        if frame:
            e, n = shape_coords.from_blend(x, y, frame)
            f["epsg3006"] = [round(e, 2), round(n, 2)]
        findings.append(f)

    times = {}
    totals = object_checks(objs, area, add)
    times["objects"] = round(time.time() - t0, 1)
    totals.update(seam_checks(objs, area, add))
    times["seams"] = round(time.time() - t0, 1)
    if tjunctions:
        totals["tjunctions"] = tjunction_checks(objs, area, add)
        times["tjunctions"] = round(time.time() - t0, 1)
    rank = {"error": 0, "warn": 1, "info": 2}
    findings.sort(key=lambda f: (rank[f["severity"]], f["type"], f["objects"]))
    counts = {}
    for f in findings:
        c = counts.setdefault(f["type"], {"findings": 0, "severity": f["severity"]})
        c["findings"] += 1
    errors = sum(1 for f in findings if f["severity"] == "error")
    return {
        "format": FORMAT, "layer": "blender", "blend": bpy.data.filepath,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ok": errors == 0, "errors": errors, "warnings": sum(1 for f in findings if f["severity"] == "warn"),
        "area": area_note,
        "meshes": len(objs), "totals": totals, "counts": counts, "seconds": times, "findings": findings,
        # GolfMap > Review reads these (format golfmap-shaping-report-v1's changedPlaces)
        "changedPlaces": [{"type": f["severity"] + " " + f["type"], "hole": f["hole"], "note": f["note"], "objects": f["objects"],
                           "centre": {"blend": f["blend"], "unity": f["unity"], "epsg3006": f.get("epsg3006")}}
                          for f in findings if f["severity"] != "info"],
    }


def main(argv):
    ap = argparse.ArgumentParser(prog="course_check.py")
    ap.add_argument("--play-lines", help="golfmap-play-lines-v1 file: the area is the play-surface meshes these lines cross + --buffer")
    ap.add_argument("--buffer", type=float, default=100.0, help="metres checked round the play-surface meshes (default 100)")
    ap.add_argument("--boundary", help="without play lines: golfmap-oob-v1 file (EPSG:3006 rings; the largest is the course boundary)")
    ap.add_argument("--margin", type=float, default=50.0, help="metres checked beyond the boundary (default 50)")
    ap.add_argument("--sidecar", help="the inner DEM .tif.json (default: the one beside the .blend)")
    ap.add_argument("--tjunctions", action="store_true", help="also T-junctions (slower)")
    ap.add_argument("--out", help="write the report here (default: course-check-blender.json beside the .blend)")
    args = ap.parse_args(argv)
    report = check(args.boundary, args.margin, args.sidecar, args.tjunctions, play_lines=args.play_lines, buffer=args.buffer)
    out = args.out or os.path.join(os.path.dirname(bpy.data.filepath) or ".", "course-check-blender.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    brief = {k: report[k] for k in ("ok", "errors", "warnings", "area", "meshes", "totals", "counts", "seconds")}
    print("course_check: " + json.dumps(brief))
    print("course_check report: " + out)
    for f in report["findings"][:30]:
        if f["severity"] != "info":
            print(f"  {f['severity']:5} {f['type']:10} {f['note']} | {', '.join(f['objects'])} | epsg {f.get('epsg3006')}")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
