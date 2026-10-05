"""Bunker Studio and Shoreline Studio driven headless, as recipe steps (bpy; used by shape_apply.op_recipe).

blender/SHAPING-PLAN.md, "Composite and parameterised recipes". Each studio is run through its own operators the
way its panel does it - scene props set, the feature's mesh selected, Preview -> Validate -> Apply - so its own
checks (seam gap, normals, flips, receipts) decide; nothing of the add-ons is changed on disk.

- `bunkerstudio.shape {preset, depth, edgeVariation, edgeDirt, highSide, highSpan, highSideStrength, faceSteepness}`:
  the public (preset) mode, the only one Bunker Studio validates for OPCD's split blend sets. The high side is
  Bunker Studio's captured guide (`high_side_override` / `high_side_parent_id` / `high_center`, what its Capture
  Guide button writes): the rim point facing the hole's green (`highSide: "green"`, the default; the green of the
  feature's hole nearest to the bunker, else the nearest green within 150 m), a compass bearing (number), or
  `"auto"` = Bunker Studio's automatic high side (the highest rim point). faceSteepness / highSideStrength scale the
  preset's own style values; Bunker Studio's receipt check compares a public preview against the preset's values,
  so the preset entry is swapped for the scaled values only while the step runs (validation sees the same values).
- `shorelinestudio.shape {preset, depth, bankSlope, strength}`: mode from the preset, Water Surface Preview off,
  no feature guide, `shape_seed` = the recipe seed (Shoreline mixes it with the parent id).

Deterministic: Bunker Studio seeds its variation from the parent id (no seed input), Shoreline from parent id +
shape_seed. After Apply the studio's bookkeeping is removed (the `*_applied` markers and the `*_BASELINE__` meshes:
the shaping engine keeps its own snapshots and op cache), so the next run starts from the same state.
"""

import math
import sys
import time

import bpy

import shape_coords
import shape_recipes as sr

GREEN_SEARCH_M = 150.0


def _module(name):
    for key in ("bl_ext.user_default." + name, name):
        if key in sys.modules:
            return sys.modules[key]
    for key, mod in sys.modules.items():
        if key.endswith("." + name):
            return mod
    raise RuntimeError(f"add-on module {name} is not loaded (enable the add-on in Blender 4.5)")


def studio_sources():
    """Files whose content decides a studio step's result (for the op-result cache key)."""
    out = []
    for name in ("bunker_studio", "shoreline_studio"):
        try:
            mod = _module(name)
        except RuntimeError:
            continue
        import os
        folder = os.path.dirname(mod.__file__)
        out += [os.path.join(folder, f) for f in sorted(os.listdir(folder)) if f.endswith(".py")]
    return out


def _select(names):
    for o in bpy.context.view_layer.objects:
        if o.select_get():
            o.select_set(False)
    objs = [bpy.data.objects[n] for n in names]
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0] if objs else None


def _call(op, override):
    """Run a studio operator; (result set, error text or None). In background mode an operator that reports an
    ERROR raises RuntimeError with the message."""
    try:
        with bpy.context.temp_override(**override):
            r = op()
        return r, None
    except RuntimeError as e:
        return {"CANCELLED"}, str(e).replace("Error: ", "").strip()


def _cleanup(objs, applied_key, baseline_prefix, collection, before_meshes):
    removed = []
    for o in objs:
        if applied_key in o.keys():
            del o[applied_key]
    names = {o.name for o in objs}
    for me in list(bpy.data.meshes):
        if me.name.startswith(baseline_prefix) and me.name not in before_meshes and (
                me.get("bs_baseline_source") in names or me.get("ss_baseline_source") in names):
            removed.append(me.name)
            bpy.data.meshes.remove(me)
    coll = bpy.data.collections.get(collection)
    if coll is not None and not coll.objects and not coll.children:
        bpy.data.collections.remove(coll)
    return removed


