"""Hydrography from Lantmäteriet Hydrografi Direkt (fetch-hydro).

Hydrografi Direkt is an OGC API Features service at HYDRO_API_URL serving
the national hydrography network. Unlike Marktäcke (fetch-water), it carries
watercourse CENTERLINES everywhere — verified live 2026-07-18 at Landeryd,
where Marktäcke has zero watercourse lines but WatercourseLine has nine —
so this is the authoritative creek source. fetch-water (Marktäcke) and
detect-water (lidar class 9) remain as alternates.

Live investigation notes (2026-07-18, basic-auth account entitled):
  - /collections lists 13 collections, all storageCrs EPSG:3006. The three
    we consume: StandingWater (lakes/ponds, Polygon), WatercoursePolygon
    (wide watercourse surfaces, Polygon), WatercourseLine (centerlines,
    LineString).
  - `?crs=<EPSG:3006 URI>` returns coordinates in the official EPSG:3006
    axis order — (northing, easting) — confirmed by the Content-Crs header
    and coordinate magnitudes. _swap_axes flips every position to the
    (easting, northing) order the rest of the pipeline uses.
  - `bbox` is interpreted in CRS84 (lon/lat WGS84) by default — no
    bbox-crs needed since callers pass WGS84 bboxes (aoi.py conventions).
  - Paging via `rel: next` links (`limit` per page, no numberMatched);
    the landing page is anonymous but /items requires basic auth (401).

Everything here is offline-testable: HTTP goes through the same
session-parameter seam as stac.py (tests pass a stub with .get), and the
GeoJSON assembly is pure functions over fixture pages.

Output convention (shared with fetch-water / fetch-osm / detect-*): a
GeoJSON FeatureCollection in EPSG:3006 with a legacy `crs` member and
`properties.type` set to 'water' (surfaces) or 'water_creek' (buffered
centerlines).
"""

from __future__ import annotations

import requests
import shapely
from shapely.geometry import shape as shapely_shape
from shapely.geometry.base import BaseGeometry

from golfpipe.stac import _credentials
from golfpipe.water import (  # noqa: F401  (re-exported for callers)
    DEFAULT_CREEK_WIDTH_M,
    GEOJSON_CRS_3006,
    _each_polygon,
    _polygon_coordinates,
    write_geojson,
)

HYDRO_API_URL = "https://api.lantmateriet.se/ogc-features/v1/hydrografi"

CRS_3006_URI = "http://www.opengis.net/def/crs/EPSG/0/3006"

# Collections whose features are standing/flowing water SURFACES (polygons).
WATER_SURFACE_COLLECTIONS = ("StandingWater", "WatercoursePolygon")
# Collection carrying watercourse CENTERLINES (creeks/ditches too narrow to
# map as surfaces) — buffered into ribbons downstream.
WATERCOURSE_LINE_COLLECTION = "WatercourseLine"

# Items per page. The API pages via `next` links; 1000 keeps a course-sized
# bbox to one page per collection (Landeryd: 22 + 3 + 9 features total).
DEFAULT_PAGE_LIMIT = 1000
# Hard stop against a next-link loop; a course bbox never legitimately needs
# this many pages at DEFAULT_PAGE_LIMIT.
MAX_PAGES = 100

ATTRIBUTION = "© Lantmäteriet, Hydrografi Direkt"
SOURCE = "lantmateriet-hydrografi"


class HydroError(RuntimeError):
    pass


def _swap_axes(coords: list) -> list:
    """EPSG:3006's official axis order is (northing, easting), and the OGC
    API honors it when `crs` requests 3006 output. Recursively flips every
    position to the (easting, northing) = (x, y) order shapely and the rest
    of the pipeline use.
    """
    if coords and isinstance(coords[0], (int, float)):
        return [coords[1], coords[0]]
    return [_swap_axes(c) for c in coords]


def _next_link(data: dict) -> str | None:
    for link in data.get("links", []):
        if link.get("rel") == "next" and link.get("href"):
            return link["href"]
    return None


