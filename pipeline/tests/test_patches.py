"""Ortho patch-log tests (T55, reworked to seam-free windowed baking) —
fully offline, no torch. Patches are MASK PNGs (version-2 log); the fill is
computed by an injected fake inpaint_fn, so the tests cover the geometry and
plumbing LaMa plugs into: log loading/versioning, EPSG:3857→3006 mask
rasterization, windowed inpaint-in-place, full replay, incremental bake with
its staleness fallback, affected-tile retiling, and CLI wiring.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path

import mercantile
import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

from golfpipe import commands, patches
from golfpipe.__main__ import main
from golfpipe.commands import cmd_apply_ortho_patches, cmd_bake_ortho_patch, default_patched_out_path

# Scene anchored at realistic SWEREF99 TM coordinates (Landeryd-ish).
E0, N0 = 533000.0, 6473000.0
SIZE = 80  # 80x80 px, 1 m/px synthetic ortho

MAGENTA = (255, 0, 255)
CYAN = (0, 255, 255)


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


def solid_fill_fn(color: tuple[int, int, int]):
    """Deterministic fake InpaintFn: masked pixels -> `color`."""
    def fn(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        out = image.copy()
        out[mask] = color
        return out
    return fn


def sub_box_3857(e0: float, n0: float, e1: float, n1: float) -> tuple[float, float, float, float]:
    """EPSG:3857 bounds of an EPSG:3006 sub-box — masks carry the 3857
    frame of the tile crop they were drawn on."""
    return transform_bounds(CRS.from_epsg(3006), CRS.from_epsg(3857), e0, n0, e1, n1)


def mask_png(path: Path, size: int = 64, box: tuple[int, int, int, int] | None = None) -> None:
    """Grayscale mask PNG: white (=inpaint) inside `box` (x0, y0, x1, y1 px;
    default the whole image), black outside — the shape the web tool uploads."""
    m = np.zeros((size, size), dtype=np.uint8)
    if box is None:
        m[:] = 255
    else:
        x0, y0, x1, y1 = box
        m[y0:y1, x0:x1] = 255
    Image.fromarray(m).save(path)


def write_log(patches_dir: Path, entries: list[dict], version: int = 2) -> None:
    patches_dir.mkdir(parents=True, exist_ok=True)
    (patches_dir / patches.PATCH_LOG_NAME).write_text(
        json.dumps({"version": version, "patches": entries}), encoding="utf-8",
    )


def entry(seq: int, file: str, bounds: tuple[float, float, float, float], tool: str = "sam") -> dict:
    w, s, e, n = bounds
    return {
        "seq": seq, "file": file,
        "bounds3857": {"west": w, "south": s, "east": e, "north": n},
        "tool": tool, "createdAt": f"2026-07-19T10:00:0{seq}Z",
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


def test_legacy_v1_log_with_entries_is_refused_but_empty_v1_is_fine(tmp_path: Path):
    b = sub_box_3857(E0, N0, E0 + 10, N0 + 10)
    write_log(tmp_path, [entry(1, "1.png", b)], version=1)
    with pytest.raises(patches.PatchError, match="version-1 pixel-patch log"):
        patches.load_patch_log(tmp_path)

    write_log(tmp_path, [], version=1)
    assert patches.load_patch_log(tmp_path) == []


def test_unknown_log_version_is_refused(tmp_path: Path):
    write_log(tmp_path, [], version=3)
    with pytest.raises(patches.PatchError, match="unsupported patch log version"):
        patches.load_patch_log(tmp_path)


# --- full replay (apply_patches_to_ortho) ------------------------------------


def test_replay_inpaints_inside_mask_and_leaves_rest_byte_identical(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    # Mask over the 3006 box [20,30)x[40,50) — fully white.
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    mask_png(patches_dir / "1.png")
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    out = tmp_path / "out.tif"
    entries = patches.load_patch_log(patches_dir)
    patches.apply_patches_to_ortho(ortho, patches_dir, entries, out, inpaint_fn=solid_fill_fn(MAGENTA))

    with rasterio.open(ortho) as src, rasterio.open(out) as dst:
        assert dst.crs == src.crs
        assert dst.transform == src.transform
        assert dst.profile["compress"] == "deflate"
        original = np.moveaxis(src.read(), 0, -1)
        patched = np.moveaxis(dst.read(), 0, -1)

    # Mask interior (well away from the reprojection edge): filled.
    # Row index = N0+SIZE - northing; the box center (25, 45) -> row 35, col 25.
    assert tuple(patched[35, 25]) == MAGENTA
    assert tuple(patched[33, 27]) == MAGENTA
    # Everything outside the mask (window included): byte-identical — the
    # inpaint invariant plus windowed write-back never touch unmasked pixels.
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[28:52, 18:32] = False  # generous margin around the mask box
    assert np.array_equal(patched[far], original[far])


def test_replay_is_deterministic_and_always_from_pristine(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 10, N0 + 10, E0 + 22, N0 + 22)
    mask_png(patches_dir / "1.png")
    write_log(patches_dir, [entry(1, "1.png", bounds)])
    entries = patches.load_patch_log(patches_dir)

    out_a, out_b = tmp_path / "a.tif", tmp_path / "b.tif"
    patches.apply_patches_to_ortho(ortho, patches_dir, entries, out_a, inpaint_fn=solid_fill_fn((10, 200, 30)))
    patches.apply_patches_to_ortho(ortho, patches_dir, entries, out_b, inpaint_fn=solid_fill_fn((10, 200, 30)))
    with rasterio.open(out_a) as a, rasterio.open(out_b) as b:
        assert np.array_equal(a.read(), b.read())
    # Pristine source untouched by both runs.
    with rasterio.open(ortho) as src:
        assert src.read().min() >= 1  # the fixture never writes 0 rows


def test_later_patches_win_in_overlap(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    b1 = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    b2 = sub_box_3857(E0 + 25, N0 + 45, E0 + 35, N0 + 55)
    mask_png(patches_dir / "1.png")
    mask_png(patches_dir / "2.png")
    write_log(patches_dir, [entry(1, "1.png", b1), entry(2, "2.png", b2, tool="ellipse")])

    colors = {1: MAGENTA, 2: CYAN}
    calls: list[int] = []

    def fn(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        # Entries replay in seq order — color by call order.
        seq = 1 if not calls else 2
        calls.append(seq)
        out = image.copy()
        out[mask] = colors[min(seq, 2)]
        return out

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=fn)
    with rasterio.open(out) as dst:
        patched = np.moveaxis(dst.read(), 0, -1)
    # Overlap center (28, 47) -> row SIZE-47=33, col 28: patch 2's cyan.
    assert tuple(patched[33, 28]) == CYAN
    # Patch-1-only area (22, 42) -> row 38, col 22: still magenta.
    assert tuple(patched[38, 22]) == MAGENTA


def test_empty_mask_changes_nothing(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    mask_png(patches_dir / "1.png", box=(0, 0, 0, 0))  # all black
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    out = tmp_path / "out.tif"

    def explode(image, mask):  # must never be called for an empty mask
        raise AssertionError("inpaint_fn called for an empty mask")

    patches.apply_patches_to_ortho(ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=explode)
    with rasterio.open(ortho) as src, rasterio.open(out) as dst:
        assert np.array_equal(src.read(), dst.read())


def test_mask_outside_raster_is_a_noop(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 5000, N0 + 5000, E0 + 5010, N0 + 5010)
    mask_png(patches_dir / "1.png")
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(
        ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=solid_fill_fn(MAGENTA),
    )
    with rasterio.open(ortho) as src, rasterio.open(out) as dst:
        assert np.array_equal(src.read(), dst.read())


def test_missing_mask_file_raises(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [entry(1, "1.png", sub_box_3857(E0, N0, E0 + 5, N0 + 5))])
    with pytest.raises(patches.PatchError, match="mask file missing"):
        patches.apply_patches_to_ortho(
            ortho, patches_dir, patches.load_patch_log(patches_dir), tmp_path / "out.tif",
            inpaint_fn=solid_fill_fn(MAGENTA),
        )


def test_refuses_out_equal_to_source(ortho: Path, tmp_path: Path):
    with pytest.raises(patches.PatchError, match="refusing to overwrite"):
        patches.apply_patches_to_ortho(ortho, tmp_path, [], ortho)


def test_nonempty_replay_without_inpaint_fn_raises(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    mask_png(patches_dir / "1.png")
    write_log(patches_dir, [entry(1, "1.png", sub_box_3857(E0, N0, E0 + 5, N0 + 5))])
    with pytest.raises(patches.PatchError, match="needs an inpaint_fn"):
        patches.apply_patches_to_ortho(
            ortho, patches_dir, patches.load_patch_log(patches_dir), tmp_path / "out.tif",
        )


# --- windowing ---------------------------------------------------------------


def test_inpaint_window_carries_context_margin(ortho: Path, tmp_path: Path):
    """The inpaint_fn must see the mask plus a surrounding context band —
    LaMa fills from surroundings."""
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    # ~10x10 m mask box in the middle of the 80 m raster.
    bounds = sub_box_3857(E0 + 35, N0 + 35, E0 + 45, N0 + 45)
    mask_png(patches_dir / "1.png")

    shapes: list[tuple[int, int]] = []

    def recording(image, mask):
        shapes.append(mask.shape)
        return image.copy()

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(
        ortho, patches_dir,
        [patches.PatchEntry(1, "1.png", bounds, "sam", "")],
        out, inpaint_fn=recording, context_px=12,
    )
    assert len(shapes) == 1
    h, w = shapes[0]
    # Mask box ~10-12 px + 12 px context each side, clipped to the raster.
    assert 30 <= h <= 40 and 30 <= w <= 40


def test_window_for_bounds_clips_and_rejects_misses():
    transform = from_origin(E0, N0 + SIZE, 1.0, 1.0)
    crs = CRS.from_epsg(3006)
    b = sub_box_3857(E0 + 70, N0 + 70, E0 + 90, N0 + 90)  # spills over the edge
    win = patches.window_for_bounds(transform, crs, SIZE, SIZE, b, pad_px=4)
    assert win is not None
    r0, r1, c0, c1 = win
    assert 0 <= r0 < r1 <= SIZE and 0 <= c0 < c1 <= SIZE
    assert r0 == 0  # north edge clipped (top of raster)
    assert patches.window_for_bounds(
        transform, crs, SIZE, SIZE, sub_box_3857(E0 + 500, N0 + 500, E0 + 510, N0 + 510),
    ) is None


def test_mask_tight_bounds_are_a_subrectangle_of_the_frame():
    mask = np.zeros((64, 64), dtype=bool)
    mask[16:32, 8:24] = True
    frame = (0.0, 0.0, 64.0, 64.0)  # 1 unit/px, row 0 = north
    tight = patches.mask_tight_bounds3857(mask, frame)
    assert tight is not None
    w, s, e, n = tight
    # cols 8..24 -> x 8..24; rows 16..32 -> y 64-32..64-16 (±1 px pad).
    assert w == pytest.approx(7.0) and e == pytest.approx(25.0)
    assert s == pytest.approx(31.0) and n == pytest.approx(49.0)
    assert patches.mask_tight_bounds3857(np.zeros((8, 8), dtype=bool), frame) is None


# --- incremental bake (cmd_bake_ortho_patch) ---------------------------------


def bake_setup(ortho: Path, tmp_path: Path):
    """Two logged masks over disjoint boxes; returns (patches_dir, b1, b2)."""
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir(exist_ok=True)
    b1 = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    b2 = sub_box_3857(E0 + 50, N0 + 15, E0 + 60, N0 + 25)
    mask_png(patches_dir / "1.png")
    mask_png(patches_dir / "2.png")
    write_log(patches_dir, [entry(1, "1.png", b1), entry(2, "2.png", b2, tool="ellipse")])
    return patches_dir, b1, b2


def test_bake_appends_incrementally_into_the_existing_working_raster(ortho: Path, tmp_path: Path):
    patches_dir, b1, b2 = bake_setup(ortho, tmp_path)
    out = tmp_path / "patched.tif"

    # First accept: working raster is missing -> full replay of the log so
    # far. (Simulate the real sequence: entry 1 was the whole log then.)
    write_log(patches_dir, [entry(1, "1.png", b1)])
    cmd_bake_ortho_patch(ortho, patches_dir, out=out, inpaint_fn=solid_fill_fn(MAGENTA))
    with rasterio.open(out) as dst:
        after_first = np.moveaxis(dst.read(), 0, -1)
    assert tuple(after_first[35, 25]) == MAGENTA

    # Second accept: log grows to [1, 2]; bake ONLY seq 2 into the existing
    # raster — fill 1 must be retained without being recomputed.
    write_log(patches_dir, [entry(1, "1.png", b1), entry(2, "2.png", b2, tool="ellipse")])
    calls: list[int] = []

    def cyan_once(image, mask):
        calls.append(1)
        out_img = image.copy()
        out_img[mask] = CYAN
        return out_img

    cmd_bake_ortho_patch(ortho, patches_dir, seq=2, out=out, inpaint_fn=cyan_once)
    assert len(calls) == 1  # one windowed inpaint, not a replay
    with rasterio.open(out) as dst:
        after_second = np.moveaxis(dst.read(), 0, -1)
    # b2 center (55, 20) -> row 60, col 55: cyan. b1 fill untouched.
    assert tuple(after_second[60, 55]) == CYAN
    assert tuple(after_second[35, 25]) == MAGENTA
    # Outside both masks: byte-identical to the state after the first bake.
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[28:52, 18:32] = False
    far[53:67, 48:62] = False
    assert np.array_equal(after_second[far], after_first[far])


def test_bake_falls_back_to_full_replay_when_working_raster_is_stale(ortho: Path, tmp_path: Path):
    patches_dir, b1, b2 = bake_setup(ortho, tmp_path)
    out = tmp_path / "patched.tif"
    # A stale working raster: raw copy WITHOUT fill 1, older than the source
    # (as after a rebuild replaced the vintage underneath it).
    import shutil
    shutil.copyfile(ortho, out)
    old = ortho.stat().st_mtime - 100
    os.utime(out, (old, old))

    cmd_bake_ortho_patch(ortho, patches_dir, seq=2, out=out, inpaint_fn=solid_fill_fn(CYAN))
    with rasterio.open(out) as dst:
        patched = np.moveaxis(dst.read(), 0, -1)
    # Full replay: BOTH masks are filled, not just seq 2.
    assert tuple(patched[35, 25]) == CYAN
    assert tuple(patched[60, 55]) == CYAN


def test_bake_retiles_only_the_target_masks_subtree(ortho: Path, tmp_path: Path):
    patches_dir, b1, b2 = bake_setup(ortho, tmp_path)
    out = tmp_path / "patched.tif"
    write_log(patches_dir, [entry(1, "1.png", b1)])
    cmd_bake_ortho_patch(ortho, patches_dir, out=out, inpaint_fn=solid_fill_fn(MAGENTA))

    write_log(patches_dir, [entry(1, "1.png", b1), entry(2, "2.png", b2, tool="ellipse")])
    tiles_out = tmp_path / "tiles" / "ortho"
    cmd_bake_ortho_patch(
        ortho, patches_dir, seq=2, out=out, tiles_out=tiles_out,
        minzoom=14, maxzoom=17, inpaint_fn=solid_fill_fn(CYAN),
    )
    expected = patches.affected_tiles([b2], 14, 17)
    written = sorted(
        (int(p.parts[-3]), int(p.parts[-2]), int(p.stem))
        for p in tiles_out.rglob("*.webp")
    )
    assert written == sorted((t.z, t.x, t.y) for t in expected)
    sample = next(tiles_out.rglob("*.webp"))
    assert Image.open(io.BytesIO(sample.read_bytes())).size == (256, 256)


def test_bake_errors_on_empty_log_and_unknown_seq(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [])
    with pytest.raises(patches.PatchError, match="nothing to bake"):
        cmd_bake_ortho_patch(ortho, patches_dir, inpaint_fn=solid_fill_fn(MAGENTA))

    patches_dir2, b1, _ = bake_setup(ortho, tmp_path)
    with pytest.raises(patches.PatchError, match="no logged patch with seq 9"):
        cmd_bake_ortho_patch(ortho, patches_dir2, seq=9, inpaint_fn=solid_fill_fn(MAGENTA))


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
    mask_png(patches_dir / "1.png")
    write_log(patches_dir, [entry(1, "1.png", bounds)])

    tiles_out = tmp_path / "tiles" / "ortho"
    out = cmd_apply_ortho_patches(
        ortho, patches_dir, out=tmp_path / "patched.tif", tiles_out=tiles_out,
        minzoom=14, maxzoom=17, inpaint_fn=solid_fill_fn(MAGENTA),
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
    """Revert-last of the only patch: the log is empty (a torch-free path),
    but the reverted patch's bounds (passed as --extra-bounds) must still be
    retiled."""
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


def test_main_wires_apply_ortho_patches(ortho: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(commands, "_lama_inpaint_fn", lambda weights, device: solid_fill_fn(MAGENTA))
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    mask_png(patches_dir / "1.png")
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


def test_main_wires_bake_ortho_patch(ortho: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(commands, "_lama_inpaint_fn", lambda weights, device: solid_fill_fn(CYAN))
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    bounds = sub_box_3857(E0 + 50, N0 + 15, E0 + 60, N0 + 25)
    mask_png(patches_dir / "1.png")
    write_log(patches_dir, [entry(1, "1.png", bounds)])
    tiles_out = tmp_path / "tiles"

    rc = main([
        "bake-ortho-patch",
        "--ortho", str(ortho),
        "--patches-dir", str(patches_dir),
        "--seq", "1",
        "--out", str(tmp_path / "p.tif"),
        "--tiles-out", str(tiles_out),
        "--minzoom", "16", "--maxzoom", "17",
    ])
    assert rc == 0
    with rasterio.open(tmp_path / "p.tif") as dst:
        patched = np.moveaxis(dst.read(), 0, -1)
    assert tuple(patched[60, 55]) == CYAN
    assert len(list(tiles_out.rglob("*.webp"))) == len(patches.affected_tiles([bounds], 16, 17))


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


def test_main_legacy_v1_log_is_a_clean_error(ortho: Path, tmp_path: Path, capsys):
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [entry(1, "1.png", sub_box_3857(E0, N0, E0 + 5, N0 + 5))], version=1)
    rc = main(["apply-ortho-patches", "--ortho", str(ortho), "--patches-dir", str(patches_dir)])
    assert rc == 1
    assert "version-1 pixel-patch log" in capsys.readouterr().err


def test_default_patched_out_path():
    p = Path("/data/sources/x/ortho-orto-l2-2025.tif")
    assert default_patched_out_path(p) == Path("/data/sources/x/ortho-orto-l2-2025.patched.tif")


# --- 3857↔3006 alignment sanity ---------------------------------------------


def test_mask_rasterization_respects_the_3857_frame_not_an_axis_aligned_3006_box():
    """A mask whose 3857 frame is rotated relative to the 3006 grid must land
    rotated: the reprojected mask edge tilts across rows instead of matching
    a naive axis-aligned 3006 paste. Checked far from Sweden's central
    meridian (max convergence)."""
    # Destination window grid near Haparanda (E ~ 24°, convergence ~ 2°).
    e0, n0 = 890000.0, 7300000.0
    size = 60
    window_transform = from_origin(e0, n0 + size, 1.0, 1.0)
    crs = CRS.from_epsg(3006)

    bounds = transform_bounds(crs, CRS.from_epsg(3857), e0 + 10, n0 + 10, e0 + 50, n0 + 50)
    # Left half of the mask True — after reprojection the True/False divider
    # must be visibly tilted in 3006 pixel space.
    mask = np.zeros((64, 64), dtype=bool)
    mask[:, :32] = True
    warped = patches.rasterize_mask_window(mask, bounds, window_transform, crs, (size, size))

    assert warped.any()
    cols = [int(np.max(np.nonzero(warped[r]))) for r in range(15, 45) if warped[r].any()]
    assert max(cols) - min(cols) >= 1
    import math
    assert not math.isclose(float(np.std(cols)), 0.0)
