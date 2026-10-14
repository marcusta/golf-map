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
        [--no-conform-cache] [--conform-cache-dir <folder>]

**Conform cache.** A regenerated course `.blend` is mostly the same flat meshes under new names, but
the conform used to run again for all of them (2.5 minutes on Vreta). So instead of pressing Conform
to Terrain once for the whole scene, prepare runs the operator's own per-object body (the add-on's
`flatten_mesh` / `project_mesh` / `fix_failed_projections`, in the operator's order) and caches each
mesh's result in `<blend folder>/shaping-staging/conform-cache/`, keyed on

- the mesh's whole pre-conform state (`shape_apply.capture_state`, so positions, topology, paint,
  normals, props - not its name) **and its modifier stack** (names + types), which `capture_state`
  does not see and the conform clears before flattening;
- the *env*: the conform button, Terrain Smooth, the seed, the add-on + engine sources, the terrain
  OBJ's content hash, and the state hash of every object a mesh can be projected onto
  (`CONFORM_TARGETS` = `Outer` for Outerplot meshes, `Terrain` for Spline ones; `target_fingerprints`).
  The OBJ's hash alone does not cover `Outer`, which OPCD builds inside the `.blend`.

A hit clears the mesh's modifiers (as the operator does), writes the stored arrays back onto it and
adds the stored `fixed` count - how many vertices Afrod's retry nudged when the result was computed -
into the report, so a warm run's `fixFailedProjections` reads exactly like the cold run's. A miss
conforms and stores both. Afrod's retry nudges are seeded per mesh from that state hash instead of
once per run, so one mesh's result never depends on the ones before it (identical on Vreta: nothing
fails to project). `--no-conform-cache` (or `GOLFMAP_PREPARE_NO_CONFORM_CACHE=1`) presses the operator
button as before; the cache is also skipped for a scene with pot bunkers, whose rename pass only the
operator does.

