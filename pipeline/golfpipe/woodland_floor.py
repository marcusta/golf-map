"""Forest-floor repaint for clean-ortho --woodland (docs/feature-vegetation-zones.md D-VZ10).

clean-ortho's LaMa pass only touches the playable corridor: crowns outside
it stay as flown. In a game engine they are wrong there too, because Unity
plants its own trees on top and the photographed crowns then read as a
green smear under the models. Inpainting whole forests is not an option
(LaMa turns large masks into mush), so each woodland stand
(woodland-features output) is repainted as forest floor instead:

    floor = colour + stdev * (luma_noise + HUE * hue_noise)
    out   = photo * (1 - alpha) + floor * alpha

- colour / stdev: the palette colour (--floor-color, default
  DEFAULT_FLOOR_RGB, a moss and needle-litter brown-green) mixed with the
  stand's own `floorColor` / `floorStdev` at `mix` (0 = palette only, 1 =
  the photo's colour only, default DEFAULT_FLOOR_MIX). The photo only shows
  the floor on tracks and in clearings, so its colour is a hint about the
  stand, not the colour of the moss under the spruce.
- noise: fractal value noise on a world-metre lattice (FLOOR_OCTAVES), so
  the texture is deterministic from --seed, seamless between processing
  blocks and between two runs over overlapping orthos. The hue term pushes
  a patch towards moss green or litter brown, not just lighter or darker.
- alpha: 0 on the stand outline, rising to 1 over feather_m inside it, and
  0 again within CORRIDOR_FEATHER_M of the keep geometry: the playable
  corridor (it belongs to the LaMa pass and the photo) plus clean-ortho's
  --keep files, typically fetch-roads output, so a forest track under a
  closed canopy stays a track. Buildings are not kept: Unity places a
  prefab on the pad, and the roof in the photo would only show under it.

The image is processed in row blocks padded by the feather, so memory is a
few blocks wide regardless of the ortho size.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio.features
import rasterio.windows
from scipy.ndimage import distance_transform_edt
from shapely.geometry.base import BaseGeometry

from golfpipe.clean_ortho import CleanOrthoError, load_polygon_features

__all__ = [
    "DEFAULT_FLOOR_RGB", "DEFAULT_FLOOR_STDEV", "DEFAULT_FEATHER_M", "CORRIDOR_FEATHER_M", "FLOOR_OCTAVES",
    "FloorStand", "parse_hex_color", "load_woodland_stands", "stand_from_properties", "value_noise", "floor_noise", "paint_woodland_floor",
]

DEFAULT_FLOOR_RGB = (80, 88, 52)
DEFAULT_FLOOR_MIX = 0.5
DEFAULT_FLOOR_STDEV = 12.0
DEFAULT_FEATHER_M = 3.0
CORRIDOR_FEATHER_M = 1.0
# (lattice cell in metres, weight): clumps of moss and litter down to single
# tufts, weighted to the fine end so the floor reads as ground, not camouflage.
FLOOR_OCTAVES = ((8.0, 0.2), (3.0, 0.3), (1.0, 0.35), (0.35, 0.35))
HUE_CELL_M = 12.0
# Per-channel direction of the hue term, applied at HUE_GAIN: + is towards
# litter brown, - towards moss green (litter (110, 85, 60) minus moss
# (75, 90, 50), normalised).
HUE = np.array([0.95, -0.14, 0.27])
HUE_GAIN = 0.4
# Measured standard deviation of the unnormalised sums (value_noise over a
# 400x400 m window), so luma and hue noise come out with unit spread.
LUMA_SPREAD = 0.26
HUE_SPREAD = 0.43


@dataclass
class FloorStand:
    geometry: BaseGeometry  # EPSG:3006
    rgb: tuple[float, float, float]
    stdev: float
    sampled: bool = False  # colour from the stand's own floorColor, not the fallback


def parse_hex_color(value: str) -> tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise CleanOrthoError(f"colour must be #rrggbb (got {value!r})")
    try:
        return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)
    except ValueError as exc:
        raise CleanOrthoError(f"colour must be #rrggbb (got {value!r})") from exc


def load_woodland_stands(
    path: Path,
    fallback_rgb: tuple[int, int, int] = DEFAULT_FLOOR_RGB,
    fallback_stdev: float = DEFAULT_FLOOR_STDEV,
    mix: float = DEFAULT_FLOOR_MIX,
) -> list[FloorStand]:
    """Woodland stands from a GeoJSON file (woodland-features output, or the
    app's features export): `vegetation_zone` features whose zoneType is
    woodland_floor, plus features with no `type` at all (hand-made masks).
    A stand's floorColor / floorStdev are mixed into the fallback at `mix`."""
    if not 0.0 <= mix <= 1.0:
        raise CleanOrthoError(f"floor mix must be 0..1 (got {mix})")
    stands: list[FloorStand] = []
    for props, geom in load_polygon_features(path):
        feature_type = props.get("type")
        if feature_type is not None and not (
            feature_type == "vegetation_zone" and props.get("zoneType") == "woodland_floor"
        ):
            continue
        stands.append(stand_from_properties(geom, props, fallback_rgb, fallback_stdev, mix))
    return stands


def stand_from_properties(
    geom: BaseGeometry,
    props: dict,
    fallback_rgb: tuple[int, int, int] = DEFAULT_FLOOR_RGB,
    fallback_stdev: float = DEFAULT_FLOOR_STDEV,
    mix: float = DEFAULT_FLOOR_MIX,
) -> FloorStand:
    """One stand from a zone's properties (or the app's attributes): its
    floorColor / floorStdev mixed into the fallback at `mix`."""
    if not 0.0 <= mix <= 1.0:
        raise CleanOrthoError(f"floor mix must be 0..1 (got {mix})")
    color = props.get("floorColor")
    sampled = isinstance(color, str)
    own = parse_hex_color(color) if sampled else fallback_rgb
    rgb = tuple(float(f + (o - f) * mix) if sampled else float(f) for f, o in zip(fallback_rgb, own))
    stdev = props.get("floorStdev")
    own_stdev = float(stdev) if isinstance(stdev, (int, float)) and stdev > 0 else fallback_stdev
    return FloorStand(geom, rgb, fallback_stdev + (own_stdev - fallback_stdev) * mix, sampled=sampled)


def _lattice(ix: np.ndarray, iy: np.ndarray, seed: int) -> np.ndarray:
    """Hash of integer lattice coordinates -> uniform values in [-1, 1)."""
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return h.astype(np.float64) / 2147483648.0 - 1.0


def value_noise(xs: np.ndarray, ys: np.ndarray, cell_m: float, seed: int) -> np.ndarray:
    """Smoothstep-interpolated value noise on a cell_m lattice in world
    metres: xs (W,) eastings of the columns, ys (H,) northings of the rows
    -> (H, W)."""
    gx, gy = np.asarray(xs, dtype=np.float64) / cell_m, np.asarray(ys, dtype=np.float64) / cell_m
    x0, y0 = np.floor(gx).astype(np.int64), np.floor(gy).astype(np.int64)
    fx, fy = gx - x0, gy - y0
    ux, uy = fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy)
    lx = np.arange(x0.min(), x0.max() + 2)
    ly = np.arange(y0.min(), y0.max() + 2)
    grid = _lattice(lx[None, :], ly[:, None], seed)
    ix, iy = x0 - lx[0], y0 - ly[0]
    rows0, rows1 = grid[iy], grid[iy + 1]
    top = rows0[:, ix] + (rows0[:, ix + 1] - rows0[:, ix]) * ux[None, :]
    bottom = rows1[:, ix] + (rows1[:, ix + 1] - rows1[:, ix]) * ux[None, :]
    return top + (bottom - top) * uy[:, None]


