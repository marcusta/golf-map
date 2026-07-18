"""Mask geometry for clean-ortho: which orthophoto pixels get inpainted.

The batch texture-cleaning command removes tree canopy + the shadows it
casts from the PLAYABLE CORRIDOR of the course, so game-engine (Unity/GSPro)
textures show grass instead of crowns/shadow blobs. This module owns the
pure, offline-testable geometry:

    mask = ((canopy ∪ shadow(canopy)) ∩ corridor) ∪ manual, dilated margin_m

- canopy: `trees` polygons (detect-trees output, or a course-features
  export — features typed 'trees', plus untyped polygons, are used).
- shadow: the canopy union translated along --shadow-azimuth (compass
  degrees, the direction the shadow FALLS TOWARD: 0 = north, 90 = east) in
  several sub-offsets up to --shadow-length metres, unioned — so the whole
  penumbra band between crown and shadow tip is covered, not just the tip.
- corridor: union of the grass feature types (default fairway, semi_rough,
  rough, tee, green — flag-tunable). Canopy/shadow OUTSIDE the corridor is
  left untouched: real forest should stay forest in the texture.
- manual: optional extra mask polygons (players, carts, hand-drawn fixes),
  honored verbatim — NOT clipped to the corridor.
- margin: small dilation (default 0.5 m) so crown edges / JPEG halos around
  the masked objects get inpainted too.

Everything is EPSG:3006 (SWEREF99 TM, metres). Input GeoJSON may be either
the pipeline's shared 3006 contract (legacy `crs` member, like detect-trees /
fetch-water output) or a WGS84 lon/lat export (the server's features.geojson)
— WGS84 is detected by coordinate range and reprojected. Rasterization goes
through rasterio transforms only; no GDAL binary (house rule).
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio.features
from shapely.geometry import shape as shapely_shape
from shapely.geometry.base import BaseGeometry
from shapely.geometry import Polygon
from shapely.ops import unary_union

__all__ = [
    "CleanOrthoError", "TypedPolygon",
    "DEFAULT_CORRIDOR_TYPES", "DEFAULT_SHADOW_AZIMUTH_DEG",
    "DEFAULT_SHADOW_LENGTH_M", "DEFAULT_MARGIN_M", "SHADOW_STEP_M",
    "load_typed_polygons", "select_polygons", "shadow_geometry",
    "build_mask_geometry", "rasterize_mask",
]


class CleanOrthoError(RuntimeError):
    """User-actionable clean-ortho input/setup error."""


# The grass surfaces a ball is realistically played from — canopy/shadow over
# these gets cleaned; everything outside stays as flown.
DEFAULT_CORRIDOR_TYPES = ("fairway", "semi_rough", "rough", "tee", "green")
# Shadow direction the ortho was flown with is course-specific — measure one
# tree in the source image. 0 = shadows falling due north (midday in Sweden).
DEFAULT_SHADOW_AZIMUTH_DEG = 0.0
DEFAULT_SHADOW_LENGTH_M = 15.0
DEFAULT_MARGIN_M = 0.5
# Sub-offset spacing for the shadow band: crowns are far wider than 3 m, so
# consecutive translates overlap and the union is a solid band.
SHADOW_STEP_M = 3.0

TypedPolygon = tuple[str | None, BaseGeometry]


def _is_epsg_3006(collection: dict) -> bool:
    crs = collection.get("crs")
    if not isinstance(crs, dict):
        return False
    name = str(crs.get("properties", {}).get("name", ""))
    return name.endswith("3006")


def _iter_features(doc: dict):
    if doc.get("type") == "FeatureCollection":
        yield from doc.get("features", [])
    elif doc.get("type") == "Feature":
        yield doc
    else:
        # Bare geometry object.
        yield {"type": "Feature", "properties": {}, "geometry": doc}


def _coords_look_wgs84(geometry: dict) -> bool:
    def walk(node):
        if isinstance(node, (list, tuple)):
            if node and isinstance(node[0], (int, float)):
                yield node
            else:
                for child in node:
                    yield from walk(child)

    for pos in walk(geometry.get("coordinates", [])):
        if abs(pos[0]) > 180 or abs(pos[1]) > 90:
            return False
    return True


def _reproject_coords(coords, reproject):
    """Recursively reprojects a GeoJSON coordinate array (rings of rings of
    positions) with reproject(xs, ys) -> (xs, ys)."""
    if coords and isinstance(coords[0], (int, float)):
        raise CleanOrthoError("unexpected bare position in geometry coordinates")
    if coords and isinstance(coords[0][0], (int, float)):
        xs, ys = reproject([p[0] for p in coords], [p[1] for p in coords])
        return [[x, y] for x, y in zip(xs, ys)]
    return [_reproject_coords(ring, reproject) for ring in coords]


def _wgs84_to_3006(xs: list[float], ys: list[float]) -> tuple[list[float], list[float]]:
    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    out_x, out_y = warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), xs, ys)
    return out_x, out_y


def load_typed_polygons(path: Path) -> list[TypedPolygon]:
    """Parses a GeoJSON file into (properties.type, shapely geometry) pairs,
    keeping Polygon/MultiPolygon features only. Output is always EPSG:3006:
    files carrying the shared contract's legacy `crs` member (or projected-
    looking coordinates) pass through; WGS84 lon/lat (e.g. the server's
    features.geojson export) is detected by coordinate range and reprojected.
    """
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleanOrthoError(f"cannot read GeoJSON {path}: {exc}") from exc

    features = [
        f for f in _iter_features(doc)
        if isinstance(f.get("geometry"), dict)
        and f["geometry"].get("type") in ("Polygon", "MultiPolygon")
    ]

    needs_reproject = (
        not _is_epsg_3006(doc)
        and all(_coords_look_wgs84(f["geometry"]) for f in features)
        and bool(features)
    )

    out: list[TypedPolygon] = []
    for feature in features:
        geometry = feature["geometry"]
        if needs_reproject:
            geometry = {
                "type": geometry["type"],
                "coordinates": _reproject_coords(geometry["coordinates"], _wgs84_to_3006),
            }
        geom = shapely_shape(geometry)
        if geom.is_empty or not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty:
            continue
        props = feature.get("properties") or {}
        feature_type = props.get("type")
        out.append((feature_type if isinstance(feature_type, str) else None, geom))
    return out


def select_polygons(
    typed: list[TypedPolygon],
    types: tuple[str, ...],
    include_untyped: bool = False,
) -> list[BaseGeometry]:
    """Geometries whose type is in `types` (untyped features too when
    include_untyped — detect-trees output is fully typed, but hand-exported
    mask polygons often carry no type property)."""
    return [
        geom for feature_type, geom in typed
        if feature_type in types or (include_untyped and feature_type is None)
    ]


def shadow_geometry(
    canopy: BaseGeometry,
    azimuth_deg: float = DEFAULT_SHADOW_AZIMUTH_DEG,
    length_m: float = DEFAULT_SHADOW_LENGTH_M,
    step_m: float = SHADOW_STEP_M,
) -> BaseGeometry:
    """The shadow band cast by `canopy`: the canopy translated toward
    `azimuth_deg` (compass degrees — 0 = north/+y, 90 = east/+x in EPSG:3006)
    at several sub-offsets up to length_m, unioned. Sub-offsets are spaced
    <= step_m so the band between crown and shadow tip has no gaps (crowns
    are much wider than step_m, so consecutive translates overlap).
    """
    from shapely.affinity import translate

    if canopy.is_empty or length_m <= 0:
        return Polygon()
    az = math.radians(azimuth_deg)
    ux, uy = math.sin(az), math.cos(az)
    n = max(1, math.ceil(length_m / step_m))
    offsets = [length_m * (i + 1) / n for i in range(n)]
    return unary_union([translate(canopy, xoff=d * ux, yoff=d * uy) for d in offsets])


def build_mask_geometry(
    canopy_geoms: list[BaseGeometry],
    corridor_geoms: list[BaseGeometry],
    manual_geoms: list[BaseGeometry] = (),
    shadow_azimuth_deg: float = DEFAULT_SHADOW_AZIMUTH_DEG,
    shadow_length_m: float = DEFAULT_SHADOW_LENGTH_M,
    margin_m: float = DEFAULT_MARGIN_M,
) -> BaseGeometry:
    """The full inpaint mask geometry (EPSG:3006):
    ((canopy ∪ shadow) ∩ corridor) ∪ manual, dilated by margin_m.

    Manual mask polygons are deliberately NOT clipped to the corridor — they
    are explicit operator intent (players, carts, blemishes anywhere).
    """
    canopy = unary_union(list(canopy_geoms)) if canopy_geoms else Polygon()
    corridor = unary_union(list(corridor_geoms)) if corridor_geoms else Polygon()
    shadow = shadow_geometry(canopy, azimuth_deg=shadow_azimuth_deg, length_m=shadow_length_m)
    mask = canopy.union(shadow).intersection(corridor)
    if manual_geoms:
        mask = mask.union(unary_union(list(manual_geoms)))
    if margin_m > 0 and not mask.is_empty:
        mask = mask.buffer(margin_m)
    return mask


def rasterize_mask(
    geometry: BaseGeometry,
    transform: "rasterio.Affine",
    out_shape: tuple[int, int],
) -> np.ndarray:
    """Burns the mask geometry into the ortho's pixel grid (EPSG:3006 raster
    transform, no GDAL binary): (H, W) bool, True = inpaint. all_touched so
    boundary pixels err on the side of being cleaned.
    """
    if geometry.is_empty:
        return np.zeros(out_shape, dtype=bool)
    raster = rasterio.features.rasterize(
        [(geometry, 1)],
        out_shape=out_shape,
        transform=transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    )
    return raster.astype(bool)
