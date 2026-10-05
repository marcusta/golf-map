"""Shaping recipes: formats, steps, parameters (pure Python, no bpy).

blender/SHAPING-PLAN.md, "Composite and parameterised recipes". A recipe file is either

- an Afrod recipe: `[{"<command>": {args}}, ...]` (Afrod Mod v4's JSON runner format; every step is an Afrod
  command), or
- a golfmap recipe: `{"format": "golfmap-recipe-v1", "steps": [{"op": ..., "params": {...}, "tag"?: ...}, ...]}`
  whose steps come from any toolset:
    `bunkerstudio.shape`     Bunker Studio's preview -> validate -> apply on the feature's mesh + blends
    `shorelinestudio.shape`  Shoreline Studio's preview -> validate -> apply (lakes, creeks)
    `afrod.<command>`        one Afrod recipe command (params = its arguments, as in an Afrod file)
    `golfmap.paint_map`      remap the feature's current paint with a role map (`params.map: {mesh, blend}`)
    `golfmap.edge_jitter`    make the borders between differently painted rings ragged (seeded from the op's seed;
                             `amount`, `wavelengthM`, `grain`, `kinds`, `seed`: jitter_params; shape_paint.edge_jitter)
  A step may also carry `tag` (a name parameter maps can address), `ringsFromSeam: true` (Afrod steps on a joined
  bunker + blend: the ring insets are written for OPCD's one-quad blend, ring 1 = the seam; the engine adds the
  blend's real row count - 1, e.g. +3 after Bunker Studio's four-row blend) and `paint` (this step's colour ->
  golfmap role map, overriding the library's).

Studio steps rebuild the feature from OPCD's untouched mesh + one-quad blend ring, so they come first: a studio step
after an Afrod topology step (loop cut, join, separate, subdivide ...) is an error, and a recipe has at most one.

Library entries (blender/recipes/library.json) declare their knobs as `params`:
    {"id": "lipHeight", "label": "Lip height", "unit": "x", "min": 0.5, "max": 2, "step": 0.1, "default": 1,
     "maps": [{"step": "bunkereditlip", "field": "bunker_lip_depth", "mode": "scale"}]}
A map's `step` is a step op (`afrod.bunkereditlip`, `bunkerstudio.shape`), an Afrod command name
(`bunkereditlip`) or a step `tag`; every matching step gets `field` set to the value (`set`) or multiplied by it
(`scale`). A recipe op's `overrides` is `{<param id>: value, ..., "seed": int}`: missing params take their default,
`seed` replaces the op's seed. Tests: `python blender/tools/shape_recipes_test.py`.
"""

import copy
import json
import math

FORMAT = "golfmap-recipe-v1"
AFROD = "afrod"

# Commands Afrod's JSON runner (WM_OT_readoperations) understands (shape_layers.RECIPE_COMMANDS mirrors it).
AFROD_COMMANDS = {
    "bunkeredit", "bunkereditlip", "bunkereditangle", "widenbunkerinterior", "flattenbunker", "addpotwall",
    "smoothmesh", "subdividemesh", "zshiftmesh", "fillvertexpaint", "randomvertexpaintloop", "growcolor",
    "slopevertexpaint", "changecolors", "swapcolors", "randomslideloop", "straightenloops", "spaceloops",
    "loopcut", "meshblendjoin", "meshblendseparate", "meshblendjoinpermanent", "separatemesh",
    "invertselection", "addblendinset", "renamematerial", "zshiftloop",
}
# Afrod commands that change topology or the mesh/blend split: a studio step must come before all of them.
AFROD_TOPOLOGY = {
    "loopcut", "subdividemesh", "meshblendjoin", "meshblendseparate", "meshblendjoinpermanent", "separatemesh",
    "addblendinset", "addpotwall", "invertselection",
}
# Afrod step arguments that name a paint colour (translated through the step's paint map).
COLOR_KEYS = ("vertex_paint_type", "vertex_paint_type_to", "vertex_paint_type_from")
# Afrod step arguments that count rings in from the object's open boundary (shifted by ringsFromSeam).
INSET_KEYS = ("loopcut_inset", "loopslide_inset", "bunker_dig_inset", "paint_loop_inset", "smooth_interior_inset", "inset")
PAINT_COLOURS = ("red", "green", "blue", "black")

