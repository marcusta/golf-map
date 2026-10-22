"""Score saved predictions again with the current metrics.py (runs/<tag>/<Site>-pred.npz -> <Site>.json).

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/rescore.py [--tags a,b] [--site Omberg]
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from common import OUT, SITES, Site, write_json
from metrics import evaluate

KEEP = ("iou", "iouWithLakes", "features", "confusion", "boundary", "auto", "lakesExcluded")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags")
    ap.add_argument("--site", help="only this site name (e.g. Omberg)")
    a = ap.parse_args()
    tags = a.tags.split(",") if a.tags else None
    by_name = {v: k for k, v in SITES.items()}
    cache = {}
    for d in sorted((OUT / "runs").iterdir()):
        if not d.is_dir() or (tags and d.name not in tags):
            continue
        for js in sorted(d.glob("*.json")):
            r = json.loads(js.read_text())
            if r.get("devSplit") or r["name"] not in by_name or (a.site and r["name"] != a.site):
                continue
            npz = d / f"{r['name']}-pred.npz"
            if not npz.exists():
                continue
            sid = by_name[r["name"]]
            if sid not in cache:
                s = Site(sid)
                cache = {sid: (np.array(s.target), np.array(s.inst), s.features)}
            gt, inst, feats = cache[sid]
            p = np.load(npz)
            res = evaluate(p["pred"], gt, inst, feats)
            if "pred_auto" in p:
                res["auto"] = evaluate(p["pred_auto"], gt, inst, feats, boundaries=False)
            for k in KEEP:
                r.pop(k, None)
            r.update(res)
            write_json(js, r)
            print(f"{d.name}/{r['name']}: mIoU {r['iou']['mIoU']:.3f}", flush=True)


if __name__ == "__main__":
    main()
