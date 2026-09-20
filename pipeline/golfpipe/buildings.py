"""Building footprints with lidar roof heights (fetch-buildings).

A building is not an app feature type: on the GSPro side it is two jobs, a
flat pad on the terrain and a prefab planted on it (unity/, the building
planter), and both need the same record. This module builds that record —
the footprint survey — from OSM and the lidar:

1. Footprint. Overpass `building=*` ways (closed rings) and multipolygon
   relations, reprojected to EPSG:3006 with the same ring machinery as
   fetch-osm. Whole footprints are kept even when they cross the area's
   edge — half a house is no use to anyone. The id is the OSM element
   (`osm:way/123`), a real source id rather than the position-derived ids
   tree stems get, so authored choices survive a data refresh even when the
   mapper nudges a corner.
2. Rectangle. shapely's minimum rotated rectangle of the footprint gives
   the length, width and the long axis' bearing in one call — the three
   numbers the planter matches a prefab on and rotates it by. Angle is the
   long side's direction, degrees counter-clockwise from east in [0, 180);
   which of its two ends is the front is not knowable from a footprint.
3. Roof heights. Laserdata Skog has no building class, but a roof is in the
   nDSM (max-return surface minus ground) just like a crown. Cells inside
   the footprint, shrunk by ROOF_EDGE_INSET_M so the eave row of mixed
   roof/ground samples is left out, give eave ≈ EAVE_PERCENTILE and ridge ≈
   RIDGE_PERCENTILE of the height distribution. Under MIN_ROOF_CELLS cells
   the building gets no measurement (a garden shed at 1 m resolution).
   `building:levels` × LEVEL_HEIGHT_M and an OSM `height` tag are carried
   for the planter's fallback; the lidar wins when present.

Output is an EPSG:3006 FeatureCollection with `properties.type`
"building" and the survey fields (id, kind, levels, rect, eaveM, ridgeM,
…). The web import wizard would show it as an unmapped bucket — it is not
meant for the app; `gspro.py buildings` turns it into `unity-buildings-v1`
and `building-pads` into terrain edits.

Offline-testable like fetch-osm: HTTP behind `osm.fetch_overpass`, the
reprojection injected, the nDSM a plain numpy grid + affine.

LICENSING — ODbL provenance per feature (`source`, `osm_type`, `osm_id`,
`fetched`) and `attribution` on the collection, as for fetch-osm.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import rasterio.features
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

from golfpipe.osm import (
    ATTRIBUTION,
    Reproject,
    _closed,
    _polygon_coordinates,
    _reproject_ring,
    _rings_to_polygons,
    _way_points,
    parse_metres,
    stitch_rings,
)
from golfpipe.water import GEOJSON_CRS_3006

FEATURE_TYPE = "building"

# Storey height for the `building:levels` fallback (Swedish residential:
# ~2.7 m rooms plus floor structure).
LEVEL_HEIGHT_M = 3.0
HEIGHT_RANGE_M = (1.0, 300.0)

# Roof measurement: shrink the footprint so the eave row's half-ground cells
# don't drag the eave estimate down; a footprint too thin to survive the
# inset is measured as is.
ROOF_EDGE_INSET_M = 0.75
EAVE_PERCENTILE = 20
RIDGE_PERCENTILE = 95
MIN_ROOF_CELLS = 4
MIN_ROOF_HEIGHT_M = 1.5  # below this the "roof" is the ground: no measurement

MIN_FOOTPRINT_AREA_M2 = 4.0


@dataclass
class Rect:
    """Minimum rotated rectangle of a footprint: centre, sides, bearing."""
    cx: float
    cy: float
    length_m: float  # the long side
    width_m: float
    angle_deg: float  # long side direction, CCW from east, [0, 180)


@dataclass
class Roof:
    eave_m: float
    ridge_m: float
    cells: int


@dataclass
class Building:
    id: str  # "osm:way/123" | "osm:relation/456"
    osm_type: str
    osm_id: int
    kind: str  # the `building=*` value ("yes" when untyped)
    levels: float | None
    height_tag_m: float | None
    name: str | None
    polygon: Polygon  # EPSG:3006 footprint (holes kept)
    rect: Rect
    roof: Roof | None = None


def build_buildings_query(bbox_wgs84: tuple[float, float, float, float]) -> str:
    """Overpass QL for building ways and multipolygon relations in bbox
    (west, south, east, north WGS84); `out geom` inlines the coordinates.
    """
    west, south, east, north = bbox_wgs84
    b = f"{south},{west},{north},{east}"  # Overpass bbox is (S,W,N,E)
    return (
        "[out:json][timeout:180];\n(\n"
        f'  way["building"]({b});\n'
        f'  relation["building"]["type"="multipolygon"]({b});\n'
        ");\nout geom;"
    )


def parse_levels(raw) -> float | None:
    """`building:levels` → a count; ranges/lists ("1;2", "2-3") take the
    first number. None when absent or not a number in (0, 200]."""
    if raw is None:
        return None
    text = str(raw).strip().replace(",", ".")
    for sep in (";", "-", "+"):
        text = text.split(sep)[0]
    try:
        value = float(text)
    except ValueError:
        return None
    return value if 0 < value <= 200 else None


def footprint_rect(polygon: BaseGeometry) -> Rect:
    """Minimum rotated rectangle → centre, long/short side, long-axis
    bearing. A degenerate footprint (a line) gets a zero width."""
    rect = polygon.minimum_rotated_rectangle
    if rect.geom_type != "Polygon":
        c = polygon.centroid
        return Rect(c.x, c.y, 0.0, 0.0, 0.0)
    coords = list(rect.exterior.coords)[:4]
    (x0, y0), (x1, y1), (x2, y2) = coords[0], coords[1], coords[2]
    a = math.hypot(x1 - x0, y1 - y0)
    b = math.hypot(x2 - x1, y2 - y1)
    if a >= b:
        length, width, dx, dy = a, b, x1 - x0, y1 - y0
    else:
        length, width, dx, dy = b, a, x2 - x1, y2 - y1
    angle = math.degrees(math.atan2(dy, dx)) % 180.0
    if angle >= 180.0 - 1e-9:
        angle = 0.0
    c = rect.centroid
    return Rect(c.x, c.y, length, width, angle)


def assemble_buildings(overpass_json: dict, reproject: Reproject) -> tuple[list[Building], list[str]]:
    """Overpass `out geom` JSON → footprints (EPSG:3006, with rects) plus
    `skipped` notes for building elements dropped for a reason worth
    reading. Non-building elements are ignored silently."""
    buildings: list[Building] = []
    skipped: list[str] = []
    for element in overpass_json.get("elements", []):
        tags = element.get("tags") or {}
        kind = tags.get("building")
        if not kind:
            continue
        etype, eid = element.get("type"), element.get("id")

        if etype == "way":
            points = _way_points(element.get("geometry", []))
            if not _closed(points):
                skipped.append(f"way/{eid}: building way is not a closed ring")
                continue
            polygons = _rings_to_polygons([_reproject_ring(points, reproject)], [])
        elif etype == "relation":
            outer_ways, inner_ways = [], []
            for member in element.get("members", []):
                if member.get("type") != "way" or not member.get("geometry"):
                    continue
                pts = _way_points(member["geometry"])
                (inner_ways if member.get("role") == "inner" else outer_ways).append(pts)
            outer_rings = [_reproject_ring(r, reproject) for r in stitch_rings(outer_ways)]
            inner_rings = [_reproject_ring(r, reproject) for r in stitch_rings(inner_ways)]
            if not outer_rings:
                skipped.append(f"relation/{eid}: building relation has no closed outer ring")
                continue
            polygons = _rings_to_polygons(outer_rings, inner_rings)
        else:
            continue

        for index, polygon in enumerate(polygons):
            if not polygon.is_valid:
                polygon = polygon.buffer(0)
            if polygon.is_empty or polygon.geom_type != "Polygon":
                skipped.append(f"{etype}/{eid}: building footprint is not a valid polygon")
                continue
            if polygon.area < MIN_FOOTPRINT_AREA_M2:
                skipped.append(f"{etype}/{eid}: footprint under {MIN_FOOTPRINT_AREA_M2:g} m²")
                continue
            suffix = f"#{index}" if len(polygons) > 1 else ""
            buildings.append(Building(
                id=f"osm:{etype}/{eid}{suffix}",
                osm_type=etype,
                osm_id=eid,
                kind=str(kind),
                levels=parse_levels(tags.get("building:levels")),
                height_tag_m=parse_metres(tags.get("height"), *HEIGHT_RANGE_M),
                name=tags.get("name"),
                polygon=polygon,
                rect=footprint_rect(polygon),
            ))
    return buildings, skipped


def measure_roof(
    polygon: Polygon,
    ndsm: np.ndarray,
    transform,
    *,
    inset_m: float = ROOF_EDGE_INSET_M,
    min_cells: int = MIN_ROOF_CELLS,
) -> Roof | None:
    """Eave/ridge heights from the nDSM cells inside the (inset) footprint,
    or None when too few cells hold a roof-height return."""
    region = polygon.buffer(-inset_m)
    if region.is_empty or region.area < 1.0:
        region = polygon
    mask = rasterio.features.geometry_mask([region], out_shape=ndsm.shape, transform=transform, invert=True)
    heights = ndsm[mask]
    heights = heights[np.isfinite(heights) & (heights >= MIN_ROOF_HEIGHT_M)]
    if heights.size < min_cells:
        return None
    return Roof(
        eave_m=float(np.percentile(heights, EAVE_PERCENTILE)),
        ridge_m=float(np.percentile(heights, RIDGE_PERCENTILE)),
        cells=int(heights.size),
    )


def measure_roofs(buildings: list[Building], ndsm: np.ndarray, transform) -> int:
    """Measures every building in place; returns how many got a roof."""
    measured = 0
    for b in buildings:
        b.roof = measure_roof(b.polygon, ndsm, transform)
        if b.roof is not None:
            measured += 1
    return measured


def fallback_height_m(b: Building) -> float | None:
    """Height when the lidar gave none: the OSM `height` tag, else levels ×
    LEVEL_HEIGHT_M, else None."""
    if b.height_tag_m is not None:
        return b.height_tag_m
    if b.levels is not None:
        return b.levels * LEVEL_HEIGHT_M
    return None


# ─── pads: the flat ground under each building, as terrain edits ──────────────

PADS_ORIGIN = "building-pads"
DEFAULT_PAD_BUFFER_M = 1.5
DEFAULT_PAD_FEATHER_M = 4.0


def read_survey(path) -> list[Building]:
    """Reads a fetch-buildings survey GeoJSON back into Buildings (rect and
    roof from the properties, no re-measuring)."""
    import json
    from pathlib import Path

    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    crs = (doc.get("crs") or {}).get("properties", {}).get("name", "")
    if doc.get("type") != "FeatureCollection" or "3006" not in crs:
        raise ValueError(f"{path} is not an EPSG:3006 building survey (fetch-buildings output)")
    out: list[Building] = []
    for feature in doc.get("features", []):
        props = feature.get("properties") or {}
        if props.get("type") != FEATURE_TYPE:
            continue
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Polygon":
            continue
        rings = geometry["coordinates"]
        polygon = Polygon(rings[0], rings[1:])
        r = props.get("rect") or {}
        rect = Rect(r["cx"], r["cy"], r["lengthM"], r["widthM"], r["angleDeg"]) if r else footprint_rect(polygon)
        roof = Roof(props["eaveM"], props["ridgeM"], props.get("roofCells", 0)) if props.get("eaveM") is not None else None
        out.append(Building(
            id=props["id"], osm_type=props.get("osm_type", ""), osm_id=props.get("osm_id", 0),
            kind=props.get("kind", "yes"), levels=props.get("levels"), height_tag_m=props.get("heightTagM"),
            name=props.get("name"), polygon=polygon, rect=rect, roof=roof,
        ))
    return out


def pad_polygon(footprint: Polygon, buffer_m: float, feather_m: float) -> Polygon:
    """The terrain-edit polygon for a footprint. dem_edit feathers over a
    band INSIDE the polygon, so to keep the whole footprint plus `buffer_m`
    of apron dead flat the polygon must reach `feather_m` further out: the
    edit is footprint ⊕ (buffer + feather) with feather = feather_m."""
    return footprint.buffer(buffer_m + feather_m, quad_segs=4, join_style="round")


def pad_edit_features(
    buildings: list[Building],
    to_wgs84: Reproject,
    *,
    buffer_m: float = DEFAULT_PAD_BUFFER_M,
    feather_m: float = DEFAULT_PAD_FEATHER_M,
    flat: bool = True,
    created_at: str = "",
) -> list[dict]:
    """One D-TE5 terrain-edit feature per building: a `plane` (dead-flat
    when `flat`) over pad_polygon, WGS84 like the server's own handoff so
    `apply-dem-edits --edits` and the server import both read it. `origin`
    / `originRef` let the server replace a previous generation without
    touching hand-drawn edits; `createdAt` (all equal, index-suffixed)
    keeps the replay order stable."""
    features = []
    for index, b in enumerate(buildings):
        polygon = pad_polygon(b.polygon, buffer_m, feather_m)
        exterior = list(polygon.exterior.coords)
        lons, lats = to_wgs84([p[0] for p in exterior], [p[1] for p in exterior])
        ring = [[round(float(lon), 7), round(float(lat), 7)] for lon, lat in zip(lons, lats)]
        features.append({
            "type": "Feature",
            "properties": {
                "op": "plane",
                "featherM": feather_m,
                **({"flat": True} if flat else {}),
                "createdAt": f"{created_at}#{index:05d}" if created_at else None,
                "origin": PADS_ORIGIN,
                "originRef": b.id,
                "kind": b.kind,
                "areaM2": round(b.polygon.area, 1),
            },
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    return features


def build_pads_geojson(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "attribution": ATTRIBUTION, "features": features}


def build_buildings_geojson(buildings: list[Building], *, fetch_date: str) -> dict:
    features = []
    for b in buildings:
        props = {
            "type": FEATURE_TYPE,
            "id": b.id,
            "kind": b.kind,
            "name": b.name,
            "levels": b.levels,
            "heightTagM": b.height_tag_m,
            "fallbackHeightM": fallback_height_m(b),
            "areaM2": round(b.polygon.area, 1),
            "rect": {
                "cx": round(b.rect.cx, 2),
                "cy": round(b.rect.cy, 2),
                "lengthM": round(b.rect.length_m, 2),
                "widthM": round(b.rect.width_m, 2),
                "angleDeg": round(b.rect.angle_deg, 1),
            },
            "eaveM": round(b.roof.eave_m, 2) if b.roof else None,
            "ridgeM": round(b.roof.ridge_m, 2) if b.roof else None,
            "roofCells": b.roof.cells if b.roof else 0,
            "source": "osm",
            "osm_type": b.osm_type,
            "osm_id": b.osm_id,
            "fetched": fetch_date,
        }
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(b.polygon)},
        })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": features,
    }
