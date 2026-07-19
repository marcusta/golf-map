"""Clone-stamp brush engine + stamp patch entries — fully offline, no torch.

Covers the pure brush math (dab spacing from flow, feathered falloff from
hardness, opacity cap, tone-match mean-shift with texture preservation,
source-validity masking), the log round trip for stamp entries, mixed
mask+stamp replay ordering, the torch-free stamp-only paths, and the batch
(multi --seq) incremental bake with its single union retile.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds

from golfpipe import patches, stamp
from golfpipe.__main__ import main
from golfpipe.commands import cmd_apply_ortho_patches, cmd_bake_ortho_patch

from test_patches import (  # noqa: F401  (ortho fixture re-used)
    E0, N0, SIZE, MAGENTA,
    entry, mask_png, ortho, solid_fill_fn, sub_box_3857, write_log,
)


def stamp_entry_dict(
    seq: int,
    path_3006: list[tuple[float, float]],
    size_m: float = 6.0,
    opacity: float = 1.0,
    flow: float = 1.0,
    hardness: float = 1.0,
    offset: tuple[float, float] = (20.0, 0.0),
    tone_match: bool = False,
    aligned: bool = True,
) -> dict:
    xs = [p[0] for p in path_3006]
    ys = [p[1] for p in path_3006]
    r = size_m / 2.0
    b = sub_box_3857(min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r)
    w, s, e, n = b
    return {
        "seq": seq,
        "kind": "stamp",
        "bounds3857": {"west": w, "south": s, "east": e, "north": n},
        "boundsSweref": {"west": min(xs) - r, "south": min(ys) - r,
                         "east": max(xs) + r, "north": max(ys) + r},
        "tool": "stamp",
        "createdAt": f"2026-07-19T11:00:0{seq}Z",
        "stamp": {
            "brush": {"sizeM": size_m, "opacity": opacity, "flow": flow, "hardness": hardness},
            "offsetM": {"dx": offset[0], "dy": offset[1]},
            "path": [[x, y] for x, y in path_3006],
            "aligned": aligned,
            "toneMatch": tone_match,
        },
    }


# --- brush math --------------------------------------------------------------


def test_dab_spacing_shrinks_with_flow_and_clamps():
    d = 40.0
    dense = stamp.dab_spacing_px(d, 1.0)
    sparse = stamp.dab_spacing_px(d, 0.3)
    assert dense == pytest.approx(d * stamp.DAB_SPACING_FRACTION)
    assert sparse > dense
    # Very low flow clamps to MAX_SPACING_DIAMETERS, tiny brushes to >= 1 px.
    assert stamp.dab_spacing_px(d, 0.01) == pytest.approx(d * stamp.MAX_SPACING_DIAMETERS)
    assert stamp.dab_spacing_px(1.0, 1.0) == 1.0


def test_dab_centers_walk_the_polyline():
    path = np.array([[0.0, 0.0], [10.0, 0.0]])
    centers = stamp.dab_centers(path, 2.5)
    assert centers[0] == pytest.approx([0.0, 0.0])
    xs = centers[:, 0]
    assert np.allclose(np.diff(xs), 2.5)
    assert xs[-1] == pytest.approx(10.0)
    # Single point -> single dab; endpoint within half a spacing is skipped.
    assert len(stamp.dab_centers(np.array([[3.0, 4.0]]), 5.0)) == 1
    short = stamp.dab_centers(np.array([[0.0, 0.0], [1.0, 0.0]]), 4.0)
    assert len(short) == 1


def test_dab_alpha_feather_follows_hardness():
    shape = (41, 41)
    hard = stamp.dab_alpha(15.0, 1.0, shape, 20.5, 20.5)
    assert set(np.unique(hard)) <= {0.0, 1.0}  # hardness 1 = binary disc
    soft = stamp.dab_alpha(15.0, 0.4, shape, 20.5, 20.5)
    # Center opaque, rim zero, in between strictly decreasing along a radius.
    assert soft[20, 20] == pytest.approx(1.0)
    assert soft[20, 40] == 0.0
    row = soft[20, 20:36]
    assert np.all(np.diff(row) <= 1e-12)
    # Lower hardness -> feather begins earlier (smaller fully-opaque core).
    softer = stamp.dab_alpha(15.0, 0.1, shape, 20.5, 20.5)
    assert softer[20, 28] < soft[20, 28]


def test_render_stamp_clones_with_offset_and_caps_opacity():
    rng = np.random.default_rng(3)
    dest = rng.integers(0, 255, size=(40, 60, 3), dtype=np.uint8)
    # Source window: dest content shifted so the clone pulls a known color.
    src = np.zeros_like(dest)
    src[:, :, 0] = 200  # pure-ish red source
    path = np.array([[30.0, 20.0]])
    out = stamp.render_stamp(dest, src, None, path, 8.0, 1.0, 1.0, 1.0, tone_match=False)
    assert tuple(out[20, 30]) == (200, 0, 0)  # full replace at the center
    far = dest.copy()
    far[10:31, 20:41] = out[10:31, 20:41]
    assert np.array_equal(far, out)  # nothing outside the dab radius changed

    half = stamp.render_stamp(dest, src, None, path, 8.0, 0.5, 1.0, 1.0, tone_match=False)
    expected = np.rint(dest[20, 30].astype(float) * 0.5 + np.array([200, 0, 0]) * 0.5)
    assert np.array_equal(half[20, 30], expected.astype(np.uint8))


def test_render_stamp_respects_source_validity():
    dest = np.full((30, 30, 3), 100, dtype=np.uint8)
    src = np.full_like(dest, 220)
    valid = np.zeros((30, 30), dtype=bool)
    valid[:, :15] = True  # right half of the window has no source
    path = np.array([[15.0, 15.0]])
    out = stamp.render_stamp(dest, src, valid, path, 10.0, 1.0, 1.0, 1.0, tone_match=False)
    assert np.all(out[:, 15:] == 100)  # untouched where source missing
    assert np.all(out[15, 6:14] == 220)  # painted where valid


def test_tone_match_shifts_mean_but_preserves_texture_variance():
    rng = np.random.default_rng(11)
    dest = np.clip(rng.normal(150.0, 5.0, size=(50, 50, 3)), 0, 255).astype(np.uint8)
    src = np.clip(rng.normal(90.0, 12.0, size=(50, 50, 3)), 0, 255).astype(np.uint8)
    path = np.array([[25.0, 25.0]])
    out = stamp.render_stamp(dest, src, None, path, 16.0, 1.0, 1.0, 1.0, tone_match=True)
    yy, xx = np.mgrid[0:50, 0:50]
    core = np.hypot(xx + 0.5 - 25.0, yy + 0.5 - 25.0) <= 16.0
    # Mean pulled onto the destination's local mean (pure per-channel shift)…
    assert abs(out[core].mean() - dest[core].mean()) < 1.0
    # …while the SOURCE texture's spread survives (matches src, not dest).
    assert out[core].std() == pytest.approx(src[core].astype(float).std(), abs=1.0)
    assert out[core].std() > dest[core].astype(float).std() * 1.5


def test_flow_builds_up_and_stays_below_opacity_cap():
    dest = np.zeros((30, 80, 3), dtype=np.uint8)
    src = np.full_like(dest, 200)
    path = np.array([[10.0, 15.0], [70.0, 15.0]])
    low = stamp.render_stamp(dest, src, None, path, 8.0, 1.0, 0.3, 1.0, tone_match=False)
    full = stamp.render_stamp(dest, src, None, path, 8.0, 1.0, 1.0, 1.0, tone_match=False)
    mid_low = float(low[15, 40, 0])
    assert 0 < mid_low < 200  # translucent build-up, not full replace
    assert float(full[15, 40, 0]) == 200.0
    capped = stamp.render_stamp(dest, src, None, path, 8.0, 0.4, 1.0, 1.0, tone_match=False)
    assert capped[15, 10:70, 0].max() <= np.ceil(200 * 0.4)


def test_render_stamp_is_deterministic():
    rng = np.random.default_rng(5)
    dest = rng.integers(0, 255, size=(40, 40, 3), dtype=np.uint8)
    src = rng.integers(0, 255, size=(40, 40, 3), dtype=np.uint8)
    path = np.array([[8.0, 8.0], [30.0, 32.0]])
    a = stamp.render_stamp(dest, src, None, path, 6.0, 0.8, 0.5, 0.6, tone_match=True)
    b = stamp.render_stamp(dest, src, None, path, 6.0, 0.8, 0.5, 0.6, tone_match=True)
    assert np.array_equal(a, b)


# --- log round trip ----------------------------------------------------------


def test_stamp_entries_round_trip_the_log(tmp_path: Path):
    d = stamp_entry_dict(3, [(E0 + 20, N0 + 30), (E0 + 26, N0 + 34)],
                         size_m=4.0, opacity=0.9, flow=0.5, hardness=0.7,
                         offset=(12.5, -3.25), tone_match=True, aligned=False)
    write_log(tmp_path, [d])
    loaded = patches.load_patch_log(tmp_path)
    assert len(loaded) == 1
    e = loaded[0]
    assert isinstance(e, patches.StampEntry)
    assert e.seq == 3
    assert e.size_m == 4.0 and e.opacity == 0.9 and e.flow == 0.5 and e.hardness == 0.7
    assert e.offset_m == (12.5, -3.25)
    assert e.path == ((E0 + 20, N0 + 30), (E0 + 26, N0 + 34))
    assert e.aligned is False and e.tone_match is True
    assert e.tool == "stamp"


def test_stamp_entry_validation_errors(tmp_path: Path):
    good = stamp_entry_dict(1, [(E0 + 10, N0 + 10)])

    bad = json.loads(json.dumps(good))
    del bad["stamp"]["brush"]["flow"]
    write_log(tmp_path, [bad])
    with pytest.raises(patches.PatchError, match="sizeM/opacity/flow/hardness"):
        patches.load_patch_log(tmp_path)

    bad = json.loads(json.dumps(good))
    bad["stamp"]["brush"]["opacity"] = 1.5
    write_log(tmp_path, [bad])
    with pytest.raises(patches.PatchError, match="opacity"):
        patches.load_patch_log(tmp_path)

    bad = json.loads(json.dumps(good))
    bad["stamp"]["path"] = []
    write_log(tmp_path, [bad])
    with pytest.raises(patches.PatchError, match="non-empty"):
        patches.load_patch_log(tmp_path)

    bad = json.loads(json.dumps(good))
    bad["kind"] = "sticker"
    write_log(tmp_path, [bad])
    with pytest.raises(patches.PatchError, match="unknown entry kind"):
        patches.load_patch_log(tmp_path)


# --- replay / bake integration ----------------------------------------------


def test_stamp_only_replay_needs_no_inpaint_fn(ortho: Path, tmp_path: Path):
    """A stamp-only log is fully bakeable torch-free (inpaint_fn=None)."""
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    # Clone the region 20 m east of the dab onto the dab (offset dx=+20).
    d = stamp_entry_dict(1, [(E0 + 30, N0 + 40)], size_m=8.0, offset=(20.0, 0.0))
    write_log(patches_dir, [d])

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(
        ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=None,
    )
    with rasterio.open(ortho) as src_ds, rasterio.open(out) as dst_ds:
        original = np.moveaxis(src_ds.read(), 0, -1)
        patched = np.moveaxis(dst_ds.read(), 0, -1)
    # Dab center (E0+30, N0+40) -> row 40, col 30; source 20 px east.
    assert np.array_equal(patched[40, 30], original[40, 50])
    assert not np.array_equal(patched[40, 30], original[40, 30]) or (
        np.array_equal(original[40, 30], original[40, 50]))
    # Outside the dab: byte-identical.
    far = np.ones((SIZE, SIZE), dtype=bool)
    far[33:48, 23:38] = False
    assert np.array_equal(patched[far], original[far])


def test_stamp_replay_is_byte_reproducible(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    d = stamp_entry_dict(1, [(E0 + 30, N0 + 40), (E0 + 40, N0 + 44)],
                         size_m=6.0, opacity=0.8, flow=0.4, hardness=0.5,
                         offset=(15.0, -10.0), tone_match=True)
    write_log(patches_dir, [d])
    a, b = tmp_path / "a.tif", tmp_path / "b.tif"
    for out in (a, b):
        patches.apply_patches_to_ortho(
            ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=None)
    with rasterio.open(a) as da, rasterio.open(b) as db:
        assert np.array_equal(da.read(), db.read())


def test_mixed_mask_and_stamp_log_replays_in_seq_order(ortho: Path, tmp_path: Path):
    """Mask (seq 1) then stamp (seq 2) over an overlapping area: the stamp
    must clone the MASK FILL (the evolving raster), proving in-order
    execution against the current patched state."""
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    mask_png(patches_dir / "1.png")
    mask_bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    # Stamp at (60, 20) cloning FROM the mask-fill area: offset (-35, +25)
    # points its source at (25, 45) — magenta after seq 1.
    d = stamp_entry_dict(2, [(E0 + 60, N0 + 20)], size_m=6.0, offset=(-35.0, 25.0))
    write_log(patches_dir, [entry(1, "1.png", mask_bounds), d])

    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(
        ortho, patches_dir, patches.load_patch_log(patches_dir), out,
        inpaint_fn=solid_fill_fn(MAGENTA),
    )
    with rasterio.open(out) as dst:
        patched = np.moveaxis(dst.read(), 0, -1)
    # Mask fill landed (center (25,45) -> row 35, col 25)…
    assert tuple(patched[35, 25]) == MAGENTA
    # …and the stamp cloned it onto (60, 20) -> row 60, col 60.
    assert tuple(patched[60, 60]) == MAGENTA


def test_stamp_source_beyond_raster_edge_paints_only_valid_pixels(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    # Dab near the east edge (center col 58, radius 4 -> cols 54..62), with
    # the source 20 m further east: source cols 74..82 spill past the 80 px
    # raster, so only the dab pixels with cols < 60 have a valid source.
    d = stamp_entry_dict(1, [(E0 + 58, N0 + 40)], size_m=8.0, offset=(20.0, 0.0))
    write_log(patches_dir, [d])
    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(
        ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=None)
    with rasterio.open(ortho) as s, rasterio.open(out) as t:
        original = np.moveaxis(s.read(), 0, -1)
        patched = np.moveaxis(t.read(), 0, -1)
    # Pixels whose source is off-raster (col >= 60 -> source >= 80): untouched.
    assert np.array_equal(patched[:, 60:], original[:, 60:])
    # The dab center (col 58) has a valid source (col 78): cloned exactly.
    assert np.array_equal(patched[40, 58], original[40, 78])
    # And the stroke genuinely painted something in the valid strip.
    assert not np.array_equal(patched[:, 54:60], original[:, 54:60])


def test_stamp_missing_the_raster_is_a_noop(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    d = stamp_entry_dict(1, [(E0 + 5000, N0 + 5000)], size_m=6.0)
    write_log(patches_dir, [d])
    out = tmp_path / "out.tif"
    patches.apply_patches_to_ortho(
        ortho, patches_dir, patches.load_patch_log(patches_dir), out, inpaint_fn=None)
    with rasterio.open(ortho) as s, rasterio.open(out) as t:
        assert np.array_equal(s.read(), t.read())


# --- batch incremental bake --------------------------------------------------


def test_batch_bake_multiple_seqs_in_one_call_with_union_retile(ortho: Path, tmp_path: Path):
    """A batch of edits (mask + two stamps) bakes in seq order in ONE
    invocation and retiles the UNION of their subtrees once."""
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    mask_bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 30, N0 + 50)
    mask_png(patches_dir / "1.png")
    s2 = stamp_entry_dict(2, [(E0 + 60, N0 + 20)], size_m=6.0, offset=(-35.0, 25.0))
    s3 = stamp_entry_dict(3, [(E0 + 10, N0 + 12)], size_m=4.0, offset=(30.0, 30.0))
    write_log(patches_dir, [entry(1, "1.png", mask_bounds), s2, s3])

    out = tmp_path / "patched.tif"
    # Seed the working raster so the incremental path (not full replay) runs.
    import shutil
    shutil.copyfile(ortho, out)

    tiles_out = tmp_path / "tiles" / "ortho"
    calls: list[int] = []

    def counting_fill(image, mask):
        calls.append(1)
        img = image.copy()
        img[mask] = MAGENTA
        return img

    cmd_bake_ortho_patch(
        ortho, patches_dir, seqs=[1, 2, 3], out=out, tiles_out=tiles_out,
        minzoom=14, maxzoom=17, inpaint_fn=counting_fill,
    )
    assert len(calls) == 1  # one windowed inpaint for the one mask
    with rasterio.open(out) as dst:
        patched = np.moveaxis(dst.read(), 0, -1)
    assert tuple(patched[35, 25]) == MAGENTA          # mask fill
    assert tuple(patched[60, 60]) == MAGENTA          # stamp 2 cloned the fill
    # Union retile: tiles of ALL three bounds, written once.
    entries = patches.load_patch_log(patches_dir)
    expected = patches.affected_tiles([e.bounds3857 for e in entries], 14, 17)
    written = sorted(
        (int(p.parts[-3]), int(p.parts[-2]), int(p.stem))
        for p in tiles_out.rglob("*.webp")
    )
    assert written == sorted((t.z, t.x, t.y) for t in expected)


def test_stamp_only_batch_never_constructs_lama(ortho: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The whole point of stamp entries being torch-free: baking them must
    not even attempt to build the LaMa runner (no weights needed)."""
    from golfpipe import commands as commands_mod

    def explode(weights, device):
        raise AssertionError("LaMa constructed for a stamp-only bake")

    monkeypatch.setattr(commands_mod, "_lama_inpaint_fn", explode)
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    s1 = stamp_entry_dict(1, [(E0 + 30, N0 + 40)], size_m=6.0, offset=(20.0, 0.0))
    write_log(patches_dir, [s1])

    out = tmp_path / "patched.tif"
    cmd_bake_ortho_patch(ortho, patches_dir, seqs=[1], out=out)  # full-replay (lazy create)
    assert out.exists()
    # And the full-replay command too.
    cmd_apply_ortho_patches(ortho, patches_dir, out=tmp_path / "replay.tif")
    assert (tmp_path / "replay.tif").exists()


