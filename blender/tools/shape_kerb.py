"""Rounded hard-road edge: `golfmap.path_kerb` (shape_apply registers it and lends it its mesh cut; the profile and
the paint are pure Python, tested by shape_kerb_test.py).

An asphalt road is laid 4-5 cm thick and rolled out at its edge, so it ends in a rounded lip above the verge, dirt
and shadow in the angle and grass leaning over it. OPCD's road meets the grass flush: road mesh, fringe strip
(`..._B_..._Blend`, one quad row ~0.12 m wide) and grass mesh lie on one surface, so the edge reads as a flat line.

1. Strips: on every blend of a hard road (`surfaces`, default asphalt, concrete, paving), the faces with an inner
   vertex on a hard road piece's boundary and an outer vertex on no road mesh (a strip between two roads stays flat).
2. Room for the lip: each strip rung (road edge -> grass edge) is cut `cuts` times (default 3), and the road pieces
   get a line `roadM` (default 0.12 m) inside their edge along every strip (the caller's `cut`), so the lip starts
   that far in on the asphalt.
3. Drop: every vertex of the pieces and strips within the lip (distance to the grass edge d < W = strip width +
   roadM) drops `depthM` (default 4.5 cm) x profile(1 - d / W), a quarter ellipse: flat where the lip starts on the
   asphalt, rolling over into a steep face at the grass edge. Every vertex of any mesh at the same place (within 1 mm:
   the grass / deep / rough boundary welded to the strip, a gravel piece at a junction) drops the same, so nothing
   opens; the verge slopes back up over its first row of faces.
4. Paint (strips only, the green/red convention Unity's path materials and Stix read): green = the road surface
   from the inner edge, a dark band (MAHS black: the neighbour's dirt) in the angle of the lip, red = the grass at the
   outer edge reaching a little way up the lip in tufts, so Stix grass grows over the edge.

Objects keep their names and materials; strips get smooth shading with custom normals dropped.
"""

import math

SURFACES = ("asphalt", "concrete", "paving")
DEPTH_M = 0.045
ROAD_M = 0.12
CUTS = 3
TOL_M = 1e-3
CONVENTION = "path-kerb-v2"  # the blends' golfmap_kerb: rounded once (a replay starts from the OPCD meshes)


def profile(t):
    """How much of the full drop a point at t (0 where the lip starts on the road .. 1 on the grass edge) takes:
    flat on the road, then rolling over (a quarter ellipse: the slope grows to vertical at the grass edge)."""
    t = max(0.0, min(1.0, t))
    return 1.0 - math.sqrt(max(0.0, 1.0 - t * t))


def _hash(ix, iy, seed):
    n = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    n = n ^ (n >> 16)
    return (n & 0xFFFF) / 32767.5 - 1.0


def _noise(x, y, seed):
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hash(ix, iy, seed), _hash(ix + 1, iy, seed)
    c, d = _hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed)
    top = a + (b - a) * sx
    return top + ((c + (d - c) * sx) - top) * sy


def _smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def strip_paint(e, x, y, seed=0):
    """(r, g, b) of a strip point e of the way from the grass edge (0) to the road edge (1), at world x, y: red grass
    at the outer edge reaching 10-45 % up in tufts, a dark band (what the r + g + b sum leaves: MAHS black) around
    a third of the way, green road surface toward the inner edge. Always green 1 at e = 1, red 1 at e = 0."""
    e = max(0.0, min(1.0, e))
    n1, n2 = _noise(x / 0.35, y / 0.35, seed), _noise(x / 0.12, y / 0.12, seed + 7)
    reach = 0.18 + 0.2 * max(0.0, n1) + 0.07 * n2
    red = 1.0 - _smoothstep(reach - 0.08, reach + 0.08, e)
    shade = 0.7 * (1.0 - _smoothstep(0.0, 0.2, abs(e - 0.32))) * (0.75 + 0.25 * n2)
    shade *= _smoothstep(0.0, 0.08, e) * (1.0 - _smoothstep(0.85, 1.0, e))
    g = (1.0 - red) * (1.0 - shade)
    r = red * (1.0 - 0.4 * shade)
    return r, g, 0.0


