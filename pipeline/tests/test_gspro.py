"""gspro rendering helpers — square extent + hillshade, no network."""

import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.crs import CRS
from PIL import Image

import gspro

BBOX = (15.50, 58.52, 15.53, 58.54)  # Vreta-ish, WGS84


def test_square_3006_extent_is_square():
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    assert abs((e1 - e0) - (n1 - n0)) < 1e-6  # true square in metres
    assert e1 > e0 and n1 > n0


def _synthetic_dem(path, extent):
    """A DEM (EPSG:3006) with a Gaussian mound covering `extent`, so slope and
    aspect vary and hillshade is genuinely non-uniform."""
    w = 200
    e0, n0, e1, n1 = extent
    gx, gy = np.meshgrid(np.linspace(0, 1, w), np.linspace(0, 1, w))
    data = (30.0 * np.exp(-(((gx - 0.5) ** 2 + (gy - 0.5) ** 2) / 0.05))).astype("float32")
    transform = from_bounds(e0, n0, e1, n1, w, w)
    with rasterio.open(
        path, "w", driver="GTiff", height=w, width=w, count=1,
        dtype="float32", crs=CRS.from_epsg(3006), transform=transform,
    ) as dst:
        dst.write(data, 1)


def test_hillshade_renders_square_grayscale_jpeg(tmp_path):
    dem = tmp_path / "dem.tif"
    _synthetic_dem(dem, gspro._square_3006_extent(BBOX))
    out = tmp_path / "hs.jpg"

    gspro.cmd_hillshade(BBOX, out, size=64, dem_path=dem,
                        azimuth=315.0, altitude=45.0, z=1.0, resolution=0.5)

    assert out.exists()
    with Image.open(out) as im:
        assert im.size == (64, 64)
        assert im.mode == "L"  # single-band grayscale


def test_hillshade_of_a_ramp_is_not_flat(tmp_path):
    dem = tmp_path / "dem.tif"
    _synthetic_dem(dem, gspro._square_3006_extent(BBOX))
    out = tmp_path / "hs.jpg"
    gspro.cmd_hillshade(BBOX, out, size=64, dem_path=dem,
                        azimuth=315.0, altitude=45.0, z=1.0, resolution=0.5)
    arr = np.asarray(Image.open(out))
    assert arr.std() > 0  # a tilted plane must produce shading variation
