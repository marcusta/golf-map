"""SAM box bench, step 2: run SAM with a box prompt on each case (sam_cases.py) over several input images, score the
masks against what was drawn.

    tools/sam-server/venv/Scripts/python.exe tools/surface-lab/bench_sam.py [--model sam2.1_l] [--model sam3]
        [--cases <glob>] [--sheets 3]

Input images (SAM takes three 8-bit channels; each is a different way of showing the same ground):
  rgb      the photo as the editor shows it
  cir      false colour NIR-R-G: grass vigour and sand/water/asphalt (low NIR) apart
  terrain  relief_2m, relief_10m, hillshade from the lidar DEM: shape of the ground, no colour at all
  mix      NDVI, relief_2m, brightness: vegetation + small-scale shape + light
  shade    the photo multiplied by the hillshade: colour with the terrain's light and shadow on it
Prompts: `single` = the box; `point` = the box centre alone; `boxpt` = both (point modes on rgb and cir only);
`oracle3` = of SAM's three multimask answers to the box, the one closest to the truth (what a "scroll through SAM's
sizes" control could reach).
Combined after SAM:
  vote     pixel majority of rgb, cir and terrain
  rule     no SAM: Otsu on a per-type index inside the box (bunker: low NDVI and bright; water: low NIR; path: low NDVI)
  auto     what a box + type tool would do: AUTO_ORDER's masks for the type in order, the first that stays in the box

Scores per case: IoU with the truth (area cases: inside the box only) and the boundary error, the mean distance in
metres between the predicted and the drawn edge (both ways). Writes data/experiments/surfaces/sam-bench/results.csv,
summary.md and contact sheets sheets/<case>.png.
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
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
from gpulock import gpu_lock  # noqa: E402

BENCH = REPO / "data" / "experiments" / "surfaces" / "sam-bench"
MODELS = REPO / "data" / "models"
VARIANTS = ["rgb", "cir", "terrain", "mix", "shade"]
VOTE_OF = ["rgb", "cir", "terrain"]
RULE_TYPES = {"bunker", "water", "path"}


def stretch(a: np.ndarray, lo: float | None = None, hi: float | None = None, pct=(2, 98)) -> np.ndarray:
    a = np.nan_to_num(a.astype(np.float32), nan=0.0)
    if lo is None or hi is None:
        lo, hi = np.percentile(a, pct)
        if hi - lo < 1e-6:
            hi = lo + 1e-6
    return (np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)


def ndvi_of(c) -> np.ndarray:
    r = c["rgb"][..., 0].astype(np.float32)
    n = c["nir"].astype(np.float32)
    return (n - r) / np.maximum(n + r, 1.0)


def make_images(c) -> dict[str, np.ndarray]:
    rgb = c["rgb"]
    nir = c["nir"]
    relief2, relief10, _slope, shade = c["dem"]
    lum = rgb.astype(np.float32).mean(-1)
    shade01 = np.nan_to_num(shade, nan=0.7)
    return {
        "rgb": rgb,
        "cir": np.dstack([nir, rgb[..., 0], rgb[..., 1]]),
        "terrain": np.dstack([stretch(relief2), stretch(relief10), stretch(shade01, 0, 1)]),
        "mix": np.dstack([stretch(ndvi_of(c), -0.1, 0.7), stretch(relief2), stretch(lum)]),
        "shade": np.clip(rgb.astype(np.float32) * (0.45 + 0.75 * shade01[..., None]), 0, 255).astype(np.uint8),
    }


def box_mask(shape, box) -> np.ndarray:
    m = np.zeros(shape, dtype=bool)
    x1, y1, x2, y2 = box
    m[max(int(y1), 0):int(np.ceil(y2)), max(int(x1), 0):int(np.ceil(x2))] = True
    return m


def edge(m: np.ndarray) -> np.ndarray:
    m8 = m.astype(np.uint8)
    return (m8 - cv2.erode(m8, np.ones((3, 3), np.uint8))).astype(bool)


def boundary_error_m(pred: np.ndarray, truth: np.ndarray, mpp: float) -> float:
    pe, te = edge(pred), edge(truth)
    if not pe.any() or not te.any():
        return float("nan")
    dt_t = cv2.distanceTransform((~te).astype(np.uint8), cv2.DIST_L2, 5)
    dt_p = cv2.distanceTransform((~pe).astype(np.uint8), cv2.DIST_L2, 5)
    return float((dt_t[pe].mean() + dt_p[te].mean()) / 2 * mpp)


def score(pred: np.ndarray, c, inside: np.ndarray) -> tuple[float, float, float]:
    """IoU, edge error (m) and predicted/drawn area ratio."""
    truth = c["truth"]
    if c["meta"]["kind"] == "area":
        pred = pred & inside
    inter = (pred & truth).sum()
    union = (pred | truth).sum()
    iou = float(inter / union) if union else float("nan")
    ratio = float(pred.sum() / truth.sum()) if truth.any() else float("nan")
    return iou, boundary_error_m(pred, truth, c["meta"]["mPerPx"]), ratio


def rule_mask(c, inside: np.ndarray) -> np.ndarray | None:
    t = c["meta"]["type"]
    if t not in RULE_TYPES:
        return None
    if t == "bunker":
        lum = c["rgb"].astype(np.float32).mean(-1) / 255
        index = -ndvi_of(c) + 0.5 * lum
    elif t == "path":
        index = -ndvi_of(c)  # gravel and asphalt alike: no living green
    else:
        index = -c["nir"].astype(np.float32)
    vals = stretch(index)
    thr, _ = cv2.threshold(vals[inside], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    m = (vals > thr) & inside
    n, comp, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8))
    if n <= 1:
        return m
    if t == "path":
        min_px = 2.0 / c["meta"]["mPerPx"] ** 2
        keep = np.flatnonzero(stats[:, cv2.CC_STAT_AREA] >= min_px)
        return np.isin(comp, keep[keep > 0])
    # The component that fills the box's central half best.
    x1, y1, x2, y2 = c["box"]
    cx1, cy1, cx2, cy2 = x1 + (x2 - x1) / 4, y1 + (y2 - y1) / 4, x2 - (x2 - x1) / 4, y2 - (y2 - y1) / 4
    centre = box_mask(m.shape, (cx1, cy1, cx2, cy2))
    counts = np.bincount(comp[centre].ravel(), minlength=n)
    counts[0] = 0
    best = int(counts.argmax())
    out = comp == best
    filled = out.astype(np.uint8)
    cnts, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(filled, cnts, -1, 1, thickness=cv2.FILLED)
    return filled.astype(bool)


def load_predictor(name: str):
    from ultralytics.models.sam import SAM2Predictor, SAM3Predictor
    weights = MODELS / f"{name}.pt"
    if not weights.exists():
        if name.startswith("sam3"):
            raise SystemExit(f"{weights} missing: SAM 3 weights are gated on Hugging Face (facebook/sam3); copy sam3.pt there")
        from ultralytics.utils.downloads import attempt_download_asset
        MODELS.mkdir(parents=True, exist_ok=True)
        attempt_download_asset(str(weights))
    cls = SAM3Predictor if name.startswith("sam3") else SAM2Predictor
    return cls(overrides=dict(conf=0.25, task="segment", mode="predict", imgsz=1024, model=str(weights), half=True,
                              verbose=False, save=False))


def click_point(c) -> list[float]:
    """The box centre: the point prompt a box tool can derive without a click."""
    x1, y1, x2, y2 = c["box"]
    return [float((x1 + x2) / 2), float((y1 + y2) / 2)]


# Per type, the masks to try in order; the first that stays in the box wins (`auto`).
AUTO_ORDER = {
    "bunker": ["cir point", "rgb point", "rule", "cir", "rgb"],
    "green": ["rgb point", "cir point", "rgb boxpt", "rgb"],
    "tee": ["rgb point", "rgb boxpt", "rgb", "terrain"],
    "fairway": ["rgb boxpt", "rgb", "shade", "cir"],
    "water": ["rgb", "cir", "rgb boxpt", "rule"],  # a pond's middle is often not water (a bend, an island)
}


def stays_in_box(mask: np.ndarray, box) -> bool:
    """A box is the user's 'about this big': at least 10 % of it filled, at most 10 % of the mask outside it +15 %."""
    x1, y1, x2, y2 = box
    n = mask.sum()
    if n < 0.10 * (x2 - x1) * (y2 - y1):
        return False
    gx, gy = 0.15 * (x2 - x1), 0.15 * (y2 - y1)
    near = box_mask(mask.shape, (x1 - gx, y1 - gy, x2 + gx, y2 + gy))
    return (mask & near).sum() >= 0.9 * n