**Terrain sidecar.** Every run (cache or not) writes `<name>.conformed.terrain.json`: the content sha
of the terrain.obj the conformed `.blend` holds. `terrain.obj` is regenerated from each DEM export
(`terrain_obj.py`), so its mtime moves on its own - `shape_worker.conformed_stale` compares the sha,
not the mtime, and re-prepares only when the terrain really changed.
"""

import argparse
import hashlib
import json
import os
import random
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import shape_apply as sa  # noqa: E402  (capture_state / apply_state / state_hash / OpCache)

FORMAT = "golfmap-shape-prepare-v1"
CACHE_FORMAT = "golfmap-conform-cache-v1"
TERRAIN_SIDECAR_FORMAT = "golfmap-conformed-terrain-v1"
# OPCD's flatten_mesh lowers every vertex by this much before projecting; a vertex the projection
# misses stays there (Afrod's fix_failed_projections looks for exactly this depth, within 1 cm).
FLATTEN_DEPTH = 100.0
FAILED_TOL = 0.01
OPCD_MODULE = "bl_ext.user_default.opcd_blender_tools"
AFROD_MODULE = OPCD_MODULE + ".operators.afrod.afrod_operators"
OPCD_UTILS_MODULE = OPCD_MODULE + ".utils.mesh_utils"


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


def _tool_props(conform_op):
    scene = bpy.context.scene
    return scene.opcdtools if conform_op == "afrod" else scene.opcd_tools


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


# ---------------------------------------------------------------- per-mesh conform cache


def cache_dir_for(blend_path):
    return os.path.join(os.path.dirname(os.path.abspath(blend_path)), "shaping-staging", "conform-cache")


def _module(name):
    mod = sys.modules.get(name)
    if mod is None:
        import importlib
        mod = importlib.import_module(name)
    return mod


def terrain_fingerprint(path, folder):
    """A content hash of the terrain OBJ, remembered per (size, mtime) in `folder` so a re-run does not
    read 644 MB again. Content, not mtime: a terrain.obj rewritten from the same heightmap
    (`terrain_obj.py`) must keep the cache."""
    st = os.stat(path)
    tag = "%d:%d" % (st.st_size, st.st_mtime_ns)
    index = os.path.join(folder, "terrain-hash.json")
    try:
        with open(index, encoding="utf-8") as f:
            known = json.load(f)
    except (OSError, ValueError):
        known = {}
    if known.get(path, {}).get("tag") == tag:
        return known[path]["sha1"], 0.0
    t0 = time.time()
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    sha = h.hexdigest()
    known[path] = {"tag": tag, "sha1": sha, "bytes": st.st_size}
    os.makedirs(folder, exist_ok=True)
    try:
        with open(index, "w", encoding="utf-8") as f:
            json.dump(known, f, indent=1)
    except OSError:
        pass
    return sha, time.time() - t0


def terrain_sidecar_path(blend_path):
    """Where a conformed .blend records the terrain.obj it was conformed against."""
    return os.path.splitext(blend_path)[0] + ".terrain.json"


def write_terrain_sidecar(out_path, source, terrain_path, terrain_sha, targets=None):
    """Write that sidecar next to `<name>.conformed.blend`; returns its path (None when it cannot be
    written - it is only a cache hint).

    `terrain.obj` is regenerated from every DEM export (`terrain_obj.py`), so its mtime moves on its own.
    The content sha here is what `shape_worker.conformed_stale` compares: a terrain rewritten from the
    same heightmap keeps the conformed cache, a changed one makes it stale."""
    doc = {"format": TERRAIN_SIDECAR_FORMAT, "blend": os.path.abspath(out_path), "source": source,
           "terrainObj": os.path.abspath(terrain_path), "terrainSha": terrain_sha,
           "conformTargets": targets or {},
           "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())}
    path = terrain_sidecar_path(out_path)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
    except OSError as e:
        print(f"[shape_prepare] could not write {path}: {e}")
        return None
    return path


def read_terrain_sidecar(blend_path):
    """That sidecar, or {} when it is missing or unreadable."""
    try:
        with open(terrain_sidecar_path(blend_path), encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) and doc.get("format") == TERRAIN_SIDECAR_FORMAT else {}


def cache_env_key(conform_op, terrain_sha, terrain_smooth, seed, targets=None):
    """Everything besides the mesh itself that decides what the conform makes of it: the engine, Blender,
    the add-on sources, the conform button, Terrain Smooth, the seed, the terrain OBJ's content hash - and
    `targets`, the state of every object a mesh can be projected onto (`target_fingerprints`)."""
    parts = [CACHE_FORMAT, sa.ENGINE_VERSION, bpy.app.version_string, conform_op,
             "smooth=%.6f" % terrain_smooth, "terrain=" + terrain_sha, "seed=%d" % seed,
             "prepare:" + str(sa._file_sha(os.path.abspath(__file__)))]
    for name in (AFROD_MODULE, OPCD_UTILS_MODULE):
        mod = sys.modules.get(name)
        parts.append(name + ":" + str(sa._file_sha(getattr(mod, "__file__", "") or "") if mod else None))
    parts.append("targets=" + json.dumps(targets or {}, sort_keys=True))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()


# Every object a mesh can be shrinkwrapped onto: the Afrod loop projects Outerplot meshes onto "Outer"
# (OPCD's outer-plot terrain, built inside the .blend) and Spline meshes onto "Terrain" (terrain.obj).
# All of them are hashed into the env key - the terrain OBJ's content hash alone does not cover "Outer",
# so a replaced outer terrain would otherwise still be served the old results.
CONFORM_TARGETS = ("Outer", "Terrain")


def _conform_target(obj):
    return "Outer" if "Outerplot" in obj.name else "Terrain"


def target_fingerprints():
    """(state hash per `CONFORM_TARGETS` object - None when the scene has none, seconds it cost).

    The Shrinkwrap's result is decided by the target's geometry, so the cache's env key must carry it,
    whole (`shape_apply.capture_state`: positions, topology, the matrix), not just the OBJ the Terrain was
    imported from."""
    t0 = time.time()
    out = {}
    for name in CONFORM_TARGETS:
        obj = bpy.data.objects.get(name)
        out[name] = sa.state_hash(*sa.capture_state(obj)) if obj is not None and obj.type == "MESH" else None
    return out, time.time() - t0


def _conform_funcs(conform_op):
    """The add-on's own per-object conform, exactly as its Conform to Terrain loop calls it."""
    if conform_op == "afrod":
        mod = _module(AFROD_MODULE)
        return mod.flatten_mesh, mod.project_mesh, mod.fix_failed_projections
    mod = _module(OPCD_UTILS_MODULE)
    return mod.flatten_mesh, mod.project_mesh, None


