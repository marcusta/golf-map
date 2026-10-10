"""What the cleaned photo's commands (golfpipe.cleaned) share with the
retile under a change (commands._retile_affected): the error type, the frames
and the set of map tiles a changed area touches.

A change to the cleaned photo is known as a box in EPSG:3006 (the photo's own
grid). The map tiles are Web Mercator, so the retile frame is that box's
EPSG:3857 envelope (bounds3006_to_3857) and the tiles to rewrite are every
tile it intersects (affected_tiles).
"""

from __future__ import annotations

import mercantile
from rasterio.crs import CRS
from rasterio.warp import transform_bounds

WEB_MERCATOR = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)
SWEREF99_TM = CRS.from_epsg(3006)


class PatchError(RuntimeError):
    """User-actionable cleaned-photo error."""


def bounds3006_to_3857(bounds3006: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """The EPSG:3857 envelope (west, south, east, north) of an EPSG:3006 box.
    Larger than the box by the meridian-convergence rotation, which is what
    a retile frame wants: every tile the box touches."""
    return transform_bounds(SWEREF99_TM, WEB_MERCATOR, *bounds3006)


def affected_tiles(
    bounds3857_list: list[tuple[float, float, float, float]],
    minzoom: int,
    maxzoom: int,
) -> list[mercantile.Tile]:
    """The deduplicated XYZ tiles intersecting any of the given EPSG:3857
    bounds, across every zoom in [minzoom, maxzoom] — the tile-pyramid
    subtree a change must rewrite. Sorted by (z, x, y) for determinism.
    """
    seen: set[mercantile.Tile] = set()
    for bounds in bounds3857_list:
        w, s, e, n = transform_bounds(WEB_MERCATOR, WGS84, *bounds)
        for z in range(minzoom, maxzoom + 1):
            for tile in mercantile.tiles(w, s, e, n, [z]):
                seen.add(tile)
    return sorted(seen, key=lambda t: (t.z, t.x, t.y))
