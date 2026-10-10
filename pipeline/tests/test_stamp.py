"""Clone-stamp brush engine + stamp edit entries — fully offline, no torch.

Covers the pure brush math (dab spacing from flow, feathered falloff from
hardness, opacity cap, tone-match mean-shift with texture preservation,
source-validity masking) and reading stamp entries from `patches.json`.
Strokes baked into the cleaned photo are in test_cleaned.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from golfpipe import patches, stamp

from test_patches import E0, N0, sub_box_3857, write_log


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


# --- reading stamp entries ----------------------------------------------------------


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
