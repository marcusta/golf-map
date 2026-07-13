"""Tests for golfpipe.reencode_webp — converting a legacy JPEG ortho tile
tree to WebP in place, idempotently, without touching terrain/.
"""

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from golfpipe.reencode_webp import main, reencode_ortho_tree


def _write_jpg(path: Path, seed: int = 0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    arr = rng.integers(0, 256, size=(256, 256, 3), dtype=np.uint8)
    Image.fromarray(arr).save(path, format="JPEG", quality=85)


def _write_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.zeros((256, 256, 3), dtype=np.uint8)
    Image.fromarray(arr).save(path, format="PNG")


@pytest.fixture
def jpg_tile_tree(tmp_path: Path) -> Path:
    """A course tile root with an ortho/ tree of a few .jpg tiles across
    two zoom levels, plus a terrain/ tree of .png tiles that must be left
    untouched."""
    root = tmp_path / "course-1"
    _write_jpg(root / "ortho" / "16" / "100" / "200.jpg", seed=1)
    _write_jpg(root / "ortho" / "16" / "100" / "201.jpg", seed=2)
    _write_jpg(root / "ortho" / "17" / "201" / "402.jpg", seed=3)
    _write_png(root / "terrain" / "14" / "50" / "60.png")
    return root


def test_reencode_converts_all_jpgs_to_webp(jpg_tile_tree: Path):
    ortho = jpg_tile_tree / "ortho"
    summary = reencode_ortho_tree(ortho)

    assert summary["converted"] == 3
    assert summary["skipped"] == 0
    assert summary["bytes_before"] > 0
    assert summary["bytes_after"] > 0

    # Every source .jpg is gone, replaced by a sibling .webp.
    assert not list(ortho.rglob("*.jpg"))
    webps = sorted(p.relative_to(ortho).as_posix() for p in ortho.rglob("*.webp"))
    assert webps == ["16/100/200.webp", "16/100/201.webp", "17/201/402.webp"]

    for webp in ortho.rglob("*.webp"):
        img = Image.open(webp)
        assert img.format == "WEBP"
        img.load()


def test_reencode_leaves_terrain_untouched(jpg_tile_tree: Path):
    reencode_ortho_tree(jpg_tile_tree / "ortho")

    terrain_pngs = list((jpg_tile_tree / "terrain").rglob("*.png"))
    assert len(terrain_pngs) == 1
    assert not list((jpg_tile_tree / "terrain").rglob("*.webp"))


def test_reencode_is_idempotent(jpg_tile_tree: Path):
    ortho = jpg_tile_tree / "ortho"
    first = reencode_ortho_tree(ortho)
    assert first["converted"] == 3

    # Second run: nothing left to convert, no error, no changes.
    webp_bytes_before = {p: p.stat().st_size for p in ortho.rglob("*.webp")}
    second = reencode_ortho_tree(ortho)
    assert second["converted"] == 0
    assert second["skipped"] == 0  # no stale .jpg siblings remain either
    webp_bytes_after = {p: p.stat().st_size for p in ortho.rglob("*.webp")}
    assert webp_bytes_before == webp_bytes_after


def test_reencode_skips_and_cleans_partial_tree(jpg_tile_tree: Path):
    """A tile that already has a .webp sibling (e.g. an interrupted prior
    run) is skipped and its leftover .jpg is removed, without re-encoding."""
    ortho = jpg_tile_tree / "ortho"
    already = ortho / "16" / "100" / "200.webp"
    # Pretend this tile was already converted but its .jpg wasn't cleaned up.
    Image.open(ortho / "16" / "100" / "200.jpg").convert("RGB").save(
        already, format="WEBP", quality=80
    )
    marker = already.stat().st_size

    summary = reencode_ortho_tree(ortho)
    assert summary["skipped"] == 1
    assert summary["converted"] == 2
    # Pre-existing webp untouched (same size), stale jpg gone.
    assert already.stat().st_size == marker
    assert not list(ortho.rglob("*.jpg"))


def test_reencode_dry_run_writes_nothing(jpg_tile_tree: Path):
    ortho = jpg_tile_tree / "ortho"
    summary = reencode_ortho_tree(ortho, dry_run=True)
    assert summary["converted"] == 3
    # Nothing actually written or deleted.
    assert len(list(ortho.rglob("*.jpg"))) == 3
    assert not list(ortho.rglob("*.webp"))


def test_main_accepts_course_root(jpg_tile_tree: Path, capsys):
    rc = main([str(jpg_tile_tree)])
    assert rc == 0
    out = capsys.readouterr().out
    assert "3 converted" in out
    assert not list((jpg_tile_tree / "ortho").rglob("*.jpg"))


def test_main_accepts_ortho_dir_directly(jpg_tile_tree: Path):
    rc = main([str(jpg_tile_tree / "ortho")])
    assert rc == 0
    assert not list((jpg_tile_tree / "ortho").rglob("*.jpg"))


def test_main_missing_ortho_dir_errors(tmp_path: Path):
    rc = main([str(tmp_path / "nope")])
    assert rc == 1
