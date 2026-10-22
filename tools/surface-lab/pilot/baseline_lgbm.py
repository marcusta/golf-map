"""Cheap baseline: LightGBM per pixel on hand-made multiscale features, leave-one-course-out.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/baseline_lgbm.py --holdout Vreta [--inputs rgbnd]
    ... --holdout all                    # every cached site in turn

Features at 0.32 m (per-site standardised photo bands):
  rgb   : R, G, B, brightness, excess green (2G-R-B); Gaussian means of brightness and ExG at sigma 2/6/16 px
          (0.64/1.9/5.1 m); local std of brightness at the same scales
  rgbn  : + NIR, NDVI; Gaussian means of NIR and NDVI, local std of NDVI
  rgbnd : + relief_2m, relief_10m, slope_deg, slope smoothed at sigma 6
Training rows: up to 25 000 random drawn pixels per class per site (sampled once, cached in pilot/lgbm/).
Writes runs/lgbm-<inputs>/<site>.json + -pred.npz like train.py.
"""
from __future__ import annotations

import argparse
import time

import numpy as np
from scipy import ndimage

from common import DEM_SCALE, IGNORE, OUT, SITES, TRAIN_CLASSES, Site, cached_sites, write_json

NCLS = len(TRAIN_CLASSES)
SIGMAS = (2, 6, 16)
MARGIN = 48
STRIP = 768
PER_CLASS = 25_000

NAMES = (["R", "G", "B", "bright", "exg"] + [f"bright_g{s}" for s in SIGMAS] + [f"exg_g{s}" for s in SIGMAS]
         + [f"bright_sd{s}" for s in SIGMAS]
         + ["nir", "ndvi"] + [f"nir_g{s}" for s in SIGMAS] + [f"ndvi_g{s}" for s in SIGMAS]
         + [f"ndvi_sd{s}" for s in SIGMAS]
         + ["relief2", "relief10", "slope", "slope_g6"])
GROUP = {n: ("rgb" if i < 14 else "nir" if i < 25 else "dem") for i, n in enumerate(NAMES)}
SETS = {"rgb": ["rgb"], "rgbn": ["rgb", "nir"], "rgbnd": ["rgb", "nir", "dem"]}


def cols(inputs: str) -> list[int]:
    return [i for i, n in enumerate(NAMES) if GROUP[n] in SETS[inputs]]


def strip_features(site: Site, r0: int, r1: int) -> np.ndarray:
    """(F, r1-r0, W) float32 for rows r0:r1 (computed on a window with MARGIN rows either side)."""
    H, W = site.shape
    a, b = max(r0 - MARGIN, 0), min(r1 + MARGIN, H)
    raw = np.asarray(site.rgbi[:, a:b], dtype=np.float32)
    st = site.meta["photoStats"]
    z = (raw - np.array(st["mean"], np.float32)[:, None, None]) / np.array(st["std"], np.float32)[:, None, None]
    bright = z[:3].mean(0)
    exg = 2 * z[1] - z[0] - z[2]
    ndvi = (raw[3] - raw[0]) / (raw[3] + raw[0] + 1.0)
    out = [z[0], z[1], z[2], bright, exg]

    def g(x, s):
        return ndimage.gaussian_filter(x, s, mode="reflect")

    def sd(x, s):
        m = g(x, s)
        return np.sqrt(np.maximum(g(x * x, s) - m * m, 0))

    out += [g(bright, s) for s in SIGMAS] + [g(exg, s) for s in SIGMAS] + [sd(bright, s) for s in SIGMAS]
    out += [z[3], ndvi] + [g(z[3], s) for s in SIGMAS] + [g(ndvi, s) for s in SIGMAS] + [sd(ndvi, s) for s in SIGMAS]
    dem = np.asarray(site.dem[:, a:b], dtype=np.float32) / DEM_SCALE[:, None, None]
    out += [dem[0], dem[1], dem[2], g(dem[2], 6)]
    f = np.stack(out).astype(np.float32)
    return f[:, r0 - a:r0 - a + (r1 - r0)]


