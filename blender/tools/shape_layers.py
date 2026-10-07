"""Shaping layers: load/validate `golfmap-shaping-layer-v1` files, map OPCD objects to golf-map features.

Pure Python (no bpy, no numpy) so it is unit-tested with plain Python (`shape_layers_test.py`) and used
by `shape_apply.py` inside Blender. See blender/SHAPING-PLAN.md for the format and the loop.

- Layers: `NN-<id>.json` in a folder, applied in file-name order; each holds ordered `ops`.
- Selectors resolve through the SVG that built the .blend: its `<path id>` is the OPCD shape id
  (objects carry `opcd_shape_id` / `opcd_parent_id` / `opcd_kind`; split pieces add suffixes such as
  `_piece2`, `_hole0`, `_0`), `data-feature-id` the golf-map feature id(s) (merged roads list several,
  space-separated), `data-type` the golf-map type, `data-surface` (a grass track only; a hard road is one
  shape of every surface, its surfaces in the `-paths.json` sidecar); the hole is in the id (`hole_<n>_...`) or the Inkscape
  layer (`Hole<n>`). `shape` selects by SVG path id (a merged road's `roads_<n>`: every object built from it).
- Seeds: an op's `seed`, else the feature's number (`data-feature-no` on the path, or the hex suffix of a
  `hole_<n>_<hex>` name when the SVG uses feature-number names), else a stable hash of the feature id
  (old index names `hole_<n>_<i>` renumber when features change, so they cannot seed).
"""

import json
import math
import os
import re
import zlib

FORMAT = "golfmap-shaping-layer-v1"
LAYER_FILE = re.compile(r"^\d\d-[\w.-]+\.json$")
KINDS = ("mesh", "blend", "any")
SELECT_KEYS = {"feature", "type", "hole", "kind", "object", "shape"}
LEVELS = ("median", "mean", "min", "plane")

# Per op: the scene.opcdtools props an op may set (name -> python type), plus op-level keys.
OPS = {
    "afrod.flattentees": {
        "params": {"tees_flat_inset": int, "tees_flat_outset": float},
        "keys": {"focus"},
    },
    "afrod.cutcartpaths": {
        "params": {"cart_cut_steps": int, "cart_angle_tolerance": float, "cart_max_distance": float,
                   "cart_preferred_distance": float, "cart_min_distance": float},
        "keys": {"weld", "cutPaint", "pathSurfaces", "sliverM"},
    },
    "golfmap.weld_tjunctions": {"params": {}, "keys": {"toleranceM"}},
    "afrod.smoothcartpaths": {
        "params": {"smooth_path_distance": float, "smooth_path_amt": int},
        "keys": set(),
    },
    "afrod.recipe": {"params": {}, "keys": {"recipe", "overrides"}, "required": {"recipe"}},
    # Cuts a mixed-surface road shape's meshes along the seams of the sidecar <svg stem>-paths.json and separates
    # one object per surface (shape_apply "golfmap.split_surfaces", geometry in shape_surfaces.py).
    "golfmap.split_surfaces": {
        "params": {},
        "keys": {"paths", "fadeM", "minPartM2", "junctionTie", "slitM", "sliverM", "weld"},
    },
    # Widens the fringe strips of gravel / dirt paths into the path and paints them as a noisy red (grass) to
    # green (path) ramp (shape_apply "golfmap.path_edge_fade", maths in shape_edgefade.py). After split_surfaces.
    "golfmap.path_edge_fade": {
        "params": {},
        "keys": {"widthM", "maxEdgeM", "amplitude", "surfaces", "weld", "paths"},
    },
    "golfmap.flatten_footprint": {
        "params": {},
        "keys": {"footprint3006", "level", "falloffM", "offsetM", "protect", "protectBandM"},
        "required": {"footprint3006"},
        "noSelect": True,
    },
}
# Provenance keys a generator may add (gspro.py shaping-global: the feature or terrain edit behind an op).
OP_KEYS = {"id", "op", "select", "params", "seed", "note", "enabled", "featureId", "origin", "originRef", "maxDzWarnM"}
# golfmap.flatten_footprint never moves these types (and their blends); see footprint_moves.
DEFAULT_PROTECT = ("green", "bunker", "water", "water_creek", "water_lake", "lake", "creek")
DEFAULT_MAX_DZ_WARN_M = 0.5

