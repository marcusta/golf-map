"""Shared machinery for the lidar auto-draft commands (detect-trees,
detect-water): boolean mask -> polygons -> filtered/simplified geometry ->
typed GeoJSON FeatureCollection.

Factored out of detect_trees.py (T46) when detect-water (T47) landed so the
grid -> morphology -> polygonize -> min-area -> simplify -> GeoJSON steps
exist once. The detectors themselves own what the mask MEANS (nDSM height
threshold vs class-9 presence) and its morphology recipe; everything after
the mask lives here.

Output convention (shared with fetch-water / fetch-osm, consumed by the web
GeoJSON draft-import wizard): a GeoJSON FeatureCollection in EPSG:3006 with
a legacy `crs` member and a per-feature `properties.type`.
"""

from __future__ import annotations

import numpy as np
import rasterio.features
from shapely.geometry import shape as shapely_shape
from shapely.geometry.base import BaseGeometry

from golfpipe.water import GEOJSON_CRS_3006

# 3x3 full block = 8-connected morphology, matching the connectivity=8
# polygonization below (opening kills < ~1-cell noise; closing with it
# bridges 1-2 cell gaps so adjacent blobs dissolve into one polygon).
STRUCTURE_8 = np.ones((3, 3), dtype=bool)

# All lidar-derived drafts come from the same Laserdata Skog point clouds.
LASERDATA_ATTRIBUTION = "© Lantmäteriet, Laserdata Skog (CC0)"


def mask_to_polygons(mask: np.ndarray, transform: "rasterio.Affine") -> list[BaseGeometry]:
    """Polygonizes a boolean mask (8-connected, so blobs a closing step
    joined diagonally stay one polygon) into shapely Polygons in the grid's
    CRS (EPSG:3006). Interior gaps come out as holes.
    """
    raster = mask.astype(np.uint8)
    return [
        shapely_shape(geom)
        for geom, value in rasterio.features.shapes(raster, mask=mask, transform=transform, connectivity=8)
        if value == 1
    ]


def filter_and_simplify(
    polygons: list[BaseGeometry],
    min_area_m2: float,
    simplify_tolerance_m: float,
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


def build_feature_collection(
    polygons: list[BaseGeometry],
    feature_type: str,
    source: str,
    attribution: str = LASERDATA_ATTRIBUTION,
) -> dict:
    """Builds the EPSG:3006 FeatureCollection: one typed feature per polygon
    (holes preserved), importable by the web GeoJSON draft-import wizard
    (same shape as fetch-water / fetch-osm output).
    """
    features: list[dict] = []
    for geom in polygons:
        for polygon in _each_polygon(geom):
            features.append({
                "type": "Feature",
                "properties": {"type": feature_type, "source": source},
                "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(polygon)},
            })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": attribution,
        "features": features,
    }
