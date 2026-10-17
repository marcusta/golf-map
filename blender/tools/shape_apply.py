"""Replay shaping layers on a conformed OPCD course .blend (headless), report, export changed FBX.

The "Apply" step of blender/SHAPING-PLAN.md. Opens `<name>.conformed.blend` (from shape_prepare.py),
replays `docs/gspro/<course>/shaping/NN-*.json` in order, writes a JSON report and optionally exports
the changed meshes' FBX (fbx_sync's exporter call and fingerprints) into a staging folder. The .blend is
never saved.

    blender -b <course>.conformed.blend --python blender/tools/shape_apply.py -- \
        --layers docs/gspro/vreta/shaping [--svg <course>.svg] [--report out.json] [--export <folder>]
        [--only <op id>,...] [--dry-run] [--render <png folder>]

Ops drive Afrod Mod v4's operators the way the UI does (scene.opcdtools props reset to their defaults
and then set from the op's params, selection, active object, a 3D View context) with Python's `random`
and numpy seeded per feature, so a replay is identical. golfmap.flatten_footprint is ours, in Afrod's
style: it moves Spline mesh vertices by a function of their XY position only, so welded seams stay welded.
"""

import argparse
import hashlib
import math
import json
import os
import random
import sys
import time

import bpy
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import shape_coords  # noqa: E402
import shape_layers as sl  # noqa: E402
import shape_recipes as sr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
REPORT_FORMAT = "golfmap-shaping-report-v1"
SEAM_XY = 1e-4  # boundary vertices this close in XY are one seam vertex
SEAM_DZ = 1e-3  # ... and a gap when their heights differ by more
FOCUS_MARGIN = 1.0
# Speed shims (same results, README "Speed shims"): GOLFMAP_SHAPE_NO_FAST_SHIMS=1 leaves them out, which is
# how a run is compared against them.
FAST_SHIMS = os.environ.get("GOLFMAP_SHAPE_NO_FAST_SHIMS") != "1"


# ---------------------------------------------------------------- scene helpers

def view3d_override():
    """Context for operators that need a 3D View (Afrod sets space_data.clip_end, loopcut needs a region)."""
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
    raise RuntimeError("no 3D View in the .blend's screens (Afrod's operators need one)")


def object_mode():
    if bpy.context.mode != "OBJECT" and bpy.context.view_layer.objects.active is not None:
        with bpy.context.temp_override(**view3d_override()):
            bpy.ops.object.mode_set(mode="OBJECT")


def select_only(names):
    object_mode()
    vl = bpy.context.view_layer
    for o in vl.objects:
        if o.select_get():
            o.select_set(False)
    objs = [bpy.data.objects[n] for n in names]
    for o in objs:
        o.select_set(True)
    vl.objects.active = objs[0] if objs else None


def spline_meshes():
    return [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("Spline")]


def reset_opcdtools(scene):
    """Every scene.opcdtools prop back to its RNA default, so an op sees only its own params (never the
    file's leftovers or an earlier op's)."""
    tools = scene.opcdtools
    for p in tools.bl_rna.properties:
        if p.identifier == "rna_type" or p.is_readonly or p.type in {"POINTER", "COLLECTION"}:
            continue
        try:
            if p.type == "ENUM":
                value = set(p.default_flag) if p.is_enum_flag else p.default
                if not p.is_enum_flag and value == "" and len(p.enum_items):
                    value = p.enum_items[0].identifier
            elif getattr(p, "is_array", False) and p.array_length > 0:
                value = tuple(p.default_array)
            else:
                value = p.default
            setattr(tools, p.identifier, value)
        except (TypeError, ValueError, AttributeError):
            pass


def set_params(scene, params):
    for k, v in params.items():
        setattr(scene.opcdtools, k, v)


def seed_all(seed):
    random.seed(seed)
    np.random.seed(seed & 0xFFFFFFFF)


# ---------------------------------------------------------------- headless shim for Afrod's loopcut

AFROD_MODULE = "bl_ext.user_default.opcd_blender_tools.operators.afrod.afrod_operators"


def edge_ring(e0):
    """The edge ring through e0 across quads (Blender's BMW_EDGERING walk, both directions)."""
    ring, seen = [e0], {e0}
    for start in list(e0.link_faces):
        e, f = e0, start
        while f is not None and len(f.verts) == 4:
            loops = list(f.loops)
            i = next(k for k, l in enumerate(loops) if l.edge == e)
            opp = loops[(i + 2) % 4].edge
            if opp in seen:
                break
            ring.append(opp)
            seen.add(opp)
            nxt = [g for g in opp.link_faces if g != f]
            f = nxt[0] if len(nxt) == 1 else None
            e = opp
    return ring


def loopcut_headless(object_index=0, edge_index=0, number_cuts=1, **_):
    """mesh.loopcut without its viewport preview: the edge ring through `edge_index` subdivided like
    loopcut's exec (BM_mesh_esubdivide: grid fill, only quads, even smooth, path corners), leaving the
    new loop selected. Blender's own mesh.loopcut registers a region draw callback and crashes in
    background mode (background regions have no type)."""
    import bmesh
    obj = bpy.context.edit_object
    me = obj.data
    bm = bmesh.from_edit_mesh(me)
    bm.edges.ensure_lookup_table()
    ring = edge_ring(bm.edges[edge_index])
    for seq in (bm.verts, bm.edges, bm.faces):
        for el in seq:
            el.select_set(False)
    res = bmesh.ops.subdivide_edges(bm, edges=ring, cuts=number_cuts, use_grid_fill=True, use_only_quads=True,
                                    use_smooth_even=True, quad_corner_type="PATH", smooth=0.0)
    for el in res["geom_inner"]:
        el.select_set(True)
    bm.select_flush(True)
    bmesh.update_edit_mesh(me)
    return {"FINISHED"}


class _Proxy:
    def __init__(self, real, **over):
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_over", over)

    def __getattr__(self, name):
        over = object.__getattribute__(self, "_over")
        return over[name] if name in over else getattr(object.__getattribute__(self, "_real"), name)


def _in_index_order(fn):
    """Afrod's get_loop_at_depth / get_boundary_loop return list(set(BMVert)): the order follows memory
    addresses, and randomslideloop draws random.gauss() in that order (spaceloops' KD ties too), so a
    seeded replay still differed run to run. Same vertices, sorted by index."""
    def wrapped(bm, *args):
        verts = fn(bm, *args)
        bm.verts.index_update()
        return sorted(verts, key=lambda v: v.index)
    return wrapped


class _ClosestVert:
    """Afrod's find_closest_vert(selected_coords, vertex) with its KD tree built once per coordinate list
    instead of once per call (smoothcartpaths calls it for every vertex near a path: minutes on a long
    road). Same answer: the XY-nearest point of the same tree, then the first coordinate in list order at
    that XY."""

    def __init__(self):
        self.coords = None

    def __call__(self, selected_coords, vertex):
        if self.coords is not selected_coords or self.n != len(selected_coords):
            self.coords, self.n = selected_coords, len(selected_coords)
            kd = KDTree(len(selected_coords))
            for i, c in enumerate(selected_coords):
                kd.insert(Vector((c.x, c.y, 0)), i)
            kd.balance()
            self.kd = kd
            self.first = {}
            for c in selected_coords:
                self.first.setdefault((c.x, c.y), c)
        p, _, _ = self.kd.find(Vector((vertex.co.x, vertex.co.y, 0)))
        hit = self.first.get((p.x, p.y))
        if hit is not None:
            return hit
        best, closest = float("inf"), None  # float32 round trip: Afrod's own linear scan
        for c in selected_coords:
            d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2
            if d < best:
                best, closest = d, c
        return closest


EMT_OFFSET_MODULE = "bl_ext.blender_org.edit_mesh_tools.mesh_offset_edges"


class _MinPopSet(set):
    """A set whose pop() and copy() are deterministic: pop takes the edge with the smallest vertex
    positions. Edit Mesh Tools' offset_edges (Afrod's widenbunkerinterior) starts each loop at
    set.pop(), an arbitrary edge, and the offset's float math then runs in a memory-dependent order."""

    def copy(self):
        return _MinPopSet(self)

    def pop(self):
        e = min(self, key=lambda e: sorted(tuple(v.co) for v in e.verts))
        self.remove(e)
        return e


def _collect_loops_ordered(fn):
    def wrapped(set_edges_orig):
        return fn(_MinPopSet(set_edges_orig))
    return wrapped


def _knife_cut_fast(afrod):
    """Afrod's knife_cut_and_color_bmesh with set membership for its "near the cut" filter (it tested every
    edge and face against a list: ~40 s of the long road's cut). Same elements in the same order, so the
    same bisect; the rest is Afrod's code unchanged."""
    import bmesh

    def knife_cut_and_color_bmesh(obj, bm_passed, keep_both_sides=True, color_name='blue', color_strength=1.0):
        if obj is None or obj.type != 'MESH':
            print("Error (knife_cut_bmesh): No active mesh object, or not a mesh.")
            return None
        selected_verts_for_cut_definition = [v for v in bm_passed.verts if v.select]
        if len(selected_verts_for_cut_definition) != 2:
            print(f"Error (knife_cut_bmesh): Expected 2 selected verts, found {len(selected_verts_for_cut_definition)}.")
            return None
        vert1_def = selected_verts_for_cut_definition[0]
        vert2_def = selected_verts_for_cut_definition[1]
        if not vert1_def.is_valid or not vert2_def.is_valid:
            print("Error (knife_cut_bmesh): Defining vertices are no longer valid.")
            return None
        plane_co_local = vert1_def.co.copy()
        cut_vector = (vert2_def.co - vert1_def.co)
        if cut_vector.length < 0.00001:
            print("Error (knife_cut_bmesh): Cut direction is zero.")
            return None
        up_vector = Vector((0.0, 0.0, 1.0))
        plane_no_local = up_vector.cross(cut_vector).normalized()
        if plane_no_local.length < 0.01:
            cut_xy = Vector((cut_vector.x, cut_vector.y, 0.0))
            if cut_xy.length > 0.001:
                plane_no_local = cut_xy.normalized()
            else:
                plane_no_local = Vector((1.0, 0.0, 0.0))
        if plane_no_local.length < 0.01:
            print("Error (knife_cut_bmesh): Could not determine a valid plane normal.")
            return None
        cut_midpoint = (vert1_def.co + vert2_def.co) / 2.0
        cut_length = cut_vector.length
        search_radius = cut_length * 0.6
        nearby_verts = [vert for vert in bm_passed.verts if (vert.co - cut_midpoint).length <= search_radius]
        near = set(nearby_verts)
        nearby_edges = [edge for edge in bm_passed.edges if any(v in near for v in edge.verts)]
        nearby_faces = [face for face in bm_passed.faces if any(v in near for v in face.verts)]
        if not nearby_faces:
            print("Warning: No geometry found near cut line")
            return None
        geom_to_cut = nearby_verts + nearby_edges + nearby_faces
        vert1_def.select_set(False)
        vert2_def.select_set(False)
        bm_passed.select_flush(False)
        newly_created_bmverts_from_cut = []
        try:
            result = bmesh.ops.bisect_plane(bm_passed, geom=geom_to_cut, plane_co=plane_co_local, plane_no=plane_no_local,
                                            clear_inner=not keep_both_sides, clear_outer=not keep_both_sides)
            if result and 'geom_cut' in result:
                for elem in result['geom_cut']:
                    if isinstance(elem, bmesh.types.BMVert):
                        if elem.is_valid:
                            newly_created_bmverts_from_cut.append(elem)
                if newly_created_bmverts_from_cut:
                    for v_iter in bm_passed.verts:
                        v_iter.select_set(False)
                    for v_new_cut in newly_created_bmverts_from_cut:
                        if v_new_cut.is_valid:
                            v_new_cut.select_set(True)
                    bm_passed.select_flush(True)
                    bmesh.update_edit_mesh(obj.data)
                    if not _paint_in_edit_mode(obj, bm_passed, newly_created_bmverts_from_cut, color_name, color_strength):
                        afrod.color_to_vertices(color_name, color_strength)
                else:
                    print("Knife_cut_bmesh: No new vertices found in geom_cut.")
            else:
                print("Knife_cut_bmesh: Bisect_plane result did not contain 'geom_cut'.")
            return newly_created_bmverts_from_cut
        except RuntimeError as e:
            print(f"Error (knife_cut_bmesh) during bmesh.ops.bisect_plane: {e}")
            return None
        except Exception as e:
            print(f"An unexpected error occurred during bisect_plane (bmesh): {e}")
            return None

    return knife_cut_and_color_bmesh


_PAINT = {'red': (1, 0, 0, 1), 'green': (0, 1, 0, 1), 'blue': (0, 0, 1, 1), 'black': (0, 0, 0, 1), 'white': (1, 1, 1, 1)}


def _paint_in_edit_mode(obj, bm, verts, color_name, strength):
    """What color_to_vertices(colour, 1.0) does to the cut's new (the only selected) vertices, without its
    Edit -> Object -> Edit round trip of every selected mesh per cut: the corners of those vertices get the
    colour exactly (0/1 channels, alpha 1). The cut only adds elements, so the BMesh keeps the order a round
    trip would give it. False when the case is not that simple (then Afrod's function runs)."""
    if strength != 1.0 or obj != bpy.context.active_object or obj.mode != 'EDIT':
        return False
    attr = obj.data.color_attributes.get("Col")
    if attr is None or attr.domain != 'CORNER':
        return False
    if attr.data_type == 'BYTE_COLOR':
        layer = bm.loops.layers.color.get("Col")
    elif attr.data_type == 'FLOAT_COLOR':
        layer = bm.loops.layers.float_color.get("Col")
    else:
        return False
    if layer is None:
        return False
    selected = [v for v in verts if v.is_valid and v.select]
    if not selected:
        return False
    c = _PAINT.get(color_name, (1, 0, 0, 1))
    value = Vector((float(c[0]), float(c[1]), float(c[2]), 1.0))
    for v in selected:
        for loop in v.link_loops:
            loop[layer] = value
    if obj.data.color_attributes.active_color_name != "Col":
        obj.data.color_attributes.active_color = obj.data.color_attributes["Col"]
    return True


def _color_to_vertices_fast(afrod, original):
    """Afrod's color_to_vertices at full strength (every cut of cutcartpaths paints its new vertices blue),
    vectorised: it blends existing*(1-s) + colour*s per corner of a selected vertex in a Python loop (~25 s
    on the long road); at s = 1 that is the colour exactly (bytes 0/255), written as arrays. Same mode
    switches, same attribute handling; any other strength or layout runs Afrod's own code."""

    def color_to_vertices(paint_color, paint_strength):
        obj = bpy.context.active_object
        if paint_strength != 1.0 or not obj or obj.type != 'MESH':
            return original(paint_color, paint_strength)
        attr = obj.data.color_attributes.get("Col")
        if attr is None or attr.domain != 'CORNER' or attr.data_type not in ('BYTE_COLOR', 'FLOAT_COLOR'):
            return original(paint_color, paint_strength)
        color = _PAINT.get(paint_color, (1, 0, 0, 1))
        mesh = obj.data
        current_mode = bpy.context.object.mode
        if current_mode == 'EDIT':
            bpy.ops.object.mode_set(mode='OBJECT')
            mesh = obj.data
        color_attr = afrod.ensure_color_attribute(obj)
        if not color_attr:
            print("Failed to create color attribute")
            if current_mode == 'EDIT':
                bpy.ops.object.mode_set(mode='EDIT')
            return
        sel = np.zeros(len(mesh.vertices), dtype=bool)
        mesh.vertices.foreach_get("select", sel)
        if not sel.any():
            print("No vertices selected - make sure to select vertices first!")
            if current_mode == 'EDIT':
                bpy.ops.object.mode_set(mode='EDIT')
            return
        cv = np.empty(len(mesh.loops), dtype=np.int32)
        mesh.loops.foreach_get("vertex_index", cv)
        key = "color_srgb" if color_attr.data_type == 'BYTE_COLOR' else "color"
        values = np.empty(len(color_attr.data) * 4, dtype=np.float32)
        color_attr.data.foreach_get(key, values)
        values = values.reshape(-1, 4)
        values[sel[cv]] = np.array([float(color[0]), float(color[1]), float(color[2]), 1.0], dtype=np.float32)
        color_attr.data.foreach_set(key, values.reshape(-1))
        if mesh.color_attributes.active_color != color_attr:
            mesh.color_attributes.active_color = color_attr
        mesh.update()
        if current_mode == 'EDIT':
            bpy.ops.object.mode_set(mode='EDIT')

    return color_to_vertices


class _NearbyVertices:
    """Afrod's find_nearby_vertices(selected_coords, radius) (smoothcartpaths' ripple), with each Spline
    object's 2D KD tree built once while its XY stays the same (it rebuilt one for every Spline object for
    every path object: ~30 s on the long road) and objects whose XY box is out of reach skipped (their
    find_range finds nothing). Same trees, same query order, so the same dict in the same order."""

    def __init__(self):
        self.trees = {}  # name -> [xy key, XY box or None, KDTree or None]

    def entry(self, obj):
        me = obj.data
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        identity = all(obj.matrix_world[i][j] == (1.0 if i == j else 0.0) for i in range(4) for j in range(4))
        key = (len(co), hashlib.sha1(np.ascontiguousarray(co[:, :2]).tobytes()).hexdigest(), identity)
        hit = self.trees.get(obj.name)
        if hit is None or hit[0] != key:
            box = (float(co[:, 0].min()), float(co[:, 1].min()), float(co[:, 0].max()), float(co[:, 1].max())) \
                if identity and len(co) else None
            hit = self.trees[obj.name] = [key, box, None, co if identity else None]
        return hit

    def tree(self, obj, hit):
        if hit[2] is None:
            me = obj.data
            kd = KDTree(len(me.vertices))
            if hit[3] is not None:  # identity matrix: matrix_world @ co is co exactly
                for i, (x, y, _) in enumerate(hit[3].tolist()):
                    kd.insert(Vector((x, y, 0.0)), i)
            else:
                for i, vert in enumerate(me.vertices):
                    co_3d = obj.matrix_world @ vert.co
                    kd.insert(Vector((co_3d.x, co_3d.y, 0.0)), i)
            kd.balance()
            hit[2], hit[3] = kd, None
        return hit[2]

    def __call__(self, selected_coords, radius):
        nearby_vertices = {}
        sel_box = None
        if selected_coords:
            xs = [c.x for c in selected_coords]
            ys = [c.y for c in selected_coords]
            sel_box = (min(xs), min(ys), max(xs), max(ys))
        for obj in bpy.context.scene.objects:
            if obj.type != 'MESH':
                continue
            if 'Spline' not in obj.name:
                continue
            if obj == bpy.context.active_object:
                continue
            hit = self.entry(obj)
            if hit[1] is not None and sel_box is not None and sl.bbox_distance(sel_box, hit[1]) > radius + 1e-3:
                continue  # no vertex within the radius of any selected coordinate
            kd = self.tree(obj, hit)
            for center_co_3d in selected_coords:
                center_co_2d = Vector((center_co_3d.x, center_co_3d.y, 0.0))
                for vert_co, index, dist in kd.find_range(center_co_2d, radius):
                    key = (obj, index)
                    if key not in nearby_vertices or dist < nearby_vertices[key]:
                        nearby_vertices[key] = dist
        return nearby_vertices


class afrod_headless:
    """While active, Afrod's module sees vertex loops in index order (determinism), a find_closest_vert
    that keeps its KD tree, a knife cut / full-strength paint / nearby-vertex search that give the same
    results faster (speed), and in background mode a `bpy` whose ops.mesh.loopcut is loopcut_headless (in
    the UI Blender's own operator works). `fast=False` leaves the speed shims out (to compare)."""

    fast = FAST_SHIMS

    def __enter__(self):
        self.module = sys.modules.get(AFROD_MODULE)
        self.saved = {}
        if self.module is None:
            return self
        for name in ("get_loop_at_depth", "get_boundary_loop"):
            fn = getattr(self.module, name, None)
            if fn is not None:
                self.saved[name] = fn
                setattr(self.module, name, _in_index_order(fn))
        if getattr(self.module, "find_closest_vert", None) is not None:
            self.saved["find_closest_vert"] = self.module.find_closest_vert
            self.module.find_closest_vert = _ClosestVert()
        if self.fast:
            for name, make in (("knife_cut_and_color_bmesh", lambda m, f: _knife_cut_fast(m)),
                               ("color_to_vertices", _color_to_vertices_fast),
                               ("find_nearby_vertices", lambda m, f: _NearbyVertices())):
                fn = getattr(self.module, name, None)
                if fn is not None:
                    self.saved[name] = fn
                    setattr(self.module, name, make(self.module, fn))
        self.emt = sys.modules.get(EMT_OFFSET_MODULE)
        if self.emt is not None and getattr(self.emt, "collect_loops", None) is not None:
            self.emt_saved = self.emt.collect_loops
            self.emt.collect_loops = _collect_loops_ordered(self.emt_saved)
        if bpy.app.background:
            real = self.module.bpy
            self.saved["bpy"] = real
            mesh = _Proxy(real.ops.mesh, loopcut=loopcut_headless)
            self.module.bpy = _Proxy(real, ops=_Proxy(real.ops, mesh=mesh))
        return self

    def __exit__(self, *exc):
        for name, value in self.saved.items():
            setattr(self.module, name, value)
        if getattr(self, "emt_saved", None) is not None:
            self.emt.collect_loops = self.emt_saved
        return False


# ---------------------------------------------------------------- geometry snapshots

def positions(obj):
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def colors(obj):
    attr = obj.data.color_attributes.get("Col")
    if attr is None:
        return np.zeros(0, dtype=np.float32)
    c = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color", c)
    return c


def snapshot(objs=None):
    return {o.name: positions(o) for o in (objs if objs is not None else spline_meshes())}


def bbox_xy(obj):
    co = positions(obj)
    if not len(co):
        return None
    return (float(co[:, 0].min()), float(co[:, 1].min()), float(co[:, 0].max()), float(co[:, 1].max()))


def diff(before, after):
    """Per object: moved vertices, max |dz| / |dxy|; topology changes are matched to the nearest old
    vertex in XY."""
    out = {}
    for name, b in before.items():
        a = after.get(name)
        if a is None:
            out[name] = {"removed": True}
            continue
        if len(a) == len(b):
            d = a - b
            moved = np.any(np.abs(d) > 1e-7, axis=1)
            n = int(moved.sum())
            if n:
                k = int(np.argmax(np.abs(d[:, 2])))
                out[name] = {"vertsMoved": n, "maxAbsDz": float(abs(d[k, 2])),
                             "maxAbsDxy": float(np.hypot(d[:, 0], d[:, 1]).max()),
                             "at": [float(a[k, 0]), float(a[k, 1])]}
            continue
        old = b.tolist()
        kd = KDTree(len(b))
        for i, (x, y, _) in enumerate(old):
            kd.insert((x, y, 0.0), i)
        kd.balance()
        dz, at = 0.0, None
        for x, y, z in a.tolist():
            _, i, _ = kd.find((x, y, 0.0))
            dzi = abs(z - old[i][2])
            if dzi > dz:
                dz, at = dzi, [x, y]
        out[name] = {"topology": [len(b), len(a)], "vertsMoved": None, "maxAbsDz": dz, "at": at}
    for name in after:
        if name not in before:
            out[name] = {"created": True, "verts": len(after[name])}
    return out


def boundary_points(obj):
    """World positions of an object's boundary vertices (on edges with one face)."""
    me = obj.data
    if not len(me.edges):
        return np.zeros((0, 3))
    ev = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get("vertices", ev)
    le = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("edge_index", le)
    faces = np.bincount(le, minlength=len(me.edges))
    verts = np.unique(ev.reshape(-1, 2)[faces == 1])
    co = positions(obj)[verts].astype(np.float64)
    m = np.array(obj.matrix_world)
    return co @ m[:3, :3].T + m[:3, 3]


def seam_check(names=None, neighbour_pad=0.5):
    """Seam gaps between the named objects (default: every Spline mesh) and their neighbours: boundary
    vertices coincident in XY (within SEAM_XY) whose heights differ by more than SEAM_DZ. Also counts each
    object's boundary vertices without a partner (course edge, open edges, T-junctions after a cut)."""
    objs = spline_meshes()
    if names is None:
        focus = [o.name for o in objs]
        near = set(focus)
    else:
        boxes = {o.name: bbox_xy(o) for o in objs}
        focus = [n for n in names if n in boxes and boxes[n]]
        near = set(focus)
        for n in focus:
            for o in objs:
                if boxes[o.name] and sl.bbox_distance(boxes[n], boxes[o.name]) <= neighbour_pad:
                    near.add(o.name)
    pts, owner = [], []
    for n in sorted(near):
        bp = boundary_points(bpy.data.objects[n])
        pts.append(bp)
        owner += [n] * len(bp)
    if not owner:
        return {"pairs": {}, "unmatched": {}}
    allp = np.concatenate(pts)
    kd = _xy_kd(allp)
    points = allp.tolist()
    pairs, unmatched = {}, {}
    focus_set = set(focus)
    for i, p in enumerate(points):
        a = owner[i]
        if a not in focus_set:
            continue
        partner = False
        for _, j, _ in kd.find_range((p[0], p[1], 0.0), SEAM_XY):
            b = owner[j]
            if b == a:
                continue
            partner = True
            if b in focus_set and b < a:
                continue  # counted from b's side
            dz = abs(points[j][2] - p[2])
            key = "|".join(sorted((a, b)))
            rec = pairs.setdefault(key, {"vertices": 0, "gaps": 0, "maxAbsDz": 0.0})
            rec["vertices"] += 1
            if dz > SEAM_DZ:
                rec["gaps"] += 1
                if dz > rec["maxAbsDz"]:
                    rec["maxAbsDz"] = dz
                    rec["at"] = [round(p[0], 3), round(p[1], 3)]
        if not partner:
            unmatched[a] = unmatched.get(a, 0) + 1
    return {"pairs": pairs, "unmatched": unmatched}


def boundary_segments(obj):
    """World XY-Z segments (N, 2, 3) of an object's boundary edges."""
    me = obj.data
    if not len(me.edges):
        return np.zeros((0, 2, 3))
    ev = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get("vertices", ev)
    le = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("edge_index", le)
    faces = np.bincount(le, minlength=len(me.edges))
    pairs = ev.reshape(-1, 2)[faces == 1]
    m = np.array(obj.matrix_world)
    co = positions(obj).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    return co[pairs]


def tjunction_check(names, tol_xy=1e-3):
    """Boundary vertices of the named objects with no coincident partner that lie on a neighbour's boundary
    edge (a T-junction, e.g. after Afrod's cutcartpaths): how far their height is off that edge."""
    objs = spline_meshes()
    boxes = {o.name: bbox_xy(o) for o in objs}
    out = {}
    for n in names:
        obj = bpy.data.objects.get(n)
        if obj is None or not boxes.get(n):
            continue
        own = boundary_points(obj)
        # Same filter as the weld (a shim): only a mesh whose box holds a cell of this one's boundary
        # vertices can have a partner within SEAM_XY or an edge within tol_xy of one of them.
        near = _weld_neighbours(objs, boxes, n, own)
        if not near:
            continue
        segs = np.concatenate([boundary_segments(o) for o in near])
        if not len(segs):
            continue
        a, b = segs[:, 0], segs[:, 1]
        ab = b[:, :2] - a[:, :2]
        L = np.maximum((ab ** 2).sum(axis=1), 1e-18)
        others = np.concatenate([boundary_points(o) for o in near])
        kd = _xy_kd(others)
        rec = {"vertices": 0, "onEdge": 0, "gaps": 0, "maxAbsDz": 0.0}
        for p in own:
            if kd.find_range((float(p[0]), float(p[1]), 0.0), SEAM_XY):
                continue  # has a partner: seam_check covers it
            rec["vertices"] += 1
            t = np.clip(((p[:2] - a[:, :2]) * ab).sum(axis=1) / L, 0.0, 1.0)
            q = a[:, :2] + ab * t[:, None]
            d = np.hypot(q[:, 0] - p[0], q[:, 1] - p[1])
            k = int(np.argmin(d))
            if d[k] > tol_xy:
                continue
            rec["onEdge"] += 1
            dz = abs(float(a[k, 2] + (b[k, 2] - a[k, 2]) * t[k]) - float(p[2]))
            if dz > SEAM_DZ:
                rec["gaps"] += 1
            if dz > rec["maxAbsDz"]:
                rec["maxAbsDz"] = round(dz, 4)
                rec["at"] = [round(float(p[0]), 3), round(float(p[1]), 3)]
        if rec["vertices"]:
            out[n] = rec
    return out


def boundary_edges(obj):
    """(edge indices, (N, 2) vertex indices, world positions of all vertices) of the boundary edges."""
    me = obj.data
    ev = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get("vertices", ev)
    le = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("edge_index", le)
    faces = np.bincount(le, minlength=len(me.edges))
    idx = np.nonzero(faces == 1)[0]
    m = np.array(obj.matrix_world)
    co = positions(obj).astype(np.float64) @ m[:3, :3].T + m[:3, 3]
    return idx, ev.reshape(-1, 2)[idx], co


SEGMENT_GRID_M = 2.0
WELD_CELL_M = 1.0   # the weld's filter cells (>> its tolerances, so one ring of neighbour cells is enough)


def _segment_grid(a, b, pad, cell=SEGMENT_GRID_M):
    """Segments a[i]-b[i] (XY) in a uniform grid: returns lookup(x, y) -> ascending indices of the segments
    whose box, grown by `pad`, covers the cell of (x, y), or None. Every segment within `pad` of the point is
    among them."""
    cells, long = {}, []  # long: a segment over too many cells to list is offered to every point
    if len(a):
        lo = np.floor((np.minimum(a[:, :2], b[:, :2]) - pad) / cell).astype(np.int64)
        hi = np.floor((np.maximum(a[:, :2], b[:, :2]) + pad) / cell).astype(np.int64)
        for i, (x0, y0, x1, y1) in enumerate(np.concatenate([lo, hi], axis=1).tolist()):
            if (x1 - x0 + 1) * (y1 - y0 + 1) > 1024:
                long.append(i)
                continue
            for cx in range(x0, x1 + 1):
                for cy in range(y0, y1 + 1):
                    cells.setdefault((cx, cy), []).append(i)
    arrays = {}
    everywhere = np.array(long, dtype=np.int64) if long else None

    def lookup(x, y):
        key = (math.floor(x / cell), math.floor(y / cell))
        if key not in arrays:
            got = np.array(cells[key], dtype=np.int64) if key in cells else None
            if everywhere is not None:
                got = everywhere if got is None else np.union1d(got, everywhere)
            arrays[key] = got
        return arrays[key]
    return lookup


# ---------------------------------------------------------------- speed shims for the T-junction weld
#
# A weld asks for the same neighbour's boundary once per named mesh (a slab's cut touches four meshes, each
# with ~270 neighbours), and a neighbour is often a course-wide road blend offering its whole boundary while
# the answers can only come from within a millimetre of one of the named mesh's own boundary vertices. Both
# shims below leave every answer as it was: the cache hands out the same arrays (and forgets a mesh the weld
# changes), and a point or segment outside the 1 m cells of those vertices is beyond every tolerance.

class _BoundaryCache:
    """`boundary_points` / `boundary_edges` per object, until `forget(name)` (the weld changes a mesh)."""

    def __init__(self):
        self._points, self._edges = {}, {}

    def points(self, obj):
        if obj.name not in self._points:
            self._points[obj.name] = boundary_points(obj)
        return self._points[obj.name]

    def edges(self, obj):
        if obj.name not in self._edges:
            self._edges[obj.name] = boundary_edges(obj)
        return self._edges[obj.name]

    def forget(self, name):
        self._points.pop(name, None)
        self._edges.pop(name, None)


CELL_KEY = 1 << 24      # cell (x, y) -> x * CELL_KEY + y (one key per cell for |x|, |y| < 2^23)


def _cells(points, cell):
    c = np.floor(points[:, :2] / cell).astype(np.int64)
    return c[:, 0] * CELL_KEY + c[:, 1]


def _grown_cells(points, cell):
    """The keys of the cells of `points` and of their eight neighbours, ascending: whatever is within `cell`
    of one of the points lies in one of them."""
    c = np.floor(points[:, :2] / cell).astype(np.int64)
    return np.unique(np.concatenate([(c[:, 0] + dx) * CELL_KEY + c[:, 1] + dy
                                     for dx in (-1, 0, 1) for dy in (-1, 0, 1)]))


def _in_cells(points, cells, cell):
    """Mask of the points whose cell is one of `cells` (ascending)."""
    return _has(cells, _cells(points, cell))


def _segments_in_cells(a, b, cells, pad, cell):
    """Mask of the segments whose box, grown by `pad`, covers one of the `cells` (ascending) - a segment
    over more than four cells is kept without the test (there are few, and keeping one changes nothing)."""
    lo = np.floor((np.minimum(a[:, :2], b[:, :2]) - pad) / cell).astype(np.int64)
    hi = np.floor((np.maximum(a[:, :2], b[:, :2]) + pad) / cell).astype(np.int64)
    small = (hi[:, 0] - lo[:, 0] <= 1) & (hi[:, 1] - lo[:, 1] <= 1)
    hit = np.zeros(len(lo), dtype=bool)
    for dx in (0, 1):
        for dy in (0, 1):
            hit |= _has(cells, np.minimum(lo[:, 0] + dx, hi[:, 0]) * CELL_KEY
                        + np.minimum(lo[:, 1] + dy, hi[:, 1]))
    return ~small | hit


def _has(sorted_keys, keys):
    """Mask of the keys present in the ascending `sorted_keys`."""
    if not len(sorted_keys) or not len(keys):
        return np.zeros(len(keys), dtype=bool)
    at = np.searchsorted(sorted_keys, keys)
    return sorted_keys[np.minimum(at, len(sorted_keys) - 1)] == keys


def _cell_cover(points, cell):
    """`cover(boxes)` -> which of the XY boxes (N, 4) hold a cell of `points` or of their eight neighbours.
    A summed-area table over the points' own cell range, so one `cumsum` answers every box in one step."""
    c = np.floor(points[:, :2] / cell).astype(np.int64)
    lo = c.min(axis=0) - 1
    size = c.max(axis=0) + 2 - lo
    grid = np.zeros((int(size[0]), int(size[1])), dtype=np.int32)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            grid[c[:, 0] + dx - lo[0], c[:, 1] + dy - lo[1]] = 1
    table = np.zeros((int(size[0]) + 1, int(size[1]) + 1), dtype=np.int64)
    table[1:, 1:] = grid.cumsum(axis=0).cumsum(axis=1)

    def cover(boxes):
        b = np.asarray(boxes, dtype=np.float64)
        x0 = np.floor(b[:, 0] / cell).astype(np.int64) - lo[0]
        y0 = np.floor(b[:, 1] / cell).astype(np.int64) - lo[1]
        x1 = np.floor(b[:, 2] / cell).astype(np.int64) - lo[0]
        y1 = np.floor(b[:, 3] / cell).astype(np.int64) - lo[1]
        outside = (x1 < 0) | (y1 < 0) | (x0 > size[0] - 1) | (y0 > size[1] - 1)
        x0, x1 = np.clip(x0, 0, size[0] - 1), np.clip(x1, 0, size[0] - 1)
        y0, y1 = np.clip(y0, 0, size[1] - 1), np.clip(y1, 0, size[1] - 1)
        got = (table[x1 + 1, y1 + 1] - table[x0, y1 + 1] - table[x1 + 1, y0] + table[x0, y0])
        return ~outside & (got > 0)
    return cover


def _weld_neighbours(objs, boxes, name, own, pad=0.5):
    """The Spline meshes whose boundary the weld has to read for the named mesh: those whose box is within
    `pad` of its box and (the shim) holds a cell of its own boundary vertices or a neighbouring cell. Only
    such a mesh can have a boundary vertex or edge within the weld's tolerances of one of them: both lie in
    its box, which then covers that vertex's cell."""
    near = [o for o in objs if o.name != name and boxes[o.name]
            and sl.bbox_distance(boxes[name], boxes[o.name]) <= pad]
    if not FAST_SHIMS or not near or not len(own):
        return near
    keep = _cell_cover(own, WELD_CELL_M)([boxes[o.name] for o in near])
    return [o for o, k in zip(near, keep.tolist()) if k]


