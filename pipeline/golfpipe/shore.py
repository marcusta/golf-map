"""A big lake's shoreline as one D-TE5 `shore` terrain edit (shore-edits).

Omberg borders lake Vättern. The terrain under the lake has to be dug to a
lake bed, and the dig measures distance in from the shoreline, so the lake
is wanted as ONE polygon (EPSG:3006 while built, holes = islands and
skerries) whose boundary is the true shore, over both terrain squares: the
inner (0.5 m DEM, its own lidar) and the outer (1 m DEM, its own lidar).

Why not the DEM alone: lidar gets almost no returns on water and gridding
fills empty cells by interpolation, so a 10-15 m sound between an island and
the mainland comes out as land, and so does the slope under a cliff.
Lantmäteriet Hydrografi (fetch-hydro's `water` polygons) is the baseline: it
follows rock edges and sounds well, but in places lies 10-15 m inland of a
cliff (it would dig the cliff away) and it misses small skerries. Lidar
ground hits are reliable LAND evidence: a cell with a class-2 point more
than LAND_ABOVE_M above the lake level is land.

The rule (shore_water_mask, found on Omberg's inner square, where it gave
the island of ~5800 m², its skerries of 67, 29, 10 and 3 m² and the open
sound):

- strong land = a class-2 hit above level + 0.3 m AND the DEM above
  level + 0.3 m; closed 3x3 twice (sparse hits on rock become solid land),
  then kept only where the DEM is above level + 0.15 m;
- water = 3x3 majority of the hydro lake raster, minus strong land (the
  majority BEFORE the cut, so small skerries survive it);
- only the water connected to the hydro lake's main body is kept (per
  connected piece of the hydro raster, the water body overlapping it most:
  a pool cut off behind a cliff goes);
- land specks under 1 m² with no strong cell go back to water.

Each terrain's mask is polygonized, simplified to half a cell and rid of
holes under 1 m²; merge_shore_polygons joins (outer − inner square) ∪
(inner ∩ inner square) ∪ (hydro lake − outer square). The hydro part past
the outer square matters: there the polygon's edge must be the real far
shore or the file's clip at least OPEN_LAKE_REACH_M away, not the square's
side, or the dig would see open lake as shore (open_lake_warnings).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import laspy
import numpy as np
import rasterio
import rasterio.features
import shapely
from rasterio.windows import Window, from_bounds
from scipy import ndimage
from shapely.geometry import Polygon, box, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient

from golfpipe.water import GEOJSON_CRS_3006

GROUND_CLASS = 2
LAND_ABOVE_M = 0.3
LAND_KEEP_M = 0.15
CLOSING_ITERATIONS = 2
SPECK_MAX_M2 = 1.0
MIN_HOLE_M2 = 1.0
LEVEL_ERODE_M = 20.0
LIDAR_MARGIN_M = 50.0
OPEN_LAKE_REACH_M = 300.0
DEFAULT_MIN_LAKE_AREA_M2 = 1e6
CHUNK_SIZE = 5_000_000
COORD_DIGITS = 8

SHORE_OP = "shore"
SHORE_ORIGIN = "shore-edits"
ATTRIBUTION = "© Lantmäteriet, Hydrografi Direkt + Laserdata Skog"

# The `shore` dig's profile (dem_edit.py reads these; the CLI has one
# kebab-case flag per key). Order is the order written to the file.
PROFILE_DEFAULTS: dict[str, float] = {
    "edgeSlope": 0.15,
    "edgeM": 2.0,
    "edgeEaseM": 2.0,
    "shelfSlope": 0.02,
    "shelfEndM": 100.0,
    "shelfEaseM": 5.0,
    "slope": 0.05,
    "depthM": 8.0,
    "floorRoundM": 5.0,
    "channelDepthM": 1.0,
    "channelRatio": 0.2,
    "channelFullM": 10.0,
    "channelGoneM": 15.0,
    "cliffRunM": 4.0,
    "cliffRiseLowM": 1.5,
    "cliffRiseHighM": 3.5,
    "cliffSlope": 1.5,
    "cliffDepthM": 6.0,
    "cliffHoldM": 15.0,
    "cliffFadeM": 45.0,
    "cliffSmoothM": 6.0,
}

_STRUCT_3x3 = np.ones((3, 3), dtype=bool)


class ShoreError(RuntimeError):
    """User-actionable shore-edits input error."""


def profile_flag(key: str) -> str:
    """'edgeEaseM' -> 'edge-ease-m' (the CLI flag of a profile key)."""
    return re.sub(r"(?<!^)([A-Z])", r"-\1", key).lower()


# ─── inputs ──────────────────────────────────────────────────────────────────


def read_lake(hydro_path: Path, min_area_m2: float = DEFAULT_MIN_LAKE_AREA_M2) -> Polygon:
    """The largest `water` polygon of a fetch-hydro GeoJSON (EPSG:3006).
    Raises ShoreError when the file has none or the largest is under
    min_area_m2 (the lake is not in the file: wrong area, or a pond)."""
    try:
        doc = json.loads(Path(hydro_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ShoreError(f"cannot read hydro GeoJSON {hydro_path}: {exc}") from exc
    polygons: list[Polygon] = []
    for feature in doc.get("features") or []:
        if (feature.get("properties") or {}).get("type") != "water" or not feature.get("geometry"):
            continue
        geom = shape(feature["geometry"])
        polygons.extend(p for p in polygon_parts(geom) if not p.is_empty)
    if not polygons:
        raise ShoreError(f"{hydro_path}: no `water` polygons (is it fetch-hydro output?)")
    lake = max(polygons, key=lambda p: p.area)
    x0, y0, x1, y1 = lake.bounds
    if max(abs(x0), abs(x1), abs(y0), abs(y1)) <= 360:
        raise ShoreError(f"{hydro_path}: coordinates look like WGS84 degrees; shore-edits needs EPSG:3006 (fetch-hydro output)")
    if lake.area < min_area_m2:
        raise ShoreError(f"{hydro_path}: the largest water polygon is {lake.area:,.0f} m², under --min-area-m2 {min_area_m2:,.0f}")
    return shapely.make_valid(lake) if not lake.is_valid else lake


def read_square(dem_path: Path) -> tuple[float, float, float, float]:
    """A terrain's square (EPSG:3006): the `.tif.json` sidecar's `square3006`
    when there is one (gspro.py dem output), else the DEM's bounds."""
    sidecar = Path(str(dem_path) + ".json")
    if sidecar.is_file():
        try:
            sq = json.loads(sidecar.read_text(encoding="utf-8")).get("square3006")
        except (OSError, json.JSONDecodeError):
            sq = None
        if sq and len(sq) == 4:
            return tuple(float(v) for v in sq)
    with rasterio.open(dem_path) as src:
        return tuple(float(v) for v in src.bounds)


