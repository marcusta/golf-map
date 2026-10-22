"""Furniture-seeded test cases: what the hole's furniture (tee markers, green points, pins, aim points) tells a Draw
tool before anything is drawn. One .npz per case, the same layout as sam_cases.py plus the furniture prompts.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/furniture_cases.py [--site <siteId>...]

Per hole of every course on a prepared site (data/app.sqlite read-only):
- tee      each drawn tee holding a tee marker; the marker is the prompt
- green    the drawn green holding the green centre; centre, front, back and the pins are the prompts
- fairway  the hole's drawn fairways; aim points are the positive prompts, the green centre and tee markers negative
`box` is a hand box round the drawn shape (padded 3-15 % per side, as in sam_cases.py) for the comparison;
`fbox` is a box from furniture alone (green: round the centre out to front/back + 3 m; fairway: the aim points + 25 m).
The crop is set by the furniture (and the box), never by the drawn shape alone.
Writes data/experiments/surfaces/furniture-bench/cases/<site8>-<kind>-<hole>-<n>.npz with rgb, nir, dem (5 bands:
the dem itself first, then relief_2m, relief_10m, slope_deg, hillshade), truth, labels, box, fbox, pos, neg, meta.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform
from rasterio.windows import from_bounds

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sam_cases as S  # noqa: E402

REPO = HERE.parents[1]
SURF = REPO / "data" / "experiments" / "surfaces"
OUT = SURF / "furniture-bench" / "cases"


def to3006(lons, lats):
    xs, ys = transform("EPSG:4326", "EPSG:3006", list(lons), list(lats))
    return list(zip(xs, ys))


def furniture(db, course_id):
    holes = {}
    for hid, num in db.execute("select id, number from holes where course_id = ?", (course_id,)):
        holes[hid] = {"number": num, "tees": [], "aims": [], "green": None, "pins": []}
    for hid, lat, lon in db.execute("select hole_id, lat, lon from tees"):
        if hid in holes:
            holes[hid]["tees"].append((lon, lat))
    for hid, lat, lon in db.execute("select hole_id, lat, lon from aim_points order by sort_order"):
        if hid in holes:
            holes[hid]["aims"].append((lon, lat))
    for gid, hid, *pts in db.execute("select id, hole_id, center_lon, center_lat, front_lon, front_lat, back_lon, "
                                     "back_lat from greens"):
        if hid in holes:
            holes[hid]["green"] = [(pts[i], pts[i + 1]) for i in (0, 2, 4) if pts[i] is not None]
            holes[hid]["pins"] = [(lon, lat) for lon, lat in db.execute(
                "select lon, lat from pins where green_id = ?", (gid,))]
    for h in holes.values():
        for k in ("tees", "aims", "green", "pins"):
            h[k] = to3006(*zip(*h[k])) if h[k] else []
    return holes


def jitter_box(b, rng):
    l, bo, r, t = b
    w, h = r - l, t - bo
    p = rng.uniform(0.03, 0.15, size=4) * np.array([w, h, w, h]) + 0.5
    return (l - p[0], bo - p[1], r + p[2], t + p[3])


def px_of(pts, crop, size_px):
    cl, cb, cr, ct = crop
    sx, sy = size_px[1] / (cr - cl), size_px[0] / (ct - cb)
    return np.array([[(x - cl) * sx, (ct - y) * sy] for x, y in pts], dtype=np.float32).reshape(-1, 2)


def cases_for_site(site: str, rng) -> int:
    d = SURF / site
    feats = {f["idx"]: f for f in json.loads((d / "features.json").read_text())}
    db = sqlite3.connect(f"file:{REPO / 'data' / 'app.sqlite'}?mode=ro", uri=True)
    courses = [r for r in json.loads((SURF / "courses.json").read_text()) if r["siteId"] == site]
    n = 0
    with rasterio.open(d / "rgbi-2025.tif") as rgbi, rasterio.open(d / "instances.tif") as inst, \
            rasterio.open(d / "labels.tif") as lab, rasterio.open(d / "dem-layers.tif") as dem:
        res = rgbi.res[0]

        def instance_at(x, y):
            r, c = rgbi.index(x, y)
            if not (0 <= r < rgbi.height and 0 <= c < rgbi.width):
                return 0
            return int(inst.read(1, window=((r, r + 1), (c, c + 1)))[0, 0])

        def drawn_extent(idxs, around, radius):
            """Visible extent of features `idxs` within `radius` m of `around` (left, bottom, right, top) or None."""
            x, y = around
            win = from_bounds(x - radius, y - radius, x + radius, y + radius, rgbi.transform)
            a = inst.read(1, window=win, boundless=True, fill_value=0)
            m = np.isin(a, list(idxs))
            if not m.any():
                return None
            rows, cols = np.nonzero(m)
            t = rasterio.windows.transform(win, rgbi.transform)
            l, top = t * (cols.min(), rows.min())
            r, bot = t * (cols.max() + 1, rows.max() + 1)
            return (l, bot, r, top)

        def write(name, kind, box_m, frame_m, truth_idx, pos, neg, fbox_m, meta):
            nonlocal n
            l = min(box_m[0], frame_m[0]); b = min(box_m[1], frame_m[1])
            r = max(box_m[2], frame_m[2]); t = max(box_m[3], frame_m[3])
            crop, size_px, mpp = S.crop_frame((l, b, r, t), res)
            px, ins, lb, dl = S.read_crop(rgbi, inst, lab, dem, crop, size_px)
            raw = dem.read(1, window=from_bounds(*crop, dem.transform), out_shape=size_px, boundless=True,
                           fill_value=np.nan, resampling=Resampling.bilinear).astype(np.float32)
            OUT.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(OUT / f"{name}.npz", rgb=np.moveaxis(px[:3], 0, -1), nir=px[3],
                                dem=np.concatenate([raw[None], dl]), truth=np.isin(ins, list(truth_idx)), labels=lb,
                                box=S.box_px(box_m, crop, size_px),
                                fbox=S.box_px(fbox_m, crop, size_px) if fbox_m else np.zeros(4, np.float32),
                                pos=px_of(pos, crop, size_px), neg=px_of(neg, crop, size_px),
                                meta=json.dumps(meta | {"site": site, "kind": "object", "type": kind, "mPerPx": mpp,
                                                        "crop": crop}))
            n += 1

        for course in courses:
            for hid, h in furniture(db, course["courseId"]).items():
                hn = h["number"]
                hole_feats = {i: f for i, f in feats.items() if f["holeId"] == hid}
                # tees: one case per drawn tee holding a marker
                seen = set()
                for tx, ty in h["tees"]:
                    i = instance_at(tx, ty)
                    if not i or feats[i]["type"] != "tee" or i in seen:
                        continue
                    seen.add(i)
                    ext = drawn_extent({i}, (tx, ty), 40)
                    if ext is None:
                        continue
                    markers = [(x, y) for x, y in h["tees"] if instance_at(x, y) == i]
                    write(f"{site[:8]}-tee-{hn:02d}-{len(seen)}", "tee", jitter_box(ext, rng),
                          (tx - 12, ty - 12, tx + 12, ty + 12), {i}, markers, [], None, {"hole": hn})
                # green: the drawn green holding the centre
                if h["green"]:
                    cx, cy = h["green"][0]
                    i = instance_at(cx, cy)
                    if i and feats[i]["type"] == "green":
                        ext = drawn_extent({i}, (cx, cy), 60)
                        rad = max([np.hypot(x - cx, y - cy) for x, y in h["green"][1:]] + [8.0]) + 3.0
                        fbox = (cx - rad, cy - rad, cx + rad, cy + rad)
                        if ext:
                            write(f"{site[:8]}-green-{hn:02d}-1", "green", jitter_box(ext, rng), fbox, {i},
                                  h["green"] + h["pins"], [], fbox, {"hole": hn, "pins": len(h["pins"])})
                # fairway: the hole's drawn fairways, aim points as prompts
                fw = {i for i, f in hole_feats.items() if f["type"] == "fairway"}
                aims = [p for p in h["aims"] if instance_at(*p) in fw]
                if fw and aims:
                    ax = [p[0] for p in aims]
                    ay = [p[1] for p in aims]
                    fbox = (min(ax) - 25, min(ay) - 25, max(ax) + 25, max(ay) + 25)
                    centre = (np.mean(ax), np.mean(ay))
                    ext = drawn_extent(fw, centre, 350)
                    if ext:
                        neg = ([h["green"][0]] if h["green"] else []) + h["tees"]
                        write(f"{site[:8]}-fairway-{hn:02d}-1", "fairway", jitter_box(ext, rng), fbox, fw, aims,
                              neg, fbox, {"hole": hn, "aims": len(aims), "aimsAll": len(h["aims"])})
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", action="append")
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    sites = args.site or sorted(p.parent.name for p in SURF.glob("*/ready.json"))
    for site in sites:
        print(f"{site}: {cases_for_site(site, rng)} cases", flush=True)


if __name__ == "__main__":
    main()
