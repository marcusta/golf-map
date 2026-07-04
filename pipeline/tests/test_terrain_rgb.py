import numpy as np

from golfpipe.terrain_rgb import decode_terrain_rgb, encode_terrain_rgb


def test_round_trip_within_tolerance():
    heights = np.array([[-500.0, 0.0, 100.0], [1200.5, 8848.0, -9999.0 * 0 + 300.3]])
    rgb = encode_terrain_rgb(heights)
    decoded = decode_terrain_rgb(rgb)
    assert np.max(np.abs(decoded - heights)) < 0.1


def test_round_trip_gradient():
    col = np.linspace(-100, 2000, 1000)
    heights = np.tile(col, (10, 1))
    rgb = encode_terrain_rgb(heights)
    assert rgb.dtype == np.uint8
    assert rgb.shape == (10, 1000, 3)
    decoded = decode_terrain_rgb(rgb)
    assert np.max(np.abs(decoded - heights)) < 0.1


def test_known_value_sea_level():
    # height=0 -> value=100000 -> R=1,G=134,B=160 per the mapbox formula
    heights = np.array([[0.0]])
    rgb = encode_terrain_rgb(heights)
    r, g, b = rgb[0, 0]
    assert (int(r) * 65536 + int(g) * 256 + int(b)) * 0.1 - 10000 == 0.0


def test_clamps_out_of_range_without_error():
    heights = np.array([[-999999.0, 999999999.0]])
    rgb = encode_terrain_rgb(heights)
    assert rgb.dtype == np.uint8
    # No exception, values clamped into uint8 range implicitly via clip.
    decoded = decode_terrain_rgb(rgb)
    assert np.isfinite(decoded).all()
