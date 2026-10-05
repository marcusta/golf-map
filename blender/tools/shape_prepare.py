"""Shaping, step 2 "Prepare": import terrain.obj and conform every Spline mesh, into a derived file.

A fresh OPCD course .blend (built from a golf-map SVG) has every Spline_* mesh flat at z~0 and no
Terrain object. This opens it headless, then presses OPCD's own buttons (blender/SHAPING-PLAN.md):

1. OPCD Base > Terrain Manager > **Import Terrain OBJ** (`opcd.convertterrain`): OBJ import, object
   named Terrain, Smooth modifier (factor = the scene's Terrain Smooth, OPCD default 1.5) applied,
   transforms applied, hidden.
2. **Conform to Terrain** with Selection = All: by default the Afrod Mod v4 button (`wm.projectmesh`):
   per mesh, clear modifiers, lower by 100 m, Shrinkwrap/Project +Z onto Terrain, apply, then Afrod's
   `fix_failed_projections` (vertices still at the flatten depth get a 1 cm random nudge and are
   projected again). `--conform opcd` uses the OPCD Base button (`opcd.projectmesh`, no retry).
   Python's `random` is seeded (`--seed`) so the nudges, and the file, are the same every run.

The operators need a 3D View (`space_data`), so they run under a context override of the file's
Layout screen; background Blender has a window but no undo stack, so the per-object operator calls
cost no undo pushes. The result is saved as a copy, `<name>.conformed.blend` next to the source
(`--out`); the source .blend is never saved. Report (`--json`): counts, vertices left at the flatten
depth (per object), timings, Terrain bounds.

    blender -b course.blend --python blender/tools/shape_prepare.py -- \
        [--terrain <terrain.obj>] [--out <file.blend>] [--json <report.json>] [--conform afrod|opcd]
        [--limit N]   # smoke test: conform only the first N Spline meshes (Selection = Selected)
"""

import argparse
import json
import os
import random
import sys
import time

import bpy
import numpy as np

FORMAT = "golfmap-shape-prepare-v1"
# OPCD's flatten_mesh lowers every vertex by this much before projecting; a vertex the projection
# misses stays there (Afrod's fix_failed_projections looks for exactly this depth, within 1 cm).
FLATTEN_DEPTH = 100.0
FAILED_TOL = 0.01
OPCD_MODULE = "bl_ext.user_default.opcd_blender_tools"
AFROD_MODULE = OPCD_MODULE + ".operators.afrod.afrod_operators"


def _view3d_override():
    """Context for operators that read space_data (OPCD's import sets the 3D View clip end)."""
    window = bpy.context.window or (bpy.context.window_manager.windows[0] if bpy.context.window_manager.windows else None)
    screens = ([window.screen] if window else []) + list(bpy.data.screens)
    for screen in screens:
        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue
            region = next((r for r in area.regions if r.type == "WINDOW"), None)
            override = {"screen": screen, "area": area, "region": region, "space_data": area.spaces.active}
            if window:
                override["window"] = window
            return override
    raise RuntimeError("no 3D View in the .blend's screens (OPCD's operators need one)")


def _z(obj):
    """World z of every vertex (objects in an OPCD course have identity transforms, but be safe)."""
    co = np.empty(len(obj.data.vertices) * 3, np.float64)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world, np.float64)
    return co @ m[2, :3] + m[2, 3]


def _count_fix_failed():
    """Wrap Afrod's fix_failed_projections to count what it finds (it prints, returns nothing)."""
    module = sys.modules.get(AFROD_MODULE)
    if module is None or not hasattr(module, "fix_failed_projections"):
        return None, lambda: None
    original = module.fix_failed_projections
    found = {}

    def counting(obj, target_name, base_z=-100):
        n = int(np.count_nonzero(np.abs(_z(obj) - base_z) < FAILED_TOL))
        if n:
            found[obj.name] = n
        return original(obj, target_name, base_z)

    module.fix_failed_projections = counting

    def restore():
        module.fix_failed_projections = original

    return found, restore


