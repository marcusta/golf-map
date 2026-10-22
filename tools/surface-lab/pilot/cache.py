"""Cache every ready site at the pilot's 0.32 m working resolution (data/experiments/surfaces/pilot/cache/<site>/).

The crop = the bounding box of the drawn surfaces (labels > 0, Linkan's lidar `trees` left out) grown by 40 m,
clipped to the site's DEM extent (the photo has a 250 m buffer beyond the DEM, so every input set sees the same
pixels). Rasters are read in strips so a ~2 GB photo never sits in RAM whole.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/cache.py [--site <id>...] [--force]

Writes rgbi.npy (4,H,W) uint8 (2x2 average), inst.npy (H,W) uint16 (2x2 mode of instances.tif),
labels.npy (H,W) uint8 (= features.json cls of inst), dem.npy (3,H,W) float16 (relief_2m, relief_10m, slope_deg,
bilinear from the 0.5 m DEM grid, 0 where there is no DEM), meta.json (grid, transform, photo stats).
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject
from rasterio.windows import Window

from common import CACHE, CLASSES, SURF, ready_sites, write_json

MARGIN_M = 40.0
F = 2  # 0.16 m -> 0.32 m


def drawn_bbox(labels_path, dem_bounds):
    with rasterio.open(labels_path) as d:
        s = 16
        small = d.read(1, out_shape=(d.height // s, d.width // s), resampling=Resampling.nearest)
        t = d.transform
        drawn = (small > 0) & (small != CLASSES.index("trees"))
        rows, cols = np.nonzero(drawn)
        sx = d.width / small.shape[1]
        sy = d.height / small.shape[0]
        left = t.c + cols.min() * sx * t.a - MARGIN_M
        right = t.c + (cols.max() + 1) * sx * t.a + MARGIN_M
        top = t.f + rows.min() * sy * t.e + MARGIN_M
        bottom = t.f + (rows.max() + 1) * sy * t.e - MARGIN_M
    left, bottom = max(left, dem_bounds.left), max(bottom, dem_bounds.bottom)
    right, top = min(right, dem_bounds.right), min(top, dem_bounds.top)
    return left, bottom, right, top


def build(site_id: str, force: bool) -> None:
    sd = SURF / site_id
    out = CACHE / site_id
    ready = json.loads((sd / "ready.json").read_text())
    if (out / "meta.json").exists() and not force:
        meta = json.loads((out / "meta.json").read_text())
        if meta.get("built") == ready.get("built"):
            print(f"{site_id}: cached")
            return
    t0 = time.time()
    out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(sd / "dem-layers.tif") as dd:
        dem_bounds = dd.bounds
    left, bottom, right, top = drawn_bbox(sd / "labels.tif", dem_bounds)
    feats = json.loads((sd / "features.json").read_text())
    lut = np.zeros(max(f["idx"] for f in feats) + 1, dtype=np.uint8)
    for f in feats:
        lut[f["idx"]] = f["cls"]

    with rasterio.open(sd / "rgbi-2025.tif") as src:
        t = src.transform
        c0 = int(np.floor((left - t.c) / t.a)) // F * F
        c1 = int(np.ceil((right - t.c) / t.a)) // F * F
        r0 = int(np.floor((top - t.f) / t.e)) // F * F
        r1 = int(np.ceil((bottom - t.f) / t.e)) // F * F
        c0, r0 = max(c0, 0), max(r0, 0)
        c1, r1 = min(c1, src.width // F * F), min(r1, src.height // F * F)
        H, W = (r1 - r0) // F, (c1 - c0) // F
        tr = Affine(t.a * F, 0, t.c + c0 * t.a, 0, t.e * F, t.f + r0 * t.e)
        crs = src.crs
        rgbi = np.lib.format.open_memmap(out / "rgbi.npy", mode="w+", dtype=np.uint8, shape=(4, H, W))
        strip = 2048
        for rr in range(r0, r1, strip):
            h = min(strip, r1 - rr)
            win = Window(c0, rr, c1 - c0, h)
            rgbi[:, (rr - r0) // F:(rr - r0 + h) // F, :] = src.read(window=win, out_shape=(4, h // F, W),
                                                                      resampling=Resampling.average)
        rgbi.flush()
    print(f"  photo {W}x{H} in {time.time() - t0:.0f} s", flush=True)

    with rasterio.open(sd / "instances.tif") as src:
        inst = np.zeros((H, W), dtype=np.uint16)
        for rr in range(r0, r1, strip):
            h = min(strip, r1 - rr)
            win = Window(c0, rr, c1 - c0, h)
            inst[(rr - r0) // F:(rr - r0 + h) // F] = src.read(1, window=win, out_shape=(h // F, W),
                                                               resampling=Resampling.mode)
    np.save(out / "inst.npy", inst)
    labels = lut[inst]
    np.save(out / "labels.npy", labels)

    with rasterio.open(sd / "dem-layers.tif") as src:
        dem = np.zeros((3, H, W), dtype=np.float32)
        for i, b in enumerate((2, 3, 4)):
            band = src.read(b)
            dst = np.full((H, W), np.nan, dtype=np.float32)
            reproject(band, dst, src_transform=src.transform, src_crs=src.crs, dst_transform=tr, dst_crs=crs,
                      src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
            dem[i] = dst
            del band
    dem_valid = np.isfinite(dem).all(0)
    dem = np.nan_to_num(dem, nan=0.0).astype(np.float16)
    np.save(out / "dem.npy", dem)

    # photo stats over valid photo pixels (sampled)
    rgbi = np.load(out / "rgbi.npy", mmap_mode="r")
    sub = np.asarray(rgbi[:, ::7, ::7], dtype=np.float32).reshape(4, -1)
    sub = sub[:, sub.sum(0) > 0]
    stats = {"mean": sub.mean(1).tolist(), "std": sub.std(1).tolist()}
    counts = {CLASSES[i]: int(n) for i, n in enumerate(np.bincount(labels.ravel(), minlength=len(CLASSES)))}
    write_json(out / "meta.json", {
        "siteId": site_id, "built": ready.get("built"), "res": t.a * F, "width": W, "height": H,
        "transform": list(tr)[:6], "crs": crs.to_wkt(), "window016": [c0, r0, c1, r1],
        "photoStats": stats, "pixelCounts": counts, "demValidShare": float(dem_valid.mean()),
    })
    print(f"{site_id}: {W}x{H} px at 0.32 m, dem valid {dem_valid.mean():.3f}, {time.time() - t0:.0f} s; "
          f"counts {counts}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    for s in a.site or ready_sites():
        build(s, a.force)


if __name__ == "__main__":
    main()
