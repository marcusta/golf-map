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

Parking lots: `amenity=parking` areas (closed ways and multipolygon
relations) that are surface lots are fetched too, used as mapped — they ARE
the paved surface, where the aisles OSM draws through them only cover strips
of it. Their `road_class` is `parking`; `service` ways lying inside a lot
(PARKING_AISLE_INSIDE of their length) are absorbed into it — dropped, lending
the lot their surface when it has none. Grading smooths each lot's lidar
ground (a `smooth` edit, lot_grade_features) instead of a corridor.

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

from dataclasses import dataclass, field

from shapely.geometry import LineString, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from golfpipe.osm import (
    ATTRIBUTION, Reproject, _closed, _polygon_coordinates, _reproject_ring, _rings_to_polygons, _way_points,
    parse_metres, stitch_rings,
)
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
# Douglas-Peucker on the centerline handed to the app with a one-way corridor
# (`centerline` property). The app draws a curve THROUGH the kept points
# (shared/features/centerline.ts), which hugs the 1 m-sampled smooth line far
# closer than the chords do, so a coarse tolerance keeps the line editable —
# a point every ~10 m on a 30 m-radius bend, two on a straight.
CENTERLINE_SIMPLIFY_M = 0.25
# Round joins/caps; 4 segments per quarter circle is plenty at road widths
# and keeps the vertex count down before simplify.
BUFFER_QUAD_SEGS = 4

FEATURE_TYPE = "path"

# Parking lots (`amenity=parking`): the road_class / group they carry, and the
# `parking=*` kinds that are not a surface lot we paint (under a roof, in a
# building, under the ground).
PARKING_GROUP = "parking"
PARKING_SKIP = frozenset({"underground", "multi-storey", "rooftop", "garage_boxes", "carports", "garages"})
# A service way with at least this share of its length inside a lot is one of
# the lot's aisles: the lot polygon already covers it.
PARKING_AISLE_INSIDE = 0.8


def is_parking_lot(tags: dict) -> bool:
    return tags.get("amenity") == "parking" and str(tags.get("parking", "surface")) not in PARKING_SKIP


@dataclass
class RoadWay:
    osm_id: int | None  # None for a road only NVDB knows (golfpipe.nvdb.fuse)
    highway: str
    group: str
    width_m: float
    # "width tag" | "lanes tag" | "golf=cartpath" | "class" | "area" | "nvdb" | "nvdb type"
    width_source: str
    geometry: BaseGeometry  # EPSG:3006 corridor polygon (already buffered)
    centerline: LineString | None = None  # EPSG:3006; None for area=yes surfaces
    surface: str | None = None  # one of PATH_SURFACES, or None (unknown)
    nvdb_ids: list[str] = field(default_factory=list)  # NVDB elements it runs along / came from


# The app's path surfaces — the `surface` attribute on `path` features
# (shared/features/path-surface.ts is the app's copy; keep them equal). The
# GSPro export merges the roads of every surface into one concrete shape per
# network (grass tracks apart, as rough); the surfaces go to the `-paths.json`
# sidecar and pick the look and the collider material in Unity (Blender cuts a
# mixed shape's mesh along the seams first).
PATH_SURFACES = ("asphalt", "concrete", "paving", "gravel", "gravel-track", "dirt", "grass", "wood")

# OSM `surface=*` -> a PATH_SURFACES value. Generic `paved` is asphalt (what a
# paved Swedish road almost always is), generic `unpaved` gravel; anything
# not listed stays unknown.
OSM_SURFACE: dict[str, str] = {
    **{v: "asphalt" for v in ("asphalt", "paved", "chipseal")},
    **{v: "concrete" for v in ("concrete", "concrete:plates", "concrete:lanes")},
    **{v: "paving" for v in ("paving_stones", "sett", "cobblestone", "unhewn_cobblestone", "bricks", "grass_paver")},
    **{v: "gravel" for v in ("gravel", "fine_gravel", "compacted", "pebblestone", "unpaved", "rock")},
    **{v: "dirt" for v in ("dirt", "earth", "ground", "mud", "sand", "woodchips")},
    "grass": "grass",
    "wood": "wood",
}


