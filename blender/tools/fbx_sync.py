"""Export only the course meshes that changed since the last export.

OPCD's Batch Export writes one FBX per visible mesh object, every time, so Unity reimports
all of them (829 files on Vreta) even when a handful changed. This exports the same files,
with the same exporter call, but only for objects whose mesh differs from what was last
written. Unity then reimports just those, and GolfMap > Meshes > Sync (bridge
`golfmap.meshes.sync`) adds new ones to the scene; overwritten ones update in place.

What counts as changed is a fingerprint of what the FBX exporter reads: the evaluated mesh
(modifiers applied) with its positions, faces, UVs, colours and other attributes, the
object's world matrix and its material slots. Fingerprints live in
`<folder>/.golfmap-fbx-sync.json` (Unity skips dot files). An object is exported when it is
new, its fingerprint differs, or its FBX is missing from the folder. The folder mirrors the
.blend: an FBX whose mesh object no longer exists in it (OPCD renumbers and merges meshes when
it regenerates the file) is deleted, so the Unity sync sees it gone (untick to keep them).
Meshes whose name starts with a skipped prefix (default: OPCD's Gap_Issue markers) are never
exported, and their FBX already in the folder go the same way.

The folder is the panel's, else the OPCD tools' export folder (scene.opcd_tools.export_folder),
else the last one used (add-on preferences; a regenerated .blend has neither scene setting),
else `<blend folder>/fbx`, like OPCD. Without a manifest nothing is exported: run
"Mark all as exported" when the folder already matches the .blend (e.g. right after an OPCD
Batch Export), or export everything once.

Install: Edit > Preferences > Add-ons > Install from Disk (this file) -> 3D View sidebar,
"GolfMap" tab. Or headless (never saves the .blend):

    blender -b course.blend --python blender/tools/fbx_sync.py -- \
        [--folder <fbx folder>] [--dry-run] [--baseline | --all] [--keep-orphans] [--exclude Gap_Issue]
"""

import argparse
import hashlib
import json
import os
import sys
import time

import bpy
import numpy as np

bl_info = {
    "name": "GolfMap FBX Sync",
    "author": "golf-map",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > GolfMap",
    "description": "Export only the course meshes that changed since the last FBX export (OPCD file names and settings)",
    "category": "Import-Export",
}

MANIFEST = ".golfmap-fbx-sync.json"
# Meshes never exported, by name prefix: OPCD's gap-check markers (Gap_Issue_<n>__<a>__vs__<b>).
DEFAULT_EXCLUDE = "Gap_Issue"
FORMAT = "golfmap-fbx-sync-v1"
# Bump when the exporter call below changes: every fingerprint then reads as changed.
# use_triangles: Blender triangulates (ear clipping), so Unity gets the triangles the Blender course check saw; left to
# Unity's importer, a concave n-gon could fold or leave a hole (Vreta's road 124, 2026-10-22).
EXPORT_SETTINGS = "export_scene.fbx(use_selection=True, bake_space_transform=True, use_custom_props=True, use_triangles=True)"

# (foreach_get key, numpy dtype, values per element) by attribute data type.
ATTRIBUTE_READ = {
    "FLOAT": ("value", np.float32, 1),
    "INT": ("value", np.int32, 1),
    "INT8": ("value", np.int8, 1),
    "BOOLEAN": ("value", np.bool_, 1),
    "FLOAT_VECTOR": ("vector", np.float32, 3),
    "FLOAT2": ("vector", np.float32, 2),
    "INT32_2D": ("value", np.int32, 2),
    "FLOAT_COLOR": ("color", np.float32, 4),
    "BYTE_COLOR": ("color", np.float32, 4),
    "QUATERNION": ("value", np.float32, 4),
    "FLOAT4X4": ("value", np.float32, 16),
}
# Internal attributes that are topology (kept) versus edit state such as selection (skipped).
TOPOLOGY = {".corner_vert", ".edge_verts"}


def _prefs():
    addon = bpy.context.preferences.addons.get(__name__)
    return addon.preferences if addon else None


def export_folder(scene, override=None):
    """Panel folder, else OPCD's export folder, else the last folder used (add-on preferences: OPCD
    regenerates the .blend, which loses both scene settings), else <blend folder>/fbx like OPCD."""
    if override:
        return os.path.realpath(bpy.path.abspath(override))
    prefs = _prefs()
    candidates = [getattr(p, "export_folder", "") if p else "" for p in (getattr(scene, "opcd_tools", None), getattr(scene, "opcdtools", None))]
    candidates.append(prefs.folder if prefs else "")
    for folder in candidates:
        if folder and folder.strip():
            path = os.path.realpath(bpy.path.abspath(folder))
            if os.path.isdir(path):
                return path
    if not bpy.data.filepath:
        raise RuntimeError("Save the .blend or set an export folder first.")
    return os.path.join(os.path.dirname(bpy.data.filepath), "fbx")


