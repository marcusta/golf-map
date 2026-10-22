"""surface_model: the inputs on the model's grid, the DEM layers, and a whole run with a small real (untrained) UNet
on synthetic rasters: the band layout, the class codes, the record that tells a current output."""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from golfpipe import surface_model as sm

CRS3006 = CRS.from_epsg(3006)
X0, Y0 = 533000.0, 6475000.0


def write(path: Path, bands: np.ndarray, res: float, x0=X0, y0=Y0, nodata=None) -> Path:
    with rasterio.open(path, "w", driver="GTiff", width=bands.shape[2], height=bands.shape[1], count=bands.shape[0],
                       dtype=bands.dtype, crs=CRS3006, transform=from_origin(x0, y0, res, res), nodata=nodata) as d:
        d.write(bands)
    return path


@pytest.fixture
def site(tmp_path: Path) -> dict:
    rng = np.random.default_rng(0)
    ortho = write(tmp_path / "ortho.tif", rng.integers(30, 220, size=(3, 500, 500), dtype=np.uint8), 0.16)
    nir = write(tmp_path / "ortho.nir.tif", rng.integers(30, 220, size=(1, 500, 500), dtype=np.uint8), 0.16)
    # the DEM covers less than the photo (the photo has a buffer), offset by a fraction of a photo pixel
    yy, xx = np.mgrid[0:120, 0:120]
    dem = (100 + 0.1 * xx * 0.5).astype(np.float32)[None]  # a 10 % slope rising east
    dem_path = write(tmp_path / "dem.tif", dem, 0.5, x0=X0 + 10.07, y0=Y0 - 10.03)
    return {"ortho": ortho, "nir": nir, "dem": dem_path}


def test_dem_layers_on_a_plane():
    yy, xx = np.mgrid[0:400, 0:400]
    dem = (100 + 0.1 * xx * 0.5).astype(np.float32)
    rel2, rel10, slope = sm.dem_layers(dem, 0.5)
    inner = (slice(180, 220), slice(180, 220))  # 3 sigma of the 10 m Gaussian clear of the reflected edges
    assert np.abs(rel2[inner]).max() < 1e-3 and np.abs(rel10[inner]).max() < 1e-2
    assert np.allclose(slope[inner], np.degrees(np.arctan(0.1)), atol=0.01)


def test_site_inputs_on_the_dem_extent_aligned_to_the_photo(site):
    photo, layers, tr, crs = sm.site_inputs(site["ortho"], site["nir"], site["dem"], 0.32)
    assert tr.a == pytest.approx(0.32) and crs.to_epsg() == 3006
    # aligned to the photo's own pixel corners (X0 + k * 0.16), inside the DEM
    assert ((tr.c - X0) / 0.16) == pytest.approx(round((tr.c - X0) / 0.16))
    assert tr.c >= X0 + 10.07 and tr.c + photo.shape[2] * 0.32 <= X0 + 10.07 + 60
    assert photo.shape[0] == 4 and photo.shape[1:] == layers.shape[1:]
    assert np.isfinite(layers[:, 5:-5, 5:-5]).all()


def test_predict_writes_the_four_bands_and_knows_when_it_is_current(site, tmp_path):
    torch = pytest.importorskip("torch")
    smp = pytest.importorskip("segmentation_models_pytorch")
    classes = ["tee", "green", "fairway", "semi_rough", "rough", "deep_rough", "bunker", "water", "path",
               "rock_slab", "background"]
    torch.manual_seed(0)
    model = smp.Unet("resnet18", encoder_weights=None, in_channels=7, classes=len(classes))
    model_path = tmp_path / "surfaces.pt"
    torch.save({k: v.half() for k, v in model.state_dict().items()}, model_path)
    model_path.with_suffix(".json").write_text(json.dumps({
        "encoder": "resnet18", "inChannels": 7, "res": 0.32, "classes": classes, "photoBands": [0, 1, 2, 3],
        "demBands": ["relief_2m", "relief_10m", "slope_deg"], "demScale": [0.25, 1.0, 10.0], "demClip": 6,
        "built": "test"}))
    out = tmp_path / "surfaces-out.tif"
    rep = sm.predict(site["ortho"], site["nir"], site["dem"], model_path, out, device="cpu")
    with rasterio.open(out) as d:
        assert d.count == 4 and d.res[0] == pytest.approx(0.32)
        cls, conf, ccls, cconf = d.read()
    allowed = {0} | {sm.CLASSES.index(c) for c in classes if c != "background"}
    assert set(np.unique(cls)) <= allowed
    assert set(np.unique(ccls)) <= allowed - {0}  # the course bands never say "not course"
    assert (cconf >= 1).all() and (conf >= 1).all()
    assert rep["width"] == cls.shape[1]
    assert sm.is_current(out, site["ortho"], site["nir"], site["dem"], model_path)
    os.utime(site["dem"], ns=(1, 1))  # a changed DEM makes it stale
    assert not sm.is_current(out, site["ortho"], site["nir"], site["dem"], model_path)
