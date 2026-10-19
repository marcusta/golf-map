"""Headless test of wall_bake.py on synthetic walls (temp dir, nothing in the repo is touched).

Small case: a ground heightfield (flat in front, a bank behind, an unsampled strip at the east end) with
  - a row of 10 overlapping, partly buried UV-spheres (2 materials, one mirrored with det < 0),
  - a big cube with a small sphere wholly inside it,
  - a lone cube resting 5 mm above flat ground (its bottom is hidden, its top exposed),
  - a buried sphere over the unsampled strip (unknown ground: nothing culled as below ground),
and `along` values that leave one chunk bin empty. Checks: below-ground and inside faces gone, the hidden
bottom gone, the exposed top kept, winding (cross(b-a, c-a) agrees with the normals), LOD triangle counts
decrease, indices and submesh materials valid, collider present, chunk count by the along/chunkM rule,
byte-identical bin across two runs, bad input -> BakeError.
Timing case: 560 stones of 440 triangles (10 models) in two courses along a 150 m curve against a bank;
prints the stats and seconds per phase (no time assert).

Run: "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --factory-startup --python-exit-code 1
     --python blender/walls/wall_bake_test.py
"""
import json
import math
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import wall_bake as wb  # noqa: E402

MATS = ["Assets/Test/granite.mat", "Assets/Test/moss.mat"]


# ---------------------------------------------------------------- synthetic models (Unity layout)

def fix_winding(v, tris):
    """Order every triangle so cross(b-a, c-a) points away from the model's origin (convex models)."""
    p = v[tris]
    n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    flip = (n * p.mean(1)).sum(1) < 0
    tris[flip] = tris[flip][:, [0, 2, 1]]
    return tris


def sphere_model(seg, rings, scale=(1.0, 1.0, 1.0), wobble=0.0, seed=0.0):
    """UV sphere like Unity imports it: one pole vertex per segment, the seam column doubled. Two
    submeshes: upper half / lower half. 2*seg*(rings-1) triangles (22 x 11 -> 440, 222 welded verts)."""
    sc = np.array(scale)

    def point(th, ph):
        d = np.array([math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph)])
        r = 1.0 + wobble * (0.5 * math.sin(3 * d[0] + seed) * math.cos(2 * d[2] + 0.7 * seed) + 0.5 * math.sin(4 * d[1] + seed))
        return d * r * sc

    v, uv = [], []
    for j in range(seg):
        v.append(point(0.0, 0.0))
        uv.append(((j + 0.5) / seg, 1.0))
    for r in range(1, rings):
        for j in range(seg + 1):
            v.append(point(math.pi * r / rings, 2 * math.pi * (j % seg) / seg))
            uv.append((j / seg, 1.0 - r / rings))
    for j in range(seg):
        v.append(point(math.pi, 0.0))
        uv.append(((j + 0.5) / seg, 0.0))
    v = np.array(v)

    def ring(r, j):
        return seg + (r - 1) * (seg + 1) + j

    bot = seg + (rings - 1) * (seg + 1)
    t = []
    for j in range(seg):
        t.append((j, ring(1, j), ring(1, j + 1)))
        t.append((ring(rings - 1, j), bot + j, ring(rings - 1, j + 1)))
        for r in range(1, rings - 1):
            t.append((ring(r, j), ring(r + 1, j), ring(r + 1, j + 1)))
            t.append((ring(r, j), ring(r + 1, j + 1), ring(r, j + 1)))
    t = fix_winding(v, np.array(t))
    n = v / (sc * sc)
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    upper = v[t].mean(1)[:, 1] >= 0
    return {"vertices": v.ravel().tolist(), "normals": n.ravel().tolist(), "uv": np.array(uv).ravel().tolist(),
            "submeshes": [t[upper].ravel().tolist(), t[~upper].ravel().tolist()]}