def _conform_one(obj, funcs):
    flatten, project, fix_failed = funcs
    if obj.modifiers:
        obj.modifiers.clear()
    flatten(obj)
    project(obj, _conform_target(obj))
    bpy.ops.object.convert(target="MESH")  # apply the Shrinkwrap
    if fix_failed is not None:
        fix_failed(obj, "Terrain")


def conform_reach(conform_op, limit_targets=None):
    """The objects the chosen Conform All button iterates. OPCD Base filters on the name; Afrod Mod's
    filter is `'Spline' or 'Outerplot' in o.name and ...`, which is always true, so it walks every
    visible object (it conforms the Spline/Outerplot ones and converts the rest)."""
    if limit_targets is not None:
        return list(limit_targets)
    visible = [o for o in bpy.context.visible_objects if o.type == "MESH"]
    if conform_op == "afrod":
        return visible
    return [o for o in visible if ("Spline" in o.name or "Outerplot" in o.name)
            and "WaterPlane" not in o.name and "Potwall" not in o.name]


def conform_cached(reach, conform_op, override, seed, cache, env, verify_full=False, fixed=None):
    """Conform every mesh in `reach` through the cache. Returns the cache stats.

    `fixed` is the dict `_count_fix_failed` fills on a miss; a hit adds the count stored with the cached
    result back into it, so the report of a warm run says exactly what a cold run's does."""
    funcs = _conform_funcs(conform_op)
    stats = {"meshes": 0, "hits": 0, "misses": 0, "converted": 0, "renamedHits": 0, "mismatches": [],
             "fixedHits": 0, "modifiersCleared": 0,
             "hashS": 0.0, "replayS": 0.0, "computeS": 0.0, "storeS": 0.0, "storedBytes": 0}
    order = sorted(reach, key=lambda o: o.name)
    with bpy.context.temp_override(**override):
        if bpy.context.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
    previous = None
    for obj in order:
        with bpy.context.temp_override(**override):
            if previous is not None:  # the operator deselects all; one object at a time is the same
                previous.select_set(False)
            obj.select_set(True)
            previous = obj
            bpy.context.view_layer.objects.active = obj
            if "Spline" not in obj.name and "Outerplot" not in obj.name:
                # what the Afrod loop still does to such an object
                bpy.ops.object.convert(target="MESH")
                stats["converted"] += 1
                continue
            stats["meshes"] += 1
            t0 = time.time()
            meta_in, arr_in = sa.capture_state(obj)
            sha_in = sa.state_hash(meta_in, arr_in)
            stats["hashS"] += time.time() - t0
            # capture_state does not see modifiers and the conform clears them before flattening, so two
            # inputs that differ only in their stack are different inputs: the stack goes in the key.
            mods = ",".join("%s:%s" % (m.name, m.type) for m in obj.modifiers)
            key = hashlib.sha1("|".join((env, _conform_target(obj), sha_in, "mods=" + mods)).encode()).hexdigest()
            entry = cache.load(key)
            if entry is not None:
                t0 = time.time()
                if obj.modifiers:  # exactly as the operator - and the miss path - does before flatten/project
                    obj.modifiers.clear()
                    stats["modifiersCleared"] += 1
                ok = _replay(obj, entry, arr_in, verify_full)
                stats["replayS"] += time.time() - t0
                if ok:
                    stats["hits"] += 1
                    # the key is the mesh's state, not its name: a regenerated .blend that renamed or
                    # renumbered an otherwise identical mesh still hits
                    stats["renamedHits"] += int(entry[0].get("object") != obj.name)
                    n_fixed = int(entry[0].get("fixed") or 0)
                    if n_fixed:
                        stats["fixedHits"] += 1
                        if fixed is not None:  # the retry the cached result already carries, in the report
                            fixed[obj.name] = fixed.get(obj.name, 0) + n_fixed
                    continue
                stats["mismatches"].append(obj.name)
                sa.apply_state(obj.name, meta_in, arr_in)  # put the input back, then compute
                obj = bpy.data.objects[obj.name]
                bpy.context.view_layer.objects.active = obj
            t0 = time.time()
            random.seed(sha_in + ":%d" % seed)  # per mesh: no mesh depends on the ones before it
            was_fixed = (fixed or {}).get(obj.name, 0)
            _conform_one(obj, funcs)
            n_fixed = (fixed or {}).get(obj.name, 0) - was_fixed
            stats["misses"] += 1
            stats["computeS"] += time.time() - t0
            t0 = time.time()
            stats["storedBytes"] += _store(cache, key, obj, meta_in, arr_in, sha_in, n_fixed)
            stats["storeS"] += time.time() - t0
    for k in ("hashS", "replayS", "computeS", "storeS"):
        stats[k] = round(stats[k], 1)
    return stats


