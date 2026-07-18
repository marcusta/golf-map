"""detect-trees tests — fully offline. Synthetic LAS point clouds (the
_write_las pattern from test_grid_dem.py) model a course corner: flat
ground, one big canopy blob with an interior clearing, a below-threshold
shrub patch, a sub-min-area speck, and a high-noise block that must be
excluded by classification (7/18), not by geometry.

Laserdata Skog does not classify vegetation, so all "canopy" fixture points
are class 1 (unclassified) — exactly what the nDSM method must handle.
"""

from __future__ import annotations

from pathlib import Path

import laspy
import numpy as np
import pytest
from shapely.geometry import Polygon

from golfpipe import detect_trees, grid_dem
from golfpipe.__main__ import main
from golfpipe.commands import cmd_detect_trees

# Scene anchored at realistic SWEREF99 TM coordinates so the "output is
# EPSG:3006 metres" assertions are meaningful.
E0, N0 = 531000.0, 6473000.0
SIZE = 30  # 30x30 m scene at 1 m resolution
BBOX_3006 = (E0, N0, E0 + SIZE, N0 + SIZE)

GROUND_Z = 10.0
CANOPY_Z = 18.0  # 8 m above ground
SHRUB_Z = 11.0  # 1 m above ground — below the 2 m default threshold


def _write_las(path: Path, x, y, z, classification, point_format: int = 3) -> Path:
    header = laspy.LasHeader(point_format=point_format, version="1.2")
    # Offsets at the data minimum so realistic EPSG:3006 coordinates
    # (~6.47e6 m northing) fit int32 at 1 mm scale.
    header.offsets = [float(np.min(np.asarray(v, dtype=np.float64))) for v in (x, y, z)]
    header.scales = [0.001, 0.001, 0.001]

    las = laspy.LasData(header)
    las.x = np.asarray(x, dtype=np.float64)
    las.y = np.asarray(y, dtype=np.float64)
    las.z = np.asarray(z, dtype=np.float64)
    las.classification = np.asarray(classification, dtype=np.uint8)
    las.write(str(path))
    return path


def _block(x0: int, x1: int, y0: int, y1: int) -> tuple[np.ndarray, np.ndarray]:
    """Cell-center coordinates for the cell block [x0,x1) x [y0,y1) (cell
    units relative to the scene origin)."""
    xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    return E0 + xs.ravel(), N0 + ys.ravel()


@pytest.fixture
def scene_las(tmp_path: Path) -> Path:
    """One point per 1 m cell:
    - ground (class 2) at z=10 everywhere;
    - canopy blob (class 1, z=18): cells [5,17)x[5,17) minus a 4x4 interior
      clearing [9,13)x[9,13) — one crown polygon with a hole, 128 m2;
    - shrub patch (class 1, z=11 → 1 m nDSM): [20,26)x[20,26);
    - speck (class 1, z=18): 3x3 at [24,27)x[3,6) — survives morphology
      (9 m2) but falls under the 25 m2 min-area filter;
    - high noise (class 18, z=210): 6x6 at [22,28)x[10,16) — large enough
      (36 m2) to become a bogus polygon if class exclusion ever broke.
    """
    xs, ys, zs, cls = [], [], [], []

    def add(bx, by, z, c):
        xs.append(bx)
        ys.append(by)
        zs.append(np.full(bx.shape, z))
        cls.append(np.full(bx.shape, c, dtype=np.uint8))

    add(*_block(0, SIZE, 0, SIZE), GROUND_Z, 2)

    cx, cy = _block(5, 17, 5, 17)
    in_clearing = (cx - E0 >= 9) & (cx - E0 <= 13) & (cy - N0 >= 9) & (cy - N0 <= 13)
    add(cx[~in_clearing], cy[~in_clearing], CANOPY_Z, 1)

    add(*_block(20, 26, 20, 26), SHRUB_Z, 1)
    add(*_block(24, 27, 3, 6), CANOPY_Z, 1)
    add(*_block(22, 28, 10, 16), 210.0, 18)

    return _write_las(
        tmp_path / "scene.las",
        np.concatenate(xs), np.concatenate(ys), np.concatenate(zs), np.concatenate(cls),
    )


# ─── grid_lidar_points max-aggregation mode ──────────────────────────────────

