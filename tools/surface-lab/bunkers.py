"""Bunkers from the photo, its NIR band and the lidar DEM, without SAM, scored against the drawn bunkers.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/bunkers.py box
    pipeline/.venv/Scripts/python.exe tools/surface-lab/bunkers.py course [--site <siteId>...]

Sand is nearly the only thing on a course with no living green in it: NDVI (NIR - R) / (NIR + R) sits around 0 or
below in every bunker of the five drawn courses, grass at 0.2-0.4. The outline is drawn where a smoothed NDVI crosses
the level between sand and grass (an iso-line, sub-pixel, smooth by construction) instead of round pixels.

box     each bunker case of the SAM bench (sam_cases.py): the iso-line inside the box, with and without brightness.
course  every bunker of a course at once, no box: sand pixels -> pieces -> kept by size, shape (paths are long),
        brightness and, from the lidar DEM, whether the piece lies in a hollow (a bunker is dug in: relief_2m inside
        below the 1.5 m ring round it). Recall / precision against the drawn bunkers, with and without the lidar test.

Edges are scored on vectors: the mean distance (both ways) between the found outline and the drawn polygon, in
metres. Writes data/experiments/surfaces/bunkers/.
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform_geom
from rasterio.windows import Window, bounds as window_bounds, from_bounds
from scipy import ndimage
from shapely.geometry import Polygon, shape
from shapely.ops import unary_union
from skimage.filters import threshold_otsu
from skimage.measure import find_contours

REPO = Path(__file__).resolve().parents[2]
SURF = REPO / "data" / "experiments" / "surfaces"
OUT = SURF / "bunkers"
BUNKER = 7  # CLASSES index
SMOOTH_PX = 1.0


def ndvi(red, nir):
    red = red.astype(np.float32)
    nir = nir.astype(np.float32)
    return (nir - red) / np.maximum(nir + red, 1.0)


def drawn_polygons(site: str, crs="EPSG:3006") -> dict:
    """Feature id -> drawn polygon (EPSG:3006 metres) for every bunker of the site."""
    out = {}
    for path in glob.glob(str(SURF / site / "features-*.geojson")):
        for f in json.loads(Path(path).read_text(encoding="utf-8"))["features"]:
            if (f.get("properties") or {}).get("type") == "bunker" and f.get("geometry"):
                out[f["id"]] = shape(transform_geom("EPSG:4326", crs, f["geometry"])).buffer(0)
    return out


def edge_distance(a, b, step=0.05) -> float:
    """Mean distance in metres between two outlines, both ways."""
    def samples(g):
        pts = []
        for ring in (getattr(g, "geoms", None) or [g]):
            line = ring.exterior
            n = max(int(line.length / step), 8)
            pts += [line.interpolate(i / n, normalized=True) for i in range(n)]
        return pts
    ba, bb = a.boundary, b.boundary
    da = np.mean([bb.distance(p) for p in samples(a)])
    db = np.mean([ba.distance(p) for p in samples(b)])
    return float((da + db) / 2)


def iou(a, b) -> float:
    u = a.union(b).area
    return float(a.intersection(b).area / u) if u else 0.0


def iso_polygons(index, level, to_m):
    """Closed iso-lines of `index` at `level` round the low side (sand), as polygons in metres."""
    polys = []
    padded = np.pad(index, 1, mode="constant", constant_values=index.max() + 1)  # closes lines at the crop edge
    for c in find_contours(padded, level):
        if len(c) < 4:
            continue
        p = Polygon([to_m(r - 1, col - 1) for r, col in c]).buffer(0)
        if p.area > 0:
            polys.append(p)
    return polys


# ---------------------------------------------------------------- box

def run_box() -> None:
    rows = []
    cache: dict[str, dict] = {}
    for path in sorted(glob.glob(str(SURF / "sam-bench" / "cases" / "*-bunker-*.npz"))):
        z = np.load(path)
        meta = json.loads(str(z["meta"]))
        site = meta["site"]
        drawn = cache.setdefault(site, drawn_polygons(site)).get(meta["id"])
        if drawn is None:
            continue
        cl, cb, cr, ct = meta["crop"]
        h, w = z["truth"].shape
        sx, sy = (cr - cl) / w, (ct - cb) / h

        def to_m(r, c):
            return (cl + (c + 0.5) * sx, ct - (r + 0.5) * sy)

        x1, y1, x2, y2 = z["box"]
        box_m = Polygon([to_m(y1, x1), to_m(y1, x2), to_m(y2, x2), to_m(y2, x1)])
        centre = Polygon([to_m(y1 + (y2 - y1) / 4, x1 + (x2 - x1) / 4), to_m(y1 + (y2 - y1) / 4, x2 - (x2 - x1) / 4),
                          to_m(y2 - (y2 - y1) / 4, x2 - (x2 - x1) / 4), to_m(y2 - (y2 - y1) / 4, x1 + (x2 - x1) / 4)])
        rgb, nir = z["rgb"], z["nir"]
        nd = ndvi(rgb[..., 0], nir)
        lum = rgb.astype(np.float32).mean(-1) / 255
        inside = np.zeros(nd.shape, bool)
        inside[int(y1):int(np.ceil(y2)), int(x1):int(np.ceil(x2))] = True

        def add(method, polys):
            cands = [p.intersection(box_m) for p in polys]
            cands = [p for p in cands if p.area > 0.5]
            if not cands:
                rows.append(dict(site=site[:8], case=Path(path).stem, method=method, iou=0.0, edge_m=np.nan,
                                 area_ratio=0.0))
                return
            best = max(cands, key=lambda p: p.intersection(centre).area)
            rows.append(dict(site=site[:8], case=Path(path).stem, method=method, iou=iou(best, drawn),
                             edge_m=edge_distance(best, drawn), area_ratio=best.area / drawn.area))

        for name, idx in (("ndvi", nd), ("ndvi+lum", nd - 0.5 * lum)):
            sm = ndimage.gaussian_filter(idx, SMOOTH_PX)
            otsu = threshold_otsu(sm[inside])
            sand, grass = np.median(sm[inside & (sm < otsu)]), np.median(sm[inside & (sm >= otsu)])
            for f in ((0.5,) if name == "ndvi" else (0.3, 0.5, 0.7)):
                # f = where between the sand's and the grass's level the line is drawn (0.5 ~ Otsu)
                add(f"{name} iso {f:g}", iso_polygons(sm, sand + f * (grass - sand), to_m))
        # the same pixels as the binary rule, outlined round pixel edges (what a mask gives)
        sm = ndimage.gaussian_filter(nd - 0.5 * lum, SMOOTH_PX)
        mask = (sm < threshold_otsu(sm[inside])) & inside
        add("rule pixels", iso_polygons(np.where(ndimage.binary_fill_holes(mask), 0.0, 1.0), 0.999, to_m))
        saved = SURF / "sam-bench" / "bunker-only" / "masks" / f"{Path(path).stem}.npz"
        if saved.exists():
            sam = np.load(saved)
            for key in ("auto", "cir_point"):
                m = sam[key]
                add(f"sam {key} pixels", iso_polygons(np.where(m, 0.0, 1.0), 0.999, to_m))
                add(f"sam {key} smoothed", iso_polygons(1 - ndimage.gaussian_filter(m.astype(np.float32), 1.5),
                                                        0.5, to_m))
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ["| method | n | mean IoU | median edge (m) | mean edge (m) | share < 0.25 m | median area / drawn |",
             "|---|---|---|---|---|---|---|"]
    for m in dict.fromkeys(r["method"] for r in rows):
        sel = [r for r in rows if r["method"] == m]
        e = np.array([r["edge_m"] for r in sel])
        lines.append(f"| {m} | {len(sel)} | {np.mean([r['iou'] for r in sel]):.3f} | {np.nanmedian(e):.3f} | "
                     f"{np.nanmean(e):.3f} | {np.mean(e < 0.25):.0%} | "
                     f"{np.median([r['area_ratio'] for r in sel]):.2f} |")
    text = "\n".join(lines)
    (OUT / "box.md").write_text(text + "\n")
    (OUT / "box.json").write_text(json.dumps(rows, indent=1))
    print(text)


# ---------------------------------------------------------------- course

BLOCK, HALO = 2048, 256


def piece_features(lab_block, n, nd, lum, rel, mpp, px):
    """Per piece: area m², elongation, mean NDVI, mean brightness, warmth ((R - B) / (R + G + B): sand is yellowish,
    rock grey), texture (std of brightness: sand is smooth), hollow depth (ring relief - inside relief, m) and the
    lidar roughness inside (std of relief_2m: rock is knobbly)."""
    warm_img = (px[0] - px[2]) / np.maximum(px[0] + px[1] + px[2], 1.0)
    feats = {}
    objs = ndimage.find_objects(lab_block)
    ring_px = max(int(round(1.5 / mpp)), 2)
    for i, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        r0, r1 = max(sl[0].start - ring_px, 0), min(sl[0].stop + ring_px, lab_block.shape[0])
        c0, c1 = max(sl[1].start - ring_px, 0), min(sl[1].stop + ring_px, lab_block.shape[1])
        sub = lab_block[r0:r1, c0:c1] == i
        area = sub.sum() * mpp * mpp
        ys, xs = np.nonzero(sub)
        if len(xs) >= 3:
            ev = np.linalg.eigvalsh(np.cov(np.vstack([xs, ys])))
            elong = float(np.sqrt(max(ev[1], 1e-6) / max(ev[0], 1e-6)))
        else:
            elong = 1.0
        ring = ndimage.binary_dilation(sub, iterations=ring_px) & ~sub
        rsub = rel[r0:r1, c0:c1]
        inside_rel = np.nanmean(rsub[sub]) if np.isfinite(rsub[sub]).any() else np.nan
        ring_rel = np.nanmean(rsub[ring]) if np.isfinite(rsub[ring]).any() else np.nan
        lsub = lum[r0:r1, c0:c1][sub]
        feats[i] = dict(area=float(area), elong=elong, ndvi=float(nd[r0:r1, c0:c1][sub].mean()),
                        lum=float(lsub.mean()), warm=float(warm_img[r0:r1, c0:c1][sub].mean()),
                        tex=float(lsub.std()), hollow=float(ring_rel - inside_rel),
                        rough=float(np.nanstd(rsub[sub])) if np.isfinite(rsub[sub]).any() else np.nan,
                        rows=(r0, r1), cols=(c0, c1))
    return feats


def road_area(site: str):
    """The site's NVDB/OSM roads as one area (centreline buffered by half its width + 1 m), or None."""
    path = REPO / "data" / "sources" / site / "roads-centerlines.geojson"
    if not path.exists():
        return None
    parts = [shape(f["geometry"]).buffer((f["properties"].get("widthM") or 4.0) / 2 + 1.0)
             for f in json.loads(path.read_text(encoding="utf-8"))["features"] if f.get("geometry")]
    return unary_union(parts) if parts else None


