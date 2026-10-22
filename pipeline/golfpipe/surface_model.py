"""The course-surface model run over a site: which surface (tee, green, fairway, bunker, water, ...) every 0.32 m of
the photo is, and where the course ends.

The model is a UNet (segmentation-models-pytorch, ResNet-34 encoder) trained on the hand-drawn courses by
`tools/surface-lab/pilot/train.py --holdout none`; its card (`<model>.json`) names the classes, the input bands and
their scaling, and this module only follows it. Inputs: the RGB ortho, its NIR band (`nir.py`) and the raw lidar
DEM, on the DEM's extent within the photo. Photo bands are standardised per site (each flight has its own colour),
the DEM enters as relief at 2 m and 10 m and slope.

`predict` writes a GeoTIFF (EPSG:3006, 0.32 m, four uint8 bands):
  1  class as a CLASSES index, 0 = not course (the model's own background class)
  2  its confidence, max softmax x 255
  3  the class among the course classes only (for use inside a known course)
  4  its confidence
and `<out>.json` recording what it was made from, which `is_current` compares. Torch and
segmentation-models-pytorch come from requirements-surfaces.txt.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import Affine
from rasterio.warp import reproject
from rasterio.windows import Window
from scipy import ndimage

# The course feature types the surface rasters use (tools/surface-lab/prepare.py CLASSES); 0 = none / not course.
CLASSES = ["none", "tee", "green", "fairway", "semi_rough", "rough", "deep_rough", "bunker", "water", "path",
           "trees", "rock_slab", "outside"]
DEM_LAYERS = ["relief_2m", "relief_10m", "slope_deg"]
TILE, MARGIN = 512, 64


class SurfaceModelError(RuntimeError):
    """User-actionable surface model input/setup error."""


def card_of(model_path: Path) -> dict:
    card = model_path.with_suffix(".json")
    if not card.exists():
        raise SurfaceModelError(f"{card} is missing: the model's card (classes, inputs) sits next to the .pt")
    return json.loads(card.read_text())


def _stamp(p: Path) -> list:
    st = p.stat()
    return [st.st_size, st.st_mtime_ns]


def _record(ortho: Path, nir: Path, dem: Path, model: Path) -> dict:
    return {"ortho": _stamp(ortho), "nir": _stamp(nir), "dem": _stamp(dem), "model": _stamp(model),
            "modelBuilt": card_of(model).get("built")}


def is_current(out: Path, ortho: Path, nir: Path, dem: Path, model: Path) -> bool:
    side = out.with_suffix(".json")
    if not out.exists() or not side.exists():
        return False
    try:
        return json.loads(side.read_text()).get("inputs") == _record(ortho, nir, dem, model)
    except (OSError, ValueError):
        return False


def dem_layers(dem: np.ndarray, res: float) -> np.ndarray:
    """relief_2m, relief_10m (DEM minus its Gaussian at that sigma) and slope in degrees; NaN where the DEM is."""
    valid = np.isfinite(dem)
    filled = dem
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        filled = dem[tuple(idx)]
    out = np.empty((3, *dem.shape), dtype=np.float32)
    out[0] = filled - ndimage.gaussian_filter(filled, 2.0 / res)
    out[1] = filled - ndimage.gaussian_filter(filled, 10.0 / res)
    gy, gx = np.gradient(filled, res)
    out[2] = np.degrees(np.arctan(np.hypot(gx, gy)))
    out[:, ~valid] = np.nan
    return out


def site_inputs(ortho: Path, nir: Path, dem: Path, res: float):
    """(photo uint8 (4, H, W) R, G, B, NIR; dem layers float32 (3, H, W); transform; crs) on a `res` grid over the
    DEM's extent within the photo, aligned to the photo's pixels."""
    with rasterio.open(ortho) as o, rasterio.open(nir) as n, rasterio.open(dem) as d:
        if (o.width, o.height, o.transform) != (n.width, n.height, n.transform):
            raise SurfaceModelError(f"{nir.name} is not on the grid of {ortho.name}")
        f = max(int(round(res / o.res[0])), 1)
        t = o.transform
        left, right = max(o.bounds.left, d.bounds.left), min(o.bounds.right, d.bounds.right)
        top, bottom = min(o.bounds.top, d.bounds.top), max(o.bounds.bottom, d.bounds.bottom)
        if left >= right or bottom >= top:
            raise SurfaceModelError(f"{dem.name} and {ortho.name} do not overlap")
        c0 = math.ceil((left - t.c) / t.a / f) * f
        c1 = math.floor((right - t.c) / t.a / f) * f
        r0 = math.ceil((top - t.f) / t.e / f) * f
        r1 = math.floor((bottom - t.f) / t.e / f) * f
        H, W = (r1 - r0) // f, (c1 - c0) // f
        win = Window(c0, r0, c1 - c0, r1 - r0)
        photo = np.empty((4, H, W), dtype=np.uint8)
        photo[:3] = o.read([1, 2, 3], window=win, out_shape=(3, H, W), resampling=Resampling.average)
        photo[3] = n.read(1, window=win, out_shape=(H, W), resampling=Resampling.average)
        tr = Affine(t.a * f, 0, t.c + c0 * t.a, 0, t.e * f, t.f + r0 * t.e)
        crs = o.crs
        raw = d.read(1).astype(np.float32)
        if d.nodata is not None:
            raw[raw == d.nodata] = np.nan
        layers_src = dem_layers(raw, float(d.res[0]))
        layers = np.full((3, H, W), np.nan, dtype=np.float32)
        for i in range(3):
            reproject(layers_src[i], layers[i], src_transform=d.transform, src_crs=d.crs, dst_transform=tr,
                      dst_crs=crs, src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    return photo, layers, tr, crs


def normalise(photo: np.ndarray, layers: np.ndarray, card: dict):
    """The card's photo bands standardised over this site, its DEM layers scaled and clipped."""
    bands = card["photoBands"]
    sub = photo[:, ::7, ::7].reshape(4, -1).astype(np.float32)
    sub = sub[:, sub.sum(0) > 0]
    mean = sub.mean(1)[bands][:, None, None]
    std = np.maximum(sub.std(1)[bands], 1e-3)[:, None, None]
    dem_idx = [DEM_LAYERS.index(b) for b in card.get("demBands", [])]
    scale = np.array(card.get("demScale", []), dtype=np.float32)[:, None, None]
    clip = float(card.get("demClip", 6))

    def tile(r0, r1, c0, c1):
        x = (photo[bands, r0:r1, c0:c1].astype(np.float32) - mean) / std
        if dem_idx:
            d = np.nan_to_num(layers[dem_idx, r0:r1, c0:c1], nan=0.0) / scale
            x = np.concatenate([x, np.clip(d, -clip, clip)], 0)
        return x
    return tile