# A farm track of tracktype grade2/grade3 (mostly gravel, or gravel and soil mixed) is a gravel road with grass
# down the middle between the wheel tracks (grusväg med gräsmitt) unless it says it is paved or plain soil.
OSM_GRAVEL_TRACK_TYPES = ("grade2", "grade3")


def osm_surface(tags: dict) -> str | None:
    surface = OSM_SURFACE.get(str(tags.get("surface", "")).strip().lower())
    if (tags.get("highway") == "track" and str(tags.get("tracktype", "")).strip().lower() in OSM_GRAVEL_TRACK_TYPES
            and surface in (None, "gravel")):
        return "gravel-track"
    return surface


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
    tag and parking lots (ways and relations), in bbox (west, south, east, north WGS84); `out geom` inlines the
    node coordinates so no separate node resolution is needed.
    """
    west, south, east, north = bbox_wgs84
    b = f"{south},{west},{north},{east}"  # Overpass bbox is (S,W,N,E)
    return (
        "[out:json][timeout:180];\n(\n"
        f'  way["highway"]({b});\n'
        f'  way["golf"="cartpath"]({b});\n'
        f'  way["amenity"="parking"]({b});\n'
        f'  relation["amenity"="parking"]({b});\n'
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
        tags = element.get("tags", {})
        eid = element.get("id")
        if is_parking_lot(tags):
            lots, note = _parking_lot_polygons(element, reproject)
            if note:
                skipped.append(note)
            roads += [RoadWay(eid, PARKING_GROUP, PARKING_GROUP, 0.0, "area", lot, None, surface=osm_surface(tags)) for lot in lots]
            continue
        if element.get("type") != "way":
            continue
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
        roads.append(RoadWay(eid, highway, group, width, source, geometry, line, surface=osm_surface(tags)))
    return roads, skipped


def _parking_lot_polygons(element: dict, reproject: Reproject) -> tuple[list[Polygon], str | None]:
    """A parking lot element -> its EPSG:3006 polygons (a relation's outer
    rings, inners as holes), or a note when it has no closed ring."""
    eid = element.get("id")
    if element.get("type") == "way":
        points = _way_points(element.get("geometry", []))
        if len(points) < 4 or not _closed(points):
            return [], f"way/{eid}: parking lot is not a closed ring"
        return [Polygon(_reproject_points(points, reproject))], None
    if element.get("type") == "relation":
        outer, inner = [], []
        for member in element.get("members", []):
            if member.get("type") == "way" and member.get("geometry"):
                (inner if member.get("role") == "inner" else outer).append(_way_points(member["geometry"]))
        outer_rings = [_reproject_ring(r, reproject) for r in stitch_rings(outer)]
        if not outer_rings:
            return [], f"relation/{eid}: parking lot relation has no closed outer ring"
        return _rings_to_polygons(outer_rings, [_reproject_ring(r, reproject) for r in stitch_rings(inner)]), None
    return [], None


def absorb_parking_aisles(ways: list[RoadWay]) -> tuple[list[RoadWay], int]:
    """Drops the `service` ways (and NVDB-only roads) lying inside a parking
    lot — its aisles; the lot polygon is the surface they cross. A lot
    without a surface of its own takes the aisles' majority surface.
    Returns (ways, number absorbed)."""
    from collections import Counter
    from dataclasses import replace

    lots = [w for w in ways if w.group == PARKING_GROUP]
    if not lots:
        return ways, 0
    lot_union = unary_union([lot.geometry for lot in lots]).buffer(0.5)
    lent: dict[int, list[str]] = {}
    kept: list[RoadWay] = []
    absorbed = 0
    for way in ways:
        line = way.centerline
        candidate = line is not None and line.length > 0 and (way.highway == "service" or way.osm_id is None)
        if candidate and line.intersection(lot_union).length >= PARKING_AISLE_INSIDE * line.length:
            absorbed += 1
            if way.surface:
                host = max(range(len(lots)), key=lambda i: line.intersection(lots[i].geometry).length)
                lent.setdefault(host, []).append(way.surface)
            continue
        kept.append(way)
    for i, surfaces in lent.items():
        lot = lots[i]
        if lot.surface is None:
            kept[kept.index(lot)] = replace(lot, surface=Counter(surfaces).most_common(1)[0][0])
    return kept, absorbed


@dataclass
class RoadPolygon:
    group: str
    polygon: Polygon
    osm_ids: list[int]
    highways: list[str]
    nvdb_ids: list[str] = field(default_factory=list)
    surfaces: list[str] = field(default_factory=list)
    width_m: float | None = None  # when the polygon is one way's corridor
    width_source: str | None = None
    # One way's corridor: the stretch of its (clipped) centerline this polygon
    # was buffered from, for the app to edit as a line.
    centerline: LineString | None = None


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
                line = None
                if not merge and sources[0].centerline is not None and sources[0].width_source != "area":
                    line = _centerline_within(sources[0].centerline, clip, polygon)
                out.append(RoadPolygon(
                    group=group,
                    polygon=simplified,
                    osm_ids=sorted({r.osm_id for r in feeders if r.osm_id is not None}),
                    highways=sorted({r.highway for r in feeders}),
                    nvdb_ids=sorted({i for r in feeders for i in r.nvdb_ids}),
                    surfaces=sorted({r.surface for r in feeders if r.surface}),
                    width_m=feeders[0].width_m if len(feeders) == 1 else None,
                    width_source=feeders[0].width_source if len(feeders) == 1 else None,
                    centerline=line,
                ))
    out.sort(key=lambda p: (-p.polygon.area, p.group))
    return out


def _centerline_within(line: LineString, clip: BaseGeometry | None, polygon: Polygon) -> LineString | None:
    """The piece of a way's centerline (clipped like its corridor) that runs
    down `polygon` — a way leaving and re-entering the area is several
    corridor pieces, each with its own stretch of line — simplified for
    editing. None when no piece fits."""
    clipped = line.intersection(clip) if clip is not None else line
    parts = [part for part in _each_line(clipped) if part.length > 0]
    if not parts:
        return None
    best = max(parts, key=lambda part: part.intersection(polygon).length)
    if best.intersection(polygon).length <= 0:
        return None
    simplified = best.simplify(CENTERLINE_SIMPLIFY_M, preserve_topology=False)
    return simplified if simplified.length > 0 else None


def _each_polygon(geom: BaseGeometry):
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        for part in geom.geoms:
            yield from _each_polygon(part)


NVDB_LICENSE = "CC0-1.0"


def _provenance(osm_ids, nvdb_ids) -> dict:
    """Geometry decides the source: a corridor drawn from an OSM centerline
    is ODbL even when NVDB lent it its width; one only NVDB knows is CC0
    with the NVDB element as its source_ref."""
    if osm_ids:
        return {"source": "osm", "license": "ODbL", "osm_ids": list(osm_ids), "nvdb_ids": list(nvdb_ids)}
    return {"source": "nvdb", "license": NVDB_LICENSE, "source_ref": f"nvdb:{nvdb_ids[0]}" if nvdb_ids else None,
            "nvdb_ids": list(nvdb_ids)}


def build_roads_geojson(polygons: list[RoadPolygon], *, fetch_date: str, attribution: str = ATTRIBUTION) -> dict:
    """EPSG:3006 FeatureCollection: `type` always `path`; `road_class` is
    the merge group for the wizard to bucket on; `surface` paved / unpaved
    (PATH_SURFACES) when known — left out when a merged network mixes
    several; provenance per
    feature (see _provenance) and `attribution` on the collection.
    """
    features = []
    for rp in polygons:
        props = {
            "type": FEATURE_TYPE,
            # The corridor IS the shape (buffered, unioned, simplified):
            # the wizard imports it verbatim instead of spline-fitting
            # it — a network ring kilometres long collapses under the
            # fitter's control cap.
            "exact": True,
            "road_class": rp.group,
            "highways": rp.highways,
            "surface": rp.surfaces[0] if len(rp.surfaces) == 1 else None,
            "area_m2": round(rp.polygon.area, 1),
            **_provenance(rp.osm_ids, rp.nvdb_ids),
            "fetched": fetch_date,
        }
        if rp.width_m is not None and rp.width_source != "area":
            props["widthM"] = round(rp.width_m, 2)
            props["widthSource"] = rp.width_source
            if rp.centerline is not None:
                # The app imports the road as this line + widthM (the
                # polygon is its fallback when the line is unusable).
                props["centerline"] = [[round(x, 2), round(y, 2)] for x, y, *_ in rp.centerline.coords]
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(rp.polygon)},
        })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": attribution,
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


def build_centerlines_geojson(ways: list[RoadWay], *, fetch_date: str, clip: BaseGeometry | None = None,
                              attribution: str = ATTRIBUTION) -> dict:
    """EPSG:3006 FeatureCollection of the road centerlines (LineStrings) with
    their resolved widths, plus the parking lots (Polygons, `road_class`
    parking) — what `road-grades` turns into corridor / plane terrain
    edits. Clipped to `clip` like the corridors (a way cut by the edge can
    come back in several pieces, each its own feature)."""
    features = []
    for way in ways:
        if way.group == PARKING_GROUP:
            lot = way.geometry.intersection(clip) if clip is not None else way.geometry
            for index, part in enumerate(_each_polygon(lot)):
                if part.area < DEFAULT_MIN_AREA_M2:
                    continue
                features.append({
                    "type": "Feature",
                    "properties": {
                        "id": f"osm:parking/{way.osm_id}" + (f"#{index}" if index else ""),
                        "highway": PARKING_GROUP,
                        "road_class": PARKING_GROUP,
                        "surface": way.surface,
                        "areaM2": round(part.area, 1),
                        "source": "osm",
                        "osm_id": way.osm_id,
                        "fetched": fetch_date,
                    },
                    "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(part)},
                })
            continue
        if way.centerline is None:
            continue
        line = way.centerline.intersection(clip) if clip is not None else way.centerline
        base = f"osm:way/{way.osm_id}" if way.osm_id is not None else f"nvdb:{way.nvdb_ids[0]}"
        for index, part in enumerate(_each_line(line)):
            if part.length <= 0:
                continue
            features.append({
                "type": "Feature",
                "properties": {
                    "id": base + (f"#{index}" if index else ""),
                    "highway": way.highway,
                    "road_class": way.group,
                    "widthM": round(way.width_m, 2),
                    "widthSource": way.width_source,
                    "surface": way.surface,
                    "lengthM": round(part.length, 1),
                    "source": "osm" if way.osm_id is not None else "nvdb",
                    "osm_id": way.osm_id,
                    "nvdb_ids": way.nvdb_ids,
                    "fetched": fetch_date,
                },
                "geometry": {"type": "LineString", "coordinates": [[round(x, 2), round(y, 2)] for x, y, *_ in part.coords]},
            })
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": attribution,
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
    first_index: int = 0,
) -> list[dict]:
    """One D-TE5 `corridor` terrain edit per centerline: the polygon is the
    paved corridor grown by `feather_m` (dem_edit feathers inside the
    polygon, so the paved width itself stays fully graded), the centerline
    and `widthM` ride along in the properties for the along/across frame
    and the profile sampling, `smoothM` is the along-road window. Same
    origin/originRef/createdAt conventions as the building pads so the
    server import replaces a generation cleanly. `first_index` continues the
    parking lots' createdAt numbering: the roads replay after the lots."""
    features = []
    for index, c in enumerate(centerlines, start=first_index):
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