def file_name(obj):
    return bpy.path.clean_name(obj.name)  # what OPCD's exporter names the file


def exclude_prefixes(text):
    return tuple(p.strip() for p in (text or "").split(",") if p.strip())


def is_excluded(name, prefixes):
    return bool(prefixes) and name.startswith(prefixes)


def fingerprint(obj, depsgraph):
    h = hashlib.sha1()
    h.update(EXPORT_SETTINGS.encode())
    # This exported convention determines Unity's channel interpretation even
    # when a fully grass-painted piece has identical geometry and colour bytes.
    h.update(json.dumps({"golfmap_path_transition": obj.get("golfmap_path_transition")},
                        sort_keys=True, separators=(",", ":")).encode())
    h.update(np.array(obj.matrix_world, dtype=np.float64).tobytes())
    h.update("|".join(s.material.name if s.material else "" for s in obj.material_slots).encode())
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        h.update(np.array([len(mesh.vertices), len(mesh.edges), len(mesh.polygons), len(mesh.loops)]).tobytes())
        co = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", co)
        h.update(co.tobytes())
        starts = np.empty(len(mesh.polygons), dtype=np.int32)
        mesh.polygons.foreach_get("loop_start", starts)
        h.update(starts.tobytes())
        for attr in sorted(mesh.attributes, key=lambda a: a.name):
            if attr.name == "position" or (attr.name.startswith(".") and attr.name not in TOPOLOGY):
                continue
            read = ATTRIBUTE_READ.get(attr.data_type)
            h.update((attr.name + ":" + attr.domain + ":" + attr.data_type).encode())
            if read is None:
                continue
            key, dtype, width = read
            values = np.empty(len(attr.data) * width, dtype=dtype)
            attr.data.foreach_get(key, values)
            h.update(values.tobytes())
        if mesh.has_custom_normals:
            normals = np.empty(len(mesh.loops) * 3, dtype=np.float32)
            mesh.corner_normals.foreach_get("vector", normals)
            h.update(normals.tobytes())
    finally:
        evaluated.to_mesh_clear()
    return h.hexdigest()


def load_manifest(folder):
    path = os.path.join(folder, MANIFEST)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("files", {}) if data.get("format") == FORMAT else None


def save_manifest(folder, files):
    path = os.path.join(folder, MANIFEST)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"format": FORMAT, "files": dict(sorted(files.items()))}, f, indent=1)
    os.replace(path + ".tmp", path)


def plan(context, folder, exclude=()):
    """Fingerprint every visible mesh object and compare with the manifest and the folder."""
    depsgraph = context.evaluated_depsgraph_get()
    manifest = load_manifest(folder)
    objects, duplicates, excluded = {}, {}, 0
    for obj in context.visible_objects:
        if obj.type != "MESH":
            continue
        name = file_name(obj)
        if is_excluded(name, exclude):
            excluded += 1
            continue
        if name in objects:
            duplicates.setdefault(name, [objects[name].name]).append(obj.name)
            continue
        objects[name] = obj
    hashes = {name: fingerprint(obj, depsgraph) for name, obj in objects.items()}
    changed = {}
    for name in sorted(objects):
        if not os.path.isfile(os.path.join(folder, name + ".fbx")):
            changed[name] = "no FBX"
        elif manifest is None:
            continue
        elif name not in manifest:
            changed[name] = "new"
        elif manifest[name] != hashes[name]:
            changed[name] = "changed"
    # Orphans: FBX of meshes no longer in the .blend, or of excluded meshes.
    known = {n for n in (file_name(o) for o in bpy.data.objects if o.type == "MESH") if not is_excluded(n, exclude)}
    on_disk = [f[:-4] for f in os.listdir(folder) if f.lower().endswith(".fbx")] if os.path.isdir(folder) else []
    orphans = sorted(n for n in on_disk if n not in known)
    return {
        "folder": folder,
        "manifest": manifest,
        "objects": objects,
        "hashes": hashes,
        "changed": changed,
        "duplicates": duplicates,
        "orphans": orphans,
        "excluded": excluded,
    }