def load_model(model_path: Path, device: str):
    import torch
    try:
        import segmentation_models_pytorch as smp
    except ImportError as exc:
        raise SurfaceModelError("segmentation-models-pytorch is missing: install pipeline/requirements-surfaces.txt "
                                "into the pipeline venv") from exc
    card = card_of(model_path)
    model = smp.Unet(card["encoder"], encoder_weights=None, in_channels=card["inChannels"],
                     classes=len(card["classes"]))
    state = torch.load(model_path, map_location="cpu")
    model.load_state_dict({k: v.float() for k, v in state.items()})
    return model.to(device).eval(), card


def run_tiles(model, tile_fn, shape, n_course: int, device: str, tta: bool = True):
    """The model over the grid in TILE px tiles keeping the inner TILE - 2 MARGIN px, flip TTA. Returns
    (class, confidence, course class, course confidence) as model class indices and uint8."""
    import torch
    H, W = shape
    out = [np.zeros((H, W), dtype=np.uint8) for _ in range(4)]
    step = TILE - 2 * MARGIN
    cuda = device.startswith("cuda")
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=cuda):
        for y in range(0, H, step):
            for x in range(0, W, step):
                ya, xa = max(y - MARGIN, 0), max(x - MARGIN, 0)
                yb, xb = min(y + step + MARGIN, H), min(x + step + MARGIN, W)
                xin = tile_fn(ya, yb, xa, xb)
                ph, pw = (-xin.shape[1]) % 32, (-xin.shape[2]) % 32
                xin = np.pad(xin, ((0, 0), (0, ph), (0, pw)), mode="reflect")
                t = torch.from_numpy(np.ascontiguousarray(xin))[None].to(device)
                prob = model(t).float().softmax(1)
                if tta:
                    prob = prob + model(t.flip(-1)).float().softmax(1).flip(-1)
                    prob = prob + model(t.flip(-2)).float().softmax(1).flip(-2)
                    prob = prob / 3
                prob = prob[0, :, :yb - ya, :xb - xa]
                cy0, cx0 = y - ya, x - xa
                pc = prob[:, cy0:cy0 + min(step, H - y), cx0:cx0 + min(step, W - x)]
                sl = (slice(y, y + pc.shape[1]), slice(x, x + pc.shape[2]))
                mx, am = pc.max(0)
                out[0][sl] = am.byte().cpu().numpy()
                out[1][sl] = (mx * 255).round().byte().cpu().numpy()
                course = pc[:n_course] / pc[:n_course].sum(0, keepdim=True)
                mx, am = course.max(0)
                out[2][sl] = am.byte().cpu().numpy()
                out[3][sl] = (mx * 255).round().byte().cpu().numpy()
    return out


def predict(ortho: Path, nir: Path, dem: Path, model_path: Path, out: Path, device: str | None = None) -> dict:
    """Run the model over the site and write `out` (+ `out`.json). Returns the report written to the json."""
    import time

    from .inpaint import torch_device
    t0 = time.time()
    dev = torch_device(device)
    model, card = load_model(model_path, dev)
    photo, layers, tr, crs = site_inputs(ortho, nir, dem, float(card.get("res", 0.32)))
    classes = card["classes"]
    n_course = sum(1 for c in classes if c != "background")
    to_code = np.array([CLASSES.index(c) if c in CLASSES else 0 for c in classes], dtype=np.uint8)
    t1 = time.time()
    cls, conf, ccls, cconf = run_tiles(model, normalise(photo, layers, card), photo.shape[1:], n_course, dev)
    no_photo = photo[:3].sum(0) == 0
    bands = np.stack([to_code[cls], conf, to_code[ccls], cconf])
    bands[:, no_photo] = 0
    out.parent.mkdir(parents=True, exist_ok=True)
    profile = dict(driver="GTiff", width=bands.shape[2], height=bands.shape[1], count=4, dtype="uint8", crs=crs,
                   transform=tr, tiled=True, blockxsize=512, blockysize=512, compress="deflate", predictor=2)
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(bands)
        for i, d in enumerate(["class (0 = not course)", "confidence", "course class", "course confidence"], 1):
            dst.set_band_description(i, d)
    report = {"inputs": _record(ortho, nir, dem, model_path), "device": dev, "width": int(bands.shape[2]),
              "height": int(bands.shape[1]), "res": float(tr.a), "classes": CLASSES,
              "inferSeconds": round(time.time() - t1, 1), "seconds": round(time.time() - t0, 1)}
    out.with_suffix(".json").write_text(json.dumps(report, indent=1))
    return report