def _added_vertices(cur, old):
    """Which vertices of `cur` (N, 3) a cut added: those further than 1e-5 from every position in `old`.
    A cut leaves the old vertices exactly where they were, so an exact match settles nearly all of them and
    only the rest are measured (speed shim: the KD tree held every vertex of a course-wide road blend)."""
    cur = cur.astype(np.float64)
    old = old.reshape(-1, 3)
    both = np.concatenate([old, cur])
    _, inv = np.unique(both, axis=0, return_inverse=True)
    inv = np.asarray(inv).reshape(-1)
    seen = np.zeros(int(inv.max()) + 1, dtype=bool)
    seen[inv[:len(old)]] = True
    rest = np.nonzero(~seen[inv[len(old):]])[0]
    if not len(rest):
        return set()
    p = cur[rest]
    lo, hi = p.min(axis=0) - 1e-5, p.max(axis=0) + 1e-5
    sub = old[((old >= lo) & (old <= hi)).all(axis=1)]
    if not len(sub):
        return {int(i) for i in rest}
    out, block = [], max(1, int(4e6 / len(sub)))
    for k in range(0, len(rest), block):
        d2 = ((p[k:k + block, None, :] - sub[None, :, :]) ** 2).sum(axis=2).min(axis=1)
        out.append(rest[k:k + block][np.sqrt(d2) > 1e-5])
    return {int(i) for i in np.concatenate(out)}


def _xy_kd(points):
    """KD tree of the points' XY (z = 0), in their order - as the weld and the seam checks build it."""
    kd = KDTree(len(points))
    for i, (x, y) in enumerate(points[:, :2].tolist()):
        kd.insert((x, y, 0.0), i)
    kd.balance()
    return kd


def weld_tjunctions(names, tol=1e-3):
    """Close the T-junctions around the named meshes (Afrod's cutcartpaths adds boundary vertices a
    neighbour does not have): every boundary vertex of theirs with no coincident partner that lies within
    `tol` (XY) of a neighbouring Spline mesh's boundary edge splits that edge there (bmesh edge_split:
    z, colours, UVs and custom normals interpolated, faces keep their winding) and the new vertex takes
    the exact position, so later ripples (smoothcartpaths) move both alike."""
    objs = spline_meshes()
    boxes = {o.name: bbox_xy(o) for o in objs}
    cache = _BoundaryCache()
    inserts = {}  # neighbour -> {edge index: [(t, point)]}
    snaps = {}  # neighbour -> {vertex index: point}
    merged = 0
    # Pass 1 (changes these meshes' vertex indices, so before any split or snap is planned).
    for n in sorted(names):
        obj = bpy.data.objects.get(n)
        if obj is None or not boxes.get(n):
            continue
        # merge_near_duplicates only asks which of this mesh's own boundary vertices has a neighbour
        # within SEAM_XY: a point more than a metre from all of them can answer nothing.
        own = cache.points(obj) if FAST_SHIMS else boundary_points(obj)
        near = _weld_neighbours(objs, boxes, n, own)
        pts = []
        own_cells = _grown_cells(own, WELD_CELL_M) if FAST_SHIMS and len(own) else None
        for o in near:
            p = cache.points(o) if FAST_SHIMS else boundary_points(o)
            pts.append(p[_in_cells(p, own_cells, WELD_CELL_M)] if own_cells is not None and len(p) else p)
        nkd = _xy_kd(np.concatenate(pts or [np.zeros((0, 3))]))
        merged += merge_near_duplicates(obj, nkd, tol)
        cache.forget(n)
    found = 0
    for n in sorted(names):
        obj = bpy.data.objects.get(n)
        if obj is None or not boxes.get(n):
            continue
        own = cache.points(obj) if FAST_SHIMS else boundary_points(obj)
        near = _weld_neighbours(objs, boxes, n, own)
        if not near:
            continue
        own_cells = _grown_cells(own, WELD_CELL_M) if FAST_SHIMS and len(own) else None
        grid_cells = np.unique(_cells(own, SEGMENT_GRID_M)) if FAST_SHIMS and len(own) else None
        edges = [(o.name,) + (cache.edges(o) if FAST_SHIMS else boundary_edges(o)) for o in near]
        o_owner, o_index, o_co = [], [], []
        for name, _, pairs, co in edges:
            vi = np.unique(pairs)
            p = co[vi]
            if own_cells is not None and len(p):
                # A neighbour vertex answers only within `tol` of an own boundary vertex, or within SEAM_XY
                # of such a neighbour vertex (the snap's second query) - both far inside a metre.
                m = _in_cells(p, own_cells, WELD_CELL_M)
                vi, p = vi[m], p[m]
            o_owner += [name] * len(vi)
            o_index += [int(i) for i in vi]
            o_co.append(p)
        others = np.concatenate(o_co or [np.zeros((0, 3))])
        kd = _xy_kd(others)
        seg_owner, seg_edge, seg_a, seg_b = [], [], [], []
        for name, idx, pairs, co in edges:
            sa, sb = co[pairs[:, 0]], co[pairs[:, 1]]
            if grid_cells is not None and len(idx):
                # A segment is only ever offered to an own boundary vertex whose grid cell its padded box
                # covers (_segment_grid), so the cells of those vertices decide.
                m = _segments_in_cells(sa, sb, grid_cells, 2.0 * tol, SEGMENT_GRID_M)
                idx, sa, sb = idx[m], sa[m], sb[m]
            seg_owner += [name] * len(idx)
            seg_edge += [int(e) for e in idx]
            seg_a.append(sa)
            seg_b.append(sb)
        if not seg_edge and not FAST_SHIMS:
            continue  # (the shim's filter may leave no segment while there is still a vertex to snap)
        a, b = np.concatenate(seg_a or [np.zeros((0, 3))]), np.concatenate(seg_b or [np.zeros((0, 3))])
        ab = b[:, :2] - a[:, :2]
        L2 = np.maximum((ab ** 2).sum(axis=1), 1e-18)
        near_segments = _segment_grid(a, b, 2.0 * tol)
        own_kd = _xy_kd(own)
        for p in own:
            if kd.find_range((float(p[0]), float(p[1]), 0.0), SEAM_XY):
                continue
            _, j, dv = kd.find((float(p[0]), float(p[1]), 0.0))
            if j is not None and dv <= tol and not own_kd.find_range(tuple(others[j][:2]) + (0.0,), SEAM_XY):
                # A near miss (OPCD leaves some seam vertices ~0.3 mm apart, and the neighbour's vertex has
                # no partner here): snap it, and whatever is coincident with it, onto this one. A neighbour
                # vertex that is already welded to this mesh is left alone (the edge is split instead).
                pt = tuple(float(c) for c in p)
                for _, jj, _ in kd.find_range(tuple(others[j][:2]) + (0.0,), SEAM_XY):
                    snaps.setdefault(o_owner[jj], {})[o_index[jj]] = pt
                found += 1
                continue
            # Only the segments whose padded box holds p can be within tol of it: the same arithmetic on those,
            # in the same order, as on all of them (a road blend spanning the course has thousands of such
            # vertices and every mesh of the course as neighbour: minutes per call when each met every segment).
            s = near_segments(float(p[0]), float(p[1]))
            if s is None:
                continue
            sa, sab, sL2 = a[s, :2], ab[s], L2[s]
            t = np.clip(((p[:2] - sa) * sab).sum(axis=1) / sL2, 0.0, 1.0)
            q = sa + sab * t[:, None]
            d = np.hypot(q[:, 0] - p[0], q[:, 1] - p[1])
            Ls = np.sqrt(sL2)
            ok = (d <= tol) & (t * Ls > SEAM_XY) & ((1 - t) * Ls > SEAM_XY)  # interior of the edge
            if not ok.any():
                continue
            j = int(np.flatnonzero(ok)[np.argmin(d[ok])])
            k = int(s[j])
            found += 1
            inserts.setdefault(seg_owner[k], {}).setdefault(seg_edge[k], []).append((float(t[j]), tuple(float(c) for c in p)))
    import bmesh
    split = {}
    for name in sorted(inserts):
        obj = bpy.data.objects[name]
        me = obj.data
        inv = obj.matrix_world.inverted()
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.edges.ensure_lookup_table()
        targets = {ei: bm.edges[ei] for ei in inserts[name]}  # before any split outdates the index table
        count = 0
        for ei in sorted(inserts[name]):
            edge = targets[ei]
            v0, v1 = edge.verts
            local = sorted({tuple(inv @ Vector(p)) for _, p in inserts[name][ei]},
                           key=lambda q: (q[0] - v0.co.x) ** 2 + (q[1] - v0.co.y) ** 2)
            cur, cur_from = edge, v0
            for q in local:
                span = math.hypot(v1.co.x - cur_from.co.x, v1.co.y - cur_from.co.y)
                fac = math.hypot(q[0] - cur_from.co.x, q[1] - cur_from.co.y) / span if span else 0.5
                if not 0.0 < fac < 1.0:
                    continue
                _, v_new = bmesh.utils.edge_split(cur, cur_from, fac)
                v_new.co = Vector(q)
                count += 1
                cur_from = v_new
                cur = next(e for e in v_new.link_edges if e.other_vert(v_new) == v1)
        bm.to_mesh(me)
        bm.free()
        me.update()
        split[name] = count
    snapped = {}
    for name in sorted(snaps):  # vertex indices survive the splits (bmesh appends new vertices)
        obj = bpy.data.objects[name]
        inv = obj.matrix_world.inverted()
        for i, p in sorted(snaps[name].items()):
            obj.data.vertices[i].co = inv @ Vector(p)
        obj.data.update()
        snapped[name] = len(snaps[name])
    objects = {n: {"split": split.get(n, 0), "snapped": snapped.get(n, 0)} for n in sorted(set(split) | set(snapped))}
    return {"toleranceM": tol, "tJunctions": found, "edgesSplit": sum(split.values()),
            "verticesSnapped": sum(snapped.values()), "nearDuplicatesMerged": merged, "objects": objects}


def merge_near_duplicates(obj, neighbour_kd, tol):
    """Afrod's cut leaves boundary slivers: a new vertex 0.1-1 mm from a boundary vertex that is welded to a
    neighbour (its remove_doubles uses 0.1 mm). Merge each such unpartnered vertex into the welded one."""
    import bmesh
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    mw = obj.matrix_world
    bverts = [v for v in bm.verts if v.is_boundary]
    world = [mw @ v.co for v in bverts]
    welded = [bool(neighbour_kd.find_range((w.x, w.y, 0.0), SEAM_XY)) for w in world]
    kd = KDTree(len(bverts))
    for i, w in enumerate(world):
        kd.insert((w.x, w.y, 0.0), i)
    kd.balance()
    targetmap = {}
    for i, v in enumerate(bverts):
        if welded[i]:
            continue
        best = None
        for _, j, dist in kd.find_range((world[i].x, world[i].y, 0.0), tol):
            if j != i and welded[j] and bverts[j] not in targetmap and (best is None or dist < best[1]):
                best = (j, dist)
        if best is not None:
            targetmap[v] = bverts[best[0]]
    if targetmap:
        bmesh.ops.weld_verts(bm, targetmap=targetmap)
        bm.to_mesh(me)
        me.update()
    bm.free()
    return len(targetmap)


def seam_summary(before, after):
    """Gaps after the run, flagged new when the pair had none (or smaller ones) before."""
    gaps = []
    for key, rec in sorted(after["pairs"].items()):
        if not rec["gaps"]:
            continue
        old = before["pairs"].get(key, {})
        gaps.append(dict(rec, objects=key.split("|"), new=rec["maxAbsDz"] > old.get("maxAbsDz", 0.0) + 1e-6,
                         gapsBefore=old.get("gaps", 0)))
    unmatched = {n: {"before": before["unmatched"].get(n, 0), "after": c}
                 for n, c in sorted(after["unmatched"].items()) if c != before["unmatched"].get(n, 0)}
    return {"toleranceXY": SEAM_XY, "gapDz": SEAM_DZ, "pairsChecked": len(after["pairs"]),
            "gaps": gaps, "newGaps": sum(1 for g in gaps if g["new"]), "unmatchedBoundaryChanged": unmatched}


def hash_objects(names):
    h, hc = hashlib.sha256(), hashlib.sha256()
    per = {}
    for n in sorted(names):
        o = bpy.data.objects.get(n)
        if o is None:
            continue
        co = positions(o).tobytes()
        h.update(n.encode())
        h.update(co)
        hc.update(n.encode())
        hc.update(colors(o).tobytes())
        per[n] = hashlib.sha256(co).hexdigest()[:16]
    return {"positions": h.hexdigest(), "colors": hc.hexdigest(), "objects": per}


# ---------------------------------------------------------------- mesh state (op-result cache, worker restores)
#
# A Spline mesh's whole state as numpy arrays: every attribute (positions, topology, selection, the byte
# colours as sRGB bytes, custom normals), polygon offsets, vertex-group weights, materials, custom props and
# the matrix. Rebuilding from it is exact (checked on all 776 Vreta meshes), so a replayed op result hashes
# the same as a computed one.

ENGINE_VERSION = "golfmap-shape-engine-2"
TOPOLOGY_ATTRS = (".corner_vert", ".corner_edge", ".edge_verts")
ATTR_IO = {  # data type -> (foreach key, numpy dtype, values per element)
    "FLOAT": ("value", np.float32, 1), "INT": ("value", np.int32, 1), "INT8": ("value", np.int32, 1),
    "BOOLEAN": ("value", np.bool_, 1), "FLOAT_VECTOR": ("vector", np.float32, 3), "FLOAT2": ("vector", np.float32, 2),
    "INT16_2D": ("value", np.int32, 2), "INT32_2D": ("value", np.int32, 2), "FLOAT_COLOR": ("color", np.float32, 4),
    "BYTE_COLOR": ("color_srgb", np.float32, 4), "QUATERNION": ("value", np.float32, 4), "FLOAT4X4": ("value", np.float32, 16),
}
# Op keys that never change geometry: left out of the op-result cache key.
NON_GEOMETRY_KEYS = {"id", "note", "origin", "originRef", "featureId", "maxDzWarnM", "enabled"}


def _attr_key(a):
    return "a|%s|%s|%s" % (a.name, a.domain, a.data_type)


def capture_state(obj):
    """(meta, arrays) of a mesh object; see state_hash / apply_state."""
    me = obj.data
    arrays = {}
    for a in me.attributes:
        io = ATTR_IO.get(a.data_type)
        if io is None:
            raise RuntimeError(f"{obj.name}: attribute {a.name} has unsupported type {a.data_type}")
        key, dtype, width = io
        v = np.empty(len(a.data) * width, dtype=dtype)
        a.data.foreach_get(key, v)
        arrays[_attr_key(a)] = v
    ps = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", ps)
    arrays["poly_start"] = ps
    if len(obj.vertex_groups) and len(me.vertices):
        vi, gi, wt = [], [], []
        for v in me.vertices:
            for g in v.groups:
                vi.append(v.index)
                gi.append(g.group)
                wt.append(g.weight)
        arrays["dv_vert"] = np.array(vi, np.int32)
        arrays["dv_group"] = np.array(gi, np.int32)
        arrays["dv_weight"] = np.array(wt, np.float32)
    meta = {"counts": [len(me.vertices), len(me.edges), len(me.polygons), len(me.loops)],
            "materials": [m.name if m else None for m in me.materials],
            "vgroups": [g.name for g in obj.vertex_groups],
            "props": {k: obj[k] for k in sorted(obj.keys()) if isinstance(obj[k], (str, int, float, bool))},
            "matrix": [[float(c) for c in row] for row in obj.matrix_world],
            "activeColor": me.color_attributes.active_color_name or None,
            "renderColor": me.color_attributes.render_color_index}
    return meta, arrays


def state_hash(meta, arrays):
    h = hashlib.sha1(json.dumps(meta, sort_keys=True).encode())
    for k in sorted(arrays):
        h.update(k.encode())
        h.update(np.ascontiguousarray(arrays[k]).tobytes())
    return h.hexdigest()


def _topology_same(meta, arrays, cur_meta, cur):
    if meta["counts"] != cur_meta["counts"]:
        return False
    keys = ["poly_start"] + [k for k in arrays if k.startswith("a|") and k.split("|")[1] in TOPOLOGY_ATTRS]
    return all(k in cur and np.array_equal(arrays[k], cur[k]) for k in keys)


def _build_mesh(name, meta, arrays):
    nv, ne, nf, nl = meta["counts"]
    me = bpy.data.meshes.new(name)
    me.vertices.add(nv)
    me.edges.add(ne)
    me.loops.add(nl)
    me.polygons.add(nf)
    by_name = {k.split("|")[1]: k for k in arrays if k.startswith("a|")}
    me.edges.foreach_set("vertices", arrays[by_name[".edge_verts"]])
    me.loops.foreach_set("vertex_index", arrays[by_name[".corner_vert"]])
    me.loops.foreach_set("edge_index", arrays[by_name[".corner_edge"]])
    me.polygons.foreach_set("loop_start", arrays["poly_start"])
    _set_attributes(me, arrays, skip=TOPOLOGY_ATTRS)
    for m in meta["materials"]:
        me.materials.append(bpy.data.materials.get(m) if m else None)
    return me


def _set_attributes(me, arrays, skip=(), cur=None):
    """Write the arrays' attributes into `me` (creating/replacing as needed; only those that differ from
    `cur`) and remove attributes the state does not have."""
    want = {}
    for k in arrays:
        if k.startswith("a|"):
            _, name, domain, dtype = k.split("|")
            want[name] = (k, domain, dtype)
    for a in list(me.attributes):
        if a.name not in want and a.name not in TOPOLOGY_ATTRS and a.name != "position":
            me.attributes.remove(a)
    for name in sorted(want):
        k, domain, dtype = want[name]
        if name in skip or (cur is not None and k in cur and np.array_equal(cur[k], arrays[k])):
            continue
        a = me.attributes.get(name)
        if a is not None and (a.domain != domain or a.data_type != dtype):
            me.attributes.remove(a)
            a = None
        if a is None:
            a = me.attributes.new(name, dtype, domain)
        a.data.foreach_set(ATTR_IO[dtype][0], arrays[k])


def _set_vertex_groups(obj, meta, arrays):
    obj.vertex_groups.clear()
    for g in meta["vgroups"]:
        obj.vertex_groups.new(name=g)
    if "dv_vert" not in arrays:
        return
    vs, gs, ws = arrays["dv_vert"], arrays["dv_group"], arrays["dv_weight"]
    for gi in range(len(meta["vgroups"])):
        m = gs == gi
        for w in np.unique(ws[m]):
            obj.vertex_groups[gi].add(vs[m][ws[m] == w].tolist(), float(w), "REPLACE")


def apply_state(name, meta, arrays):
    """Make object `name` hold exactly this state: in place when the topology is unchanged (only differing
    arrays written), else a rebuilt mesh swapped in. Creates the object (scene collection) when missing."""
    obj = bpy.data.objects.get(name)
    if obj is not None and obj.type == "MESH":
        cur_meta, cur = capture_state(obj)
        if _topology_same(meta, arrays, cur_meta, cur):
            me = obj.data
            _set_attributes(me, arrays, skip=TOPOLOGY_ATTRS, cur=cur)
            if cur_meta["materials"] != meta["materials"]:
                me.materials.clear()
                for m in meta["materials"]:
                    me.materials.append(bpy.data.materials.get(m) if m else None)
            if cur_meta["vgroups"] != meta["vgroups"] or any(
                    not np.array_equal(cur.get(k, np.zeros(0)), arrays.get(k, np.zeros(0))) for k in ("dv_vert", "dv_group", "dv_weight")):
                _set_vertex_groups(obj, meta, arrays)
            _finish_state(obj, meta)
            return obj
    me = _build_mesh(name, meta, arrays)
    if obj is None:
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
    else:
        old = obj.data
        obj.data = me
        if old.users == 0:
            old_name = old.name
            bpy.data.meshes.remove(old)
            me.name = old_name
    _set_vertex_groups(obj, meta, arrays)
    _finish_state(obj, meta)
    return obj


def _finish_state(obj, meta):
    me = obj.data
    if meta["activeColor"] and me.color_attributes.get(meta["activeColor"]) is not None:
        me.color_attributes.active_color = me.color_attributes[meta["activeColor"]]
    if meta["renderColor"] >= 0 and meta["renderColor"] < len(me.color_attributes):
        me.color_attributes.render_color_index = meta["renderColor"]
    for k in list(obj.keys()):
        if k not in meta["props"] and isinstance(obj[k], (str, int, float, bool)):
            del obj[k]
    for k, v in meta["props"].items():
        if obj.get(k) != v:
            obj[k] = v
    if [[float(c) for c in row] for row in obj.matrix_world] != meta["matrix"]:
        from mathutils import Matrix
        obj.matrix_world = Matrix(meta["matrix"])
    me.update()


def remove_object(name):
    obj = bpy.data.objects.get(name)
    if obj is None:
        return
    me = obj.data if obj.type == "MESH" else None
    bpy.data.objects.remove(obj)
    if me is not None and me.users == 0:
        bpy.data.meshes.remove(me)


def op_canonical(op, drop=("note",)):
    return json.dumps({k: v for k, v in op.items() if k not in drop}, sort_keys=True, separators=(",", ":"))


def _file_sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    except OSError:
        return None


def env_key():
    """What besides an op and its input meshes decides its result: engine and shims (this file), Blender,
    the Afrod / Edit Mesh Tools sources. (Recipe units add their recipe file, shape_paint and the library.)"""
    parts = [ENGINE_VERSION, bpy.app.version_string]
    for p in (os.path.abspath(__file__), os.path.join(HERE, "shape_layers.py")):
        parts.append(os.path.basename(p) + ":" + str(_file_sha(p)))
    for mod in (AFROD_MODULE, EMT_OFFSET_MODULE):
        m = sys.modules.get(mod)
        parts.append(mod + ":" + str(_file_sha(getattr(m, "__file__", "") or "") if m else None))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()


class OpCache:
    """Op-result cache on disk: <folder>/<key[:2]>/<key>.npz = the changed meshes' arrays (only those that
    differ from the input, `keep` names the rest) + a JSON `meta` (run record, per object meta + hash)."""

    def __init__(self, folder):
        self.folder = folder

    def path(self, key):
        return os.path.join(self.folder, key[:2], key + ".npz")

    def load(self, key):
        p = self.path(key)
        if not os.path.isfile(p):
            return None
        try:
            with np.load(p, allow_pickle=False) as data:
                meta = json.loads(bytes(data["meta"]).decode("utf-8"))
                arrays = {k: data[k] for k in data.files if k != "meta"}
            return meta, arrays
        except (OSError, ValueError, KeyError):
            self.delete(key)
            return None

    def store(self, key, meta, arrays):
        p = self.path(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "wb") as f:
            np.savez(f, meta=np.frombuffer(json.dumps(meta, default=str).encode("utf-8"), dtype=np.uint8), **arrays)
        os.replace(tmp, p)

    def delete(self, key):
        try:
            os.remove(self.path(key))
        except OSError:
            pass


POSITION_KEY = "a|position|POINT|FLOAT_VECTOR"


def max_abs_dz(old, new):
    """Largest |dz| between two vertex arrays (N, 3): per vertex when the counts agree, else each new vertex
    against the nearest old one in XY (topology changed)."""
    if not len(new) or not len(old):
        return 0.0
    if len(old) == len(new):
        return float(np.abs(new[:, 2].astype(np.float64) - old[:, 2]).max())
    kd = KDTree(len(old))
    for i, (x, y, _) in enumerate(old.tolist()):
        kd.insert((x, y, 0.0), i)
    kd.balance()
    dz = 0.0
    for x, y, z in new.tolist():
        _, i, _ = kd.find((x, y, 0.0))
        dz = max(dz, abs(z - float(old[i][2])))
    return dz


def unit_dz(writes, before):
    """Per object a unit wrote: its max |dz| against the unit's input (None: created by the unit)."""
    out = {}
    for n in writes:
        obj = bpy.data.objects.get(n)
        if obj is None:
            continue
        old = before.get(n, (None, {}))[1].get(POSITION_KEY)
        out[n] = None if old is None else round(max_abs_dz(old.reshape(-1, 3), positions(obj)), 4)
    return out


class Unit:
    """One run of an op: a feature group (Afrod ops, recipes) or the whole op ("*"). `reads(margin)` is the
    set of object names it may read or change (targets plus everything within its reach)."""

    def __init__(self, uid, targets, seed, reads, extra=""):
        self.id = uid
        self.targets = targets
        self.seed = seed
        self._reads = reads
        self.extra = extra
        self.current = None  # the reads resolved right before it runs
        self.cut_paint = None

    def reads(self, margin=0.0):
        return set(self._reads(margin)) | set(self.targets)


class History:
    """Worker snapshots: per object, its state before each op that changed it ((op index, mesh copy, object
    meta), mesh copies share their arrays with the live mesh until either changes). The state at any op
    boundary p is the first entry at or after p, else the live object."""

    ABSENT = None

    def __init__(self):
        self.entries = {}  # name -> [[op index, mesh name or None, meta or None]]
        self.counter = 0
        self.broken = []  # reasons the history can no longer restore exactly (escaped writes)

    def copy(self, name):
        obj = bpy.data.objects.get(name)
        if obj is None:
            return [None, None]
        me = obj.data.copy()
        self.counter += 1
        me.name = "gmsnap.%d" % self.counter
        me.use_fake_user = True
        return [me.name, {"props": {k: obj[k] for k in obj.keys() if isinstance(obj[k], (str, int, float, bool))},
                          "matrix": [list(r) for r in obj.matrix_world], "mesh": obj.data.name}]

    def has(self, name, index):
        return any(e[0] == index for e in self.entries.get(name, []))

    def record(self, name, index, snap):
        lst = self.entries.setdefault(name, [])
        lst.append([index, snap[0], snap[1]])
        lst.sort(key=lambda e: e[0])

    def state_at(self, name, index):
        for e in self.entries.get(name, []):
            if e[0] >= index:
                return e
        return None

    def restore(self, name, index):
        """Put object `name` back to its state before op `index`. Returns True when something was done."""
        e = self.state_at(name, index)
        if e is None:
            return False
        if e[1] is None:
            remove_object(name)
            return True
        src = bpy.data.meshes[e[1]]
        me = src.copy()
        me.use_fake_user = False
        obj = bpy.data.objects.get(name)
        if obj is None:
            obj = bpy.data.objects.new(name, me)
            bpy.context.scene.collection.objects.link(obj)
        else:
            old = obj.data
            obj.data = me
            if old.users == 0:
                bpy.data.meshes.remove(old)
        if me.name != e[2]["mesh"] and e[2]["mesh"] not in bpy.data.meshes:
            me.name = e[2]["mesh"]
        for k in list(obj.keys()):
            if k not in e[2]["props"] and isinstance(obj[k], (str, int, float, bool)):
                del obj[k]
        for k, v in e[2]["props"].items():
            obj[k] = v
        from mathutils import Matrix
        obj.matrix_world = Matrix(e[2]["matrix"])
        return True

    def truncate(self, names, index):
        """Drop the entries at or after `index` of these objects (they are about to be re-recorded)."""
        free = []
        for n in names:
            keep = []
            for e in self.entries.get(n, []):
                (keep if e[0] < index else free).append(e)
            if keep:
                self.entries[n] = keep
            else:
                self.entries.pop(n, None)
        self.free([e[1] for e in free])

    def remap(self, index_map, start, skip):
        """Renumber entries at or after `start` (old op index -> new) of objects not in `skip`. False when an
        entry's op is gone (then the history cannot be trusted)."""
        ok = True
        for n, lst in self.entries.items():
            if n in skip:
                continue
            for e in lst:
                if e[0] >= start:
                    if e[0] not in index_map:
                        ok = False
                        continue
                    e[0] = index_map[e[0]]
        return ok

    def free(self, mesh_names):
        ids = [bpy.data.meshes[m] for m in mesh_names if m and m in bpy.data.meshes]
        if ids:
            bpy.data.batch_remove(ids)

    def clear(self):
        self.free([e[1] for lst in self.entries.values() for e in lst])
        self.entries = {}
        self.broken = []


class UnitRunner:
    """Runs each op unit: resolves what it reads, keys the op-result cache on the op, the unit and the
    state hashes of everything it reads, replays a hit (verified against the stored result hashes) or
    computes and stores; records every unit's reads/writes (the worker's footprints) and, with a History,
    the state of each changed object before the op."""

    def __init__(self, cache=None, history=None):
        self.cache = cache
        self.history = history
        self.env = env_key()
        self.filter = None
        self.op_index = None
        self.op_key = None
        self.records = {}  # op key -> {unit id: {reads, writes, removed, created, cached, seconds}}
        self.op_units = []
        self.op_stored = []
        self.escapes = []  # (op key, names) written outside every unit's reads
        self.stats = {"hits": 0, "misses": 0, "stored": 0, "invalid": 0, "uncacheable": 0,
                      "keySeconds": 0.0, "replaySeconds": 0.0, "computeSeconds": 0.0, "savedSeconds": 0.0}

    def begin_op(self, index, key, unit_filter=None):
        self.op_index, self.op_key, self.filter = index, key, unit_filter
        self.op_units, self.op_stored = [], []
        if unit_filter is None:
            self.records[key] = {}
        else:
            self.records.setdefault(key, {})

    def end_op(self, changed_names):
        """changed_names: objects the op-level diff saw change. Any not written by a unit escaped the reads
        prediction: the op's cache entries are dropped and the history marked."""
        written = set()
        for uid in self.op_units:
            r = self.records[self.op_key][uid]
            written |= set(r["writes"]) | set(r["removed"])
        escaped = sorted(set(changed_names) - written)
        if escaped:
            self.escapes.append((self.op_key, escaped))
            for key in self.op_stored:
                self.cache.delete(key)
            self.stats["stored"] -= len(self.op_stored)
            self.stats["uncacheable"] += len(self.op_stored)
            for uid in self.op_units:
                self.records[self.op_key][uid]["reads"] = sorted(set(self.records[self.op_key][uid]["reads"]) | set(escaped))
            if self.history is not None:
                self.history.broken.append(f"{self.op_key} changed {escaped[:5]} outside its predicted reads")
        return escaped

    def key(self, ctx, op, unit, hashes):
        h = hashlib.sha256()
        h.update(self.env.encode())
        h.update(op_canonical(op, NON_GEOMETRY_KEYS).encode())
        h.update(json.dumps([unit.id, unit.seed, unit.extra, ctx.frame], sort_keys=True, default=str).encode())
        for n in sorted(hashes):
            h.update(("%s=%s;" % (n, hashes[n])).encode())
        return h.hexdigest()

    def run(self, ctx, op, unit, compute):
        if self.filter is not None and unit.id not in self.filter:
            return None
        object_mode()
        t0 = time.time()
        reads = sorted(n for n in unit.reads(0.0) if n in bpy.data.objects)
        unit.current = set(reads)
        names_before = {o.name for o in spline_meshes()}
        before = {n: capture_state(bpy.data.objects[n]) for n in reads}
        hashes = {n: state_hash(*before[n]) for n in reads}
        key = self.key(ctx, op, unit, hashes)
        pre = {n: self.history.copy(n) for n in reads} if self.history is not None else {}
        self.stats["keySeconds"] += time.time() - t0
        run, writes, removed, created = None, None, [], []
        if self.cache is not None:
            got = self.replay(key, before)
            if got is not None:
                run, writes, removed, created = got
        if run is None:
            t = time.time()
            try:
                run = compute()
            except Exception:
                # It may have changed any of its reads half-way: count them all as written (the worker can then
                # restore them) and let the op report the error.
                object_mode()
                names_after = {o.name for o in spline_meshes()}
                created = sorted(names_after - names_before)
                removed = sorted(names_before - names_after)
                touched = sorted((set(reads) | set(created)) - set(removed))
                ctx.forget(set(reads) | set(created))
                ctx.refresh()
                self.records[self.op_key][unit.id] = {"reads": reads, "writes": touched, "removed": removed,
                                                      "created": created, "cached": False, "failed": True,
                                                      "seconds": round(time.time() - t0, 3)}
                if unit.id not in self.op_units:
                    self.op_units.append(unit.id)
                if self.history is not None:
                    for n in touched + removed:
                        if not self.history.has(n, self.op_index):
                            self.history.record(n, self.op_index, [None, None] if n in created else pre.pop(n, [None, None]))
                    self.history.free([s[0] for s in pre.values()])
                raise
            object_mode()
            names_after = {o.name for o in spline_meshes()}
            created = sorted(names_after - names_before)
            removed = sorted(names_before - names_after)
            writes, post = [], {}
            for n in sorted(set(reads) | set(created)):
                if n not in names_after:
                    continue
                st = capture_state(bpy.data.objects[n])
                hs = state_hash(*st)
                if n in created or hs != hashes.get(n):
                    writes.append(n)
                    post[n] = (st, hs)
            elapsed = time.time() - t
            self.stats["computeSeconds"] += elapsed
            if self.cache is not None:
                self.stats["misses"] += 1
                if set(removed) <= set(reads):
                    self.store(key, run, writes, post, removed, created, before, elapsed)
                else:
                    self.stats["uncacheable"] += 1
        ctx.forget(set(writes) | set(removed))
        if set(created) | set(removed):
            ctx.refresh()
        rec = {"reads": reads, "writes": writes, "removed": removed, "created": created, "targets": list(unit.targets),
               "cached": bool(run.get("cached")), "seconds": round(time.time() - t0, 3),
               "dz": unit_dz(writes, before)}
        self.records[self.op_key][unit.id] = rec
        if unit.id not in self.op_units:
            self.op_units.append(unit.id)
        if self.history is not None:
            for n in set(writes) | set(removed):
                if self.history.has(n, self.op_index):
                    continue
                if n in created:
                    self.history.record(n, self.op_index, [None, None])
                elif n in pre:
                    self.history.record(n, self.op_index, pre.pop(n))
                else:
                    self.history.broken.append(f"{self.op_key}/{unit.id} changed {n} outside its reads")
            self.history.free([s[0] for s in pre.values()])
        return run

    def store(self, key, run, writes, post, removed, created, before, elapsed):
        meta = {"run": {k: v for k, v in run.items() if k != "seconds"}, "computeSeconds": round(elapsed, 3),
                "removed": removed, "created": created, "writes": []}
        arrays = {}
        for i, n in enumerate(writes):
            (m, arr), hs = post[n]
            old = before.get(n, (None, {}))[1]
            stored, keep = [], []
            for k in sorted(arr):
                if k in old and old[k].dtype == arr[k].dtype and np.array_equal(old[k], arr[k]):
                    keep.append(k)
                else:
                    arrays["o%d_%d" % (i, len(stored))] = arr[k]
                    stored.append(k)
            meta["writes"].append({"name": n, "meta": m, "hash": hs, "stored": stored, "keep": keep})
        self.cache.store(key, meta, arrays)
        self.op_stored.append(key)
        self.stats["stored"] += 1

    def replay(self, key, before):
        got = self.cache.load(key)
        if got is None:
            return None
        meta, arrays = got
        t = time.time()
        writes = [w["name"] for w in meta["writes"]]
        ok = True
        try:
            for i, w in enumerate(meta["writes"]):
                arr = {k: arrays["o%d_%d" % (i, j)] for j, k in enumerate(w["stored"])}
                for k in w["keep"]:
                    arr[k] = before[w["name"]][1][k]
                apply_state(w["name"], w["meta"], arr)
            for n in meta["removed"]:
                remove_object(n)
            for w in meta["writes"]:
                obj = bpy.data.objects.get(w["name"])
                if obj is None or state_hash(*capture_state(obj)) != w["hash"]:
                    ok = False
                    break
        except (KeyError, RuntimeError, ValueError, TypeError) as e:
            print(f"[shape_apply] cache entry {key[:12]} unusable: {e}")
            ok = False
        if not ok:  # put the inputs back and compute instead
            for n in writes:
                if n in before:
                    apply_state(n, *before[n])
                else:
                    remove_object(n)
            for n in meta["removed"]:
                if n in before:
                    apply_state(n, *before[n])
            self.cache.delete(key)
            self.stats["invalid"] += 1
            return None
        elapsed = time.time() - t
        self.stats["hits"] += 1
        self.stats["replaySeconds"] += elapsed
        self.stats["savedSeconds"] += max(0.0, meta.get("computeSeconds", 0.0) - elapsed)
        run = dict(meta["run"], cached=True, seconds=round(elapsed, 3))
        return run, writes, meta["removed"], meta["created"]

    def summary(self):
        return {k: round(v, 2) if isinstance(v, float) else v for k, v in self.stats.items()}


# ---------------------------------------------------------------- ops

