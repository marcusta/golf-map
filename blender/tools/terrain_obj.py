"""Write the course's `terrain.obj` from the exported inner heightmap, instead of Unity's Export To OBJ.

Shaping step 2 (`shape_prepare.py`) imports a `terrain.obj` that used to come out of the Unity editor by
hand (Terrain > Export To OBJ, docs/workflows.md section 1 step 8). The OBJ is nothing but the inner
heightmap `.raw` the same export already writes, so we can write it here and drop the manual step:

    bun run py ../blender/tools/terrain_obj.py --sidecar <inner .tif.json> --out terrain.obj

What Unity's exporter wrote (measured on Vreta's Sep 27 `terrain.obj`, 644 MB, 2049x2049):

* header `# Unity Terrain OBJ File`, CRLF line endings, then all `v`, all `vt`, all `f` lines;
* **half** the heightmap's resolution: 2049 nodes a side out of the 4097 `.raw` (every second sample,
  corners included), spacing `sideM / (grid - 1)` = 2050/2048 m;
* vertices row-major with z (north) ascending and, inside a row, x descending:
  `v -(px + ix*spacing) (py + h) (pz + iz*spacing)` - **x negated** (Unity is left-handed, OBJ is not),
  y = the height above the heightmap's `minM`, so the OBJ frame is `shape_coords.py`'s `.blend` frame
  after Blender's OBJ import (forward -Z, up Y: obj x,y,z -> blend x, -z, y);
* `vt ix/(grid-1) iz/(grid-1)`, one per vertex, same index;
* two triangles per cell, cells row-major: `(iz,ix) (iz+1,ix) (iz,ix+1)` and
  `(iz,ix+1) (iz+1,ix) (iz+1,ix+1)`, 1-based `v/vt` pairs, no normals;
* numbers formatted like C#'s `G7` (7 significant digits, shortest form) - `%.7g` here.

Heights come straight from the `.raw` (uint16 little-endian, north-up rows, `[0,65535]` ->
`[minM,maxM]`), so they are the DEM's; Unity's OBJ went through the terrain's own 16-bit storage and is
up to one of its steps off (`heightRangeM/65535` = 0.63 mm on Vreta). Pure Python + numpy, no bpy.
Tests: `python blender/tools/terrain_obj_test.py`.
"""

import argparse
import json
import os
import sys
import time
from decimal import Context, Decimal, ROUND_HALF_UP

import numpy as np

_G7 = Context(prec=7, rounding=ROUND_HALF_UP)
HEADER = "# Unity Terrain OBJ File"
EOL = "\r\n"
# Unity's Export To OBJ resolution menu -> how many heightmap samples it skips.
SAMPLE_STEP = {"full": 1, "half": 2, "quarter": 4, "eighth": 8, "sixteenth": 16}
ROWS_PER_CHUNK = 64