def lidar_files(path: Path) -> list[Path]:
    """The .las/.laz (COPC too) files of a folder, or the one file given."""
    path = Path(path)
    if path.is_file():
        return [path]
    if not path.is_dir():
        raise ShoreError(f"lidar folder {path} does not exist")
    files = sorted(p for p in path.iterdir() if p.suffix.lower() in (".las", ".laz"))
    if not files:
        raise ShoreError(f"no .las/.laz files in {path}")
    return files


@dataclass
class HitStats:
    files_read: int = 0
    files_skipped: int = 0
    points_read: int = 0
    hits: int = 0


def count_land_hits(
    lidar_paths: list[Path],
    transform,
    shape_hw: tuple[int, int],
    level: float,
    *,
    above_m: float = LAND_ABOVE_M,
    chunk_size: int = CHUNK_SIZE,
) -> tuple[np.ndarray, HitStats]:
    """Per cell of the grid (transform, shape_hw: north-up, square cells),
    the number of class-2 (ground) points higher than level + above_m. Files
    whose header bbox misses the grid are skipped unread; points are read in
    laspy chunks like grid_dem."""
    height, width = shape_hw
    res = float(transform.a)
    e_min, n_max = float(transform.c), float(transform.f)
    e_max, n_min = e_min + width * res, n_max - height * res
    grid = np.zeros(height * width, dtype=np.int32)
    stats = HitStats()
    z_min = level + above_m
    for path in lidar_paths:
        with laspy.open(str(path)) as reader:
            h = reader.header
            if h.maxs[0] < e_min or h.mins[0] > e_max or h.maxs[1] < n_min or h.mins[1] > n_max:
                stats.files_skipped += 1
                continue
            stats.files_read += 1
            for chunk in reader.chunk_iterator(chunk_size):
                stats.points_read += len(chunk)
                cls = np.asarray(chunk.classification)
                keep = cls == GROUND_CLASS
                if not keep.any():
                    continue
                x = np.asarray(chunk.x, dtype=np.float64)[keep]
                y = np.asarray(chunk.y, dtype=np.float64)[keep]
                z = np.asarray(chunk.z, dtype=np.float64)[keep]
                m = (x >= e_min) & (x < e_max) & (y > n_min) & (y <= n_max) & (z > z_min)
                if not m.any():
                    continue
                col = np.floor((x[m] - e_min) / res).astype(np.int64)
                row = np.floor((n_max - y[m]) / res).astype(np.int64)
                np.clip(col, 0, width - 1, out=col)
                np.clip(row, 0, height - 1, out=row)
                np.add.at(grid, row * width + col, 1)
                stats.hits += int(m.sum())
    return grid.reshape(height, width), stats


