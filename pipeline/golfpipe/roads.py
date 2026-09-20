"""Road corridors from OSM highway centerlines (fetch-roads).

OSM maps a road as a `highway=*` way: an ordered node list plus tags. That is
a centerline, not a surface. This module turns the ways Overpass returns for
a bbox into road-surface polygons in EPSG:3006, in the same typed-GeoJSON
draft the web import wizard consumes (shared convention with fetch-osm /
fetch-water / detect-trees: a FeatureCollection with a legacy `crs` member
and `properties.type` naming an app feature type — here always `path`, the
type gspro.py paints as OPCD `concrete`).

Generation, per way:

1. Width. `width=*` when it parses (metres; "3", "3.5", "3 m", "3,5"),
   else `lanes` × LANE_WIDTH_M, else CLASS_WIDTH_M for the highway class.
   `golf=cartpath` is CARTPATH_WIDTH_M unless the way says otherwise. At
   Vreta only 37 of 897 ways carry `width`, so the class table does most
   of the work; `--class-width` overrides it per course.
2. Smooth the centerline — a Catmull-Rom curve through the way's nodes,
   sampled every metre (OSM stores a bend as nodes 10-20 m apart; buffered
   raw, the corridor shows flats between the joins); bends of 70° or more
   stay corners. Then buffer by half the width, round caps and round
   joins.
3. One polygon per way (the default): an OSM offset is nearly always one
   whole way traced off other imagery, and a way that is its own feature
   is fixed with a single drag in the app. `--merge` unions everything in
   a ROAD_GROUP (`road` / `track` / `path`) into road-network polygons
   instead — no junction overlaps, enclosed blocks as holes, but one
   feature of thousands of vertices. Either way `road_class` lets the
   wizard bucket, say, the roads in and the footpaths out.
4. Clip to the requested area (Overpass returns whole ways that cross the
   bbox, so a 5 km box otherwise yields a 9 km network), simplify to shed
   buffer vertex spam, drop slivers.

Skipped: tunnels (nothing to paint) and SKIP_HIGHWAY classes (steps,
platforms, proposed/construction). `area=yes` ways are surfaces already and
are used verbatim when closed. Bridges are kept — they are painted on the
terrain like any road; the later corridor grading is where a bridge needs
care.

Everything here is offline-testable: the HTTP call is the same
`osm.fetch_overpass` seam, assembly is pure over hand-built Overpass JSON,
and reprojection is an injected callable (the command wires in
`rasterio.warp.transform`).

LICENSING — ODbL, as for fetch-osm: each polygon carries `source`,
`fetched` and the `osm_ids` of the ways merged into it; the collection
carries `attribution`.
"""

from __future__ import annotations

from dataclasses import dataclass

from shapely.geometry import LineString, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from golfpipe.osm import ATTRIBUTION, Reproject, _closed, _polygon_coordinates, _way_points, parse_metres
from golfpipe.water import GEOJSON_CRS_3006

# Total width in metres per highway class, used when a way carries neither
# `width` nor `lanes`. Swedish rural/suburban defaults: a two-lane tertiary
# is 6 m, a residential street 5, a service road/driveway 3.5, a forest
# track 3.
CLASS_WIDTH_M: dict[str, float] = {
    "motorway": 12.0, "motorway_link": 6.0,
    "trunk": 9.0, "trunk_link": 6.0,
    "primary": 7.0, "primary_link": 5.0,
    "secondary": 6.5, "secondary_link": 5.0,
    "tertiary": 6.0, "tertiary_link": 5.0,
    "unclassified": 5.0,
    "residential": 5.0,
    "living_street": 4.5,
    "service": 3.5,
    "track": 3.0,
    "pedestrian": 3.0,
    "cycleway": 2.5,
    "bridleway": 2.0,
    "footway": 1.5,
    "path": 1.2,
    "road": 4.0,
}
LANE_WIDTH_M = 3.25
CARTPATH_WIDTH_M = 2.5
# Widths outside this range are mis-tagged (a "30" km/h, a "0.3" kerb).
WIDTH_RANGE_M = (0.5, 40.0)