def test_grid_lidar_points_max_aggregate_and_class_exclusion(tmp_path: Path):
    path = tmp_path / "max.las"
    # Two returns in cell (5,5): max must win over mean. A class-7 noise
    # point in cell (2,2) at absurd z must be excluded via exclude_classes
    # even though classes=None takes every other code.
    _write_las(
        path,
        [5.2, 5.8, 2.5, 8.5],
        [5.2, 5.8, 2.5, 8.5],
        [110.0, 118.0, 999.0, 60.0],
        [1, 2, 7, 9],
    )

    bbox = (0.0, 0.0, 10.0, 10.0)
    max_grid, count_grid, _, class_counts = grid_dem.grid_lidar_points(
        [path], bbox, resolution=1.0, classes=None, aggregate="max",
        exclude_classes=detect_trees.NOISE_CLASSES,
    )

    row, col = int(10.0 - 1 - 5.0), 5  # row 4 (north-up grid), col 5
    assert max_grid[row, col] == pytest.approx(118.0)  # max, not sum/mean
    assert count_grid[row, col] == 2

    noise_row, noise_col = int(10.0 - 1 - 2.0), 2
    assert count_grid[noise_row, noise_col] == 0  # class 7 excluded
    assert np.isneginf(max_grid[noise_row, noise_col])  # unhit cells hold -inf

    # classes=None still tallies diagnostics for every class in bbox.
    assert class_counts.counts == {1: 1, 2: 1, 7: 1, 9: 1}
    assert class_counts.points_used_for_grid == 3


def test_grid_lidar_points_rejects_unknown_aggregate(tmp_path: Path):
    path = _write_las(tmp_path / "one.las", [1.0], [1.0], [1.0], [2])
    with pytest.raises(ValueError, match="aggregate"):
        grid_dem.grid_lidar_points([path], (0.0, 0.0, 2.0, 2.0), aggregate="median")


# ─── nDSM + morphology building blocks ───────────────────────────────────────

def test_build_ndsm_clamps_and_masks():
    ground = np.array([[10.0, 10.0, detect_trees.NODATA], [10.0, 10.0, 10.0]], dtype=np.float32)
    surface = np.array([[18.0, 8.0, 50.0], [-np.inf, 12.0, 10.0]])
    count = np.array([[1.0, 1.0, 1.0], [0.0, 2.0, 1.0]])

    ndsm = detect_trees.build_ndsm(ground, surface, count)

    assert ndsm[0, 0] == pytest.approx(8.0)  # normal canopy height
    assert ndsm[0, 1] == 0.0  # surface below ground clamps to 0
    assert ndsm[0, 2] == 0.0  # no ground reference → no canopy
    assert ndsm[1, 0] == 0.0  # no surface return → no canopy
    assert ndsm[1, 1] == pytest.approx(2.0)


def test_canopy_mask_thresholds_opens_and_closes():
    ndsm = np.zeros((20, 20))
    ndsm[2, 2] = 9.0  # isolated single cell — opening must kill it
    ndsm[5:15, 5:15] = 9.0  # solid blob
    ndsm[8:10, 8:10] = 0.0  # 2x2 interior gap — closing must bridge it
    ndsm[16, 5:15] = 1.9  # below threshold — never canopy

    mask = detect_trees.canopy_mask(ndsm, min_height_m=2.0)

    assert not mask[2, 2]
    assert mask[8:10, 8:10].all()  # gap dissolved into the crown
    assert mask[5:15, 5:15].all()
    assert not mask[16, 5:15].any()


# ─── end-to-end command ──────────────────────────────────────────────────────

def test_cmd_detect_trees_end_to_end(tmp_path: Path, scene_las: Path, capsys):
    out = tmp_path / "trees.geojson"
    cmd_detect_trees([scene_las], BBOX_3006, out, resolution=1.0)

    import json

    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["crs"]["properties"]["name"].endswith("EPSG::3006")
    assert "Laserdata Skog" in collection["attribution"]

    # Exactly one crown polygon: the shrub is below --min-height, the speck
    # below --min-area, and the class-18 noise block excluded by class.
    assert len(collection["features"]) == 1
    feature = collection["features"][0]
    assert feature["properties"]["type"] == "trees"

    rings = feature["geometry"]["coordinates"]
    assert len(rings) == 2  # exterior + the interior clearing as a hole

    polygon = Polygon(rings[0], rings[1:])
    assert polygon.area == pytest.approx(128.0, rel=0.15)  # 12x12 minus 4x4
    assert Polygon(rings[1]).area == pytest.approx(16.0, rel=0.3)

    # Output coordinates are EPSG:3006 metres inside the scene bbox.
    for ring in rings:
        for x, y in ring:
            assert E0 <= x <= E0 + SIZE and N0 <= y <= N0 + SIZE

    assert "Wrote" in capsys.readouterr().out


def test_detect_trees_cli_dispatch(tmp_path: Path, scene_las: Path):
    out = tmp_path / "trees.geojson"
    code = main([
        "detect-trees",
        "--lidar", str(scene_las),
        "--bbox-3006", ",".join(str(v) for v in BBOX_3006),
        "--resolution", "1.0",
        "--out", str(out),
    ])
    assert code == 0
    assert out.exists()
