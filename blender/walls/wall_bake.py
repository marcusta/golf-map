"""Stone-wall bake, the Blender side. Headless Blender 4.5.

A stone wall in Unity is hundreds of separate boulder instances (~10 models, ~440 triangles each) that
overlap on purpose and sit partly buried in the ground and in the bank behind them. Unity exports the
placed stones (golfmap-wallbake-in-v1); this script merges them into chunks ~chunkM long along the wall
with the hidden geometry removed, plus LOD meshes and a simplified collider per chunk, and writes
golfmap-wallbake-out-v1 (<wall>.out.json + <wall>.out.bin) for Unity to import.

Frame: Unity world coordinates kept verbatim (metres, Y up, no axis swap). Triangle index order is
Unity's: cross(b - a, c - a) of a front face points out of the stone; the output keeps that.

  1. Stones: each model mesh moved by its local->world matrix (triangles reversed when det < 0, so they
     still face out). Vertices that coincide (Unity splits them at UV seams) are welded per stone, so the
     decimation sees one closed surface; normals and UVs stay per face corner.
  2. Cull triangles, kept whole (no cutting), in this order (each triangle counted once):
       a. below ground: all 3 vertices more than groundEpsM below the bilinear ground height;
       b. inside another stone: all 3 vertices at least insideEpsM inside the same other stone
          (nearest point on that stone + the sign against its face normal; stones are closed meshes);
       c. hidden (cullHidden): every sample point (centroid, and the corners pulled 10% toward it, 1 mm
          out along the face normal) has every one of `rays` Fibonacci-hemisphere rays blocked within
          rayM by all stones (pre-cull) + the ground mesh. One BVH for everything; a triangle stops at
          its first escaping ray, so only hidden triangles pay the full cost.
  3. Chunks: n = max(1, round((maxAlong - minAlong) / chunkM)) equal bins over the stones' `along`
     (Python round: halves go to even, like C# Math.Round); each stone goes whole into its bin. Bins
     with no surviving triangle are skipped and the ids renumbered contiguous (chunk-00, chunk-01, ...).
  4. LODs: LOD0 at ratio 1.0 is the culled mesh with the source normals and UVs verbatim; ratio < 1 is
     Blender's Decimate (Collapse, triangulate) of the culled mesh with smooth vertex normals.
  5. Collider: the colliderLod geometry, all submeshes merged, positions welded, triangles only.
  6. Pivot: centre of the chunk's bounds in x/z, its min y; all output positions are pivot-relative.
Output vertices are split per (position, normal, uv), one submesh per material index (ascending).

  blender.exe -b --factory-startup --python-exit-code 1 --python blender/walls/wall_bake.py --
      --in <wall>.in.json --out <wall>.out.json
Test: blender/walls/wall_bake_test.py (same way, no arguments).
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

FORMAT_IN = "golfmap-wallbake-in-v1"
FORMAT_OUT = "golfmap-wallbake-out-v1"
DEFAULTS = {"chunkM": 8.0, "lods": [1.0, 0.35, 0.1], "colliderLod": 1, "groundEpsM": 0.02,
            "insideEpsM": 0.01, "cullHidden": True, "rays": 48, "rayM": 20.0}
WELD_M = 1e-5            # Unity's seam-split vertices are the same point to well within this
SAMPLE_OFF_M = 0.001     # ray sample points sit this far out along the face normal
RAY_BATCH = 4096         # triangles per numpy batch of sample points / ray directions


class BakeError(Exception):
    """Bad input: reported as one line and a non-zero exit."""


def need(ok, msg):
    if not ok:
        raise BakeError(msg)


# ---------------------------------------------------------------- input

def read_input(path):
    need(os.path.isfile(path), "input not found: " + path)
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except ValueError as e:
        raise BakeError("input is not JSON: {} ({})".format(path, e))
    need(isinstance(doc, dict) and doc.get("format") == FORMAT_IN,
         "input format is not " + FORMAT_IN + ": " + path)
    for k, t in (("models", dict), ("materials", list), ("stones", list)):
        need(isinstance(doc.get(k), t), "input lacks '{}' ({})".format(k, t.__name__))
    need(len(doc["stones"]) > 0, "input has no stones")
    s = dict(DEFAULTS)
    s.update(doc.get("settings") or {})
    need(float(s["chunkM"]) > 0, "settings.chunkM must be > 0")
    need(isinstance(s["lods"], list) and len(s["lods"]) > 0 and all(0 < float(r) <= 1 for r in s["lods"]),
         "settings.lods must be a non-empty list of ratios in (0, 1]")
    need(0 <= int(s["colliderLod"]) < len(s["lods"]), "settings.colliderLod is not a LOD index")
    need(int(s["rays"]) > 0 and float(s["rayM"]) > 0, "settings.rays and rayM must be > 0")
    doc["settings"] = s
    return doc


class Model:
    """One source mesh: welded positions, triangles as welded ids plus the source ids for normals/UVs."""

    def __init__(self, key, m):
        where = "model '" + key + "'"
        v = np.asarray(m.get("vertices", []), np.float64)
        need(v.size > 0 and v.size % 3 == 0, where + ": vertices must be a non-empty multiple of 3")
        v = v.reshape(-1, 3)
        nv = len(v)
        n = np.asarray(m.get("normals", []), np.float64)
        need(n.size == v.size, where + ": normals count differs from vertices")
        uv = np.asarray(m.get("uv") or [], np.float64)
        need(uv.size in (0, 2 * nv), where + ": uv count differs from vertices")
        self.normals = n.reshape(-1, 3)
        self.uv = uv.reshape(-1, 2) if uv.size else np.zeros((nv, 2))
        subs = m.get("submeshes")
        need(isinstance(subs, list) and len(subs) > 0, where + ": no submeshes")
        tris, sub = [], []
        for i, s in enumerate(subs):
            a = np.asarray(s, np.int64)
            need(a.size % 3 == 0, "{}: submesh {} index count is not a multiple of 3".format(where, i))
            need(a.size == 0 or (a.min() >= 0 and a.max() < nv), "{}: submesh {} index out of range".format(where, i))
            tris.append(a.reshape(-1, 3))
            sub.append(np.full(len(a) // 3, i, np.int64))
        self.nsub = len(subs)
        src = np.concatenate(tris)
        sub = np.concatenate(sub)
        # weld: quantised positions -> one id per point (first source vertex gives the position)
        q = np.round(v / WELD_M).astype(np.int64)
        _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
        inv = inv.reshape(-1)
        self.pos = v[first]
        w = inv[src]
        ok = (w[:, 0] != w[:, 1]) & (w[:, 1] != w[:, 2]) & (w[:, 0] != w[:, 2])
        self.tris_in = len(src)
        self.degenerate = int((~ok).sum())   # collapsed by the weld (zero-area slivers)
        self.tri = w[ok]
        self.src = src[ok]
        self.sub = sub[ok]


class Ground:
    """The heightfield over x/z (Y up); NaN = not sampled."""

    def __init__(self, g):
        self.ok = bool(g)
        if not self.ok:
            return
        self.x0, self.z0, self.cell = float(g["x0"]), float(g["z0"]), float(g["cell"])
        self.nx, self.nz = int(g["nx"]), int(g["nz"])
        need(self.cell > 0 and self.nx > 0 and self.nz > 0, "ground: cell, nx, nz must be > 0")
        h = g.get("heights", [])
        need(len(h) == self.nx * self.nz, "ground: heights must have nx*nz values")
        self.h = np.array([np.nan if y is None else y for y in h], np.float64).reshape(self.nz, self.nx)
        self.ok = self.nx > 1 and self.nz > 1

    def sample(self, x, z):
        """Bilinear ground y at x/z; NaN outside the grid or next to an unsampled point."""
        out = np.full(len(x), np.nan)
        if not self.ok:
            return out
        fx = (x - self.x0) / self.cell
        fz = (z - self.z0) / self.cell
        inside = (fx >= 0) & (fx <= self.nx - 1) & (fz >= 0) & (fz <= self.nz - 1)
        fx, fz = fx[inside], fz[inside]
        ix = np.clip(np.floor(fx).astype(np.int64), 0, self.nx - 2)
        iz = np.clip(np.floor(fz).astype(np.int64), 0, self.nz - 2)
        tx, tz = fx - ix, fz - iz
        h = self.h
        out[inside] = ((h[iz, ix] * (1 - tx) + h[iz, ix + 1] * tx) * (1 - tz)
                       + (h[iz + 1, ix] * (1 - tx) + h[iz + 1, ix + 1] * tx) * tz)
        return out

    def mesh(self, lo, hi):
        """Triangles of every cell with 4 known corners inside the x/z box lo..hi -> (verts, tris)."""
        if not self.ok:
            return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
        ix0 = max(0, int(math.floor((lo[0] - self.x0) / self.cell)))
        iz0 = max(0, int(math.floor((lo[1] - self.z0) / self.cell)))
        ix1 = min(self.nx - 1, int(math.ceil((hi[0] - self.x0) / self.cell)))
        iz1 = min(self.nz - 1, int(math.ceil((hi[1] - self.z0) / self.cell)))
        if ix1 <= ix0 or iz1 <= iz0:
            return np.zeros((0, 3)), np.zeros((0, 3), np.int64)
        sub = self.h[iz0:iz1 + 1, ix0:ix1 + 1]
        w = sub.shape[1]
        fin = np.isfinite(sub)
        cell = fin[:-1, :-1] & fin[:-1, 1:] & fin[1:, :-1] & fin[1:, 1:]
        cz, cx = np.nonzero(cell)
        a = cz * w + cx
        b, c, d = a + 1, a + w + 1, a + w
        tris = np.concatenate([np.stack([a, d, c], 1), np.stack([a, c, b], 1)])   # normals up (+Y)
        used, tris = np.unique(tris, return_inverse=True)
        gz, gx = np.divmod(used, w)
        verts = np.stack([self.x0 + (gx + ix0) * self.cell, sub.reshape(-1)[used],
                          self.z0 + (gz + iz0) * self.cell], 1)
        return verts, tris.reshape(-1, 3)


class Wall:
    """All stones in world space. P: welded positions; T: triangles (ids into P), contiguous per stone;
    CN/CU: per-corner normals/UVs; TM: material index; TS: stone index."""

    def __init__(self, doc):
        models = {k: Model(k, m) for k, m in doc["models"].items()}
        nmat = len(doc["materials"])
        P, T, CN, CU, TM, TS, vr, tr = [], [], [], [], [], [], [], []
        self.tris_in = self.degenerate = 0
        nv = nt = 0
        self.along = np.zeros(len(doc["stones"]))
        for si, st in enumerate(doc["stones"]):
            where = "stone {}".format(si)
            md = models.get(st.get("model"))
            need(md is not None, "{}: unknown model {!r}".format(where, st.get("model")))
            mats = st.get("materials")
            need(isinstance(mats, list) and len(mats) == md.nsub,
                 "{}: needs one material index per submesh ({})".format(where, md.nsub))
            need(all(isinstance(i, int) and 0 <= i < nmat for i in mats), where + ": material index out of range")
            mtx = st.get("matrix")
            need(isinstance(mtx, list) and len(mtx) == 16, where + ": matrix must be 16 floats")
            need(isinstance(st.get("along"), (int, float)), where + ": no 'along'")
            self.along[si] = float(st["along"])
            M = np.asarray(mtx, np.float64).reshape(4, 4)    # row-major, Unity m00 m01 m02 m03 m10 ...
            A, t = M[:3, :3], M[:3, 3]
            det = float(np.linalg.det(A))
            need(abs(det) > 1e-12 and np.all(np.isfinite(M)), where + ": matrix is singular or not finite")
            pos = md.pos @ A.T + t
            nrm = md.normals @ np.linalg.inv(A)              # inverse transpose: n' = (A^-1)^T n
            ln = np.linalg.norm(nrm, axis=1, keepdims=True)
            nrm = nrm / np.where(ln > 0, ln, 1.0)
            order = [0, 2, 1] if det < 0 else [0, 1, 2]     # a mirror flips the winding: turn it back
            tri, src = md.tri[:, order], md.src[:, order]
            P.append(pos)
            T.append(tri + nv)
            CN.append(nrm[src])
            CU.append(md.uv[src])
            TM.append(np.asarray(mats, np.int64)[md.sub])
            TS.append(np.full(len(tri), si, np.int64))
            vr.append((nv, nv + len(pos)))
            tr.append((nt, nt + len(tri)))
            nv += len(pos)
            nt += len(tri)
            self.tris_in += md.tris_in
            self.degenerate += md.degenerate
        self.P = np.concatenate(P)
        self.T = np.concatenate(T)
        self.CN = np.concatenate(CN)
        self.CU = np.concatenate(CU)
        self.TM = np.concatenate(TM)
        self.TS = np.concatenate(TS)
        self.vrange = vr
        self.trange = tr
        self.lo = np.array([self.P[a:b].min(0) for a, b in vr])
        self.hi = np.array([self.P[a:b].max(0) for a, b in vr])
        # BVHs are float32: build them around the wall's own origin (sub-mm even kilometres out)
        self.origin = np.round((self.lo.min(0) + self.hi.max(0)) / 2)
        self.PL = self.P - self.origin


# ---------------------------------------------------------------- culling

def cull_below_ground(wall, ground, eps):
    g = ground.sample(wall.P[:, 0], wall.P[:, 2])
    below = wall.P[:, 1] < g - eps                      # NaN ground -> False
    return below[wall.T].all(1)


def cull_inside(wall, alive, eps):
    """Triangles with all 3 vertices >= eps inside one other stone (pairs with overlapping bounds)."""
    out = np.zeros(len(wall.T), bool)
    bvhs = {}

    def bvh(j):
        if j not in bvhs:
            (va, vb), (ta, tb) = wall.vrange[j], wall.trange[j]
            bvhs[j] = BVHTree.FromPolygons(wall.PL[va:vb].tolist(), (wall.T[ta:tb] - va).tolist(), epsilon=0.0)
        return bvhs[j]

    lo, hi = wall.lo, wall.hi
    for i, (ta, tb) in enumerate(wall.trange):
        al = alive[ta:tb].copy()
        if not al.any():
            continue
        others = np.nonzero(np.all(lo[i] <= hi, 1) & np.all(hi[i] >= lo, 1))[0]
        va, vb = wall.vrange[i]
        pi = wall.PL[va:vb]
        tri = wall.T[ta:tb] - va
        for j in others.tolist():
            if j == i or not al.any():
                continue
            # a vertex >= eps inside stone j lies inside j's bounds shrunk by eps
            inb = np.all((pi > lo[j] - wall.origin + eps) & (pi < hi[j] - wall.origin - eps), 1)
            cand = al & inb[tri].all(1)
            if not cand.any():
                continue
            verts = np.unique(tri[cand])
            find = bvh(j).find_nearest
            flag = np.zeros(len(pi), bool)
            for v, p in zip(verts.tolist(), pi[verts].tolist()):
                loc, nrm, _, dist = find(p)
                flag[v] = (loc is not None and dist >= eps
                           and (p[0] - loc[0]) * nrm[0] + (p[1] - loc[1]) * nrm[1] + (p[2] - loc[2]) * nrm[2] < 0)
            gone = cand & flag[tri].all(1)
            al &= ~gone
            out[ta:tb] |= gone
    return out


def hemisphere(n):
    """n deterministic Fibonacci directions on the +Z hemisphere, from the pole down to the horizon."""
    i = np.arange(n) + 0.5
    z = 1.0 - i / n
    r = np.sqrt(1.0 - z * z)
    phi = i * math.pi * (3.0 - math.sqrt(5.0))
    return np.stack([r * np.cos(phi), r * np.sin(phi), z], 1)


def ray_frames(nrm, H):
    """Per normal: the rotation taking the +Z hemisphere H onto it (columns tangent, bitangent, normal),
    and the order of H's directions with the most upward (+Y) world direction first. A visible face
    mostly escapes upward, so it stops after a ray or two; the order cannot change a result (hidden =
    every ray blocked), only how soon a visible face is found."""
    helper = np.where((np.abs(nrm[:, 0]) < 0.9)[:, None], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0])
    tx = np.cross(helper, nrm)
    tx /= np.maximum(np.linalg.norm(tx, axis=1), 1e-12)[:, None]
    ty = np.cross(nrm, tx)
    rot = np.stack([tx, ty, nrm], 2)                       # (k, 3, 3), world = rot @ local
    order = np.argsort(-(rot[:, 1, :] @ H.T), axis=1, kind="stable")
    return rot, order


def cull_hidden(wall, ground, alive, rays, ray_m):
    """Triangles every sample point of which (the centroid + the 3 corners pulled 10% toward it, all 1 mm
    out along the face normal) sees nothing but stone or ground in every hemisphere direction.
    Each ray costs ~1.7 us in mathutils and a hidden triangle needs all 4 * `rays` of them, so the loop
    builds only the directions it casts (rotated lazily in mathutils) and stops at the first escape."""
    out = np.zeros(len(wall.T), bool)
    cand = np.nonzero(alive)[0]
    if len(cand) == 0:
        return out
    lo = wall.P.min(0)
    hi = wall.P.max(0)
    origin, P = wall.origin, wall.PL
    gv, gt = ground.mesh((lo[0] - ray_m, lo[2] - ray_m), (hi[0] + ray_m, hi[2] + ray_m))
    verts = np.concatenate([P, gv - origin]).tolist()
    tris = np.concatenate([wall.T, gt + len(P)]).tolist()
    ray = BVHTree.FromPolygons(verts, tris, epsilon=0.0).ray_cast
    H = hemisphere(rays)
    Hv = [Vector(h) for h in H.tolist()]
    for s in range(0, len(cand), RAY_BATCH):
        ids = cand[s:s + RAY_BATCH]
        p = P[wall.T[ids]]                                        # (k, 3, 3)
        nrm = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        ln = np.linalg.norm(nrm, axis=1)
        good = ln > 1e-12                                         # zero area: leave it to the decimation
        nrm = nrm / np.where(good, ln, 1.0)[:, None]
        cen = p.mean(1)
        smp = np.concatenate([cen[:, None], p + 0.1 * (cen[:, None] - p)], 1) + SAMPLE_OFF_M * nrm[:, None]
        rot, order = ray_frames(nrm, H)
        for k in np.nonzero(good)[0].tolist():
            R = Matrix(rot[k].tolist())
            pts = smp[k].tolist()
            hidden = True
            for j in order[k].tolist():
                d = R @ Hv[j]
                for pt in pts:
                    if ray(pt, d, ray_m)[0] is None:
                        hidden = False
                        break
                if not hidden:
                    break
            out[ids[k]] = hidden
    return out


# ---------------------------------------------------------------- chunks, LODs, collider

def chunk_bins(along, chunk_m):
    """Bin per stone and the bins' along ranges: n = max(1, round(span / chunkM)) equal bins."""
    a0, a1 = float(along.min()), float(along.max())
    n = max(1, int(round((a1 - a0) / chunk_m)))
    w = (a1 - a0) / n
    if w <= 0:
        return np.zeros(len(along), np.int64), [(a0, a1)]
    b = np.clip(np.floor((along - a0) / w).astype(np.int64), 0, n - 1)
    return b, [(a0 + i * w, a0 + (i + 1) * w) for i in range(n)]