def export_objects(context, folder, names, objects):
    """OPCD's per-object export (operators/export.py) for just these objects."""
    os.makedirs(folder, exist_ok=True)
    view_layer = context.view_layer
    selected = [o for o in context.selected_objects]
    active = view_layer.objects.active
    try:
        bpy.ops.object.select_all(action="DESELECT")
        for name in names:
            obj = objects[name]
            obj.select_set(True)
            view_layer.objects.active = obj
            bpy.ops.export_scene.fbx(filepath=os.path.join(folder, name + ".fbx"), use_selection=True, bake_space_transform=True, use_custom_props=True,
                                     use_triangles=True)
            obj.select_set(False)
    finally:
        for o in selected:
            if o.name in view_layer.objects:
                o.select_set(True)
        view_layer.objects.active = active


def run(context, folder=None, dry_run=False, baseline=False, export_all=False, delete_orphans=True, exclude=DEFAULT_EXCLUDE):
    """Returns a report dict. baseline: record the current state without exporting. delete_orphans: remove FBX
    whose mesh object is no longer in the .blend (OPCD renumbers meshes when it regenerates the file), so the
    Unity sync sees them gone. exclude: comma-separated name prefixes never exported (their FBX count as orphans)."""
    if context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")  # edit-mode changes reach the mesh only on leaving it
    started = time.time()
    folder = export_folder(context.scene, folder)
    prefixes = exclude_prefixes(exclude)
    p = plan(context, folder, prefixes)
    manifest = p["manifest"]
    if manifest is None and not (baseline or export_all or dry_run):
        raise RuntimeError(
            "No " + MANIFEST + " in " + folder + " yet. Use 'Mark all as exported' if the folder matches the "
            ".blend (e.g. right after OPCD's Batch Export), or export everything once.")
    if baseline:
        to_export = [n for n, why in p["changed"].items() if why == "no FBX"]
    elif export_all:
        to_export = sorted(p["objects"])
    else:
        to_export = sorted(p["changed"])
    report = {
        "folder": folder,
        "meshes": len(p["objects"]),
        "export": {n: p["changed"].get(n, "all") for n in to_export},
        "orphans": p["orphans"],
        "excluded": p["excluded"],
        "exclude": list(prefixes),
        "duplicates": p["duplicates"],
        "dryRun": dry_run,
        "firstRun": manifest is None,
    }
    if dry_run:
        report["seconds"] = round(time.time() - started, 1)
        return report
    export_objects(context, folder, to_export, p["objects"])
    files = {n: h for n, h in (manifest or {}).items() if not is_excluded(n, prefixes)}
    if baseline or export_all:
        files.update(p["hashes"])
    else:
        for n in to_export:
            files[n] = p["hashes"][n]
    if delete_orphans:
        for n in p["orphans"]:
            os.remove(os.path.join(folder, n + ".fbx"))
            files.pop(n, None)
        report["deletedOrphans"] = len(p["orphans"])
    save_manifest(folder, files)
    report["seconds"] = round(time.time() - started, 1)
    return report


def summary(report):
    verb = "would export" if report["dryRun"] else "exported"
    lines = ["%s %d of %d meshes to %s (%.1f s)" % (verb, len(report["export"]), report["meshes"], report["folder"], report["seconds"])]
    for name, why in sorted(report["export"].items()):
        lines.append("  %-8s %s" % (why, name))
    if report["orphans"]:
        state = "deleted" if report.get("deletedOrphans") else "no exported mesh in the .blend (removed or excluded)"
        lines.append("%d FBX with %s: %s" % (len(report["orphans"]), state, ", ".join(report["orphans"][:20]) + (" ..." if len(report["orphans"]) > 20 else "")))
    if report.get("excluded"):
        lines.append("%d meshes skipped (name starts with %s)" % (report["excluded"], " / ".join(report["exclude"])))
    for name, objs in report["duplicates"].items():
        lines.append("!! %s.fbx: several objects map to it (%s); only %s is exported" % (name, ", ".join(objs), objs[0]))
    return "\n".join(lines)


# ---------------------------------------------------------------- UI

class GOLFMAP_OT_fbx_export_changed(bpy.types.Operator):
    """Export FBX only for visible meshes that changed since the last export"""
    bl_idname = "golfmap.fbx_export_changed"
    bl_label = "Export changed FBX"
    bl_options = {"REGISTER"}

    dry_run: bpy.props.BoolProperty(name="Dry run", default=False)

    def execute(self, context):
        return _operate(self, context, dry_run=self.dry_run)


class GOLFMAP_OT_fbx_mark_exported(bpy.types.Operator):
    """Record every visible mesh as exported without writing FBX (use when the folder already matches the .blend)"""
    bl_idname = "golfmap.fbx_mark_exported"
    bl_label = "Mark all as exported"
    bl_options = {"REGISTER"}

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        return _operate(self, context, baseline=True)


