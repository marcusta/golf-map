"""golfpipe.inpaint tests — fully offline, no torch. Crop/stitch round-trips
with fake inpaint implementations (identity / constant fill / crop-dependent
fill for the feather seam), window enumeration, and the lazy-import +
missing-weights error paths.
"""

from __future__ import annotations

import sys

import numpy as np
import pytest

from golfpipe.inpaint import (
    BIG_LAMA_JIT_URL,
    InpaintDependencyError,
    InpaintWeightsError,
    LamaInpainter,
    _import_torch,
    feather_weights,
    inpaint_tiled,
    iter_crop_windows,
)


def _image(h: int, w: int, seed: int = 7) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, size=(h, w, 3), dtype=np.uint8)


def _identity(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    return image


def _fill(value: tuple[int, int, int]):
    def fn(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        out = image.copy()
        out[mask] = value
        return out

    return fn


# --- feather_weights / iter_crop_windows -------------------------------------


def test_feather_weights_positive_ramped():
    w = feather_weights(100, 80, overlap=16)
    assert w.shape == (100, 80)
    assert (w > 0).all()
    assert w[50, 40] == 1.0
    assert w[0, 0] == pytest.approx((1 / 17) ** 2)
    # Monotonic ramp over the overlap edge.
    assert (np.diff(w[:17, 40]) > 0).all()


def test_iter_crop_windows_cover_all_masked_pixels_and_skip_empty():
    mask = np.zeros((700, 900), dtype=bool)
    mask[100:140, 600:830] = True  # spans several 256px crops horizontally
    windows = iter_crop_windows(mask, crop_size=256, overlap=32)
    assert windows  # non-empty
    covered = np.zeros_like(mask)
    for r0, r1, c0, c1 in windows:
        assert mask[r0:r1, c0:c1].any()  # no empty crops processed
        assert (r1 - r0) == 256 and (c1 - c0) == 256  # full-size crops
        covered[r0:r1, c0:c1] = True
    assert covered[mask].all()
    # Work proportional to the masked area: far fewer than the full grid.
    full_grid = len(iter_crop_windows(np.ones_like(mask), crop_size=256, overlap=32))
    assert len(windows) < full_grid / 2


def test_iter_crop_windows_rejects_bad_overlap():
    with pytest.raises(ValueError, match="overlap"):
        iter_crop_windows(np.ones((10, 10), dtype=bool), crop_size=32, overlap=32)


# --- inpaint_tiled ------------------------------------------------------------


def test_identity_round_trip():
    image = _image(300, 500)
    mask = np.zeros((300, 500), dtype=bool)
    mask[50:120, 100:400] = True
    out = inpaint_tiled(image, mask, _identity, crop_size=128, overlap=16)
    assert np.array_equal(out, image)


def test_fill_only_changes_masked_pixels_across_crops():
    image = _image(700, 900)
    mask = np.zeros((700, 900), dtype=bool)
    mask[100:140, 50:830] = True   # spans multiple crops
    mask[600:660, 700:880] = True  # second disjoint blob
    out = inpaint_tiled(image, mask, _fill((255, 0, 255)), crop_size=256, overlap=32)
    assert np.all(out[mask] == (255, 0, 255))
    assert np.array_equal(out[~mask], image[~mask])


def test_feathered_stitch_blends_between_crops():
    """Two adjacent crops that disagree (fill value depends on crop origin)
    must blend smoothly in the overlap instead of hard-seaming."""
    image = _image(64, 300, seed=3)
    mask = np.zeros((64, 300), dtype=bool)
    mask[20:44, 10:290] = True

    calls: list[int] = []

    def crop_dependent_fill(crop: np.ndarray, crop_mask: np.ndarray) -> np.ndarray:
        value = 100 if not calls else 200
        calls.append(value)
        out = crop.copy()
        out[crop_mask] = value
        return out

    out = inpaint_tiled(image, mask, crop_dependent_fill, crop_size=176, overlap=48)
    assert len(calls) == 2
    left = out[32, 40]     # only in crop 1
    right = out[32, 260]   # only in crop 2
    middle = out[32, 150]  # inside the 48px overlap band
    assert np.all(left == 100)
    assert np.all(right == 200)
    assert 100 < middle[0] < 200  # feathered, not a hard seam


def test_empty_mask_never_calls_inpaint_fn():
    image = _image(100, 100)
    mask = np.zeros((100, 100), dtype=bool)

    def boom(*_args):
        raise AssertionError("inpaint_fn must not run for an empty mask")

    out = inpaint_tiled(image, mask, boom)
    assert np.array_equal(out, image)
    assert out is not image  # a copy, the input is never aliased


def test_image_smaller_than_crop_size():
    image = _image(40, 60)
    mask = np.zeros((40, 60), dtype=bool)
    mask[10:20, 10:50] = True
    out = inpaint_tiled(image, mask, _fill((1, 2, 3)), crop_size=512, overlap=64)
    assert np.all(out[mask] == (1, 2, 3))
    assert np.array_equal(out[~mask], image[~mask])


def test_shape_validation():
    with pytest.raises(ValueError, match="image must be"):
        inpaint_tiled(np.zeros((10, 10), dtype=np.uint8), np.zeros((10, 10), dtype=bool), _identity)
    with pytest.raises(ValueError, match="mask shape"):
        inpaint_tiled(np.zeros((10, 10, 3), dtype=np.uint8), np.zeros((5, 5), dtype=bool), _identity)


def test_progress_callback_reports_each_crop():
    image = _image(300, 300)
    mask = np.ones((300, 300), dtype=bool)
    seen: list[tuple[int, int]] = []
    inpaint_tiled(image, mask, _identity, crop_size=128, overlap=16,
                  progress=lambda done, total: seen.append((done, total)))
    assert seen
    assert seen[-1][0] == seen[-1][1] == len(seen)


# --- lazy import + weights errors ----------------------------------------------


def test_import_torch_error_names_the_extras_file(monkeypatch):
    # sys.modules['torch'] = None makes `import torch` raise ImportError even
    # if torch happens to be installed (e.g. after a live smoke run).
    monkeypatch.setitem(sys.modules, "torch", None)
    with pytest.raises(InpaintDependencyError, match="requirements-inpaint.txt"):
        _import_torch()


def test_lama_inpainter_requires_weights(monkeypatch):
    monkeypatch.delenv("GOLFPIPE_LAMA_WEIGHTS", raising=False)
    with pytest.raises(InpaintWeightsError) as excinfo:
        LamaInpainter()
    assert "GOLFPIPE_LAMA_WEIGHTS" in str(excinfo.value)
    assert BIG_LAMA_JIT_URL in str(excinfo.value)


def test_lama_inpainter_rejects_missing_weights_file(tmp_path, monkeypatch):
    monkeypatch.delenv("GOLFPIPE_LAMA_WEIGHTS", raising=False)
    with pytest.raises(InpaintWeightsError, match="not found"):
        LamaInpainter(weights=tmp_path / "nope.pt")


def test_lama_inpainter_env_var_resolves_weights(tmp_path, monkeypatch):
    weights = tmp_path / "big-lama.pt"
    weights.write_bytes(b"stub")
    monkeypatch.setenv("GOLFPIPE_LAMA_WEIGHTS", str(weights))
    inpainter = LamaInpainter()  # torch not touched until the first call
    assert inpainter.weights_path == weights
