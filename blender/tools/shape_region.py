"""Region entries of the shaping op cache: an op unit keyed and replayed by the part of the course it reads.

A rock-slab cut-out or a tee flatten changes a few square metres of meshes that span hundreds of metres (OPCD's
`Outer_Deep_Sat` fill pieces, the deep rough). The op cache's own key is every read mesh's whole state, so any
change anywhere in such a mesh - and OPCD refills a piece whenever a shape on its border changes - made every unit
that reads it miss. A region entry keys the unit on the part of each mesh around it instead, and a hit replaces
just that part (README "Shaping: apply", "Region entries").

Pure numpy on the states `shape_apply.capture_state` makes ((meta, arrays): every attribute as a flat array keyed
`a|<name>|<domain>|<type>`, `poly_start`, vertex-group weights `dv_*`), so it runs without Blender too.

- **K** (`masks`): the faces with a vertex inside the key box, their corners, vertices and edges, plus loose
  vertices / edges inside it.
- **Signature** (`signature`): the K part in its relative order - every attribute of the K elements, references as
  K-relative ids, each K edge's face count in the whole mesh, vertex-group weights - plus the caller's class of the
  mesh. No names: a renumbered piece hits.
- **Piece** (`extract`): what the op left of the K part. Every input element outside the change box (the region the
  op may change, inside K) must be in the output unchanged and in the same order ("local"); the output elements
  that are not the images of non-K elements form the piece, self-contained (references internal), with the K
  elements on K's edge that the rest of the mesh refers to (`ringV`, `ringE`: K-relative id -> piece id). Two
  whole-mesh effects are recorded instead of breaking locality: custom normals rewritten everywhere
  (`renormal`, the cut's `_drop_cut_attrs`; the caller re-derives and checks them) and an attribute set to one
  value everywhere (`fill`, e.g. a selection flag Edit Mode leaves on).
- **Transplant** (`transplant`): a mesh with the same K part gets the piece in K's place: piece elements take the
  K elements' slots in order, extra ones are appended, spare slots dropped; everything outside K stays as it is.
- **Canonical hash** (`canonical_hash`): a mesh state's hash independent of element order and face start corner
  (what an order-free comparison of two runs uses).
"""
import hashlib
import json

import numpy as np

POSITION_KEY = "a|position|POINT|FLOAT_VECTOR"
CUSTOM_NORMAL_KEY = "a|custom_normal|CORNER|INT16_2D"
WIDTH = {"FLOAT": 1, "INT": 1, "INT8": 1, "BOOLEAN": 1, "FLOAT_VECTOR": 3, "FLOAT2": 2, "INT16_2D": 2,
         "INT32_2D": 2, "FLOAT_COLOR": 4, "BYTE_COLOR": 4, "QUATERNION": 4, "FLOAT4X4": 16}
TOPOLOGY = (".edge_verts", ".corner_vert", ".corner_edge")
DOMAINS = ("POINT", "EDGE", "FACE", "CORNER")
# Selection flags: in a K part they are keyed and replayed like any attribute; outside it a replay keeps the mesh's own
# (Afrod's Edit Mode leaves a pattern over every mesh it entered; selection reaches neither the FBX nor GSPro).
SELECTION = ("a|.select_vert|POINT|BOOLEAN", "a|.select_edge|EDGE|BOOLEAN", "a|.select_poly|FACE|BOOLEAN")
# Props that hold names or OPCD ids (a renumbered piece changes them; the ops read the index's type/kind instead).
NAME_PROPS = ("opcd_shape_id", "opcd_parent_id", "golfmap_cut_from")


class NotLocal(Exception):
    """The op changed something outside its region (or in a way a piece cannot hold)."""


def parse(key):
    _, name, domain, dtype = key.split("|")
    return name, domain, dtype