BUNKER_PRESETS = ("CLASSIC", "PARKLAND", "FLASHED", "NATURAL", "LINKS", "POT")
SHORELINE_PRESETS = {
    "PARKLAND_SHELF": "LAKE", "NATURAL_POND": "LAKE", "COVE_POINT": "LAKE", "DEEP_WATER": "LAKE",
    "MAINTAINED_DRAIN": "CREEK", "MEADOW_BROOK": "CREEK", "ESTATE_STREAM": "CREEK", "POOL_RIFFLE": "CREEK",
    "ROCKY_RUNNEL": "CREEK", "ERODED_GULLY": "CREEK",
}
# Studio step fields: name -> (default, min, max); None = no default (the preset's own value).
STUDIO_FIELDS = {
    "bunkerstudio.shape": {
        "preset": ("CLASSIC", None, None),
        "depth": (None, 0.05, 2.0),            # m (Bunker Studio floor_depth; default: the preset's 0.45)
        "edgeVariation": (50.0, 0.0, 100.0),   # %
        "edgeDirt": (35.0, 0.0, 100.0),        # %
        "highSide": ("green", None, None),     # "green" (toward the hole's green), "auto" (Bunker Studio's) or a bearing
        "highSpan": (None, 0.02, 1.0),         # fraction of the rim the high side covers (default: Bunker Studio's 0.35)
        "highSideStrength": (1.0, 0.0, 3.0),   # x the preset's high crown raise and high-face tightening
        "faceSteepness": (1.0, 0.25, 4.0),     # x: face widths divided by it (steeper faces)
    },
    "shorelinestudio.shape": {
        "preset": (None, None, None),
        "depth": (None, 0.01, 10.0),           # m (maximum_depth; default: the preset's)
        "bankSlope": (None, 1.0, 80.0),        # degrees (default: the preset's)
        "strength": (1.0, 0.0, 1.5),           # shape strength
    },
}
JITTER_DEFAULTS = {"amount": 0.5, "wavelengthM": 0.6, "grain": 0.5, "kinds": ["mesh"], "seed": 0}
GOLFMAP_STEPS = {"golfmap.paint_map": {"map"}, "golfmap.edge_jitter": set(JITTER_DEFAULTS)}
STEP_KEYS = {"op", "params", "tag", "ringsFromSeam", "paint", "note"}
MAP_MODES = ("set", "scale")


class RecipeError(ValueError):
    pass


def jitter_params(params):
    """golfmap.edge_jitter params with their defaults, checked (RecipeError). amount 0-1: at most this share of the
    neighbour ring's colour a vertex takes; wavelengthM: length of the coherent wobble along the edge; grain 0-1:
    share of per-vertex noise in it; kinds: mesh and/or blend; seed: added to the op's seed."""
    p = dict(JITTER_DEFAULTS, **(params or {}))
    extra = sorted(set(p) - set(JITTER_DEFAULTS))
    if extra:
        raise RecipeError(f"unknown param(s) {', '.join(extra)}")
    for k, lo, hi in (("amount", 0.0, 1.0), ("grain", 0.0, 1.0), ("wavelengthM", 0.01, 100.0)):
        if not isinstance(p[k], (int, float)) or isinstance(p[k], bool) or not lo <= p[k] <= hi:
            raise RecipeError(f"{k} must be a number in {lo}..{hi}")
    if not isinstance(p["kinds"], list) or not p["kinds"] or any(k not in ("mesh", "blend") for k in p["kinds"]):
        raise RecipeError("kinds must be a non-empty list of mesh, blend")
    if not isinstance(p["seed"], int) or isinstance(p["seed"], bool):
        raise RecipeError("seed must be an integer")
    return p


