"""Creeks: the line down a creek and the water surface along it.

Shared by the `dig` terrain edit's ``reference: stream`` (the bed dug below
the surface, dem_edit.py) and ``gspro.py creeks`` (R.A.M. splines at the
surface in Unity), so the water always sits in its bed.

- ``ribbon_centerline`` — a creek imported or drawn as a polygon (a buffered
  Hydrografi line, fitted as a spline) has lost its line. The Voronoi diagram
  of points sampled along its outline has its interior edges on the medial
  axis; the longest path through them is the creek's line, and twice the
  median distance from that line to the outline its width.
- ``surface_profile`` — lidar on a small creek is noise: grass on the banks,
  a few water returns, interpolation between. Each station along the line
  takes the lowest height across the creek, the line is turned to run
  downhill (a least-squares trend), and the heights are forced to only fall
  (a running minimum from upstream), smoothed and forced again, so neither
  the R.A.M. surface nor the dug bed ever climbs.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass

import numpy as np
import rasterio.transform
import shapely
from shapely.geometry import LineString, Polygon

__all__ = [
    "DEFAULT_STATION_M", "DEFAULT_SURFACE_SMOOTH_M",
    "ribbon_centerline", "SurfaceProfile", "surface_profile",
]

DEFAULT_STATION_M = 1.0
# Running mean over the monotone profile: long enough to take out steps the
# running minimum leaves, short enough to keep a weir or a culvert drop.
DEFAULT_SURFACE_SMOOTH_M = 10.0
# Below a fall (surface_profile's `breaks`) the first stations still see the sill and its face.
BREAK_CLEAR_M = 1.5
# A stretch between falls that falls less than this plus this much per metre is a pond: one level, the low quartile
# of its water (water plants and reeds read high, nothing reads low). golfpipe.water_steps' RUN_FLAT_M/_SLOPE.
POND_FLAT_M = 0.3
POND_FLAT_SLOPE = 0.002


def ribbon_centerline(polygon: Polygon, spacing_m: float = 0.5) -> tuple[LineString, float] | None:
    """(line, width in m) down the middle of a creek-shaped polygon, or None
    for a polygon too small or too round to have one."""
    from scipy.spatial import Voronoi

    polygon = polygon.buffer(0)
    if polygon.is_empty or polygon.area <= 0:
        return None
    if polygon.geom_type == "MultiPolygon":
        polygon = max(polygon.geoms, key=lambda g: g.area)
    ring = polygon.exterior
    n = max(int(ring.length / spacing_m), 12)
    samples = np.array([ring.interpolate(i * ring.length / n).coords[0] for i in range(n)])
    vor = Voronoi(samples)
    verts = vor.vertices
    inside = shapely.contains_xy(polygon, verts[:, 0], verts[:, 1]) if len(verts) else np.array([], bool)

    graph: dict[int, list[tuple[int, float]]] = {}
    for a, b in vor.ridge_vertices:
        if a < 0 or b < 0 or not (inside[a] and inside[b]):
            continue
        if not polygon.contains(LineString([verts[a], verts[b]])):
            continue
        w = float(np.hypot(*(verts[a] - verts[b])))
        graph.setdefault(a, []).append((b, w))
        graph.setdefault(b, []).append((a, w))
    if len(graph) < 2:
        return None

    def farthest(start: int) -> tuple[int, dict[int, int]]:
        dist = {start: 0.0}
        prev: dict[int, int] = {}
        heap = [(0.0, start)]
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist[u]:
                continue
            for v, w in graph[u]:
                if d + w < dist.get(v, np.inf):
                    dist[v] = d + w
                    prev[v] = u
                    heapq.heappush(heap, (d + w, v))
        end = max(dist, key=dist.get)
        return end, prev

    # The diameter of the (largest connected) medial graph: from any node to
    # its farthest node, then from there to that one's farthest.
    start = max(graph, key=lambda k: len(graph[k]))
    a, _ = farthest(start)
    b, prev = farthest(a)
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    if len(path) < 2:
        return None
    from shapely.ops import substring

    line = LineString(verts[path])
    boundary = polygon.exterior
    dists = np.array([boundary.distance(shapely.Point(p)) for p in line.coords])
    width = float(2 * np.median(dists))
    # At a square end the medial axis forks into the two corners and the
    # longest path follows one fork: trim a width off each end, then run the
    # ends straight out to the outline.
    if line.length > 3 * width:
        line = substring(line, width, line.length - width)
    coords = np.asarray(line.coords)
    for end in (0, -1):
        p, q = coords[end], coords[1 if end == 0 else -2]
        direction = p - q
        norm = float(np.hypot(*direction))
        if norm > 0:
            coords[end] = p + direction / norm * 2 * width
    extended = LineString(coords).intersection(polygon.buffer(1e-6))
    if extended.geom_type == "MultiLineString":
        mid = line.interpolate(0.5, normalized=True)
        extended = min(extended.geoms, key=lambda g: g.distance(mid))
    if extended.geom_type != "LineString" or extended.length <= 0:
        extended = line
    return extended, width


@dataclass(frozen=True)
class SurfaceProfile:
    """Stations along a creek, running downstream (the line reversed when it
    was drawn uphill): positions, chainage and the water surface there."""

    x: np.ndarray
    y: np.ndarray
    s: np.ndarray
    z: np.ndarray
    reversed: bool
    # The chainages of the falls the profile was cut at (see surface_profile's `breaks`), in order downstream.
    break_s: tuple = ()


def surface_profile(
    dem: np.ndarray,
    transform: "rasterio.Affine",
    line: np.ndarray,
    width_m: float,
    valid: np.ndarray | None = None,
    station_m: float = DEFAULT_STATION_M,
    smooth_m: float = DEFAULT_SURFACE_SMOOTH_M,
    breaks: list | None = None,
) -> SurfaceProfile | None:
    """The monotone water surface along `line` ([[x, y], …] in the DEM's
    CRS) over `dem` (with `transform`; `valid` masks nodata). None when the
    line is shorter than two stations or crosses no valid cells.

    `breaks` ([[x, y], …], a waterfall's lip on the creek: shared/features/
    waterfall.ts) cut the profile: each stretch between them is made to fall
    and smoothed on its own, so a chain of ponds keeps each pond flat at its
    level and the step between them sharp, instead of a 10 m ramp. A stretch
    that hardly falls (POND_FLAT_*) is a pond and gets one level."""
    line = np.asarray(line, dtype=np.float64)
    seg = np.hypot(*np.diff(line, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(cum[-1])
    if total < station_m:
        return None
    n = int(np.ceil(total / station_m)) + 1
    s = np.linspace(0.0, total, n)
    x = np.interp(s, cum, line[:, 0])
    y = np.interp(s, cum, line[:, 1])
    # Unit normals from the local direction.
    dx, dy = np.gradient(x), np.gradient(y)
    norm = np.hypot(dx, dy)
    norm[norm == 0] = 1.0
    nx, ny = -dy / norm, dx / norm

    cell = min(abs(transform.a), abs(transform.e))
    half = max(width_m / 2.0, cell)
    offsets = np.arange(-half, half + 1e-9, cell / 2.0)
    height, width = dem.shape
    lows = np.full(n, np.nan)
    for off in offsets:
        rows, cols = rasterio.transform.rowcol(transform, x + nx * off, y + ny * off)
        rows, cols = np.asarray(rows), np.asarray(cols)
        ok = (rows >= 0) & (rows < height) & (cols >= 0) & (cols < width)
        z = np.full(n, np.nan)
        z[ok] = dem[rows[ok], cols[ok]]
        if valid is not None:
            bad = np.zeros(n, bool)
            bad[ok] = ~valid[rows[ok], cols[ok]]
            z[bad] = np.nan
        lows = np.fmin(lows, z)
    good = np.isfinite(lows)
    if good.sum() < 2:
        return None
    lows = np.interp(s, s[good], lows[good])

    # Downstream = the direction the least-squares trend falls.
    rev = bool(np.polyfit(s, lows, 1)[0] > 0)
    if rev:
        x, y, lows = x[::-1], y[::-1], lows[::-1]
    # The falls' chainages along the (downstream) line: the nearest station to each.
    # A lip at the very end of the line (an outlet into the creek from another water) cuts nothing.
    clear = max(int(round(BREAK_CLEAR_M / station_m)), 1)
    cuts: list[int] = []
    for p in breaks or []:
        i = int(np.argmin((x - float(p[0])) ** 2 + (y - float(p[1])) ** 2))
        if clear <= i <= n - 1 - clear and i not in cuts:
            cuts.append(i)
    cuts.sort()
    z = np.empty(n)
    k = max(int(round(smooth_m / station_m)), 1)
    for a, b in zip([0] + cuts, cuts + [n]):
        raw = lows[a:b].copy()
        # Just below a fall the cross-section still takes in the sill and the face: start from the water past it.
        if a > 0 and len(raw) > clear:
            raw[:clear] = raw[clear]
        seg = np.minimum.accumulate(raw)
        m = len(seg)
        if k > 1 and m > 2:
            pad = np.concatenate([np.full(k, seg[0]), seg, np.full(k, seg[-1])])
            seg = np.minimum.accumulate(np.convolve(pad, np.ones(k) / k, mode="same")[k:-k])
        if cuts and m > 1 and seg[0] - seg[-1] < POND_FLAT_M + POND_FLAT_SLOPE * (s[b - 1] - s[a]):
            seg = np.full(m, float(np.percentile(raw, 25)))
        z[a:b] = seg
    # Never climbing downstream across a fall either.
    z = np.minimum.accumulate(z)
    return SurfaceProfile(x=x, y=y, s=s, z=z, reversed=rev, break_s=tuple(float(s[i]) for i in cuts))
