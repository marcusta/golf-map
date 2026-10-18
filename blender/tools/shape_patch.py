"""The carry-over's patch: a mesh OPCD refilled gets the previous build's faces back wherever they still fit.

OPCD fills a shape (and its `Outer_Deep_Sat` fill pieces between the shapes) with random interior points, anew on
every build in which the outline changed: a refilled piece shares no interior vertex with the old one (Omberg
svg_108 -> svg_110: 0 %, median 0.44 m apart) and only half its border. Everything keyed on mesh content then
misses - the conform cache for the whole piece, and the op cache's region entries (shape_region) for every rock
slab or tee on it, even far from the edit. So for each mesh the carry-over keeps as OPCD made it (shape_carry), the
previous build's faces are put back where nothing changed:

- **Plain meshes only** (`constants`): triangles, no vertex groups, every attribute other than position and topology
  one value over the mesh (OPCD's filled meshes: one paint colour, flat custom normals, one material).
- **Donors**: the previous build's plain meshes with the same materials, attribute set and values.
- **A donor face fits** (`fit_faces`) when each of its vertices is one of the new border vertices (the same XY, bit
  for bit) or lies inside the new outline at least `D_MIN` from where it changed (the new border's segments the
  donor has no edge for), and an edge between two border vertices is a border edge or runs inside.
- **The gaps** (where the border changed, a piece split moved, a shape shrank) are triangulated by Blender's
  constrained Delaunay over the new border, the kept faces' edges and the new build's own interior points that lie
  in a gap (`GAP_MIN` from every kept vertex, not inside a kept face). A kept face the triangulation has to cut (a
  border passing through it, a point inside it) becomes gap, and it runs again.
- **Order**: the kept vertices, edges and faces in the donors' order (donors by name), each face's corners as the
  donor had them; then the new border vertices not yet there, the new interior points, the gap edges and faces.
  A part of the mesh that comes from one old mesh has that mesh's relative order - what a region key compares.
- **Checks**: no vertex added by the triangulation, the same area (`AREA_TOL`), the same border edges, every face
  wound like the mesh. Any failure: the mesh stays as OPCD made it (`reason`).

The border vertices keep the new build's positions, so no seam moves. Pure numpy apart from the triangulation
(`mathutils.geometry.delaunay_2d_cdt`, Blender only); states as shape_apply.capture_state makes them.
"""
import numpy as np

import shape_region as sreg

D_MIN = 0.3          # a donor's interior vertex this close to the new border does not fit
GAP_MIN = 0.5        # a new interior point this close to a kept vertex stays out of the gap
AREA_TOL = 1e-6      # relative
ROW_M = 2.0          # point-in-polygon: the border's segments bucketed in rows this tall
SAMPLE_M = 0.05      # distance to the border: measured to points this far apart along it
MAX_ROUNDS = 6


def constants(meta, arrays):
    """{key: value bytes} of a plain mesh (every non-topology attribute but position one value), else None."""
    if meta.get("vgroups") or "dv_vert" in arrays:
        return None
    m = sreg.Mesh(meta, arrays)
    if m.n["FACE"] == 0 or not (m.pt == 3).all():
        return None
    out = {}
    for k in m.keys:
        name, domain, _ = sreg.parse(k)
        if name in sreg.TOPOLOGY or k == sreg.POSITION_KEY:
            continue
        c = m.col(k)
        if not len(c) or not (c == c[:1]).all():
            return None
        out[k] = c[0].tobytes()
    return out


def border(m):
    """(border edges (k, 2) as vertex pairs, border vertex ids) of a mesh."""
    fc = np.bincount(m.ce, minlength=m.n["EDGE"])
    be = m.ev[fc == 1].astype(np.int64)
    return be, np.unique(be)


def _xy_keys(xy):
    """One hashable key per XY (float32 bits)."""
    a = np.ascontiguousarray(xy.astype(np.float32))
    return a.view(np.uint64).ravel() if a.shape[1] == 2 else None


