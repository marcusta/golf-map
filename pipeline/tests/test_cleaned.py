"""The cleaned photo (golfpipe.cleaned): one square RGB GeoTIFF per site,
edited in place. Offline and torch-free: mask fills come from a fake
inpaint_fn, as in test_patches.
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


def box_3857(e0: float, n0: float, e1: float, n1: float) -> dict:
    w, s, e, n = transform_bounds(CRS.from_epsg(3006), CRS.from_epsg(3857), e0, n0, e1, n1)
    return {"west": w, "south": s, "east": e, "north": n}


def write_edits(edits_dir: Path, entries: list[dict]) -> None:
    edits_dir.mkdir(parents=True, exist_ok=True)
    (edits_dir / patches.PATCH_LOG_NAME).write_text(json.dumps({"version": 2, "patches": entries}), encoding="utf-8")


def solid(color):
    def fn(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        out = image.copy()
        out[mask] = color
        return out
    return fn


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


# --- cleaned-bake -----------------------------------------------------------


def test_bake_writes_mask_and_stamp_edits_into_the_photo_and_retiles_under_them(photo: Path, tmp_path: Path):
    before = pixels(photo)
    edits = tmp_path / "edits"
    # A mask over the 16 m box at the square's south-west corner, all white.
    edits.mkdir()
    Image.fromarray(np.full((32, 32), 255, dtype=np.uint8)).save(edits / "1.png")
    mask_box = (SQUARE[0], SQUARE[1], SQUARE[0] + 16, SQUARE[1] + 16)
    # A stamp dab in the north-east quarter, cloning from 20 m to the west.
    cx, cy = SQUARE[2] - 12, SQUARE[3] - 12
    write_edits(edits, [
        {"seq": 1, "file": "1.png", "bounds3857": box_3857(*mask_box), "tool": "ellipse", "createdAt": ""},
        {"seq": 2, "kind": "stamp", "bounds3857": box_3857(cx - 4, cy - 4, cx + 4, cy + 4),
         "boundsSweref": {"west": cx - 4, "south": cy - 4, "east": cx + 4, "north": cy + 4},
         "tool": "stamp", "createdAt": "",
         "stamp": {"brush": {"sizeM": 6, "opacity": 1, "flow": 1, "hardness": 1},
                   "offsetM": {"dx": -20, "dy": 0}, "path": [[cx, cy]], "aligned": True, "toneMatch": False}},
    ])
    tiles = tmp_path / "tiles" / "ortho-sim"
    doc = cleaned.cmd_cleaned_bake(photo, edits, tiles_out=tiles, minzoom=15, maxzoom=16, inpaint_fn=solid(MAGENTA))

    after = pixels(photo)
    assert doc["edits"] == 2 and doc["baked"] == 2
    # The mask box is the bottom-left 16 px; its inside is the fill.
    assert (after[SIZE - 12:SIZE - 4, 4:12] == MAGENTA).all()
    # The dab's core took the pixels 20 px to its left.
    r, c = 12, SIZE - 12
    assert np.array_equal(after[r - 1:r + 1, c - 1:c + 1], before[r - 1:r + 1, c - 20 - 1:c - 20 + 1])
    # Nothing else moved.
    untouched = np.ones((SIZE, SIZE), dtype=bool)
    untouched[SIZE - 20:, :20] = False
    untouched[r - 5:r + 5, c - 5:c + 5] = False
    assert np.array_equal(after[untouched], before[untouched])
    assert doc["tiles"] == len(list(tiles.rglob("*.webp"))) > 0


def test_bake_needs_edits_and_a_photo(photo: Path, tmp_path: Path):
    with pytest.raises(patches.PatchError, match="nothing to bake"):
        cleaned.cmd_cleaned_bake(photo, tmp_path / "empty")
    write_edits(tmp_path / "e", [{"seq": 1, "file": "1.png", "bounds3857": box_3857(*SQUARE), "tool": "sam"}])
    with pytest.raises(patches.PatchError, match="run cleaned-init first"):
        cleaned.cmd_cleaned_bake(tmp_path / "missing.cleaned.tif", tmp_path / "e", inpaint_fn=solid(MAGENTA))


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


# --- what the bake must keep doing ------------------------------------------


def stamp_edit(seq: int, cx: float, cy: float, *, to: tuple[float, float] | None = None, size_m: float = 6,
               offset: tuple[float, float] = (-20, 0), opacity: float = 1, flow: float = 1, hardness: float = 1,
               tone_match: bool = False) -> dict:
    """A stamp entry: a dab at (cx, cy), or a stroke from there to `to`, EPSG:3006."""
    path = [[cx, cy]] + ([list(to)] if to else [])
    xs, ys, r = [p[0] for p in path], [p[1] for p in path], size_m / 2 + 1
    return {"seq": seq, "kind": "stamp", "bounds3857": box_3857(min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r),
            "tool": "stamp", "createdAt": "",
            "stamp": {"brush": {"sizeM": size_m, "opacity": opacity, "flow": flow, "hardness": hardness},
                      "offsetM": {"dx": offset[0], "dy": offset[1]}, "path": path, "aligned": True,
                      "toneMatch": tone_match}}


def mask_edit(edits_dir: Path, seq: int, box3006: tuple[float, float, float, float], white: bool = True) -> dict:
    """A mask entry over `box3006`, its 64 px mask PNG all white (or all black) written beside it."""
    edits_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.full((64, 64), 255 if white else 0, dtype=np.uint8)).save(edits_dir / f"{seq}.png")
    return {"seq": seq, "file": f"{seq}.png", "bounds3857": box_3857(*box3006), "tool": "sam", "createdAt": ""}


def px(e: float, n: float) -> tuple[int, int]:
    """Cleaned-photo pixel (row, col) of an EPSG:3006 point: 1 m/px, north up."""
    return int(SQUARE[3] - n), int(e - SQUARE[0])


def test_a_stamp_only_bake_never_loads_lama(photo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Stamps are pixel math: a batch without a mask must work with no torch and no weights."""
    from golfpipe import commands

    def explode(weights, device):
        raise AssertionError("LaMa constructed for a stamp-only bake")

    monkeypatch.setattr(commands, "_lama_inpaint_fn", explode)
    write_edits(tmp_path / "edits", [stamp_edit(1, SQUARE[2] - 12, SQUARE[3] - 12)])
    assert cleaned.cmd_cleaned_bake(photo, tmp_path / "edits")["baked"] == 1


