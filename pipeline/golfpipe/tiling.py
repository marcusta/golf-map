"""XYZ (Web Mercator, 256px) tile pyramid generation, shared by tile-ortho
and tile-terrain. Both cut tiles the same way (reproject source raster to
EPSG:3857 via WarpedVRT, resample each tile's window); they differ only in
how the resampled window becomes output bytes (JPEG passthrough of RGB vs.
Terrain-RGB encoding of a single elevation band).
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import mercantile
import numpy as np
import rasterio
from rasterio.warp import transform_bounds

from golfpipe.raster import WEB_MERCATOR, WGS84, is_all_nodata, read_window_bounds

TILE_SIZE = 256


def raster_bounds_wgs84(path: Path) -> tuple[float, float, float, float]:
    with rasterio.open(path) as src:
        return transform_bounds(src.crs, WGS84, *src.bounds)


def tiles_for_bbox(bbox_wgs84: tuple[float, float, float, float], minzoom: int, maxzoom: int):
    """Yields mercantile.Tile objects covering bbox_wgs84 for each zoom
    level in [minzoom, maxzoom].
    """
    west, south, east, north = bbox_wgs84
    for z in range(minzoom, maxzoom + 1):
        yield from mercantile.tiles(west, south, east, north, [z])


def pyramid_bounds_3857(
    bbox_wgs84: tuple[float, float, float, float], minzoom: int, maxzoom: int
) -> tuple[float, float, float, float]:
    """Union of the EPSG:3857 bounds of every XYZ tile in the pyramid for
    bbox_wgs84 across [minzoom, maxzoom]. Used to size a WarpedVRT's
    virtual extent so windowed reads for every tile stay in-bounds.
    """
    lefts, bottoms, rights, tops = [], [], [], []
    for tile in tiles_for_bbox(bbox_wgs84, minzoom, maxzoom):
        b = mercantile.xy_bounds(tile)
        lefts.append(b.left)
        bottoms.append(b.bottom)
        rights.append(b.right)
        tops.append(b.top)
    return (min(lefts), min(bottoms), max(rights), max(tops))


def generate_tile_pyramid(
    vrt,
    bbox_wgs84: tuple[float, float, float, float],
    minzoom: int,
    maxzoom: int,
    out_dir: Path,
    encode_tile: Callable[[np.ndarray], bytes | None],
    file_ext: str,
) -> int:
    """Core tiling loop: for every XYZ tile in range covering bbox_wgs84,
    reads the corresponding window from `vrt` (already reprojected to
    EPSG:3857), calls encode_tile(data) -> bytes to produce file content,
    and writes it to out_dir/{z}/{x}/{y}.{file_ext}.

    encode_tile should return None to signal "skip this tile" (e.g.
    fully-nodata ortho tiles). Returns the number of tiles written.
    """
    written = 0
    for tile in tiles_for_bbox(bbox_wgs84, minzoom, maxzoom):
        bounds_3857 = mercantile.xy_bounds(tile)
        data = read_window_bounds(
            vrt,
            (bounds_3857.left, bounds_3857.bottom, bounds_3857.right, bounds_3857.top),
            TILE_SIZE,
        )

        encoded = encode_tile(data)
        if encoded is None:
            continue

        tile_path = out_dir / str(tile.z) / str(tile.x) / f"{tile.y}.{file_ext}"
        tile_path.parent.mkdir(parents=True, exist_ok=True)
        tile_path.write_bytes(encoded)
        written += 1

    return written


def nodata_skip(data, nodata) -> bool:
    return is_all_nodata(data, nodata)
