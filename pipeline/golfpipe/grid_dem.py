"""Bins classified lidar points (COPC/LAS/LAZ) into a regular grid DEM.

Used by the `grid-dem` command to build an authoritative bare-earth-ish
surface directly from Lantmateriet's classified point clouds
(`dsm-skoglig-copc` collection), replacing the old reverse-engineered
local rasters. Ground (class 2) and water (class 9) points are the
default "terrain surface" classes; bridge deck (class 17) is included
too when present in the source data, since it should behave like solid
ground for a walkable course DEM.

Memory strategy: point clouds here can be 100M+ points and several
hundred MB to ~1 GB compressed. Reading the whole file into a single
array of points would be wasteful and, for very large tiles, could blow
memory. Instead this reads via laspy's chunked iterator and accumulates
two float64 grids (sum of z per cell, count of points per cell) — only
those two O(rows*cols) arrays are held in memory, not the raw points.
At 0.5 m resolution over a ~3.1x3.1 km buffered box that's about
6200x6200 cells, i.e. ~300 MB per accumulator array (acceptable per the
task's own sizing note); callers needing to shrink memory further can
pass a coarser `resolution`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import laspy
import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.fill import fillnodata
from rasterio.transform import from_origin
from scipy.ndimage import median_filter

DEFAULT_CLASSES = (2, 9)  # ground, water
BRIDGE_CLASS = 17
DEFAULT_RESOLUTION = 0.5
DEFAULT_CHUNK_SIZE = 2_000_000
SPIKE_THRESHOLD_M = 2.0  # used by describe_spikes, not by gridding itself


@dataclass
class ClassCounts:
    """Per-classification-code point counts encountered while scanning one
    or more lidar files, restricted to the requested bbox. Used for the
    "report per-class counts" requirement — this is diagnostic, not just
    counts of points actually gridded (a point can be in a requested class
    but outside the bbox and therefore excluded from both).
    """

    counts: dict[int, int] = field(default_factory=dict)
    used_classes: tuple[int, ...] = ()
    total_points_in_bbox: int = 0
    points_used_for_grid: int = 0

    def add(self, classification: int, n: int) -> None:
        self.counts[classification] = self.counts.get(classification, 0) + n


def _grid_shape(bbox_3006: tuple[float, float, float, float], resolution: float) -> tuple[int, int, "rasterio.Affine"]:
    e_min, n_min, e_max, n_max = bbox_3006
    width = int(np.ceil((e_max - e_min) / resolution))
    height = int(np.ceil((n_max - n_min) / resolution))
    transform = from_origin(e_min, n_max, resolution, resolution)
    return width, height, transform


def detect_available_classes(lidar_paths: list[Path]) -> set[int]:
    """Scans LAS/LAZ header point-count-by-return info is not enough for
    per-class detection, so this does a lightweight full pass over each
    file's classification codes (chunked) and returns the set of distinct
    codes present. Used to decide whether class 17 (bridge) actually
    exists in a given dataset before requesting it.
    """
    found: set[int] = set()
    for path in lidar_paths:
        with laspy.open(str(path)) as reader:
            for chunk in reader.chunk_iterator(DEFAULT_CHUNK_SIZE):
                classes = np.asarray(chunk.classification)
                found.update(int(c) for c in np.unique(classes))
    return found


def grid_lidar_points(
    lidar_paths: list[Path],
    bbox_3006: tuple[float, float, float, float],
    resolution: float = DEFAULT_RESOLUTION,
    classes: tuple[int, ...] | None = DEFAULT_CLASSES,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    *,
    aggregate: str = "sum",
    exclude_classes: tuple[int, ...] = (),
) -> tuple[np.ndarray, np.ndarray, "rasterio.Affine", ClassCounts]:
    """Reads one or more LAS/LAZ/COPC files in chunks, filters points to
    bbox_3006 (e_min, n_min, e_max, n_max in EPSG:3006 metres) and to the
    requested classification codes, and bins them into a regular grid:
    mean z per cell.

    Returns (sum_grid, count_grid, transform, class_counts). Callers
    combine sum/count into a mean-height grid (see build_dem_grid) —
    kept as raw accumulators here so multiple files can be merged before
    finalizing, and so this function alone is easy to unit test.

    Aggregation modes (keyword-only, DEM callers are untouched):
    - aggregate="sum" (default): the historical contract above — the first
      grid is the per-cell z sum, mean = sum / count.
    - aggregate="max": the first grid is the per-cell z MAX instead
      (np.maximum.at), used by detect-trees to build a canopy surface
      (nDSM); cells no point hit hold -inf, so callers must mask by
      count_grid > 0. count/transform/class_counts semantics unchanged.

    Class selection: `classes=None` uses ALL classification codes (the
    detect-trees "every return is surface" case); `exclude_classes` then
    drops codes from whatever `classes` selected (e.g. noise 7/18).
    """
    if aggregate not in ("sum", "max"):
        raise ValueError(f"aggregate must be 'sum' or 'max', got {aggregate!r}")
    width, height, transform = _grid_shape(bbox_3006, resolution)
    init = 0.0 if aggregate == "sum" else -np.inf
    sum_grid = np.full((height, width), init, dtype=np.float64)
    count_grid = np.zeros((height, width), dtype=np.float64)
    class_counts = ClassCounts(used_classes=tuple(classes) if classes is not None else ())

    e_min, n_min, e_max, n_max = bbox_3006
    inv_res = 1.0 / resolution

    for path in lidar_paths:
        with laspy.open(str(path)) as reader:
            for chunk in reader.chunk_iterator(chunk_size):
                x = np.asarray(chunk.x, dtype=np.float64)
                y = np.asarray(chunk.y, dtype=np.float64)
                z = np.asarray(chunk.z, dtype=np.float64)
                classification = np.asarray(chunk.classification)

                in_bbox = (x >= e_min) & (x < e_max) & (y >= n_min) & (y < n_max)
                if not np.any(in_bbox):
                    # Still tally class counts for points inside the bbox
                    # only (points entirely outside are not interesting
                    # diagnostics for this dataset/course).
                    continue

                x_b, y_b, z_b, cls_b = x[in_bbox], y[in_bbox], z[in_bbox], classification[in_bbox]
                class_counts.total_points_in_bbox += int(cls_b.size)
                for code in np.unique(cls_b):
                    class_counts.add(int(code), int(np.count_nonzero(cls_b == code)))

                if classes is None:
                    use_mask = np.ones(cls_b.shape, dtype=bool)
                else:
                    use_mask = np.isin(cls_b, classes)
                if exclude_classes:
                    use_mask &= ~np.isin(cls_b, exclude_classes)
                if not np.any(use_mask):
                    continue
                x_u, y_u, z_u = x_b[use_mask], y_b[use_mask], z_b[use_mask]
                class_counts.points_used_for_grid += int(x_u.size)

                # Row 0 is the north edge (from_origin uses n_max as top).
                col = np.floor((x_u - e_min) * inv_res).astype(np.int64)
                row = np.floor((n_max - y_u) * inv_res).astype(np.int64)

                valid = (col >= 0) & (col < width) & (row >= 0) & (row < height)
                col, row, z_u = col[valid], row[valid], z_u[valid]

                flat_idx = row * width + col
                if aggregate == "max":
                    np.maximum.at(sum_grid.reshape(-1), flat_idx, z_u)
                else:
                    np.add.at(sum_grid.reshape(-1), flat_idx, z_u)
                np.add.at(count_grid.reshape(-1), flat_idx, 1.0)

    return sum_grid, count_grid, transform, class_counts


def build_dem_grid(
    sum_grid: np.ndarray,
    count_grid: np.ndarray,
    fill_nodata: bool = True,
    median_despike: bool = True,
    nodata_value: float = -9999.0,
) -> np.ndarray:
    """Turns accumulated sum/count grids into a finished float32 DEM:
    mean z per populated cell, rasterio.fill.fillnodata for empty cells,
    then a light 3x3 median filter to kill single-cell spikes (isolated
    noisy points surviving classification, e.g. birds/wires misclassified
    as ground).
    """
    populated = count_grid > 0
    mean_grid = np.full(count_grid.shape, nodata_value, dtype=np.float64)
    mean_grid[populated] = sum_grid[populated] / count_grid[populated]

    if fill_nodata and not populated.all():
        if populated.any():
            mean_grid = fillnodata(mean_grid, mask=populated.astype(np.uint8), max_search_distance=200.0)
        # If nothing at all is populated, leave as nodata_value everywhere;
        # fillnodata has nothing to interpolate from.

    if median_despike:
        # 3x3 median across the whole grid, then only accept the median
        # where the original cell was populated (or already filled) so we
        # don't smear real edge-of-coverage nodata around.
        smoothed = median_filter(mean_grid, size=3, mode="nearest")
        mean_grid = smoothed

    return mean_grid.astype(np.float32)


def write_dem_geotiff(
    dem: np.ndarray,
    transform: "rasterio.Affine",
    out_path: Path,
    crs: CRS | int = 3006,
    nodata_value: float = -9999.0,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    profile = {
        "driver": "GTiff",
        "height": dem.shape[0],
        "width": dem.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": CRS.from_epsg(crs) if isinstance(crs, int) else crs,
        "transform": transform,
        "nodata": nodata_value,
        # Compressed + tiled: DEFLATE with the floating-point predictor shrinks
        # smooth lidar DEMs several-fold vs raw float32, while staying a plain
        # georeferenced GeoTIFF the analysis service reads unchanged.
        "compress": "deflate",
        "predictor": 3,  # floating-point predictor
        "zlevel": 9,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(dem, 1)
    return out_path


def describe_spikes(dem: np.ndarray, threshold_m: float = SPIKE_THRESHOLD_M) -> int:
    """Counts cells whose max abs difference to any of their 8 neighbours
    exceeds threshold_m — a quick spike-noise sanity metric (not used by
    gridding itself, just diagnostics for the caller to report).
    """
    padded = np.pad(dem, 1, mode="edge")
    max_diff = np.zeros_like(dem)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            shifted = padded[1 + dy : 1 + dy + dem.shape[0], 1 + dx : 1 + dx + dem.shape[1]]
            diff = np.abs(dem - shifted)
            max_diff = np.maximum(max_diff, diff)
    return int(np.count_nonzero(max_diff > threshold_m))
