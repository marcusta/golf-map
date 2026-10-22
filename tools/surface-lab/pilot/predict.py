"""Re-run inference of a saved model (runs/<tag>/<Site>.pt, written by train.py for rgbnd runs) with other tiling.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/predict.py --tag loco-r34-rgbnd-bg-s1 --tile 1024 --margin 192 [--site Vreta]

Writes runs/<tag>-t<tile>/<Site>.json + -pred.npz (same layout as train.py; train_s copied from the source run).
Bigger tiles give the network more context in wide uniform areas (a big lake) and fewer tile seams.
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np

from common import INPUT_SETS, OUT, SITES, Site, write_json


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--tile", type=int, default=1024)
    ap.add_argument("--margin", type=int, default=192)
    ap.add_argument("--site", action="append")
    a = ap.parse_args()

    import torch
    from gpulock import gpu_lock
    from metrics import evaluate
    from train import build_model, predict

    src = OUT / "runs" / a.tag
    dst = OUT / "runs" / f"{a.tag}-t{a.tile}"
    for sid, name in SITES.items():
        if a.site and name not in a.site and sid not in a.site:
            continue
        pt = src / f"{name}.pt"
        if not pt.exists():
            continue
        meta = json.loads((src / f"{name}.json").read_text())
        sd = {k: v.float() for k, v in torch.load(pt, map_location="cpu").items()}
        ncls = sd["segmentation_head.0.weight"].shape[0]
        spec = INPUT_SETS[meta["inputs"]]
        model = build_model(len(spec["photo"]) + len(spec["dem"]), meta["encoder"], weights=None, ncls=ncls)
        model.load_state_dict(sd)
        site = Site(sid)
        with gpu_lock("surface-pilot"):
            model = model.cuda()
            t0 = time.time()
            pred, conf, pred_auto, conf_auto = predict(model, site, meta["inputs"], tile=a.tile, margin=a.margin)
            infer_s = time.time() - t0
            model.cpu()
        gt = np.array(site.target)
        res = evaluate(pred, gt, np.array(site.inst), site.features)
        if ncls > 10:
            res["auto"] = evaluate(pred_auto, gt, np.array(site.inst), site.features, boundaries=False)
        keep = {k: meta[k] for k in ("holdout", "name", "inputs", "encoder", "iters", "bs", "patch", "trainSites",
                                     "train_s", "inferMpx", "bg") if k in meta}
        res.update(keep | {"infer_s": infer_s, "tile": a.tile, "margin": a.margin, "source": a.tag})
        write_json(dst / f"{name}.json", res)
        extra = {"pred_auto": pred_auto, "conf_auto": conf_auto} if ncls > 10 else {}
        np.savez_compressed(dst / f"{name}-pred.npz", pred=pred, conf=conf, **extra)
        print(f"{name}: {infer_s:.0f} s, mIoU {res['iou']['mIoU']:.3f} (was {meta['iou']['mIoU']:.3f}), "
              f"water {res['iou']['water']}", flush=True)


if __name__ == "__main__":
    main()
