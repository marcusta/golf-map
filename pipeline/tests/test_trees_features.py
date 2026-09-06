"""trees-features tests: synthetic cleaned-canopy grids (numpy / tmpdir
GeoTIFF), no lidar, no network. The property contract checked here is the
one the server's generated-features import expects.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
import rasterio.features
from rasterio.crs import CRS
from rasterio.transform import from_origin
from shapely.geometry import Polygon, shape

from golfpipe import trees_features
from golfpipe.__main__ import main
from golfpipe.commands import cmd_trees_features
from golfpipe.water import GEOJSON_CRS_3006

E0, N0 = 531000.0, 6473000.0
SIZE = 100
TRANSFORM = from_origin(E0, N0 + SIZE, 1.0, 1.0)

EXPECTED_PROPERTY_NAMES = {
    "type", "source", "source_ref", "license", "heightMaxM", "heightP90M", "heightMeanM", "areaM2",
}


def _grid() -> np.ndarray:
    """Two blobs and a speck. Rows are north-up (row 0 = north edge).

    A: 20x20 at rows 10..30, cols 10..30, 12 m with 20 cells (5 %) at 15 m
       -> max 15, p90 12, mean 12.15, area 400.
    B: 10x15 at rows 60..70, cols 50..65, 6 m -> area 150.
    speck: 2x2 at rows 80..82, cols 80..82, 10 m -> 4 m², dropped.
    Plus 1 m fringe cells around A (below the 2 m threshold; must not count).
    """
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[9:31, 9:31] = 1.0
    g[10:30, 10:30] = 12.0
    g[10, 10:30] = 15.0
    g[60:70, 50:65] = 6.0
    g[80:82, 80:82] = 10.0
    return g


def _write_tif(path: Path, grid: np.ndarray, nodata: float | None = 0.0) -> Path:
    profile = {
        "driver": "GTiff", "height": grid.shape[0], "width": grid.shape[1], "count": 1, "dtype": "float32",
        "crs": CRS.from_epsg(3006), "transform": TRANSFORM, "nodata": nodata,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(grid.astype(np.float32), 1)
    return path


def _by_area(trees):
    return sorted(trees, key=lambda t: t.area_m2, reverse=True)


# ─── mask noise filter ───────────────────────────────────────────────────────

def test_disk_structure_sizes():
    cross = trees_features.disk_structure(1.0)
    assert cross.shape == (3, 3) and cross.sum() == 5 and not cross[0, 0]
    assert trees_features.disk_structure(1.5).shape == (3, 3)
    assert trees_features.disk_structure(1.5).all()
    d = trees_features.disk_structure(2.5)
    assert d.shape == (5, 5) and not d[0, 0] and d[0, 2] and d[2, 0]
    assert trees_features.disk_structure(0.5).shape == (1, 1)


def test_denoise_mask_bridges_slit_drops_speck_keeps_thin_and_hole():
    m = np.zeros((40, 40), dtype=bool)
    m[5:25, 5:25] = True
    m[12:18, 12:18] = False  # 6-cell hole: wider than the closing
    m[10:20, 25] = False  # 1-cell slit
    m[10:20, 26:30] = True
    m[35, 35] = True  # 1 m² speck: under min area
    m[30:32, 2:20] = True  # 2 m wide, 18 m long hedge: 36 m², kept whole
    m[0:3, 36:40] = True  # 12 m² at the grid edge: kept (no border erosion)
    out = trees_features.denoise_mask(m, 1.0, 1.0, 12.0)
    assert not out[35, 35]
    assert out[10:20, 25].all()  # slit closed
    assert not out[13:17, 13:17].any()  # hole kept
    assert out[30:32, 2:20].all() and not out[29, 2:20].any() and not out[32, 2:20].any()
    assert out[0:3, 36:40].all()
    # No closing and no area filter: identity.
    assert trees_features.denoise_mask(m, 1.0, 0.0, 0.0) is m
    # Area filter alone.
    only_area = trees_features.denoise_mask(m, 1.0, 0.0, 12.0)
    assert not only_area[35, 35] and not only_area[10:20, 25].any()


def test_coverage_small_crown_and_thin_hedge_survive():
    """Every cell >= min height in a 5 m crown (21 m²) and a 2 m wide hedge
    must end up inside a polygon, with and without rounding.
    """
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    crown = (yy - 20) ** 2 + (xx - 20) ** 2 <= 2.5 ** 2  # 21 cells
    g[crown] = 8.0
    g[60:62, 10:70] = 3.0  # 2 m x 60 m hedge
    g[75:95, 60:95] = 15.0  # a block, with cell fringe
    g[74, 70:80] = 15.0
    assert int(crown.sum()) == 21
    for round_m in (0.0, trees_features.DEFAULT_ROUND_M):
        trees = trees_features.trees_from_canopy(g, TRANSFORM, round_m=round_m)
        labels = rasterio.features.rasterize(
            ((t.geometry, 1) for t in trees), out_shape=g.shape, transform=TRANSFORM, fill=0, dtype="uint8",
        )
        canopy = g >= 2.0
        covered = (labels > 0) & canopy
        assert covered.sum() / canopy.sum() >= 0.98, round_m
        assert covered[crown].all(), round_m
        assert covered[60:62, 12:68].all(), round_m
        assert len(trees) == 3, round_m
    by_h = sorted(trees, key=lambda t: t.height_max_m)
    assert by_h[0].height_max_m == pytest.approx(3.0, abs=0.05)
    assert by_h[1].height_max_m == pytest.approx(8.0, abs=0.05)
    assert 15 <= by_h[1].area_m2 <= 30


def _turn_angles_deg(ring) -> np.ndarray:
    pts = np.asarray(ring.coords)[:-1]
    a = pts - np.roll(pts, 1, axis=0)
    b = np.roll(pts, -1, axis=0) - pts
    cross = a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]
    dot = (a * b).sum(axis=1)
    return np.degrees(np.abs(np.arctan2(cross, dot)))


def test_rounding_removes_pixel_corners_and_bounds_vertices():
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    g[(yy - 40) ** 2 + (xx - 40) ** 2 <= 20 ** 2] = 10.0  # disk, 1 m staircase edge
    g[10:14, 70:95] = 6.0  # 4 m wide bar with 90° corners
    raw = trees_features.trees_from_canopy(g, TRANSFORM, round_m=0.0)
    rounded = trees_features.trees_from_canopy(g, TRANSFORM)
    assert len(raw) == len(rounded) == 2
    raw_disk, raw_bar = _by_area(raw)
    disk, bar = _by_area(rounded)
    # Staircase: right angles everywhere before, none after.
    assert (np.abs(_turn_angles_deg(raw_disk.geometry.exterior) - 90) < 1e-6).all()
    for poly in (disk.geometry, bar.geometry):
        angles = _turn_angles_deg(poly.exterior)
        assert angles.max() < 60.0
        assert poly.is_valid and not poly.interiors
    # Vertex count bounded: fewer than the staircase, and well under one per 0.5 m of perimeter.
    assert len(disk.geometry.exterior.coords) < 0.6 * len(raw_disk.geometry.exterior.coords)
    assert len(disk.geometry.exterior.coords) < disk.geometry.length / 0.5
    # Shape and stats are kept: area within a few % and height stats intact.
    assert disk.area_m2 == pytest.approx(raw_disk.area_m2, rel=0.03)
    assert disk.height_max_m == pytest.approx(10.0, abs=0.05)
    assert bar.area_m2 == pytest.approx(100, rel=0.1)


def test_rounding_keeps_neighbours_disjoint():
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[20:40, 20:40] = 9.0
    g[20:40, 41:60] = 9.0  # 1-cell gap: bridged by the closing, one polygon
    g[60:80, 20:40] = 9.0
    g[60:80, 45:60] = 9.0  # 5-cell gap: stays two polygons
    trees = trees_features.trees_from_canopy(g, TRANSFORM)
    assert len(trees) == 3
    geoms = [t.geometry for t in trees]
    for i, a in enumerate(geoms):
        for b in geoms[i + 1:]:
            assert a.intersection(b).area < 1e-6


def test_chaikin_ring_square():
    ring = np.array([(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)], dtype=float)
    once = trees_features.chaikin_ring(ring, 1)
    assert once.shape == (9, 2) and np.array_equal(once[0], once[-1])
    assert once[:-1].tolist() == [[1, 0], [3, 0], [4, 1], [4, 3], [3, 4], [1, 4], [0, 3], [0, 1]]
    assert trees_features.chaikin_ring(ring, 0).tolist() == ring.tolist()
    poly = trees_features.chaikin_polygon(Polygon(ring), 2)
    assert poly.is_valid and 12.0 < poly.area < 16.0


# ─── polygons + stats ────────────────────────────────────────────────────────

def test_trees_from_canopy_two_blobs_speck_dropped():
    trees = trees_features.trees_from_canopy(_grid(), TRANSFORM)
    assert len(trees) == 2
    a, b = _by_area(trees)

    assert a.area_m2 == pytest.approx(400, rel=0.15)
    assert a.height_max_m == pytest.approx(15.0, abs=0.05)
    assert a.height_p90_m == pytest.approx(12.0, abs=0.15)
    assert a.height_mean_m == pytest.approx(12.15, abs=0.15)
    assert isinstance(a.area_m2, int)
    # Geometry sits on blob A, not on the 1 m fringe.
    minx, miny, maxx, maxy = a.geometry.bounds
    assert minx == pytest.approx(E0 + 10, abs=0.6) and maxx == pytest.approx(E0 + 30, abs=0.6)
    assert miny == pytest.approx(N0 + SIZE - 30, abs=0.6) and maxy == pytest.approx(N0 + SIZE - 10, abs=0.6)

    assert b.area_m2 == pytest.approx(150, rel=0.15)
    assert b.height_max_m == pytest.approx(6.0, abs=0.05)
    assert b.height_p90_m == pytest.approx(6.0, abs=0.05)
    assert b.height_mean_m == pytest.approx(6.0, abs=0.05)
    for t in trees:
        assert t.geometry.is_valid and t.geometry.geom_type == "Polygon"


def test_trees_from_canopy_min_height_and_min_area_filters():
    trees = trees_features.trees_from_canopy(_grid(), TRANSFORM, min_height_m=8.0)
    assert len(trees) == 1 and trees[0].height_max_m == pytest.approx(15.0, abs=0.05)
    trees = trees_features.trees_from_canopy(_grid(), TRANSFORM, min_area_m2=200.0)
    assert len(trees) == 1 and trees[0].area_m2 == pytest.approx(400, rel=0.15)
    assert trees_features.trees_from_canopy(np.zeros((10, 10)), TRANSFORM) == []


def test_trees_from_canopy_roof_guard_keeps_small_crown_away_from_roofs():
    """3x3 10 m crowns (a thin birch after the 7x7 canopy spread): kept only
    with a roof mask and no roof cell within 3 m."""
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[10:30, 10:30] = 12.0                     # 400 m² tree, roof right beside it: never guarded
    g[80:83, 80:83] = 10.0                     # small crown, roof 5 cells away
    g[50:53, 50:53] = 10.0                     # small crown, roof 2 cells away
    roof = np.zeros(g.shape, dtype=bool); roof[10:30, 31:40] = True; roof[88:95, 75:90] = True; roof[55:60, 48:56] = True
    assert [t.area_m2 for t in _by_area(trees_features.trees_from_canopy(g, TRANSFORM))] == pytest.approx([400], rel=0.15)
    guarded = _by_area(trees_features.trees_from_canopy(g, TRANSFORM, roof_mask=roof))
    assert len(guarded) == 2 and guarded[1].area_m2 < 12 and guarded[1].height_max_m == pytest.approx(10.0, abs=0.05)
    assert guarded[1].geometry.centroid.x == pytest.approx(E0 + 81.5, abs=0.5)
    assert len(trees_features.trees_from_canopy(g, TRANSFORM, roof_mask=roof, roof_guard_m=1.0)) == 3
    assert len(trees_features.trees_from_canopy(g, TRANSFORM, roof_mask=np.zeros(g.shape, bool))) == 3
    with pytest.raises(ValueError, match="roof_mask"):
        trees_features.trees_from_canopy(g, TRANSFORM, roof_mask=roof[:50])


def test_roof_guard_runs_before_rounding_can_merge_roof_islands():
    """Two 4-cell roof-edge islands 2 m apart: rounding (closing radius
    1.5 m) would merge them into a 20 m² polygon that escapes a
    polygon-level guard. The component-level guard removes them first."""
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[50:52, 50:52] = 10.0
    g[50:52, 54:56] = 10.0
    roof = np.zeros(g.shape, dtype=bool); roof[54:60, 45:60] = True
    assert trees_features.trees_from_canopy(g, TRANSFORM, roof_mask=roof) == []
    assert len(trees_features.trees_from_canopy(g, TRANSFORM, roof_mask=np.zeros(g.shape, bool))) == 1
    kept = trees_features.drop_small_components_near_roofs(g > 0, np.zeros(g.shape, bool), 1.0)
    assert kept.sum() == 8
    assert trees_features.drop_small_components_near_roofs(g > 0, roof, 1.0).sum() == 0
    assert trees_features.drop_small_components_near_roofs(g > 0, roof, 1.0, guard_area_m2=4.0).sum() == 8


def test_near_roof_mask_dilates_by_the_guard_distance():
    roof = np.zeros((11, 11), dtype=bool); roof[5, 5] = True
    near = trees_features.near_roof_mask(roof, 1.0, 3.0)
    assert near[5, 2] and near[2, 5] and near[3, 3] and not near[5, 1] and not near[2, 2]
    assert near.sum() == 29
    assert trees_features.near_roof_mask(roof, 1.0, 0.0) is roof


def test_trees_from_canopy_keeps_hole():
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[20:60, 20:60] = 9.0
    g[35:45, 35:45] = 0.0  # 10x10 clearing
    trees = trees_features.trees_from_canopy(g, TRANSFORM)
    assert len(trees) == 1
    poly = trees[0].geometry
    assert len(poly.interiors) == 1
    assert poly.area == pytest.approx(1600 - 100, rel=0.1)
    assert trees[0].area_m2 == pytest.approx(1500, rel=0.1)
    hole = Polygon(poly.interiors[0])
    assert hole.area == pytest.approx(100, rel=0.3)
    assert trees[0].height_max_m == pytest.approx(9.0, abs=0.05)  # the 0 m clearing is not counted


def test_small_hole_filled_large_hole_kept():
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[10:90, 10:90] = 9.0
    g[20:25, 20:25] = 0.0  # 25 m² clearing: under the 50 m² default, filled
    g[50:70, 50:70] = 0.0  # 400 m² clearing: kept
    trees = trees_features.trees_from_canopy(g, TRANSFORM)
    assert len(trees) == 1
    poly = trees[0].geometry
    assert len(poly.interiors) == 1
    assert Polygon(poly.interiors[0]).area == pytest.approx(400, rel=0.2)
    assert trees[0].area_m2 == pytest.approx(6400 - 400, rel=0.05)  # filled hole counted in areaM2
    # Threshold at 0 keeps both; a threshold above 400 fills both.
    both = trees_features.trees_from_canopy(g, TRANSFORM, min_hole_area_m2=0.0)
    assert len(both) == 1 and len(both[0].geometry.interiors) == 2
    none = trees_features.trees_from_canopy(g, TRANSFORM, min_hole_area_m2=500.0)
    assert len(none) == 1 and len(none[0].geometry.interiors) == 0
    assert none[0].area_m2 == pytest.approx(6400, rel=0.05)


def test_fill_small_holes_direct():
    outer = Polygon([(0, 0), (100, 0), (100, 100), (0, 100)])
    small = [(10, 10), (14, 10), (14, 14), (10, 14)]  # 16 m²
    large = [(40, 40), (60, 40), (60, 60), (40, 60)]  # 400 m²
    poly = Polygon(outer.exterior, [small, large])
    out = trees_features.fill_small_holes(poly, 50.0)
    assert len(out.interiors) == 1 and Polygon(out.interiors[0]).area == pytest.approx(400)
    assert trees_features.fill_small_holes(poly, 0.0) is poly
    assert len(trees_features.fill_small_holes(poly, 500.0).interiors) == 0


def test_filling_holes_does_not_change_height_stats():
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    g[10:90, 10:90] = 9.0
    g[10, 10:90] = 14.0  # one row at 14 m -> max 14, p90 9
    g[20:25, 20:25] = 0.0  # filled by default
    g[30:35, 30:35] = 0.0
    g[40:45, 60:65] = 0.0
    kept = trees_features.trees_from_canopy(g, TRANSFORM, min_hole_area_m2=0.0)[0]
    filled = trees_features.trees_from_canopy(g, TRANSFORM)[0]
    assert len(kept.geometry.interiors) == 3 and len(filled.geometry.interiors) == 0
    assert filled.area_m2 > kept.area_m2
    assert filled.height_max_m == kept.height_max_m == pytest.approx(14.0, abs=0.05)
    assert filled.height_p90_m == kept.height_p90_m == pytest.approx(9.0, abs=0.05)
    assert filled.height_mean_m == kept.height_mean_m
    assert filled.height_mean_m == pytest.approx(9.0 + 5.0 / 80.0, abs=0.06)


def test_feature_collection_contract():
    trees = trees_features.trees_from_canopy(_grid(), TRANSFORM)
    fc = trees_features.build_trees_feature_collection(trees, "canopy.tif", course_id="c1")
    assert fc["type"] == "FeatureCollection"
    assert fc["crs"] == GEOJSON_CRS_3006
    assert fc["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3006"
    assert fc["courseId"] == "c1"
    assert len(fc["features"]) == 2
    for f in fc["features"]:
        props = f["properties"]
        assert set(props) == EXPECTED_PROPERTY_NAMES
        assert props["type"] == "trees"
        assert props["source"] == "lidar-canopy"
        assert props["source_ref"] == "canopy.tif"
        assert props["license"] == "CC0-1.0"
        assert isinstance(props["areaM2"], int)
        for key in ("heightMaxM", "heightP90M", "heightMeanM"):
            assert isinstance(props[key], float) and round(props[key], 1) == props[key]
        assert f["geometry"]["type"] == "Polygon"
        assert shape(f["geometry"]).is_valid
    fc = trees_features.build_trees_feature_collection([], "x")
    assert "courseId" not in fc and fc["features"] == []


# ─── command / CLI ───────────────────────────────────────────────────────────

def test_read_canopy_tif_nodata_and_bbox_clip(tmp_path: Path):
    g = _grid()
    g[0, 0] = -9999.0
    tif = _write_tif(tmp_path / "canopy.tif", g, nodata=-9999.0)
    canopy, transform = trees_features.read_canopy_tif(tif)
    assert canopy[0, 0] == 0.0 and canopy.shape == (SIZE, SIZE) and transform == TRANSFORM
    # Clip to blob B (cols 50..65, rows 60..70 -> E 50..65, N 30..40) with a margin.
    clipped, t = trees_features.read_canopy_tif(tif, (E0 + 45, N0 + 25, E0 + 70, N0 + 45))
    assert clipped.shape == (20, 25)
    assert t.c == pytest.approx(E0 + 45) and t.f == pytest.approx(N0 + 45)
    trees = trees_features.trees_from_canopy(clipped, t)
    assert len(trees) == 1 and trees[0].height_max_m == pytest.approx(6.0, abs=0.05)
    with pytest.raises(ValueError, match="bbox"):
        trees_features.read_canopy_tif(tif, (E0 + 500, N0 + 500, E0 + 600, N0 + 600))


def test_cmd_trees_features_from_canopy_tif(tmp_path: Path, capsys):
    tif = _write_tif(tmp_path / "canopy.tif", _grid())
    out = tmp_path / "trees.geojson"
    cmd_trees_features(out, canopy_tif=tif, course_id="c1")
    fc = json.loads(out.read_text(encoding="utf-8"))
    assert len(fc["features"]) == 2
    assert fc["features"][0]["properties"]["source_ref"] == "canopy.tif"
    assert fc["courseId"] == "c1"
    assert "Tree polygons: 2" in capsys.readouterr().out


def test_cmd_trees_features_roof_tif_enables_small_crowns(tmp_path: Path, capsys):
    g = _grid(); g[80:83, 80:83] = 10.0                     # 9 m² crown 12 cells from the roof
    tif = _write_tif(tmp_path / "canopy.tif", g)
    roof = np.zeros((SIZE, SIZE), dtype=np.float32); roof[95:100, 95:100] = 1.0
    roof_tif = _write_tif(tmp_path / "roof.tif", roof, nodata=-1.0)
    out = tmp_path / "trees.geojson"
    cmd_trees_features(out, canopy_tif=tif, roof_tif=roof_tif)
    assert len(json.loads(out.read_text(encoding="utf-8"))["features"]) == 3
    assert "No roof mask" not in capsys.readouterr().out
    cmd_trees_features(out, canopy_tif=tif)
    assert len(json.loads(out.read_text(encoding="utf-8"))["features"]) == 2
    assert "No roof mask" in capsys.readouterr().out
    with pytest.raises(ValueError, match="canopy grid"):
        cmd_trees_features(out, canopy_tif=tif, roof_tif=_write_tif(tmp_path / "bad.tif", roof[:50]))


def test_cmd_trees_features_requires_an_input(tmp_path: Path):
    with pytest.raises(ValueError, match="canopy-tif"):
        cmd_trees_features(tmp_path / "x.geojson")
    with pytest.raises(ValueError, match="bbox"):
        cmd_trees_features(tmp_path / "x.geojson", lidar_paths=[tmp_path / "a.laz"])


def test_trees_features_cli_dispatch(tmp_path: Path):
    tif = _write_tif(tmp_path / "canopy.tif", _grid())
    out = tmp_path / "trees.geojson"
    code = main([
        "trees-features", "--canopy-tif", str(tif), "--out", str(out),
        "--course-id", "c1", "--source-ref", "m21c011-646_54.copc.laz", "--min-area", "200", "--min-hole-area", "10",
        "--bbox", f"{E0},{N0},{E0 + SIZE},{N0 + SIZE}",
    ])
    assert code == 0
    fc = json.loads(out.read_text(encoding="utf-8"))
    assert len(fc["features"]) == 1
    props = fc["features"][0]["properties"]
    assert props["source_ref"] == "m21c011-646_54.copc.laz"
    assert set(props) == EXPECTED_PROPERTY_NAMES