def pack(pos_c, nrm_c, uv_c, mats):
    """Corner arrays (N,3,*) -> vertices split per (position, normal, uv) as float32 rows of 8, and
    [(material, int32 indices)] with one submesh per material, ascending, triangle order kept inside."""
    order = np.argsort(mats, kind="stable")
    rows = np.concatenate([pos_c, nrm_c, uv_c], 2)[order].reshape(-1, 8).astype(np.float32) + np.float32(0)
    verts, inv = np.unique(rows, axis=0, return_inverse=True)
    idx = inv.reshape(-1).astype(np.int32)
    m = mats[order]
    subs = []
    for mat in np.unique(m).tolist():
        sel = np.nonzero(m == mat)[0]
        subs.append((int(mat), idx.reshape(-1, 3)[sel].reshape(-1)))
    return verts, subs


def blender_mesh(name, pos, tris, uv_c, mats):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(pos))
    me.vertices.foreach_set("co", pos.astype(np.float32).ravel())
    nt = len(tris)
    me.loops.add(3 * nt)
    me.loops.foreach_set("vertex_index", tris.astype(np.int32).ravel())
    me.polygons.add(nt)
    me.polygons.foreach_set("loop_start", np.arange(0, 3 * nt, 3, dtype=np.int32))
    me.polygons.foreach_set("material_index", mats.astype(np.int32))
    uvl = me.uv_layers.new(name="UVMap")
    uvl.data.foreach_set("uv", uv_c.astype(np.float32).ravel())
    for _ in range(int(mats.max()) + 1):
        me.materials.append(None)        # slots, so the material indices survive evaluation
    me.update(calc_edges=True)
    return me