def test_sparse_sim_tiles_take_the_children_they_lack_from_the_pristine_tree(ortho: Path, photo: Path, tmp_path: Path):
    """The sim tree holds only changed tiles, so a parent tile whose children
    are partly in it must read the rest from the read-only pristine tree and
    never composite black."""
    from golfpipe.commands import cmd_tile_ortho

    pristine = tmp_path / "tiles" / "ortho"
    cmd_tile_ortho(ortho, pristine, minzoom=16, maxzoom=18)
    write_edits(tmp_path / "edits", [stamp_edit(1, SQUARE[0] + 30, SQUARE[1] + 40)])
    sim = tmp_path / "tiles" / "ortho-sim"
    cleaned.cmd_cleaned_bake(photo, tmp_path / "edits", tiles_out=sim, pristine_tiles=pristine, minzoom=16, maxzoom=18)

    entry = patches.load_patch_log(tmp_path / "edits")[0]
    expected = patches.affected_tiles([entry.bounds3857], 16, 18)
    written = {(int(p.parts[-3]), int(p.parts[-2]), int(p.stem)) for p in sim.rglob("*.webp")}
    assert written == {(t.z, t.x, t.y) for t in expected}

    parent = next(t for t in expected if t.z == 16)
    rel = Path("16") / str(parent.x) / f"{parent.y}.webp"
    sim_img = np.asarray(Image.open(sim / rel).convert("RGB"), dtype=np.int16)
    pristine_img = np.asarray(Image.open(pristine / rel).convert("RGB"), dtype=np.int16)
    # A tiny stroke plus re-encode noise; a black quadrant would be far above this.
    assert np.abs(sim_img - pristine_img).mean() < 6.0