# Commands WM_OT_readoperations (Afrod's JSON recipe runner) understands.
RECIPE_COMMANDS = {
    "bunkeredit", "bunkereditlip", "bunkereditangle", "widenbunkerinterior", "flattenbunker", "addpotwall",
    "smoothmesh", "subdividemesh", "zshiftmesh", "fillvertexpaint", "randomvertexpaintloop", "growcolor",
    "slopevertexpaint", "changecolors", "swapcolors", "randomslideloop", "straightenloops", "spaceloops",
    "loopcut", "meshblendjoin", "meshblendseparate", "meshblendjoinpermanent", "separatemesh",
    "invertselection", "addblendinset", "renamematerial", "zshiftloop",
}


class LayerError(ValueError):
    pass


# ---------------------------------------------------------------- layers

def layer_files(folder):
    """`NN-*.json` in the folder, in name order (other files, e.g. README or hand/, are ignored)."""
    return [os.path.join(folder, f) for f in sorted(os.listdir(folder)) if LAYER_FILE.match(f)]


def load_layers(folder):
    """[(path, layer)] in apply order. Raises LayerError listing every problem found."""
    if not os.path.isdir(folder):
        raise LayerError(f"no layer folder {folder}")
    layers, errors = [], []
    for path in layer_files(folder):
        try:
            with open(path, encoding="utf-8") as f:
                layer = json.load(f)
        except (OSError, ValueError) as e:
            errors.append(f"{os.path.basename(path)}: {e}")
            continue
        errors += [f"{os.path.basename(path)}: {m}" for m in validate_layer(layer)]
        layers.append((path, layer))
    seen = {}
    for path, layer in layers:
        for op in layer.get("ops") or []:
            key = (layer.get("id"), op.get("id")) if isinstance(op, dict) else None
            if key and key in seen:
                errors.append(f"{os.path.basename(path)}: op id {op.get('id')!r} repeats in layer {layer.get('id')!r}")
            seen[key] = path
    ids = [layer.get("id") for _, layer in layers]
    for i in sorted({i for i in ids if ids.count(i) > 1 and i}):
        errors.append(f"layer id {i!r} used by more than one file")
    if errors:
        raise LayerError("invalid shaping layers:\n  " + "\n  ".join(errors))
    return layers


def validate_layer(layer):
    """List of problems in one layer (empty when valid)."""
    if not isinstance(layer, dict):
        return ["root must be an object"]
    errors = []
    if layer.get("format") != FORMAT:
        errors.append(f"format must be {FORMAT!r}")
    if not isinstance(layer.get("id"), str) or not layer.get("id"):
        errors.append("id must be a non-empty string")
    ops = layer.get("ops")
    if not isinstance(ops, list):
        return errors + ["ops must be a list"]
    for i, op in enumerate(ops):
        errors += [f"ops[{i}]: {m}" for m in validate_op(op)]
    return errors


