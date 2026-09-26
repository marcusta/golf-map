"""Woodland-floor zone proposals from lidar (woodland-features command;
docs/feature-vegetation-zones.md D-VZ10).

Under a closed stand the ground is not meadow: it is needle litter, moss,
blueberry and fern, a green-brown the ortho only shows in the gaps between
crowns. This module turns the cleaned canopy grid into one polygon per
stand, which becomes a `vegetation_zone` of zone type `woodland_floor` once
imported (an ordinary zone: editable, deletable, re-importable by source).
Two consumers read the same polygons:

- VSPro, through `gspro.py zones`: the zone's channel carries the
  understory items (ferns, dwarf shrubs, deadwood) bound to that type.
- clean-ortho `--woodland`: the stand is repainted as forest floor in the
  stand's own colour, so the terrain texture under the planted trees is
  ground, not crowns.

Steps on the cleaned canopy grid (metres above ground, 0 = none):

1. canopy = cells >= min_height_m (3 m: the shrub band of lowveg-features
   ends there, so the two never claim the same cells for the same reason).
2. Closing with a disk of close_m (5 m): crowns less than about 2 x close_m
   apart merge into a stand, the gaps between them included.
3. With a roof mask (the canopy grid's suppressed roof cells), cells within
   roof_buffer_m are removed: garden trees around houses are not a wood.
4. 8-connected components under min_area_m2 (2500 m², a quarter hectare)
   are dropped: a lone tree or a row of three keeps meadow under it.
5. Polygonize, holes under min_hole_area_m2 filled, then grown by edge_m
   (the floor runs out past the outermost crowns), rounded and simplified
   like trees-features. Stands whose canopy cover (share of grid cells
   >= min_height_m inside the polygon) is under min_cover are dropped: a
   loose scatter the closing happened to bridge is parkland, not a wood.
6. Per stand: coverPct, heightP90M, areaM2; with band counts (the --lidar
   path, lowveg_features.count_band_points 0.5..3 m) understoryPct, the
   share of cells holding an understory return, and the zone weight
   derived from it (see understory_weight); with an ortho, floorColor and
   floorStdev (floor_colors).

Output (build_woodland_feature_collection): EPSG:3006 FeatureCollection with
the legacy `crs` member, properties type "vegetation_zone", source
"lidar-woodland", zoneType "woodland_floor", weight, feather 4, noise 2 and
the stats above. Import with
`PUT /api/courses/:courseId/features/generated?source=lidar-woodland`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
import rasterio.windows
from scipy.ndimage import binary_dilation
from shapely.geometry.base import BaseGeometry

from golfpipe.detect_common import LASERDATA_ATTRIBUTION, _polygon_coordinates, mask_to_polygons
from golfpipe.trees_features import (
    _each_polygon,
    _height_stats,
    denoise_mask,
    disk_structure,
    fill_small_holes,
    round_outlines,
)
from golfpipe.water import GEOJSON_CRS_3006

__all__ = [
    "DEFAULT_MIN_HEIGHT_M", "DEFAULT_CLOSE_M", "DEFAULT_MIN_AREA_M2", "DEFAULT_MIN_HOLE_AREA_M2",
    "DEFAULT_EDGE_M", "DEFAULT_MIN_COVER", "DEFAULT_ROOF_BUFFER_M", "DEFAULT_ROUND_M", "DEFAULT_SIMPLIFY_M",
    "DEFAULT_MIN_WEIGHT", "FULL_UNDERSTORY_SHARE",
    "FEATURE_TYPE", "SOURCE", "LICENSE", "ZONE_TYPE", "ZONE_FEATHER_M", "ZONE_NOISE_M",
    "WoodlandStand", "stand_mask", "woodland_from_canopy", "understory_weight", "floor_colors",
    "build_woodland_feature_collection",
]

DEFAULT_MIN_HEIGHT_M = 3.0
DEFAULT_CLOSE_M = 5.0
DEFAULT_MIN_AREA_M2 = 2500.0
DEFAULT_MIN_HOLE_AREA_M2 = 400.0
DEFAULT_EDGE_M = 2.0
DEFAULT_MIN_COVER = 0.5
DEFAULT_ROOF_BUFFER_M = 5.0
DEFAULT_ROUND_M = 3.0
DEFAULT_SIMPLIFY_M = 1.0
# Weight from understory: a stand where FULL_UNDERSTORY_SHARE of the cells
# hold a 0.5..3 m return gets weight 1; sparser stands scale down linearly,
# never under DEFAULT_MIN_WEIGHT (a bare spruce floor still has moss).
# Vreta's leaf-off 2 points/m² scan gives 1 to 13 % across its 14 stands,
# so 20 % is "full"; a denser scan wants --full-understory raised.
DEFAULT_MIN_WEIGHT = 0.3
FULL_UNDERSTORY_SHARE = 0.2
# Floor colour: a stand needs this many floor pixels for a colour of its own,
# and a floor pixel is ground-coloured (see floor_colors).
MIN_FLOOR_PIXELS = 200
GROUND_RED_OVER_GREEN = 0.9
GROUND_RED_OVER_BLUE = 20.0
GROUND_MIN_LUMA = 45.0
GROUND_MAX_LUMA = 125.0
# The longest side the ortho window of one stand is read at; larger stands
# are read decimated (a median colour does not need 16 cm pixels).
FLOOR_SAMPLE_MAX_PX = 2048

FEATURE_TYPE = "vegetation_zone"
SOURCE = "lidar-woodland"
LICENSE = "CC0-1.0"
ZONE_TYPE = "woodland_floor"
ZONE_FEATHER_M = 4.0
ZONE_NOISE_M = 2.0


@dataclass
class WoodlandStand:
    geometry: BaseGeometry  # shapely Polygon, EPSG:3006
    cover_pct: int
    height_p90_m: float
    area_m2: int
    understory_pct: int | None = None
    weight: float = 1.0
    floor_color: str | None = None   # "#rrggbb"
    floor_stdev: float | None = None  # per-channel standard deviation of the sampled floor, 0..255


def stand_mask(
    canopy: np.ndarray,
    cell_size: float,
    min_height_m: float = DEFAULT_MIN_HEIGHT_M,
    close_m: float = DEFAULT_CLOSE_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    roof_mask: np.ndarray | None = None,
    roof_buffer_m: float = DEFAULT_ROOF_BUFFER_M,
) -> np.ndarray:
    """Steps 1 to 4 of the module docstring: the grid cells that belong to a stand."""
    heights = np.nan_to_num(np.asarray(canopy, dtype=np.float64), nan=0.0)
    mask = denoise_mask(heights >= min_height_m, cell_size, close_m, 0.0)
    if roof_mask is not None and np.any(roof_mask):
        roofs = np.asarray(roof_mask, dtype=bool)
        if roof_buffer_m > 0.0:
            structure = disk_structure(roof_buffer_m / cell_size)
            if structure.shape != (1, 1):
                roofs = binary_dilation(roofs, structure=structure)
        mask &= ~roofs
    return denoise_mask(mask, cell_size, 0.0, min_area_m2)


def _share_inside(values: np.ndarray, polygons: list[BaseGeometry], transform) -> list[float]:
    """Mean of a boolean grid over the cells inside each polygon (0 when none)."""
    labels = rasterio.features.rasterize(
        ((geom, i + 1) for i, geom in enumerate(polygons)),
        out_shape=values.shape, transform=transform, fill=0, dtype="int32",
    )
    n = len(polygons) + 1
    cells = np.bincount(labels.ravel(), minlength=n).astype(np.float64)
    hits = np.bincount(labels.ravel(), weights=values.ravel().astype(np.float64), minlength=n)
    return [float(hits[i] / cells[i]) if cells[i] > 0 else 0.0 for i in range(1, n)]


def understory_weight(share: float, min_weight: float = DEFAULT_MIN_WEIGHT,
                      full_share: float = FULL_UNDERSTORY_SHARE) -> float:
    """Zone weight from the understory share: linear to 1 at full_share,
    clamped to [min_weight, 1], 2 decimals."""
    if full_share <= 0.0:
        return 1.0
    return round(float(min(1.0, max(min_weight, share / full_share))), 2)


def woodland_from_canopy(
    canopy: np.ndarray,
    transform: "rasterio.Affine",
    roof_mask: np.ndarray | None = None,
    band_count: np.ndarray | None = None,
    min_height_m: float = DEFAULT_MIN_HEIGHT_M,
    close_m: float = DEFAULT_CLOSE_M,
    min_area_m2: float = DEFAULT_MIN_AREA_M2,
    min_hole_area_m2: float = DEFAULT_MIN_HOLE_AREA_M2,
    edge_m: float = DEFAULT_EDGE_M,
    min_cover: float = DEFAULT_MIN_COVER,
    roof_buffer_m: float = DEFAULT_ROOF_BUFFER_M,
    round_m: float = DEFAULT_ROUND_M,
    simplify_m: float = DEFAULT_SIMPLIFY_M,
    min_weight: float = DEFAULT_MIN_WEIGHT,
) -> list[WoodlandStand]:
    """Cleaned canopy grid (north-up affine transform in EPSG:3006) ->
    woodland stands. band_count is lowveg_features.BandCounts.count on the
    same cells; without it there is no understoryPct and every weight is 1.
    See the module docstring for the steps."""
    heights = np.nan_to_num(np.asarray(canopy, dtype=np.float64), nan=0.0)
    if band_count is not None and np.shape(band_count) != heights.shape:
        raise ValueError(f"band counts are {np.shape(band_count)}, the canopy grid is {heights.shape}")
    cell_size = float(abs(transform.a))
    mask = stand_mask(heights, cell_size, min_height_m, close_m, min_area_m2, roof_mask, roof_buffer_m)
    if not mask.any():
        return []
    raw = [fill_small_holes(geom, min_hole_area_m2) for geom in mask_to_polygons(mask, transform)]
    if edge_m > 0.0:
        raw = [geom.buffer(edge_m, join_style="round") for geom in raw]
    polygons = [p for p in round_outlines(raw, round_m, simplify_m, min_area_m2) if p.area >= min_area_m2]
    polygons = [fill_small_holes(p, min_hole_area_m2) for p in polygons]
    polygons = [p for geom in polygons for p in _each_polygon(geom)]
    if not polygons:
        return []
    cover = _share_inside(heights >= min_height_m, polygons, transform)
    keep = [i for i, c in enumerate(cover) if c >= min_cover]
    polygons = [polygons[i] for i in keep]
    cover = [cover[i] for i in keep]
    if not polygons:
        return []
    stats = _height_stats(heights, polygons, transform, min_height_m)
    under = _share_inside(np.asarray(band_count) > 0, polygons, transform) if band_count is not None else None
    stands = []
    for i, polygon in enumerate(polygons):
        stand = WoodlandStand(
            geometry=polygon,
            cover_pct=int(round(cover[i] * 100)),
            height_p90_m=stats[i][1],
            area_m2=int(round(polygon.area)),
        )
        if under is not None:
            stand.understory_pct = int(round(under[i] * 100))
            stand.weight = understory_weight(under[i], min_weight)
        stands.append(stand)
    return stands


def floor_colors(
    stands: list[WoodlandStand],
    canopy: np.ndarray,
    canopy_transform: "rasterio.Affine",
    ortho_path: Path,
    gap_min_height_m: float = 0.5,
    gap_buffer_m: float = 1.0,
    min_pixels: int = MIN_FLOOR_PIXELS,
    inset_m: float = DEFAULT_EDGE_M + 1.0,
) -> int:
    """Sets floor_color / floor_stdev on each stand from the ortho (an RGB
    GeoTIFF in EPSG:3006), over the pixels at least inset_m inside the
    stand (the outer band is the edge the floor was grown by, meadow in the
    photo). Floor pixels are ground-coloured: red at least GROUND_RED_OVER_GREEN
    of green (not leaf green), red over blue by GROUND_RED_OVER_BLUE (warm, so
    not blue crown shade and not grey gravel) and luminance between
    GROUND_MIN_LUMA and GROUND_MAX_LUMA (not deep shadow, not a bright track).
    Those in lidar gaps (canopy cell under gap_min_height_m and at least
    gap_buffer_m from a taller one) are preferred; when there are fewer than
    min_pixels of them, every ground-coloured pixel in the stand counts
    (tracks, clearings, windthrow). Measured on Vreta: the ortho is not a
    true ortho and is four summers newer than the lidar, so under closed
    spruce the lidar gaps show leaning crowns in the photo, and the gap
    pixels alone gave crown-shade blue-greens, and without the warmth and
    brightness limits the fallback gave gravel grey. Pixels between the 10th and
    90th percentile of luminance give the per-channel median colour and the
    standard deviation. Stands with too few floor pixels keep None. Returns
    the number of stands that got a colour."""
    heights = np.nan_to_num(np.asarray(canopy, dtype=np.float64), nan=0.0)
    tall = heights >= gap_min_height_m
    cell = float(abs(canopy_transform.a))
    if gap_buffer_m > 0.0:
        structure = disk_structure(gap_buffer_m / cell)
        if structure.shape != (1, 1):
            tall = binary_dilation(tall, structure=structure)
    rows_c, cols_c = heights.shape
    coloured = 0
    with rasterio.open(ortho_path) as src:
        if src.crs is not None and src.crs.to_epsg() != 3006:
            raise ValueError(f"{ortho_path} is in {src.crs}; floor colours need an EPSG:3006 ortho")
        if src.count < 3:
            raise ValueError(f"{ortho_path} has {src.count} band(s); floor colours need RGB")
        for stand in stands:
            core = stand.geometry.buffer(-inset_m) if inset_m > 0.0 else stand.geometry
            if core.is_empty:
                continue
            window = rasterio.windows.from_bounds(*core.bounds, transform=src.transform)
            window = window.round_offsets().round_lengths()
            window = window.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            if window.width < 1 or window.height < 1:
                continue
            step = max(1, int(np.ceil(max(window.width, window.height) / FLOOR_SAMPLE_MAX_PX)))
            out_h, out_w = int(np.ceil(window.height / step)), int(np.ceil(window.width / step))
            rgb = src.read([1, 2, 3], window=window, out_shape=(3, out_h, out_w))
            wt = src.window_transform(window) @ rasterio.Affine.scale(window.width / out_w, window.height / out_h)
            inside = rasterio.features.rasterize(
                [(core, 1)], out_shape=(out_h, out_w), transform=wt, fill=0, dtype="uint8",
            ).astype(bool)
            # Pixel centres -> canopy cells (both north-up in EPSG:3006, so rows and columns separate).
            xs = wt.c + (np.arange(out_w) + 0.5) * wt.a
            ys = wt.f + (np.arange(out_h) + 0.5) * wt.e
            cc = np.floor((xs - canopy_transform.c) / canopy_transform.a).astype(np.int64)
            rc = np.floor((ys - canopy_transform.f) / canopy_transform.e).astype(np.int64)
            col_ok = (cc >= 0) & (cc < cols_c)
            row_ok = (rc >= 0) & (rc < rows_c)
            covered = np.ones((out_h, out_w), dtype=bool)
            sub = tall[np.clip(rc, 0, rows_c - 1)][:, np.clip(cc, 0, cols_c - 1)]
            covered[np.ix_(row_ok, col_ok)] = sub[np.ix_(row_ok, col_ok)]
            r, g, b = (band.astype(np.float64) for band in rgb)
            ground = (inside & (r >= GROUND_RED_OVER_GREEN * g) & (r >= b + GROUND_RED_OVER_BLUE)
                      & (0.299 * r + 0.587 * g + 0.114 * b >= GROUND_MIN_LUMA)
                      & (0.299 * r + 0.587 * g + 0.114 * b <= GROUND_MAX_LUMA))
            valid = ground & ~covered
            if np.count_nonzero(valid) < min_pixels:
                valid = ground
            if np.count_nonzero(valid) < min_pixels:
                continue
            pixels = rgb[:, valid].T.astype(np.float64)
            luma = pixels @ np.array([0.299, 0.587, 0.114])
            low, high = np.percentile(luma, [10, 90])
            floor = pixels[(luma >= low) & (luma <= high)]
            color = np.clip(np.round(np.median(floor, axis=0)), 0, 255).astype(int)
            stand.floor_color = "#{:02x}{:02x}{:02x}".format(*color)
            stand.floor_stdev = round(float(floor.std(axis=0).mean()), 1)
            coloured += 1
    return coloured


def build_woodland_feature_collection(
    stands: list[WoodlandStand],
    source_ref: str,
    course_id: str | None = None,
    attribution: str = LASERDATA_ATTRIBUTION,
) -> dict:
    """EPSG:3006 FeatureCollection (legacy `crs` member as detect_common),
    one Polygon feature per stand with the property contract from the module
    docstring. Stats that were not computed are left out, not nulled."""
    features = []
    for stand in stands:
        props: dict = {
            "type": FEATURE_TYPE,
            "source": SOURCE,
            "source_ref": source_ref,
            "license": LICENSE,
            "zoneType": ZONE_TYPE,
            "weight": stand.weight,
            "feather": ZONE_FEATHER_M,
            "noise": ZONE_NOISE_M,
            "coverPct": stand.cover_pct,
            "heightP90M": stand.height_p90_m,
            "areaM2": stand.area_m2,
        }
        if stand.understory_pct is not None:
            props["understoryPct"] = stand.understory_pct
        if stand.floor_color is not None:
            props["floorColor"] = stand.floor_color
            props["floorStdev"] = stand.floor_stdev
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(stand.geometry)},
        })
    collection: dict = {"type": "FeatureCollection", "crs": GEOJSON_CRS_3006, "attribution": attribution}
    if course_id:
        collection["courseId"] = course_id
    collection["features"] = features
    return collection