def decimated(ob, mod, ratio):
    """Evaluate the Decimate modifier at `ratio` -> corner arrays (pos, smooth normal, uv) + local mats."""
    mod.ratio = ratio
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = ob.evaluated_get(dg)
    m = ev.to_mesh()
    try:
        nv = len(m.vertices)
        co = np.empty(nv * 3, np.float32)
        m.vertices.foreach_get("co", co)
        vn = np.empty(nv * 3, np.float32)
        m.vertex_normals.foreach_get("vector", vn)
        m.calc_loop_triangles()
        nt = len(m.loop_triangles)
        lv = np.empty(nt * 3, np.int32)
        ll = np.empty(nt * 3, np.int32)
        lm = np.empty(nt, np.int32)
        m.loop_triangles.foreach_get("vertices", lv)
        m.loop_triangles.foreach_get("loops", ll)
        m.loop_triangles.foreach_get("material_index", lm)
        uv = np.zeros(len(m.loops) * 2, np.float32)
        if m.uv_layers.active is not None:
            m.uv_layers.active.data.foreach_get("uv", uv)
    finally:
        ev.to_mesh_clear()
    co, vn, uv = co.reshape(-1, 3), vn.reshape(-1, 3), uv.reshape(-1, 2)
    lv, ll = lv.reshape(-1, 3), ll.reshape(-1, 3)
    return co[lv].astype(np.float64), vn[lv].astype(np.float64), uv[ll].astype(np.float64), lm