def validate_op(op):
    if not isinstance(op, dict):
        return ["must be an object"]
    errors = []
    name = op.get("op")
    spec = OPS.get(name)
    if not isinstance(op.get("id"), str) or not op.get("id"):
        errors.append("id must be a non-empty string")
    if spec is None:
        return errors + [f"unknown op {name!r} (known: {', '.join(sorted(OPS))})"]
    allowed = OP_KEYS | spec["keys"]
    errors += [f"unknown key {k!r}" for k in sorted(set(op) - allowed)]
    errors += [f"missing {k!r}" for k in sorted(spec.get("required", set()) - set(op))]
    if "seed" in op and (not isinstance(op["seed"], int) or isinstance(op["seed"], bool)):
        errors.append("seed must be an integer")
    if "enabled" in op and not isinstance(op["enabled"], bool):
        errors.append("enabled must be true/false")
    params = op.get("params", {})
    if not isinstance(params, dict):
        errors.append("params must be an object")
        params = {}
    for k, v in params.items():
        want = spec["params"].get(k)
        if want is None:
            errors.append(f"unknown param {k!r} for {name} (known: {', '.join(sorted(spec['params'])) or 'none'})")
        elif not _is_type(v, want):
            errors.append(f"param {k!r} must be {want.__name__}")
    select = op.get("select")
    if spec.get("noSelect"):
        if select is not None:
            errors.append(f"{name} takes no select (it works on every Spline mesh under the footprint)")
    elif not isinstance(select, dict) or not select:
        errors.append("select must be a non-empty object")
    else:
        errors += validate_select(select)
    if name == "afrod.recipe":
        if not (isinstance(op.get("recipe"), str) and op["recipe"].strip()):
            errors.append("recipe must be a .json path or a recipe library id")
        ov = op.get("overrides", {})
        if not isinstance(ov, dict) or not all(
                isinstance(k, str) and k and (_is_scalar(v) or (isinstance(v, list) and v and all(_is_type(c, float) for c in v)))
                for k, v in ov.items()):
            errors.append("overrides must be an object of scene.opcdtools prop -> number/bool/string (or list of numbers)")
    if name == "golfmap.flatten_footprint":
        fp = op.get("footprint3006")
        if not (isinstance(fp, list) and len(fp) >= 3 and all(
                isinstance(p, list) and len(p) == 2 and all(_is_type(c, float) for c in p) for p in fp)):
            errors.append("footprint3006 must be a list of >= 3 [E, N] pairs")
        if op.get("level", "median") not in LEVELS:
            errors.append(f"level must be one of {', '.join(LEVELS)}")
        for k in ("falloffM", "offsetM"):
            if k in op and not _is_type(op[k], float):
                errors.append(f"{k} must be a number")
        if _is_type(op.get("falloffM", 0.0), float) and op.get("falloffM", 0.0) < 0:
            errors.append("falloffM must be >= 0")
        pr = op.get("protect", [])
        if not (isinstance(pr, list) and all(isinstance(t, str) for t in pr)):
            errors.append("protect must be a list of golf-map types")
        if "protectBandM" in op and not (_is_type(op["protectBandM"], float) and op["protectBandM"] > 0):
            errors.append("protectBandM must be a number > 0")
    if name == "golfmap.split_surfaces":
        for k, lo in (("fadeM", 0.0), ("minPartM2", 0.0), ("sliverM", 0.0), ("slitM", 0.0)):
            if k in op and not (_is_type(op[k], float) and op[k] >= lo):
                errors.append(f"{k} must be a number >= {lo:g}")
        if "junctionTie" in op and not (_is_type(op["junctionTie"], float) and 0 <= op["junctionTie"] < 1):
            errors.append("junctionTie must be a number in [0, 1)")
        if "paths" in op and not (isinstance(op["paths"], str) and op["paths"]):
            errors.append("paths must be a sidecar file name or path")
        if "weld" in op and not isinstance(op["weld"], bool):
            errors.append("weld must be true/false")
    if name == "golfmap.path_edge_fade":
        import sys
        here = os.path.dirname(os.path.abspath(__file__))
        if here not in sys.path:
            sys.path.insert(0, here)
        import shape_edgefade
        errors += shape_edgefade.validate_params(op)
        if "paths" in op and not (isinstance(op["paths"], str) and op["paths"]):
            errors.append("paths must be a sidecar file name or path")
    if name == "golfmap.weld_tjunctions" and "toleranceM" in op and not (_is_type(op["toleranceM"], float) and op["toleranceM"] > 0):
        errors.append("toleranceM must be a number > 0")
    if name == "afrod.cutcartpaths" and "weld" in op and not isinstance(op["weld"], bool):
        errors.append("weld must be true/false")
    if name == "afrod.cutcartpaths" and "sliverM" in op and not (_is_type(op["sliverM"], float) and op["sliverM"] >= 0):
        errors.append("sliverM must be a number >= 0")
    if name == "afrod.cutcartpaths" and op.get("cutPaint", "auto") not in ("auto", "restore", "keep"):
        errors.append("cutPaint must be auto, restore or keep")
    if name == "afrod.cutcartpaths" and "pathSurfaces" in op and not (
            isinstance(op["pathSurfaces"], dict) and all(isinstance(k, str) and (v is None or isinstance(v, str))
                                                         for k, v in op["pathSurfaces"].items())):
        errors.append("pathSurfaces must be an object of feature id -> surface (string or null)")
    if "maxDzWarnM" in op and not (_is_type(op["maxDzWarnM"], float) and op["maxDzWarnM"] > 0):
        errors.append("maxDzWarnM must be a number > 0")
    return errors