def _store(cache, key, obj, meta_in, arr_in, sha_in, n_fixed=0):
    """Keep this mesh's conform result. `fixed` is how many vertices Afrod's retry had to nudge: the
    arrays carry the nudge, but only the count makes a hit's report read like the miss that stored it."""
    meta_out, arr_out = sa.capture_state(obj)
    changed = {k: v for k, v in arr_out.items()
               if k not in arr_in or not np.array_equal(v, arr_in[k])}
    meta = {"format": CACHE_FORMAT, "object": obj.name, "target": _conform_target(obj),
            "in": sha_in, "out": sa.state_hash(meta_out, arr_out), "meta": meta_out,
            "fixed": int(n_fixed), "arrayKeys": sorted(arr_out), "changed": sorted(changed)}
    cache.store(key, meta, changed)
    try:
        return os.path.getsize(cache.path(key))
    except OSError:
        return 0


def _replay(obj, entry, arr_in, verify_full):
    """Write a cached conform result onto `obj`: the stored arrays over the ones the conform left alone."""
    meta, stored = entry
    if meta.get("format") != CACHE_FORMAT:
        return False
    arrays = {}
    for k in meta["arrayKeys"]:
        if k in stored:
            arrays[k] = stored[k]
        elif k in arr_in:
            arrays[k] = arr_in[k]
        else:
            return False
    sa.apply_state(obj.name, meta["meta"], arrays)
    out = bpy.data.objects[obj.name]
    if verify_full:
        return sa.state_hash(*sa.capture_state(out)) == meta["out"]
    co = sa.positions(out)
    want = arrays[sa.POSITION_KEY].reshape(-1, 3)
    return co.shape == want.shape and np.array_equal(co.astype(np.float32), want.astype(np.float32))


def _bounds(obj):
    co = np.empty(len(obj.data.vertices) * 3, np.float64)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(obj.matrix_world, np.float64)
    w = co @ m[:3, :3].T + m[:3, 3]
    return [round(float(v), 3) for v in (*w.min(0), *w.max(0))]


