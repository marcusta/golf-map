"""Tree-canopy polygons from classified COPC lidar (detect-trees).

Laserdata Skog typically does NOT classify vegetation — high vegetation
comes back as class 1 (unclassified) — so class codes can't select trees.
Instead this derives a normalized digital surface model (nDSM):

    ground grid  = mean z of ground/water returns (DEFAULT_CLASSES, the
                   same grid_lidar_points/build_dem_grid path grid-dem uses)
    surface grid = MAX z per cell over ALL returns except noise (7/18)
    nDSM         = surface - ground   (height above ground, metres)

Cells with nDSM >= min_height are canopy candidates. Laserdata Skog is only
~1-2 pts/m², so even under solid forest a sizable fraction of cells has no
surface return at all and the raw mask is salt-and-pepper. scipy.ndimage
binary CLOSING therefore runs FIRST (bridges those sampling holes and
dissolves adjacent crowns — 8-connected rasterio.features.shapes afterwards
yields merged crown polygons directly, interior clearings as holes), then
binary OPENING kills what's left of isolated noise. (Opening-first was the
original order and annihilated real sparse forest: a 3x3 erosion needs a
full 9-cell true neighborhood, ~0.65^9 ≈ 2% survival at real point
densities.) A min-area filter drops specks and shapely simplification thins
the stairstep cell outlines.

Output convention (shared with fetch-water / fetch-osm, consumed by the web
GeoJSON draft-import wizard): a GeoJSON FeatureCollection in EPSG:3006 with
a legacy `crs` member and `properties.type` = 'trees'.

The steps after the canopy mask (polygonize -> min-area -> simplify ->
GeoJSON writer) live in detect_common.py, shared with detect-water.

Everything is offline-testable: input is local LAS/LAZ/COPC files that
cmd_fetch_lidar already downloaded — no network in this module at all.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import binary_closing, binary_opening
from shapely.geometry.base import BaseGeometry

from golfpipe.detect_common import (
    LASERDATA_ATTRIBUTION,
    STRUCTURE_8,
    build_feature_collection,
    filter_and_simplify,
    mask_to_polygons,
)

__all__ = [
    "NOISE_CLASSES", "DEFAULT_MIN_HEIGHT_M", "DEFAULT_MIN_AREA_M2",
    "DEFAULT_SIMPLIFY_TOLERANCE_M", "DEFAULT_RESOLUTION", "NODATA",
    "ATTRIBUTION", "NdsmStats",
    "build_ndsm", "canopy_mask", "mask_to_polygons", "filter_and_simplify",
    "build_trees_geojson",
]

# Laserdata Skog noise codes excluded from the max-z surface: 7 = low noise,
# 18 = high noise (birds, atmospheric returns).
NOISE_CLASSES = (7, 18)

DEFAULT_MIN_HEIGHT_M = 2.0
DEFAULT_MIN_AREA_M2 = 25.0
DEFAULT_SIMPLIFY_TOLERANCE_M = 0.5
# detect-trees grids at 1.0 m — NOT grid-dem's 0.5 m default. At ~1-2 pts/m²
# (Laserdata Skog), a 0.5 m cell is 0.25 m² and ~30-40% of forest cells hold
# no surface return; 1 m² cells keep the raw canopy mask mostly solid.
DEFAULT_RESOLUTION = 1.0

NODATA = -9999.0

ATTRIBUTION = LASERDATA_ATTRIBUTION


@dataclass
class NdsmStats:
    """Diagnostics for cmd_detect_trees to report."""

    ground_points: int = 0
    surface_points: int = 0
    canopy_cells_raw: int = 0
    canopy_cells_cleaned: int = 0


def build_ndsm(ground_dem: np.ndarray, surface_max: np.ndarray, surface_count: np.ndarray) -> np.ndarray:
    """nDSM (height above ground, metres, float64) from a finished ground
    DEM (build_dem_grid output, NODATA where empty) and the max-z surface
    accumulators (grid_lidar_points aggregate="max": -inf where no return).

    Cells with no surface return or no ground reference get 0 (no canopy —
    never a canopy candidate), and negative heights (surface below the
    interpolated ground, e.g. water) clamp to 0.
    """
    ground = ground_dem.astype(np.float64)
    valid = (surface_count > 0) & (ground != NODATA)
    ndsm = np.zeros(ground.shape, dtype=np.float64)
    ndsm[valid] = np.maximum(surface_max[valid] - ground[valid], 0.0)
    return ndsm


def canopy_mask(ndsm: np.ndarray, min_height_m: float = DEFAULT_MIN_HEIGHT_M) -> np.ndarray:
    """Thresholds the nDSM at min_height_m, then binary CLOSING first
    (bridges the per-cell sampling holes sparse lidar leaves in real forest
    and merges adjacent crowns), then binary OPENING (removes what's left of
    isolated noise). Returns a boolean canopy mask.

    Order matters: at ~1-2 pts/m² the raw forest mask is salt-and-pepper
    (~30-40% empty cells), and opening FIRST erodes it to nearly nothing
    (a 3x3 erosion needs a full true neighborhood — ~0.65^9 ≈ 2% survival);
    closing must run first to consolidate the mask.
    """
    mask = ndsm >= min_height_m
    mask = binary_closing(mask, structure=STRUCTURE_8)
    mask = binary_opening(mask, structure=STRUCTURE_8)
    return mask


def build_trees_geojson(polygons: list[BaseGeometry]) -> dict:
    """Builds the EPSG:3006 FeatureCollection: one 'trees' feature per
    polygon (holes preserved), importable by the web GeoJSON draft-import
    wizard (same shape as fetch-water / fetch-osm output).
    """
    return build_feature_collection(polygons, "trees", "lidar-ndsm", ATTRIBUTION)
