"""Bunker proposals: the surface model finds the bunkers, the photo's NIR band draws their edges.

The model (`surface_model.py`) finds 265 of the 270 bunkers drawn on five courses, each course run by a model that
never saw it, but on a 0.32 m grid. Sand has almost no living green, so its NDVI sits near 0 against 0.2-0.4 for
grass: each found bunker's outline is redrawn as the line where a smoothed sand index (NDVI - 0.5 x brightness) crosses
30 % of the way from the bunker's sand to the grass round it, at the photo's 0.16 m. On the drawn courses that line
lies 0.12 m (median) from the drawn edge, the model's own 0.20 m. Where the index finds no clear sand (deep shadow,
grey sand) or a line far from the model's piece, the model's smoothed outline is kept (`edge: "model"`).

Left out: pieces under MIN_AREA_M2, pieces the model puts outside the course (its background class), and bunkers
already drawn (`known`: a drawn bunker covering 30 % of the piece). Numbers from tools/surface-lab (bunkers.py).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.windows import from_bounds
from scipy import ndimage
from shapely.geometry import Polygon, mapping, shape
from shapely.strtree import STRtree
from skimage.measure import find_contours

from .surface_model import CLASSES

BUNKER = CLASSES.index("bunker")
MIN_AREA_M2 = 2.0
KNOWN_SHARE = 0.3       # a drawn bunker covering this share of a piece: already drawn
EDGE_LEVEL = 0.3        # the line: this far from the sand's index towards the grass's
RING_M = (1.0, 3.0)     # grass sampled this far outside the piece
SEARCH_M = 1.0          # the line may move this far outside the piece
MIN_CONTRAST = 0.08     # sand vs grass index difference below this: no clear sand, keep the model's outline
AREA_RANGE = (0.5, 2.0)  # a NIR outline outside this share of the model piece's area is not trusted
SMOOTH_PX = 1.0


class BunkerProposalsError(RuntimeError):
    """User-actionable bunker proposal input error."""


def _iso_polygons(index: np.ndarray, level: float, to_m) -> list[Polygon]:
    """Closed iso-lines of `index` at `level` round its low side, as polygons in metres."""
    padded = np.pad(index, 1, mode="constant", constant_values=float(np.nanmax(index)) + 1)
    polys = []
    for c in find_contours(padded, level):
        if len(c) < 4:
            continue
        p = Polygon([to_m(r - 1, col - 1) for r, col in c]).buffer(0)
        if p.area > 0:
            polys.append(max(getattr(p, "geoms", [p]), key=lambda g: g.area))
    return polys


def _sand_index(rgb: np.ndarray, nir: np.ndarray) -> np.ndarray:
    red = rgb[0].astype(np.float32)
    n = nir.astype(np.float32)
    ndvi = (n - red) / np.maximum(n + red, 1.0)
    lum = rgb.astype(np.float32).mean(0) / 255
    return ndimage.gaussian_filter(ndvi - 0.5 * lum, SMOOTH_PX)


def nir_outline(piece: Polygon, ortho, nir) -> tuple[Polygon | None, float]:
    """The sand index's iso-line round `piece` (EPSG:3006 polygon) on the photo grid, and the sand/grass contrast."""
    pad = RING_M[1] + 1.0
    left, bottom, right, top = piece.bounds
    win = from_bounds(left - pad, bottom - pad, right + pad, top + pad, ortho.transform).round_offsets().round_lengths()
    rgb = ortho.read([1, 2, 3], window=win, boundless=True, fill_value=0)
    nr = nir.read(1, window=win, boundless=True, fill_value=0)
    if rgb.size == 0:
        return None, 0.0
    t = ortho.window_transform(win)
    px = float(ortho.res[0])
    h, w = nr.shape
    to_m = lambda r, c: (t.c + (c + 0.5) * t.a, t.f + (r + 0.5) * t.e)  # noqa: E731
    inside = rasterize([(piece, 1)], out_shape=(h, w), transform=t, dtype="uint8").astype(bool)
    if inside.sum() < 4:
        return None, 0.0
    idx = _sand_index(rgb, nr)
    core = ndimage.binary_erosion(inside, iterations=1)
    grow = lambda m: max(int(round(m / px)), 1)  # noqa: E731
    ring = ndimage.binary_dilation(inside, iterations=grow(RING_M[1])) & \
        ~ndimage.binary_dilation(inside, iterations=grow(RING_M[0]))
    if not core.any() or not ring.any():
        return None, 0.0
    sand, grass = float(np.median(idx[core])), float(np.median(idx[ring]))
    contrast = grass - sand
    if contrast < MIN_CONTRAST:
        return None, contrast
    region = ndimage.binary_dilation(inside, iterations=grow(SEARCH_M))
    local = np.where(region, idx, grass + contrast + 1.0)
    polys = _iso_polygons(local, sand + EDGE_LEVEL * contrast, to_m)
    if not polys:
        return None, contrast
    best = max(polys, key=lambda p: p.intersection(piece).area)
    ratio = best.area / max(piece.area, 1e-6)
    if not (AREA_RANGE[0] <= ratio <= AREA_RANGE[1]) or best.intersection(piece).area < 0.5 * piece.area:
        return None, contrast
    return best, contrast