def site_samples(site: Site, seed=0):
    path = OUT / "lgbm" / f"{site.id}-samples.npz"
    if path.exists():
        d = np.load(path)
        return d["X"], d["y"]
    rng = np.random.default_rng(seed)
    t = site.target
    pick = np.zeros(t.shape, dtype=bool)
    for c in range(NCLS):
        rr, cc = np.nonzero(t == c)
        if rr.size == 0:
            continue
        k = rng.choice(rr.size, min(PER_CLASS, rr.size), replace=False)
        pick[rr[k], cc[k]] = True
    Xs, ys = [], []
    for r0 in range(0, t.shape[0], STRIP):
        r1 = min(r0 + STRIP, t.shape[0])
        m = pick[r0:r1]
        if not m.any():
            continue
        f = strip_features(site, r0, r1)
        Xs.append(f[:, m].T)
        ys.append(t[r0:r1][m])
    X, y = np.concatenate(Xs), np.concatenate(ys)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, X=X, y=y)
    return X, y


def predict_site(model, site: Site, inputs: str):
    t = site.target
    H, W = t.shape
    pred = np.full((H, W), IGNORE, dtype=np.uint8)
    conf = np.zeros((H, W), dtype=np.uint8)
    cs = cols(inputs)
    for r0 in range(0, H, STRIP):
        r1 = min(r0 + STRIP, H)
        m = t[r0:r1] != IGNORE
        if not m.any():
            continue
        f = strip_features(site, r0, r1)[cs][:, m].T
        p = model.predict_proba(f)
        pr = pred[r0:r1]
        cf = conf[r0:r1]
        pr[m] = p.argmax(1)
        cf[m] = np.round(p.max(1) * 255)
    return pred, conf


def run(hold: str, inputs: str) -> None:
    import lightgbm as lgb
    from metrics import evaluate

    test = Site(hold)
    train = [Site(s) for s in cached_sites() if s != hold]
    t0 = time.time()
    data = [site_samples(s) for s in train]
    X = np.concatenate([d[0] for d in data])[:, cols(inputs)]
    y = np.concatenate([d[1] for d in data])
    print(f"[lgbm-{inputs}] hold out {test.name}: {X.shape[0]} rows x {X.shape[1]} features "
          f"({time.time() - t0:.0f} s)", flush=True)
    t1 = time.time()
    model = lgb.LGBMClassifier(objective="multiclass", n_estimators=200, num_leaves=63, learning_rate=0.1,
                               min_child_samples=100, subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
                               n_jobs=16, verbose=-1)
    model.fit(X, y)
    # LightGBM only knows the classes it saw; map back to train indices
    classes = model.classes_
    train_s = time.time() - t1
    t2 = time.time()
    pred, conf = predict_site(model, test, inputs)
    pred = np.where(pred == IGNORE, IGNORE, classes[np.minimum(pred, len(classes) - 1)]).astype(np.uint8)
    infer_s = time.time() - t2
    res = evaluate(pred, np.array(test.target), np.array(test.inst), test.features)
    res.update({"holdout": hold, "name": test.name, "inputs": inputs, "model": "lightgbm", "train_s": train_s,
                "infer_s": infer_s, "trainSites": [s.name for s in train], "rows": int(X.shape[0])})
    d = OUT / "runs" / f"lgbm-{inputs}"
    write_json(d / f"{test.name}.json", res)
    np.savez_compressed(d / f"{test.name}-pred.npz", pred=pred, conf=conf)
    print(f"  trained {train_s:.0f} s, predicted {infer_s:.0f} s", flush=True)
    print("  IoU " + " ".join(f"{k}={v:.2f}" for k, v in res["iou"].items() if v is not None), flush=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--holdout", required=True)
    ap.add_argument("--inputs", default="rgbnd", choices=list(SETS))
    a = ap.parse_args()
    holds = cached_sites() if a.holdout == "all" else [k for k, v in SITES.items() if a.holdout in (k, v)]
    for h in holds:
        run(h, a.inputs)


if __name__ == "__main__":
    main()