def inside(points, a, b):
    """Even-odd point in polygon (the polygon = segments a[i] -> b[i]) for (n, 2) points, by rows."""
    if not len(points):
        return np.zeros(0, bool)
    y0 = min(float(points[:, 1].min()), float(min(a[:, 1].min(), b[:, 1].min())))
    pr = np.floor((points[:, 1] - y0) / ROW_M).astype(np.int64)
    lo = np.floor((np.minimum(a[:, 1], b[:, 1]) - y0) / ROW_M).astype(np.int64)
    hi = np.floor((np.maximum(a[:, 1], b[:, 1]) - y0) / ROW_M).astype(np.int64)
    span = hi - lo + 1
    seg = np.repeat(np.arange(len(a)), span)
    row = np.repeat(lo, span) + (np.arange(span.sum()) - np.repeat(np.cumsum(span) - span, span))
    order = np.argsort(row, kind="stable")
    row, seg = row[order], seg[order]
    out = np.zeros(len(points), bool)
    porder = np.argsort(pr, kind="stable")
    rows_p, starts = np.unique(pr[porder], return_index=True)
    ends = np.append(starts[1:], len(porder))
    for r, s, e in zip(rows_p.tolist(), starts.tolist(), ends.tolist()):
        pi = porder[s:e]
        j0, j1 = np.searchsorted(row, r), np.searchsorted(row, r, side="right")
        if j0 == j1:
            continue
        sa, sb = a[seg[j0:j1]], b[seg[j0:j1]]
        px, py = points[pi, 0][:, None], points[pi, 1][:, None]
        cond = (sa[:, 1] > py) != (sb[:, 1] > py)
        dy = np.where(sb[:, 1] == sa[:, 1], 1.0, sb[:, 1] - sa[:, 1])
        xint = sa[:, 0] + (py - sa[:, 1]) * (sb[:, 0] - sa[:, 0]) / dy
        out[pi] = ((cond & (xint > px)).sum(1) % 2) == 1
    return out


def border_distance(points, a, b):
    """Distance (to within SAMPLE_M / 2) from each point to the nearest border segment."""
    from mathutils.kdtree import KDTree
    L = np.hypot(*(b - a).T)
    n = np.maximum(1, np.ceil(L / SAMPLE_M).astype(np.int64))
    t = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
    t = t / np.repeat(n, n)
    seg = np.repeat(np.arange(len(a)), n)
    s = a[seg] + (b[seg] - a[seg]) * t[:, None]
    s = np.concatenate([s, b])
    kd = KDTree(len(s))
    for i, (x, y) in enumerate(s.tolist()):
        kd.insert((x, y, 0.0), i)
    kd.balance()
    return np.array([kd.find((x, y, 0.0))[2] for x, y in points.tolist()]) if len(points) else np.zeros(0)


def fit_faces(m, d, bkeys, seg_a, seg_b, bedges):
    """Donor mesh d's faces that fit inside mesh m (see the module doc): (face ids, per donor vertex its m border
    vertex or -1)."""
    dxy = d.co[:, :2].astype(np.float64)
    keys = _xy_keys(d.co[:, :2])
    on_b = np.array([bkeys.get(int(k), -1) for k in keys.tolist()], np.int64)
    box = (min(seg_a[:, 0].min(), seg_b[:, 0].min()), min(seg_a[:, 1].min(), seg_b[:, 1].min()),
           max(seg_a[:, 0].max(), seg_b[:, 0].max()), max(seg_a[:, 1].max(), seg_b[:, 1].max()))
    cand = (on_b < 0) & sreg.inside(d.co, box)
    ok = on_b >= 0
    # the new border's segments the donor does not have as an edge: where the outline changed
    de = on_b[d.ev]
    de = de[(de >= 0).all(1)]
    have = {(min(p, q), max(p, q)) for p, q in de.tolist()}
    changed = np.array([(min(p, q), max(p, q)) not in have for p, q in bedges.tolist()], bool)
    ci = np.nonzero(cand)[0]
    if len(ci):
        inn = inside(dxy[ci], seg_a, seg_b)
        ci = ci[inn]
        if len(ci) and changed.any():
            dist = border_distance(dxy[ci], seg_a[changed], seg_b[changed])
            ok[ci[dist >= D_MIN + SAMPLE_M]] = True
        elif len(ci):
            ok[ci] = True
    tri = d.cv.reshape(-1, 3)
    fok = ok[tri].all(1)
    # an edge between two border vertices: a border edge of m, or its midpoint inside m
    bset = {(min(p, q), max(p, q)) for p, q in bedges.tolist()}
    check = np.nonzero(fok & ((on_b[tri] >= 0).sum(1) >= 2))[0]
    mids, owners = [], []
    for f in check.tolist():
        vs = tri[f].tolist()
        for i in range(3):
            p, q = on_b[vs[i]], on_b[vs[(i + 1) % 3]]
            if p >= 0 and q >= 0 and (min(p, q), max(p, q)) not in bset:
                mids.append((dxy[vs[i]] + dxy[vs[(i + 1) % 3]]) / 2)
                owners.append(f)
    if mids:
        inn = inside(np.array(mids), seg_a, seg_b)
        for f, good in zip(owners, inn.tolist()):
            if not good:
                fok[f] = False
    return np.nonzero(fok)[0], on_b