def lake_mask(lake: BaseGeometry, shape_hw: tuple[int, int], transform) -> np.ndarray:
    """Cells whose centre is in the lake."""
    height, width = shape_hw
    res = float(transform.a)
    e_min, n_max = float(transform.c), float(transform.f)
    window = box(e_min - res, n_max - (height + 1) * res, e_min + (width + 1) * res, n_max + res)
    clipped = lake.intersection(window)
    if clipped.is_empty:
        return np.zeros(shape_hw, dtype=bool)
    return rasterio.features.geometry_mask([clipped], out_shape=shape_hw, transform=transform, invert=True)


def water_level(dem: np.ndarray, transform, lake: BaseGeometry, erode_m: float = LEVEL_ERODE_M) -> float | None:
    """Median DEM height over the lake shrunk by erode_m (away from banks and
    the interpolated shore), None when no valid cell is left. `dem` holds NaN
    for nodata."""
    inner = lake.buffer(-erode_m)
    if inner.is_empty:
        return None
    cells = lake_mask(inner, dem.shape, transform) & np.isfinite(dem)
    if not cells.any():
        return None
    return float(np.median(dem[cells]))


# ─── the rule ────────────────────────────────────────────────────────────────


def _closing(mask: np.ndarray, iterations: int) -> np.ndarray:
    """3x3 binary closing that treats the outside as a continuation of the
    edge (scipy's zero border would erode land touching the grid's side)."""
    pad = iterations
    padded = np.pad(mask, pad, mode="edge")
    closed = ndimage.binary_closing(padded, structure=_STRUCT_3x3, iterations=iterations)
    return closed[pad:-pad, pad:-pad]


def strong_land(dem: np.ndarray, strong_hits: np.ndarray, level: float) -> np.ndarray:
    """Cells the lidar says are land: a ground hit above level + 0.3 m on DEM
    above level + 0.3 m, closed twice, kept where the DEM is above level +
    0.15 m."""
    with np.errstate(invalid="ignore"):
        strong = (strong_hits > 0) & (dem > level + LAND_ABOVE_M)
        strong = _closing(strong, CLOSING_ITERATIONS) & (dem > level + LAND_KEEP_M)
    return strong


def _main_bodies(water: np.ndarray, hydro_mask: np.ndarray) -> np.ndarray:
    """For each 4-connected piece of the hydro raster, the 4-connected water
    body overlapping it most; everything else (pools cut off by land) goes."""
    wl, wn = ndimage.label(water)
    if wn == 0:
        return water
    hl, hn = ndimage.label(hydro_mask)
    both = (wl > 0) & (hl > 0)
    keys = hl[both].astype(np.int64) * (wn + 1) + wl[both]
    uniq, counts = np.unique(keys, return_counts=True)
    h_of, w_of = uniq // (wn + 1), uniq % (wn + 1)
    keep = np.zeros(wn + 1, dtype=bool)
    order = np.lexsort((-counts, h_of))  # per hydro piece, the biggest overlap first
    first = np.ones(order.size, dtype=bool)
    first[1:] = h_of[order][1:] != h_of[order][:-1]
    keep[w_of[order][first]] = True
    return keep[wl]