def floor_noise(xs: np.ndarray, ys: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """(luma, hue) noise fields with roughly unit standard deviation."""
    luma = sum(w * value_noise(xs, ys, cell, seed + i) for i, (cell, w) in enumerate(FLOOR_OCTAVES))
    hue = value_noise(xs, ys, HUE_CELL_M, seed + 101)
    return luma / LUMA_SPREAD, hue / HUE_SPREAD


def paint_woodland_floor(
    image: np.ndarray,
    transform: "rasterio.Affine",
    stands: list[FloorStand],
    keep: BaseGeometry | None = None,
    feather_m: float = DEFAULT_FEATHER_M,
    seed: int = 0,
    block_rows: int = 1024,
) -> tuple[np.ndarray, int]:
    """Repaints the stands in `image` ((H, W, 3) uint8 on the north-up
    EPSG:3006 `transform`) as forest floor, see the module docstring.
    Returns (new image, pixels with alpha > 0)."""
    out = np.array(image, copy=True)
    if not stands:
        return out, 0
    height, width = out.shape[:2]
    px = float(abs(transform.a))
    pad = int(math.ceil(max(feather_m, CORRIDOR_FEATHER_M) / px)) + 1
    colours = np.array([(0.0, 0.0, 0.0)] + [s.rgb for s in stands], dtype=np.float64)
    stdevs = np.array([0.0] + [s.stdev for s in stands], dtype=np.float64)
    shapes = [(s.geometry, i + 1) for i, s in enumerate(stands)]
    has_keep = keep is not None and not keep.is_empty
    xs = transform.c + (np.arange(width) + 0.5) * transform.a
    painted = 0
    for r0 in range(0, height, block_rows):
        r1 = min(height, r0 + block_rows)
        p0, p1 = max(0, r0 - pad), min(height, r1 + pad)
        window = rasterio.windows.Window(0, p0, width, p1 - p0)
        block_transform = rasterio.windows.transform(window, transform)
        labels = rasterio.features.rasterize(
            shapes, out_shape=(p1 - p0, width), transform=block_transform, fill=0, dtype="int32",
        )
        inside = labels > 0
        if not inside[r0 - p0:r1 - p0].any():
            continue
        if feather_m > 0.0 and not inside.all():
            alpha = np.clip(distance_transform_edt(inside, sampling=px) / feather_m, 0.0, 1.0)
        else:
            alpha = inside.astype(np.float64)
        if has_keep:
            in_keep = rasterio.features.rasterize(
                [(keep, 1)], out_shape=(p1 - p0, width), transform=block_transform, fill=0, dtype="uint8",
            ).astype(bool)
            if in_keep.all():
                continue
            if in_keep.any():
                alpha *= np.clip(distance_transform_edt(~in_keep, sampling=px) / CORRIDOR_FEATHER_M, 0.0, 1.0)
        alpha = alpha[r0 - p0:r1 - p0]
        labels = labels[r0 - p0:r1 - p0]
        hit = alpha > 0.0
        if not hit.any():
            continue
        ys = transform.f + (np.arange(r0, r1) + 0.5) * transform.e
        luma, hue = floor_noise(xs, ys, seed)
        spread = stdevs[labels][..., None]
        floor = colours[labels] + spread * (luma[..., None] + hue[..., None] * (HUE_GAIN * HUE))
        block = out[r0:r1].astype(np.float64)
        a = alpha[..., None]
        out[r0:r1] = np.clip(np.round(block * (1.0 - a) + floor * a), 0, 255).astype(np.uint8)
        painted += int(np.count_nonzero(hit))
    return out, painted