def in_triangles(points, xy, tris, cell=2.0):
    """Per point: does it lie inside (or on) one of the triangles (vertex ids into xy)? Triangles bucketed by cell."""
    out = np.zeros(len(points), bool)
    if not len(points) or not len(tris):
        return out
    T = xy[tris]                                   # (t, 3, 2)
    lo, hi = T.min(1), T.max(1)
    c0 = np.floor(lo / cell).astype(np.int64)
    c1 = np.floor(hi / cell).astype(np.int64)
    buckets = {}
    for t, (ax, ay, bx, by) in enumerate(np.hstack([c0, c1]).tolist()):
        for cx in range(ax, bx + 1):
            for cy in range(ay, by + 1):
                buckets.setdefault((cx, cy), []).append(t)
    pc = np.floor(points / cell).astype(np.int64)
    for i, (cx, cy) in enumerate(pc.tolist()):
        ts = buckets.get((cx, cy))
        if not ts:
            continue
        tri = T[ts]
        p = points[i]
        d1 = (tri[:, 1, 0] - tri[:, 0, 0]) * (p[1] - tri[:, 0, 1]) - (tri[:, 1, 1] - tri[:, 0, 1]) * (p[0] - tri[:, 0, 0])
        d2 = (tri[:, 2, 0] - tri[:, 1, 0]) * (p[1] - tri[:, 1, 1]) - (tri[:, 2, 1] - tri[:, 1, 1]) * (p[0] - tri[:, 1, 0])
        d3 = (tri[:, 0, 0] - tri[:, 2, 0]) * (p[1] - tri[:, 2, 1]) - (tri[:, 0, 1] - tri[:, 2, 1]) * (p[0] - tri[:, 2, 0])
        if (((d1 >= 0) & (d2 >= 0) & (d3 >= 0)) | ((d1 <= 0) & (d2 <= 0) & (d3 <= 0))).any():
            out[i] = True
    return out


def _area2(xy, tri):
    p, q, r = xy[tri[:, 0]], xy[tri[:, 1]], xy[tri[:, 2]]
    return (q[:, 0] - p[:, 0]) * (r[:, 1] - p[:, 1]) - (q[:, 1] - p[:, 1]) * (r[:, 0] - p[:, 0])


