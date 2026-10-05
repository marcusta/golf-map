"""Paint normalisation after an Afrod recipe: every recipe author paints bunkers and water with their own
colour meanings (blender/recipes/library.json says which); this rewrites the touched objects' vertex paint so
each channel carries its canonical golfmap role (blender/SHAPING-PLAN.md, "Terrain editor -> Blender";
the `golfmap` convention in blender/conventions/bunker-channels.json):

    channel  bunker / water mesh                        blend strip
    red      grassLip  (adjoining grass look, 3D grass)  adjoining (the surrounding surface)
    green    dirt      (dirt / bank soil face)           longGrass (longer, darker grass)
    black    shadow    (dark lip, no 3D grass / wet edge) browning (browning grass / dirt toward the hazard)
    blue     floor     (sand / water bed)                -

Paint is channel weights: a corner colour (r, g, b) is weights over red, green, blue plus an implicit
black = 1 - r - g - b (clamped at 0), so a remap is a linear map of the four weights and exact for
recipe paint (pure colours and their blends). The arithmetic runs on the stored sRGB bytes (`color_srgb`),
which is what the FBX carries and what the shader weights in Unity.

Entry points (bpy, no operators, deterministic):
    remap_after_recipe(objects, recipe)  - objects = the bunker/water mesh + its blend objects after the recipe ran;
                                           recipe = library id or recipe file path.
    remap_opcd_default(objects)          - OPCD's untouched paint -> golfmap roles (objects no recipe painted).
    edge_jitter(objects, params, seed)   - the recipe step golfmap.edge_jitter: paint borders between rings made
                                           ragged (seeded, deterministic; the seam ring never changes).
Remapped objects get the custom properties golfmap_paint = "golfmap", golfmap_paint_recipe and golfmap_paint_hash (a
hash of the paint as written). An object counts as already golfmap only while its paint still matches that hash, so a
snapshot restore that puts OPCD's paint back (and keeps the properties) is remapped again. The OPCD default skips
golfmap objects, so it can run over a whole course after the recipes.

The weight maths and the library logic are plain Python (tests: python blender/tools/shape_paint_test.py).
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import shape_recipes  # noqa: E402
REPO = os.path.dirname(os.path.dirname(HERE))
LIBRARY = os.path.join(REPO, "blender", "recipes", "library.json")
LIBRARY_FORMAT = "golfmap-recipe-library-v1"
CHANNELS = ("red", "green", "blue", "black")
KINDS = ("mesh", "blend")
SURFACES = ("bunker", "lake", "creek", "path")
JOINS = ("last-blend", "permanent", "none")
PROP = "golfmap_paint"
PROP_RECIPE = "golfmap_paint_recipe"
PROP_HASH = "golfmap_paint_hash"
CANONICAL = "golfmap"
COLOR_ATTR = "Col"


# ------------------------------------------------------------------ library

def default_recipe_dirs():
    """Same lookup as shape_layers.recipe_dirs: $GOLFMAP_AFROD_RECIPES (default D:/gspro/afrod-recipes), then
    blender/recipes."""
    return [os.environ.get("GOLFMAP_AFROD_RECIPES", "D:/gspro/afrod-recipes"), os.path.join(REPO, "blender", "recipes")]


def load_library(path=None):
    with open(path or LIBRARY, encoding="utf-8") as f:
        lib = json.load(f)
    problems = validate_library(lib)
    if problems:
        raise ValueError((path or LIBRARY) + ": " + "; ".join(problems))
    return lib


def validate_library(lib):
    errors = []
    if lib.get("format") != LIBRARY_FORMAT:
        errors.append(f"format must be {LIBRARY_FORMAT}")
    roles = lib.get("roles", {})
    for kind in KINDS:
        for role, spec in roles.get(kind, {}).items():
            if spec.get("channel") not in CHANNELS:
                errors.append(f"roles.{kind}.{role}: channel must be one of {CHANNELS}")

    def check_map(where, kind, m):
        if not isinstance(m, dict):
            errors.append(f"{where}: must be an object")
            return
        for colour, target in m.items():
            if colour not in CHANNELS:
                errors.append(f"{where}: {colour!r} is not a paint colour")
            try:
                role_weights(target, kind, lib)
            except ValueError as e:
                errors.append(f"{where}.{colour}: {e}")

    for surface, maps in (lib.get("opcdDefault") or {}).items():
        if surface == "notes":
            continue
        if surface not in SURFACES:
            errors.append(f"opcdDefault.{surface}: unknown surface")
        for kind in KINDS:
            check_map(f"opcdDefault.{surface}.{kind}", kind, maps.get(kind, {}))
    for source, maps in (lib.get("studioPaint") or {}).items():
        if source == "notes":
            continue
        for kind in KINDS:
            check_map(f"studioPaint.{source}.{kind}", kind, (maps or {}).get(kind, {}))
    ids, defaults = set(), {}
    for i, r in enumerate(lib.get("recipes", [])):
        where = f"recipes[{i}] {r.get('id')}"
        for k in ("id", "name", "file", "author"):
            if not isinstance(r.get(k), str) or not r.get(k):
                errors.append(f"{where}: {k} missing")
        if r.get("id") in ids:
            errors.append(f"{where}: duplicate id")
        ids.add(r.get("id"))
        if r.get("join") not in JOINS:
            errors.append(f"{where}: join must be one of {JOINS}")
        for s in r.get("surfaces", []):
            if s not in SURFACES:
                errors.append(f"{where}: unknown surface {s!r}")
        for kind in KINDS:
            check_map(f"{where}.paint.{kind}", kind, (r.get("paint") or {}).get(kind, {}))
        for source, maps in (r.get("stepPaint") or {}).items():
            for kind in KINDS:
                check_map(f"{where}.stepPaint.{source}.{kind}", kind, (maps or {}).get(kind, {}))
        errors += [f"{where}: {m}" for m in shape_recipes.validate_params(r.get("params"))]
        if r.get("default"):
            for s in r.get("surfaces", []):
                if s in defaults:
                    errors.append(f"{where}: second default for {s} (after {defaults[s]})")
                defaults[s] = r.get("id")
    return errors


def recipe_path(entry, dirs=None):
    for d in dirs or default_recipe_dirs():
        p = os.path.join(d, entry["file"])
        if os.path.isfile(p):
            return os.path.normpath(p)
    return None


def _norm(p):
    return os.path.normcase(os.path.normpath(p)).replace("\\", "/")


def find_entry(recipe, lib, dirs=None):
    """Library entry for a library id, a file path relative to the recipe folders, or an absolute path
    (what shape_layers.find_recipe returns). None when the library does not know it."""
    if recipe is None:
        return None
    if isinstance(recipe, dict):
        return recipe
    by_id = {r["id"]: r for r in lib["recipes"]}
    if recipe in by_id:
        return by_id[recipe]
    want = _norm(recipe)
    for r in lib["recipes"]:
        rel = _norm(r["file"])
        if want == rel or want.endswith("/" + rel):
            return r
        for d in dirs or default_recipe_dirs():
            if want == _norm(os.path.join(d, r["file"])):
                return r
    return None


def default_recipe(surface, lib):
    for r in lib["recipes"]:
        if r.get("default") and surface in r.get("surfaces", []):
            return r
    return None


def recipes_for(surface, lib):
    return [r for r in lib["recipes"] if surface in r.get("surfaces", [])]


# ------------------------------------------------------------ weight maths

def role_weights(target, kind, lib):
    """A map target -> {canonical channel: weight}. target: a role name of this kind ('grassLip'), a channel
    name ('red'), or {role or channel: weight} for a split."""
    if isinstance(target, dict):
        out = {}
        for t, w in target.items():
            if not isinstance(w, (int, float)) or isinstance(w, bool):
                raise ValueError(f"weight of {t!r} must be a number")
            for ch, w2 in role_weights(t, kind, lib).items():
                out[ch] = out.get(ch, 0.0) + float(w) * w2
        return out
    if target in CHANNELS:
        return {target: 1.0}
    spec = lib.get("roles", {}).get(kind, {}).get(target)
    if spec is None:
        raise ValueError(f"{target!r} is not a {kind} role ({', '.join(lib.get('roles', {}).get(kind, {}))}) or a channel")
    return {spec["channel"]: 1.0}


def identity():
    return [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]


def role_matrix(role_map, kind, lib):
    """4x4 matrix M (rows = canonical channel out, columns = painted colour in, order CHANNELS) for a
    colour -> role map. Colours the map leaves out keep their channel."""
    m = [[0.0] * 4 for _ in range(4)]
    for j, colour in enumerate(CHANNELS):
        target = (role_map or {}).get(colour, colour)
        for ch, w in role_weights(target, kind, lib).items():
            m[CHANNELS.index(ch)][j] += w
    return m


def is_identity(m, eps=1e-12):
    return all(abs(m[i][j] - (1.0 if i == j else 0.0)) <= eps for i in range(4) for j in range(4))


def weights(rgb):
    """(r, g, b) -> (r, g, b, black) with black = 1 - r - g - b, clamped at 0."""
    r, g, b = float(rgb[0]), float(rgb[1]), float(rgb[2])
    return (r, g, b, max(0.0, 1.0 - r - g - b))


def remap_color(rgb, m):
    """Remapped (r, g, b), clamped to 0..1; the new black is implicit again."""
    w = weights(rgb)
    out = [sum(m[i][j] * w[j] for j in range(4)) for i in range(3)]
    return tuple(min(1.0, max(0.0, v)) for v in out)


def dominant(rgb):
    """The paint check's rule (bunker_paint_report.py, GolfMapBunkerChannels.Dominant)."""
    r, g, b = rgb[0], rgb[1], rgb[2]
    if max(r, g, b) < 0.25:
        return "black"
    if r >= g and r >= b:
        return "red"
    return "green" if g >= b else "blue"