def validate_params(op):
    errors = []
    d = op.get("depthM", DEPTH_M)
    if not isinstance(d, (int, float)) or isinstance(d, bool) or not 0 < d <= 0.2:
        errors.append("depthM must be a number in (0, 0.2]")
    w = op.get("roadM", ROAD_M)
    if not isinstance(w, (int, float)) or isinstance(w, bool) or not 0 <= w <= 1:
        errors.append("roadM must be a number in [0, 1]")
    c = op.get("cuts", CUTS)
    if not isinstance(c, int) or isinstance(c, bool) or not 0 <= c <= 6:
        errors.append("cuts must be an integer in [0, 6]")
    s = op.get("surfaces", list(SURFACES))
    if not isinstance(s, list) or not s or not all(isinstance(x, str) for x in s):
        errors.append("surfaces must be a list of surface names")
    return errors


def chains(edges, digits=4):
    """Polylines from undirected segments [(a, b)] joined at shared end points (a node where more than two meet
    ends the chains through it)."""
    def key(p):
        return (round(p[0], digits), round(p[1], digits))
    adj, pos = {}, {}
    for a, b in edges:
        ka, kb = key(a), key(b)
        if ka == kb:
            continue
        pos[ka], pos[kb] = a, b
        adj.setdefault(ka, set()).add(kb)
        adj.setdefault(kb, set()).add(ka)
    used, out = set(), []

    def walk(k0, k1):
        line = [pos[k0], pos[k1]]
        used.add(frozenset((k0, k1)))
        prev, cur = k0, k1
        while len(adj[cur]) == 2:
            nxt = next(k for k in adj[cur] if k != prev)
            if frozenset((cur, nxt)) in used:
                break
            used.add(frozenset((cur, nxt)))
            line.append(pos[nxt])
            prev, cur = cur, nxt
        return line

    for start_at_nodes in (True, False):
        for k in sorted(adj):
            if start_at_nodes and len(adj[k]) == 2:
                continue
            for k1 in sorted(adj[k]):
                if frozenset((k, k1)) not in used:
                    out.append(walk(k, k1))
    return out


