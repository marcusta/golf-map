"""Cleaned-photo export / re-import loop (docs/feature-ortho-export-import.md)
— fully offline, no torch. Covers the fixed square frame (creation from a
WGS84 bbox, refusal to change), `export-ortho-square` (image, world file,
export.json, immutability), `import-ortho-square` (diff against the export,
noise filter, no-change and refusal cases) and the whole round trip on a
synthetic GeoTIFF: an edit painted into the export lands on the right ground
pixels of the ortho, also when it is imported against an older export after
the log has grown.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image

import gspro
from golfpipe import commands, patches, square_frame
from golfpipe.__main__ import main
from golfpipe.commands import cmd_bake_ortho_patch, cmd_export_ortho_square, cmd_import_ortho_square

from test_patches import (  # noqa: F401  (ortho fixture re-used)
    CYAN, E0, MAGENTA, N0, SIZE,
    ortho, read_hwc, write_log,
)

# A WGS84 area near the synthetic ortho (Landeryd-ish).
BBOX = (15.60, 58.38, 15.62, 58.39)

# The test frame: a 100 m square around the 80 m ortho (10 m of uncovered
# ground on every side), 80 px -> 1.25 m/px, coarser than the 1 m ortho as
# the real 0.21 m frame is coarser than the 0.16 m photo.
FRAME_EXTENT = (E0 - 10.0, N0 - 10.0, E0 + 90.0, N0 + 90.0)
FRAME_SIZE = 80


def write_frame(path: Path, extent=FRAME_EXTENT, size: int = FRAME_SIZE) -> Path:
    path.write_text(json.dumps({"extent3006": list(extent), "size": size}), encoding="utf-8")
    return path


@pytest.fixture
def site(ortho: Path, tmp_path: Path) -> dict:
    """A site directory: working raster (a copy of the pristine ortho — an
    empty log), frame, patches dir, exports dir."""
    working = commands.default_patched_out_path(ortho)
    working.write_bytes(ortho.read_bytes())
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [])
    return {
        "ortho": ortho,
        "working": working,
        "frame": write_frame(tmp_path / square_frame.FRAME_NAME),
        "patches": patches_dir,
        "exports": tmp_path / "exports",
        "tmp": tmp_path,
    }


def export(site: dict, seq: int, log_seq: int = 0, **kw) -> dict:
    return cmd_export_ortho_square(
        site["working"], site["frame"], site["exports"] / str(seq), seq=seq, log_seq=log_seq, **kw,
    )


def edited_copy(site: dict, export_seq: int, name: str, paint) -> Path:
    """A copy of an export's PNG with `paint(pixels)` applied — the external
    editor."""
    src = site["exports"] / str(export_seq) / f"ortho-sim-{export_seq}.png"
    pixels = np.array(Image.open(src))
    paint(pixels)
    out = site["tmp"] / name
    Image.fromarray(pixels).save(out)
    return out


def append_entry(site: dict, result: dict) -> None:
    """What the server does with the import's stdout: append the entry."""
    log_path = site["patches"] / patches.PATCH_LOG_NAME
    doc = json.loads(log_path.read_text(encoding="utf-8"))
    doc["patches"].append({
        "seq": result["seq"], "kind": result["kind"], "file": result["file"],
        "bounds3006": result["bounds3006"], "bounds3857": result["bounds3857"],
        "exportSeq": result["exportSeq"], "changedPixels": result["changedPixels"],
        "tool": "external", "createdAt": "2026-10-07T12:00:00.000Z",
    })
    log_path.write_text(json.dumps(doc), encoding="utf-8")


def import_and_bake(site: dict, export_seq: int, image: Path, seq: int, **kw) -> dict:
    result = cmd_import_ortho_square(
        site["working"], site["patches"], site["exports"] / str(export_seq), image, seq=seq, **kw,
    )
    if result["changed"]:
        append_entry(site, result)
        cmd_bake_ortho_patch(site["ortho"], site["patches"], seqs=[seq], out=site["working"])
    return result