class Ctx:
    def __init__(self, scene, index, svg_paths, scheme, frame):
        self.scene = scene
        self.index = index
        self.by_name = {r["name"]: r for r in index}
        self.svg_paths = svg_paths
        self.scheme = scheme
        self.frame = frame
        self.runner = UnitRunner()
        self._boxes = {}

    def refresh(self):
        """Rebuild the object index after objects were created, removed or renamed."""
        self.index = sl.build_index(_index_objects(), self.svg_paths)
        self.by_name = {r["name"]: r for r in self.index}

    def box(self, name):
        """XY bounding box of an object, cached until forget() (every unit forgets what it wrote)."""
        if name not in self._boxes:
            obj = bpy.data.objects.get(name)
            self._boxes[name] = bbox_xy(obj) if obj is not None and obj.type == "MESH" else None
        return self._boxes[name]

    def forget(self, names=None):
        if names is None:
            self._boxes.clear()
        else:
            for n in names:
                self._boxes.pop(n, None)


def _index_objects():
    return [{"name": o.name, "shapeId": o.get("opcd_shape_id"), "parentId": o.get("opcd_parent_id"),
             "kind": o.get("opcd_kind")} for o in spline_meshes()]


def feature_groups(ctx, op):
    recs, problems = sl.select(op["select"], ctx.index)
    return sl.group_by_feature(recs), problems


def group_seed(ctx, op, svg_id):
    if "seed" in op:
        return op["seed"]
    p = ctx.svg_paths.get(svg_id)
    return sl.feature_seed(p, ctx.scheme) if p else sl.stable_seed(svg_id)


def near_boxes(ctx, names, pad):
    """The names plus every Spline mesh whose XY box is within `pad` of one of theirs."""
    boxes = [b for b in (ctx.box(n) for n in names) if b]
    out = set(names)
    for o in spline_meshes():
        b = ctx.box(o.name)
        if b and o.name not in out and any(sl.bbox_distance(a, b) <= pad for a in boxes):
            out.add(o.name)
    return out


def tee_reads(ctx, op, names, margin=0.0):
    """What Afrod's tee flatten can reach: it puts every visible Spline mesh into Edit Mode and resizes with
    proportional editing of radius <= (tee half-size + outset), so meshes further away never move. With
    `focus` (default) the engine hides the others, which keeps them out of Edit Mode (seconds per tee)."""
    if op.get("focus", True) is False:
        return {o.name for o in spline_meshes() if not o.hide_get()} | set(names)
    outset = op.get("params", {}).get("tees_flat_outset", 0.0)
    boxes = [b for b in (ctx.box(n) for n in names) if b]
    box = (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))
    reach = max(box[2] - box[0], box[3] - box[1]) / 2 + outset + FOCUS_MARGIN
    out = set(names)
    for o in spline_meshes():
        if o.name in out or o.hide_get():
            continue
        b = ctx.box(o.name)
        if b is not None and sl.bbox_distance(box, b) <= reach + margin:
            out.add(o.name)
    return out


def _rna_default(ctx, prop):
    return ctx.scene.opcdtools.bl_rna.properties[prop].default


def plan_units(ctx, op):
    """The op's units in run order (one per feature group; "*" for the whole-op ops) and selector problems.
    Each unit's reads(margin) is what it may read or change: the worker's footprints and the cache key."""
    kind = op["op"]
    if kind == "golfmap.flatten_footprint":
        box = footprint_guard_box(ctx, op)
        return [Unit("*", [], None, lambda margin=0.0: {
            o.name for o in spline_meshes() if o.visible_get() and ctx.box(o.name)
            and sl.bbox_distance(box, ctx.box(o.name)) <= margin})], []
    if kind == "golfmap.split_surfaces":
        # select picks shapes; every object OPCD built from a picked shape (meshes, split pieces, blends) is split
        import shape_surfaces as ss
        recs, problems = sl.select(dict(op["select"], kind="any"), ctx.index)
        path = _split_sidecar(ctx, op)
        docs = ctx.__dict__.setdefault("_sidecars", {})
        if path not in docs:
            try:
                docs[path] = ss.load_sidecar(path)
            except (OSError, ValueError):
                docs[path] = None
        doc = docs[path]
        src = _file_sha(os.path.join(HERE, "shape_surfaces.py"))
        units = []
        for shape in sorted({r["svgId"] for r in recs if r["svgId"]}):
            names = sorted(r["name"] for r in ctx.index if r["svgId"] == shape)
            extra = json.dumps([ss.shape_key(doc, shape) if doc else None, src], sort_keys=True)
            units.append(Unit(shape, names, None, (lambda names: lambda margin=0.0: split_reads(ctx, names, margin))(names),
                              extra=extra))
        return units, problems
    if kind == "golfmap.cut_out":
        # one unit, named by the op; reads = every Spline mesh the cut can reach (the outline's box + 1 m; with
        # `rise`, + its apron, which it refines and moves) and every mesh within 1 m of their boxes: the welds run on
        # the whole boundary of those meshes and split their neighbours' edges (Omberg hall-58: a lake bed and a
        # gravel path 20 m off the apron). With rise mode dem, the DEM it samples keys the cache too.
        box = sl.polygon_bbox(cut_out_poly(ctx, op))
        reach = 1.0 + (rise_params(op["rise"])["apronM"] if op.get("rise") else 0.0)
        extra = ""
        if (op.get("rise") or {}).get("mode") == "dem":
            try:
                extra = json.dumps({"dem": course_dem_sha(ctx)})
            except OSError as e:          # cut_out reports it and cuts nothing
                extra = json.dumps({"dem": None, "error": str(e)})
        return [Unit(op["name"], [], None, lambda margin=0.0: near_boxes(ctx, [
            o.name for o in spline_meshes() if ctx.box(o.name)
            and sl.bbox_distance(box, ctx.box(o.name)) <= reach + margin], 1.0 + margin), extra=extra)], []
    if kind == "golfmap.weld_tjunctions":
        recs, problems = sl.select(op["select"], ctx.index)
        names = [r["name"] for r in recs]
        return [Unit("*", names, None, lambda margin=0.0: near_boxes(ctx, names, 1.0 + margin))], problems
    if kind == "golfmap.path_transition":
        import shape_surfaces as ss
        recs, problems = sl.select(dict(op["select"], kind="any"), ctx.index)
        doc = ss.load_sidecar(_split_sidecar(ctx, op))
        units = []
        for svg_id, group in sl.group_by_feature(recs):
            entries = [e for e in doc.get("transitions", []) if e.get("shape") == svg_id]
            if not entries:
                continue
            names = sorted(r["name"] for r in ctx.index if r["svgId"] == svg_id)
            extra = json.dumps([entries, _file_sha(os.path.join(HERE, "shape_transition.py")),
                               _file_sha(os.path.join(HERE, "shape_edgefade.py"))], sort_keys=True)
            units.append(Unit(svg_id, names, None,
                              (lambda names: lambda margin=0.0: set(names))(names), extra=extra))
        return units, problems
    if kind == "golfmap.path_kerb":
        # one unit per road shape (its hard pieces' strips); reads = the shape's objects + the meshes beside them,
        # whose vertices on a strip's outer edge drop with it (their boxes + 1 m)
        recs, problems = sl.select(dict(op["select"], kind="any"), ctx.index)
        src = _file_sha(os.path.join(HERE, "shape_kerb.py"))
        units = []
        for svg_id, group in sl.group_by_feature(recs):
            names = [r["name"] for r in group]
            units.append(Unit(svg_id, names, None,
                              (lambda names: lambda margin=0.0: near_boxes(ctx, names, 1.0 + margin))(names), extra=src))
        return units, problems
    if kind == "golfmap.path_edge_fade":
        # one unit per road shape: its path pieces and every blend object (the strips of several pieces share one);
        # reads = the shape's objects + what the weld afterwards can reach (their boxes + 1 m)
        recs, problems = sl.select(dict(op["select"], kind="any"), ctx.index)
        src = _file_sha(os.path.join(HERE, "shape_edgefade.py"))
        units = []
        for svg_id, group in sl.group_by_feature(recs):
            names = [r["name"] for r in group]
            units.append(Unit(svg_id, names, group_seed(ctx, op, svg_id),
                              (lambda names: lambda margin=0.0: near_boxes(ctx, names, 1.0 + margin))(names), extra=src))
        return units, problems
    groups, problems = feature_groups(ctx, op)
    weld = op.get("weld", True) is not False
    radius = None
    if kind == "afrod.smoothcartpaths":
        radius = op.get("params", {}).get("smooth_path_distance", _rna_default(ctx, "smooth_path_distance"))
    units = []
    for svg_id, recs in groups:
        names = [r["name"] for r in recs]
        seed = group_seed(ctx, op, svg_id)
        extra = ""
        if kind == "afrod.flattentees":
            reads = (lambda names: lambda margin=0.0: tee_reads(ctx, op, names, margin))(names)
        elif kind == "afrod.cutcartpaths":
            # the weld after the cut looks 0.5 m around each cut mesh
            reads = (lambda names: lambda margin=0.0: near_boxes(ctx, names, 1.0 + margin) if weld else set(names))(names)
            cut_paint = cut_paint_mode(ctx, op, svg_id)
            extra = json.dumps(cut_paint, sort_keys=True)
        elif kind == "afrod.smoothcartpaths":
            # smooth_outside moves every Spline vertex within the radius of the path's boundary
            reads = (lambda names: lambda margin=0.0: near_boxes(ctx, names, radius + 0.5 + margin))(names)
        elif kind == "afrod.recipe":
            names = [r["name"] for r in recs if r["kind"] == "mesh"]
            if not names:
                continue
            reads = (lambda names: lambda margin=0.0: recipe_reads(names))(names)
            plan = recipe_plan(ctx, op)
            if plan["seed"] is not None:
                seed = plan["seed"]
            extra = plan["key"]
        else:
            raise RuntimeError(f"no planner for {kind}")
        unit = Unit(svg_id, names, seed, reads, extra=extra)
        if kind == "afrod.cutcartpaths":
            unit.cut_paint = cut_paint
        units.append(unit)
    return units, problems


def run_afrod(ctx, op, operator, extra=None, focus=False, post=None, pre=None):
    """One call of an Afrod operator per feature (its objects selected), seeded per feature. pre(unit) runs
    before the operator, post(unit, what pre returned) after it (its result goes into the run's `post`)."""
    units, problems = plan_units(ctx, op)
    runs = []
    for unit in units:
        def compute(unit=unit):
            names, seed = unit.targets, unit.seed
            before = pre(unit) if pre else None
            reset_opcdtools(ctx.scene)
            set_params(ctx.scene, dict(extra or {}, **op.get("params", {})))
            seed_all(seed)
            hidden = hide_outside(unit.current | set(names)) if focus else []
            try:
                select_only(names)
                t = time.time()
                with bpy.context.temp_override(**view3d_override()), afrod_headless():
                    result = getattr(bpy.ops.wm, operator)()
                run = {"feature": unit.id, "targets": names, "seed": seed, "result": sorted(result),
                       "seconds": round(time.time() - t, 2)}
            finally:
                object_mode()
                for o in hidden:
                    o.hide_set(False)
            if post:
                run["post"] = post(unit, before)
            return run
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, problems


def hide_outside(keep):
    """Hide every visible Spline mesh not in `keep` (Afrod's tee flatten then leaves them out of Edit Mode)."""
    hidden = []
    for o in spline_meshes():
        if o.name in keep or o.hide_get():
            continue
        o.hide_set(True)
        hidden.append(o)
    return hidden


def op_flattentees(ctx, op):
    return run_afrod(ctx, op, "flattentees", {"tees_selection_type": "Selected"}, focus=op.get("focus", True) is not False)


def op_cutcartpaths(ctx, op):
    """Afrod's cut, then its slivers collapsed (collapse_cut_slivers, `sliverM`), then (unless "weld": false)
    golfmap.weld_tjunctions on the cut meshes, then the cut's paint per `cutPaint` (restore_cut_paint)."""
    weld = op.get("weld", True) is not False
    sliver = float(op.get("sliverM", SLIVER_M))

    def post(unit, before):
        slivers = collapse_cut_slivers(unit.targets, before, sliver)
        joints, guards = (joint_guards(unit.targets, before) if unit.cut_paint["mode"] == "keep" else (None, None))
        out = weld_tjunctions(unit.targets) if weld else {}
        out["cutPaint"] = restore_cut_paint(unit.targets, before, unit.cut_paint, joints)
        if guards is not None:
            out["cutPaint"]["guards"] = guards
        out["slivers"] = slivers
        return out

    return run_afrod(ctx, op, "cutcartpaths", pre=lambda unit: paint_snapshot(unit.targets), post=post)


# ---------------------------------------------------------------- the cut's slivers (afrod.cutcartpaths sliverM)
#
# Afrod's cut bisects the path with vertical planes wherever they fall, so a plane passing a few mm from an
# existing vertex splits every edge around it next to that vertex: new vertices 0.1 mm - a few cm from an old
# one, sliver triangles in between (Vreta: ~1000 cut edges under 5 cm). smoothcartpaths then smooths the path's
# z by topology (vertices_smooth x smooth_path_amt, not distance weighted), so two vertices 6 mm apart with
# different neighbours end up cm apart in height: near-vertical micro faces whose smooth-shaded normals draw a
# dark triangular smudge across the path in GSPro (Vreta, hole 13 tees: 8 cm of height over 6 mm, shading 50 deg
# off). Each cut vertex within `sliverM` (XY) of a vertex it shares a face with is merged into it (an old vertex
# first, shortest pair first; a chain may not carry a vertex further than sliverM, so the joint line bends by at
# most that). A cut vertex on the boundary only merges along a boundary edge, so the outline and its seams stay.

SLIVER_M = 0.05


def collapse_cut_slivers(names, snap, tol=SLIVER_M, mark_attr=None):
    """Merge the cut's new vertices into a vertex of one of their faces closer than `tol` in XY (see above).
    `snap`: the pre-cut paint_snapshot (its `co` tells old vertices from new). mark_attr: an int edge attribute
    whose non-zero marks survive the merge (golfmap.split_surfaces' seam edges: a cut edge merged onto an old edge
    passes its mark on, value 1 winning). Returns {sliverM, merged, objects: {mesh: merged}}."""
    import bmesh
    stats = {}
    if not tol or tol <= 0:
        return {"sliverM": tol, "merged": 0, "objects": stats}
    for n in sorted(names):
        obj = bpy.data.objects.get(n)
        old = (snap or {}).get(n)
        if obj is None or old is None or not len(old["co"]):
            continue
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        if FAST_SHIMS:
            new = _added_vertices(positions(obj), old["co"])
        else:
            kd = KDTree(len(old["co"]))
            for i, p in enumerate(old["co"].tolist()):
                kd.insert(p, i)
            kd.balance()
            new = {v.index for v in bm.verts if kd.find(tuple(v.co))[2] > 1e-5}
        if not new:
            bm.free()
            continue
        cands = []  # (XY distance, lower index, higher index, a, b): vertex pairs of one face, one a cut vertex
        seen = set()
        faces = bm.faces
        if FAST_SHIMS:
            # a face with no cut vertex offers no pair; `cands` is sorted by (distance, indices) below, so
            # which face offers a pair first does not matter
            bm.faces.index_update()
            faces = sorted({f for i in sorted(new) for f in bm.verts[i].link_faces}, key=lambda f: f.index)
        for f in faces:
            fv = list(f.verts)
            for i, a in enumerate(fv):
                for b in fv[i + 1:]:
                    if a.index not in new and b.index not in new:
                        continue
                    key = (min(a.index, b.index), max(a.index, b.index))
                    if key in seen:
                        continue
                    seen.add(key)
                    d = math.hypot(a.co.x - b.co.x, a.co.y - b.co.y)
                    if d < tol:
                        cands.append((d,) + key + ((a, b) if a.index < b.index else (b, a)))
        cands.sort(key=lambda c: c[:3])
        targetmap = {}
        for _, _, _, a, b in cands:
            if a in targetmap or b in targetmap:
                continue
            e = bm.edges.get((a, b))
            options = []
            for src, dst in ((a, b), (b, a)):
                if src.index not in new:
                    continue
                end = dst
                while end in targetmap:
                    end = targetmap[end]
                if end is src or math.hypot(src.co.x - end.co.x, src.co.y - end.co.y) >= tol:
                    continue  # a chain (src -> dst -> ...) may not carry src further than tol
                if src.is_boundary and not (e is not None and e.is_boundary and dst.is_boundary):
                    continue  # a boundary cut vertex moves only along the outline
                options.append((dst.index in new, src.index < dst.index, src, dst))  # old targets first, then keep the lower index
            if not options:
                continue
            _, _, src, dst = min(options, key=lambda o: o[:2])
            targetmap[src] = dst
        for src in sorted(targetmap, key=lambda v: v.index):  # resolve chains: weld_verts wants final targets
            end = targetmap[src]
            while end in targetmap:
                end = targetmap[end]
            targetmap[src] = end
        for src, dst in sorted(targetmap.items(), key=lambda kv: (kv[0].index, kv[1].index)):
            if bm.edges.get((src, dst)) is None:  # same face, no edge (an n-gon the cut left): split the face there first
                shared = list(set(src.link_faces) & set(dst.link_faces))
                if len(shared) > 1:
                    bm.faces.index_update()
                    shared.sort(key=lambda f: f.index)
                if shared:
                    bmesh.utils.face_split(shared[0], src, dst)
        lay = bm.edges.layers.int.get(mark_attr) if mark_attr else None
        if targetmap and lay is not None:
            for src, dst in targetmap.items():
                for e in list(src.link_edges):
                    if not e[lay]:
                        continue
                    x = e.other_vert(src)
                    x = targetmap.get(x, x)
                    if x is dst:
                        continue
                    e2 = bm.edges.get((dst, x))
                    if e2 is not None and (e[lay] == 1 or not e2[lay]):
                        e2[lay] = e[lay]
        if targetmap:
            bmesh.ops.weld_verts(bm, targetmap=targetmap)
            bm.to_mesh(me)
            me.update()
            stats[n] = len(targetmap)
        bm.free()
    return {"sliverM": tol, "merged": sum(stats.values()), "objects": stats}



# ---------------------------------------------------------------- the cut's paint (afrod.cutcartpaths cutPaint)
#
# Afrod's knife cut paints every vertex on each cut plane blue (color_to_vertices 'blue'): concrete expansion
# joints, for a path material whose blue channel is a joint texture. On any other path the blue channel is not a
# joint (Unity's path materials show it as green streaks). `cutPaint`: "restore" = every corner the cut painted
# gets the path's own paint back (a new vertex: interpolated along the old edge it split; an old vertex: its own
# old colour), "keep" = joints stay blue but only on the cut's new vertices (old vertices on the plane - the
# boundary end points, an end cap's fan centre - get their colour back, so a joint is the cut line, not a gradient
# over the faces around such a vertex), "auto" (default) = per path feature from its golf-map `surface`: concrete
# -> keep, anything else or unknown -> restore. The surface comes from the SVG shape's own `data-surface` (only a
# grass track has one; a hard road is one shape of every surface; source "svg"), else the op's `pathSurfaces` {feature id: surface},
# else the app database read-only ($GOLFMAP_APP_DB, default data/app.sqlite); decided in
# shape_layers.cut_paint_decision.

CUT_PAINT_MODES = ("auto", "restore", "keep")
BLUE = (0.0, 0.0, 1.0)
_SURFACES = {}


def path_surfaces(feature_ids):
    """{feature id: surface or None} from the app database (read-only), cached per process."""
    want = [f for f in feature_ids if f not in _SURFACES]
    if want:
        import sqlite3
        db = os.environ.get("GOLFMAP_APP_DB") or os.path.join(REPO, "data", "app.sqlite")
        found = {}
        try:
            conn = sqlite3.connect("file:" + db.replace(os.sep, "/") + "?mode=ro", uri=True)
            try:
                q = "SELECT id, attributes_json FROM course_features WHERE id IN (%s)" % ",".join("?" * len(want))
                for fid, attrs in conn.execute(q, want):
                    try:
                        found[fid] = (json.loads(attrs or "{}") or {}).get("surface")
                    except ValueError:
                        found[fid] = None
            finally:
                conn.close()
        except Exception as e:  # no database: unknown surfaces (restore)
            print(f"[shape_apply] path surfaces: {db} not readable ({e}); cut paint restored")
        for f in want:
            _SURFACES[f] = found.get(f)
    return {f: _SURFACES[f] for f in feature_ids}


def cut_paint_mode(ctx, op, svg_id):
    """{mode: restore|keep, surfaces, source} for one path unit of a cutcartpaths op."""
    return sl.cut_paint_decision(op, ctx.svg_paths.get(svg_id) or {}, path_surfaces)


def _vertex_colours(obj):
    """(per-vertex mean sRGB colour (N, 4) float64, corner colours (L, 4) float32, corner vertex (L,)) or None."""
    me = obj.data
    attr = me.color_attributes.get("Col")
    if attr is None or attr.domain != "CORNER":
        return None
    buf = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color_srgb", buf)
    buf = buf.reshape(-1, 4)
    cv = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", cv)
    n = len(me.vertices)
    acc = np.zeros((n, 4))
    cnt = np.zeros(n)
    np.add.at(acc, cv, buf.astype(np.float64))
    np.add.at(cnt, cv, 1.0)
    mean = acc / np.maximum(cnt, 1.0)[:, None]
    return mean, buf, cv


def _blue_corners(buf):
    """Corners whose paint reads blue (the paint check's dominant rule)."""
    rgb = buf[:, :3]
    mx = rgb.max(axis=1)
    return int(np.count_nonzero((mx >= 0.25) & (rgb[:, 2] > rgb[:, 0]) & (rgb[:, 2] > rgb[:, 1])))


def paint_snapshot(names):
    """Before the cut: per mesh its vertex positions, edges, per-vertex colours and blue corner count."""
    out = {}
    for n in names:
        obj = bpy.data.objects.get(n)
        vc = _vertex_colours(obj) if obj is not None else None
        if vc is None:
            continue
        me = obj.data
        ev = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get("vertices", ev)
        out[n] = {"co": positions(obj).astype(np.float64), "edges": ev.reshape(-1, 2), "colour": vc[0],
                  "blue": _blue_corners(vc[1])}
    return out


JOINT_GUARD_M = 0.03  # keep: guard cuts this far either side of a joint confine its blue to a thin line


def _cut_blue_vertices(obj, old):
    """Vertices the cut painted: every corner exactly blue, and not blue before the cut. (indices, positions)"""
    vc = _vertex_colours(obj)
    if vc is None:
        return np.zeros(0, dtype=np.int64), np.zeros((0, 3))
    _, buf, cv = vc
    exact = np.all(np.abs(buf[:, :3] - np.array(BLUE, dtype=np.float32)) < 1e-6, axis=1)
    n = len(obj.data.vertices)
    all_blue = np.ones(n, dtype=bool)
    np.logical_and.at(all_blue, cv, exact)
    has = np.zeros(n, dtype=bool)
    has[cv] = True
    co = positions(obj).astype(np.float64)
    kd = KDTree(len(old["co"]))
    for i, p in enumerate(old["co"].tolist()):
        kd.insert(p, i)
    kd.balance()
    idx = []
    for j in np.nonzero(all_blue & has)[0].tolist():
        _, i, d = kd.find(co[j].tolist())
        if d > 1e-5 or np.abs(old["colour"][i][:3] - np.array(BLUE)).max() > 1e-3:
            idx.append(j)
    idx = np.array(idx, dtype=np.int64)
    return idx, co[idx] if len(idx) else np.zeros((0, 3))


def joint_guards(names, snap, width=JOINT_GUARD_M):
    """keep: for every joint the cut painted (a connected run of vertices it painted blue), bisect the faces around
    it with two planes parallel to the joint, `width` either side, so its blue fades out within that strip instead
    of across whole faces (an end cap's fan: the whole cap). Returns ({name: joint vertex positions}, stats); the
    guard vertices get the path's paint back in restore_cut_paint."""
    import bmesh
    joints, stats = {}, {}
    for n in names:
        obj = bpy.data.objects.get(n)
        old = (snap or {}).get(n)
        if obj is None or old is None:
            continue
        idx, pts = _cut_blue_vertices(obj, old)
        joints[n] = pts
        if not len(idx):
            continue
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        blue = set(idx.tolist())
        seen, groups = set(), []
        for s in sorted(blue):
            if s in seen:
                continue
            stack, comp = [s], []
            seen.add(s)
            while stack:
                v = bm.verts[stack.pop()]
                comp.append(v.index)
                for e in v.link_edges:
                    w = e.other_vert(v).index
                    if w in blue and w not in seen:
                        seen.add(w)
                        stack.append(w)
            groups.append(sorted(comp))
        planes = []
        for comp in groups:
            if len(comp) < 2:
                continue
            p = np.array([tuple(bm.verts[i].co) for i in comp], dtype=np.float64)
            c = p.mean(axis=0)
            _, _, vt = np.linalg.svd(p[:, :2] - c[:2], full_matrices=False)
            d = vt[0]
            nrm = Vector((-d[1], d[0], 0.0))
            planes.append((comp, Vector(c), nrm))
        added = 0
        for comp, c, nrm in planes:
            bm.verts.ensure_lookup_table()
            verts = [bm.verts[i] for i in comp if i < len(bm.verts)]
            faces = list({f for v in verts for f in v.link_faces})
            for side in (1.0, -1.0):
                geom = faces + list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts})
                res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=c + nrm * (width * side), plane_no=nrm,
                                             clear_inner=False, clear_outer=False)
                added += sum(1 for el in res["geom_cut"] if isinstance(el, bmesh.types.BMVert))
                faces = list({f for v in verts if v.is_valid for f in v.link_faces})
        bm.to_mesh(me)
        bm.free()
        me.update()
        stats[n] = {"joints": len(planes), "guardVertices": added}
    return joints, stats


def restore_cut_paint(names, snap, mode, joints=None):
    """Put back the paint the cut changed (see above). restore: corners painted exactly (0, 0, 1) - what the cut
    writes - where the vertex was not blue before. keep: the joints (`joints`: positions of the vertices the cut
    painted, per mesh) stay blue; every other vertex the cut or its guards added gets the path's paint."""
    stats = {"mode": mode["mode"], "source": mode["source"], "surfaces": mode["surfaces"], "objects": {}}
    for n in names:
        obj = bpy.data.objects.get(n)
        old = (snap or {}).get(n)
        vc = _vertex_colours(obj) if obj is not None else None
        if old is None or vc is None:
            continue
        _, buf, cv = vc
        co = positions(obj).astype(np.float64)
        kd = KDTree(len(old["co"]))
        for i, p in enumerate(old["co"].tolist()):
            kd.insert(p, i)
        kd.balance()
        adj = {}
        for a, b in old["edges"].tolist():
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        target = np.empty((len(co), 4))
        is_new = np.zeros(len(co), dtype=bool)
        for j, p in enumerate(co.tolist()):
            _, i, d = kd.find(p)
            if d <= 1e-5:
                target[j] = old["colour"][i]
                continue
            is_new[j] = True
            best = (float("inf"), i, i, 0.0)
            pv = np.asarray(p)
            for _, a, _ in kd.find_n(p, 6):
                pa = old["co"][a]
                for b in adj.get(a, ()):
                    ab = old["co"][b] - pa
                    L = float(ab @ ab)
                    t = 0.0 if L <= 0 else min(1.0, max(0.0, float((pv - pa) @ ab) / L))
                    dist = float(np.linalg.norm(pa + ab * t - pv))
                    if dist < best[0]:
                        best = (dist, a, b, t)
            _, a, b, t = best
            target[j] = old["colour"][a] * (1 - t) + old["colour"][b] * t
        painted = np.all(np.abs(buf[:, :3] - np.array(BLUE, dtype=np.float32)) < 1e-6, axis=1)
        was_blue = np.all(np.abs(target[cv][:, :3] - np.array(BLUE)) < 1e-3, axis=1)
        fix = painted & ~was_blue
        if mode["mode"] == "keep":
            jp = (joints or {}).get(n)
            is_joint = np.zeros(len(co), dtype=bool)
            if jp is not None and len(jp):
                jkd = KDTree(len(jp))
                for i, p in enumerate(jp.tolist()):
                    jkd.insert(p, i)
                jkd.balance()
                for j, p in enumerate(co.tolist()):
                    is_joint[j] = jkd.find(p)[2] <= 2e-3
            fix = (is_new[cv] | painted) & ~is_joint[cv] & ~was_blue  # guard vertices and stray blue get the path's paint
        if fix.any():
            out = buf.copy()
            out[fix, :3] = target[cv[fix], :3].astype(np.float32)
            obj.data.color_attributes["Col"].data.foreach_set("color_srgb", out.reshape(-1))
            obj.data.update()
            buf = out
        stats["objects"][n] = {"newVertices": int(is_new.sum()), "cornersRestored": int(fix.sum()),
                               "jointVertices": int(len((joints or {}).get(n, ()))) if joints is not None else None,
                               "blueCornersBefore": old["blue"], "blueCornersAfter": _blue_corners(buf)}
    return stats


def op_weld_tjunctions(ctx, op):
    units, problems = plan_units(ctx, op)
    runs = []
    for unit in units:
        def compute(unit=unit):
            t = time.time()
            stats = weld_tjunctions(unit.targets, float(op.get("toleranceM", 1e-3)))
            return {"feature": None, "targets": unit.targets, "seed": None, "result": ["FINISHED"], "post": stats,
                    "seconds": round(time.time() - t, 2)}
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, problems


def op_smoothcartpaths(ctx, op):
    return run_afrod(ctx, op, "smoothcartpaths")


def recipe_path(op):
    """The recipe file: a path (absolute, or relative to $GOLFMAP_AFROD_RECIPES, then blender/recipes) or a
    recipe library id (blender/recipes/library.json)."""
    path = sl.find_recipe(op["recipe"], sl.recipe_dirs(REPO), REPO)
    if not path:
        raise RuntimeError(f"recipe {op['recipe']} not found in {sl.recipe_dirs(REPO)} or the recipe library")
    return path


def recipe_plan(ctx, op):
    """The op's recipe, parsed and parameterised (cached per op content): {path, format, steps (params applied),
    entry (library entry or None), values (param values), seed (overrides.seed or None), legacy (raw
    scene.opcdtools overrides), applied (param maps), warnings, key (op-result cache key part)}. Raises on a bad
    recipe, a map that matches no step, or overrides it cannot take."""
    canon = op_canonical(op, NON_GEOMETRY_KEYS)
    cache = ctx.__dict__.setdefault("_recipe_plans", {})
    if canon in cache:
        return cache[canon]
    import shape_paint
    path = recipe_path(op)
    parsed = sr.load_recipe(path)
    if parsed["problems"]:
        raise RuntimeError("recipe " + path + ": " + "; ".join(parsed["problems"]))
    lib = shape_paint.load_library()
    entry = shape_paint.find_entry(op["recipe"], lib) or shape_paint.find_entry(path, lib)
    decl = (entry or {}).get("params") or []
    values, seed, legacy, warnings = sr.resolve_overrides(decl, op.get("overrides"))
    steps, applied = sr.apply_params(parsed["steps"], decl, values)
    if legacy:
        props = ctx.scene.opcdtools.bl_rna.properties
        unknown = sorted(k for k in legacy if k not in props)
        if unknown:
            raise RuntimeError(f"overrides: {', '.join(unknown)} are neither params of recipe "
                               f"{(entry or {}).get('id', os.path.basename(path))} ({', '.join(p['id'] for p in decl) or 'none'}, seed) "
                               "nor scene.opcdtools props")
        if parsed["format"] != sr.AFROD:
            raise RuntimeError(f"overrides: raw scene.opcdtools props ({', '.join(sorted(legacy))}) only go with Afrod "
                               "recipes; use the recipe's params")
    # Afrod steps of a golfmap recipe paint in golfmap roles: their colours go through the step's paint map.
    translated = []
    if parsed["format"] == sr.FORMAT:
        role = lambda target, kind: shape_paint.role_weights(target, kind, lib)
        for i, s in enumerate(steps):
            if sr.step_source(s["op"]) != sr.AFROD:
                continue
            channels = sr.colour_channels(shape_paint.step_paint_map(entry, s, lib).get("mesh") or {}, "mesh", role)
            try:
                s["params"], changed = sr.translate_colours(s["params"], channels)
            except sr.RecipeError as e:
                raise RuntimeError(f"recipe {path} steps[{i}] {s['op']}: {e}")
            translated += [{"step": i, "field": k, "from": a, "to": b} for k, a, b in changed]
    parts = [str(_file_sha(p)) for p in (path, os.path.join(HERE, "shape_paint.py"), os.path.join(HERE, "shape_recipes.py"),
                                         os.path.join(REPO, "blender", "recipes", "library.json"))]
    studio = any(sr.is_studio(s["op"]) for s in steps)
    if studio:
        import shape_studios
        parts += [str(_file_sha(os.path.join(HERE, "shape_studios.py")))] + [str(_file_sha(p)) for p in shape_studios.studio_sources()]
        greens = sorted((p["id"], p.get("hole"), p.get("points")) for p in ctx.svg_paths.values() if p.get("type") == "green")
        parts.append(hashlib.sha1(json.dumps([greens, ctx.frame], sort_keys=True, default=str).encode()).hexdigest())
    plan = {"path": path, "format": parsed["format"], "steps": steps, "entry": entry, "lib": lib, "values": values,
            "seed": seed, "legacy": legacy, "applied": applied, "translated": translated, "warnings": warnings,
            "studio": studio, "key": "|".join(parts)}
    cache[canon] = plan
    return plan


def recipe_reads(meshes):
    """A recipe's meshes and their blends (Afrod's own pairing: metadata, else names; meshblendjoin joins
    the last one)."""
    out = set(meshes)
    afrod = sys.modules.get(AFROD_MODULE)
    for n in meshes:
        obj = bpy.data.objects.get(n)
        if obj is None:
            continue
        if afrod is not None and hasattr(afrod, "opcd_find_blends_for_mesh"):
            out |= {o.name for o in afrod.opcd_find_blends_for_mesh(obj)}
        else:
            pid = obj.get("opcd_parent_id")
            out |= {o.name for o in bpy.data.objects if o.type == "MESH" and pid and o.get("opcd_kind") == "blend"
                    and o.get("opcd_parent_id") == pid}
    return out


def _paint_hook():
    """shape_paint.remap_after_recipe (recipe paint -> the golfmap channel roles), when that module exists."""
    try:
        import shape_paint
    except ImportError:
        return None
    return getattr(shape_paint, "remap_after_recipe", None)


def _feature_objects(meshes):
    """The meshes and every blend with one of their opcd_parent_ids, sorted by name."""
    pids = {bpy.data.objects[n].get("opcd_parent_id") for n in meshes if n in bpy.data.objects}
    return sorted((o for o in bpy.data.objects if o.type == "MESH" and (o.name in meshes or (
        o.get("opcd_kind") == "blend" and o.get("opcd_parent_id") in pids and o.get("opcd_parent_id")))),
        key=lambda o: o.name)


def _run_afrod_step(item, step_dir):
    """One command through Afrod's JSON runner. Returns (result set, trace entry)."""
    step_file = os.path.join(step_dir, "step.json")
    with open(step_file, "w", encoding="utf-8") as f:
        json.dump([item], f)
    ts = time.time()
    error = None
    try:
        with bpy.context.temp_override(**view3d_override()), afrod_headless():
            r = bpy.ops.wm.readoperations(filepath=step_file)
    except RuntimeError as e:  # an Afrod operator raised (in background mode its error comes back as an exception)
        lines = [ln.strip() for ln in str(e).splitlines() if ln.strip() and not ln.strip().startswith(("Location:", "File ", "^"))]
        r, error = {"CANCELLED"}, (lines[-1] if lines else str(e))[:300]
    object_mode()
    sel = sorted(o.name for o in bpy.context.selected_objects)
    h = hashlib.sha256()
    for n in sel:
        h.update(positions(bpy.data.objects[n]).tobytes())
    out = {"command": next(iter(item)), "result": sorted(r), "selected": sel, "hash": h.hexdigest()[:12],
           "seconds": round(time.time() - ts, 3)}
    if error:
        out["error"] = error
    return r, out