def _feature_objects(mesh):
    pid = mesh.get("opcd_parent_id")
    blends = sorted((o for o in bpy.data.objects if o.type == "MESH" and pid and o.get("opcd_parent_id") == pid
                     and o.get("opcd_kind") == "blend"), key=lambda o: o.name)
    return [mesh] + blends


# ---------------------------------------------------------------- the high side

def svg_to_blend(sx, sy, frame):
    """SVG user units (x = E - e0, y = n1 - N) -> .blend XY."""
    e = sx + frame["e0"]
    n = frame["n0"] + frame["sideM"] - sy
    return shape_coords.to_blend(e, n, frame)


def green_target(rec, svg_paths, frame, centre_blend):
    """(x, y, green svg id, distance m) of the green the bunker faces: the nearest green of its hole, else the
    nearest green within GREEN_SEARCH_M. None when there is none."""
    greens = [p for p in svg_paths.values() if p.get("type") == "green" and p.get("points")]
    hole = (rec or {}).get("hole")
    cands = [g for g in greens if hole is not None and g.get("hole") == hole] or greens
    best = None
    for g in cands:
        xs = [p[0] for p in g["points"]]
        ys = [p[1] for p in g["points"]]
        gx, gy = svg_to_blend(sum(xs) / len(xs), sum(ys) / len(ys), frame)
        d = math.hypot(gx - centre_blend[0], gy - centre_blend[1])
        if best is None or d < best[3]:
            best = (gx, gy, g["id"], d)
    if best is None:
        return None
    if not (hole is not None and any(g.get("hole") == hole for g in greens)) and best[3] > GREEN_SEARCH_M:
        return None
    return best


def bunker_rim(mesh):
    """(points [(x, y)], cumulative arc lengths, perimeter, analysis) of the bunker's seam cycle, as Bunker Studio
    measures positions around the rim (its _arc_data over the canonical mesh cycle)."""
    bs = _module("bunker_studio")
    source_set = bs._resolve_source_set(mesh)
    analysis = source_set.analysis if len(source_set.blends) > 1 else bs._match_seam(mesh, source_set.blends[0])
    points, cumulative, _, perimeter = bs._arc_data(mesh, analysis["mesh_cycle"])
    return [(p.x, p.y) for p in points], cumulative, perimeter


def plan_high_side(mesh, params, rec, svg_paths, frame):
    """{mode, center?, target?, green?, bearing?} for a bunkerstudio.shape step (plain data, no settings)."""
    want = params.get("highSide", "green")
    if want == "auto":
        return {"mode": "AUTOMATIC", "reason": "highSide auto"}
    pts, cumulative, perimeter = bunker_rim(mesh)
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    out = {"mode": "CAPTURED"}
    bearing = sr.studio_high_side_bearing(want)
    if bearing is not None:
        dx, dy = sr.bearing_vector_blend(bearing)
        target = (cx + dx * 10.0, cy + dy * 10.0)
        out["bearing"] = round(bearing, 2)
    else:
        g = green_target(rec, svg_paths, frame, (cx, cy))
        if g is None:
            return {"mode": "AUTOMATIC", "reason": "no green near the bunker"}
        target = (g[0], g[1])
        out.update(green=g[2], greenDistanceM=round(g[3], 1),
                   bearing=round(math.degrees(math.atan2(-(g[0] - cx), -(g[1] - cy))) % 360.0, 1))
    i = sr.high_side_index(pts, (cx, cy), target)
    if i is None:
        return {"mode": "AUTOMATIC", "reason": "target at the bunker centre"}
    out["center"] = cumulative[i] / perimeter
    out["target"] = [round(target[0], 3), round(target[1], 3)]
    out["rimPoint"] = [round(pts[i][0], 3), round(pts[i][1], 3)]
    return out


# ---------------------------------------------------------------- Bunker Studio

