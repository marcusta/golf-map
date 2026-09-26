"""Parking lots in fetch-roads / road-grades — offline, hand-built Overpass
JSON through the fetch seam (the shape `out geom;` returns: ways with an
inline `geometry`, relations with member ways carrying theirs).
"""

from __future__ import annotations

import json
from pathlib import Path

from rasterio.crs import CRS
from rasterio.warp import transform as warp_transform
from shapely.geometry import LineString, Point, Polygon, shape

from golfpipe import roads
from golfpipe.commands import cmd_fetch_roads, cmd_road_grades
from grass_zones import load_roads

BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)


def reproject(lons, lats):
    return warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))


def geom(points):
    return [{"lat": lat, "lon": lon} for lon, lat in points]


def way(osm_id, points, **tags):
    return {"type": "way", "id": osm_id, "tags": tags, "geometry": geom(points)}


def ring(w, s, e, n):
    return [(w, s), (e, s), (e, n), (w, n), (w, s)]


# A ~120 x 110 m lot with one aisle down its middle, an access road running
# up to its south edge, and a street passing along its north side.
LOT = ring(15.550, 58.400, 15.552, 58.401)
AISLE = [(15.551, 58.4001), (15.551, 58.4009)]
ACCESS = [(15.551, 58.3990), (15.551, 58.4000)]
STREET = [(15.549, 58.4012), (15.553, 58.4012)]


def p3006(lon, lat):
    xs, ys = reproject([lon], [lat])
    return Point(xs[0], ys[0])


def test_query_asks_for_parking_ways_and_relations():
    q = roads.build_roads_query(BBOX_WGS84)
    assert 'way["amenity"="parking"]' in q and 'relation["amenity"="parking"]' in q


def test_surface_lots_become_parking_areas_and_covered_ones_are_skipped():
    doc = {"elements": [
        way(1, LOT, amenity="parking", parking="surface", surface="asphalt"),
        way(2, ring(15.560, 58.405, 15.561, 58.4055), amenity="parking"),  # no parking=* : a surface lot
        way(3, ring(15.570, 58.410, 15.571, 58.4105), amenity="parking", parking="underground"),
        way(4, ring(15.570, 58.411, 15.571, 58.4115), amenity="parking", parking="multi-storey"),
        way(5, LOT[:3], amenity="parking"),  # not closed
    ]}
    ways, skipped = roads.assemble_roads(doc, reproject)
    lots = {w.osm_id: w for w in ways}
    assert set(lots) == {1, 2}
    lot = lots[1]
    assert (lot.group, lot.highway, lot.width_source, lot.surface) == ("parking", "parking", "area", "asphalt")
    assert lot.centerline is None and lot.geometry.geom_type == "Polygon"
    assert lot.geometry.contains(p3006(15.551, 58.4005))
    assert lots[2].surface is None
    assert skipped == ["way/5: parking lot is not a closed ring"]


def test_a_multipolygon_lot_keeps_its_island_as_a_hole():
    island = ring(15.5508, 58.4004, 15.5512, 58.4006)
    rel = {"type": "relation", "id": 77, "tags": {"type": "multipolygon", "amenity": "parking"}, "members": [
        {"type": "way", "role": "outer", "geometry": geom(LOT)},
        {"type": "way", "role": "inner", "geometry": geom(island)},
    ]}
    [lot], _ = roads.assemble_roads({"elements": [rel]}, reproject)
    assert lot.osm_id == 77 and len(lot.geometry.interiors) == 1
    assert not lot.geometry.contains(p3006(15.551, 58.4005))  # the island
    assert lot.geometry.contains(p3006(15.5503, 58.4005))


def test_aisles_inside_a_lot_are_absorbed_and_lend_it_their_surface():
    doc = {"elements": [
        way(1, LOT, amenity="parking"),
        way(2, AISLE, highway="service", service="parking_aisle", surface="asphalt"),
        way(3, ACCESS, highway="service"),  # ends at the lot edge: kept
        way(4, STREET, highway="residential"),  # outside: kept
    ]}
    ways, _ = roads.assemble_roads(doc, reproject)
    kept, absorbed = roads.absorb_parking_aisles(ways)
    assert absorbed == 1
    assert sorted(w.osm_id for w in kept) == [1, 3, 4]
    lot = next(w for w in kept if w.group == "parking")
    assert lot.surface == "asphalt"


def test_fetch_roads_writes_the_lot_as_one_feature_and_road_grades_fits_it_a_plane(tmp_path: Path, capsys):
    elements = [
        way(1, LOT, amenity="parking", parking="surface"),
        way(2, AISLE, highway="service", service="parking_aisle", surface="gravel"),
        way(3, ACCESS, highway="service"),
    ]
    out, lines = tmp_path / "roads.geojson", tmp_path / "roads-centerlines.geojson"
    cmd_fetch_roads(BBOX_WGS84, out, overpass_fetch=lambda q, *, url="": {"elements": elements}, centerlines_out=lines)
    assert "Parking lots: 1 (absorbed 1 aisle(s) inside them)" in capsys.readouterr().out

    features = json.loads(out.read_text(encoding="utf-8"))["features"]
    parking = [f["properties"] for f in features if f["properties"]["road_class"] == "parking"]
    assert len(parking) == 1 and len(features) == 2  # the lot + the access road; no aisle strip
    assert parking[0]["surface"] == "gravel" and parking[0]["osm_ids"] == [1] and "widthM" not in parking[0]

    doc = json.loads(lines.read_text(encoding="utf-8"))
    lot_feature = next(f for f in doc["features"] if f["properties"]["road_class"] == "parking")
    assert lot_feature["geometry"]["type"] == "Polygon" and lot_feature["properties"]["id"] == "osm:parking/1"
    # The road loader ignores polygons; the lot reader finds them; grass keeps off both.
    assert [c.id for c in roads.read_centerlines(lines)] == ["osm:way/3"]
    [lot] = roads.read_parking_lots(lines)
    assert lot.surface == "gravel"
    blockers = load_roads(lines)
    assert sorted(type(g).__name__ for g, _ in blockers) == ["LineString", "Polygon"]

    edits_out = tmp_path / "grades.geojson"
    cmd_road_grades(lines, edits_out)
    edits = json.loads(edits_out.read_text(encoding="utf-8"))["features"]
    assert [e["properties"]["op"] for e in edits] == ["plane", "corridor"]  # the lot replays first
    plane = edits[0]["properties"]
    assert plane["originRef"] == "osm:parking/1" and plane["origin"] == "road-grades"
    assert "flat" not in plane  # tilted best fit, not dug level
    assert plane["createdAt"] < edits[1]["properties"]["createdAt"]
    # The edit polygon reaches featherM beyond the lot so the whole lot sits on the plane.
    lons, lats = zip(*edits[0]["geometry"]["coordinates"][0])
    xs, ys = reproject(lons, lats)
    edit_poly = Polygon(zip(xs, ys))
    assert edit_poly.area > lot.polygon.area
    assert edit_poly.buffer(-roads.DEFAULT_LOT_FEATHER_M + 0.2).contains(lot.polygon)
    assert "1 parking lot plane(s)" in capsys.readouterr().out

    cmd_road_grades(lines, edits_out, classes={"road"})
    assert [e["properties"]["op"] for e in json.loads(edits_out.read_text(encoding="utf-8"))["features"]] == ["corridor"]
