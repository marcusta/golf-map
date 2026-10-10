"""Clean-tool edit entries and their bake primitives (golfpipe.patches) —
fully offline, no torch. Mask entries are MASK PNGs; the fill is computed by
an injected fake inpaint_fn, so the tests cover the geometry and plumbing
LaMa plugs into: reading and versioning `patches.json`, EPSG:3857→3006 mask
rasterization, the windowed inpaint-in-place, and the affected-tile set. The
bake of a whole batch into the cleaned photo is in test_cleaned.
"""

from __future__ import annotations

import json
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

# Scene anchored at realistic SWEREF99 TM coordinates (Landeryd-ish).
E0, N0 = 533000.0, 6473000.0
SIZE = 80  # 80x80 px, 1 m/px synthetic ortho

MAGENTA = (255, 0, 255)


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


# --- windowing ---------------------------------------------------------------


def test_inpaint_window_carries_context_margin(ortho: Path, tmp_path: Path):
    """The inpaint_fn must see the mask plus a surrounding context band —
    LaMa fills from surroundings."""
    # ~10x10 m mask box in the middle of the 80 m raster.
    bounds = sub_box_3857(E0 + 35, N0 + 35, E0 + 45, N0 + 45)
    mask_png(tmp_path / "1.png")

    shapes: list[tuple[int, int]] = []

    def recording(image, mask):
        shapes.append(mask.shape)
        return image.copy()

    with rasterio.open(ortho, "r+") as dst:
        patches.bake_entry_into(
            dst, tmp_path, patches.PatchEntry(1, "1.png", bounds, "sam", ""), recording, context_px=12,
        )
    assert len(shapes) == 1
    h, w = shapes[0]
    # Mask box ~10-12 px + 12 px context each side, clipped to the raster.
    assert 30 <= h <= 40 and 30 <= w <= 40


def test_mask_entry_without_inpaint_fn_raises(ortho: Path, tmp_path: Path):
    mask_png(tmp_path / "1.png")
    mask = patches.PatchEntry(1, "1.png", sub_box_3857(E0, N0, E0 + 5, N0 + 5), "sam", "")
    with rasterio.open(ortho, "r+") as dst:
        with pytest.raises(patches.PatchError, match="needs an inpaint_fn"):
            patches.bake_entry_into(dst, tmp_path, mask, None)


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