RULES = {
    "sand only": lambda f: f["area"] >= 2.0,
    "+ shape, light": lambda f: f["area"] >= 2.0 and f["elong"] < 6 and f["lum"] > 0.42,
    "+ lidar hollow": lambda f: f["area"] >= 2.0 and f["elong"] < 6 and f["lum"] > 0.42 and f["hollow"] > 0.02,
}


def run_course(sites: list[str]) -> None:
    summary = []
    for site in sites:
        d = SURF / site
        feats_json = {f["idx"]: f for f in json.loads((d / "features.json").read_text())}
        drawn = drawn_polygons(site)
        roads = road_area(site)
        with rasterio.open(d / "rgbi-2025.tif") as px, rasterio.open(d / "instances.tif") as inst, \
                rasterio.open(d / "labels.tif") as labr, rasterio.open(d / "dem-layers.tif") as dem:
            mpp = px.res[0]
            T = px.transform
            # The site's sand level: the NDVI of its grass (bright-ish, green pixels) minus a margin.
            sample = px.read(window=Window(px.width // 4, px.height // 4, px.width // 2, px.height // 2),
                             out_shape=(4, 1024, 1024), resampling=Resampling.average)
            snd = ndvi(sample[0], sample[3])
            slum = sample[:3].astype(np.float32).mean(0) / 255
            grass = np.median(snd[(slum > 0.3) & (slum < 0.55) & (snd > 0.1)])
            t_ndvi = float(grass - 0.25)
            pieces = []  # (polygon m, features, drawn bunker idx it overlaps or None, inside drawn area)
            found_by_rule = {k: set() for k in RULES}
            drawn_idx = set()
            for row in range(0, px.height, BLOCK):
                for col in range(0, px.width, BLOCK):
                    w = Window(col - HALO, row - HALO, BLOCK + 2 * HALO, BLOCK + 2 * HALO)
                    p = px.read(window=w, boundless=True, fill_value=0).astype(np.float32)
                    if not p.any():
                        continue
                    ins = inst.read(1, window=w, boundless=True, fill_value=0)
                    lb = labr.read(1, window=w, boundless=True, fill_value=0)
                    b = window_bounds(w, T)
                    rel = dem.read(2, window=from_bounds(*b, dem.transform), out_shape=lb.shape, boundless=True,
                                   fill_value=np.nan, resampling=Resampling.bilinear)
                    nd = ndimage.gaussian_filter(ndvi(p[0], p[3]), SMOOTH_PX)
                    lum = p[:3].mean(0) / 255
                    sand = (nd < t_ndvi) & (p[3] > 0)
                    sand = ndimage.binary_opening(sand, iterations=1)
                    lab_block, n = ndimage.label(sand)
                    core = (slice(HALO, HALO + BLOCK), slice(HALO, HALO + BLOCK))
                    bunker_ids = [i for i in np.unique(ins[core]) if i and feats_json.get(int(i), {}).get("type") == "bunker"]
                    for i in bunker_ids:  # drawn bunkers whose centre is in this block's core
                        ys, xs = np.nonzero(ins == i)
                        if HALO <= ys.mean() < HALO + BLOCK and HALO <= xs.mean() < HALO + BLOCK:
                            drawn_idx.add(int(i))
                    fts = piece_features(lab_block, n, nd, lum, rel, mpp, p)
                    for k, f in fts.items():
                        r0, r1 = f["rows"]
                        c0, c1 = f["cols"]
                        sub = lab_block[r0:r1, c0:c1] == k
                        ys, xs = np.nonzero(sub)
                        cy, cx = ys.mean() + r0, xs.mean() + c0
                        if not (HALO <= cy < HALO + BLOCK and HALO <= cx < HALO + BLOCK):
                            continue
                        hit = ins[r0:r1, c0:c1][sub]
                        hit = hit[np.isin(hit, bunker_ids)]
                        match = int(np.bincount(hit).argmax()) if len(hit) else None
                        in_course = lb[int(cy), int(cx)] != 0
                        f["match"] = match if match and (hit == match).sum() >= 0.3 * sub.sum() else None
                        f["in_course"] = bool(in_course)
                        # outline: iso-line of the smoothed NDVI round this piece, in metres
                        ox, oy = T * (col - HALO + c0, row - HALO + r0)
                        to_m = lambda r, c, ox=ox, oy=oy: (ox + (c + 0.5) * mpp, oy - (r + 0.5) * mpp)
                        local = np.where(ndimage.binary_dilation(sub, iterations=3), nd[r0:r1, c0:c1], t_ndvi + 1)
                        polys = iso_polygons(local, t_ndvi, to_m)
                        f["poly"] = max(polys, key=lambda q: q.area) if polys else None
                        f["road"] = (f["poly"].intersection(roads).area / f["poly"].area
                                     if f["poly"] is not None and roads is not None and f["poly"].area else 0.0)
                        pieces.append(f)
                        for name, rule in RULES.items():
                            if rule(f) and f["match"]:
                                found_by_rule[name].add(f["match"])
        res = {"site": site[:8], "tNdvi": round(t_ndvi, 3), "drawn": len(drawn_idx)}
        for name, rule in RULES.items():
            kept = [f for f in pieces if rule(f) and f["in_course"]]
            tp = sum(1 for f in kept if f["match"])
            res[name] = dict(recall=len(found_by_rule[name] & drawn_idx) / max(len(drawn_idx), 1),
                             precision=tp / max(len(kept), 1), kept=len(kept), falsePos=len(kept) - tp)
        edges = []
        for f in pieces:
            if f["match"] and f["poly"] is not None and RULES["+ lidar hollow"](f):
                g = drawn.get(feats_json[f["match"]]["id"])
                if g is not None:
                    edges.append(edge_distance(f["poly"], g))
        res["edgeMedianM"] = float(np.median(edges)) if edges else None
        res["edgeShareUnder25cm"] = float(np.mean(np.array(edges) < 0.25)) if edges else None
        summary.append(res)
        print(json.dumps(res))
        (OUT / f"pieces-{site[:8]}.json").write_text(json.dumps(
            [{k: v for k, v in f.items() if k not in ("poly", "rows", "cols")} | {"wkt": f["poly"].wkt}
             for f in pieces if f["poly"] is not None and f["in_course"] and f["area"] >= 2.0]))
        write_overlay(site, pieces, drawn_idx, found_by_rule["+ lidar hollow"])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "course.json").write_text(json.dumps(summary, indent=1))


