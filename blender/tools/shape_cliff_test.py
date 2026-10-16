"""golfmap.cut_out `rise` mode dem and `uv` box (shape_apply.cut_out -> rock_rise -> _rock_rise_dem) on a synthetic
course: a tilted plane of OPCD-like 1.2 m triangles (a rough mesh and a semi mesh meeting along a seam, a green in
the apron) over a DEM with a 10 m cliff across the outline - the course meshes lost the cliff, the DEM has it. Checks:
the GeoTIFF reader (deflate + floating-point predictor, tiles, against rasterio when the pipeline venv is there), the
slab's vertices on the DEM, the faces on the step steep, the apron's smoothstep blend, the green's shared vertices
pinned, 0 open seams and 0 unmatched border vertices, box UVs on the cliff's faces, and the op's validation.
Run: "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" -b --python-exit-code 1 --python blender/tools/shape_cliff_test.py"""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import types
import zlib
sys.path.insert(0, os.path.dirname(__file__))
import bpy
import numpy as np

bpy.ops.wm.read_factory_settings(use_empty=True)
import shape_apply as sa
import shape_coords
import shape_layers as sl

TMP = tempfile.mkdtemp(prefix="golfmap-cliff-")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# --- the DEM: 60 x 60 m at 0.5 m; the frame has a Unity position, so every offset of the mapping is exercised
E0, N0, SIDE, RES, MIN_M = 500000.0, 6400000.0, 60.0, 0.5, 50.0
SIDECAR = {"square3006": [E0, N0, E0 + SIDE, N0 + SIDE], "minM": MIN_M, "resolution": RES,
           "unity": {"position": {"x": 2.0, "y": 1.5, "z": -3.0}}}
FRAME = shape_coords.load_frame(SIDECAR)
STEP_X = -30.0                       # blend x of the cliff line; the high side west of it (x < STEP_X)
LOW, HIGH = 20.0, 30.0               # blend z of the DEM either side


def plane(x, y):
    """The course meshes' heights (blend z): a tilted plane, the cliff smoothed away."""
    return 25.0 + 0.05 * x + 0.02 * y


size = int(SIDE / RES)
cols = np.arange(size)
E = E0 + (cols + 0.5) * RES                    # pixel centres
N = N0 + SIDE - (cols + 0.5) * RES             # rows north-down
EE, NN = np.meshgrid(E, N)
BX, BY = shape_coords.to_blend(EE, NN, FRAME)  # numpy-safe: plain arithmetic
dem_blend = np.where(BX < STEP_X, HIGH, LOW) + 0.03 * BY      # blend z; a slope in y pins the north/south mapping
DEM = (dem_blend - FRAME["py"] + FRAME["minM"]).astype(np.float32)   # metres above sea: z = H - minM + py
assert np.all(np.abs(BX - STEP_X) > 0.1), "the cliff line must fall between pixel centres"


