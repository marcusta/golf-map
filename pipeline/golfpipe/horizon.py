"""A far shore for a big lake: a low hazy ridge where the lake's water reaches the horizon.

The lake planes (golfpipe/lake_plane.py) stop at `radiusM` (4 km) from the inner square's centre; past that GSPro
shows only sky. Real land 20-25 km away (Vättern's west shore seen from Omberg) stands about half a degree above the
water, less the earth's curvature; drawn at ~4 km that is a ridge some metres to a couple of tens of metres high.
So along every bearing where the water reaches the edge, a ridge stands `distanceM` out: its foot under the water
(the plane runs in under it), a gentle front, a crest of smooth seeded hills, a back slope. At the ends of the
stretch it sinks into the water, as land does past the horizon. It is drawn unlit with a haze texture (lighter up
top, a darker blue-green band low down, some mottling along it), so it reads as far away in any light.

    python -m golfpipe horizon --lake-plane <prefix>-inner-lake-plane.json --out <prefix>-horizon.json
        -> <prefix>-horizon.json (golfmap-horizon-v1: vertices, triangles, uvs in the Unity frame) and
           <prefix>-horizon.png (the haze texture), for Unity's golfmap.horizon.build
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

DEFAULT_DISTANCE_M = 3900.0      # the ridge's foot, from the lake plane's centre (the planes reach 4000 m)
DEFAULT_HEIGHT_M = (30.0, 70.0)  # crest heights over the water: about 0.4-0.9 deg over the horizon from the course, a little more than the real far shore (Hokensas, 200-300 m at 20-25 km) so it reads as land
STEP_DEG = 0.25                  # bearings sampled this often
TAPER_DEG = 4.0                  # the ridge sinks into the water over this at each end of a stretch
MIN_STRETCH_DEG = 3.0            # shorter stretches of open horizon are left alone
# across the ridge: (metres out from the foot, share of the crest height); the foot is under the water
PROFILE = [(0.0, -0.15), (30.0, 0.08), (90.0, 0.55), (180.0, 1.0), (260.0, 0.85), (360.0, 0.35)]
FOOT_BELOW_M = 2.0               # the first profile point this far under the water
# the haze texture: colour by height share (0 at the water, 1 at the crest), Omberg's late-June afternoon
HAZE_LOW = (0.22, 0.29, 0.31)    # land low down, blue-green through the haze (the post-processing lifts it)
HAZE_HIGH = (0.40, 0.47, 0.52)   # the crest: a hazy blue-grey darker than the sky at the horizon
TEXTURE_SIZE = (512, 64)


def _centre(doc: dict, centre: tuple[float, float] | None = None) -> tuple[float, float]:
    """The lake plane's centre in the Unity frame (the inner square's centre, which `radiusM` is measured from)."""
    if centre is not None:
        return centre
    if doc.get("centre"):
        return float(doc["centre"][0]), float(doc["centre"][1])
    raise ValueError("this lake-plane file predates `centre`: pass --centre x,z (the inner square's centre in "
                     "Unity metres, 755,755 for a 1510 m square), or build the lake plane again")


def _water(doc: dict):
    """The far plane's water as a point-in-water test (an STRtree of its triangles)."""
    from shapely import STRtree
    from shapely.geometry import Point, Polygon
    far = next(m for m in doc["meshes"] if m["role"] == "far")
    v = np.asarray(far["vertices"], dtype=float).reshape(-1, 2)
    t = np.asarray(far["triangles"], dtype=int).reshape(-1, 3)
    tris = [Polygon(v[k]) for k in t]
    tree = STRtree(tris)

    def inside(x: float, z: float) -> bool:
        p = Point(x, z)
        return any(tris[i].covers(p) for i in tree.query(p))
    return inside


def _hills(bearings: np.ndarray, lo: float, hi: float, seed: int) -> np.ndarray:
    """Smooth seeded hills along the bearings (a few octaves of random sines), between lo and hi."""
    rng = np.random.default_rng(seed)
    a = np.radians(bearings)
    h = np.zeros_like(a)
    for k, w in ((3, 1.0), (7, 0.6), (17, 0.35), (41, 0.15)):
        h += w * np.sin(k * a + rng.uniform(0, 2 * math.pi)) * rng.uniform(0.6, 1.0)
    h = (h - h.min()) / max(h.max() - h.min(), 1e-9)
    return lo + (hi - lo) * h


def _stretches(open_: np.ndarray) -> list[tuple[int, int]]:
    """Runs of True in a circular boolean array, as (start, length) index pairs."""
    n = len(open_)
    if open_.all():
        return [(0, n)]
    start = int(np.argmin(open_))   # a closed index: runs never wrap past it
    runs, i = [], 0
    while i < n:
        j = (start + i) % n
        if open_[j]:
            k = i
            while k < n and open_[(start + k) % n]:
                k += 1
            runs.append(((start + i) % n, k - i))
            i = k
        else:
            i += 1
    return runs