def op_recipe(ctx, op):
    """A recipe per feature. Afrod recipes (a list of commands) run through Afrod's JSON runner
    (WM_OT_readoperations), one command per call; golfmap recipes (golfmap-recipe-v1) run their steps in order:
    studio steps through shape_studios (Bunker Studio / Shoreline Studio preview -> validate -> apply), Afrod steps
    as above, golfmap.paint_map. Library params (op `overrides`) are mapped onto the steps first (recipe_plan).
    Afrod's meshblendseparate renames the blend to `<mesh base>Blend` and gives both parts every material slot and
    the mesh's custom properties; the blend's name, slots and opcd_* properties are put back so FBX names and
    pairing survive. Paint ends in golfmap roles: an Afrod recipe is remapped once at the end (shape_paint); a
    golfmap recipe keeps it canonical step by step (OPCD's paint mapped before its first Afrod step unless a studio
    step repainted everything, a studio's output mapped right after it, Afrod paint colours translated)."""
    plan = recipe_plan(ctx, op)
    for w in plan["warnings"]:
        print(f"[shape_apply] {op['id']}: {w}")
    if plan["legacy"]:
        print(f"[shape_apply] {op['id']}: overrides win over every recipe step's params: {json.dumps(plan['legacy'], sort_keys=True)}")
    step_dir = os.path.join(bpy.app.tempdir or os.environ.get("TEMP", "."), "golfmap-recipe-steps")
    os.makedirs(step_dir, exist_ok=True)
    units, sel_problems = plan_units(ctx, op)
    runs = []
    for unit in units:
        def compute(unit=unit):
            meshes = unit.targets
            keep = {}
            for n in meshes:
                obj = bpy.data.objects[n]
                keep[n] = _identity(obj)
                pid = obj.get("opcd_parent_id")
                blends = sorted(o.name for o in bpy.data.objects
                                if o.type == "MESH" and o.get("opcd_kind") == "blend" and pid and o.get("opcd_parent_id") == pid)
                if blends:
                    keep[blends[-1]] = dict(_identity(bpy.data.objects[blends[-1]]), joinedInto=n)
            start = {o.name: capture_state(o) for o in _feature_objects(meshes)}
            names_before = set(bpy.data.objects.keys())
            reset_opcdtools(ctx.scene)
            seed_all(unit.seed)
            select_only(meshes)
            t = time.time()
            if plan["format"] == sr.AFROD:
                trace, result, extra = _run_afrod_recipe(ctx, plan, step_dir)
            else:
                trace, result, extra = _run_golfmap_recipe(ctx, op, plan, unit, step_dir)
            if "FINISHED" not in result:
                # A step failed: the feature goes back to what it was (a half-run recipe is no look anyone wants).
                object_mode()
                failed = next((s for s in reversed(trace) if s.get("error") or "FINISHED" not in s.get("result", [])), {})
                extra.setdefault("error", f"steps[{failed.get('step')}] {failed.get('op') or failed.get('command')}: "
                                          f"{failed.get('error') or failed.get('result')}")
                for n in sorted(set(bpy.data.objects.keys()) - names_before):
                    if bpy.data.objects[n].type == "MESH":
                        remove_object(n)
                for n, st in start.items():
                    apply_state(n, *st)
                object_mode()
                fixed = []
            else:
                fixed = _restore_identities(keep)
                if extra.get("_jitter"):
                    _run_edge_jitter(meshes, extra["_jitter"], unit.seed, trace, extra)
            extra.pop("_jitter", None)
            run = {"feature": unit.id, "targets": sorted(keep), "seed": unit.seed, "result": sorted(result),
                   "recipe": plan["path"], "format": plan["format"], "restored": fixed,
                   "seconds": round(time.time() - t, 2), "trace": trace}
            if plan["values"]:
                run["params"] = plan["values"]
                run["paramMaps"] = [{k: a[k] for k in ("param", "step", "field", "mode", "before", "after")} for a in plan["applied"]]
            if plan["legacy"]:
                run["overrides"] = plan["legacy"]
            run.update(extra)
            if "FINISHED" in result:
                objs = [bpy.data.objects[n] for n in sorted(keep) if n in bpy.data.objects]
                if plan["format"] == sr.AFROD:
                    remap = _paint_hook()
                    if remap is not None:
                        run["paint"] = remap(objs, op["recipe"])
                else:
                    import shape_paint
                    shape_paint.mark_golfmap(objs, (plan["entry"] or {}).get("id") or os.path.basename(plan["path"]))
                object_mode()
            return run
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, sel_problems


def _run_afrod_recipe(ctx, plan, step_dir):
    """An Afrod recipe's commands, one per call of Afrod's runner (what it does in its own loop), so the report can
    say which step failed and trace each step's result. Raw overrides go into every step and onto the scene."""
    trace, result = [], {"FINISHED"}
    for i, item in enumerate(sr.afrod_items(plan["steps"])):
        if plan["legacy"]:  # into the step's args (what Afrod's runner reads) and the scene (what the operator reads)
            (cmd, args), = item.items()
            item = {cmd: dict(args, **plan["legacy"])}
            set_params(ctx.scene, plan["legacy"])
        r, entry = _run_afrod_step(item, step_dir)
        trace.append(dict(entry, step=i))
        if "FINISHED" not in r:
            result = r
            break
    return trace, result, {}


def _run_golfmap_recipe(ctx, op, plan, unit, step_dir):
    """A golfmap recipe's steps on one feature (see op_recipe). Returns (trace, result, extra run keys)."""
    import shape_paint
    lib, entry = plan["lib"], plan["entry"]
    meshes = unit.targets
    trace, result, extra = [], {"FINISHED"}, {"paint": []}
    canonical = False
    shift = None
    for i, step in enumerate(plan["steps"]):
        src = sr.step_source(step["op"])
        ts = time.time()
        if sr.is_studio(step["op"]):
            import shape_studios
            studio = []
            for m in meshes:
                object_mode()
                if step["op"] == "bunkerstudio.shape":
                    rec = shape_studios.run_bunker_studio(m, step["params"], ctx.by_name.get(m), ctx.svg_paths, ctx.frame,
                                                          view3d_override())
                else:
                    rec = shape_studios.run_shoreline_studio(m, step["params"], unit.seed, view3d_override())
                studio.append(rec)
                if rec.get("error"):
                    break
            object_mode()
            extra.setdefault("studio", []).extend(studio)
            failed = [r for r in studio if r.get("error")]
            trace.append({"step": i, "op": step["op"], "result": ["CANCELLED"] if failed else ["FINISHED"],
                          "error": failed[0]["error"] if failed else None, "seconds": round(time.time() - ts, 3)})
            if failed:
                result = {"CANCELLED"}
                extra["error"] = f"{step['op']}: {failed[0]['error']}"
                break
            objs = _feature_objects(meshes)
            rows = shape_paint.remap_objects(objs, shape_paint.step_paint_map(entry, step, lib), lib)
            extra["paint"].append({"step": i, "source": step["op"], "objects": rows})
            canonical = True
            seed_all(unit.seed)  # the Afrod steps draw the same numbers whatever the studio did
            select_only(meshes)
        elif src == sr.AFROD:
            if not canonical:
                rows = shape_paint.remap_opcd_default(_feature_objects(meshes), lib)
                extra["paint"].append({"step": i, "source": "opcdDefault", "objects": rows["objects"]})
                canonical = True
                select_only(meshes)
            if shift is None and any(s.get("ringsFromSeam") for s in plan["steps"][i:]):
                # before the first Afrod step: the blend is still its own object (meshblendjoin merges it)
                import shape_studios
                shift = shape_studios.blend_rows(bpy.data.objects[meshes[0]]) - 1
                extra["seamRing"] = shift + 1
            args = sr.shift_insets(step["params"], shift) if step.get("ringsFromSeam") else step["params"]
            r, rec = _run_afrod_step({step["op"].split(".", 1)[1]: args}, step_dir)
            trace.append(dict(rec, step=i, op=step["op"], args=args))
            if "FINISHED" not in r:
                result = r
                break
        elif step["op"] == "golfmap.paint_map":
            rows = shape_paint.remap_objects(_feature_objects(meshes), step["params"]["map"], lib)
            extra["paint"].append({"step": i, "source": "golfmap.paint_map", "objects": rows})
            canonical = True
            trace.append({"step": i, "op": step["op"], "result": ["FINISHED"], "seconds": round(time.time() - ts, 3)})
        elif step["op"] == "golfmap.edge_jitter":
            # Runs after the feature's names are put back (op_recipe: an Afrod meshblendseparate leaves the mesh part
            # as `<name>.001` until then); validate_steps keeps these steps last.
            if not canonical:  # jitter works on golfmap roles: OPCD's paint is mapped first, as before an Afrod step
                rows = shape_paint.remap_opcd_default(_feature_objects(meshes), lib)
                extra["paint"].append({"step": i, "source": "opcdDefault", "objects": rows["objects"]})
                canonical = True
            extra.setdefault("_jitter", []).append((i, step["params"]))
    return trace, result, extra


def _run_edge_jitter(meshes, pending, seed, trace, extra):
    """The recipe's golfmap.edge_jitter steps (deferred by _run_golfmap_recipe) on the feature, names restored."""
    import shape_paint
    object_mode()
    for i, params in pending:
        ts = time.time()
        rows = shape_paint.edge_jitter(_feature_objects(meshes), params, seed or 0)
        extra["paint"].append({"step": i, "source": "golfmap.edge_jitter", "objects": rows})
        trace.append({"step": i, "op": "golfmap.edge_jitter", "result": ["FINISHED"], "seconds": round(time.time() - ts, 3)})


def _identity(obj):
    return {"name": obj.name, "props": {k: obj[k] for k in obj.keys() if isinstance(obj[k], (str, int, float))},
            "materials": [m.name if m else None for m in obj.data.materials]}


def _restore_identities(keep):
    fixed = []
    # Meshes first: Afrod's meshblendseparate names the mesh part `<base>Mesh` while the blend part still
    # holds that name, so Blender (4.x never renames the other ID) gives the mesh `<name>.001`.
    for orig, ident in sorted(keep.items(), key=lambda kv: "joinedInto" in kv[1]):
        obj = bpy.data.objects.get(orig)
        if obj is None and "joinedInto" not in ident:
            cands = sorted(o.name for o in bpy.data.objects if o.name.startswith(orig + ".") and o.name[len(orig) + 1:].isdigit())
            if cands:
                obj = bpy.data.objects[cands[0]]
                fixed.append(f"renamed {obj.name} -> {orig}")
                obj.name = orig
        if obj is None and "joinedInto" in ident:
            base = ident["joinedInto"][:-4]  # "..._-_Mesh" -> "..._-_"
            cands = sorted(o.name for o in bpy.data.objects if o.name == base + "Blend" or o.name.startswith(base + "Blend."))
            if cands:
                obj = bpy.data.objects[cands[0]]
                fixed.append(f"renamed {obj.name} -> {orig}")
                obj.name = orig
        if obj is None:
            fixed.append(f"{orig} is gone")
            continue
        for k, v in ident["props"].items():
            if obj.get(k) != v:
                obj[k] = v
                fixed.append(f"{orig}: {k} = {v}")
        mats = [m.name if m else None for m in obj.data.materials]
        if mats != ident["materials"]:
            _set_materials(obj, ident["materials"])
            fixed.append(f"{orig}: materials {mats} -> {ident['materials']}")
    return fixed


def _set_materials(obj, names):
    me = obj.data
    current = [m.name if m else None for m in me.materials]
    idx = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("material_index", idx)
    remap = np.array([names.index(n) if n in names else 0 for n in current] or [0], dtype=np.int32)
    idx = remap[np.clip(idx, 0, len(remap) - 1)]
    me.materials.clear()
    for n in names:
        me.materials.append(bpy.data.materials.get(n) if n else None)
    me.polygons.foreach_set("material_index", idx)
    me.update()


def footprint_guard_box(ctx, op):
    poly = [shape_coords.to_blend(e, n, ctx.frame) for e, n in op["footprint3006"]]
    falloff = float(op.get("falloffM", 0.0))
    band = float(op.get("protectBandM", falloff if falloff > 0 else 1.0))
    return sl.polygon_bbox(poly, falloff + band)


def op_flatten_footprint(ctx, op):
    units, _ = plan_units(ctx, op)
    runs = []
    for unit in units:
        run = ctx.runner.run(ctx, op, unit, lambda: flatten_footprint(ctx, op))
        if run is not None:
            runs.append(run)
    return runs, []


def flatten_footprint(ctx, op):
    """Level every Spline mesh vertex inside an EPSG:3006 footprint (median/mean/min/plane of the
    vertices inside, + offsetM) and blend the ones outside within falloffM by Afrod's smooth falloff of
    their XY distance to the outline."""
    poly = [shape_coords.to_blend(e, n, ctx.frame) for e, n in op["footprint3006"]]
    falloff = float(op.get("falloffM", 0.0))
    protect = set(op.get("protect", sl.DEFAULT_PROTECT))
    protected = {r["name"]: r["type"] for r in ctx.index if r["type"] in protect}
    band = float(op.get("protectBandM", falloff if falloff > 0 else 1.0))
    box = sl.polygon_bbox(poly, falloff)
    guard_box = sl.polygon_bbox(poly, falloff + band)
    verts, arrays, guard_pts, overlap = [], {}, [], set()
    for o in spline_meshes():
        if not o.visible_get():
            continue
        co = positions(o)
        if not len(co):
            continue
        if o.name in protected:
            m = (co[:, 0] >= guard_box[0]) & (co[:, 0] <= guard_box[2]) & (co[:, 1] >= guard_box[1]) & (co[:, 1] <= guard_box[3])
            for i in np.nonzero(m)[0]:
                x, y = float(co[i, 0]), float(co[i, 1])
                guard_pts.append((x, y))
                if sl.point_in_polygon(x, y, poly):
                    overlap.add(o.name)
            continue
        m = (co[:, 0] >= box[0]) & (co[:, 0] <= box[2]) & (co[:, 1] >= box[1]) & (co[:, 1] <= box[3])
        if not m.any():
            continue
        arrays[o.name] = co
        for i in np.nonzero(m)[0]:
            verts.append(((o.name, int(i)), float(co[i, 0]), float(co[i, 1]), float(co[i, 2])))
    if overlap:
        return {"feature": None, "targets": [], "seed": None, "result": ["CANCELLED"],
                "skipped": "footprint overlaps protected " + ", ".join(sorted(f"{n} ({protected[n]})" for n in overlap))}
    guard = None
    if guard_pts:
        kd = KDTree(len(guard_pts))
        for i, (x, y) in enumerate(guard_pts):
            kd.insert((x, y, 0.0), i)
        kd.balance()
        guard = lambda x, y: kd.find((x, y, 0.0))[2]
    t = time.time()
    moves, n_inside = sl.footprint_moves(verts, poly, op.get("level", "median"), falloff, float(op.get("offsetM", 0.0)),
                                         guard=guard, band=band)
    for (name, i), z in moves.items():
        arrays[name][i, 2] = z
    touched = sorted({name for name, _ in moves})
    for name in touched:
        me = bpy.data.objects[name].data
        me.vertices.foreach_set("co", arrays[name].reshape(-1))
        me.update()
    return {"feature": None, "targets": touched, "seed": None, "result": ["FINISHED"], "insideVerts": n_inside,
            "protectedNear": sorted({n for n in protected if n in arrays}) or None, "guardVerts": len(guard_pts),
            "protectBandM": band, "seconds": round(time.time() - t, 2)}


# ---------------------------------------------------------------- golfmap.split_surfaces
#
# The SVG writes every touching road piece as ONE shape per network (`roads_124`: asphalt and gravel, 85 pieces):
# OPCD's build needs the junction fillets dissolved inside one shape, and splitting the shapes in the SVG left
# slivers along seams through junctions. So the split happens here, on OPCD's meshes: the sidecar
# `<svg stem>-paths.json` (`golfmap-path-regions-v1`) gives every piece's surface and outline, shape_surfaces.Regions
# turns them into one region per surface and the seams between them (the higher road's own kerb lines), and per
# mixed shape (a unit) this:
#
# 1. cuts every road mesh of the shape along the seam polylines (a gravel / dirt road's seam against asphalt, concrete
#    or paving ragged: Regions `raggedM`, default shape_surfaces.DEFAULT_RAGGED; 0 = the straight kerb) (insert_polyline: crossed edges split at the exact
#    crossing, faces split between consecutive crossings with the polyline's own bends as new vertices, z from the
#    face plane; the seam is an exact edge chain both sides share), plus a fade line `fadeM` into the lower side
#    (Regions.fade_lines) so the paint fade has vertices to live on (OPCD's ~1 m triangles have none);
# 2. collapses the cut's slivers (collapse_cut_slivers, `sliverM`) and closes the T-junctions the cut left on the
#    neighbours' edges (weld_tjunctions: the blends' inner edges, the shape's other pieces across hole boundaries);
# 3. classifies faces: components bounded by seam edges vote by an interior point's region (area weighted;
#    Regions.region fills what no piece covers with the nearest region); a component the cut did not close off
#    falls back to per-face points; then small parts join the neighbour they share the longest edge with
#    (_merge_small_parts: an island under `minPartM2` that does not carry on into the next OPCD piece, and any
#    surface that would be an object under `minPartM2`);
# 4. blends (`_B_` strips around the shape, one quad row): a face takes the class of the road face its inner edge
#    lies on; a face whose inner edge changes class (where a seam leaves the road) is split straight across the
#    strip there (its outer T-junction welded onto whatever lies outside); small parts as in 3;
# 5. paints the fade: on the lower surface's road faces, every corner within `fadeM` of a seam to a higher surface
#    (not asphalt / concrete: a crisp edge) gets its colour times distance / fadeM (red at fadeM, black at the
#    seam: Unity's MAHS material draws red = own surface, black = the neighbour's);
# 6. separates one object per (object, surface): `Spline_<shape>_<surface>_<rest of the OPCD name>`, opcd ids with
#    the surface after the shape (`roads_124_gravel_3`, blends `roads_124_gravel`), `opcd_kind` kept, plus
#    `golfmap_surface` and `golfmap_split_from`; custom normals set per vertex from the whole mesh's normals before
#    the split (OPCD's are the smooth vertex normals), so both sides of a seam shade alike; the original objects
#    are removed (their FBX deleted by the export / worker sync).

SPLIT_FADE_M = 0.5
SPLIT_MIN_PART_M2 = 1.0
SPLIT_EPS = 5e-4  # a polyline passing this close to a vertex goes through it (float32 positions: ~1e-4 m apart here)
SPLIT_EDGE_ATTR = "golfmap_split_edge"  # 1 = seam cut, 2 = fade line (removed before the op ends)
SPLIT_CLASS_ATTR = "golfmap_split_class"  # face: index into the unit's surface list
SPLIT_VN_ATTR = "golfmap_split_vn"  # vertex: smooth normal before the cut
SEAM_CUT, FADE_CUT = 1, 2


def _split_sidecar(ctx, op):
    """The road-surface sidecar: op `paths` (relative to the SVG's folder), else <svg stem>-paths.json."""
    import shape_surfaces as ss
    svg = getattr(ctx, "svg_file", None) or ""
    if op.get("paths"):
        p = op["paths"]
        return p if os.path.isabs(p) else os.path.join(os.path.dirname(svg), p)
    return ss.sidecar_for_svg(svg)


def split_reads(ctx, names, margin=0.0):
    """The shape's objects plus everything the welds can reach (their boxes + 1 m)."""
    return near_boxes(ctx, names, 1.0 + margin)


def _surface_name(name, shape, surface):
    """Spline_roads_124_3_Concrete_-_Mesh -> Spline_roads_124_gravel_3_Concrete_-_Mesh (the surface right after the
    shape name, the OPCD suffixes kept); roads_124_3 -> roads_124_gravel_3, roads_124 -> roads_124_gravel."""
    for pre in ("Spline_" + shape, shape):
        if name == pre:
            return pre + "_" + surface
        if name.startswith(pre + "_"):
            return pre + "_" + surface + name[len(pre):]
    return name + "_" + surface


def _face_xy(f):
    return [(v.co.x, v.co.y) for v in f.verts]


def _plane_z(f, x, y):
    """z of the face's plane at (x, y) (Newell normal: sub-faces of a triangle are planar)."""
    vs = [v.co for v in f.verts]
    nx = ny = nz = 0.0
    for i in range(len(vs)):
        a, b = vs[i - 1], vs[i]
        nx += (a.y - b.y) * (a.z + b.z)
        ny += (a.z - b.z) * (a.x + b.x)
        nz += (a.x - b.x) * (a.y + b.y)
    c = Vector((sum(v.x for v in vs), sum(v.y for v in vs), sum(v.z for v in vs))) / len(vs)
    if abs(nz) < 1e-12:
        return c.z
    return c.z - (nx * (x - c.x) + ny * (y - c.y)) / nz


def _face_point(f):
    """A point inside the face (its vertex mean when that is inside, else the centroid of its largest triangle:
    a face the cut bent around a seam corner is concave and its mean can lie outside it)."""
    import shape_surfaces as ss
    c = f.calc_center_median()
    poly = _face_xy(f)
    if len(poly) == 3 or ss.point_in_ring(c.x, c.y, poly):
        return c.x, c.y
    from mathutils.geometry import tessellate_polygon
    vs = [v.co for v in f.verts]
    best, pt = -1.0, (c.x, c.y)
    for i, j, k in tessellate_polygon([vs]):
        a, b, d = vs[i], vs[j], vs[k]
        area = abs((b.x - a.x) * (d.y - a.y) - (d.x - a.x) * (b.y - a.y))
        if area > best:
            best, pt = area, ((a.x + b.x + d.x) / 3, (a.y + b.y + d.y) / 3)
    return pt


def _edge_grid(bm, box, cell=2.0):
    import shape_surfaces as ss
    grid = {}
    x0, y0, x1, y1 = box
    for e in bm.edges:
        a, b = e.verts[0].co, e.verts[1].co
        if max(a.x, b.x) < x0 or min(a.x, b.x) > x1 or max(a.y, b.y) < y0 or min(a.y, b.y) > y1:
            continue
        for cx in range(math.floor(min(a.x, b.x) / cell), math.floor(max(a.x, b.x) / cell) + 1):
            for cy in range(math.floor(min(a.y, b.y) / cell), math.floor(max(a.y, b.y) / cell) + 1):
                grid.setdefault((cx, cy), []).append(e)
    return grid, cell


def _grid_edges(grid, cell, a, b, pad):
    """Edges in the cells along segment ab (sampled every half cell, a 3x3 neighbourhood each)."""
    out, seen = [], set()
    L = math.dist(a, b)
    steps = max(1, int(math.ceil(L / (cell / 2))))
    cells = set()
    for i in range(steps + 1):
        x = a[0] + (b[0] - a[0]) * i / steps
        y = a[1] + (b[1] - a[1]) * i / steps
        cx, cy = math.floor(x / cell), math.floor(y / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                cells.add((cx + dx, cy + dy))
    for c in sorted(cells):
        for e in grid.get(c, ()):
            if id(e) not in seen:
                seen.add(id(e))
                out.append(e)
    return out


def insert_polyline(bm, pts, mark, layer, vn_layer=None, eps=SPLIT_EPS):
    """Cut a 2D polyline into a (planar in XY) BMesh as an exact edge chain: every edge it crosses is split at
    the crossing (z linear along the edge), a vertex within `eps` is passed through, consecutive crossings
    inside one face are joined by a face split whose intermediate vertices are the polyline's own bends (z on the
    face plane). Parts of the polyline outside the mesh cut nothing (and so do its ends inside a face: the cut
    stops at the last edge it crossed). The chain's edges get `mark` in the int edge layer. Returns stats."""
    import bmesh
    import shape_surfaces as ss
    stats = {"edgeSplits": 0, "faceSplits": 0, "throughVertices": 0, "alongEdges": 0, "outside": 0, "failed": 0}
    if len(pts) < 2:
        return stats
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    grid, cell = _edge_grid(bm, (min(xs) - 1.0, min(ys) - 1.0, max(xs) + 1.0, max(ys) + 1.0))
    if not grid:
        return stats
    events = []  # [s along the polyline, kind, payload]: kind v (BMVert), x (split: [edge, point]), i (inner point)
    S = 0.0
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]
        L = math.dist(a, b)
        events.append([S, "i", a])
        if L < 1e-9:
            continue
        for e in _grid_edges(grid, cell, a, b, eps):
            u, v = e.verts
            du, tu = ss.seg_point_distance(u.co.x, u.co.y, a[0], a[1], b[0], b[1])
            dv, tv = ss.seg_point_distance(v.co.x, v.co.y, a[0], a[1], b[0], b[1])
            if du <= eps:
                events.append([S + tu * L, "v", u])
            if dv <= eps:
                events.append([S + tv * L, "v", v])
            if du <= eps or dv <= eps:
                continue
            for t in ss.seg_intersections(a, b, (u.co.x, u.co.y), (v.co.x, v.co.y), 1e-12):
                p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                if math.dist(p, (u.co.x, u.co.y)) <= eps or math.dist(p, (v.co.x, v.co.y)) <= eps:
                    continue
                events.append([S + t * L, "x", [e, p]])
        S += L
    events.append([S, "i", pts[-1]])
    # Split every crossed edge (all its crossings, in order from one end) and give the events their vertex.
    by_edge = {}
    for ev in events:
        if ev[1] == "x":
            by_edge.setdefault(ev[2][0], []).append(ev)
    for edge in sorted(by_edge, key=lambda e: (e.verts[0].co.x, e.verts[0].co.y, e.verts[1].co.x, e.verts[1].co.y)):
        v0, v1 = edge.verts
        evs = sorted(by_edge[edge], key=lambda ev: math.dist((v0.co.x, v0.co.y), ev[2][1]))
        cur, cur_from = edge, v0
        last = None
        for ev in evs:
            p = ev[2][1]
            if last is not None and math.dist((last.co.x, last.co.y), p) <= eps:
                ev[1], ev[2] = "v", last
                continue
            span = math.hypot(v1.co.x - cur_from.co.x, v1.co.y - cur_from.co.y)
            fac = math.hypot(p[0] - cur_from.co.x, p[1] - cur_from.co.y) / span if span else 0.5
            if not 0.0 < fac < 1.0:
                ev[1], ev[2] = "v", (cur_from if fac <= 0 else v1)
                continue
            _, w = bmesh.utils.edge_split(cur, cur_from, fac)
            w.co.x, w.co.y = p
            stats["edgeSplits"] += 1
            ev[1], ev[2] = "v", w
            last = w
            cur_from = w
            cur = next(e for e in w.link_edges if e.other_vert(w) == v1)
    events.sort(key=lambda ev: (ev[0], ev[1] == "i"))
    # Inner points that coincide with a vertex event are that vertex.
    seq = []
    for ev in events:
        if ev[1] == "i":
            p = ev[2]
            if seq and seq[-1][0] == "v" and math.dist((seq[-1][1].co.x, seq[-1][1].co.y), p) <= eps:
                continue
            seq.append(("i", p, ev[0]))
        else:
            if seq and seq[-1][0] == "i" and math.dist(seq[-1][1], (ev[2].co.x, ev[2].co.y)) <= eps:
                seq.pop()
            seq.append(("v", ev[2], ev[0]))
    last_v, inner = None, []
    for kind, item, _ in seq:
        if kind == "i":
            if last_v is not None:
                inner.append(item)
            continue
        w = item
        if last_v is not None and w is not last_v:
            _connect(bm, last_v, w, inner, mark, layer, vn_layer, stats)
        elif last_v is w and not inner:
            stats["throughVertices"] += 1
        last_v, inner = w, []
    return stats


def _connect(bm, va, vb, inner, mark, layer, vn_layer, stats):
    """Join two vertices of the cut (consecutive along the polyline) through `inner` points inside one face."""
    import bmesh
    import shape_surfaces as ss
    e = bm.edges.get((va, vb))
    if e is not None and not inner:
        if e[layer] != SEAM_CUT:
            e[layer] = mark
        stats["alongEdges"] += 1
        return
    path = [(va.co.x, va.co.y)] + list(inner) + [(vb.co.x, vb.co.y)]
    probes = list(inner) + [((path[i][0] + path[i + 1][0]) / 2, (path[i][1] + path[i + 1][1]) / 2) for i in range(len(path) - 1)]
    common = [f for f in va.link_faces if f in set(vb.link_faces)]
    face = None
    for f in sorted(common, key=lambda f: f.index):
        poly = _face_xy(f)
        if all(ss.point_in_ring(x, y, poly) for x, y in probes):
            face = f
            break
    if face is None:
        mid = probes[-1] if not inner else probes[0]
        inside = any(ss.point_in_ring(mid[0], mid[1], _face_xy(f)) for f in set(va.link_faces) | set(vb.link_faces))
        stats["failed" if inside and common else "outside"] += 1
        return
    coords = [(x, y, _plane_z(face, x, y)) for x, y in inner]
    before = set(face.verts)
    try:
        new_face, loop = bmesh.utils.face_split(face, va, vb, coords=coords, use_exist=True)
    except (ValueError, RuntimeError):
        stats["failed"] += 1
        return
    stats["faceSplits"] += 1
    if new_face is None:
        stats["failed"] += 1
        return
    # The new chain: va -> the coords' new vertices -> vb.
    chain = [va]
    pool = [v for v in set(face.verts) | set(new_face.verts) if v not in before]
    for x, y in inner:
        w = min(pool, key=lambda v: (v.co.x - x) ** 2 + (v.co.y - y) ** 2) if pool else None
        if w is not None and math.hypot(w.co.x - x, w.co.y - y) < 1e-3:  # float32 positions
            chain.append(w)
            if vn_layer is not None:  # a new inner vertex: the smooth normal of the face it splits
                n = Vector((0.0, 0.0, 0.0))
                for v in before:
                    n += Vector(v[vn_layer])
                w[vn_layer] = n.normalized() if n.length else Vector((0.0, 0.0, 1.0))
    chain.append(vb)
    for p, q in zip(chain, chain[1:]):
        e = bm.edges.get((p, q))
        if e is not None:
            e[layer] = mark


def _insert_points(bm, points, vn_layer=None, eps=SPLIT_EPS):
    """Make each point that lies strictly inside a (convex) face a vertex: the face poked (a fan) and its new
    centre moved to the point. Points on an edge or a vertex are left to the cut. Returns the number inserted."""
    import bmesh
    import shape_surfaces as ss
    cell = 2.0
    grid = {}
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    x0, y0, x1, y1 = min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1
    for f in bm.faces:
        fx = [v.co.x for v in f.verts]
        fy = [v.co.y for v in f.verts]
        if max(fx) < x0 or min(fx) > x1 or max(fy) < y0 or min(fy) > y1:
            continue
        for cx in range(math.floor(min(fx) / cell), math.floor(max(fx) / cell) + 1):
            for cy in range(math.floor(min(fy) / cell), math.floor(max(fy) / cell) + 1):
                grid.setdefault((cx, cy), []).append(f)
    done = 0
    seen = set()
    for x, y in points:
        k = (round(x, 5), round(y, 5))
        if k in seen:
            continue
        seen.add(k)
        for f in grid.get((math.floor(x / cell), math.floor(y / cell)), ()):
            if not f.is_valid:
                continue
            poly = _face_xy(f)
            if not ss.point_in_ring(x, y, poly):
                continue
            near_edge = any(ss.seg_point_distance(x, y, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1])[0] <= eps
                            for i in range(len(poly)))
            convex = len(poly) == 3 or all(
                ((poly[i][0] - poly[i - 1][0]) * (poly[(i + 1) % len(poly)][1] - poly[i][1])
                 - (poly[i][1] - poly[i - 1][1]) * (poly[(i + 1) % len(poly)][0] - poly[i][0])) * _orient(poly) >= 0
                for i in range(len(poly)))
            if near_edge or not convex:
                break
            z = _plane_z(f, x, y)
            res = bmesh.ops.poke(bm, faces=[f])
            v = res["verts"][0]
            v.co = Vector((x, y, z))
            fans = res["faces"]
            for cx in range(math.floor((x - 2) / cell), math.floor((x + 2) / cell) + 1):  # keep the grid usable
                for cy in range(math.floor((y - 2) / cell), math.floor((y + 2) / cell) + 1):
                    grid.setdefault((cx, cy), []).extend(fans)
            done += 1
            break
    return done


def _orient(poly):
    a = 0.0
    for i in range(len(poly)):
        a += poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1]
    return 1.0 if a >= 0 else -1.0


def _store_vertex_normals(obj):
    """Each vertex's smooth normal (mean of its corner normals) as a vertex attribute the cut interpolates."""
    me = obj.data
    cn = np.empty(len(me.loops) * 3, dtype=np.float32)
    me.corner_normals.foreach_get("vector", cn)
    cn = cn.reshape(-1, 3).astype(np.float64)
    cv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", cv)
    acc = np.zeros((len(me.vertices), 3))
    np.add.at(acc, cv, cn)
    acc /= np.maximum(np.linalg.norm(acc, axis=1), 1e-12)[:, None]
    a = me.attributes.get(SPLIT_VN_ATTR) or me.attributes.new(SPLIT_VN_ATTR, "FLOAT_VECTOR", "POINT")
    a.data.foreach_set("vector", acc.astype(np.float32).reshape(-1))


def _cut_mesh(obj, seams, fades):
    """Insert the seam and fade polylines (blend coordinates) whose box meets the object's into its mesh."""
    import bmesh
    stats = {"seams": 0, "fades": 0}
    box = bbox_xy(obj)
    me = obj.data
    if SPLIT_VN_ATTR not in me.attributes:
        _store_vertex_normals(obj)
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.edges.layers.int.get(SPLIT_EDGE_ATTR) or bm.edges.layers.int.new(SPLIT_EDGE_ATTR)
    vn_layer = bm.verts.layers.float_vector.get(SPLIT_VN_ATTR)
    # A seam chain that ends inside the mesh (where it meets another chain at a node, or a slit's medial line
    # joins a kerb) would stop at the last edge it crossed, and so would the chain on the other side of the node:
    # the face around the node stays uncut and the regions leak into each other there. So every chain end inside a
    # face becomes a vertex first (the face poked, its centre moved to the end point; z on the face plane).
    ends = [p for pts in seams for p in (pts[0], pts[-1])
            if box[0] - 1 <= p[0] <= box[2] + 1 and box[1] - 1 <= p[1] <= box[3] + 1]
    stats["nodesInserted"] = _insert_points(bm, ends, vn_layer) if ends else 0
    for kind, lines, mark in (("seams", seams, SEAM_CUT), ("fades", fades, FADE_CUT)):
        for pts in lines:
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            if max(xs) < box[0] - 1 or min(xs) > box[2] + 1 or max(ys) < box[1] - 1 or min(ys) > box[3] + 1:
                continue
            st = insert_polyline(bm, pts, mark, layer, vn_layer)
            if st["edgeSplits"] or st["faceSplits"] or st["alongEdges"]:
                stats[kind] += 1
            for k, v in st.items():
                stats[k] = stats.get(k, 0) + v
    bm.to_mesh(me)
    bm.free()
    me.update()
    return stats


def _components(faces, connected):
    """Connected components of `faces` (BMFaces) where connected(edge) says faces may join across it."""
    comp = {}
    out = []
    for f in faces:
        if f in comp:
            continue
        stack, cur = [f], []
        comp[f] = len(out)
        while stack:
            g = stack.pop()
            cur.append(g)
            for e in g.edges:
                if not connected(e):
                    continue
                for h in e.link_faces:
                    if h not in comp:
                        comp[h] = len(out)
                        stack.append(h)
        out.append(cur)
    return out


def _edge_key(a, b):
    return frozenset(((round(a.x, 4), round(a.y, 4)), (round(b.x, 4), round(b.y, 4))))


def _merge_small_parts(objs, surfaces, min_area):
    """Small parts of the classified objects (all road meshes, or all blends, of one shape) join the neighbour they
    share the longest edge with (smallest first, until none is left): a connected part under min_area that does not
    carry on into another of the objects across their shared boundary (an island: a piece's end cap poking past the
    other road's kerb), and every part of a surface whose faces in an object add up to under min_area (it would be a
    tiny object; also when it carries on into the next OPCD piece). Returns {object: [{from, to, areaM2, at,
    why}]}."""
    import bmesh
    shared = {}  # boundary edge -> {(object, class)}
    for obj in objs:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        cls = bm.faces.layers.int.get(SPLIT_CLASS_ATTR)
        for e in bm.edges:
            if len(e.link_faces) == 1:
                shared.setdefault(_edge_key(e.verts[0].co, e.verts[1].co), set()).add((obj.name, e.link_faces[0][cls]))
        bm.free()
    out = {}
    for obj in objs:
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        cls = bm.faces.layers.int.get(SPLIT_CLASS_ATTR)
        merged = []
        for _ in range(500):
            area = {}
            for f in bm.faces:
                area[f[cls]] = area.get(f[cls], 0.0) + f.calc_area()
            if len(area) < 2:
                break
            parts = _components(list(bm.faces), lambda e: len(e.link_faces) == 2 and e.link_faces[0][cls] == e.link_faces[1][cls])
            cands = []
            for part in parts:
                own = part[0][cls]
                a = sum(f.calc_area() for f in part)
                if area[own] < min_area:
                    cands.append((a, "tinyObject", part))
                elif a < min_area:
                    goes_on = any(n != obj.name and c == own for f in part for e in f.edges if len(e.link_faces) == 1
                                  for n, c in shared.get(_edge_key(e.verts[0].co, e.verts[1].co), ()))
                    if not goes_on:
                        cands.append((a, "island", part))
            moved = False
            for a, why, part in sorted(cands, key=lambda c: (c[0], c[2][0].index)):
                pset = set(part)
                own = part[0][cls]
                touch = {}
                for f in part:
                    for e in f.edges:
                        for h in e.link_faces:
                            if h not in pset and h[cls] != own:
                                touch[h[cls]] = touch.get(h[cls], 0.0) + e.calc_length()
                if not touch:
                    continue
                to = max(sorted(touch), key=lambda c: touch[c])
                c = sum((f.calc_center_median() for f in part), Vector()) / len(part)
                merged.append({"from": surfaces[own], "to": surfaces[to], "areaM2": round(a, 3), "why": why,
                               "at": [round(c.x, 2), round(c.y, 2)]})
                for f in part:
                    f[cls] = to
                moved = True
                break  # the parts changed: look again
            if not moved:
                break
        if merged:
            bm.to_mesh(me)
            me.update()
            out[obj.name] = merged
        bm.free()
    return out