def test_main_wires_repeatable_seq(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    s1 = stamp_entry_dict(1, [(E0 + 30, N0 + 40)], size_m=6.0, offset=(20.0, 0.0))
    s2 = stamp_entry_dict(2, [(E0 + 10, N0 + 12)], size_m=4.0, offset=(30.0, 30.0))
    write_log(patches_dir, [s1, s2])
    tiles_out = tmp_path / "tiles"

    rc = main([
        "bake-ortho-patch",
        "--ortho", str(ortho),
        "--patches-dir", str(patches_dir),
        "--seq", "1", "--seq", "2",
        "--out", str(tmp_path / "p.tif"),
        "--tiles-out", str(tiles_out),
        "--minzoom", "16", "--maxzoom", "17",
    ])
    assert rc == 0
    entries = patches.load_patch_log(patches_dir)
    expected = patches.affected_tiles([e.bounds3857 for e in entries], 16, 17)
    assert len(list(tiles_out.rglob("*.webp"))) == len(expected)


def test_sim_overlay_retile_reads_missing_children_from_pristine(ortho: Path, tmp_path: Path):
    """Dual photo state: --tiles-out is the sparse ortho-sim overlay, and a
    derived parent whose children are only PARTLY in the overlay must read
    the rest from the read-only pristine tree — never composite black."""
    from PIL import Image
    from golfpipe.commands import cmd_tile_ortho

    # Build the full pristine tree once (small zoom range keeps it tiny).
    pristine = tmp_path / "tiles" / "ortho"
    cmd_tile_ortho(ortho, pristine, minzoom=16, maxzoom=18)

    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    s1 = stamp_entry_dict(1, [(E0 + 30, N0 + 40)], size_m=6.0, offset=(20.0, 0.0))
    write_log(patches_dir, [s1])

    sim = tmp_path / "tiles" / "ortho-sim"
    cmd_bake_ortho_patch(
        ortho, patches_dir, seqs=[1], out=tmp_path / "patched.tif",
        tiles_out=sim, minzoom=16, maxzoom=18,
        pristine_tiles=pristine,
    )
    entries = patches.load_patch_log(patches_dir)
    expected = patches.affected_tiles([entries[0].bounds3857], 16, 18)
    # The overlay holds exactly the affected subtree — nothing more.
    written = {(int(p.parts[-3]), int(p.parts[-2]), int(p.stem)) for p in sim.rglob("*.webp")}
    assert written == {(t.z, t.x, t.y) for t in expected}

    # The z16 sim parent must match its pristine counterpart closely: the
    # stroke is tiny at z16, and the OTHER three children came from the
    # pristine tree via the fallback (without it they'd composite black).
    parent = next(t for t in expected if t.z == 16)
    sim_img = np.asarray(Image.open(sim / "16" / str(parent.x) / f"{parent.y}.webp").convert("RGB"), dtype=np.int16)
    pristine_img = np.asarray(
        Image.open(pristine / "16" / str(parent.x) / f"{parent.y}.webp").convert("RGB"), dtype=np.int16)
    diff = np.abs(sim_img - pristine_img).mean()
    assert diff < 3.0  # tiny stroke + WebP re-encode noise only — no black quadrants


def test_bake_unknown_seq_in_batch_errors(ortho: Path, tmp_path: Path):
    patches_dir = tmp_path / "patches"
    patches_dir.mkdir()
    s1 = stamp_entry_dict(1, [(E0 + 30, N0 + 40)])
    write_log(patches_dir, [s1])
    with pytest.raises(patches.PatchError, match="no logged patch with seq 7"):
        cmd_bake_ortho_patch(ortho, patches_dir, seqs=[1, 7])