def offset_away(line, d, far):
    """`line` moved `d` to the side where `far(x, y)` (the distance to the grass edge) grows: into the road. The side
    is chosen per polyline from its middle segment."""
    import shape_surfaces as ss
    i = max(0, len(line) // 2 - 1)
    a, b = line[i], line[i + 1]
    L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
    nx, ny = -(b[1] - a[1]) / L, (b[0] - a[0]) / L
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    left = far(mx + nx * 0.05, my + ny * 0.05) > far(mx - nx * 0.05, my - ny * 0.05)
    return ss.offset_polyline([(p[0], p[1]) for p in line], d if left else -d, False)


def kerb_core(pieces, blends, roads, others, depth=DEPTH_M, road_m=ROAD_M, cuts=CUTS, cut=None, seed=0, tol=TOL_M):
    """Round the strips of `blends` along the boundaries of `pieces` (hard road meshes). `roads`: every road mesh
    near (any surface: an outer vertex on one marks a road-to-road strip); `others`: every other mesh near (their
    vertices at a moved point move with it); `cut(pieces, polylines)`: inserts the lines into the pieces (shape_apply's
    mesh cut). Mesh space is the course frame for all of them (the course .blend). Returns the run fields."""
    import bmesh
    import numpy as np
    from mathutils.kdtree import KDTree

    def kd_of(points):
        kd = KDTree(max(1, len(points)))
        for i, p in enumerate(points):
            kd.insert((p[0], p[1], 0.0), i)
        kd.balance()
        return kd

    def dense(edges, step=0.01):
        pts = []
        for a, b in edges:
            n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
            pts += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)]
        return pts

    edge_pts = []
    for o in pieces:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        edge_pts += [tuple(v.co) for e in bm.edges if e.is_boundary for v in e.verts]
        bm.free()
    road_pts = [tuple(v.co) for r in roads for v in r.data.vertices]
    on_edge, on_road = kd_of(edge_pts), kd_of(road_pts)

    def near(kd, co, n):
        return n and kd.find((co[0], co[1], 0.0))[2] <= tol

    out = {"depthM": depth, "roadM": road_m, "cuts": cuts, "blends": {}, "outer": 0}
    inner_edges, outer_edges, widths = [], [], []
    strips = {}
    for o in blends:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        inner = {v for v in bm.verts if near(on_edge, v.co, len(edge_pts))}
        strip = [f for f in bm.faces if any(v in inner for v in f.verts) and any(v not in inner for v in f.verts)
                 and all(v in inner or not near(on_road, v.co, len(road_pts)) for v in f.verts)]
        if not strip:
            out["blends"][o.name] = {"strip": 0}
            bm.free()
            continue
        outer = {v for f in strip for v in f.verts if v not in inner}
        ie = [(tuple(e.verts[0].co), tuple(e.verts[1].co)) for f in strip for e in f.edges
              if e.verts[0] in inner and e.verts[1] in inner]
        oe = [(tuple(e.verts[0].co), tuple(e.verts[1].co)) for f in strip for e in f.edges
              if e.verts[0] in outer and e.verts[1] in outer]
        rungs = list({e for f in strip for e in f.edges if (e.verts[0] in inner) != (e.verts[1] in inner)})
        widths += [e.calc_length() for e in rungs]
        if cuts and rungs:
            bmesh.ops.subdivide_edges(bm, edges=rungs, cuts=cuts, use_grid_fill=True)
        for f in bm.faces:
            f.smooth = True
        bm.to_mesh(o.data)
        bm.free()
        inner_edges += ie
        outer_edges += oe
        strips[o.name] = {"strip": len(strip), "rungs": len(rungs), "outer": len(outer)}
        out["outer"] += len(outer)
    out["blends"].update(strips)
    if not outer_edges:
        return out
    strip_w = sorted(widths)[len(widths) // 2] if widths else 0.12
    W = strip_w + road_m
    k_out = kd_of(dense(outer_edges))
    k_in = kd_of(dense(inner_edges))

    def far(x, y):
        return k_out.find((x, y, 0.0))[2]

    # 2. the line where the lip starts on the asphalt
    lines = [offset_away(line, road_m, far) for line in chains(inner_edges) if len(line) >= 2] if road_m > 0 else []
    if lines and cut is not None:
        out["cut"] = cut(pieces, lines)
    out["lipLines"] = len(lines)

    # 3. the drop, decided on the pieces and strips, carried to every vertex at the same place
    moved_pts, moved_dz = [], []
    for o in list(pieces) + [b for b in blends if b.name in strips]:
        for v in o.data.vertices:
            d = far(v.co.x, v.co.y)
            if d < W:
                moved_pts.append((v.co.x, v.co.y))
                moved_dz.append(-depth * profile(1.0 - d / W))
    kd = kd_of(moved_pts)
    out["moved"] = {}
    seen = set()
    for o in list(pieces) + list(blends) + list(roads) + list(others):
        if o.name in seen:
            continue
        seen.add(o.name)
        n = 0
        for v in o.data.vertices:
            _, i, dist = kd.find((v.co.x, v.co.y, 0.0))
            if dist <= tol and moved_dz[i] < 0:
                v.co.z += moved_dz[i]
                n += 1
        if n:
            o.data.update()
            out["moved"][o.name] = n

    # 4. the strips' paint
    for o in blends:
        if o.name not in strips:
            continue
        me = o.data
        attr = me.color_attributes.get("Col")
        if attr is None or attr.domain != "CORNER":
            for a in list(me.color_attributes):
                me.color_attributes.remove(a)
            attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        buf = np.empty(len(me.loops) * 4, dtype=np.float32)
        attr.data.foreach_get("color_srgb", buf)
        buf = buf.reshape(-1, 4)
        cv = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", cv)
        paint = {}
        for vi in set(cv.tolist()):
            co = me.vertices[vi].co
            do = k_out.find((co.x, co.y, 0.0))[2]
            di = k_in.find((co.x, co.y, 0.0))[2]
            if do + di > strip_w * 1.6 + 0.02:      # not a strip vertex (the blend's other faces keep their paint)
                continue
            paint[vi] = strip_paint(do / (do + di) if do + di > 0 else 0.0, co.x, co.y, seed)
        for li, vi in enumerate(cv.tolist()):
            p = paint.get(vi)
            if p is not None:
                buf[li, :3] = p
        attr.data.foreach_set("color_srgb", buf.reshape(-1))
        custom = me.attributes.get("custom_normal")
        if custom is not None:
            me.attributes.remove(custom)
        me.update()
        strips[o.name]["painted"] = len(paint)
    out["stripWidthM"] = round(strip_w, 3)
    return out