class GOLFMAP_OT_fbx_export_all(bpy.types.Operator):
    """Export every visible mesh and record it (same result as OPCD's Batch Export)"""
    bl_idname = "golfmap.fbx_export_all"
    bl_label = "Export all FBX"
    bl_options = {"REGISTER"}

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        return _operate(self, context, export_all=True)


def _operate(op, context, **kwargs):
    try:
        prefs = _prefs()
        report = run(context, folder=context.scene.golfmap_fbx_folder or None,
                     delete_orphans=context.scene.golfmap_fbx_delete_orphans,
                     exclude=prefs.exclude if prefs else DEFAULT_EXCLUDE, **kwargs)
    except RuntimeError as e:
        op.report({"ERROR"}, str(e))
        return {"CANCELLED"}
    prefs = _prefs()
    if prefs and not report["dryRun"] and prefs.folder != report["folder"]:
        prefs.folder = report["folder"]
        context.preferences.is_dirty = True
    text = summary(report)
    print("[GolfMap FBX sync]\n" + text)
    op.report({"INFO"}, text.splitlines()[0] + " (details in the system console)")
    return {"FINISHED"}


class GOLFMAP_PT_fbx_sync(bpy.types.Panel):
    bl_label = "FBX Sync"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "GolfMap"

    def draw(self, context):
        scene = context.scene
        col = self.layout.column()
        col.prop(scene, "golfmap_fbx_folder", text="Folder")
        try:
            col.label(text=export_folder(scene, scene.golfmap_fbx_folder or None), icon="FILE_FOLDER")
        except RuntimeError as e:
            col.label(text=str(e), icon="ERROR")
        col.operator(GOLFMAP_OT_fbx_export_changed.bl_idname, icon="EXPORT")
        col.operator(GOLFMAP_OT_fbx_export_changed.bl_idname, text="Preview (dry run)", icon="VIEWZOOM").dry_run = True
        col.prop(scene, "golfmap_fbx_delete_orphans")
        prefs = _prefs()
        if prefs:
            col.prop(prefs, "exclude", text="Skip")
        col.separator()
        col.operator(GOLFMAP_OT_fbx_mark_exported.bl_idname, icon="CHECKMARK")
        col.operator(GOLFMAP_OT_fbx_export_all.bl_idname, icon="FILE_REFRESH")


class GolfMapFbxSyncPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__

    folder: bpy.props.StringProperty(
        name="Last FBX folder", subtype="DIR_PATH", default="",
        description="Used when the .blend names no folder (OPCD regenerates the file without it); set by every export")

    exclude: bpy.props.StringProperty(
        name="Skip meshes starting with", default=DEFAULT_EXCLUDE,
        description="Comma-separated name prefixes never exported; their FBX already in the folder are deleted like removed meshes")

    def draw(self, context):
        self.layout.prop(self, "folder")
        self.layout.prop(self, "exclude")


CLASSES = (GolfMapFbxSyncPreferences, GOLFMAP_OT_fbx_export_changed, GOLFMAP_OT_fbx_mark_exported, GOLFMAP_OT_fbx_export_all, GOLFMAP_PT_fbx_sync)


def register():
    bpy.types.Scene.golfmap_fbx_folder = bpy.props.StringProperty(
        name="FBX folder", subtype="DIR_PATH", default="",
        description="Empty: the OPCD tools' export folder, else the last folder used, else <blend folder>/fbx")
    bpy.types.Scene.golfmap_fbx_delete_orphans = bpy.props.BoolProperty(
        name="Delete FBX of removed meshes", default=True,
        description="Delete FBX files in the folder whose mesh object no longer exists in the .blend (the Unity sync then removes their scene objects)")
    for cls in CLASSES:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
    del bpy.types.Scene.golfmap_fbx_folder
    del bpy.types.Scene.golfmap_fbx_delete_orphans


def main(argv):
    parser = argparse.ArgumentParser(prog="fbx_sync.py")
    parser.add_argument("--folder")
    parser.add_argument("--dry-run", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--baseline", action="store_true", help="record the current state, export only missing files")
    mode.add_argument("--all", action="store_true", help="export every visible mesh")
    parser.add_argument("--keep-orphans", action="store_true", help="keep FBX whose mesh is no longer in the .blend")
    parser.add_argument("--exclude", default=DEFAULT_EXCLUDE, help="comma-separated name prefixes never exported (default %(default)s)")
    parser.add_argument("--json", help="also write the report here")
    args = parser.parse_args(argv)
    report = run(bpy.context, folder=args.folder, dry_run=args.dry_run, baseline=args.baseline,
                 export_all=args.all, delete_orphans=not args.keep_orphans, exclude=args.exclude)
    print(summary(report))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