# --- frame -------------------------------------------------------------------


def test_square_extent_matches_gspro_ortho():
    assert square_frame.square_extent_3006(BBOX) == gspro._square_3006_extent(BBOX)
    assert square_frame.SIDE_STEP_M == gspro.SIDE_STEP_M
    assert square_frame.DEFAULT_SIZE == gspro.DEFAULT_SIZE


def test_frame_is_created_once_from_a_bbox_and_never_changed(tmp_path: Path):
    path = tmp_path / "site" / square_frame.FRAME_NAME
    with pytest.raises(patches.PatchError, match="pass --bounds-wgs84"):
        square_frame.ensure_frame(path)

    frame, created = square_frame.ensure_frame(path, BBOX)
    assert created
    assert frame.size == 8192
    assert frame.extent3006 == square_frame.square_extent_3006(BBOX)
    assert frame.side_m % 10.0 == pytest.approx(0.0, abs=1e-6)
    assert json.loads(path.read_text(encoding="utf-8")) == {"extent3006": list(frame.extent3006), "size": 8192}

    # Later calls return the stored frame — with nothing, or the same request.
    assert square_frame.ensure_frame(path) == (frame, False)
    assert square_frame.ensure_frame(path, BBOX, 8192) == (frame, False)
    before = path.read_bytes()
    with pytest.raises(patches.PatchError, match="refusing to change the frame"):
        square_frame.ensure_frame(path, (15.60, 58.38, 15.66, 58.39))
    with pytest.raises(patches.PatchError, match="refusing to change the frame"):
        square_frame.ensure_frame(path, size=4096)
    assert path.read_bytes() == before


def test_frame_file_is_validated(tmp_path: Path):
    path = tmp_path / square_frame.FRAME_NAME
    path.write_text("{nope", encoding="utf-8")
    with pytest.raises(patches.PatchError, match="cannot read frame"):
        square_frame.load_frame(path)
    write_frame(path, extent=(0.0, 0.0, 100.0, 90.0))
    with pytest.raises(patches.PatchError, match="not square"):
        square_frame.load_frame(path)
    write_frame(path, size=0)
    with pytest.raises(patches.PatchError, match="size must be a positive integer"):
        square_frame.load_frame(path)


def test_pixel_bounds_and_world_file():
    frame = square_frame.SquareFrame(FRAME_EXTENT, FRAME_SIZE)
    assert frame.res_m == 1.25
    assert frame.pixel_bounds3006(0, FRAME_SIZE, 0, FRAME_SIZE) == FRAME_EXTENT
    # Rows count from the north edge.
    assert frame.pixel_bounds3006(8, 16, 4, 12) == (E0 - 5.0, N0 + 70.0, E0 + 5.0, N0 + 80.0)
    lines = [float(v) for v in square_frame.world_file_text(frame).split()]
    assert lines == [1.25, 0.0, 0.0, -1.25, E0 - 10.0 + 0.625, N0 + 90.0 - 0.625]


# --- export ------------------------------------------------------------------


def test_export_writes_image_world_file_and_meta(site: dict, capsys):
    meta = export(site, 1, log_seq=7)
    out_dir = site["exports"] / "1"
    png = out_dir / "ortho-sim-1.png"

    assert json.loads(capsys.readouterr().out) == meta  # stdout is exactly export.json
    assert json.loads((out_dir / "export.json").read_text(encoding="utf-8")) == meta
    assert meta["exportSeq"] == 1 and meta["logSeq"] == 7
    assert meta["extent3006"] == list(FRAME_EXTENT) and meta["size"] == FRAME_SIZE
    assert meta["file"] == "ortho-sim-1.png" and meta["format"] == "png"
    assert meta["sha256"] == hashlib.sha256(png.read_bytes()).hexdigest()
    assert meta["bytes"] == png.stat().st_size
    assert (out_dir / "ortho-sim-1.pgw").read_text(encoding="ascii") == square_frame.world_file_text(
        square_frame.SquareFrame(FRAME_EXTENT, FRAME_SIZE))

    pixels = np.array(Image.open(png))
    assert pixels.shape == (FRAME_SIZE, FRAME_SIZE, 3)
    # The 10 m the ortho does not cover = 8 px of black on every side.
    assert not pixels[:7].any() and not pixels[:, :7].any()
    assert pixels[20:60, 20:60].min() > 0


