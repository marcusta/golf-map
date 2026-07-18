"""apply-ortho-patches tests (T55) — fully offline, no torch. Patches are
pre-rendered RGBA PNGs (as the server stores them), so replay/retile is pure
raster work: log loading, EPSG:3857→3006 composite correctness, replay
determinism, affected-tile computation, and CLI wiring with real (tiny)
WebP retiling.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path

import mercantile
import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

from golfpipe import patches
from golfpipe.__main__ import main
from golfpipe.commands import cmd_apply_ortho_patches, default_patched_out_path

# Scene anchored at realistic SWEREF99 TM coordinates (Landeryd-ish).
E0, N0 = 533000.0, 6473000.0
SIZE = 80  # 80x80 px, 1 m/px synthetic ortho


@pytest.fixture
def ortho(tmp_path: Path) -> Path:
    path = tmp_path / "ortho-orto-l2-2025.tif"
    transform = from_origin(E0, N0 + SIZE, 1.0, 1.0)
    rng = np.random.default_rng(7)
    rgb = rng.integers(1, 255, size=(3, SIZE, SIZE), dtype=np.uint8)
    profile = {
        "driver": "GTiff", "height": SIZE, "width": SIZE, "count": 3,
        "dtype": "uint8", "crs": CRS.from_epsg(3006),
        "transform": transform, "nodata": 0, "compress": "deflate",
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(rgb)
    return path


def sub_box_3857(e0: float, n0: float, e1: float, n1: float) -> tuple[float, float, float, float]:
    """EPSG:3857 bounds of an EPSG:3006 sub-box — patches carry the 3857
    frame of the tile crop they came from."""
    return transform_bounds(CRS.from_epsg(3006), CRS.from_epsg(3857), e0, n0, e1, n1)


def solid_patch_png(path: Path, color: tuple[int, int, int], size: int = 64,
                    alpha_box: tuple[int, int, int, int] | None = None) -> None:
    """RGBA PNG: `color` everywhere, alpha 255 inside alpha_box (px, default
    all) and 0 outside — the shape the web tool uploads (alpha = inpaint mask)."""
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., :3] = color
    if alpha_box is None:
        rgba[..., 3] = 255
    else:
        x0, y0, x1, y1 = alpha_box
        rgba[y0:y1, x0:x1, 3] = 255
    Image.fromarray(rgba).save(path)


def write_log(patches_dir: Path, entries: list[dict]) -> None:
    patches_dir.mkdir(parents=True, exist_ok=True)
    (patches_dir / patches.PATCH_LOG_NAME).write_text(
        json.dumps({"version": 1, "patches": entries}), encoding="utf-8",
    )


def entry(seq: int, file: str, bounds: tuple[float, float, float, float], tool: str = "sam") -> dict:
    w, s, e, n = bounds
    return {
        "seq": seq, "file": file,
        "bounds3857": {"west": w, "south": s, "east": e, "north": n},
        "tool": tool, "createdAt": f"2026-07-18T10:00:0{seq}Z",
    }


# --- load_patch_log ----------------------------------------------------------


def test_missing_log_is_an_empty_list(tmp_path: Path):
    assert patches.load_patch_log(tmp_path / "nope") == []


def test_log_entries_sort_by_seq(tmp_path: Path):
    b = sub_box_3857(E0, N0, E0 + 10, N0 + 10)
    write_log(tmp_path, [entry(2, "2.png", b), entry(1, "1.png", b)])
    loaded = patches.load_patch_log(tmp_path)
    assert [e.seq for e in loaded] == [1, 2]
    assert loaded[0].file == "1.png"
    assert loaded[0].tool == "sam"
    assert loaded[0].bounds3857 == pytest.approx(b)


def test_bad_json_and_bad_entries_raise(tmp_path: Path):
    (tmp_path / patches.PATCH_LOG_NAME).write_text("{nope", encoding="utf-8")
    with pytest.raises(patches.PatchError, match="cannot read"):
        patches.load_patch_log(tmp_path)

    write_log(tmp_path, [{"seq": 1, "file": "1.png", "bounds3857": {"west": 5, "south": 5, "east": 1, "north": 9}}])
    with pytest.raises(patches.PatchError, match="degenerate bounds"):
        patches.load_patch_log(tmp_path)

    write_log(tmp_path, [{"seq": 1, "file": "../evil.png",
                          "bounds3857": {"west": 0, "south": 0, "east": 1, "north": 1}}])
    with pytest.raises(patches.PatchError, match="plain name"):
        patches.load_patch_log(tmp_path)

    (tmp_path / patches.PATCH_LOG_NAME).write_text(json.dumps({"other": []}), encoding="utf-8")
    with pytest.raises(patches.PatchError, match="not a patch log"):
        patches.load_patch_log(tmp_path)


# --- replay ------------------------------------------------------------------


def test_replay_composites_patch_inside_bounds_and_leaves_rest_byte_identical(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    # Patch over the 3006 box [20,30)x[40,50) — magenta, fully opaque.
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    solid_patch_png(patches_dir / "1.png", (255, 0, 255))
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    out = tmp_path / "out.tif"
    entries = patches.load_patch_log(patches_dir)
    patches.apply_patches_to_ortho(ortho, patches_dir, entries, out)

    with rasterio.open(ortho) as src, rasterio.open(out) as dst:
        assert dst.crs == src.crs
        assert dst.transform == src.transform
        assert dst.profile["compress"] == "deflate"
        original = np.moveaxis(src.read(), 0, -1)
        patched = np.moveaxis(dst.read(), 0, -1)

    # Patch interior (well away from the reprojection edge blend): magenta.
    # Row index = N0+SIZE - northing; the box center (25, 45) -> row 35, col 25.
    assert tuple(patched[35, 25]) == (255, 0, 255)
    assert tuple(patched[33, 27]) == (255, 0, 255)
    # Far outside the patch: byte-identical to the pristine source.
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[25:56, 15:36] = False  # generous margin around the patch
    assert np.array_equal(patched[far], original[far])


def test_replay_is_deterministic_and_always_from_pristine(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 10, N0 + 10, E0 + 22, N0 + 22)
    solid_patch_png(patches_dir / "1.png", (10, 200, 30))
    write_log(patches_dir, [entry(1, "1.png", bounds)])
    entries = patches.load_patch_log(patches_dir)

    out_a, out_b = tmp_path / "a.tif", tmp_path / "b.tif"
    patches.apply_patches_to_ortho(ortho, patches_dir, entries, out_a)
    patches.apply_patches_to_ortho(ortho, patches_dir, entries, out_b)
    with rasterio.open(out_a) as a, rasterio.open(out_b) as b:
        assert np.array_equal(a.read(), b.read())
    # Pristine source untouched by both runs.
    with rasterio.open(ortho) as src:
        assert src.read().min() >= 1  # the fixture never writes 0/magenta rows


def test_later_patches_win_in_overlap(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    b1 = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    b2 = sub_box_3857(E0 + 25, N0 + 45, E0 + 35, N0 + 55)
    solid_patch_png(patches_dir / "1.png", (255, 0, 255))
    solid_patch_png(patches_dir / "2.png", (0, 255, 255))
    write_log(patches_dir, [entry(1, "1.png", b1), entry(2, "2.png", b2, tool="ellipse")])

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(ortho, patches_dir, patches.load_patch_log(patches_dir), out)
    with rasterio.open(out) as dst:
        patched = np.moveaxis(dst.read(), 0, -1)
    # Overlap center (28, 47) -> row SIZE-47=33, col 28: patch 2's cyan.
    assert tuple(patched[33, 28]) == (0, 255, 255)
    # Patch-1-only area (22, 42) -> row 38, col 22: still magenta.
    assert tuple(patched[38, 22]) == (255, 0, 255)


def test_zero_alpha_patch_changes_nothing(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    solid_patch_png(patches_dir / "1.png", (255, 0, 255), alpha_box=(0, 0, 0, 0))
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(ortho, patches_dir, patches.load_patch_log(patches_dir), out)
    with rasterio.open(ortho) as src, rasterio.open(out) as dst:
        assert np.array_equal(src.read(), dst.read())


def test_patch_outside_raster_is_a_noop(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 5000, N0 + 5000, E0 + 5010, N0 + 5010)
    solid_patch_png(patches_dir / "1.png", (255, 0, 255))
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(ortho, patches_dir, patches.load_patch_log(patches_dir), out)
    with rasterio.open(ortho) as src, rasterio.open(out) as dst:
        assert np.array_equal(src.read(), dst.read())


def test_missing_patch_file_raises(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [entry(1, "1.png", sub_box_3857(E0, N0, E0 + 5, N0 + 5))])
    with pytest.raises(patches.PatchError, match="patch file missing"):
        patches.apply_patches_to_ortho(
            ortho, patches_dir, patches.load_patch_log(patches_dir), tmp_path / "out.tif",
        )


def test_refuses_out_equal_to_source(ortho: Path, tmp_path: Path):
    with pytest.raises(patches.PatchError, match="refusing to overwrite"):
        patches.apply_patches_to_ortho(ortho, tmp_path, [], ortho)


# --- affected_tiles ----------------------------------------------------------


def test_affected_tiles_cover_the_bounds_at_every_zoom():
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 60, N0 + 76)  # ~40x36 m
    tiles = patches.affected_tiles([bounds], 14, 20)

    by_zoom: dict[int, list[mercantile.Tile]] = {}
    for t in tiles:
        by_zoom.setdefault(t.z, []).append(t)
    assert sorted(by_zoom) == list(range(14, 21))

    w, s, e, n = transform_bounds(CRS.from_epsg(3857), CRS.from_epsg(4326), *bounds)
    for z in range(14, 21):
        expected = set(mercantile.tiles(w, s, e, n, [z]))
        assert set(by_zoom[z]) == expected
    # A ~40 m box: one tile at z14, a small cluster at z20 — never an explosion.
    assert len(by_zoom[14]) == 1
    assert 1 <= len(by_zoom[20]) <= 9
    # Deterministic ordering.
    assert tiles == sorted(tiles, key=lambda t: (t.z, t.x, t.y))


def test_affected_tiles_dedupe_overlapping_patches():
    b = sub_box_3857(E0, N0, E0 + 10, N0 + 10)
    once = patches.affected_tiles([b], 14, 18)
    twice = patches.affected_tiles([b, b], 14, 18)
    assert once == twice


# --- CLI / command wiring ----------------------------------------------------


def test_cmd_apply_ortho_patches_retiles_only_the_affected_subtree(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    solid_patch_png(patches_dir / "1.png", (255, 0, 255))
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    tiles_out = tmp_path / "tiles" / "ortho"
    out = cmd_apply_ortho_patches(
        ortho, patches_dir, out=tmp_path / "patched.tif", tiles_out=tiles_out,
        minzoom=14, maxzoom=17,
    )
    assert out == tmp_path / "patched.tif"

    expected = patches.affected_tiles([bounds], 14, 17)
    written = sorted(
        (int(p.parts[-3]), int(p.parts[-2]), int(p.stem))
        for p in tiles_out.rglob("*.webp")
    )
    assert written == sorted((t.z, t.x, t.y) for t in expected)
    # And the tile bytes are valid WebP.
    sample = next(tiles_out.rglob("*.webp"))
    assert Image.open(io.BytesIO(sample.read_bytes())).size == (256, 256)


def test_cmd_with_empty_log_and_extra_bounds_retiles_from_the_copy(ortho: Path, tmp_path: Path):
    """Revert-last of the only patch: the log is empty, but the reverted
    patch's bounds (passed as --extra-bounds) must still be retiled."""
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [])
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)

    tiles_out = tmp_path / "tiles" / "ortho"
    cmd_apply_ortho_patches(
        ortho, patches_dir, out=tmp_path / "patched.tif", tiles_out=tiles_out,
        minzoom=15, maxzoom=16, extra_bounds_3857=[bounds],
    )
    with rasterio.open(ortho) as src, rasterio.open(tmp_path / "patched.tif") as dst:
        assert np.array_equal(src.read(), dst.read())
    assert len(list(tiles_out.rglob("*.webp"))) == len(patches.affected_tiles([bounds], 15, 16))


