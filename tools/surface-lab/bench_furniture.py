"""Furniture-seeded Draw bench: SAM prompted by the hole's furniture against the box + type tool, on the same crops
(furniture_cases.py).

    tools/sam-server/venv/Scripts/python.exe tools/surface-lab/bench_furniture.py [--model sam2.1_l] [--sheets 2]

Prompts per case (rgb photo):
  box        the box + type tool from bench_sam.py (`auto`: the type's mask order, the first that stays in the box)
  furn       furniture points only: tee markers / green centre, front, back, pins / aim points (+ the green and tee
             markers as negative points for a fairway)
  fbox+furn  furniture points + a box built from furniture alone (green: centre out to front/back + 3 m;
             fairway: aim points + 25 m)
  box+furn   the hand box + furniture points
  plane      tees only, no photo: the lidar ground grown out from the tee marker while it stays on the plane fitted
             round the marker (a tee is a flat built pad)
  furn&plane tees only: the furniture mask cut to the plane grown 1 m wider
Writes data/experiments/surfaces/furniture-bench/results.csv, summary.md, sheets/.
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bench_sam as B  # noqa: E402
from gpulock import gpu_lock  # noqa: E402

REPO = HERE.parents[1]
BENCH = REPO / "data" / "experiments" / "surfaces" / "furniture-bench"


def load(path: str) -> dict:
    z = np.load(path)
    c = {k: z[k] for k in ("rgb", "nir", "truth", "labels", "box", "fbox", "pos", "neg")}
    c["raw_dem"] = z["dem"][0]
    c["dem"] = z["dem"][1:]  # the 4 bands bench_sam expects
    c["meta"] = json.loads(str(z["meta"]))
    c["name"] = Path(path).stem
    return c


def sam_points(pred, shape, pos, neg, box=None) -> np.ndarray:
    pts = [list(map(float, p)) for p in pos] + [list(map(float, p)) for p in neg]
    labels = [1] * len(pos) + [0] * len(neg)
    kw = dict(points=[pts], labels=[labels])
    if box is not None:
        kw["bboxes"] = [list(map(float, box))]
    m, _ = pred.inference_features(pred.features, src_shape=shape, **kw)
    return m[0].cpu().numpy() if m is not None else np.zeros(shape, bool)


def plane_mask(dem: np.ndarray, seeds: np.ndarray, mpp: float, fit_r=3.0, tol=0.07, max_r=30.0) -> np.ndarray:
    """Ground on the plane fitted within fit_r of the tee markers, connected to them, within max_r."""
    h, w = dem.shape
    yy, xx = np.mgrid[0:h, 0:w]
    sx, sy = seeds[:, 0].mean(), seeds[:, 1].mean()
    d = np.hypot(xx - sx, yy - sy) * mpp
    fit = (d <= fit_r) & np.isfinite(dem)
    if fit.sum() < 6:
        return np.zeros(dem.shape, bool)
    A = np.c_[xx[fit], yy[fit], np.ones(fit.sum())]
    coef, *_ = np.linalg.lstsq(A, dem[fit], rcond=None)
    plane = coef[0] * xx + coef[1] * yy + coef[2]
    on = (np.abs(np.nan_to_num(dem, nan=1e9) - plane) < tol) & (d <= max_r)
    on = cv2.morphologyEx(on.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)
    n, comp = cv2.connectedComponents(on.astype(np.uint8))
    ids = {int(comp[int(round(y)), int(round(x))]) for x, y in seeds if 0 <= int(y) < h and 0 <= int(x) < w}
    ids.discard(0)
    out = np.isin(comp, list(ids)) if ids else np.zeros(dem.shape, bool)
    filled = out.astype(np.uint8)
    cnts, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(filled, cnts, -1, 1, thickness=cv2.FILLED)
    return filled.astype(bool)


def sheet(path: Path, c, masks: dict) -> None:
    tiles = []
    for name, m in [("drawn (white)", None)] + list(masks.items()):
        p = np.ascontiguousarray(c["rgb"].copy())
        cnts, _ = cv2.findContours(c["truth"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(p, cnts, -1, (255, 255, 255), 2)
        if m is not None:
            cnts, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(p, cnts, -1, (255, 50, 50), 2)
        for x, y in c["pos"]:
            cv2.circle(p, (int(x), int(y)), 5, (60, 255, 60), -1)
        for x, y in c["neg"]:
            cv2.circle(p, (int(x), int(y)), 5, (255, 60, 255), -1)
        p = cv2.resize(p, (360, int(360 * p.shape[0] / p.shape[1])))
        cv2.putText(p, name, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3)
        cv2.putText(p, name, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        tiles.append(p)
    hgt = max(t.shape[0] for t in tiles)
    tiles = [np.pad(t, ((0, hgt - t.shape[0]), (0, 0), (0, 0))) for t in tiles]
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(np.hstack(tiles), cv2.COLOR_RGB2BGR))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="sam2.1_l")
    ap.add_argument("--sheets", type=int, default=2, help="contact sheets per type and site")
    args = ap.parse_args()
    paths = sorted(glob.glob(str(BENCH / "cases" / "*.npz")))
    rows, done = [], {}
    with gpu_lock("furniture-bench"):
        pred = B.load_predictor(args.model)
        t0 = time.time()
        for p in paths:
            c = load(p)
            t, shape = c["meta"]["type"], c["truth"].shape
            inside = B.box_mask(shape, c["box"])
            shown, _threes, _picked = B.case_masks(pred, c, B.make_images(c))
            masks = {"box": shown["auto"]}
            pred.set_image(np.ascontiguousarray(c["rgb"][..., ::-1]))
            masks["furn"] = sam_points(pred, shape, c["pos"], c["neg"])
            if c["fbox"].any():
                masks["fbox+furn"] = sam_points(pred, shape, c["pos"], c["neg"], c["fbox"])
            masks["box+furn"] = sam_points(pred, shape, c["pos"], c["neg"], c["box"])
            if t == "green":  # front and back sit on the green's edge: the centre (and pins) alone
                pins = c["meta"].get("pins", 0)
                inner = np.vstack([c["pos"][:1]] + ([c["pos"][-pins:]] if pins else []))
                masks["centre+pins"] = sam_points(pred, shape, inner, c["neg"])
            if t == "fairway" and len(c["neg"]):  # box from the aim points out to the green centre, + 15 m
                pts = np.vstack([c["pos"], c["neg"][:1]])
                m = 15 / c["meta"]["mPerPx"]
                box2 = [pts[:, 0].min() - m, pts[:, 1].min() - m, pts[:, 0].max() + m, pts[:, 1].max() + m]
                masks["aim-green box+furn"] = sam_points(pred, shape, c["pos"], c["neg"], box2)
            if t == "tee":
                pm = plane_mask(c["raw_dem"], c["pos"], c["meta"]["mPerPx"])
                masks["plane"] = pm
                grown = cv2.dilate(pm.astype(np.uint8), np.ones((2 * int(1 / c["meta"]["mPerPx"]) + 1,) * 2,
                                                                np.uint8)).astype(bool)
                masks["furn&plane"] = masks["furn"] & grown if pm.any() else masks["furn"]
            for name, m in masks.items():
                iou, edge, ratio = B.score(m, c, inside)
                rows.append(dict(case=c["name"], site=c["meta"]["site"][:8], type=t, prompt=name, iou=iou,
                                 edge_m=edge, area_ratio=ratio))
            key = (c["meta"]["site"], t)
            if done.get(key, 0) < args.sheets:
                sheet(BENCH / "sheets" / f"{c['name']}.png", c, masks)
                done[key] = done.get(key, 0) + 1
        print(f"{len(paths)} cases in {time.time() - t0:.0f} s")
    with open(BENCH / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    prompts = list(dict.fromkeys(r["prompt"] for r in rows))
    lines = ["mean IoU (median edge error, m); share of cases with IoU >= 0.8\n",
             "| type | n | " + " | ".join(prompts) + " |", "|" + "---|" * (len(prompts) + 2)]
    for t in dict.fromkeys(r["type"] for r in rows):
        cells = []
        for pr in prompts:
            sel = [r for r in rows if r["type"] == t and r["prompt"] == pr]
            if not sel:
                cells.append("")
                continue
            ious = np.array([r["iou"] for r in sel])
            cells.append(f"{np.nanmean(ious):.2f} ({np.nanmedian([r['edge_m'] for r in sel]):.1f}) "
                         f"{np.mean(ious >= 0.8):.0%}")
        n = len({r["case"] for r in rows if r["type"] == t})
        lines.append(f"| {t} | {n} | " + " | ".join(cells) + " |")
    (BENCH / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