def run(terrain_path, out_path, conform_op="afrod", limit=None, seed=0, cache=True, cache_dir=None):
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

    if os.environ.get("GOLFMAP_PREPARE_NO_CONFORM_CACHE"):
        cache = False
    cache_report = {"used": False}
    pot = sorted(o.name for o in bpy.context.visible_objects if "Pot" in o.name and "Potwall" not in o.name)
    if cache and pot:
        cache_report["skipped"] = f"{len(pot)} pot bunkers in the scene: only the operator renames those"
        cache = False
    cache_dir = cache_dir or cache_dir_for(source)

    # Always: the sidecar next to the conformed .blend records which terrain.obj it holds, so the worker
    # can tell a regenerated terrain from a rewritten one without a cache (`shape_worker.conformed_stale`).
    terrain_sha, terrain_hash_s = terrain_fingerprint(terrain_path, cache_dir)
    conform_targets, targets_hash_s = {}, 0.0

    t0 = time.time()
    fixed, restore = _count_fix_failed() if conform_op == "afrod" else (None, lambda: None)
    try:
        if cache:
            conform_targets, targets_hash_s = target_fingerprints()
            env = cache_env_key(conform_op, terrain_sha, float(_tool_props(conform_op).terrainsmooth), seed,
                                conform_targets)
            reach = conform_reach(conform_op, targets if limit else None)
            print(f"[shape_prepare] conform cache {cache_dir} (env {env[:12]}, {len(reach)} objects)")
            stats = conform_cached(reach, conform_op, override, seed, sa.OpCache(cache_dir), env,
                                   verify_full=bool(os.environ.get("GOLFMAP_PREPARE_VERIFY_CACHE")),
                                   fixed=fixed)
            cache_report = dict(stats, used=True, dir=cache_dir, env=env, terrainSha=terrain_sha,
                                terrainHashS=round(terrain_hash_s, 1), targets=conform_targets,
                                targetHashS=round(targets_hash_s, 1))
            _tool_props(conform_op).conform_selection_type = "Selected"  # as the operator leaves it
        else:
            conform(targets, conform_op, all_meshes=not limit, override=override, seed=seed)
    finally:
        restore()
    t_conform = time.time() - t0
    print(f"[shape_prepare] conformed {len(targets)} meshes in {t_conform:.1f} s"
          + (" (cache: %d hits, %d misses)" % (cache_report["hits"], cache_report["misses"]) if cache else ""))

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
    sidecar = write_terrain_sidecar(out_path, source, terrain_path, terrain_sha, conform_targets)

    return {
        "format": FORMAT,
        "source": source,
        "out": os.path.abspath(out_path),
        "terrainObj": os.path.abspath(terrain_path),
        "terrainSha": terrain_sha,
        "terrainSidecar": sidecar,
        "conformTargets": conform_targets,
        "conformOp": ("wm.projectmesh (Afrod Mod v4)" if conform_op == "afrod" else "opcd.projectmesh (OPCD Base)")
                     + (", per mesh through the conform cache" if cache_report["used"] else ""),
        "cache": cache_report,
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
    c = report.get("cache") or {}
    if c.get("used"):
        lines.append("Conform cache: {hits} hits ({renamedHits} of them stored under another name), {misses} misses "
                     "of {meshes} meshes ({converted} only converted); "
                     "hash {hashS} s, replay {replayS} s, compute {computeS} s, store {storeS} s "
                     "({storedBytes:.0f} MB written)".format(**dict(c, storedBytes=c["storedBytes"] / 1e6)))
        lines.append("  conform targets {}; hashed in {} s{}".format(
            ", ".join("%s %s" % (k, (v or "-")[:12]) for k, v in sorted((c.get("targets") or {}).items())) or "none",
            c.get("targetHashS"),
            "; modifiers cleared on %d hits" % c["modifiersCleared"] if c.get("modifiersCleared") else ""))
        if c["mismatches"]:
            lines.append(f"  !! {len(c['mismatches'])} cached results did not verify and were recomputed: "
                         f"{c['mismatches'][:5]}")
    elif c.get("skipped"):
        lines.append("Conform cache off: " + c["skipped"])
    if report.get("terrainSha"):
        lines.append(f"terrain.obj sha {report['terrainSha'][:12]}"
                     + (f" -> {report['terrainSidecar']}" if report.get("terrainSidecar") else ""))
    fx = report["fixFailedProjections"]
    if fx is not None:
        lines.append(f"fix_failed_projections found {fx['vertices']} missed vertices in {fx['objects']} objects"
                     + (" (%d of them replayed from the cache)" % c["fixedHits"] if c.get("fixedHits") else ""))
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
    parser.add_argument("--no-conform-cache", action="store_true",
                        help="press the Conform to Terrain button for the whole scene instead of the per-mesh cache")
    parser.add_argument("--conform-cache-dir", help="default <blend folder>/shaping-staging/conform-cache")
    args = parser.parse_args(argv)
    source = bpy.path.abspath(bpy.data.filepath)
    folder, name = os.path.split(source)
    terrain = args.terrain or os.path.join(folder, "terrain.obj")
    out = args.out or os.path.join(folder, os.path.splitext(name)[0] + ".conformed.blend")
    report = run(terrain, out, conform_op=args.conform, limit=args.limit, seed=args.seed,
                 cache=not args.no_conform_cache, cache_dir=args.conform_cache_dir)
    print("[shape_prepare]\n" + summary(report))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