def run_bunker_studio(mesh_name, params, rec, svg_paths, frame, override):
    """Preview -> Validate -> Apply one bunker (mesh + its blends). Returns a run record; `error` set when a step
    of Bunker Studio refused (the objects are then unchanged: its preview and apply are all-or-nothing)."""
    bs = _module("bunker_studio")
    core = _module("bunker_studio.core")
    t = time.time()
    mesh = bpy.data.objects[mesh_name]
    objs = _feature_objects(mesh)
    names = [o.name for o in objs]
    settings = bpy.context.scene.bunker_studio
    preset = params.get("preset", "CLASSIC")
    rec_out = {"studio": "bunkerstudio", "preset": preset, "objects": names}
    for name in bs.SETTING_NAMES_V2 + ("edge_dirt", "edge_variation", "high_side_override", "high_side_parent_id", "preset"):
        settings.property_unset(name)
    entry = core.BUNKER_PRESETS[preset]
    original = entry["values"]
    style = sr.bunker_style_values(original, params.get("faceSteepness", 1.0), params.get("highSideStrength", 1.0),
                                   core.CUSTOM_PRESET_V2_RANGES)
    before_meshes = {m.name for m in bpy.data.meshes}
    entry["values"] = style  # the preset as Bunker Studio resolves it (apply, preview, receipt check) for this step
    try:
        high = plan_high_side(mesh, params, rec, svg_paths, frame)
        _select([mesh_name])
        r, err = _call(lambda: bpy.ops.bunker_studio.apply_preset(preset=preset), override)
        if err:
            return dict(rec_out, error=f"apply_preset: {err}", seconds=round(time.time() - t, 2))
        settings.floor_depth = float(params["depth"]) if params.get("depth") is not None else style["floor_depth"]
        settings.edge_variation = float(params.get("edgeVariation", 50.0))
        settings.edge_dirt = float(params.get("edgeDirt", 35.0))
        if params.get("highSpan") is not None:
            settings.high_span = float(params["highSpan"])
        if high["mode"] == "CAPTURED":
            settings.high_center = high["center"]
            settings.high_side_override = True
            settings.high_side_parent_id = str(mesh.get("opcd_parent_id"))
        rec_out.update(depth=round(settings.floor_depth, 4), edgeVariation=settings.edge_variation,
                       edgeDirt=settings.edge_dirt, highSide=dict(high, span=round(settings.high_span, 4)),
                       style={k: round(v, 5) for k, v in style.items()})
        r, err = _call(bpy.ops.bunker_studio.preview, override)
        rec_out["preview"] = settings.status
        if err:
            return dict(rec_out, error=f"preview: {err}", seconds=round(time.time() - t, 2))
        previews = [o.name for o in bpy.context.selected_objects]
        _select(previews)
        r, err = _call(bpy.ops.bunker_studio.validate, override)
        rec_out["validate"] = settings.status
        if err:
            _select(previews)
            _call(bpy.ops.bunker_studio.clear_preview, override)
            return dict(rec_out, error=f"validate: {err}", seconds=round(time.time() - t, 2))
        _select(previews)
        r, err = _call(bpy.ops.bunker_studio.apply, override)
        rec_out["apply"] = settings.status
        if err:
            _select(previews)
            _call(bpy.ops.bunker_studio.clear_preview, override)
            return dict(rec_out, error=f"apply: {err}", seconds=round(time.time() - t, 2))
    finally:
        entry["values"] = original
    rec_out["removedBaselines"] = _cleanup(objs, bs.APPLIED_KEY, bs.BASELINE_PREFIX, bs.PREVIEW_COLLECTION, before_meshes)
    rec_out["seconds"] = round(time.time() - t, 2)
    return rec_out


# ---------------------------------------------------------------- Shoreline Studio