class Mesh:
    """A captured state with its topology unpacked."""

    def __init__(self, meta, arrays):
        self.meta, self.arrays = meta, arrays
        nv, ne, nf, nl = meta["counts"]
        self.n = {"POINT": nv, "EDGE": ne, "FACE": nf, "CORNER": nl}
        self.keys = sorted(k for k in arrays if k.startswith("a|"))
        by = {parse(k)[0]: k for k in self.keys}
        self.ev = arrays[by[".edge_verts"]].reshape(-1, 2) if ".edge_verts" in by else np.zeros((0, 2), np.int32)
        self.cv = arrays[by[".corner_vert"]] if ".corner_vert" in by else np.zeros(0, np.int32)
        self.ce = arrays[by[".corner_edge"]] if ".corner_edge" in by else np.zeros(0, np.int32)
        self.ps = arrays["poly_start"].astype(np.int64)
        self.pt = np.diff(np.append(self.ps, nl)).astype(np.int64)
        self.co = arrays[POSITION_KEY].reshape(-1, 3)
        self.topo = {n: by[n] for n in TOPOLOGY if n in by}

    def col(self, key):
        name, domain, dtype = parse(key)
        return self.arrays[key].reshape(self.n[domain], WIDTH[dtype])

    def plain_keys(self, domain, skip=()):
        return [k for k in self.keys if parse(k)[1] == domain and parse(k)[0] not in TOPOLOGY and k not in skip]


def inside(co, box):
    return (co[:, 0] >= box[0]) & (co[:, 0] <= box[2]) & (co[:, 1] >= box[1]) & (co[:, 1] <= box[3])


def masks(m, box):
    """(vk, ek, fk, lk): the K part of mesh `m` for an XY box (x0, y0, x1, y1)."""
    nv, ne, nf, nl = (m.n[d] for d in DOMAINS)
    vin = inside(m.co, box) if nv else np.zeros(0, bool)
    fk = np.zeros(nf, bool)
    if nf and nl:
        fk = np.add.reduceat(vin[m.cv].astype(np.int32), m.ps) > 0
    lk = np.repeat(fk, m.pt)
    vk = np.zeros(nv, bool)
    vk[m.cv[lk]] = True
    ek = np.zeros(ne, bool)
    ek[m.ce[lk]] = True
    used_v = np.zeros(nv, bool)
    used_v[m.cv] = True
    used_e = np.zeros(ne, bool)
    used_e[m.ce] = True
    vk |= vin & ~used_v                     # loose vertices inside the box
    if ne:
        ek |= ~used_e & vk[m.ev].any(1)     # loose edges touching one
        vk[m.ev[ek].ravel()] = True
    return vk, ek, fk, lk


def _rank(mask):
    return np.cumsum(mask) - 1


def signature(meta, arrays, box, cls):
    """sha256 of the mesh's K part (relative order, K-relative refs) + `cls`, or None when K is empty."""
    m = Mesh(meta, arrays)
    vk, ek, fk, lk = masks(m, box)
    if not vk.any():
        return None
    vr, er = _rank(vk), _rank(ek)
    h = hashlib.sha256()
    h.update(json.dumps(cls, sort_keys=True, default=str).encode())
    sel = {"POINT": vk, "EDGE": ek, "FACE": fk, "CORNER": lk}
    for k in m.keys:
        name, domain, _ = parse(k)
        if name == ".edge_verts":
            data = vr[m.ev[ek]]
        elif name == ".corner_vert":
            data = vr[m.cv[lk]]
        elif name == ".corner_edge":
            data = er[m.ce[lk]]
        else:
            data = m.col(k)[sel[domain]]
        h.update(k.encode())
        h.update(np.ascontiguousarray(data).tobytes())
    h.update(m.pt[fk].tobytes())
    h.update(np.bincount(m.ce, minlength=m.n["EDGE"])[ek].astype(np.int64).tobytes())
    if "dv_vert" in arrays:
        s = vk[arrays["dv_vert"]]
        h.update(vr[arrays["dv_vert"][s]].astype(np.int64).tobytes())
        h.update(arrays["dv_group"][s].tobytes())
        h.update(arrays["dv_weight"][s].tobytes())
    return h.hexdigest()


# ---------------------------------------------------------------- rows and matching

def _bytes_rows(cols, n):
    """(n, w) uint8: the given (n, k) arrays side by side as bytes."""
    if not n:
        return np.zeros((0, 0), np.uint8)
    parts = [np.ascontiguousarray(np.ascontiguousarray(c).reshape(n, -1)).view(np.uint8).reshape(n, -1) for c in cols]
    return np.hstack(parts) if parts else np.zeros((n, 0), np.uint8)


_M1, _M2 = np.uint64(0x9E3779B97F4A7C15), np.uint64(0xBF58476D1CE4E5B9)