def test_later_edits_win_where_they_overlap(photo: Path, tmp_path: Path):
    edits = tmp_path / "edits"
    write_edits(edits, [
        mask_edit(edits, 2, (E0 + 25, N0 + 45, E0 + 35, N0 + 55)),
        mask_edit(edits, 1, (E0 + 20, N0 + 40, E0 + 30, N0 + 50)),
    ])
    fills = iter([MAGENTA, CYAN])  # one call per entry, in seq order whatever the file order

    def fn(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        return solid(next(fills))(image, mask)

    assert cleaned.cmd_cleaned_bake(photo, edits, inpaint_fn=fn)["baked"] == 2
    after = pixels(photo)
    assert tuple(after[px(E0 + 28.5, N0 + 46.5)]) == CYAN      # the overlap: edit 2
    assert tuple(after[px(E0 + 22.5, N0 + 41.5)]) == MAGENTA   # edit 1 only


def test_a_stamp_clones_what_an_earlier_mask_of_the_batch_filled(photo: Path, tmp_path: Path):
    """Each edit bakes onto the photo as the edits before it left it."""
    edits = tmp_path / "edits"
    write_edits(edits, [
        mask_edit(edits, 1, (E0 + 20, N0 + 40, E0 + 30, N0 + 50)),
        # A dab at (60, 20) whose source, 35 m west and 25 m north, is the middle of the mask.
        stamp_edit(2, E0 + 60, N0 + 20, offset=(-35, 25)),
    ])
    cleaned.cmd_cleaned_bake(photo, edits, inpaint_fn=solid(MAGENTA))
    after = pixels(photo)
    assert tuple(after[px(E0 + 25.5, N0 + 44.5)]) == MAGENTA
    assert tuple(after[px(E0 + 60.5, N0 + 19.5)]) == MAGENTA


def test_an_empty_mask_and_edits_off_the_photo_change_nothing(photo: Path, tmp_path: Path):
    before = pixels(photo)
    edits = tmp_path / "edits"
    write_edits(edits, [
        mask_edit(edits, 1, (E0 + 20, N0 + 40, E0 + 30, N0 + 50), white=False),
        mask_edit(edits, 2, (E0 + 5000, N0 + 5000, E0 + 5010, N0 + 5010)),
        stamp_edit(3, E0 + 5000, N0 + 5000),
    ])

    def explode(image, mask):
        raise AssertionError("inpaint_fn called with nothing to fill")

    doc = cleaned.cmd_cleaned_bake(photo, edits, inpaint_fn=explode)
    assert (doc["edits"], doc["baked"]) == (3, 0)
    assert np.array_equal(pixels(photo), before)


def test_a_mask_entry_without_its_png_fails_the_bake(photo: Path, tmp_path: Path):
    write_edits(tmp_path / "edits", [
        {"seq": 1, "file": "1.png", "bounds3857": box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50), "tool": "sam"}])
    with pytest.raises(patches.PatchError, match="mask file missing"):
        cleaned.cmd_cleaned_bake(photo, tmp_path / "edits", inpaint_fn=solid(MAGENTA))


def test_the_same_stroke_on_the_same_photo_gives_the_same_bytes(ortho: Path, tmp_path: Path):
    # A soft, translucent, tone-matched stroke: every float path of the brush engine.
    write_edits(tmp_path / "edits", [stamp_edit(
        1, E0 + 30, N0 + 40, to=(E0 + 40, N0 + 44), opacity=0.8, flow=0.4, hardness=0.5,
        offset=(15, -10), tone_match=True)])
    results = []
    for name in ("a", "b"):
        out = tmp_path / f"{name}.cleaned.tif"
        cleaned.create_cleaned(ortho, SQUARE, out, SIZE)
        untouched = pixels(out)
        assert cleaned.cmd_cleaned_bake(out, tmp_path / "edits")["baked"] == 1
        results.append(pixels(out))
    assert np.array_equal(results[0], results[1])
    assert not np.array_equal(results[0], untouched)


def test_a_stamp_whose_source_runs_off_the_photo_paints_only_where_it_has_one(photo: Path, tmp_path: Path):
    before = pixels(photo)
    # An 8 m dab centred 22 m inside the east edge, its source 20 m further east:
    # only the dab's pixels more than 20 px from the edge have a source on the photo.
    cx, cy = SQUARE[2] - 22, N0 + 40
    write_edits(tmp_path / "edits", [stamp_edit(1, cx, cy, size_m=8, offset=(20, 0))])
    assert cleaned.cmd_cleaned_bake(photo, tmp_path / "edits")["baked"] == 1
    after = pixels(photo)
    row, col = px(cx, cy)
    edge = SIZE - 20  # a pixel at or east of this column has its source off the photo
    assert np.array_equal(after[:, edge:], before[:, edge:])
    # West of it the dab is cloned exactly, from 20 px to the east.
    assert np.array_equal(after[row, edge - 2], before[row, edge - 2 + 20])
    assert not np.array_equal(after[:, col - 4:edge], before[:, col - 4:edge])


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


def test_export_rgb_is_the_raw_pixels(photo: Path, tmp_path: Path):
    out = tmp_path / "photo.rgb"
    doc = cleaned.cmd_cleaned_export(photo, out, fmt="rgb")
    assert doc["bytes"] == SIZE * SIZE * 3
    assert np.array_equal(np.fromfile(out, dtype=np.uint8).reshape(SIZE, SIZE, 3), pixels(photo))