def run_shoreline_studio(mesh_name, params, seed, override):
    """Preview -> Validate -> Apply one water base (mesh + its blends); run record as run_bunker_studio's."""
    ss = _module("shoreline_studio")
    ss_core = _module("shoreline_studio.core")
    t = time.time()
    mesh = bpy.data.objects[mesh_name]
    objs = _feature_objects(mesh)
    preset = params["preset"]
    mode = sr.SHORELINE_PRESETS[preset]
    s = bpy.context.scene.shoreline_studio
    s.mode = mode
    s.preset = preset
    values = ss_core.PRESET_RECIPES[preset]["values"]
    s.bank_slope = math.radians(float(params["bankSlope"])) if params.get("bankSlope") is not None else values["bank_slope"]
    s.maximum_depth = float(params["depth"]) if params.get("depth") is not None else values["maximum_depth"]
    s.shape_strength = float(params.get("strength", 1.0))
    s.shape_seed = int(seed) % 1000000
    s.water_surface_preview = False
    s.feature_guides = "{}"
    rec_out = {"studio": "shorelinestudio", "preset": preset, "mode": mode, "objects": [o.name for o in objs],
               "depth": round(s.maximum_depth, 4), "bankSlopeDeg": round(math.degrees(s.bank_slope), 3),
               "strength": s.shape_strength, "shapeSeed": s.shape_seed,
               "zoneStops": [list(z) for z in ss_core.PRESET_RECIPES[preset]["shape"]["zone_stops"]]}
    before_meshes = {m.name for m in bpy.data.meshes}
    _select([mesh_name])
    r, err = _call(bpy.ops.shoreline_studio.preview, override)
    rec_out["preview"] = s.status
    if err:
        return dict(rec_out, error=f"preview: {err}", seconds=round(time.time() - t, 2))
    previews = [o.name for o in bpy.context.selected_objects]
    _select(previews)
    r, err = _call(bpy.ops.shoreline_studio.validate, override)
    rec_out["validate"] = s.status
    if err:
        _select(previews)
        _call(bpy.ops.shoreline_studio.clear_preview, override)
        return dict(rec_out, error=f"validate: {err}", seconds=round(time.time() - t, 2))
    _select(previews)
    r, err = _call(bpy.ops.shoreline_studio.apply, override)
    rec_out["apply"] = s.status
    if err:
        _select(previews)
        _call(bpy.ops.shoreline_studio.clear_preview, override)
        return dict(rec_out, error=f"apply: {err}", seconds=round(time.time() - t, 2))
    rec_out["removedBaselines"] = _cleanup(objs, ss.APPLIED_KEY, ss.BASELINE_PREFIX, ss.PREVIEW_COLLECTION, before_meshes)
    rec_out["seconds"] = round(time.time() - t, 2)
    return rec_out


# ---------------------------------------------------------------- rings

def blend_rows(mesh):
    """Rows of the blend Afrod's meshblendjoin joins (the last by name of the mesh's blends): edge steps from its
    outer boundary to the seam it shares with the mesh. OPCD's own blends are one quad row (1); Bunker Studio's
    public blends four. 1 when there is no blend."""
    import bmesh
    from mathutils.kdtree import KDTree
    objs = _feature_objects(mesh)
    if len(objs) < 2:
        return 1
    blend = objs[-1]
    mw_m, mw_b = mesh.matrix_world, blend.matrix_world
    mesh_b = [mw_m @ v.co for v in mesh.data.vertices]
    kd = KDTree(len(mesh_b))
    for i, p in enumerate(mesh_b):
        kd.insert((p.x, p.y, 0.0), i)
    kd.balance()
    bm = bmesh.new()
    bm.from_mesh(blend.data)
    try:
        boundary = [v for v in bm.verts if v.is_boundary]
        seam = {v for v in boundary if kd.find_range(((mw_b @ v.co).x, (mw_b @ v.co).y, 0.0), 1e-4)}
        outer = [v for v in boundary if v not in seam]
        if not seam or not outer:
            return 1
        dist = {v: 0 for v in outer}
        frontier = list(outer)
        while frontier:
            nxt = []
            for v in frontier:
                for e in v.link_edges:
                    w = e.other_vert(v)
                    if w not in dist:
                        dist[w] = dist[v] + 1
                        nxt.append(w)
            frontier = nxt
        rows = [dist[v] for v in seam if v in dist]
        return max(1, min(rows)) if rows else 1
    finally:
        bm.free()