# ---------------------------------------------------------------- parsing

def parse_recipe(data):
    """{format, steps: [{op, params, tag?, ringsFromSeam?, paint?}], problems} of a recipe file's JSON."""
    if isinstance(data, list):
        steps, problems = [], []
        for i, item in enumerate(data):
            if not isinstance(item, dict) or len(item) != 1:
                problems.append(f"[{i}] must be an object with one command")
                continue
            (cmd, args), = item.items()
            if not isinstance(args, dict):
                problems.append(f"[{i}] {cmd}: arguments must be an object")
                args = {}
            steps.append({"op": AFROD + "." + str(cmd), "params": dict(args)})
        problems += validate_steps(steps)
        return {"format": AFROD, "steps": steps, "problems": problems}
    if isinstance(data, dict):
        if data.get("format") != FORMAT:
            return {"format": None, "steps": [], "problems": [f"format must be {FORMAT!r} (or an Afrod list of commands)"]}
        raw = data.get("steps")
        if not isinstance(raw, list) or not raw:
            return {"format": FORMAT, "steps": [], "problems": ["steps must be a non-empty list"]}
        steps, problems = [], []
        for i, s in enumerate(raw):
            if not isinstance(s, dict):
                problems.append(f"steps[{i}] must be an object")
                continue
            extra = sorted(set(s) - STEP_KEYS)
            if extra:
                problems.append(f"steps[{i}]: unknown key(s) {', '.join(extra)}")
            step = {"op": s.get("op"), "params": dict(s.get("params") or {}) if isinstance(s.get("params", {}), dict) else None}
            if step["params"] is None:
                problems.append(f"steps[{i}]: params must be an object")
                step["params"] = {}
            for k in ("tag", "ringsFromSeam", "paint", "note"):
                if k in s:
                    step[k] = s[k]
            steps.append(step)
        problems += validate_steps(steps)
        return {"format": FORMAT, "steps": steps, "problems": problems}
    return {"format": None, "steps": [], "problems": ["recipe root must be a list (Afrod) or an object (golfmap-recipe-v1)"]}


def load_recipe(path):
    with open(path, encoding="utf-8") as f:
        return parse_recipe(json.load(f))


def step_source(op):
    """'bunkerstudio', 'shorelinestudio', 'afrod' or 'golfmap'."""
    return str(op).split(".", 1)[0]


def is_studio(op):
    return op in STUDIO_FIELDS