def _classify_mesh(obj, regions, surfaces):
    """Face classes of a cut road mesh (step 3 above) into the face attribute SPLIT_CLASS_ATTR."""
    import bmesh
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.edges.layers.int.get(SPLIT_EDGE_ATTR)
    cls = bm.faces.layers.int.get(SPLIT_CLASS_ATTR) or bm.faces.layers.int.new(SPLIT_CLASS_ATTR)
    stats = {"components": 0, "mixedComponents": 0, "filledFaces": 0, "smallPartsMerged": 0, "unsealedEdges": 0}
    seam = (lambda e: e[layer] == SEAM_CUT) if layer is not None else (lambda e: False)
    comps = _components(list(bm.faces), lambda e: len(e.link_faces) == 2 and not seam(e))
    for comp in comps:
        votes, per = {}, []
        for f in comp:
            x, y = _face_point(f)
            s, filled = regions.region(x, y)
            stats["filledFaces"] += int(filled)
            a = f.calc_area()
            votes[s] = votes.get(s, 0.0) + a
            per.append((f, s))
        total = sum(votes.values()) or 1.0
        top = max(sorted(votes), key=lambda s: votes[s])
        stats["components"] += 1
        if votes[top] >= 0.99 * total:
            for f in comp:
                f[cls] = surfaces.index(top)
        else:
            stats["mixedComponents"] += 1
            for f, s in per:
                f[cls] = surfaces.index(s)
    # Where the class changes across an edge the cut did not make (a mixed component: per-face classes), the
    # boundary follows the triangles: count them (and where) so the report says where to look.
    loose = []
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.link_faces[0][cls] != e.link_faces[1][cls] and not seam(e):
            loose.append(e)
    stats["unsealedEdges"] = len(loose)
    if loose:
        c = (loose[0].verts[0].co + loose[0].verts[1].co) / 2
        stats["unsealedAt"] = [round(c.x, 2), round(c.y, 2)]
    bm.to_mesh(me)
    bm.free()
    me.update()
    return stats


def _road_edge_classes(meshes):
    """KD tree over the midpoints of the road meshes' boundary edges -> (endpoints, class) for the blends."""
    import bmesh
    mids, recs = [], []
    for obj in meshes:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        cls = bm.faces.layers.int.get(SPLIT_CLASS_ATTR)
        for e in bm.edges:
            if len(e.link_faces) != 1:
                continue
            a, b = e.verts[0].co, e.verts[1].co
            mids.append(((a.x + b.x) / 2, (a.y + b.y) / 2))
            recs.append(((a.x, a.y), (b.x, b.y), e.link_faces[0][cls]))
        bm.free()
    kd = KDTree(len(mids))
    for i, (x, y) in enumerate(mids):
        kd.insert((x, y, 0.0), i)
    kd.balance()
    return kd, recs


def _road_class_of(kd, recs, a, b, tol=2e-3):
    """Class of the road boundary edge that coincides with edge ab (XY), else None."""
    _, i, d = kd.find(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.0))
    if i is None or d > tol:
        return None
    p, q, c = recs[i]
    if (math.dist(p, a) <= tol and math.dist(q, b) <= tol) or (math.dist(p, b) <= tol and math.dist(q, a) <= tol):
        return c
    return None


def _classify_blend(obj, kd, recs, regions, surfaces):
    """Blend faces take the class of the road face their inner edge lies on; a face whose inner edges change
    class is split straight across the strip at the change (step 4 above)."""
    import bmesh
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    cls = bm.faces.layers.int.get(SPLIT_CLASS_ATTR) or bm.faces.layers.int.new(SPLIT_CLASS_ATTR)
    vn_layer = bm.verts.layers.float_vector.get(SPLIT_VN_ATTR)
    stats = {"byRoadEdge": 0, "byRegion": 0, "acrossSplits": 0, "smallPartsMerged": 0}
    todo = list(bm.faces)
    while todo:
        f = todo.pop()
        loops = list(f.loops)
        n = len(loops)
        ecls = []  # per loop edge (loop i: verts i -> i+1): road class or None
        for lp in loops:
            a, b = lp.vert.co, lp.link_loop_next.vert.co
            ecls.append(_road_class_of(kd, recs, (a.x, a.y), (b.x, b.y)))
        known = [c for c in ecls if c is not None]
        if not known:
            x, y = _face_point(f)
            f[cls] = surfaces.index(regions.region(x, y)[0])
            stats["byRegion"] += 1
            continue
        if len(set(known)) == 1:
            f[cls] = known[0]
            stats["byRoadEdge"] += 1
            continue
        # The inner chain: the run of consecutive loop edges on the road (cyclic); the change vertex P where the
        # class switches; the outer chain the rest. Split from P across to the outer chain at the same fraction.
        start = next((i for i in range(n) if ecls[i] is not None and ecls[i - 1] is None), None)
        if start is None:
            f[cls] = max(set(known), key=known.count)
            stats["byRoadEdge"] += 1
            continue
        inner = []
        i = start
        while ecls[i % n] is not None and len(inner) < n:
            inner.append(i % n)
            i += 1
        change = next((k for k in range(1, len(inner)) if ecls[inner[k]] != ecls[inner[k - 1]]), None)
        outer_idx = [(start + len(inner) + k) % n for k in range(n - len(inner))]  # loop edges of the outer chain
        if change is None or not outer_idx:
            f[cls] = max(set(known), key=known.count)
            stats["byRoadEdge"] += 1
            continue
        verts = [lp.vert for lp in loops]
        P = verts[inner[change]]
        inner_pts = [verts[inner[0]]] + [verts[(j + 1) % n] for j in inner]
        lens = [math.hypot(q.co.x - p.co.x, q.co.y - p.co.y) for p, q in zip(inner_pts, inner_pts[1:])]
        frac = sum(lens[:change]) / (sum(lens) or 1.0)
        # The rest of the loop runs inner end -> side edge -> outer edge(s) -> side edge -> inner start; the outer
        # edge proper (without the two sides across the strip) runs from the corner beside the inner END to the
        # one beside its START, so the inner fraction from the start is 1 - fraction along it.
        outer_pts = [verts[outer_idx[0]]] + [verts[(j + 1) % n] for j in outer_idx]
        if len(outer_pts) < 4:  # no outer edge between two sides (a triangle cap): no straight split
            f[cls] = max(set(known), key=known.count)
            stats["byRoadEdge"] += 1
            continue
        outer_pts = outer_pts[1:-1]
        olens = [math.hypot(q.co.x - p.co.x, q.co.y - p.co.y) for p, q in zip(outer_pts, outer_pts[1:])]
        target = (1.0 - frac) * sum(olens)
        acc, k = 0.0, 0
        while k < len(olens) - 1 and acc + olens[k] < target:
            acc += olens[k]
            k += 1
        p0, p1 = outer_pts[k], outer_pts[k + 1]
        t = (target - acc) / olens[k] if olens[k] else 0.0
        if t * olens[k] < 0.01:
            Q = p0
        elif (1 - t) * olens[k] < 0.01:
            Q = p1
        else:
            edge = bm.edges.get((p0, p1))
            _, Q = bmesh.utils.edge_split(edge, p0, t)
        if Q is P or bm.edges.get((P, Q)) is not None:
            f[cls] = max(set(known), key=known.count)
            continue
        try:
            g, _ = bmesh.utils.face_split(f, P, Q)
        except (ValueError, RuntimeError):
            f[cls] = max(set(known), key=known.count)
            continue
        stats["acrossSplits"] += 1
        todo += [f, g]
    bm.to_mesh(me)
    bm.free()
    me.update()
    return stats


def _mesh_classes(obj):
    """Arrays of a classified mesh: face class (F,), corner -> face (L,), corner vertex (L,), corner edge (L,),
    edge vertices (E, 2), world XY-Z positions (V, 3)."""
    me = obj.data
    fc = np.zeros(len(me.polygons), dtype=np.int32)
    ca = me.attributes.get(SPLIT_CLASS_ATTR)
    if ca is not None:
        ca.data.foreach_get("value", fc)
    ls = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_start", ls)
    lt = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_total", lt)
    corner_face = np.empty(len(me.loops), dtype=np.int64)
    for f, (s0, n) in enumerate(zip(ls.tolist(), lt.tolist())):
        corner_face[s0:s0 + n] = f
    cv = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", cv)
    ce = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("edge_index", ce)
    ev = np.empty(len(me.edges) * 2, dtype=np.int32)
    me.edges.foreach_get("vertices", ev)
    mw = np.array(obj.matrix_world)
    co = positions(obj).astype(np.float64) @ mw[:3, :3].T + mw[:3, 3]
    return fc, corner_face, cv, ce, ev.reshape(-1, 2), co


def _shape_seams(meshes, surfaces):
    """Every seam edge of the classified road meshes of a shape: edges whose two faces differ in class, and
    boundary edges two meshes share (an OPCD piece boundary) with different classes on either side. Returns
    (grids: {low class: SegmentGrid of the fading seams}, neighbours: {low class: {higher surfaces}}, report:
    {pair: {edges, lengthM, acrossPieces}})."""
    import shape_surfaces as ss
    grids, neighbours, report = {}, {}, {}
    shared = {}  # boundary edge key -> [(class, a, b)]

    def add(c0, c1, a, b, across):
        s0, s1 = surfaces[c0], surfaces[c1]
        k = "/".join(sorted((s0, s1), key=ss.rank))
        rec = report.setdefault(k, {"edges": 0, "lengthM": 0.0, "acrossPieces": 0})
        rec["edges"] += 1
        rec["lengthM"] += math.hypot(b[0] - a[0], b[1] - a[1])
        rec["acrossPieces"] += int(across)
        if ss.is_sharp(s0, s1):
            return
        hi = ss.higher(s0, s1)
        lo = c1 if hi == s0 else c0
        grids.setdefault(lo, ss.SegmentGrid(2.0)).add((a[0], a[1]), (b[0], b[1]))
        neighbours.setdefault(lo, set()).add(hi)

    for obj in meshes:
        fc, corner_face, cv, ce, ev, co = _mesh_classes(obj)
        edge_faces = {}
        for corner, e in enumerate(ce.tolist()):
            edge_faces.setdefault(e, []).append(int(corner_face[corner]))
        for e, fs in edge_faces.items():
            a, b = co[ev[e, 0]], co[ev[e, 1]]
            if len(fs) == 1:
                key = frozenset(((round(a[0], 4), round(a[1], 4)), (round(b[0], 4), round(b[1], 4))))
                shared.setdefault(key, []).append((int(fc[fs[0]]), a, b))
            elif len(fs) == 2 and fc[fs[0]] != fc[fs[1]]:
                add(int(fc[fs[0]]), int(fc[fs[1]]), a, b, False)
    for lst in shared.values():
        if len(lst) == 2 and lst[0][0] != lst[1][0]:
            add(lst[0][0], lst[1][0], lst[0][1], lst[0][2], True)
    report = {k: dict(v, lengthM=round(v["lengthM"], 2)) for k, v in sorted(report.items())}
    return grids, neighbours, report


def _fade_paint(obj, surfaces, width, grids, neighbours):
    """Step 5 above on one classified road mesh, against the shape's seams (_shape_seams). Returns
    {surface: {to: [higher surfaces], vertices, corners}}."""
    import shape_surfaces as ss
    me = obj.data
    attr = me.color_attributes.get("Col")
    if attr is None or attr.domain != "CORNER" or width <= 0 or not len(me.polygons) or not grids:
        return {}
    fc, corner_face, cv, _, _, co = _mesh_classes(obj)
    factor = np.ones(len(me.loops), dtype=np.float32)
    faded, corners = {}, {}
    dist = {}  # (class, vertex) -> factor
    for corner in range(len(me.loops)):
        c = int(fc[corner_face[corner]])
        g = grids.get(c)
        if g is None:
            continue
        v = int(cv[corner])
        key = (c, v)
        if key not in dist:
            x, y = co[v, 0], co[v, 1]
            near = g.within(x, y, width)
            d = min((ss.seg_point_distance(x, y, g.items[i][0][0], g.items[i][0][1], g.items[i][1][0], g.items[i][1][1])[0]
                     for i in near), default=width)
            dist[key] = min(1.0, d / width)
            if d < width:
                faded.setdefault(c, set()).add(v)
        factor[corner] = dist[key]
        if dist[key] < 1.0:
            corners[c] = corners.get(c, 0) + 1
    if (factor < 1).any():
        buf = np.empty(len(attr.data) * 4, dtype=np.float32)
        attr.data.foreach_get("color_srgb", buf)
        buf = buf.reshape(-1, 4)
        buf[:, :3] *= factor[:, None]
        attr.data.foreach_set("color_srgb", buf.reshape(-1))
        me.update()
    return {surfaces[c]: {"to": sorted(neighbours.get(c, ()), key=ss.rank), "vertices": len(vs), "corners": corners.get(c, 0)}
            for c, vs in faded.items()}


def _separate(obj, shape, surfaces):
    """Step 6 above: one new object per class of `obj`; the original removed. Returns [part records]."""
    import bmesh
    me = obj.data
    a = me.attributes.get(SPLIT_CLASS_ATTR)
    fc = np.zeros(len(me.polygons), dtype=np.int32)
    if a is not None:
        a.data.foreach_get("value", fc)
    present = sorted(set(fc.tolist()))
    parts = []
    props = {k: obj[k] for k in obj.keys() if isinstance(obj[k], (str, int, float, bool))}
    for c in present:
        surface = surfaces[c]
        name = _surface_name(obj.name, shape, surface)
        new_me = me.copy()
        bm = bmesh.new()
        bm.from_mesh(new_me)
        layer = bm.faces.layers.int.get(SPLIT_CLASS_ATTR)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[layer] != c], context="FACES")
        loose = [v for v in bm.verts if not v.link_faces]
        if loose:
            bmesh.ops.delete(bm, geom=loose, context="VERTS")
        bm.to_mesh(new_me)
        bm.free()
        vn = None
        va = new_me.attributes.get(SPLIT_VN_ATTR)
        if va is not None:
            vn = np.empty(len(new_me.vertices) * 3, dtype=np.float32)
            va.data.foreach_get("vector", vn)
            vn = vn.reshape(-1, 3)
        for n in (SPLIT_CLASS_ATTR, SPLIT_EDGE_ATTR, SPLIT_VN_ATTR):
            if new_me.attributes.get(n) is not None:
                new_me.attributes.remove(new_me.attributes[n])
        if vn is not None:
            ln = np.linalg.norm(vn, axis=1)
            vn[ln < 1e-6] = (0.0, 0.0, 1.0)
            new_me.normals_split_custom_set_from_vertices([tuple(v) for v in vn.tolist()])
        new_me.name = name
        new = bpy.data.objects.new(name, new_me)
        for col in obj.users_collection:
            col.objects.link(new)
        new.matrix_world = obj.matrix_world.copy()
        for g in obj.vertex_groups:
            new.vertex_groups.new(name=g.name)
        for k, v in props.items():
            new[k] = v
        for k in ("opcd_shape_id", "opcd_parent_id"):
            if isinstance(props.get(k), str):
                new[k] = _surface_name(props[k], shape, surface)
        new["golfmap_surface"] = surface
        new["golfmap_split_from"] = obj.name
        new.hide_set(obj.hide_get())
        new.hide_render = obj.hide_render
        new_me.update()
        parts.append({"name": name, "from": obj.name, "surface": surface, "kind": props.get("opcd_kind"),
                      "faces": len(new_me.polygons), "areaM2": round(sum(p.area for p in new_me.polygons), 3)})
    remove_object(obj.name)
    return parts


def op_split_surfaces(ctx, op):
    units, problems = plan_units(ctx, op)
    runs = []
    for unit in units:
        def compute(unit=unit):
            return split_surfaces(ctx, op, unit)
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, problems


def split_surfaces(ctx, op, unit):
    """One mixed road shape (unit.id = its SVG id): steps 1-6 above. Returns the run record."""
    import shape_surfaces as ss
    t = time.time()
    shape = unit.id
    run = {"feature": shape, "targets": list(unit.targets), "seed": None, "shape": shape}
    path = _split_sidecar(ctx, op)
    try:
        doc = ss.load_sidecar(path)
    except (OSError, ValueError) as e:
        return dict(run, result=["CANCELLED"], error=f"no road-surface sidecar {path}: {e}")
    entry = (doc.get("regions") or {}).get(shape)
    run["sidecar"] = path
    if entry is None:
        return dict(run, result=["CANCELLED"], error=f"{shape} is not in {os.path.basename(path)}")
    if not entry.get("mixed"):
        return dict(run, result=["FINISHED"], note=f"{shape} is one surface ({entry.get('surface')}): nothing to split")
    width = float(op.get("fadeM", SPLIT_FADE_M))
    min_area = float(op.get("minPartM2", SPLIT_MIN_PART_M2))
    regions = ss.Regions(entry.get("pieces") or [], to_xy=ss.svg_to_blend(ctx.frame), tie=float(op.get("junctionTie", ss.DEFAULT_TIE)),
                         dominant=entry.get("surface"), slit=float(op.get("slitM", ss.DEFAULT_SLIT)),
                         ragged=float(op.get("raggedM", ss.DEFAULT_RAGGED)))
    surfaces = regions.surfaces()
    seams = [c["points"] for c in regions.seams if c["length"] >= 1e-3]
    fades = [f["points"] for f in regions.fade_lines(width)] if width > 0 else []
    run["regions"] = regions.report()
    objs = [bpy.data.objects[n] for n in unit.targets if n in bpy.data.objects]
    meshes = [o for o in objs if o.get("opcd_kind") != "blend"]
    blends = [o for o in objs if o.get("opcd_kind") == "blend"]
    object_mode()
    snap = {o.name: {"co": positions(o).astype(np.float64)} for o in meshes}
    cut = {}
    for o in meshes:
        cut[o.name] = _cut_mesh(o, seams, fades)
    for o in blends:
        _store_vertex_normals(o)
    slivers = collapse_cut_slivers([o.name for o in meshes], snap, float(op.get("sliverM", SLIVER_M)), mark_attr=SPLIT_EDGE_ATTR)
    weld = op.get("weld", True) is not False
    welds = {"meshes": weld_tjunctions([o.name for o in meshes]) if weld else None}
    classes = {o.name: _classify_mesh(o, regions, surfaces) for o in meshes}
    small = _merge_small_parts(meshes, surfaces, min_area)
    kd, recs = _road_edge_classes(meshes)
    for o in blends:
        classes[o.name] = _classify_blend(o, kd, recs, regions, surfaces)
    small.update(_merge_small_parts(blends, surfaces, min_area))
    for n, rec in classes.items():
        rec["smallPartsMerged"] = len(small.get(n, []))
        if small.get(n):
            rec["smallParts"] = small[n]
    if weld:
        welds["blends"] = weld_tjunctions([o.name for o in blends])
    grids, neighbours, run["seamEdges"] = _shape_seams(meshes, surfaces)
    fade = {o.name: _fade_paint(o, surfaces, width, grids, neighbours) for o in meshes}
    parts = []
    for o in meshes + blends:
        name = o.name
        got = _separate(o, shape, surfaces)
        for p in got:
            f = fade.get(name, {}).get(p["surface"])
            if f:
                p["fade"] = f
        parts += got
    run.update(result=["FINISHED"], targets=sorted(p["name"] for p in parts), parts=parts,
               removed=sorted(unit.targets), created=sorted(p["name"] for p in parts),
               cut=cut, slivers=slivers, weld=welds, classify=classes,
               fadeM=width, minPartM2=min_area, seconds=round(time.time() - t, 2))
    print(f"[shape_apply] split_surfaces {shape}: {len(unit.targets)} objects -> {len(parts)} parts "
          f"({', '.join(surfaces)}), {len(seams)} seam chains, {len(fades)} fade lines, {run['seconds']} s")
    return run


# ---------------------------------------------------------------- golfmap.cut_out
#
# Something that is no drawn feature (a rock slab in the rough, traced off the ortho) becomes its own object, so
# Unity can give it its own material and physics material. One op = one outline (`outline3006`, EPSG:3006):
#   1. every visible Spline mesh under the outline (meshes and blends, any surface; `protect` types cancel the op)
#      is cut along it (insert_polyline, the ring put in twice from opposite starts so it closes); the cut's slivers
#      collapse (`sliverM`) and weld_tjunctions closes what the cut left on the neighbours (`weld`, default on);
#   2. the faces inside leave their meshes (which keep their names, ids and materials) and are joined, welded along
#      the old mesh borders inside the outline, into one new object `Spline_<name>_<surface>_-_Mesh` (`surface`
#      default Rock: no golf surface word, so Unity's GolfMapSurfaces classes it Other and vegetation keeps off);
#      `opcd_kind` mesh, `opcd_shape_id` = name, `golfmap_surface`, `golfmap_cut_from`; first source's materials;
#   3. both sides of the new border are the same edge chain (same vertices): custom normals are set per vertex from
#      the smooth normals before the cut, as split_surfaces does, so the border shades alike on both sides.
# Run `border` = the new object's boundary vertices and how many have no coincident vertex outside (0 expected).

CUT_OUT_WELD_M = 1e-3  # inside parts of different source meshes are welded along their old border within this
CUT_OUT_UV_M = 4.0     # the new object's planar UVs: one texture tile per this many metres


def cut_out_name(op):
    return "Spline_%s_%s_-_Mesh" % (op["name"], op.get("surface", "Rock"))


def cut_out_poly(ctx, op):
    poly = [shape_coords.to_blend(e, n, ctx.frame) for e, n in op["outline3006"]]
    if len(poly) > 3 and math.dist(poly[0], poly[-1]) < 1e-6:
        poly.pop()
    return poly


def op_cut_out(ctx, op):
    units, _ = plan_units(ctx, op)
    runs = []
    for unit in units:
        run = ctx.runner.run(ctx, op, unit, lambda: cut_out(ctx, op))
        if run is not None:
            runs.append(run)
    return runs, []


def _cut_ring(obj, poly):
    """Cut the closed outline into the mesh as an exact edge chain. Returns insert_polyline's stats, summed."""
    import bmesh
    me = obj.data
    if SPLIT_VN_ATTR not in me.attributes:
        _store_vertex_normals(obj)
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.edges.layers.int.get(SPLIT_EDGE_ATTR) or bm.edges.layers.int.new(SPLIT_EDGE_ATTR)
    vn_layer = bm.verts.layers.float_vector.get(SPLIT_VN_ATTR)
    stats = {}
    half = len(poly) // 2
    # insert_polyline leaves the piece before its first crossing and after its last uncut: the second pass starts
    # on the other side of the ring and closes it (what the first pass cut is passed through as existing edges).
    for pts in (poly + [poly[0]], poly[half:] + poly[:half] + [poly[half]]):
        for k, v in insert_polyline(bm, pts, SEAM_CUT, layer, vn_layer).items():
            stats[k] = stats.get(k, 0) + v
    bm.to_mesh(me)
    bm.free()
    me.update()
    return stats


def _drop_cut_attrs(me, normals=True):
    """Remove the cut's temporary attributes; with `normals`, first set the custom normals from the stored ones."""
    vn = None
    a = me.attributes.get(SPLIT_VN_ATTR)
    if a is not None and normals and len(me.vertices):
        vn = np.empty(len(me.vertices) * 3, dtype=np.float32)
        a.data.foreach_get("vector", vn)
        vn = vn.reshape(-1, 3)
    for n in (SPLIT_CLASS_ATTR, SPLIT_EDGE_ATTR, SPLIT_VN_ATTR):
        if me.attributes.get(n) is not None:
            me.attributes.remove(me.attributes[n])
    if vn is not None:
        ln = np.linalg.norm(vn, axis=1)
        vn[ln < 1e-6] = (0.0, 0.0, 1.0)
        me.normals_split_custom_set_from_vertices([tuple(v) for v in vn.tolist()])
    me.update()


def cut_out(ctx, op):
    """One outline: steps 1-3 above. Returns the run record."""
    import bmesh
    t = time.time()
    name = cut_out_name(op)
    surface = op.get("surface", "Rock")
    run = {"feature": op["name"], "targets": [], "seed": None, "object": name}
    if name in bpy.data.objects:
        return dict(run, result=["CANCELLED"], error=f"{name} exists already")
    poly = cut_out_poly(ctx, op)
    if (op.get("rise") or {}).get("mode") == "dem":
        try:
            dem_sampler(ctx, sl.polygon_bbox(poly, rise_params(op["rise"])["apronM"] + 1.0))
        except (OSError, ValueError, KeyError) as e:
            return dict(run, result=["CANCELLED"], error=f"rise mode dem: {e}")
    box = sl.polygon_bbox(poly)
    protect = set(op.get("protect", sl.DEFAULT_PROTECT))
    lake_ok = set()
    rise = op.get("rise") or {}
    if rise.get("mode") == "dem" and rise.get("waterM") is not None:
        # a cliff into a lake: the outline may run out over that lake's own meshes, which give the rock the bed
        # faces it covers (the rock face goes on down to the dug bed instead of a lake-bed band standing above the
        # water); tees, and every other water (ponds, creeks), stay protected
        if "protect" not in op:
            protect.add("tee")
        lake_ok = dem_lake_meshes(ctx, poly, rise_params(rise)["apronM"])
        run["lake"] = sorted(lake_ok)
    protected = {r["name"]: r["type"] for r in ctx.index if r["type"] in protect and r["name"] not in lake_ok}
    object_mode()
    cands, overlap = [], set()
    for o in sorted(spline_meshes(), key=lambda o: o.name):
        b = ctx.box(o.name)
        if not o.visible_get() or not b or sl.bbox_distance(box, b) > 0:
            continue
        if o.name in protected:
            co = positions(o)
            m = (co[:, 0] >= box[0]) & (co[:, 0] <= box[2]) & (co[:, 1] >= box[1]) & (co[:, 1] <= box[3])
            if any(sl.point_in_polygon(float(co[i, 0]), float(co[i, 1]), poly) for i in np.nonzero(m)[0]):
                overlap.add(o.name)
            continue
        if not np.allclose(np.array(o.matrix_world), np.eye(4), atol=1e-7):
            return dict(run, result=["CANCELLED"], error=f"{o.name} has an object transform (the cut works in mesh coordinates)")
        cands.append(o)
    if overlap:
        return dict(run, result=["CANCELLED"],
                    skipped="outline overlaps protected " + ", ".join(sorted(f"{n} ({protected[n]})" for n in overlap)))
    snap = {o.name: {"co": positions(o).astype(np.float64)} for o in cands}
    cut = {o.name: _cut_ring(o, poly) for o in cands}
    names = [o.name for o in cands]
    slivers = collapse_cut_slivers(names, snap, float(op.get("sliverM", SLIVER_M)), mark_attr=SPLIT_EDGE_ATTR)
    weld = weld_tjunctions(names) if op.get("weld", True) is not False else None
    area_before = area_inside = area_outside = 0.0
    parts, sources = [], []
    for o in cands:
        me = o.data
        bm = bmesh.new()
        bm.from_mesh(me)
        inside = set()
        for f in bm.faces:
            c = f.calc_center_median()
            if box[0] - 2 <= c.x <= box[2] + 2 and box[1] - 2 <= c.y <= box[3] + 2 and sl.point_in_polygon(*_face_point(f), poly):
                inside.add(f.index)
        if not inside:
            bm.free()
            _drop_cut_attrs(me, normals=bool(cut[o.name].get("edgeSplits") or cut[o.name].get("faceSplits")))
            continue
        total = sum(f.calc_area() for f in bm.faces)
        part = me.copy()
        pb = bmesh.new()
        pb.from_mesh(part)
        bmesh.ops.delete(pb, geom=[f for f in pb.faces if f.index not in inside], context="FACES")
        bmesh.ops.delete(pb, geom=[v for v in pb.verts if not v.link_faces], context="VERTS")
        a_in = sum(f.calc_area() for f in pb.faces)
        pb.to_mesh(part)
        pb.free()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index in inside], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        a_out = sum(f.calc_area() for f in bm.faces)
        bm.to_mesh(me)
        bm.free()
        _drop_cut_attrs(me)
        area_before += total
        area_inside += a_in
        area_outside += a_out
        parts.append(part)
        sources.append({"name": o.name, "kind": o.get("opcd_kind"), "type": (ctx.by_name.get(o.name) or {}).get("type"),
                        "facesOut": len(inside), "areaOutM2": round(a_in, 3), "cut": cut[o.name]})
    if not parts:
        return dict(run, result=["CANCELLED"], error="no Spline mesh face lies inside the outline")
    # the new object's material and collections from the first source that is no lake bed
    first = bpy.data.objects[next((s["name"] for s in sources if s["name"] not in lake_ok), sources[0]["name"])]
    if first.name != sources[0]["name"]:
        k = [s["name"] for s in sources].index(first.name)
        parts.insert(0, parts.pop(k))
    new_me = parts[0]
    jb = bmesh.new()
    for part in parts:
        jb.from_mesh(part)
    welded = len(jb.verts)
    bmesh.ops.remove_doubles(jb, verts=[v for v in jb.verts if v.is_boundary], dist=CUT_OUT_WELD_M)
    welded -= len(jb.verts)
    for f in jb.faces:
        f.material_index = 0
    # Planar UVs, one tile per `uvM` metres: OPCD's meshes have none (their materials project in world space), a
    # rock material in Unity needs them.
    uv_m = float(op.get("uvM", CUT_OUT_UV_M))
    uv = jb.loops.layers.uv.verify()
    for f in jb.faces:
        for loop in f.loops:
            loop[uv].uv = (loop.vert.co.x / uv_m, loop.vert.co.y / uv_m)
    jb.to_mesh(new_me)
    jb.free()
    for part in parts[1:]:
        bpy.data.meshes.remove(part)
    _drop_cut_attrs(new_me)
    if op.get("uv", "planar") == "box":
        # box UVs (per face the plane of its dominant normal axis): a steep slab's faces carry the texture unstretched
        box_uvs(new_me, uv_m)
    new_me.name = name
    new = bpy.data.objects.new(name, new_me)
    for col in first.users_collection:
        col.objects.link(new)
    new["opcd_kind"] = "mesh"
    new["opcd_shape_id"] = op["name"]
    new["golfmap_surface"] = surface.lower()
    new["golfmap_cut_from"] = ",".join(s["name"] for s in sources)
    new.hide_render = first.hide_render
    if op.get("rise"):
        run["rise"] = rock_rise(ctx, op, new, poly)
    # The border: every boundary vertex of the new object has the same vertex on a mesh outside.
    outside = np.concatenate([boundary_points(o) for o in spline_meshes()
                              if o.name != name and ctx.box(o.name) is not None
                              and sl.bbox_distance(box, bbox_xy(o)) <= 1.0] or [np.zeros((0, 3))])
    own = boundary_points(new)
    if FAST_SHIMS and len(outside) and len(own):
        # Only a point within SEAM_XY of one of the slab's own boundary vertices is ever looked up (speed
        # shim: a road blend under the outline's box offers its whole course-long boundary).
        outside = outside[_in_cells(outside, _grown_cells(own, WELD_CELL_M), WELD_CELL_M)]
    kd = _xy_kd(outside)
    unmatched, max_dz = 0, 0.0
    for p in own:
        hit = kd.find_range((float(p[0]), float(p[1]), 0.0), SEAM_XY)
        if not hit:
            unmatched += 1
        else:
            max_dz = max(max_dz, min(abs(float(outside[j][2] - p[2])) for _, j, _ in hit))
    run.update(result=["FINISHED"], targets=[name] + [s["name"] for s in sources], created=[name], sources=sources,
               faces=len(new_me.polygons), vertices=len(new_me.vertices), areaM2=round(area_inside, 3),
               areaCheckM2=round(area_before - area_inside - area_outside, 6), weldedInside=welded,
               slivers=slivers, weld=weld,
               border={"vertices": int(len(own)), "unmatched": unmatched, "maxAbsDz": round(max_dz, 6)},
               seconds=round(time.time() - t, 2))
    if unmatched or any(s["cut"].get("failed") for s in sources):
        run["warning"] = "the border is not closed everywhere (see border.unmatched / sources[].cut.failed)"
    print(f"[shape_apply] cut_out {name}: {len(sources)} source mesh(es), {run['faces']} faces, {run['areaM2']} m2, "
          f"border {len(own)} vertices / {unmatched} unmatched, {run['seconds']} s")
    return run


# ---------------------------------------------------------------- golfmap.cut_out `rise`
#
# A slab that rises out of the ground or the water instead of lying in it (Vreta hall_247, the klippa in hole 15's
# lake: the slab lay on the dug lake bed and the shore notch around it pulled the water plane down to it). After
# the cut: the slab is refined to `maxEdgeM` (the cut keeps OPCD's ~1.2 m triangles, too coarse to shape) and the
# ground around it within `apronM` to twice that, T-junctions closed; then every vertex of the slab and of the meshes
# within reach goes to max(z, target(x, y)): inside the outline a rounded rise from the foot (`footM` under
# `waterM`) to the top (`topM` over `waterM`, or over the highest ground on the outline when there is no water) with
# lumpy noise (`noiseM`), outside it a shoal / apron falling from the foot to the lowest ground within the apron.
# Lift only and one height per XY: vertices two meshes share move alike, so no seam opens. Green, bunker, tee and
# path meshes are left alone (a road or path refined and pulled toward the DEM by an apron got steep faces and
# shading faults: dark smudges in GSPro, Omberg 2026-10-17). Moved vertices get fresh normals, the others keep theirs.

RISE_DEFAULTS = {"footM": 0.35, "apronM": 3.0, "noiseM": 0.22, "maxEdgeM": 0.35, "seed": 0.0}
# `mode` dem (a cliff: the slab and its apron go to the course's DEM, see _rock_rise_dem): lidar is the shape, so no
# noise, and a finer slab - the DEM's cells are 0.5 m
RISE_DEM_DEFAULTS = {"apronM": 3.0, "noiseM": 0.0, "maxEdgeM": 0.3, "seed": 0.0}
RISE_KEEP = ("green", "bunker", "tee", "path")
RISE_STEEP_DEG = 55.0       # report: the slab's faces at least this steep (the 14th green's cliff on 0.5 m cells)


def rise_params(rise):
    rise = rise or {}
    mode = rise.get("mode", "dome")
    p = dict(RISE_DEM_DEFAULTS if mode == "dem" else RISE_DEFAULTS)
    p.update({k: float(v) for k, v in rise.items() if k != "mode"})
    p["mode"] = mode
    return p


# ---------------------------------------------------------------- the course DEM (`rise.mode` dem)
#
# The inner heightmap export next to the .blend, `<prefix>-inner-dem-<side>m.tif` (float32, EPSG:3006, metres above
# sea; the edited DEM, so a lake bed is already dug) with its sidecar (the frame, `minM`). Read here with numpy + zlib,
# not rasterio: Blender's Python has no rasterio, and the shaping worker can run on a machine without the pipeline
# venv (README "A worker on another machine"). The file is the kind the pipeline writes (gspro.py: GTiff, tiled
# 256, deflate, predictor 3); read are classic TIFF, strips or tiles, none / deflate, predictor 1 or 3, one float32
# / float64 band, either byte order - anything else raises. Only the blocks under the window asked for are read.
# A pixel is an area (GDAL's default; PixelIsPoint shifts the tiepoint half a pixel): bilinear between centres.

