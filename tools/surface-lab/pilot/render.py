"""Pictures and prediction rasters of a run.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/render.py --tag loco-r34-rgbnd-bg [--site Vreta] [--holes 3] [--tif]

- images/<tag>-<Site>-hole<n>.png: photo | drawn | predicted | confidence for a hole's box (its tees, green, fairways
  and bunkers + 15 m, widened to at least 1:1.6); the prediction is shown everywhere the model ran (with the
  background class: black = the model says not course), the drawn panel is black where nothing is drawn.
- images/<tag>-<Site>-overview.png: the whole crop at 1.28 m/px.
- pred-<siteId>.tif (--tif) on the cache grid (0.32 m, EPSG:3006, transform in the tif), classes numbered as
  prepare.py CLASSES / labels.tif: band 1 = class (0 = no prediction or, with the background class, not course),
  band 2 = confidence (max softmax x 255); a background-class model adds band 3 = class among the course classes only
  (for use inside a known course outline) and band 4 = its confidence.
Colours = prepare.py CLASS_RGB. Output goes to data/experiments/surfaces/pilot/.
"""
from __future__ import annotations

import argparse

import numpy as np
from PIL import Image, ImageDraw

from common import (BG, CLASS_RGB, IGNORE, OUT, OUT_RGB, SITES, TRAIN_CLASSES, TRAIN_RGB, TRAIN_TO_CLASS, Site,
                    cached_sites)

RAMP = np.array([[0, 0, 4], [87, 16, 110], [188, 55, 84], [249, 142, 9], [252, 255, 164]], dtype=np.float32)


def ramp(conf: np.ndarray) -> np.ndarray:
    x = conf.astype(np.float32) / 255 * (len(RAMP) - 1)
    i = np.clip(np.floor(x).astype(int), 0, len(RAMP) - 2)
    f = (x - i)[..., None]
    return (RAMP[i] * (1 - f) + RAMP[i + 1] * f).astype(np.uint8)


def photo_rgb(site: Site, r0, r1, c0, c1, step=1) -> np.ndarray:
    return np.asarray(site.rgbi[:3, r0:r1:step, c0:c1:step]).transpose(1, 2, 0).copy()


def pred_rgb(pred: np.ndarray) -> np.ndarray:
    out = np.zeros(pred.shape + (3,), np.uint8)
    m = pred != IGNORE
    out[m] = OUT_RGB[pred[m]]
    return out