def _restore_specks(water: np.ndarray, strong: np.ndarray, cell_area: float, max_m2: float = SPECK_MAX_M2) -> np.ndarray:
    """8-connected land pieces under max_m2 without a strong cell -> water."""
    ll, ln = ndimage.label(~water, structure=_STRUCT_3x3)
    if ln == 0:
        return water
    sizes = np.bincount(ll.ravel(), minlength=ln + 1)
    strong_n = np.bincount(ll.ravel(), weights=strong.ravel().astype(np.float64), minlength=ln + 1)
    speck = (sizes * cell_area < max_m2) & (strong_n == 0)
    speck[0] = False
    return water | speck[ll]


def shore_water_mask(
    hydro_mask: np.ndarray,
    dem: np.ndarray,
    strong_hits: np.ndarray,
    level: float,
    cell_size: float,
) -> np.ndarray:
    """The lake's water cells on one terrain grid (see the module docstring
    for the rule). hydro_mask: the hydro lake rasterized; dem: heights, NaN
    for nodata; strong_hits: class-2 points above level + 0.3 m per cell."""
    hydro_mask = hydro_mask.astype(bool)
    strong = strong_land(dem, strong_hits, level)
    water = ndimage.uniform_filter(hydro_mask.astype(np.float32), size=3, mode="nearest") > 0.5
    water &= ~strong
    water = _main_bodies(water, hydro_mask)
    return _restore_specks(water, strong, cell_size * cell_size)


# ─── polygons ────────────────────────────────────────────────────────────────


def polygon_parts(geom: BaseGeometry) -> list[Polygon]:
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if hasattr(geom, "geoms"):
        return [p for g in geom.geoms for p in polygon_parts(g)]
    return []


def drop_small_holes(geom: BaseGeometry, min_hole_m2: float = MIN_HOLE_M2) -> BaseGeometry:
    out = [Polygon(p.exterior, [r for r in p.interiors if Polygon(r).area >= min_hole_m2]) for p in polygon_parts(geom)]
    return shapely.union_all(out) if len(out) != 1 else out[0]


def mask_to_polygon(water: np.ndarray, transform, cell_size: float, min_hole_m2: float = MIN_HOLE_M2) -> BaseGeometry:
    """Water mask -> shapely (Multi)Polygon in the grid's CRS: polygonized
    (4-connected), simplified to half a cell keeping topology, holes under
    min_hole_m2 dropped."""
    if not water.any():
        return Polygon()
    parts = [shape(g) for g, v in rasterio.features.shapes(
        water.astype(np.uint8), mask=water, transform=transform, connectivity=4) if v == 1]
    merged = shapely.make_valid(shapely.union_all(parts))
    simplified = merged.simplify(cell_size / 2.0, preserve_topology=True)
    return drop_small_holes(shapely.make_valid(simplified), min_hole_m2)


@dataclass
class MergeResult:
    polygon: Polygon
    dropped_m2: list[float] = field(default_factory=list)


def merge_shore_polygons(
    lake: BaseGeometry,
    outer_polygon: BaseGeometry,
    outer_square: tuple[float, float, float, float],
    inner_polygon: BaseGeometry,
    inner_square: tuple[float, float, float, float],
    min_hole_m2: float = MIN_HOLE_M2,
) -> MergeResult:
    """(outer − inner square) ∪ (inner ∩ inner square) ∪ (hydro lake − outer
    square), made valid; ONE Polygon, the largest part (the others' areas in
    dropped_m2)."""
    inner_box, outer_box = box(*inner_square), box(*outer_square)
    pieces = [
        outer_polygon.difference(inner_box) if not outer_polygon.is_empty else Polygon(),
        inner_polygon.intersection(inner_box) if not inner_polygon.is_empty else Polygon(),
        lake.difference(outer_box),
    ]
    merged = shapely.make_valid(shapely.union_all([p for p in pieces if not p.is_empty]))
    merged = merged.buffer(0)
    parts = sorted(polygon_parts(merged), key=lambda p: p.area, reverse=True)
    if not parts:
        raise ShoreError("the merged shore polygon is empty")
    main = drop_small_holes(parts[0], min_hole_m2)
    return MergeResult(polygon=main, dropped_m2=[p.area for p in parts[1:]])


