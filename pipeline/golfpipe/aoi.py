"""Area-of-interest resolution: every command that takes an area accepts
either --bbox (w,s,e,n in WGS84) or --aoi (a GeoJSON file whose combined
bounding box becomes the bbox). Stdlib json only — no fiona/pyshp; GeoJSON
was chosen deliberately over shapefile to keep this dependency-free.
"""

from __future__ import annotations

import json
from pathlib import Path

# Generous but real-world sanity bounds for lon/lat, used to catch files
# that are accidentally in a projected CRS (e.g. SWEREF99 TM metres)
# instead of WGS84 degrees.
LON_MIN, LON_MAX = -180.0, 180.0
LAT_MIN, LAT_MAX = -90.0, 90.0


class AoiError(ValueError):
    pass


def parse_bbox(raw: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise AoiError(f"--bbox must have 4 comma-separated values (w,s,e,n), got: {raw!r}")
    try:
        west, south, east, north = (float(p) for p in parts)
    except ValueError as exc:
        raise AoiError(f"--bbox values must be numbers, got: {raw!r}") from exc
    _validate_bbox((west, south, east, north))
    return (west, south, east, north)


def _validate_bbox(bbox: tuple[float, float, float, float]) -> None:
    west, south, east, north = bbox
    for name, lon in (("west", west), ("east", east)):
        if not (LON_MIN <= lon <= LON_MAX):
            raise AoiError(
                f"--bbox {name}={lon} is out of longitude range [{LON_MIN}, {LON_MAX}]; "
                "expected WGS84 lon/lat, not a projected CRS"
            )
    for name, lat in (("south", south), ("north", north)):
        if not (LAT_MIN <= lat <= LAT_MAX):
            raise AoiError(
                f"--bbox {name}={lat} is out of latitude range [{LAT_MIN}, {LAT_MAX}]; "
                "expected WGS84 lon/lat, not a projected CRS"
            )
    if west >= east:
        raise AoiError(f"--bbox west ({west}) must be < east ({east})")
    if south >= north:
        raise AoiError(f"--bbox south ({south}) must be < north ({north})")


def _iter_coords(geom: dict):
    """Recursively yields (lon, lat) pairs from any GeoJSON geometry dict."""
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype is None:
        raise AoiError(f"GeoJSON geometry missing 'type': {geom!r}")
    if coords is None:
        raise AoiError(f"GeoJSON geometry missing 'coordinates': {geom!r}")

    if gtype == "Point":
        yield tuple(coords[:2])
    elif gtype in ("MultiPoint", "LineString"):
        for c in coords:
            yield tuple(c[:2])
    elif gtype in ("MultiLineString", "Polygon"):
        for ring in coords:
            for c in ring:
                yield tuple(c[:2])
    elif gtype == "MultiPolygon":
        for polygon in coords:
            for ring in polygon:
                for c in ring:
                    yield tuple(c[:2])
    elif gtype == "GeometryCollection":
        for sub in geom.get("geometries", []):
            yield from _iter_coords(sub)
    else:
        raise AoiError(f"Unsupported GeoJSON geometry type: {gtype!r}")


def _iter_feature_geometries(data: dict):
    gtype = data.get("type")
    if gtype == "FeatureCollection":
        features = data.get("features")
        if not features:
            raise AoiError("GeoJSON FeatureCollection has no features")
        for feature in features:
            geom = feature.get("geometry")
            if geom is None:
                continue
            yield geom
    elif gtype == "Feature":
        geom = data.get("geometry")
        if geom is None:
            raise AoiError("GeoJSON Feature has no geometry")
        yield geom
    elif gtype in (
        "Point", "MultiPoint", "LineString", "MultiLineString",
        "Polygon", "MultiPolygon", "GeometryCollection",
    ):
        # Bare geometry object.
        yield data
    else:
        raise AoiError(f"Unsupported top-level GeoJSON 'type': {gtype!r}")


def bbox_from_geojson(path: Path) -> tuple[float, float, float, float]:
    """Reads a GeoJSON file (Feature, FeatureCollection, or bare geometry,
    WGS84) and returns the combined bounding box of all coordinates as
    (west, south, east, north).
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise AoiError(f"--aoi file is not valid JSON: {path}") from exc

    if not isinstance(data, dict):
        raise AoiError(f"--aoi file must contain a GeoJSON object, got: {type(data).__name__}")

    lons: list[float] = []
    lats: list[float] = []
    for geom in _iter_feature_geometries(data):
        for lon, lat in _iter_coords(geom):
            lons.append(lon)
            lats.append(lat)

    if not lons:
        raise AoiError(f"--aoi file has no coordinates: {path}")

    bbox = (min(lons), min(lats), max(lons), max(lats))
    _validate_bbox(bbox)
    return bbox


def resolve_bbox(bbox_arg: str | None, aoi_arg: str | None) -> tuple[float, float, float, float]:
    """Resolves the final WGS84 bbox from mutually-exclusive --bbox/--aoi
    CLI args. Argparse-level mutual exclusivity should already guarantee
    exactly one is set; this re-checks defensively for direct callers.
    """
    if bbox_arg and aoi_arg:
        raise AoiError("Specify only one of --bbox or --aoi, not both")
    if bbox_arg:
        return parse_bbox(bbox_arg)
    if aoi_arg:
        return bbox_from_geojson(Path(aoi_arg))
    raise AoiError("One of --bbox or --aoi is required")
