"""Tests for golfpipe.grid_dem: bins classified lidar points into a
regular-grid DEM. Uses small synthetic LAS files written via laspy (no
network, no real point clouds) so the suite stays fast and offline.
"""

from __future__ import annotations

from pathlib import Path

import laspy
import numpy as np
import pytest
import rasterio

from golfpipe import grid_dem


def _write_las(path: Path, x, y, z, classification, point_format: int = 3) -> Path:
    header = laspy.LasHeader(point_format=point_format, version="1.2")
    header.offsets = [0.0, 0.0, 0.0]
    header.scales = [0.001, 0.001, 0.001]

    las = laspy.LasData(header)
    las.x = np.asarray(x, dtype=np.float64)
    las.y = np.asarray(y, dtype=np.float64)
    las.z = np.asarray(z, dtype=np.float64)
    las.classification = np.asarray(classification, dtype=np.uint8)
    las.write(str(path))
    return path


@pytest.fixture
def synthetic_las_two_classes(tmp_path: Path) -> Path:
    """A small point set inside bbox_3006=(0,0,10,10) at 1 m resolution:
    - ground (class 2) points at known heights forming a simple pattern.
    - water (class 9) points at a distinct known height.
    - noise (class 1, unclassified) points that should be excluded by the
      default class filter.
    One cell (x=5..6, y=5..6) gets two ground points averaging to a known
    mean, to exercise the mean-per-cell binning.
    """
    path = tmp_path / "synthetic.las"
    xs = [0.5, 1.5, 2.5, 5.2, 5.8, 9.5, 3.5]
    ys = [0.5, 1.5, 2.5, 5.2, 5.8, 9.5, 3.5]
    zs = [100.0, 101.0, 102.0, 110.0, 112.0, 50.0, 999.0]
    # cell (5,5): two ground points averaging (110+112)/2 = 111.0
    classes = [2, 2, 2, 2, 2, 9, 1]
    _write_las(path, xs, ys, zs, classes)
    return path


def test_grid_lidar_points_bins_mean_per_cell(synthetic_las_two_classes: Path):
    bbox = (0.0, 0.0, 10.0, 10.0)
    sum_grid, count_grid, transform, class_counts = grid_dem.grid_lidar_points(
        [synthetic_las_two_classes], bbox, resolution=1.0, classes=(2, 9),
    )

    assert sum_grid.shape == (10, 10)
    assert count_grid.shape == (10, 10)

    # Row 0 = north edge (y=10..9), so y=5.2/5.8 -> row index 10 - 1 - 5 = 4.
    col = int((5.2 - 0.0) / 1.0)
    row = int((10.0 - 5.8) / 1.0)
    assert count_grid[row, col] == 2
    assert sum_grid[row, col] == pytest.approx(110.0 + 112.0)

    # Class-1 (noise) point at (3.5, 3.5) must be excluded entirely.
    noise_row = int((10.0 - 3.5) / 1.0)
    noise_col = int(3.5 / 1.0)
    assert count_grid[noise_row, noise_col] == 0

    # Per-class diagnostic counts include every class seen in bbox, not
    # just the ones actually used for gridding.
    assert class_counts.counts[2] == 5
    assert class_counts.counts[9] == 1
    assert class_counts.counts[1] == 1
    assert class_counts.total_points_in_bbox == 7
    assert class_counts.points_used_for_grid == 6  # 5 ground + 1 water


def test_grid_lidar_points_filters_to_bbox(tmp_path: Path):
    path = tmp_path / "outside.las"
    # One point inside bbox (0,0,10,10), one point well outside it.
    _write_las(path, [5.0, 500.0], [5.0, 500.0], [42.0, 999.0], [2, 2])

    bbox = (0.0, 0.0, 10.0, 10.0)
    sum_grid, count_grid, _, class_counts = grid_dem.grid_lidar_points(
        [path], bbox, resolution=1.0, classes=(2,),
    )

    assert count_grid.sum() == 1
    assert class_counts.total_points_in_bbox == 1
    assert class_counts.points_used_for_grid == 1


