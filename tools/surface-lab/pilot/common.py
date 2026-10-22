"""Shared bits of the surface-model pilot: paths, classes, the cached per-site arrays.

The class list and colours are copies of prepare.py's CLASSES / CLASS_RGB (prepare.py imports golfpipe at module
level, so it is not imported here). The model predicts TRAIN_CLASSES; `none`, `trees` (Linkan's are lidar drafts)
and `outside` are ignored (255) in training and evaluation.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(HERE / ".hf"))  # model weights stay inside the pilot folder
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
REPO = HERE.parents[2]
DEPS = HERE / ".deps"
if str(DEPS) not in sys.path:
    sys.path.append(str(DEPS))  # appended: the venv's numpy/scipy/torch win over anything in .deps
LAB = HERE.parent
if str(LAB) not in sys.path:
    sys.path.append(str(LAB))  # gpulock

SURF = REPO / "data" / "experiments" / "surfaces"
OUT = SURF / "pilot"
CACHE = OUT / "cache"

SITES = {
    "317d1f83-3ade-431c-8201-605ac0bd2871": "Omberg",
    "88E5F5B7-B1E6-4EBA-9D47-49B289C59EAE": "Vreta",
    "26D37361-D79C-41AA-AA49-92F2C2277222": "Landeryd",
    "208f4f4d-5242-4ef3-ac57-f3d1bc9047f1": "Linkan",
    "5febd2fe-ecb3-4e34-acf5-e0db1f31c9f9": "Klinga",
}

CLASSES = ["none", "tee", "green", "fairway", "semi_rough", "rough", "deep_rough", "bunker", "water", "path",
           "trees", "rock_slab", "outside"]
CLASS_RGB = np.array([
    [0, 0, 0], [230, 120, 220], [40, 220, 90], [120, 200, 60], [90, 150, 50], [60, 110, 40], [35, 70, 30],
    [240, 225, 160], [40, 110, 230], [150, 150, 150], [20, 60, 20], [130, 120, 110], [200, 60, 60]], dtype=np.uint8)

TRAIN_CLASSES = ["tee", "green", "fairway", "semi_rough", "rough", "deep_rough", "bunker", "water", "path",
                 "rock_slab"]
IGNORE = 255
# labels.tif class index -> train index (255 = ignore)
LUT = np.full(256, IGNORE, dtype=np.uint8)
for _ti, _name in enumerate(TRAIN_CLASSES):
    LUT[CLASSES.index(_name)] = _ti
# train index -> labels.tif class index (for the pred tifs and the colours)
TRAIN_TO_CLASS = np.array([CLASSES.index(c) for c in TRAIN_CLASSES], dtype=np.uint8)
TRAIN_RGB = CLASS_RGB[TRAIN_TO_CLASS]
# Optional 11th model class "background" (= not course): undrawn pixels farther than BG_DIST_M from anything
# drawn. Only Omberg and Vreta are drawn whole; elsewhere undrawn stays ignore.
BG = len(TRAIN_CLASSES)
BG_DIST_M = 30.0
BG_EXCLUDE = {"26D37361-D79C-41AA-AA49-92F2C2277222",  # Landeryd: undrawn Classic course in the photo
              "208f4f4d-5242-4ef3-ac57-f3d1bc9047f1",  # Linkan: only some holes drawn
              "5febd2fe-ecb3-4e34-acf5-e0db1f31c9f9"}  # Klinga: no rough drawn
OUT_RGB = np.vstack([TRAIN_RGB, [[0, 0, 0]]]).astype(np.uint8)  # background shown black like "nothing drawn"

RES = 0.32  # working resolution (2 x the photo's 0.16 m)

# Input sets for the ablation; channel order in the cache: rgbi.npy = R, G, B, NIR; dem.npy = relief_2m,
# relief_10m, slope_deg.
INPUT_SETS = {
    "rgb": {"photo": [0, 1, 2], "dem": []},
    "rgbn": {"photo": [0, 1, 2, 3], "dem": []},
    "rgbnd": {"photo": [0, 1, 2, 3], "dem": [0, 1, 2]},
}


def ready_sites() -> list[str]:
    return [s for s in SITES if (SURF / s / "ready.json").exists()]


def cached_sites() -> list[str]:
    return [s for s in SITES if (CACHE / s / "meta.json").exists()]


class Site:
    """The cached 0.32 m arrays of one site, memory-mapped."""

    def __init__(self, site_id: str):
        self.id = site_id
        self.name = SITES[site_id]
        d = CACHE / site_id
        self.meta = json.loads((d / "meta.json").read_text())
        self.rgbi = np.load(d / "rgbi.npy", mmap_mode="r")      # (4, H, W) uint8
        self.dem = np.load(d / "dem.npy", mmap_mode="r")        # (3, H, W) float16, NaN-free (0 where no DEM)
        self.labels = np.load(d / "labels.npy", mmap_mode="r")  # (H, W) uint8, CLASSES index
        self.inst = np.load(d / "inst.npy", mmap_mode="r")      # (H, W) uint16, features.json idx
        self.target = LUT[np.asarray(self.labels)]              # (H, W) uint8 train index / 255
        self.features = json.loads((SURF / site_id / "features.json").read_text())

    def background_target(self) -> np.ndarray:
        """target + BG where nothing is drawn within BG_DIST_M (computed at 1.28 m)."""
        from scipy import ndimage
        t = self.target.copy()
        if self.id in BG_EXCLUDE:
            return t
        k = 4
        drawn = np.asarray(self.labels[::k, ::k]) > 0
        far = ndimage.distance_transform_edt(~drawn) * RES * k > BG_DIST_M
        far = np.repeat(np.repeat(far, k, 0), k, 1)[:t.shape[0], :t.shape[1]]
        t[far & (np.asarray(self.labels) == 0)] = BG
        return t

    @property
    def shape(self):
        return self.labels.shape

    def photo_norm(self, bands: list[int]):
        st = self.meta["photoStats"]
        mean = np.array([st["mean"][b] for b in bands], dtype=np.float32)
        std = np.array([st["std"][b] for b in bands], dtype=np.float32)
        return mean, std


DEM_SCALE = np.array([0.25, 1.0, 10.0], dtype=np.float32)  # relief_2m [m], relief_10m [m], slope [deg]


def load_input(site: Site, input_set: str, r0=0, r1=None, c0=0, c1=None) -> np.ndarray:
    """Normalised float32 input (C, h, w) of a window: per-site standardised photo bands, scaled DEM layers."""
    spec = INPUT_SETS[input_set]
    r1 = site.shape[0] if r1 is None else r1
    c1 = site.shape[1] if c1 is None else c1
    mean, std = site.photo_norm(spec["photo"])
    x = np.asarray(site.rgbi[spec["photo"], r0:r1, c0:c1], dtype=np.float32)
    x = (x - mean[:, None, None]) / std[:, None, None]
    if spec["dem"]:
        d = np.asarray(site.dem[spec["dem"], r0:r1, c0:c1], dtype=np.float32) / DEM_SCALE[spec["dem"]][:, None, None]
        x = np.concatenate([x, np.clip(d, -6, 6)], 0)
    return x


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2))
