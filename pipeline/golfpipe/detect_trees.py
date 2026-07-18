"""Tree-canopy polygons from classified COPC lidar (detect-trees).

Laserdata Skog typically does NOT classify vegetation — high vegetation
comes back as class 1 (unclassified) — so class codes can't select trees.
Instead this derives a normalized digital surface model (nDSM):

    ground grid  = mean z of ground/water returns (DEFAULT_CLASSES, the
                   same grid_lidar_points/build_dem_grid path grid-dem uses)
    surface grid = MAX z per cell over ALL returns except noise (7/18)
    nDSM         = surface - ground   (height above ground, metres)

Cells with nDSM >= min_height are canopy candidates; scipy.ndimage binary
opening kills single-cell noise, then binary closing bridges adjacent
crowns (the "dissolve" — 8-connected rasterio.features.shapes afterwards
yields merged crown polygons directly, interior clearings as holes). A
min-area filter drops specks and shapely simplification thins the stairstep
cell outlines.

Output convention (shared with fetch-water / fetch-osm, consumed by the web
GeoJSON draft-import wizard): a GeoJSON FeatureCollection in EPSG:3006 with
a legacy `crs` member and `properties.type` = 'trees'.

Everything is offline-testable: input is local LAS/LAZ/COPC files that
cmd_fetch_lidar already downloaded — no network in this module at all.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import rasterio.features
from scipy.ndimage import binary_closing, binary_opening
from shapely.geometry import shape as shapely_shape
from shapely.geometry.base import BaseGeometry

from golfpipe.water import GEOJSON_CRS_3006

# Laserdata Skog noise codes excluded from the max-z surface: 7 = low noise,
# 18 = high noise (birds, atmospheric returns).
NOISE_CLASSES = (7, 18)

DEFAULT_MIN_HEIGHT_M = 2.0
DEFAULT_MIN_AREA_M2 = 25.0
DEFAULT_SIMPLIFY_TOLERANCE_M = 0.5

# 3x3 full block = 8-connected morphology, matching the connectivity=8
# polygonization below (opening kills < ~1-cell noise, closing bridges
# 1-2 cell gaps between adjacent crowns so they dissolve into one polygon).
_STRUCTURE = np.ones((3, 3), dtype=bool)

NODATA = -9999.0

ATTRIBUTION = "© Lantmäteriet, Laserdata Skog (CC0)"


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
    """Thresholds the nDSM at min_height_m, then binary opening (removes
    isolated noise cells) followed by binary closing (bridges small gaps so
    adjacent crowns merge). Returns a boolean canopy mask.
    """
    mask = ndsm >= min_height_m
    mask = binary_opening(mask, structure=_STRUCTURE)
    mask = binary_closing(mask, structure=_STRUCTURE)
    return mask


def mask_to_polygons(mask: np.ndarray, transform: "rasterio.Affine") -> list[BaseGeometry]:
    """Polygonizes the canopy mask (8-connected, so crowns the closing step
    joined diagonally stay one polygon) into shapely Polygons in the grid's
    CRS (EPSG:3006). Interior clearings come out as holes.
    """
    raster = mask.astype(np.uint8)
    return [
        shapely_shape(geom)
        for geom, value in rasterio.features.shapes(raster, mask=mask, transform=transform, connectivity=8)
        if value == 1
    ]


def filter_and_simplify(
    polygons: list[BaseGeometry],
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    simplify_tolerance_m: float = DEFAULT_SIMPLIFY_TOLERANCE_M,
) -> list[BaseGeometry]:
    """Drops polygons below min_area_m2, then Douglas-Peucker-simplifies the
    survivors (topology-preserving) to thin the stairstep cell outlines.
    """
    out: list[BaseGeometry] = []
    for polygon in polygons:
        if polygon.area < min_area_m2:
            continue
        simplified = polygon.simplify(simplify_tolerance_m, preserve_topology=True)
        if simplified.is_empty:
            continue
        out.append(simplified)
    return out


def _each_polygon(geom: BaseGeometry):
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        for part in geom.geoms:
            yield from _each_polygon(part)


def _polygon_coordinates(polygon, ndigits: int = 2) -> list[list[list[float]]]:
    def ring(coords):
        return [[round(x, ndigits), round(y, ndigits)] for x, y, *_ in coords]

    return [ring(polygon.exterior.coords)] + [ring(interior.coords) for interior in polygon.interiors]


def build_trees_geojson(polygons: list[BaseGeometry]) -> dict:
    """Builds the EPSG:3006 FeatureCollection: one 'trees' feature per
    polygon (holes preserved), importable by the web GeoJSON draft-import
    wizard (same shape as fetch-water / fetch-osm output).
    """
    features: list[dict] = []
    for geom in polygons:
        for polygon in _each_polygon(geom):
            features.append({
                "type": "Feature",
                "properties": {"type": "trees", "source": "lidar-ndsm"},
                "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(polygon)},
            })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": features,
    }
