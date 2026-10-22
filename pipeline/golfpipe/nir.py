"""The photo's near-infrared band, kept beside the RGB ortho as `<ortho stem>.nir.tif`.

Lantmäteriet's ortho items are RGBI; the map build keeps RGB for the tiles (`cmd_fetch_ortho`), and now writes the
fourth band next to it on the same grid (`split_nir`). `build_nir` makes the file for a site built before that: the
vintage's items found again (a local copy in `tile_dirs` first, else downloaded into `workdir` and deleted after),
band 4 warped onto the exact grid of the RGB ortho, block by block. NIR is what tells sand from grass
(`bunker_proposals.py`) and feeds the surface model (`surface_model.py`).
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_bounds
from rasterio.windows import Window, bounds as window_bounds

from . import stac

BLOCK = 2048


def nir_path(ortho_path: Path) -> Path:
    return ortho_path.with_name(f"{ortho_path.stem}.nir.tif")


def _profile(ref) -> dict:
    return dict(driver="GTiff", width=ref.width, height=ref.height, count=1, dtype="uint8", crs=ref.crs,
                transform=ref.transform, tiled=True, blockxsize=512, blockysize=512, compress="deflate", predictor=2,
                BIGTIFF="IF_SAFER")


def split_nir(path: Path) -> Path | None:
    """Band 4 of a freshly mosaicked RGBI ortho into `<stem>.nir.tif` (same grid). None when it has no band 4."""
    with rasterio.open(path) as src:
        if src.count < 4:
            return None
        out = nir_path(path)
        with rasterio.open(out, "w", **_profile(src)) as dst:
            for _, w in src.block_windows(1):
                dst.write(src.read(4, window=w), 1, window=w)
    return out


def _local(item_id: str, tile_dirs: list[Path]) -> Path | None:
    for d in tile_dirs:
        for p in glob.glob(str(d / f"{item_id}.tif")) + glob.glob(str(d / "*" / f"{item_id}.tif")):
            try:
                with rasterio.open(p) as t:
                    if t.count >= 4:
                        return Path(p)
            except rasterio.RasterioIOError:
                continue
    return None


def fetch_nir(ref_path: Path, collection: str, tile_dirs: list[Path], workdir: Path,
              allow_download: bool = True) -> dict:
    """`build_nir` from the vintage's RGBI items: a local copy in `tile_dirs` first, else downloaded into `workdir`
    and deleted afterwards."""
    with rasterio.open(ref_path) as ref:
        wgs = transform_bounds(ref.crs, "EPSG:4326", *ref.bounds)
    items = [it for it in stac.search(stac.ORTHO_STAC_URL, wgs, collections=[collection], limit=100)
             if it.collection == collection]
    if not items:
        raise SystemExit(f"no {collection} ortho items cover {ref_path.name}")
    sources, downloaded = [], []
    try:
        for it in items:
            p = _local(it.id, tile_dirs)
            if p is None:
                if not allow_download:
                    raise SystemExit(f"{it.id} is not on disk and downloads are off")
                workdir.mkdir(parents=True, exist_ok=True)
                p = workdir / f"{it.id}.tif"
                print(f"downloading {it.id} ...", flush=True)
                stac.download_asset(it.data_href, p)
                downloaded.append(p)
            sources.append((it.id, p))
        return build_nir(ref_path, sources) | {"downloaded": len(downloaded)}
    finally:
        for p in downloaded:
            p.unlink(missing_ok=True)


def build_nir(ref_path: Path, sources: list[tuple[str, Path]]) -> dict:
    """Write `<ref stem>.nir.tif` on the grid of the RGB ortho `ref_path`: band 4 of the RGBI `sources` (id, path)
    warped onto it. Returns a report: the sources and `rgbCheck` = mean |RGB of the sources - RGB of the ortho|
    (0-255) over sampled blocks, which stays near 0 when the NIR lines up."""
    out = nir_path(ref_path)
    tmp = out.with_suffix(".tif.part")
    diffs = []
    try:
        with rasterio.open(ref_path) as ref:
            srcs = [rasterio.open(p) for _, p in sources]
            vrts = [WarpedVRT(s, crs=ref.crs, transform=ref.transform, width=ref.width, height=ref.height,
                              resampling=Resampling.bilinear, add_alpha=True) for s in srcs]
            try:
                with rasterio.open(tmp, "w", **_profile(ref)) as dst:
                    n = 0
                    for row in range(0, ref.height, BLOCK):
                        for col in range(0, ref.width, BLOCK):
                            w = Window(col, row, min(BLOCK, ref.width - col), min(BLOCK, ref.height - row))
                            wb = window_bounds(w, ref.transform)
                            nir = np.zeros((int(w.height), int(w.width)), dtype=np.uint8)
                            rgb = np.zeros((3, int(w.height), int(w.width)), dtype=np.uint8)
                            filled = np.zeros(nir.shape, dtype=bool)
                            for s, v in zip(srcs, vrts):
                                b = s.bounds
                                if not (wb[0] < b.right and b.left < wb[2] and wb[1] < b.top and b.bottom < wb[3]):
                                    continue
                                data = v.read(window=w)
                                take = (data[-1] > 0) & ~filled
                                nir[take] = data[3][take]
                                rgb[:, take] = data[:3, take]
                                filled |= take
                            dst.write(nir, 1, window=w)
                            if n % 3 == 0 and filled.any():
                                refd = ref.read([1, 2, 3], window=w)
                                valid = filled & (refd.astype(np.int32).sum(0) > 0)
                                if valid.any():
                                    diffs.append(float(np.abs(rgb[:, valid].astype(np.int16) - refd[:, valid]).mean()))
                            n += 1
            finally:
                for v in vrts:
                    v.close()
                for s in srcs:
                    s.close()
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    return {"out": str(out), "items": [{"id": i, "from": str(p)} for i, p in sources],
            "rgbCheck": float(np.mean(diffs)) if diffs else None}
