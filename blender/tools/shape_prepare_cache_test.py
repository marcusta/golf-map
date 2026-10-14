"""The per-mesh conform cache, on a synthetic scene: what the key covers, what a hit restores.

Vreta cannot show any of this - nothing there fails to project, no mesh arrives with a modifier and the
scene has no `Outer`. So this builds a four-object course by hand (a tilted `Terrain`, a flat `Outer`, two
Spline meshes - one of them hanging off the terrain so Afrod's retry fires - and an `Outerplot` mesh that
projects onto `Outer`) and runs `shape_prepare.conform_cached` over it several times against one cache:

1. cold: every mesh a miss;
2. warm, same inputs: every mesh a hit, the same state hashes, the same `fix_failed_projections` report,
   and no modifier left on the mesh that arrived with one;
3. the same mesh with another modifier stack: a miss, because the conform clears the stack and
   `capture_state` cannot see it;
4. `Outer` replaced: another env key, so the Outerplot mesh is conformed again onto the new one.

Needs the OPCD add-on (Afrod's `flatten_mesh` / `project_mesh` / `fix_failed_projections`), so no
--factory-startup. Run from the repository root:
    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python-exit-code 1 --python blender/tools/shape_prepare_cache_test.py
"""
import os
import sys
import tempfile

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_apply as sa  # noqa: E402
import shape_prepare as sp  # noqa: E402

FAILED = []
SMOOTH = 1.5
SEED = 0
TERRAIN_SHA = "t" * 40   # stands in for the OBJ's content hash: the same in every run here
A = "Spline_Fairway_A_-_Mesh"
B = "Spline_Green_B_-_Mesh"
C = "Outerplot_1"


def check(what, got, want):
    ok = got == want
    print(("  ok   " if ok else "  FAIL ") + what + ("" if ok else f"  got {got!r}, want {want!r}"))
    if not ok:
        FAILED.append(what)


def grid(name, x0, y0, x1, y1, zf, n=4):
    me = bpy.data.meshes.new(name)
    xs = [x0 + (x1 - x0) * i / n for i in range(n + 1)]
    ys = [y0 + (y1 - y0) * j / n for j in range(n + 1)]
    verts = [(x, y, zf(x, y)) for y in ys for x in xs]
    faces = [(j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i)
             for j in range(n) for i in range(n)]
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build(modifier=None, outer_z=3.0):
    """A fresh scene. `modifier` is a modifier type put on mesh A (as a regenerated .blend can arrive with
    one); `outer_z` is the height of the outer-plot terrain the Outerplot mesh projects onto."""
    bpy.ops.wm.read_homefile(use_empty=True)
    for o in (grid("Terrain", 0, 0, 20, 20, lambda x, y: 5.0 + 0.05 * x + 0.02 * y, n=8),
              grid("Outer", 30, 0, 50, 20, lambda x, y: outer_z, n=4)):
        o.hide_set(True)                      # as OPCD's import leaves the terrain
    a = grid(A, 2, 2, 10, 10, lambda x, y: 0.0)
    grid(B, 15, 2, 25, 10, lambda x, y: 0.0)  # half of it hangs off the Terrain: those verts fail
    grid(C, 32, 2, 48, 10, lambda x, y: 0.0)
    if modifier:
        a.modifiers.new("Arrived", modifier)
    return a


def run(cache_dir, modifier=None, outer_z=3.0):
    """Conform the scene through the cache once.
    Returns (stats, fix report, state hash per object, env key, conform-target hashes)."""
    build(modifier=modifier, outer_z=outer_z)
    override = sp._view3d_override()
    targets, _ = sp.target_fingerprints()
    env = sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED, targets)
    fixed, restore = sp._count_fix_failed()
    if fixed is None:
        raise RuntimeError("Afrod's fix_failed_projections is not loaded: is the OPCD add-on enabled?")
    try:
        stats = sp.conform_cached(sp.conform_reach("afrod"), "afrod", override, SEED,
                                  sa.OpCache(cache_dir), env, fixed=fixed)
    finally:
        restore()
    hashes = {o.name: sa.state_hash(*sa.capture_state(o))
              for o in bpy.data.objects if o.type == "MESH" and o.name in (A, B, C)}
    return stats, dict(fixed), hashes, env, targets


