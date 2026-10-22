"""Metrics on a held-out site, only where something trainable is drawn (target != 255).

- IoU per class from the confusion matrix (+ "roughs" = semi_rough + rough + deep_rough merged, + mIoU over the
  classes drawn on that site).
- Boundary F-score at 0.5 m and 1.0 m: class edge pixels (4-neighbour) of the drawn and the predicted map, counted
  only inside the drawn area shrunk by 2 px (the edge of the drawn area is not a class edge); precision = predicted
  edge within tol of a drawn edge, recall = drawn edge within tol of a predicted edge. Also the median and mean
  distance drawn edge -> nearest predicted edge of that class, in metres.
- Per-feature recall for tee/green/bunker/water: share of drawn features (>= MIN_PX visible pixels at 0.32 m) with
  >= 50 % of their visible pixels predicted as their class.
Open lakes (a water feature > LAKE_HA visible: only Omberg's Vaettern, 33 ha from the map) are left out of the main
numbers; `iouWithLakes` keeps them.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

from common import IGNORE, RES, TRAIN_CLASSES

N = len(TRAIN_CLASSES)
FEATURE_CLASSES = ["tee", "green", "bunker", "water"]
MIN_PX = 4
LAKE_HA = 5.0
CROSS = ndimage.generate_binary_structure(2, 1)
ROUGHS = [TRAIN_CLASSES.index(c) for c in ("semi_rough", "rough", "deep_rough")]


NP = N + 1  # predicted column N = "background" (not course), only from models trained with it


def confusion(pred: np.ndarray, gt: np.ndarray) -> np.ndarray:
    m = gt != IGNORE
    return np.bincount(NP * gt[m].astype(np.int64) + pred[m], minlength=N * NP).reshape(N, NP)


def iou_table(cm: np.ndarray) -> dict:
    tp = np.diag(cm[:, :N]).astype(np.float64)
    gt_n = cm.sum(1)
    pr_n = cm.sum(0)
    res = {}
    for i, c in enumerate(TRAIN_CLASSES):
        res[c] = float(tp[i] / (gt_n[i] + pr_n[i] - tp[i])) if gt_n[i] > 0 else None
    r = ROUGHS
    tp_r = cm[np.ix_(r, r)].sum()
    res["roughs"] = float(tp_r / (cm[r].sum() + cm[:, r].sum() - tp_r)) if cm[r].sum() else None
    present = [res[c] for c in TRAIN_CLASSES if res[c] is not None]
    res["mIoU"] = float(np.mean(present))
    res["pixelAcc"] = float(tp.sum() / cm.sum())
    res["backgroundOnDrawn"] = float(cm[:, N].sum() / cm.sum())
    return res


def _edges(mask: np.ndarray) -> np.ndarray:
    return mask & ~ndimage.binary_erosion(mask, CROSS, border_value=1)


def boundary_scores(pred: np.ndarray, gt: np.ndarray, tols_m=(0.5, 1.0)) -> dict:
    valid = gt != IGNORE
    inner = ndimage.binary_erosion(valid, CROSS, iterations=2, border_value=0)
    out = {}
    for i, c in enumerate(TRAIN_CLASSES):
        g = gt == i
        if g.sum() < 50:
            continue
        p = (pred == i) & valid
        ge = _edges(g) & inner
        pe = _edges(p) & inner
        if ge.sum() == 0:
            continue
        rows = {}
        d_to_pred = ndimage.distance_transform_edt(~pe) * RES if pe.any() else np.full(g.shape, np.inf)
        d_to_gt = ndimage.distance_transform_edt(~ge) * RES
        dg = d_to_pred[ge]
        dp = d_to_gt[pe]
        for t in tols_m:
            rec = float((dg <= t).mean())
            prec = float((dp <= t).mean()) if dp.size else 0.0
            rows[f"F@{t}m"] = 2 * prec * rec / (prec + rec) if prec + rec > 0 else 0.0
        rows["medianEdgeDist_m"] = float(np.median(dg)) if np.isfinite(dg).any() else None
        rows["meanEdgeDist_m"] = float(np.mean(np.minimum(dg, 20.0)))  # capped at 20 m
        out[c] = rows
        del d_to_pred, d_to_gt
    return out


def feature_recall(pred: np.ndarray, gt: np.ndarray, inst: np.ndarray, features: list[dict]) -> dict:
    """pred/gt are train indices; inst the features.json idx raster on the same grid."""
    m = gt != IGNORE
    idx = inst[m].astype(np.int64)
    hit = (pred[m] == gt[m]).astype(np.float64)
    nmax = int(max(f["idx"] for f in features)) + 1
    tot = np.bincount(idx, minlength=nmax)
    hits = np.bincount(idx, weights=hit, minlength=nmax)
    out = {}
    by_cls = {}
    for f in features:
        t = f["type"] if f["type"] != "water_creek" else "water"
        if t not in FEATURE_CLASSES:
            continue
        n = tot[f["idx"]]
        if n < MIN_PX:
            continue
        by_cls.setdefault(t, []).append(hits[f["idx"]] / n)
    for c in FEATURE_CLASSES:
        v = np.array(by_cls.get(c, []))
        out[c] = {"n": int(v.size), "recall50": float((v >= 0.5).mean()) if v.size else None,
                  "meanCover": float(v.mean()) if v.size else None}
    return out


def open_lakes(inst: np.ndarray, features: list[dict]) -> list[int]:
    """idx of water features with more than LAKE_HA visible at 0.32 m (Omberg's Vaettern, from the map)."""
    cnt = np.bincount(inst.ravel())
    return [f["idx"] for f in features if f["type"] == "water" and f["idx"] < len(cnt)
            and cnt[f["idx"]] * RES * RES / 1e4 > LAKE_HA]


def evaluate(pred: np.ndarray, gt: np.ndarray, inst: np.ndarray, features: list[dict], boundaries=True) -> dict:
    """Main numbers leave open lakes (> LAKE_HA) out; "iouWithLakes" keeps them."""
    lakes = open_lakes(inst, features)
    res = {"lakesExcluded": lakes}
    if lakes:
        res["iouWithLakes"] = iou_table(confusion(pred, gt))
        gt = gt.copy()
        gt[np.isin(inst, lakes)] = IGNORE
    cm = confusion(pred, gt)
    res.update({"iou": iou_table(cm), "features": feature_recall(pred, gt, inst, features), "confusion": cm.tolist()})
    if boundaries:
        res["boundary"] = boundary_scores(pred, gt)
    return res
