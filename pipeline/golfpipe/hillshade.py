"""QGIS/GDAL-style hillshade (Horn gradients) from a DEM GeoTIFF.

Produces an OPAQUE single-band uint8 grayscale raster — every pixel has a
value (flat ground ≈ mid grey, slopes lighter/darker) — unlike a client-side
MapLibre hillshade layer, which is a translucent shading overlay. Tiled and
served as an ordinary raster layer so the map shows the same relief image
QGIS renders with `gdaldem hillshade -az 315 -alt 45 -z 1`.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import rasterio

# QGIS defaults — match the layer styling the user calibrated in QGIS.
DEFAULT_AZIMUTH = 315.0
DEFAULT_ALTITUDE = 45.0
DEFAULT_Z_FACTOR = 1.0


def hillshade_horn(
    dem: np.ndarray,
    res_m: float,
    azimuth: float = DEFAULT_AZIMUTH,
    altitude: float = DEFAULT_ALTITUDE,
    z: float = DEFAULT_Z_FACTOR,
) -> np.ndarray:
    """QGIS/GDAL-style hillshade (Horn gradients). Returns uint8 0..255."""
    x, y = np.gradient(dem * z, res_m, res_m)
    slope = np.pi / 2.0 - np.arctan(np.hypot(x, y))
    aspect = np.arctan2(-x, y)
    az = np.radians(azimuth)
    alt = np.radians(altitude)
    shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos((az - np.pi / 2.0) - aspect)
    return (255.0 * (shaded + 1) / 2).clip(0, 255).astype("uint8")


def write_hillshade_geotiff(
    dem_path: Path,
    out_path: Path,
    azimuth: float = DEFAULT_AZIMUTH,
    altitude: float = DEFAULT_ALTITUDE,
    z: float = DEFAULT_Z_FACTOR,
) -> Path:
    """Reads a DEM GeoTIFF, computes an opaque uint8 hillshade in the DEM's own
    grid/CRS, and writes it as a single-band GeoTIFF ready for tile-ortho.

    Interior nodata (-9999 / non-finite) is filled with the mean so the shading
    doesn't cliff at holes; those areas are outside real coverage and end up
    outside the tile pyramid anyway.
    """
    with rasterio.open(dem_path) as src:
        dem = src.read(1).astype("float64")
        transform = src.transform
        crs = src.crs
        nodata = src.nodata

    finite = np.isfinite(dem) & (dem > -1e5)
    if nodata is not None:
        finite &= dem != nodata
    if not finite.all():
        dem = dem.copy()
        dem[~finite] = float(dem[finite].mean()) if finite.any() else 0.0

    res_m = abs(transform.a)  # metres per pixel (DEM is EPSG:3006, metres)
    shade = hillshade_horn(dem, res_m, azimuth, altitude, z)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out_path, "w", driver="GTiff",
        height=shade.shape[0], width=shade.shape[1],
        count=1, dtype="uint8", crs=crs, transform=transform,
    ) as dst:
        dst.write(shade, 1)
    return out_path
