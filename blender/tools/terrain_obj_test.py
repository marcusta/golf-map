"""Pure tests for terrain_obj.py: a synthetic .raw -> OBJ and back. `python blender/tools/terrain_obj_test.py`."""

import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import terrain_obj as T  # noqa: E402


def sidecar(res=5, side=8.0, min_m=10.0, max_m=20.0, pos=(0.0, 0.0, 0.0)):
    return {"crs": "EPSG:3006", "terrain": "inner", "square3006": [0.0, 0.0, side, side], "sideM": side,
            "minM": min_m, "maxM": max_m, "heightRangeM": max_m - min_m,
            "unity": {"heightmapResolution": res, "position": {"x": pos[0], "y": pos[1], "z": pos[2]}},
            "raw": {"file": "h.raw", "size": res, "dtype": "uint16", "byteOrder": "little-endian",
                    "rowOrder": "north-up", "scale": {"minM": min_m, "maxM": max_m, "to": [0, 65535]}}}


def parse(path):
    """Read an OBJ back: header, vertices, uvs, faces (0-based triples), raw line order."""
    v, vt, f, kinds, header = [], [], [], [], None
    with open(path, encoding="utf-8", newline="") as fh:
        text = fh.read()
    assert text.count("\n") == text.count("\r\n") == text.count("\r"), "every line must end CRLF"
    assert text.endswith("\r\n")
    for line in text.replace("\r\n", "\n").split("\n"):
        if not line:
            continue
        p = line.split()
        kinds.append(p[0])
        if p[0] == "#":
            header = line
        elif p[0] == "v":
            v.append(tuple(float(x) for x in p[1:]))
        elif p[0] == "vt":
            vt.append(tuple(float(x) for x in p[1:]))
        elif p[0] == "f":
            idx = []
            for tok in p[1:]:
                a, b = tok.split("/")
                assert a == b, "v and vt index must agree: " + line
                idx.append(int(a) - 1)
            f.append(tuple(idx))
        else:
            raise AssertionError("unexpected line: " + line)
    return {"header": header, "v": v, "vt": vt, "f": f,
            "blocks": [k for i, k in enumerate(kinds) if i == 0 or kinds[i - 1] != k]}


def write_case(folder, raw, sc, sample="full"):
    raw.astype("<u2").tofile(os.path.join(folder, "h.raw"))
    sp = os.path.join(folder, "h.tif.json")
    with open(sp, "w", encoding="utf-8") as fh:
        json.dump(sc, fh)
    out = os.path.join(folder, "terrain.obj")
    report = T.run(sp, out, sample=sample)
    return out, report


def test_small_grid():
    res, side, min_m, max_m = 5, 8.0, 10.0, 20.0
    # north-up rows: row 0 = north (z max). Make the height a known function of the code.
    codes = (np.arange(res * res, dtype=np.uint16).reshape(res, res) * 2000)
    with tempfile.TemporaryDirectory() as d:
        out, rep = write_case(d, codes, sidecar(res, side, min_m, max_m))
        o = parse(out)
    assert o["header"] == T.HEADER
    assert o["blocks"] == ["#", "v", "vt", "f"], o["blocks"]
    assert rep["grid"] == res and rep["vertices"] == res * res and rep["faces"] == 2 * (res - 1) ** 2
    assert len(o["v"]) == res * res and len(o["vt"]) == res * res and len(o["f"]) == rep["faces"]
    sp = side / (res - 1)
    rng = max_m - min_m
    for iz in range(res):
        for ix in range(res):
            x, y, z = o["v"][iz * res + ix]
            u, vv = o["vt"][iz * res + ix]
            assert abs(x - -(ix * sp)) < 1e-6, (ix, iz, x)
            assert abs(z - iz * sp) < 1e-6, (ix, iz, z)
            # z ascending = north ascending, so the raw's row 0 (north) is the last OBJ row
            expect = float(codes[res - 1 - iz, ix]) / 65535.0 * rng
            assert abs(y - expect) < 1e-4, (ix, iz, y, expect)
            assert abs(u - ix / (res - 1.0)) < 1e-6 and abs(vv - iz / (res - 1.0)) < 1e-6
    # winding: two triangles a cell, cells row-major
    for iz in range(res - 1):
        for ix in range(res - 1):
            a, d = iz * res + ix, (iz + 1) * res + ix
            assert o["f"][2 * (iz * (res - 1) + ix)] == (a, d, a + 1)
            assert o["f"][2 * (iz * (res - 1) + ix) + 1] == (a + 1, d, d + 1)
    print("ok small grid: order, axes, heights, uvs, winding")


