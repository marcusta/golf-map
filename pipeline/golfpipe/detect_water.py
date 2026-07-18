"""Water polygons from class-9 lidar returns (detect-water).

The Marktäcke vector entitlement (fetch-water's source) is not active on the
account, so this derives DRAFT water polygons from the classified Laserdata
Skog point cloud instead — the signal is per-cell PRESENCE of class-9
(water) points, not height. Water absorbs NIR, so returns over open water
are sparse: after thresholding presence >= 1 point/cell, a GENEROUS binary
closing (default ~3 m radius, --closing-radius) inflates the sparse hits
into contiguous water bodies, then a small binary opening kills isolated
stray returns; 8-connected polygonization, min-area filtering (default
50 m² — ponds, not puddles) and simplification are the shared
detect_common steps detect-trees also uses.

Flatness sanity check (report-only, never filters): real standing water is
flat, so a per-polygon spread of the class-9 cell mean heights above
~0.3 m suggests misclassified noise — the command prints a warning but
keeps the polygon.

Known limitation: creeks rarely carry class-9 returns, so `water_creek` is
out of scope here — fetch-water stays the source for creeks once the
Marktäcke entitlement is activated.

Output convention (shared with fetch-water / fetch-osm / detect-trees):
EPSG:3006 FeatureCollection, legacy `crs` member, `properties.type` =
'water'. Fully offline — input is local LAS/LAZ/COPC files from
fetch-lidar.
"""

from __future__ import annotations

import numpy as np
import rasterio.features
from scipy.ndimage import binary_closing, binary_opening
from shapely.geometry.base import BaseGeometry

from golfpipe.detect_common import (
    LASERDATA_ATTRIBUTION,
    STRUCTURE_8,
    build_feature_collection,
)

WATER_CLASSES = (9,)

DEFAULT_CLOSING_RADIUS_M = 3.0
DEFAULT_MIN_AREA_M2 = 50.0
DEFAULT_SIMPLIFY_TOLERANCE_M = 0.5
DEFAULT_FLATNESS_SPREAD_M = 0.3

ATTRIBUTION = LASERDATA_ATTRIBUTION


def disk_structure(radius_cells: int) -> np.ndarray:
    """Circular boolean structuring element of the given radius (in cells)
    for the generous closing — a disk, not a block, so the bridged shape
    stays round-ish instead of growing square corners.
    """
    r = max(1, int(radius_cells))
    yy, xx = np.ogrid[-r : r + 1, -r : r + 1]
    return (xx * xx + yy * yy) <= r * r


def water_mask(
    count_grid: np.ndarray,
    resolution: float,
    closing_radius_m: float = DEFAULT_CLOSING_RADIUS_M,
) -> np.ndarray:
    """Boolean water mask from the class-9 count grid: presence (>= 1 point
    per cell), generous binary closing (bridges the sparse-return gaps so a
    pond becomes one body), then a small 3x3 opening (kills lone stray
    class-9 returns the closing could not merge into anything).
    """
    presence = count_grid > 0
    radius_cells = max(1, int(round(closing_radius_m / resolution)))
    mask = binary_closing(presence, structure=disk_structure(radius_cells))
    mask = binary_opening(mask, structure=STRUCTURE_8)
    return mask


def flatness_spreads(
    polygons: list[BaseGeometry],
    sum_grid: np.ndarray,
    count_grid: np.ndarray,
    transform: "rasterio.Affine",
) -> list[float]:
    """Per-polygon z-spread (max - min, metres) of the class-9 cell MEAN
    heights inside the polygon. Standing water is flat, so a large spread
    flags misclassified noise. Report-only: the caller prints warnings and
    keeps every polygon (never filters silently). Polygons that cover no
    populated cell report 0.0.
    """
    populated = count_grid > 0
    mean = np.zeros(count_grid.shape, dtype=np.float64)
    mean[populated] = sum_grid[populated] / count_grid[populated]

    spreads: list[float] = []
    for polygon in polygons:
        inside = rasterio.features.geometry_mask(
            [polygon], out_shape=count_grid.shape, transform=transform,
            invert=True, all_touched=True,
        )
        cells = inside & populated
        if not cells.any():
            spreads.append(0.0)
            continue
        z = mean[cells]
        spreads.append(float(z.max() - z.min()))
    return spreads


def build_water_geojson(polygons: list[BaseGeometry]) -> dict:
    """Builds the EPSG:3006 FeatureCollection: one 'water' feature per
    polygon, importable by the web GeoJSON draft-import wizard (same shape
    as fetch-water / fetch-osm / detect-trees output).
    """
    return build_feature_collection(polygons, "water", "lidar-class9", ATTRIBUTION)
