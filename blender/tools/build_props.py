"""Build course props (buildings, shelters, flags, benches ...) from a spec into FBX for Unity.

    blender -b --factory-startup --python blender/tools/build_props.py -- --spec <spec.json> --out <folder>
        [--only id,id] [--preview] [--layout] [--blend <file.blend>]

Spec (golfmap-props-spec-v1, e.g. docs/gspro/vreta/clubhouse-props.json):
  assets:    {id: {parts: [...], category: building|structure|prop|vehicle, collider: mesh|box|none,
                   physics: GSPwood (optional: the GSPro physic material of its colliders, a name under
                   Assets/Resources/Physics/ or an asset path; without it GolfMapMakeReady.AssetPhysics decides),
                   bake: true | {lods, lodM, cullM, colliderLod, rays, lastLodShadows}}}
  instances: [{asset, e, n, yawDeg, ground: max|min|centre, dz}]   e/n = EPSG:3006 metres,
             yawDeg = compass bearing of the asset's local +x axis
  origin:    [E, N] for the --layout preview scene

Writes into --out:
  Models/<id>.fbx          one mesh per asset, local frame (x long axis, z up, origin on the ground)
  Textures/*.png           generated albedo + normal maps (sized in metres, see props_kit.MATERIALS)
  Previews/<id>.png        (--preview) a lit render of each asset
  props.json               golfmap-props-v1 manifest for Unity: materials, assets (fbx, collider,
                           physics, bounds), instances - GolfMapProps.cs reads it
--layout also builds every instance in one scene around `origin` (flat ground, optional ortho
image) and renders top and oblique views to Previews/layout_*.png, to check placement.

`bake` (an asset of many stones in one mesh: a stone bridge's core + shell): its loose parts go through the
stone-wall bake (blender/walls/wall_bake.py bake_doc): triangles inside another closed part or that no ray
from them escapes are dropped, then LODs by Decimate (`lods` ratios, default [1, 0.35, 0.1]) and a collider
mesh from LOD `colliderLod` (default 1). The FBX then holds <id>_LOD0.. and <id>_collider; the manifest
says so (`lods`: {count, lodM, cullM, lastLodShadows}, `colliderMesh`) and GolfMapProps builds the LODGroup
(switching at lodM metres, default [40, 120]) and the MeshCollider from them. No ground: what is buried
stays (its shadow too).
Never touches the course .blend.
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "walls"))
import props_kit as kit  # noqa: E402
import wall_bake  # noqa: E402

BAKE_DEFAULTS = {"lods": [1.0, 0.35, 0.1], "lodM": [40.0, 120.0], "cullM": 0.0, "colliderLod": 1, "rays": 48,
                 "lastLodShadows": False}


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--only", default="")
    p.add_argument("--preview", action="store_true")
    p.add_argument("--layout", action="store_true")
    p.add_argument("--ortho", default="", help="PNG to lay under the layout scene")
    p.add_argument("--ortho-bounds", default="", help="x0,y0,x1,y1 of the ortho PNG in EPSG:3006")
    p.add_argument("--blend", default="")
    p.add_argument("--texture-size", type=int, default=1024)
    return p.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    return sc


def export_fbx(ob, path):
    """FBX carries mesh, UVs and material *names* only: Unity builds the materials from props.json
    and remaps by name. Texture links are cut for the export (else Unity's importer makes its own
    materials from them and asks to re-type the normal maps)."""
    cut = []
    for m in {m for o in (ob if isinstance(ob, (list, tuple)) else [ob]) for m in o.data.materials if m}:
        if m and m.use_nodes:
            for l in list(m.node_tree.links):
                if l.from_node.type == "TEX_IMAGE":
                    cut.append((m, l.from_socket, l.to_socket))
                    m.node_tree.links.remove(l)
    try:
        _export(ob, path)
    finally:
        for m, a, b in cut:
            m.node_tree.links.new(a, b)


def _export(ob, path):
    obs = ob if isinstance(ob, (list, tuple)) else [ob]
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, bake_space_transform=True,
                             object_types={"MESH"}, mesh_smooth_type="OFF", add_leaf_bones=False,
                             path_mode="STRIP", embed_textures=False)


def loose_parts(nv, tris):
    """Connected component per vertex (union-find over the triangles' vertex ids)."""
    parent = list(range(nv))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for a, b, c in tris.tolist():
        ra = find(a)
        parent[find(b)] = ra
        parent[find(c)] = ra
    return np.array([find(i) for i in range(nv)])


def bake_asset(ob, aid, opts, collection):
    """The asset's loose parts baked like a stone wall (wall_bake.bake_doc, Blender's Z up, no ground, one
    chunk) -> [<id>_LOD0.., <id>_collider] objects in the asset's own frame, and the bake's stats."""
    me = ob.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    lv, ll, lm = np.empty(nt * 3, np.int32), np.empty(nt * 3, np.int32), np.empty(nt, np.int32)
    me.loop_triangles.foreach_get("vertices", lv)
    me.loop_triangles.foreach_get("loops", ll)
    me.loop_triangles.foreach_get("material_index", lm)
    lv, ll = lv.reshape(-1, 3), ll.reshape(-1, 3)
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    cn = np.empty(len(me.loops) * 3)
    me.corner_normals.foreach_get("vector", cn)
    cn = cn.reshape(-1, 3)
    uv = np.zeros(len(me.loops) * 2)
    if me.uv_layers.active is not None:
        me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    part = loose_parts(len(co), lv)[lv[:, 0]]
    nmat = max(1, len(me.materials))
    models, stones = {}, []
    for k, p in enumerate(np.unique(part).tolist()):
        t = np.nonzero(part == p)[0]
        idx = np.arange(3 * len(t)).reshape(-1, 3)
        used = np.unique(lm[t]).tolist()
        models[str(k)] = {"vertices": co[lv[t]].ravel().tolist(), "normals": cn[ll[t]].ravel().tolist(),
                          "uv": uv[ll[t]].ravel().tolist(),
                          "submeshes": [idx[lm[t] == m].ravel().tolist() for m in used]}
        stones.append({"model": str(k), "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                       "materials": used, "along": 0.0})
    doc = wall_bake.check_settings({
        "format": wall_bake.FORMAT_IN, "wall": aid, "models": models, "materials": list(range(nmat)), "stones": stones,
        "settings": {"chunkM": 1e9, "lods": opts["lods"], "colliderLod": opts["colliderLod"], "rays": opts["rays"],
                     "cullHidden": True, "up": 2}})
    core = wall_bake.bake_doc(doc)
    chunk = core["chunks"][0]
    pivot = np.asarray(chunk["pivot"], np.float64)
    out = []
    for k, (verts, subs) in enumerate(chunk["lods"]):
        out.append(mesh_object("{}_LOD{}".format(aid, k), verts, subs, pivot, me.materials, collection))
    cpos, cidx = chunk["collider"]
    cme = bpy.data.meshes.new(aid + "_collider")
    cme.from_pydata((cpos + pivot).tolist(), [], cidx.reshape(-1, 3).tolist())
    cme.update()
    col = bpy.data.objects.new(aid + "_collider", cme)
    collection.objects.link(col)
    col.hide_render = True
    out.append(col)
    return out, core["stats"]


def mesh_object(name, verts, subs, pivot, materials, collection):
    """A baked LOD (rows of position, normal, uv; [(material slot, indices)]) as an object with those normals."""
    idx = np.concatenate([i for _, i in subs]).reshape(-1, 3)
    mat = np.concatenate([np.full(len(i) // 3, m) for m, i in subs])
    me = bpy.data.meshes.new(name)
    me.from_pydata((verts[:, 0:3].astype(np.float64) + pivot).tolist(), [], idx.tolist())
    for m in materials:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", mat.astype(np.int32))
    uvl = me.uv_layers.new(name="UVMap")
    uvl.data.foreach_set("uv", verts[idx.ravel(), 6:8].astype(np.float32).ravel())
    me.shade_smooth()
    me.normals_split_custom_set(verts[idx.ravel(), 3:6].astype(np.float64).tolist())
    me.update()
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    return ob


def bounds(ob):
    xs = [v.co.x for v in ob.data.vertices]
    ys = [v.co.y for v in ob.data.vertices]
    zs = [v.co.z for v in ob.data.vertices]
    return {"min": [round(min(xs), 3), round(min(ys), 3), round(min(zs), 3)], "max": [round(max(xs), 3), round(max(ys), 3), round(max(zs), 3)]}


def setup_render(sc, w, h):
    sc.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items.keys() else "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    sky = world.node_tree.nodes.new("ShaderNodeTexSky")
    world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.35
    sc.world = world
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.5
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = (math.radians(50), 0, math.radians(35))
    sc.collection.objects.link(so)
    sc.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in sc.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"


def camera(sc, loc, target, lens=35, ortho=None):
    cam = bpy.data.cameras.new("cam")
    cam.lens = lens
    cam.clip_end = 5000
    if ortho:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    co.location = loc
    d = Vector(target) - Vector(loc)
    co.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.camera = co
    return co


def preview(ob, path):
    """Render one asset from the front-left, framed on its bounds."""
    sc = bpy.context.scene
    b = bounds(ob)
    c = Vector([(b["min"][i] + b["max"][i]) / 2 for i in range(3)])
    r = max((Vector(b["max"]) - Vector(b["min"])).length / 2, 0.5)
    ground = bpy.data.meshes.new("g")
    s = r * 4
    ground.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    go = bpy.data.objects.new("ground", ground)
    gm = bpy.data.materials.new("groundmat")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.2, 0.08, 1)
    go.data.materials.append(gm)
    sc.collection.objects.link(go)
    cam = camera(sc, c + Vector((-r * 1.6, -r * 2.2, r * 1.1)), c, lens=35)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(go)


def main():
    a = args()
    t0 = time.time()
    spec = json.load(open(a.spec, encoding="utf-8"))
    out = os.path.abspath(a.out)
    models, texdir, prevdir = (os.path.join(out, d) for d in ("Models", "Textures", "Previews"))
    for d in (models, texdir):
        os.makedirs(d, exist_ok=True)
    only = set(x for x in a.only.split(",") if x)
    # spec-level materials: finished pictures (a sign face per hole, `image`, paths relative to the spec) or one of
    # the kit's generated textures in a spec's own colour (`texture`, e.g. "granite:170,170,166:0:0:0", tiled `tile` m)
    kit.SPEC_DIR = os.path.dirname(os.path.abspath(a.spec))
    for name, m in spec.get("materials", {}).items():
        if "texture" in m:
            kit.MATERIALS[name] = (m["texture"], tuple(m.get("tile", (4.0, 4.0))), None, m.get("smoothness", 0.3), m.get("metallic", 0.0))
        else:
            kit.MATERIALS[name] = ("image:" + m["image"], (1.0, 1.0), None, m.get("smoothness", 0.3), 0.0)

    sc = reset_scene()
    # geometry first, so only the materials some asset uses get their textures generated
    geos = {}
    for aid, asset in spec["assets"].items():
        if "prefab" not in asset:
            geos[aid] = kit.Geo()
            kit.build_parts(geos[aid], asset["parts"])
    bank = kit.TextureBank(texdir, a.texture_size)
    table = kit.material_table(bank, {m for g in geos.values() for _, m, _ in g.faces})
    if a.preview or a.layout:
        os.makedirs(prevdir, exist_ok=True)
        setup_render(sc, 960, 640)

    lib = bpy.data.collections.new("assets")
    sc.collection.children.link(lib)
    manifest_assets = {}
    objs = {}
    used_mats = set()
    for aid, asset in spec["assets"].items():
        if "prefab" in asset:  # a Unity prefab from the course project: placed as is, nothing to build
            manifest_assets[aid] = {k: asset[k] for k in ("prefab", "axis", "recolor", "physics") if k in asset}
            manifest_assets[aid].update(category=asset.get("category", "prop"), collider=asset.get("collider", "keep"))
            continue
        ob = kit.to_object(geos[aid], aid, table, texdir, lib)
        used_mats.update(m.name for m in ob.data.materials)
        manifest_assets[aid] = {
            "fbx": "Models/" + aid + ".fbx", "category": asset.get("category", "prop"),
            "collider": asset.get("collider", "mesh" if asset.get("category") in ("building", "structure") else "none"),
            "bounds": bounds(ob), "tris": sum(len(p.vertices) - 2 for p in ob.data.polygons),
            "materials": [m.name for m in ob.data.materials],
        }
        manifest_assets[aid].update({"physics": asset["physics"]} if "physics" in asset else {})
        export = ob
        if asset.get("bake") and not (only and aid not in only):
            opts = dict(BAKE_DEFAULTS, **(asset["bake"] if isinstance(asset["bake"], dict) else {}))
            export, st = bake_asset(ob, aid, opts, lib)
            bpy.data.objects.remove(ob)
            bpy.context.view_layer.update()
            ob = export[0]
            manifest_assets[aid].update(
                tris=st["trisLod"][0], trisSource=st["trisIn"], colliderMesh=aid + "_collider",
                lods={"count": len(opts["lods"]), "lodM": opts["lodM"], "cullM": opts["cullM"],
                      "lastLodShadows": opts["lastLodShadows"]},
                bake={"culledInside": st["culledInside"], "culledHidden": st["culledHidden"], "trisLod": st["trisLod"],
                      "colliderTris": st["colliderTris"], "seconds": st["seconds"]["total"]})
            print("baked %-24s %6d -> %s tris, collider %d" % (aid, st["trisIn"], st["trisLod"], st["colliderTris"]))
        objs[aid] = ob
        if only and aid not in only:
            continue
        export_fbx(export, os.path.join(models, aid + ".fbx"))
        if a.preview:
            for o in lib.objects:
                o.hide_render = o is not ob
            preview(ob, os.path.join(prevdir, aid + ".png"))
        print("built %-24s %6d tris" % (aid, manifest_assets[aid]["tris"]))

    manifest = {
        "format": "golfmap-props-v1",
        "source": os.path.basename(a.spec),
        "materials": {k: v for k, v in table.items() if k in used_mats},
        "assets": manifest_assets,
        "instances": spec["instances"],
    }
    with open(os.path.join(out, "props.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)

    if a.layout:
        layout(spec, objs, lib, prevdir, a)
    if a.blend:
        for o in lib.objects:
            o.hide_render = False
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.blend))
    print("done: %d assets, %d instances, %.1f s" % (len(manifest_assets), len(spec["instances"]), time.time() - t0))


def layout(spec, objs, lib, prevdir, a):
    """Every instance around spec.origin on flat ground (an ortho image if given); top + oblique renders."""
    sc = bpy.context.scene
    E0, N0 = spec["origin"]
    lay = bpy.data.collections.new("layout")
    sc.collection.children.link(lay)
    for o in lib.objects:
        o.hide_render = True
    for inst in spec["instances"]:
        if inst["asset"] not in objs:
            continue  # Unity prefabs are not in the Blender scene
        src = objs[inst["asset"]]
        o = bpy.data.objects.new(inst["asset"], src.data)
        o.location = (inst["e"] - E0, inst["n"] - N0, inst.get("dz", 0.0))
        o.rotation_euler = (0, 0, math.radians(90 - inst.get("yawDeg", 90)))
        lay.objects.link(o)
    if a.ortho:
        x0, y0, x1, y1 = map(float, a.ortho_bounds.split(","))
        me = bpy.data.meshes.new("ortho")
        me.from_pydata([(x0 - E0, y0 - N0, -0.02), (x1 - E0, y0 - N0, -0.02), (x1 - E0, y1 - N0, -0.02), (x0 - E0, y1 - N0, -0.02)], [], [(0, 1, 2, 3)])
        uv = me.uv_layers.new()
        for li, co in zip(range(4), [(0, 0), (1, 0), (1, 1), (0, 1)]):
            uv.data[li].uv = co
        m = bpy.data.materials.new("ortho")
        m.use_nodes = True
        tx = m.node_tree.nodes.new("ShaderNodeTexImage")
        tx.image = bpy.data.images.load(a.ortho)
        em = m.node_tree.nodes.new("ShaderNodeEmission")
        m.node_tree.links.new(tx.outputs["Color"], em.inputs["Color"])
        m.node_tree.links.new(em.outputs["Emission"], m.node_tree.nodes["Material Output"].inputs["Surface"])
        me.materials.append(m)
        ob = bpy.data.objects.new("ortho", me)
        lay.objects.link(ob)
    views = spec.get("layoutViews") or [{"name": "top", "at": [0, 0], "size": 200}]
    sc.render.resolution_x, sc.render.resolution_y = 1400, 1400
    for v in views:
        if v.get("from"):
            sc.render.resolution_x, sc.render.resolution_y = 1600, 900
            camera(sc, (v["from"][0], v["from"][1], v["from"][2]), (v["at"][0], v["at"][1], v.get("atZ", 0)), lens=v.get("lens", 30))
        else:
            sc.render.resolution_x, sc.render.resolution_y = 1400, 1400
            camera(sc, (v["at"][0], v["at"][1], 300), (v["at"][0], v["at"][1], 0), ortho=v.get("size", 200))
        sc.render.filepath = os.path.join(prevdir, "layout_" + v["name"] + ".png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