def validate_select(select):
    errors = [f"unknown select key {k!r}" for k in sorted(set(select) - SELECT_KEYS)]
    for key in ("feature", "type", "object", "shape"):
        if key in select:
            v = select[key]
            if not (isinstance(v, str) and v) and not (isinstance(v, list) and v and all(isinstance(s, str) and s for s in v)):
                errors.append(f"select.{key} must be a string or a list of strings")
    if "hole" in select:
        v = select["hole"]
        vals = v if isinstance(v, list) else [v]
        if not vals or not all(isinstance(h, int) and not isinstance(h, bool) for h in vals):
            errors.append("select.hole must be an integer or a list of integers")
    if select.get("kind", "mesh") not in KINDS:
        errors.append(f"select.kind must be one of {', '.join(KINDS)}")
    if not set(select) & {"feature", "type", "hole", "object", "shape"}:
        errors.append("select needs feature, type, hole, object or shape")
    return errors


def validate_recipe(data):
    """Problems in an Afrod recipe (list of single-command objects) - WM_OT_readoperations' format."""
    if not isinstance(data, list):
        return ["recipe root must be a list"]
    errors = []
    for i, item in enumerate(data):
        if not isinstance(item, dict) or len(item) != 1:
            errors.append(f"[{i}] must be an object with one command")
            continue
        (cmd, args), = item.items()
        if cmd not in RECIPE_COMMANDS:
            errors.append(f"[{i}] unknown command {cmd!r} (Afrod skips it)")
        elif not isinstance(args, dict):
            errors.append(f"[{i}] {cmd}: arguments must be an object")
    return errors


def _is_scalar(v):
    return isinstance(v, (bool, str)) or _is_type(v, float)


def _is_type(v, want):
    if isinstance(v, bool):
        return want is bool
    if want is float:
        return isinstance(v, (int, float)) and math.isfinite(v)
    return isinstance(v, want)


# ---------------------------------------------------------------- SVG

_TAG = re.compile(r"<(/?)(g|path)\b([^>]*?)(/?)>", re.S)
_ATTR = re.compile(r"([\w:.-]+)\s*=\s*\"([^\"]*)\"")
_HOLE_ID = re.compile(r"^hole_(\d+)_")
_HOLE_LAYER = re.compile(r"^Hole\s*(\d+)$")


def parse_svg(text):
    """{path id: {id, type, surface, featureIds, hole, layer, featureNo, points, bbox}} of every <path> with an
    id (`surface` = its `data-surface`, None when absent)."""
    paths = {}
    stack = []
    for m in _TAG.finditer(text):
        closing, tag, attrs, selfclose = m.groups()
        if tag == "g":
            if closing:
                if stack:
                    stack.pop()
            elif not selfclose:
                a = dict(_ATTR.findall(attrs))
                stack.append(a.get("inkscape:label") or a.get("id"))
            continue
        if closing:
            continue
        a = dict(_ATTR.findall(attrs))
        pid = a.get("id")
        if not pid:
            continue
        layer = next((s for s in reversed(stack) if s), None)
        hole = None
        hm = _HOLE_ID.match(pid)
        if hm:
            hole = int(hm.group(1))
        elif layer and _HOLE_LAYER.match(layer):
            hole = int(_HOLE_LAYER.match(layer).group(1))
        pts = path_points(a.get("d", ""))
        no = a.get("data-feature-no")
        paths[pid] = {
            "id": pid,
            "type": a.get("data-type"),
            "surface": a.get("data-surface") or None,
            "featureIds": (a.get("data-feature-id") or "").split(),
            "hole": hole,
            "layer": layer,
            "featureNo": int(no) if no and no.isdigit() else None,
            "points": pts,
            "bbox": _bbox(pts),
        }
    return paths


def cut_paint_decision(op, svg_path, db_surfaces):
    """{mode: restore|keep, surfaces, source} for one path unit of an `afrod.cutcartpaths` op (what
    shape_apply.cut_paint_mode returns; pure so it is tested here). `svg_path` = the unit's parsed SVG
    path ({} when unknown), `db_surfaces(feature ids)` = {id: surface or None} from the app database.
    An explicit `cutPaint` wins; else `auto` reads the surface: the SVG's own `data-surface` (a grass
    track; a hard road has none), else the op's `pathSurfaces` {feature id: surface}, else the database. keep =
    every surface concrete (OPCD's joint texture), anything else or unknown = restore."""
    want = op.get("cutPaint", "auto")
    if want in ("restore", "keep"):
        return {"mode": want, "source": "op", "surfaces": None}
    fids = list((svg_path or {}).get("featureIds") or [])
    own = (svg_path or {}).get("surface")
    given = op.get("pathSurfaces") or {}
    if own:
        surfaces, source = {f: own for f in fids} if fids else {(svg_path or {}).get("id") or "": own}, "svg"
    elif fids and all(f in given for f in fids):
        surfaces, source = {f: given[f] for f in fids}, "op"
    else:
        surfaces, source = (db_surfaces(fids), "db") if fids else ({}, "none")
    known = [v for v in surfaces.values() if v]
    mode = "keep" if known and len(known) == len(surfaces) and all(v == "concrete" for v in known) else "restore"
    return {"mode": mode, "source": source, "surfaces": surfaces}