def write_geotiff(path, arr, tile=64):
    """A GeoTIFF like the pipeline's (tiled, deflate, floating-point predictor), little-endian, no library."""
    h, w = arr.shape
    across, down = -(-w // tile), -(-h // tile)
    blocks = []
    for br in range(down):
        for bc in range(across):
            t = np.zeros((tile, tile), dtype=np.float32)
            part = arr[br * tile:(br + 1) * tile, bc * tile:(bc + 1) * tile]
            t[:part.shape[0], :part.shape[1]] = part
            b = t.astype(">f4").view(np.uint8).reshape(tile, tile, 4).transpose(0, 2, 1).reshape(tile, 4 * tile)
            d = b.copy()
            d[:, 1:] = b[:, 1:] - b[:, :-1]
            blocks.append(zlib.compress(d.tobytes()))
    data = b"".join(blocks)
    offs, o = [], 8
    for blk in blocks:
        offs.append(o)
        o += len(blk)
    ifd_at = 8 + len(data)
    tags = [(256, 4, [w]), (257, 4, [h]), (258, 3, [32]), (259, 3, [8]), (262, 3, [1]), (277, 3, [1]), (284, 3, [1]),
            (317, 3, [3]), (322, 3, [tile]), (323, 3, [tile]), (324, 4, offs), (325, 4, [len(b) for b in blocks]),
            (339, 3, [3]), (33550, 12, [RES, RES, 0.0]), (33922, 12, [0.0, 0.0, 0.0, E0, N0 + SIDE, 0.0])]
    fmt = {3: "H", 4: "I", 12: "d"}
    extra_at = ifd_at + 2 + 12 * len(tags) + 4
    ifd, extra = struct.pack("<H", len(tags)), b""
    for tag, typ, vals in tags:
        raw = struct.pack("<" + fmt[typ] * len(vals), *vals)
        if len(raw) <= 4:
            ifd += struct.pack("<HHI", tag, typ, len(vals)) + raw.ljust(4, b"\0")
        else:
            ifd += struct.pack("<HHII", tag, typ, len(vals), extra_at + len(extra))
            extra += raw
    ifd += struct.pack("<I", 0)
    with open(path, "wb") as f:
        f.write(b"II*\0" + struct.pack("<I", ifd_at) + data + ifd + extra)


tif = os.path.join(TMP, "test-inner-dem-60m.tif")
write_geotiff(tif, DEM)
with open(tif + ".json", "w", encoding="utf-8") as f:
    json.dump(SIDECAR, f)

# 1. the reader: the whole band and a window across tiles, bit-exact
lay = sa.tiff_layout(tif)
assert (lay["width"], lay["height"], lay["x0"], lay["y0"], lay["sx"]) == (size, size, E0, N0 + SIDE, RES), lay
assert np.array_equal(sa.tiff_window(tif, lay, 0, size, 0, size), DEM.astype(np.float64))
assert np.array_equal(sa.tiff_window(tif, lay, 50, 90, 60, 70), DEM[50:90, 60:70].astype(np.float64))
venv = os.path.join(REPO, "pipeline", ".venv", "Scripts", "python.exe")
if os.path.exists(venv):
    # the same band written by rasterio the way the pipeline writes the inner DEM (gspro.py / golfpipe sculpt.py)
    npy, rio = os.path.join(TMP, "dem.npy"), os.path.join(TMP, "rasterio-dem.tif")
    np.save(npy, DEM)
    code = ("import sys, numpy as np, rasterio\nfrom rasterio.transform import from_origin\na = np.load(sys.argv[1])\n"
            "with rasterio.open(sys.argv[2], 'w', driver='GTiff', width=a.shape[1], height=a.shape[0], count=1, "
            "dtype='float32', crs='EPSG:3006', transform=from_origin(%r, %r, %r, %r), tiled=True, blockxsize=256, "
            "blockysize=256, compress='deflate', predictor=3) as d:\n    d.write(a, 1)\n") % (E0, N0 + SIDE, RES, RES)
    subprocess.run([venv, "-c", code, npy, rio], check=True)
    rl = sa.tiff_layout(rio)
    assert (rl["x0"], rl["y0"], rl["sx"], rl["predictor"]) == (E0, N0 + SIDE, RES, 3), rl
    assert np.array_equal(sa.tiff_window(rio, rl, 0, size, 0, size), DEM.astype(np.float64)), "rasterio's file reads differently"
    print("reader: own writer and rasterio's file read bit-exact")
else:
    print("reader: own writer read bit-exact (no pipeline venv for the rasterio cross-check)")


def dem_expected(x, y):
    """Bilinear between pixel centres, worked out here from the array (the reader's job, done another way)."""
    e, n = shape_coords.from_blend(x, y, FRAME)
    fc, fr = (e - E0) / RES - 0.5, (N0 + SIDE - n) / RES - 0.5
    i, j = int(np.floor(fc)), int(np.floor(fr))
    t, u = fc - i, fr - j
    a = DEM.astype(np.float64)
    h = (1 - t) * (1 - u) * a[j, i] + t * (1 - u) * a[j, i + 1] + (1 - t) * u * a[j + 1, i] + t * u * a[j + 1, i + 1]
    return h - FRAME["minM"] + FRAME["py"]


# --- the course: x -50..-14, y -50..-14 in 1.2 m squares split in two triangles; rough north of y = -30.4, semi south,
# a green patch in the apron east of the outline (its vertices shared with the rough)
X0, Y0, K, STEP = -50.0, -50.0, 30, 1.2


def region(cx, cy):
    if -23.6 < cx < -21.2 and -29.6 < cy < -27.2:     # 0.4 m east of the outline
        return "green"
    return "rough" if cy > -30.4 else "semi"


verts = [(X0 + i * STEP, Y0 + j * STEP) for j in range(K + 1) for i in range(K + 1)]
faces = {"rough": [], "semi": [], "green": []}
for j in range(K):
    for i in range(K):
        a = j * (K + 1) + i
        cx, cy = verts[a][0] + STEP / 2, verts[a][1] + STEP / 2
        faces[region(cx, cy)] += [(a, a + 1, a + K + 2), (a, a + K + 2, a + K + 1)]
names = {"rough": "Spline_t2_Rough_-_Mesh", "semi": "Spline_t2_Rough_Semi_-_Mesh", "green": "Spline_t2_Green_-_Mesh"}


def build():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for k, fs in faces.items():
        used = sorted({v for f in fs for v in f})
        remap = {v: n for n, v in enumerate(used)}
        me = bpy.data.meshes.new(names[k])
        me.from_pydata([(verts[v][0], verts[v][1], plane(*verts[v])) for v in used], [], [[remap[v] for v in f] for f in fs])
        col = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
        for c in col.data:
            c.color_srgb = (1, 0, 0, 1)
        o = bpy.data.objects.new(names[k], me)
        bpy.context.collection.objects.link(o)
        o["opcd_kind"] = "mesh"
    index = [{"name": names["rough"], "type": "rough"}, {"name": names["semi"], "type": "rough"},
             {"name": names["green"], "type": "green"}]
    ctx = types.SimpleNamespace(index=index, by_name={r["name"]: r for r in index}, frame=FRAME,
                                dem_sidecar=tif + ".json")
    ctx.box = lambda n: sa.bbox_xy(bpy.data.objects[n]) if n in bpy.data.objects else None
    return ctx


RECT = (-36.0, -36.0, -24.0, -24.0)  # the outline (blend), crossing the cliff line and the rough/semi seam
APRON, UV_M = 3.0, 4.0
outline = [list(shape_coords.from_blend(x, y, FRAME)) for x, y in
           ((RECT[0], RECT[1]), (RECT[2], RECT[1]), (RECT[2], RECT[3]), (RECT[0], RECT[3]))]
op = {"id": "cliff", "op": "golfmap.cut_out", "name": "cliff_t2", "outline3006": outline, "uv": "box", "uvM": UV_M,
      "rise": {"mode": "dem", "apronM": APRON}}

# 2. validation: dem needs no topM and takes none; dome still needs it; uv is planar or box
assert sl.validate_op(op) == [], sl.validate_op(op)
bad = lambda **kw: " ".join(sl.validate_op(dict(op, **kw)))
assert "takes no topM" in bad(rise={"mode": "dem", "topM": 1.0})
assert "needs topM" in bad(rise={"apronM": 3.0}) and "needs topM" in bad(rise={"mode": "dome"})
assert "rise.mode must be" in bad(rise={"mode": "cliff"})
assert "uv must be" in bad(uv="cube")
assert sl.validate_op(dict(op, rise={"topM": 0.9, "waterM": 9.4})) == []

ctx = build()
t0 = time.time()
run = sa.cut_out(ctx, op)
took = time.time() - t0
assert run["result"] == ["FINISHED"], run
rise = run["rise"]
print("cut_out", {k: run[k] for k in ("faces", "vertices", "areaM2", "border", "seconds")})
print("rise", {k: rise[k] for k in ("slabZ", "maxUpM", "maxDownM", "steepFaces", "maxSlopeDeg", "pinned", "seams",
                                    "moved", "seconds")})
slab = bpy.data.objects[sa.cut_out_name(op)]
sco = sa.positions(slab).astype(np.float64)

# 3. the slab on the DEM (bilinear), within 2 cm; the DEM's cliff is in it
err = max(abs(z - dem_expected(x, y)) for x, y, z in sco.tolist())
assert err < 0.02, f"a slab vertex is {err:.3f} m off the DEM"
assert sco[:, 2].max() - sco[:, 2].min() > 9.5, "the slab does not carry the 10 m cliff"
# refined to maxEdgeM 0.3 in XY (the dem default)
ev = np.array([e.vertices[:] for e in slab.data.edges])
elen = np.hypot(*(sco[ev[:, 0], :2] - sco[ev[:, 1], :2]).T)
assert elen.max() <= 0.3 + 1e-5, elen.max()
# no zero-area face (a vertical sliver on a cliff) and no doubled vertex inside the slab
for p in slab.data.polygons:
    q = sco[list(p.vertices)]
    assert len(q) == 3 and p.area > 1e-6, f"face {p.index} is degenerate: {q.round(3).tolist()}"
_, counts = np.unique(np.round(sco / 1e-4).astype(np.int64), axis=0, return_counts=True)
assert counts.max() == 1, f"{int((counts > 1).sum())} doubled vertices in the slab"

# 4. the faces on the step are steep: every face on the DEM's ramp between the two pixel centres (x -30.25..-29.75)
# that spans 0.1 m of it across, and at least one steep face per 0.3 m along the line
on_ramp = 0
for p in slab.data.polygons:
    xs = [sco[v, 0] for v in p.vertices]
    if min(xs) >= STEP_X - 0.25 - 1e-6 and max(xs) <= STEP_X + 0.25 + 1e-6 and max(xs) - min(xs) >= 0.1:
        slope = np.degrees(np.arccos(min(1.0, abs(p.normal.z))))
        assert slope > 75, f"a face on the cliff has slope {slope:.0f} deg"
        on_ramp += 1
assert on_ramp >= 40, on_ramp
steep = 0
for p in slab.data.polygons:
    steep += abs(p.normal.z) < np.cos(np.radians(sa.RISE_STEEP_DEG))
assert steep >= (RECT[3] - RECT[1]) / 0.3 and rise["steepFaces"] == steep and rise["maxSlopeDeg"] > 80, (steep, rise)

# 5. the apron: from the DEM at the outline to the mesh's own height at apronM (smoothstep); beyond it untouched;
# the green's vertices (and the semi's shared with it) keep their heights


def outside_dist(x, y):
    dx, dy = max(RECT[0] - x, 0.0, x - RECT[2]), max(RECT[1] - y, 0.0, y - RECT[3])
    return float(np.hypot(dx, dy))


checked = 0
green_xy = {(round(c[0], 3), round(c[1], 3)) for c in sa.positions(bpy.data.objects[names["green"]]).tolist()}
for k in ("rough", "semi", "green"):
    for x, y, z in sa.positions(bpy.data.objects[names[k]]).astype(np.float64).tolist():
        d = outside_dist(x, y)
        own = plane(x, y)
        if k == "green" or (round(x, 3), round(y, 3)) in green_xy or d >= APRON:
            assert abs(z - own) < 1e-4, f"{k} moved at ({x:.2f}, {y:.2f}) d {d:.2f}: {own:.3f} -> {z:.3f}"
            continue
        if d <= 1e-6:
            want = dem_expected(x, y)
        else:
            w = d / APRON
            w = w * w * (3 - 2 * w)
            want = dem_expected(x, y) * (1 - w) + own * w
        assert abs(z - want) < 0.02, f"{k} apron at ({x:.2f}, {y:.2f}) d {d:.2f}: {z:.3f}, want {want:.3f}"
        checked += 1
assert checked > 200, checked
assert rise["pinned"] > 0, "the green's vertices in the apron were not pinned"

# 6. the seams: the slab's border all matched, no shared point with two heights anywhere
assert run["border"]["unmatched"] == 0 and run["border"]["maxAbsDz"] < 1e-4, run["border"]
assert rise["seams"]["open"] == 0, rise["seams"]
allseams = sa.slab_seam_check(sa.spline_meshes())
assert allseams["open"] == 0 and allseams["points"] > 0, allseams

# 7. box UVs: a steep face's UVs span its height / uvM along v (a planar UV would give ~0)
uvl = slab.data.uv_layers[0].data
checked_uv = 0
for p in slab.data.polygons:
    if abs(p.normal.z) > 0.3:
        continue
    zs = [sco[slab.data.loops[i].vertex_index, 2] for i in p.loop_indices]
    vs = [uvl[i].uv[1] for i in p.loop_indices]
    us = [uvl[i].uv[0] for i in p.loop_indices]
    assert abs((max(vs) - min(vs)) - (max(zs) - min(zs)) / UV_M) < 1e-4, (vs, zs)
    ys = [sco[slab.data.loops[i].vertex_index, 1] for i in p.loop_indices]
    assert abs((max(us) - min(us)) - (max(ys) - min(ys)) / UV_M) < 1e-4, "a face facing x is not projected on YZ"
    checked_uv += 1
assert checked_uv >= 20, checked_uv
for p in slab.data.polygons:                                   # top faces stay planar x, y
    if abs(p.normal.z) > 0.9:
        i = p.loop_indices[0]
        v = slab.data.loops[i].vertex_index
        assert abs(uvl[i].uv[0] - sco[v, 0] / UV_M) < 1e-4 and abs(uvl[i].uv[1] - sco[v, 1] / UV_M) < 1e-4
# a lone vertical quad 10 m high, facing -Y: XZ projection, v spans 10 / uvM
me = bpy.data.meshes.new("wall")
me.from_pydata([(0, 0, 0), (2, 0, 0), (2, 0, 10), (0, 0, 10)], [], [(0, 1, 2, 3)])
sa.box_uvs(me, UV_M)
wv = [d.uv[1] for d in me.uv_layers[0].data]
wu = [d.uv[0] for d in me.uv_layers[0].data]
assert abs(max(wv) - min(wv) - 10 / UV_M) < 1e-6 and abs(max(wu) - min(wu) - 2 / UV_M) < 1e-6, (wu, wv)

# 8. the op cache keys on the DEM's content: the cut-out unit's extra carries its hash, a changed DEM another
units, _ = sa.plan_units(ctx, op)
key1 = units[0].extra
assert json.loads(key1)["dem"] == sa._file_sha(tif)
write_geotiff(tif, DEM + 0.5)
os.utime(tif, ns=(time.time_ns() + 10 ** 9, time.time_ns() + 10 ** 9))
units, _ = sa.plan_units(ctx, op)
assert units[0].extra != key1, "a new DEM must re-run the op"
assert sa.plan_units(ctx, dict(op, rise={"topM": 1.0}))[0][0].extra == "", "a dome's cache key must not change"

print(f"cliff test passed: slab {sco[:, 2].min():.2f}-{sco[:, 2].max():.2f} m, DEM error {err * 1000:.2f} mm, "
      f"{steep} steep faces (max {rise['maxSlopeDeg']} deg, {on_ramp} on the ramp), {checked} apron vertices checked, {rise['pinned']} pinned, "
      f"seams {allseams}, {checked_uv} steep faces' box UVs, cut_out + rise {took:.2f} s")
