"""The cleaned photo (golfpipe.cleaned): one square RGB GeoTIFF per site,
edited in place. Offline and torch-free.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

from golfpipe import cleaned, patches
from golfpipe.__main__ import main

# An 80 m photo at 1 m/px; the terrain square is its middle 64 m.
E0, N0 = 533000.0, 6473000.0
SRC = 80
SQUARE = (E0 + 8, N0 + 8, E0 + 72, N0 + 72)
SIZE = 64  # 1 m/px on the square, so cleaned pixels are source pixels

MAGENTA = (255, 0, 255)
CYAN = (0, 255, 255)


@pytest.fixture
def ortho(tmp_path: Path) -> Path:
    path = tmp_path / "ortho-orto-l2-2025.tif"
    rgb = np.random.default_rng(7).integers(1, 255, size=(3, SRC, SRC), dtype=np.uint8)
    profile = {
        "driver": "GTiff", "height": SRC, "width": SRC, "count": 3, "dtype": "uint8",
        "crs": CRS.from_epsg(3006), "transform": from_origin(E0, N0 + SRC, 1.0, 1.0), "compress": "deflate",
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(rgb)
    return path


@pytest.fixture
def photo(ortho: Path, tmp_path: Path) -> Path:
    out = tmp_path / "ortho-orto-l2-2025.cleaned.tif"
    cleaned.create_cleaned(ortho, SQUARE, out, SIZE)
    return out


def pixels(path: Path) -> np.ndarray:
    with rasterio.open(path) as src:
        return np.moveaxis(src.read([1, 2, 3]), 0, -1)


# --- cleaned-init -----------------------------------------------------------


def test_init_writes_the_square_at_the_given_size_in_3006(ortho: Path, photo: Path):
    with rasterio.open(photo) as src:
        assert (src.width, src.height, src.count, src.dtypes[0]) == (SIZE, SIZE, 3, "uint8")
        assert src.crs == CRS.from_epsg(3006)
        assert tuple(src.bounds) == pytest.approx(SQUARE)
    # 1 m/px on a pixel-aligned square: the cleaned pixels are the source's.
    with rasterio.open(ortho) as src:
        source = np.moveaxis(src.read([1, 2, 3]), 0, -1)
    assert np.array_equal(pixels(photo), source[8:72, 8:72])


def test_init_never_replaces_an_existing_cleaned_photo_or_the_source(ortho: Path, photo: Path, capsys):
    with pytest.raises(patches.PatchError, match="never re-created"):
        cleaned.cmd_cleaned_init(ortho, SQUARE, photo, SIZE)
    with pytest.raises(patches.PatchError, match="refusing to overwrite the source"):
        cleaned.create_cleaned(ortho, SQUARE, ortho, SIZE)
    with pytest.raises(patches.PatchError, match="must be a square"):
        cleaned.create_cleaned(ortho, (E0, N0, E0 + 10, N0 + 20), photo.with_name("x.tif"), SIZE)


def test_init_cli_prints_what_it_wrote(ortho: Path, tmp_path: Path, capsys):
    out = tmp_path / "c.cleaned.tif"
    assert main(["cleaned-init", "--ortho", str(ortho), "--square-3006", ",".join(str(v) for v in SQUARE),
                 "--out", str(out), "--size", "32"]) == 0
    doc = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert doc == {"file": "c.cleaned.tif", "size": 32, "extent3006": list(SQUARE), "source": ortho.name}
    with rasterio.open(out) as src:
        assert src.width == 32


# --- cleaned-replace --------------------------------------------------------


def test_replace_takes_any_image_of_the_size_and_reports_only_what_changed(photo: Path, tmp_path: Path):
    edited = pixels(photo).copy()
    edited[10:14, 20:30] = (1, 2, 3)
    image = tmp_path / "edit.png"
    Image.fromarray(edited).save(image)
    tiles = tmp_path / "tiles" / "ortho-sim"

    doc = cleaned.cmd_cleaned_replace(photo, image, tiles_out=tiles, minzoom=15, maxzoom=16)
    assert doc["changed"] is True and doc["changedPixels"] == 40 and doc["size"] == SIZE
    # The box is exactly the changed pixels' edges, in metres.
    assert doc["bounds3006"] == pytest.approx({
        "west": SQUARE[0] + 20, "east": SQUARE[0] + 30, "north": SQUARE[3] - 10, "south": SQUARE[3] - 14})
    assert np.array_equal(pixels(photo), edited)
    assert doc["tiles"] == len(list(tiles.rglob("*.webp"))) > 0

    # The same image again changes nothing and touches no tile.
    again = cleaned.cmd_cleaned_replace(photo, image, tiles_out=tmp_path / "none")
    assert again == {"changed": False, "changedPixels": 0, "size": SIZE}
    assert not (tmp_path / "none").exists()


def test_replace_retiles_under_each_change_not_the_box_round_them_all(photo: Path, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(cleaned, "RETILE_CELL_PX", 8)
    edited = pixels(photo).copy()
    edited[1, 1] = (9, 9, 9)        # north-west corner
    edited[62, 62] = (9, 9, 9)      # south-east corner
    Image.fromarray(edited).save(tmp_path / "corners.png")
    seen: list = []
    monkeypatch.setattr(cleaned, "_retile", lambda _c, bounds, *a, **k: seen.extend(bounds) or 0)
    doc = cleaned.cmd_cleaned_replace(photo, tmp_path / "corners.png", tiles_out=tmp_path / "t")
    # The reported box spans the photo; the retile gets the two 8 px cells only.
    assert doc["bounds3006"]["east"] - doc["bounds3006"]["west"] == pytest.approx(62)
    assert len(seen) == 2
    to_3006 = lambda b: transform_bounds(CRS.from_epsg(3857), CRS.from_epsg(3006), *b)
    widths = sorted(round(to_3006(b)[2] - to_3006(b)[0]) for b in seen)
    assert all(8 <= w <= 9 for w in widths)


def test_replace_takes_a_wholly_different_picture(photo: Path, tmp_path: Path):
    other = np.random.default_rng(99).integers(0, 255, size=(SIZE, SIZE, 3), dtype=np.uint8)
    image = tmp_path / "mickey.png"
    Image.fromarray(other).save(image)
    doc = cleaned.cmd_cleaned_replace(photo, image)
    assert doc["changed"] is True
    assert np.array_equal(pixels(photo), other)


def test_replace_lays_a_transparent_image_over_the_photo(photo: Path, tmp_path: Path):
    before = pixels(photo)
    rgba = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    rgba[30:34, 30:34] = (*MAGENTA, 255)
    image = tmp_path / "layer.png"
    Image.fromarray(rgba).save(image)
    cleaned.cmd_cleaned_replace(photo, image)
    after = pixels(photo)
    assert (after[30:34, 30:34] == MAGENTA).all()
    mask = np.ones((SIZE, SIZE), dtype=bool)
    mask[30:34, 30:34] = False
    assert np.array_equal(after[mask], before[mask])


def test_replace_refuses_another_size_and_a_non_image(photo: Path, tmp_path: Path):
    before = pixels(photo)
    small = tmp_path / "small.png"
    Image.fromarray(np.zeros((32, 32, 3), dtype=np.uint8)).save(small)
    with pytest.raises(patches.PatchError, match=r"32 x 32 px and the cleaned photo is 64 x 64 px"):
        cleaned.cmd_cleaned_replace(photo, small)
    junk = tmp_path / "junk.png"
    junk.write_bytes(b"not an image")
    with pytest.raises(patches.PatchError, match="cannot read junk.png as an image"):
        cleaned.cmd_cleaned_replace(photo, junk)
    assert np.array_equal(pixels(photo), before)


def test_replace_restores_an_undo_snapshot(photo: Path, tmp_path: Path):
    snapshot = tmp_path / "1.tif"
    snapshot.write_bytes(photo.read_bytes())
    before = pixels(photo)
    edited = before.copy()
    edited[:8, :8] = 0
    Image.fromarray(edited).save(tmp_path / "e.png")
    cleaned.cmd_cleaned_replace(photo, tmp_path / "e.png")
    doc = cleaned.cmd_cleaned_replace(photo, snapshot)
    assert doc["changed"] is True
    assert np.array_equal(pixels(photo), before)


# --- cleaned-export ---------------------------------------------------------


def test_export_png_is_the_photo_and_comes_back_unchanged(photo: Path, tmp_path: Path, capsys):
    out = tmp_path / "out" / "cleaned.png"
    assert main(["cleaned-export", "--cleaned", str(photo), "--out", str(out)]) == 0
    doc = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert doc == {"file": "cleaned.png", "format": "png", "size": SIZE, "bytes": out.stat().st_size}
    assert np.array_equal(np.asarray(Image.open(out)), pixels(photo))
    assert main(["cleaned-replace", "--cleaned", str(photo), "--image", str(out)]) == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["changed"] is False


def test_export_jpeg_and_cli_errors(photo: Path, tmp_path: Path, capsys):
    out = tmp_path / "cleaned.jpg"
    cleaned.cmd_cleaned_export(photo, out, fmt="jpg")
    assert Image.open(out).format == "JPEG"
    capsys.readouterr()
    assert main(["cleaned-replace", "--cleaned", str(tmp_path / "nope.tif"), "--image", str(out)]) != 0
    assert "run cleaned-init first" in capsys.readouterr().err


# --- cleaned-patch (the Clean tool's strokes) and the raw export -------------

def write_patches(patches_dir: Path, rects: list[tuple[int, int, int, int, tuple[int, int, int]]]) -> None:
    patches_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, (x, y, w, h, color) in enumerate(rects):
        rgba = np.empty((h, w, 4), dtype=np.uint8)
        rgba[..., :3] = color
        rgba[..., 3] = 0  # alpha is ignored
        rgba.tofile(patches_dir / f"{i}.rgba")
        entries.append({"x": x, "y": y, "w": w, "h": h, "file": f"{i}.rgba"})
    (patches_dir / "patches.json").write_text(json.dumps(entries), encoding="utf-8")


def test_patch_writes_the_rectangles_in_order_and_retiles_under_them(photo: Path, tmp_path: Path):
    before = pixels(photo).copy()
    write_patches(tmp_path / "p", [(20, 10, 10, 4, MAGENTA), (25, 12, 3, 6, CYAN)])
    tiles = tmp_path / "tiles" / "ortho-sim"
    doc = cleaned.cmd_cleaned_patch(photo, tmp_path / "p", tiles_out=tiles, minzoom=15, maxzoom=16)
    assert doc["patches"] == 2 and doc["pixels"] == 58
    assert doc["tiles"] == len(list(tiles.rglob("*.webp"))) > 0
    after = pixels(photo)
    expected = before.copy()
    expected[10:14, 20:30] = MAGENTA
    expected[12:18, 25:28] = CYAN  # the later patch wins where they overlap
    assert np.array_equal(after, expected)


def test_patch_refuses_a_rectangle_off_the_photo_and_a_short_file(photo: Path, tmp_path: Path):
    write_patches(tmp_path / "off", [(SIZE - 2, 0, 4, 4, MAGENTA)])
    with pytest.raises(patches.PatchError, match="outside"):
        cleaned.cmd_cleaned_patch(photo, tmp_path / "off")
    write_patches(tmp_path / "short", [(0, 0, 4, 4, MAGENTA)])
    (tmp_path / "short" / "0.rgba").write_bytes(b"\x00" * 10)
    with pytest.raises(patches.PatchError, match="not 4 x 4"):
        cleaned.cmd_cleaned_patch(photo, tmp_path / "short")
    with pytest.raises(patches.PatchError, match="patches.json"):
        cleaned.cmd_cleaned_patch(photo, tmp_path / "missing")


def test_sparse_sim_tiles_take_the_children_they_lack_from_the_pristine_tree(ortho: Path, photo: Path, tmp_path: Path):
    """The sim tree holds only changed tiles, so a parent tile whose children
    are partly in it must read the rest from the read-only pristine tree and
    never composite black."""
    from golfpipe.commands import cmd_tile_ortho

    pristine = tmp_path / "tiles" / "ortho"
    cmd_tile_ortho(ortho, pristine, minzoom=16, maxzoom=18)
    # A 4 px patch that keeps the photo's own pixels: the tiles are rewritten, the picture is not.
    x, y, w, h = 30, 22, 4, 4
    patches_dir = tmp_path / "p"
    patches_dir.mkdir()
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = pixels(photo)[y:y + h, x:x + w]
    rgba.tofile(patches_dir / "0.rgba")
    (patches_dir / "patches.json").write_text(
        json.dumps([{"x": x, "y": y, "w": w, "h": h, "file": "0.rgba"}]), encoding="utf-8")
    sim = tmp_path / "tiles" / "ortho-sim"
    cleaned.cmd_cleaned_patch(photo, patches_dir, tiles_out=sim, pristine_tiles=pristine, minzoom=16, maxzoom=18)

    box3006 = (SQUARE[0] + x, SQUARE[3] - y - h, SQUARE[0] + x + w, SQUARE[3] - y)
    expected = patches.affected_tiles([patches.bounds3006_to_3857(box3006)], 16, 18)
    written = {(int(p.parts[-3]), int(p.parts[-2]), int(p.stem)) for p in sim.rglob("*.webp")}
    assert written == {(t.z, t.x, t.y) for t in expected}

    parent = next(t for t in expected if t.z == 16)
    rel = Path("16") / str(parent.x) / f"{parent.y}.webp"
    sim_img = np.asarray(Image.open(sim / rel).convert("RGB"), dtype=np.int16)
    pristine_img = np.asarray(Image.open(pristine / rel).convert("RGB"), dtype=np.int16)
    # Resampling and re-encode noise only; a black quadrant would be far above this.
    assert np.abs(sim_img - pristine_img).mean() < 6.0


def test_export_rgb_is_the_raw_pixels(photo: Path, tmp_path: Path):
    out = tmp_path / "photo.rgb"
    doc = cleaned.cmd_cleaned_export(photo, out, fmt="rgb")
    assert doc["bytes"] == SIZE * SIZE * 3
    assert np.array_equal(np.fromfile(out, dtype=np.uint8).reshape(SIZE, SIZE, 3), pixels(photo))
