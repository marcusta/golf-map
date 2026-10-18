"""Omberg far farmsteads east of the course (outer terrain), simple lidar-fitted buildings.

Run with Blender 4.5: --factory-startup --python <this file> -- --out <folder> [--no-render].
Output is a golfmap-props-v1 folder (Models/, Textures/, props.json, build-report.json and
omberg-far-authored.blend), installed beside the clubhouse set by
clubhouse/install.ps1 (it merges by asset id). Evidence: data/omberg-far/ (crop.py).

farms.py defines register_materials() and build(add, new, ev);
ev.add_prefab places course-project prefabs (e.g. CESimgolf boxwood) as manifest instances.
Every material here is exported as omberg_far_<name>, so nothing collides with the
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
import farms

ORIGIN = (478800.0, 6457310.0)   # review-scene origin (EPSG:3006)
BASE_Z = 100.0                    # review-scene z origin (RH2000)


class Evidence:
    """Shared survey inputs: OSM footprints, lidar points and ortho crops (data/omberg-far)."""
    def __init__(self):
        import numpy as np
        data = ROOT / "data/omberg-far"
        self.crop = json.loads((data / "crop.json").read_text())
        self.osm = {str(f["properties"]["osm_id"]): f for f in json.loads((data / "osm-buildings.json").read_text())}
        self.points = np.load(data / "lidar-crop.npz")["points"]
        self.data = data
        self.dem = np.load(data / "dem-edited-crop.npz")

    def terrain(self, e, n):
        """Course terrain height (edited DEM, bilinear) at EPSG:3006 (e, n): where Unity's
        centre-on-terrain placement puts an asset's origin before dz."""
        d = self.dem
        x = (e - float(d["topLeftE"])) / float(d["pixelE"]) - .5
        y = (float(d["topLeftN"]) - n) / float(d["pixelN"]) - .5
        z = d["z"]
        i, j = int(math.floor(y)), int(math.floor(x))
        fy, fx = y - i, x - j
        i, j = max(0, min(i, z.shape[0] - 2)), max(0, min(j, z.shape[1] - 2))
        return float(z[i, j] * (1 - fx) * (1 - fy) + z[i, j + 1] * fx * (1 - fy)
                     + z[i + 1, j] * (1 - fx) * fy + z[i + 1, j + 1] * fx * fy)


def site_name(mat):
    return "omberg_far_" + (mat[len("omberg_"):] if mat.startswith("omberg_") else mat)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=str(ROOT / "data/omberg-far/build"))
    p.add_argument("--no-render", action="store_true")
    a = p.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    out = Path(a.out).resolve()
    for d in ["Models", "Textures", "Previews"]:
        (out / d).mkdir(parents=True, exist_ok=True)
    sc = exporter.reset_scene()
    farms.register_materials()
    ev = Evidence()
    assets, instances = {}, []

    def lift(e, n, ground_abs, dz):
        # Unity sets the origin on the course terrain under it, then adds dz: carry the gap
        # between the authored ground and that terrain so the asset lands at ground_abs (+ dz).
        return round(ground_abs - ev.terrain(e, n) + dz, 3)

    def add(aid, g, e, n, yaw, ground_abs, dz=0.0):
        """Place asset `aid` (asset-local metres, +x along yawDeg's compass bearing, z up from
        ground_abs) at EPSG:3006 (e, n), so that its z=0 lands at ground_abs + dz in Unity."""
        assert aid.startswith("omberg_far_"), aid
        assets[aid] = g
        instances.append(dict(asset=aid, e=e, n=n, yawDeg=yaw, ground="centre", dz=lift(e, n, ground_abs, dz),
                              layoutZ=round(ground_abs + dz - BASE_Z, 3)))

    prefabs, proxies = {}, []

    def add_prefab(aid, prefab, e, n, yaw, ground_abs, scale=(1, 1, 1), size=None, dz=0.0, category="prop"):
        """Place a Unity prefab from the course project (e.g. the CESimgolf boxwood) instead of
        authored geometry. `scale` is Unity's local scale (x along yawDeg, y up, z across; it
        multiplies the prefab's own); each instance's origin lands at ground_abs + dz. `size` is
        the unscaled prefab in the same axes and only draws a review box; prefabs are not exported."""
        assert aid.startswith("omberg_far_"), aid
        prefabs.setdefault(aid, dict(prefab=prefab, category=category, collider="keep"))
        instances.append(dict(asset=aid, e=e, n=n, yawDeg=yaw, ground="centre", dz=lift(e, n, ground_abs, dz),
                              scale=[round(v, 4) for v in scale], layoutZ=round(ground_abs + dz - BASE_Z, 3)))
        if size:
            proxies.append((aid, e, n, yaw, ground_abs + dz, [size[0] * scale[0], size[2] * scale[2], size[1] * scale[1]]))

    ev.add_prefab = add_prefab
    farms.build(add, kit.Geo, ev)

    for g in assets.values():
        renamed = []
        for face, mat, uv in g.faces:
            name = site_name(mat)
            if name not in kit.MATERIALS:
                kit.MATERIALS[name] = kit.MATERIALS[mat]
            renamed.append((face, name, uv))
        g.faces = renamed
    used = {m for g in assets.values() for _, m, _ in g.faces}
    table = kit.material_table(kit.TextureBank(str(out / "Textures"), 1024), used)
    matte = {site_name(m) for m in getattr(farms, "MATTE", set())}
    for name in matte & set(table):
        table[name]["specular"] = [0, 0, 0]
        table[name]["smoothness"] = 0
    # The kit's flat colours are sRGB (Blender linearises them itself); Unity's SetColor
    # takes linear values, so solid (untextured) colours are converted on the export copy.
    export_table = {n: dict(d) for n, d in table.items()}
    for d in export_table.values():
        if not d.get("albedo"):
            d["color"] = [round(((v + .055) / 1.055) ** 2.4 if v > .04045 else v / 12.92, 7) for v in d["color"]]
    lib = bpy.data.collections.new("Far farmsteads")
    sc.collection.children.link(lib)
    manifest = {"format": "golfmap-props-v1", "source": "far/model.py", "materials": export_table,
                "assets": {}, "instances": instances}
    objects = {}
    for name, g in assets.items():
        ob = kit.to_object(g, name, table, str(out / "Textures"), lib)
        # Draped ground surfaces get one continuous smooth normal field: flat faces on a
        # triangulated terrain drape read as a patchwork of triangles in Unity.
        ground = any(k in name for k in ("paving", "yard"))
        for face in ob.data.polygons:
            face.use_smooth = ground
        if ground:
            for edge in ob.data.edges:
                edge.use_edge_sharp = False
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
    report = dict(format="omberg-far-build-v1", source="far/model.py", assets=len(assets),
                  triangles=sum(v.get("tris", 0) for v in manifest["assets"].values()), perAsset=manifest["assets"])
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
            ob.name = "proxy " + aid  # not "omberg_far_*": the survey checker picks assets by that prefix
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
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "omberg-far-authored.blend"))
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