def auto_mask(t: str, shown: dict, box) -> tuple[np.ndarray, str] | None:
    order = [k for k in AUTO_ORDER.get(t, []) if k in shown]
    for k in order:
        if stays_in_box(shown[k], box):
            return shown[k], k
    return (shown[order[0]], order[0]) if order else None


def run_sam(pred, image_rgb: np.ndarray, box, point=None) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """(single mask, three multimask masks, their scores, extra prompt masks) for one image and box. With `point`,
    also the point-only answer (the old click tool) and box + point."""
    bgr = np.ascontiguousarray(image_rgb[..., ::-1])
    pred.set_image(bgr)
    shape = image_rgb.shape[:2]
    b = [list(map(float, box))]
    m1, _ = pred.inference_features(pred.features, src_shape=shape, bboxes=b)
    m3, b3 = pred.inference_features(pred.features, src_shape=shape, bboxes=b, multimask_output=True)
    single = m1[0].cpu().numpy() if m1 is not None else np.zeros(shape, bool)
    extra = {}
    if point is not None:
        mp, _ = pred.inference_features(pred.features, src_shape=shape, points=[point], labels=[1])
        extra["point"] = mp[0].cpu().numpy() if mp is not None else np.zeros(shape, bool)
        mbp, _ = pred.inference_features(pred.features, src_shape=shape, bboxes=b, points=[point], labels=[1])
        extra["boxpt"] = mbp[0].cpu().numpy() if mbp is not None else np.zeros(shape, bool)
    if m3 is None:
        return single, np.zeros((0, *shape), bool), np.zeros(0), extra
    return single, m3.cpu().numpy(), b3[:, 4].float().cpu().numpy(), extra


