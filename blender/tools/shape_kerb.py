"""Rounded hard-road edge: `golfmap.path_kerb` (shape_apply registers it; the profile is pure Python, tested by
shape_kerb_test.py).

An asphalt road is laid 4-5 cm thick and rolled out at its edge, so it ends in a rounded lip a little above the
verge. OPCD's road meets the grass flush: road mesh, fringe strip (`..._B_..._Blend`, one quad row ~0.12 m wide)
and grass mesh all lie on the same surface, so the edge reads as a flat line in GSPro. This op rounds the strip:

1. the strips: on every blend of a hard road (`surfaces`, default asphalt, concrete, paving), the faces with an inner
   vertex on a hard road piece's boundary and an outer vertex on no road mesh (a strip between two roads stays flat);
2. each strip rung (an edge from the road edge to the grass edge) is cut `cuts` times (default 2), so the lip has
   vertices to bend on;
3. every strip vertex drops by `depthM` x profile(t), t = 0 on the road edge to 1 on the grass edge: the road stays
   where it is, the lip rolls over into a steeper face, and the grass edge ends `depthM` (default 3 cm) lower;
4. every vertex of any other mesh at an outer strip vertex (the grass / deep / rough boundary welded to it, within
   1 mm) drops the same `depthM`, so nothing opens: the verge slopes down to the lip over its first row of faces.

Topology outside the strips does not change, the objects keep their names, paint (the new vertices interpolate the
strip's ramp) and materials; the strip objects get smooth shading with custom normals dropped.
"""

import math

SURFACES = ("asphalt", "concrete", "paving")
DEPTH_M = 0.03
CUTS = 2
TOL_M = 1e-3
CONVENTION = "path-kerb-v1"  # the blends' golfmap_kerb: rounded once (a replay starts from the OPCD meshes)


def profile(t):
    """How much of the full drop a strip point at t (0 road edge .. 1 grass edge) takes: flat on the road, then
    rolling over (a quarter ellipse: the slope grows to vertical at the grass edge, capped by the strip's width)."""
    t = max(0.0, min(1.0, t))
    return 1.0 - math.sqrt(max(0.0, 1.0 - t * t))


def validate_params(op):
    errors = []
    d = op.get("depthM", DEPTH_M)
    if not isinstance(d, (int, float)) or isinstance(d, bool) or not 0 < d <= 0.2:
        errors.append("depthM must be a number in (0, 0.2]")
    c = op.get("cuts", CUTS)
    if not isinstance(c, int) or isinstance(c, bool) or not 0 <= c <= 6:
        errors.append("cuts must be an integer in [0, 6]")
    s = op.get("surfaces", list(SURFACES))
    if not isinstance(s, list) or not s or not all(isinstance(x, str) for x in s):
        errors.append("surfaces must be a list of surface names")
    return errors


def kerb_core(pieces, blends, roads, others, depth=DEPTH_M, cuts=CUTS, tol=TOL_M):
    """Round the strips of `blends` along the boundaries of `pieces` (hard road meshes). `roads`: every road mesh
    near (any surface: an outer vertex on one marks a road-to-road strip), `others`: the meshes whose vertices may
    sit on the strips' outer edge (the blends' own outer vertices drop in the same pass, once each). Returns
    the run fields."""
    import bmesh
    from mathutils.kdtree import KDTree

    def kd_of(points):
        kd = KDTree(max(1, len(points)))
        for i, p in enumerate(points):
            kd.insert((p[0], p[1], 0.0), i)
        kd.balance()
        return kd

    def world_bm(obj):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.transform(obj.matrix_world)
        bm.verts.ensure_lookup_table()
        return bm

    edge_pts = []
    for p in pieces:
        bm = world_bm(p)
        edge_pts += [tuple(v.co) for e in bm.edges if e.is_boundary for v in e.verts]
        bm.free()
    road_pts = []
    for r in roads:
        mw = r.matrix_world
        road_pts += [tuple(mw @ v.co) for v in r.data.vertices]
    on_edge, on_road = kd_of(edge_pts), kd_of(road_pts)

    def near(kd, co, n):
        return n and kd.find((co[0], co[1], 0.0))[2] <= tol

    out = {"depthM": depth, "cuts": cuts, "blends": {}, "outer": 0, "moved": {}}
    drops = []  # outer edge points (world) whose coincident vertices in other meshes drop `depth`
    for o in blends:
        bm = world_bm(o)
        inner = {v for v in bm.verts if near(on_edge, v.co, len(edge_pts))}
        strip = [f for f in bm.faces if any(v in inner for v in f.verts)
                 and any(v not in inner for v in f.verts)
                 and all(v in inner or not near(on_road, v.co, len(road_pts)) for v in f.verts)]
        if not strip:
            out["blends"][o.name] = {"strip": 0}
            bm.free()
            continue
        outer = {v for f in strip for v in f.verts if v not in inner}
        inner_edges = [(e.verts[0].co.copy(), e.verts[1].co.copy()) for f in strip for e in f.edges
                       if e.verts[0] in inner and e.verts[1] in inner]
        outer_edges = [(e.verts[0].co.copy(), e.verts[1].co.copy()) for f in strip for e in f.edges
                       if e.verts[0] in outer and e.verts[1] in outer]
        rungs = list({e for f in strip for e in f.edges if (e.verts[0] in inner) != (e.verts[1] in inner)})
        drops += [(v.co.x, v.co.y) for v in outer]  # dropped with every other mesh's vertex there, below
        old = {tuple(v.co) for v in bm.verts}  # (the subdivide may rebuild vertices: compare positions)
        if cuts and rungs:
            bmesh.ops.subdivide_edges(bm, edges=rungs, cuts=cuts, use_grid_fill=True)
        bm.verts.ensure_lookup_table()
        new = [v for v in bm.verts if tuple(v.co) not in old]

        def dense(edges, step=0.01):
            pts = []
            for a, b in edges:
                n = max(1, int((b - a).length / step))
                pts += [a.lerp(b, k / n) for k in range(n + 1)]
            return pts

        kin, kout = kd_of(dense(inner_edges)), kd_of(dense(outer_edges))
        for v in new:
            di = kin.find((v.co.x, v.co.y, 0.0))[2]
            do = kout.find((v.co.x, v.co.y, 0.0))[2]
            v.co.z -= depth * profile(di / (di + do) if di + do > 0 else 0.0)
        for f in bm.faces:
            f.smooth = True
        mats = list(o.data.materials)
        bm.transform(o.matrix_world.inverted())
        bm.to_mesh(o.data)
        bm.free()
        me = o.data
        if len(me.materials) == 0:
            for m in mats:
                me.materials.append(m)
        custom = me.attributes.get("custom_normal")
        if custom is not None:
            me.attributes.remove(custom)
        me.update()
        out["blends"][o.name] = {"strip": len(strip), "rungs": len(rungs), "outer": len(outer), "new": len(new)}
        out["outer"] += len(outer)
    if drops:
        kd = kd_of(drops)
        for o in list(others) + [b for b in blends if b not in others]:
            mw, inv = o.matrix_world, o.matrix_world.inverted()
            n = 0
            for v in o.data.vertices:
                w = mw @ v.co
                if kd.find((w.x, w.y, 0.0))[2] <= tol:
                    w.z -= depth
                    v.co = inv @ w
                    n += 1
            if n:
                o.data.update()
                out["moved"][o.name] = n
    return out
