"""A pond's outline moved part of the way in to the lidar's water edge.

The lidar sees no ground on water: the DEM is a flat sheet at the water surface, and a steep bank is smeared a metre
or two out over it by the 0.5 m grid. An outline drawn on the orthophoto (or from Hydrografi) follows the visible
shore, the top of that smear; the lidar's edge (the DEM at the level + RISE_M) is the other bound. The truth is in
between, so each point of the outline outside the lidar edge by more than `min_m` moves `toward` (0-1) of the way to
it; the moves are smoothed along the outline so it stays a smooth shape. Points never move out.

    python -m golfpipe.water_edge < {"dem": <path>, "ring": [[e, n], ...], "toward": 0.5, "minM": 0.2}
        -> {"ring": [[e, n], ...], "level": ..., "areaM2": {"drawn", "lidar", "new"}, "movedM": {"p50", "p90", "max"}}

The ring is the outline flattened (EPSG:3006, closed or not); `scripts/water-edge.ts` fits the result back to a
B-spline and stores it on the feature.
"""
from __future__ import annotations

import json
import sys

import numpy as np

RISE_M = 0.05        # the lidar's water: the DEM within this of the level
SAMPLE_M = 0.25      # the outline resampled this fine
SMOOTH_M = 1.5       # the moves smoothed along the outline over this (gaussian sigma)
PAD_M = 10.0


def _resample(ring: np.ndarray, step: float) -> np.ndarray:
    closed = np.vstack([ring, ring[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    t = np.arange(0.0, s[-1], step)
    return np.column_stack([np.interp(t, s, closed[:, 0]), np.interp(t, s, closed[:, 1])])


def water_edge(dem_path: str, ring: list, toward: float = 0.5, min_m: float = 0.2) -> dict:
    import rasterio
    from rasterio.features import geometry_mask, shapes
    from rasterio.windows import from_bounds
    from scipy import ndimage
    from shapely.geometry import Point, Polygon, shape

    pts = np.asarray(ring, dtype=float)
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    drawn = Polygon(pts)
    if not drawn.is_valid:
        drawn = drawn.buffer(0)
    w, s, e, n = drawn.buffer(PAD_M).bounds
    with rasterio.open(dem_path) as r:
        win = from_bounds(w, s, e, n, r.transform)
        z = r.read(1, window=win, boundless=True, fill_value=np.nan).astype(float)
        if r.nodata is not None:
            z[z == r.nodata] = np.nan
        T = r.window_transform(win)
    deep = None
    for inset in (2.0, 1.0, 0.5):
        core = drawn.buffer(-inset)
        if core.is_empty:
            continue
        m = ~geometry_mask([core.__geo_interface__], z.shape, T) & np.isfinite(z)
        if m.sum() >= 8:
            deep = m
            break
    if deep is None:
        raise ValueError("the outline is too small for the DEM to see water inside it")
    level = float(np.median(z[deep]))
    wet = np.nan_to_num(z, nan=np.inf) <= level + RISE_M
    lab, _ = ndimage.label(wet)
    ids, counts = np.unique(lab[deep & wet], return_counts=True)
    ids, counts = ids[ids > 0], counts[ids > 0]
    if len(ids) == 0:
        raise ValueError("no flat water inside the outline")
    k = int(ids[np.argmax(counts)])
    regions = [shape(g) for g, v in shapes((lab == k).astype(np.uint8), transform=T) if v == 1]
    lidar = max(regions, key=lambda g: g.area).intersection(drawn)
    if lidar.geom_type != "Polygon":
        lidar = max(getattr(lidar, "geoms", [lidar]), key=lambda g: g.area)

    q = _resample(pts, SAMPLE_M)
    move = np.zeros_like(q)
    dist = np.zeros(len(q))
    edge = lidar.exterior
    for i, (x, y) in enumerate(q):
        p = Point(x, y)
        if lidar.contains(p):
            continue
        dist[i] = edge.distance(p)
        nearest = edge.interpolate(edge.project(p))
        move[i] = (nearest.x - x, nearest.y - y)
    # only past min_m, eased in over it, then smoothed along the outline
    k_in = np.clip((dist - min_m) / max(min_m, 1e-6), 0.0, 1.0)
    move *= (toward * k_in)[:, None]
    sigma = SMOOTH_M / SAMPLE_M
    move = np.column_stack([ndimage.gaussian_filter1d(move[:, j], sigma, mode="wrap") for j in range(2)])
    out = q + move
    new = Polygon(out)
    moved = np.hypot(*move.T)
    return {
        "ring": [[round(float(x), 3), round(float(y), 3)] for x, y in out],
        "level": round(level, 3),
        "areaM2": {"drawn": round(drawn.area, 1), "lidar": round(lidar.area, 1), "new": round(new.area, 1)},
        "outsideLidarM": {"p50": round(float(np.median(dist)), 2), "p90": round(float(np.percentile(dist, 90)), 2),
                          "max": round(float(dist.max()), 2)},
        "movedM": {"p50": round(float(np.median(moved)), 2), "p90": round(float(np.percentile(moved, 90)), 2),
                   "max": round(float(moved.max()), 2)},
    }


if __name__ == "__main__":
    a = json.load(sys.stdin)
    json.dump(water_edge(a["dem"], a["ring"], float(a.get("toward", 0.5)), float(a.get("minM", 0.2))), sys.stdout)