def panels(imgs: list[np.ndarray], titles: list[str], max_side=900) -> Image.Image:
    """2 panels per row; each panel scaled so its longer side is <= max_side."""
    h, w = imgs[0].shape[:2]
    s = min(1.0, max_side / max(h, w))
    nh, nw = max(1, int(h * s)), max(1, int(w * s))
    pad, top = 6, 22
    ncol = len(imgs) if h > 1.3 * w else (2 if len(imgs) > 2 else len(imgs))  # tall crops side by side
    nrow = (len(imgs) + ncol - 1) // ncol
    canvas = Image.new("RGB", (ncol * (nw + pad) + pad, nrow * (nh + top + pad)), (255, 255, 255))
    d = ImageDraw.Draw(canvas)
    for i, (im, t) in enumerate(zip(imgs, titles)):
        pim = Image.fromarray(im).resize((nw, nh), Image.NEAREST if i in (1, 2) else Image.BILINEAR)
        x = pad + (i % ncol) * (nw + pad)
        y = (i // ncol) * (nh + top + pad)
        canvas.paste(pim, (x, y + top))
        d.text((x, y + 5), t, fill=(0, 0, 0))
    return canvas


def legend() -> Image.Image:
    names = TRAIN_CLASSES
    im = Image.new("RGB", (len(names) * 96 + 10, 22), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for i, n in enumerate(names):
        x = 5 + i * 96
        d.rectangle([x, 5, x + 12, 17], fill=tuple(int(v) for v in TRAIN_RGB[i]), outline=(0, 0, 0))
        d.text((x + 16, 6), n, fill=(0, 0, 0))
    return im


def stack(top: Image.Image, bottom: Image.Image) -> Image.Image:
    w = max(top.width, bottom.width)
    c = Image.new("RGB", (w, top.height + bottom.height), (255, 255, 255))
    c.paste(top, (0, 0))
    c.paste(bottom, (0, top.height))
    return c


def hole_boxes(site: Site, margin_px=47):
    hole_of = {}
    for f in site.features:
        if f.get("holeId") and f["type"] in ("tee", "green", "fairway", "bunker"):
            hole_of[f["idx"]] = f["holeId"]
    holes = sorted(set(hole_of.values()))
    lut = np.zeros(max(f["idx"] for f in site.features) + 1, dtype=np.int32)
    for idx, h in hole_of.items():
        lut[idx] = holes.index(h) + 1
    hr = lut[np.asarray(site.inst)]
    sl = __import__("scipy.ndimage", fromlist=["find_objects"]).find_objects(hr)
    boxes = []
    H, W = site.shape
    for i, s in enumerate(sl):
        if s is None:
            continue
        has_green = any(f["holeId"] == holes[i] and f["type"] == "green" for f in site.features)
        if not has_green:
            continue
        r0, r1 = s[0].start - margin_px, s[0].stop + margin_px
        c0, c1 = s[1].start - margin_px, s[1].stop + margin_px
        h, w = r1 - r0, c1 - c0  # no thinner than 1:1.6 either way (a straight hole is a thin strip)
        if w < h / 1.6:
            c0, c1 = int((c0 + c1) / 2 - h / 3.2), int((c0 + c1) / 2 + h / 3.2)
        elif h < w / 1.6:
            r0, r1 = int((r0 + r1) / 2 - w / 3.2), int((r0 + r1) / 2 + w / 3.2)
        r0, r1, c0, c1 = max(r0, 0), min(r1, H), max(c0, 0), min(c1, W)
        if (r1 - r0) * (c1 - c0) > 2500 * 2500:  # a hole spread over the site (stray shape): skip
            continue
        boxes.append((holes[i], r0, r1, c0, c1))
    boxes.sort(key=lambda b: (b[1] + b[2]))
    return boxes


def render(tag: str, site_id: str, n_holes: int, tif: bool) -> None:
    site = Site(site_id)
    run = OUT / "runs" / tag
    name = site.name
    d = np.load(run / f"{name}-pred.npz")
    pred, conf = d["pred"], d["conf"]
    auto = "pred_auto" in d
    if auto:  # show what the model draws by itself (black = it says not course)
        pred_c, conf_c = pred, conf
        pred, conf = d["pred_auto"], d["conf_auto"]
    img_dir = OUT / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    labels = np.asarray(site.labels)

    boxes = hole_boxes(site)
    if boxes:
        pick = [boxes[int(round(q * (len(boxes) - 1)))] for q in np.linspace(0.15, 0.85, n_holes)]
        for k, (hid, r0, r1, c0, c1) in enumerate(dict.fromkeys(pick)):
            imgs = [photo_rgb(site, r0, r1, c0, c1), CLASS_RGB[labels[r0:r1, c0:c1]], pred_rgb(pred[r0:r1, c0:c1]),
                    ramp(conf[r0:r1, c0:c1])]
            p = panels(imgs, ["photo 2025", "drawn (black = nothing drawn)",
                              f"predicted ({tag})" + (", black = not course" if auto else ""),
                              "confidence (dark = unsure)"])
            stack(p, legend()).save(img_dir / f"{tag}-{name}-hole{k + 1}.png")
    s = 4
    imgs = [photo_rgb(site, 0, site.shape[0], 0, site.shape[1], s), CLASS_RGB[labels[::s, ::s]], pred_rgb(pred[::s, ::s]),
            ramp(conf[::s, ::s])]
    stack(panels(imgs, ["photo 2025", "drawn", f"predicted ({tag})", "confidence"], max_side=1000), legend()).save(
        img_dir / f"{tag}-{name}-overview.png")
    if tif:
        import rasterio
        from rasterio.transform import Affine
        def to_cls(p):
            return np.where((p == IGNORE) | (p == BG), 0,
                            TRAIN_TO_CLASS[np.minimum(p, len(TRAIN_TO_CLASS) - 1)]).astype(np.uint8)
        cls = to_cls(pred)
        m = site.meta
        prof = dict(driver="GTiff", width=m["width"], height=m["height"], count=4 if auto else 2, dtype="uint8", crs=m["crs"],
                    transform=Affine(*m["transform"]), tiled=True, blockxsize=512, blockysize=512, compress="deflate")
        with rasterio.open(OUT / f"pred-{site_id}.tif", "w", **prof) as dst:
            dst.write(cls, 1)
            dst.write(conf, 2)
            dst.set_band_description(1, "class (prepare.py CLASSES index)")
            dst.set_band_description(2, "confidence (max softmax x 255)")
            if auto:
                dst.write(to_cls(pred_c), 3)
                dst.write(conf_c, 4)
                dst.set_band_description(1, "class, 0 = not course (model's own background class)")
                dst.set_band_description(3, "class among the course classes only (inside a known course outline)")
                dst.set_band_description(4, "confidence of band 3")
            dst.update_tags(model=tag, classes=",".join(["none", "tee", "green", "fairway", "semi_rough", "rough",
                                                         "deep_rough", "bunker", "water", "path", "trees",
                                                         "rock_slab", "outside"]))
    print(f"{tag} {name}: {len(boxes)} holes found, images in {img_dir}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--site", action="append")
    ap.add_argument("--holes", type=int, default=3)
    ap.add_argument("--tif", action="store_true")
    a = ap.parse_args()
    sites = [k for k, v in SITES.items() if not a.site or k in a.site or v in a.site]
    for s in sites:
        if s in cached_sites() and (OUT / "runs" / a.tag / f"{SITES[s]}-pred.npz").exists():
            render(a.tag, s, a.holes, a.tif)


if __name__ == "__main__":
    main()