def _row_hash(rows):
    """uint64 per row of a (n, w) uint8 array."""
    n, w = rows.shape
    if not n or not w:
        return np.full(n, 0x632BE59BD9B4E019, np.uint64)
    pad = (-w) % 8
    if pad:
        rows = np.hstack([rows, np.zeros((n, pad), np.uint8)])
    words = np.ascontiguousarray(rows).view(np.uint64).reshape(n, -1)
    h = np.full(n, 0x632BE59BD9B4E019, np.uint64)
    with np.errstate(over="ignore"):
        for j in range(words.shape[1]):
            h = (h ^ words[:, j]) * _M1
            h ^= h >> np.uint64(31)
            h *= _M2
            h ^= h >> np.uint64(29)
    return h


def _face_hash(corner_hash, face_rows_hash, ps, pt):
    """uint64 per face: its corners' hashes in order, its own attributes and corner count."""
    nf = len(ps)
    if not nf:
        return np.zeros(0, np.uint64)
    local = np.arange(len(corner_hash)) - np.repeat(ps, pt)
    with np.errstate(over="ignore"):
        w = (local.astype(np.uint64) + np.uint64(1)) * _M2
        mixed = corner_hash * (w | np.uint64(1))
        mixed ^= mixed >> np.uint64(33)
        s = np.add.reduceat(mixed, ps) if len(mixed) else np.zeros(nf, np.uint64)
        s = s * _M1 ^ face_rows_hash ^ (pt.astype(np.uint64) * _M2)
    return s


def _match(a, b):
    """Positions in `b` of the elements of `a` (uint64 hashes), found as a subsequence in order. None when some
    element of `a` is missing or the order is not kept."""
    if not len(a):
        return np.zeros(0, np.int64)
    order = np.argsort(b, kind="stable")
    bs = b[order]
    pos = np.searchsorted(bs, a)
    if (pos >= len(bs)).any() or (bs[np.minimum(pos, len(bs) - 1)] != a).any():
        return None
    idx = order[pos]
    if (np.diff(idx) > 0).all():
        return idx
    # duplicates (two equal rows): walk the subsequence
    out = np.empty(len(a), np.int64)
    j = 0
    bl = b.tolist()
    for i, x in enumerate(a.tolist()):
        while j < len(bl) and bl[j] != x:
            j += 1
        if j == len(bl):
            return None
        out[i] = j
        j += 1
    return out


def _box_distance(co, box):
    dx = np.maximum(np.maximum(box[0] - co[:, 0], co[:, 0] - box[2]), 0)
    dy = np.maximum(np.maximum(box[1] - co[:, 1], co[:, 1] - box[3]), 0)
    return np.hypot(dx, dy)


def _why_vertices(mi, mo, ia, pk, box_r):
    """Why the vertices outside the change box are not in the output as they were: per attribute, how many and how
    far from the box (the reason a unit is not local)."""
    for k in [POSITION_KEY] + [k for k in pk if k != POSITION_KEY]:
        a = _row_hash(_bytes_rows([mi.col(k)], mi.n["POINT"]))[ia]
        b = _row_hash(_bytes_rows([mo.col(k)], mo.n["POINT"]))
        if _match(a, b) is not None:
            continue
        if k == POSITION_KEY:
            gone = ia[~np.isin(a, b)]
            if len(gone):
                d = _box_distance(mi.co[gone], box_r)
                return "a vertex outside the region moved (%d, up to %.0f m from it)" % (len(gone), d.max())
            return "the vertices outside the region changed order"
        return "point attribute %s changed outside the region" % parse(k)[0]
    return "the vertices outside the region changed order"


def _why_faces(mi, mo, if_, ck, fkk, v2o, e2o, box_r):
    """Why the faces outside the change box are not in the output as they were (see _why_vertices)."""
    def face_hashes(m, cols_c, cols_f, cv, ce):
        c = _row_hash(_bytes_rows(cols_c + [cv, ce], m.n["CORNER"]))
        return _face_hash(c, _row_hash(_bytes_rows(cols_f, m.n["FACE"])), m.ps, m.pt)
    z = lambda m: np.zeros(m.n["CORNER"], np.int64)
    a = face_hashes(mi, [], [], v2o[mi.cv], z(mi))[if_]
    b = face_hashes(mo, [], [], mo.cv.astype(np.int64), z(mo))
    if _match(a, b) is None:
        gone = if_[~np.isin(a, b)]
        if len(gone):
            co = mi.co[mi.cv[np.concatenate([np.arange(s, s + t) for s, t in zip(mi.ps[gone].tolist(), mi.pt[gone].tolist())])]]
            return "a face outside the region lost or changed a vertex (%d, up to %.0f m from it)" % (len(gone), _box_distance(co, box_r).max())
        return "the faces outside the region changed order"
    for k in ck:
        if _match(face_hashes(mi, [mi.col(k)], [], v2o[mi.cv], z(mi))[if_], face_hashes(mo, [mo.col(k)], [], mo.cv.astype(np.int64), z(mo))) is None:
            return "corner attribute %s changed outside the region" % parse(k)[0]
    for k in fkk:
        if _match(face_hashes(mi, [], [mi.col(k)], v2o[mi.cv], z(mi))[if_], face_hashes(mo, [], [mo.col(k)], mo.cv.astype(np.int64), z(mo))) is None:
            return "face attribute %s changed outside the region" % parse(k)[0]
    return "a face's edges outside the region changed"


