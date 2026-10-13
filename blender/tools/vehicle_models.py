"""Step 2 of the low-poly vehicles (README "Low-poly vehicles"). Headless Blender 4.5: merged versions of a
vehicle pack's Unity prefabs (30-43 renderers a car) for use as course props.

For each model in MODELS: rebuild the prefab in its root space from the source FBX meshes and the prefab's
transforms (<work>/prefabs.json from vehicle_prefabs.py), drop the listed parts, and merge everything into
two objects: <id>_body and <id>_details (the small parts, so their shadows can be switched off), one
material slot per original Unity material, source normals and UV0 kept. Writes <work>/<id>_lowpoly.fbx
(export settings of build_props.py), <work>/vehicles-lowpoly.json (triangles before/after, slots, bounds in
Unity axes) and <work>/renders/<id>_compare.png (original left, merged right). The golf cart's prefab comes
from here; the cars' from vehicle_models_10k.py, which imports this module.

  blender -b --factory-startup --python blender/tools/vehicle_models.py -- [--work <dir>] [--only <id>] [--no-render]

MODELS is what this script knows about the packs' prefabs (which parts are hidden, which materials make the
body): a new vehicle prefab needs an entry.

Blender space of the output: x = -Unity x, y = -Unity z, z = Unity y (what Unity's FBX import turns back
into the prefab root's own axes).
"""
import json
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
# the work folder (git-ignored): prefabs.json in, FBX + manifest + renders out
HERE = argv[argv.index("--work") + 1] if "--work" in argv else os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tree-export", "vehicles-lowpoly")
DATA = json.load(open(os.path.join(HERE, "prefabs.json"), encoding="utf-8"))
ONLY = argv[argv.index("--only") + 1] if "--only" in argv else None
RENDER = "--no-render" not in argv

V = "Assets/Vehicles/Prefabs/"
MODELS = [
    {
        "id": "sedan_tocus",
        "prefabs": [V + "Small Sedan White.prefab"],
        # the underside pan stays (it closes the wheel arches); its springs and exhaust pipe go
        "dropNodes": [],
        "dropMaterials": ["Tocus_Spring", "Tocus_Exhaust_Pipe"],
        "decimate": {},
        "body": ["Tocus_Body White", "Tocus_Plastics", "Tocus_Wheel", "Tocus_Grid"],
        "forward": "z",
    },
    {
        "id": "hatchback",
        "prefabs": [V + "Hatchback White.prefab", V + "Hatchback Black.prefab"],
        # steering wheel only: the chassis pan closes the wheel arches, Brake1/2 are the dark backing behind the spokes
        "dropNodes": ["Steer"],
        "dropMaterials": [],
        "decimate": {},  # collapse at 0.5-0.6 on Rim/Ring closed the gaps between the spokes: left alone
        "body": ["BodyMat 5", "SeamsMat 5", "BodyMat 4", "SeamsMat 4", "BlacksMat", "TireMat", "RimMat"],
        "forward": "z",
    },
    {
        "id": "golf_cart_ezgo",
        "prefabs": ["Assets/CESimgolf 3D Assets/Course Items/Golf Cart/golf-cart-ezgo.prefab"],
        "dropNodes": [],
        "dropMaterials": [],
        "decimate": {},
        "body": ["Cart Color", "Scratched_Polyvinyl_Carbonate_sccnbdnp", "Scratched_Polyvinyl_Hood", "Rubber_scgudevp",
                 "Rubber_front_cart", "Tires Tread", "Rims", "Black", "Leather_oi3tzbp0", "Basket"],
        "forward": "x",
    },
]