# -------------------------------------------------------------- planning

def surface_from_name(name, materials=()):
    """bunker / lake / creek / path from an OPCD object name (materials as a fallback), else None."""
    for text in [name] + [m or "" for m in materials]:
        t = text.lower()
        if "bunker" in t:
            return "bunker"
        if "creek" in t:
            return "creek"
        if "lake" in t or "water" in t:
            return "lake"
        if any(k in t for k in ("concrete", "asphalt", "cart", "path", "gravel", "roads_")):
            return "path"
    return None


def kind_from(name, opcd_kind=None):
    if opcd_kind in KINDS:
        return opcd_kind
    return "blend" if "blend" in name.lower() else "mesh"


def plan(objects, entry, lib, surface=None):
    """Which map each object gets. objects: [{name, kind, parentId, marked, materials}] (plain data).
    Returns [{name, kind, surface, source, recipe, matrix}] with source 'recipe', 'opcdDefault' or
    'skip' (marked: the paint is still what a remap wrote, so calling twice is harmless; or no map known).

    The recipe's map goes to the mesh and, for 'last-blend' recipes, to the blend Afrod joined (the last by
    name among the mesh's blends, same opcd_parent_id); other blends keep OPCD's paint -> opcdDefault. An
    empty map for a kind means the recipe did not repaint it -> opcdDefault too."""
    rows = []
    join = (entry or {}).get("join", "none")
    touched_blends = set()
    if entry is not None and join in ("last-blend", "permanent"):
        blends = sorted((o for o in objects if kind_from(o["name"], o.get("kind")) == "blend"), key=lambda o: o["name"])
        meshes = [o for o in objects if kind_from(o["name"], o.get("kind")) == "mesh"]
        if join == "permanent":
            touched_blends = {o["name"] for o in blends}
        else:
            for m in meshes:
                own = [b for b in blends if m.get("parentId") and b.get("parentId") == m.get("parentId")]
                if not own and not m.get("parentId"):
                    base = m["name"][:-4] if m["name"].endswith("Mesh") else m["name"]
                    own = [b for b in blends if b["name"].startswith(base)]
                if own:
                    touched_blends.add(own[-1]["name"])
    for o in objects:
        kind = kind_from(o["name"], o.get("kind"))
        surf = surface or surface_from_name(o["name"], o.get("materials", ()))
        if surf is None and entry is not None and len(entry.get("surfaces", [])) == 1:
            surf = entry["surfaces"][0]
        touched = entry is not None and (kind == "mesh" or o["name"] in touched_blends)
        recipe_map = ((entry or {}).get("paint") or {}).get(kind) or {}
        row = {"name": o["name"], "kind": kind, "surface": surf, "recipe": (entry or {}).get("id")}
        if o.get("marked"):
            # The paint is exactly what a remap wrote (hash match): nothing painted since, so a second map would
            # map twice (a recipe that repaints changes the hash).
            row.update(source="skip", reason="already golfmap", matrix=None)
        elif touched and recipe_map:
            row.update(source="recipe", matrix=role_matrix(recipe_map, kind, lib))
        else:
            default = (lib.get("opcdDefault") or {}).get(surf or "")
            if default is None:
                row.update(source="skip", reason=f"no OPCD default for surface {surf}", matrix=None)
            else:
                row.update(source="opcdDefault", matrix=role_matrix(default.get(kind) or {}, kind, lib))
        rows.append(row)
    return rows