def open_lake_warnings(
    lake: BaseGeometry,
    outer_square: tuple[float, float, float, float],
    reach_m: float = OPEN_LAKE_REACH_M,
) -> list[str]:
    """Where the lake crosses a side of the outer square, how far it reaches
    past that side (within the span it crosses); a warning per side under
    reach_m — the hydro file was fetched too tight and the dig would take
    the clip for a shore."""
    x0, y0, x1, y1 = outer_square
    big = 1e6
    sides = {
        "west": ((x0, y0, x0, y1), lambda a, b: box(x0 - big, a, x0, b), lambda g: x0 - g.bounds[0], 1),
        "east": ((x1, y0, x1, y1), lambda a, b: box(x1, a, x1 + big, b), lambda g: g.bounds[2] - x1, 1),
        "south": ((x0, y0, x1, y0), lambda a, b: box(a, y0 - big, b, y0), lambda g: y0 - g.bounds[1], 0),
        "north": ((x0, y1, x1, y1), lambda a, b: box(a, y1, b, y1 + big), lambda g: g.bounds[3] - y1, 0),
    }
    warnings: list[str] = []
    for name, (seg, band_of, reach_of, axis) in sides.items():
        crossing = lake.intersection(shapely.LineString([seg[:2], seg[2:]]))
        if crossing.is_empty or crossing.length <= 0:
            continue
        b = crossing.bounds
        a_lo, a_hi = (b[1], b[3]) if axis == 1 else (b[0], b[2])
        beyond = lake.intersection(band_of(a_lo, a_hi))
        reach = reach_of(beyond) if not beyond.is_empty else 0.0
        if reach < reach_m:
            warnings.append(
                f"the lake crosses the outer square's {name} side over {crossing.length:,.0f} m but reaches only "
                f"{reach:,.0f} m past it (< {reach_m:g} m): fetch the hydro file for a bigger area, or the dig "
                f"will treat the file's clip as shore")
    return warnings


# ─── output ──────────────────────────────────────────────────────────────────


def _to_wgs84_rings(polygon: Polygon) -> list[list[list[float]]]:
    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    src, dst = CRS.from_epsg(3006), CRS.from_epsg(4326)
    polygon = orient(polygon, sign=1.0)  # RFC 7946: exterior counter-clockwise
    rings = []
    for ring in [polygon.exterior, *polygon.interiors]:
        xs, ys = ring.coords.xy
        lons, lats = warp_transform(src, dst, list(xs), list(ys))
        coords = [[round(float(lon), COORD_DIGITS), round(float(lat), COORD_DIGITS)] for lon, lat in zip(lons, lats)]
        if coords[0] != coords[-1]:
            coords.append(list(coords[0]))
        rings.append(coords)
    return rings


def shore_edit_collection(
    polygon_3006: Polygon,
    level_m: float,
    profile: dict[str, float] | None = None,
    created_at: str | None = None,
) -> dict:
    """The D-TE5 handoff: a WGS84 FeatureCollection with ONE `shore` edit
    (featherM 0, the lake level and the dig profile; origin `shore-edits`
    so the server import replaces the previous generation)."""
    params = dict(PROFILE_DEFAULTS)
    params.update(profile or {})
    unknown = set(params) - set(PROFILE_DEFAULTS)
    if unknown:
        raise ShoreError(f"unknown shore profile key(s): {sorted(unknown)}")
    properties = {
        "op": SHORE_OP,
        "featherM": 0,
        "levelM": round(float(level_m), 3),
        **{k: float(params[k]) for k in PROFILE_DEFAULTS},
        "createdAt": created_at,
        "origin": SHORE_ORIGIN,
        "originRef": "lake",
        "areaM2": round(polygon_3006.area, 1),
    }
    return {
        "type": "FeatureCollection",
        "attribution": ATTRIBUTION,
        "features": [{
            "type": "Feature",
            "properties": properties,
            "geometry": {"type": "Polygon", "coordinates": _to_wgs84_rings(polygon_3006)},
        }],
    }


