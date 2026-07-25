"""Derive the publishable *analysis* DEM from a builder DEM.

The VPS (serve mode) needs DEM sampling at runtime — web putt-read, planner
green analysis and elevation profiles, iOS `AnalysisGrid` all go through
`analysis.service`'s `/analysis/sample-grid` — but shipping the full 0.5 m
lidar DEM costs ~30 MB per site. Terrain tiles (z16, ~2.4 m/px at lat 58) are
far too coarse to read a green from, so the DEM cannot simply be dropped.

This module builds option (b) of the deploy-split plan §6: ONE raster on the
source's 0.5 m grid where

- cells within ``buffer_m`` (default 30 m) of a green polygon keep their full
  0.5 m detail — this is where slope/break reading happens, and it must be
  bit-identical to what the builder would answer; and
- every other cell carries a ``coarse_factor``-block mean (default 2 → 1 m)
  of the source, replicated back onto the 0.5 m grid.

Keeping one grid, one transform and one nodata footprint means the server
needs no code change at all: the mosaic is registered as *the* ``dem_cog``
asset and `analysis.service` reads whatever the asset points at. Green reads
hit 0.5 m data, fairway profiles hit 1 m data, both out of one file. The file
stays small because DEFLATE with the floating-point predictor eats the
replicated (piecewise-constant) coarse areas.

Source selection is the caller's job, and follows the established rule: the
EDITED DEM (``sources/<siteId>/dem-edited.tif``) when the site has terrain
edits, else the pristine ``dem.tif`` — so terrain edits flow through to
published green reads exactly as they flow into tiles (D-TE2).

Green handoff format matches the terrain-edit handoff (D-TE5): a GeoJSON
FeatureCollection in WGS84; only the geometries are used (properties are
ignored). Buffering happens on the raster grid via a cell-size-aware
euclidean distance transform, so no shapely dependency is needed and the
buffer is exact in metres regardless of ring shape.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rasterio.features
from scipy.ndimage import distance_transform_edt

__all__ = [
    "DemAnalysisError",
    "DEFAULT_GREEN_BUFFER_M",
    "DEFAULT_COARSE_FACTOR",
    "load_green_geometries",
    "reproject_geometries",
    "green_mask",
    "coarsen",
    "build_analysis_dem",
]


class DemAnalysisError(RuntimeError):
    """User-actionable dem-analysis input/setup error."""


#: Metres of full-resolution margin kept around every green polygon (§6).
DEFAULT_GREEN_BUFFER_M = 30.0
#: Block factor for the coarse background: 2 turns a 0.5 m DEM into 1 m data.
DEFAULT_COARSE_FACTOR = 2


def load_green_geometries(path: Path, log=print) -> list[dict]:
    """Parses a greens GeoJSON FeatureCollection (WGS84) into a list of
    GeoJSON geometry dicts.

    Malformed *files* raise DemAnalysisError; malformed individual features
    are skipped with a warning — one bad green must never fail a publish.
    Accepts a bare geometry or a Feature as well, so the file can be produced
    by hand for a one-off.
    """
    path = Path(path)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DemAnalysisError(f"cannot read greens GeoJSON {path}: {exc}") from exc
    if not isinstance(doc, dict):
        raise DemAnalysisError(f"{path}: greens must be a GeoJSON object")

    kind = doc.get("type")
    if kind in ("Polygon", "MultiPolygon"):
        return [doc]
    if kind == "Feature":
        features = [doc]
    elif kind == "FeatureCollection":
        features = doc.get("features")
        if not isinstance(features, list):
            raise DemAnalysisError(f"{path}: FeatureCollection has no features array")
    else:
        raise DemAnalysisError(f"{path}: expected a FeatureCollection of green polygons, got type {kind!r}")

    geometries: list[dict] = []
    for i, feature in enumerate(features):
        label = f"{path.name} feature {i}"
        if not isinstance(feature, dict):
            log(f"warning: {label}: not a Feature object — skipped")
            continue
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
            log(f"warning: {label}: geometry is not a Polygon/MultiPolygon — skipped")
            continue
        geometries.append(geometry)
    return geometries


def reproject_geometries(geometries: list[dict], dem_crs) -> list[dict]:
    """Reprojects geometries from WGS84 (the handoff CRS) to the DEM's CRS."""
    from rasterio.warp import transform_geom

    return [transform_geom("EPSG:4326", dem_crs, geometry) for geometry in geometries]