@dataclass
class ParkingLot:
    id: str
    polygon: Polygon  # EPSG:3006
    surface: str | None


def read_parking_lots(path) -> list[ParkingLot]:
    """The parking lots in a fetch-roads `--centerlines-out` file."""
    import json
    from pathlib import Path

    from shapely.geometry import shape

    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    out: list[ParkingLot] = []
    for feature in doc.get("features", []):
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Polygon" or props.get("road_class") != PARKING_GROUP:
            continue
        out.append(ParkingLot(id=props["id"], polygon=shape(geometry), surface=props.get("surface")))
    return out


DEFAULT_LOT_FEATHER_M = 2.0
# The median radius a lot's ground is smoothed over: wide enough to take out
# a mound or a lidar seam, small against a lot, so its slope and bends stay.
DEFAULT_LOT_SMOOTH_RADIUS_M = 4.0


def lot_grade_features(
    lots: list[ParkingLot],
    to_wgs84: Reproject,
    *,
    feather_m: float = DEFAULT_LOT_FEATHER_M,
    radius_m: float = DEFAULT_LOT_SMOOTH_RADIUS_M,
    created_at: str = "",
    first_index: int = 0,
) -> list[dict]:
    """One D-TE5 `smooth` terrain edit per parking lot: the lidar ground under
    the lot through a `radius_m` median (dem_edit), over the lot grown by
    `feather_m` (dem_edit feathers inside the polygon, so the lot itself is
    fully smoothed). A lot keeps the slope and the gentle bends it was built
    with and loses the bumps. One least-squares plane per lot did not: real
    lots are not planes (Omberg's 8,500 m² yard bends 1.6 m off its best
    plane), and neighbouring lots' planes met in shelves up to 0.8 m.
    Holes are graded with the lot. Same origin as the road corridors, and
    numbered before them, so the lots replay FIRST: a corridor takes its
    profile from the heights as they are when it replays, so a road ending
    at a lot runs into the smoothed lot, and a road passing through or along
    one stays one smooth line. Replayed after the roads, a lot overwrote the
    graded road inside it and its feather left a step where the road went
    on (Vreta: 1.5 m in 3 m beside a gravel yard)."""
    features = []
    for offset, lot in enumerate(lots):
        polygon = Polygon(lot.polygon.exterior).buffer(feather_m, quad_segs=BUFFER_QUAD_SEGS, join_style="round")
        exterior = list(polygon.exterior.coords)
        lons, lats = to_wgs84([p[0] for p in exterior], [p[1] for p in exterior])
        ring = [[round(float(lon), 7), round(float(lat), 7)] for lon, lat in zip(lons, lats)]
        index = first_index + offset
        features.append({
            "type": "Feature",
            "properties": {
                "op": "smooth",
                "featherM": feather_m,
                "radiusM": radius_m,
                "createdAt": f"{created_at}#{index:05d}" if created_at else None,
                "origin": GRADES_ORIGIN,
                "originRef": lot.id,
                "highway": PARKING_GROUP,
                "road_class": PARKING_GROUP,
                "areaM2": round(lot.polygon.area, 1),
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


def square_polygon_3006(square_3006: tuple[float, float, float, float]) -> Polygon:
    """An EPSG:3006 terrain square (x0, y0, x1, y1) as the clip polygon. The
    WGS84 envelope of the square is larger than it (the grid is turned off
    north by the meridian convergence), so clipping to bbox_polygon_3006 of
    that envelope lets roads run 10-15 m past the square's edges."""
    x0, y0, x1, y1 = square_3006
    return Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


# Course features that define "near the course" for fetch-roads --near: the
# playing surfaces and penalty areas someone mapped. Not water or creeks (an
# imported watercourse runs kilometres off the course and would pull in every
# road along it; a pond on the course is within reach of its fairways anyway),
# not the roads themselves (a previous import would grow the area along every
# road), not the deep-rough / outside / OOB fill, not generated vegetation.
NEAR_TYPES = frozenset({
    "green", "tee", "fairway", "semi_rough", "rough", "bunker",
    "penalty_yellow", "penalty_red",
})
DEFAULT_NEAR_M = 200.0


def near_area_3006(doc: dict, reproject: Reproject, distance_m: float = DEFAULT_NEAR_M) -> BaseGeometry | None:
    """The course features in a GeoJSON FeatureCollection (EPSG:3006 when
    its `crs` says so, else WGS84 — the app's course features), grown by
    `distance_m`: roads farther than that from anything on the course are
    scenery. Only NEAR_TYPES count when a feature says its `type`; untyped
    features all count, generated ones never. None when nothing qualifies.
    A self-intersecting drawn outline is repaired first, so one bad feature
    does not fail the union of them all."""
    from shapely import make_valid
    from shapely.geometry import shape
    from shapely.ops import transform as shapely_transform

    crs = (doc.get("crs") or {}).get("properties", {}).get("name", "")
    in_3006 = "3006" in crs

    def to_3006(xs, ys, zs=None):
        es, ns = reproject(list(xs), list(ys))
        return list(es), list(ns)

    parts = []
    for feature in doc.get("features", []):
        props = feature.get("properties") or {}
        kind = props.get("type")
        if (kind is not None and kind not in NEAR_TYPES) or props.get("generated"):
            continue
        try:
            geom = shape(feature.get("geometry"))
        except Exception:  # noqa: BLE001 — a malformed feature is skipped
            continue
        if geom.is_empty:
            continue
        parts.append(make_valid(geom if in_3006 else shapely_transform(to_3006, geom)))
    if not parts:
        return None
    return unary_union(parts).buffer(distance_m, quad_segs=8)