def test_winding_and_corners():
    res = 9
    rng = np.random.default_rng(7)
    codes = rng.integers(0, 65536, (res, res)).astype(np.uint16)
    with tempfile.TemporaryDirectory() as d:
        out, rep = write_case(d, codes, sidecar(res, 16.0, 5.0, 25.0))
        o = parse(out)
    v = np.array(o["v"])
    # Every face winds the same way, and that way is Unity's: its exporter negates X without reversing
    # the triangles, so in a right-handed frame (OBJ, and the .blend after `wm.obj_import` with its
    # default forward -Z / up Y) the terrain's faces point down. Kept as Unity wrote it - the only thing
    # that reads this mesh is OPCD's Conform (a Shrinkwrap PROJECT with cull_face off, which ignores
    # orientation) and the Terrain is hidden.
    down = 0
    for a, b, c in o["f"]:
        p, q, r = v[a], v[b], v[c]
        # the .blend frame is (x, -z): the cross product's sign is the face's +Z normal
        cross = ((q[0] - p[0]) * (-r[2] + p[2]) - (-q[2] + p[2]) * (r[0] - p[0]))
        down += cross < 0
    assert down == len(o["f"]), f"{len(o['f']) - down} faces wind against Unity's"
    # corners of the square are present exactly once each
    xs, zs = v[:, 0], v[:, 2]
    assert abs(xs.min() - -16.0) < 1e-6 and abs(xs.max()) < 1e-9
    assert abs(zs.max() - 16.0) < 1e-6 and abs(zs.min()) < 1e-9
    print("ok 9x9: every face winds like Unity's (down in the .blend frame), corners exact")


def test_sample_step_and_position():
    res = 9
    codes = (np.arange(res * res, dtype=np.uint16).reshape(res, res) * 700)
    with tempfile.TemporaryDirectory() as d:
        out, rep = write_case(d, codes, sidecar(res, 16.0, 0.0, 10.0), sample="half")
        o = parse(out)
    assert rep["grid"] == 5 and rep["step"] == 2
    x, y, z = o["v"][0]
    assert (x, z) == (0.0, 0.0)
    assert abs(y - float(codes[res - 1, 0]) / 65535.0 * 10.0) < 1e-4
    # the far corner is still on the square's edge (corners are kept)
    assert abs(o["v"][-1][0] - -16.0) < 1e-6 and abs(o["v"][-1][2] - 16.0) < 1e-6
    # a Unity terrain position offsets every axis (x negated with the rest)
    with tempfile.TemporaryDirectory() as d:
        out, rep = write_case(d, codes, sidecar(res, 16.0, 0.0, 10.0, pos=(3.0, -1.5, 2.0)))
        o2 = parse(out)
    assert abs(o2["v"][0][0] - -3.0) < 1e-6 and abs(o2["v"][0][2] - 2.0) < 1e-6
    assert abs(o2["v"][0][1] - (o["v"][0][1] * 0 + float(codes[res - 1, 0]) / 65535.0 * 10.0 - 1.5)) < 1e-4
    try:
        T.frame_from_sidecar(sidecar(6), "half")  # 5 cells, step 2
    except ValueError as e:
        assert "does not divide" in str(e), e
    else:
        raise AssertionError("a step that does not divide the cells must be refused")
    print("ok sampling (half of 9 -> 5, corners kept), terrain position, bad step refused")