def validate_steps(steps):
    problems = []
    tags = {}
    first_topology = None
    studios = []
    for i, s in enumerate(steps):
        op = s.get("op")
        where = f"steps[{i}] {op}"
        if not isinstance(op, str) or "." not in op:
            problems.append(f"steps[{i}]: op must be '<toolset>.<name>'")
            continue
        src, name = op.split(".", 1)
        params = s.get("params") or {}
        if src == AFROD:
            if name not in AFROD_COMMANDS:
                problems.append(f"{where}: unknown Afrod command {name!r}")
            elif name in AFROD_TOPOLOGY and first_topology is None:
                first_topology = i
            for k in COLOR_KEYS:
                if k in params and params[k] not in PAINT_COLOURS + ("white",):
                    problems.append(f"{where}: {k} must be one of {', '.join(PAINT_COLOURS)}")
        elif is_studio(op):
            studios.append(i)
            if first_topology is not None:
                problems.append(f"{where}: studio steps must come before any Afrod topology step "
                                f"(steps[{first_topology}] {steps[first_topology]['op']} changes the mesh they rebuild)")
            problems += [f"{where}: {m}" for m in validate_studio_params(op, params)]
        elif op in GOLFMAP_STEPS:
            extra = sorted(set(params) - GOLFMAP_STEPS[op])
            if extra:
                problems.append(f"{where}: unknown param(s) {', '.join(extra)}")
            if op == "golfmap.paint_map" and not isinstance(params.get("map"), dict):
                problems.append(f"{where}: params.map must be {{mesh: {{colour: role}}, blend: {{...}}}}")
            if op == "golfmap.edge_jitter" and not extra:
                try:
                    jitter_params(params)
                except RecipeError as e:
                    problems.append(f"{where}: {e}")
        else:
            problems.append(f"steps[{i}]: unknown op {op!r} (afrod.<command>, {', '.join(sorted(STUDIO_FIELDS))}, "
                            f"{', '.join(sorted(GOLFMAP_STEPS))})")
        if "tag" in s:
            if not isinstance(s["tag"], str) or not s["tag"] or "." in s["tag"]:
                problems.append(f"{where}: tag must be a non-empty name without dots")
            elif s["tag"] in tags:
                problems.append(f"{where}: tag {s['tag']!r} repeats (steps[{tags[s['tag']]}])")
            else:
                tags[s["tag"]] = i
        if "ringsFromSeam" in s and (not isinstance(s["ringsFromSeam"], bool) or src != AFROD):
            problems.append(f"{where}: ringsFromSeam is true/false on Afrod steps")
        if "paint" in s and not isinstance(s["paint"], dict):
            problems.append(f"{where}: paint must be {{mesh: {{colour: role}}, blend: {{...}}}}")
    if len(studios) > 1:
        problems.append(f"at most one studio step per recipe (steps {studios})")
    jitter = [i for i, s in enumerate(steps) if s.get("op") == "golfmap.edge_jitter"]
    if jitter and any(steps[i].get("op") != "golfmap.edge_jitter" for i in range(jitter[0], len(steps))):
        problems.append(f"steps[{jitter[0]}] golfmap.edge_jitter: edge_jitter steps come last (they run once the "
                        "feature's objects have their names back)")
    return problems


def validate_studio_params(op, params):
    fields = STUDIO_FIELDS[op]
    out = [f"unknown field {k!r} (known: {', '.join(sorted(fields))})" for k in sorted(set(params) - set(fields))]
    for k, v in params.items():
        if k not in fields:
            continue
        _, lo, hi = fields[k]
        if k == "preset":
            allowed = BUNKER_PRESETS if op == "bunkerstudio.shape" else tuple(SHORELINE_PRESETS)
            if v not in allowed:
                out.append(f"preset must be one of {', '.join(allowed)}")
        elif k == "highSide":
            if not (v in ("green", "auto") or _num(v)):
                out.append("highSide must be 'green', 'auto' or a compass bearing in degrees")
        elif not _num(v):
            out.append(f"{k} must be a number")
        elif lo is not None and not lo <= v <= hi:
            out.append(f"{k} must be within {lo}..{hi} (got {v})")
    if op == "shorelinestudio.shape" and "preset" not in params:
        out.append("preset is required (a Shoreline Studio preset id)")
    return out


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def afrod_items(steps):
    """The Afrod runner's JSON items for Afrod steps ([{command: args}])."""
    return [{s["op"].split(".", 1)[1]: dict(s["params"])} for s in steps if step_source(s["op"]) == AFROD]


# ---------------------------------------------------------------- parameters