def green_mask(
    geometries: list[dict],
    shape: tuple[int, int],
    transform: "rasterio.Affine",
    buffer_m: float = DEFAULT_GREEN_BUFFER_M,
) -> np.ndarray:
    """Boolean mask of cells within `buffer_m` metres of any green polygon
    (geometries already in the raster's CRS).

    The buffer is a euclidean distance transform on the rasterized polygons
    with per-axis sampling taken from the transform, so it is a true metric
    buffer on non-square cells too. `all_touched=True` when rasterizing keeps
    slivers of small greens from vanishing; the buffer dwarfs the half-cell
    difference anyway.
    """
    height, width = shape
    if not geometries:
        return np.zeros(shape, dtype=bool)

    mask = rasterio.features.rasterize(
        [(geometry, 1) for geometry in geometries],
        out_shape=(height, width),
        transform=transform,
        fill=0,
        all_touched=True,
        dtype="uint8",
    ).astype(bool)
    if buffer_m <= 0 or not mask.any():
        return mask

    cell_x = abs(transform.a)
    cell_y = abs(transform.e)
    distances = distance_transform_edt(~mask, sampling=(cell_y, cell_x))
    return mask | (distances <= buffer_m)


def coarsen(dem: np.ndarray, valid: np.ndarray, factor: int) -> np.ndarray:
    """Block-mean `dem` over `factor`x`factor` blocks and replicate the means
    back onto the full grid (float64 out).

    Only `valid` cells contribute to a block's mean; a fully-invalid block
    yields NaN (the caller pins those cells back to nodata). The grid is
    edge-padded to a whole number of blocks, so the last partial block along
    either axis averages only its real cells.
    """
    if factor <= 1:
        return dem.astype(np.float64, copy=True)

    height, width = dem.shape
    pad_r = (-height) % factor
    pad_c = (-width) % factor
    values = np.where(valid, dem, 0.0).astype(np.float64)
    weights = valid.astype(np.float64)
    if pad_r or pad_c:
        values = np.pad(values, ((0, pad_r), (0, pad_c)), mode="constant")
        weights = np.pad(weights, ((0, pad_r), (0, pad_c)), mode="constant")

    blocks_r = values.shape[0] // factor
    blocks_c = values.shape[1] // factor
    sums = values.reshape(blocks_r, factor, blocks_c, factor).sum(axis=(1, 3))
    counts = weights.reshape(blocks_r, factor, blocks_c, factor).sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        means = np.where(counts > 0, sums / np.maximum(counts, 1.0), np.nan)

    expanded = np.repeat(np.repeat(means, factor, axis=0), factor, axis=1)
    return expanded[:height, :width]


def build_analysis_dem(
    dem: np.ndarray,
    transform: "rasterio.Affine",
    nodata: float | None,
    geometries: list[dict],
    buffer_m: float = DEFAULT_GREEN_BUFFER_M,
    coarse_factor: int = DEFAULT_COARSE_FACTOR,
) -> tuple[np.ndarray, np.ndarray]:
    """Builds the mosaic. Returns `(analysis_dem, full_res_mask)`.

    Inside `full_res_mask` (greens + buffer) the output is bit-identical to
    the input — that is the whole point, and the parity test pins it. Outside
    it carries the block-mean background. Nodata cells stay nodata, so the
    raster's valid footprint is unchanged and `analysis.service` keeps
    returning `null` in exactly the same places.
    """
    source = dem.astype(np.float64)
    valid = np.isfinite(source)
    if nodata is not None:
        valid &= source != nodata

    mask = green_mask(geometries, dem.shape, transform, buffer_m)
    background = coarsen(source, valid, coarse_factor)

    out = np.where(mask, source, background)
    # A coarse block whose cells were all nodata yields NaN — and any cell that
    # was nodata in the source stays nodata, full-res or not.
    fill = nodata if nodata is not None else 0.0
    out = np.where(valid & np.isfinite(out), out, fill)
    return out.astype(np.float32), mask