def _global_fills(mi, mo):
    """Attributes the op set to one value over the whole output mesh where the input did not already have it
    (a selection flag Edit Mode leaves on): {key: value bytes}."""
    out = {}
    for k in mo.keys:
        name, domain, dtype = parse(k)
        if name in TOPOLOGY or k == POSITION_KEY or k == CUSTOM_NORMAL_KEY or not mo.n[domain]:
            continue
        c = mo.col(k)
        if not (c == c[:1]).all():
            continue
        if k in mi.arrays and mi.n[domain] and (mi.col(k) == c[:1]).all():
            continue
        out[k] = c[0]
    return out


# ---------------------------------------------------------------- piece

def extract(state_in, state_out, box_k, box_r):
    """The piece: what the op left of the K part (box_k) of one mesh, given that it may change things only inside
    box_r. Returns (meta, arrays); raises NotLocal."""
    mi, mo = Mesh(*state_in), Mesh(*state_out)
    ki, ko = set(mi.keys), set(mo.keys)
    extra = ko - ki
    # an attribute the op added (bmesh writes `sharp_edge`) or dropped: fine when it is the default (0) outside
    # the change box, where the other side has none
    added = sorted(extra - {CUSTOM_NORMAL_KEY} - set(SELECTION))
    dropped = sorted((ki - ko) - {CUSTOM_NORMAL_KEY} - set(SELECTION))
    if any(parse(k)[0] in TOPOLOGY for k in added + dropped):
        raise NotLocal("topology attributes")
    if mi.meta.get("materials") != mo.meta.get("materials") or mi.meta.get("vgroups") != mo.meta.get("vgroups"):
        raise NotLocal("materials or vertex groups")
    fills = _global_fills(mi, mo)
    skip = set(fills) | {CUSTOM_NORMAL_KEY} | set(added) | set(dropped) | set(SELECTION)
    vk, ek, fk, lk = masks(mi, box_k)
    nv_o, ne_o, nf_o, nl_o = (mo.n[d] for d in DOMAINS)

    # vertices: every one outside box_r is in the output, unchanged, in order
    va = ~inside(mi.co, box_r)
    pk = mi.plain_keys("POINT", skip)
    hv_in = _row_hash(_bytes_rows([mi.col(k) for k in pk], mi.n["POINT"]))
    hv_out = _row_hash(_bytes_rows([mo.col(k) for k in pk], nv_o))
    ia = np.nonzero(va)[0]
    img = _match(hv_in[ia], hv_out)
    if img is None:
        raise NotLocal(_why_vertices(mi, mo, ia, pk, box_r))
    v2o = np.full(mi.n["POINT"], -1, np.int64)
    v2o[ia] = img
    # edges whose vertices are all outside box_r
    ea = va[mi.ev].all(1) if len(mi.ev) else np.zeros(0, bool)
    ek_ = mi.plain_keys("EDGE", skip)
    ie = np.nonzero(ea)[0]
    he_in = _row_hash(_bytes_rows([mi.col(k)[ie] for k in ek_] + [v2o[mi.ev[ie]]], len(ie)))
    he_out = _row_hash(_bytes_rows([mo.col(k) for k in ek_] + [mo.ev.astype(np.int64)], ne_o))
    eimg = _match(he_in, he_out)
    if eimg is None:
        raise NotLocal("an edge outside the region changed")
    e2o = np.full(mi.n["EDGE"], -1, np.int64)
    e2o[ie] = eimg
    # faces whose vertices are all outside box_r
    fa = np.add.reduceat((~va[mi.cv]).astype(np.int32), mi.ps) == 0 if len(mi.ps) else np.zeros(0, bool)
    ck = mi.plain_keys("CORNER", skip)
    fkk = mi.plain_keys("FACE", skip)
    la = np.repeat(fa, mi.pt)
    cin = _row_hash(_bytes_rows([mi.col(k) for k in ck] + [v2o[mi.cv], e2o[mi.ce]], mi.n["CORNER"]))
    cout = _row_hash(_bytes_rows([mo.col(k) for k in ck] + [mo.cv.astype(np.int64), mo.ce.astype(np.int64)], nl_o))
    hf_in = _face_hash(cin, _row_hash(_bytes_rows([mi.col(k) for k in fkk], mi.n["FACE"])), mi.ps, mi.pt)
    hf_out = _face_hash(cout, _row_hash(_bytes_rows([mo.col(k) for k in fkk], nf_o)), mo.ps, mo.pt)
    if_ = np.nonzero(fa)[0]
    fimg = _match(hf_in[if_], hf_out)
    if fimg is None:
        raise NotLocal(_why_faces(mi, mo, if_, ck, fkk, v2o, e2o, box_r))
    f2o = np.full(mi.n["FACE"], -1, np.int64)
    f2o[if_] = fimg
    # exact check of what the hashes matched (corners of the matched faces)
    lin = np.nonzero(la)[0]
    lout = np.concatenate([np.arange(s, s + t) for s, t in zip(mo.ps[fimg].tolist(), mo.pt[fimg].tolist())]) \
        if len(fimg) else np.zeros(0, np.int64)
    if len(lin) != len(lout) or not (np.array_equal(v2o[mi.cv[lin]], mo.cv[lout]) and np.array_equal(e2o[mi.ce[lin]], mo.ce[lout])):
        raise NotLocal("corner refs outside the region differ")
    for k in ck:
        if not np.array_equal(mi.col(k)[lin], mo.col(k)[lout]):
            raise NotLocal("corner attribute %s outside the region differs" % k)
    for k in pk:
        if not np.array_equal(mi.col(k)[ia], mo.col(k)[img]):
            raise NotLocal("point attribute %s outside the region differs" % k)
    for keys, m_, idx in ((added, mo, {"POINT": img, "EDGE": eimg, "FACE": fimg, "CORNER": lout}),
                          (dropped, mi, {"POINT": ia, "EDGE": ie, "FACE": if_, "CORNER": lin})):
        for k in keys:
            if m_.col(k)[idx[parse(k)[1]]].any():
                raise NotLocal("attribute %s outside the region is not the default" % k)
    # custom normals outside K: unchanged, or rewritten everywhere (renormal; the caller checks how)
    renormal = False
    if CUSTOM_NORMAL_KEY in ko:
        if CUSTOM_NORMAL_KEY not in ki or not np.array_equal(mi.col(CUSTOM_NORMAL_KEY)[lin], mo.col(CUSTOM_NORMAL_KEY)[lout]):
            renormal = "rewritten"
    elif CUSTOM_NORMAL_KEY in ki:
        renormal = "clear"     # the op cleared the mesh's custom normals (the lake a water slab joins)

    # the piece = the output minus the images of non-K elements
    def piece_of(n_out, images):
        keep = np.ones(n_out, bool)
        keep[images] = False
        return np.nonzero(keep)[0]

    pv = piece_of(nv_o, v2o[~vk])
    pe = piece_of(ne_o, e2o[~ek])
    pf = piece_of(nf_o, f2o[~fk])
    if (v2o[~vk] < 0).any() or (e2o[~ek] < 0).any() or (f2o[~fk] < 0).any():
        raise NotLocal("an element outside K lies in the change box")   # box_r not inside box_k
    o2pv = np.full(nv_o, -1, np.int64)
    o2pv[pv] = np.arange(len(pv))
    o2pe = np.full(ne_o, -1, np.int64)
    o2pe[pe] = np.arange(len(pe))
    if not (inside(mo.co[pv], box_r) | np.isin(pv, v2o[vk & va])).all():
        raise NotLocal("a changed vertex lies outside the region")
    pl = np.concatenate([np.arange(s, s + t) for s, t in zip(mo.ps[pf].tolist(), mo.pt[pf].tolist())]) \
        if len(pf) else np.zeros(0, np.int64)
    p_ev = o2pv[mo.ev[pe]]
    p_cv, p_ce = o2pv[mo.cv[pl]], o2pe[mo.ce[pl]]
    if (p_ev < 0).any() or (p_cv < 0).any() or (p_ce < 0).any():
        raise NotLocal("a piece element refers outside K")
    arrays = {}
    for k in mo.keys:
        name, domain, _ = parse(k)
        if name == ".edge_verts":
            arrays[k] = p_ev.astype(np.int32).ravel()
        elif name == ".corner_vert":
            arrays[k] = p_cv.astype(np.int32)
        elif name == ".corner_edge":
            arrays[k] = p_ce.astype(np.int32)
        else:
            idx = {"POINT": pv, "EDGE": pe, "FACE": pf, "CORNER": pl}[domain]
            arrays[k] = np.ascontiguousarray(mo.col(k)[idx]).ravel()
    arrays["poly_total"] = mo.pt[pf].astype(np.int32)
    if "dv_vert" in state_out[1]:
        dv = state_out[1]["dv_vert"]
        s = o2pv[dv] >= 0
        arrays["dv_vert"] = o2pv[dv[s]].astype(np.int32)
        arrays["dv_group"] = state_out[1]["dv_group"][s]
        arrays["dv_weight"] = state_out[1]["dv_weight"][s]
    # K elements on K's edge (left unchanged) that the rest of the mesh refers to: K-relative id -> piece id
    vr, er = _rank(vk), _rank(ek)
    kv_anchor = np.nonzero(vk & (v2o >= 0))[0]
    ke_anchor = np.nonzero(ek & (e2o >= 0))[0]
    arrays["ringV"] = np.stack([vr[kv_anchor], o2pv[v2o[kv_anchor]]]).astype(np.int64)
    arrays["ringE"] = np.stack([er[ke_anchor], o2pe[e2o[ke_anchor]]]).astype(np.int64)
    if (arrays["ringV"][1] < 0).any() or (arrays["ringE"][1] < 0).any():
        raise NotLocal("a K element on K's edge left the piece")
    for i, (k, v) in enumerate(sorted(fills.items())):
        arrays["fill%d" % i] = np.asarray(v)
    meta = {"k": [int(vk.sum()), int(ek.sum()), int(fk.sum()), int(lk.sum())],
            "counts": [len(pv), len(pe), len(pf), len(pl)], "renormal": renormal,
            "fills": sorted(fills), "keys": mo.keys, "dropped": dropped + sorted((ki - ko) & set(SELECTION)),
            "dv": "dv_vert" in state_out[1]}
    return meta, arrays