# ------------------------------------------------------------------ bpy glue

def _color_attr(me):
    attr = me.color_attributes.get(COLOR_ATTR)
    if attr is None:
        attr = me.color_attributes.active_color or (me.color_attributes[0] if len(me.color_attributes) else None)
    return attr


def _read_srgb(obj):
    import numpy as np
    attr = _color_attr(obj.data)
    if attr is None or len(attr.data) == 0:
        return None, None
    buf = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color_srgb", buf)
    return attr, buf


def paint_hash(obj):
    """Hash of obj's paint (sRGB colours as stored), or None without paint."""
    import hashlib
    _, buf = _read_srgb(obj)
    return None if buf is None else hashlib.sha1(buf.tobytes()).hexdigest()[:16]


def is_golfmap(obj):
    return obj.get(PROP) == CANONICAL and obj.get(PROP_HASH) is not None and obj.get(PROP_HASH) == paint_hash(obj)


def remap_object(obj, m):
    """Apply matrix m to every colour of obj's paint attribute (sRGB bytes). Returns the number of colours
    that changed, or None when the object has no paint."""
    import numpy as np
    attr, buf = _read_srgb(obj)
    if attr is None:
        return None
    c = buf.reshape(-1, 4).astype(np.float64)
    rgb = c[:, :3]
    w = np.concatenate([rgb, np.clip(1.0 - rgb.sum(axis=1, keepdims=True), 0.0, None)], axis=1)
    out = np.clip(w @ np.asarray(m, dtype=np.float64)[:3].T, 0.0, 1.0)
    changed = int(np.count_nonzero(np.abs(out - rgb).max(axis=1) > 1e-6))
    if changed:
        c[:, :3] = out
        attr.data.foreach_set("color_srgb", c.astype(np.float32).ravel())
        obj.data.update()
    return changed


