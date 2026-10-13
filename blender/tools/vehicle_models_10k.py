"""Step 3 of the low-poly vehicles (README "Low-poly vehicles"). Headless Blender 4.5: ~10 000-triangle
background versions of the pack's sedan and hatchback (seen from 20-100 m), and the vehicles.json that
Unity's golfmap.vehicles.build turns into prefabs.

Same rebuild of the prefab in root space as vehicle_models.py (imported from there; run it first: this
reads its manifest), then:
  1. parts named in dropNodes/dropMaterials go;
  2. faces no outside viewer can see are removed (ray test against the opaque faces from 324 directions,
     0.5-88 deg above the horizon; glass does not block, so what shows through the windows stays);
  3. listed parts are reduced (planar dissolve / collapse), normals read back from the unreduced part.
     Faces seen only through the glass can be reduced harder than the outside ("inside" rows);
  4. the hatchback's modelled rims are replaced by a plain spoked rim (lip, barrel, dark disc, flat spokes, hub).
Tried and dropped: collapse on spoked rims (fills the gaps), planar dissolve on tyres (lumpy) and on the
sedan's textured body (its UVs do not survive merged faces: the door strips vanish).
Output in <work>: <id>_10k.fbx, entries "<id>_10k" in vehicles-lowpoly.json, renders/<id>_10k_compare.png
(rows: front, rear, side, wheel, then 30 m and 80 m at the pixel scale of a 1080p 60 deg game view), and
vehicles.json (golfmap-vehicles-v1: prefab name, FBX, source prefab for the materials, objects with their
slots and castShadows). Copy the FBX files named in vehicles.json and vehicles.json itself into
<course>/Props/VehiclesLowPoly/, then run golfmap.vehicles.build.

  blender -b --factory-startup --python blender/tools/vehicle_models_10k.py -- [--work <dir>] [--only <id>]
      [--probe] [--no-render] [--shadows none|body]   (none, the default: no vehicle casts a shadow)
"""
import json
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vehicle_models as B  # noqa: E402

HERE = B.HERE
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ONLY = argv[argv.index("--only") + 1] if "--only" in argv else None
PROBE = "--probe" in argv
RENDER = "--no-render" not in argv and not PROBE
SHADOWS = argv[argv.index("--shadows") + 1] if "--shadows" in argv else "none"

V = "Assets/Vehicles/Prefabs/"
MODELS = [
    {
        "id": "sedan_tocus", "out": "sedan_tocus_10k",
        "prefabs": [V + "Small Sedan White.prefab"],
        "dropNodes": [],
        "dropMaterials": ["Tocus_Spring", "Tocus_Exhaust_Pipe", "Tocus_Seat", "Tocus_Steering_wheel"],
        "decimate": {},
        "glass": ["Tocus_Windows"],
        "body": ["Tocus_Body White", "Tocus_Plastics", "Tocus_Wheel", "Tocus_Grid"],
        "forward": "z",
        # (node regex, material regex or None) -> ops
        # the textured body, trim and lights are left as they are (planar dissolve on the body wiped the door
        # strips: its UVs do not survive merged faces); the cabin lining (seen through the glass) and what is
        # left of the underside pan (it closes the wheel arches) are cut to a third; the wheels are untouched
        "reduce": [
            [r".", r"Tocus_Salon", [["planar", 10], ["collapse", 0.35]], "inside"],  # outside it is door strips and handles
            [r"Tocus_Bottom", None, [["planar", 10], ["collapse", 0.35]]],
            [r".", r"Tocus_Windows", [["planar", 5]]],
        ],
        "wheels": None,
    },
    {
        "id": "hatchback", "out": "hatchback_10k",
        "prefabs": [V + "Hatchback White.prefab", V + "Hatchback Black.prefab"],
        "dropNodes": ["Steer", "Exhaust", "Disk", "Brake1", "Brake2", "Wipers", "Rim", "Ring"],
        "dropMaterials": [],
        "decimate": {},
        "glass": ["GlassMat"],
        "body": ["BodyMat 5", "SeamsMat 5", "BodyMat 4", "SeamsMat 4", "BlacksMat", "TireMat", "RimMat"],
        "forward": "z",
        "reduce": [
            [r"^BodyMain$", None, [["planar", 7]]],
            [r"^(Interior|Chassis)$", None, [["planar", 10], ["collapse", 0.5]]],
            [r"^(Metal|Headlight|Lamp)$", None, [["planar", 10], ["collapse", 0.5]], "inside"],
            [r"^(Metal|Headlight|Lamp)$", None, [["planar", 10]], "outside"],
            [r"^(WindowFrame|Bumpers1|Bumpers2|Seams|lightGlass)$", None, [["planar", 10]]],  # the tyre is left alone: planar made it lumpy
            [r"^(WindowsGlass|RearLightLeft|RearLightRight)$", None, [["planar", 5]]],
        ],
        # Rim + Ring (1 860 triangles a wheel, 7 488 in all) are rebuilt: lip, barrel, dark disc, flat spokes, hub
        "wheels": {"rim": r"^Rim$", "rimMat": "RimMat", "darkMat": "BlacksMat", "spokes": 10},
    },
]


