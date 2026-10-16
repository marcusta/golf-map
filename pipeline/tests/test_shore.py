"""shore-edits tests — offline, no mocks. The rule (shore_water_mask) runs on
small synthetic grids modelled on what Omberg's shore showed: a sound the
DEM filled in above the lake, hydro lying inland of a cliff, a skerry hydro
misses, a noise speck. The merge and the D-TE5 output run on hand-built
shapely polygons; the CLI runs end to end on synthetic DEM GeoTIFFs, LAS
files written with laspy and a fetch-hydro-shaped GeoJSON.
"""

from __future__ import annotations

import json
from pathlib import Path

import laspy
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from shapely.geometry import Point, Polygon, box, shape

from golfpipe import shore
from golfpipe.__main__ import main

LEVEL = 100.0
CELL = 0.5
E0, N1 = 477000.0, 6458000.0  # realistic SWEREF99 TM corner
TRANSFORM = from_origin(E0, N1, CELL, CELL)


def scene(rows=60, cols=60):
    """Lake (hydro water, DEM at the level, no ground hits) west of col 40,
    mainland east of it (DEM 103 m, a ground hit in every cell)."""
    hydro = np.zeros((rows, cols), dtype=bool)
    hydro[:, :40] = True
    dem = np.full((rows, cols), LEVEL, dtype=np.float64)
    dem[:, 40:] = 103.0
    hits = np.zeros((rows, cols), dtype=np.int32)
    hits[:, 40:] = 3
    return hydro, dem, hits


def run(hydro, dem, hits):
    return shore.shore_water_mask(hydro, dem, hits, LEVEL, CELL)


# ─── the rule ────────────────────────────────────────────────────────────────


def test_sound_filled_in_by_the_dem_stays_water():
    hydro, dem, hits = scene()
    # An island (cols 10..24) hydro knows about, with lidar hits on it ...
    hydro[10:50, 10:25] = False
    dem[10:50, 10:25] = 102.0
    hits[10:50, 10:25] = 2
    # ... and the sound between it and the mainland (cols 25..39): gridding
    # interpolated the DEM up to 0.6 m above the lake, but no ground hit.
    dem[10:50, 25:40] = LEVEL + 0.6
    water = run(hydro, dem, hits)
    assert water[10:50, 26:39].all()
    assert not water[12:48, 12:23].any()  # the island is land
    assert not water[:, 41:].any()


def test_hydro_inland_of_a_cliff_is_cut_back_to_the_rock():
    hydro, dem, hits = scene()
    # Hydro reaches 8 cells (4 m) onto the cliff, which lidar sees high and dry.
    hydro[:, 40:48] = True
    # A hollow under the cliff, low and without hits, sealed off by rock on all
    # sides: it is not connected to the lake, so it stays land too.
    dem[20:30, 43:47] = LEVEL
    hits[20:30, 43:47] = 0
    water = run(hydro, dem, hits)
    assert not water[:, 41:48].any()
    assert water[:, :39].all()


def test_skerry_hydro_misses_is_kept_as_a_hole():
    hydro, dem, hits = scene()
    # A 2 m² bump (2 x 4 cells of 0.5 m) out in the water: hydro calls it
    # lake, the lidar has ground hits on it 0.5-0.8 m above the level.
    dem[30:32, 10:14] = LEVEL + 0.8
    hits[30:32, 10:14] = 1
    water = run(hydro, dem, hits)
    assert not water[30:32, 10:14].all()
    polygon = shore.mask_to_polygon(water, TRANSFORM, CELL)
    lake = max(shore.polygon_parts(polygon), key=lambda p: p.area)
    holes = [Polygon(r) for r in lake.interiors]
    assert len(holes) == 1
    assert abs(holes[0].area - 2.0) < 0.01  # all of it: the majority runs before the land cut
    centre = (E0 + 12 * CELL, N1 - 31 * CELL)
    assert holes[0].contains(Point(centre))


def test_land_speck_without_a_hit_goes_back_to_water():
    hydro, dem, hits = scene()
    # Hydro has a tiny 2 x 3 cell "island" (the majority filter leaves the
    # middle two cells, 0.5 m²) the lidar never saw: noise, back to water.
    hydro[30:32, 10:13] = False
    dem[30:32, 10:13] = LEVEL + 0.5
    water = run(hydro, dem, hits)
    assert water[30:32, 10:13].all()
    # The same speck with a ground hit on it is a real rock.
    hits[30:32, 10:13] = 1
    water = run(hydro, dem, hits)
    assert not water[30:32, 10:13].all()


def test_level_is_the_lake_median_away_from_the_shore():
    hydro, dem, _ = scene()
    dem[:, 30:40] = LEVEL + 2.0  # the interpolated band along the shore is ignored
    lake = box(E0 - 1000, N1 - 60 * CELL, E0 + 40 * CELL, N1)
    assert shore.water_level(dem, TRANSFORM, lake, erode_m=6.0) == LEVEL


