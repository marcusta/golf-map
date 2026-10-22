"""Markdown tables of every run in data/experiments/surfaces/pilot/runs/ (printed; pasted into report.md).

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/summarize.py [--tags a,b] [--sites Vreta,Omberg]
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from common import OUT, TRAIN_CLASSES

ORDER = ["Omberg", "Vreta", "Landeryd", "Linkan", "Klinga"]
FULL = ["Omberg", "Vreta", "Landeryd"]  # drawn whole; Linkan and Klinga have some surfaces only


def load(tags=None):
    runs = {}
    for d in sorted((OUT / "runs").iterdir()):
        if not d.is_dir() or (tags and d.name not in tags):
            continue
        for f in d.glob("*.json"):
            r = json.loads(f.read_text())
            runs.setdefault(d.name, {})[r["name"]] = r
    return runs


def fmt(v, pct=True):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "-"
    return f"{v * 100:.0f}" if pct else f"{v:.2f}"


def iou_table(runs: dict, tag: str, sites: list[str]) -> str:
    cols = TRAIN_CLASSES + ["roughs", "mIoU", "pixelAcc"]
    lines = ["| held out | " + " | ".join(cols) + " |", "|---" * (len(cols) + 1) + "|"]
    acc = {c: [] for c in cols}
    for s in sites:
        r = runs[tag].get(s)
        if not r:
            continue
        lines.append(f"| {s} | " + " | ".join(fmt(r["iou"].get(c)) for c in cols) + " |")
        for c in cols:
            if r["iou"].get(c) is not None:
                acc[c].append(r["iou"][c])
    lines.append("| **mean** | " + " | ".join(fmt(np.mean(acc[c])) if acc[c] else "-" for c in cols) + " |")
    full = [runs[tag][s] for s in FULL if s in sites and s in runs[tag]]
    if len(full) == len(FULL):
        cells = []
        for c in cols:
            v = [r["iou"][c] for r in full if r["iou"].get(c) is not None]
            cells.append(fmt(np.mean(v)) if v else "-")
        lines.append("| **mean, whole courses** | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def ablation_table(runs: dict, tags: list[str], sites: list[str], metric="mIoU") -> str:
    lines = ["| model | " + " | ".join(sites) + " | mean | mean whole courses |", "|---" * (len(sites) + 3) + "|"]
    for t in tags:
        vals = [runs.get(t, {}).get(s, {}).get("iou", {}).get(metric) for s in sites]
        ok = [v for v in vals if v is not None]
        okf = [v for s, v in zip(sites, vals) if s in FULL and v is not None]
        lines.append(f"| {t} | " + " | ".join(fmt(v) for v in vals) + f" | {fmt(np.mean(ok)) if ok else '-'} | "
                     f"{fmt(np.mean(okf)) if len(okf) == len(FULL) else '-'} |")
    return "\n".join(lines)


def class_ablation(runs: dict, tags: list[str], sites: list[str]) -> str:
    cols = TRAIN_CLASSES + ["roughs", "mIoU"]
    lines = ["| model (mean IoU over held-out sites) | " + " | ".join(cols) + " |", "|---" * (len(cols) + 1) + "|"]
    for t in tags:
        row = []
        for c in cols:
            v = [runs[t][s]["iou"][c] for s in sites if s in runs.get(t, {}) and runs[t][s]["iou"].get(c) is not None]
            row.append(fmt(np.mean(v)) if v else "-")
        lines.append(f"| {t} | " + " | ".join(row) + " |")
    return "\n".join(lines)


def feature_table(runs: dict, tag: str, sites: list[str]) -> str:
    cls = ["tee", "green", "bunker", "water"]
    lines = ["| held out | " + " | ".join(f"{c} found (n)" for c in cls) + " |", "|---" * (len(cls) + 1) + "|"]
    for s in sites:
        r = runs[tag].get(s)
        if not r:
            continue
        cells = []
        for c in cls:
            v = r["features"].get(c, {})
            cells.append(f"{fmt(v.get('recall50'))} % ({v.get('n', 0)})" if v.get("recall50") is not None else "-")
        lines.append(f"| {s} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def feature_ablation(runs: dict, tags: list[str], sites: list[str]) -> str:
    """Drawn features found, pooled over the held-out sites (found / drawn)."""
    cls = ["tee", "green", "bunker", "water"]
    lines = ["| model | " + " | ".join(f"{c} found" for c in cls) + " |", "|---" * (len(cls) + 1) + "|"]
    for t in tags:
        cells = []
        for c in cls:
            hit = n = 0
            for s in sites:
                v = runs.get(t, {}).get(s, {}).get("features", {}).get(c)
                if v and v.get("recall50") is not None:
                    hit += round(v["recall50"] * v["n"])
                    n += v["n"]
            cells.append(f"{hit}/{n} = {hit / n * 100:.0f} %" if n else "-")
        lines.append(f"| {t} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def boundary_table(runs: dict, tag: str, sites: list[str]) -> str:
    lines = ["| class | " + " | ".join(f"{s} F@0.5m / F@1m / median m" for s in sites) + " |",
             "|---" * (len(sites) + 1) + "|"]
    for c in TRAIN_CLASSES:
        cells = []
        for s in sites:
            b = runs[tag].get(s, {}).get("boundary", {}).get(c)
            cells.append(f"{fmt(b['F@0.5m'])} / {fmt(b['F@1.0m'])} / {b['medianEdgeDist_m']:.1f}" if b else "-")
        lines.append(f"| {c} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def confusion_table(runs: dict, tag: str, sites: list[str]) -> str:
    """Row-normalised confusion summed over the held-out sites (each site's rows weighted equally)."""
    names = TRAIN_CLASSES + ["bg"]
    acc = np.zeros((len(TRAIN_CLASSES), len(names)))
    for s in sites:
        r = runs[tag].get(s)
        if not r:
            continue
        cm = np.array(r["confusion"], dtype=np.float64)
        rows = cm.sum(1, keepdims=True)
        acc += np.divide(cm, rows, out=np.zeros_like(cm), where=rows > 0)
    acc = acc / np.maximum(acc.sum(1, keepdims=True), 1e-9)
    lines = ["| drawn -> predicted | " + " | ".join(names) + " |", "|---" * (len(names) + 1) + "|"]
    for i, c in enumerate(TRAIN_CLASSES):
        lines.append(f"| {c} | " + " | ".join(f"{v * 100:.0f}" if v >= 0.005 else "." for v in acc[i]) + " |")
    return "\n".join(lines)


def times(runs: dict, tags: list[str], sites: list[str]) -> str:
    lines = ["| model | held out | train s | predict s | Mpx predicted |", "|---|---|---|---|---|"]
    for t in tags:
        for s in sites:
            r = runs.get(t, {}).get(s)
            if r:
                lines.append(f"| {t} | {s} | {r['train_s']:.0f} | {r['infer_s']:.0f} | {r.get('inferMpx', 0):.0f} |")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags")
    ap.add_argument("--sites")
    ap.add_argument("--best")
    a = ap.parse_args()
    tags = a.tags.split(",") if a.tags else None
    runs = load(tags)
    tags = tags or list(runs)
    sites = a.sites.split(",") if a.sites else [s for s in ORDER if any(s in runs[t] for t in tags)]
    for t in tags:
        print(f"\n### {t}: IoU % per class\n")
        print(iou_table(runs, t, sites))
        print(f"\n{t}: per-feature recall (>= 50 % of the drawn feature predicted as its class)\n")
        print(feature_table(runs, t, sites))
    print("\n### mIoU per held-out site\n")
    print(ablation_table(runs, tags, sites))
    print("\n### Mean IoU per class over held-out sites\n")
    print(class_ablation(runs, tags, sites))
    print("\n### Mean IoU per class over the whole courses (Omberg, Vreta, Landeryd)\n")
    print(class_ablation(runs, tags, [s for s in sites if s in FULL]))
    print("\n### Drawn features found (>= 50 % of the feature predicted as its class), pooled over held-out sites\n")
    print(feature_ablation(runs, tags, sites))
    if a.best:
        print(f"\n### Boundaries ({a.best})\n")
        print(boundary_table(runs, a.best, sites))
        print(f"\n### Confusion, % of drawn pixels per row, mean over held-out sites ({a.best})\n")
        print(confusion_table(runs, a.best, sites))
    print("\n### Times\n")
    print(times(runs, tags, sites))


if __name__ == "__main__":
    main()
