"""Clone-stamp brush engine for the ortho patch log (clean-photo tool).

A stamp patch entry stores a STROKE, not pixels: brush parameters, a
source→dest offset, and the dest polyline. This module renders such a stroke
onto an RGB window with pure, deterministic numpy — no torch, no model — so
stamp entries are byte-reproducible on replay (unlike mask entries, whose
LaMa fills are only visually equivalent across replays).

Brush-engine semantics (mirrored by web/src/clean/clean-stamp.ts for the
live client-side preview):

  * size      brush DIAMETER in ground metres (converted to px by callers).
  * hardness  fraction of the radius that is fully opaque; from there alpha
              feathers to 0 at the rim with a raised-cosine falloff.
  * flow      per-dab alpha. Dabs composite over each other along the path
              (a_new = a + dab·(1−a)), so low flow builds up gradually where
              the path self-overlaps. Flow also sets DAB SPACING: dabs land
              every `DAB_SPACING_FRACTION · diameter / flow` px along the
              path (clamped) — high flow → dense dabs → a solid ribbon; low
              flow → sparse translucent dabs.
  * opacity   a CAP on the whole stroke: the accumulated dab alpha is scaled
              by opacity at composite time, so no pixel of one stroke ever
              exceeds it (classic opacity-vs-flow distinction).
  * tone-match (per stroke, default on): before compositing, the clone
              source's local mean RGB (over the stroke's painted region) is
              shifted to the destination region's local mean — a pure
              per-channel offset, so the source TEXTURE (variance) is
              preserved while its tone blends into the surroundings.

The stroke reads its source pixels from a snapshot of the raster taken
BEFORE the stroke composites (never mid-stroke feedback), which keeps the
render order-independent within one stroke and deterministic on replay.
"""

from __future__ import annotations

import math

import numpy as np

# Dab spacing at flow=1, as a fraction of the brush diameter.
DAB_SPACING_FRACTION = 0.25
# Flow below this is treated as this (spacing and per-dab alpha stay sane).
MIN_FLOW = 0.05
# Spacing never exceeds this many diameters (very low flow stays a stroke,
# not disconnected freckles kilometres apart).
MAX_SPACING_DIAMETERS = 2.0


def dab_spacing_px(diameter_px: float, flow: float) -> float:
    """Distance between successive dab centers along the path, in px.

    Higher flow → denser dabs. Clamped to [1 px, MAX_SPACING_DIAMETERS·d].
    """
    f = max(float(flow), MIN_FLOW)
    spacing = diameter_px * DAB_SPACING_FRACTION / f
    return float(min(max(spacing, 1.0), diameter_px * MAX_SPACING_DIAMETERS))


def dab_centers(path_px: np.ndarray, spacing_px: float) -> np.ndarray:
    """Dab centers spaced `spacing_px` along a polyline of (x, y) px points.

    The first path point always gets a dab; the last point gets one too when
    it sits more than half a spacing beyond the last emitted dab (so short
    final segments still reach the stroke's visible end). A single-point
    path is a single dab.
    """
    pts = np.asarray(path_px, dtype=np.float64).reshape(-1, 2)
    if len(pts) == 0:
        return pts
    centers = [pts[0]]
    carried = 0.0  # distance walked since the last emitted dab
    for a, b in zip(pts[:-1], pts[1:]):
        seg = b - a
        seg_len = float(math.hypot(seg[0], seg[1]))
        if seg_len == 0.0:
            continue
        t = spacing_px - carried
        while t <= seg_len:
            centers.append(a + seg * (t / seg_len))
            t += spacing_px
        carried = seg_len - (t - spacing_px)
    last = pts[-1]
    if float(math.hypot(*(last - centers[-1]))) > spacing_px * 0.5:
        centers.append(last)
    return np.array(centers)


def dab_alpha(radius_px: float, hardness: float, shape: tuple[int, int],
              cx: float, cy: float) -> np.ndarray:
    """Alpha profile of one feathered circular dab on a (rows, cols) grid.

    1 inside `hardness·radius`, raised-cosine falloff to 0 at the rim.
    hardness=1 is a hard-edged disc. Sampled at pixel centers.
    """
    h = min(max(float(hardness), 0.0), 1.0)
    rows, cols = shape
    yy, xx = np.mgrid[0:rows, 0:cols]
    d = np.hypot(xx + 0.5 - cx, yy + 0.5 - cy)
    if h >= 1.0 or radius_px <= 0:
        return (d <= radius_px).astype(np.float64)
    core = h * radius_px
    ring = max(radius_px - core, 1e-9)
    t = np.clip((d - core) / ring, 0.0, 1.0)
    alpha = 0.5 * (1.0 + np.cos(np.pi * t))
    alpha[d > radius_px] = 0.0
    return alpha


def stroke_alpha(
    shape: tuple[int, int],
    path_px: np.ndarray,
    radius_px: float,
    flow: float,
    hardness: float,
) -> np.ndarray:
    """Accumulated alpha of a whole stroke over a (rows, cols) window.

    Dabs are placed along the path at flow-derived spacing and composited
    over each other (a += dab·(1−a)); the result is in [0, 1) and must still
    be scaled by `opacity` before use.
    """
    rows, cols = shape
    acc = np.zeros((rows, cols), dtype=np.float64)
    f = max(float(flow), MIN_FLOW)
    spacing = dab_spacing_px(radius_px * 2.0, flow)
    r_int = int(math.ceil(radius_px)) + 1
    for cx, cy in dab_centers(path_px, spacing):
        c0 = max(0, int(math.floor(cx)) - r_int)
        c1 = min(cols, int(math.ceil(cx)) + r_int + 1)
        r0 = max(0, int(math.floor(cy)) - r_int)
        r1 = min(rows, int(math.ceil(cy)) + r_int + 1)
        if r1 <= r0 or c1 <= c0:
            continue
        dab = f * dab_alpha(radius_px, hardness, (r1 - r0, c1 - c0), cx - c0, cy - r0)
        acc[r0:r1, c0:c1] += dab * (1.0 - acc[r0:r1, c0:c1])
    return acc


def render_stamp(
    dest: np.ndarray,
    src: np.ndarray,
    src_valid: np.ndarray | None,
    path_px: np.ndarray,
    radius_px: float,
    opacity: float,
    flow: float,
    hardness: float,
    tone_match: bool,
) -> np.ndarray:
    """Composites one clone-stamp stroke onto `dest` and returns the result.

    `dest` and `src` are (H, W, 3) uint8 windows on the SAME pixel grid —
    `src` is the raster content already shifted by the clone offset (a
    snapshot taken before this stroke). `src_valid`, when given, marks the
    pixels whose shifted source actually exists on the raster; the stroke
    paints nothing where the source is missing (window/raster edges).

    Tone-match shifts the source's mean RGB (over the painted region) to the
    destination region's mean before compositing — texture preserved, tone
    blended. Pure float64 math, np.rint rounding: byte-reproducible.
    """
    alpha = stroke_alpha(dest.shape[:2], path_px, radius_px, flow, hardness)
    if src_valid is not None:
        alpha = np.where(src_valid, alpha, 0.0)
    alpha *= min(max(float(opacity), 0.0), 1.0)
    region = alpha > 0.0
    if not region.any():
        return dest.copy()

    src_f = src.astype(np.float64)
    if tone_match:
        delta = (dest[region].astype(np.float64).mean(axis=0)
                 - src_f[region].mean(axis=0))
        src_f = np.clip(src_f + delta, 0.0, 255.0)

    a = alpha[..., None]
    out = dest.astype(np.float64) * (1.0 - a) + src_f * a
    return np.rint(out).astype(np.uint8)