def test_export_is_deterministic_and_immutable(site: dict):
    first = export(site, 1)
    second = export(site, 2)
    assert first["sha256"] == second["sha256"]
    with pytest.raises(patches.PatchError, match="exports are immutable"):
        export(site, 1)


def test_export_creates_the_frame_from_bounds_and_then_refuses_other_bounds(ortho: Path, tmp_path: Path):
    frame_path = tmp_path / square_frame.FRAME_NAME
    with pytest.raises(patches.PatchError, match="pass --bounds-wgs84"):
        cmd_export_ortho_square(ortho, frame_path, tmp_path / "exports" / "1", seq=1, log_seq=0)
    assert not (tmp_path / "exports" / "1" / "export.json").exists()

    meta = cmd_export_ortho_square(
        ortho, frame_path, tmp_path / "exports" / "1", seq=1, log_seq=0, size=64, bounds_wgs84=BBOX,
    )
    assert meta["extent3006"] == list(square_frame.square_extent_3006(BBOX)) and meta["size"] == 64
    assert square_frame.load_frame(frame_path).size == 64

    with pytest.raises(patches.PatchError, match="refusing to change the frame"):
        cmd_export_ortho_square(
            ortho, frame_path, tmp_path / "exports" / "2", seq=2, log_seq=0,
            bounds_wgs84=(15.0, 58.0, 15.1, 58.1),
        )


def test_export_jpg_writes_a_jpeg_and_its_world_file(site: dict):
    meta = export(site, 1, fmt="jpg")
    out_dir = site["exports"] / "1"
    assert meta["file"] == "ortho-sim-1.jpg" and meta["format"] == "jpg"
    assert Image.open(out_dir / "ortho-sim-1.jpg").format == "JPEG"
    assert (out_dir / "ortho-sim-1.jgw").is_file()


# --- import ------------------------------------------------------------------


def paint_block(color, r0=30, r1=42, c0=20, c1=36):
    def paint(pixels: np.ndarray) -> None:
        pixels[r0:r1, c0:c1] = color
    return paint


def test_round_trip_lands_the_edit_on_the_right_ground_pixels(site: dict):
    export(site, 1)
    before = read_hwc(site["working"])
    # Frame rows 30..42, cols 20..36 at 1.25 m: east E0+15..E0+35, north
    # N0+37.5..N0+52.5 -> ortho cols 15..35, rows 27.5..42.5.
    edited = edited_copy(site, 1, "edited.png", paint_block(MAGENTA))
    result = import_and_bake(site, 1, edited, seq=1)

    assert result["changed"] is True
    assert result["kind"] == "raster" and result["file"] == "1.png" and result["exportSeq"] == 1
    assert result["diffPixels"] == 12 * 16
    assert result["changedPixels"] == 14 * 18  # dilated 1 px
    assert result["regions"] == 1
    # Mask bbox + 2 px of padding, as exact frame pixel edges.
    assert (result["widthPx"], result["heightPx"]) == (20, 16)
    assert result["bounds3006"] == {
        "west": E0 + 12.5, "south": N0 + 35.0, "east": E0 + 37.5, "north": N0 + 55.0,
    }
    b = result["bounds3006"]
    assert tuple(result["bounds3857"].values()) == pytest.approx(
        patches.bounds3006_to_3857((b["west"], b["south"], b["east"], b["north"])))

    stored = np.array(Image.open(site["patches"] / "1.png"))
    assert stored.shape == (16, 20, 4)
    assert (stored[..., 3] > 0).sum() == result["changedPixels"]
    # The outer ring is transparent, so the alpha ramp ends inside the PNG.
    assert not stored[0, :, 3].any() and not stored[-1, :, 3].any()
    assert not stored[:, 0, 3].any() and not stored[:, -1, 3].any()

    after = read_hwc(site["working"])
    # Ortho pixels whose centre lies between painted frame-pixel centres:
    # exactly the painted colour.
    assert (after[28:42, 16:34] == MAGENTA).all()
    # Beyond the dilation + ramp (2 frame px = 2.5 m, taken as 4 m): untouched.
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[23:47, 11:40] = False
    assert np.array_equal(after[far], before[far])
    # The pristine source is never written.
    assert np.array_equal(read_hwc(site["ortho"]), before)

    # A second export contains the edit: re-importing it unedited is no change.
    export(site, 2, log_seq=1)
    again = cmd_import_ortho_square(
        site["working"], site["patches"], site["exports"] / "2",
        site["exports"] / "2" / "ortho-sim-2.png", seq=2,
    )
    assert again["changed"] is False and again["reason"] == "identical"