def directions():
    out = []
    for el in (0.5, 2, 5, 10, 18, 30, 45, 65, 88):
        for az in range(0, 360, 10):
            a, e = math.radians(az + el), math.radians(el)
            out.append((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
    return np.array(out)


def cull_hidden(parts, glass):
    """Drop triangles no direction above the horizon can see (back faces count as unseen). Each part gets
    q["ext"]: True for triangles seen without looking through glass (the outside of the car)."""
    masks = visible(parts, glass)
    removed = 0
    for q, keep in zip(parts, masks):
        removed += int((~keep).sum())
        for k in ("p", "n", "uv", "mat"):
            q[k] = q[k][keep]
    for q, ext in zip(parts, visible(parts, [])):
        q["ext"] = ext | np.isin(q["mat"], glass)
    return removed


def visible(parts, glass):
    opaque = [q["p"][~np.isin(q["mat"], glass)] for q in parts]
    tri = np.concatenate(opaque).reshape(-1, 3)
    bvh = BVHTree.FromPolygons([tuple(v) for v in tri], [(i, i + 1, i + 2) for i in range(0, len(tri), 3)], epsilon=0.0)
    dirs = directions()
    dvec = [Vector(d) for d in dirs]
    masks = []
    for q in parts:
        p = q["p"]
        nrm = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        nrm = nrm / np.maximum(ln, 1e-12)
        cen = p.mean(axis=1)
        samples = np.stack([cen] + [cen * 0.25 + p[:, i] * 0.75 for i in range(3)] + [(p[:, i] + p[:, (i + 1) % 3]) * 0.49 + cen * 0.02 for i in range(3)], axis=1)
        facing = nrm @ dirs.T > 0.03
        keep = np.zeros(len(p), bool)
        for t in range(len(p)):
            fd = np.nonzero(facing[t])[0]
            if len(fd) == 0:
                continue
            off = nrm[t] * 2e-4
            seen = False
            for s in samples[t]:
                o = Vector(s + off)
                for k in fd[::3]:
                    if bvh.ray_cast(o, dvec[k], 60.0)[0] is None:
                        seen = True
                        break
                if seen:
                    break
            if not seen:
                for s in samples[t]:
                    o = Vector(s + off)
                    for k in fd:
                        if bvh.ray_cast(o, dvec[k], 60.0)[0] is None:
                            seen = True
                            break
                    if seen:
                        break
            keep[t] = seen
        masks.append(keep)
    return masks


def soup(ob, slots):
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3).astype(np.float64)
    tl = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get("loops", tl)
    tv = np.empty(nt * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", tv)
    tm = np.empty(nt, np.int32)
    me.loop_triangles.foreach_get("material_index", tm)
    cn = np.empty(len(me.loops) * 3, np.float32)
    me.corner_normals.foreach_get("vector", cn)
    cn = cn.reshape(-1, 3).astype(np.float64)
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers[0].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    out = {"p": co[tv].reshape(nt, 3, 3), "n": cn[tl].reshape(nt, 3, 3), "uv": uv[tl].reshape(nt, 3, 2), "mat": np.array(slots, object)[tm]}
    bpy.data.meshes.remove(me)
    return out


def reduce_part(q, ops):
    """ops: [["planar", degrees] | ["unsubdiv", iterations] | ["collapse", ratio], ...]"""
    if len(q["p"]) == 0 or not ops:
        return q
    slots = []
    for m in q["mat"]:
        if m not in slots:
            slots.append(m)
    ob, _c = B.build_object("red", [q], slots, weld_normals=False)
    for op, val in ops:
        mod = ob.modifiers.new(op, "DECIMATE")
        if op == "planar":
            mod.decimate_type = "DISSOLVE"
            mod.angle_limit = math.radians(val)
            mod.delimit = {"MATERIAL", "UV"}
            mod.use_dissolve_boundaries = False
        elif op == "unsubdiv":
            mod.decimate_type = "UNSUBDIV"
            mod.iterations = int(val)
        else:
            mod.decimate_type = "COLLAPSE"
            mod.ratio = val
            mod.use_collapse_triangulate = True
    ob.modifiers.new("tri", "TRIANGULATE")
    out = soup(ob, slots)
    out["node"] = q["node"]
    me = ob.data
    bpy.data.objects.remove(ob)
    bpy.data.meshes.remove(me)
    out["n"] = source_normals(q, out["p"])
    return out


def source_normals(q, p):
    """Corner normals for the reduced triangles p, read off the unreduced part q: the nearest source triangle
    that faces the same way (so a corner on a crease takes the normal of its own side), interpolated."""
    sp, sn = q["p"], q["n"]
    flat = sp.reshape(-1, 3)
    bvh = BVHTree.FromPolygons([tuple(v) for v in flat], [(i, i + 1, i + 2) for i in range(0, len(flat), 3)], epsilon=0.0)
    sf = np.cross(sp[:, 1] - sp[:, 0], sp[:, 2] - sp[:, 0])
    sf /= np.maximum(np.linalg.norm(sf, axis=1, keepdims=True), 1e-12)
    fn = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    out = np.empty_like(p)
    for t in range(len(p)):
        cen = p[t].mean(axis=0)
        for c in range(3):
            pos = p[t, c] * 0.97 + cen * 0.03  # a little inside the triangle: off the crease
            best, bd = None, -2.0
            for loc, _n, idx, dist in bvh.find_nearest_range(Vector(pos), 0.01):
                d = float(sf[idx] @ fn[t]) - dist * 20
                if d > bd:
                    best, bd = (loc, idx), d
            if best is None:
                loc, _n, idx, _d = bvh.find_nearest(Vector(pos))
                best = (loc, idx)
            loc, idx = best
            a, b, cc = sp[idx]
            v0, v1, v2 = b - a, cc - a, np.array(loc) - a
            d00, d01, d11, d20, d21 = v0 @ v0, v0 @ v1, v1 @ v1, v2 @ v0, v2 @ v1
            den = d00 * d11 - d01 * d01
            if abs(den) < 1e-20:
                n = sn[idx, 0]
            else:
                v = (d11 * d20 - d01 * d21) / den
                w = (d00 * d21 - d01 * d20) / den
                n = sn[idx, 0] * (1 - v - w) + sn[idx, 1] * v + sn[idx, 2] * w
            ln = np.linalg.norm(n)
            out[t, c] = n / ln if ln > 1e-9 and n @ fn[t] > -0.2 else fn[t]
    return out


def simple_rims(orig_parts, w, seg=24):
    """A plain spoked rim per wheel in place of the modelled one: lip ring, short barrel, dark disc behind,
    flat spokes and a hub. Wheels are found as the four clusters of the rim node's triangles."""
    pts = np.concatenate([q["p"].reshape(-1, 3) for q in orig_parts if re.search(w["rim"], q["node"])])
    ymid = (pts[:, 1].min() + pts[:, 1].max()) / 2
    tris, mats = [], []

    def add(a, b, c, want, mat):
        n = np.cross(np.subtract(b, a), np.subtract(c, a))
        if np.dot(n, want) < 0:
            b, c = c, b
        tris.append((a, b, c))
        mats.append(mat)

    for s in (-1.0, 1.0):
        for front in (True, False):
            sel = pts[(np.sign(pts[:, 0]) == s) & ((pts[:, 1] < ymid) == front)]
            lo, hi = sel.min(axis=0), sel.max(axis=0)
            cy, cz = (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2
            R = min(hi[1] - lo[1], hi[2] - lo[2]) / 2
            xf = hi[0] if s > 0 else lo[0]
            out = (s, 0.0, 0.0)
            ring = lambda r, x: [(x, cy + r * math.cos(2 * math.pi * i / seg), cz + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
            lip_o, lip_i, back = ring(R, xf), ring(0.85 * R, xf), ring(0.85 * R, xf - s * 0.06)
            centre_back = (xf - s * 0.06, cy, cz)
            for i in range(seg):
                k = (i + 1) % seg
                add(lip_o[i], lip_o[k], lip_i[k], out, w["rimMat"])
                add(lip_o[i], lip_i[k], lip_i[i], out, w["rimMat"])
                inward = (0.0, cy - lip_i[i][1], cz - lip_i[i][2])
                add(lip_i[i], lip_i[k], back[k], inward, w["rimMat"])
                add(lip_i[i], back[k], back[i], inward, w["rimMat"])
                add(centre_back, back[i], back[k], out, w["darkMat"])
            xs, xh = xf - s * 0.015, xf - s * 0.008
            n = w["spokes"]
            for i in range(n):
                a = 2 * math.pi * (i + 0.5) / n
                u = (math.cos(a), math.sin(a))
                v = (-u[1], u[0])
                hw0, hw1 = 0.055 * R, 0.04 * R
                p = lambda r, hw: (xs, cy + u[0] * r + v[0] * hw, cz + u[1] * r + v[1] * hw)
                add(p(0.2 * R, -hw0), p(0.86 * R, -hw1), p(0.86 * R, hw1), out, w["rimMat"])
                add(p(0.2 * R, -hw0), p(0.86 * R, hw1), p(0.2 * R, hw0), out, w["rimMat"])
            hub = [(xh, cy + 0.24 * R * math.cos(2 * math.pi * i / n), cz + 0.24 * R * math.sin(2 * math.pi * i / n)) for i in range(n)]
            for i in range(n):
                add((xh, cy, cz), hub[i], hub[(i + 1) % n], out, w["rimMat"])
    p = np.array(tris, np.float64)
    nrm = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    return [{"node": "simple_rim", "p": p, "n": np.repeat(nrm[:, None, :], 3, axis=1), "uv": np.zeros((len(p), 3, 2), np.float32), "mat": np.array(mats, object)}]


def render_sheet(cfg, orig, low, out_png):
    """Rows: front 3/4, rear 3/4, low side, wheel close-up, 30 m and 80 m as seen in a 1080p game view."""
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE_NEXT"
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
    gm.from_pydata([(-200, -200, 0), (200, -200, 0), (200, 200, 0), (-200, 200, 0)], [], [(0, 1, 2, 3)])
    gmat = bpy.data.materials.new("ground")
    gmat.use_nodes = True
    gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.3, 0.3, 0.3, 1)
    gm.materials.append(gmat)
    sc.collection.objects.link(bpy.data.objects.new("ground", gm))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    b = B.unity_bounds(orig)
    centre = Vector((-(b["min"][0] + b["max"][0]) / 2, -(b["min"][2] + b["max"][2]) / 2, (b["min"][1] + b["max"][1]) / 2))
    size = max(b["max"][i] - b["min"][i] for i in range(3))
    fwd = Vector((0, -1, 0))
    side = Vector((-fwd.y, fwd.x, 0))
    W, H = 800, 480
    game = 2 * math.atan((W / 2.5 / 2) / (540 / math.tan(math.radians(30))))  # a 320 px wide cut of a 1080p, 60 deg view
    views = [("front", fwd * 0.75 + side * 0.66, 0.38, None), ("rear", -fwd * 0.75 - side * 0.66, 0.38, None), ("side", fwd * 0.2 + side * 0.98, 0.1, None),
             ("wheel", fwd * 0.3 + side * 0.95, 0.12, None), ("30m", fwd * 0.6 + side * 0.8, None, 30.0), ("80m", -fwd * 0.5 + side * 0.87, None, 80.0)]
    rows = []
    for vname, d, h, metres in views:
        imgs = []
        for group in (orig, low):
            for ob in orig + low:
                ob.hide_render = ob not in group
            dd = Vector((d.x, d.y, 0)).normalized()
            if metres:
                cam.data.sensor_fit = "HORIZONTAL"
                cam.data.angle = game
                sc.render.resolution_x, sc.render.resolution_y = int(W / 2.5), int(H / 2.5)
                aim = centre
                cam.location = Vector((centre.x, centre.y, 0)) + dd * metres + Vector((0, 0, 1.7))
            else:
                cam.data.lens = 60
                sc.render.resolution_x, sc.render.resolution_y = W, H
                dist = size * (1.0 if vname == "wheel" else 2.6)
                aim = centre + (fwd * size * 0.3 - Vector((0, 0, centre.z * 0.5)) if vname == "wheel" else Vector((0, 0, 0)))
                cam.location = aim + dd * dist + Vector((0, 0, h * dist))
            cam.rotation_euler = (aim - cam.location).to_track_quat("-Z", "Y").to_euler()
            path = os.path.join(HERE, "renders", "_tmp.png")
            sc.render.filepath = path
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(path)
            w, hh = img.size
            px = np.empty(w * hh * 4, np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(hh, w, 4)
            if metres:  # blow the game pixels up without smoothing
                px = px[(np.arange(H) / 2.5).astype(int)][:, (np.arange(W) / 2.5).astype(int)]
            imgs.append(px)
            bpy.data.images.remove(img)
            os.remove(path)
        rows.append(np.concatenate(imgs, axis=1))
    sheet = np.concatenate(rows[::-1], axis=0)
    hh, w = sheet.shape[:2]
    out = bpy.data.images.new("sheet", w, hh, alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = out_png
    out.file_format = "PNG"
    out.save()


def ops_for(cfg, node, mat, ext):
    """reduce rows: [node regex, material regex or None, ops, where] with where = "inside" (only faces seen
    through the glass), "outside" or absent (both)."""
    for row in cfg["reduce"]:
        nre, mre, ops = row[:3]
        where = row[3] if len(row) > 3 else None
        if re.search(nre, node) and (mre is None or re.search(mre, mat)) and (where is None or (where == "outside") == ext):
            return ops
    return None


def main():
    manifest_path = os.path.join(HERE, "vehicles-lowpoly.json")
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    for cfg in MODELS:
        if ONLY and cfg["id"] != ONLY:
            continue
        prefabs = [B.DATA["prefabs"][p] for p in cfg["prefabs"]]
        first = prefabs[0]
        paths = sorted({n["mesh"]["model"] for pf in prefabs for n in pf["nodes"] if "mesh" in n})
        src = B.load_sources(paths, {})
        bpy.ops.wm.read_factory_settings(use_empty=True)
        notes = []
        orig_parts = B.assemble(first, src, cfg, False, notes)
        parts = B.assemble(first, src, cfg, True, [])
        before = sum(len(q["p"]) for q in orig_parts)
        after_drop = sum(len(q["p"]) for q in parts)
        if cfg["wheels"] and not PROBE:
            parts += simple_rims(orig_parts, cfg["wheels"])  # before the cull: they hide what is behind them
        hidden = cull_hidden(parts, cfg["glass"])
        # one piece per (node, material) so a recipe can address e.g. the cabin lining of a door
        pieces = []
        for q in parts:
            for m in dict.fromkeys(q["mat"]):
                for ext in (True, False):  # outside faces and faces only seen through the glass apart
                    sel = (q["mat"] == m) & (q["ext"] == ext)
                    if sel.any():
                        pieces.append({"node": q["node"], "ext": ext, "p": q["p"][sel], "n": q["n"][sel], "uv": q["uv"][sel], "mat": q["mat"][sel]})
        stages = {}
        reduced = []
        for q in pieces:
            m = q["mat"][0]
            if PROBE:
                row = [len(q["p"])]
                for ops in ([["planar", 5]], [["planar", 10]], [["planar", 20]], [["unsubdiv", 2]], [["planar", 10], ["collapse", 0.5]]):
                    row.append(len(reduce_part(q, ops)["p"]))
                print("PROBE %-26s %-22s visible %5d | planar5 %5d planar10 %5d planar20 %5d unsubdiv2 %5d planar10+collapse.5 %5d" % (q["node"], m, *row))
                continue
            ops = ops_for(cfg, q["node"], m, q["ext"])
            r = reduce_part(q, ops) if ops else q
            stages[q["node"] + " | " + m + ("" if q["ext"] else " | behind glass")] = {"visible": len(q["p"]), "final": len(r["p"]), "ops": ops or []}
            reduced.append(r)
        if PROBE:
            print("PROBE", cfg["id"], "before", before, "after drops", after_drop, "hidden removed", hidden)
            continue
        low_mats = []
        for q in reduced:
            for m in q["mat"]:
                if m not in low_mats:
                    low_mats.append(m)
        body_slots = [m for m in cfg["body"] if m in low_mats]
        detail_slots = [m for m in low_mats if m not in cfg["body"]]
        split = lambda ps, slots: [dict(q, **{k: q[k][np.isin(q["mat"], slots)] for k in ("p", "n", "uv", "mat")}) for q in ps]
        low_obs, objects = [], []
        for suffix, slots, shadows in (("body", body_slots, True), ("details", detail_slots, False)):
            ob, counts = B.build_object(cfg["out"] + "_" + suffix, split(reduced, slots), slots)
            low_obs.append(ob)
            objects.append({"name": ob.name, "castShadows": shadows, "triangles": len(ob.data.polygons), "vertices": len(ob.data.vertices),
                            "materials": slots, "trianglesPerMaterial": counts})
        fbx = os.path.join(HERE, cfg["out"] + ".fbx")
        for o in bpy.data.objects:
            o.select_set(o in low_obs)
        bpy.context.view_layer.objects.active = low_obs[0]
        bpy.ops.export_scene.fbx(filepath=fbx, use_selection=True, bake_space_transform=True, object_types={"MESH"},
                                 mesh_smooth_type="OFF", add_leaf_bones=False, path_mode="STRIP", embed_textures=False)
        all_mats = []
        for q in orig_parts:
            for m in q["mat"]:
                if m not in all_mats:
                    all_mats.append(m)
        orig_ob, orig_counts = B.build_object(cfg["out"] + "_original", orig_parts, all_mats)
        after = sum(o["triangles"] for o in objects)
        base = manifest["models"][cfg["id"]]
        entry = {k: base[k] for k in ("sourcePrefabs", "sourceModels", "specAssets", "instances", "renderersBefore", "forwardAxis", "uv") if k in base}
        entry.update({
            "fbx": os.path.basename(fbx),
            "renderersAfter": len(objects),
            "trianglesBefore": before,
            "trianglesAfter": after,
            "materialsBefore": all_mats,
            "trianglesPerMaterialBefore": orig_counts,
            "dropped": {"nodes": cfg["dropNodes"], "materials": cfg["dropMaterials"], "inactive": base["dropped"]["inactive"],
                        "hiddenTriangles": hidden, "materialsGone": [m for m in all_mats if m not in low_mats]},
            "reduced": stages,
            "added": {"simple_rim": {"replaces": cfg["wheels"]["rim"] + " and Ring", "materials": [cfg["wheels"]["rimMat"], cfg["wheels"]["darkMat"]],
                                     "triangles": sum(len(q["p"]) for q in reduced if q["node"] == "simple_rim")}} if cfg["wheels"] else {},
            "objects": objects,
            "boundsUnity": {"before": B.unity_bounds([orig_ob]), "after": B.unity_bounds(low_obs)},
            "notes": notes,
        })
        if "variants" in base:
            entry["variants"] = base["variants"]
        manifest["models"][cfg["out"]] = entry
        print("MODEL", cfg["out"], "before", before, "after drops", after_drop, "hidden", hidden, "final", after, [(o["name"], o["triangles"], o["materials"]) for o in objects])
        for k, v in stages.items():
            if v["ops"]:
                print("   ", k, v)
        if RENDER:
            render_sheet(cfg, [orig_ob], low_obs, os.path.join(HERE, "renders", cfg["out"] + "_compare.png"))
        json.dump(manifest, open(manifest_path, "w", encoding="utf-8"), indent=1)


# Unity prefabs golfmap.vehicles.build makes: name -> (manifest model, source prefab whose materials go on the slots)
PREFABS = [
    ("Sedan", "sedan_tocus_10k", V + "Small Sedan White.prefab"),
    ("Hatchback White", "hatchback_10k", V + "Hatchback White.prefab"),
    ("Hatchback Black", "hatchback_10k", V + "Hatchback Black.prefab"),
    ("Golf Cart", "golf_cart_ezgo", "Assets/CESimgolf 3D Assets/Course Items/Golf Cart/golf-cart-ezgo.prefab"),
]


def write_vehicles_json():
    models = json.load(open(os.path.join(HERE, "vehicles-lowpoly.json"), encoding="utf-8"))["models"]
    out = {"format": "golfmap-vehicles-v1", "shadows": SHADOWS, "prefabs": []}
    for name, mid, prefab in PREFABS:
        if mid not in models:
            print("vehicles.json: no model", mid, "(run vehicle_models.py / this script without --only)")
            continue
        v = models[mid]
        swap = v.get("variants", {}).get(os.path.basename(prefab), {}).get("materialSwap", {})
        out["prefabs"].append({
            "name": name, "fbx": v["fbx"], "materialsFrom": prefab, "sourceModel": mid,
            "objects": [{"name": o["name"], "castShadows": SHADOWS == "body" and o["castShadows"], "materials": [swap.get(m, m) for m in o["materials"]]} for o in v["objects"]],
            "triangles": v["trianglesAfter"], "trianglesBefore": v["trianglesBefore"], "boundsUnity": v["boundsUnity"]["after"],
        })
    json.dump(out, open(os.path.join(HERE, "vehicles.json"), "w", encoding="utf-8"), indent=1)


main()
if not PROBE:
    write_vehicles_json()
