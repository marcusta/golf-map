"""NVDB fusion for fetch-roads — fully offline. NVDB rows are hand-built in
the shape api.trafikinfo.trafikverket.se returns (one row per covered piece
of a network element: Element_Id, Start/End_Measure fractions, 3D WKT in
SWEREF99 TM), and the command test stubs both HTTP seams. Geometry is built
straight in EPSG:3006 so distances read as metres.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from rasterio.crs import CRS
from rasterio.warp import transform as warp_transform
from shapely.geometry import LineString, Point, box, shape

from golfpipe import nvdb, roads
from golfpipe.commands import cmd_fetch_roads

TODAY = "2026-09-24"
E0, N0 = 530000.0, 6487000.0


def to3006(lons, lats):
    return warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))


def to4326(es, ns):
    return warp_transform(CRS.from_epsg(3006), CRS.from_epsg(4326), list(es), list(ns))


def wkt3d(points):
    return "LINESTRING Z (" + ", ".join(f"{x} {y} 90.0" for x, y in points) + ")"


def row(element, points, start=0.0, end=1.0, **fields):
    return {
        "Element_Id": element, "Start_Measure": start, "End_Measure": end,
        "Valid_From": "2020-01-01", "Valid_To": "9999-12-31", "Deleted": False,
        "Geometry": {"WKT-SWEREF99TM-3D": wkt3d(points)}, **fields,
    }


def osm_way(osm_id, points, highway="unclassified", width=5.0, source="class", surface=None):
    line = LineString(points)
    return roads.RoadWay(
        osm_id=osm_id, highway=highway, group=roads.ROAD_GROUP.get(highway, "road"),
        width_m=width, width_source=source, geometry=line.buffer(width / 2), centerline=line, surface=surface,
    )


# A 200 m east-west gravel lane, as both networks know it (OSM 0.4 m off).
LANE = [(E0, N0), (E0 + 200, N0)]
LANE_OSM = [(E0, N0 + 0.4), (E0 + 200, N0 + 0.4)]


def lane_rows(**extra):
    return {
        nvdb.NETWORK_TYPE: [row("1:100", LANE, Nättyp="bilnät")],
        nvdb.WIDTH_TYPE: [row("1:100", LANE, Bredd=3.1)],
        nvdb.SURFACE_TYPE: [row("1:100", LANE, Slitlagertyp="grus")],
        nvdb.KIND_TYPE: [row("1:100", LANE, Typ="Småväg enkel standard")],
        **extra,
    }


# ─── request / response ──────────────────────────────────────────────────────

def test_request_asks_every_type_for_current_rows_in_the_box():
    body = nvdb.build_request('k"ey', (530000, 6487000, 531000, 6488000))
    assert "authenticationkey='k\"ey'" in body or 'authenticationkey="k&quot;ey"' in body
    for name, namespace in nvdb.OBJECT_TYPES:
        assert f'objecttype="{name}"' in body and f'namespace="{namespace}"' in body
    assert body.count('<INTERSECTS name="Geometry.WKT-SWEREF99TM-3D" shape="box" value="530000.0 6487000.0, 531000.0 6488000.0"/>') == 4
    assert body.count('<EQ name="Deleted" value="false"/>') == 4


def test_response_errors_raise_with_the_api_message():
    bad = json.dumps({"RESPONSE": {"RESULT": [{"ERROR": {"SOURCE": "Request", "MESSAGE": "Invalid query attribute"}}]}})
    with pytest.raises(nvdb.NvdbError, match="Invalid query attribute"):
        nvdb.parse_response(400, bad)
    with pytest.raises(nvdb.NvdbError, match="no RESULT"):
        nvdb.parse_response(401, "Unauthorized")


def test_response_maps_results_to_object_types_in_order():
    body = json.dumps({"RESPONSE": {"RESULT": [{name: [{"GID": i}]} for i, (name, _) in enumerate(nvdb.OBJECT_TYPES)]}})
    rows = nvdb.parse_response(200, body)
    assert [rows[name][0]["GID"] for name, _ in nvdb.OBJECT_TYPES] == [0, 1, 2, 3]


# ─── the network ─────────────────────────────────────────────────────────────

def test_network_reads_attributes_by_measure_and_drops_stale_rows():
    rows = {
        nvdb.NETWORK_TYPE: [
            row("1:100", LANE, Nättyp="bilnät"),
            row("1:200", [(E0, N0 + 50), (E0 + 100, N0 + 50)], Nättyp="bilnät", Deleted=True),
            row("1:300", [(E0, N0 + 90), (E0 + 100, N0 + 90)], Nättyp="bilnät", Valid_To="2021-01-01"),
        ],
        # Paved for the first 40 %, gravel after.
        nvdb.SURFACE_TYPE: [
            row("1:100", LANE[:1] + [(E0 + 80, N0)], 0.0, 0.4, Slitlagertyp="belagd"),
            row("1:100", [(E0 + 80, N0)] + LANE[1:], 0.4, 1.0, Slitlagertyp="grus"),
        ],
        nvdb.WIDTH_TYPE: [row("1:100", LANE, Bredd=0.1)],  # out of range: ignored
    }
    net = nvdb.build_network(rows, today=TODAY)
    assert [link.element_id for link in net.links] == ["1:100"]
    link = net.links[0]
    assert net.attrs_at(link, Point(E0 + 20, N0)).surface == "asphalt"
    assert net.attrs_at(link, Point(E0 + 150, N0)).surface == "gravel"
    assert net.attrs_at(link, Point(E0 + 150, N0)).width_m is None


def test_network_links_covering_part_of_an_element_map_measures_through():
    # This piece is the element's second half: its own midpoint is measure 0.75.
    rows = {
        nvdb.NETWORK_TYPE: [row("1:100", [(E0 + 100, N0), (E0 + 200, N0)], 0.5, 1.0, Nättyp="bilnät")],
        nvdb.WIDTH_TYPE: [row("1:100", LANE[:1], 0.0, 0.7, Bredd=6.0), row("1:100", LANE[1:], 0.7, 1.0, Bredd=3.0)],
    }
    rows[nvdb.WIDTH_TYPE][0]["Geometry"]["WKT-SWEREF99TM-3D"] = wkt3d(LANE)
    rows[nvdb.WIDTH_TYPE][1]["Geometry"]["WKT-SWEREF99TM-3D"] = wkt3d(LANE)
    net = nvdb.build_network(rows, today=TODAY)
    link = net.links[0]
    assert net.attrs_at(link, Point(E0 + 110, N0)).width_m == 6.0  # measure 0.55
    assert net.attrs_at(link, Point(E0 + 190, N0)).width_m == 3.0  # measure 0.95


# ─── fusion ──────────────────────────────────────────────────────────────────

def test_fuse_gives_an_osm_road_the_measured_width_and_surface():
    way = osm_way(7, LANE_OSM, width=5.0, source="class")
    ways, stats = nvdb.fuse([way], nvdb.build_network(lane_rows(), today=TODAY))
    [fused] = ways
    assert (fused.width_m, fused.width_source, fused.surface) == (3.1, "nvdb", "gravel")
    assert fused.nvdb_ids == ["1:100"] and fused.osm_id == 7
    assert fused.centerline is way.centerline  # OSM geometry kept
    # Re-buffered to 3.1 m: 1.5 m beside the centerline is in, 1.7 m out.
    assert fused.geometry.contains(Point(E0 + 100, N0 + 0.4 + 1.5))
    assert not fused.geometry.contains(Point(E0 + 100, N0 + 0.4 + 1.7))
    assert (stats.matched, stats.measured_width, stats.surface, stats.added) == (1, 1, 1, 0)


def test_fuse_measured_width_beats_an_osm_width_tag_but_road_type_does_not():
    measured, _ = nvdb.fuse([osm_way(1, LANE_OSM, width=4.0, source="width tag")], nvdb.build_network(lane_rows(), today=TODAY))
    assert measured[0].width_m == 3.1
    no_bredd = lane_rows()
    no_bredd[nvdb.WIDTH_TYPE] = []
    tagged, _ = nvdb.fuse([osm_way(1, LANE_OSM, width=4.0, source="width tag")], nvdb.build_network(no_bredd, today=TODAY))
    assert (tagged[0].width_m, tagged[0].width_source) == (4.0, "width tag")
    guessed, stats = nvdb.fuse([osm_way(1, LANE_OSM, width=5.0, source="class")], nvdb.build_network(no_bredd, today=TODAY))
    assert (guessed[0].width_m, guessed[0].width_source) == (nvdb.VAGSLAG_WIDTH_M["Småväg enkel standard"], "nvdb type")
    assert stats.kind_width == 1


def test_fuse_keeps_a_cycleway_beside_the_road_off_the_road_width():
    cycleway = osm_way(2, [(E0, N0 + 4), (E0 + 200, N0 + 4)], highway="cycleway", width=2.5)
    ways, stats = nvdb.fuse([cycleway], nvdb.build_network(lane_rows(), today=TODAY))
    # Unmatched (wrong network), and the NVDB lane — which no OSM ROAD runs
    # along, but the cycleway covers within MATCH_M — is not added either.
    assert ways[0].width_m == 2.5 and ways[0].nvdb_ids == []
    assert stats.matched == 0 and stats.added == 0


def test_fuse_ignores_a_road_that_only_crosses_the_nvdb_link():
    crossing = osm_way(3, [(E0 + 100, N0 - 100), (E0 + 100, N0 + 100)], width=5.0)
    ways, stats = nvdb.fuse([crossing], nvdb.build_network(lane_rows(), today=TODAY))
    assert ways[0].width_m == 5.0 and stats.matched == 0


def test_fuse_adds_the_nvdb_road_osm_lacks_reaching_the_road_it_joins():
    # OSM has only a north-south road; NVDB also has the lane teeing into it
    # from the east at (E0, N0).
    trunk = osm_way(4, [(E0, N0 - 100), (E0, N0 + 100)], highway="tertiary", width=6.0)
    rows = lane_rows()
    rows[nvdb.NETWORK_TYPE].append(row("1:900", [(E0, N0 - 100), (E0, N0 + 100)], Nättyp="bilnät"))
    ways, stats = nvdb.fuse([trunk], nvdb.build_network(rows, today=TODAY), clip=box(E0 - 300, N0 - 300, E0 + 150, N0 + 300))
    assert stats.added == 1
    added = next(w for w in ways if w.osm_id is None)
    assert (added.highway, added.group, added.width_m, added.width_source, added.surface) == ("track", "track", 3.1, "nvdb", "gravel")
    assert added.nvdb_ids == ["1:100"]
    # Starts at the junction (grown back over the match buffer), ends at the clip.
    xs = [x for x, _ in added.centerline.coords]
    assert min(xs) == pytest.approx(E0, abs=0.01) and max(xs) == pytest.approx(E0 + 150, abs=0.01)

    polygons = roads.merge_corridors(ways)
    doc = roads.build_roads_geojson(polygons, fetch_date=TODAY, attribution="x")
    nvdb_only = next(f["properties"] for f in doc["features"] if f["properties"]["source"] == "nvdb")
    assert nvdb_only["license"] == "CC0-1.0" and nvdb_only["source_ref"] == "nvdb:1:100"
    assert nvdb_only["surface"] == "gravel" and nvdb_only["widthM"] == 3.1
    osm_road = next(f["properties"] for f in doc["features"] if f["properties"]["source"] == "osm")
    assert osm_road["license"] == "ODbL" and osm_road["osm_ids"] == [4]

    lines = roads.build_centerlines_geojson(ways, fetch_date=TODAY)
    assert {f["properties"]["id"] for f in lines["features"]} == {"osm:way/4", "nvdb:1:100"}


def test_fuse_does_not_add_short_junction_slop():
    rows = {nvdb.NETWORK_TYPE: [row("1:1", [(E0, N0), (E0 + 20, N0)], Nättyp="bilnät")]}
    ways, stats = nvdb.fuse([], nvdb.build_network(rows, today=TODAY))
    assert ways == [] and stats.added == 0


# ─── near the course ─────────────────────────────────────────────────────────

def test_near_area_grows_the_mapped_playing_features_only():
    (lon,), (lat,) = to4326([E0], [N0])
    square = lambda d: [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]
    doc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"type": "green"}, "geometry": {"type": "Polygon", "coordinates": [square(0.0002)]}},
        {"type": "Feature", "properties": {"type": "path"}, "geometry": {"type": "Polygon", "coordinates": [square(0.05)]}},
        {"type": "Feature", "properties": {"type": "trees", "generated": True}, "geometry": {"type": "Polygon", "coordinates": [square(0.05)]}},
        # Water runs off the course (an imported creek): it never counts.
        {"type": "Feature", "properties": {"type": "water_creek"}, "geometry": {"type": "Polygon", "coordinates": [square(0.05)]}},
        {"type": "Feature", "properties": {"type": "water"}, "geometry": {"type": "Polygon", "coordinates": [square(0.05)]}},
    ]}
    area = roads.near_area_3006(doc, to3006, 200.0)
    assert area.contains(Point(E0 + 200, N0))
    assert not area.contains(Point(E0 + 300, N0))
    assert roads.near_area_3006({"features": doc["features"][1:]}, to3006) is None


# ─── the command ─────────────────────────────────────────────────────────────

def test_cmd_fetch_roads_fuses_nvdb_and_keeps_only_roads_near_the_course(tmp_path: Path, capsys):
    # OSM: the lane near the green, and a far road 1 km north.
    (lon0, lon1), (lat0, lat1) = to4326([LANE_OSM[0][0], LANE_OSM[1][0]], [LANE_OSM[0][1], LANE_OSM[1][1]])
    (flon0, flon1), (flat0, flat1) = to4326([E0, E0 + 200], [N0 + 1000, N0 + 1000])
    overpass = {"elements": [
        {"type": "way", "id": 1, "tags": {"highway": "unclassified"}, "geometry": [{"lon": lon0, "lat": lat0}, {"lon": lon1, "lat": lat1}]},
        {"type": "way", "id": 2, "tags": {"highway": "unclassified"}, "geometry": [{"lon": flon0, "lat": flat0}, {"lon": flon1, "lat": flat1}]},
    ]}
    (glon,), (glat,) = to4326([E0 + 100], [N0 + 40])
    near = tmp_path / "features.geojson"
    near.write_text(json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"type": "green"},
        "geometry": {"type": "Point", "coordinates": [glon, glat]}}]}), encoding="utf-8")
    boxes = []

    def nvdb_stub(key, box_3006):
        boxes.append((key, box_3006))
        return lane_rows()

    bbox = (lon0 - 0.01, lat0 - 0.01, lon1 + 0.01, flat1 + 0.01)
    out, lines_out = tmp_path / "roads.geojson", tmp_path / "lines.geojson"
    cmd_fetch_roads(bbox, out, overpass_fetch=lambda q, *, url="": overpass, centerlines_out=lines_out,
                    near_path=near, near_m=200.0, nvdb_key="k", nvdb_fetch=nvdb_stub)

    # NVDB was asked only for the 200 m neighbourhood of the green.
    [(key, (e0, n0, e1, n1))] = boxes
    assert key == "k" and n1 < N0 + 300 and e0 > E0 - 150
    features = json.loads(out.read_text(encoding="utf-8"))["features"]
    assert [f["properties"]["osm_ids"] for f in features] == [[1]]  # the far road is gone
    props = features[0]["properties"]
    assert (props["widthM"], props["widthSource"], props["surface"], props["nvdb_ids"]) == (3.1, "nvdb", "gravel", ["1:100"])
    [line] = json.loads(lines_out.read_text(encoding="utf-8"))["features"]
    assert line["properties"]["widthM"] == 3.1 and "Trafikverket" in json.loads(out.read_text(encoding="utf-8"))["attribution"]
    printed = capsys.readouterr().out
    assert "Limited to 200 m around the course features" in printed
    assert "along OSM ways: 1 (measured width 1" in printed


def test_cmd_fetch_roads_falls_back_to_osm_when_nvdb_fails(tmp_path: Path, capsys):
    (lon0, lon1), (lat0, lat1) = to4326([LANE_OSM[0][0], LANE_OSM[1][0]], [LANE_OSM[0][1], LANE_OSM[1][1]])
    overpass = {"elements": [{"type": "way", "id": 1, "tags": {"highway": "unclassified"},
                              "geometry": [{"lon": lon0, "lat": lat0}, {"lon": lon1, "lat": lat1}]}]}

    def broken(key, box_3006):
        raise nvdb.NvdbError("NVDB answered HTTP 401")

    out = tmp_path / "roads.geojson"
    cmd_fetch_roads((lon0 - 0.01, lat0 - 0.01, lon1 + 0.01, lat1 + 0.01), out,
                    overpass_fetch=lambda q, *, url="": overpass, nvdb_key="k", nvdb_fetch=broken)
    [feature] = json.loads(out.read_text(encoding="utf-8"))["features"]
    assert feature["properties"]["widthSource"] == "class"
    assert "NVDB unavailable, OSM only: NVDB answered HTTP 401" in capsys.readouterr().out