def _info(obj):
    return {"name": obj.name, "kind": obj.get("opcd_kind"), "parentId": obj.get("opcd_parent_id"),
            "marked": is_golfmap(obj),
            "materials": [m.name if m else "" for m in getattr(obj.data, "materials", [])]}


def _apply(objects, entry, lib, surface=None):
    objs = [o for o in objects if o is not None and getattr(o, "type", None) == "MESH"]
    by_name = {o.name: o for o in objs}
    rows = plan([_info(o) for o in objs], entry, lib, surface)
    for row in rows:
        obj = by_name[row["name"]]
        m = row.pop("matrix")
        if m is None:
            continue
        row["identity"] = is_identity(m)
        row["changed"] = 0 if row["identity"] else remap_object(obj, m)
        if row["changed"] is None:
            row["source"] = "skip"
            row["reason"] = "no paint"
            continue
        obj[PROP] = CANONICAL
        obj[PROP_RECIPE] = row["recipe"] if row["source"] == "recipe" else "opcdDefault"
        obj[PROP_HASH] = paint_hash(obj)
    return rows


def remap_after_recipe(objects, recipe, library=None, surface=None):
    """After a recipe ran on a feature: rewrite the paint of `objects` (its mesh + blend objects) into the
    golfmap roles. recipe: library id, recipe file path (relative or absolute), or a library entry.
    Returns {recipe, objects: [{name, kind, surface, source, changed, ...}], warnings}."""
    lib = library if isinstance(library, dict) else load_library(library)
    entry = find_entry(recipe, lib)
    if entry is None:
        return {"recipe": recipe, "objects": [], "warnings": [
            f"recipe {recipe!r} is not in {LIBRARY}: paint left as the recipe made it (add it to the library)"]}
    rows = _apply(objects, entry, lib, surface)
    return {"recipe": entry["id"], "objects": rows, "warnings": []}


