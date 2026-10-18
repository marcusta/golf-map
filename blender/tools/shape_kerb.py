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

5. Where a hard piece meets a loose one (gravel, dirt: split_surfaces' seam, ragged), a milder lip: the asphalt
   rolls down `seamDepthM` (default 2 cm) over its last `seamRoadM` (0.2 m, a line cut there too), the loose piece
   lies that much lower at the seam and rises back over `seamLooseM` (0.5 m: split_surfaces' fade line has
   vertices there), so gravel lobes on the asphalt sit in the broken edge, a little below it.
6. A sawn joint in the asphalt just inside that seam, following its every tooth: three lines cut parallel to the
   ragged seam `jointM` (default 0.035 m) in, +- `jointHalfM` (0.012 m); the middle one sinks `jointDepthM`
   (6 mm) and is painted blue, the two guards keep the road's paint, so the joint is a thin V of blue a little
   below the asphalt (Unity draws a hard road's blue as a dark joint, as Afrod's concrete expansion joints).

Normals: the road and gravel pieces carry OPCD's custom normals (set from before the cut, so both sides of a piece
seam shade alike); flat ones would light the lips as if nothing had moved. Every moved vertex of theirs gets its
normal tilted by the slope of the drop it took (the profiles' derivative along the direction away from the edge),
the same function of XY in every object, so coincident vertices still shade alike and the cut's slivers do not
smudge it; the joint's V is left to its paint. The strips get smooth shading with custom normals dropped.

Objects keep their names and materials.
"""

import math

SURFACES = ("asphalt", "concrete", "paving")
DEPTH_M = 0.045
ROAD_M = 0.12
CUTS = 3
LOOSE = ("gravel", "dirt")
SEAM_DEPTH_M = 0.02
SEAM_ROAD_M = 0.2
SEAM_LOOSE_M = 0.5
JOINT_M = 0.035
JOINT_HALF_M = 0.012
JOINT_DEPTH_M = 0.006
JOINT_SIMPLIFY_M = 0.01  # the seam's grit smoothed this much under the joint (its lines would cross at every tooth)
SEAM_SIMPLIFY_M = 0.08  # the ragged seam is smoothed this much before its lip line is offset (no kinks)
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
    for key, hi in (("seamDepthM", 0.2), ("seamRoadM", 1), ("seamLooseM", 2), ("jointM", 0.5), ("jointHalfM", 0.1),
                    ("jointDepthM", 0.05)):
        v = op.get(key, 0.01)
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= hi:
            errors.append("%s must be a number in [0, %s]" % (key, hi))
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


def offset_ragged(line, d, side, min_dot=0.2):
    """A ragged polyline moved `d` to `side` (+1 left, -1 right) point by point along its averaged normals, the
    points whose segment turns back against the source (where a tooth is sharper than d) dropped, so the offset
    follows every tooth without loops."""
    n = len(line)
    out = []
    for i in range(n):
        a = line[i - 1] if i > 0 else line[i]
        b = line[i + 1] if i < n - 1 else line[i]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        out.append((line[i][0] - dy / L * d * side, line[i][1] + dx / L * d * side, i))
    kept = [out[0]]
    for q in out[1:]:
        p0 = kept[-1]
        sx, sy = line[q[2]][0] - line[p0[2]][0], line[q[2]][1] - line[p0[2]][1]
        ox, oy = q[0] - p0[0], q[1] - p0[1]
        ls, lo = math.hypot(sx, sy), math.hypot(ox, oy)
        if ls > 0 and lo > 0 and (sx * ox + sy * oy) / (ls * lo) >= min_dot:
            kept.append(q)
    return [(x, y) for x, y, _ in kept]


def seam_profile(d, road_side, seam_road=SEAM_ROAD_M, seam_loose=SEAM_LOOSE_M):
    """Share (0..1) of the seam drop at distance d from a hard/loose seam: on the road a quarter ellipse over its
    last seam_road, on the loose side the full drop at the seam easing back to nothing at seam_loose."""
    if road_side:
        return profile(1.0 - d / seam_road) if seam_road > 0 and d < seam_road else (1.0 if d <= 0 else 0.0)
    return 1.0 - _smoothstep(0.0, seam_loose, d) if seam_loose > 0 else (1.0 if d <= 0 else 0.0)


def kerb_core(pieces, blends, roads, others, depth=DEPTH_M, road_m=ROAD_M, cuts=CUTS, cut=None, seed=0, tol=TOL_M,
              loose=(), seam_depth=SEAM_DEPTH_M, seam_road=SEAM_ROAD_M, seam_loose=SEAM_LOOSE_M,
              joint=JOINT_M, joint_half=JOINT_HALF_M, joint_depth=JOINT_DEPTH_M):
    """Round the strips of `blends` along the boundaries of `pieces` (hard road meshes). `roads`: every road mesh
    near (any surface: an outer vertex on one marks a road-to-road strip); `others`: every other mesh near (their
    vertices at a moved point move with it); `cut(pieces, polylines)`: inserts the lines into the pieces (shape_apply's
    mesh cut); `loose`: the gravel / dirt pieces whose seams with `pieces` get the milder lip (step 5). Mesh space is
    the course frame for all of them (the course .blend). Returns the run fields."""
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

    out = {"depthM": depth, "roadM": road_m, "cuts": cuts, "blends": {}, "outer": 0, "moved": {}}
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

    # 5's seams: the hard pieces' boundary edges that a loose piece shares
    seam_edges = []
    if loose and seam_depth > 0:
        loose_pts = []
        for o in loose:
            bm = bmesh.new()
            bm.from_mesh(o.data)
            loose_pts += [tuple(v.co) for e in bm.edges if e.is_boundary for v in e.verts]
            bm.free()
        on_loose = kd_of(loose_pts)
        for o in pieces:
            bm = bmesh.new()
            bm.from_mesh(o.data)
            seam_edges += [(tuple(e.verts[0].co), tuple(e.verts[1].co)) for e in bm.edges if e.is_boundary
                           and all(near(on_loose, v.co, len(loose_pts)) for v in e.verts)]
            bm.free()
    out["seamEdges"] = len(seam_edges)
    if not outer_edges and not seam_edges:
        return out
    strip_w = sorted(widths)[len(widths) // 2] if widths else 0.12
    W = strip_w + road_m
    k_out = kd_of(dense(outer_edges)) if outer_edges else None
    k_in = kd_of(dense(inner_edges)) if inner_edges else None
    k_seam = kd_of(dense(seam_edges)) if seam_edges else None

    def far(x, y):
        return k_out.find((x, y, 0.0))[2] if k_out else float("inf")

    def seam_d(x, y):
        return k_seam.find((x, y, 0.0))[2] if k_seam else float("inf")

    # 2. the lines where the lips start on the asphalt (the seam's on a smoothed copy of the ragged line)
    lines = [offset_away(line, road_m, far) for line in chains(inner_edges) if len(line) >= 2] if road_m > 0 else []
    seam_lines = []
    if seam_edges and seam_road > 0:
        from mathutils.bvhtree import BVHTree
        import shape_surfaces as ss
        trees = [BVHTree.FromPolygons([v.co for v in o.data.vertices], [list(p.vertices) for p in o.data.polygons])
                 for o in pieces]

        def on_hard(x, y):
            return any(t.ray_cast((x, y, 1e4), (0, 0, -1))[0] is not None for t in trees)

        for line in chains(seam_edges):
            if len(line) < 2:
                continue
            pts = ss.simplify([(p[0], p[1]) for p in line], SEAM_SIMPLIFY_M)
            if len(pts) < 2:
                continue
            i = max(0, len(pts) // 2 - 1)
            a, b = pts[i], pts[i + 1]
            L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
            mx = (a[0] + b[0]) / 2 - (b[1] - a[1]) / L * 0.1
            my = (a[1] + b[1]) / 2 + (b[0] - a[0]) / L * 0.1
            seam_lines.append(ss.offset_polyline(pts, seam_road if on_hard(mx, my) else -seam_road, False))
    # 6. the sawn joint: three lines along the ragged seam itself, inside the asphalt
    joint_lines = []
    if seam_edges and joint > 0 and joint_half > 0:
        from mathutils.bvhtree import BVHTree
        import shape_surfaces as ss
        trees = [BVHTree.FromPolygons([v.co for v in o.data.vertices], [list(p.vertices) for p in o.data.polygons])
                 for o in pieces]

        def hard_at(x, y):
            return any(t.ray_cast((x, y, 1e4), (0, 0, -1))[0] is not None for t in trees)

        for line in chains(seam_edges):
            if len(line) < 3:
                continue
            votes = 0
            for i in range(0, len(line) - 1, max(1, (len(line) - 1) // 9)):
                a, b = line[i], line[i + 1]
                L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
                mx, my = (a[0] + b[0]) / 2 - (b[1] - a[1]) / L * 0.04, (a[1] + b[1]) / 2 + (b[0] - a[0]) / L * 0.04
                votes += 1 if hard_at(mx, my) else -1
            side = 1 if votes >= 0 else -1
            src = ss.simplify([(p[0], p[1]) for p in line], JOINT_SIMPLIFY_M)
            for d in (joint - joint_half, joint, joint + joint_half):
                off = offset_ragged(src, d, side)
                if len(off) >= 2:
                    joint_lines.append(off)
    if (lines or seam_lines or joint_lines) and cut is not None:
        out["cut"] = cut(pieces, lines + seam_lines + joint_lines)
    out["lipLines"], out["seamLines"], out["jointLines"] = len(lines), len(seam_lines), len(joint_lines)

    # 3. the drop, decided on the pieces, strips and loose pieces, carried to every vertex at the same place
    moved_pts, moved_dz = [], []
    for o in list(pieces) + [b for b in blends if b.name in strips]:
        for v in o.data.vertices:
            d = far(v.co.x, v.co.y)
            dz = -depth * profile(1.0 - d / W) if d < W else 0.0
            ds = seam_d(v.co.x, v.co.y)
            if ds < seam_road or ds <= tol:
                dz = min(dz, -seam_depth * seam_profile(ds, True, seam_road, seam_loose))
            if o in pieces and joint_lines and abs(ds - joint) < joint_half * 0.5:
                dz -= joint_depth
            if dz < 0:
                moved_pts.append((v.co.x, v.co.y))
                moved_dz.append(dz)
    n_hard = len(moved_pts)
    for o in loose:
        for v in o.data.vertices:
            ds = seam_d(v.co.x, v.co.y)
            if ds < seam_loose:
                moved_pts.append((v.co.x, v.co.y))
                moved_dz.append(-seam_depth * seam_profile(ds, False, seam_road, seam_loose))
    out["seamLooseVertices"] = len(moved_pts) - n_hard
    kd = kd_of(moved_pts)
    seen = set()
    for o in list(pieces) + list(blends) + list(loose) + list(roads) + list(others):
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
        if o.name not in strips or k_out is None:
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
    # the pieces' normals tilted by the drop's slope (see the module docstring)
    def nearest_dir(kd, x, y):
        if kd is None:
            return float("inf"), (0.0, 0.0)
        co, _, d = kd.find((x, y, 0.0))
        if d <= 1e-9:
            return 0.0, (0.0, 0.0)
        return d, ((x - co[0]) / d, (y - co[1]) / d)

    def slope(fn, d, h=0.002):
        # capped at 1 (45 deg): the quarter ellipse is vertical at the edge, the mesh's last faces are not
        g = (fn(d + h) - fn(max(0.0, d - h))) / (d + h - max(0.0, d - h))
        return max(-1.0, min(1.0, g))

    def kerb_dz(d):
        return -depth * profile(1.0 - d / W) if d < W else 0.0

    def seam_dz(d, road):
        return -seam_depth * seam_profile(d, road, seam_road, seam_loose)

    tilted = 0
    for o, road in [(o, True) for o in pieces] + [(o, False) for o in loose]:
        me = o.data
        if not len(me.loops):
            continue
        me.update()
        cn = np.empty(len(me.loops) * 3, dtype=np.float32)
        me.corner_normals.foreach_get("vector", cn)
        cn = cn.reshape(-1, 3)
        cv = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get("vertex_index", cv)
        grads = {}
        for vi in set(cv.tolist()):
            co = me.vertices[vi].co
            gx = gy = 0.0
            if road:
                d1, u1 = nearest_dir(k_out, co.x, co.y)
                d2, u2 = nearest_dir(k_seam, co.x, co.y)
                a1 = kerb_dz(d1) if d1 < W else 0.0
                a2 = seam_dz(d2, True) if d2 < seam_road else 0.0
                if a1 < 0 and a1 <= a2:
                    g = slope(kerb_dz, d1)
                    gx, gy = g * u1[0], g * u1[1]
                elif a2 < 0:
                    g = slope(lambda d: seam_dz(d, True), d2)
                    gx, gy = g * u2[0], g * u2[1]
            else:
                d2, u2 = nearest_dir(k_seam, co.x, co.y)
                if d2 < seam_loose:
                    g = slope(lambda d: seam_dz(d, False), d2)
                    gx, gy = g * u2[0], g * u2[1]
            if gx or gy:
                grads[vi] = (gx, gy)
        if not grads:
            continue
        for li, vi in enumerate(cv.tolist()):
            g = grads.get(vi)
            if g is None:
                continue
            nx, ny, nz = cn[li]
            nx, ny = nx - g[0] * nz, ny - g[1] * nz
            L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            cn[li] = (nx / L, ny / L, nz / L)
        me.normals_split_custom_set([tuple(v) for v in cn.tolist()])
        me.update()
        tilted += len(grads)
    out["normalsTilted"] = tilted

    # 6's paint: the joint's middle line blue on the hard pieces (the guards keep the road's paint)
    if joint_lines:
        painted = 0
        for o in pieces:
            me = o.data
            attr = me.color_attributes.get("Col")
            if attr is None or attr.domain != "CORNER":
                continue
            buf = np.empty(len(me.loops) * 4, dtype=np.float32)
            attr.data.foreach_get("color_srgb", buf)
            buf = buf.reshape(-1, 4)
            cv = np.empty(len(me.loops), dtype=np.int64)
            me.loops.foreach_get("vertex_index", cv)
            hit = {vi for vi in set(cv.tolist())
                   if abs(seam_d(me.vertices[vi].co.x, me.vertices[vi].co.y) - joint) < joint_half * 0.5}
            if not hit:
                continue
            mask = np.array([vi in hit for vi in cv.tolist()])
            buf[mask, :3] = (0.0, 0.0, 1.0)
            attr.data.foreach_set("color_srgb", buf.reshape(-1))
            me.update()
            painted += len(hit)
        out["jointVertices"] = painted
    out["stripWidthM"] = round(strip_w, 3)
    return out
