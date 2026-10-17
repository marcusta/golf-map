"""Omberg farm yard east of the course: dwellings and barns as standalone Blender assets.

Run with Blender 4.5: --factory-startup --python <this file> -- --out <folder> [--no-render].
Output is a golfmap-props-v1 folder (Models/, Textures/, props.json, build-report.json and
omberg-farm-authored.blend), installed beside the clubhouse set by
clubhouse/install.ps1 (it merges by asset id). Evidence: data/omberg-farm/ (crop.py).

dwellings.py, barns.py, garden.py and neighbours.py each define register_materials() and build(add, new, ev);
ev.add_prefab places course-project prefabs (e.g. CESimgolf boxwood) as manifest instances.
Every material here is exported as omberg_farm_<name>, so nothing collides with the
clubhouse set's materials in the shared Unity props.json.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "blender/tools"))
sys.path.insert(0, str(HERE))
import props_kit as kit
import build_props as exporter
import dwellings
import barns
import garden
import neighbours

ORIGIN = (478320.0, 6457650.0)   # review-scene origin (EPSG:3006)
BASE_Z = 100.0                    # review-scene z origin (RH2000)


class Evidence:
    """Shared survey inputs: OSM footprints, lidar points and ortho crops (data/omberg-farm)."""
    def __init__(self):
        import numpy as np
        data = ROOT / "data/omberg-farm"
        self.crop = json.loads((data / "crop.json").read_text())
        self.osm = {str(f["properties"]["osm_id"]): f for f in json.loads((data / "osm-buildings.json").read_text())}
        self.points = np.load(data / "lidar-crop.npz")["points"]
        self.data = data


def farm_name(mat):
    return "omberg_farm_" + (mat[len("omberg_"):] if mat.startswith("omberg_") else mat)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=str(ROOT / "data/omberg-farm/build"))
    p.add_argument("--no-render", action="store_true")
    a = p.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    out = Path(a.out).resolve()
    for d in ["Models", "Textures", "Previews"]:
        (out / d).mkdir(parents=True, exist_ok=True)
    sc = exporter.reset_scene()
    dwellings.register_materials()
    barns.register_materials()
    garden.register_materials()
    neighbours.register_materials()
    ev = Evidence()
    assets, instances = {}, []

    def add(aid, g, e, n, yaw, ground_abs, dz=0.0):
        """Place asset `aid` (asset-local metres, +x along yawDeg's compass bearing, z up from
        ground_abs) at EPSG:3006 (e, n). Unity drops it on the terrain under its centre + dz."""
        assert aid.startswith("omberg_farm_"), aid
        assets[aid] = g
        instances.append(dict(asset=aid, e=e, n=n, yawDeg=yaw, ground="centre", dz=dz,
                              layoutZ=round(ground_abs - BASE_Z, 3)))

    prefabs, proxies = {}, []

    def add_prefab(aid, prefab, e, n, yaw, ground_abs, scale=(1, 1, 1), size=None, dz=0.0, category="prop"):
        """Place a Unity prefab from the course project (e.g. the CESimgolf boxwood) instead of
        authored geometry. Unity scales it by `scale` in its local axes (x along yawDeg) and sets
        each instance's centre on the terrain + dz. `size` (local x, y, z metres before scaling) only
        draws a review box in the .blend; prefabs are not exported."""
        assert aid.startswith("omberg_farm_"), aid
        prefabs.setdefault(aid, dict(prefab=prefab, category=category, collider="keep"))
        instances.append(dict(asset=aid, e=e, n=n, yawDeg=yaw, ground="centre", dz=dz,
                              scale=[round(v, 4) for v in scale], layoutZ=round(ground_abs - BASE_Z, 3)))
        if size:
            proxies.append((aid, e, n, yaw, ground_abs + dz, [s * k for s, k in zip(size, scale)]))

    ev.add_prefab = add_prefab
    dwellings.build(add, kit.Geo, ev)
    barns.build(add, kit.Geo, ev)
    garden.build(add, kit.Geo, ev)
    neighbours.build(add, kit.Geo, ev)

    for g in assets.values():
        renamed = []
        for face, mat, uv in g.faces:
            name = farm_name(mat)
            if name not in kit.MATERIALS:
                kit.MATERIALS[name] = kit.MATERIALS[mat]
            renamed.append((face, name, uv))
        g.faces = renamed
    used = {m for g in assets.values() for _, m, _ in g.faces}
    table = kit.material_table(kit.TextureBank(str(out / "Textures"), 1024), used)
    matte = {farm_name(m) for m in getattr(dwellings, "MATTE", set()) | getattr(barns, "MATTE", set()) | getattr(garden, "MATTE", set()) | getattr(neighbours, "MATTE", set())}
    for name in matte & set(table):
        table[name]["specular"] = [0, 0, 0]
        table[name]["smoothness"] = 0
    # The kit's flat colours are sRGB (Blender linearises them itself); Unity's SetColor
    # takes linear values, so solid (untextured) colours are converted on the export copy.
    export_table = {n: dict(d) for n, d in table.items()}
    for d in export_table.values():
        if not d.get("albedo"):
            d["color"] = [round(((v + .055) / 1.055) ** 2.4 if v > .04045 else v / 12.92, 7) for v in d["color"]]
    lib = bpy.data.collections.new("Farm architecture")
    sc.collection.children.link(lib)
    manifest = {"format": "golfmap-props-v1", "source": "farm/model.py", "materials": export_table,
                "assets": {}, "instances": instances}
    objects = {}
    for name, g in assets.items():
        ob = kit.to_object(g, name, table, str(out / "Textures"), lib)
        for face in ob.data.polygons:
            face.use_smooth = False
        ob.data.update()
        objects[name] = ob
        exporter.export_fbx(ob, str(out / "Models" / (name + ".fbx")))
        category = getattr(g, "category", "building")  # garden parts set g.category = "structure" or "prop"
        manifest["assets"][name] = dict(fbx="Models/" + name + ".fbx", category=category, collider="mesh",
                                        bounds=exporter.bounds(ob),
                                        tris=sum(len(p.vertices) - 2 for p in ob.data.polygons),
                                        materials=[m.name for m in ob.data.materials])
        print(name, manifest["assets"][name]["tris"], "triangles", flush=True)
    manifest["assets"].update(prefabs)
    (out / "props.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    report = dict(format="omberg-farm-build-v1", source="farm/model.py", assets=len(assets),
                  triangles=sum(v["tris"] for v in manifest["assets"].values()), perAsset=manifest["assets"])
    (out / "build-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    for i in instances:
        if i["asset"] not in objects:
            continue
        ob = objects[i["asset"]]
        ob.location = (i["e"] - ORIGIN[0], i["n"] - ORIGIN[1], i["layoutZ"])
        ob.rotation_euler.z = math.radians(90 - i["yawDeg"])
    # Review-only boxes where prefab instances stand (Unity supplies the real foliage).
    if proxies:
        pc = bpy.data.collections.new("Prefab proxies (not exported)")
        sc.collection.children.link(pc)
        mat = bpy.data.materials.new("prefab proxy")
        mat.diffuse_color = (.16, .32, .12, 1)
        for aid, e, n, yaw, z, (sx, sy, sz) in proxies:
            bpy.ops.mesh.primitive_cube_add(size=1, location=(e - ORIGIN[0], n - ORIGIN[1], z - BASE_Z + sz / 2))
            ob = bpy.context.object
            ob.name = aid + " proxy"
            ob.scale = (sx, sy, sz)
            ob.rotation_euler.z = math.radians(90 - yaw)
            ob.data.materials.append(mat)
            for c in ob.users_collection:
                c.objects.unlink(ob)
            pc.objects.link(ob)
    exporter.setup_render(sc, 1600, 1200)
    sc.render.image_settings.file_format = "PNG"
    sc["golfmap_origin_epsg3006"] = [ORIGIN[0], ORIGIN[1], BASE_Z]
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "omberg-farm-authored.blend"))
    if not a.no_render:
        for view, loc, target in [("southwest", (-140, -150, 90), (0, 10, 0)),
                                  ("northeast", (140, 160, 90), (0, 10, 0))]:
            co = exporter.camera(sc, loc, target)
            sc.render.filepath = str(out / "Previews" / (view + ".png"))
            bpy.ops.render.render(write_still=True)
            bpy.data.objects.remove(co, do_unlink=True)
    print("OUTPUT", out, flush=True)


if __name__ == "__main__":
    main()