def load_svg(path):
    with open(path, encoding="utf-8") as f:
        return parse_svg(f.read())


_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_PATH_TOKEN = re.compile(r"([MmLlHhVvCcSsQqTtAaZz])|(" + _NUM + ")")
_ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def path_points(d):
    """On-curve points (segment end points) of an SVG path, absolute user units."""
    tokens = _PATH_TOKEN.findall(d or "")
    pts, i, cmd = [], 0, None
    x = y = sx = sy = 0.0
    nums = []

    def flush(c, args):
        nonlocal x, y, sx, sy
        up, rel = c.upper(), c.islower()
        if up == "Z":
            x, y = sx, sy
            return
        if up == "H":
            x = x + args[0] if rel else args[0]
        elif up == "V":
            y = y + args[0] if rel else args[0]
        else:
            ex, ey = args[-2], args[-1]
            x, y = (x + ex, y + ey) if rel else (ex, ey)
        if up == "M":
            sx, sy = x, y
        pts.append((x, y))

    while i < len(tokens):
        c, num = tokens[i]
        if c:
            cmd = c
            nums = []
            if c.upper() == "Z":
                flush(c, [])
            i += 1
            continue
        nums.append(float(num))
        i += 1
        n = _ARGS.get((cmd or "M").upper(), 2)
        if n and len(nums) == n:
            flush(cmd, nums)
            nums = []
            if cmd == "M":
                cmd = "L"
            elif cmd == "m":
                cmd = "l"
    return pts


def _bbox(pts):
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def resolve_shape(shape_id, svg_ids):
    """The SVG path id an OPCD shape id comes from: the longest id equal to it or followed by `_...`."""
    if not shape_id:
        return None
    if shape_id in svg_ids:
        return shape_id
    parts = shape_id.split("_")
    for n in range(len(parts) - 1, 0, -1):
        cand = "_".join(parts[:n])
        if cand in svg_ids:
            return cand
    return None


def score_svg(svg_paths, shape_ids):
    """How well an SVG explains a .blend's shape ids: (resolved, -unused svg ids)."""
    ids = set(svg_paths)
    used = set()
    resolved = 0
    for s in shape_ids:
        r = resolve_shape(s, ids)
        if r:
            resolved += 1
            used.add(r)
    return {"resolved": resolved, "shapes": len(shape_ids), "unused": sorted(ids - used)}


def choose_svg(candidates, shape_ids):
    """candidates: {path: svg_paths}. Best first: most shape ids resolved, fewest unused SVG paths,
    newest file. Returns [(path, score)]."""
    ranked = []
    for path, paths in candidates.items():
        sc = score_svg(paths, shape_ids)
        mtime = os.path.getmtime(path) if os.path.exists(path) else 0
        ranked.append((path, sc, mtime))
    ranked.sort(key=lambda t: (-t[1]["resolved"], len(t[1]["unused"]), -t[2], t[0]))
    return [(p, s) for p, s, _ in ranked]


def naming_scheme(svg_ids):
    """'index' when every stem (hole_<n>, others, roads) is numbered 1..k (old OPCD-export names that
    renumber), else 'feature-no' (hole_<n>_<feature number in hex>)."""
    groups = {}
    for pid in svg_ids:
        m = re.match(r"^(.*)_([0-9a-f]+)$", pid)
        if not m:
            continue
        groups.setdefault(m.group(1), []).append(m.group(2))
    if not groups:
        return "index"
    for suffixes in groups.values():
        if not all(s.isdigit() for s in suffixes):
            return "feature-no"
        if sorted(int(s) for s in suffixes) != list(range(1, len(suffixes) + 1)):
            return "feature-no"
    return "index"


def stable_seed(text):
    """A seed from a string that is the same on every run and machine."""
    return zlib.crc32(text.encode("utf-8")) & 0x7FFFFFFF