def test_main_wires_apply_ortho_patches(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    solid_patch_png(patches_dir / "1.png", (255, 0, 255))
    write_log(patches_dir, [entry(1, "1.png", bounds)])
    tiles_out = tmp_path / "tiles"

    rc = main([
        "apply-ortho-patches",
        "--ortho", str(ortho),
        "--patches-dir", str(patches_dir),
        "--out", str(tmp_path / "p.tif"),
        "--tiles-out", str(tiles_out),
        "--minzoom", "16", "--maxzoom", "17",
        "--extra-bounds", ",".join(str(v) for v in sub_box_3857(E0, N0, E0 + 5, N0 + 5)),
    ])
    assert rc == 0
    assert (tmp_path / "p.tif").exists()
    expected = patches.affected_tiles([bounds, sub_box_3857(E0, N0, E0 + 5, N0 + 5)], 16, 17)
    assert len(list(tiles_out.rglob("*.webp"))) == len(expected)


def test_main_default_out_is_patched_tif_and_source_untouched(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [])
    source_bytes = ortho.read_bytes()
    rc = main(["apply-ortho-patches", "--ortho", str(ortho), "--patches-dir", str(patches_dir)])
    assert rc == 0
    assert default_patched_out_path(ortho).exists()
    assert ortho.read_bytes() == source_bytes


def test_main_bad_log_is_a_clean_error(ortho: Path, tmp_path: Path, capsys):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    (patches_dir / patches.PATCH_LOG_NAME).write_text("{broken", encoding="utf-8")
    rc = main(["apply-ortho-patches", "--ortho", str(ortho), "--patches-dir", str(patches_dir)])
    assert rc == 1
    assert "cannot read patch log" in capsys.readouterr().err


def test_default_patched_out_path():
    p = Path("/data/sources/x/ortho-orto-l2-2025.tif")
    assert default_patched_out_path(p) == Path("/data/sources/x/ortho-orto-l2-2025.patched.tif")


# --- 3857↔3006 alignment sanity ---------------------------------------------


def test_composite_respects_the_3857_frame_not_an_axis_aligned_3006_box():
    """A patch whose 3857 frame is rotated relative to the 3006 grid must
    land rotated: the corner of the reprojected patch differs from a naive
    axis-aligned 3006 paste. Verified via alpha coverage of a half-opaque
    patch far from Sweden's central meridian (max convergence)."""
    # Ortho grid near Haparanda (E ~ 24°, convergence ~ 2°).
    e0, n0 = 890000.0, 7300000.0
    size = 60
    transform = from_origin(e0, n0 + size, 1.0, 1.0)
    image = np.zeros((size, size, 3), dtype=np.uint8)

    bounds = transform_bounds(CRS.from_epsg(3006), CRS.from_epsg(3857), e0 + 10, n0 + 10, e0 + 50, n0 + 50)
    # Left half opaque white — after reprojection the opaque/clear divider
    # must be visibly tilted in 3006 pixel space.
    rgba = np.zeros((64, 64, 4), dtype=np.uint8)
    rgba[:, :32, :3] = 255
    rgba[:, :32, 3] = 255
    patches.composite_patch(image, transform, CRS.from_epsg(3006), rgba, bounds)

    filled = image[:, :, 0] > 128
    assert filled.any()
    # The divider column varies with the row — rotation is preserved.
    cols = [int(np.max(np.nonzero(filled[r]))) for r in range(15, 45) if filled[r].any()]
    assert max(cols) - min(cols) >= 1
    assert not math.isclose(float(np.std(cols)), 0.0)
