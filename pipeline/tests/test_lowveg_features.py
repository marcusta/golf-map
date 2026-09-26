"""lowveg-features tests: synthetic cleaned-canopy grids (numpy / tmpdir
GeoTIFF), no lidar, no network. The property contract checked here is the
one the server's generated-features import expects for vegetation zones
(docs/feature-vegetation-zones.md D-VZ7).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from shapely.geometry import Polygon, box, shape

from golfpipe import lowveg_features
from golfpipe.__main__ import main
from golfpipe.commands import cmd_lowveg_features
from golfpipe.water import GEOJSON_CRS_3006

E0, N0 = 531000.0, 6473000.0
SIZE = 100
TRANSFORM = from_origin(E0, N0 + SIZE, 1.0, 1.0)

EXPECTED_PROPERTY_NAMES = {
    "type", "source", "source_ref", "license", "zoneType", "weight", "feather", "noise",
    "heightP90M", "heightMaxM", "areaM2",
}


def _grid() -> np.ndarray:
    """Rows are north-up (row 0 = north edge).

    tree:   20x20 at rows 10..30, cols 10..30, 12 m, with a 1-cell fringe
            of 1.5 m around it (the crown edge in a max-z grid) — a tree,
            never a shrub zone, fringe included.
    shrubs: 10x15 at rows 60..70, cols 50..65, 1.5 m with one 2.5 m cell
            -> a zone of ~150 m², p90 1.5, max 2.5.
    grass:  10x10 at rows 80..90, cols 80..90, 0.2 m -> below min height.
    """
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[9:31, 9:31] = 1.5
    g[10:30, 10:30] = 12.0
    g[60:70, 50:65] = 1.5
    g[62, 57] = 2.5
    g[80:90, 80:90] = 0.2
    return g


def _write_tif(path: Path, grid: np.ndarray) -> Path:
    profile = {
        "driver": "GTiff", "height": grid.shape[0], "width": grid.shape[1], "count": 1, "dtype": "float32",
        "crs": CRS.from_epsg(3006), "transform": TRANSFORM, "nodata": 0.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(grid.astype(np.float32), 1)
    return path


def _cell_box(row0, row1, col0, col1):
    """EPSG:3006 box of a cell block (rows north-up)."""
    return box(E0 + col0, N0 + SIZE - row1, E0 + col1, N0 + SIZE - row0)


def test_the_shrub_blob_becomes_a_zone_the_tree_and_the_grass_do_not():
    zones = lowveg_features.lowveg_from_canopy(_grid(), TRANSFORM)
    assert len(zones) == 1
    z = zones[0]
    assert 130 <= z.area_m2 <= 160
    assert z.height_p90_m == pytest.approx(1.5, abs=0.1) and z.height_max_m == pytest.approx(2.5, abs=0.01)
    assert z.geometry.intersects(_cell_box(60, 70, 50, 65))
    assert not z.geometry.intersects(_cell_box(9, 31, 9, 31))  # tree and fringe
    assert not z.geometry.intersects(_cell_box(80, 90, 80, 90))  # grass


def test_tree_fringe_is_cut_by_the_buffer_and_kept_without_it():
    """The 1.5 m ring around the 12 m crown is low vegetation by height
    alone; the tree buffer is what removes it."""
    without = lowveg_features.lowveg_from_canopy(_grid(), TRANSFORM, tree_buffer_m=0.0, min_area_m2=4.0, round_m=0.0)
    assert any(z.geometry.intersects(_cell_box(9, 31, 9, 31)) for z in without)
    assert all(not z.geometry.intersects(_cell_box(12, 28, 12, 28)) for z in without)  # the crown itself is a hole
    with_buffer = lowveg_features.lowveg_from_canopy(_grid(), TRANSFORM, min_area_m2=4.0, round_m=0.0)
    assert not any(z.geometry.intersects(_cell_box(9, 31, 9, 31)) for z in with_buffer)


def test_given_tree_polygons_are_cut_out_with_their_buffer(tmp_path):
    g = _grid()
    g[40:50, 5:35] = 1.5  # a second shrub strip, 300 m²
    trees = [_cell_box(38, 52, 3, 20)]  # a tree polygon over its west 15 m
    zones = lowveg_features.lowveg_from_canopy(g, TRANSFORM, trees=trees, tree_buffer_m=1.0, round_m=0.0)
    strip = [z for z in zones if z.geometry.intersects(_cell_box(40, 50, 5, 35))]
    assert len(strip) == 1
    assert 120 <= strip[0].area_m2 <= 150  # 30 - 15 - 1 buffer = 14 columns
    assert not strip[0].geometry.intersects(trees[0].buffer(0.9))
    assert not any(z.geometry.intersects(trees[0]) for z in zones)


def test_min_area_and_height_band_are_honoured():
    g = _grid()
    g[95:98, 2:5] = 1.5  # 9 m²
    zones = lowveg_features.lowveg_from_canopy(g, TRANSFORM)
    assert len(zones) == 1  # the 9 m² patch is under the 20 m² default
    assert lowveg_features.lowveg_from_canopy(g, TRANSFORM, min_area_m2=4.0, round_m=0.0)[0].area_m2 >= 9 or \
        len(lowveg_features.lowveg_from_canopy(g, TRANSFORM, min_area_m2=4.0, round_m=0.0)) == 2
    grassy = lowveg_features.lowveg_from_canopy(g, TRANSFORM, min_height_m=0.1)
    assert any(z.geometry.intersects(_cell_box(80, 90, 80, 90)) for z in grassy)
    with pytest.raises(ValueError, match="max_height_m"):
        lowveg_features.lowveg_from_canopy(g, TRANSFORM, min_height_m=3.0, max_height_m=1.0)


def test_feature_collection_property_contract():
    zones = lowveg_features.lowveg_from_canopy(_grid(), TRANSFORM)
    fc = lowveg_features.build_lowveg_feature_collection(zones, "canopy.tif", course_id="course-1")
    assert fc["type"] == "FeatureCollection" and fc["crs"] == GEOJSON_CRS_3006
    assert fc["courseId"] == "course-1" and "Lantmäteriet" in fc["attribution"]
    assert len(fc["features"]) == 1
    props = fc["features"][0]["properties"]
    assert set(props) == EXPECTED_PROPERTY_NAMES
    assert props["type"] == "vegetation_zone" and props["source"] == "lidar-lowveg"
    assert props["source_ref"] == "canopy.tif" and props["license"] == "CC0-1.0"
    assert props["zoneType"] == "shrub" and props["weight"] == 1 and props["feather"] == 2 and props["noise"] == 0
    assert props["heightP90M"] == pytest.approx(1.5, abs=0.1) and props["heightMaxM"] == 2.5
    assert isinstance(props["areaM2"], int)
    geom = shape(fc["features"][0]["geometry"])
    assert geom.geom_type == "Polygon" and geom.is_valid


def test_read_tree_polygons_filters_by_type_and_refuses_degrees(tmp_path):
    ok = tmp_path / "trees.geojson"
    ok.write_text(json.dumps({
        "type": "FeatureCollection", "crs": GEOJSON_CRS_3006,
        "features": [
            {"type": "Feature", "properties": {"type": "trees"},
             "geometry": {"type": "Polygon", "coordinates": [[[E0, N0], [E0 + 10, N0], [E0 + 10, N0 + 10], [E0, N0 + 10], [E0, N0]]]}},
            {"type": "Feature", "properties": {"type": "fairway"},
             "geometry": {"type": "Polygon", "coordinates": [[[E0, N0], [E0 + 50, N0], [E0 + 50, N0 + 50], [E0, N0 + 50], [E0, N0]]]}},
        ],
    }))
    polys = lowveg_features.read_tree_polygons(ok)
    assert len(polys) == 1 and polys[0].area == pytest.approx(100.0)

    degrees = tmp_path / "wgs.geojson"
    degrees.write_text(json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {},
         "geometry": {"type": "Polygon", "coordinates": [[[15.5, 58.5], [15.6, 58.5], [15.6, 58.6], [15.5, 58.5]]]}},
    ]}))
    with pytest.raises(ValueError, match="EPSG:3006"):
        lowveg_features.read_tree_polygons(degrees)


def test_command_from_canopy_tif_with_trees(tmp_path, capsys):
    tif = _write_tif(tmp_path / "canopy.tif", _grid())
    trees = tmp_path / "trees.geojson"
    trees.write_text(json.dumps({
        "type": "FeatureCollection", "crs": GEOJSON_CRS_3006,
        "features": [{"type": "Feature", "properties": {"type": "trees"},
                      "geometry": {"type": "Polygon", "coordinates": [list(_cell_box(58, 72, 48, 58).exterior.coords)]}}],
    }))
    out = cmd_lowveg_features(tmp_path / "lowveg.geojson", canopy_tif=tif, course_id="c1", trees_path=trees)
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["courseId"] == "c1" and len(doc["features"]) == 1
    props = doc["features"][0]["properties"]
    assert props["source_ref"] == "canopy.tif" and props["zoneType"] == "shrub"
    assert props["areaM2"] < 100  # the west part of the blob is under the tree polygon + buffer
    report = capsys.readouterr().out
    assert "Trees to cut out: 1 polygon(s)" in report and "Shrub zone proposals: 1" in report


def test_cli(tmp_path):
    tif = _write_tif(tmp_path / "canopy.tif", _grid())
    out = tmp_path / "lowveg.geojson"
    code = main([
        "lowveg-features", "--canopy-tif", str(tif), "--out", str(out), "--course-id", "c1",
        "--min-height", "0.5", "--max-height", "3", "--min-area", "20", "--source-ref", "m21.laz",
    ])
    assert code in (0, None) and out.exists()
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert [f["properties"]["source_ref"] for f in doc["features"]] == ["m21.laz"]
    with pytest.raises(SystemExit):
        main(["lowveg-features", "--canopy-tif", str(tif), "--out", str(out), "--min-height", "3", "--max-height", "1"])


# ─── from points (--lidar) ───────────────────────────────────────────────────
#
# A 100 m square on ground sloping 20 % to the east (z = 10 + 0.2 x), one
# ground return per 0.5 m. On top of it:
#   shrub:   rows 60..70, cols 50..65 (north-up cells), returns 0.7 m above
#            ground: under the canopy grid's 1 m floor, so only counting finds it.
#   tree:    rows 10..30, cols 10..30, 12 m, two returns per pulse.
#   roof:    rows 40..52, cols 75..87, 5 m, single returns (suppressed as a roof).
#   clutter: rows 44..50, cols 64..71, 1 m (a car or a trampoline) 4 m from the roof.
#   noise:   one stray 1.5 m return at row 85, col 20.

import laspy  # noqa: E402

SLOPE = 0.2


def _ground_z(x):
    return 10.0 + SLOPE * (np.asarray(x) - E0)


def _block(row0, row1, col0, col1, height, returns=1, step=0.5):
    """Returns over a cell block (rows north-up) at `height` above the slope."""
    xs = np.arange(E0 + col0 + 0.25, E0 + col1, step)
    ys = np.arange(N0 + SIZE - row1 + 0.25, N0 + SIZE - row0, step)
    x, y = (a.ravel() for a in np.meshgrid(xs, ys))
    return x, y, _ground_z(x) + height, np.full(x.size, 1, np.uint8), np.full(x.size, returns, np.uint8)


def _write_cloud(path: Path, parts) -> Path:
    x, y, z, cls, nr = (np.concatenate(v) for v in zip(*parts))
    header = laspy.LasHeader(point_format=3, version="1.2")
    header.offsets = [float(x.min()), float(y.min()), float(z.min())]
    header.scales = [0.001, 0.001, 0.001]
    las = laspy.LasData(header)
    las.x, las.y, las.z = x, y, z
    las.classification = cls
    las.number_of_returns = nr
    las.return_number = np.ones(x.size, np.uint8)
    las.write(str(path))
    return path


def _cloud(tmp_path: Path) -> Path:
    gx, gy, gz, _, gnr = _block(0, SIZE, 0, SIZE, 0.0)
    ground = (gx, gy, gz, np.full(gx.size, 2, np.uint8), gnr)
    stray = (np.array([E0 + 20.5]), np.array([N0 + SIZE - 85.5]), _ground_z([E0 + 20.5]) + 1.5,
             np.array([1], np.uint8), np.array([1], np.uint8))
    return _write_cloud(tmp_path / "cloud.laz", [
        ground,
        _block(60, 70, 50, 65, 0.7),
        _block(10, 30, 10, 30, 12.0, returns=2),
        _block(40, 52, 75, 87, 5.0),
        _block(44, 50, 64, 71, 1.0),
        stray,
    ])


BBOX = (E0, N0, E0 + SIZE, N0 + SIZE)


def test_count_band_points_measures_height_above_the_sloping_ground(tmp_path):
    x, y, z, cls, nr = _block(0, SIZE, 0, SIZE, 0.0)
    ground = (x, y, z, np.full(x.size, 2, np.uint8), nr)
    low = _block(20, 22, 20, 22, 0.3)   # ground noise height: never counted
    high = _block(40, 41, 40, 41, 0.8)  # in the band
    cloud = _write_cloud(tmp_path / "slope.laz", [ground, low, high])
    ground_dem = _ground_z(E0 + np.arange(SIZE) + 0.5)[None, :].repeat(SIZE, axis=0)
    band = lowveg_features.count_band_points([cloud], BBOX, ground_dem, 1.0)
    assert band.count.sum() == 4 and band.count[40, 40] == 4
    assert band.max_height[40, 40] == pytest.approx(0.8, abs=0.01)
    assert band.count[20:22, 20:22].sum() == 0


def test_lowveg_from_points_window_trees_and_roof_buffer():
    band = lowveg_features.BandCounts(np.zeros((SIZE, SIZE)), np.zeros((SIZE, SIZE)))
    band.count[60:70, 50:65] = 2
    band.max_height[60:70, 50:65] = 0.7
    band.count[85, 20] = 1  # a stray return: under min_points
    band.count[44:50, 64:71] = 4
    band.max_height[44:50, 64:71] = 1.0
    canopy = np.zeros((SIZE, SIZE), np.float32)
    canopy[10:30, 10:30] = 12.0
    roofs = np.zeros((SIZE, SIZE), bool)
    roofs[40:52, 75:87] = True

    zones = lowveg_features.lowveg_from_points(band, canopy, TRANSFORM, roof_mask=roofs)
    assert len(zones) == 1
    zone = zones[0]
    assert zone.geometry.intersects(_cell_box(60, 70, 50, 65))
    assert zone.height_max_m == pytest.approx(0.7) and 120 <= zone.area_m2 <= 180

    kept = lowveg_features.lowveg_from_points(band, canopy, TRANSFORM, roof_mask=roofs, roof_buffer_m=0.0)
    assert len(kept) == 2  # without the buffer the clutter beside the roof is proposed
    with pytest.raises(ValueError, match="min_points"):
        lowveg_features.lowveg_from_points(band, canopy, TRANSFORM, min_points=0)


def test_command_from_lidar_finds_scrub_under_one_metre(tmp_path, capsys):
    cloud = _cloud(tmp_path)
    out = cmd_lowveg_features(tmp_path / "lowveg.geojson", lidar_paths=[cloud], bbox_3006=BBOX, course_id="c1")
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert len(doc["features"]) == 1
    props = doc["features"][0]["properties"]
    assert set(props) == EXPECTED_PROPERTY_NAMES
    assert props["source_ref"] == "cloud.laz" and props["heightMaxM"] == pytest.approx(0.7, abs=0.05)
    assert shape(doc["features"][0]["geometry"]).intersects(_cell_box(60, 70, 50, 65))
    report = capsys.readouterr().out
    assert "Counting returns 0.5..3 m above ground" in report and "roof buffer 10 m" in report


def test_cli_from_lidar_passes_min_points_and_roof_buffer(tmp_path):
    cloud = _cloud(tmp_path)
    out = tmp_path / "lowveg.geojson"
    bbox = ",".join(str(v) for v in BBOX)
    main(["lowveg-features", "--lidar", str(cloud), "--bbox", bbox, "--out", str(out), "--roof-buffer", "0"])
    assert len(json.loads(out.read_text(encoding="utf-8"))["features"]) == 2
    main(["lowveg-features", "--lidar", str(cloud), "--bbox", bbox, "--out", str(out), "--min-points", "100"])
    assert json.loads(out.read_text(encoding="utf-8"))["features"] == []


def test_canopy_tif_run_says_it_misses_scrub_under_one_metre(tmp_path, capsys):
    tif = _write_tif(tmp_path / "canopy.tif", _grid())
    cmd_lowveg_features(tmp_path / "lowveg.geojson", canopy_tif=tif)
    assert "run with --lidar to count points instead" in capsys.readouterr().out