def import_terrain(path, override):
    for name in ("Terrain",):
        if name in bpy.data.objects:
            raise RuntimeError(f"the .blend already has a {name} object: prepare starts from a fresh OPCD .blend")
    with bpy.context.temp_override(**override):
        result = bpy.ops.opcd.convertterrain(filepath=path)
    if "FINISHED" not in result or "Terrain" not in bpy.data.objects:
        raise RuntimeError(f"Import Terrain OBJ failed: {result}")
    return bpy.data.objects["Terrain"]


def conform(targets, conform_op, all_meshes, override, seed):
    """Press Conform to Terrain. `targets` are the Spline meshes it will reach (for the report)."""
    scene = bpy.context.scene
    props = scene.opcdtools if conform_op == "afrod" else scene.opcd_tools
    with bpy.context.temp_override(**override):
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
    if not all_meshes:
        for o in targets:
            o.select_set(True)
    props.conform_selection_type = "All" if all_meshes else "Selected"
    random.seed(seed)
    with bpy.context.temp_override(**override):
        op = bpy.ops.wm.projectmesh if conform_op == "afrod" else bpy.ops.opcd.projectmesh
        result = op()
    if "FINISHED" not in result:
        raise RuntimeError(f"Conform to Terrain failed: {result}")


def _bounds(obj):
    co = np.empty(len(obj.data.vertices) * 3, np.float64)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world, np.float64)
    w = co @ m[:3, :3].T + m[:3, 3]
    return [round(float(v), 3) for v in (*w.min(0), *w.max(0))]


def run(terrain_path, out_path, conform_op="afrod", limit=None, seed=0):
    t_start = time.time()
    source = bpy.path.abspath(bpy.data.filepath)
    if not source:
        raise RuntimeError("open the course .blend first (blender -b course.blend --python ...)")
    if os.path.normcase(os.path.abspath(out_path)) == os.path.normcase(os.path.abspath(source)):
        raise RuntimeError("--out is the source .blend: prepare never saves the source")
    if not os.path.isfile(terrain_path):
        raise RuntimeError(f"no terrain OBJ at {terrain_path}")
    if OPCD_MODULE not in bpy.context.preferences.addons:
        raise RuntimeError(f"OPCD Mesh Editing Tools ({OPCD_MODULE}) is not enabled")
    override = _view3d_override()

    # What Conform All reaches: visible Spline meshes (OPCD also takes Outerplot; Afrod's filter takes
    # every visible object but only projects Spline/Outerplot ones). WaterPlane/Potwall are skipped.
    splines = [o for o in bpy.context.scene.objects if o.type == "MESH" and "Spline" in o.name]
    targets = [o for o in splines if o.visible_get() and "WaterPlane" not in o.name and "Potwall" not in o.name]
    targets.sort(key=lambda o: o.name)
    if limit:
        targets = targets[:limit]
    z_before = {o.name: _z(o) for o in targets}
    flat = np.concatenate(list(z_before.values())) if z_before else np.zeros(1)

    t0 = time.time()
    print(f"[shape_prepare] importing {terrain_path} ({os.path.getsize(terrain_path) / 1e6:.0f} MB)")
    terrain = import_terrain(terrain_path, override)
    t_import = time.time() - t0
    print(f"[shape_prepare] terrain imported in {t_import:.1f} s: {len(terrain.data.vertices)} vertices")

    t0 = time.time()
    fixed, restore = _count_fix_failed() if conform_op == "afrod" else (None, lambda: None)
    try:
        conform(targets, conform_op, all_meshes=not limit, override=override, seed=seed)
    finally:
        restore()
    t_conform = time.time() - t0
    print(f"[shape_prepare] conformed {len(targets)} meshes in {t_conform:.1f} s")

    failures = []
    unchanged = []
    verts = 0
    for o in targets:
        z = _z(o)
        verts += len(z)
        before = z_before[o.name]
        if len(z) != len(before):
            failures.append({"object": o.name, "error": f"vertex count changed {len(before)} -> {len(z)}"})
            continue
        n_failed = int(np.count_nonzero(np.abs(z - (before - FLATTEN_DEPTH)) < FAILED_TOL))
        if n_failed:
            failures.append({"object": o.name, "shapeId": o.get("opcd_shape_id"), "vertices": n_failed, "of": len(z)})
        if np.allclose(z, before):
            unchanged.append(o.name)

    t0 = time.time()
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out_path, copy=True)
    t_save = time.time() - t0

    return {
        "format": FORMAT,
        "source": source,
        "out": os.path.abspath(out_path),
        "terrainObj": os.path.abspath(terrain_path),
        "conformOp": "wm.projectmesh (Afrod Mod v4)" if conform_op == "afrod" else "opcd.projectmesh (OPCD Base)",
        "terrainSmooth": (bpy.context.scene.opcdtools if conform_op == "afrod" else bpy.context.scene.opcd_tools).terrainsmooth,
        "seed": seed,
        "limit": limit,
        "objects": len(bpy.context.scene.objects),
        "splineMeshes": len(splines),
        "conformed": len(targets),
        "conformedVertices": verts,
        "splineZBefore": [round(float(flat.min()), 3), round(float(flat.max()), 3)],
        "failedObjects": len([f for f in failures if "vertices" in f]),
        "failedVertices": sum(f.get("vertices", 0) for f in failures),
        "failures": failures,
        "unchanged": unchanged,
        "fixFailedProjections": None if fixed is None else {
            "objects": len(fixed), "vertices": sum(fixed.values()), "byObject": fixed},
        "terrain": {"vertices": len(terrain.data.vertices), "faces": len(terrain.data.polygons),
                    "bounds": _bounds(terrain)},
        "timings": {"importS": round(t_import, 1), "conformS": round(t_conform, 1), "saveS": round(t_save, 1),
                    "totalS": round(time.time() - t_start, 1)},
    }


