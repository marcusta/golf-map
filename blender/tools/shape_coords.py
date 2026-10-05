"""EPSG:3006 (SWEREF 99 TM) <-> OPCD course .blend world coordinates.

The .blend and its terrain.obj share one frame, fixed by the inner DEM square the Unity terrain was
built from (sidecar `<prefix>-inner-dem-<side>m.tif.json`: `square3006` = [e0, n0, e1, n1],
`unity.position`, `minM`). Unity puts the terrain's SW corner at `unity.position`, X east, Z north;
Unity's OBJ export negates X, and Blender's OBJ import (forward -Z, up Y) turns OBJ z into -Y. OPCD's
SVG import lands the meshes in the same place (SVG x = E - e0, y = n1 - N; blend x = -svg x,
y = svg y - side). So the .blend is the course turned 180 degrees about the SW corner:

    x = -(E - e0 + px)        E = e0 - px - x
    y = -(N - n0 + pz)        N = n0 - pz - y
    z = H - minM + py         H = z + minM - py      (heights of the imported Terrain)

with (px, py, pz) = unity.position (zero on Vreta). Pure Python, no bpy: usable from Blender scripts
and plain Python. Self-test: `python blender/tools/shape_coords.py`.
"""

import glob
import json
import os


def load_frame(sidecar):
    """The frame of a course from its inner DEM sidecar (path to the .tif.json, or a dict)."""
    if isinstance(sidecar, str):
        with open(sidecar, encoding="utf-8") as f:
            sidecar = json.load(f)
    e0, n0, e1, n1 = sidecar["square3006"]
    pos = (sidecar.get("unity") or {}).get("position") or {}
    return {
        "e0": float(e0), "n0": float(n0), "sideM": float(e1 - e0),
        "minM": float(sidecar.get("minM", 0.0)),
        "px": float(pos.get("x", 0.0)), "py": float(pos.get("y", 0.0)), "pz": float(pos.get("z", 0.0)),
    }


def find_sidecar(folder):
    """The inner DEM sidecar in a course folder (next to the .blend and terrain.obj)."""
    found = sorted(glob.glob(os.path.join(folder, "*-inner-dem-*m.tif.json")))
    if not found:
        raise FileNotFoundError(f"no *-inner-dem-*m.tif.json in {folder}")
    return found[0]


def to_blend(e, n, frame):
    """EPSG:3006 easting/northing -> .blend world x, y."""
    return -(e - frame["e0"] + frame["px"]), -(n - frame["n0"] + frame["pz"])


def from_blend(x, y, frame):
    """.blend world x, y -> EPSG:3006 easting/northing."""
    return frame["e0"] - frame["px"] - x, frame["n0"] - frame["pz"] - y


def height_to_blend(h, frame):
    """Elevation (m above sea level, the DEM's) -> .blend z of the imported Terrain."""
    return h - frame["minM"] + frame["py"]


def height_from_blend(z, frame):
    return z + frame["minM"] - frame["py"]


def _self_test():
    # Vreta: tee hole_11_10. SVG path bounds (x 1165.90..1171.61, y 1498.70..1507.05; x = E - e0,
    # y = n1 - N) vs its Blend mesh in vreta_svg_1985.blend (x -1171.59..-1165.93, y -551.27..-542.99).
    frame = load_frame({"square3006": [529030.0, 6486669.0, 531080.0, 6488719.0], "minM": 65.22,
                        "unity": {"position": {"x": 0.0, "y": 0.0, "z": 0.0}}})
    e0, n1 = 529030.0, 6488719.0
    for sx, sy, bx, by in ((1165.90, 1507.05, -1165.93, -542.99), (1171.61, 1498.70, -1171.59, -551.27)):
        x, y = to_blend(e0 + sx, n1 - sy, frame)
        assert abs(x - bx) < 0.1 and abs(y - by) < 0.1, (sx, sy, x, y, bx, by)
    for e, n in ((529030.0, 6486669.0), (530123.4, 6487001.9), (531080.0, 6488719.0)):
        x, y = to_blend(e, n, frame)
        e2, n2 = from_blend(x, y, frame)
        assert abs(e2 - e) < 1e-6 and abs(n2 - n) < 1e-6
    assert to_blend(529030.0, 6486669.0, frame) == (0.0, 0.0)
    assert to_blend(531080.0, 6488719.0, frame) == (-2050.0, -2050.0)
    assert abs(height_from_blend(height_to_blend(80.5, frame), frame) - 80.5) < 1e-9
    print("shape_coords self-test ok")


if __name__ == "__main__":
    _self_test()