def inspection_collection(polygon_3006: Polygon, level_m: float) -> dict:
    """The same polygon in EPSG:3006 (legacy crs member) for QGIS."""
    geom = mapping(orient(polygon_3006, sign=1.0))
    geom = {"type": "Polygon", "coordinates": [[[round(x, 3), round(y, 3)] for x, y in ring] for ring in geom["coordinates"]]}
    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": [{"type": "Feature", "properties": {"type": "water", "source": SHORE_ORIGIN, "levelM": round(level_m, 3)},
                      "geometry": geom}],
    }


# ─── one terrain, end to end ─────────────────────────────────────────────────


@dataclass
class TerrainShore:
    name: str
    square: tuple[float, float, float, float]
    cell_size: float
    polygon: BaseGeometry
    hydro_m2: float
    cut_m2: float
    added_m2: float
    cut_cells: int
    added_cells: int
    hits: HitStats
    seconds_read: float = 0.0
    seconds_rule: float = 0.0


def read_dem_window(dem_path: Path, bounds: tuple[float, float, float, float]):
    """The DEM inside bounds (snapped out to whole cells, clipped to the
    file): (heights with NaN for nodata, transform)."""
    with rasterio.open(dem_path) as src:
        win = from_bounds(*bounds, transform=src.transform)
        win = win.round_offsets(op="floor").round_lengths(op="ceil")
        full = Window(0, 0, src.width, src.height)
        win = win.intersection(full)
        dem = src.read(1, window=win).astype(np.float64)
        if src.nodata is not None:
            dem[dem == src.nodata] = np.nan
        return dem, src.window_transform(win)


def shore_for_terrain(
    name: str,
    dem_path: Path,
    lidar_paths: list[Path],
    lake: BaseGeometry,
    level: float,
) -> TerrainShore:
    """The rule on one terrain: its DEM's grid over the lake's bbox (inside
    the square) grown by LIDAR_MARGIN_M, that terrain's lidar."""
    import time

    square = read_square(dem_path)
    with rasterio.open(dem_path) as src:
        dem_bounds = tuple(src.bounds)
        cell = float(src.transform.a)
    lake_in = lake.intersection(box(*dem_bounds))
    if lake_in.is_empty:
        raise ShoreError(f"{name}: the lake does not reach the DEM {dem_path}")
    lx0, ly0, lx1, ly1 = lake_in.bounds
    m = LIDAR_MARGIN_M
    window = (max(lx0 - m, dem_bounds[0]), max(ly0 - m, dem_bounds[1]), min(lx1 + m, dem_bounds[2]), min(ly1 + m, dem_bounds[3]))
    t0 = time.perf_counter()
    dem, transform = read_dem_window(dem_path, window)
    hits, hit_stats = count_land_hits(lidar_paths, transform, dem.shape, level)
    t1 = time.perf_counter()
    hydro = lake_mask(lake_in, dem.shape, transform)
    water = shore_water_mask(hydro, dem, hits, level, cell)
    polygon = mask_to_polygon(water, transform, cell)
    t2 = time.perf_counter()
    area = cell * cell
    cut = int(np.count_nonzero(hydro & ~water))
    added = int(np.count_nonzero(water & ~hydro))
    return TerrainShore(
        name=name, square=square, cell_size=cell, polygon=polygon,
        hydro_m2=float(hydro.sum()) * area, cut_m2=cut * area, added_m2=added * area,
        cut_cells=cut, added_cells=added, hits=hit_stats,
        seconds_read=t1 - t0, seconds_rule=t2 - t1,
    )


def level_from_dem(dem_path: Path, lake: BaseGeometry, erode_m: float = LEVEL_ERODE_M) -> float | None:
    """water_level over the part of the lake on this DEM."""
    with rasterio.open(dem_path) as src:
        bounds = tuple(src.bounds)
    part = lake.intersection(box(*bounds))
    if part.is_empty:
        return None
    dem, transform = read_dem_window(dem_path, part.bounds)
    return water_level(dem, transform, lake, erode_m)


def vertex_count(polygon: Polygon) -> int:
    return len(polygon.exterior.coords) + sum(len(r.coords) for r in polygon.interiors)