def feature_seed(svg_path, scheme):
    """Default seed of the feature(s) behind one SVG path."""
    if svg_path.get("featureNo") is not None:
        return svg_path["featureNo"]
    if scheme == "feature-no":
        m = re.match(r"^(?:hole_\d+|others|roads)_([0-9a-f]+)$", svg_path["id"])
        if m:
            return int(m.group(1), 16)
    return stable_seed(" ".join(sorted(svg_path["featureIds"])) or svg_path["id"])


# ---------------------------------------------------------------- object index

def build_index(objects, svg_paths):
    """objects: [{name, shapeId, parentId, kind}] (Spline meshes). Adds svgId, type, featureIds, hole."""
    ids = set(svg_paths)
    out = []
    for o in objects:
        sid = resolve_shape(o.get("parentId"), ids) or resolve_shape(o.get("shapeId"), ids)
        p = svg_paths.get(sid) if sid else None
        out.append(dict(o, svgId=sid, type=p["type"] if p else None,
                        featureIds=list(p["featureIds"]) if p else [], hole=p["hole"] if p else None))
    return out


def _as_list(v):
    return v if isinstance(v, list) else [v]


def select(selector, index):
    """Objects matching a selector (all given keys must match). Returns (records, problems)."""
    kind = selector.get("kind", "mesh")
    recs = [r for r in index if kind == "any" or r.get("kind") == kind]
    problems = []
    if "object" in selector:
        names = set(_as_list(selector["object"]))
        recs = [r for r in recs if r["name"] in names]
        missing = names - {r["name"] for r in recs}
        problems += [f"object {n!r} not found" for n in sorted(missing)]
    if "feature" in selector:
        feats = _as_list(selector["feature"])
        found = set()
        keep = []
        for r in recs:
            hit = [f for f in feats if f in r["featureIds"]]
            if hit:
                found.update(hit)
                keep.append(r)
        recs = keep
        known = {f for r in index for f in r["featureIds"]}
        for f in feats:
            if f not in found:
                problems.append(f"feature {f} " + ("has no " + kind + " object" if f in known else "is in no SVG path of this .blend"))
    if "shape" in selector:  # SVG path ids (a merged road's `roads_<n>`): every object OPCD built from them
        shapes = set(_as_list(selector["shape"]))
        recs = [r for r in recs if r.get("svgId") in shapes]
        problems += [f"shape {s!r} has no {kind} object" for s in sorted(shapes - {r.get('svgId') for r in recs})]
    if "type" in selector:
        types = set(_as_list(selector["type"]))
        recs = [r for r in recs if r["type"] in types]
    if "hole" in selector:
        holes = set(_as_list(selector["hole"]))
        recs = [r for r in recs if r["hole"] in holes]
    if not recs and not problems:
        problems.append("selector matched no objects")
    return sorted(recs, key=lambda r: r["name"]), problems


def group_by_feature(records):
    """[(svgId, [records])] in svgId order: one group per SVG path (a feature, or a merged road)."""
    groups = {}
    for r in records:
        groups.setdefault(r["svgId"] or r["name"], []).append(r)
    return sorted(groups.items())


# ---------------------------------------------------------------- geometry (footprints)

def point_in_polygon(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def distance_to_polygon(x, y, poly):
    """Distance from a point to the polygon's outline."""
    best = float("inf")
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L))
        px, py = ax + t * dx - x, ay + t * dy - y
        best = min(best, px * px + py * py)
    return math.sqrt(best)


def smooth_falloff(t):
    """Afrod's smooth_falloff: 1 at t=0 down to 0 at t=1 (smoothstep)."""
    return 1 - (3 * t * t - 2 * t * t * t) if 0 <= t <= 1 else 0.0