def step_paint_map(entry, step, lib):
    """The colour -> role maps ({mesh, blend}) of a composite recipe step: the step's own `paint`, else the
    entry's `stepPaint` by the step's tag, op or toolset (`afrod`), else the library's `studioPaint` for a studio
    step, else identity (the step paints in golfmap colours)."""
    if isinstance(step.get("paint"), dict):
        return step["paint"]
    by = (entry or {}).get("stepPaint") or {}
    op = step.get("op", "")
    for key in (step.get("tag"), op, op.split(".", 1)[0]):
        if key and key in by:
            return by[key]
    studio = (lib.get("studioPaint") or {}).get(op)
    if studio is not None:
        return studio
    return {"mesh": {}, "blend": {}}


def remap_objects(objects, maps, lib, recipe_id=None):
    """Remap every object's whole paint with a {mesh, blend} colour -> role map (by the object's kind): what a
    studio step leaves (it painted all of them). Returns [{name, kind, changed}]; marks nothing."""
    rows = []
    for obj in objects:
        if obj is None or getattr(obj, "type", None) != "MESH":
            continue
        kind = kind_from(obj.name, obj.get("opcd_kind"))
        m = role_matrix((maps or {}).get(kind) or {}, kind, lib)
        rows.append({"name": obj.name, "kind": kind, "identity": is_identity(m),
                     "changed": 0 if is_identity(m) else remap_object(obj, m)})
    return rows


def mark_golfmap(objects, recipe_id):
    """Mark objects whose paint is already in golfmap roles (a composite recipe keeps it canonical step by step)."""
    for obj in objects:
        if obj is None or getattr(obj, "type", None) != "MESH" or paint_hash(obj) is None:
            continue
        obj[PROP] = CANONICAL
        obj[PROP_RECIPE] = recipe_id or "golfmap"
        obj[PROP_HASH] = paint_hash(obj)


# ------------------------------------------------------------- edge jitter

