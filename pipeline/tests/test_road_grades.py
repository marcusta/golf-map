"""road-grades tests — offline. Centerlines come out of fetch-roads run on
hand-built Overpass JSON through the fetch seam; the corridor edits are
checked as D-TE5 features and by replaying them onto a synthetic bumpy DEM
with apply-dem-edits.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform as warp_transform
from shapely.geometry import LineString, shape

from golfpipe import roads
from golfpipe.commands import cmd_apply_dem_edits, cmd_fetch_roads, cmd_road_grades

BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)


def reproject(lons, lats):
    return warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))


def way(osm_id, points, **tags):
    return {"type": "way", "id": osm_id, "tags": tags, "geometry": [{"lat": lat, "lon": lon} for lon, lat in points]}


STREET = [(15.550, 58.400), (15.552, 58.400), (15.554, 58.400)]
TRACK = [(15.560, 58.405), (15.561, 58.4055)]


def centerlines_file(tmp_path: Path, elements) -> Path:
    out = tmp_path / "roads.geojson"
    lines = tmp_path / "roads-centerlines.geojson"
    cmd_fetch_roads(BBOX_WGS84, out, overpass_fetch=lambda q, *, url="": {"elements": elements}, centerlines_out=lines)
    return lines


def test_fetch_roads_writes_clipped_centerlines_with_widths(tmp_path: Path, capsys):
    long_street = [(15.550, 58.400), (15.600, 58.400)]  # runs out of the bbox to the east
    lines = centerlines_file(tmp_path, [
        way(1, long_street, highway="residential", width="5"),
        way(2, TRACK, highway="track"),
        way(3, [(15.56, 58.41), (15.561, 58.41), (15.561, 58.411), (15.56, 58.41)], highway="pedestrian", area="yes"),
    ])
    doc = json.loads(lines.read_text(encoding="utf-8"))
    assert doc["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3006" and "ODbL" in doc["attribution"]
    by_id = {f["properties"]["id"]: f for f in doc["features"]}
    assert set(by_id) == {"osm:way/1", "osm:way/2"}  # the area has no centerline
    street = by_id["osm:way/1"]
    assert street["geometry"]["type"] == "LineString"
    assert street["properties"]["widthM"] == 5.0 and street["properties"]["widthSource"] == "width tag"
    assert street["properties"]["road_class"] == "road" and street["properties"]["highway"] == "residential"
    # Clipped at the bbox edge: ~1.75 km of the 2.9 km way is inside.
    assert 1500 < street["properties"]["lengthM"] < 2000
    assert by_id["osm:way/2"]["properties"]["widthM"] == roads.CLASS_WIDTH_M["track"]
    assert "Centerlines: 2" in capsys.readouterr().out

    parsed = roads.read_centerlines(lines)
    assert [(c.id, c.group, c.width_m) for c in parsed] == [("osm:way/1", "road", 5.0), ("osm:way/2", "track", 3.0)]
    assert parsed[0].line.geom_type == "LineString"


def test_grade_edit_features_are_corridors_with_centerline_and_width():
    line = LineString([(500_000, 6_470_000), (500_100, 6_470_000)])
    c = roads.Centerline("osm:way/9", "service", "road", 3.5, line)

    def to_wgs84(xs, ys):
        return warp_transform(CRS.from_epsg(3006), CRS.from_epsg(4326), list(xs), list(ys))

    [feature] = roads.grade_edit_features([c], to_wgs84, feather_m=2.0, smooth_m=20.0, created_at="2026-09-15T12:00:00Z")
    props = feature["properties"]
    assert props["op"] == "corridor" and props["featherM"] == 2.0 and props["smoothM"] == 20.0 and props["widthM"] == 3.5
    assert props["origin"] == "road-grades" and props["originRef"] == "osm:way/9"
    assert props["createdAt"] == "2026-09-15T12:00:00Z#00000"
    assert props["highway"] == "service" and props["road_class"] == "road" and props["lengthM"] == 100.0
    assert len(props["centerline"]) == 2 and all(14 < lon < 17 and 58 < lat < 59 for lon, lat in props["centerline"])
    # Polygon = pavement (3.5 m) + 2 m feather each side: 7.5 m wide, in WGS84.
    ring = feature["geometry"]["coordinates"][0]
    xs, ys = reproject([p[0] for p in ring], [p[1] for p in ring])
    back = shape({"type": "Polygon", "coordinates": [list(zip(xs, ys))]})
    assert math.isclose(back.area, 100 * 7.5 + math.pi * 3.75 ** 2, rel_tol=0.05)


def test_cmd_road_grades_filters_classes(tmp_path: Path, capsys):
    lines = centerlines_file(tmp_path, [way(1, STREET, highway="residential"), way(2, TRACK, highway="track")])
    out = tmp_path / "grades.geojson"
    cmd_road_grades(lines, out, classes={"road"})
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert [f["properties"]["originRef"] for f in doc["features"]] == ["osm:way/1"]
    assert "Road grades: 1 corridor edits (road=1)" in capsys.readouterr().out
    cmd_road_grades(lines, out)
    assert len(json.loads(out.read_text(encoding="utf-8"))["features"]) == 2


def test_road_grades_replay_flattens_across_the_pavement(tmp_path: Path):
    lines = centerlines_file(tmp_path, [way(1, STREET, highway="residential", width="6")])
    [c] = roads.read_centerlines(lines)
    grades = cmd_road_grades(lines, tmp_path / "grades.geojson", feather_m=2.0, smooth_m=25.0)

    # A 1 m DEM around the road with 0.4 m random bumps on a 3 % north-south slope.
    e0, n0, e1, n1 = c.line.bounds
    x0, y1 = math.floor(e0) - 20, math.ceil(n1) + 20
    w, h = math.ceil(e1) - x0 + 20, y1 - (math.floor(n0) - 20)
    transform = from_origin(x0, y1, 1.0, 1.0)
    rng = np.random.default_rng(3)
    rows = np.arange(h, dtype=np.float64)
    dem = 40.0 + 0.03 * rows[:, None] + rng.uniform(-0.4, 0.4, size=(h, w))
    dem_path = tmp_path / "dem.tif"
    with rasterio.open(dem_path, "w", driver="GTiff", height=h, width=w, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=transform, nodata=-9999.0) as dst:
        dst.write(dem.astype(np.float32), 1)

    out = cmd_apply_dem_edits(dem_path, grades, tmp_path / "dem-edited.tif")
    with rasterio.open(out) as src:
        edited = src.read(1)
        # Sample cross sections every 20 m along the road: the 6 m pavement is
        # level across, and the along-road profile no longer has the bumps.
        pave = rasterio.features.geometry_mask([c.line.buffer(2.5)], out_shape=edited.shape, transform=src.transform, invert=True)
        assert pave.sum() > 500
        stations = [c.line.interpolate(d) for d in np.arange(30, c.line.length - 30, 20)]
        for p in stations:
            r, col = src.index(p.x, p.y)
            across = edited[r - 2:r + 3, col]
            assert np.ptp(across) < 0.05
            before = dem[r - 2:r + 3, col]
            assert np.ptp(before) > 0.05
        along = np.array([edited[src.index(p.x, p.y)] for p in stations])
        assert np.abs(np.diff(along)).max() < 0.08