# Merge group per class — `properties.road_class` in the output.
ROAD_GROUP: dict[str, str] = {
    **{k: "road" for k in (
        "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
        "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
        "residential", "living_street", "service", "pedestrian", "road",
    )},
    "track": "track",
    **{k: "path" for k in ("cycleway", "bridleway", "footway", "path")},
}
SKIP_HIGHWAY = frozenset({
    "steps", "platform", "bus_stop", "elevator", "corridor",
    "proposed", "construction", "abandoned", "razed",
})
TUNNEL_VALUES = frozenset({"yes", "building_passage", "culvert"})

# Douglas-Peucker on the buffered ring. Small on purpose: the ring is dense
# (a smoothed centerline sampled every metre) and its round caps' vertices
# sit 2.5·(1−cos 22.5°) ≈ 0.19 m inboard of the side's tangent, so a 0.25 m
# tolerance let a whole straight side collapse onto a chord between two cap
# vertices — the corridor came out 0.2 m narrower. 0.1 m keeps the sides
# where they are and still thins a 1 m-sampled straight to its ends.
DEFAULT_SIMPLIFY_M = 0.1
DEFAULT_MIN_AREA_M2 = 4.0
# Round joins/caps; 4 segments per quarter circle is plenty at road widths
# and keeps the vertex count down before simplify.
BUFFER_QUAD_SEGS = 4

FEATURE_TYPE = "path"


@dataclass
class RoadWay:
    osm_id: int
    highway: str
    group: str
    width_m: float
    width_source: str  # "width tag" | "lanes tag" | "golf=cartpath" | "class" | "area"
    geometry: BaseGeometry  # EPSG:3006 corridor polygon (already buffered)
    centerline: LineString | None = None  # EPSG:3006; None for area=yes surfaces


def parse_width_m(raw) -> float | None:
    """`width=*` -> metres, or None when it isn't a plain metre value in
    WIDTH_RANGE_M ("narrow", feet, "3 lanes" all give None).
    """
    return parse_metres(raw, *WIDTH_RANGE_M)


def road_width_m(tags: dict, class_widths: dict[str, float] | None = None) -> tuple[float, str] | None:
    """Total corridor width for a way with the reason it was chosen, or None
    when the way is not a road we paint (no/skipped highway class, tunnel).
    Precedence: width tag > lanes tag > cartpath > class table.
    """
    if not tags:
        return None
    highway = tags.get("highway")
    cartpath = tags.get("golf") == "cartpath"
    if highway in SKIP_HIGHWAY:
        return None
    if tags.get("tunnel") in TUNNEL_VALUES:
        return None
    if highway is None and not cartpath:
        return None

    width = parse_width_m(tags.get("width")) or parse_width_m(tags.get("est_width"))
    if width is not None:
        return width, "width tag"
    lanes = str(tags.get("lanes", "")).strip()
    if lanes.isdigit() and 1 <= int(lanes) <= 8:
        return int(lanes) * LANE_WIDTH_M, "lanes tag"
    if cartpath:
        return CARTPATH_WIDTH_M, "golf=cartpath"
    table = {**CLASS_WIDTH_M, **(class_widths or {})}
    if highway in table:
        return table[highway], "class"
    return None


def road_group(tags: dict) -> str:
    if tags.get("golf") == "cartpath":
        return "path"
    return ROAD_GROUP.get(tags.get("highway", ""), "road")


def build_roads_query(bbox_wgs84: tuple[float, float, float, float]) -> str:
    """Overpass QL for every highway way plus cart paths without a highway
    tag, in bbox (west, south, east, north WGS84); `out geom` inlines the
    node coordinates so no separate node resolution is needed.
    """
    west, south, east, north = bbox_wgs84
    b = f"{south},{west},{north},{east}"  # Overpass bbox is (S,W,N,E)
    return (
        "[out:json][timeout:180];\n(\n"
        f'  way["highway"]({b});\n'
        f'  way["golf"="cartpath"]({b});\n'
        ");\nout geom;"
    )


def _reproject_points(points, reproject: Reproject) -> list[tuple[float, float]]:
    xs, ys = reproject([p[0] for p in points], [p[1] for p in points])
    return list(zip((float(x) for x in xs), (float(y) for y in ys)))