DEM_PAD_PX = 2
_TIFF_DTYPES = {1: "u1", 3: "u2", 4: "u4", 5: "u4", 6: "i1", 8: "i2", 9: "i4", 10: "i4", 11: "f4", 12: "f8", 16: "u8"}
_TIFF_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8}


def tiff_layout(path):
    """The first image of a GeoTIFF: size, blocks, coding and the pixel grid in the file's CRS
    ({width, height, blockW, blockH, offsets, counts, compression, predictor, bytes, order, x0, y0, sx, sy, nodata})."""
    import struct
    with open(path, "rb") as f:
        head = f.read(8)
        bo = {b"II": "<", b"MM": ">"}.get(head[:2])
        if bo is None or struct.unpack(bo + "H", head[2:4])[0] != 42:
            raise ValueError(f"{path}: not a classic TIFF (BigTIFF is not read)")
        f.seek(struct.unpack(bo + "I", head[4:8])[0])
        (n,) = struct.unpack(bo + "H", f.read(2))
        entries = [struct.unpack(bo + "HHII", f.read(12)) for _ in range(n)]
        tags = {}
        for tag, typ, count, value in entries:
            size = _TIFF_SIZES.get(typ)
            if size is None:
                continue
            nbytes = size * count
            if nbytes <= 4:
                raw = struct.pack(bo + "I", value)[:nbytes]
            else:
                f.seek(value)
                raw = f.read(nbytes)
            if typ in (2, 7):
                tags[tag] = raw
            else:
                v = np.frombuffer(raw, dtype=bo + _TIFF_DTYPES[typ])
                tags[tag] = (v[0::2] / np.maximum(v[1::2], 1)) if typ in (5, 10) else v
    one = lambda t, d=None: (int(tags[t][0]) if t in tags else d)
    width, height = one(256), one(257)
    bps, spp, fmt = one(258, 1), one(277, 1), one(339, 1)
    if spp != 1 or fmt != 3 or bps not in (32, 64):
        raise ValueError(f"{path}: one float32/float64 band expected (samples {spp}, format {fmt}, bits {bps})")
    comp, pred = one(259, 1), one(317, 1)
    if comp not in (1, 8, 32946) or pred not in (1, 3):
        raise ValueError(f"{path}: compression {comp} / predictor {pred} is not read (none or deflate, predictor 1 or 3)")
    if 322 in tags:
        bw, bh, offs, cnts = one(322), one(323), tags[324], tags[325]
    else:
        bw, bh, offs, cnts = width, one(278, height), tags[273], tags[279]
    if 34264 in tags:
        m = tags[34264]
        if abs(m[1]) > 1e-12 or abs(m[4]) > 1e-12:
            raise ValueError(f"{path}: a rotated raster is not read")
        sx, sy, x0, y0 = float(m[0]), float(-m[5]), float(m[3]), float(m[7])
    else:
        sc, tp = tags[33550], tags[33922]
        sx, sy = float(sc[0]), float(sc[1])
        x0, y0 = float(tp[3] - tp[0] * sx), float(tp[4] + tp[1] * sy)
    keys = tags.get(34735)
    if keys is not None:
        for i in range(4, len(keys) - 3, 4):
            if int(keys[i]) == 1025 and int(keys[i + 3]) == 2:   # GTRasterTypeGeoKey = RasterPixelIsPoint
                x0, y0 = x0 - sx / 2, y0 + sy / 2
    nodata = None
    if 42113 in tags:
        try:
            nodata = float(tags[42113].rstrip(b"\0").decode("ascii"))
        except ValueError:
            pass
    return {"width": width, "height": height, "blockW": bw, "blockH": bh, "offsets": [int(v) for v in offs],
            "counts": [int(v) for v in cnts], "compression": comp, "predictor": pred, "bytes": bps // 8, "order": bo,
            "x0": x0, "y0": y0, "sx": sx, "sy": sy, "nodata": nodata}


def _tiff_block(data, lay):
    import zlib
    buf = zlib.decompress(data) if lay["compression"] != 1 else data
    nb, bw = lay["bytes"], lay["blockW"]
    b = np.frombuffer(buf, dtype=np.uint8)
    rows = b.size // (bw * nb)
    b = b[:rows * bw * nb].reshape(rows, bw * nb)
    if lay["predictor"] == 3:
        # floating-point predictor: the row's bytes are differenced, and stored as byte planes, most significant first
        b = np.cumsum(b, axis=1, dtype=np.uint8)
        return np.ascontiguousarray(b.reshape(rows, nb, bw).transpose(0, 2, 1)).view(">f%d" % nb).reshape(rows, bw)
    return np.ascontiguousarray(b).view(lay["order"] + "f%d" % nb).reshape(rows, bw)


