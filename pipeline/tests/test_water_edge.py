"""golfpipe.water_edge: a pond's edge found on the photo between the lidar's water and the drawn outline."""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Polygon

from golfpipe.water_edge import water_edge

E0, N0 = 500000.0, 6500000.0   # the pond's centre
TRUE_HALF = 20.0               # the real water's edge: a square 40 m across
LIDAR_HALF = 18.5              # the lidar's flat sheet stops 1.5 m short of it (the bank smeared over the water)
DRAWN_HALF = 21.0              # the drawn outline 1 m outside it


def square(half: float) -> list[list[float]]:
    return [[E0 - half, N0 - half], [E0 + half, N0 - half], [E0 + half, N0 + half], [E0 - half, N0 + half]]


def write_dem(path, res=0.5):
    n = int(120 / res)
    xs = E0 - 60 + (np.arange(n) + 0.5) * res
    ys = N0 + 60 - (np.arange(n) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    d = np.maximum(abs(X - E0), abs(Y - N0))           # square "radius"
    z = np.where(d <= LIDAR_HALF, 10.0, 10.0 + (d - LIDAR_HALF) * 0.6).astype(np.float32)
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32", crs="EPSG:3006",
                       transform=from_origin(E0 - 60, N0 + 60, res, res), nodata=-9999) as dst:
        dst.write(z, 1)


def write_ortho(path, water_half: float | None, res=0.25, reeds_from: float | None = None):
    n = int(120 / res)
    xs = E0 - 60 + (np.arange(n) + 0.5) * res
    ys = N0 + 60 - (np.arange(n) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    d = np.maximum(abs(X - E0), abs(Y - N0))
    rgb = np.zeros((3, n, n), dtype=np.uint8)
    grass, water, reeds = (95, 135, 60), (45, 62, 70), (100, 140, 70)
    rng = np.random.default_rng(1)
    for k in range(3):
        band = np.full((n, n), grass[k], dtype=float)
        if water_half is not None:
            band = np.where(d <= water_half, water[k], band)
        if reeds_from is not None:   # reeds from the lidar's edge out: looks like land right up to the open water
            band = np.where((d > LIDAR_HALF) & (d <= reeds_from), reeds[k], band)
        rgb[k] = np.clip(band + rng.normal(0, 3, (n, n)), 0, 255).astype(np.uint8)
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=3, dtype="uint8", crs="EPSG:3006",
                       transform=from_origin(E0 - 60, N0 + 60, res, res)) as dst:
        dst.write(rgb)


def half_width(ring) -> float:
    p = Polygon(ring)
    return float(np.sqrt(p.area) / 2)


def test_the_edge_is_found_on_the_photo_between_the_lidar_and_the_drawn_line(tmp_path):
    write_dem(tmp_path / "dem.tif")
    write_ortho(tmp_path / "ortho.tif", TRUE_HALF)
    r = water_edge(str(tmp_path / "dem.tif"), square(DRAWN_HALF), orthos=[str(tmp_path / "ortho.tif")],
                   image=str(tmp_path / "check.png"))
    assert r["level"] == pytest.approx(10.0)
    assert half_width(r["lidarRing"]) == pytest.approx(LIDAR_HALF, abs=0.4)
    assert half_width(r["ring"]) == pytest.approx(TRUE_HALF, abs=0.35)   # the photo's edge, not the lidar's
    assert r["movedM"]["p50"] == pytest.approx(DRAWN_HALF - TRUE_HALF, abs=0.35)
    assert sum(k["toM"] - k["fromM"] for k in r["kept"]) < 10            # (the corners may stay)
    assert (tmp_path / "check.png").exists()


def test_reeds_keep_the_drawn_line_and_say_so(tmp_path):
    write_dem(tmp_path / "dem.tif")
    write_ortho(tmp_path / "ortho.tif", LIDAR_HALF, reeds_from=DRAWN_HALF + 0.5)
    r = water_edge(str(tmp_path / "dem.tif"), square(DRAWN_HALF), orthos=[str(tmp_path / "ortho.tif")])
    perimeter = 8 * DRAWN_HALF
    assert sum(k["toM"] - k["fromM"] for k in r["kept"]) > 0.8 * perimeter
    assert half_width(r["ring"]) == pytest.approx(DRAWN_HALF, abs=0.2)


def test_toward_moves_every_point_that_share_of_the_way_to_the_lidar_edge(tmp_path):
    write_dem(tmp_path / "dem.tif")
    r = water_edge(str(tmp_path / "dem.tif"), square(DRAWN_HALF), toward=0.5)
    assert half_width(r["ring"]) == pytest.approx((DRAWN_HALF + LIDAR_HALF) / 2, abs=0.35)


def test_a_photo_that_cannot_tell_water_from_land_is_refused(tmp_path):
    write_dem(tmp_path / "dem.tif")
    write_ortho(tmp_path / "ortho.tif", None)   # all grass: the lidar's water looks like the land
    with pytest.raises(ValueError, match="orthophoto"):
        water_edge(str(tmp_path / "dem.tif"), square(DRAWN_HALF), orthos=[str(tmp_path / "ortho.tif")])