# A bend turning at least this much at one node is a real corner (a turn
# into a parking lot); gentler ones are OSM's sparse sampling of a curve.
CORNER_TURN_DEG = 70.0
# Spacing of the smoothed centerline's vertices (metres).
SMOOTH_STEP_M = 1.0


def _turn_deg(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    import math
    t = math.degrees(math.atan2(c[1] - b[1], c[0] - b[0]) - math.atan2(b[1] - a[1], b[0] - a[0]))
    t = abs((t + 180.0) % 360.0 - 180.0)
    return t


def smooth_polyline(
    points: list[tuple[float, float]],
    step_m: float = SMOOTH_STEP_M,
    corner_turn_deg: float = CORNER_TURN_DEG,
) -> list[tuple[float, float]]:
    """A Catmull-Rom curve through the nodes of an OSM way (EPSG:3006), sampled
    every `step_m`: OSM stores a bend as a few nodes 10-20 m apart, and a
    corridor buffered from the raw polyline shows those as flats between
    round joins. The nodes are on the road, so the curve through them is
    the centerline. A node turning `corner_turn_deg` or more is a real
    corner: the curve is broken there (straight in, straight out). Ends are
    kept as they are (endpoint tangents from the first/last segment).
    """
    import math

    pts = [points[0]]
    for p in points[1:]:
        if math.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1]) > 1e-6:
            pts.append(p)
    n = len(pts)
    if n < 3:
        return list(pts)
    corner = [True] + [_turn_deg(pts[i - 1], pts[i], pts[i + 1]) >= corner_turn_deg for i in range(1, n - 1)] + [True]

    out: list[tuple[float, float]] = [pts[0]]
    for i in range(n - 1):
        p1, p2 = pts[i], pts[i + 1]
        # Phantom neighbours past a corner/end: extend the segment straight.
        p0 = pts[i - 1] if i > 0 and not corner[i] else (2 * p1[0] - p2[0], 2 * p1[1] - p2[1])
        p3 = pts[i + 2] if i + 2 < n and not corner[i + 1] else (2 * p2[0] - p1[0], 2 * p2[1] - p1[1])
        length = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        samples = max(int(math.ceil(length / step_m)), 1)
        for k in range(1, samples):
            t = k / samples
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            out.append((x, y))
        out.append(p2)  # the node itself, exactly
    return out


def assemble_roads(
    overpass_json: dict,
    reproject: Reproject,
    class_widths: dict[str, float] | None = None,
) -> tuple[list[RoadWay], list[str]]:
    """Overpass `out geom` JSON -> one buffered EPSG:3006 corridor per road
    way, plus `skipped` notes for ways ignored for a reason worth reading
    (non-road ways are silently common and not logged).
    """
    roads: list[RoadWay] = []
    skipped: list[str] = []
    for element in overpass_json.get("elements", []):
        if element.get("type") != "way":
            continue
        tags = element.get("tags", {})
        eid = element.get("id")
        resolved = road_width_m(tags, class_widths)
        if resolved is None:
            continue
        width, source = resolved
        points = _way_points(element.get("geometry", []))
        if len(points) < 2:
            skipped.append(f"way/{eid}: {tags.get('highway')} way has fewer than 2 points")
            continue
        group = road_group(tags)
        highway = tags.get("highway") or "cartpath"

        line = None
        if tags.get("area") == "yes":
            # An OSM area is a closed way; an open one is a tagging error,
            # not something to close for the mapper.
            if not _closed(points):
                skipped.append(f"way/{eid}: area=yes {highway} is not a closed ring")
                continue
            geometry = Polygon(_reproject_points(points, reproject))
            source = "area"
        else:
            line = LineString(smooth_polyline(_reproject_points(points, reproject)))
            if line.length <= 0:
                skipped.append(f"way/{eid}: {highway} way has zero length")
                continue
            geometry = line.buffer(width / 2.0, quad_segs=BUFFER_QUAD_SEGS, cap_style="round", join_style="round")
        roads.append(RoadWay(eid, highway, group, width, source, geometry, line))
    return roads, skipped


