"""Tree polygons from the cleaned canopy grid (trees-features command,
`canopy --trees-out`).

detect-trees builds its own canopy mask from the raw nDSM (closing +
opening). The `canopy` tile layers instead come from canopy.clean_canopy
(roofs suppressed by return count, clamp, 3x3 closing, 7x7 max filter).
When the two disagree the map shows canopy where no polygon exists and
vice versa. This module derives polygons from the SAME cleaned canopy grid
the tiles are cut from (canopy.tif in the canopy workdir, or the grid built
in-process), so layers and polygons agree.

Steps (trees_from_canopy):

1. mask = canopy >= min_height_m.
2. Noise filter in raster space (denoise_mask): binary closing with a disk
   of radius close_m (1.0 m at 1 m cells = the 3x3 cross) bridges 1-cell
   gaps and slits, then 8-connected components smaller than min_area_m2
   are dropped. There is no opening: every canopy cell of a component that
   is large enough stays in the mask, so a single-cell-wide hedge or a 3x3
   crown survives. close_m <= 0 skips the closing.
3. Polygonize 8-connected (detect_common.mask_to_polygons; interior
   clearings come out as holes). Interior rings with area below
   min_hole_area_m2 are removed (the gap is filled; fill_small_holes);
   larger clearings stay holes.
4. Outline rounding (round_outlines, round_m = r > 0): vector closing of
   all polygons together (dilate r, union, erode r; round joins) fills
   notches and slits narrower than 2r and merges neighbours closer than
   2r; then a vector opening per part (erode r, dilate r) rounds convex
   corners. Parts the opening removed come back when they are >=
   min_area_m2 and >= 1 m wide, so thin hedges and small crowns keep
   their footprint. Then two Chaikin corner-cutting iterations per ring,
   Douglas-Peucker simplify by simplify_m (bounds the vertex count),
   make_valid, and a union so neighbouring polygons never overlap.
   round_m <= 0 keeps the cell outlines and only simplifies by simplify_m
   (topology preserving).
5. Explode to single Polygons, drop those under min_area_m2.
6. Per-polygon height stats against the canopy grid: every polygon is
   rasterized once (rasterio.features.rasterize with its index as the
   burn value), then heightMaxM / heightP90M / heightMeanM are taken over
   the cells inside the polygon whose canopy is >= min_height_m (falling
   back to every canopy cell inside when rounding left none). Filled
   holes hold cells below min_height_m, so they never enter the stats.
   areaM2 is the polygon area rounded to an integer and does include
   filled holes.

Output (build_trees_feature_collection): GeoJSON FeatureCollection in
EPSG:3006 with the same legacy `crs` member detect_common uses, one
Polygon per feature, properties exactly: type "trees", source
"lidar-canopy", source_ref, license "CC0-1.0", heightMaxM, heightP90M,
heightMeanM (1 decimal), areaM2 (int). The server imports it via
`PUT /api/courses/:courseId/features/generated?source=lidar-canopy`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
import rasterio.windows
from scipy.ndimage import binary_closing, label
from shapely import make_valid, unary_union
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from golfpipe.detect_common import (
    LASERDATA_ATTRIBUTION,
    _each_polygon,
    _polygon_coordinates,
    mask_to_polygons,
)
from golfpipe.water import GEOJSON_CRS_3006

__all__ = [
    "DEFAULT_MIN_HEIGHT_M", "DEFAULT_MIN_AREA_M2", "DEFAULT_MIN_HOLE_AREA_M2", "DEFAULT_CLOSE_M",
    "DEFAULT_ROUND_M", "DEFAULT_SIMPLIFY_M", "CHAIKIN_ITERATIONS", "THIN_KEEP_WIDTH_M", "FEATURE_TYPE", "SOURCE", "LICENSE",
    "TreePolygon",
    "disk_structure", "denoise_mask", "fill_small_holes", "chaikin_ring", "chaikin_polygon",
    "round_outlines", "trees_from_canopy", "build_trees_feature_collection", "read_canopy_tif",
]

DEFAULT_MIN_HEIGHT_M = 2.0
DEFAULT_MIN_AREA_M2 = 12.0
DEFAULT_MIN_HOLE_AREA_M2 = 50.0
DEFAULT_CLOSE_M = 1.0
DEFAULT_ROUND_M = 1.5
DEFAULT_SIMPLIFY_M = 0.3
CHAIKIN_ITERATIONS = 2
THIN_KEEP_WIDTH_M = 1.0  # rounding keeps removed parts at least this wide (and >= min area)

FEATURE_TYPE = "trees"
SOURCE = "lidar-canopy"
LICENSE = "CC0-1.0"


@dataclass
class TreePolygon:
    geometry: BaseGeometry  # shapely Polygon, EPSG:3006
    height_max_m: float
    height_p90_m: float
    height_mean_m: float
    area_m2: int


def disk_structure(radius_cells: float) -> np.ndarray:
    """Boolean disk: cells whose centre lies within radius_cells of the
    origin. radius 1.0 -> 3x3 cross, 1.5 -> 3x3 block, 2.5 -> 5x5 with
    the corners cut.
    """
    r = int(np.floor(radius_cells))
    if r < 1:
        return np.ones((1, 1), dtype=bool)
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    return (xx * xx + yy * yy) <= radius_cells * radius_cells


def denoise_mask(mask: np.ndarray, cell_size: float, close_m: float, min_area_m2: float) -> np.ndarray:
    """Binary closing with disk_structure(close_m / cell_size) (skipped
    when close_m <= 0 or the disk is a single cell; the grid is padded so
    components touching the edge are not eroded), then 8-connected
    components with fewer than min_area_m2 / cell_size**2 cells are
    dropped. No opening, so nothing is thinned.
    """
    out = mask
    if close_m > 0.0:
        structure = disk_structure(close_m / cell_size)
        if structure.shape != (1, 1):
            pad = structure.shape[0] // 2
            padded = np.pad(mask, pad, mode="constant", constant_values=False)
            out = binary_closing(padded, structure=structure)[pad:-pad, pad:-pad]
    if min_area_m2 > 0.0 and out.any():
        min_cells = int(np.ceil(min_area_m2 / (cell_size * cell_size)))
        if min_cells > 1:
            labels, count = label(out, structure=np.ones((3, 3), dtype=bool))
            sizes = np.bincount(labels.ravel())
            keep = sizes >= min_cells
            keep[0] = False
            out = keep[labels]
    return out


def fill_small_holes(geom: BaseGeometry, min_hole_area_m2: float) -> BaseGeometry:
    """Removes interior rings whose area is below min_hole_area_m2 from
    every Polygon in geom (MultiPolygon parts handled one by one). Rings
    at or above the threshold stay. min_hole_area_m2 <= 0 returns geom
    unchanged.
    """
    if min_hole_area_m2 <= 0.0 or geom.is_empty:
        return geom
    if geom.geom_type == "Polygon":
        if not geom.interiors:
            return geom
        kept = [ring for ring in geom.interiors if Polygon(ring).area >= min_hole_area_m2]
        if len(kept) == len(geom.interiors):
            return geom
        return Polygon(geom.exterior, kept)
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        return type(geom)([fill_small_holes(part, min_hole_area_m2) for part in geom.geoms])
    return geom


def chaikin_ring(coords: np.ndarray, iterations: int = CHAIKIN_ITERATIONS) -> np.ndarray:
    """Chaikin corner cutting on a closed ring (first point == last point,
    shape (n, 2)). Each iteration replaces every edge by its 1/4 and 3/4
    points, so a right-angle corner becomes a chamfer and a 1-cell
    staircase converges on the diagonal. Returns a closed ring.
    """
    pts = np.asarray(coords, dtype=np.float64)[:, :2]
    if len(pts) > 1 and np.array_equal(pts[0], pts[-1]):
        pts = pts[:-1]
    for _ in range(max(iterations, 0)):
        if len(pts) < 3:
            break
        nxt = np.roll(pts, -1, axis=0)
        cut = np.empty((2 * len(pts), 2), dtype=np.float64)
        cut[0::2] = 0.75 * pts + 0.25 * nxt
        cut[1::2] = 0.25 * pts + 0.75 * nxt
        pts = cut
    return np.vstack([pts, pts[:1]])


def chaikin_polygon(polygon: Polygon, iterations: int = CHAIKIN_ITERATIONS) -> BaseGeometry:
    """chaikin_ring on the exterior and every interior ring; interiors that
    collapse below 3 distinct points are dropped.
    """
    shell = chaikin_ring(np.asarray(polygon.exterior.coords), iterations)
    holes = []
    for ring in polygon.interiors:
        cut = chaikin_ring(np.asarray(ring.coords), iterations)
        if len(cut) >= 4:
            holes.append(cut)
    return Polygon(shell, holes)


def _valid_polygons(geoms) -> list[Polygon]:
    out: list[Polygon] = []
    for geom in geoms:
        if geom.is_empty:
            continue
        out.extend(_each_polygon(geom if geom.is_valid else make_valid(geom)))
    return out


def round_outlines(
    polygons: list[BaseGeometry],
    round_m: float,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    iterations: int = CHAIKIN_ITERATIONS,
) -> list[Polygon]:
    """Rounds cell-staircase outlines. r = round_m, all buffers use round
    joins:

    1. Vector closing: every polygon dilated by r, union, eroded by r.
       Touching or near (< 2r) neighbours merge; notches, slits and holes
       narrower than 2r fill; concave corners get radius r. Nothing is lost.
    2. Vector opening of each closed part: erode by r, dilate by r. Convex
       corners get radius r; parts narrower than 2r vanish.
    3. Pieces the opening removed (closed minus opened) come back when they
       are at least min_area_m2 and at least THIN_KEEP_WIDTH_M wide (their
       erosion by half that width is not empty): a 2 m hedge or a 4 m crown
       survives, corner shavings and edge slivers do not.
    4. Chaikin corner cutting per ring (`iterations`), Douglas-Peucker
       simplify by simplify_m (topology preserving, bounds the vertex
       count), make_valid, union (output polygons never overlap), explode
       to single Polygons.

    round_m <= 0 skips 1-3: simplify by simplify_m (when > 0), make_valid,
    explode. Buffers run per part on lightly simplified (5 cm) input; a
    single erosion of the whole dilated multipolygon is 20x slower in GEOS.
    """
    parts = _valid_polygons(polygons)
    if not parts:
        return []
    if round_m <= 0.0:
        if simplify_m > 0.0:
            parts = _valid_polygons(p.simplify(simplify_m, preserve_topology=True) for p in parts)
        return parts

    r = float(round_m)
    keep_erode = THIN_KEEP_WIDTH_M / 2.0 * 0.9
    dilated = unary_union([p.buffer(r, join_style="round") for p in parts])
    rounded: list[BaseGeometry] = []
    for part in _each_polygon(dilated):
        closed = part.simplify(0.05, preserve_topology=True).buffer(-r, join_style="round")
        for closed_part in _each_polygon(closed):
            opened = closed_part.simplify(0.05, preserve_topology=True).buffer(-r, join_style="round")
            opened = opened.buffer(r, join_style="round") if not opened.is_empty else opened
            pieces: list[BaseGeometry] = list(_each_polygon(opened))
            lost = closed_part.difference(opened) if not opened.is_empty else closed_part
            for piece in _each_polygon(lost):
                if piece.area >= min_area_m2 and not piece.buffer(-keep_erode).is_empty:
                    pieces.append(piece)
            if pieces:
                rounded.append(unary_union(pieces) if len(pieces) > 1 else pieces[0])

    cut: list[BaseGeometry] = []
    for polygon in _valid_polygons(rounded):
        geom = chaikin_polygon(polygon, iterations)
        if simplify_m > 0.0:
            geom = geom.simplify(simplify_m, preserve_topology=True)
        cut.append(geom)
    cut = _valid_polygons(cut)
    if not cut:
        return []
    return list(_each_polygon(unary_union(cut)))


def _height_stats(
    canopy: np.ndarray,
    polygons: list[BaseGeometry],
    transform: "rasterio.Affine",
    min_height_m: float,
) -> list[tuple[float, float, float]]:
    """(max, p90, mean) per polygon, over the canopy cells inside it. One
    rasterize pass burns each polygon's 1-based index; stats are grouped by
    that label. Polygons whose interior has no cell >= min_height_m fall
    back to every cell > 0 inside them, then to 0.0.
    """
    if not polygons:
        return []
    labels = rasterio.features.rasterize(
        ((geom, i + 1) for i, geom in enumerate(polygons)),
        out_shape=canopy.shape, transform=transform, fill=0, dtype="int32",
    )
    heights = np.asarray(canopy, dtype=np.float64)

    def grouped(select: np.ndarray) -> dict[int, np.ndarray]:
        lab = labels[select]
        val = heights[select]
        order = np.argsort(lab, kind="stable")
        lab, val = lab[order], val[order]
        ids, starts = np.unique(lab, return_index=True)
        ends = np.append(starts[1:], lab.size)
        return {int(i): val[s:e] for i, s, e in zip(ids, starts, ends)}

    inside = labels > 0
    strict = grouped(inside & (heights >= min_height_m))
    loose = None
    out: list[tuple[float, float, float]] = []
    for i in range(1, len(polygons) + 1):
        values = strict.get(i)
        if values is None:
            if loose is None:
                loose = grouped(inside & (heights > 0.0))
            values = loose.get(i)
        if values is None or values.size == 0:
            out.append((0.0, 0.0, 0.0))
            continue
        out.append((
            round(float(values.max()), 1),
            round(float(np.percentile(values, 90)), 1),
            round(float(values.mean()), 1),
        ))
    return out


def trees_from_canopy(
    canopy: np.ndarray,
    transform: "rasterio.Affine",
    min_height_m: float = DEFAULT_MIN_HEIGHT_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    close_m: float = DEFAULT_CLOSE_M,
    round_m: float = DEFAULT_ROUND_M,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    min_hole_area_m2: float = DEFAULT_MIN_HOLE_AREA_M2,
) -> list[TreePolygon]:
    """Cleaned canopy grid (metres above ground, 0 = none; float, north-up
    affine transform in EPSG:3006) -> tree polygons with height stats. See
    the module docstring for the steps.
    """
    heights = np.nan_to_num(np.asarray(canopy, dtype=np.float64), nan=0.0)
    cell_size = float(abs(transform.a))
    mask = denoise_mask(heights >= min_height_m, cell_size, close_m, min_area_m2)
    if not mask.any():
        return []

    raw = [fill_small_holes(geom, min_hole_area_m2) for geom in mask_to_polygons(mask, transform)]
    polygons = [p for p in round_outlines(raw, round_m, simplify_m, min_area_m2) if p.area >= min_area_m2]

    stats = _height_stats(heights, polygons, transform, min_height_m)
    return [
        TreePolygon(
            geometry=polygon,
            height_max_m=h_max, height_p90_m=h_p90, height_mean_m=h_mean,
            area_m2=int(round(polygon.area)),
        )
        for polygon, (h_max, h_p90, h_mean) in zip(polygons, stats)
    ]


def build_trees_feature_collection(
    trees: list[TreePolygon],
    source_ref: str,
    course_id: str | None = None,
    attribution: str = LASERDATA_ATTRIBUTION,
) -> dict:
    """EPSG:3006 FeatureCollection (legacy `crs` member as detect_common),
    one Polygon feature per TreePolygon with the property contract from the
    module docstring. `courseId` and `attribution` are foreign members.
    """
    features = []
    for tree in trees:
        features.append({
            "type": "Feature",
            "properties": {
                "type": FEATURE_TYPE,
                "source": SOURCE,
                "source_ref": source_ref,
                "license": LICENSE,
                "heightMaxM": tree.height_max_m,
                "heightP90M": tree.height_p90_m,
                "heightMeanM": tree.height_mean_m,
                "areaM2": tree.area_m2,
            },
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(tree.geometry)},
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


def read_canopy_tif(
    path: Path,
    bbox_3006: tuple[float, float, float, float] | None = None,
) -> tuple[np.ndarray, "rasterio.Affine"]:
    """Reads band 1 of a canopy GeoTIFF (float, nodata -> 0) as float32,
    optionally clipped to bbox_3006 (e_min, n_min, e_max, n_max, snapped
    outward to whole cells and intersected with the raster). Returns
    (canopy, transform).
    """
    with rasterio.open(path) as src:
        if bbox_3006 is not None:
            e_min, n_min, e_max, n_max = bbox_3006
            # Snap outward to whole cells, then intersect with the raster.
            col0 = int(np.floor((e_min - src.transform.c) / src.transform.a))
            col1 = int(np.ceil((e_max - src.transform.c) / src.transform.a))
            row0 = int(np.floor((n_max - src.transform.f) / src.transform.e))
            row1 = int(np.ceil((n_min - src.transform.f) / src.transform.e))
            col0, row0 = max(col0, 0), max(row0, 0)
            col1, row1 = min(col1, src.width), min(row1, src.height)
            if col1 <= col0 or row1 <= row0:
                raise ValueError(f"--bbox does not intersect {path}")
            window = rasterio.windows.Window(col0, row0, col1 - col0, row1 - row0)
            data = src.read(1, window=window)
            transform = src.window_transform(window)
        else:
            data = src.read(1)
            transform = src.transform
        nodata = src.nodata
    heights = data.astype(np.float32)
    if nodata is not None:
        heights[heights == nodata] = 0.0
    heights[~np.isfinite(heights)] = 0.0
    return heights, transform