def _hash01(*ints):
    """Deterministic hash of integers -> [0, 1) (splitmix64 steps; no global RNG, so the Afrod steps' draws stay put)."""
    h = 0x9E3779B97F4A7C15
    for i in ints:
        h = (h ^ (int(i) & 0xFFFFFFFFFFFFFFFF)) & 0xFFFFFFFFFFFFFFFF
        h = (h + 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF
        h = ((h ^ (h >> 30)) * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
        h = ((h ^ (h >> 27)) * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
        h ^= h >> 31
    return (h >> 11) / float(1 << 53)


def jitter_noise(x, y, seed, wavelength, grain):
    """Seeded noise in -1..1 at world point (x, y): value noise over a `wavelength` lattice (smoothstep) mixed with
    per-point grain (hashed on the point to the mm, so it follows the place, not the vertex order)."""
    fx, fy = x / wavelength, y / wavelength
    ix, iy = int(fx // 1), int(fy // 1)
    tx, ty = fx - ix, fy - iy
    sx, sy = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    c = [[_hash01(seed, ix + i, iy + j) for j in (0, 1)] for i in (0, 1)]
    smooth = (c[0][0] * (1 - sx) + c[1][0] * sx) * (1 - sy) + (c[0][1] * (1 - sx) + c[1][1] * sx) * sy
    white = _hash01(seed, 7, int(round(x * 1000)), int(round(y * 1000)))
    return max(-1.0, min(1.0, 2.0 * ((1 - grain) * smooth + grain * white) - 1.0))


def seam_hops(n_verts, edges, boundary):
    """Edge hops of every vertex from the boundary vertices (ring 0 = the seam), -1 where unreachable."""
    nb = [[] for _ in range(n_verts)]
    for a, b in edges:
        nb[a].append(b)
        nb[b].append(a)
    hops = [-1] * n_verts
    frontier = sorted(set(boundary))
    for v in frontier:
        hops[v] = 0
    h = 0
    while frontier:
        h += 1
        nxt = []
        for v in frontier:
            for w in nb[v]:
                if hops[w] < 0:
                    hops[w] = h
                    nxt.append(w)
        frontier = nxt
    return hops, nb


def jitter_colors(colors, hops, nb, xy, seed, p):
    """Paint rings made ragged: every vertex off the seam takes up to `amount` of its outer neighbours' mean colour
    (noise < 0: the outer band reaches in) or of its inner neighbours' (noise > 0: the inner colour reaches out),
    from the colours as they were. Only borders between differently painted rings change; the seam ring (hop 0)
    never does, so it still matches the blend. colors: per-vertex (r, g, b). Returns the new list."""
    out = list(colors)
    for v, h in enumerate(hops):
        if h <= 0:
            continue
        n = jitter_noise(xy[v][0], xy[v][1], seed, p["wavelengthM"], p["grain"])
        side = [w for w in nb[v] if hops[w] == (h + 1 if n > 0 else h - 1)]
        t = abs(n) * p["amount"]
        if not side or t <= 0:
            continue
        target = [sum(colors[w][k] for w in side) / len(side) for k in range(3)]
        out[v] = tuple(colors[v][k] + (target[k] - colors[v][k]) * t for k in range(3))
    return out


def edge_jitter(objects, params, seed=0):
    """golfmap.edge_jitter on a feature's objects (bpy): the paint borders of the chosen kinds made ragged
    (jitter_colors), per vertex in world XY. Colours are per vertex (corner colours of a vertex move together).
    Returns [{name, kind, changed}]; marks nothing (the recipe's end marks the feature golfmap)."""
    import numpy as np
    p = shape_recipes.jitter_params(params)
    rows = []
    for obj in objects:
        if obj is None or getattr(obj, "type", None) != "MESH":
            continue
        kind = kind_from(obj.name, obj.get("opcd_kind"))
        if kind not in p["kinds"]:
            continue
        me = obj.data
        attr, buf = _read_srgb(obj)
        if attr is None:
            rows.append({"name": obj.name, "kind": kind, "changed": None})
            continue
        nv, ne, nl = len(me.vertices), len(me.edges), len(me.loops)
        ev = np.empty(ne * 2, dtype=np.int64)
        me.edges.foreach_get("vertices", ev)
        ev = ev.reshape(-1, 2)
        le = np.empty(nl, dtype=np.int64)
        me.loops.foreach_get("edge_index", le)
        faces_per_edge = np.bincount(le, minlength=ne)
        boundary = ev[faces_per_edge == 1].ravel().tolist()
        hops, nb = seam_hops(nv, ev.tolist(), boundary)
        co = np.empty(nv * 3, dtype=np.float64)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        mw = np.array(obj.matrix_world, dtype=np.float64)
        world = co @ mw[:3, :3].T + mw[:3, 3]
        c = buf.reshape(-1, 4).astype(np.float64)
        if attr.domain == "CORNER":
            lv = np.empty(nl, dtype=np.int64)
            me.loops.foreach_get("vertex_index", lv)
            cnt = np.maximum(np.bincount(lv, minlength=nv), 1)
            vc = np.stack([np.bincount(lv, weights=c[:, k], minlength=nv) / cnt for k in range(3)], axis=1)
        else:
            lv = None
            vc = c[:, :3]
        new = np.asarray(jitter_colors([tuple(r) for r in vc.tolist()], hops, nb, world[:, :2].tolist(),
                                       int(seed) + p["seed"], p), dtype=np.float64)
        delta = new - vc
        moved = np.abs(delta).max(axis=1) > 1e-6
        changed = int(np.count_nonzero(moved))
        if changed:
            c[:, :3] = np.clip(c[:, :3] + (delta[lv] if lv is not None else delta), 0.0, 1.0)
            attr.data.foreach_set("color_srgb", c.astype(np.float32).ravel())
            me.update()
        rows.append({"name": obj.name, "kind": kind, "changed": changed})
    return rows


def remap_opcd_default(objects, library=None, surface=None):
    """OPCD's own paint -> golfmap roles, for objects no recipe painted (objects already golfmap are skipped)."""
    lib = library if isinstance(library, dict) else load_library(library)
    return {"recipe": None, "objects": _apply(objects, None, lib, surface), "warnings": []}
