"""A pond's water edge, found between the lidar's open water and the drawn (or Hydrografi) outline.

Neither source is the water's edge on its own:
- the lidar sees no ground on water: the DEM is a flat sheet at the water surface, and the 0.5 m grid smears a steep
  bank a metre or two out over it, so the lidar's water (the DEM within RISE_M of the level) lies inside the shore;
- an outline drawn on the orthophoto, or Hydrografi's, follows the visible shore, often the top of the bank or the
  reed line, so it lies on or outside it.

So the edge is searched for in the band between the two, on the orthophoto: each pond teaches its own two classes
(water = the photo inside the lidar's water, land = a ring outside the outline) and every outline point walks in
along its normal to where the photo turns from land to water. Searching only inside the band is what keeps tree
shadows and the far shore out. Where the photo shows no clear turn (reeds, lily pads, shade, two classes that look
alike) the point keeps the drawn line, and those stretches are reported. Two photos (summer and leaf-off) vote; the
moves are smoothed along the outline, and a point never moves out of the band.

    python -m golfpipe.water_edge --input <request.json> --out <answer.json>   (or the request on stdin)
        request: {"dem": <path>, "orthos": [<path>, ...], "ring": [[e, n], ...], "toward"?, "minM"?, "image"?}
        -> {"ring": [[e, n], ...], "lidarRing": [[e, n], ...], "level": ..., "areaM2": {...}, "movedM": {...},
            "kept": [{"fromM", "toM", "why"}], "sources": {"ortho": n, "kept": n}, "image": <path or null>}

`toward` (0-1) instead of the photo: every point moves that share of the way to the lidar edge (the first,
photo-less version, `--toward` in scripts/water-edge.ts). `image` writes a check picture: the photo with the drawn
line (blue), the lidar's water (yellow), the new edge (red) and the kept stretches (magenta).
"""
from __future__ import annotations

import json
import sys

import numpy as np

RISE_M = 0.05        # the lidar's water: the DEM within this of the level
SAMPLE_M = 0.25      # the outline resampled this fine
SMOOTH_M = 1.5       # the moves smoothed along the outline over this (gaussian sigma)
PAD_M = 12.0
OUT_MARGIN_M = 1.0   # the edge may lie this far outside the drawn line (a line already moved in finds its way back)
LAND_RING_M = (1.5, 4.0)   # land is taught from this ring outside the outline
WATER_INSET_M = 1.0        # water from this far inside the lidar's water
STEP_M = 0.1         # the walk along a normal
MIN_SEPARATION = 1.5  # the two classes this many standard deviations apart, else the photo cannot tell
TURN_HOLD_M = 1.0    # a turn: the water likeness stays high this far in past it
LAND_MAX = 0.3       # ... after a stretch at most this water-like (land)