def test_g7_formatting():
    assert T.g7(0.0) == "0" and T.g7(-0.0) == "0"
    assert T.g7(-1.0009765625) == "-1.000977"
    assert T.g7(-3.0029296875) == "-3.00293"
    assert T.g7(0.00048828125) == "0.0004882813"
    assert T.g7(2050.0) == "2050"
    print("ok G7 number formatting matches Unity's")


def test_grid_axes():
    """The axes `plane_height` wants: ascending with the grid index, which in the `.blend` is -x and -y."""
    frame = T.frame_from_sidecar(sidecar(res=9, side=4.0, pos=(3.0, 0.0, -7.0)), "half")
    u, v = T.grid_axes(frame)
    assert frame["grid"] == 5 and frame["spacingM"] == 1.0, frame
    assert np.allclose(u, [3.0, 4.0, 5.0, 6.0, 7.0]), u          # u = -x, x = -(px + ix*spacing)
    assert np.allclose(v, [-7.0, -6.0, -5.0, -4.0, -3.0]), v     # v = -y, y = -(pz + iz*spacing)
    print("ok grid axes ascend with the index (both of the .blend's axes run the other way)")


def test_plane_height_triangles():
    """Both of a cell's triangles, the diagonal between them, the cell edges and the grid's corners.

    A 3x3 grid, spacing 1, with heights that make the two triangles of cell (0,0) different planes:

        iz=2  0  0  0
        iz=1  0  0  0          g[iz, ix], ix east
        iz=0  0  1  4
    """
    u = v = np.array([0.0, 1.0, 2.0])
    g = np.array([[0.0, 1.0, 4.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]])
    # cell (0,0): h00=0 h01=1 h10=0 h11=0.
    #   first triangle  (fx+fz <= 1): h = fx
    #   second triangle (fx+fz >= 1): h = 0 + (1-fz)*1 = 1-fz
    def h(qu, qv):
        z, inside = T.plane_height(u, v, g, np.array([qu], float), np.array([qv], float))
        return float(z[0]), bool(inside[0])

    assert h(0.25, 0.25) == (0.25, True), h(0.25, 0.25)      # inside the first triangle
    assert h(0.75, 0.75) == (0.25, True), h(0.75, 0.75)      # inside the second: 1 - 0.75
    assert h(0.5, 0.5) == (0.5, True)                        # on the diagonal: both give 0.5
    assert h(0.25, 0.75) == (0.25, True)                     # the diagonal fx+fz=1 again
    assert h(0.9, 0.1) == (0.9, True) and h(0.1, 0.9) == (0.1, True)
    assert h(0.0, 0.0) == (0.0, True) and h(1.0, 0.0) == (1.0, True)   # cell corners = the nodes
    assert h(0.0, 1.0) == (0.0, True) and h(1.0, 1.0) == (0.0, True)
    assert h(0.5, 0.0) == (0.5, True)                        # a cell edge: linear between two nodes
    assert h(1.5, 0.0) == (2.5, True)                        # the next cell east: between 1 and 4
    assert h(2.0, 0.0) == (4.0, True)                        # the grid's far corner, not the clamp's
    assert h(2.0, 2.0) == (0.0, True) and h(0.0, 2.0) == (0.0, True)
    for off in ((-1e-9, 0.5), (2.0 + 1e-9, 0.5), (0.5, -1e-9), (0.5, 2.0 + 1e-9), (-5, -5), (9, 9)):
        assert h(*off)[1] is False, off                      # off the grid: what the ray misses
    # the two planes agree on the diagonal wherever the heights are, so the tie never shows
    rng = np.random.default_rng(7)
    gg = rng.standard_normal((3, 3)) * 10.0
    t = np.linspace(0.0, 1.0, 101)
    a, _ = T.plane_height(u, v, gg, t, 1.0 - t)
    b = (1.0 - t) * gg[1, 0] + t * gg[0, 1]
    assert np.abs(a - b).max() < 1e-12, np.abs(a - b).max()
    print("ok the cell lookup: both triangles, the diagonal, cell edges, corners, off the grid")