# ─── merge ───────────────────────────────────────────────────────────────────

OUTER = (0.0, 0.0, 1000.0, 1000.0)
INNER = (300.0, 300.0, 700.0, 700.0)


def test_merge_keeps_inner_detail_inside_and_the_hydro_margin_outside():
    # The hydro lake: everything west of x=500, out to 600 m past the square.
    lake = box(-600, -200, 500, 1200)
    # Outer terrain: shore at x=505 (a little out), a skerry at (100, 100) and
    # a coarse rock inside the inner square that the inner run refines away.
    outer = Polygon(box(0, 0, 505, 1000).exterior, [box(95, 95, 105, 105).exterior, box(400, 400, 420, 420).exterior])
    # Inner terrain: shore at x=490 and its own small island at (350, 600).
    inner = Polygon(box(300, 300, 490, 700).exterior, [box(348, 598, 352, 602).exterior])
    result = shore.merge_shore_polygons(lake, outer, OUTER, inner, INNER)
    p = result.polygon
    assert p.geom_type == "Polygon" and p.is_valid
    assert not p.contains(Point(350, 600))      # the inner island
    assert p.contains(Point(410, 410))          # the outer's coarse rock is gone inside the inner square
    assert not p.contains(Point(100, 100))      # the outer skerry stays
    assert not p.contains(Point(495, 500))      # inner shore wins inside the inner square
    assert p.contains(Point(502, 800))          # outer shore outside it
    assert p.contains(Point(-500, 500)) and p.contains(Point(400, 1150))  # hydro beyond the outer square
    assert result.dropped_m2 == []


def test_merge_keeps_the_largest_part_and_reports_the_rest():
    lake = box(-600, -200, 500, 1200)
    outer = shore.shapely.union_all([box(0, 0, 500, 1000), box(800, 800, 820, 820)])  # a pond on land
    inner = box(300, 300, 500, 700)
    result = shore.merge_shore_polygons(lake, outer, OUTER, inner, INNER)
    assert result.polygon.geom_type == "Polygon"
    assert [round(a) for a in result.dropped_m2] == [400]


def test_open_lake_warning_when_the_hydro_file_stops_at_the_square():
    assert shore.open_lake_warnings(box(-600, -400, 500, 1400), OUTER) == []
    warnings = shore.open_lake_warnings(box(-100, -400, 500, 1400), OUTER)
    assert len(warnings) == 1 and "west" in warnings[0] and "100 m" in warnings[0]


# ─── output ──────────────────────────────────────────────────────────────────


def test_output_is_one_d_te5_shore_edit_in_wgs84():
    polygon = Polygon(box(477000, 6457000, 477400, 6457400).exterior, [box(477100, 6457100, 477110, 6457110).exterior])
    doc = shore.shore_edit_collection(polygon, 88.7614, {"depthM": 6.0}, created_at="2026-10-16T00:00:00Z")
    assert doc["type"] == "FeatureCollection"
    assert len(doc["features"]) == 1
    feature = doc["features"][0]
    props = feature["properties"]
    assert props["op"] == "shore" and props["featherM"] == 0 and props["levelM"] == 88.761
    expected = dict(shore.PROFILE_DEFAULTS, depthM=6.0)
    assert {k: props[k] for k in shore.PROFILE_DEFAULTS} == expected
    assert list(shore.PROFILE_DEFAULTS) == [
        "edgeSlope", "edgeM", "edgeEaseM", "shelfSlope", "shelfEndM", "shelfEaseM", "slope",
        "depthM", "floorRoundM", "channelDepthM", "channelRatio", "channelFullM", "channelGoneM"]
    assert props["origin"] == "shore-edits" and props["createdAt"] == "2026-10-16T00:00:00Z"
    geometry = feature["geometry"]
    assert geometry["type"] == "Polygon" and len(geometry["coordinates"]) == 2
    for ring in geometry["coordinates"]:
        assert ring[0] == ring[-1]
        for lon, lat in ring:
            assert 14 < lon < 15 and 58 < lat < 59
            assert round(lon, 8) == lon and round(lat, 8) == lat
    back = shape(geometry)
    assert back.is_valid and back.exterior.is_ccw


# ─── CLI end to end ──────────────────────────────────────────────────────────

# Outer square 200 m at 1 m, inner 60 m at 0.5 m in its middle; the lake is
# everything west of x = SHORE, out to 400 m past the outer square.
OX0, OY0 = 476000.0, 6457000.0
O_SQ = (OX0, OY0, OX0 + 200, OY0 + 200)
I_SQ = (OX0 + 70, OY0 + 70, OX0 + 130, OY0 + 130)
SHORE = OX0 + 110
ISLAND = (OX0 + 90, OY0 + 95, OX0 + 96, OY0 + 105)  # 60 m², in the inner square, hydro misses it