def contact_sheet(path: Path, c, images, masks: dict[str, np.ndarray]) -> None:
    rgb = c["rgb"]
    tiles = []
    x1, y1, x2, y2 = map(int, c["box"])

    def panel(img, mask, title, colour=(255, 60, 60)):
        p = np.ascontiguousarray(img.copy())
        cnts, _ = cv2.findContours(c["truth"].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(p, cnts, -1, (255, 255, 255), 2)
        if mask is not None:
            cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(p, cnts, -1, colour, 2)
        cv2.rectangle(p, (x1, y1), (x2, y2), (255, 230, 0), 2)
        p = cv2.resize(p, (360, int(360 * p.shape[0] / p.shape[1])))
        cv2.putText(p, title, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3)
        cv2.putText(p, title, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
        return p

    tiles.append(panel(rgb, None, f"{c['meta']['type']} (white = drawn)"))
    for v in VARIANTS:
        tiles.append(panel(images[v], masks.get(v), v))
    for extra in ("rgb point", "vote", "rule", "auto"):
        if extra in masks:
            tiles.append(panel(rgb, masks[extra], extra))
    h = max(t.shape[0] for t in tiles)
    tiles = [np.pad(t, ((0, h - t.shape[0]), (0, 0), (0, 0))) for t in tiles]
    rows = [np.hstack(tiles[i:i + 4] + [np.zeros_like(tiles[0])] * (4 - len(tiles[i:i + 4])))
            for i in range(0, len(tiles), 4)]
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(np.vstack(rows), cv2.COLOR_RGB2BGR))


def case_masks(pred, c, images) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray], str]:
    """Every mask for one case, named '<input>' (box), '<input> point' (box centre), '<input> boxpt' (both),
    'vote', 'rule' and 'auto'; SAM's three multimask answers for rgb and cir; which mask auto picked."""
    shown = {}
    threes = {}
    point = click_point(c) if c["meta"]["kind"] == "object" else None
    for v in VARIANTS:
        single, m3, _s3, extra = run_sam(pred, images[v], c["box"], point if v in ("rgb", "cir") else None)
        shown[v] = single
        shown |= {f"{v} {mode}": m for mode, m in extra.items()}
        if len(m3) and v in ("rgb", "cir"):
            threes[v] = m3
    shown["vote"] = np.sum([shown[v] for v in VOTE_OF], axis=0) >= 2
    rm = rule_mask(c, box_mask(c["truth"].shape, c["box"]))
    if rm is not None:
        shown["rule"] = rm
    picked = auto_mask(c["meta"]["type"], shown, c["box"])
    if picked is None:
        return shown, threes, ""
    shown["auto"] = picked[0]
    return shown, threes, picked[1]


