"""SAM box bench, step 1: test cases cut from the drawn courses (prepare.py's output), one .npz per case.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/sam_cases.py [--site <siteId>...] [--per-type 12] [--seed 7]

A case is what Marcus would do with a box tool: a box roughly round one thing of one type, plus the photo, NIR and
DEM layers of the crop around it, and what he actually drew there.

- Object types (tee, green, fairway, bunker, water): one drawn feature; the box is its visible extent padded 3-15 %
  per side at random (a hand-drawn box is never tight); the truth is that feature's visible pixels.
- Area types (semi_rough, rough, deep_rough, path): a square box of a fixed size round a random pixel of the type;
  the truth is every pixel of that type inside the box.

The crop is the box plus 30 % context per side, at the photo's 0.16 m when it fits in 1024 px (SAM's input size),
else scaled down to 1024. Writes data/experiments/surfaces/sam-bench/cases/<site8>-<type>-<n>.npz with
rgb uint8 (H,W,3), nir uint8 (H,W), dem float32 (4,H,W: relief_2m, relief_10m, slope_deg, hillshade),
truth bool (H,W), labels uint8 (H,W), box float (4,) x1,y1,x2,y2 in crop pixels, meta json.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window, from_bounds

REPO = Path(__file__).resolve().parents[2]
SURF = REPO / "data" / "experiments" / "surfaces"
OUT = SURF / "sam-bench" / "cases"
CLASSES = ["none", "tee", "green", "fairway", "semi_rough", "rough", "deep_rough", "bunker", "water", "path",
           "trees", "rock_slab", "outside"]
OBJECT_TYPES = {"tee": 30.0, "green": 150.0, "fairway": 1000.0, "bunker": 8.0, "water": 50.0}  # min visible m²
# Lakes are cut off with a drawn straight line where the course ends (Vaettern at Omberg): no tool can find that.
MAX_AREA = {"water": 30000.0}
AREA_TYPES = {"semi_rough": 40.0, "rough": 60.0, "deep_rough": 80.0, "path": 30.0}  # box side, m
SAM_SIZE = 1024
CONTEXT = 0.30


def read_crop(rgbi, inst, lab, dem, bounds, size_px):
    """Photo-grid crop of `bounds` (EPSG:3006) at size_px (h, w); DEM layers resampled onto the same frame."""
    win = from_bounds(*bounds, transform=rgbi.transform)
    px = rgbi.read(window=win, out_shape=(4, *size_px), resampling=Resampling.average, boundless=True, fill_value=0)
    ins = inst.read(1, window=win, out_shape=size_px, resampling=Resampling.nearest, boundless=True, fill_value=0)
    lb = lab.read(1, window=win, out_shape=size_px, resampling=Resampling.nearest, boundless=True, fill_value=0)
    dwin = from_bounds(*bounds, transform=dem.transform)
    dl = dem.read([2, 3, 4, 5], window=dwin, out_shape=(4, *size_px), resampling=Resampling.bilinear, boundless=True,
                  fill_value=np.nan).astype(np.float32)
    return px, ins, lb, dl


def crop_frame(box_m, res):
    """Crop bounds round a box (left, bottom, right, top, metres) and its pixel size."""
    l, b, r, t = box_m
    cw, ch = r - l, t - b
    pad = max(CONTEXT * max(cw, ch), 8.0)
    crop = (l - pad, b - pad, r + pad, t + pad)
    side_m = max(crop[2] - crop[0], crop[3] - crop[1])
    scale = max(side_m / res / SAM_SIZE, 1.0)
    w = int(round((crop[2] - crop[0]) / res / scale))
    h = int(round((crop[3] - crop[1]) / res / scale))
    return crop, (h, w), res * scale


def box_px(box_m, crop, size_px):
    l, b, r, t = box_m
    cl, cb, cr, ct = crop
    sx = size_px[1] / (cr - cl)
    sy = size_px[0] / (ct - cb)
    return np.array([(l - cl) * sx, (ct - t) * sy, (r - cl) * sx, (ct - b) * sy], dtype=np.float32)


def instance_bounds(inst, idx_set):
    """Visible extent (left, bottom, right, top) and pixel count per feature idx, one pass over the raster."""
    found = {}
    for _, w in inst.block_windows(1):
        a = inst.read(1, window=w)
        for idx in np.intersect1d(np.unique(a), list(idx_set)):
            rows, cols = np.nonzero(a == idx)
            r0, r1 = rows.min() + w.row_off, rows.max() + w.row_off + 1
            c0, c1 = cols.min() + w.col_off, cols.max() + w.col_off + 1
            prev = found.get(int(idx))
            if prev:
                r0, c0 = min(r0, prev[0]), min(c0, prev[1])
                r1, c1 = max(r1, prev[2]), max(c1, prev[3])
                n = prev[4] + len(rows)
            else:
                n = len(rows)
            found[int(idx)] = (r0, c0, r1, c1, n)
    return found


def class_pixels(lab, cls, rng, k):
    """k random pixel positions of class `cls` (row, col), sampled block by block."""
    picks = []
    for _, w in lab.block_windows(1):
        a = lab.read(1, window=w)
        rows, cols = np.nonzero(a == cls)
        if len(rows):
            take = rng.choice(len(rows), size=min(3, len(rows)), replace=False)
            picks += [(rows[i] + w.row_off, cols[i] + w.col_off) for i in take]
    rng.shuffle(picks)
    return picks[:k]


def write_case(name, px, ins_truth, lb, dl, box, meta):
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT / f"{name}.npz", rgb=np.moveaxis(px[:3], 0, -1), nir=px[3], dem=dl, truth=ins_truth,
                        labels=lb, box=box, meta=json.dumps(meta))


def cases_for_site(site: str, per_type: int, rng) -> int:
    d = SURF / site
    feats = json.loads((d / "features.json").read_text())
    n = 0
    with rasterio.open(d / "rgbi-2025.tif") as rgbi, rasterio.open(d / "instances.tif") as inst, \
            rasterio.open(d / "labels.tif") as lab, rasterio.open(d / "dem-layers.tif") as dem:
        res = rgbi.res[0]
        T = rgbi.transform
        wanted = {f["idx"]: f for f in feats if f["type"] in OBJECT_TYPES}
        extents = instance_bounds(inst, set(wanted))
        for ftype, min_area in OBJECT_TYPES.items():
            max_area = MAX_AREA.get(ftype, float("inf"))
            pool = [i for i, e in extents.items()
                    if wanted[i]["type"] == ftype and min_area <= e[4] * res * res <= max_area]
            rng.shuffle(pool)
            for k, idx in enumerate(pool[:per_type]):
                r0, c0, r1, c1, _ = extents[idx]
                left, top = T * (c0, r0)
                right, bottom = T * (c1, r1)
                w, h = right - left, top - bottom
                p = rng.uniform(0.03, 0.15, size=4) * np.array([w, h, w, h]) + 0.5
                box_m = (left - p[0], bottom - p[1], right + p[2], top + p[3])
                crop, size_px, mpp = crop_frame(box_m, res)
                px, ins, lb, dl = read_crop(rgbi, inst, lab, dem, crop, size_px)
                meta = {"site": site, "type": ftype, "kind": "object", "idx": idx, "id": wanted[idx]["id"],
                        "mPerPx": mpp, "crop": crop, "boxM": box_m}
                write_case(f"{site[:8]}-{ftype}-{k:02d}", px, ins == idx, lb, dl, box_px(box_m, crop, size_px), meta)
                n += 1
        for ftype, side in AREA_TYPES.items():
            cls = CLASSES.index(ftype)
            for k, (row, col) in enumerate(class_pixels(lab, cls, rng, per_type)):
                cx, cy = T * (col + 0.5, row + 0.5)
                box_m = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
                crop, size_px, mpp = crop_frame(box_m, res)
                px, ins, lb, dl = read_crop(rgbi, inst, lab, dem, crop, size_px)
                bx = box_px(box_m, crop, size_px)
                inside = np.zeros(lb.shape, dtype=bool)
                inside[int(bx[1]):int(math.ceil(bx[3])), int(bx[0]):int(math.ceil(bx[2]))] = True
                meta = {"site": site, "type": ftype, "kind": "area", "mPerPx": mpp, "crop": crop, "boxM": box_m}
                write_case(f"{site[:8]}-{ftype}-{k:02d}", px, (lb == cls) & inside, lb, dl, bx, meta)
                n += 1
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append")
    ap.add_argument("--per-type", type=int, default=12)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    sites = args.site or sorted(p.parent.name for p in SURF.glob("*/ready.json"))
    for site in sites:
        print(f"{site}: {cases_for_site(site, args.per_type, rng)} cases")


if __name__ == "__main__":
    main()