def _ranges(starts, counts):
    """Concatenated aranges [s, s + c) (vectorised)."""
    counts = np.asarray(counts, np.int64)
    if not len(counts) or not counts.sum():
        return np.zeros(0, np.int64)
    ends = np.cumsum(counts)
    first = np.repeat(np.asarray(starts, np.int64) - (ends - counts), counts)
    return first + np.arange(ends[-1])


def _slots(kmask, n_piece):
    """Output order for one domain: (src_is_piece, src_index) per output element, and piece id -> output index."""
    rank = _rank(kmask)
    keep = ~kmask | (rank < n_piece)
    kept = np.nonzero(keep)[0]
    is_p = kmask[kept]
    src = np.where(is_p, rank[kept], kept)
    nk = int(kmask.sum())
    if n_piece > nk:
        is_p = np.concatenate([is_p, np.ones(n_piece - nk, bool)])
        src = np.concatenate([src, np.arange(nk, n_piece)])
    p2o = np.full(n_piece, -1, np.int64)
    p2o[src[is_p]] = np.nonzero(is_p)[0]
    i2o = np.full(len(kmask), -1, np.int64)
    i2o[src[~is_p]] = np.nonzero(~is_p)[0]
    return is_p, src, p2o, i2o


def transplant(state_in, box_k, piece):
    """The mesh `state_in` with its K part replaced by `piece` ((meta, arrays) from `extract` of a mesh whose K part
    equals this one's). Returns (meta, arrays, info): info["inputCorners"] = per output corner the input corner it
    came from (-1: from the piece), for the caller's custom-normal step."""
    pmeta, parr = piece
    mi = Mesh(*state_in)
    vk, ek, fk, lk = masks(mi, box_k)
    if [int(vk.sum()), int(ek.sum()), int(fk.sum()), int(lk.sum())] != pmeta["k"]:
        raise NotLocal("K differs")
    npv, npe, npf, npl = pmeta["counts"]
    v_is_p, v_src, pv2o, iv2o = _slots(vk, npv)
    e_is_p, e_src, pe2o, ie2o = _slots(ek, npe)
    f_is_p, f_src, pf2o, if2o = _slots(fk, npf)
    # input refs to K elements (only the ones on K's edge are referred to from outside K)
    kv2o = np.full(int(vk.sum()), -1, np.int64)
    kv2o[parr["ringV"][0]] = pv2o[parr["ringV"][1]]
    ke2o = np.full(int(ek.sum()), -1, np.int64)
    ke2o[parr["ringE"][0]] = pe2o[parr["ringE"][1]]
    vmap = np.where(vk, kv2o[np.maximum(_rank(vk), 0)], iv2o) if len(kv2o) else iv2o
    emap = np.where(ek, ke2o[np.maximum(_rank(ek), 0)], ie2o) if len(ke2o) else ie2o
    # corners: per output face, from the input or from the piece
    p_ps = np.concatenate([[0], np.cumsum(parr["poly_total"])[:-1]]).astype(np.int64) if npf else np.zeros(0, np.int64)
    p_pt = parr["poly_total"].astype(np.int64)
    f_counts = np.empty(len(f_src), np.int64)
    f_starts = np.empty(len(f_src), np.int64)
    f_counts[f_is_p], f_starts[f_is_p] = p_pt[f_src[f_is_p]], p_ps[f_src[f_is_p]]
    f_counts[~f_is_p], f_starts[~f_is_p] = mi.pt[f_src[~f_is_p]], mi.ps[f_src[~f_is_p]]
    c_is_p = np.repeat(f_is_p, f_counts)
    c_src = _ranges(f_starts, f_counts)
    nl_out = len(c_src)
    arrays = {}
    p_keys = set(pmeta["keys"])
    fills = {k: parr["fill%d" % i] for i, k in enumerate(pmeta["fills"])}
    n_out = {"POINT": len(v_src), "EDGE": len(e_src), "FACE": len(f_src), "CORNER": nl_out}
    sel = {"POINT": (v_is_p, v_src), "EDGE": (e_is_p, e_src), "FACE": (f_is_p, f_src), "CORNER": (c_is_p, c_src)}
    for k in pmeta["keys"]:
        name, domain, dtype = parse(k)
        w = WIDTH[dtype]
        is_p, src = sel[domain]
        pc = parr[k].reshape(-1, w) if k in parr else None
        if name == ".edge_verts":
            out = np.empty((n_out["EDGE"], 2), np.int64)
            out[~is_p] = vmap[mi.ev[src[~is_p]]]
            out[is_p] = pv2o[pc[src[is_p]]]
        elif name == ".corner_vert":
            out = np.empty((nl_out, 1), np.int64)
            out[~is_p, 0] = vmap[mi.cv[src[~is_p]]]
            out[is_p, 0] = pv2o[pc[src[is_p], 0]]
        elif name == ".corner_edge":
            out = np.empty((nl_out, 1), np.int64)
            out[~is_p, 0] = emap[mi.ce[src[~is_p]]]
            out[is_p, 0] = pe2o[pc[src[is_p], 0]]
        else:
            ic = mi.col(k) if k in mi.arrays else None
            dt = pc.dtype if pc is not None else ic.dtype
            out = np.zeros((n_out[domain], w), dt)
            if ic is not None:
                out[~is_p] = ic[src[~is_p]]
            out[is_p] = pc[src[is_p]]
            if k in fills:
                out[~is_p] = fills[k]
        if name in TOPOLOGY:
            if (out < 0).any():
                raise NotLocal("a reference into K has no piece element")
            out = out.astype(np.int32)
        arrays[k] = np.ascontiguousarray(out).ravel()
    for k in mi.keys:
        if k in p_keys or k in pmeta["dropped"] or (k == CUSTOM_NORMAL_KEY and pmeta["renormal"] == "clear"):
            continue
        if mi.col(k).any():   # one the op dropped, which this mesh has only as the default: as good as absent
            raise NotLocal("attribute %s not in the piece" % k)
    ps = np.concatenate([[0], np.cumsum(f_counts)[:-1]]).astype(np.int32) if len(f_counts) else np.zeros(0, np.int32)
    arrays["poly_start"] = ps
    if pmeta.get("dv") or "dv_vert" in state_in[1]:
        dvi = state_in[1].get("dv_vert", np.zeros(0, np.int32))
        keep = ~vk[dvi]
        verts = np.concatenate([iv2o[dvi[keep]], pv2o[parr["dv_vert"]] if "dv_vert" in parr else np.zeros(0, np.int64)])
        groups = np.concatenate([state_in[1].get("dv_group", np.zeros(0, np.int32))[keep], parr.get("dv_group", np.zeros(0, np.int32))])
        weights = np.concatenate([state_in[1].get("dv_weight", np.zeros(0, np.float32))[keep], parr.get("dv_weight", np.zeros(0, np.float32))])
        order = np.argsort(verts, kind="stable")
        if len(verts):
            arrays["dv_vert"] = verts[order].astype(np.int32)
            arrays["dv_group"] = groups[order].astype(np.int32)
            arrays["dv_weight"] = weights[order].astype(np.float32)
    meta = dict(state_in[0], counts=[n_out["POINT"], n_out["EDGE"], n_out["FACE"], nl_out])
    input_corners = np.where(c_is_p, -1, c_src)
    # per output vertex the input vertex it is (outside K, or a K vertex on K's edge), else -1
    input_vertex = np.full(len(v_src), -1, np.int64)
    input_vertex[~v_is_p] = v_src[~v_is_p]
    kpos = np.nonzero(vk)[0]
    input_vertex[pv2o[parr["ringV"][1]]] = kpos[parr["ringV"][0]]
    return meta, arrays, {"inputCorners": input_corners, "inputVertex": input_vertex, "renormal": pmeta["renormal"],
                          "pieceCorners": np.nonzero(c_is_p)[0]}