def write_overlay(site: str, pieces, drawn_idx, found) -> None:
    """Quarter-scale photo: green = found and drawn, red = found but not drawn, yellow = drawn but missed."""
    d = SURF / site
    scale = 4
    with rasterio.open(d / "rgbi-2025.tif") as px, rasterio.open(d / "instances.tif") as inst:
        h, w = px.height // scale, px.width // scale
        img = px.read([1, 2, 3], out_shape=(3, h, w), resampling=Resampling.average)
        ins = inst.read(1, out_shape=(h, w), resampling=Resampling.nearest)
        T = px.transform
    img = (img * 0.6).astype(np.uint8)
    missed = np.isin(ins, list(drawn_idx - found))
    img[:, missed] = np.array([255, 220, 0])[:, None]
    from rasterio.features import rasterize
    for f in pieces:
        if f["poly"] is None or not f["in_course"] or not RULES["+ lidar hollow"](f):
            continue
        colour = (60, 230, 60) if f["match"] else (255, 40, 40)
        m = rasterize([(f["poly"].boundary.buffer(0.6), 1)], out_shape=(h, w),
                      transform=T * rasterio.Affine.scale(scale), dtype="uint8").astype(bool)
        img[:, m] = np.array(colour)[:, None]
    with rasterio.open(OUT / f"course-{site[:8]}.png", "w", driver="PNG", width=w, height=h, count=3,
                       dtype="uint8") as dst:
        dst.write(img)