def write_dem(path: Path, square, res: float) -> Path:
    x0, y0, x1, y1 = square
    w, h = int((x1 - x0) / res), int((y1 - y0) / res)
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y1 - (np.arange(h) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    dem = np.where(X < SHORE, LEVEL, 104.0)
    on_island = (X >= ISLAND[0]) & (X < ISLAND[2]) & (Y >= ISLAND[1]) & (Y < ISLAND[3])
    dem = np.where(on_island, 101.5, dem).astype(np.float32)
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(x0, y1, res, res), nodata=-9999.0) as dst:
        dst.write(dem, 1)
    return path


def write_las(path: Path, square, step: float) -> Path:
    x0, y0, x1, y1 = square
    X, Y = np.meshgrid(np.arange(x0 + 0.2, x1, step), np.arange(y0 + 0.2, y1, step))
    x, y = X.ravel(), Y.ravel()
    on_island = (x >= ISLAND[0]) & (x < ISLAND[2]) & (y >= ISLAND[1]) & (y < ISLAND[3])
    land = (x >= SHORE) | on_island
    z = np.where(on_island, 101.5, np.where(land, 104.0, LEVEL))
    cls = np.where(land, 2, 9).astype(np.uint8)
    header = laspy.LasHeader(point_format=3, version="1.2")
    header.offsets = [float(x.min()), float(y.min()), float(z.min())]
    header.scales = [0.001, 0.001, 0.001]
    las = laspy.LasData(header)
    las.x, las.y, las.z, las.classification = x, y, z, cls
    las.write(str(path))
    return path


def test_cli_end_to_end(tmp_path: Path, capsys):
    hydro = tmp_path / "hydro.geojson"
    lake = box(OX0 - 400, OY0 - 400, SHORE + 3, OY0 + 600)  # hydro lies 3 m inland, on the rock
    hydro.write_text(json.dumps({
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3006"}},
        "features": [
            {"type": "Feature", "properties": {"type": "water"}, "geometry": json.loads(shore.shapely.to_geojson(lake))},
            {"type": "Feature", "properties": {"type": "water"}, "geometry": json.loads(shore.shapely.to_geojson(box(OX0 + 150, OY0 + 150, OX0 + 160, OY0 + 160)))},
        ],
    }), encoding="utf-8")
    inner_dem = write_dem(tmp_path / "dem.tif", I_SQ, 0.5)
    outer_dem = write_dem(tmp_path / "outer-dem.tif", O_SQ, 1.0)
    (tmp_path / "lidar").mkdir()
    (tmp_path / "outer-lidar").mkdir()
    write_las(tmp_path / "lidar" / "inner.las", I_SQ, 0.5)
    write_las(tmp_path / "outer-lidar" / "outer.las", O_SQ, 1.0)
    write_las(tmp_path / "outer-lidar" / "far.las", (OX0 + 5000, OY0, OX0 + 5010, OY0 + 10), 1.0)
    out = tmp_path / "shore.geojson"
    out_3006 = tmp_path / "shore-3006.geojson"
    code = main([
        "shore-edits", "--hydro", str(hydro),
        "--inner-dem", str(inner_dem), "--inner-lidar", str(tmp_path / "lidar"),
        "--outer-dem", str(outer_dem), "--outer-lidar", str(tmp_path / "outer-lidar"),
        "--min-area-m2", "1000", "--depth-m", "6",
        "--out", str(out), "--out-3006", str(out_3006),
    ])
    printed = capsys.readouterr().out
    assert code == 0, printed
    assert "Level: 100.00 m" in printed
    assert "1 skipped" in printed  # far.las misses the outer grid
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert len(doc["features"]) == 1 and doc["features"][0]["properties"]["depthM"] == 6.0
    p = shape(json.loads(out_3006.read_text(encoding="utf-8"))["features"][0]["geometry"])
    assert p.is_valid
    island_centre = Point((ISLAND[0] + ISLAND[2]) / 2, (ISLAND[1] + ISLAND[3]) / 2)
    assert not p.contains(island_centre)
    assert [round(Polygon(r).area) for r in p.interiors] == [60]
    # The 3 m of rock hydro took for lake are land again, on both terrains.
    for y in (OY0 + 100, OY0 + 20):
        assert p.contains(Point(SHORE - 1.5, y))
        assert not p.contains(Point(SHORE + 1.5, y))
    assert p.contains(Point(OX0 - 300, OY0 + 100))  # the hydro margin beyond the outer square


def test_cli_refuses_a_hydro_file_without_the_lake(tmp_path: Path, capsys):
    hydro = tmp_path / "hydro.geojson"
    hydro.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"type": "water"},
         "geometry": json.loads(shore.shapely.to_geojson(box(OX0, OY0, OX0 + 50, OY0 + 50)))}]}), encoding="utf-8")
    code = main(["shore-edits", "--hydro", str(hydro), "--inner-dem", "x.tif", "--inner-lidar", "x",
                 "--outer-dem", "y.tif", "--outer-lidar", "y", "--out", str(tmp_path / "o.geojson")])
    assert code == 1
    assert "--min-area-m2" in capsys.readouterr().err
