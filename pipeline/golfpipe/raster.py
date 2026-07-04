"""Shared raster helpers: mosaicking, cropping to a WGS84 bbox, and
reprojection to Web Mercator via WarpedVRT. All GDAL access goes through
rasterio (bundled GDAL) — no system GDAL / gdalwarp / gdal_translate calls.
"""

from __future__ import annotations

import tempfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.merge import merge as rio_merge
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds
from rasterio.windows import from_bounds as window_from_bounds

WEB_MERCATOR = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)


def mosaic_and_crop(
    source_paths: list[Path],
    bbox_wgs84: tuple[float, float, float, float],
    out_path: Path,
    buffer_m: float = 0.0,
) -> Path:
    """Mosaics one or more GeoTIFFs (assumed same CRS) and crops to the given
    WGS84 bbox (with an optional buffer in the mosaic's own CRS units,
    which is metres for EPSG:3006), writing the result to out_path.

    If there is exactly one source and no crop/buffer is needed, this still
    normalizes through rasterio so the output is a clean single-band or
    multi-band GeoTIFF with a well-formed profile.
    """
    if not source_paths:
        raise ValueError("mosaic_and_crop requires at least one source raster")

    srcs = [rasterio.open(p) for p in source_paths]
    try:
        crs = srcs[0].crs
        # Reproject the WGS84 bbox into the mosaic CRS to compute the crop window.
        west, south, east, north = transform_bounds(WGS84, crs, *bbox_wgs84)
        if buffer_m:
            west -= buffer_m
            south -= buffer_m
            east += buffer_m
            north += buffer_m

        mosaic, transform = rio_merge(srcs, bounds=(west, south, east, north))

        profile = srcs[0].profile.copy()
        profile.update(
            height=mosaic.shape[1],
            width=mosaic.shape[2],
            transform=transform,
            count=mosaic.shape[0],
        )

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with rasterio.open(out_path, "w", **profile) as dst:
            dst.write(mosaic)
    finally:
        for s in srcs:
            s.close()

    return out_path


@contextmanager
def edge_pad_dem(input_path: Path, pad_m: float):
    """Yields a path to a copy of the single-band DEM at input_path, grown
    on all four sides by `pad_m` metres (converted to whole pixels via the
    source transform) using edge-replicated padding (numpy `mode="edge"`:
    the outermost row/column of real values is repeated outward).

    This exists to fix the terrain "cliff wall" artifact: a DEM's real
    coverage is normally smaller than the XYZ tile pyramid's bounds (tile
    grids rarely align to source extent), so open_warped_to_mercator grows
    the WarpedVRT's virtual extent to cover the pyramid and GDAL fills that
    grown area with nodata — which cmd_tile_terrain then 0-fills at encode
    time, producing a 40-90 m sea-level cliff ringing real terrain.
    Pre-padding the source DEM with plausible (edge-replicated) heights
    *before* tiling means boundary/overlap tiles sample real-ish elevation
    instead of 0 m, without touching the tile pyramid enumeration or the
    manifest bounds — both of those must stay derived from the *original*
    (unpadded) DEM, since the padding is a tiling implementation detail,
    not real surveyed coverage.

    If pad_m <= 0, yields input_path unchanged (no-op).
    """
    if pad_m <= 0:
        yield input_path
        return

    with rasterio.open(input_path) as src:
        if src.count != 1:
            raise ValueError(f"edge_pad_dem expects a single-band DEM, got {src.count} bands")

        transform = src.transform
        pixel_size_x = abs(transform.a)
        pixel_size_y = abs(transform.e)
        pad_x = max(0, int(round(pad_m / pixel_size_x)))
        pad_y = max(0, int(round(pad_m / pixel_size_y)))

        data = src.read(1)
        padded = np.pad(data, ((pad_y, pad_y), (pad_x, pad_x)), mode="edge")

        # Grow the transform to match: the new origin moves pad_x pixels
        # west and pad_y pixels north of the original origin.
        new_transform = transform * Affine.translation(-pad_x, -pad_y)

        profile = src.profile.copy()
        profile.pop("blockxsize", None)
        profile.pop("blockysize", None)
        profile.pop("tiled", None)
        profile.update(
            height=padded.shape[0],
            width=padded.shape[1],
            transform=new_transform,
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        padded_path = Path(tmpdir) / "edge_padded.tif"
        with rasterio.open(padded_path, "w", **profile) as dst:
            dst.write(padded, 1)
        yield padded_path


def open_warped_to_mercator(
    path: Path,
    resampling,
    extra_bounds_3857: tuple[float, float, float, float] | None = None,
) -> WarpedVRT:
    """Opens a raster wrapped in a WarpedVRT reprojecting it to EPSG:3857
    on the fly, for tiling. Caller is responsible for closing the VRT (and
    the underlying dataset it wraps stays open for its lifetime).

    rasterio's WarpedVRT does not support boundless reads, so tile windows
    that straddle the edge of the source data's reprojected extent (very
    common — tile grids are rarely pixel-aligned to the source raster)
    would otherwise raise. To avoid that, when extra_bounds_3857 is given
    the VRT's own virtual extent is grown to at least cover those bounds
    (union with the source's natural extent); GDAL fills the grown area
    with nodata, and ordinary (non-boundless) windowed reads then work for
    every tile in the pyramid.
    """
    src = rasterio.open(path)

    if extra_bounds_3857 is None:
        return WarpedVRT(src, crs=WEB_MERCATOR, resampling=resampling)

    natural_transform, natural_width, natural_height = calculate_default_transform(
        src.crs, WEB_MERCATOR, src.width, src.height, *src.bounds
    )
    nat_left = natural_transform.c
    nat_top = natural_transform.f
    nat_right = nat_left + natural_transform.a * natural_width
    nat_bottom = nat_top + natural_transform.e * natural_height
    # natural_transform.e is negative (north-up), so nat_bottom < nat_top.

    ext_left, ext_bottom, ext_right, ext_top = extra_bounds_3857

    left = min(nat_left, ext_left)
    right = max(nat_right, ext_right)
    bottom = min(nat_bottom, ext_bottom)
    top = max(nat_top, ext_top)

    pixel_size_x = natural_transform.a
    pixel_size_y = -natural_transform.e
    width = max(natural_width, int(round((right - left) / pixel_size_x)))
    height = max(natural_height, int(round((top - bottom) / pixel_size_y)))

    transform = Affine(pixel_size_x, 0.0, left, 0.0, -pixel_size_y, top)

    return WarpedVRT(
        src,
        crs=WEB_MERCATOR,
        resampling=resampling,
        transform=transform,
        width=width,
        height=height,
    )


def read_window_bounds(vrt, bounds_3857: tuple[float, float, float, float], out_size: int):
    """Reads a resampled out_size x out_size window from a WarpedVRT for
    the given EPSG:3857 bounds (left, bottom, right, top). Returns an array
    shaped (bands, out_size, out_size). Requires the VRT's virtual extent
    to already cover bounds_3857 (see open_warped_to_mercator's
    extra_bounds_3857) since WarpedVRT reads cannot be boundless.
    """
    window = window_from_bounds(*bounds_3857, transform=vrt.transform)
    data = vrt.read(
        window=window,
        out_shape=(vrt.count, out_size, out_size),
    )
    return data


def is_all_nodata(data: np.ndarray, nodata) -> bool:
    if nodata is None:
        # No nodata defined: treat all-zero as empty for RGB tiles.
        return bool(np.all(data == 0))
    return bool(np.all(data == nodata))
