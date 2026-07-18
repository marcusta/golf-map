"""Reusable image inpainting: overlapping-crop tiling + a LaMa runner.

Two independent layers, deliberately CLI-free (T55's interactive editor
cleaning will consume this module directly — keep it that way):

1. `inpaint_tiled(image, mask, inpaint_fn, ...)` — pure orchestration.
   Splits arbitrarily large images into overlapping crops, runs any
   `InpaintFn` on each crop that contains masked pixels, and feather-stitches
   the results back (linear ramp over the overlap, normalized weighted
   average). Pixels OUTSIDE the mask always come back byte-identical to the
   input, so stitching seams can only ever land inside the inpainted area.
   Memory for the model is bounded by the crop size, not the image size.

2. `LamaInpainter` — an `InpaintFn` backed by the TorchScript export of
   big-lama (Suvorov et al., WACV 2022, "Resolution-robust Large Mask
   Inpainting with Fourier Convolutions"). torch is a heavy dependency that
   must NOT bloat the base pipeline env, so it lives in
   pipeline/requirements-inpaint.txt and is imported lazily on first use
   with a crisp install hint. Weights are likewise not committed: pass
   `weights=` or set $GOLFPIPE_LAMA_WEIGHTS to a local big-lama TorchScript
   checkpoint (see BIG_LAMA_JIT_URL / pipeline/README.md).

Array conventions (shared with every InpaintFn):
    image: (H, W, 3) uint8 RGB
    mask:  (H, W) bool — True = pixel to inpaint
    return: (H, W, 3) uint8, same shape as the input crop
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

__all__ = [
    "InpaintError", "InpaintDependencyError", "InpaintWeightsError",
    "InpaintFn", "WEIGHTS_ENV_VAR", "BIG_LAMA_JIT_URL",
    "DEFAULT_CROP_SIZE", "DEFAULT_OVERLAP",
    "feather_weights", "iter_crop_windows", "inpaint_tiled", "LamaInpainter",
    "resolve_device", "torch_device",
]


class InpaintError(RuntimeError):
    """Base for user-actionable inpainting setup/runtime errors."""


class InpaintDependencyError(InpaintError):
    """torch (the optional inpainting extra) is not installed."""


class InpaintWeightsError(InpaintError):
    """No LaMa weights file was provided / found."""


class InpaintFn(Protocol):
    def __call__(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray: ...


WEIGHTS_ENV_VAR = "GOLFPIPE_LAMA_WEIGHTS"
# TorchScript export of the official big-lama checkpoint (the same artifact
# lama-cleaner/IOPaint use) — loadable with torch.jit.load, no LaMa repo code
# needed. ~196 MB; download once, point $GOLFPIPE_LAMA_WEIGHTS at it.
BIG_LAMA_JIT_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"

DEFAULT_CROP_SIZE = 512
DEFAULT_OVERLAP = 64
# LaMa's FFC blocks need dimensions divisible by 8.
_PAD_MODULO = 8


def _import_torch():
    """Lazy torch import with an install hint — torch is deliberately NOT in
    the base pipeline requirements (see requirements-inpaint.txt)."""
    try:
        import torch  # noqa: PLC0415
    except ImportError as exc:
        raise InpaintDependencyError(
            "inpainting needs torch, which is deliberately not part of the base "
            "pipeline env. Install the optional inpainting extras into the venv:\n"
            "  cd pipeline && ./.venv/bin/pip install -r requirements-inpaint.txt"
        ) from exc
    return torch


def resolve_device(
    requested: str | None,
    *,
    mps_available: bool,
    cuda_available: bool,
) -> str:
    """Pure device-resolution policy shared by the LaMa runner and the
    editor-assist sidecar (kept torch-free so it is trivially testable):

        explicit override  ->  the requested string, verbatim
        else mps if available  ->  "mps"  (Apple-silicon GPU)
        else cuda if available ->  "cuda"
        else                   ->  "cpu"

    `mps_available` / `cuda_available` are injected so callers can pass
    torch's real probes (see `torch_device`) while tests exercise every
    branch without importing torch at all.
    """
    if requested:
        return requested
    if mps_available:
        return "mps"
    if cuda_available:
        return "cuda"
    return "cpu"


def torch_device(requested: str | None = None) -> str:
    """`resolve_device` wired to torch's live availability probes. Imports
    torch lazily (with the usual install hint on failure); `torch.backends.mps`
    is absent on older torch builds, hence the getattr guard."""
    torch = _import_torch()
    mps_backend = getattr(torch.backends, "mps", None)
    mps_available = bool(mps_backend is not None and mps_backend.is_available())
    return resolve_device(
        requested,
        mps_available=mps_available,
        cuda_available=bool(torch.cuda.is_available()),
    )


def feather_weights(height: int, width: int, overlap: int) -> np.ndarray:
    """(H, W) float32 stitch weights for one crop: linear ramp from
    1/(overlap+1) at each edge up to 1.0 in the interior. Strictly positive
    everywhere, so a pixel covered by a single crop normalizes to exactly its
    own value — no special-casing of image/mask-region borders needed.
    """

    def ramp(n: int) -> np.ndarray:
        i = np.arange(n, dtype=np.float32)
        return np.minimum(np.minimum(i + 1, n - i), overlap + 1) / (overlap + 1)

    return np.outer(ramp(height), ramp(width)).astype(np.float32)


def iter_crop_windows(
    mask: np.ndarray,
    crop_size: int = DEFAULT_CROP_SIZE,
    overlap: int = DEFAULT_OVERLAP,
) -> list[tuple[int, int, int, int]]:
    """Grid of (r0, r1, c0, c1) crop windows covering every True pixel of
    `mask`, stepping crop_size - overlap; windows whose mask slice is empty
    are skipped (so work is proportional to the masked area, not the image).
    The trailing window in each axis is clamped so crops keep their full size
    against the image edge (unless the whole axis is smaller than crop_size).
    """
    if overlap >= crop_size:
        raise ValueError(f"overlap ({overlap}) must be smaller than crop_size ({crop_size})")
    h, w = mask.shape
    step = crop_size - overlap

    def starts(extent: int) -> list[int]:
        if extent <= crop_size:
            return [0]
        out = list(range(0, extent - crop_size, step))
        out.append(extent - crop_size)
        return out

    windows: list[tuple[int, int, int, int]] = []
    for r0 in starts(h):
        r1 = min(r0 + crop_size, h)
        for c0 in starts(w):
            c1 = min(c0 + crop_size, w)
            if mask[r0:r1, c0:c1].any():
                windows.append((r0, r1, c0, c1))
    return windows


def inpaint_tiled(
    image: np.ndarray,
    mask: np.ndarray,
    inpaint_fn: InpaintFn,
    crop_size: int = DEFAULT_CROP_SIZE,
    overlap: int = DEFAULT_OVERLAP,
    progress: Callable[[int, int], None] | None = None,
) -> np.ndarray:
    """Runs `inpaint_fn` over overlapping crops of `image` that contain
    masked pixels and feather-stitches the results. Returns a new (H, W, 3)
    uint8 array; pixels where mask is False are byte-identical to the input.

    `progress(done, total)` is called after each crop when provided.
    """
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(f"image must be (H, W, 3), got {image.shape}")
    if mask.shape != image.shape[:2]:
        raise ValueError(f"mask shape {mask.shape} does not match image {image.shape[:2]}")

    out = image.copy()
    if not mask.any():
        return out

    windows = iter_crop_windows(mask, crop_size=crop_size, overlap=overlap)
    acc = np.zeros(image.shape, dtype=np.float32)
    wsum = np.zeros(mask.shape, dtype=np.float32)

    for i, (r0, r1, c0, c1) in enumerate(windows):
        crop = image[r0:r1, c0:c1]
        crop_mask = mask[r0:r1, c0:c1]
        result = np.asarray(inpaint_fn(crop, crop_mask))
        if result.shape != crop.shape:
            raise ValueError(
                f"inpaint_fn returned shape {result.shape} for a {crop.shape} crop"
            )
        w = feather_weights(r1 - r0, c1 - c0, overlap)
        acc[r0:r1, c0:c1] += result.astype(np.float32) * w[..., None]
        wsum[r0:r1, c0:c1] += w
        if progress is not None:
            progress(i + 1, len(windows))

    # Every masked pixel lies in at least one processed window, so wsum > 0
    # exactly where we need it; clip the divisor to keep the untouched
    # remainder NaN-free (those pixels are overwritten by `out`'s copy anyway).
    blended = acc / np.maximum(wsum, 1e-6)[..., None]
    out[mask] = np.clip(np.rint(blended[mask]), 0, 255).astype(np.uint8)
    return out


class LamaInpainter:
    """InpaintFn running the TorchScript big-lama checkpoint.

    Construction validates the weights path (cheap, torch-free — so missing
    weights fail fast with a download hint before any heavy import); torch is
    imported and the model loaded lazily on the first call.

    device: None → auto (`resolve_device`): mps if available, else cuda, else
    cpu. Pass an explicit string to force one. On Apple silicon LaMa's Fourier
    convolutions lean on torch's MPS FFT support (torch >= 2.1); if any op is
    unsupported at runtime the call is caught and re-run on CPU (a one-line
    warning, no mid-batch crash — set PYTORCH_ENABLE_MPS_FALLBACK=1 for torch's
    softer per-op fallback instead).
    """

    def __init__(self, weights: str | Path | None = None, device: str | None = None):
        resolved = weights or os.environ.get(WEIGHTS_ENV_VAR)
        if not resolved:
            raise InpaintWeightsError(
                "no LaMa weights configured: pass --weights or set "
                f"${WEIGHTS_ENV_VAR} to a local big-lama TorchScript checkpoint. "
                f"Download it once from {BIG_LAMA_JIT_URL} (see pipeline/README.md)."
            )
        self.weights_path = Path(resolved)
        if not self.weights_path.is_file():
            raise InpaintWeightsError(
                f"LaMa weights not found at {self.weights_path} — download the "
                f"big-lama TorchScript checkpoint from {BIG_LAMA_JIT_URL} "
                f"(see pipeline/README.md), then pass --weights or set ${WEIGHTS_ENV_VAR}."
            )
        self._requested_device = device
        self._model = None
        self._torch = None
        self._device = None

    def _load(self) -> None:
        torch = _import_torch()
        device = torch_device(self._requested_device)
        model = torch.jit.load(str(self.weights_path), map_location="cpu")
        model.eval()
        model.to(device)
        self._torch, self._model, self._device = torch, model, device

    def __call__(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        if self._model is None:
            self._load()
        torch = self._torch

        h, w = mask.shape
        pad_h = (-h) % _PAD_MODULO
        pad_w = (-w) % _PAD_MODULO
        img = np.pad(image, ((0, pad_h), (0, pad_w), (0, 0)), mode="reflect")
        msk = np.pad(mask, ((0, pad_h), (0, pad_w)), mode="constant")

        img_t = torch.from_numpy(img.astype(np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
        msk_t = torch.from_numpy(msk.astype(np.float32)).unsqueeze(0).unsqueeze(0)
        with torch.inference_mode():
            out_t = self._run(img_t, msk_t)
        out = out_t[0].permute(1, 2, 0).detach().cpu().numpy()
        return np.clip(out * 255.0, 0, 255).astype(np.uint8)[:h, :w]

    def _run(self, img_t, msk_t):
        """Run the jitted model on the current device. On a GPU device (mps in
        particular) an op may be unsupported at runtime; catch it once, drop the
        model to CPU for the rest of this run, and retry — so a long batch never
        dies on one bad crop."""
        try:
            return self._model(img_t.to(self._device), msk_t.to(self._device))
        except (RuntimeError, NotImplementedError) as exc:
            if self._device == "cpu":
                raise
            print(
                f"warning: LaMa hit an unsupported op on '{self._device}' "
                f"({str(exc).splitlines()[0]}); falling back to CPU for the rest "
                f"of this run (set PYTORCH_ENABLE_MPS_FALLBACK=1 for torch's "
                f"softer per-op fallback).",
                file=sys.stderr,
            )
            self._model.to("cpu")
            self._device = "cpu"
            return self._model(img_t.to("cpu"), msk_t.to("cpu"))