@dataclass
class RoadPolygon:
    group: str
    polygon: Polygon
    osm_ids: list[int]
    highways: list[str]


def merge_corridors(
    roads: list[RoadWay],
    clip: BaseGeometry | None = None,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    merge: bool = False,
) -> list[RoadPolygon]:
    """One polygon per OSM way by default: an OSM offset is nearly always a
    whole way traced off other imagery, and a way that is its own feature
    is fixed with one drag in the app, where a unioned network would move
    every road at once. Junction overlaps are harmless — the same OPCD
    surface either way. `merge=True` unions the corridors per group into
    road-network polygons instead (enclosed blocks as holes; one feature
    with thousands of vertices — for a Blender cut with no seams, not for
    editing). Both clip to `clip` (EPSG:3006), simplify and drop slivers;
    each polygon remembers the ways behind it. Largest first.
    """
    out: list[RoadPolygon] = []
    for group in sorted({r.group for r in roads}):
        members = [r for r in roads if r.group == group]
        units: list[tuple[BaseGeometry, list[RoadWay]]] = (
            [(unary_union([r.geometry for r in members]), members)] if merge
            else [(r.geometry, [r]) for r in members]
        )
        for unit, sources in units:
            if clip is not None:
                unit = unit.intersection(clip)
            for polygon in _each_polygon(unit):
                if polygon.area < min_area_m2:
                    continue
                simplified = polygon.simplify(simplify_m, preserve_topology=True)
                if simplified.is_empty or simplified.geom_type != "Polygon":
                    continue
                feeders = [r for r in sources if r.geometry.intersects(polygon)] if merge else sources
                out.append(RoadPolygon(
                    group=group,
                    polygon=simplified,
                    osm_ids=sorted({r.osm_id for r in feeders}),
                    highways=sorted({r.highway for r in feeders}),
                ))
    out.sort(key=lambda p: (-p.polygon.area, p.group))
    return out


def _each_polygon(geom: BaseGeometry):
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        for part in geom.geoms:
            yield from _each_polygon(part)


def build_roads_geojson(polygons: list[RoadPolygon], *, fetch_date: str) -> dict:
    """EPSG:3006 FeatureCollection: `type` always `path`; `road_class` is
    the merge group for the wizard to bucket on; ODbL provenance per
    feature and `attribution` on the collection.
    """
    features = []
    for rp in polygons:
        features.append({
            "type": "Feature",
            "properties": {
                "type": FEATURE_TYPE,
                # The corridor IS the shape (buffered, unioned, simplified):
                # the wizard imports it verbatim instead of spline-fitting
                # it — a network ring kilometres long collapses under the
                # fitter's control cap.
                "exact": True,
                "road_class": rp.group,
                "highways": rp.highways,
                "area_m2": round(rp.polygon.area, 1),
                "source": "osm",
                "osm_ids": rp.osm_ids,
                "fetched": fetch_date,
            },
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(rp.polygon)},
        })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": features,
    }


# ─── centerlines: the input for grading the roads into the DEM ───────────────

GRADES_ORIGIN = "road-grades"
DEFAULT_GRADE_FEATHER_M = 2.0
DEFAULT_GRADE_SMOOTH_M = 25.0


def _each_line(geom: BaseGeometry):
    if geom.is_empty:
        return
    if geom.geom_type == "LineString":
        yield geom
    elif geom.geom_type in ("MultiLineString", "GeometryCollection"):
        for part in geom.geoms:
            yield from _each_line(part)


def build_centerlines_geojson(ways: list[RoadWay], *, fetch_date: str, clip: BaseGeometry | None = None) -> dict:
    """EPSG:3006 LineString FeatureCollection of the road centerlines with
    their resolved widths — what `road-grades` turns into corridor terrain
    edits. Clipped to `clip` like the corridors (a way cut by the edge can
    come back in several pieces, each its own feature)."""
    features = []
    for way in ways:
        if way.centerline is None:
            continue
        line = way.centerline.intersection(clip) if clip is not None else way.centerline
        for index, part in enumerate(_each_line(line)):
            if part.length <= 0:
                continue
            features.append({
                "type": "Feature",
                "properties": {
                    "id": f"osm:way/{way.osm_id}" + (f"#{index}" if index else ""),
                    "highway": way.highway,
                    "road_class": way.group,
                    "widthM": round(way.width_m, 2),
                    "widthSource": way.width_source,
                    "lengthM": round(part.length, 1),
                    "source": "osm",
                    "osm_id": way.osm_id,
                    "fetched": fetch_date,
                },
                "geometry": {"type": "LineString", "coordinates": [[round(x, 2), round(y, 2)] for x, y, *_ in part.coords]},
            })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": features,
    }