def validate_params(decl):
    """Problems in a library entry's `params` list."""
    if decl is None:
        return []
    if not isinstance(decl, list):
        return ["params must be a list"]
    out, seen = [], set()
    for i, p in enumerate(decl):
        where = f"params[{i}]"
        if not isinstance(p, dict):
            out.append(f"{where} must be an object")
            continue
        pid = p.get("id")
        if not isinstance(pid, str) or not pid.isidentifier() or pid == "seed":
            out.append(f"{where}: id must be an identifier other than 'seed'")
        elif pid in seen:
            out.append(f"{where}: id {pid!r} repeats")
        seen.add(pid)
        lo, hi, d = p.get("min"), p.get("max"), p.get("default")
        if not (_num(lo) and _num(hi) and lo < hi):
            out.append(f"{where} {pid}: min < max must be numbers")
        elif not (_num(d) and lo <= d <= hi):
            out.append(f"{where} {pid}: default must be within min..max")
        if "step" in p and not (_num(p["step"]) and p["step"] > 0):
            out.append(f"{where} {pid}: step must be > 0")
        maps = p.get("maps")
        if not isinstance(maps, list) or not maps:
            out.append(f"{where} {pid}: maps must be a non-empty list")
            continue
        for j, m in enumerate(maps):
            if not isinstance(m, dict) or not isinstance(m.get("step"), str) or not isinstance(m.get("field"), str):
                out.append(f"{where} {pid}: maps[{j}] needs step and field (strings)")
            elif m.get("mode", "set") not in MAP_MODES:
                out.append(f"{where} {pid}: maps[{j}].mode must be set or scale")
    return out


def resolve_overrides(decl, overrides):
    """(values {param id: value}, seed or None, other {key: value}, warnings). Missing params take their
    default; a value outside min..max is clamped (the server refuses those; a hand-written layer may not);
    keys that are neither a param nor `seed` are returned in `other` (raw scene.opcdtools overrides, the older
    form, which the engine still takes for plain Afrod recipes)."""
    decl = decl or []
    overrides = overrides or {}
    by_id = {p["id"]: p for p in decl}
    values = {p["id"]: p["default"] for p in decl}
    seed, other, warnings = None, {}, []
    for k, v in overrides.items():
        if k == "seed":
            if not isinstance(v, int) or isinstance(v, bool):
                raise RecipeError(f"overrides.seed must be an integer (got {v!r})")
            seed = v
        elif k in by_id:
            p = by_id[k]
            if not _num(v):
                raise RecipeError(f"overrides.{k} must be a number (got {v!r})")
            c = min(max(float(v), p["min"]), p["max"])
            if c != v:
                warnings.append(f"overrides.{k} = {v} clamped to {c} ({p['min']}..{p['max']})")
            values[k] = c
        else:
            other[k] = v
    return values, seed, other, warnings


def step_matches(step, ref):
    """A map's `step` names this step: its op, its Afrod command name or its tag."""
    op = step.get("op", "")
    return ref == op or ref == step.get("tag") or (step_source(op) == AFROD and ref == op.split(".", 1)[1])


def field_default(step, field):
    """A studio step field's default (None when it has none: the preset's value)."""
    fields = STUDIO_FIELDS.get(step.get("op"))
    if fields and field in fields:
        return fields[field][0]
    return None


def apply_params(steps, decl, values):
    """Steps with every param's maps applied: (steps, applied [{param, value, step, field, mode, before, after}]).
    Raises RecipeError when a map names no step, or scales a field the step does not have (and has no default)."""
    out = copy.deepcopy(steps)
    applied = []
    for p in decl or []:
        value = values.get(p["id"], p["default"])
        for m in p["maps"]:
            mode = m.get("mode", "set")
            hits = [i for i, s in enumerate(out) if step_matches(s, m["step"])]
            if not hits:
                raise RecipeError(f"param {p['id']}: map step {m['step']!r} matches no step of the recipe")
            for i in hits:
                params = out[i]["params"]
                before = params.get(m["field"], field_default(out[i], m["field"]))
                if mode == "set":
                    after = value
                else:
                    if not _num(before):
                        raise RecipeError(f"param {p['id']}: steps[{i}] {out[i]['op']} has no numeric {m['field']!r} to scale")
                    after = before * value
                if isinstance(before, int) and not isinstance(before, bool) and mode == "set" and float(after).is_integer():
                    after = int(after)
                params[m["field"]] = after
                applied.append({"param": p["id"], "value": value, "step": i, "op": out[i]["op"], "field": m["field"],
                                "mode": mode, "before": before, "after": after})
    return out, applied


# ---------------------------------------------------------------- paint and rings