def test_import_against_an_older_export_keeps_what_the_log_gained_since(site: dict):
    export(site, 1)
    first = edited_copy(site, 1, "first.png", paint_block(MAGENTA))
    import_and_bake(site, 1, first, seq=1)
    export(site, 2, log_seq=1)

    # A second edit made in the OLD export 1, elsewhere: its image does not
    # show the magenta block. Only the cyan block may come out of the diff.
    second = edited_copy(site, 1, "second.png", paint_block(CYAN, r0=56, r1=64, c0=48, c1=60))
    before = read_hwc(site["working"])
    result = import_and_bake(site, 1, second, seq=2)

    assert result["changed"] is True and result["exportSeq"] == 1
    assert result["diffPixels"] == 8 * 12
    # Frame rows 56..64, cols 48..60 -> east E0+50..E0+65, north N0+10..N0+20
    # (+ 2 px of padding).
    assert result["bounds3006"] == {
        "west": E0 + 47.5, "south": N0 + 7.5, "east": E0 + 67.5, "north": N0 + 22.5,
    }
    after = read_hwc(site["working"])
    assert (after[62:69, 52:63] == CYAN).all()        # the new edit
    assert (after[28:42, 16:34] == MAGENTA).all()     # the earlier import survives
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[56:75, 46:69] = False
    assert np.array_equal(after[far], before[far])
    assert [e.seq for e in patches.load_patch_log(site["patches"])] == [1, 2]


def test_scattered_edits_are_one_entry_with_colour_only_around_the_masks(site: dict):
    export(site, 1)
    before = read_hwc(site["working"])

    def two_blocks(pixels: np.ndarray) -> None:
        pixels[14:20, 14:20] = MAGENTA
        pixels[60:66, 58:64] = CYAN

    result = import_and_bake(site, 1, edited_copy(site, 1, "two.png", two_blocks), seq=1)
    assert result["changed"] is True and result["regions"] == 2
    assert result["changedPixels"] == 2 * 8 * 8
    assert (result["widthPx"], result["heightPx"]) == (54, 56)

    stored = np.array(Image.open(site["patches"] / "1.png"))
    # Between the blocks nothing is stored: neither alpha nor colour.
    assert not stored[12:44, 12:42].any()
    # Around a mask the edited image's own colour is kept for the edge ramp.
    assert stored[0, 1:9, :3].all() and not stored[0, 1:9, 3].any()

    after = read_hwc(site["working"])
    # Frame rows/cols 14..20 -> ortho rows/cols 7.5..15; frame rows 60..66,
    # cols 58..64 -> ortho rows 65..72.5, cols 62.5..70.
    assert (after[8:14, 8:14] == MAGENTA).all()
    assert (after[66:72, 63:69] == CYAN).all()
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[3:20, 3:20] = False      # around the magenta block
    far[60:77, 58:75] = False    # around the cyan block
    assert np.array_equal(after[far], before[far])


