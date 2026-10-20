"""The paint preview: a course's paint rules and strokes applied to the meshes Unity sent, in plain Python (numpy).

Unity no longer paints the course meshes by rules (Blender's `golfmap.paint` ops do, shape_paintop.py); it only
shows a temporary preview until the mesh's next FBX replaces it. This computes that preview's colours with the same
maths as the Blender op (shape_paintrules) and the same op order as the layer (pipeline/shaping_paint.paint_layer),
so a preview is what the next /sync paints.

    python blender/tools/shape_paintpreview.py [--in input.json] [--out output.json]   (stdin / stdout without)

Input:
    {"folder": "<course export folder: the inner DEM sidecar (frame) and the road / creek / lake-plane exports>",
     "frame": {...shape_coords frame...}            optional, instead of the folder's sidecar (tests)
     "paint": {...paint.json document...}            the rules and strokes; the ops come out in the layer's order
       or "ops": [{"id", "rule", "source"?}, ...]    the ops as they stand in 90-paint.gen.json
     "only": [op id, ...]                            optional: paint only these ops (paint-<rule id>,
                                                    paint-stroke-<id>), every op still checked: the base colours
                                                    carry the rest already (Blender painted them)
     "meshes": [{"object", "surface"?, "vertexCount", "positions": b64 float32 xyz (Unity world),
                 "colors": b64 float32 rgba (the FBX mesh's, may be empty), "triangles": b64 int32}, ...]}

Output:
    {"objects": [{"object", "colors": b64 float32 rgba}],   the meshes whose colours differ from the ones sent
     "unchanged": [object, ...],                            the meshes no op changed (a stale preview of these
                                                            goes back to the FBX)
     "changed": n, "ops": n, "warnings": [...]}

Frames: Unity world = (-x, z, -y) of the .blend (shape_paintrules header), so .blend = (-ux, -uz, uy). Colours are
quantised to bytes after every op as the Blender op's BYTE_COLOR attribute does. Differences from the Blender op: per
vertex instead of per face corner (Unity's colours are per vertex), and an edge rule sees only the bunker blends among
the meshes sent. A rule error (or an invalid paint.json) exits 1 with the message on stderr.
"""

import argparse
import base64
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import shape_coords  # noqa: E402
import shape_paintrules as pr  # noqa: E402

PIPELINE = os.path.join(os.path.dirname(os.path.dirname(HERE)), "pipeline")


def _layer_ops(paint):
    """The ops of a paint.json document in the layer's order (pipeline/shaping_paint.paint_layer)."""
    if PIPELINE not in sys.path:
        sys.path.insert(0, PIPELINE)
    import shaping_paint
    try:
        return shaping_paint.paint_layer(paint)["ops"]
    except shaping_paint.PaintError as e:
        raise pr.RuleError(str(e))


def _b64(text, dtype, width):
    if not text:
        return None
    a = np.frombuffer(base64.b64decode(text), dtype=dtype)
    return a.reshape(-1, width) if width > 1 else a


def _enc(a):
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.float32).tobytes()).decode("ascii")


def _quantise(c):
    return np.floor(np.clip(c, 0.0, 1.0) * 255.0 + 0.5) / 255.0


def _box_gap(a, b):
    return max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0.0)


class Mesh:
    """One mesh as Unity sent it, in the .blend frame."""

    def __init__(self, m):
        self.name = str(m["object"])
        pos = _b64(m.get("positions"), np.float32, 3)
        self.world = np.zeros((0, 3)) if pos is None else np.column_stack(
            [-pos[:, 0], -pos[:, 2], pos[:, 1]]).astype(np.float64)
        tri = _b64(m.get("triangles"), np.int32, 1)
        self.tris = np.zeros(0, dtype=np.int64) if tri is None else tri.astype(np.int64)
        col = _b64(m.get("colors"), np.float32, 4)
        if col is not None and len(col) != len(self.world):
            raise pr.RuleError(f"{self.name}: {len(col)} colours for {len(self.world)} vertices")
        self.original = None if col is None else col.astype(np.float64)
        self.colours = None if col is None else self.original.copy()
        self._border = None

    @property
    def box(self):
        if not len(self.world):
            return None
        lo, hi = self.world.min(axis=0), self.world.max(axis=0)
        return float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1])

    def border(self):
        if self._border is None:
            nt = len(self.tris) // 3
            self._border = pr.boundary_points(self.world, self.tris[:nt * 3], np.arange(nt) * 3, np.full(nt, 3))
        return self._border

    def changed(self):
        if self.colours is None:
            return False
        if self.original is None:
            return True
        return bool((np.abs(self.colours - self.original) > 0.5 / 255.0).any())


def _load(rule, folder, source, cache):
    """(parsed, problem) of the rule's export file (shape_paintop._input's meaning): problem None = read or reads
    none, "" = no file (nothing to paint), else what is wrong."""
    what = "creek" if rule["kind"] == "object" and rule.get("creek") else rule["kind"]
    if what not in ("road", "creek", "lakebed"):
        return None, None
    path = pr.rule_file(rule, folder, source) if folder else None
    if path is None or not os.path.isfile(path):
        why = f"{rule['id']}: no {pr.FILE_SUFFIX[what]} export ({path or 'no course prefix'}): nothing painted"
        return None, why if what == "creek" else ""
    key = (path, what, rule.get("creek"))
    if key not in cache:
        if what == "road":
            cache[key] = pr.road_samples(pr.load_roads(path))
        elif what == "creek":
            cache[key] = pr.load_creek(path, rule["creek"])
        else:
            cache[key] = pr.load_lake_plane(path)
    parsed = cache[key]
    if what == "creek" and parsed is None:
        return None, f"{rule['id']}: creek {rule['creek']} is not in {os.path.basename(path)} (export creeks first)"
    return parsed, None