@dataclass
class Centerline:
    id: str
    highway: str
    group: str
    width_m: float
    line: LineString  # EPSG:3006


def read_centerlines(path) -> list[Centerline]:
    """Reads a fetch-roads `--centerlines-out` file back."""
    import json
    from pathlib import Path

    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    crs = (doc.get("crs") or {}).get("properties", {}).get("name", "")
    if doc.get("type") != "FeatureCollection" or "3006" not in crs:
        raise ValueError(f"{path} is not an EPSG:3006 road centerlines file (fetch-roads --centerlines-out)")
    out: list[Centerline] = []
    for feature in doc.get("features", []):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString" or len(geometry.get("coordinates", [])) < 2:
            continue
        out.append(Centerline(
            id=props["id"], highway=props.get("highway", ""), group=props.get("road_class", "road"),
            width_m=float(props["widthM"]), line=LineString(geometry["coordinates"]),
        ))
    return out


def grade_edit_features(
    centerlines: list[Centerline],
    to_wgs84: Reproject,
    *,
    feather_m: float = DEFAULT_GRADE_FEATHER_M,
    smooth_m: float = DEFAULT_GRADE_SMOOTH_M,
    created_at: str = "",
) -> list[dict]:
    """One D-TE5 `corridor` terrain edit per centerline: the polygon is the
    paved corridor grown by `feather_m` (dem_edit feathers inside the
    polygon, so the paved width itself stays fully graded), the centerline
    and `widthM` ride along in the properties for the along/across frame
    and the profile sampling, `smoothM` is the along-road window. Same
    origin/originRef/createdAt conventions as the building pads so the
    server import replaces a generation cleanly."""
    features = []
    for index, c in enumerate(centerlines):
        polygon = c.line.buffer(c.width_m / 2.0 + feather_m, quad_segs=BUFFER_QUAD_SEGS, cap_style="round", join_style="round")
        exterior = list(polygon.exterior.coords)
        lons, lats = to_wgs84([p[0] for p in exterior], [p[1] for p in exterior])
        ring = [[round(float(lon), 7), round(float(lat), 7)] for lon, lat in zip(lons, lats)]
        clons, clats = to_wgs84([p[0] for p in c.line.coords], [p[1] for p in c.line.coords])
        centerline = [[round(float(lon), 7), round(float(lat), 7)] for lon, lat in zip(clons, clats)]
        features.append({
            "type": "Feature",
            "properties": {
                "op": "corridor",
                "featherM": feather_m,
                "smoothM": smooth_m,
                "widthM": round(c.width_m, 2),
                "centerline": centerline,
                "createdAt": f"{created_at}#{index:05d}" if created_at else None,
                "origin": GRADES_ORIGIN,
                "originRef": c.id,
                "highway": c.highway,
                "road_class": c.group,
                "lengthM": round(c.line.length, 1),
            },
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })
    return features


def bbox_polygon_3006(bbox_wgs84: tuple[float, float, float, float], reproject: Reproject) -> Polygon:
    """The WGS84 area as an EPSG:3006 polygon, edges densified so the clip
    follows the graticule instead of cutting straight between the corners.
    """
    west, south, east, north = bbox_wgs84
    n = 16
    ring: list[tuple[float, float]] = []
    ring += [(west + (east - west) * i / n, south) for i in range(n)]
    ring += [(east, south + (north - south) * i / n) for i in range(n)]
    ring += [(east - (east - west) * i / n, north) for i in range(n)]
    ring += [(west, north - (north - south) * i / n) for i in range(n)]
    return Polygon(_reproject_points(ring, reproject))