def test_import_of_an_unedited_export_is_a_successful_no_change(site: dict, capsys):
    export(site, 1)
    capsys.readouterr()
    rc = main([
        "import-ortho-square",
        "--ortho", str(site["working"]),
        "--patches-dir", str(site["patches"]),
        "--export-dir", str(site["exports"] / "1"),
        "--image", str(site["exports"] / "1" / "ortho-sim-1.png"),
        "--seq", "1",
    ])
    assert rc == 0
    assert json.loads(capsys.readouterr().out) == {
        "changed": False, "reason": "identical", "seq": 1, "exportSeq": 1,
        "changedPixels": 0, "diffPixels": 0, "tolerance": 2, "minAreaPx": 4,
    }
    assert not (site["patches"] / "1.png").exists()


def test_import_tolerance_and_min_area_filter_noise(site: dict):
    export(site, 1)

    def shift_and_speck(pixels: np.ndarray) -> None:
        # A one-level shift everywhere it fits (a colour-profile round trip)...
        pixels[:] = np.where(pixels < 255, pixels + 1, pixels)
        # ...and a 3-pixel speck well over the tolerance.
        pixels[40, 40:43] = np.where(pixels[40, 40:43] < 128, 255, 0)

    noisy = edited_copy(site, 1, "noisy.png", shift_and_speck)
    result = cmd_import_ortho_square(site["working"], site["patches"], site["exports"] / "1", noisy, seq=1)
    assert result["changed"] is False and result["reason"] == "below-min-area"
    assert result["diffPixels"] == 3
    assert not (site["patches"] / "1.png").exists()

    kept = cmd_import_ortho_square(
        site["working"], site["patches"], site["exports"] / "1", noisy, seq=1, min_area_px=3,
    )
    assert kept["changed"] is True and kept["regions"] == 1 and kept["changedPixels"] == 3 * 5

    # With tolerance 0 the whole shifted frame is the change.
    everything = cmd_import_ortho_square(
        site["working"], site["patches"], site["exports"] / "1", noisy, seq=2, tolerance=0,
    )
    assert everything["changedPixels"] > 0.5 * FRAME_SIZE * FRAME_SIZE


def test_import_of_a_change_off_the_photo_is_a_no_change(site: dict):
    export(site, 1)
    corner = edited_copy(site, 1, "corner.png", paint_block(MAGENTA, r0=0, r1=4, c0=0, c1=4))
    result = cmd_import_ortho_square(site["working"], site["patches"], site["exports"] / "1", corner, seq=1)
    assert result["changed"] is False and result["reason"] == "outside-ortho"
    assert result["diffPixels"] == 16
    assert not (site["patches"] / "1.png").exists()


def test_import_refusals(site: dict, capsys):
    export(site, 1)
    export_dir = site["exports"] / "1"
    good = edited_copy(site, 1, "good.png", paint_block(MAGENTA))

    def run(image: Path, *extra: str, seq: int = 1, export_dir: Path = export_dir) -> tuple[int, str]:
        capsys.readouterr()
        rc = main([
            "import-ortho-square", "--ortho", str(site["working"]), "--patches-dir", str(site["patches"]),
            "--export-dir", str(export_dir), "--image", str(image), "--seq", str(seq), *extra,
        ])
        captured = capsys.readouterr()
        assert rc == 0 or captured.out == ""  # a failure prints no JSON
        return rc, captured.err

    # Wrong size.
    small = site["tmp"] / "small.png"
    Image.open(good).resize((40, 40)).save(small)
    rc, err = run(small)
    assert rc == 1 and "must keep the export's size" in err

    # Saved as JPEG: refused with the default tolerance, accepted with one.
    jpeg = site["tmp"] / "edited.jpg"
    Image.open(good).save(jpeg, quality=95)
    rc, err = run(jpeg)
    assert rc == 1 and "pass --tolerance" in err
    rc, _ = run(jpeg, "--tolerance", "60")
    assert rc == 0 and (site["patches"] / "1.png").is_file()

    # Not an image at all.
    junk = site["tmp"] / "junk.png"
    junk.write_bytes(b"not a png")
    rc, err = run(junk)
    assert rc == 1 and "cannot read the edited image" in err

    # A seq the log already has.
    write_log(site["patches"], [{
        "seq": 1, "kind": "raster", "file": "1.png",
        "bounds3006": {"west": E0, "south": N0, "east": E0 + 5, "north": N0 + 5},
    }])
    rc, err = run(good)
    assert rc == 1 and "already in the patch log" in err

    # No such export; an export whose image was overwritten.
    rc, err = run(good, seq=2, export_dir=site["exports"] / "9")
    assert rc == 1 and "cannot read export" in err
    Image.open(good).save(export_dir / "ortho-sim-1.png")
    rc, err = run(good, seq=2)
    assert rc == 1 and "no longer matches its export.json" in err