def patch(state, donors):
    """state: the mesh as the new build has it (after the carry-over weld). donors: [(name, state)] of the previous
    build, by name. Returns (new state, stats) or (None, reason)."""
    from mathutils import Vector
    from mathutils.geometry import delaunay_2d_cdt
    consts = constants(*state)
    if consts is None:
        return None, "not plain"
    m = sreg.Mesh(*state)
    xy = m.co[:, :2].astype(np.float64)
    tri_m = m.cv.reshape(-1, 3).astype(np.int64)
    a2_m = _area2(xy, tri_m)
    sign = 1.0 if (a2_m > 0).sum() >= (a2_m < 0).sum() else -1.0
    if not ((a2_m * sign) > 0).all():
        return None, "mixed winding"
    area_m = float(np.abs(a2_m).sum()) / 2
    bedges, bverts = border(m)
    if not len(bedges):
        return None, "no border"
    seg_a, seg_b = xy[bedges[:, 0]], xy[bedges[:, 1]]
    mkeys = _xy_keys(m.co[:, :2])
    bkeys = {int(mkeys[v]): int(v) for v in bverts.tolist()}
    mbox = (float(xy[:, 0].min()), float(xy[:, 1].min()), float(xy[:, 0].max()), float(xy[:, 1].max()))

    # the donors' faces that fit
    kept = []   # (donor no, face ids, donor mesh, on_b)
    for di, (dname, dstate) in enumerate(donors):
        if constants(*dstate) != consts or set(k for k in dstate[1] if k.startswith("a|")) != set(m.keys) \
                or dstate[0].get("materials") != state[0].get("materials"):
            continue
        d = sreg.Mesh(*dstate)
        if not len(d.co) or not sreg.inside(d.co, mbox).any():
            continue
        faces, on_b = fit_faces(m, d, bkeys, seg_a, seg_b, bedges)
        if len(faces):
            kept.append([di, faces, d, on_b])
    if not kept:
        return None, "no donor face fits"

    m_interior = np.setdiff1d(np.arange(m.n["POINT"]), bverts)
    drop_points = set()
    for rnd in range(MAX_ROUNDS):
        # vertices: the kept ones in donor order, then the border, then the gap points
        key_to_new, pos, src = {}, [], []

        def add(k, p):
            if k not in key_to_new:
                key_to_new[k] = len(pos)
                pos.append(p)
            return key_to_new[k]

        kept_faces = []   # per kept face its 3 new vertex ids (donor corner order)
        dkeys = []
        for di, faces, d, on_b in kept:
            used = np.unique(d.cv.reshape(-1, 3)[faces])
            keys = _xy_keys(d.co[:, :2])
            dk = {}
            for v in used.tolist():
                k = int(keys[v])
                dk[v] = add(k, m.co[on_b[v]] if on_b[v] >= 0 else d.co[v])
            dkeys.append(dk)
            kept_faces += [[dk[v] for v in t] for t in d.cv.reshape(-1, 3)[faces].tolist()]
        n_kept_v = len(pos)
        for v in bverts.tolist():
            add(int(mkeys[v]), m.co[v])
        n_border_v = len(pos)
        # the new build's interior points in the gaps
        kv = np.array([p[:2] for p in pos[:n_kept_v]], np.float64)
        gap_pts = []
        if len(m_interior):
            from mathutils.kdtree import KDTree
            kd = KDTree(len(kv))
            for i, (x, y) in enumerate(kv.tolist()):
                kd.insert((x, y, 0.0), i)
            kd.balance()
            for v in m_interior.tolist():
                if v in drop_points:
                    continue
                if kd.find((float(xy[v, 0]), float(xy[v, 1]), 0.0))[2] >= GAP_MIN:
                    gap_pts.append(v)
            if gap_pts and kept_faces:
                kxy = np.array([p[:2] for p in pos], np.float64)
                inside_kept = in_triangles(xy[gap_pts], kxy, np.array(kept_faces, np.int64))
                gap_pts = [v for v, bad_ in zip(gap_pts, inside_kept.tolist()) if not bad_]
        for v in gap_pts:
            add(int(mkeys[v]), m.co[v])
        n_v = len(pos)
        P = np.array(pos, np.float64)
        # constraints: the border and every kept face's edges
        cons = set()
        for p, q in bedges.tolist():
            a_, b_ = key_to_new[int(mkeys[p])], key_to_new[int(mkeys[q])]
            cons.add((min(a_, b_), max(a_, b_)))
        for f in kept_faces:
            for i in range(3):
                a_, b_ = f[i], f[(i + 1) % 3]
                cons.add((min(a_, b_), max(a_, b_)))
        cons = sorted(cons)
        out = delaunay_2d_cdt([Vector((float(x), float(y))) for x, y in P[:, :2].tolist()], cons, [], 0, 1e-9, True)
        out_co, _, out_faces, orig_verts = out[0], out[1], out[2], out[3]
        o2i = np.full(len(out_co), -1, np.int64)
        for i, ov in enumerate(orig_verts):
            if len(ov) == 1:
                o2i[i] = ov[0]
            elif len(ov) > 1:
                return None, "points merged by the triangulation"
        kept_set = {tuple(sorted(f)): j for j, f in enumerate(kept_faces)}
        found, gap, cut = set(), [], set()
        cent_faces = []
        for f in out_faces:
            ids = [int(o2i[i]) for i in f]
            if min(ids) < 0:     # a vertex the triangulation added: a constraint crossed another
                cut.add(tuple(f))
                continue
            t = tuple(sorted(ids))
            if t in kept_set:
                found.add(kept_set[t])
            else:
                cent_faces.append(ids)
        missing = [j for j in range(len(kept_faces)) if j not in found]
        if missing or cut:
            # kept faces the triangulation had to cut: they become gap (and any gap point inside them goes)
            bad = set(missing)
            if cut:
                # faces next to an added vertex: the kept faces sharing a vertex with them
                near = {int(o2i[i]) for f in cut for i in f if o2i[i] >= 0}
                bad |= {j for j, f in enumerate(kept_faces) if near & set(f)}
            new_kept = []
            for di, faces, d, on_b in kept:
                dk = dkeys[[k[0] for k in kept].index(di)]
                keep_f = []
                for fid, tv in zip(faces.tolist(), d.cv.reshape(-1, 3)[faces].tolist()):
                    j = kept_set.get(tuple(sorted(dk[v] for v in tv)))
                    if j is None or j not in bad:
                        keep_f.append(fid)
                if keep_f:
                    new_kept.append([di, np.array(keep_f, np.int64), d, on_b])
            # gap points inside a dropped kept face
            if gap_pts and bad:
                hit = in_triangles(xy[gap_pts], P[:, :2], np.array([kept_faces[j] for j in sorted(bad)], np.int64))
                drop_points.update(v for v, h in zip(gap_pts, hit.tolist()) if h)
            if not new_kept:
                return None, "no donor face survives the triangulation"
            kept = new_kept
            continue
        # gap faces: the triangles inside the outline
        G = np.array(cent_faces, np.int64).reshape(-1, 3)
        if len(G):
            c = P[G, :2].mean(1)
            G = G[inside(c, seg_a, seg_b)]
            a2 = _area2(P[:, :2], G)
            flip = (a2 * sign) < 0
            G[flip] = G[flip][:, [0, 2, 1]]
        K = np.array(kept_faces, np.int64).reshape(-1, 3)
        if len(K) and not ((_area2(P[:, :2], K) * sign) > 0).all():
            return None, "a donor face is wound the other way"
        area = (np.abs(_area2(P[:, :2], K)).sum() + np.abs(_area2(P[:, :2], G)).sum()) / 2 if len(G) else np.abs(_area2(P[:, :2], K)).sum() / 2
        if abs(area - area_m) > AREA_TOL * area_m + 1e-6:
            return None, "area %.4f != %.4f" % (area, area_m)
        faces = np.concatenate([K, G]) if len(G) else K
        # edges: the kept faces' in donor edge order, then the rest as the faces bring them
        edge_id, edges = {}, []
        for (di, fids, d, on_b), dk in zip(kept, dkeys):
            tri_e = d.ce.reshape(-1, 3)[fids]
            for e in np.unique(tri_e).tolist():
                p, q = d.ev[e].tolist()
                a_, b_ = dk[p], dk[q]
                k = (min(a_, b_), max(a_, b_))
                if k not in edge_id:
                    edge_id[k] = len(edges)
                    edges.append(k)
        corner_edge = np.empty(faces.size, np.int64)
        for i, f in enumerate(faces.tolist()):
            for c_ in range(3):
                a_, b_ = f[c_], f[(c_ + 1) % 3]
                k = (min(a_, b_), max(a_, b_))
                if k not in edge_id:
                    edge_id[k] = len(edges)
                    edges.append(k)
                corner_edge[3 * i + c_] = edge_id[k]
        E = np.array(edges, np.int64)
        # the border: exactly the new build's edges
        count = np.bincount(corner_edge, minlength=len(E))
        new_border = {tuple(e) for e in E[count == 1].tolist()}
        want = {tuple(sorted((key_to_new[int(mkeys[p])], key_to_new[int(mkeys[q])]))) for p, q in bedges.tolist()}
        if new_border != want or (count > 2).any():
            return None, "the border changed"
        used = np.zeros(n_v, bool)
        used[faces.ravel()] = True
        if not used.all():
            return None, "a vertex without a face"
        break
    else:
        return None, "the triangulation kept cutting donor faces"

    nv, ne, nf = n_v, len(E), len(faces)
    arrays = {}
    for k in m.keys:
        name, domain, dtype = sreg.parse(k)
        if k == sreg.POSITION_KEY:
            arrays[k] = P.astype(np.float32).ravel()
        elif name == ".edge_verts":
            arrays[k] = E.astype(np.int32).ravel()
        elif name == ".corner_vert":
            arrays[k] = faces.astype(np.int32).ravel()
        elif name == ".corner_edge":
            arrays[k] = corner_edge.astype(np.int32)
        else:
            n = {"POINT": nv, "EDGE": ne, "FACE": nf, "CORNER": nf * 3}[domain]
            one = np.frombuffer(consts[k], dtype=state[1][k].dtype)
            arrays[k] = np.tile(one, n)
    arrays["poly_start"] = (np.arange(nf) * 3).astype(np.int32)
    meta = dict(state[0], counts=[nv, ne, nf, nf * 3])
    vmap = np.full(m.n["POINT"], -1, np.int64)   # the new build's border vertex id -> the patched mesh's
    for v in bverts.tolist():
        vmap[v] = key_to_new[int(mkeys[v])]
    stats = {"kept": int(len(K)), "gap": int(len(G)), "gapPoints": len(gap_pts), "faces": int(nf),
             "faces0": int(m.n["FACE"]), "donors": [donors[k[0]][0] for k in kept], "rounds": rnd + 1}
    return (meta, arrays), dict(stats, vmap=vmap)
