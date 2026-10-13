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