def test_import_from_a_jpeg_export_needs_an_explicit_tolerance(site: dict):
    export(site, 1, fmt="jpg")
    export_dir = site["exports"] / "1"
    pixels = np.array(Image.open(export_dir / "ortho-sim-1.jpg"))
    pixels[30:42, 20:36] = MAGENTA
    edited = site["tmp"] / "edited.png"
    Image.fromarray(pixels).save(edited)

    with pytest.raises(patches.PatchError, match="pass --tolerance"):
        cmd_import_ortho_square(site["working"], site["patches"], export_dir, edited, seq=1)
    result = cmd_import_ortho_square(site["working"], site["patches"], export_dir, edited, seq=1, tolerance=2)
    assert result["changed"] is True and result["diffPixels"] > 0


# --- CLI ---------------------------------------------------------------------


def test_main_wires_export_and_import(ortho: Path, tmp_path: Path, capsys):
    patches_dir = tmp_path / "patches"
    write_log(patches_dir, [])
    frame_path = tmp_path / square_frame.FRAME_NAME
    export_dir = tmp_path / "exports" / "1"

    rc = main([
        "export-ortho-square",
        "--ortho", str(ortho),
        "--frame", str(frame_path),
        "--out-dir", str(export_dir),
        "--seq", "1", "--log-seq", "0",
        "--size", "128",
        "--bounds-wgs84", ",".join(str(v) for v in BBOX),
    ])
    assert rc == 0
    meta = json.loads(capsys.readouterr().out)
    assert meta["exportSeq"] == 1 and meta["size"] == 128 and meta["format"] == "png"
    assert square_frame.load_frame(frame_path).size == 128

    # The same export dir again, and a frame change: clean errors.
    assert main([
        "export-ortho-square", "--ortho", str(ortho), "--frame", str(frame_path),
        "--out-dir", str(export_dir), "--seq", "1", "--log-seq", "0",
    ]) == 1
    assert "exports are immutable" in capsys.readouterr().err
    assert main([
        "export-ortho-square", "--ortho", str(ortho), "--frame", str(frame_path),
        "--out-dir", str(tmp_path / "exports" / "2"), "--seq", "2", "--log-seq", "0", "--size", "256",
    ]) == 1
    assert "refusing to change the frame" in capsys.readouterr().err

    pixels = np.array(Image.open(export_dir / "ortho-sim-1.png"))
    pixels[10:20, 10:20] = CYAN
    edited = tmp_path / "edited.png"
    Image.fromarray(pixels).save(edited)
    rc = main([
        "import-ortho-square",
        "--ortho", str(ortho),
        "--patches-dir", str(patches_dir),
        "--export-dir", str(export_dir),
        "--image", str(edited),
        "--seq", "5",
        "--tolerance", "2", "--min-area-px", "4",
    ])
    assert rc == 0
    result = json.loads(capsys.readouterr().out)
    # The ortho is far from BBOX's square: nothing of the change is on it.
    assert result == {
        "changed": False, "reason": "outside-ortho", "seq": 5, "exportSeq": 1,
        "changedPixels": 0, "diffPixels": 100, "tolerance": 2, "minAreaPx": 4,
    }
