"""Canopy height rasters from classified COPC lidar (canopy command).

Builds on detect_trees' nDSM (ground = mean z of DEFAULT_CLASSES returns,
surface = max z of every non-noise return, nDSM = surface - ground) and
turns it into a per-cell canopy HEIGHT raster rather than crown polygons:

1. Building suppression. Laserdata Skog has no building class, so roofs
   show up in the nDSM exactly like crowns. Laser pulses that hit a roof
   return once; pulses into foliage split into several returns. Cells with
   nDSM >= 2 m whose fraction of multi-return points is under 10 % are
   treated as roofs and zeroed (suppress_buildings).
2. Clamp to [0, 40] m, drop cells under 1 m, binary closing (3x3,
   8-connected) of the >= 1 m mask to bridge sampling holes (cells the
   closing fills take the max of their 3x3 neighbourhood), then a 3 m
   radius maximum filter (7x7 at 1 m) over the masked heights, multiplied
   back by the closed mask, so each canopy cell holds its crown top and
   the footprint stays equal to the closed mask (clean_canopy).
3. A display colour ramp by height (canopy_color_rgba) for the
   `canopy-color` tile layer; transparent below 1 m.
4. Crown shaping for the `surface` DSM only (crown_shape). The cleaned
   canopy is a set of flat plateaus with 1 m vertical walls (the 7x7 max
   filter clipped to the footprint), which renders as mesas when draped in
   3D. crown_shape tapers each footprint toward its edge with a sqrt
   shoulder over CROWN_TAPER_RADIUS_M (or the crown's own half-width when
   smaller, so a lone spike keeps its top), dips the plateau between the
   raw nDSM's local maxima when the pre-filter nDSM is given, and smooths
   with a footprint-normalised Gaussian (CROWN_BLUR_SIGMA_M). Nothing
   leaks outside the footprint and no cell exceeds 1.02x its input. The
   `canopy` layer (height-above-ground queries) never goes through this.

Everything here is pure numpy/scipy on in-memory grids; the command in
commands.py does the lidar gridding, GeoTIFF writes and tiling.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from scipy.ndimage import binary_closing, distance_transform_edt, gaussian_filter, maximum_filter

from golfpipe.detect_common import STRUCTURE_8
from golfpipe.detect_trees import NODATA

__all__ = [
    "MIN_CANOPY_HEIGHT_M", "MAX_CANOPY_HEIGHT_M", "BUILDING_MIN_HEIGHT_M",
    "BUILDING_MAX_MULTI_FRACTION", "CROWN_FILTER_SIZE", "COLOR_STOPS",
    "CROWN_TAPER_RADIUS_M", "CROWN_BLUR_SIGMA_M", "CROWN_MAX_GAIN", "CROWN_PLATEAU_DIP",
    "suppress_buildings", "clean_canopy", "crown_shape", "canopy_color_rgba", "resample_dem_to_grid",
]

MIN_CANOPY_HEIGHT_M = 1.0
MAX_CANOPY_HEIGHT_M = 40.0
BUILDING_MIN_HEIGHT_M = 2.0
BUILDING_MAX_MULTI_FRACTION = 0.10
# 3 m radius at 1 m resolution: 7x7 window.
CROWN_FILTER_SIZE = 7
# crown_shape (surface DSM only): edge taper radius, Gaussian sigma, the
# cap on any cell relative to its input, and how far the plateau may dip
# between raw-nDSM local maxima (0.25 = down to 75 % of the crown top).
CROWN_TAPER_RADIUS_M = 4.0
CROWN_BLUR_SIGMA_M = 1.0
CROWN_MAX_GAIN = 1.02
CROWN_PLATEAU_DIP = 0.25

# (height m, (R, G, B)); linear interpolation between stops, clamped at the
# ends. Below the first stop the pixel is fully transparent.
COLOR_STOPS: tuple[tuple[float, tuple[int, int, int]], ...] = (
    (1.0, (255, 255, 0)),
    (8.0, (255, 140, 0)),
    (15.0, (230, 30, 30)),
    (25.0, (200, 0, 200)),
    (35.0, (80, 40, 255)),
)


def suppress_buildings(
    ndsm: np.ndarray,
    point_count: np.ndarray,
    multi_return_count: np.ndarray,
    min_height_m: float = BUILDING_MIN_HEIGHT_M,
    max_multi_fraction: float = BUILDING_MAX_MULTI_FRACTION,
) -> np.ndarray:
    """Zeroes nDSM cells that look like roofs: height >= min_height_m and
    (multi-return points / all points) < max_multi_fraction. Cells with no
    points are left alone (their nDSM is already 0). Returns a new array.
    """
    out = np.array(ndsm, dtype=np.float64, copy=True)
    has_points = point_count > 0
    fraction = np.zeros(ndsm.shape, dtype=np.float64)
    fraction[has_points] = multi_return_count[has_points] / point_count[has_points]
    roof = has_points & (out >= min_height_m) & (fraction < max_multi_fraction)
    out[roof] = 0.0
    return out


def clean_canopy(
    ndsm: np.ndarray,
    min_height_m: float = MIN_CANOPY_HEIGHT_M,
    max_height_m: float = MAX_CANOPY_HEIGHT_M,
    filter_size: int = CROWN_FILTER_SIZE,
) -> np.ndarray:
    """Clamps to [0, max_height_m], drops cells below min_height_m, closes
    the canopy mask (3x3, 8-connected) filling bridged cells with their 3x3
    neighbourhood max, then applies a filter_size maximum filter to the
    masked heights and multiplies the result by the closed mask, so every
    canopy cell holds its local crown top and cells outside the closed
    mask stay 0 (the footprint equals the closed mask). Returns float32.
    """
    h = np.clip(np.nan_to_num(np.asarray(ndsm, dtype=np.float64), nan=0.0), 0.0, max_height_m)
    h[h < min_height_m] = 0.0

    mask = h >= min_height_m
    closed = binary_closing(mask, structure=STRUCTURE_8)
    filled = closed & ~mask
    if filled.any():
        local_max = maximum_filter(h, size=3, mode="constant", cval=0.0)
        h[filled] = local_max[filled]
    h[~(closed | mask)] = 0.0

    # Max filter over the masked heights, then restricted to the closed
    # mask: canopy cells take their local crown top, cells outside the
    # canopy stay 0 (a lone spike stays a single cell at its own height).
    footprint = closed | mask
    crown = maximum_filter(h, size=filter_size, mode="constant", cval=0.0) * footprint
    return crown.astype(np.float32)


def crown_shape(
    canopy_h: np.ndarray,
    cell_size: float,
    ndsm: np.ndarray | None = None,
    taper_radius_m: float = CROWN_TAPER_RADIUS_M,
    blur_sigma_m: float = CROWN_BLUR_SIGMA_M,
    max_gain: float = CROWN_MAX_GAIN,
    plateau_dip: float = CROWN_PLATEAU_DIP,
) -> np.ndarray:
    """Rounds the cleaned canopy plateaus into crown-like shapes for the
    surface DSM. Steps, all inside the footprint (canopy_h > 0):

    1. d = distance from the cell centre to the footprint edge in metres
       (distance_transform_edt - 0.5 cells, so edge cells sit at half a
       cell, not 0). factor = sqrt(clip(d / r, 0, 1)) with r =
       min(taper_radius_m, the footprint's local half-width), so edge
       cells of a broad crown drop to ~35 % and a 1-cell spike (half-width
       0.5) keeps 100 %.
    2. If the pre-max-filter `ndsm` is given, cells between its local
       maxima dip: factor *= 1 - plateau_dip * (1 - smooth_ndsm / canopy_h).
    3. Footprint-normalised Gaussian blur (sigma blur_sigma_m):
       blur(h * fp) / blur(fp), so heights never bleed onto fairways and an
       isolated cell is left exactly at its own height.
    4. Re-mask to the footprint and clamp to max_gain * canopy_h.

    Returns float32, same shape. Cells outside the footprint are 0.
    """
    h = np.nan_to_num(np.asarray(canopy_h, dtype=np.float64), nan=0.0)
    fp = h > 0.0
    if not fp.any():
        return np.zeros(h.shape, dtype=np.float32)

    d = (distance_transform_edt(fp) - 0.5) * cell_size
    d = np.clip(d, 0.0, None)
    window = 2 * int(np.ceil(taper_radius_m / cell_size)) + 1
    half_width = maximum_filter(d, size=window, mode="constant", cval=0.0)
    r = np.maximum(np.minimum(taper_radius_m, half_width), 0.5 * cell_size)
    factor = np.sqrt(np.clip(d / r, 0.0, 1.0))

    sigma_cells = blur_sigma_m / cell_size
    fp_f = fp.astype(np.float64)
    fp_blur = gaussian_filter(fp_f, sigma=sigma_cells, mode="constant", cval=0.0)

    if ndsm is not None and plateau_dip > 0.0:
        raw = np.nan_to_num(np.asarray(ndsm, dtype=np.float64), nan=0.0)
        raw = np.clip(raw, 0.0, None) * fp_f
        smooth = np.zeros(h.shape, dtype=np.float64)
        num = gaussian_filter(raw, sigma=sigma_cells, mode="constant", cval=0.0)
        smooth[fp] = num[fp] / fp_blur[fp]
        ratio = np.ones(h.shape, dtype=np.float64)
        ratio[fp] = np.clip(smooth[fp] / h[fp], 0.0, 1.0)
        factor = factor * (1.0 - plateau_dip * (1.0 - ratio))

    tapered = h * factor * fp_f
    blurred = gaussian_filter(tapered, sigma=sigma_cells, mode="constant", cval=0.0)
    out = np.zeros(h.shape, dtype=np.float64)
    out[fp] = blurred[fp] / fp_blur[fp]
    out = np.minimum(out, h * max_gain)
    out[~fp] = 0.0
    return out.astype(np.float32)


def canopy_color_rgba(heights: np.ndarray, stops=COLOR_STOPS) -> np.ndarray:
    """Colours a 2D height array (metres) into an (H, W, 4) uint8 RGBA
    array: transparent below the first stop, otherwise the ramp colour
    with alpha 255. Heights above the last stop take the last colour.
    """
    h = np.nan_to_num(np.asarray(heights, dtype=np.float64), nan=0.0)
    xs = np.array([s[0] for s in stops], dtype=np.float64)
    rgb = np.array([s[1] for s in stops], dtype=np.float64)

    out = np.zeros(h.shape + (4,), dtype=np.uint8)
    drawn = h >= xs[0]
    if not drawn.any():
        return out
    hv = np.clip(h[drawn], xs[0], xs[-1])
    for band in range(3):
        out[..., band][drawn] = np.round(np.interp(hv, xs, rgb[:, band])).astype(np.uint8)
    out[..., 3][drawn] = 255
    return out


def resample_dem_to_grid(
    dem_path: Path,
    transform,
    shape: tuple[int, int],
    crs="EPSG:3006",
    nodata: float = NODATA,
) -> np.ndarray:
    """Bilinearly resamples the DEM GeoTIFF onto the canopy grid (transform,
    shape, crs). Cells outside the DEM's coverage hold `nodata`. Returns
    float64.
    """
    height, width = shape
    with rasterio.open(dem_path) as src:
        with WarpedVRT(
            src,
            crs=crs,
            transform=transform,
            width=width,
            height=height,
            resampling=Resampling.bilinear,
            nodata=src.nodata if src.nodata is not None else nodata,
        ) as vrt:
            data = vrt.read(1).astype(np.float64)
            vrt_nodata = vrt.nodata
    if vrt_nodata is not None:
        data[data == vrt_nodata] = nodata
    data[~np.isfinite(data)] = nodata
    return data
