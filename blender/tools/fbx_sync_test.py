"""Headless check of fbx_sync.py on a course .blend (read-only; exports into a temp folder).

    blender -b course.blend --python-exit-code 1 --python blender/tools/fbx_sync_test.py [-- --compare <OPCD fbx folder>]

Keeps five meshes visible, then: export all, re-run (nothing), edit a vertex and move an
object (both re-exported, the rest untouched), delete an FBX (re-exported), rename an object
(new file exported, old one an orphan, deleted on request). --compare checks the exported
files against OPCD's Batch Export of the same objects (same size: FBX differ only in the
timestamp header).
"""

import os
import sys
import tempfile

import bpy

# Load this folder's fbx_sync.py by path: an installed copy of the add-on is already imported as "fbx_sync".
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location("fbx_sync_under_test", os.path.join(os.path.dirname(os.path.abspath(__file__)), "fbx_sync.py"))
fbx_sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fbx_sync)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
compare = argv[argv.index("--compare") + 1] if "--compare" in argv else None
ctx = bpy.context
folder = tempfile.mkdtemp(prefix="fbx_sync_test_")

meshes = sorted((o for o in ctx.visible_objects if o.type == "MESH" and not o.name.startswith("Gap_Issue")), key=lambda o: len(o.data.vertices))
keep = meshes[:5]
for o in ctx.visible_objects:
    if o not in keep:
        o.hide_set(True)
names = [fbx_sync.file_name(o) for o in keep]


def run(**kw):
    return fbx_sync.run(ctx, folder=folder, **kw)


def mtimes():
    return {n: os.stat(os.path.join(folder, n + ".fbx")).st_mtime_ns for n in names if os.path.exists(os.path.join(folder, n + ".fbx"))}


def check(label, cond):
    print(("ok   " if cond else "FAIL ") + label)
    if not cond:
        raise SystemExit(1)


try:
    run()
    check("refuses without a manifest", False)
except RuntimeError:
    check("refuses without a manifest", True)

gap = bpy.data.objects.new("Gap_Issue_0__fbx_sync_test", keep[0].data.copy())
ctx.scene.collection.objects.link(gap)
old_gap = os.path.join(folder, "Gap_Issue_9__from_an_earlier_export.fbx")
open(old_gap, "wb").close()

r = run(export_all=True)
check("export all writes every visible mesh", sorted(r["export"]) == sorted(names) and len(mtimes()) == 5)
check("Gap_Issue mesh skipped, its old FBX deleted",
      r["excluded"] == 1 and not any(f.startswith("Gap_Issue") for f in os.listdir(folder))
      and not any(n.startswith("Gap_Issue") for n in fbx_sync.load_manifest(folder)))
if compare:
    for n in names:
        ours, theirs = os.path.getsize(os.path.join(folder, n + ".fbx")), os.path.getsize(os.path.join(compare, n + ".fbx"))
        check("same size as OPCD's export: %s (%d / %d)" % (n, ours, theirs), ours == theirs)

before = mtimes()
r = run()
check("unchanged: nothing exported", r["export"] == {} and mtimes() == before)

a, b = keep[0], keep[1]
a.data.vertices[0].co.z += 0.05
b.location.x += 1.0
ctx.view_layer.update()
r = run()
after = mtimes()
check("vertex edit and move re-export exactly those two",
      r["export"] == {names[0]: "changed", names[1]: "changed"}
      and after[names[0]] != before[names[0]] and after[names[1]] != before[names[1]]
      and all(after[n] == before[n] for n in names[2:]))

os.remove(os.path.join(folder, names[2] + ".fbx"))
r = run()
check("missing FBX re-exported", r["export"] == {names[2]: "no FBX"} and os.path.exists(os.path.join(folder, names[2] + ".fbx")))

old = names[3]
keep[3].name = "Renamed_by_fbx_sync_test"
new = fbx_sync.file_name(keep[3])
r = run(dry_run=True)
check("rename: dry run lists the new file and the orphan, writes nothing",
      r["export"] == {new: "no FBX"} and old in r["orphans"] and not os.path.exists(os.path.join(folder, new + ".fbx")))
r = run(delete_orphans=False)
check("rename, orphans kept: new file exported, old one stays",
      os.path.exists(os.path.join(folder, new + ".fbx")) and os.path.exists(os.path.join(folder, old + ".fbx")))
os.remove(os.path.join(folder, new + ".fbx"))
r = run()
check("rename: new file exported, orphan deleted",
      os.path.exists(os.path.join(folder, new + ".fbx")) and not os.path.exists(os.path.join(folder, old + ".fbx")))
check("manifest dropped the orphan", old not in fbx_sync.load_manifest(folder))

print("all passed:", folder)