def horizon(lake_plane: dict, distance_m: float = DEFAULT_DISTANCE_M, height_m: tuple[float, float] = DEFAULT_HEIGHT_M,
            seed: int = 7, centre: tuple[float, float] | None = None) -> dict:
    cx, cz = _centre(lake_plane, centre)
    water_y = float(lake_plane["surfaceY"])
    inside = _water(lake_plane)
    bearings = np.arange(0.0, 360.0, STEP_DEG)
    # open horizon: the water still there just inside the planes' edge (radiusM), past the ridge's foot
    probe = max(distance_m, float(lake_plane.get("radiusM", distance_m + 100.0)) - 20.0)
    open_ = np.array([inside(cx + math.sin(math.radians(b)) * d, cz + math.cos(math.radians(b)) * d)
                      for b in bearings for d in (probe,)])
    crest = _hills(bearings, height_m[0], height_m[1], seed)
    vertices, triangles, uvs = [], [], []
    stretches = []
    for start, length in _stretches(open_):
        if length * STEP_DEG < MIN_STRETCH_DEG:
            continue
        idx = [(start + i) % len(bearings) for i in range(length + 1)]   # one past: close the last step
        base = len(vertices) // 3
        n = len(idx)
        for j, i in enumerate(idx):
            b = bearings[i] if j < length else bearings[idx[-2]] + STEP_DEG
            ends = min(j, n - 1 - j) * STEP_DEG
            taper = min(1.0, ends / TAPER_DEG)
            taper = taper * taper * (3 - 2 * taper)
            h = crest[i % len(crest)] * taper
            s, c = math.sin(math.radians(b)), math.cos(math.radians(b))
            for out, share in PROFILE:
                y = water_y - FOOT_BELOW_M if share < 0 else water_y + share * h
                r = distance_m + out
                vertices += [round(cx + s * r, 2), round(y, 3), round(cz + c * r, 2)]
                uvs += [round(b / 360.0, 5), round(max(share, 0.0) * taper, 4)]
        rows = len(PROFILE)
        for j in range(n - 1):
            for k in range(rows - 1):
                a = base + j * rows + k
                b2 = base + (j + 1) * rows + k
                # front faces towards the centre: clockwise as seen from there (Unity's front-face winding)
                triangles += [a, b2, a + 1, a + 1, b2, b2 + 1]
        stretches.append({"fromDeg": round(float(bearings[start]), 2), "toDeg": round(float(bearings[idx[-2]] + STEP_DEG), 2)})
    return {
        "format": "golfmap-horizon-v1",
        "name": f"{lake_plane.get('name', 'Lake')}_FarShore",
        "centre": [round(cx, 2), round(cz, 2)],
        "distanceM": distance_m,
        "heightM": list(height_m),
        "waterY": water_y,
        "stretches": stretches,
        "vertices": vertices,
        "triangles": triangles,
        "uvs": uvs,
    }


def haze_texture(path: Path, seed: int = 7) -> Path:
    """The ridge's colour: haze by height share (v), with darker mottling along the bearings (u)."""
    from PIL import Image
    from scipy import ndimage
    w, h = TEXTURE_SIZE
    rng = np.random.default_rng(seed)
    mottle = ndimage.gaussian_filter1d(rng.normal(0, 1, w), 3, mode="wrap")
    mottle = (mottle - mottle.min()) / max(mottle.max() - mottle.min(), 1e-9)
    v = np.linspace(0, 1, h)[:, None]                         # row 0 = bottom (flipped below)
    k = np.clip(v ** 0.8, 0, 1)
    lo, hi = np.array(HAZE_LOW), np.array(HAZE_HIGH)
    rgb = lo[None, None, :] * (1 - k[..., None]) + hi[None, None, :] * k[..., None]
    rgb = rgb * (1 - 0.10 * (1 - k[..., None]) * mottle[None, :, None])   # darker patches low down
    img = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)[::-1]
    Image.fromarray(np.broadcast_to(img, (h, w, 3)).copy(), "RGB").save(path)
    return path


def cmd_horizon(lake_plane_path: Path, out: Path, distance_m: float = DEFAULT_DISTANCE_M,
                height_m: tuple[float, float] = DEFAULT_HEIGHT_M, seed: int = 7, centre: tuple[float, float] | None = None) -> Path:
    doc = horizon(json.loads(Path(lake_plane_path).read_text(encoding="utf-8")), distance_m, height_m, seed, centre)
    texture = out.with_suffix(".png")
    haze_texture(texture, seed)
    doc["texture"] = texture.name
    out.write_text(json.dumps(doc), encoding="utf-8")
    deg = sum((s["toDeg"] - s["fromDeg"]) % 360 for s in doc["stretches"])
    print(f"Far shore: {len(doc['stretches'])} stretch(es), {deg:.0f} deg of horizon, {distance_m:.0f} m out, "
          f"hills {height_m[0]:g}-{height_m[1]:g} m; {len(doc['vertices']) // 3} vertices -> {out} (+ {texture.name})")
    return out