def tiff_window(path, lay, r0, r1, c0, c1):
    """Rows r0..r1-1, columns c0..c1-1 of the band as float64 (inside the image)."""
    bw, bh = lay["blockW"], lay["blockH"]
    across = -(-lay["width"] // bw)
    out = np.full((r1 - r0, c1 - c0), np.nan)
    with open(path, "rb") as f:
        for br in range(r0 // bh, (r1 - 1) // bh + 1):
            for bc in range(c0 // bw, (c1 - 1) // bw + 1):
                k = br * across + bc
                f.seek(lay["offsets"][k])
                blk = _tiff_block(f.read(lay["counts"][k]), lay)
                ra, rb = max(r0, br * bh), min(r1, br * bh + blk.shape[0])
                ca, cb = max(c0, bc * bw), min(c1, bc * bw + bw)
                if ra < rb and ca < cb:
                    out[ra - r0:rb - r0, ca - c0:cb - c0] = blk[ra - br * bh:rb - br * bh, ca - bc * bw:cb - bc * bw]
    if lay["nodata"] is not None:
        out[out == lay["nodata"]] = np.nan
    return out


def course_dem_path(ctx):
    """The course DEM GeoTIFF: ctx.dem_path, else the inner heightmap sidecar's .tif (the Applier's --sidecar)."""
    path = getattr(ctx, "dem_path", None)
    if path:
        return path
    sidecar = getattr(ctx, "dem_sidecar", None)
    if not sidecar:
        raise FileNotFoundError("no inner DEM sidecar known (rise mode dem samples <prefix>-inner-dem-<side>m.tif)")
    return sidecar[:-len(".json")] if sidecar.endswith(".json") else sidecar


def course_dem_sha(ctx):
    """Content hash of the course DEM, cached per path, size and mtime (it keys a dem rise's op cache)."""
    path = course_dem_path(ctx)
    st = os.stat(path)
    memo = ctx.__dict__.setdefault("_dem_sha", {})
    k = (path, st.st_size, st.st_mtime_ns)
    if k not in memo:
        memo[k] = _file_sha(path)
    return memo[k]


def dem_sampler(ctx, box):
    """Bilinear height of the course DEM in the .blend's frame for the XY box (x0, y0, x1, y1) and DEM_PAD_PX
    round it: returns (sample(xy) -> z array, info). The window is cached per DEM content and window."""
    path, sha, fr = course_dem_path(ctx), course_dem_sha(ctx), ctx.frame
    layouts = ctx.__dict__.setdefault("_dem_layouts", {})
    lay = layouts.get(sha) or layouts.setdefault(sha, tiff_layout(path))
    # .blend x, y -> E, N (shape_coords.from_blend), then the pixel grid (centres at x0 + (c + 0.5) sx)
    to_col = lambda x: ((fr["e0"] - fr["px"] - x) - lay["x0"]) / lay["sx"] - 0.5
    to_row = lambda y: (lay["y0"] - (fr["n0"] - fr["pz"] - y)) / lay["sy"] - 0.5
    cs, rs = sorted((to_col(box[0]), to_col(box[2]))), sorted((to_row(box[1]), to_row(box[3])))
    c0, c1 = max(0, int(math.floor(cs[0])) - DEM_PAD_PX), min(lay["width"], int(math.ceil(cs[1])) + DEM_PAD_PX + 1)
    r0, r1 = max(0, int(math.floor(rs[0])) - DEM_PAD_PX), min(lay["height"], int(math.ceil(rs[1])) + DEM_PAD_PX + 1)
    if c1 - c0 < 2 or r1 - r0 < 2:
        raise ValueError(f"the box {box} lies outside the DEM {os.path.basename(path)}")
    windows = ctx.__dict__.setdefault("_dem_windows", {})
    wk = (sha, r0, r1, c0, c1)
    if wk not in windows:
        windows[wk] = tiff_window(path, lay, r0, r1, c0, c1)
    win = windows[wk]
    off = fr["py"] - fr["minM"]          # z = H - minM + py (shape_coords.height_to_blend)

    def sample(xy, grid=None):
        """grid: an array the window's shape (e.g. the window blurred) to sample instead of the DEM."""
        win = windows[wk] if grid is None else grid
        xy = np.asarray(xy, dtype=np.float64)
        fc, frw = to_col(xy[:, 0]) - c0, to_row(xy[:, 1]) - r0
        i = np.clip(np.floor(fc).astype(np.int64), 0, win.shape[1] - 2)
        j = np.clip(np.floor(frw).astype(np.int64), 0, win.shape[0] - 2)
        t, u = np.clip(fc - i, 0.0, 1.0), np.clip(frw - j, 0.0, 1.0)
        h = ((1 - t) * (1 - u) * win[j, i] + t * (1 - u) * win[j, i + 1] + (1 - t) * u * win[j + 1, i]
             + t * u * win[j + 1, i + 1])
        if np.isnan(h).any():
            raise ValueError(f"the DEM {os.path.basename(path)} has no height at {int(np.isnan(h).sum())} vertices "
                             "(nodata, or outside its square)")
        return h + off

    sample.window, sample.res = win, (lay["sx"], lay["sy"])
    info = {"dem": os.path.basename(path), "demSha": sha, "window": [r0, r1, c0, c1]}
    return sample, info


def _poly_signed_distance(pts, poly, chunk=8192):
    """Signed XY distance of each point to the closed polygon: > 0 inside, < 0 outside. In chunks of points: the
    pairs are points x polygon edges (Omberg hall-58: 277 000 x 381 would be 1.7 GB an array)."""
    if len(pts) > chunk:
        return np.concatenate([_poly_signed_distance(pts[i:i + chunk], poly, chunk) for i in range(0, len(pts), chunk)])
    a = np.asarray(poly, dtype=np.float64)
    b = np.roll(a, -1, axis=0)
    ab = b - a
    ab2 = np.maximum((ab ** 2).sum(1), 1e-12)
    p = pts[:, None, :2]
    t = np.clip(((p - a[None]) * ab[None]).sum(2) / ab2[None], 0.0, 1.0)
    d = np.sqrt((((a[None] + t[..., None] * ab[None]) - p) ** 2).sum(2)).min(1)
    # even-odd crossing test, vectorised
    x, y = pts[:, 0][:, None], pts[:, 1][:, None]
    y1, y2 = a[None, :, 1], b[None, :, 1]
    cross = ((y1 > y) != (y2 > y)) & (x < a[None, :, 0] + (y - y1) * (b[None, :, 0] - a[None, :, 0]) / np.where(y2 - y1 == 0, 1e-12, y2 - y1))
    inside = cross.sum(1) % 2 == 1
    return np.where(inside, d, -d)


def _rock_noise(x, y, seed):
    import shape_edgefade as ef
    s = int(seed) & 0xFFFF
    return (0.6 * ef.value_noise(x / 2.2, y / 2.2, s) + 0.3 * ef.value_noise(x / 0.9, y / 0.9, s + 7)
            + 0.1 * ef.value_noise(x / 0.35, y / 0.35, s + 13))


def _refine(obj, max_edge, keep=None, single_edge=False):
    """Halve the edges longer than max_edge (of the faces `keep` selects, all when None) until none is; triangulated.
    `single_edge`: a face with one cut edge is split too (bmesh's use_single_edge). Without it such a face keeps the
    new vertex as a straight corner and the triangulation can leave a zero-area triangle on it, which the next pass
    splits again (the dome's refinement does that, kept as it is; mode dem splits). Returns the number of passes."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    passes = 0
    for _ in range(8):
        faces = [f for f in bm.faces if keep is None or keep(f)]
        long_edges = list({e for f in faces for e in f.edges if e.calc_length() > max_edge})
        if not long_edges:
            break
        bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True, use_single_edge=single_edge)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        passes += 1
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return passes


RISE_SINK_REACH_M = 12.0    # how far from the slab a face under the water can join the lake (the shore notch)
RISE_SINK_BELOW_M = 0.05    # a face joins the lake when all its vertices lie this far under the water
LAKE_TYPES = ("water", "water_lake", "lake")


def _rise_sink_into_lake(ctx, slab, poly, near, water, apron):
    """The faces of the meshes around the slab (not the lake, not the slab) that lie wholly under the water and
    connect to the lake join the lake mesh: a shore notch drawn around a rock (Vreta hole 15) leaves a ring and a
    channel of rough on the lake bed, and grass would grow up through the water there. Positions are kept, so the
    seams stay closed; the moved corners take the lake's own paint. Returns {lake, moved: {mesh: faces}} or None."""
    import bmesh
    lakes = [o for o in near if (ctx.by_name.get(o.name) or {}).get("type") in LAKE_TYPES]
    if not lakes:
        return None
    lake = max(lakes, key=lambda o: int((_poly_signed_distance(positions(o), poly) > -apron).sum()))
    key = lambda c: (round(c[0] * 1000), round(c[1] * 1000))
    reach = apron + RISE_SINK_REACH_M
    cands = [o for o in near if o is not lake and (ctx.by_name.get(o.name) or {}).get("type") not in LAKE_TYPES
             and o.data.polygons]
    # faces under the water, per mesh, and the XY keys of their corners
    faces, keys_of = {}, {}
    for o in cands:
        co = positions(o)
        sd = _poly_signed_distance(co, poly)
        ok_v = (co[:, 2] < water - RISE_SINK_BELOW_M) & (sd > -reach)
        for p in o.data.polygons:
            vs = list(p.vertices)
            if all(ok_v[v] for v in vs):
                faces.setdefault(o.name, []).append(p.index)
                keys_of[(o.name, p.index)] = {key(co[v]) for v in vs}
    under = {n: len(v) for n, v in faces.items()}
    if not faces:
        return {"lake": lake.name, "moved": {}, "underWater": under}
    # flood from the boundary of the lake and its blends (water too) across shared corners
    lake_keys = {key(c) for o in lakes for c in boundary_points(o)}
    by_key = {}
    for f, ks in keys_of.items():
        for k in ks:
            by_key.setdefault(k, []).append(f)
    seen, stack = set(), [f for f, ks in keys_of.items() if ks & lake_keys]
    seeds = len(stack)
    while stack:
        f = stack.pop()
        if f in seen:
            continue
        seen.add(f)
        for k in keys_of[f]:
            stack.extend(g for g in by_key.get(k, ()) if g not in seen)
    moved = {}
    lake_col = None
    lc = lake.data.color_attributes.get("Col")
    if lc is not None and len(lc.data):
        buf = np.empty(len(lc.data) * 4, dtype=np.float32)
        lc.data.foreach_get("color_srgb", buf)
        lake_col = np.median(buf.reshape(-1, 4), axis=0)
    lb = bmesh.new()
    lb.from_mesh(lake.data)
    for o in cands:
        idx = {i for (n, i) in seen if n == o.name}
        if not idx:
            continue
        part = o.data.copy()
        pb = bmesh.new()
        pb.from_mesh(part)
        pb.faces.ensure_lookup_table()
        bmesh.ops.delete(pb, geom=[f for f in pb.faces if f.index not in idx], context="FACES")
        bmesh.ops.delete(pb, geom=[v for v in pb.verts if not v.link_faces], context="VERTS")
        pb.to_mesh(part)
        pb.free()
        sb = bmesh.new()
        sb.from_mesh(o.data)
        sb.faces.ensure_lookup_table()
        bmesh.ops.delete(sb, geom=[f for f in sb.faces if f.index in idx], context="FACES")
        bmesh.ops.delete(sb, geom=[v for v in sb.verts if not v.link_faces], context="VERTS")
        sb.to_mesh(o.data)
        sb.free()
        o.data.update()
        n0 = len(lb.faces)
        lb.from_mesh(part)
        lb.faces.ensure_lookup_table()
        col = lb.loops.layers.color.get("Col")
        if col is not None and lake_col is not None:
            lin =[c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in lake_col[:3]] + [float(lake_col[3])]
            for f in lb.faces[n0:]:
                for l in f.loops:
                    l[col] = lin
        bpy.data.meshes.remove(part)
        moved[o.name] = len(idx)
    bmesh.ops.remove_doubles(lb, verts=[v for v in lb.verts if v.is_boundary], dist=CUT_OUT_WELD_M)
    for f in lb.faces:
        f.material_index = 0
        f.smooth = True
    lb.to_mesh(lake.data)
    lb.free()
    me = lake.data
    if me.has_custom_normals:
        bpy.context.view_layer.objects.active = lake
        with bpy.context.temp_override(**view3d_override()):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    me.update()
    return {"lake": lake.name, "moved": moved, "underWater": under, "seeds": seeds}


def dem_lake_meshes(ctx, poly, apron):
    """The lake a dem slab's water join targets (the water mesh with the most vertices within the apron, as
    _rise_sink_into_lake picks it) and every object of the same drawn shape (its pieces and blends)."""
    pbox = sl.polygon_bbox(poly)
    best, count = None, 0
    for r in ctx.index:
        o = bpy.data.objects.get(r["name"])
        if r["type"] not in LAKE_TYPES or o is None or not o.visible_get():
            continue
        b = ctx.box(r["name"])
        if not b or sl.bbox_distance(pbox, b) > apron:
            continue
        n = int((_poly_signed_distance(positions(o), poly) > -apron).sum())
        if n > count:
            best, count = r, n
    if best is None:
        return set()
    if not best.get("svgId"):
        return {best["name"]}
    return {r["name"] for r in ctx.index if r.get("svgId") == best["svgId"] and r["type"] in LAKE_TYPES}


def _rise_refine(ctx, slab, poly, apron, max_edge, single_edge=False):
    """Step 1 of a rise: the slab refined all over to max_edge, the ground of the meshes within the apron (not green,
    bunker, tee, path) to twice that, T-junctions closed. Returns (near meshes, passes, weld)."""
    box = sl.polygon_bbox(poly, apron)
    keep = {r["name"] for r in ctx.index if r["type"] in RISE_KEEP}
    near = [o for o in spline_meshes() if o.name != slab.name and o.visible_get() and o.name not in keep
            and (b := bbox_xy(o)) and sl.bbox_distance(sl.polygon_bbox(poly), b) <= apron]
    passes = {slab.name: _refine(slab, max_edge, single_edge=single_edge)}
    poly_np = np.asarray(poly)
    for o in near:
        def in_apron(f, o=o):
            c = f.calc_center_median()
            if not (box[0] <= c.x <= box[2] and box[1] <= c.y <= box[3]):
                return False
            return _poly_signed_distance(np.array([[c.x, c.y]]), poly_np)[0] > -apron
        passes[o.name] = _refine(o, 2 * max_edge, in_apron, single_edge=single_edge)
    weld = weld_tjunctions([slab.name] + [o.name for o in near])
    return near, passes, weld


def _rise_set_z(o, co, new_z, moved, slab):
    """Write the new heights; moved vertices (and their ring) take the new geometry's normals, the rest keep their
    custom ones (a slab without custom normals is shaded smooth)."""
    me = o.data
    old_vn = None
    if me.has_custom_normals:
        cn = np.empty(len(me.loops) * 3, dtype=np.float32)
        me.corner_normals.foreach_get("vector", cn)
        vi = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", vi)
        old_vn = np.zeros((len(me.vertices), 3))
        np.add.at(old_vn, vi, cn.reshape(-1, 3))
    co = co.copy()
    co[:, 2] = new_z
    me.vertices.foreach_set("co", co.reshape(-1).astype(np.float32))
    me.update()
    if old_vn is not None:
        vn = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertex_normals.foreach_get("vector", vn)   # the geometry's own, not the custom ones
        vn = vn.reshape(-1, 3)
        ring = moved.copy()
        ev = np.empty(len(me.edges) * 2, dtype=np.int64)
        me.edges.foreach_get("vertices", ev)
        ev = ev.reshape(-1, 2)
        ring[ev[moved[ev[:, 0]], 1]] = True
        ring[ev[moved[ev[:, 1]], 0]] = True
        keep_vn = old_vn / np.maximum(np.linalg.norm(old_vn, axis=1, keepdims=True), 1e-9)
        final = np.where(ring[:, None], vn, keep_vn)
        me.normals_split_custom_set_from_vertices([tuple(v) for v in final.tolist()])
    elif o is slab:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()


def box_uvs(me, uv_m):
    """`uv` box: every face projected onto the plane of its dominant normal axis (top faces XY, steep faces XZ or YZ),
    one tile per uv_m metres, so a cliff's faces carry the texture unstretched (seams between the projections)."""
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    nl = len(me.loops)
    if not nl:
        return
    fn = np.empty(len(me.polygons) * 3, dtype=np.float32)
    me.polygons.foreach_get("normal", fn)
    fn = np.abs(fn.reshape(-1, 3))
    tot = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get("loop_total", tot)
    start = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get("loop_start", start)
    face = np.empty(nl, dtype=np.int64)
    face[np.concatenate([np.arange(s, s + t) for s, t in zip(start.tolist(), tot.tolist())])] = np.repeat(np.arange(len(tot)), tot)
    vi = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi)
    co = positions_of(me)[vi].astype(np.float64)
    n = fn[face]
    top = (n[:, 2] >= n[:, 0]) & (n[:, 2] >= n[:, 1])
    side_x = ~top & (n[:, 0] >= n[:, 1])            # facing +-X: the YZ plane
    u = np.where(top, co[:, 0], np.where(side_x, co[:, 1], co[:, 0]))
    v = np.where(top, co[:, 1], co[:, 2])
    uv = np.stack([u, v], axis=1) / uv_m
    me.uv_layers[0].data.foreach_set("uv", uv.astype(np.float32).reshape(-1))


def positions_of(me):
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def _rise_uvs(op, slab):
    """The slab's UVs again, on the refined (and moved) mesh: planar (x, y) / uvM, or box."""
    uv_m = float(op.get("uvM", CUT_OUT_UV_M))
    if op.get("uv", "planar") == "box":
        box_uvs(slab.data, uv_m)
    elif slab.data.uv_layers:
        uvl = slab.data.uv_layers[0].data
        vi = np.empty(len(slab.data.loops), dtype=np.int64)
        slab.data.loops.foreach_get("vertex_index", vi)
        xy = positions(slab)[vi, :2] / uv_m
        uvl.foreach_set("uv", xy.astype(np.float32).reshape(-1))


def rock_rise(ctx, op, slab, poly):
    p = rise_params(op["rise"])
    if p["mode"] == "dem":
        return _rock_rise_dem(ctx, op, slab, poly, p)
    t0 = time.time()
    apron, max_edge = p["apronM"], p["maxEdgeM"]
    # 1. refine: the slab all over, the ground within the apron
    near, passes, weld = _rise_refine(ctx, slab, poly, apron, max_edge)
    # 2. the target heights
    objs = [slab] + near
    cos = {o.name: positions(o) for o in objs}
    border = boundary_points(slab)
    water = p.get("waterM")
    base = water if water is not None else float(border[:, 2].max())
    top, foot = base + p["topM"], (water - p["footM"]) if water is not None else float(border[:, 2].min())
    s_slab = _poly_signed_distance(cos[slab.name], poly)
    s_max = max(float(s_slab.max()), 0.5)
    in_reach = [(o, co, _poly_signed_distance(co, poly)) for o, co in ((o, cos[o.name]) for o in near)]
    bed = min([float(co[s > -apron, 2].min()) for o, co, s in in_reach if (s > -apron).any()] + [foot])
    seed = int(p["seed"]) or (sum(map(ord, op["name"])) & 0xFFFF)
    lifted, max_lift = {}, 0.0
    for o, co, s in [(slab, cos[slab.name], s_slab)] + in_reach:
        target = np.full(len(co), -1e9)
        inside = s >= 0
        if inside.any():
            t = np.clip(s[inside] / s_max, 0.0, 1.0)
            prof = 1.0 - (1.0 - t) ** 2.4
            noise = np.array([_rock_noise(x, y, seed) for x, y in co[inside, :2].tolist()])
            target[inside] = foot + (top - foot) * prof + noise * p["noiseM"] * np.sqrt(t)
        out = (s < 0) & (s > -apron)
        if out.any():
            u = np.clip(-s[out] / apron, 0.0, 1.0)
            target[out] = foot - (foot - bed) * (u * u * (3 - 2 * u))
        new_z = np.maximum(co[:, 2], target)
        moved = new_z > co[:, 2] + 1e-6
        if not moved.any():
            continue
        max_lift = max(max_lift, float((new_z - co[:, 2])[moved].max()))
        _rise_set_z(o, co, new_z, moved, slab)
        lifted[o.name] = int(moved.sum())
    sunk = _rise_sink_into_lake(ctx, slab, poly, near, water, apron) if water is not None else None
    _rise_uvs(op, slab)
    out = {"waterM": water, "topZ": round(top, 3), "footZ": round(foot, 3), "bedZ": round(bed, 3), "inradiusM": round(s_max, 2),
           "refinePasses": passes, "weld": weld, "lifted": lifted, "maxLiftM": round(max_lift, 3), "sunk": sunk,
           "seconds": round(time.time() - t0, 2)}
    print(f"[shape_apply] cut_out {slab.name} rise: top {top:.2f}, foot {foot:.2f}, bed {bed:.2f}, lifted {lifted}")
    return out


# `mode` dem: a cliff (Omberg's 14th green on its granite cliff over Vattern). The lidar DEM has it, the course meshes
# lose it (terrain.obj is the half-resolution heightmap, OPCD's Terrain Smooth rounds it, ~1.2 m triangles). After
# the same refinement as a dome, every vertex of the slab goes to the DEM's height at its XY (bilinear, up or down,
# plus `noiseM` lumps inside, default 0), and the vertices of the meshes within `apronM` outside the outline blend
# from the DEM at the outline to their own height at apronM (smoothstep). One height per XY: the vertices two meshes
# share move alike, and a vertex shared with a green, bunker or tee (left alone) keeps its height. The water join
# (`waterM`) is the dome's.

def slab_seam_check(objs, tol_xy=SEAM_XY, tol_z=SEAM_DZ):
    """Boundary points the objects share in XY with different heights: {points, open, maxDz}."""
    pts = [boundary_points(o) for o in objs]
    pts = np.concatenate([p for p in pts if len(p)] or [np.zeros((0, 3))])
    if not len(pts):
        return {"points": 0, "open": 0, "maxDz": 0.0}
    k = np.round(pts[:, :2] / tol_xy).astype(np.int64)
    order = np.lexsort((k[:, 1], k[:, 0]))
    k, z = k[order], pts[order, 2]
    new = np.ones(len(k), dtype=bool)
    new[1:] = (k[1:] != k[:-1]).any(1)
    gid = np.cumsum(new) - 1
    lo = np.full(gid[-1] + 1, np.inf)
    hi = np.full(gid[-1] + 1, -np.inf)
    np.minimum.at(lo, gid, z)
    np.maximum.at(hi, gid, z)
    count = np.bincount(gid)
    spread = np.where(count > 1, hi - lo, 0.0)
    return {"points": int((count > 1).sum()), "open": int((spread > tol_z).sum()), "maxDz": round(float(spread.max()), 6)}


# ---------------------------------------------------------------- dem rise: granite shaping
#
# The DEM alone reads as rounded dough in game: 0.5 m cells, mostly interpolated across the faces. Swedish granite is
# blocky, in layered ledges, broken facets and crisp edges. After the slab took the DEM's heights, its interior (not
# the outline: a smooth falloff from 0 on the outline to 1 at `falloffM` in, so no step at the seam; every vertex a
# mesh shares stays as it is) is shaped in four seeded steps, each off with a strength of 0:
#   1. sharpen: unsharp mask of the DEM, z + sharpen * (z - blur(z)), Gaussian sigma = sharpenRadiusM / 2 on the
#      DEM's own grid: steeper faces, crisper crests;
#   2. facets: Voronoi cells (~facetM, jittered seeds); each cell's heights blend `facets` toward the least-squares
#      plane of its (sharpened) DEM heights: planar blocks, broken edges where cells meet;
#   3. terrace: ledges - z pulled `terrace` toward a stepped profile (terraceStepM a step, flat tread, soft riser in
#      the last 35 %, the levels offset per facet so no ledge is one contour) where the sharpened DEM is under
#      terraceMaxDeg (fading over the 10 degrees below), so the big faces stay faces. After the facets, which would
#      flatten the ledges again;
#   4. relief: where the sharpened DEM is over reliefMinDeg (fading in over 5 degrees either side), the vertices
#      move horizontally along the face's outward normal by 3-octave value noise in 3D (3 / 1.2 / 0.5 m, reliefM
#      at most) so a wall is not smooth; a face that would flip has its vertices' move halved (6 rounds), and what
#      still flips is reported;
# then (5.) the rock's normals are split by angle (`hardEdgeDeg`: sharp edges, smooth faces, no custom normals), so
# the facets light as crisp edges; the FBX exporter writes the split corner normals.

RISE_DEM_SHAPE = {"sharpen": 0.8, "sharpenRadiusM": 2.0, "facets": 0.6, "facetM": 2.5, "terrace": 0.5,
                  "terraceStepM": 1.0, "terraceMaxDeg": 60.0, "reliefM": 0.35, "reliefMinDeg": 55.0,
                  "hardEdgeDeg": 35.0, "falloffM": 1.5}
RISE_DEM_DEFAULTS.update(RISE_DEM_SHAPE)
TERRACE_RISER = 0.35        # the share of a step that is riser
_U64_A, _U64_B = np.uint64(0xBF58476D1CE4E5B9), np.uint64(0x94D049BB133111EB)


def _mix64(h):
    h = (h ^ (h >> np.uint64(30))) * _U64_A
    h = (h ^ (h >> np.uint64(27))) * _U64_B
    return h ^ (h >> np.uint64(31))


def hash01(seed, *keys):
    """Uniform [0, 1) per integer key tuple (vectorised splitmix64): the same keys give the same value whatever
    the vertex order."""
    keys = np.broadcast_arrays(*[np.asarray(k, dtype=np.int64) for k in keys])
    h = np.full(keys[0].shape, (int(seed) & 0xFFFFFFFF) + 0x9E3779B97F4A7C15, dtype=np.uint64)
    with np.errstate(over="ignore"):
        for k in keys:
            h = _mix64(h ^ k.astype(np.uint64))
    return (h >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def value_noise3(x, y, z, seed):
    """Smooth value noise in 3D, [-1, 1], lattice 1 unit, vectorised."""
    ix, iy, iz = np.floor(x), np.floor(y), np.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    sx, sy, sz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    ix, iy, iz = ix.astype(np.int64), iy.astype(np.int64), iz.astype(np.int64)
    c = lambda a, b, d: hash01(seed, ix + a, iy + b, iz + d) * 2 - 1
    x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * sx
    x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * sx
    x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * sx
    x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * sx
    y0, y1 = x00 + (x10 - x00) * sy, x01 + (x11 - x01) * sy
    return y0 + (y1 - y0) * sz


def gauss_blur(grid, sigma_px):
    """Separable Gaussian blur, edges extended."""
    if sigma_px <= 0:
        return grid.copy()
    r = int(math.ceil(3 * sigma_px))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_px) ** 2)
    k /= k.sum()
    out = grid
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        g = np.pad(out, pad, mode="edge")
        n = out.shape[axis]
        acc = np.zeros_like(out, dtype=np.float64)
        for i, w in enumerate(k):
            acc += w * (g[i:i + n, :] if axis == 0 else g[:, i:i + n])
        out = acc
    return out


def voronoi_cells(xy, cell, seed):
    """Nearest of one jittered seed per `cell` grid square (the 3 x 3 squares round each point). Returns (cell index
    per point, the cells' grid keys (n, 2), the cells' seed points (n, 2))."""
    g = np.floor(xy / cell).astype(np.int64)
    best = np.full(len(xy), np.inf)
    kx, ky = g[:, 0].copy(), g[:, 1].copy()
    px, py = np.zeros(len(xy)), np.zeros(len(xy))
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            cx, cy = g[:, 0] + dx, g[:, 1] + dy
            sx = (cx + 0.1 + 0.8 * hash01(seed, cx, cy, 1)) * cell
            sy = (cy + 0.1 + 0.8 * hash01(seed, cx, cy, 2)) * cell
            d = (xy[:, 0] - sx) ** 2 + (xy[:, 1] - sy) ** 2
            take = d < best
            best[take], kx[take], ky[take], px[take], py[take] = d[take], cx[take], cy[take], sx[take], sy[take]
    keys, ids = np.unique(np.stack([kx, ky], 1), axis=0, return_inverse=True)
    ids = ids.reshape(-1)
    seeds = np.zeros((len(keys), 2))
    seeds[ids] = np.stack([px, py], 1)
    return ids, keys, seeds


def cell_planes(ids, seeds, x, y, z):
    """The least-squares plane z = a x + b y + c of each cell's points, evaluated at the points (a cell of fewer
    than 3 points, or of points on a line, gives its mean)."""
    n = int(ids.max()) + 1 if len(ids) else 0
    X, Y = x - seeds[ids, 0], y - seeds[ids, 1]
    s = lambda w: np.bincount(ids, weights=w, minlength=n)
    sxx, sxy, syy, sx, sy, sn = s(X * X), s(X * Y), s(Y * Y), s(X), s(Y), s(np.ones_like(X))
    sxz, syz, sz = s(X * z), s(Y * z), s(z)
    A = np.stack([np.stack([sxx, sxy, sx], 1), np.stack([sxy, syy, sy], 1), np.stack([sx, sy, sn], 1)], 1)
    b = np.stack([sxz, syz, sz], 1)
    det = np.linalg.det(A)
    ok = (sn >= 3) & (np.abs(det) > 1e-9 * np.maximum(sn, 1) ** 3)
    coef = np.zeros((n, 3))
    coef[:, 2] = sz / np.maximum(sn, 1)
    if ok.any():
        coef[ok] = np.linalg.solve(A[ok], b[ok][..., None])[..., 0]
    c = coef[ids]
    return c[:, 0] * X + c[:, 1] * Y + c[:, 2]


def _tri_normals(co, tri):
    n = np.cross(co[tri[:, 1]] - co[tri[:, 0]], co[tri[:, 2]] - co[tri[:, 0]])
    return n


def slope_stats(co, tri, steep=RISE_STEEP_DEG):
    """Area-weighted mean slope (degrees) and the area share of faces at least `steep`."""
    n = _tri_normals(co, tri)
    ln = np.linalg.norm(n, axis=1)
    a = ln / 2
    sl_ = np.degrees(np.arccos(np.clip(np.abs(n[:, 2]) / np.maximum(ln, 1e-12), 0.0, 1.0)))
    tot = max(float(a.sum()), 1e-12)
    return {"meanSlopeDeg": round(float((sl_ * a).sum() / tot), 2),
            "steepShare": round(float(a[sl_ >= steep].sum() / tot), 4)}


def _triangles(me):
    tot = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get("loop_total", tot)
    if len(tot) and (tot != 3).any():
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        bm.to_mesh(me)
        bm.free()
        me.update()
    tri = np.empty(len(me.polygons) * 3, dtype=np.int64)
    me.polygons.foreach_get("vertices", tri)
    return tri.reshape(-1, 3)


def _boundary_mask(me):
    ev = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", ev)
    le = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("edge_index", le)
    faces = np.bincount(le, minlength=len(me.edges))
    m = np.zeros(len(me.vertices), dtype=bool)
    m[ev.reshape(-1, 2)[faces == 1].reshape(-1)] = True
    return m


def _smooth01(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def dem_granite(slab, poly, p, seed, sample):
    """Steps 1-4 above on the slab's interior. Returns the report {falloffM, vertices, steps{...}, before, after}."""
    t0 = time.time()
    me = slab.data
    tri = _triangles(me)
    co = positions(slab).astype(np.float64)
    s = _poly_signed_distance(co, poly)
    f = _smooth01(s / max(p["falloffM"], 1e-6))
    f[(s < 1e-4) | _boundary_mask(me)] = 0.0
    act = f > 0
    rep = {"falloffM": p["falloffM"], "vertices": int(act.sum()), "steps": {}, "before": slope_stats(co, tri)}
    if not act.any():
        rep["after"] = rep["before"]
        return rep
    xy = co[:, :2]
    win = sample.window
    grid = win
    if p["sharpen"] > 0:
        blur = gauss_blur(win, p["sharpenRadiusM"] / 2.0 / sample.res[0])
        grid = win + p["sharpen"] * (win - blur)
    h = 0.25
    gx = (sample(xy + [h, 0], grid) - sample(xy - [h, 0], grid)) / (2 * h)
    gy = (sample(xy + [0, h], grid) - sample(xy - [0, h], grid)) / (2 * h)
    gslope = np.degrees(np.arctan(np.hypot(gx, gy)))

    def step(name, new_z=None, new_xy=None, **extra):
        nonlocal co
        before = slope_stats(co, tri)
        old = co.copy()
        if new_z is not None:
            co[:, 2] = np.where(act, new_z, co[:, 2])
        if new_xy is not None:
            co[:, :2] = np.where(act[:, None], new_xy, co[:, :2])
        d = np.abs(co - old)
        rep["steps"][name] = dict(maxDz=round(float(d[:, 2].max()), 3), maxDxy=round(float(np.hypot(d[:, 0], d[:, 1]).max()), 3),
                                  meanSlopeDeg=[before["meanSlopeDeg"], slope_stats(co, tri)["meanSlopeDeg"]],
                                  steepShare=[before["steepShare"], slope_stats(co, tri)["steepShare"]], **extra)

    z = co[:, 2]
    if p["sharpen"] > 0:
        step("sharpen", z + f * (sample(xy, grid) - sample(xy)))
    cells = None
    if p["facetM"] > 0 and (p["facets"] > 0 or p["terrace"] > 0):
        ids, keys, seeds = voronoi_cells(xy, p["facetM"], seed)
        cells = (ids, keys)
        if p["facets"] > 0:
            z = co[:, 2]
            plane = cell_planes(ids[act], seeds, co[act, 0], co[act, 1], z[act])
            nz = z.copy()
            nz[act] = z[act] + f[act] * p["facets"] * (plane - z[act])
            step("facets", nz, cells=int(len(np.unique(ids[act]))))
    if p["terrace"] > 0 and p["terraceStepM"] > 0:
        z = co[:, 2]
        S = p["terraceStepM"]
        if cells is not None:
            off = hash01(seed, cells[1][cells[0], 0], cells[1][cells[0], 1], 3) * S
        else:
            off = np.zeros(len(z))
        u = (z - off) / S
        k = np.floor(u)
        q = u - k
        stepped = off + S * (k + _smooth01((q - (1 - TERRACE_RISER)) / TERRACE_RISER))
        gate = 1.0 - _smooth01((gslope - (p["terraceMaxDeg"] - 10.0)) / 10.0)
        step("terrace", z + f * gate * p["terrace"] * (stepped - z),
             share=round(float((gate[act] > 0.5).mean()), 3))
    if p["reliefM"] > 0:
        w = _smooth01((gslope - (p["reliefMinDeg"] - 5.0)) / 10.0) * f
        g = np.hypot(gx, gy)
        nh = -np.stack([gx, gy], 1) / np.maximum(g, 1e-9)[:, None]      # downhill: out of the face
        x, y, zz = co[:, 0], co[:, 1], co[:, 2]
        noise = sum(wt * value_noise3(x / sc, y / sc, zz / sc, seed + 17 * i)
                    for i, (wt, sc) in enumerate(((0.55, 3.0), (0.3, 1.2), (0.15, 0.5))))
        disp = (p["reliefM"] * noise * w)[:, None] * nh
        n0 = _tri_normals(co, tri)
        scale = np.ones(len(co))
        flips = 0
        for _ in range(7):
            moved = co.copy()
            moved[:, :2] += disp * scale[:, None]
            bad = (np.einsum("ij,ij->i", n0, _tri_normals(moved, tri)) <= 0) & (np.linalg.norm(n0, axis=1) > 1e-12)
            flips = int(bad.sum())
            if not flips:
                break
            scale[np.unique(tri[bad].reshape(-1))] *= 0.5
        step("relief", new_xy=co[:, :2] + disp * scale[:, None], flips=flips, faces=int((w > 0.5).sum()))
        if flips:
            rep["steps"]["relief"]["warning"] = f"{flips} face(s) still flip after 6 halvings"
    me.vertices.foreach_set("co", co.astype(np.float32).reshape(-1))
    me.update()
    rep["after"] = slope_stats(co, tri)
    rep["seconds"] = round(time.time() - t0, 2)
    return rep


def hard_edges(me, deg):
    """Split the rock's normals by angle: sharp edges over `deg`, faces smooth, the custom normals dropped."""
    if me.attributes.get("custom_normal") is not None:
        me.attributes.remove(me.attributes["custom_normal"])
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.set_sharp_from_angle(angle=math.radians(deg))
    a = me.attributes.get("sharp_edge")
    sharp = 0
    if a is not None and len(me.edges):
        v = np.empty(len(me.edges), dtype=bool)
        a.data.foreach_get("value", v)
        sharp = int(v.sum())
    me.update()
    return {"angleDeg": deg, "sharpEdges": sharp, "edges": len(me.edges)}


def _rock_rise_dem(ctx, op, slab, poly, p):
    t0 = time.time()
    apron, max_edge = p["apronM"], p["maxEdgeM"]
    near, passes, weld = _rise_refine(ctx, slab, poly, apron, max_edge, single_edge=True)
    objs = [slab] + near
    cos = {o.name: positions(o) for o in objs}
    box = sl.polygon_bbox(poly, apron + 1.0)
    sample, info = dem_sampler(ctx, box)
    # the XY of the kept meshes' vertices within reach: a vertex there keeps its height (the seam to them stays)
    key = lambda c: (np.round(c[:, 0] / SEAM_XY).astype(np.int64), np.round(c[:, 1] / SEAM_XY).astype(np.int64))
    keep_names = {r["name"] for r in ctx.index if r["type"] in RISE_KEEP}
    pinned_keys = set()
    for o in spline_meshes():
        if o.name in keep_names and (b := bbox_xy(o)) and sl.bbox_distance(box, b) <= 0:
            kx, ky = key(positions(o))
            pinned_keys.update(zip(kx.tolist(), ky.tolist()))
    s_slab = _poly_signed_distance(cos[slab.name], poly)
    s_max = max(float(s_slab.max()), 0.5)
    seed = int(p["seed"]) or (sum(map(ord, op["name"])) & 0xFFFF)
    moved_n, up, down, pinned = {}, 0.0, 0.0, 0
    for o in objs:
        co = cos[o.name]
        s = s_slab if o is slab else _poly_signed_distance(co, poly)
        reach = s > -apron
        if not reach.any():
            continue
        z = co[:, 2].astype(np.float64)
        new_z = z.copy()
        idx = np.nonzero(reach)[0]
        dem = sample(co[idx, :2])
        si = s[idx]
        w = np.clip(-si / apron, 0.0, 1.0)
        w = w * w * (3 - 2 * w)                    # 0 on the outline (and inside), 1 at apronM
        target = dem * (1 - w) + z[idx] * w
        if p["noiseM"] > 0:
            ins = si > 0
            if ins.any():
                t = np.clip(si[ins] / s_max, 0.0, 1.0)
                noise = np.array([_rock_noise(x, y, seed) for x, y in co[idx[ins], :2].tolist()])
                target[ins] += noise * p["noiseM"] * np.sqrt(t)
        if pinned_keys:
            kx, ky = key(co[idx])
            pin = np.array([k in pinned_keys for k in zip(kx.tolist(), ky.tolist())], dtype=bool)
            target[pin] = z[idx][pin]
            pinned += int(pin.sum())
        new_z[idx] = target
        moved = np.abs(new_z - z) > 1e-6
        if not moved.any():
            continue
        d = (new_z - z)[moved]
        up, down = max(up, float(d.max())), min(down, float(d.min()))
        _rise_set_z(o, co, new_z, moved, slab)
        moved_n[o.name] = int(moved.sum())
    # the granite: sharpen, facets, terrace, relief on the slab's interior
    granite = None
    if any(p[k] > 0 for k in ("sharpen", "facets", "terrace", "reliefM")):
        granite = dem_granite(slab, poly, p, seed, sample)
    water = p.get("waterM")
    sunk = _rise_sink_into_lake(ctx, slab, poly, near, water, apron) if water is not None else None
    _rise_uvs(op, slab)
    if p["hardEdgeDeg"] > 0:
        granite = dict(granite or {}, hardEdges=hard_edges(slab.data, p["hardEdgeDeg"]))
    elif granite:
        hard_edges(slab.data, 180.0)     # moved again: smooth normals from the new shape
    # how steep the slab came out, and the seams between everything the rise touched or borders
    fn = np.empty(len(slab.data.polygons) * 3, dtype=np.float32)
    slab.data.polygons.foreach_get("normal", fn)
    nz = np.abs(fn.reshape(-1, 3)[:, 2]) if len(fn) else np.ones(1)
    slope = np.degrees(np.arccos(np.clip(nz, 0.0, 1.0)))
    sz = positions(slab)[:, 2]
    bordering = [o for o in spline_meshes() if (b := bbox_xy(o)) and sl.bbox_distance(box, b) <= 0]
    seams = slab_seam_check(bordering)
    out = dict(info, mode="dem", waterM=water, slabZ=[round(float(sz.min()), 3), round(float(sz.max()), 3)],
               inradiusM=round(s_max, 2), refinePasses=passes, weld=weld, moved=moved_n, lifted=moved_n,
               maxUpM=round(up, 3), maxDownM=round(down, 3), pinned=pinned,
               steepFaces=int((slope >= RISE_STEEP_DEG).sum()), maxSlopeDeg=round(float(slope.max()), 1),
               seams=seams, sunk=sunk, granite=granite, seconds=round(time.time() - t0, 2))
    if granite and (granite.get("steps", {}).get("relief") or {}).get("warning"):
        out["warning"] = granite["steps"]["relief"]["warning"]
    print(f"[shape_apply] cut_out {slab.name} rise dem: slab {out['slabZ'][0]:.2f}-{out['slabZ'][1]:.2f}, "
          f"up {up:.2f} / down {down:.2f}, {out['steepFaces']} faces >= {RISE_STEEP_DEG:g} deg, "
          f"seams {seams['open']} open of {seams['points']}, moved {moved_n}")
    if seams["open"]:
        out["warning"] = f"{seams['open']} seam point(s) open after the dem rise (seams.maxDz {seams['maxDz']} m)"
    return out


# ---------------------------------------------------------------- golfmap.path_edge_fade
#
# A gravel or dirt path meets the grass along a fringe strip (`..._B_..._Blend`, OPCD's blend) one quad wide
# (0.12 m) with a straight red -> black ramp: the path ends on a line and the 3D grass beside it follows the
# strip's quads. This op makes the edge irregular:
#   1. for every path piece of a picked road shape (surface in `surfaces`, default gravel and dirt) and every blend
#      object of that surface: the blend faces whose inner edge lies on the piece's boundary are the piece's strip;
#   2. the strip is joined with the piece, welded, the edges that cross the line `widthM` + 0.1 m from the seam are cut
#      there, and every edge inside that zone is halved until it is <=
#      `maxEdgeM` (the paint's resolution; the faces grow with 1 / maxEdgeM^2);
#   3. the path faces whose centre is within the effective width of the seam move to the strip: it now reaches that far
#      into the path (`widthM`, at most 60 % of the piece's half width: a narrow path keeps a core), the strip's outer
#      edge (welded to the rough / deep mesh beside it) does not move;
#   4. the strip is painted with shape_edgefade.strip_value: red = the neighbour's grass (Stix grows on red), green =
#      the path surface, a noisy ramp from the outer edge (all red) to the inner edge (all green); the rest of the
#      blend object (strips of pieces this unit did not reach, other shapes' ends) is converted to the same convention
#      (red = 1 - old red, green = old red) so the object has one convention, which `golfmap.paths.materials` reads
#      from the paint (path Green, far Red) and `golfmap.roughgrass.plant` plants grass on;
#   5. the changed meshes get smooth shading (custom normals dropped), then `weld_tjunctions` closes the T-junctions the
#      subdivided outer edge made against the neighbours (`weld`, default on).
# Object names and the mesh's materials stay; the objects carry `golfmap_edge_fade` = the convention id.
# `edge_fade_core` takes the objects, so it is also run on imported FBX by the quick harness (no replay needed).

EDGE_FADE_PROP = "golfmap_edge_fade"
EDGE_FADE_ZONE_MARGIN_M = 0.1   # subdivide this far beyond the strip (its faces' centres are tested against the width)
EDGE_FADE_MIN_WIDTH_M = 0.1     # a piece too narrow for at least this much strip is left alone


def _edge_fade_surface(ctx, obj, doc):
    """The surface of a path piece or blend: `golfmap_surface` (set by split_surfaces), else the sidecar's surface of
    its road shape when that shape is one surface."""
    s = obj.get("golfmap_surface")
    if s:
        return s
    entry = ((doc or {}).get("regions") or {}).get((ctx.by_name.get(obj.name) or {}).get("svgId"))
    if entry and not entry.get("mixed"):
        return entry.get("surface")
    return None


def _ef_world_bm(obj):
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    return bm


def _ef_red(v, layer):
    vals = [l[layer][0] for l in v.link_loops]
    return sum(vals) / len(vals) if vals else 1.0


def _ef_dense_kd(points):
    kd = KDTree(max(1, len(points)))
    for i, p in enumerate(points):
        kd.insert(p, i)
    kd.balance()
    return kd


def _ef_dense_points(edges, step):
    pts = []
    for a, b in edges:
        n = max(1, int((b - a).length / step))
        for k in range(n + 1):
            pts.append(a.lerp(b, k / n))
    return pts


def _ef_faces_to_bm(faces, s_layer=False):
    """A new bmesh of these faces (smooth; a vertex is shared by the source vertex it came from)."""
    import bmesh
    nb = bmesh.new()
    mp = {}
    if s_layer:
        nb.loops.layers.float.new("s")
    for f in faces:
        vs = []
        for v in f.verts:
            nv = mp.get(v)
            if nv is None:
                nv = mp[v] = nb.verts.new(v.co)
            vs.append(nv)
        nf = nb.faces.new(vs)
        nf.smooth = True
    return nb


def _ef_set_colours(me, buf):
    for a in list(me.color_attributes):
        me.color_attributes.remove(a)
    attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = 0
    attr.data.foreach_set("color_srgb", buf.reshape(-1).astype(np.float32))


def _ef_finish(obj, bm, colours):
    """Write bm (world space) into the object's mesh: local space, smooth, custom normals dropped, materials and
    colours (an (L, 4) sRGB array, in the corner order of bm's faces) set."""
    me = obj.data
    mats = list(me.materials)
    bm.transform(obj.matrix_world.inverted())
    bm.to_mesh(me)
    bm.free()
    if len(me.materials) == 0:
        for m in mats:
            me.materials.append(m)
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.update()
    if me.has_custom_normals:
        bpy.context.view_layer.objects.active = obj
        with bpy.context.temp_override(**view3d_override()):
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
    _ef_set_colours(me, colours)
    if me.attributes.get("s") is not None:
        me.attributes.remove(me.attributes["s"])
    me.update()


def op_path_transition(ctx, op):
    import shape_transition as transition
    import shape_surfaces as ss
    units, problems = plan_units(ctx, op)
    doc = ss.load_sidecar(_split_sidecar(ctx, op))
    runs = []
    for unit in units:
        def compute(unit=unit):
            object_mode()
            entries = [e for e in doc.get("transitions", []) if e.get("shape") == unit.id]
            surfaces = {e.get("surface") for e in entries} & {"gravel", "dirt"}
            objects = [bpy.data.objects[n] for n in unit.targets if n in bpy.data.objects
                       and _edge_fade_surface(ctx, bpy.data.objects[n], doc) in surfaces]
            changed = transition.apply(objects, entries, ctx.frame, float(op.get("maxEdgeM", .3)))
            warnings = changed.pop('warnings', [])
            return {"feature": unit.id, "targets": list(unit.targets), "result": ["FINISHED"], "objects": changed,
                    "warnings": warnings}
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, problems


def op_path_kerb(ctx, op):
    """golfmap.path_kerb (shape_kerb.py): the fringe strips of hard roads rounded into a lip, the verge beside them
    `depthM` lower."""
    import shape_kerb as kb
    import shape_surfaces as ss
    units, problems = plan_units(ctx, op)
    try:
        doc = ss.load_sidecar(_split_sidecar(ctx, op))
    except (OSError, ValueError):
        doc = None
    surfaces = set(op.get("surfaces") or kb.SURFACES)
    runs = []
    for unit in units:
        def compute(unit=unit):
            object_mode()
            objs = [bpy.data.objects[n] for n in unit.targets if n in bpy.data.objects]
            hard = [o for o in objs if _edge_fade_surface(ctx, o, doc) in surfaces and not o.get(KERB_PROP)]
            pieces = [o for o in hard if o.get("opcd_kind") != "blend"]
            blends = [o for o in hard if o.get("opcd_kind") == "blend"]
            run = {"feature": unit.id, "targets": list(unit.targets), "result": ["FINISHED"]}
            if not pieces or not blends:
                return dict(run, note="no %s road in %s" % ("/".join(sorted(surfaces)), unit.id))
            near = [bpy.data.objects[n] for n in sorted(unit.reads()) if n in bpy.data.objects]
            roads = [o for o in near if "Concrete" in o.name and o.get("opcd_kind") != "blend"]
            others = [o for o in near if o not in blends and o not in roads]
            t = time.time()
            run.update(kb.kerb_core(pieces, blends, roads, others, depth=float(op.get("depthM", kb.DEPTH_M)),
                                    cuts=int(op.get("cuts", kb.CUTS))))
            for o in blends:
                o[KERB_PROP] = kb.CONVENTION
            run["seconds"] = round(time.time() - t, 2)
            print(f"[shape_apply] path_kerb {unit.id}: {len(blends)} blends, {run['outer']} edge vertices, "
                  f"{sum(run['moved'].values())} verge vertices lowered, {run['seconds']} s")
            return run
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, problems


KERB_PROP = "golfmap_kerb"


def op_path_edge_fade(ctx, op):
    units, problems = plan_units(ctx, op)
    runs = []
    for unit in units:
        def compute(unit=unit):
            return path_edge_fade(ctx, op, unit)
        run = ctx.runner.run(ctx, op, unit, compute)
        if run is not None:
            runs.append(run)
    return runs, problems


def path_edge_fade(ctx, op, unit):
    import shape_edgefade as ef
    import shape_surfaces as ss
    run = {"feature": unit.id, "targets": list(unit.targets), "seed": unit.seed, "result": ["FINISHED"]}
    surfaces = set(op.get("surfaces") or ef.SURFACES)
    try:
        doc = ss.load_sidecar(_split_sidecar(ctx, op))
    except (OSError, ValueError):
        doc = None
    objs = [bpy.data.objects[n] for n in unit.targets if n in bpy.data.objects]
    pieces = [o for o in objs if o.get("opcd_kind") != "blend" and _edge_fade_surface(ctx, o, doc) in surfaces
              and not o.get(EDGE_FADE_PROP)]
    blends = [o for o in objs if o.get("opcd_kind") == "blend" and _edge_fade_surface(ctx, o, doc) in surfaces
              and not o.get(EDGE_FADE_PROP)]
    if not pieces or not blends:
        run.update(pieces={}, blends=[], note="no %s in %s of surface %s (or already faded)" % (
            "path piece" if not pieces else "blend", unit.id, "/".join(sorted(surfaces))))
        return run
    object_mode()
    run.update(edge_fade_core(pieces, blends, width=float(op.get("widthM", ef.WIDTH_M)),
                              max_edge=float(op.get("maxEdgeM", ef.MAX_EDGE_M)), amplitude=float(op.get("amplitude", ef.AMPLITUDE)),
                              seed=int(unit.seed or 0) & 0xFFFF, weld=op.get("weld", True) is not False))
    print(f"[shape_apply] path_edge_fade {unit.id}: {len(run['pieces'])} pieces, {len(run['blends'])} blends, "
          f"{run['faces']} faces, {run['seconds']} s ({run['phases']})")
    return run


def edge_fade_core(pieces, blends, width, max_edge, amplitude, seed, weld=True, tol=1e-3):
    """Fade the strips of `blends` (mesh objects in the course frame, `Col` colours) along the boundaries of `pieces`.
    Returns the run fields: widthM, maxEdgeM, amplitude, surfaces..., pieces, blends, changed, faces, welds."""
    import bmesh
    import shape_edgefade as ef
    t0 = time.time()
    phases = {"match": 0.0, "subdivide": 0.0, "assign": 0.0, "paint": 0.0, "build": 0.0}
    out = {"widthM": width, "maxEdgeM": max_edge, "amplitude": amplitude, "pieces": {}, "blends": []}
    B = []
    for o in blends:
        bm = _ef_world_bm(o)
        col = bm.loops.layers.color.get("Col")
        inner = [v for v in bm.verts if col is not None and _ef_red(v, col) > 0.9]
        B.append({"obj": o, "bm": bm, "col": col, "inner": inner, "inner_set": set(inner), "claimed": set(), "strips": [], "pieces": []})
    new_pieces = {}
    for P in pieces:
        tp0 = time.time()
        bmP = _ef_world_bm(P)
        bnd = {v.index for e in bmP.edges if e.is_boundary for v in e.verts}
        if not bnd:
            bmP.free()
            continue
        pk = KDTree(len(bnd))
        for i in bnd:
            pk.insert(bmP.verts[i].co, i)
        pk.balance()
        matched = []
        for b in B:
            m = set()
            hit_verts = {v for v in b["inner"] if pk.find(v.co)[2] < tol}
            if hit_verts:
                for f in {f for v in hit_verts for f in v.link_faces}:
                    if f.index not in b["claimed"] and sum(1 for v in f.verts if v in hit_verts) >= 2:
                        m.add(f.index)
            matched.append(m)
        if not any(matched):
            bmP.free()
            out["pieces"][P.name] = {"matched": 0}
            continue
        owner_kd, owner_w, parts = {}, {}, []
        for bi, m in enumerate(matched):
            if not m:
                continue
            b = B[bi]
            edges = []
            for fi in m:
                for e in b["bm"].faces[fi].edges:
                    a, c = e.verts
                    if _ef_red(a, b["col"]) < 0.1 and _ef_red(c, b["col"]) < 0.1:
                        edges.append((a.co.copy(), c.co.copy()))
            owner_kd[bi + 1] = _ef_dense_kd(_ef_dense_points(edges, 0.02))
            ds = sorted(owner_kd[bi + 1].find(v.co)[2] for v in {v for fi in m for v in b["bm"].faces[fi].verts if v in b["inner_set"]})
            owner_w[bi + 1] = ds[len(ds) // 2] if ds else 0.12
            bmM = b["bm"].copy()
            bmM.faces.ensure_lookup_table()
            bmesh.ops.delete(bmM, geom=[f for f in bmM.faces if f.index not in m], context="FACES")
            bmesh.ops.delete(bmM, geom=[v for v in bmM.verts if not v.link_faces], context="VERTS")
            parts.append((bi + 1, bmM))
        tp = bpy.data.meshes.new("gm_ef_p")
        bmP.to_mesh(tp)
        bm = bmesh.new()
        bm.from_mesh(tp)
        owner = bm.faces.layers.int.new("owner")
        bm.faces.ensure_lookup_table()
        for f in bm.faces:
            f[owner] = 0
        for oid, bmM in parts:
            tm = bpy.data.meshes.new("gm_ef_m")
            bmM.to_mesh(tm)
            n0 = len(bm.faces)
            bm.from_mesh(tm)
            bm.faces.ensure_lookup_table()
            for f in bm.faces[n0:]:
                f[owner] = oid
            bmM.free()
            bpy.data.meshes.remove(tm)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=tol)
        colj = bm.loops.layers.color.get("Col")
        phases["match"] += time.time() - tp0
        tp0 = time.time()

        # the seam (path <-> strip) never moves while subdividing, so its distance field is computed once
        pts, ids = [], []
        for e in bm.edges:
            if len(e.link_faces) == 2 and (e.link_faces[0][owner] == 0) != (e.link_faces[1][owner] == 0):
                a, c = e.verts[0].co, e.verts[1].co
                oid = max(e.link_faces[0][owner], e.link_faces[1][owner])
                n = max(1, int((c - a).length / 0.05))
                for k in range(n + 1):
                    pts.append(a.lerp(c, k / n))
                    ids.append(oid)
        if not pts:
            bm.free()
            bmP.free()
            bpy.data.meshes.remove(tp)
            out["pieces"][P.name] = {"matched": sum(len(m) for m in matched), "skipped": "no seam between the piece and its strip"}
            continue
        sk = _ef_dense_kd(pts)
        dist = {}

        def d_of(v):
            d = dist.get(v)
            if d is None:
                d = dist[v] = sk.find(v.co)[2]
            return d

        # the path's half width: at the vertices and the edge midpoints (a path of rungs has every vertex on a seam)
        path_edges = {e for f in bm.faces if f[owner] == 0 for e in f.edges}
        half = max([d_of(v) for e in path_edges for v in e.verts]
                   + [sk.find((e.verts[0].co + e.verts[1].co) / 2)[2] for e in path_edges], default=0.0)
        eff = min(width, 0.6 * half)
        if eff < EDGE_FADE_MIN_WIDTH_M:
            bm.free()
            bmP.free()
            bpy.data.meshes.remove(tp)
            out["pieces"][P.name] = {"matched": sum(len(m) for m in matched), "skipped": f"too narrow: half width {half:.2f} m"}
            continue
        for bi, m in enumerate(matched):
            if m:
                B[bi]["claimed"] |= m
                B[bi]["pieces"].append(P.name)
        zone = eff + EDGE_FADE_ZONE_MARGIN_M
        touched = set()
        # 0. an edge with both ends inside the zone can still leave it: OPCD's narrow paths are rungs straight across,
        #    seam to seam (both ends at distance 0). Unsplit, step 2 halved such a rung at the path's middle, the
        #    triangle seam-seam-middle had its centre inside the width and moved to the strip: teeth to the middle
        #    (Vreta roads_145, 2026-10-15). Split them where they are farthest out, so step 1 sees them crossing.
        for _ in range(4):
            leaving = []
            for e in bm.edges:
                v0, v1 = e.verts
                if d_of(v0) >= zone or d_of(v1) >= zone or (v0.co - v1.co).length <= zone:
                    continue
                t, d = max(((t, sk.find(v0.co.lerp(v1.co, t))[2]) for t in (0.25, 0.5, 0.75)), key=lambda td: td[1])
                if d >= zone:
                    leaving.append((e, t, d))
            if not leaving:
                break
            for e, t, d in leaving:
                _ne, nv = bmesh.utils.edge_split(e, e.verts[0], t)
                dist[nv] = d
                touched.update(nv.link_faces)
        # 1. every edge that crosses the zone boundary gets a vertex exactly there (distance interpolated along the edge):
        #    no triangle reaches from the strip band deep into the path (a coarse wedge would carry its membership and
        #    its paint across as a sawtooth), and the part outside the zone stays coarse
        crossing = [e for e in bm.edges if (d_of(e.verts[0]) < zone) != (d_of(e.verts[1]) < zone)]
        for e in crossing:
            v0, v1 = e.verts
            d0, d1 = d_of(v0), d_of(v1)
            frac = min(0.98, max(0.02, (zone - d0) / (d1 - d0)))
            _ne, nv = bmesh.utils.edge_split(e, v0, frac)
            dist[nv] = zone - 1e-6
            touched.update(nv.link_faces)
        if touched:
            bmesh.ops.triangulate(bm, faces=list(touched))
        # 2. inside the zone every edge is halved until it is <= max_edge
        cand = list(bm.edges)
        iters = 0
        for _ in range(8):
            long_edges = [e for e in cand if e.is_valid and (e.verts[0].co - e.verts[1].co).length > max_edge
                          and d_of(e.verts[0]) < zone and d_of(e.verts[1]) < zone]
            if not long_edges:
                break
            res = bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
            cand = [g for g in res["geom"] if isinstance(g, bmesh.types.BMEdge)]
            iters += 1
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        phases["subdivide"] += time.time() - tp0
        tp0 = time.time()
        strip_of = {}
        for f in bm.faces:
            if f[owner] > 0:
                strip_of[f] = f[owner]
            elif min(d_of(v) for v in f.verts) < eff + max_edge:
                _co, i, d = sk.find(f.calc_center_median())
                if d < eff:
                    strip_of[f] = ids[i]
        path_faces = [f for f in bm.faces if f not in strip_of]
        phases["assign"] += time.time() - tp0
        tp0 = time.time()
        per_owner = {}
        for f, oid in strip_of.items():
            per_owner.setdefault(oid, []).append(f)
        for oid, faces in per_owner.items():
            nbS = _ef_faces_to_bm(faces, True)
            s_layer = nbS.loops.layers.float.get("s")
            total = eff + owner_w[oid]
            okd = owner_kd[oid]
            sv = {}
            for f in nbS.faces:
                for l in f.loops:
                    v = l.vert
                    s = sv.get(v)
                    if s is None:
                        co = v.co
                        s = sv[v] = ef.strip_value(okd.find(co)[2], total, co.x, co.y, seed, amplitude)
                    l[s_layer] = s
            ts = bpy.data.meshes.new("gm_ef_s")
            nbS.to_mesh(ts)
            nbS.free()
            B[oid - 1]["strips"].append(ts)
        phases["paint"] += time.time() - tp0
        tp0 = time.time()
        if path_faces:
            # the piece keeps its own paint (plain red, or the fade `split_surfaces` painted toward another surface),
            # interpolated through the subdivision
            keep = None
            if colj is not None:
                keep = np.array([[l[colj][0], l[colj][1], l[colj][2], l[colj][3]] for f in path_faces for l in f.loops],
                                dtype=np.float32).reshape(-1, 4)
            new_pieces[P.name] = (_ef_faces_to_bm(path_faces), keep)
        out["pieces"][P.name] = {"matched": sum(len(m) for m in matched), "stripFaces": len(strip_of), "pathFaces": len(path_faces),
                                 "widthM": round(eff, 3), "halfWidthM": round(half, 3), "subdivisions": iters}
        bm.free()
        bpy.data.meshes.remove(tp)
        bmP.free()
        phases["build"] += time.time() - tp0
    # the blends: the faces no piece claimed (kept, in the new paint convention) + the strips
    tp0 = time.time()
    changed = []
    for b in B:
        o = b["obj"]
        if not b["claimed"]:
            b["bm"].free()
            continue
        bmB = b["bm"]
        orig = bpy.data.meshes.new("gm_ef_o")
        bmB.to_mesh(orig)
        oc = orig.color_attributes.get("Col")
        obuf = np.zeros(len(oc.data) * 4, dtype=np.float32)
        oc.data.foreach_get("color_srgb", obuf)
        obuf = obuf.reshape(-1, 4)
        bmB.faces.ensure_lookup_table()
        rest = [f for f in bmB.faces if f.index not in b["claimed"]]
        rest_cols = np.array([obuf[l.index] for f in rest for l in f.loops], dtype=np.float32).reshape(-1, 4)
        if len(rest_cols):
            r_old = rest_cols[:, 0].copy()
            rest_cols[:, 0] = 1.0 - r_old
            rest_cols[:, 1] = r_old
            rest_cols[:, 2] = 0.0
            rest_cols[:, 3] = 1.0
        nbR = _ef_faces_to_bm(rest)
        tr = bpy.data.meshes.new("gm_ef_r")
        nbR.to_mesh(tr)
        nbR.free()
        n_rest = len(tr.loops)
        bmF = bmesh.new()
        bmF.from_mesh(tr)
        for ts in b["strips"]:
            bmF.from_mesh(ts)
        bmesh.ops.remove_doubles(bmF, verts=bmF.verts[:], dist=tol)
        for f in bmF.faces:
            f.smooth = True
        nfaces = len(bmF.faces)
        bmF.to_mesh(orig)      # corners follow the faces: the first n_rest are the rest, the others the strips' (`s`)
        sv = np.zeros(len(orig.loops), dtype=np.float32)
        sa = orig.attributes.get("s")
        if sa is not None:
            sa.data.foreach_get("value", sv)
        cols = np.zeros((len(orig.loops), 4), dtype=np.float32)
        cols[:, 3] = 1.0
        cols[:n_rest] = rest_cols
        cols[n_rest:, 0] = 1.0 - sv[n_rest:]
        cols[n_rest:, 1] = sv[n_rest:]
        _ef_finish(o, bmF, cols)
        o[EDGE_FADE_PROP] = ef.CONVENTION
        changed.append(o.name)
        out["blends"].append({"name": o.name, "pieces": b["pieces"], "claimedFaces": len(b["claimed"]), "faces": nfaces,
                              "restFaces": len(rest)})
        for ts in b["strips"]:
            bpy.data.meshes.remove(ts)
        for m in (orig, tr):
            bpy.data.meshes.remove(m)
        bmB.free()
    # the path pieces, each with its own paint
    kept_faded = 0
    for name, (nbP, keep) in new_pieces.items():
        o = bpy.data.objects[name]
        loops = sum(len(f.loops) for f in nbP.faces)
        if keep is None or len(keep) != loops:
            keep = np.zeros((loops, 4), dtype=np.float32)
            keep[:, 0] = 1.0
            keep[:, 3] = 1.0
        kept_faded += int((np.abs(keep[:, :3] - np.array([1.0, 0.0, 0.0])).max(axis=1) > 0.05).sum())
        _ef_finish(o, nbP, keep)
        o[EDGE_FADE_PROP] = ef.CONVENTION
        changed.append(o.name)
    phases["build"] += time.time() - tp0
    out["keptFadedCorners"] = kept_faded
    out["welds"] = weld_tjunctions(changed) if changed and weld else None
    out["changed"] = sorted(changed)
    out["faces"] = sum(b["faces"] for b in out["blends"]) + sum(p.get("pathFaces", 0) for p in out["pieces"].values())
    out["phases"] = {k: round(v, 1) for k, v in phases.items()}
    out["seconds"] = round(time.time() - t0, 2)
    return out


RUNNERS = {
    "golfmap.split_surfaces": op_split_surfaces,
    "golfmap.cut_out": op_cut_out,
    "golfmap.path_edge_fade": op_path_edge_fade,
    "golfmap.path_kerb": op_path_kerb,
    "golfmap.path_transition": op_path_transition,
    "afrod.flattentees": op_flattentees,
    "afrod.cutcartpaths": op_cutcartpaths,
    "afrod.smoothcartpaths": op_smoothcartpaths,
    "afrod.recipe": op_recipe,
    "golfmap.flatten_footprint": op_flatten_footprint,
    "golfmap.weld_tjunctions": op_weld_tjunctions,
}


# ---------------------------------------------------------------- places, render, export

def place(obj, rec, frame):
    co = positions(obj).astype(np.float64)
    lo, hi = co.min(axis=0), co.max(axis=0)
    c = (lo + hi) / 2
    e, n = shape_coords.from_blend(c[0], c[1], frame)
    e_lo, n_lo = shape_coords.from_blend(hi[0], hi[1], frame)  # the frame turns 180 degrees
    e_hi, n_hi = shape_coords.from_blend(lo[0], lo[1], frame)
    to_unity = lambda x, y, z: [round(-x, 3), round(z, 3), round(-y, 3)]  # OBJ export negates X; import -Z fwd, Y up
    ulo, uhi = to_unity(hi[0], hi[1], lo[2]), to_unity(lo[0], lo[1], hi[2])
    return {
        "object": obj.name,
        "featureId": (rec or {}).get("featureIds", [None])[0] if (rec or {}).get("featureIds") else None,
        "featureIds": (rec or {}).get("featureIds", []),
        "svgId": (rec or {}).get("svgId"),
        "type": (rec or {}).get("type"),
        "hole": (rec or {}).get("hole"),
        "kind": obj.get("opcd_kind"),
        "centre": {"blend": [round(float(v), 3) for v in c],
                   "epsg3006": [round(e, 3), round(n, 3), round(shape_coords.height_from_blend(float(c[2]), frame), 3)],
                   "unity": to_unity(*c)},
        "bounds": {"blend": [round(float(v), 3) for v in list(lo) + list(hi)],
                   "epsg3006": [round(e_lo, 3), round(n_lo, 3), round(e_hi, 3), round(n_hi, 3)],
                   "unity": ulo + uhi},
    }


def place_group(objs, main, rec, frame):
    """A place over several objects: `place` of the main object, with centre and bounds over all of them."""
    out = place(bpy.data.objects[main] if isinstance(main, str) else main, rec, frame)
    co = np.concatenate([positions(o).astype(np.float64) for o in objs if len(o.data.vertices)])
    lo, hi = co.min(axis=0), co.max(axis=0)
    c = (lo + hi) / 2
    e, n = shape_coords.from_blend(c[0], c[1], frame)
    e_lo, n_lo = shape_coords.from_blend(hi[0], hi[1], frame)
    e_hi, n_hi = shape_coords.from_blend(lo[0], lo[1], frame)
    to_unity = lambda x, y, z: [round(-x, 3), round(z, 3), round(-y, 3)]
    out["objects"] = sorted(o.name for o in objs)
    out["centre"] = {"blend": [round(float(v), 3) for v in c],
                     "epsg3006": [round(e, 3), round(n, 3), round(shape_coords.height_from_blend(float(c[2]), frame), 3)],
                     "unity": to_unity(*c)}
    out["bounds"] = {"blend": [round(float(v), 3) for v in list(lo) + list(hi)],
                     "epsg3006": [round(e_lo, 3), round(n_lo, 3), round(e_hi, 3), round(n_hi, 3)],
                     "unity": to_unity(hi[0], hi[1], lo[2]) + to_unity(lo[0], lo[1], hi[2])}
    return out


def render_targets(names, path, color="VERTEX", exaggerate=1.0):
    """Workbench still of the targets from the south-east at ~40 degrees, studio light and shadows.
    color: VERTEX (the paint) or SINGLE (grey, shows relief); exaggerate scales every Spline mesh's Z
    for the picture only."""
    scene = bpy.context.scene
    objs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
    if not objs:
        return None
    co = np.concatenate([positions(o) for o in objs]).astype(np.float64)
    lo, hi = co.min(axis=0), co.max(axis=0)
    c = (lo + hi) / 2
    c[2] *= exaggerate
    size = max(hi[0] - lo[0], hi[1] - lo[1], 4.0) + 8.0
    cam_data = bpy.data.cameras.new("golfmap_shape_cam")
    cam_data.lens = 35
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new("golfmap_shape_cam", cam_data)
    scene.collection.objects.link(cam)
    d = Vector((0.55, 0.55, 0.62)).normalized() * size * 1.25
    cam.location = Vector(c) + d
    cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
    hidden = [o for o in bpy.data.objects if o.type == "MESH" and not o.name.startswith("Spline") and not o.hide_render]
    for o in hidden:
        o.hide_render = True
    splines = spline_meshes()
    scales = [tuple(o.scale) for o in splines]
    sh = scene.display.shading
    old = (scene.camera, scene.render.engine, scene.render.filepath, scene.render.resolution_x, scene.render.resolution_y,
           sh.light, sh.color_type, tuple(sh.single_color), sh.show_cavity, sh.show_shadows)
    try:
        if exaggerate != 1.0:
            for o in splines:
                o.scale.z *= exaggerate
        scene.camera = cam
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.render.resolution_x, scene.render.resolution_y = 1280, 900
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        sh.light = "STUDIO"
        sh.color_type = color
        sh.single_color = (0.72, 0.72, 0.70)
        sh.show_cavity = False
        sh.show_shadows = True
        scene.display.shadow_focus = 0.5
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
    finally:
        (scene.camera, scene.render.engine, scene.render.filepath, scene.render.resolution_x, scene.render.resolution_y,
         sh.light, sh.color_type, sh.single_color, sh.show_cavity, sh.show_shadows) = old
        for o, sc in zip(splines, scales):
            o.scale = sc
        for o in hidden:
            o.hide_render = False
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(cam_data)
    return path


def render_style(op):
    """Paint for recipes (they repaint), grey with 5x relief for height-only ops."""
    return ("VERTEX", 1.0, "") if op["op"] == "afrod.recipe" else ("SINGLE", 5.0, "-z5")


def fbx_sync_module():
    """This repo's fbx_sync.py, loaded by path: `import fbx_sync` would find the add-on copy installed in
    Blender's addons folder when that is enabled, which may be older (Vreta's lacks the Gap_Issue exclude)."""
    mod = sys.modules.get("golfmap_fbx_sync")
    if mod is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("golfmap_fbx_sync", os.path.join(HERE, "fbx_sync.py"))
        mod = importlib.util.module_from_spec(spec)
        sys.modules["golfmap_fbx_sync"] = mod
        spec.loader.exec_module(mod)
    return mod


def inside_unity_project(folder):
    p = os.path.realpath(folder)
    while True:
        if os.path.isdir(os.path.join(p, "Assets")) and os.path.isdir(os.path.join(p, "ProjectSettings")):
            return True
        parent = os.path.dirname(p)
        if parent == p:
            return False
        p = parent


def export_changed(names, folder, gone=()):
    """fbx_sync's exporter call and fingerprints for just these objects, into a staging folder: an FBX
    is (re)written when its fingerprint differs from the folder's manifest or the file is missing. `gone`:
    objects the run removed (golfmap.split_surfaces' originals): their FBX and manifest entries are deleted."""
    if inside_unity_project(folder):
        raise RuntimeError(f"refusing to export into a Unity project: {folder}")
    fbx_sync = fbx_sync_module()
    os.makedirs(folder, exist_ok=True)
    object_mode()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    objects = {fbx_sync.file_name(bpy.data.objects[n]): bpy.data.objects[n] for n in names if n in bpy.data.objects}
    hashes = {fn: fbx_sync.fingerprint(o, depsgraph) for fn, o in objects.items()}
    manifest = fbx_sync.load_manifest(folder) or {}
    todo = sorted(fn for fn in objects if manifest.get(fn) != hashes[fn]
                  or not os.path.isfile(os.path.join(folder, fn + ".fbx")))
    fbx_sync.export_objects(bpy.context, folder, todo, objects)
    manifest.update({fn: hashes[fn] for fn in todo})
    live = {fbx_sync.file_name(o) for o in bpy.data.objects if o.type == "MESH"}
    removed = []
    for n in sorted(gone):
        fn = bpy.path.clean_name(n)
        if fn in live:
            continue
        path = os.path.join(folder, fn + ".fbx")
        had = os.path.isfile(path) or fn in manifest
        if os.path.isfile(path):
            os.remove(path)
        if had:
            removed.append(fn)
        manifest.pop(fn, None)
    fbx_sync.save_manifest(folder, manifest)
    return {"folder": folder, "exported": todo, "unchanged": sorted(set(objects) - set(todo)), "removed": removed}


def fingerprints():
    fbx_sync = fbx_sync_module()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    return {o.name: fbx_sync.fingerprint(o, depsgraph) for o in spline_meshes()}


# ---------------------------------------------------------------- main

def where(at_blend, svg_paths, frame):
    """EPSG:3006 of a .blend XY and the nearest hole (by the SVG's paths)."""
    e, n = shape_coords.from_blend(at_blend[0], at_blend[1], frame)
    sx, sy = e - frame["e0"], frame["n0"] + frame["sideM"] - n
    hole, dist = sl.nearest_hole(sx, sy, svg_paths)
    return {"epsg3006": [round(e, 2), round(n, 2)], "blend": [round(at_blend[0], 2), round(at_blend[1], 2)],
            "nearestHole": hole, "nearestHoleM": round(dist, 1) if hole is not None else None}


def find_svg(blend_path, override):
    folder = os.path.dirname(blend_path)
    shape_ids = sorted({o.get("opcd_shape_id") for o in spline_meshes() if o.get("opcd_shape_id")})
    if override:
        paths = {override: sl.load_svg(override)}
        ranked = sl.choose_svg(paths, shape_ids)
    else:
        # Next to the .blend, and the export snapshots (a newer export replaces vreta.svg while an older
        # .blend / conformed cache is still around).
        cands = sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.lower().endswith(".svg"))
        history = os.path.join(folder, "export-history")
        if os.path.isdir(history):
            cands += sorted(os.path.join(history, d, f) for d in os.listdir(history) if os.path.isdir(os.path.join(history, d))
                            for f in os.listdir(os.path.join(history, d)) if f.lower().endswith(".svg"))
        if not cands:
            raise RuntimeError(f"no .svg next to {blend_path}; pass --svg")
        ranked = sl.choose_svg({p: sl.load_svg(p) for p in cands}, shape_ids)
    path, score = ranked[0]
    for p, sc in ranked[1:]:  # on a tie prefer the SVG next to the .blend over its export-history copy
        if (sc["resolved"], len(sc["unused"])) != (score["resolved"], len(score["unused"])):
            break
        if os.path.dirname(os.path.abspath(p)) == os.path.abspath(folder) and os.path.dirname(os.path.abspath(path)) != os.path.abspath(folder):
            path, score = p, sc
            break
    def rel(p):
        try:
            return os.path.relpath(p, folder)
        except ValueError:  # another drive (an --svg outside the course folder)
            return p
    return path, sl.load_svg(path), score, [(rel(p), s["resolved"], len(s["unused"])) for p, s in ranked[:5]]


def find_source(cache_path):
    """The source .blend of a conformed cache: shape_prepare's report `<cache stem>.json` ("source"), else
    the cache name with `.conformed` (and further dot-suffixes such as `.new`) stripped."""
    stem = cache_path[:-6] if cache_path.lower().endswith(".blend") else cache_path
    try:
        with open(stem + ".json", encoding="utf-8") as f:
            src = json.load(f).get("source")
        if src and os.path.isfile(src):
            return src
    except (OSError, ValueError):
        pass
    folder, name = os.path.split(stem)
    parts = name.split(".")
    if "conformed" not in parts:
        return None
    parts = parts[:parts.index("conformed")] + parts[parts.index("conformed") + 1:]
    while parts:
        cand = os.path.join(folder, ".".join(parts) + ".blend")
        if os.path.isfile(cand) and os.path.normcase(cand) != os.path.normcase(cache_path):
            return cand
        parts = parts[:-1]
    return None


def cache_check(blend):
    """A warning when the conformed cache is older than its source .blend (a regenerated source)."""
    src = find_source(blend)
    if not src:
        return None, None
    if os.path.getmtime(src) > os.path.getmtime(blend):
        return src, {"kind": "staleCache", "layer": None, "op": None,
                     "message": f"conformed cache {os.path.basename(blend)} ({time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(blend)))}) "
                                f"is older than its source {os.path.basename(src)} ({time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(src)))}): "
                                "re-run shape_prepare.py"}
    return src, None


def build_ctx(svg_paths, frame):
    return Ctx(bpy.context.scene, sl.build_index(_index_objects(), svg_paths), svg_paths, sl.naming_scheme(svg_paths), frame)


def op_key(layer, op):
    return f"{layer['id']}:{op['id']}"


class Applier:
    """A shaping run on the open conformed .blend: the SVG and frame resolved once, then ops applied one at
    a time (apply_op, through the unit runner: op-result cache, footprints, worker history) while gathering
    what the report needs. Used by main() and by shape_worker.py."""

    def __init__(self, svg=None, sidecar=None, cache=True, cache_dir=None, history=None,
                 max_dz_warn=sl.DEFAULT_MAX_DZ_WARN_M, render=None):
        self.blend = bpy.data.filepath
        self.folder = os.path.dirname(self.blend)
        self.staging = os.path.join(self.folder, "shaping-staging")
        self.svg_path, self.svg_paths, self.score, self.ranked = find_svg(self.blend, svg)
        sidecar = sidecar or shape_coords.find_sidecar(self.folder)
        self.frame = shape_coords.load_frame(sidecar)
        self.ctx = build_ctx(self.svg_paths, self.frame)
        self.ctx.dem_sidecar = sidecar if isinstance(sidecar, str) else None   # rise mode dem samples its .tif
        self.ctx.svg_file = self.svg_path  # golfmap.split_surfaces reads <svg stem>-paths.json next to it
        self.cache_dir = cache_dir or os.path.join(self.staging, "cache")
        self.runner = UnitRunner(OpCache(self.cache_dir) if cache else None, history)
        self.ctx.runner = self.runner
        self.max_dz_warn = max_dz_warn
        self.render = render
        self.reset()

    def reset(self):
        self.ops_report, self.unresolved, self.warnings = [], [], []
        self.targeted, self.selected, self.changed_by, self.renders = set(), set(), {}, {}
        self.spent = {"snapshot": 0.0, "diff": 0.0}  # report `phases`: what the ops' own seconds leave out

    def svg_report(self):
        unmapped = sorted(r["name"] for r in self.ctx.index if not r["svgId"])
        return {"path": self.svg_path, "scheme": self.ctx.scheme, "resolvedShapes": self.score["resolved"],
                "shapes": self.score["shapes"], "unusedPaths": self.score["unused"], "candidates": self.ranked,
                "unmappedObjects": len(unmapped), "unmappedSample": unmapped[:10]}

    def apply_op(self, index, layer, path, op, only=None, dry_run=False, unit_filter=None):
        """Run one op (every unit, or only the unit ids in unit_filter) and return its report entry."""
        ctx = self.ctx
        key = op_key(layer, op)
        entry = {"layer": layer["id"], "file": os.path.basename(path), "id": op["id"], "op": op["op"],
                 "params": op.get("params", {})}
        for k in ("featureId", "origin", "originRef", "recipe", "level", "falloffM"):
            if k in op:
                entry[k] = op[k]
        self.ops_report.append(entry)
        if only and not only & {op["id"], key, layer["id"]}:
            entry["status"] = "skipped"
            return entry
        if op.get("enabled") is False:
            entry["status"] = "disabled"
            return entry
        if "select" in op:
            recs, problems = sl.select(op["select"], ctx.index)
            self.selected.update(r["name"] for r in recs)
            entry["targets"] = [r["name"] for r in recs]
            entry["features"] = sorted({f for r in recs for f in r["featureIds"]})
            self.unresolved += [{"layer": layer["id"], "op": op["id"], "select": op["select"], "problem": p} for p in problems]
            if not recs:
                entry["status"] = "unresolved"
                entry["problems"] = problems
                return entry
        if dry_run:
            entry["status"] = "resolved"
            self.targeted.update(entry.get("targets", []))
            return entry
        if self.render and entry.get("targets"):
            color, exaggerate, tag = render_style(op)
            self.renders[key] = {"targets": entry["targets"], "style": [color, exaggerate], "before": render_targets(
                entry["targets"], os.path.join(self.render, f"{layer['id']}-{op['id']}-before{tag}.png"), color, exaggerate)}
        t0 = time.time()
        before = snapshot()
        self.spent["snapshot"] += time.time() - t0
        t = time.time()
        self.runner.begin_op(index, key, unit_filter)
        hits0, misses0 = self.runner.stats["hits"], self.runner.stats["misses"]
        try:
            runs, problems = RUNNERS[op["op"]](ctx, op)
            entry["status"] = "ok"
            entry["runs"] = runs
            for r in runs:
                if r.get("error"):
                    self.warnings.append({"layer": layer["id"], "op": op["id"], "kind": "stepFailed", "feature": r.get("feature"),
                                          "objects": r.get("targets"), "message": f"{r.get('feature')}: {r['error']} (feature left as it was)"})
            skipped = [r["skipped"] for r in runs if r.get("skipped")]
            if skipped:
                entry["status"] = "skipped-protected"
                self.warnings.append({"layer": layer["id"], "op": op["id"], "kind": "protected", "message": "; ".join(skipped)})
            if problems:
                entry["problems"] = problems
        except Exception as e:  # report and carry on with the next op
            import traceback
            traceback.print_exc()
            entry["status"] = "error"
            entry["error"] = f"{type(e).__name__}: {e}"
            object_mode()
        entry["seconds"] = round(time.time() - t, 2)
        entry["cache"] = {"hits": self.runner.stats["hits"] - hits0, "misses": self.runner.stats["misses"] - misses0}
        t0 = time.time()
        after = snapshot()
        self.spent["snapshot"] += time.time() - t0
        t0 = time.time()
        d = diff(before, after)
        self.spent["diff"] += time.time() - t0
        escaped = self.runner.end_op(d)
        if escaped:
            self.warnings.append({"layer": layer["id"], "op": op["id"], "kind": "escape", "objects": escaped,
                                  "message": f"changed {len(escaped)} object(s) outside its predicted reach "
                                             "(not cached; the worker re-applies everything on the next sync)"})
        ctx.forget(d)
        if set(before) != set(after):
            ctx.refresh()
        entry["objectsChanged"] = sorted(d)
        entry["vertsMoved"] = sum(v.get("vertsMoved") or 0 for v in d.values())
        entry["maxAbsDz"] = round(max([v.get("maxAbsDz", 0.0) for v in d.values()] or [0.0]), 4)
        entry["maxAbsDxy"] = round(max([v.get("maxAbsDxy", 0.0) or 0.0 for v in d.values()] or [0.0]), 4)
        entry["topology"] = {n: v["topology"] for n, v in d.items() if "topology" in v}
        by_type = {}
        for n, v in sorted(d.items()):
            typ = (ctx.by_name.get(n) or {}).get("type") or ("outer" if n.startswith("Spline_Outer") else "unmapped")
            rec = by_type.setdefault(typ, {"objects": 0, "vertsMoved": 0, "maxAbsDz": 0.0})
            rec["objects"] += 1
            rec["vertsMoved"] += v.get("vertsMoved") or 0
            rec["maxAbsDz"] = round(max(rec["maxAbsDz"], v.get("maxAbsDz") or 0.0), 4)
        entry["movedByType"] = by_type
        limit = op.get("maxDzWarnM", self.max_dz_warn)
        worst = max(((v.get("maxAbsDz") or 0.0, n, v.get("at")) for n, v in d.items()), default=None)
        if worst and worst[0] > limit and worst[2]:
            self.warnings.append(dict(where(worst[2], self.svg_paths, self.frame), layer=layer["id"], op=op["id"], kind="maxDz",
                                      maxAbsDz=round(worst[0], 3), object=worst[1],
                                      type=(ctx.by_name.get(worst[1]) or {}).get("type"), limitM=limit,
                                      featureId=op.get("featureId"), movedByType=by_type))
        entry["created"] = sorted(n for n, v in d.items() if v.get("created"))
        entry["removed"] = sorted(n for n, v in d.items() if v.get("removed"))
        for run in entry.get("runs", []):
            self.targeted.update(run["targets"])
        for n in d:
            self.changed_by.setdefault(n, []).append(key)
        print(f"[shape_apply] {key} {op['op']}: {entry['status']}, {len(d)} objects changed, "
              f"{entry['vertsMoved']} verts moved, max |dz| {entry['maxAbsDz']} m, {entry['seconds']} s"
              + (f" (cache {entry['cache']['hits']} hit / {entry['cache']['misses']} miss)" if self.runner.cache else "")
              + (f" -- {entry['error']}" if entry.get("error") else ""))
        return entry

    def untouched(self):
        shaped_types = {r["type"] for r in self.ctx.index if r["name"] in self.selected and r["type"]}
        return {t: sorted(r["name"] for r in self.ctx.index if r["type"] == t and r["kind"] == "mesh"
                          and r["name"] not in self.targeted and r["name"] not in self.changed_by)
                for t in sorted(shaped_types)}

    def checks(self, changed, seams_before, seams_after, cut_objects):
        """Seam summary, T-junctions around cut meshes, NaNs of the changed objects."""
        seams = seam_summary(seams_before, seams_after)
        tj = tjunction_check(sorted(set(cut_objects) | {n for n, c in seams["unmatchedBoundaryChanged"].items()
                                                         if c["after"] > c["before"]}))
        seams["tJunctions"] = {"toleranceXY": 1e-3, "objects": tj, "gaps": sum(r["gaps"] for r in tj.values()),
                               "maxAbsDz": max([r["maxAbsDz"] for r in tj.values()] or [0.0])}
        nans = sorted(n for n in changed if n in bpy.data.objects and not np.isfinite(positions(bpy.data.objects[n])).all())
        paths = sorted(r["name"] for r in self.ctx.index if r["type"] == "path" and r["kind"] == "mesh")
        return {"seams": seams, "nans": nans, "pathSurface": path_surface_check(paths, self.frame, self.svg_paths)}

    PLACE_MIN_DZ = 0.01  # objects a unit moved less than this (ripple) are left out of its place

    def places(self, names, ops_by_object=None, op_keys=None):
        """Changed places for Unity's Review window, one per op unit (a tee, a path, a pad, a recipe'd feature):
        {object (the unit's main object: its target, else the one it moved most - Review resolves places by it),
        objects, featureId, featureIds, type, hole, svgId, kind, op, opKey, unit, maxAbsDz, centre, bounds (over
        all its objects; blend, EPSG:3006 and Unity), note}. Only objects in `names` the unit moved >= 1 cm (or
        created) count; a unit with none is left out. op_keys: only these ops (a worker sync: the ops it ran)."""
        want = set(names)
        entries = {op_key({"id": e["layer"]}, e): e for e in self.ops_report}
        out = []
        for key, units in self.runner.records.items():
            if op_keys is not None and key not in op_keys:
                continue
            entry = entries.get(key) or {}
            for uid, rec in units.items():
                dz = rec.get("dz") or {}
                objs = [n for n in rec.get("writes", []) if n in want and n in bpy.data.objects
                        and (dz.get(n) is None or dz[n] >= self.PLACE_MIN_DZ)]
                if not objs:
                    continue
                targets = [n for n in rec.get("targets", []) if n in objs]
                main = targets[0] if targets else max(objs, key=lambda n: (dz.get(n) is None, dz.get(n) or 0.0, n))
                p = place_group([bpy.data.objects[n] for n in objs], main, self.ctx.by_name.get(main), self.frame)
                moved = [v for n, v in dz.items() if n in objs and v is not None]
                p["maxAbsDz"] = round(max(moved), 4) if moved else None
                if entry.get("featureId") and uid == "*":  # a generated footprint names its feature (pad, lot)
                    p["featureId"], p["featureIds"] = entry["featureId"], [entry["featureId"]]
                    p["type"] = entry.get("origin") or "footprint"
                p.update(op=entry.get("op"), opKey=key, unit=uid)
                what = f"{entry.get('op', key)} {uid if uid != '*' else entry.get('id', key)}"
                p["note"] = (f"{what}: {len(objs)} object(s), max |dz| {p['maxAbsDz']} m" if p["maxAbsDz"] is not None
                             else f"{what}: {len(objs)} object(s) created")
                out.append(p)
        return out

    def places_detail(self, names, ops_by_object=None):
        """The older per-object list (report `changedObjectsDetail`): every changed object with its ops."""
        ops_by_object = ops_by_object if ops_by_object is not None else self.changed_by
        return [dict(place(bpy.data.objects[n], self.ctx.by_name.get(n), self.frame), ops=ops_by_object.get(n, []))
                for n in names if n in bpy.data.objects]


PATH_STEEP_NZ = 0.5  # a path face steeper than 60 deg (a sliver smoothed into a wall)
PATH_SHADE_DEG = 20.0  # a vertex normal this far off the plane of its edge neighbours shades as a smudge
PATH_BUMP_M = 0.03  # a vertex this far off that plane (pit / spike)


def neighbour_planes(co, ev):
    """Per vertex the least-squares plane z = a x + b y + c through its edge neighbours (relative to the vertex):
    (deviation of the vertex from it, the plane's unit normal, fitted mask)."""
    n = len(co)
    i = np.concatenate([ev[:, 0], ev[:, 1]])
    j = np.concatenate([ev[:, 1], ev[:, 0]])
    d = co[j] - co[i]
    m = np.zeros((n, 3, 3))
    r = np.zeros((n, 3))
    f = np.stack([d[:, 0], d[:, 1], np.ones(len(d))], axis=1)
    np.add.at(m, i, f[:, :, None] * f[:, None, :])
    np.add.at(r, i, f * d[:, 2:3])
    det = np.linalg.det(m)
    ok = np.abs(det) > 1e-12
    sol = np.zeros((n, 3))
    if ok.any():
        sol[ok] = np.linalg.solve(m[ok], r[ok][:, :, None])[:, :, 0]
    nrm = np.stack([-sol[:, 0], -sol[:, 1], np.ones(n)], axis=1)
    nrm /= np.linalg.norm(nrm, axis=1)[:, None]
    return -sol[:, 2], nrm, ok


def path_surface_check(names, frame=None, svg_paths=None):
    """Path meshes' surface faults that shading shows as dark smudges (the cut's slivers after smoothcartpaths):
    per mesh, cut-size edges (< SLIVER_M in XY), steep faces (normal z < PATH_STEEP_NZ), shading faults (vertex
    normal > PATH_SHADE_DEG off the plane of its edge neighbours) and bumps (vertex > PATH_BUMP_M off that
    plane: a conformed path has some from the lidar, so they are counted, not flagged); the worst shading fault
    per mesh with its EPSG:3006 position."""
    out, tot = {}, {"meshes": 0, "shortEdges": 0, "steepFaces": 0, "shadingFaults": 0, "bumps": 0}
    for n in sorted(names):
        obj = bpy.data.objects.get(n)
        if obj is None or obj.type != "MESH" or not len(obj.data.vertices):
            continue
        me = obj.data
        mw = np.array(obj.matrix_world)
        co = positions(obj).astype(np.float64) @ mw[:3, :3].T + mw[:3, 3]
        ev = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get("vertices", ev)
        ev = ev.reshape(-1, 2)
        short = int((np.hypot(*(co[ev[:, 0], :2] - co[ev[:, 1], :2]).T) < SLIVER_M).sum())
        me.calc_loop_triangles()
        tv = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("vertices", tv)
        tv = tv.reshape(-1, 3)
        cr = np.cross(co[tv[:, 1]] - co[tv[:, 0]], co[tv[:, 2]] - co[tv[:, 0]])
        ln = np.linalg.norm(cr, axis=1)
        steep = int(((cr[:, 2] < PATH_STEEP_NZ * ln) & (ln > 0)).sum())
        dev, nrm, ok = neighbour_planes(co, ev)
        vn = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertex_normals.foreach_get("vector", vn)
        vn = vn.reshape(-1, 3).astype(np.float64) @ mw[:3, :3].T
        vn /= np.maximum(np.linalg.norm(vn, axis=1), 1e-12)[:, None]
        shade = np.where(ok, np.degrees(np.arccos(np.clip((vn * nrm).sum(axis=1), -1.0, 1.0))), 0.0)
        faults = int((shade > PATH_SHADE_DEG).sum())
        bumps = int(((np.abs(dev) > PATH_BUMP_M) & ok).sum())
        tot["meshes"] += 1
        for k, v in (("shortEdges", short), ("steepFaces", steep), ("shadingFaults", faults), ("bumps", bumps)):
            tot[k] += v
        if not (short or steep or faults):
            continue
        rec = {"shortEdges": short, "steepFaces": steep, "shadingFaults": faults, "bumps": bumps}
        if faults:
            k = int(np.argmax(shade))
            rec["worstShadeDeg"] = round(float(shade[k]), 1)
            rec["at"] = [round(float(co[k, 0]), 3), round(float(co[k, 1]), 3)]
            if frame is not None:
                rec.update(where(rec["at"], svg_paths or {}, frame))
        out[n] = rec
    return dict(tot, steepNz=PATH_STEEP_NZ, shadeDeg=PATH_SHADE_DEG, bumpM=PATH_BUMP_M, shortEdgeM=SLIVER_M, objects=out)


def cut_objects(ops_report):
    return {n for e in ops_report if e["op"] in ("afrod.cutcartpaths", "golfmap.weld_tjunctions", "golfmap.split_surfaces", "golfmap.cut_out")
            for r in e.get("runs", [])
            for n in list(r["targets"]) + list((r.get("post") or {}).get("objects", {}))}


def hash_all():
    """Positions and colour hashes of every Spline mesh (determinism checks: a replay must match)."""
    h = hash_objects([o.name for o in spline_meshes()])
    return {"positions": h["positions"], "colors": h["colors"]}


def main(argv):
    ap = argparse.ArgumentParser(prog="shape_apply.py")
    ap.add_argument("--layers", required=True, help="folder of NN-*.json shaping layers")
    ap.add_argument("--svg", help="the SVG that built the .blend (default: best match next to it)")
    ap.add_argument("--sidecar", help="inner DEM sidecar (default: *-inner-dem-*m.tif.json next to the .blend)")
    ap.add_argument("--report", help="report JSON (default <blend folder>/shaping-staging/shaping-report.json)")
    ap.add_argument("--export", nargs="?", const="", default=None,
                    help="export changed FBX to this staging folder (default <blend folder>/shaping-staging/fbx)")
    ap.add_argument("--sync-fbx", help="after applying, bring this FBX folder in step with the whole shaped .blend "
                    "(fbx_sync: every changed mesh exported, FBX of meshes no longer there deleted) - the Unity "
                    "project's mesh folder, e.g. <project>/Assets/fbx; unlike --export this may be inside a Unity project")
    ap.add_argument("--only", help="comma-separated layer ids, op ids or layer:op to run")
    ap.add_argument("--dry-run", action="store_true", help="resolve selectors only")
    ap.add_argument("--render", help="folder for before/after PNGs of each op's targets")
    ap.add_argument("--max-dz-warn", type=float, default=sl.DEFAULT_MAX_DZ_WARN_M,
                    help="warn about ops moving a vertex more than this (m; an op's maxDzWarnM overrides)")
    ap.add_argument("--no-cache", action="store_true", help="compute every op (no op-result cache reads or writes)")
    ap.add_argument("--cache-dir", help="op-result cache folder (default <blend folder>/shaping-staging/cache)")
    args = ap.parse_args(argv)

    started = time.time()
    blend = bpy.data.filepath
    folder = os.path.dirname(blend)
    staging = os.path.join(folder, "shaping-staging")
    report_path = args.report or os.path.join(staging, "shaping-report.json")
    report = {"format": REPORT_FORMAT, "blend": blend, "layersFolder": os.path.abspath(args.layers),
              "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "dryRun": args.dry_run}
    try:
        layers = sl.load_layers(args.layers)
    except sl.LayerError as e:
        report["error"] = str(e)
        _write(report_path, report)
        print(str(e))
        sys.exit(2)
    report["layers"] = [os.path.basename(p) for p, _ in layers]

    source, stale = cache_check(blend)
    report["source"] = source
    if stale:
        print("[shape_apply] WARNING " + stale["message"])
    app = Applier(svg=args.svg, sidecar=args.sidecar, cache=not args.no_cache and not args.dry_run,
                  cache_dir=args.cache_dir, max_dz_warn=args.max_dz_warn, render=args.render)
    report["svg"] = app.svg_report()
    report["frame"] = app.frame
    print(f"[shape_apply] {len(layers)} layer(s), SVG {os.path.basename(app.svg_path)} ({app.score['resolved']}/{app.score['shapes']} shapes, "
          f"{app.ctx.scheme} names), {len(app.ctx.index)} Spline meshes"
          + (f", op cache {app.cache_dir}" if app.runner.cache else ""))

    only = set(args.only.split(",")) if args.only else None
    object_mode()
    phases = {}

    def took(name, fn):
        t = time.time()
        got = fn()
        phases[name] = round(phases.get(name, 0.0) + time.time() - t, 1)
        return got

    fp_before = None if args.dry_run else took("fingerprints", fingerprints)
    seams_before = None if args.dry_run else took("seamCheck", seam_check)
    index = 0
    for path, layer in layers:
        for op in layer["ops"]:
            app.apply_op(index, layer, path, op, only=only, dry_run=args.dry_run)
            index += 1
    report["ops"] = app.ops_report
    report["unresolved"] = app.unresolved
    report["warnings"] = ([stale] if stale else []) + app.warnings
    report["untouched"] = app.untouched()
    if not args.dry_run:
        fp_after = took("fingerprints", fingerprints)
        changed = sorted(n for n in fp_after if fp_before.get(n) != fp_after[n])
        touched = sorted(set(changed) | set(app.changed_by))
        seams_after = took("seamCheck", seam_check)
        report["checks"] = took("checks", lambda: app.checks(changed, seams_before, seams_after,
                                                             cut_objects(app.ops_report)))
        report["checks"]["nans"] = sorted(n for n, a in snapshot().items() if not np.isfinite(a).all())
        ps = report["checks"]["pathSurface"]
        if ps["steepFaces"] or ps["shadingFaults"]:
            worst = max(ps["objects"].items(), key=lambda kv: kv[1].get("worstShadeDeg", 0.0))
            report["warnings"].append(dict({k: v for k, v in worst[1].items() if k in ("epsg3006", "nearestHole", "worstShadeDeg")},
                                           layer="checks", op="pathSurface", kind="pathSurface", object=worst[0], message=(
                f"{ps['steepFaces']} steep face(s) and {ps['shadingFaults']} shading fault(s) on {len(ps['objects'])} path "
                f"mesh(es) (dark smudges in GSPro); worst {worst[1].get('worstShadeDeg')} deg on {worst[0]} at "
                f"{worst[1].get('epsg3006')}")))
        report["changed"] = {"objects": changed, "byOp": {n: app.changed_by.get(n, []) for n in changed},
                             "removed": sorted(set(fp_before) - set(fp_after))}
        report["changedPlaces"] = took("places", lambda: app.places(changed))
        report["changedObjectsDetail"] = took("places", lambda: app.places_detail(changed))
        report["hash"] = took("hashes", lambda: hash_objects(touched))
        report["hashAll"] = took("hashes", lambda: dict(
            hash_all(), fbx=hashlib.sha256(json.dumps(sorted(fp_after.items())).encode()).hexdigest()))
        report["cache"] = app.runner.summary()
        if args.render:
            for key, r in app.renders.items():
                color, exaggerate = r["style"]
                tag = "-z%g" % exaggerate if exaggerate != 1.0 else ""
                r["after"] = render_targets(r["targets"], os.path.join(args.render, key.replace(":", "-") + f"-after{tag}.png"),
                                            color, exaggerate)
            report["renders"] = app.renders
        if args.export is not None:
            report["export"] = export_changed(changed, args.export or os.path.join(staging, "fbx"),
                                              gone=sorted(set(fp_before) - set(fp_after)))
        if args.sync_fbx:
            fbx_sync = fbx_sync_module()
            object_mode()
            synced = fbx_sync.run(bpy.context, folder=args.sync_fbx)
            report["syncFbx"] = {k: synced[k] for k in ("folder", "meshes", "orphans", "firstRun", "seconds")}
            report["syncFbx"]["exported"] = sorted(synced["export"])
            report["syncFbx"]["deletedOrphans"] = synced.get("deletedOrphans", 0)
            print("[shape_apply] " + fbx_sync.summary(synced).splitlines()[0])
    report["seconds"] = round(time.time() - started, 1)
    phases["ops"] = round(sum(e.get("seconds") or 0.0 for e in app.ops_report), 1)
    phases.update({k: round(v, 1) for k, v in app.spent.items()})
    report["phases"] = phases
    _write(report_path, report)
    print(f"[shape_apply] report {report_path} ({report['seconds']} s; "
          + ", ".join(f"{k} {v} s" for k, v in sorted(report['phases'].items())) + ")")
    if not args.dry_run:
        s = report["checks"]["seams"]
        print(f"[shape_apply] {len(report['changed']['objects'])} objects changed; seams: {len(s['gaps'])} gap pairs "
              f"({s['newGaps']} new) of {s['pairsChecked']}; T-junction gaps {s['tJunctions']['gaps']} "
              f"(max {s['tJunctions']['maxAbsDz']} m); NaNs in {len(report['checks']['nans'])}; "
              f"positions hash {report['hash']['positions'][:16]} (all meshes {report['hashAll']['positions'][:16]})")
        ps = report["checks"]["pathSurface"]
        print(f"[shape_apply] path surfaces ({ps['meshes']} meshes): {ps['steepFaces']} steep faces, {ps['shadingFaults']} "
              f"shading faults, {ps['shortEdges']} edges < {ps['shortEdgeM']} m, {ps['bumps']} bumps > {ps['bumpM']} m")
        if app.runner.cache:
            c = report["cache"]
            print(f"[shape_apply] op cache: {c['hits']} hits ({c['replaySeconds']} s replay, ~{c['savedSeconds']} s saved), "
                  f"{c['misses']} misses ({c['computeSeconds']} s), {c['stored']} stored, {c['invalid']} invalid, "
                  f"{c['uncacheable']} uncacheable; keys {c['keySeconds']} s")
    if app.unresolved:
        print(f"[shape_apply] {len(app.unresolved)} unresolved selector(s)")
    for w in report["warnings"]:
        if w["kind"] == "staleCache":
            print("[shape_apply] WARNING " + w["message"])
            continue
        print(f"[shape_apply] warning {w['layer']}:{w['op']} {w['kind']}: " + (
            w.get("message") or f"{w['maxAbsDz']} m on {w['object']} ({w['type']}) at {w['epsg3006']}, hole {w['nearestHole']}"))


def _write(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, default=str)
    os.replace(path + ".tmp", path)


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
