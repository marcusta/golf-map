"""Surface lab data: for each site with drawn courses, the 4-band photo (RGB + NIR) on the site's ortho grid,
lidar DEM layers and the drawn features burnt into an instance raster. The shared input of the SAM box bench
(bench_sam.py) and the surface-model pilot (pilot/).

    bun tools/surface-lab/export-labels.ts                                   # the drawn features, first
    pipeline/.venv/Scripts/python.exe tools/surface-lab/prepare.py [--site <siteId>...] [--force] [--no-download]

Writes data/experiments/surfaces/<siteId>/:
  rgbi-2025.tif   uint8 x4 (R, G, B, NIR) on the grid of data/sources/<site>/ortho-orto-l2-2025.tif (0.16 m, the
                  photo the shapes were drawn on). Lantmaeteriet's photo tiles are RGBI; the map build keeps RGB only
                  (cmd_fetch_ortho), so the tiles are read again: from a local copy when one exists (D:/ortofoton,
                  a map build's temp folder, _tiles/), else downloaded into _tiles/.
  dem-layers.tif  float32 on the site's 0.5 m DEM grid (data/sources/<site>/dem.tif, the raw lidar ground):
                  dem, relief_2m, relief_10m (DEM minus a Gaussian of that sigma), slope_deg, hillshade (315/45).
  instances.tif   uint16 on the photo grid: the topmost drawn surface per pixel, as its `idx` in features.json
                  (0 = nothing drawn). Burnt bottom-up in stackKey order, the order the editor paints them.
  labels.tif      uint8 on the photo grid: CLASSES index of that surface.
  features.json   [{idx, id, type, cls, holeId, source, stackKey}] (overlays such as vegetation zones left out).
  preview-*.png   1/8-scale looks: rgb, cir (NIR-R-G), ndvi, hillshade, labels.
  ready.json      what was built; `rgbCheck` = mean |RGB - reference RGB| (0-255) to prove the NIR is aligned.
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio import features as rfeatures
from rasterio.enums import MergeAlg, Resampling
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds, transform_geom
from rasterio.windows import Window, bounds as window_bounds, transform as window_transform
from scipy import ndimage
from shapely.geometry import shape

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))
from golfpipe import stac  # noqa: E402

DATA = REPO / "data"
OUT = DATA / "experiments" / "surfaces"
TILE_CACHE = OUT / "_tiles"
TILE_M = 2500
YEAR = 2025
BLOCK = 2048

CLASSES = ["none", "tee", "green", "fairway", "semi_rough", "rough", "deep_rough", "bunker", "water", "path",
           "trees", "rock_slab", "outside"]
TYPE_CLASS = {t: i for i, t in enumerate(CLASSES) if i} | {"water_creek": CLASSES.index("water")}
# Display colours for preview-labels.png (index = class).
CLASS_RGB = np.array([
    [0, 0, 0], [230, 120, 220], [40, 220, 90], [120, 200, 60], [90, 150, 50], [60, 110, 40], [35, 70, 30],
    [240, 225, 160], [40, 110, 230], [150, 150, 150], [20, 60, 20], [130, 120, 110], [200, 60, 60]], dtype=np.uint8)
DEM_BANDS = ["dem", "relief_2m", "relief_10m", "slope_deg", "hillshade"]


def load_dotenv() -> None:
    env = REPO / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def tile_ids(bounds: tuple[float, float, float, float], year: int) -> list[str]:
    left, bottom, right, top = bounds
    ids = []
    for n0 in range(int(bottom // TILE_M) * TILE_M, int(math.ceil(top / TILE_M)) * TILE_M, TILE_M):
        for e0 in range(int(left // TILE_M) * TILE_M, int(math.ceil(right / TILE_M)) * TILE_M, TILE_M):
            ids.append(f"o{n0 // 100}_{e0 // 100}_25_mr{year % 100:02d}")
    return ids


def local_tile(tile_id: str) -> Path | None:
    temp = os.environ.get("TEMP", "")
    for pattern in (f"D:/ortofoton/*/{tile_id}.tif", f"{temp}/golfbuild-*/ortho-src/{tile_id}.tif",
                    str(TILE_CACHE / f"{tile_id}.tif")):
        for p in glob.glob(pattern):
            try:
                with rasterio.open(p) as d:
                    if d.count >= 4:
                        return Path(p)
            except rasterio.RasterioIOError:
                continue
    return None


def fetch_tiles(bounds, crs, allow_download: bool) -> list[Path]:
    ids = tile_ids(bounds, YEAR)
    found = {i: local_tile(i) for i in ids}
    missing = [i for i, p in found.items() if p is None]
    if missing and allow_download:
        load_dotenv()
        wgs = transform_bounds(crs, "EPSG:4326", *bounds)
        items = {it.id: it for it in stac.search_ortho(wgs, ids=missing)}
        TILE_CACHE.mkdir(parents=True, exist_ok=True)
        for tile_id in missing:
            item = items.get(tile_id)
            if item is None:
                print(f"  {tile_id}: not in the catalogue, skipped")
                continue
            part = TILE_CACHE / f"{tile_id}.tif.part"
            t0 = time.time()
            print(f"  {tile_id}: downloading ...", flush=True)
            stac.download_asset(item.data_href, part)
            final = TILE_CACHE / f"{tile_id}.tif"
            part.replace(final)
            print(f"  {tile_id}: {final.stat().st_size / 2**20:.0f} MB in {time.time() - t0:.0f} s", flush=True)
            found[tile_id] = final
    for tile_id, p in found.items():
        print(f"  {tile_id}: {p if p else 'MISSING'}")
    return [p for p in found.values() if p]


def blocks(width: int, height: int, size: int = BLOCK):
    for row in range(0, height, size):
        for col in range(0, width, size):
            yield Window(col, row, min(size, width - col), min(size, height - row))


def intersects(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def build_rgbi(ref_path: Path, tiles: list[Path], out: Path) -> float:
    """Every tile warped onto the reference photo's grid, block by block (the box has ~6 GB free). Returns the mean
    absolute RGB difference to the reference photo over the blocks checked."""
    with rasterio.open(ref_path) as ref:
        profile = dict(driver="GTiff", width=ref.width, height=ref.height, count=4, dtype="uint8", crs=ref.crs,
                       transform=ref.transform, tiled=True, blockxsize=512, blockysize=512, compress="deflate",
                       predictor=2, BIGTIFF="IF_SAFER", interleave="pixel")
        srcs = [rasterio.open(p) for p in tiles]
        vrts = [WarpedVRT(s, crs=ref.crs, transform=ref.transform, width=ref.width, height=ref.height,
                          resampling=Resampling.bilinear, add_alpha=True) for s in srcs]
        diffs, n = [], 0
        tmp = out.with_suffix(".tif.part")
        try:
            with rasterio.open(tmp, "w", **profile) as dst:
                for w in blocks(ref.width, ref.height):
                    wb = window_bounds(w, ref.transform)
                    block = np.zeros((4, int(w.height), int(w.width)), dtype=np.uint8)
                    filled = np.zeros(block.shape[1:], dtype=bool)
                    for s, v in zip(srcs, vrts):
                        if not intersects(wb, s.bounds):
                            continue
                        data = v.read(window=w)
                        take = (data[-1] > 0) & ~filled
                        block[:, take] = data[:4, take]
                        filled |= take
                    dst.write(block, window=w)
                    if n % 3 == 0 and filled.any():
                        refd = ref.read([1, 2, 3], window=w)
                        valid = filled & (refd.astype(np.int32).sum(0) > 0)
                        if valid.any():
                            diffs.append(float(np.abs(block[:3, valid].astype(np.int16) - refd[:, valid]).mean()))
                    n += 1
            tmp.replace(out)
        finally:
            for v in vrts:
                v.close()
            for s in srcs:
                s.close()
    return float(np.mean(diffs)) if diffs else float("nan")


def build_dem_layers(dem_path: Path, out: Path) -> None:
    with rasterio.open(dem_path) as src:
        dem = src.read(1).astype(np.float32)
        nodata = src.nodata
        profile = src.profile.copy()
        res = float(src.res[0])
    valid = np.isfinite(dem) if nodata is None else (np.isfinite(dem) & (dem != nodata))
    filled = dem.copy()
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        filled = dem[tuple(idx)]
    layers = [dem]
    for sigma_m in (2.0, 10.0):
        layers.append(filled - ndimage.gaussian_filter(filled, sigma_m / res))
    gy, gx = np.gradient(filled, res)  # rows run north to south
    slope = np.arctan(np.hypot(gx, gy))
    layers.append(np.degrees(slope).astype(np.float32))
    aspect = np.arctan2(-gx, gy)  # downslope direction, clockwise from north
    az, alt = math.radians(315.0), math.radians(45.0)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    layers.append(np.clip(shade, 0, 1).astype(np.float32))
    stack = np.stack(layers).astype(np.float32)
    stack[:, ~valid] = np.nan
    profile.update(count=len(layers), dtype="float32", nodata=np.nan, tiled=True, blockxsize=512, blockysize=512,
                   compress="deflate", predictor=3)
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(stack)
        for i, name in enumerate(DEM_BANDS, start=1):
            dst.set_band_description(i, name)


def load_features(site_dir: Path, crs) -> list[dict]:
    feats = []
    for path in sorted(site_dir.glob("features-*.geojson")):
        for f in json.loads(path.read_text(encoding="utf-8"))["features"]:
            props = f.get("properties") or {}
            ftype = props.get("type")
            geom = f.get("geometry")
            if ftype not in TYPE_CLASS or not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
                continue
            g = transform_geom("EPSG:4326", crs, geom)
            feats.append({"id": f.get("id"), "type": ftype, "cls": TYPE_CLASS[ftype], "holeId": props.get("holeId"),
                          "source": props.get("source"), "stackKey": float(props.get("stackKey") or 0),
                          "geom": g, "bounds": shape(g).bounds})
    feats.sort(key=lambda f: f["stackKey"])  # stable: equal keys keep sort_order
    for i, f in enumerate(feats, start=1):
        f["idx"] = i
    return feats


def build_instances(ref_path: Path, feats: list[dict], out_inst: Path, out_labels: Path) -> None:
    lut = np.zeros(len(feats) + 1, dtype=np.uint8)
    for f in feats:
        lut[f["idx"]] = f["cls"]
    with rasterio.open(ref_path) as ref:
        base = dict(driver="GTiff", width=ref.width, height=ref.height, count=1, crs=ref.crs, transform=ref.transform,
                    tiled=True, blockxsize=512, blockysize=512, compress="deflate", predictor=2)
        with rasterio.open(out_inst, "w", **base, dtype="uint16", nodata=0) as di, \
                rasterio.open(out_labels, "w", **base, dtype="uint8", nodata=0) as dl:
            for row in range(0, ref.height, BLOCK):
                w = Window(0, row, ref.width, min(BLOCK, ref.height - row))
                wb = window_bounds(w, ref.transform)
                shapes = [(f["geom"], f["idx"]) for f in feats if intersects(wb, f["bounds"])]
                if shapes:
                    arr = rfeatures.rasterize(shapes, out_shape=(int(w.height), int(w.width)),
                                              transform=window_transform(w, ref.transform), fill=0, dtype="uint16",
                                              merge_alg=MergeAlg.replace)
                else:
                    arr = np.zeros((int(w.height), int(w.width)), dtype=np.uint16)
                di.write(arr, 1, window=w)
                dl.write(lut[arr], 1, window=w)


def write_png(path: Path, rgb: np.ndarray) -> None:
    with rasterio.open(path, "w", driver="PNG", width=rgb.shape[2], height=rgb.shape[1], count=3, dtype="uint8") as d:
        d.write(rgb)


def stretch(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return (np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)


def write_previews(site_dir: Path, scale: int = 8) -> None:
    with rasterio.open(site_dir / "rgbi-2025.tif") as d:
        shp = (4, d.height // scale, d.width // scale)
        px = d.read(out_shape=shp, resampling=Resampling.average).astype(np.float32)
    write_png(site_dir / "preview-rgb.png", px[:3].astype(np.uint8))
    write_png(site_dir / "preview-cir.png", np.stack([px[3], px[0], px[1]]).astype(np.uint8))
    ndvi = (px[3] - px[0]) / np.maximum(px[3] + px[0], 1)
    g = stretch(ndvi, -0.2, 0.6)
    write_png(site_dir / "preview-ndvi.png", np.stack([255 - g, g, np.zeros_like(g)]))
    with rasterio.open(site_dir / "labels.tif") as d:
        lab = d.read(1, out_shape=(d.height // scale, d.width // scale), resampling=Resampling.mode)
    write_png(site_dir / "preview-labels.png", CLASS_RGB[lab].transpose(2, 0, 1))
    with rasterio.open(site_dir / "dem-layers.tif") as d:
        hs = d.read(5)
    write_png(site_dir / "preview-hillshade.png", np.repeat(stretch(np.nan_to_num(hs, nan=0.5), 0, 1)[None], 3, 0))


def prepare_site(site_id: str, force: bool, allow_download: bool) -> None:
    site_dir = OUT / site_id
    src_dir = DATA / "sources" / site_id
    ref_path = src_dir / f"ortho-orto-l2-{YEAR}.tif"
    dem_path = src_dir / "dem.tif"
    print(f"== {site_id}")
    report: dict = {"siteId": site_id, "year": YEAR, "classes": CLASSES, "demBands": DEM_BANDS,
                    "reference": str(ref_path.relative_to(REPO)), "dem": str(dem_path.relative_to(REPO))}
    with rasterio.open(ref_path) as ref:
        bounds, crs = tuple(ref.bounds), ref.crs
        report["grid"] = {"width": ref.width, "height": ref.height, "res": ref.res[0], "bounds": bounds}

    rgbi = site_dir / f"rgbi-{YEAR}.tif"
    if force or not rgbi.exists():
        t0 = time.time()
        tiles = fetch_tiles(bounds, crs, allow_download)
        report["tiles"] = [str(p) for p in tiles]
        report["rgbCheck"] = build_rgbi(ref_path, tiles, rgbi)
        print(f"  rgbi: {time.time() - t0:.0f} s, mean |RGB - reference| = {report['rgbCheck']:.2f}")
    layers = site_dir / "dem-layers.tif"
    if force or not layers.exists():
        build_dem_layers(dem_path, layers)
        print("  dem layers written")
    inst = site_dir / "instances.tif"
    feats = load_features(site_dir, crs)
    if force or not inst.exists():
        t0 = time.time()
        build_instances(ref_path, feats, inst, site_dir / "labels.tif")
        print(f"  instances: {len(feats)} surfaces in {time.time() - t0:.0f} s")
    (site_dir / "features.json").write_text(json.dumps(
        [{k: f[k] for k in ("idx", "id", "type", "cls", "holeId", "source", "stackKey")} for f in feats]))
    write_previews(site_dir)
    old = json.loads((site_dir / "ready.json").read_text()) if (site_dir / "ready.json").exists() else {}
    report = old | report | {"built": time.strftime("%Y-%m-%dT%H:%M:%S")}
    report["counts"] = {c: sum(1 for f in feats if f["cls"] == i) for i, c in enumerate(CLASSES) if i}
    (site_dir / "ready.json").write_text(json.dumps(report, indent=2))
    print(f"  ready: {site_dir / 'ready.json'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append", help="site id (default: every site export-labels.ts wrote)")
    ap.add_argument("--force", action="store_true", help="rebuild what exists")
    ap.add_argument("--no-download", action="store_true", help="only tiles already on disk")
    args = ap.parse_args()
    sites = args.site or sorted(p.parent.name for p in OUT.glob("*/features-*.geojson"))
    for site_id in dict.fromkeys(sites):
        prepare_site(site_id, args.force, not args.no_download)


if __name__ == "__main__":
    main()