def load_case(path: str):
    z = np.load(path)
    return {k: z[k] for k in ("rgb", "nir", "dem", "truth", "labels", "box")} | {
        "meta": json.loads(str(z["meta"])), "name": Path(path).stem}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", action="append", help="sam2.1_l (default), sam2.1_b, sam3")
    ap.add_argument("--cases", default=str(BENCH / "cases" / "*.npz"))
    ap.add_argument("--sheets", type=int, default=3, help="contact sheets per type and site")
    ap.add_argument("--out", default=str(BENCH))
    ap.add_argument("--save-masks", action="store_true", help="keep each case's masks in <out>/masks/<case>.npz")
    args = ap.parse_args()
    out = Path(args.out)
    paths = sorted(glob.glob(args.cases))
    models = args.model or ["sam2.1_l"]
    rows = []
    sheets_done: dict[tuple, int] = {}
    with gpu_lock("sam-bench"):
        for model_name in models:
            pred = load_predictor(model_name)
            t0 = time.time()
            for i, p in enumerate(paths):
                c = load_case(p)
                meta = c["meta"]
                inside = box_mask(c["truth"].shape, c["box"])
                images = make_images(c)
                shown, threes, picked = case_masks(pred, c, images)
                if args.save_masks:
                    (out / "masks").mkdir(parents=True, exist_ok=True)
                    np.savez_compressed(out / "masks" / f"{c['name']}.npz",
                                        **{k.replace(" ", "_"): m for k, m in shown.items()})
                for name, mask in shown.items():
                    inp, _, mode = name.partition(" ")
                    iou, be, ratio = score(mask, c, inside)
                    rows.append(dict(model="none" if name == "rule" else model_name, case=c["name"],
                                     site=meta["site"][:8], type=meta["type"], input=inp, mode=mode or "single",
                                     iou=iou, edge_m=be, area_ratio=ratio, picked=picked if name == "auto" else ""))
                for v, m3 in threes.items():
                    best = max((score(m, c, inside) for m in m3), key=lambda s: np.nan_to_num(s[0], nan=-1))
                    rows.append(dict(model=model_name, case=c["name"], site=meta["site"][:8], type=meta["type"],
                                     input=v, mode="oracle3", iou=best[0], edge_m=best[1], area_ratio=best[2],
                                     picked=""))
                key = (model_name, meta["site"], meta["type"])
                if sheets_done.get(key, 0) < args.sheets:
                    contact_sheet(out / "sheets" / f"{model_name}-{c['name']}.png", c, images, shown)
                    sheets_done[key] = sheets_done.get(key, 0) + 1
                if (i + 1) % 20 == 0:
                    print(f"{model_name}: {i + 1}/{len(paths)} cases, {time.time() - t0:.0f} s", flush=True)
            print(f"{model_name}: {len(paths)} cases in {time.time() - t0:.0f} s")
            del pred
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    write_summary(rows, out / "summary.md")
    print((out / "summary.md").read_text())


def write_summary(rows: list[dict], path: Path) -> None:
    types = list(dict.fromkeys(r["type"] for r in rows))
    lines = []
    for model in dict.fromkeys(r["model"] for r in rows if r["model"] != "none"):
        cols = [("auto", "single"), ("rgb", "point"), ("rgb", "single"), ("rgb", "boxpt"), ("rgb", "oracle3"),
                ("cir", "point"), ("cir", "single"), ("cir", "oracle3"), ("terrain", "single"), ("mix", "single"),
                ("shade", "single"), ("vote", "single"), ("rule", "single")]
        lines.append(f"## {model}: mean IoU (median edge error, m), {len({r['case'] for r in rows})} cases\n")
        lines.append("| type | n | " + " | ".join(f"{v}{'' if m == 'single' else ' ' + m}" for v, m in cols) + " |")
        lines.append("|" + "---|" * (len(cols) + 2))
        for t in types:
            cells = []
            n = len({r["case"] for r in rows if r["type"] == t})
            for v, m in cols:
                sel = [r for r in rows if r["type"] == t and r["input"] == v and r["mode"] == m
                       and (r["model"] == model or v == "rule")]
                if not sel:
                    cells.append("")
                    continue
                iou = np.nanmean([r["iou"] for r in sel])
                be = np.nanmedian([r["edge_m"] for r in sel])
                cells.append(f"{iou:.2f} ({be:.1f})")
            lines.append(f"| {t} | {n} | " + " | ".join(cells) + " |")
        lines.append("")
        lines.append("Median predicted/drawn area (above 1 = SAM takes more than was drawn):\n")
        lines.append("| type | rgb point | rgb single | cir single |")
        lines.append("|---|---|---|---|")
        for t in types:
            cells = []
            for v, m in (("rgb", "point"), ("rgb", "single"), ("cir", "single")):
                sel = [r["area_ratio"] for r in rows if r["type"] == t and r["input"] == v and r["mode"] == m
                       and r["model"] == model]
                cells.append(f"{np.nanmedian(sel):.2f}" if sel else "")
            lines.append(f"| {t} | " + " | ".join(cells) + " |")
        lines.append("")
    path.write_text("\n".join(lines))


if __name__ == "__main__":
    main()
