"""Unity sculpt layers: heights changed in Unity, carried back as terrain edits.

Unity's golfmap.terrain.capture writes what was sculpted on a terrain since
golf-map last sent its heights (golfmap-sculpt-v1: a float32 .raw in metres
on the Unity heightmap's own grid, north-up, cropped, plus a .json). Here:

- ``capture_to_geotiff`` turns a capture into an EPSG:3006 GeoTIFF, the file
  a `delta` terrain edit points at (dem_edit.py adds it onto the DEM, after
  every other edit).
- ``sculpt_on_grid`` resamples sculpt GeoTIFFs onto a heightmap export's grid
  — what ``gspro.py dem --sculpt`` writes next to the heightmap as
  `<stem>-sculpt-in.raw`, so Unity knows how much of the heights it gets is
  sculpt, and its next capture is the whole layer rather than only the new
  strokes.

The grid is the .raw heightmap's: `size`² pixels over the terrain square
(``rasterio.transform.from_bounds(square, size, size)``), row 0 north. Unity
reads pixel (col, row) as heightmap vertex (col, size−1−row); the capture and
the sculpt-in use that same pixel grid, so the two directions agree cell for
cell.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

__all__ = ["CAPTURE_FORMAT", "SculptError", "capture_to_geotiff", "sculpt_on_grid"]

CAPTURE_FORMAT = "golfmap-sculpt-v1"
SWEREF99 = CRS.from_epsg(3006)


class SculptError(RuntimeError):
    """A capture that cannot be read."""


def capture_to_geotiff(meta_path: Path, out: Path) -> dict:
    """The capture described by `meta_path` (its .raw next to it) as a
    float32 GeoTIFF at `out`, covering just the crop; returns the metadata
    plus `bounds3006` (x0, y0, x1, y1 of the written raster)."""
    meta_path = Path(meta_path)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("format") != CAPTURE_FORMAT:
        raise SculptError(f"{meta_path.name}: format must be {CAPTURE_FORMAT}")
    crop = meta.get("crop")
    if not crop or not meta.get("file"):
        raise SculptError(f"{meta_path.name}: the capture has no sculpted cells")
    size = int(meta["size"])
    e0, n0, e1, n1 = (float(v) for v in meta["square3006"])
    cols, rows = int(crop["cols"]), int(crop["rows"])
    col0, row0 = int(crop["col0"]), int(crop["row0"])
    if cols <= 0 or rows <= 0 or col0 < 0 or row0 < 0 or col0 + cols > size or row0 + rows > size:
        raise SculptError(f"{meta_path.name}: crop {crop} does not fit the {size}² grid")
    raw = meta_path.with_name(meta["file"])
    data = np.fromfile(raw, dtype="<f4")
    if data.size != cols * rows:
        raise SculptError(f"{raw.name} holds {data.size} floats, not {cols}×{rows}")
    data = data.reshape(rows, cols)

    full = from_bounds(e0, n0, e1, n1, size, size)
    transform = full * rasterio.Affine.translation(col0, row0)
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", driver="GTiff", width=cols, height=rows, count=1, dtype="float32",
                       crs=SWEREF99, transform=transform, compress="deflate", predictor=3) as dst:
        dst.write(data.astype(np.float32), 1)
    px = (e1 - e0) / size
    bounds = (e0 + col0 * px, n1 - (row0 + rows) * px, e0 + (col0 + cols) * px, n1 - row0 * px)
    return {**meta, "bounds3006": [round(v, 3) for v in bounds]}


def sculpt_on_grid(tifs: list[Path], extent: tuple[float, float, float, float], size: int) -> np.ndarray:
    """The sum of the sculpt GeoTIFFs `tifs`, resampled (bilinear, 0 outside
    them) onto the `size`² heightmap pixel grid over `extent`, row 0 north."""
    e0, n0, e1, n1 = extent
    dst_transform = from_bounds(e0, n0, e1, n1, size, size)
    total = np.zeros((size, size), dtype=np.float32)
    for tif in tifs:
        layer = np.zeros((size, size), dtype=np.float32)
        with rasterio.open(tif) as src:
            reproject(source=rasterio.band(src, 1), destination=layer, src_transform=src.transform, src_crs=src.crs,
                      dst_transform=dst_transform, dst_crs=SWEREF99, resampling=Resampling.bilinear,
                      src_nodata=None, dst_nodata=0.0)
        total += np.nan_to_num(layer)
    return total