def test_plane_height_uneven_axes():
    """The OBJ's coordinates carry 7 significant digits, so the cells are not evenly spaced: the lookup
    must use the node coordinates, not a division by the nominal spacing."""
    u = np.array([0.0, 1.0, 2.0005, 3.0])
    v = np.array([0.0, 1.0, 2.0])
    g = np.tile(np.array([0.0, 10.0, 20.005, 30.0]), (3, 1))   # height = 10 * u
    z, inside = T.plane_height(u, v, g, np.array([1.5, 2.5]), np.array([0.0, 0.0]))
    assert inside.all()
    assert abs(z[0] - 15.0) < 1e-9 and abs(z[1] - 25.0) < 1e-9, z
    assert T.plane_height(u, v, g, np.array([3.0]), np.array([2.0]))[0][0] == 30.0
    try:
        T.plane_height(u, v, g[:2], np.array([0.5]), np.array([0.5]))
    except ValueError as e:
        assert "expected" in str(e), e
    else:
        raise AssertionError("a grid that does not match the axes must be refused")
    print("ok unevenly spaced nodes (the OBJ's G7 quantisation) and the shape guard")


def test_smooth_grid():
    """Blender's Smooth modifier on this grid: neighbours weighted factor/2 (it accumulates edge
    midpoints), the six edges the OBJ's triangles make, and fewer of them on the border."""
    g = np.zeros((3, 3))
    g[1, 1] = 1.0
    s = T.smooth_grid(g, 1.5)
    assert abs(s[1, 1] - 0.25) < 1e-12, s[1, 1]              # (1 - 1.5/2) * 1
    assert abs(s[1, 0] - 0.75 / 4.0) < 1e-12, s[1, 0]        # a border node: 4 neighbours, one of them 1
    # (0,0) and (2,2) have only two edges each - the anti-diagonal of their cell joins the other two
    # corners - and neither of those two neighbours is the raised node
    assert s[0, 0] == 0.0 and s[2, 2] == 0.0, (s[0, 0], s[2, 2])
    assert abs(s[0, 2] - 0.75 / 3.0) < 1e-12, s[0, 2]        # the anti-diagonal reaches (0,2) and (2,0)
    assert abs(s[2, 0] - 0.75 / 3.0) < 1e-12, s[2, 0]
    big = np.add.outer(np.arange(6.0) * 3.0, np.arange(6.0) * 2.0)   # a plane
    inner = (slice(1, -1), slice(1, -1))
    assert np.abs(T.smooth_grid(big, 1.5)[inner] - big[inner]).max() < 1e-12
    assert np.abs(T.smooth_grid(big, 0.0) - big).max() == 0.0
    print("ok the Smooth modifier's weights, its six edges and its border")


def test_raw_size_guard():
    with tempfile.TemporaryDirectory() as d:
        np.zeros(4, np.uint16).tofile(os.path.join(d, "h.raw"))
        try:
            T.read_raw(os.path.join(d, "h.raw"), 5)
        except ValueError as e:
            assert "expected 25" in str(e), e
        else:
            raise AssertionError("a .raw of the wrong size must be refused")
    print("ok a .raw that does not match the sidecar is refused")


if __name__ == "__main__":
    test_g7_formatting()
    test_small_grid()
    test_winding_and_corners()
    test_sample_step_and_position()
    test_grid_axes()
    test_plane_height_triangles()
    test_plane_height_uneven_axes()
    test_smooth_grid()
    test_raw_size_guard()
    print("terrain_obj tests ok")