def fetch_collection_geometries(
    collection_id: str,
    bbox_wgs84: tuple[float, float, float, float],
    session=None,
    base_url: str = HYDRO_API_URL,
    page_limit: int = DEFAULT_PAGE_LIMIT,
) -> list[BaseGeometry]:
    """Fetches every feature of `collection_id` intersecting bbox_wgs84
    (server-side bbox filter, paged via `next` links) and returns their
    shapely geometries in EPSG:3006 (axes swapped to easting/northing).

    Requires LANTMATERIET_USER/PASS (raises MissingCredentialsError before
    any request otherwise) — /items responds 401 anonymously.
    """
    user, password = _credentials()
    sess = session or requests

    url: str | None = f"{base_url}/collections/{collection_id}/items"
    params: dict[str, object] | None = {
        "f": "json",
        "bbox": ",".join(str(v) for v in bbox_wgs84),
        "crs": CRS_3006_URI,
        "limit": page_limit,
    }

    geoms: list[BaseGeometry] = []
    for _ in range(MAX_PAGES):
        if url is None:
            return geoms
        resp = sess.get(url, params=params, auth=(user, password), timeout=60)
        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (401, 403):
                raise HydroError(
                    f"Hydrografi Direkt returned {status} for {collection_id}: the "
                    "LANTMATERIET_USER account has not activated the 'Hydrografi "
                    "Nedladdning, direkt' product in Geotorget (the landing page is "
                    "anonymous, the /items endpoints are not)."
                ) from exc
            raise
        data = resp.json()
        for feature in data.get("features", []):
            geometry = feature.get("geometry")
            if not geometry or not geometry.get("coordinates"):
                continue
            geoms.append(shapely_shape({
                "type": geometry["type"],
                "coordinates": _swap_axes(geometry["coordinates"]),
            }))
        # `next` hrefs carry the full query string; params only on page 1.
        url, params = _next_link(data), None
    raise HydroError(
        f"Hydrografi Direkt paging for {collection_id} exceeded {MAX_PAGES} pages — "
        "aborting (next-link loop, or the bbox is far larger than a course)"
    )


def clip_geometries(
    geoms: list[BaseGeometry],
    bbox_3006: tuple[float, float, float, float],
    kind: str,
) -> list[BaseGeometry]:
    """Clips geometries to bbox_3006 (EPSG:3006 metres), keeping only the
    non-empty parts whose dimension matches `kind` ('polygon' or 'line') —
    the server's bbox filter is intersects, so features can extend well
    beyond the requested area (a river crossing the course, a lake shore).
    """
    wanted = ("Polygon", "MultiPolygon") if kind == "polygon" else ("LineString", "MultiLineString")
    clip = shapely.box(*bbox_3006)
    out: list[BaseGeometry] = []
    for geom in geoms:
        clipped = geom.intersection(clip)
        if not clipped.is_empty and clipped.geom_type in wanted:
            out.append(clipped)
    return out


def build_hydro_geojson(
    polygons: list[BaseGeometry],
    lines: list[BaseGeometry],
    creek_width_m: float = DEFAULT_CREEK_WIDTH_M,
) -> dict:
    """Builds the EPSG:3006 FeatureCollection (same recipe as fetch-water):
    water surfaces unioned (StandingWater and WatercoursePolygon overlap
    where a pond feeds a widened watercourse) and exploded into one 'water'
    feature per disjoint polygon (holes preserved); centerlines buffered by
    creek_width_m/2 per side, unioned (contiguous network segments merge
    seamlessly) and exploded into 'water_creek' features.
    """
    features: list[dict] = []

    def add(geom: BaseGeometry, feature_type: str) -> None:
        for polygon in _each_polygon(geom):
            features.append({
                "type": "Feature",
                "properties": {"type": feature_type, "source": SOURCE},
                "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(polygon)},
            })

    if polygons:
        add(shapely.unary_union(polygons), "water")
    if lines:
        buffered = [line.buffer(creek_width_m / 2.0) for line in lines]
        add(shapely.unary_union(buffered), "water_creek")

    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": features,
    }