def run_model() -> None:
    """The surface-model pilot's bunkers through the same scoring as `box` and `course`: pilot/pred-<site>.tif band 3
    (each course predicted by the model trained on the other four, 0.32 m). Per box case: the model's bunker piece at
    the box, outlined round its pixels, smoothed, and with its edge redrawn as the NIR + brightness iso-line
    (`model + contour`). Per course: the model's bunker pieces against the drawn bunkers."""
    rows = []
    cache: dict[str, dict] = {}
    for path in sorted(glob.glob(str(SURF / "sam-bench" / "cases" / "*-bunker-*.npz"))):
        z = np.load(path)
        meta = json.loads(str(z["meta"]))
        site = meta["site"]
        drawn = cache.setdefault(site, drawn_polygons(site)).get(meta["id"])
        if drawn is None:
            continue
        cl, cb, cr, ct = meta["crop"]
        h, w = z["truth"].shape
        sx, sy = (cr - cl) / w, (ct - cb) / h
        to_m = lambda r, c: (cl + (c + 0.5) * sx, ct - (r + 0.5) * sy)  # noqa: E731
        x1, y1, x2, y2 = z["box"]
        box_m = Polygon([to_m(y1, x1), to_m(y1, x2), to_m(y2, x2), to_m(y2, x1)])

        def add(method, polys, piece):
            cands = [p.intersection(box_m) for p in polys]
            cands = [p for p in cands if p.area > 0.5]
            if not cands:
                rows.append(dict(method=method, iou=0.0, edge_m=np.nan, area_ratio=0.0))
                return
            best = max(cands, key=lambda p: p.intersection(piece).area if piece is not None else p.area)
            rows.append(dict(method=method, iou=iou(best, drawn), edge_m=edge_distance(best, drawn),
                             area_ratio=best.area / drawn.area))

        with rasterio.open(SURF / "pilot" / f"pred-{site}.tif") as pr:
            cls = pr.read(3, window=from_bounds(cl, cb, cr, ct, pr.transform), out_shape=(h, w), boundless=True,
                          fill_value=0, resampling=Resampling.nearest)
        lab, n = ndimage.label(cls == BUNKER)
        centre = lab[int(y1 + (y2 - y1) / 4):int(y2 - (y2 - y1) / 4), int(x1 + (x2 - x1) / 4):int(x2 - (x2 - x1) / 4)]
        counts = np.bincount(centre.ravel(), minlength=n + 1)
        counts[0] = 0
        if not n or counts.max() == 0:
            for m in ("model pixels", "model smoothed", "model + contour"):
                rows.append(dict(method=m, iou=0.0, edge_m=np.nan, area_ratio=0.0))
            continue
        comp = lab == counts.argmax()
        piece = iso_polygons(np.where(comp, 0.0, 1.0), 0.999, to_m)
        piece = max(piece, key=lambda p: p.area) if piece else None
        add("model pixels", iso_polygons(np.where(comp, 0.0, 1.0), 0.999, to_m), piece)
        add("model smoothed", iso_polygons(1 - ndimage.gaussian_filter(comp.astype(np.float32), 1.5), 0.5, to_m),
            piece)
        rgb, nir = z["rgb"], z["nir"]
        idx = ndimage.gaussian_filter(ndvi(rgb[..., 0], nir) - 0.5 * rgb.astype(np.float32).mean(-1) / 255, SMOOTH_PX)
        one_m = max(int(round(1.0 / meta["mPerPx"])), 1)
        core = ndimage.binary_erosion(comp, iterations=1)
        ring = ndimage.binary_dilation(comp, iterations=3 * one_m) & ~ndimage.binary_dilation(comp, iterations=one_m)
        if core.any() and ring.any():
            sand, grass = np.median(idx[core]), np.median(idx[ring])
            region = ndimage.binary_dilation(comp, iterations=one_m)
            local = np.where(region, idx, grass + abs(grass - sand) + 1)
            add("model + contour", iso_polygons(local, sand + 0.3 * (grass - sand), to_m), piece)
        else:
            add("model + contour", [piece] if piece is not None else [], piece)
    lines = ["| method | n | mean IoU | median edge (m) | mean edge (m) | share < 0.25 m | median area / drawn |",
             "|---|---|---|---|---|---|---|"]
    for m in dict.fromkeys(r["method"] for r in rows):
        sel = [r for r in rows if r["method"] == m]
        e = np.array([r["edge_m"] for r in sel])
        lines.append(f"| {m} | {len(sel)} | {np.mean([r['iou'] for r in sel]):.3f} | {np.nanmedian(e):.3f} | "
                     f"{np.nanmean(e):.3f} | {np.mean(e < 0.25):.0%} | "
                     f"{np.median([r['area_ratio'] for r in sel]):.2f} |")
    lines += ["", "| site | drawn | model found | model false finds |", "|---|---|---|---|"]
    for site in sorted(p.parent.name for p in SURF.glob("*/ready.json")):
        feats = {f["idx"]: f for f in json.loads((SURF / site / "features.json").read_text())}
        with rasterio.open(SURF / "pilot" / f"pred-{site}.tif") as pr, \
                rasterio.open(SURF / site / "instances.tif") as inst, rasterio.open(SURF / site / "labels.tif") as lb:
            cls = pr.read(3)
            win = from_bounds(*pr.bounds, inst.transform)
            ins = inst.read(1, window=win, out_shape=cls.shape, boundless=True, fill_value=0,
                            resampling=Resampling.nearest)
            labs = lb.read(1, window=win, out_shape=cls.shape, boundless=True, fill_value=0,
                           resampling=Resampling.nearest)
            px_area = pr.res[0] * pr.res[1]
        bunker_ids = {i for i, f in feats.items() if f["type"] == "bunker"}
        drawn_here = set(np.unique(ins[np.isin(ins, list(bunker_ids))]).tolist())
        lab, n = ndimage.label(cls == BUNKER, structure=np.ones((3, 3)))
        found, false = set(), 0
        for k, sl in enumerate(ndimage.find_objects(lab), start=1):
            sub = lab[sl] == k
            if sub.sum() * px_area < 2.0:
                continue
            ys, xs = np.nonzero(sub)
            if labs[sl][int(ys.mean()), int(xs.mean())] == 0:
                continue  # outside the drawn course: unknown
            hit = ins[sl][sub]
            hit = hit[np.isin(hit, list(bunker_ids))]
            if len(hit) and np.bincount(hit).max() >= 0.3 * sub.sum():
                found.add(int(np.bincount(hit).argmax()))
            else:
                false += 1
        lines.append(f"| {site[:8]} | {len(drawn_here)} | {len(found & drawn_here)} | {false} |")
    text = "\n".join(lines)
    (OUT / "model.md").write_text(text + "\n")
    print(text)