def fit_level(points, level):
    """A function (x, y) -> z for the vertices inside a footprint: median/mean/min height or a
    least-squares plane."""
    zs = sorted(p[2] for p in points)
    if not zs:
        raise ValueError("no vertices inside the footprint")
    if level == "median":
        n = len(zs)
        z = zs[n // 2] if n % 2 else 0.5 * (zs[n // 2 - 1] + zs[n // 2])
        return lambda x, y: z
    if level == "mean":
        z = sum(zs) / len(zs)
        return lambda x, y: z
    if level == "min":
        z = zs[0]
        return lambda x, y: z
    if level == "plane":
        if len(points) < 3:
            raise ValueError("a plane needs 3 or more vertices inside the footprint")
        cx = sum(p[0] for p in points) / len(points)
        cy = sum(p[1] for p in points) / len(points)
        # Normal equations for z = a (x-cx) + b (y-cy) + c.
        sxx = sxy = syy = sxz = syz = sz = 0.0
        for x, y, z in points:
            dx, dy = x - cx, y - cy
            sxx += dx * dx
            sxy += dx * dy
            syy += dy * dy
            sxz += dx * z
            syz += dy * z
            sz += z
        det = sxx * syy - sxy * sxy
        if abs(det) < 1e-12:
            a = b = 0.0
        else:
            a = (sxz * syy - syz * sxy) / det
            b = (syz * sxx - sxz * sxy) / det
        c = sz / len(points)
        return lambda x, y: a * (x - cx) + b * (y - cy) + c
    raise ValueError(f"unknown level {level!r}")


def footprint_moves(verts, poly, level="median", falloff=0.0, offset=0.0, guard=None, band=1.0):
    """verts: [(key, x, y, z)] in the polygon's frame. New z per key: inside -> the level (+offset),
    outside within `falloff` of the outline -> blended with Afrod's smooth falloff by XY distance.
    guard(x, y): XY distance to the nearest protected vertex (None: nothing protected); the weight is
    scaled by 1 - smooth_falloff(distance / band), so it reaches 0 at protected vertices (which are not
    in `verts`) and a seam with them never opens. A function of XY only, so coincident seam vertices of
    neighbouring meshes stay welded."""
    inside = [(k, x, y, z) for k, x, y, z in verts if point_in_polygon(x, y, poly)]
    f = fit_level([(x, y, z) for _, x, y, z in inside], level)
    moves = {}
    for k, x, y, z in verts:
        target = f(x, y) + offset
        if point_in_polygon(x, y, poly):
            w = 1.0
        elif falloff > 0:
            w = smooth_falloff(distance_to_polygon(x, y, poly) / falloff)
        else:
            w = 0.0
        if w > 0 and guard is not None:
            w *= 1.0 - smooth_falloff(min(guard(x, y) / band, 1.0))
        if w > 0:
            nz = z + (target - z) * w
            if nz != z:
                moves[k] = nz
    return moves, len(inside)


def nearest_hole(x, y, svg_paths):
    """(hole, distance) of the SVG path with a hole whose on-curve points come nearest (SVG units = m)."""
    best = (None, float("inf"))
    for p in svg_paths.values():
        if p.get("hole") is None or not p.get("points"):
            continue
        if bbox_distance((x, y, x, y), p["bbox"]) >= best[1]:
            continue
        d = min(math.hypot(px - x, py - y) for px, py in p["points"])
        if d < best[1]:
            best = (p["hole"], d)
    return best


def polygon_bbox(poly, pad=0.0):
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def bbox_distance(a, b):
    """Gap between two XY boxes (0 when they overlap)."""
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


# ---------------------------------------------------------------- recipes

def recipe_dirs(repo_root):
    """Where a relative recipe path is looked up: $GOLFMAP_AFROD_RECIPES (default D:/gspro/afrod-recipes),
    then blender/recipes."""
    return [os.environ.get("GOLFMAP_AFROD_RECIPES", "D:/gspro/afrod-recipes"), os.path.join(repo_root, "blender", "recipes")]


def library_file(recipe_id, repo_root):
    """The file of a recipe library id (blender/recipes/library.json `recipes[].id`), or None."""
    try:
        with open(os.path.join(repo_root, "blender", "recipes", "library.json"), encoding="utf-8") as f:
            lib = json.load(f)
    except (OSError, ValueError):
        return None
    for entry in lib.get("recipes", []) if isinstance(lib, dict) else []:
        if isinstance(entry, dict) and entry.get("id") == recipe_id:
            return entry.get("file")
    return None


def find_recipe(name, dirs, repo_root=None):
    """A recipe file: an absolute path, a path relative to one of `dirs`, or (with repo_root) a recipe library
    id whose `file` is found that way."""
    if os.path.isabs(name):
        return name if os.path.isfile(name) else None
    for d in dirs:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return os.path.normpath(p)
    if repo_root and not name.lower().endswith(".json"):
        f = library_file(name, repo_root)
        if f:
            return find_recipe(f, dirs)
    return None