def cube_model():
    """Unit cube (-0.5..0.5), 4 vertices per face with the face normal, one submesh."""
    v, n, uv, t = [], [], [], []
    for axis in range(3):
        for sgn in (-1.0, 1.0):
            u, w = [a for a in range(3) if a != axis]
            base = len(v)
            for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                p = [0.0, 0.0, 0.0]
                p[axis], p[u], p[w] = 0.5 * sgn, 0.5 * a, 0.5 * b
                v.append(p)
                nn = [0.0, 0.0, 0.0]
                nn[axis] = sgn
                n.append(nn)
                uv.append(((a + 1) / 2, (b + 1) / 2))
            t += [(base, base + 1, base + 2), (base, base + 2, base + 3)]
    v = np.array(v)
    t = fix_winding(v, np.array(t))
    return {"vertices": v.ravel().tolist(), "normals": np.array(n).ravel().tolist(),
            "uv": np.array(uv).ravel().tolist(), "submeshes": [t.ravel().tolist()]}


def matrix(pos, scale=(1.0, 1.0, 1.0), yaw=0.0, tilt=0.0):
    """Unity local->world TRS, row-major m00 m01 m02 m03 m10 ..."""
    cy, sy, ct, st = math.cos(yaw), math.sin(yaw), math.cos(tilt), math.sin(tilt)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, ct, -st], [0, st, ct]])
    m = np.eye(4)
    m[:3, :3] = ry @ rx @ np.diag(scale)
    m[:3, 3] = pos
    return m.ravel().tolist()


def ground_grid(fn, x0, z0, cell, nx, nz):
    hs = []
    for iz in range(nz):
        for ix in range(nx):
            y = fn(x0 + ix * cell, z0 + iz * cell)
            hs.append(None if y is None else float(y))
    return {"x0": x0, "z0": z0, "cell": cell, "nx": nx, "nz": nz, "heights": hs}


# ---------------------------------------------------------------- reading the output back

def read_out(path):
    with open(path, encoding="utf-8") as f:
        out = json.load(f)
    raw = open(os.path.join(os.path.dirname(path), out["bin"]), "rb").read()
    end = 0
    for c in out["chunks"]:
        for lod in c["lods"]:
            o, nv = lod["offset"], lod["vertexCount"]
            f32 = np.frombuffer(raw, "<f4", 8 * nv, o)
            lod["pos"] = f32[:3 * nv].reshape(-1, 3).astype(np.float64)
            lod["nrm"] = f32[3 * nv:6 * nv].reshape(-1, 3).astype(np.float64)
            lod["uv"] = f32[6 * nv:].reshape(-1, 2)
            o += 32 * nv
            for sm in lod["submeshes"]:
                sm["idx"] = np.frombuffer(raw, "<i4", sm["indexCount"], o)
                o += 4 * sm["indexCount"]
            end = max(end, o)
        col = c["collider"]
        o = col["offset"]
        col["pos"] = np.frombuffer(raw, "<f4", 3 * col["vertexCount"], o).reshape(-1, 3)
        o += 12 * col["vertexCount"]
        col["idx"] = np.frombuffer(raw, "<i4", col["indexCount"], o)
        end = max(end, o + 4 * col["indexCount"])
    assert end == len(raw), "bin size {} != end of last record {}".format(len(raw), end)
    return out, raw


def lod_world_tris(c, k):
    """(N,3,3) world positions and (N,3,3) normals of LOD k, all submeshes."""
    lod = c["lods"][k]
    idx = np.concatenate([sm["idx"] for sm in lod["submeshes"]]).reshape(-1, 3)
    return lod["pos"][idx] + np.array(c["pivot"]), lod["nrm"][idx]


