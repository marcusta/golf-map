"""nir: the photo's fourth band kept beside the RGB ortho, and rebuilt on its grid from RGBI items on disk."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import ColorInterp
from rasterio.transform import from_origin

from golfpipe import nir

CRS3006 = CRS.from_epsg(3006)
X0, Y0, RES = 533000.0, 6475000.0, 0.16


def write(path: Path, bands: np.ndarray, x0=X0, y0=Y0) -> Path:
    with rasterio.open(path, "w", driver="GTiff", width=bands.shape[2], height=bands.shape[1], count=bands.shape[0],
                       dtype="uint8", crs=CRS3006, transform=from_origin(x0, y0, RES, RES),
                       photometric="minisblack") as d:
        d.write(bands)
        if bands.shape[0] == 4:  # as Lantmäteriet's items: red, green, blue, then NIR (no alpha)
            d.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.undefined]
    return path


def rgbi(h, w, seed):
    rng = np.random.default_rng(seed)
    return rng.integers(1, 255, size=(4, h, w), dtype=np.uint8)


def test_split_nir_writes_band_four_on_the_same_grid(tmp_path):
    data = rgbi(64, 80, 1)
    path = write(tmp_path / "ortho-orto-l2-2025.tif", data)
    out = nir.split_nir(path)
    assert out == tmp_path / "ortho-orto-l2-2025.nir.tif"
    with rasterio.open(out) as d, rasterio.open(path) as src:
        assert (d.width, d.height, d.transform, d.count) == (src.width, src.height, src.transform, 1)
        assert np.array_equal(d.read(1), data[3])


def test_split_nir_skips_rgb(tmp_path):
    path = write(tmp_path / "ortho.tif", rgbi(16, 16, 2)[:3])
    assert nir.split_nir(path) is None


def test_build_nir_from_two_items_onto_the_ortho_grid(tmp_path):
    full = rgbi(100, 120, 3)
    # the RGB ortho is a crop of the two items, which split the area in a west and an east half
    ortho = write(tmp_path / "ortho.tif", full[:3, 10:90, 20:110], x0=X0 + 20 * RES, y0=Y0 - 10 * RES)
    west = write(tmp_path / "o_west.tif", full[:, :, :60])
    east = write(tmp_path / "o_east.tif", full[:, :, 60:], x0=X0 + 60 * RES)
    rep = nir.build_nir(ortho, [("o_west", west), ("o_east", east)])
    with rasterio.open(rep["out"]) as d:
        assert np.array_equal(d.read(1), full[3, 10:90, 20:110])
    assert rep["rgbCheck"] == 0.0