def _resample(ring: np.ndarray, step: float) -> np.ndarray:
    closed = np.vstack([ring, ring[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    s = np.concatenate([[0.0], np.cumsum(seg)])
    t = np.arange(0.0, s[-1], step)
    return np.column_stack([np.interp(t, s, closed[:, 0]), np.interp(t, s, closed[:, 1])])


def _ccw(pts: np.ndarray) -> np.ndarray:
    x, y = pts[:, 0], pts[:, 1]
    area = 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))
    return pts if area > 0 else pts[::-1]


def _normals_in(q: np.ndarray) -> np.ndarray:
    """Unit normals pointing into a counter-clockwise ring (its inside is on the left)."""
    t = np.roll(q, -2, axis=0) - np.roll(q, 2, axis=0)
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    return np.column_stack([-t[:, 1], t[:, 0]])


def lidar_water(dem_path: str, drawn, pad: float = PAD_M):
    """(level, the lidar's open water inside the drawn outline as a polygon)."""
    import rasterio
    from rasterio.features import geometry_mask, shapes
    from rasterio.windows import from_bounds
    from scipy import ndimage
    from shapely.geometry import shape

    w, s, e, n = drawn.buffer(pad).bounds
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
    keep = ids > 0
    ids, counts = ids[keep], counts[keep]
    if len(ids) == 0:
        raise ValueError("no flat water inside the outline")
    k = int(ids[np.argmax(counts)])
    regions = [shape(g) for g, v in shapes((lab == k).astype(np.uint8), transform=T) if v == 1]
    water = max(regions, key=lambda g: g.area).intersection(drawn)
    if water.geom_type != "Polygon":
        water = max(getattr(water, "geoms", [water]), key=lambda g: g.area)
    return level, water


class _Photo:
    """One orthophoto around the pond, and its water likeness (0 land .. 1 water), taught from this pond."""

    def __init__(self, path: str, drawn, water):
        import rasterio
        from rasterio.features import geometry_mask
        from rasterio.windows import from_bounds
        from scipy import ndimage

        w, s, e, n = drawn.buffer(PAD_M).bounds
        with rasterio.open(path) as r:
            win = from_bounds(w, s, e, n, r.transform)
            rgb = r.read([1, 2, 3], window=win, boundless=True, fill_value=0).astype(float)
            self.T = r.window_transform(win)
        self.inv = ~self.T
        feats = self._features(rgb)
        water_core = water.buffer(-WATER_INSET_M)
        if water_core.is_empty or water_core.area < 4:
            water_core = water.buffer(-0.5)
        land = drawn.buffer(LAND_RING_M[1]).difference(drawn.buffer(LAND_RING_M[0]))
        shape_ = rgb.shape[1:]
        wm = ~geometry_mask([water_core.__geo_interface__], shape_, self.T) if not water_core.is_empty else np.zeros(shape_, bool)
        lm = ~geometry_mask([land.__geo_interface__], shape_, self.T)
        self.ok = wm.sum() >= 30 and lm.sum() >= 30
        self.separation = 0.0
        if not self.ok:
            self.like = np.zeros(shape_)
            return
        X = feats.reshape(feats.shape[0], -1).T
        xw, xl = X[wm.ravel()], X[lm.ravel()]
        # Fisher's discriminant: the one direction that best tells this pond's water from its land.
        cov = np.cov(xw.T) + np.cov(xl.T) + np.eye(X.shape[1]) * 1e-3
        d = np.linalg.solve(cov, xw.mean(0) - xl.mean(0))
        pw, pl = xw @ d, xl @ d
        self.separation = float((pw.mean() - pl.mean()) / np.sqrt(0.5 * (pw.var() + pl.var()) + 1e-9))
        p = (X @ d).reshape(shape_)
        lo, hi = np.median(pl), np.median(pw)
        like = np.clip((p - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
        px = abs(self.T.a)
        self.like = ndimage.gaussian_filter(like, max(0.15 / px, 0.5))
        self.ok = self.separation >= MIN_SEPARATION

    @staticmethod
    def _features(rgb: np.ndarray) -> np.ndarray:
        r, g, b = rgb
        tot = r + g + b + 1e-6
        hi, lo = rgb.max(0), rgb.min(0)
        return np.stack([tot / 3.0, r / tot * 255, g / tot * 255, (hi - lo) / np.maximum(hi, 1) * 255])

    def at(self, xy: np.ndarray) -> np.ndarray:
        cols, rows = self.inv * (xy[:, 0], xy[:, 1])
        r = np.clip(np.round(rows).astype(int), 0, self.like.shape[0] - 1)
        c = np.clip(np.round(cols).astype(int), 0, self.like.shape[1] - 1)
        return self.like[r, c]


def _turn(like: np.ndarray, step: float):
    """Where along a walk (outside -> in) the photo turns from land to water: the first point whose water likeness
    reaches 0.5 and stays high for the next TURN_HOLD_M, with land before it; None when the photo shows no such turn
    (reeds and lily pads look like land all the way in, shade like water all the way out)."""
    hold = max(2, int(round(TURN_HOLD_M / step)))
    if len(like) < hold + 1:
        return None
    for i in range(len(like) - hold):
        if like[i] < 0.5:
            continue
        if like[i:i + hold].mean() < 0.65:
            continue
        if i == 0:
            return None   
        return i * step if like[:i].min() < LAND_MAX else None
    return None


def water_edge(dem_path: str, ring: list, orthos: list[str] | None = None, toward: float | None = None,
               min_m: float = 0.2, image: str | None = None) -> dict:
    from scipy import ndimage
    from shapely.geometry import LineString, Point, Polygon

    pts = np.asarray(ring, dtype=float)
    if len(pts) > 1 and np.allclose(pts[0], pts[-1], rtol=0, atol=1e-6):
        pts = pts[:-1]
    pts = _ccw(pts)
    drawn = Polygon(pts)
    if not drawn.is_valid:
        drawn = drawn.buffer(0)
    level, water = lidar_water(dem_path, drawn)
    edge = water.exterior

    q = _resample(pts, SAMPLE_M)
    nin = _normals_in(q)
    move = np.zeros_like(q)
    outside = np.array([0.0 if water.contains(Point(x, y)) else edge.distance(Point(x, y)) for x, y in q])
    found = np.zeros(len(q), dtype=int)   # how many photos placed this point
    why = np.full(len(q), "", dtype=object)
    photos = []
    if toward is None:
        photos = [ph for ph in (_Photo(p, drawn, water) for p in (orthos or [])) if ph.ok]
        if not photos:
            raise ValueError("no orthophoto tells this pond's water from its land: draw the edge by hand, or use --toward")
    for i, (x, y) in enumerate(q):
        if outside[i] <= min_m:
            continue   # already at the lidar's water: nothing to find
        if toward is not None:
            p = Point(x, y)
            near = edge.interpolate(edge.project(p))
            move[i] = (toward * (near.x - x), toward * (near.y - y))
            found[i] = 1
            continue
        # walk in along the normal from OUT_MARGIN_M outside to the lidar's water
        start = q[i] - nin[i] * OUT_MARGIN_M
        ray = LineString([tuple(start), tuple(q[i] + nin[i] * (outside[i] + 3.0))])
        hit = ray.intersection(edge)
        stop = OUT_MARGIN_M + outside[i]
        if not hit.is_empty:
            ds = [Point(start).distance(g) for g in getattr(hit, "geoms", [hit])]
            stop = min(min(ds), OUT_MARGIN_M + outside[i] + 3.0)
        t = np.arange(0.0, max(stop, STEP_M * 3), STEP_M)
        xy = start[None, :] + t[:, None] * nin[i][None, :]
        turns = [tt for tt in (_turn(ph.at(xy), STEP_M) for ph in photos) if tt is not None]
        if not turns:
            why[i] = "no clear water edge on the photo (reeds, shade?)"
            continue
        d_in = float(np.mean(turns)) - OUT_MARGIN_M   # + = in from the drawn line, - = out
        move[i] = nin[i] * d_in
        found[i] = len(turns)
    sigma = SMOOTH_M / SAMPLE_M
    move = np.column_stack([ndimage.gaussian_filter1d(move[:, j], sigma, mode="wrap") for j in range(2)])
    out = q + move
    # never out of the band: not past the margin outside the drawn line, not into the lidar's water
    outer = drawn.buffer(OUT_MARGIN_M)
    for i, (x, y) in enumerate(out):
        p = Point(x, y)
        if not outer.contains(p):
            b = outer.exterior.interpolate(outer.exterior.project(p))
            out[i] = (b.x, b.y)
        elif water.contains(p) and outside[i] > min_m:
            b = edge.interpolate(edge.project(p))
            out[i] = (b.x, b.y)
    new = Polygon(out)
    moved = np.hypot(*(out - q).T)
    kept = _stretches(why, SAMPLE_M)
    result = {
        "ring": [[round(float(x), 3), round(float(y), 3)] for x, y in out],
        "lidarRing": [[round(float(x), 3), round(float(y), 3)] for x, y in water.exterior.coords],
        "level": round(level, 3),
        "areaM2": {"drawn": round(drawn.area, 1), "lidar": round(water.area, 1), "new": round(new.area, 1)},
        "outsideLidarM": {"p50": round(float(np.median(outside)), 2), "p90": round(float(np.percentile(outside, 90)), 2),
                          "max": round(float(outside.max()), 2)},
        "movedM": {"p50": round(float(np.median(moved)), 2), "p90": round(float(np.percentile(moved, 90)), 2),
                   "max": round(float(moved.max()), 2)},
        "kept": kept,
        "photos": [{"separation": round(ph.separation, 2)} for ph in photos],
        "image": None,
    }
    if image:
        result["image"] = _draw(image, orthos[0] if orthos else None, pts, water, out, q, why)
    return result


def _stretches(why: np.ndarray, step: float) -> list[dict]:
    """The runs of outline points that kept the drawn line, as distances along it."""
    out, i, n = [], 0, len(why)
    while i < n:
        if why[i]:
            j = i
            while j + 1 < n and why[j + 1]:
                j += 1
            if (j - i + 1) * step >= 1.0:
                out.append({"fromM": round(i * step, 1), "toM": round((j + 1) * step, 1), "why": str(why[i])})
            i = j + 1
        else:
            i += 1
    return out


def _draw(path: str, ortho: str | None, drawn, water, new, q, why) -> str:
    import rasterio
    from PIL import Image, ImageDraw
    from rasterio.windows import from_bounds

    xs = np.concatenate([drawn[:, 0], new[:, 0]])
    ys = np.concatenate([drawn[:, 1], new[:, 1]])
    w, s, e, n = xs.min() - 6, ys.min() - 6, xs.max() + 6, ys.max() + 6
    scale = 1400.0 / max(e - w, n - s)
    W, H = int((e - w) * scale), int((n - s) * scale)
    if ortho:
        with rasterio.open(ortho) as r:
            a = r.read([1, 2, 3], window=from_bounds(w, s, e, n, r.transform), boundless=True, fill_value=0)
        img = Image.fromarray(np.moveaxis(a, 0, -1).astype(np.uint8)).resize((W, H), Image.LANCZOS)
    else:
        img = Image.new("RGB", (W, H), (40, 40, 40))
    d = ImageDraw.Draw(img)
    P = lambda p: ((p[0] - w) * scale, (n - p[1]) * scale)
    d.line([P(p) for p in drawn] + [P(drawn[0])], fill=(0, 170, 255), width=2)
    d.line([P(p) for p in water.exterior.coords], fill=(255, 230, 0), width=2)
    d.line([P(p) for p in new] + [P(new[0])], fill=(255, 50, 50), width=2)
    for i in np.nonzero(why != "")[0]:
        x, y = P(q[i])
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(255, 0, 255))
    img.save(path)
    return path


def main(argv: list[str] | None = None) -> None:
    """`--input <json> --out <json>` (the server's runner), else the request on stdin and the answer on stdout."""
    import argparse
    p = argparse.ArgumentParser(prog="python -m golfpipe.water_edge")
    p.add_argument("--input")
    p.add_argument("--out")
    args = p.parse_args(argv)
    a = json.loads(open(args.input, encoding="utf-8").read()) if args.input else json.load(sys.stdin)
    result = water_edge(a["dem"], a["ring"], orthos=a.get("orthos"),
                        toward=float(a["toward"]) if a.get("toward") is not None else None,
                        min_m=float(a.get("minM", 0.2)), image=a.get("image"))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f)
        print(f"water edge: moved p50 {result['movedM']['p50']} m, max {result['movedM']['max']} m; "
              f"{len(result['kept'])} stretch(es) kept -> {args.out}")
    else:
        print(json.dumps(result))


if __name__ == "__main__":
    main()