def collider(verts, subs):
    """All submeshes merged, positions welded (exact float32), degenerate triangles dropped."""
    idx = np.concatenate([i for _, i in subs]).reshape(-1, 3)
    pos, inv = np.unique(verts[:, :3], axis=0, return_inverse=True)
    t = inv.reshape(-1)[idx]
    t = t[(t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])]
    return pos, t.reshape(-1).astype(np.int32)


def build_chunk(wall, tri_ids, lods, collider_lod, name):
    """One chunk: pivot, LOD meshes (verts, subs) per ratio, collider (pos, idx)."""
    tri = wall.T[tri_ids]
    used, local = np.unique(tri, return_inverse=True)
    local = local.reshape(-1, 3)
    wpos = wall.P[used]
    lo, hi = wpos.min(0), wpos.max(0)
    pivot = np.round([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], 6)
    pos = wpos - pivot
    mats = wall.TM[tri_ids]
    nrm_c, uv_c = wall.CN[tri_ids], wall.CU[tri_ids]
    out = []
    ob = me = None
    try:
        for ratio in lods:
            if ratio >= 1.0:
                out.append(pack(pos[local], nrm_c, uv_c, mats))
                continue
            if ob is None:
                umat, lmat = np.unique(mats, return_inverse=True)
                me = blender_mesh(name, pos, local, uv_c.reshape(-1, 2), lmat.reshape(-1))
                ob = bpy.data.objects.new(name, me)
                bpy.context.scene.collection.objects.link(ob)
                mod = ob.modifiers.new("decimate", "DECIMATE")
                mod.decimate_type = "COLLAPSE"
                mod.use_collapse_triangulate = True
            p, n, u, lm = decimated(ob, mod, float(ratio))
            out.append(pack(p, n, u, umat[lm]))
    finally:
        if ob is not None:
            bpy.data.objects.remove(ob)
        if me is not None:
            bpy.data.meshes.remove(me)
    return pivot, out, collider(*out[collider_lod])