# ---------------------------------------------------------------- order-free comparison

def canonical_hash(meta, arrays, skip=()):
    """sha1 of a mesh state that does not depend on the order of its elements or a face's start corner: the
    sorted faces (each a ring of corner rows - the corner's vertex attributes and its own, from the smallest),
    the sorted edges (endpoint rows + attributes), the sorted vertex rows, materials and vertex groups."""
    m = Mesh(meta, arrays)
    nv, ne, nf, nl = (m.n[d] for d in DOMAINS)
    pk = m.plain_keys("POINT", skip)
    vrows = _bytes_rows([m.col(k) for k in pk], nv)
    vh = _row_hash(vrows)
    # corners: vertex row hash + corner attributes
    crow = _bytes_rows([vh[m.cv].reshape(-1, 1)] + [m.col(k) for k in m.plain_keys("CORNER", skip)], nl)
    ch = _row_hash(crow)
    # rotate every face to start at its smallest corner hash
    h = hashlib.sha1(json.dumps([meta.get("materials"), meta.get("vgroups")]).encode())
    if nf:
        local = np.arange(nl) - np.repeat(m.ps, m.pt)
        first = np.minimum.reduceat(ch, m.ps)
        is_min = ch == np.repeat(first, m.pt)
        # first occurrence of the minimum per face
        cand = np.where(is_min, local, np.iinfo(np.int64).max)
        off = np.minimum.reduceat(cand, m.ps)
        rot = (local + np.repeat(off, m.pt)) % np.repeat(m.pt, m.pt) + np.repeat(m.ps, m.pt)
        ch_rot = ch[rot]
        fattr = _row_hash(_bytes_rows([m.col(k) for k in m.plain_keys("FACE", skip)], nf))
        fh = _face_hash(ch_rot, fattr, m.ps, m.pt)
        h.update(np.sort(fh).tobytes())
    if ne:
        a, b = vh[m.ev[:, 0]], vh[m.ev[:, 1]]
        lo, hi = np.minimum(a, b), np.maximum(a, b)
        er = _row_hash(_bytes_rows([lo.reshape(-1, 1), hi.reshape(-1, 1)] + [m.col(k) for k in m.plain_keys("EDGE", skip)], ne))
        h.update(np.sort(er).tobytes())
    h.update(np.sort(vh).tobytes())
    if "dv_vert" in arrays:
        dv = _row_hash(_bytes_rows([vh[arrays["dv_vert"]].reshape(-1, 1), arrays["dv_group"].reshape(-1, 1),
                                    arrays["dv_weight"].reshape(-1, 1)], len(arrays["dv_vert"])))
        h.update(np.sort(dv).tobytes())
    return h.hexdigest()
