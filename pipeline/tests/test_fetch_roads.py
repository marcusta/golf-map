"""fetch-roads tests — fully offline. Overpass JSON is hand-built (the shape
`out geom;` returns for ways: an inline `geometry` list of {lat, lon}), and
the end-to-end command test stubs the Overpass HTTP call behind the
`overpass_fetch` seam so pytest never touches the network. Reprojection uses
rasterio locally.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from rasterio.crs import CRS
from rasterio.warp import transform as warp_transform
from shapely.geometry import Point, shape

from golfpipe import roads
from golfpipe.commands import cmd_fetch_roads

BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)


def reproject(lons, lats):
    return warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))


def geom(points):
    return [{"lat": lat, "lon": lon} for lon, lat in points]


def way(osm_id, points, **tags):
    return {"type": "way", "id": osm_id, "tags": tags, "geometry": geom(points)}


def p3006(lon, lat):
    xs, ys = reproject([lon], [lat])
    return Point(xs[0], ys[0])


# An east-west residential street and a service road teeing into it from
# the south, all inside BBOX_WGS84. ~0.002° lon ≈ 117 m at this latitude.
STREET = [(15.550, 58.400), (15.552, 58.400), (15.554, 58.400)]
DRIVEWAY = [(15.552, 58.399), (15.552, 58.400)]


# ─── width resolution ────────────────────────────────────────────────────────

def test_parse_width_accepts_metre_spellings_and_rejects_junk():
    assert roads.parse_width_m("3") == 3.0
    assert roads.parse_width_m("3.5") == 3.5
    assert roads.parse_width_m("3,5") == 3.5
    assert roads.parse_width_m("4 m") == 4.0
    assert roads.parse_width_m(" 2.5m ") == 2.5
    assert roads.parse_width_m("narrow") is None
    assert roads.parse_width_m("10'") is None
    assert roads.parse_width_m("0.3") is None  # below WIDTH_RANGE_M
    assert roads.parse_width_m("60") is None  # above
    assert roads.parse_width_m(None) is None


def test_road_width_precedence_width_lanes_cartpath_class():
    assert roads.road_width_m({"highway": "tertiary", "width": "7"}) == (7.0, "width tag")
    assert roads.road_width_m({"highway": "tertiary", "lanes": "2"}) == (2 * roads.LANE_WIDTH_M, "lanes tag")
    assert roads.road_width_m({"highway": "tertiary"}) == (roads.CLASS_WIDTH_M["tertiary"], "class")
    assert roads.road_width_m({"highway": "path", "golf": "cartpath"}) == (roads.CARTPATH_WIDTH_M, "golf=cartpath")
    assert roads.road_width_m({"golf": "cartpath"}) == (roads.CARTPATH_WIDTH_M, "golf=cartpath")
    # A width tag beats the cartpath default too.
    assert roads.road_width_m({"golf": "cartpath", "width": "3"}) == (3.0, "width tag")
    # Per-course override of the class table.
    assert roads.road_width_m({"highway": "service"}, {"service": 4.0}) == (4.0, "class")


def test_road_width_skips_non_roads_tunnels_and_unknown_classes():
    assert roads.road_width_m({}) is None
    assert roads.road_width_m({"building": "yes"}) is None
    assert roads.road_width_m({"highway": "steps"}) is None
    assert roads.road_width_m({"highway": "proposed"}) is None
    assert roads.road_width_m({"highway": "residential", "tunnel": "yes"}) is None
    assert roads.road_width_m({"highway": "residential", "tunnel": "culvert"}) is None
    assert roads.road_width_m({"highway": "made_up_class"}) is None
    # Bridges are painted like any road.
    assert roads.road_width_m({"highway": "residential", "bridge": "yes"}) is not None


def test_road_group_buckets_classes():
    assert roads.road_group({"highway": "tertiary"}) == "road"
    assert roads.road_group({"highway": "service"}) == "road"
    assert roads.road_group({"highway": "track"}) == "track"
    assert roads.road_group({"highway": "footway"}) == "path"
    assert roads.road_group({"highway": "path", "golf": "cartpath"}) == "path"


def test_build_roads_query_uses_sw_ne_bbox_and_out_geom():
    q = roads.build_roads_query(BBOX_WGS84)
    assert "(58.39,15.53,58.42,15.58)" in q
    assert 'way["highway"]' in q
    assert 'way["golf"="cartpath"]' in q
    assert q.rstrip().endswith("out geom;")


# ─── centerline smoothing ────────────────────────────────────────────────────

def test_smooth_polyline_rounds_a_sparse_bend_but_keeps_a_true_corner():
    # Three OSM nodes on a 40° bend, 30 m apart: the curve fills in between.
    bend = [(0.0, 0.0), (30.0, 0.0), (30.0 + 30 * math.cos(math.radians(40)), 30 * math.sin(math.radians(40)))]
    smooth = roads.smooth_polyline(bend)
    assert len(smooth) > 40
    assert smooth[0] == bend[0] and smooth[-1] == bend[-1]
    # Passes through the middle node, and the largest turn between samples is a few degrees.
    assert min(math.hypot(x - 30, y) for x, y in smooth) < 1e-6
    turns = [roads._turn_deg(smooth[i - 1], smooth[i], smooth[i + 1]) for i in range(1, len(smooth) - 1)]
    assert max(turns) < 5
    assert sum(turns) > 35  # the whole 40° is turned, gradually

    # A 90° turn is a corner: straight in, straight out, no rounding.
    corner = [(0.0, 0.0), (30.0, 0.0), (30.0, 30.0)]
    smooth = roads.smooth_polyline(corner)
    assert all(abs(y) < 1e-9 for x, y in smooth if x < 30 - 1e-9)
    assert all(abs(x - 30) < 1e-9 for x, y in smooth if y > 1e-9)
    # Two points are left alone; duplicates collapse.
    assert roads.smooth_polyline([(0.0, 0.0), (10.0, 0.0)]) == [(0.0, 0.0), (10.0, 0.0)]
    assert roads.smooth_polyline([(0.0, 0.0), (0.0, 0.0), (10.0, 0.0)]) == [(0.0, 0.0), (10.0, 0.0)]


def test_assembled_corridor_is_round_through_a_gentle_bend():
    # Three nodes on a gentle bend (~25°); the corridor's outer edge turns a
    # little at every vertex instead of one flat then a join.
    doc = {"elements": [way(1, [(15.550, 58.400), (15.552, 58.4001), (15.5535, 58.4005)], highway="residential", width="5")]}
    ways, _ = roads.assemble_roads(doc, reproject)
    coords = list(ways[0].geometry.exterior.coords)
    assert len(coords) > 100
    turns = [roads._turn_deg(coords[i - 1], coords[i], coords[i + 1]) for i in range(1, len(coords) - 1)]
    # Round caps turn 22.5° per step (4 segments per quarter); the sides never more than that.
    assert max(turns) <= 22.5 + 1e-6
    assert ways[0].centerline is not None and len(ways[0].centerline.coords) > 100


# ─── assembly ────────────────────────────────────────────────────────────────

def test_assemble_buffers_centerline_to_its_width():
    doc = {"elements": [way(1, STREET, highway="residential", width="6")]}
    ways, skipped = roads.assemble_roads(doc, reproject)
    assert skipped == []
    assert len(ways) == 1
    w = ways[0]
    assert (w.osm_id, w.highway, w.group, w.width_m, w.width_source) == (1, "residential", "road", 6.0, "width tag")
    # A point 2.5 m north of the centerline is inside a 6 m corridor; 3.5 m is not.
    mid = p3006(15.552, 58.400)
    assert w.geometry.contains(Point(mid.x, mid.y + 2.5))
    assert not w.geometry.contains(Point(mid.x, mid.y + 3.5))
    # Corridor area ≈ length × width (+ round caps).
    length = p3006(15.550, 58.400).distance(p3006(15.554, 58.400))
    assert math.isclose(w.geometry.area, length * 6.0 + math.pi * 9.0, rel_tol=0.05)


def test_assemble_uses_area_yes_polygon_verbatim_and_logs_open_one():
    square = [(15.56, 58.41), (15.561, 58.41), (15.561, 58.411), (15.56, 58.411), (15.56, 58.41)]
    doc = {"elements": [
        way(10, square, highway="pedestrian", area="yes"),
        way(11, square[:3], highway="pedestrian", area="yes"),
    ]}
    ways, skipped = roads.assemble_roads(doc, reproject)
    assert [w.osm_id for w in ways] == [10]
    assert ways[0].width_source == "area"
    assert ways[0].geometry.contains(p3006(15.5605, 58.4105))
    assert skipped == ["way/11: area=yes pedestrian is not a closed ring"]


def test_assemble_ignores_non_road_ways_silently_and_logs_degenerate_ones():
    doc = {"elements": [
        way(20, STREET, building="yes"),
        way(21, STREET, highway="steps"),
        way(22, STREET[:1], highway="residential"),
        {"type": "node", "id": 5, "lat": 58.4, "lon": 15.55},
    ]}
    ways, skipped = roads.assemble_roads(doc, reproject)
    assert ways == []
    assert skipped == ["way/22: residential way has fewer than 2 points"]


# ─── merging ─────────────────────────────────────────────────────────────────

def test_merge_joins_a_t_junction_into_one_polygon_with_provenance():
    doc = {"elements": [
        way(1, STREET, highway="residential"),
        way(2, DRIVEWAY, highway="service"),
    ]}
    ways, _ = roads.assemble_roads(doc, reproject)
    merged = roads.merge_corridors(ways, merge=True)
    assert len(merged) == 1
    rp = merged[0]
    assert rp.group == "road"
    assert rp.osm_ids == [1, 2]
    assert rp.highways == ["residential", "service"]
    assert rp.polygon.geom_type == "Polygon"
    # Both centerlines' midpoints lie inside the single merged corridor.
    assert rp.polygon.contains(p3006(15.551, 58.400))
    assert rp.polygon.contains(p3006(15.552, 58.3995))


def test_default_is_one_polygon_per_way_so_a_misaligned_road_can_be_dragged_alone():
    doc = {"elements": [
        way(1, STREET, highway="residential"),
        way(2, DRIVEWAY, highway="service"),
    ]}
    ways, _ = roads.assemble_roads(doc, reproject)
    per_way = roads.merge_corridors(ways)
    assert [(rp.osm_ids, rp.highways) for rp in per_way] == [([1], ["residential"]), ([2], ["service"])]
    # The two corridors overlap at the junction — the same surface twice, harmless.
    assert per_way[0].polygon.intersects(per_way[1].polygon)


def test_merge_keeps_groups_apart_and_orders_largest_first():
    footpath = [(15.560, 58.405), (15.561, 58.405)]
    doc = {"elements": [
        way(1, STREET, highway="residential"),
        way(3, footpath, highway="footway"),
    ]}
    ways, _ = roads.assemble_roads(doc, reproject)
    merged = roads.merge_corridors(ways)
    assert [rp.group for rp in merged] == ["road", "path"]
    assert merged[0].polygon.area > merged[1].polygon.area


def test_merge_clips_to_area_and_drops_slivers():
    # A street running well past the east edge of a small clip box.
    long_street = [(15.550, 58.400), (15.570, 58.400)]
    doc = {"elements": [way(1, long_street, highway="residential", width="5")]}
    ways, _ = roads.assemble_roads(doc, reproject)
    clip = roads.bbox_polygon_3006((15.549, 58.399, 15.555, 58.401), reproject)
    merged = roads.merge_corridors(ways, clip=clip)
    assert len(merged) == 1
    clipped = merged[0].polygon
    assert clip.buffer(0.05).contains(clipped)
    assert not clipped.contains(p3006(15.560, 58.400))
    # Clipped corridor ≈ 5 m × the ~350 m of street inside the box.
    inside = p3006(15.550, 58.400).distance(p3006(15.555, 58.400))
    assert math.isclose(clipped.area, inside * 5.0, rel_tol=0.1)

    # A one-metre stub is a sliver at the default min area.
    stub = [(15.560, 58.410), (15.56001, 58.410)]
    ways, _ = roads.assemble_roads({"elements": [way(2, stub, highway="footway")]}, reproject)
    assert roads.merge_corridors(ways) == []


def test_merge_simplify_thins_buffer_vertices_but_keeps_shape():
    doc = {"elements": [way(1, STREET, highway="residential")]}
    ways, _ = roads.assemble_roads(doc, reproject)
    raw = roads.merge_corridors(ways, simplify_m=0.0)[0].polygon
    thin = roads.merge_corridors(ways)[0].polygon
    # The smoothed straight is sampled every metre: hundreds of vertices in,
    # a couple of dozen out, and the sides exactly where they were (a looser
    # tolerance let a side collapse onto a chord between cap vertices).
    assert len(raw.exterior.coords) > 300
    assert len(thin.exterior.coords) < 30
    assert math.isclose(thin.area, raw.area, rel_tol=0.002)


# ─── GeoJSON ─────────────────────────────────────────────────────────────────

def test_build_geojson_carries_crs_attribution_and_provenance():
    doc = {"elements": [way(1, STREET, highway="residential"), way(2, DRIVEWAY, highway="service")]}
    ways, _ = roads.assemble_roads(doc, reproject)
    collection = roads.build_roads_geojson(roads.merge_corridors(ways, merge=True), fetch_date="2026-09-14")
    assert collection["type"] == "FeatureCollection"
    assert collection["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3006"
    assert "OpenStreetMap" in collection["attribution"] and "ODbL" in collection["attribution"]
    [feature] = collection["features"]
    props = feature["properties"]
    assert props["type"] == "path"
    assert props["exact"] is True  # the wizard imports the corridor verbatim, no spline fit
    assert props["road_class"] == "road"
    assert props["highways"] == ["residential", "service"]
    assert props["osm_ids"] == [1, 2]
    assert props["source"] == "osm"
    assert props["fetched"] == "2026-09-14"
    assert props["area_m2"] > 0
    assert feature["geometry"]["type"] == "Polygon"
    # Coordinates are projected metres (EPSG:3006), rounded to cm.
    x, y = feature["geometry"]["coordinates"][0][0]
    assert 400_000 < x < 700_000 and 6_400_000 < y < 6_500_000
    assert round(x, 2) == x and round(y, 2) == y


def test_one_way_corridor_carries_its_clipped_centerline_for_the_app_to_edit():
    # A street running past the east edge of the clip, bending on the way.
    street = [(15.550, 58.400), (15.553, 58.4003), (15.556, 58.4012), (15.570, 58.402)]
    doc = {"elements": [way(1, street, highway="residential", width="5")]}
    ways, _ = roads.assemble_roads(doc, reproject)
    clip = roads.bbox_polygon_3006((15.549, 58.399, 15.560, 58.403), reproject)
    [feature] = roads.build_roads_geojson(roads.merge_corridors(ways, clip=clip), fetch_date="2026-09-25")["features"]
    props = feature["properties"]
    assert props["widthM"] == 5.0
    line = props["centerline"]
    # Simplified for editing: a handful of points, not the 1 m samples.
    assert 2 <= len(line) < 40
    polygon = shape(feature["geometry"])
    for x, y in line:
        assert round(x, 2) == x and round(y, 2) == y
        # Inside the clip, down the middle of the corridor.
        assert clip.buffer(0.05).contains(Point(x, y))
        assert polygon.buffer(0.05).contains(Point(x, y))
    # Every stretch of the corridor is within a half-width of the line.
    from shapely.geometry import LineString
    assert polygon.hausdorff_distance(LineString(line)) < 2.5 + 3.0  # the clipped end's corners


def test_merged_network_and_area_surfaces_carry_no_centerline():
    doc = {"elements": [way(1, STREET, highway="residential"), way(2, DRIVEWAY, highway="service")]}
    ways, _ = roads.assemble_roads(doc, reproject)
    [feature] = roads.build_roads_geojson(roads.merge_corridors(ways, merge=True), fetch_date="2026-09-25")["features"]
    assert "centerline" not in feature["properties"]


# ─── end-to-end command ──────────────────────────────────────────────────────

def test_cmd_fetch_roads_end_to_end(tmp_path: Path, capsys):
    doc = {"elements": [
        way(1, STREET, highway="residential"),
        way(2, DRIVEWAY, highway="service"),
        way(3, [(15.560, 58.405), (15.561, 58.405)], highway="track"),
        way(4, STREET, highway="residential", tunnel="yes"),
    ]}
    calls: list[tuple[str, str]] = []

    def stub(query: str, *, url: str = "") -> dict:
        calls.append((query, url))
        return doc

    out = tmp_path / "roads.geojson"
    result = cmd_fetch_roads(BBOX_WGS84, out, overpass_fetch=stub, overpass_url="http://stub.invalid",
                             class_widths={"service": 4.0})
    assert result == out
    assert len(calls) == 1 and calls[0][1] == "http://stub.invalid"
    assert 'way["highway"]' in calls[0][0]

    collection = json.loads(out.read_text(encoding="utf-8"))
    # One polygon per way: the street, the driveway, the track.
    groups = sorted(f["properties"]["road_class"] for f in collection["features"])
    assert groups == ["road", "road", "track"]
    driveway = next(f for f in collection["features"] if f["properties"]["osm_ids"] == [2])
    assert driveway["properties"]["highways"] == ["service"]
    # The service road took the overridden 4 m width: a point 1.8 m beside
    # its centerline is inside, 2.2 m is outside (probe halfway down the driveway).
    poly = shape(driveway["geometry"])
    mid = p3006(15.552, 58.3995)
    assert poly.contains(Point(mid.x + 1.8, mid.y))
    assert not poly.contains(Point(mid.x + 2.2, mid.y))

    printed = capsys.readouterr().out
    assert "OSM road ways: 3" in printed
    assert "class: 3" in printed
    assert "Road polygons: 3 (road=2, track=1)" in printed
    assert f"Wrote {out}" in printed


def test_cmd_fetch_roads_clips_to_the_exact_square_not_its_wgs84_envelope(tmp_path: Path):
    # A road running east through the whole bbox; the square is the bbox's
    # grid envelope shrunk 50 m on each side, and nothing may pass its edge.
    envelope = roads.bbox_polygon_3006(BBOX_WGS84, reproject)
    e0, n0, e1, n1 = envelope.bounds
    square = (e0 + 50, n0 + 50, e1 - 50, n1 - 50)
    west, south, east, north = BBOX_WGS84
    mid = (south + north) / 2
    doc = {"elements": [way(1, [(west - 0.01, mid), (east + 0.01, mid)], highway="residential")]}
    out, lines_out = tmp_path / "roads.geojson", tmp_path / "lines.geojson"
    cmd_fetch_roads(BBOX_WGS84, out, overpass_fetch=lambda q, *, url="": doc, centerlines_out=lines_out, square_3006=square)
    [feature] = json.loads(out.read_text(encoding="utf-8"))["features"]
    x0, y0, x1, y1 = shape(feature["geometry"]).bounds
    assert x0 >= square[0] - 0.01 and x1 <= square[2] + 0.01
    assert x0 < square[0] + 1 and x1 > square[2] - 1  # and it does reach the edges
    [line] = json.loads(lines_out.read_text(encoding="utf-8"))["features"]
    lx0, _, lx1, _ = shape(line["geometry"]).bounds
    assert lx0 >= square[0] - 0.01 and lx1 <= square[2] + 0.01


def test_cmd_fetch_roads_writes_empty_collection_when_nothing_mapped(tmp_path: Path, capsys):
    out = tmp_path / "roads.geojson"
    cmd_fetch_roads(BBOX_WGS84, out, overpass_fetch=lambda q, *, url="": {"elements": []})
    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["features"] == []
    assert "no highway ways found" in capsys.readouterr().out


def test_osm_surface_tags_map_to_the_app_path_surfaces():
    cases = {
        "asphalt": "asphalt", "paved": "asphalt", "Concrete:plates": "concrete", "paving_stones": "paving",
        "sett": "paving", "fine_gravel": "gravel", "compacted": "gravel", "unpaved": "gravel",
        "ground": "dirt", "woodchips": "dirt", "grass": "grass", "wood": "wood",
    }
    for tag, surface in cases.items():
        assert roads.osm_surface({"surface": tag}) == surface, tag
    assert roads.osm_surface({"surface": "metal"}) is None
    assert roads.osm_surface({}) is None
    assert set(roads.OSM_SURFACE.values()) <= set(roads.PATH_SURFACES)
