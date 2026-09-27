"""Build course props (buildings, shelters, flags, benches ...) from a spec into FBX for Unity.

    blender -b --factory-startup --python blender/tools/build_props.py -- --spec <spec.json> --out <folder>
        [--only id,id] [--preview] [--layout] [--blend <file.blend>]

Spec (golfmap-props-spec-v1, e.g. docs/gspro/vreta/clubhouse-props.json):
  assets:    {id: {parts: [...], category: building|structure|prop|vehicle, collider: mesh|box|none}}
  instances: [{asset, e, n, yawDeg, ground: max|min|centre, dz}]   e/n = EPSG:3006 metres,
             yawDeg = compass bearing of the asset's local +x axis
  origin:    [E, N] for the --layout preview scene

Writes into --out:
  Models/<id>.fbx          one mesh per asset, local frame (x long axis, z up, origin on the ground)
  Textures/*.png           generated albedo + normal maps (sized in metres, see props_kit.MATERIALS)
  Previews/<id>.png        (--preview) a lit render of each asset
  props.json               golfmap-props-v1 manifest for Unity: materials, assets (fbx, collider,
                           bounds), instances - GolfMapProps.cs reads it
--layout also builds every instance in one scene around `origin` (flat ground, optional ortho
image) and renders top and oblique views to Previews/layout_*.png, to check placement.
Never touches the course .blend.
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import props_kit as kit  # noqa: E402


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
    for m in ob.data.materials:
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
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, bake_space_transform=True,
                             object_types={"MESH"}, mesh_smooth_type="OFF", add_leaf_bones=False,
                             path_mode="STRIP", embed_textures=False)


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
    # spec-level materials: finished pictures (a sign face per hole), paths relative to the spec
    kit.SPEC_DIR = os.path.dirname(os.path.abspath(a.spec))
    for name, m in spec.get("materials", {}).items():
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
            manifest_assets[aid] = {k: asset[k] for k in ("prefab", "axis", "recolor") if k in asset}
            manifest_assets[aid].update(category=asset.get("category", "prop"), collider=asset.get("collider", "keep"))
            continue
        ob = kit.to_object(geos[aid], aid, table, texdir, lib)
        objs[aid] = ob
        used_mats.update(m.name for m in ob.data.materials)
        manifest_assets[aid] = {
            "fbx": "Models/" + aid + ".fbx", "category": asset.get("category", "prop"),
            "collider": asset.get("collider", "mesh" if asset.get("category") in ("building", "structure") else "none"),
            "bounds": bounds(ob), "tris": sum(len(p.vertices) - 2 for p in ob.data.polygons),
            "materials": [m.name for m in ob.data.materials],
        }
        if only and aid not in only:
            continue
        export_fbx(ob, os.path.join(models, aid + ".fbx"))
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