# Unity (x, y, z) -> Blender (-x, -z, y)
P = Matrix(((-1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
PI = P.inverted()


_units = {}


def fbx_unit_scale(path):
    """UnitScaleFactor of a binary FBX (1 = cm, 2.54 = inches)."""
    if path not in _units:
        from io_scene_fbx import parse_fbx
        root, _ver = parse_fbx.parse(path)
        _units[path] = 1.0
        for el in root.elems:
            if el.id == b"GlobalSettings":
                for p70 in el.elems:
                    if p70.id == b"Properties70":
                        for p in p70.elems:
                            if p.props[0] == b"UnitScaleFactor":
                                _units[path] = p.props[4]
    return _units[path]


def unity_scale(model_path):
    """Unity model space per Blender world unit for this file (file scale on: metres both sides)."""
    meta = DATA["models"][model_path]
    usf = fbx_unit_scale(model_path)
    blender = usf / 100.0
    unity = (usf / 100.0 if meta.get("useFileScale") == "1" else 1.0) * float(meta.get("globalScale") or 1)
    return unity / blender


def trs(pos, rot, scale):
    return Matrix.Translation(Vector(pos)) @ Quaternion((rot[3], rot[0], rot[1], rot[2])).to_matrix().to_4x4() @ Matrix.Diagonal(Vector(scale + [1]))


def extract(ob, ratio=None):
    """Triangle soup of an imported object in Blender world space: corner positions, normals, UV0,
    slot per triangle, and the slots in first-use order (= Unity's submesh order)."""
    first = []
    for poly in ob.data.polygons:
        if poly.material_index not in first:
            first.append(poly.material_index)
    if ratio:
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    if ratio:
        ob.modifiers.remove(mod)
        if not me.has_custom_normals:  # else the collapse has interpolated the source normals
            me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
            me.set_sharp_from_angle(angle=math.radians(40))
            me.update()
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    tl = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get("loops", tl)
    tv = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", tv)
    tm = np.empty(nt, np.int32)
    me.loop_triangles.foreach_get("material_index", tm)
    cn = np.empty(len(me.loops) * 3, np.float32)
    me.corner_normals.foreach_get("vector", cn)
    cn = cn.reshape(-1, 3)
    if me.uv_layers:
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers[0].data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
    else:
        uv = np.zeros((len(me.loops), 2), np.float32)
    w = np.array(ob.matrix_world, np.float64)
    pos = co[tv].astype(np.float64) @ w[:3, :3].T + w[:3, 3]
    nrm = cn[tl].astype(np.float64) @ np.linalg.inv(w[:3, :3])
    out = {"p": pos.reshape(nt, 3, 3), "n": nrm.reshape(nt, 3, 3), "uv": uv[tl].reshape(nt, 3, 2), "m": tm,
           "first": first, "loc": np.array(ob.matrix_world.translation), "uvs": len(me.uv_layers)}
    bpy.data.meshes.remove(me)
    return out


def load_sources(paths, decimate):
    src = {}
    for path in paths:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=path, use_custom_normals=True, use_anim=False)
        for ob in list(bpy.data.objects):
            if ob.type != "MESH":
                continue
            src[(path, ob.name)] = extract(ob)
            if ob.name in decimate:
                src[(path, ob.name, "dec")] = extract(ob, decimate[ob.name])
    return src


def assemble(prefab, src, cfg, low, notes):
    """Triangles of the prefab in Blender-space root coordinates, tagged with Unity material names."""
    nodes = {n["id"]: n for n in prefab["nodes"]}
    parts = []
    for n in prefab["nodes"]:
        if "mesh" not in n or "materials" not in n:
            continue
        chain_active = True
        m = n
        while m:
            chain_active = chain_active and m["active"]
            m = nodes.get(m["parent"]) if m["parent"] else None
        if not chain_active or n.get("enabled") is False:
            continue  # not rendered in the game either
        if low and n["name"] in cfg["dropNodes"]:
            continue
        path, name = n["mesh"]["model"], n["mesh"]["name"]
        key = (path, name, "dec") if low and (path, name, "dec") in src else (path, name)
        if key not in src:
            notes.append("MISSING mesh %s in %s (node %s)" % (name, os.path.basename(path), n["name"]))
            continue
        s = src[key]
        k = unity_scale(path)
        # parents: every ancestor's TRS; the root keeps only its scale (placing sets its position and rotation)
        parent = Matrix.Identity(4)
        m = nodes.get(n["parent"]) if n["parent"] else None
        while m:
            parent = (Matrix.Diagonal(Vector(m["scale"] + [1])) if m["root"] else trs(m["pos"], m["rot"], m["scale"])) @ parent
            m = nodes.get(m["parent"]) if m["parent"] else None
        model_pos = PI @ (Vector(s["loc"]) * k)  # where Unity's import puts this node in the model
        delta = Vector(n["pos"]) - model_pos
        if delta.length > 0.002:
            notes.append("node %s moved %.3f m from its place in the model" % (n["name"], delta.length))
        f = np.array(P @ parent @ Matrix.Translation(delta) @ PI @ Matrix.Scale(k, 4), np.float64)
        lin = f[:3, :3]
        pos = s["p"] @ lin.T + f[:3, 3]
        nrm = s["n"] @ np.linalg.inv(lin)
        nrm /= np.maximum(np.linalg.norm(nrm, axis=2, keepdims=True), 1e-12)
        uv = s["uv"]
        if np.linalg.det(lin) < 0:
            pos, nrm, uv = pos[:, ::-1], nrm[:, ::-1], uv[:, ::-1]
        used = s["first"]
        if len(used) != len(n["materials"]):
            notes.append("node %s: %d used material slots, %d renderer materials" % (n["name"], len(used), len(n["materials"])))
        names = np.array([n["materials"][used.index(i)] if i in used and used.index(i) < len(n["materials"]) else n["materials"][-1] for i in range(max(used) + 1)], object)
        mats = names[s["m"]]
        keep = np.array([not (low and mm in cfg["dropMaterials"]) for mm in mats], bool)
        parts.append({"node": n["name"], "p": pos[keep], "n": nrm[keep], "uv": uv[keep], "mat": mats[keep]})
    return parts


def make_material(name):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    info = DATA["materials"].get(name, {})
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    col = info.get("color", [0.8, 0.8, 0.8, 1])
    mode = info.get("_Mode", 0)
    bsdf.inputs["Base Color"].default_value = (col[0], col[1], col[2], 1)
    bsdf.inputs["Metallic"].default_value = info.get("_Metallic", 0)
    bsdf.inputs["Roughness"].default_value = max(0.08, 1 - info.get("_Glossiness", 0.5))
    mat.diffuse_color = (col[0], col[1], col[2], 1)
    tex = info.get("textures", {}).get("_MainTex")
    if tex and os.path.exists(tex):
        try:
            img = bpy.data.images.load(tex, check_existing=True)
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = img
            mix = mat.node_tree.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1
            mix.inputs[7].default_value = (col[0], col[1], col[2], 1)
            mat.node_tree.links.new(node.outputs["Color"], mix.inputs[6])
            mat.node_tree.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
            if mode in (1, 2, 3):
                mat.node_tree.links.new(node.outputs["Alpha"], bsdf.inputs["Alpha"])
        except RuntimeError:
            pass
    elif mode in (2, 3):
        bsdf.inputs["Alpha"].default_value = max(0.25, col[3])
    if mode in (1, 2, 3):
        mat.surface_render_method = "DITHERED"
    return mat


def build_object(name, parts, slots, weld_normals=True):
    """One mesh from triangle soups: vertices welded by position, source normals as custom normals,
    UV0, polygons ordered by slot so Unity's submesh order is the slot order."""
    p = np.concatenate([q["p"] for q in parts])
    n = np.concatenate([q["n"] for q in parts])
    uv = np.concatenate([q["uv"] for q in parts])
    mat = np.concatenate([q["mat"] for q in parts])
    idx = np.array([slots.index(m) for m in mat], np.int32)
    order = np.argsort(idx, kind="stable")
    p, n, uv, idx = p[order], n[order], uv[order], idx[order]
    # degenerate triangles out
    area = np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1)
    ok = area > 1e-10
    p, n, uv, idx = p[ok], n[ok], uv[ok], idx[ok]
    nt = len(p)
    flat = p.reshape(-1, 3)
    # weld by position + normal: two-sided faces (same corners, opposite normals) stay separate faces
    keys = np.concatenate([np.round(flat / 2e-5), np.round(n.reshape(-1, 3) * 50)], axis=1).astype(np.int64) if weld_normals else np.round(flat / 2e-5).astype(np.int64)
    _u, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    verts = flat[first]
    tri = inverse.reshape(nt, 3)
    good = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    _s, uniq = np.unique(np.sort(tri, axis=1), axis=0, return_index=True)  # exact duplicates out
    good[np.setdiff1d(np.arange(len(tri)), uniq)] = False
    tri, n, uv, idx = tri[good], n[good], uv[good], idx[good]
    nt = len(tri)
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.astype(np.float32).ravel())
    me.loops.add(nt * 3)
    me.loops.foreach_set("vertex_index", tri.astype(np.int32).ravel())
    me.polygons.add(nt)
    me.polygons.foreach_set("loop_start", np.arange(0, nt * 3, 3, dtype=np.int32))
    me.polygons.foreach_set("loop_total", np.full(nt, 3, np.int32))
    me.polygons.foreach_set("material_index", idx)
    me.polygons.foreach_set("use_smooth", np.ones(nt, bool))
    uvl = me.uv_layers.new(name="UVMap")
    uvl.data.foreach_set("uv", uv.astype(np.float32).ravel())
    for s in slots:
        me.materials.append(make_material(s))
    me.update(calc_edges=True)
    me.normals_split_custom_set([tuple(v) for v in n.reshape(-1, 3)])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    counts = {s: int((idx == i).sum()) for i, s in enumerate(slots)}
    return ob, counts