def load_known(path: Path | None) -> list[Polygon]:
    """Drawn bunkers: a GeoJSON FeatureCollection of polygons in EPSG:3006."""
    if path is None:
        return []
    fc = json.loads(Path(path).read_text(encoding="utf-8"))
    out = []
    for f in fc.get("features", []):
        g = f.get("geometry")
        if g and g.get("type") in ("Polygon", "MultiPolygon"):
            out.append(shape(g).buffer(0))
    return out


def propose(surfaces: Path, ortho: Path, nir: Path, known: list[Polygon], min_area_m2: float = MIN_AREA_M2) -> dict:
    """Bunker proposals as an EPSG:3006 GeoJSON FeatureCollection, best confidence first. Each feature: the outline,
    `id` (from its centre, stable between runs), `areaM2`, `confidence` (the model's mean, 0..1), `edge`
    ("nir" | "model") and `contrast` (sand vs grass index)."""
    with rasterio.open(surfaces) as s:
        cls = s.read(1)
        ccls = s.read(3)
        cconf = s.read(4)
        st = s.transform
        sres = float(s.res[0])
    lab, n = ndimage.label(ccls == BUNKER, structure=np.ones((3, 3)))
    tree = STRtree(known) if known else None
    feats, skipped = [], {"small": 0, "notCourse": 0, "drawn": 0}
    with rasterio.open(ortho) as o, rasterio.open(nir) as nr:
        if (o.width, o.height, o.transform) != (nr.width, nr.height, nr.transform):
            raise BunkerProposalsError(f"{nir.name} is not on the grid of {ortho.name}")
        for k, sl in enumerate(ndimage.find_objects(lab), start=1):
            if sl is None:
                continue
            sub = lab[sl] == k
            if sub.sum() * sres * sres < min_area_m2:
                skipped["small"] += 1
                continue
            ys, xs = np.nonzero(sub)
            cy, cx = int(round(ys.mean())) + sl[0].start, int(round(xs.mean())) + sl[1].start
            if cls[cy, cx] == 0 and not (cls[sl][sub] != 0).mean() > 0.5:
                skipped["notCourse"] += 1
                continue
            r0, c0 = sl[0].start, sl[1].start
            to_m = lambda r, c: (st.c + (c + c0 + 0.5) * st.a, st.f + (r + r0 + 0.5) * st.e)  # noqa: E731
            smooth = ndimage.gaussian_filter(np.pad(sub, 2).astype(np.float32), 1.0)
            polys = _iso_polygons(1.0 - smooth, 0.5, lambda r, c: to_m(r - 2, c - 2))
            if not polys:
                continue
            piece = max(polys, key=lambda p: p.area)
            if tree is not None:
                hits = [known[i] for i in tree.query(piece)]
                if any(g.intersection(piece).area >= KNOWN_SHARE * piece.area for g in hits):
                    skipped["drawn"] += 1
                    continue
            outline, contrast = nir_outline(piece, o, nr)
            edge = "nir" if outline is not None else "model"
            geom = outline if outline is not None else piece
            c = geom.centroid
            feats.append({"type": "Feature", "geometry": mapping(geom.simplify(0.02)), "properties": {
                "id": f"bk-{int(round(c.x))}-{int(round(c.y))}", "type": "bunker",
                "areaM2": round(geom.area, 1), "confidence": round(float(cconf[sl][sub].mean()) / 255, 3),
                "edge": edge, "contrast": round(float(contrast), 3)}})
    feats.sort(key=lambda f: -f["properties"]["confidence"])
    return {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3006"}},
            "skipped": skipped, "features": feats}