def load_sidecar(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def grid_axes(frame):
    """The grid's two axes in OBJ index order: `u[ix]` and `v[iz]`, both ascending by `spacingM`.

    The OBJ writes `v -(px + ix*spacing) (py + h) (pz + iz*spacing)`, and Blender's import maps obj
    `x,y,z` to blend `x,-z,y`, so in the `.blend` **both** x and y run *down* as the index runs up:
    blend x = -(px + ix*spacing), blend y = -(pz + iz*spacing). `u = -x` and `v = -y` are therefore the
    ascending axes `plane_height` wants - flipping the arrays instead would reverse the index order and
    with it the cells' diagonal (`plane_height`)."""
    grid, sp = frame["grid"], frame["spacingM"]
    ix = np.arange(grid, dtype=np.float64)
    return frame["px"] + ix * sp, frame["pz"] + ix * sp


def plane_height(u, v, g, qu, qv):
    """Height on the terrain grid at the query points `(qu, qv)`, and whether they are on it.

    `u` (len `grid`, strictly ascending) is the axis of the column index `ix`, `v` that of the row index
    `iz` (both as `grid_axes` gives them - in the `.blend` that means `qu = -x`, `qv = -y`); `g[iz, ix]`
    is the node height. Neither axis has to be evenly spaced: the OBJ's coordinates are written with 7
    significant digits, so a 2050 m side is quantised to 0.5 mm, and the cell edges the Shrinkwrap's rays
    actually meet are those quantised ones. The cell is found with `searchsorted`, not by dividing by the
    spacing, so this is the same cell Blender finds.

    Two triangles a cell, exactly the OBJ's (`obj_chunks`):
    `(iz,ix) (iz+1,ix) (iz,ix+1)` and `(iz,ix+1) (iz+1,ix) (iz+1,ix+1)`. With `fx`, `fz` the fractional
    position in the cell, the first holds `fx + fz <= 1`. **The two planes agree exactly on the diagonal**
    `fx + fz == 1` (both reduce to `(1-fx)*h10 + fx*h01`), so a point on it gets one height whichever
    triangle claims it - which is how the tie is broken on both sides: Blender's watertight ray test hands
    such a ray to exactly one of the two triangles, and the height is the same one.

    Returns `(height, inside)`, both the shape of the query. `height` is meaningless where `inside` is
    False (the point is off the grid, which is what the Shrinkwrap's ray misses)."""
    u, v, g = np.asarray(u, np.float64), np.asarray(v, np.float64), np.asarray(g, np.float64)
    if u.ndim != 1 or v.ndim != 1 or g.shape != (v.size, u.size):
        raise ValueError(f"grid is {g.shape}, expected {(v.size, u.size)} for the given axes")
    if u.size < 2 or v.size < 2:
        raise ValueError("the grid needs at least 2 nodes a side")
    qu, qv = np.asarray(qu, np.float64), np.asarray(qv, np.float64)
    inside = (qu >= u[0]) & (qu <= u[-1]) & (qv >= v[0]) & (qv <= v[-1])
    ix = np.clip(np.searchsorted(u, qu, side="right") - 1, 0, u.size - 2)
    iz = np.clip(np.searchsorted(v, qv, side="right") - 1, 0, v.size - 2)
    fx = (qu - u[ix]) / (u[ix + 1] - u[ix])
    fz = (qv - v[iz]) / (v[iz + 1] - v[iz])
    h00, h01 = g[iz, ix], g[iz, ix + 1]
    h10, h11 = g[iz + 1, ix], g[iz + 1, ix + 1]
    return np.where(fx + fz <= 1.0,
                    h00 + fx * (h01 - h00) + fz * (h10 - h00),
                    h11 + (1.0 - fx) * (h10 - h11) + (1.0 - fz) * (h01 - h11)), inside


def frame_from_sidecar(sidecar, sample="half"):
    """Grid and placement the OBJ needs: raw file, resolution, step, grid, spacing, height range, position."""
    raw = sidecar.get("raw") or {}
    res = int(raw.get("size") or (sidecar.get("unity") or {}).get("heightmapResolution") or 0)
    if res < 2:
        raise ValueError("the sidecar has no raw.size / unity.heightmapResolution")
    step = SAMPLE_STEP[sample] if isinstance(sample, str) else int(sample)
    if step < 1 or (res - 1) % step:
        raise ValueError(f"sample step {step} does not divide the heightmap's {res - 1} cells")
    side = float(sidecar["sideM"])
    min_m = float(sidecar["minM"])
    max_m = float(sidecar.get("maxM", min_m))
    pos = (sidecar.get("unity") or {}).get("position") or {}
    grid = (res - 1) // step + 1
    return {
        "rawFile": raw.get("file"), "res": res, "step": step, "grid": grid,
        "sideM": side, "spacingM": side / (grid - 1),
        "minM": min_m, "maxM": max_m,
        "heightRangeM": float(sidecar.get("heightRangeM", max_m - min_m)),
        "px": float(pos.get("x", 0.0)), "py": float(pos.get("y", 0.0)), "pz": float(pos.get("z", 0.0)),
    }


def read_raw(path, res):
    a = np.fromfile(path, dtype="<u2")
    if a.size != res * res:
        raise ValueError(f"{path} holds {a.size} uint16, expected {res * res} for a {res}x{res} heightmap")
    return a.reshape(res, res)


def height_grid(raw, frame):
    """`g[iz, ix]` = metres above `minM` at the terrain node (ix east, iz north), as Unity places it:
    the `.raw`'s row 0 is north, so the sampled rows are flipped."""
    sub = raw[::frame["step"], ::frame["step"]]
    return sub[::-1, :].astype(np.float64) * (frame["heightRangeM"] / 65535.0)


def smooth_grid(g, factor):
    """What OPCD's Import Terrain OBJ does to the heights after the import: one pass of Blender's **Smooth**
    modifier (`use_y` only - the OBJ's y is the height - factor = the scene's Terrain Smooth, default 1.5),
    applied.

    Blender's modifier accumulates, per incident edge, the edge's *midpoint*, so the mean it blends toward is
    `0.5*h + 0.5*mean(neighbours)` and the result is `(1 - f/2)*h + (f/2)*mean(neighbours)`: Terrain Smooth
    1.5 weights the neighbours 0.75, not 1.5. The neighbours are the grid's edges, which the OBJ's two
    triangles a cell make: east, west, north, south and the **anti-diagonal** `(iz+1,ix)-(iz,ix+1)` - six for
    an interior node, fewer on the border, where the modifier divides by the count it found.

    So the Terrain object in the `.blend` is not the `.raw`: on Vreta it differs from it by up to 1.14 m
    (mean 15 mm). This reproduces it to 0.8 mm (the OBJ's 7-significant-digit heights and float32
    accumulation), which is why the grid conform reads the Terrain object itself and only uses this as a
    check that the object really is the grid the sidecar describes."""
    g = np.asarray(g, np.float64)
    acc = np.zeros(g.shape, np.float64)
    cnt = np.zeros(g.shape, np.int32)
    for dst, src in (((slice(None), slice(0, -1)), (slice(None), slice(1, None))),       # east
                     ((slice(None), slice(1, None)), (slice(None), slice(0, -1))),       # west
                     ((slice(0, -1), slice(None)), (slice(1, None), slice(None))),       # north
                     ((slice(1, None), slice(None)), (slice(0, -1), slice(None))),       # south
                     ((slice(1, None), slice(0, -1)), (slice(0, -1), slice(1, None))),   # anti-diagonal
                     ((slice(0, -1), slice(1, None)), (slice(1, None), slice(0, -1)))):
        acc[dst] += g[src]
        cnt[dst] += 1
    half = 0.5 * float(factor)
    return (1.0 - half) * g + half * (acc / np.maximum(cnt, 1))


def g7(x):
    """C#'s `G7` (invariant culture): 7 significant digits, trailing zeros dropped, no negative zero,
    scientific only outside 1e-5..1e7. C# rounds half away from zero where Python's `%g` rounds half to
    even (0.00048828125 -> 0.0004882813, not ...12), so the digits come from `decimal`."""
    if x == 0.0:
        return "0"
    d = _G7.create_decimal(Decimal(x)).normalize()
    adjusted = d.adjusted()
    if -5 <= adjusted < 7:
        return format(d, "f")
    mantissa = format(abs(d).scaleb(-adjusted).normalize(), "f")
    return ("-" if d.is_signed() else "") + mantissa + "E" + ("+" if adjusted >= 0 else "-") + "%02d" % abs(adjusted)


def obj_chunks(g, frame):
    """The OBJ's text in chunks (header, vertex rows, uv rows, face rows), ready to write."""
    grid = frame["grid"]
    if g.shape != (grid, grid):
        raise ValueError(f"height grid is {g.shape}, expected {(grid, grid)}")
    sp, px, py, pz = frame["spacingM"], frame["px"], frame["py"], frame["pz"]
    xs = [g7(-(px + ix * sp)) for ix in range(grid)]
    zs = [g7(pz + iz * sp) for iz in range(grid)]
    us = [g7(ix / (grid - 1.0)) for ix in range(grid)]
    vs = [g7(iz / (grid - 1.0)) for iz in range(grid)]
    yield HEADER + EOL

    # Vertices. The raw's uint16 has only 65536 distinct heights, so format each one once.
    codes = np.rint(g / (frame["heightRangeM"] / 65535.0)).astype(np.int64) if frame["heightRangeM"] else None
    ytab = {} if codes is None else {int(c): g7(py + int(c) * (frame["heightRangeM"] / 65535.0))
                                     for c in np.unique(codes)}
    for iz0 in range(0, grid, ROWS_PER_CHUNK):
        out = []
        for iz in range(iz0, min(iz0 + ROWS_PER_CHUNK, grid)):
            z = zs[iz]
            row = codes[iz] if codes is not None else None
            ys = [ytab[int(c)] for c in row] if row is not None else [g7(py + h) for h in g[iz]]
            out += ["v " + xs[ix] + " " + ys[ix] + " " + z for ix in range(grid)]
        yield EOL.join(out) + EOL

    for iz0 in range(0, grid, ROWS_PER_CHUNK):
        out = []
        for iz in range(iz0, min(iz0 + ROWS_PER_CHUNK, grid)):
            v = vs[iz]
            out += ["vt " + us[ix] + " " + v for ix in range(grid)]
        yield EOL.join(out) + EOL

    for iz0 in range(0, grid - 1, ROWS_PER_CHUNK):
        out = []
        for iz in range(iz0, min(iz0 + ROWS_PER_CHUNK, grid - 1)):
            base = iz * grid + 1
            for ix in range(grid - 1):
                a = base + ix
                d = a + grid
                out.append("f %d/%d %d/%d %d/%d" % (a, a, d, d, a + 1, a + 1))
                out.append("f %d/%d %d/%d %d/%d" % (a + 1, a + 1, d, d, d + 1, d + 1))
        yield EOL.join(out) + EOL


def write_obj(out_path, g, frame):
    n = 0
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        for chunk in obj_chunks(g, frame):
            f.write(chunk)
            n += len(chunk)
    os.replace(tmp, out_path)
    return n


def run(sidecar_path, out_path, sample="half", raw_path=None):
    t0 = time.time()
    sidecar = load_sidecar(sidecar_path)
    if sidecar.get("terrain") not in (None, "inner"):
        # the outer terrain is placed by the importer (unity.position, and sunk further: docs/gspro/export.md)
        print("[terrain_obj] warning: %s is the %r heightmap; shaping's terrain.obj is the inner one"
              % (os.path.basename(sidecar_path), sidecar["terrain"]))
    frame = frame_from_sidecar(sidecar, sample)
    raw_path = raw_path or os.path.join(os.path.dirname(os.path.abspath(sidecar_path)), frame["rawFile"] or "")
    raw = read_raw(raw_path, frame["res"])
    g = height_grid(raw, frame)
    size = write_obj(out_path, g, frame)
    grid = frame["grid"]
    return {
        "format": "golfmap-terrain-obj-v1",
        "out": os.path.abspath(out_path), "bytes": size,
        "sidecar": os.path.abspath(sidecar_path), "raw": os.path.abspath(raw_path),
        "sample": sample, "heightmap": frame["res"], "grid": grid, "step": frame["step"],
        "sideM": frame["sideM"], "spacingM": frame["spacingM"],
        "position": [frame["px"], frame["py"], frame["pz"]],
        "vertices": grid * grid, "faces": 2 * (grid - 1) * (grid - 1),
        "minM": frame["minM"], "heightRangeM": frame["heightRangeM"],
        "yM": [round(float(g.min()), 6), round(float(g.max()), 6)],
        "seconds": round(time.time() - t0, 1),
    }


def summary(r):
    return ("terrain.obj: {grid}x{grid} nodes ({sample} of the {heightmap} heightmap, {spacingM:.6f} m), "
            "{vertices} vertices, {faces} faces, y {yM[0]}..{yM[1]} m above minM {minM:.3f}\n"
            "  -> {out} ({mb:.0f} MB) in {seconds} s").format(mb=r["bytes"] / 1e6, **r)


def main(argv=None):
    p = argparse.ArgumentParser(prog="terrain_obj.py", description="write terrain.obj from the inner heightmap .raw")
    p.add_argument("--sidecar", required=True, help="the inner heightmap sidecar (<prefix>-inner-dem-<side>m.tif.json)")
    p.add_argument("--out", help="output OBJ (default: terrain.obj next to the sidecar)")
    p.add_argument("--raw", help="the .raw (default: the sidecar's raw.file, next to it)")
    p.add_argument("--sample", default="half", choices=sorted(SAMPLE_STEP),
                   help="Unity's Export To OBJ resolution (default %(default)s, what Vreta's OBJ used)")
    p.add_argument("--json", help="also write the report here")
    a = p.parse_args(argv)
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.sidecar)), "terrain.obj")
    report = run(a.sidecar, out, sample=a.sample, raw_path=a.raw)
    print(summary(report))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