def colour_channels(role_map, kind, role_channel):
    """{painted colour: canonical channel} of a colour -> role map (role_channel(target, kind) -> {channel: w}).
    A colour whose target is a split (several channels) maps to None."""
    out = {}
    for colour in PAINT_COLOURS:
        target = (role_map or {}).get(colour, colour)
        w = role_channel(target, kind)
        chans = [c for c, x in w.items() if x]
        out[colour] = chans[0] if len(chans) == 1 and abs(w[chans[0]] - 1.0) < 1e-9 else None
    return out


def translate_colours(params, channels):
    """An Afrod step's arguments with its paint colours replaced by their canonical channels (so paint stays in
    golfmap roles). Returns (params, [(key, from, to)]); raises RecipeError for a colour mapped to a split."""
    out, changed = dict(params), []
    for k in COLOR_KEYS:
        v = params.get(k)
        if v in channels:
            to = channels[v]
            if to is None:
                raise RecipeError(f"{k} {v!r} maps to a mix of channels: paint steps need a colour -> one role map")
            if to != v:
                out[k] = to
                changed.append((k, v, to))
    return out, changed


def shift_insets(params, shift):
    """Ring-inset arguments moved `shift` rings inward (ringsFromSeam)."""
    if not shift:
        return dict(params)
    out = dict(params)
    for k in INSET_KEYS:
        if k in out and isinstance(out[k], int) and not isinstance(out[k], bool):
            out[k] = out[k] + shift
    return out


def studio_high_side_bearing(value):
    """A studio highSide as a compass bearing in degrees (0 = north, 90 = east), else None."""
    return float(value) % 360.0 if _num(value) else None


def high_side_index(points, centre, target):
    """Index of the rim point whose direction from `centre` best faces `target` (2D points): the high side of a
    bunker faces the green. Ties go to the lowest index."""
    dx, dy = target[0] - centre[0], target[1] - centre[1]
    n = math.hypot(dx, dy)
    if n < 1e-9:
        return None
    dx, dy = dx / n, dy / n
    best, arg = -float("inf"), None
    for i, p in enumerate(points):
        vx, vy = p[0] - centre[0], p[1] - centre[1]
        m = math.hypot(vx, vy)
        if m < 1e-9:
            continue
        s = (vx * dx + vy * dy) / m
        if s > best + 1e-12:
            best, arg = s, i
    return arg


def bearing_vector_blend(bearing_deg):
    """A compass bearing (EPSG:3006: 0 = north, 90 = east) as a .blend XY direction (the .blend is the course
    turned 180 degrees: +x = west, +y = south)."""
    b = math.radians(bearing_deg)
    return (-math.sin(b), -math.cos(b))


def bunker_style_values(values, face_steepness=1.0, high_strength=1.0, ranges=None):
    """A Bunker Studio preset's style values with faceSteepness (face widths divided by it: steeper faces) and
    highSideStrength (the high crown raise times it; the high face tightened from the normal width by it) applied,
    clamped to Bunker Studio's ranges."""
    v = dict(values)
    f = max(1e-6, float(face_steepness))
    for k in ("normal_face_width", "high_face_width", "entry_face_width"):
        if k in v:
            v[k] = v[k] / f
    s = float(high_strength)
    if "crown_raise" in v:
        v["crown_raise"] = v["crown_raise"] * s
    if "high_face_width" in v and "normal_face_width" in v:
        v["high_face_width"] = v["normal_face_width"] - (v["normal_face_width"] - v["high_face_width"]) * s
    for k, (lo, hi) in (ranges or {}).items():
        # Only values the scaling pushed out move, and just inside the bound: Blender keeps the props as float32, and
        # a bound stored as float32 (0.08 -> 0.0799999982) reads as outside it in Bunker Studio's receipt check.
        if k in v and v[k] < lo:
            v[k] = lo + 1e-6
        elif k in v and v[k] > hi:
            v[k] = hi - 1e-6
    return v
