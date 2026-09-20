"""Synthetic validation render for gspro.py zones. Run from anywhere with the
pipeline venv: pipeline/.venv/Scripts/python.exe docs/validation/vegetation-zones/render.py

A 400 m square at 800 px (0.5 m/px, the inner-terrain default density) with
overlapping zones of four types, feathers, noise and a hole, rendered with
the real rasterizer (gspro.render_zone_masks) and composited as colours.
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pipeline"))
import gspro  # noqa: E402

OUT_DIR = Path(__file__).resolve().parent
E0, N0, SIDE, SIZE = 600000.0, 6400000.0, 400.0, 800
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)

COLORS = {"rough_tall": (0x9a, 0xa8, 0x3a), "shrub": (0x4f, 0x7a, 0x2e), "fern": (0x2e, 0x8a, 0x6a), "meadow": (0xd9, 0xb8, 0x3c)}
CHANNEL = {"rough_tall": 0, "shrub": 1, "fern": 2, "meadow": 3}


def blob(cx, cy, r, n=9, wobble=0.35, seed=0):
    """A wobbly closed B-spline ring (the app's default curve type)."""
    rng = np.random.default_rng(seed)
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * (1 + wobble * (rng.random() - 0.5))
        pts.append({"x": E0 + cx + rr * math.cos(a), "y": N0 + cy + rr * math.sin(a)})
    return {"points": pts}


def rect(x0, y0, x1, y1):
    return {"points": [{"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0},
                       {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]}


def zone(key, rings, weight=1.0, feather=2.0, noise=0.0, curve="bspline", i=[0]):
    i[0] += 1
    return gspro.ZoneSpec(id=f"z{i[0]}", zone_type=key, weight=weight, feather=feather, noise=noise,
                          geometry={"crs": "EPSG:3006", "curveType": curve, "rings": rings})


ZONES = [
    zone("rough_tall", [blob(150, 220, 120, seed=1)], weight=1.0, feather=8.0, noise=0.0),          # 1: big, soft edge
    zone("shrub", [blob(250, 150, 90, seed=2)], weight=0.7, feather=4.0, noise=3.0),                # 2: over the rough, noisy edge
    zone("fern", [blob(110, 260, 55, seed=3)], weight=1.0, feather=3.0, noise=1.5),                 # 3: inside the rough
    zone("meadow", [rect(230, 240, 380, 380), rect(280, 290, 330, 330)], weight=0.5, feather=0.0, curve="bezier"),  # 4: hard edge + hole
    zone("shrub", [blob(60, 80, 45, seed=4)], weight=1.0, feather=0.0, noise=0.0),                  # 5: lone hard-edged
    zone("fern", [blob(330, 70, 40, seed=5)], weight=0.3, feather=6.0, noise=0.0),                  # 6: lone at weight 0.3
]

LEGEND = [
    "1 rough_tall  w1.0  feather 8",
    "2 shrub       w0.7  feather 4  noise 3",
    "3 fern        w1.0  feather 3  noise 1.5",
    "4 meadow      w0.5  hard edge, hole",
    "5 shrub       w1.0  hard edge",
    "6 fern        w0.3  feather 6",
]


def main():
    channels, outside = gspro.render_zone_masks(ZONES, EXTENT, SIZE, seed=3)
    assert outside == 0
    total = sum(channels.values())
    print("max channel sum", float(total.max()))

    # Left: colour composite over a pale ground, each type's colour by its weight.
    ground = np.full((SIZE, SIZE, 3), (0xe8, 0xe4, 0xd8), dtype=np.float32)
    comp = ground * (1.0 - total[..., None])
    for key, arr in channels.items():
        comp += np.array(COLORS[key], dtype=np.float32) * arr[..., None]
    left = Image.fromarray(np.round(comp).clip(0, 255).astype(np.uint8))

    # Right: the packed RGBA mask as the file would hold it (alpha = meadow shown as white).
    rgba = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    for key, arr in channels.items():
        rgba[..., CHANNEL[key]] = np.round(arr * 255).astype(np.uint8)
    rgb_view = rgba[..., :3].astype(np.float32) + rgba[..., 3:4].astype(np.float32)
    right = Image.fromarray(rgb_view.clip(0, 255).astype(np.uint8))

    # Bottom: a weight profile along one row through zones 1, 2 and 4.
    row = SIZE - 1 - int(250 * SIZE / SIDE)  # y = 250 m
    prof_h = 140
    prof = Image.new("RGB", (SIZE * 2 + 20, prof_h), (255, 255, 255))
    d = ImageDraw.Draw(prof)
    for key, arr in channels.items():
        pts = [(int(x * (SIZE * 2) / SIZE) + 10, prof_h - 10 - int(arr[row, x] * (prof_h - 30))) for x in range(SIZE)]
        d.line(pts, fill=COLORS[key], width=2)
    pts = [(int(x * (SIZE * 2) / SIZE) + 10, prof_h - 10 - int(total[row, x] * (prof_h - 30))) for x in range(SIZE)]
    d.line(pts, fill=(60, 60, 60), width=1)
    d.text((14, 4), "weights along y = 250 m (grey = channel sum, never above 1)", fill=(0, 0, 0))

    pad, head = 10, 26
    canvas = Image.new("RGB", (SIZE * 2 + pad * 3, head + SIZE + prof_h + pad * 3 + 100), (255, 255, 255))
    canvas.paste(left, (pad, head))
    canvas.paste(right, (SIZE + pad * 2, head))
    canvas.paste(prof, (pad, head + SIZE + pad))
    d = ImageDraw.Draw(canvas)
    d.text((pad, 6), "colour composite (type colour x weight over the ground)", fill=(0, 0, 0))
    d.text((SIZE + pad * 2, 6), "packed mask RGBA: R rough_tall, G shrub, B fern, A meadow (shown as white)", fill=(0, 0, 0))
    y0 = head + SIZE + prof_h + pad * 2
    for i, line in enumerate(LEGEND):
        key = line.split()[1]
        d.rectangle((pad, y0 + i * 15 + 3, pad + 10, y0 + i * 15 + 13), fill=COLORS[key])
        d.text((pad + 16, y0 + i * 15), line, fill=(0, 0, 0))
    d.line((pad, head + row, pad + SIZE, head + row), fill=(255, 0, 0), width=1)
    d.text((SIZE - 280, y0), f"400 m square, {SIZE} px, {SIDE / SIZE:g} m/px, seed 3", fill=(0, 0, 0))
    d.text((SIZE - 280, y0 + 15), f"max channel sum {float(total.max()):.4f}", fill=(0, 0, 0))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_DIR / "synthetic-zones.png")
    Image.fromarray(rgba).save(OUT_DIR / "synthetic-zones-mask-0.png")
    print("wrote", OUT_DIR / "synthetic-zones.png")


if __name__ == "__main__":
    main()