GRID = {
    "lum": [0.42, 0.5, 0.55, 0.6, 0.65],
    "warm": [-1.0, 0.0, 0.02, 0.04, 0.06],
    "tex": [1.0, 0.12, 0.09, 0.07],
    "hollow": [-1.0, 0.0, 0.02, 0.04, 0.06],
    "road": [1.01, 0.3],
}


def keep_piece(f, r) -> bool:
    return (f["area"] >= 2.0 and f["elong"] < 6 and f["lum"] >= r["lum"] and f["warm"] >= r["warm"]
            and f["tex"] <= r["tex"] and (f["hollow"] >= r["hollow"] if np.isfinite(f["hollow"]) else r["hollow"] < 0)
            and f["road"] <= r["road"])


def counts(pieces, drawn_n, r):
    kept = [f for f in pieces if keep_piece(f, r)]
    found = {f["match"] for f in kept if f["match"]}
    tp = sum(1 for f in kept if f["match"])
    return len(found), drawn_n - len(found), len(kept) - tp


def run_rules() -> None:
    """Leave one course out: the thresholds that score best (F1) on four courses, tested on the fifth. Once with the
    lidar hollow test allowed, once without (photo + NIR only)."""
    course = {r["site"]: r for r in json.loads((OUT / "course.json").read_text())}
    data = {s: json.loads((OUT / f"pieces-{s}.json").read_text()) for s in course}
    combos = [dict(zip(GRID, v)) for v in np.array(np.meshgrid(*GRID.values()), dtype=object).T.reshape(-1, len(GRID))]
    lines = ["| held out | input | aim | drawn | found | missed | false finds | rule (from the other four) |",
             "|---|---|---|---|---|---|---|---|"]

    def f1(tp, fn, fp):
        return 2 * tp / max(2 * tp + fn + fp, 1)

    def recall_first(tp, fn, fp):  # find >= 90 % on the training courses, then as few false finds as possible
        recall = tp / max(tp + fn, 1)
        return 1e6 - fp if recall >= 0.90 else recall * 1e3 - fp * 1e-3

    variants = (("photo + NIR", "F1", lambda r: r["hollow"] < 0, f1), ("+ lidar", "F1", lambda r: True, f1),
                ("+ lidar", "find all", lambda r: True, recall_first))
    for variant, aim, allowed, objective in variants:
        for held in course:
            best, best_score = None, -np.inf
            for r in filter(allowed, combos):
                tp = fn = fp = 0
                for s in course:
                    if s == held:
                        continue
                    a, b, c = counts(data[s], course[s]["drawn"], r)
                    tp, fn, fp = tp + a, fn + b, fp + c
                score = objective(tp, fn, fp)
                if score > best_score:
                    best, best_score = r, score
            a, b, c = counts(data[held], course[held]["drawn"], best)
            rule = ", ".join(f"{k} {'<=' if k in ('tex', 'road') else '>='} {v:g}" for k, v in best.items()
                             if not (k in ("warm", "hollow") and v < 0) and not (k == "tex" and v >= 1)
                             and not (k == "road" and v > 1))
            lines.append(f"| {held} | {variant} | {aim} | {course[held]['drawn']} | {a} | {b} | {c} | {rule} |")
    text = "\n".join(lines)
    (OUT / "rules.md").write_text(text + "\n")
    print(text)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("what", choices=["box", "course", "rules", "model"])
    ap.add_argument("--site", action="append")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.what == "box":
        run_box()
    elif args.what == "rules":
        run_rules()
    elif args.what == "model":
        run_model()
    else:
        run_course(args.site or sorted(p.parent.name for p in SURF.glob("*/ready.json")))


if __name__ == "__main__":
    main()
