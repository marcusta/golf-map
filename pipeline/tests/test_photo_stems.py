"""golfpipe photo-stems beyond the frozen acceptance cases (tests/acceptance/test_photo_stems_omberg.py)."""
from __future__ import annotations

import statistics
from pathlib import Path

from golfpipe import photo_stems

CUT = Path(__file__).resolve().parent / "fixtures" / "photo-stems-omberg" / "rough-1-10"


def _run(tmp_path: Path, factor: float) -> dict:
    return photo_stems.cmd_photo_stems(
        CUT / "ortho-orto-l2-2025.tif", CUT / "ortho-orto-l2-2023.tif", CUT / "tree-stems.json",
        CUT / "features.json", tmp_path / f"out-{factor}.json", lidar_size_factor=factor)


def test_the_lidar_size_factor_sizes_the_photo_stems_like_the_scaled_lidar_trees(tmp_path):
    """Omberg's trees export plants every lidar stem 1.15 times as tall and wide (trees.lidarSizeFactor):
    calibrated against them at that size, the photo stems grow with them and stand where they stood."""
    plain, scaled = _run(tmp_path, 1.0), _run(tmp_path, 1.15)
    assert [p["id"] for p in scaled["proposals"]] == [p["id"] for p in plain["proposals"]]
    h0 = statistics.median(p["heightM"] for p in plain["proposals"])
    h1 = statistics.median(p["heightM"] for p in scaled["proposals"])
    r0 = statistics.median(p["crownRadiusM"] for p in plain["proposals"])
    r1 = statistics.median(p["crownRadiusM"] for p in scaled["proposals"])
    assert abs(h1 / h0 - 1.15) < 0.05
    assert abs(r1 / r0 - 1.15) < 0.1
    assert scaled["calibration"]["lidarSizeFactor"] == 1.15
