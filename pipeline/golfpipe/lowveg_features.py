"""Shrub-zone proposals from lidar (lowveg-features command;
docs/feature-vegetation-zones.md D-VZ7).

Lidar does not place lower vegetation, VSPro does, from rules. What lidar
can do is say where bushes and tall scrub already stand: cells of the
cleaned canopy grid (canopy.tif from the canopy workdir, or the same grid
built from lidar) whose height is between min_height_m (0.5 m) and
max_height_m (3 m) and which are not trees. Those cells are cleaned and
polygonised the way trees_features does it and become ordinary
`vegetation_zone` features of zone type `shrub` once imported — editable,
deletable, re-importable by source. Nothing is placed from lidar directly.

Two inputs, one pipeline after the mask:

- From lidar (lowveg_from_points, what `--lidar` runs): the points
  themselves are counted. Every non-noise return gets a height above the
  ground grid (bilinear), and a cell is low vegetation when the 3x3 cells
  around it hold at least min_points returns between min_height_m and
  max_height_m and the cell itself holds one. The cleaned canopy grid
  cannot do this: it keeps only the highest return per cell and drops
  everything under canopy.MIN_CANOPY_HEIGHT_M (1 m), so 0.5..1 m scrub
  never reached it. Measured on Vreta's 2050 m square (2 points/m²,
  leaf-off March 2021): ground returns spread to about +0.4 m, so 0.5 m
  is clear of them; a 3-return window keeps hedges the grid missed.
  Returns from garden objects (cars, fences, trampolines, sheds) look the
  same as shrubs, single-return share included (a dense hedge is single-
  return too), so cells within roof_buffer_m (10 m) of the canopy grid's
  roof cells are dropped. That cleared Vreta's housing areas and kept
  the hedges along the car park and the road.
- From a canopy.tif (lowveg_from_canopy, `--canopy-tif`): cells of the
  cleaned grid in the band. Kept for runs without the point cloud; its
  effective floor is 1 m, see above.

Steps for the canopy grid (lowveg_from_canopy); the points path swaps
step 1 for the count above and adds the roof buffer to step 2:

1. mask = min_height_m <= canopy <= max_height_m.
2. Trees are cut out: every cell above max_height_m is a tree by
   definition, and so is everything within tree_buffer_m of one (binary
   dilation by a disk), because the crown edge of a 12 m birch reads as
   2 m of "low vegetation" in a max-z grid. With `trees` (polygons from
   trees-features, or the app's exported trees features) those are
   buffered by tree_buffer_m and burned out as well.
3. trees_features.denoise_mask: closing with a disk of close_m, then
   8-connected components under min_area_m2 are dropped.
4. Polygonize 8-connected (interior gaps are holes), rings under
   min_hole_area_m2 filled, then trees_features.round_outlines (vector
   close/open, Chaikin, simplify, union) and polygons under min_area_m2
   dropped. min_area_m2 defaults to 20 m²: a zone is a VSPro rule area,
   and a 4 m² bush is better left to the biome's own scatter than made a
   feature someone has to accept.
5. Height stats per polygon over the low-vegetation cells inside it
   (canopy above max_height_m zeroed first, so a tree cell rounding pulled
   in never enters them): heightP90M and heightMaxM, 1 decimal, plus
   areaM2.

Output (build_lowveg_feature_collection): GeoJSON FeatureCollection in
EPSG:3006 with the legacy `crs` member, one Polygon per feature, properties
type "vegetation_zone", source "lidar-lowveg", source_ref, license
"CC0-1.0", zoneType "shrub", weight 1, feather 2, noise 0, heightP90M,
heightMaxM, areaM2. The server imports it via
`PUT /api/courses/:courseId/features/generated?source=lidar-lowveg` and
turns the non-reserved scalar properties (zoneType, weight, feather,
noise, the stats) into the feature's attributes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import laspy
import numpy as np
import rasterio.features
from scipy.ndimage import binary_dilation, map_coordinates, uniform_filter
from shapely.geometry import shape
from shapely.geometry.base import BaseGeometry

from golfpipe.detect_common import LASERDATA_ATTRIBUTION, _polygon_coordinates, mask_to_polygons
from golfpipe.trees_features import (
    DEFAULT_CLOSE_M,
    DEFAULT_ROUND_M,
    _height_stats,
    denoise_mask,
    disk_structure,
    fill_small_holes,
    read_canopy_tif,
    round_outlines,
)
from golfpipe.water import GEOJSON_CRS_3006

__all__ = [
    "DEFAULT_MIN_HEIGHT_M", "DEFAULT_MAX_HEIGHT_M", "DEFAULT_TREE_BUFFER_M", "DEFAULT_MIN_AREA_M2",
    "DEFAULT_MIN_HOLE_AREA_M2", "DEFAULT_CLOSE_M", "DEFAULT_ROUND_M", "DEFAULT_SIMPLIFY_M",
    "FEATURE_TYPE", "SOURCE", "LICENSE", "ZONE_TYPE", "ZONE_WEIGHT", "ZONE_FEATHER_M", "ZONE_NOISE_M",
    "DEFAULT_MIN_POINTS", "DEFAULT_ROOF_BUFFER_M",
    "LowVegPolygon", "BandCounts", "read_tree_polygons", "tree_mask", "count_band_points",
    "lowveg_from_canopy", "lowveg_from_points",
    "build_lowveg_feature_collection", "read_canopy_tif",
]

DEFAULT_MIN_HEIGHT_M = 0.5
DEFAULT_MAX_HEIGHT_M = 3.0
DEFAULT_TREE_BUFFER_M = 1.0
DEFAULT_MIN_AREA_M2 = 20.0
DEFAULT_MIN_HOLE_AREA_M2 = 20.0
DEFAULT_SIMPLIFY_M = 0.5
# Points path: returns in the height band over the 3x3 cells around a cell,
# and the distance from a roof cell inside which nothing is proposed.
DEFAULT_MIN_POINTS = 3
DEFAULT_ROOF_BUFFER_M = 10.0
DEFAULT_CHUNK_SIZE = 2_000_000

FEATURE_TYPE = "vegetation_zone"
SOURCE = "lidar-lowveg"
LICENSE = "CC0-1.0"
# The zone fields every proposal gets (docs/feature-vegetation-zones.md §5 defaults).
ZONE_TYPE = "shrub"
ZONE_WEIGHT = 1.0
ZONE_FEATHER_M = 2.0
ZONE_NOISE_M = 0.0


@dataclass
class LowVegPolygon:
    geometry: BaseGeometry  # shapely Polygon, EPSG:3006
    height_p90_m: float
    height_max_m: float
    area_m2: int


def read_tree_polygons(path: Path) -> list[BaseGeometry]:
    """Polygon/MultiPolygon geometries of a GeoJSON file in EPSG:3006 metres
    (trees-features output, or the app's exported features). When features
    carry a `type` property only the `trees` ones count; without it every
    polygon does. A file in degrees is refused."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    features = doc.get("features") if isinstance(doc, dict) else None
    if doc.get("type") == "Feature":
        features = [doc]
    if not isinstance(features, list):
        raise ValueError(f"{path} is not a GeoJSON FeatureCollection")
    crs_name = str(((doc.get("crs") or {}).get("properties") or {}).get("name") or "")
    if crs_name and "3006" not in crs_name:
        raise ValueError(f"{path}: trees must be in EPSG:3006 metres, not {crs_name}")
    typed = [f for f in features if isinstance((f.get("properties") or {}).get("type"), str)]
    if typed:
        features = [f for f in typed if f["properties"]["type"] == "trees"]
    out: list[BaseGeometry] = []
    for f in features:
        geom = f.get("geometry") or {}
        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        g = shape(geom)
        if g.is_empty:
            continue
        minx, miny, maxx, maxy = g.bounds
        if abs(minx) <= 180 and abs(maxx) <= 180 and abs(miny) <= 90 and abs(maxy) <= 90:
            raise ValueError(f"{path}: trees look like WGS84 degrees; export them in EPSG:3006 metres")
        out.append(g if g.is_valid else g.buffer(0))
    return out


def tree_mask(
    canopy: np.ndarray,
    transform: "rasterio.Affine",
    max_height_m: float,
    trees: list[BaseGeometry] | None,
    tree_buffer_m: float,
) -> np.ndarray:
    """Cells that are trees or within tree_buffer_m of one: canopy above
    max_height_m dilated by a disk of tree_buffer_m, plus the given tree
    polygons buffered by tree_buffer_m and rasterized (all_touched)."""
    heights = np.asarray(canopy)
    cell_size = float(abs(transform.a))
    tall = heights > max_height_m
    if tree_buffer_m > 0.0 and tall.any():
        structure = disk_structure(tree_buffer_m / cell_size)
        if structure.shape != (1, 1):
            tall = binary_dilation(tall, structure=structure)
    if trees:
        shapes = [(g.buffer(tree_buffer_m, join_style="round") if tree_buffer_m > 0.0 else g, 1) for g in trees]
        burned = rasterio.features.rasterize(
            shapes, out_shape=heights.shape, transform=transform, fill=0, dtype="uint8", all_touched=True,
        )
        tall = tall | (burned > 0)
    return tall


def lowveg_from_canopy(
    canopy: np.ndarray,
    transform: "rasterio.Affine",
    min_height_m: float = DEFAULT_MIN_HEIGHT_M,
    max_height_m: float = DEFAULT_MAX_HEIGHT_M,
    trees: list[BaseGeometry] | None = None,
    tree_buffer_m: float = DEFAULT_TREE_BUFFER_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    close_m: float = DEFAULT_CLOSE_M,
    round_m: float = DEFAULT_ROUND_M,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    min_hole_area_m2: float = DEFAULT_MIN_HOLE_AREA_M2,
) -> list[LowVegPolygon]:
    """Cleaned canopy grid (metres above ground, 0 = none; north-up affine
    transform in EPSG:3006) -> shrub-zone polygons with height stats. See
    the module docstring for the steps."""
    if max_height_m <= min_height_m:
        raise ValueError("max_height_m must be greater than min_height_m")
    heights = np.nan_to_num(np.asarray(canopy, dtype=np.float64), nan=0.0)
    mask = (heights >= min_height_m) & (heights <= max_height_m)
    mask &= ~tree_mask(heights, transform, max_height_m, trees, tree_buffer_m)
    low = np.where(heights <= max_height_m, heights, 0.0)
    return _zones_from_mask(mask, low, transform, min_height_m, min_area_m2, close_m, round_m, simplify_m,
                            min_hole_area_m2)


@dataclass
class BandCounts:
    """Per-cell result of count_band_points, on the ground grid's cells."""
    count: np.ndarray       # returns between min and max height above ground
    max_height: np.ndarray  # highest of those returns, metres above ground (0 = none)


def count_band_points(
    lidar_paths: list[Path],
    bbox_3006: tuple[float, float, float, float],
    ground_dem: np.ndarray,
    resolution: float,
    min_height_m: float = DEFAULT_MIN_HEIGHT_M,
    max_height_m: float = DEFAULT_MAX_HEIGHT_M,
    exclude_classes: tuple[int, ...] = (7, 18),
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> BandCounts:
    """Reads the point clouds in chunks and counts, per cell of the grid
    over bbox_3006 (row 0 north, the grid ground_dem is on), the returns
    whose height above ground is in [min_height_m, max_height_m]. Ground
    height is ground_dem sampled bilinearly at the point (cell values sit at
    cell centres), so a slope does not lift a point into the band. Noise
    classes are skipped; every other class counts, since Laserdata has no
    vegetation class."""
    e_min, n_min, e_max, n_max = bbox_3006
    ground = np.asarray(ground_dem, dtype=np.float64)
    height, width = ground.shape
    count = np.zeros(height * width, dtype=np.float64)
    top = np.zeros(height * width, dtype=np.float64)
    inv = 1.0 / resolution
    for path in lidar_paths:
        with laspy.open(str(path)) as reader:
            for chunk in reader.chunk_iterator(chunk_size):
                x = np.asarray(chunk.x, dtype=np.float64)
                y = np.asarray(chunk.y, dtype=np.float64)
                keep = (x >= e_min) & (x < e_max) & (y >= n_min) & (y < n_max)
                if exclude_classes:
                    keep &= ~np.isin(np.asarray(chunk.classification), exclude_classes)
                if not keep.any():
                    continue
                x, y, z = x[keep], y[keep], np.asarray(chunk.z, dtype=np.float64)[keep]
                col = np.floor((x - e_min) * inv).astype(np.int64)
                row = np.floor((n_max - y) * inv).astype(np.int64)
                valid = (col >= 0) & (col < width) & (row >= 0) & (row < height)
                x, y, z, col, row = x[valid], y[valid], z[valid], col[valid], row[valid]
                ground_z = map_coordinates(
                    ground, [(n_max - y) * inv - 0.5, (x - e_min) * inv - 0.5], order=1, mode="nearest",
                )
                h = z - ground_z
                band = (h >= min_height_m) & (h <= max_height_m)
                idx = (row * width + col)[band]
                np.add.at(count, idx, 1.0)
                np.maximum.at(top, idx, h[band])
    return BandCounts(count.reshape(height, width), top.reshape(height, width))


def lowveg_from_points(
    band: BandCounts,
    canopy: np.ndarray,
    transform: "rasterio.Affine",
    roof_mask: np.ndarray | None = None,
    min_height_m: float = DEFAULT_MIN_HEIGHT_M,
    max_height_m: float = DEFAULT_MAX_HEIGHT_M,
    min_points: int = DEFAULT_MIN_POINTS,
    roof_buffer_m: float = DEFAULT_ROOF_BUFFER_M,
    trees: list[BaseGeometry] | None = None,
    tree_buffer_m: float = DEFAULT_TREE_BUFFER_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    close_m: float = DEFAULT_CLOSE_M,
    round_m: float = DEFAULT_ROUND_M,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    min_hole_area_m2: float = DEFAULT_MIN_HOLE_AREA_M2,
) -> list[LowVegPolygon]:
    """Band point counts (count_band_points) -> shrub-zone polygons. Trees
    come from the cleaned canopy grid on the same cells (above max_height_m,
    plus the given polygons, both buffered by tree_buffer_m); roof_mask is
    the canopy grid's suppressed roof cells, dilated by roof_buffer_m. Height
    stats are over each cell's highest band return."""
    if max_height_m <= min_height_m:
        raise ValueError("max_height_m must be greater than min_height_m")
    if min_points < 1:
        raise ValueError("min_points must be at least 1")
    counts = np.asarray(band.count, dtype=np.float64)
    heights = np.nan_to_num(np.asarray(canopy, dtype=np.float64), nan=0.0)
    if counts.shape != heights.shape:
        raise ValueError(f"band counts are {counts.shape}, the canopy grid is {heights.shape}")
    cell_size = float(abs(transform.a))
    window = uniform_filter(counts, size=3, mode="constant") * 9.0
    mask = (counts > 0) & (window >= min_points - 1e-6)
    mask &= ~tree_mask(heights, transform, max_height_m, trees, tree_buffer_m)
    if roof_mask is not None and np.any(roof_mask):
        roofs = np.asarray(roof_mask, dtype=bool)
        if roof_buffer_m > 0.0:
            structure = disk_structure(roof_buffer_m / cell_size)
            if structure.shape != (1, 1):
                roofs = binary_dilation(roofs, structure=structure)
        mask &= ~roofs
    return _zones_from_mask(mask, np.asarray(band.max_height, dtype=np.float64), transform, min_height_m,
                            min_area_m2, close_m, round_m, simplify_m, min_hole_area_m2)


def _zones_from_mask(mask, low, transform, min_height_m, min_area_m2, close_m, round_m, simplify_m,
                     min_hole_area_m2) -> list[LowVegPolygon]:
    """Steps 3 to 5 of the module docstring, shared by both inputs: denoise,
    polygonize, round, then height stats over `low` (metres, 0 = none)."""
    mask = denoise_mask(mask, float(abs(transform.a)), close_m, min_area_m2)
    if not mask.any():
        return []
    raw = [fill_small_holes(geom, min_hole_area_m2) for geom in mask_to_polygons(mask, transform)]
    polygons = [p for p in round_outlines(raw, round_m, simplify_m, min_area_m2) if p.area >= min_area_m2]
    stats = _height_stats(low, polygons, transform, min_height_m)
    return [
        LowVegPolygon(geometry=polygon, height_p90_m=p90, height_max_m=h_max, area_m2=int(round(polygon.area)))
        for polygon, (h_max, p90, _mean) in zip(polygons, stats)
    ]


def build_lowveg_feature_collection(
    zones: list[LowVegPolygon],
    source_ref: str,
    course_id: str | None = None,
    attribution: str = LASERDATA_ATTRIBUTION,
) -> dict:
    """EPSG:3006 FeatureCollection (legacy `crs` member as detect_common),
    one Polygon feature per LowVegPolygon with the property contract from
    the module docstring. `courseId` and `attribution` are foreign members."""
    features = []
    for zone in zones:
        features.append({
            "type": "Feature",
            "properties": {
                "type": FEATURE_TYPE,
                "source": SOURCE,
                "source_ref": source_ref,
                "license": LICENSE,
                "zoneType": ZONE_TYPE,
                "weight": ZONE_WEIGHT,
                "feather": ZONE_FEATHER_M,
                "noise": ZONE_NOISE_M,
                "heightP90M": zone.height_p90_m,
                "heightMaxM": zone.height_max_m,
                "areaM2": zone.area_m2,
            },
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(zone.geometry)},
        })
    collection: dict = {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": attribution,
    }
    if course_id:
        collection["courseId"] = course_id
    collection["features"] = features
    return collection
