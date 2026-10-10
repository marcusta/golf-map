"""The tile set under a change to the cleaned photo (golfpipe.patches)."""

from __future__ import annotations

import mercantile
from rasterio.crs import CRS
from rasterio.warp import transform_bounds

from golfpipe import patches

# Realistic SWEREF99 TM coordinates (Landeryd-ish).
E0, N0 = 533000.0, 6473000.0


def sub_box_3857(e0: float, n0: float, e1: float, n1: float) -> tuple[float, float, float, float]:
    """EPSG:3857 bounds of an EPSG:3006 sub-box."""
    return transform_bounds(CRS.from_epsg(3006), CRS.from_epsg(3857), e0, n0, e1, n1)


def test_affected_tiles_cover_the_bounds_at_every_zoom():
    bounds = sub_box_3857(E0 + 20, N0 + 40, E0 + 60, N0 + 76)  # ~40x36 m
    tiles = patches.affected_tiles([bounds], 14, 20)

    by_zoom: dict[int, list[mercantile.Tile]] = {}
    for t in tiles:
        by_zoom.setdefault(t.z, []).append(t)
    assert sorted(by_zoom) == list(range(14, 21))

    w, s, e, n = transform_bounds(CRS.from_epsg(3857), CRS.from_epsg(4326), *bounds)
    for z in range(14, 21):
        expected = set(mercantile.tiles(w, s, e, n, [z]))
        assert set(by_zoom[z]) == expected
    # A ~40 m box: one tile at z14, a small cluster at z20 — never an explosion.
    assert len(by_zoom[14]) == 1
    assert 1 <= len(by_zoom[20]) <= 9
    # Deterministic ordering.
    assert tiles == sorted(tiles, key=lambda t: (t.z, t.x, t.y))


def test_affected_tiles_dedupe_overlapping_patches():
    b = sub_box_3857(E0, N0, E0 + 10, N0 + 10)
    once = patches.affected_tiles([b], 14, 18)
    twice = patches.affected_tiles([b, b], 14, 18)
    assert once == twice