def expected_bins(alongs, chunk_m):
    a0, a1 = min(alongs), max(alongs)
    n = max(1, round((a1 - a0) / chunk_m))
    w = (a1 - a0) / n
    used = sorted({min(n - 1, int((a - a0) // w)) for a in alongs})
    return [(a0 + b * w, a0 + (b + 1) * w) for b in used]


# ---------------------------------------------------------------- small case

def small_ground(x, z):
    if x >= 10.8:
        return None                                   # the unsampled strip
    return 0.0 if z < 1.0 else min(0.8 * (z - 1.0), 0.8)


def small_input():
    stones = []
    for i in range(10):                               # the row, partly buried, nosing into the bank
        x = 0.5 + 0.6 * i
        sx = -0.45 if i == 3 else 0.45                # stone 3 mirrored (det < 0)
        stones.append({"model": "s0", "matrix": matrix((x, 0.15, 0.6), (sx, 0.45, 0.45), yaw=0.3 * i),
                       "materials": [0, 1] if i % 2 == 0 else [1, 0], "along": x})
    stones.append({"model": "c0", "matrix": matrix((6.0, 0.255, -1.2), (0.5, 0.5, 0.5)),       # 10: lone cube
                   "materials": [0], "along": 6.0})
    stones.append({"model": "c0", "matrix": matrix((9.5, 0.3, 0.0), (1.2, 1.2, 1.2)),          # 11: container
                   "materials": [1], "along": 9.5})
    stones.append({"model": "s1", "matrix": matrix((9.5, 0.35, 0.0), (0.3, 0.3, 0.3)),         # 12: inside it
                   "materials": [0, 0], "along": 9.5})
    stones.append({"model": "s0", "matrix": matrix((11.3, -0.2, -1.0), (0.4, 0.4, 0.4)),       # 13: no ground
                   "materials": [0, 1], "along": 14.5})
    return {"format": "golfmap-wallbake-in-v1", "wall": "test-small",
            "models": {"s0": sphere_model(16, 8), "s1": sphere_model(12, 6), "c0": cube_model()},
            "materials": MATS, "stones": stones,
            "ground": ground_grid(small_ground, -1.0, -2.0, 0.1, 136, 61),
            "settings": {"chunkM": 3.0, "lods": [1.0, 0.35, 0.1], "colliderLod": 1, "groundEpsM": 0.02,
                         "insideEpsM": 0.01, "cullHidden": True, "rays": 48, "rayM": 20.0}}


def check_small(tmp):
    doc = small_input()
    inp = os.path.join(tmp, "test-small.in.json")
    with open(inp, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    out_a = os.path.join(tmp, "a", "test-small.out.json")
    out_b = os.path.join(tmp, "b", "test-small.out.json")
    os.makedirs(os.path.dirname(out_a))
    os.makedirs(os.path.dirname(out_b))
    wb.main(["--in", inp, "--out", out_a])
    wb.main(["--in", inp, "--out", out_b])
    out, raw = read_out(out_a)
    _, raw_b = read_out(out_b)
    s = out["stats"]
    print("small:", json.dumps({k: v for k, v in s.items() if k != "seconds"}), s["seconds"])

    assert out["format"] == "golfmap-wallbake-out-v1" and out["bin"] == "test-small.out.bin"
    assert out["materials"] == MATS
    assert raw == raw_b, "bin differs between two runs"
    assert s["trisIn"] == 10 * 224 + 2 * 12 + 120 + 224, s["trisIn"]

    # chunks: along/chunkM rule, empty bin skipped, ids contiguous
    exp = expected_bins([st["along"] for st in doc["stones"]], 3.0)
    assert len(exp) == 4 and len(out["chunks"]) == len(exp), (len(out["chunks"]), exp)
    for k, (c, (a, b)) in enumerate(zip(out["chunks"], exp)):
        assert c["id"] == "chunk-{:02d}".format(k), c["id"]
        assert abs(c["along"][0] - a) < 1e-6 and abs(c["along"][1] - b) < 1e-6, (c["along"], a, b)

    # structure: indices in range, submeshes ascending valid materials, collider, LOD counts decrease
    sums = [0, 0, 0]
    for c in out["chunks"]:
        counts = []
        for k, lod in enumerate(c["lods"]):
            mats = [sm["material"] for sm in lod["submeshes"]]
            assert mats == sorted(set(mats)) and all(0 <= m < len(MATS) for m in mats), mats
            nt = 0
            for sm in lod["submeshes"]:
                assert sm["indexCount"] % 3 == 0 and sm["indexCount"] > 0
                assert sm["idx"].min() >= 0 and sm["idx"].max() < lod["vertexCount"]
                nt += sm["indexCount"] // 3
            assert np.all(np.isfinite(lod["pos"])) and np.allclose(np.linalg.norm(lod["nrm"], axis=1), 1, atol=1e-3)
            counts.append(nt)
            sums[k] += nt
        assert counts[0] > counts[1] > counts[2], (c["id"], counts)
        col = c["collider"]
        assert col["vertexCount"] > 0 and col["indexCount"] > 0 and col["indexCount"] % 3 == 0
        assert col["idx"].min() >= 0 and col["idx"].max() < col["vertexCount"]
        lo = c["lods"][0]["pos"].min(0)
        assert abs(lo[1]) < 1e-5, "pivot is not at the min y"
    assert sums == s["trisLod"], (sums, s["trisLod"])
    assert sums[0] == s["trisIn"] - s["degenerate"] - s["culledGround"] - s["culledInside"] - s["culledHidden"]

    p0 = np.concatenate([lod_world_tris(c, 0)[0] for c in out["chunks"]])
    n0 = np.concatenate([lod_world_tris(c, 0)[1] for c in out["chunks"]])

    # winding: cross(b-a, c-a) agrees with the corner normals (incl. the mirrored stone)
    cr = np.cross(p0[:, 1] - p0[:, 0], p0[:, 2] - p0[:, 0])
    agree = (cr * n0.sum(1)).sum(1)
    assert np.all(agree > 0), "{} LOD0 triangles wound against their normals".format(int((agree <= 0).sum()))
    for k in (1, 2):
        pk = np.concatenate([lod_world_tris(c, k)[0] for c in out["chunks"]])
        nk = np.concatenate([lod_world_tris(c, k)[1] for c in out["chunks"]])
        crk = np.cross(pk[:, 1] - pk[:, 0], pk[:, 2] - pk[:, 0])
        frac = float(((crk * nk.sum(1)).sum(1) > 0).mean())
        assert frac > 0.95, "LOD{} winding agrees on only {:.1%}".format(k, frac)

    # below ground: nothing left with all 3 corners deeper than groundEpsM (analytic ground, sampled strip)
    g = np.array([[np.nan if small_ground(x, z) is None or x > 10.7 else small_ground(x, z) for x, _, z in t] for t in p0])
    deep = np.all(p0[:, :, 1] < g - 0.02 - 1e-4, 1)
    assert not deep.any(), "{} buried triangles survived".format(int(deep.sum()))
    assert s["culledGround"] > 0

    # inside: nothing left with all 3 corners inside the container cube; the inner sphere is gone
    inbox = np.all((np.abs(p0[:, :, 0] - 9.5) < 0.6 - 0.011) & (np.abs(p0[:, :, 1] - 0.3) < 0.6 - 0.011)
                   & (np.abs(p0[:, :, 2]) < 0.6 - 0.011), 1)
    assert not inbox.any(), "{} triangles inside the container survived".format(int(inbox.sum()))
    assert s["culledInside"] > 120, s["culledInside"]

    # lone cube: bottom (5 mm over the ground) hidden, top exposed and facing up
    foot = np.all((np.abs(p0[:, :, 0] - 6.0) < 0.26) & (np.abs(p0[:, :, 2] + 1.2) < 0.26), 1)
    bottom = foot & np.all(np.abs(p0[:, :, 1] - 0.005) < 1e-3, 1)
    top = foot & np.all(np.abs(p0[:, :, 1] - 0.505) < 1e-4, 1)
    assert not bottom.any(), "the lone cube's bottom survived"
    assert top.sum() == 2 and np.all(cr[top][:, 1] > 0), "the lone cube's top is missing or wound down"
    assert s["culledHidden"] >= 2, s["culledHidden"]

    # unsampled ground: the sphere there keeps its underside
    under = np.all((p0[:, :, 0] > 10.8) & (p0[:, :, 1] < -0.55), 1)
    assert under.any(), "the stone over unknown ground lost its underside"

    # bad input
    bad = os.path.join(tmp, "bad.in.json")
    for broken in ({"format": "nope"}, dict(doc, stones=[dict(doc["stones"][0], model="missing")]),
                   dict(doc, stones=[dict(doc["stones"][0], materials=[0, 5])])):
        with open(bad, "w", encoding="utf-8") as f:
            json.dump(broken, f)
        try:
            wb.main(["--in", bad, "--out", os.path.join(tmp, "bad.out.json")])
        except wb.BakeError as e:
            print("  bad input rejected:", e)
        else:
            raise AssertionError("bad input was accepted")
    print("small case OK")


# ---------------------------------------------------------------- timing case

def curve(s):
    return s, 8.0 * math.sin(math.pi * s / 150.0)


def big_ground(x, z):
    zc = 8.0 * math.sin(math.pi * x / 150.0)
    slope = 8.0 * math.pi / 150.0 * math.cos(math.pi * x / 150.0)
    d = (z - zc) / math.sqrt(1 + slope * slope)          # signed distance from the wall line, + = bank side
    front = 0.01 * x
    return front + min(0.9, max(0.0, (d - 0.3) * 1.5))


def timing_input():
    rng = np.random.default_rng(7)
    models = {}
    for m in range(10):
        r = rng.uniform(0.38, 0.5)
        models["m{}".format(m)] = sphere_model(22, 11, (r * rng.uniform(0.9, 1.3), r * rng.uniform(0.6, 0.9),
                                                        r * rng.uniform(0.8, 1.1)), wobble=0.15, seed=float(m))
    stones = []
    n = 280
    for course in range(2):
        for i in range(n):
            s = (i + 0.5 * course) * 150.0 / n
            x, z = curve(s)
            slope = 8.0 * math.pi / 150.0 * math.cos(math.pi * s / 150.0)
            nz = 1.0 / math.sqrt(1 + slope * slope)
            nx = -slope * nz                                # toward the bank
            off = 0.1 + 0.15 * course + rng.uniform(-0.05, 0.05)
            px, pz = x + nx * off, z + nz * off
            y = 0.01 * px + (0.08 if course == 0 else 0.6) + rng.uniform(-0.05, 0.05)
            k = len(stones)
            sx = -1.0 if k % 37 == 0 else 1.0
            stones.append({"model": "m{}".format(int(rng.integers(10))),
                           "matrix": matrix((px, y, pz), (sx, 1.0, 1.0), yaw=float(rng.uniform(0, 2 * math.pi)),
                                            tilt=float(rng.uniform(-0.25, 0.25))),
                           "materials": [0, 1] if rng.random() < 0.5 else [1, 0], "along": s})
    cell = 0.15
    nxg, nzg = int(156 / cell) + 1, int(16 / cell) + 1
    return {"format": "golfmap-wallbake-in-v1", "wall": "test-560", "models": models, "materials": MATS,
            "stones": stones, "ground": ground_grid(big_ground, -3.0, -3.0, cell, nxg, nzg), "settings": {}}


def check_timing(tmp):
    doc = timing_input()
    inp = os.path.join(tmp, "test-560.in.json")
    with open(inp, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    out_path = os.path.join(tmp, "test-560.out.json")
    out = wb.main(["--in", inp, "--out", out_path])
    out, raw = read_out(out_path)
    s = out["stats"]
    print("560 stones: input {:.1f} MB, bin {:.1f} MB, {} chunks".format(os.path.getsize(inp) / 1e6, len(raw) / 1e6,
                                                                       len(out["chunks"])))
    print("  tris in {}  degenerate {}  culled ground {}  inside {}  hidden {}  -> LOD tris {}  collider {}".format(
        s["trisIn"], s["degenerate"], s["culledGround"], s["culledInside"], s["culledHidden"], s["trisLod"],
        s["colliderTris"]))
    print("  seconds:", s["seconds"])
    assert len(out["chunks"]) == len(expected_bins([st["along"] for st in doc["stones"]], 8.0))
    assert s["trisLod"][0] > s["trisLod"][1] > s["trisLod"][2]


def main():
    tmp = tempfile.mkdtemp(prefix="wall_bake_test_")
    try:
        check_small(tmp)
        check_timing(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("wall_bake_test: OK")


if __name__ == "__main__":
    main()