def _targets(rule, meshes, parsed, frame):
    """The meshes the op paints (shape_paintop.plan_paint's choice), each with what its weights need."""
    kind = rule["kind"]
    course = [m for m in meshes if pr.is_course_mesh(m.name) and len(m.world)]
    if kind == "object":
        return [(m, None) for m in course if rule["match"] in m.name]
    if kind == "road":
        if not len(parsed):
            return []
        reach = pr.road_reach(parsed, rule)
        out = []
        for m in course:
            b = m.box
            if pr.classify(m.name) in rule["surfaces"] and ((parsed[:, 0] >= b[0] - reach) & (parsed[:, 0] <= b[2] + reach)
                                                           & (parsed[:, 1] >= b[1] - reach) & (parsed[:, 1] <= b[3] + reach)).any():
                out.append((m, None))
        return out
    if kind == "edge":
        blends = [m for m in course if pr.BUNKER_BLEND in m.name]
        out = []
        for m in course:
            if pr.classify(m.name) not in rule["surfaces"]:
                continue
            near = [b for b in blends if b is not m and _box_gap(m.box, b.box) <= rule["widthM"]]
            if near:
                out.append((m, np.concatenate([b.border() for b in near])))
        return out
    if kind == "lakebed":
        out = []
        for m in course:
            lo, hi = m.world.min(axis=0), m.world.max(axis=0)
            if pr.lake_mesh_selected(m.name, lo, hi, parsed, rule["match"]):
                out.append((m, None))
        return out
    geom = pr.stroke_geometry(rule, frame)
    box = pr.stroke_box(geom, rule)
    return [(m, geom) for m in course if pr.stroke_touches(m.name, rule) and _box_gap(m.box, box) <= 0.0]


def _weights(rule, mesh, parsed, extra):
    kind = rule["kind"]
    if kind == "object":
        line, left, right = parsed if parsed is not None else (None, float("nan"), float("nan"))
        return pr.object_weights(mesh.world, mesh.border(), rule, line, left, right)
    if kind == "road":
        return pr.road_weights(mesh.world[:, :2], parsed, rule)
    if kind == "edge":
        return pr.edge_weights(mesh.world[:, :2], extra, rule)
    if kind == "lakebed":
        return pr.lakebed_weights(mesh.world, parsed, rule)
    return pr.stroke_weights(mesh.world[:, :2], extra, rule)


def paint_op(op, meshes, folder, frame, cache, warnings):
    """One op on every mesh it reaches: their colours painted in place."""
    rule = pr.normalise(op["rule"], op.get("id") or "op")
    parsed, problem = _load(rule, folder, op.get("source"), cache)
    if problem is not None:
        if problem:
            warnings.append(problem)
        return
    lake = rule["kind"] == "lakebed"
    for mesh, extra in _targets(rule, meshes, parsed, frame):
        w = _weights(rule, mesh, parsed, extra)
        min_w = 0.0 if lake else pr.MIN_WEIGHT
        if mesh.colours is None:
            if not (w > min_w).any():
                continue
            mesh.colours = np.tile(np.array(pr.LAKE_DEFAULT_COLOUR if lake else pr.DEFAULT_COLOUR), (len(mesh.world), 1))
        mesh.colours = _quantise(pr.apply_channel(mesh.colours, w, rule["channel"], rule.get("mode", "replace"), min_w))


def preview(doc):
    """The preview of an input document (see the header): the output document."""
    folder = doc.get("folder") or None
    if "ops" in doc:
        ops = doc["ops"]
    elif "paint" in doc:
        ops = _layer_ops(doc["paint"])
    else:
        raise pr.RuleError("input needs paint (a paint.json document) or ops")
    for op in ops:   # every op is checked, whether or not a mesh came with it
        pr.normalise(op.get("rule"), op.get("id") or "op")
    if doc.get("only") is not None:   # paint only these op ids (the base colours carry the rest already)
        only = set(doc["only"])
        ops = [op for op in ops if op.get("id") in only]
    meshes = [Mesh(m) for m in doc.get("meshes") or []]
    frame = doc.get("frame")
    if frame is None and meshes and any((op.get("rule") or {}).get("kind") == "stroke" for op in ops):
        if not folder:
            raise pr.RuleError("a stroke needs the course frame: give folder (with the inner DEM sidecar) or frame")
        frame = shape_coords.load_frame(shape_coords.find_sidecar(folder))
    warnings, cache = [], {}
    if meshes:
        for op in ops:
            paint_op(op, meshes, folder, frame, cache, warnings)
    objects = [{"object": m.name, "colors": _enc(m.colours)} for m in meshes if m.changed()]
    return {"objects": objects, "unchanged": [m.name for m in meshes if not m.changed()], "changed": len(objects),
            "ops": len(ops), "warnings": warnings}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--in", dest="inp", help="input JSON file (default stdin)")
    p.add_argument("--out", help="output JSON file (default stdout)")
    args = p.parse_args(argv)
    try:
        if args.inp:
            with open(args.inp, encoding="utf-8") as f:
                doc = json.load(f)
        else:
            doc = json.load(sys.stdin)
        out = preview(doc)
    except (pr.RuleError, ValueError, KeyError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    text = json.dumps(out)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