def summary(report):
    t = report["timings"]
    b = report["terrain"]["bounds"]
    lines = [
        f"Conformed {report['conformed']} of {report['splineMeshes']} Spline meshes ({report['conformedVertices']} vertices) "
        f"with {report['conformOp']} -> {report['out']}",
        f"Terrain: {report['terrain']['vertices']} vertices, x {b[0]}..{b[3]}, y {b[1]}..{b[4]}, z {b[2]}..{b[5]}",
        f"Time: import {t['importS']} s, conform {t['conformS']} s, save {t['saveS']} s, total {t['totalS']} s",
    ]
    fx = report["fixFailedProjections"]
    if fx is not None:
        lines.append(f"fix_failed_projections found {fx['vertices']} missed vertices in {fx['objects']} objects")
    lines.append(f"Left at the flatten depth: {report['failedVertices']} vertices in {report['failedObjects']} objects")
    for f in report["failures"][:20]:
        lines.append(f"  !! {f['object']}: {f.get('error') or str(f['vertices']) + ' of ' + str(f['of'])}")
    if report["unchanged"]:
        lines.append(f"Not moved at all: {len(report['unchanged'])} meshes, e.g. {report['unchanged'][:5]}")
    return "\n".join(lines)


def main(argv):
    parser = argparse.ArgumentParser(prog="shape_prepare.py")
    parser.add_argument("--terrain", help="terrain OBJ (default: terrain.obj next to the .blend)")
    parser.add_argument("--out", help="derived .blend (default: <name>.conformed.blend next to the source)")
    parser.add_argument("--json", help="also write the report here")
    parser.add_argument("--conform", choices=("afrod", "opcd"), default="afrod",
                        help="which Conform to Terrain button: Afrod Mod v4 (with the failed-projection retry, default) or OPCD Base")
    parser.add_argument("--limit", type=int, help="smoke test: conform only the first N Spline meshes (by name)")
    parser.add_argument("--seed", type=int, default=0, help="seed for Afrod's random nudges (default %(default)s)")
    args = parser.parse_args(argv)
    source = bpy.path.abspath(bpy.data.filepath)
    folder, name = os.path.split(source)
    terrain = args.terrain or os.path.join(folder, "terrain.obj")
    out = args.out or os.path.join(folder, os.path.splitext(name)[0] + ".conformed.blend")
    report = run(terrain, out, conform_op=args.conform, limit=args.limit, seed=args.seed)
    print("[shape_prepare]\n" + summary(report))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
