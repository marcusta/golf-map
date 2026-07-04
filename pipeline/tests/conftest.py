"""Shared fixtures: synthetic GeoTIFFs built entirely in-memory/tmpdir, no
network. Used across tiling, terrain-rgb, and manifest tests.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

# A real spot in Sweden (near Linkoping) so reprojection to EPSG:3857 and
# WGS84 bbox math behaves like production data would.
SWEREF99_TM = CRS.from_epsg(3006)
ORIGIN_X = 533000.0  # metres, SWEREF99 TM
ORIGIN_Y = 6475000.0
PIXEL_SIZE = 1.0  # 1 m/pixel
SIZE = 512


@pytest.fixture
def synthetic_dem(tmp_path: Path) -> Path:
    """512x512, EPSG:3006, 1 m/pixel, single-band float32 DEM with a known
    linear gradient (100.0 m at the west edge rising to 150.0 m at the east
    edge) so decoded terrain-RGB heights can be checked against a formula.
    """
    path = tmp_path / "dem.tif"
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL_SIZE, PIXEL_SIZE)

    col = np.arange(SIZE, dtype=np.float64)
    gradient_row = 100.0 + (col / (SIZE - 1)) * 50.0  # 100..150 m
    heights = np.tile(gradient_row, (SIZE, 1)).astype(np.float32)

    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "float32",
        "crs": SWEREF99_TM,
        "transform": transform,
        "nodata": -9999.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights, 1)

    return path


@pytest.fixture
def synthetic_dem_with_nodata(tmp_path: Path) -> Path:
    """Same as synthetic_dem but with a nodata patch in one corner, to
    exercise the terrain nodata-fill behavior.
    """
    path = tmp_path / "dem_nodata.tif"
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL_SIZE, PIXEL_SIZE)

    col = np.arange(SIZE, dtype=np.float64)
    gradient_row = 100.0 + (col / (SIZE - 1)) * 50.0
    heights = np.tile(gradient_row, (SIZE, 1)).astype(np.float32)
    heights[0:50, 0:50] = -9999.0

    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "float32",
        "crs": SWEREF99_TM,
        "transform": transform,
        "nodata": -9999.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights, 1)

    return path


@pytest.fixture
def synthetic_dem_with_interior_hole(tmp_path: Path) -> Path:
    """Same gradient DEM as synthetic_dem, but with a nodata hole entirely
    *inside* the raster (surrounded by valid data on all four sides) rather
    than touching an edge. Models the real-world case (PDAL polygon-crop
    corridors) where nodata pixels sit in the interior of otherwise-valid
    coverage, as opposed to genuinely-outside-coverage padding at the
    raster's border. Used to exercise --fill-nodata interpolation, which
    should recover values close to the surrounding gradient rather than
    the 0-fill flat-sea-level behavior appropriate for edge padding.
    """
    path = tmp_path / "dem_interior_hole.tif"
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL_SIZE, PIXEL_SIZE)

    col = np.arange(SIZE, dtype=np.float64)
    gradient_row = 100.0 + (col / (SIZE - 1)) * 50.0
    heights = np.tile(gradient_row, (SIZE, 1)).astype(np.float32)
    # Interior hole: a block roughly in the middle of the raster, well away
    # from all four edges.
    heights[200:260, 200:260] = -9999.0

    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "float32",
        "crs": SWEREF99_TM,
        "transform": transform,
        "nodata": -9999.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights, 1)

    return path


@pytest.fixture
def synthetic_dem_min50(tmp_path: Path) -> Path:
    """A DEM covering a course-sized box (2300x2300 m, matching the real
    Landeryd source DEM's scale — deliberately *not* reusing the small
    512x512 m SIZE/PIXEL_SIZE constants, since at z16 those would make a
    single tile (611 m wide) larger than the entire source raster, which
    is not representative of the real bug: the boundary-tile edge-wall
    only shows up when the source DEM's real coverage is large relative
    to a single output tile). Every value is >= 50.0 m (a gradient from
    50.0 at the west edge to 80.0 at the east edge), with no nodata
    pixels at all.

    Used to assert the edge-pad fix: after tiling, boundary/overlap tiles
    (which sample past this DEM's real coverage) must never decode any
    height below the source minimum, i.e. no 0 m cliff-wall pixels — the
    whole point of edge_pad_dem replicating edge heights instead of
    0-filling outside-coverage padding.
    """
    path = tmp_path / "dem_min50.tif"
    course_size = 2300  # metres, matches the real Landeryd DEM's extent
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL_SIZE, PIXEL_SIZE)

    col = np.arange(course_size, dtype=np.float64)
    gradient_row = 50.0 + (col / (course_size - 1)) * 30.0  # 50..80 m
    heights = np.tile(gradient_row, (course_size, 1)).astype(np.float32)

    profile = {
        "driver": "GTiff",
        "height": course_size,
        "width": course_size,
        "count": 1,
        "dtype": "float32",
        "crs": SWEREF99_TM,
        "transform": transform,
        "nodata": -9999.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights, 1)

    return path


@pytest.fixture
def synthetic_ortho(tmp_path: Path) -> Path:
    """512x512, EPSG:3006, 1 m/pixel, 3-band uint8 RGB raster with a
    deterministic pattern (not nodata anywhere).
    """
    path = tmp_path / "ortho.tif"
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL_SIZE, PIXEL_SIZE)

    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    r = (xx % 256).astype(np.uint8)
    g = (yy % 256).astype(np.uint8)
    b = np.full((SIZE, SIZE), 128, dtype=np.uint8)
    rgb = np.stack([r, g, b], axis=0)

    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 3,
        "dtype": "uint8",
        "crs": SWEREF99_TM,
        "transform": transform,
        "nodata": 0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(rgb)

    return path


@pytest.fixture
def synthetic_ortho_with_nodata(tmp_path: Path) -> Path:
    """Ortho raster with a fully-nodata band region in one corner, to
    exercise tile-skipping.
    """
    path = tmp_path / "ortho_nodata.tif"
    transform = from_origin(ORIGIN_X, ORIGIN_Y, PIXEL_SIZE, PIXEL_SIZE)

    rgb = np.full((3, SIZE, SIZE), 200, dtype=np.uint8)
    # Zero out the whole top-left quadrant to guarantee some tiles are 100% nodata.
    rgb[:, 0 : SIZE // 2, 0 : SIZE // 2] = 0

    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 3,
        "dtype": "uint8",
        "crs": SWEREF99_TM,
        "transform": transform,
        "nodata": 0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(rgb)

    return path
