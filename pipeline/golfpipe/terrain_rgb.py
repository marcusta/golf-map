"""Mapbox/MapLibre Terrain-RGB encode/decode.

height = -10000 + (R * 65536 + G * 256 + B) * 0.1

Encodable range is roughly -10000 m to +917504 m in 0.1 m steps, which
comfortably covers Swedish terrain elevations (RH2000 heights).
"""

from __future__ import annotations

import numpy as np

OFFSET = -10000.0
SCALE = 0.1


def encode_terrain_rgb(heights: np.ndarray) -> np.ndarray:
    """Encodes a 2D array of heights (metres) into a (H, W, 3) uint8 RGB array.

    Values are clamped to the representable range before encoding so
    out-of-range inputs (e.g. leftover fill values) don't wrap around.
    """
    value = np.round((heights.astype(np.float64) - OFFSET) / SCALE).astype(np.int64)
    max_value = (1 << 24) - 1
    value = np.clip(value, 0, max_value)

    r = (value >> 16) & 0xFF
    g = (value >> 8) & 0xFF
    b = value & 0xFF

    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    return rgb


def decode_terrain_rgb(rgb: np.ndarray) -> np.ndarray:
    """Decodes a (H, W, 3) uint8 RGB array back into heights (metres)."""
    r = rgb[..., 0].astype(np.float64)
    g = rgb[..., 1].astype(np.float64)
    b = rgb[..., 2].astype(np.float64)
    return OFFSET + (r * 65536 + g * 256 + b) * SCALE