# ---------------------------------------------------------------- main

def bake(inp, out_path):
    t0 = time.perf_counter()
    doc = read_input(inp)
    s = doc["settings"]
    ground = Ground(doc.get("ground"))
    wall = Wall(doc)
    t1 = time.perf_counter()

    below = cull_below_ground(wall, ground, float(s["groundEpsM"]))
    tb = time.perf_counter()
    inside = cull_inside(wall, ~below, float(s["insideEpsM"]))
    alive = ~below & ~inside
    tc = time.perf_counter()
    hidden = (cull_hidden(wall, ground, alive, int(s["rays"]), float(s["rayM"])) if s["cullHidden"]
              else np.zeros(len(alive), bool))
    alive &= ~hidden
    t2 = time.perf_counter()

    lods = [float(r) for r in s["lods"]]
    col_lod = int(s["colliderLod"])
    bins, ranges = chunk_bins(wall.along, float(s["chunkM"]))
    tri_bin = bins[wall.TS]
    chunks = []
    for b, rng in enumerate(ranges):
        ids = np.nonzero(alive & (tri_bin == b))[0]
        if len(ids) == 0:
            continue
        cid = "chunk-{:02d}".format(len(chunks))
        pivot, lod_meshes, col = build_chunk(wall, ids, lods, col_lod, cid)
        chunks.append({"id": cid, "pivot": pivot, "stones": int((bins == b).sum()), "along": rng,
                       "lods": lod_meshes, "collider": col})
    t3 = time.perf_counter()

    bin_path = out_path[:-5] + ".bin" if out_path.lower().endswith(".json") else out_path + ".bin"
    parts, off = [], 0
    out_chunks = []
    tris_lod = [0] * len(lods)
    col_tris = 0
    for c in chunks:
        lod_rec = []
        for k, (verts, subs) in enumerate(c["lods"]):
            v = verts.astype("<f4")
            rec = [v[:, 0:3].tobytes(), v[:, 3:6].tobytes(), v[:, 6:8].tobytes()]
            rec += [i.astype("<i4").tobytes() for _, i in subs]
            lod_rec.append({"offset": off, "vertexCount": len(verts),
                            "submeshes": [{"material": m, "indexCount": len(i)} for m, i in subs]})
            tris_lod[k] += sum(len(i) for _, i in subs) // 3
            parts += rec
            off += sum(len(r) for r in rec)
        cpos, cidx = c["collider"]
        rec = [cpos.astype("<f4").tobytes(), cidx.astype("<i4").tobytes()]
        col_rec = {"offset": off, "vertexCount": len(cpos), "indexCount": len(cidx)}
        col_tris += len(cidx) // 3
        parts += rec
        off += sum(len(r) for r in rec)
        out_chunks.append({"id": c["id"], "pivot": [float(v) for v in c["pivot"]], "stones": c["stones"],
                           "along": [round(c["along"][0], 6), round(c["along"][1], 6)],
                           "lods": lod_rec, "collider": col_rec})
    with open(bin_path, "wb") as f:
        f.write(b"".join(parts))
    stats = {"stones": len(doc["stones"]), "trisIn": wall.tris_in, "degenerate": wall.degenerate,
             "culledGround": int(below.sum()), "culledInside": int(inside.sum()),
             "culledHidden": int(hidden.sum()), "trisLod": tris_lod, "colliderTris": col_tris,
             "seconds": {"load": round(t1 - t0, 3), "cull": round(t2 - t1, 3), "lods": round(t3 - t2, 3),
                         "write": 0.0, "total": 0.0, "cullGround": round(tb - t1, 3),
                         "cullInside": round(tc - tb, 3), "cullHidden": round(t2 - tc, 3)}}
    out = {"format": FORMAT_OUT, "wall": doc.get("wall", ""), "bin": os.path.basename(bin_path),
           "materials": doc["materials"], "stats": stats, "chunks": out_chunks}
    t5 = time.perf_counter()
    stats["seconds"]["write"] = round(t5 - t3, 3)
    stats["seconds"]["total"] = round(t5 - t0, 3)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    return out


def main(argv=None):
    if argv is None:
        argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="wall_bake.py", description="Bake a stone wall into chunks + LODs + collider.")
    ap.add_argument("--in", dest="inp", required=True, help="<wall>.in.json (golfmap-wallbake-in-v1)")
    ap.add_argument("--out", required=True, help="<wall>.out.json; the .bin goes next to it")
    a = ap.parse_args(argv)
    out = bake(a.inp, a.out)
    s = out["stats"]
    print("wall_bake: {} - {} stones, {} tris in, culled ground {} inside {} hidden {}, {} chunks, LOD tris {}, "
          "collider {} tris, {:.1f} s -> {}".format(
              out["wall"], s["stones"], s["trisIn"], s["culledGround"], s["culledInside"], s["culledHidden"],
              len(out["chunks"]), s["trisLod"], s["colliderTris"], s["seconds"]["total"], a.out))
    return out


if __name__ == "__main__":
    try:
        main()
    except BakeError as e:
        print("wall_bake: error: " + str(e), file=sys.stderr)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(2)