def unity_bounds(obs):
    lo = np.array([1e9] * 3)
    hi = -lo
    for ob in obs:
        co = np.empty(len(ob.data.vertices) * 3, np.float32)
        ob.data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        u = np.stack([-co[:, 0], co[:, 2], -co[:, 1]], axis=1)
        lo = np.minimum(lo, u.min(axis=0))
        hi = np.maximum(hi, u.max(axis=0))
    return {"min": [round(float(x), 4) for x in lo], "max": [round(float(x), 4) for x in hi]}


def render_views(cfg, orig, low, out_png):
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x, sc.render.resolution_y = 800, 480
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.75, 0.8, 0.9, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    sc.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    sc.collection.objects.link(sun)
    gm = bpy.data.meshes.new("ground")
    gm.from_pydata([(-30, -30, 0), (30, -30, 0), (30, 30, 0), (-30, 30, 0)], [], [(0, 1, 2, 3)])
    gmat = bpy.data.materials.new("ground")
    gmat.use_nodes = True
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.28, 0.3, 0.28, 1)
    gm.materials.append(gmat)
    ground = bpy.data.objects.new("ground", gm)
    sc.collection.objects.link(ground)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 60
    sc.collection.objects.link(cam)
    sc.camera = cam
    b = unity_bounds(low)
    centre = Vector((-(b["min"][0] + b["max"][0]) / 2, -(b["min"][2] + b["max"][2]) / 2, (b["min"][1] + b["max"][1]) / 2))
    size = max(b["max"][i] - b["min"][i] for i in range(3))
    fwd = Vector((0, -1, 0)) if cfg["forward"] == "z" else Vector((-1, 0, 0))  # Unity +z / +x in Blender axes
    side = Vector((-fwd.y, fwd.x, 0))
    views = [("front", fwd * 0.75 + side * 0.66, 0.38), ("rear", -fwd * 0.75 - side * 0.66, 0.38), ("low", fwd * 0.35 + side * 0.94, 0.06), ("far", fwd * 0.75 + side * 0.66, 0.2), ("wheel", fwd * 0.3 + side * 0.95, 0.12)]
    tiles = []
    for vname, d, h in views:
        row = []
        for label, group in (("orig", orig), ("low", low)):
            for ob in orig + low:
                ob.hide_render = ob not in group
            dist = size * (9.0 if vname == "far" else 1.0 if vname == "wheel" else 2.6)
            dd = d.normalized()
            aim = centre + (fwd * size * 0.3 - Vector((0, 0, centre.z * 0.5)) if vname == "wheel" else Vector((0, 0, 0)))
            cam.location = aim + Vector((dd.x, dd.y, 0)) * dist + Vector((0, 0, h * dist))
            cam.rotation_euler = (aim - cam.location).to_track_quat("-Z", "Y").to_euler()
            path = os.path.join(HERE, "renders", "_%s_%s_%s.png" % (cfg["id"], vname, label))
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            row.append(path)
        tiles.append(row)
    # compose: columns original | low-poly, rows = views
    rows = []
    for row in tiles:
        imgs = []
        for path in row:
            img = bpy.data.images.load(path)
            w, h = img.size
            px = np.empty(w * h * 4, np.float32)
            img.pixels.foreach_get(px)
            imgs.append(px.reshape(h, w, 4))
            bpy.data.images.remove(img)
            os.remove(path)
        rows.append(np.concatenate(imgs, axis=1))
    sheet = np.concatenate(rows[::-1], axis=0)  # image rows are bottom-up
    h, w = sheet.shape[:2]
    out = bpy.data.images.new("sheet", w, h, alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = out_png
    out.file_format = "PNG"
    out.save()
    for ob in orig + low:
        ob.hide_render = False


def main():
    os.makedirs(os.path.join(HERE, "renders"), exist_ok=True)
    manifest_path = os.path.join(HERE, "vehicles-lowpoly.json")
    manifest = json.load(open(manifest_path, encoding="utf-8")) if ONLY and os.path.exists(manifest_path) else {"format": "golfmap-vehicles-lowpoly-v1", "models": {}}
    manifest["note"] = ("Geometry is in the source prefab's root space (root position/rotation left out, root scale baked in). "
                        "Unity axes: x = -Blender x, y = Blender z, z = -Blender y. Triangle counts 'before' are the meshes the "
                        "prefab renders (inactive objects left out), parsed from the source FBX files with Blender.")
    for cfg in MODELS:
        if ONLY and cfg["id"] != ONLY:
            continue
        prefabs = [DATA["prefabs"][p] for p in cfg["prefabs"]]
        paths = sorted({n["mesh"]["model"] for pf in prefabs for n in pf["nodes"] if "mesh" in n})
        src = load_sources(paths, cfg["decimate"])
        bpy.ops.wm.read_factory_settings(use_empty=True)
        notes = []
        first = prefabs[0]
        orig_parts = assemble(first, src, cfg, False, notes)
        low_parts = assemble(first, src, cfg, True, [])
        all_mats = []
        for q in orig_parts:
            for m in q["mat"]:
                if m not in all_mats:
                    all_mats.append(m)
        low_mats = []
        for q in low_parts:
            for m in q["mat"]:
                if m not in low_mats:
                    low_mats.append(m)
        body_slots = [m for m in cfg["body"] if m in low_mats]
        detail_slots = [m for m in low_mats if m not in cfg["body"]]
        split = lambda parts, slots: [dict(q, **{k: q[k][np.isin(q["mat"], slots)] for k in ("p", "n", "uv", "mat")}) for q in parts]
        low_obs, objects = [], []
        for suffix, slots, shadows in (("body", body_slots, True), ("details", detail_slots, False)):
            if not slots:
                continue
            ob, counts = build_object(cfg["id"] + "_" + suffix, split(low_parts, slots), slots)
            low_obs.append(ob)
            objects.append({"name": ob.name, "castShadows": shadows, "triangles": len(ob.data.polygons), "vertices": len(ob.data.vertices),
                            "materials": slots, "trianglesPerMaterial": counts})
        fbx = os.path.join(HERE, cfg["id"] + "_lowpoly.fbx")
        for o in bpy.data.objects:
            o.select_set(o in low_obs)
        bpy.context.view_layer.objects.active = low_obs[0]
        bpy.ops.export_scene.fbx(filepath=fbx, use_selection=True, bake_space_transform=True, object_types={"MESH"},
                                 mesh_smooth_type="OFF", add_leaf_bones=False, path_mode="STRIP", embed_textures=False)
        orig_ob, orig_counts = build_object(cfg["id"] + "_original", orig_parts, all_mats)
        before = sum(len(q["p"]) for q in orig_parts)
        after = sum(o["triangles"] for o in objects)
        per_node = {}
        for q in orig_parts:
            per_node[q["node"]] = per_node.get(q["node"], 0) + len(q["p"])
        entry = {
            "fbx": os.path.basename(fbx),
            "sourcePrefabs": [pf["path"] for pf in prefabs],
            "sourceModels": paths,
            "specAssets": {os.path.basename(pf["path"]): {a: v["instances"] for a, v in pf["assets"].items()} for pf in prefabs},
            "instances": sum(pf["instances"] for pf in prefabs),
            "renderersBefore": sum(1 for n in first["nodes"] if "materials" in n and n["active"]),
            "renderersAfter": len(objects),
            "trianglesBefore": before,
            "trianglesAfter": after,
            "materialsBefore": all_mats,
            "trianglesPerMaterialBefore": orig_counts,
            "trianglesPerSourceNode": per_node,
            "dropped": {"nodes": cfg["dropNodes"], "materials": cfg["dropMaterials"], "inactive": [n["name"] for n in first["nodes"] if not n["active"]]},
            "decimated": cfg["decimate"],
            "objects": objects,
            "uv": "UV0 only (the first UV set of every source mesh)",
            "boundsUnity": {"before": unity_bounds([orig_ob]), "after": unity_bounds(low_obs)},
            "forwardAxis": cfg["forward"],
            "notes": notes,
        }
        # the same geometry serves prefabs that differ only in materials: slot names per prefab
        variants = {}
        for pf in prefabs[1:]:
            a = {n["name"] + "|" + str(i): m for n in first["nodes"] for i, m in enumerate(n.get("materials", []))}
            b = {n["name"] + "|" + str(i): m for n in pf["nodes"] for i, m in enumerate(n.get("materials", []))}
            swap = {}
            for kk in a:
                if kk in b and a[kk] != b[kk]:
                    swap[a[kk]] = b[kk]
            sig = lambda q: sorted((n.get("mesh", {}).get("name") or "", [round(x, 4) for x in n["pos"] + n["rot"] + n["scale"]]) for n in q["nodes"] if not n["root"])
            variants[os.path.basename(pf["path"])] = {"materialSwap": swap, "sameGeometryAndTransforms": sig(first) == sig(pf)}
        if variants:
            entry["variants"] = variants
        manifest["models"][cfg["id"]] = entry
        print("MODEL", cfg["id"], "before", before, "after", after, "objects", [(o["name"], o["triangles"], len(o["materials"])) for o in objects], "notes", notes, "variants", variants)
        if RENDER:
            render_views(cfg, [orig_ob], low_obs, os.path.join(HERE, "renders", cfg["id"] + "_compare.png"))
        json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), indent=1)


if __name__ == "__main__":
    main()