def z_of(name):
    return [round(v.co.z, 4) for v in bpy.data.objects[name].data.vertices]


with tempfile.TemporaryDirectory(prefix="golfmap_conform_cache_") as folder:
    cache_dir = os.path.join(folder, "conform-cache")

    # 1. Cold. Mesh A arrives with a modifier; the conform clears it before flattening.
    cold, fixed_cold, hash_cold, env, targets_cold = run(cache_dir, modifier="SMOOTH")
    check("cold: three meshes, all misses", (cold["meshes"], cold["hits"], cold["misses"]), (3, 0, 3))
    check("cold: the modifier the mesh arrived with is gone", len(bpy.data.objects[A].modifiers), 0)
    check("cold: Afrod's retry fired on the mesh hanging off the terrain", sorted(fixed_cold), [B])
    check("cold: and nudged more than one vertex", fixed_cold[B] > 1, True)
    check("cold: the Outerplot mesh landed on Outer", set(z_of(C)), {3.0})

    # 2. Warm, the same inputs: hits, and a report a cold run would not tell apart.
    warm, fixed_warm, hash_warm, env_warm, _ = run(cache_dir, modifier="SMOOTH")
    check("warm: the env key is unchanged", env_warm, env)
    check("warm: three meshes, all hits", (warm["meshes"], warm["hits"], warm["misses"]), (3, 3, 0))
    check("warm: every state hash is the cold one", hash_warm, hash_cold)
    check("warm: fix_failed_projections says exactly what the cold run said", fixed_warm, fixed_cold)
    check("warm: counted as a replayed retry", (warm["fixedHits"], warm["mismatches"]), (1, []))
    check("warm: the hit cleared the modifier the mesh arrived with",
          (warm["modifiersCleared"], len(bpy.data.objects[A].modifiers)), (1, 0))

    # 3. The same mesh, another stack. capture_state cannot see modifiers, so only the key's own
    #    modifier signature keeps this from being served A's result under a stack that was cleared.
    other, fixed_other, hash_other, _, _ = run(cache_dir, modifier="SUBSURF")
    check("another modifier stack: that mesh is a miss, the other two still hit",
          (other["hits"], other["misses"]), (2, 1))
    check("and its result is the same (the stack is cleared either way)", hash_other[A], hash_cold[A])
    none, fixed_none, hash_none, _, _ = run(cache_dir, modifier=None)
    check("no modifier at all: a third key, same result", (none["misses"], hash_none[A]), (1, hash_cold[A]))
    check("the retry report holds through all of it", (fixed_other, fixed_none), (fixed_cold, fixed_cold))

    # 4. A replaced outer terrain. Nothing about terrain.obj, the button, the smooth or the seed changed -
    #    only the object the Outerplot mesh is shrinkwrapped onto - so only the targets in the env key can
    #    tell the cache that its results are stale.
    lifted, _, hash_lifted, env_lifted, targets_lifted = run(cache_dir, modifier=None, outer_z=3.5)
    check("a replaced Outer is another target hash", targets_lifted["Outer"] != targets_cold["Outer"], True)
    check("  and so another env key", env_lifted != env, True)
    check("  while the key without the targets - what it used to be - cannot tell the two apart",
          sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED),
          sp.cache_env_key("afrod", TERRAIN_SHA, SMOOTH, SEED))
    check("so every mesh is conformed again", (lifted["hits"], lifted["misses"]), (0, 3))
    check("and the Outerplot mesh is on the new Outer", set(z_of(C)), {3.5})
    check("while the Spline meshes come out as before",
          (hash_lifted[A], hash_lifted[B]), (hash_cold[A], hash_cold[B]))

print(("FAILED: " + ", ".join(FAILED)) if FAILED else "all conform cache checks passed")
sys.exit(1 if FAILED else 0)