def test_grid_lidar_points_class_filter_excludes_unrequested_classes(tmp_path: Path):
    path = tmp_path / "classes.las"
    _write_las(path, [1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [10.0, 20.0, 30.0], [2, 9, 17])

    bbox = (0.0, 0.0, 10.0, 10.0)
    # Only request ground (2) — water (9) and bridge (17) must be excluded.
    _, count_grid, _, class_counts = grid_dem.grid_lidar_points(
        [path], bbox, resolution=1.0, classes=(2,),
    )
    assert count_grid.sum() == 1
    assert class_counts.points_used_for_grid == 1
    # But diagnostics still report all classes present in the bbox.
    assert class_counts.counts == {2: 1, 9: 1, 17: 1}


def test_detect_available_classes(tmp_path: Path):
    path = tmp_path / "classes.las"
    _write_las(path, [1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [10.0, 20.0, 30.0], [2, 9, 17])
    assert grid_dem.detect_available_classes([path]) == {2, 9, 17}


def test_build_dem_grid_fills_nodata_and_despikes():
    # 5x5 grid: populated everywhere except one hole, plus a single-cell
    # spike that median filtering should smooth away.
    count_grid = np.ones((5, 5))
    sum_grid = np.full((5, 5), 100.0)  # mean would be 100 everywhere
    count_grid[2, 2] = 0  # empty cell (no lidar points landed here)
    sum_grid[2, 2] = 0.0
    sum_grid[0, 0] = 5000.0  # single-cell spike: mean 5000 vs neighbours ~100

    dem = grid_dem.build_dem_grid(sum_grid, count_grid)

    assert dem.dtype == np.float32
    # The previously-empty cell must be filled with a plausible value
    # (close to the surrounding 100.0 field), not left as nodata (-9999).
    assert dem[2, 2] != -9999.0
    assert dem[2, 2] == pytest.approx(100.0, abs=5.0)

    # The spike must be knocked down by the 3x3 median filter — it should
    # no longer be wildly different from its neighbours.
    assert dem[0, 0] < 1000.0


def test_build_dem_grid_all_nodata_when_empty():
    count_grid = np.zeros((3, 3))
    sum_grid = np.zeros((3, 3))
    dem = grid_dem.build_dem_grid(sum_grid, count_grid)
    assert np.all(dem == -9999.0)


def test_write_dem_geotiff_roundtrip(tmp_path: Path):
    dem = np.array([[10.0, 20.0], [30.0, 40.0]], dtype=np.float32)
    transform = rasterio.transform.from_origin(541000.0, 6468000.0, 0.5, 0.5)
    out_path = tmp_path / "dem.tif"

    grid_dem.write_dem_geotiff(dem, transform, out_path)

    with rasterio.open(out_path) as src:
        assert src.crs.to_epsg() == 3006
        assert src.nodata == -9999.0
        data = src.read(1)
        np.testing.assert_array_equal(data, dem)


def test_describe_spikes_counts_large_neighbour_differences():
    dem = np.full((5, 5), 60.0, dtype=np.float32)
    dem[2, 2] = 90.0  # 30 m spike vs. all 8 neighbours
    spikes = grid_dem.describe_spikes(dem, threshold_m=2.0)
    # All 8 neighbours of the spike (and the spike cell itself, whose max
    # diff to its neighbours is also > threshold) get flagged.
    assert spikes >= 8


def test_end_to_end_grid_dem_from_two_files(tmp_path: Path):
    """Two lidar files covering adjacent/overlapping areas of the same
    bbox (mirrors the real fetch: two COPC tiles straddle the course
    boundary) should merge into one consistent DEM.
    """
    path_a = tmp_path / "tile_a.las"
    path_b = tmp_path / "tile_b.las"
    _write_las(path_a, [1.0, 2.0], [1.0, 2.0], [55.0, 56.0], [2, 2])
    _write_las(path_b, [8.0, 9.0], [8.0, 9.0], [70.0, 71.0], [2, 2])

    bbox = (0.0, 0.0, 10.0, 10.0)
    sum_grid, count_grid, transform, class_counts = grid_dem.grid_lidar_points(
        [path_a, path_b], bbox, resolution=1.0, classes=(2,),
    )
    assert count_grid.sum() == 4
    assert class_counts.points_used_for_grid == 4

    dem = grid_dem.build_dem_grid(sum_grid, count_grid)
    valid = dem[dem != -9999.0]
    assert valid.min() >= 50.0
    assert valid.max() <= 75.0
