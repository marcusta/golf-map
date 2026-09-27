#!/usr/bin/env python
"""gspro — manual helpers to produce GSPro-ready assets from a WGS84 area.

Separate from the `golfpipe` tile pipeline (which builds the app's XYZ tiles);
this tool renders the flat, square, high-res rasters GSPro course tooling wants.
It reuses golfpipe internals (STAC search/download, mosaic/crop, lidar→DEM).

Run with no arguments (or -h/--help) to see this help.

Commands:
  ortho      Download the two most recent orthophoto vintages for an area and
             render each to a square JPEG (default 8192×8192). Different
             vintages are often flown in different seasons, so you can pick the
             nicer-looking one. --terrain-out adds the darkened Unity terrain
             twin; --tint-out adds that twin softened (--soften-m) and with
             the course's grass surfaces tinted dark green (the
             Photoshop-overlay step, masked by the app's own drawn features
             instead of by the SVG), at --tint-size.
  hillshade  Render a square hillshade JPEG (default 8192×8192, QGIS-style) from
             a DEM — either an existing --dem GeoTIFF or freshly gridded from
             Laserdata Skog lidar for --bbox.
  trees      Convert a tree-stems asset (golfpipe trees-stems output) into the
             unity-trees-v1 file the Unity Tree Planter reads, over one
             terrain square: plot origin/size from the square, the height
             range from that terrain's heightmap sidecar.
  zones      Rasterize a course's vegetation zones (app database) into the
             VSPro texture masks for one terrain square — one channel per
             VSP item (four per RGBA PNG), each the sum of the zone types /
             variants binding it, crossfaded at the edges — plus the
             unity-zones-v2 JSON the Unity importer reads.
  gkd        Write the GreenKeeper course-description file (<scene>.GKD) for a
             course: holes, tee boxes, pin positions, green centres and aim
             points from the app's tables, penalty areas and the out-of-bounds
             ring from its drawn features, all as Unity world positions on one
             terrain square. Merges into the existing .GKD, keeping everything
             GreenKeeper owns.
  svg        Export a course's drawn features from the app database as a
             layered, fill-only SVG in the GSPro/OPCD trace palette: one
             Inkscape layer per hole, shapes named <type>_<n>, fills from
             the OPCD v4 palette.
  dem        Clip/resample a DEM GeoTIFF to the square as a float32 EPSG:3006
             GeoTIFF AND the Unity heightmap OPCD's TIF→RAW .bat would make
             from it (4097×4097 uint16 little-endian .raw, north-up), plus a
             .json sidecar with the height range and the Unity terrain/import
             settings, for the inner or outer terrain.

All commands render over ONE square SWEREF99 (EPSG:3006) extent, so the ortho,
hillshade, DEM and SVG line up. Give it either way:
  --square-3006 x0,y0,x1,y1   the exact square in EPSG:3006 metres (what the
                              app passes: its inner or outer terrain square)
  --bbox west,south,east,north a WGS84 area; it is reprojected and squared,
                              the side rounded UP to the next 10 m
Downloads need LANTMATERIET_USER/LANTMATERIET_PASS (loaded from the repo-root
.env, same as golfpipe).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform as transform_points, transform_bounds
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from golfpipe import stac
from golfpipe import commands
from golfpipe import grid_dem as grid_dem_mod
from golfpipe.raster import mosaic_and_crop

WGS84 = CRS.from_epsg(4326)
SWEREF99 = CRS.from_epsg(3006)
DEFAULT_SIZE = 8192
DEFAULT_JPEG_QUALITY = 92
# Unity's terrain shader lights the texture again on top of the sunlight
# already baked into an orthophoto, so an untouched photo renders washed
# out. The terrain variant is the same render multiplied by this — about
# 80 % darker, what looked right when tuned by hand on Vreta.
DEFAULT_TERRAIN_DARKEN = 0.4
# Where the darkening multiplies. "linear": decode sRGB to linear light,
# multiply, re-encode — what a dimmer light on the same scene does, so
# colour and contrast survive and the result reads as an albedo (grass
# reflects ~0.25 of light; a sun-lit photo averages ~0.5, so ×0.4 lands
# near a natural albedo). "srgb": multiply the 8-bit values directly, the
# image-editor "brightness" slider; ×0.25 there is ×0.05 in linear light,
# which is why that looked dull and muddy on the terrain.
DEFAULT_DARKEN_SPACE = "linear"
# The darkened twin has a quarter of the tonal range, so the same JPEG
# quantisation is four times as visible: it gets this quality and no chroma
# subsampling instead of the caller's --quality.
TERRAIN_JPEG_QUALITY = 97
# Terrain sides are whole multiples of this (metres): 2010 m, never 2009.37 m.
SIDE_STEP_M = 10.0
DEFAULT_DEM_RESOLUTION = 1.0
# Unity terrain heightmap resolution (2^n + 1); OPCD's TIF→RAW .bat resamples
# to exactly this: gdal_translate -ot UInt16 -scale MIN MAX 0 65535 -outsize 4097 4097 -r bilinear
UNITY_HEIGHTMAP_RESOLUTION = 4097
UINT16_MAX = 65535
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "data" / "app.sqlite"


# --- Shared helpers ---------------------------------------------------------

def _load_dotenv() -> None:
    """Load KEY=VALUE from the nearest .env (cwd upward, 4 levels) so downloads
    find LANTMATERIET_USER/PASS. Mirrors golfpipe.__main__._load_dotenv."""
    here = Path.cwd()
    for base in [here, *here.parents][:5]:
        env = base / ".env"
        if not env.is_file():
            continue
        for line in env.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
        return


def _parse_bbox(text: str) -> tuple[float, float, float, float]:
    parts = [float(v) for v in text.split(",")]
    if len(parts) != 4:
        raise SystemExit("error: --bbox must be west,south,east,north (WGS84 degrees)")
    return tuple(parts)  # type: ignore[return-value]


Extent = tuple[float, float, float, float]


def _square_3006_extent(bbox_wgs84: tuple[float, float, float, float]) -> Extent:
    """Reproject the WGS84 bbox to EPSG:3006 metres and expand it to a true
    square (GSPro textures/heightmaps are square) whose side is the next whole
    multiple of SIDE_STEP_M, centred where the bbox is centred. The app skips
    this and passes its exact, already-snapped square as --square-3006."""
    e0, n0, e1, n1 = transform_bounds(WGS84, SWEREF99, *bbox_wgs84)
    cx, cy = (e0 + e1) / 2.0, (n0 + n1) / 2.0
    side = math.ceil(max(e1 - e0, n1 - n0) / SIDE_STEP_M - 1e-9) * SIDE_STEP_M
    return (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)


def _parse_square(text: str) -> Extent:
    """`x0,y0,x1,y1` in EPSG:3006 metres; must be a true square."""
    try:
        parts = [float(v) for v in text.split(",")]
    except ValueError:
        parts = []
    if len(parts) != 4:
        raise SystemExit("error: --square-3006 must be x0,y0,x1,y1 (EPSG:3006 metres)")
    x0, y0, x1, y1 = parts
    if x1 <= x0 or y1 <= y0:
        raise SystemExit("error: --square-3006 must have x1 > x0 and y1 > y0")
    if abs((x1 - x0) - (y1 - y0)) > 1e-6:
        raise SystemExit(f"error: --square-3006 is not square ({x1 - x0:.3f} × {y1 - y0:.3f} m)")
    return (x0, y0, x1, y1)


def _add_area(p: argparse.ArgumentParser) -> None:
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--bbox", help="west,south,east,north in WGS84 degrees (squared, side rounded up to 10 m)")
    group.add_argument("--square-3006", dest="square_3006",
                       help="the exact square to render, x0,y0,x1,y1 in EPSG:3006 metres")


def _resolve_area(args: argparse.Namespace) -> tuple[tuple[float, float, float, float], Extent]:
    """(WGS84 bbox, EPSG:3006 square extent) from --bbox or --square-3006. With
    the square given, the WGS84 bbox is its envelope — what STAC/lidar
    searches take — and the extent is used verbatim."""
    if getattr(args, "square_3006", None):
        extent = _parse_square(args.square_3006)
        return transform_bounds(SWEREF99, WGS84, *extent), extent
    bbox = _parse_bbox(args.bbox)
    return bbox, _square_3006_extent(bbox)


def _reproject_square(src_path: Path, extent: tuple[float, float, float, float], size: int,
                      bands: list[int], dtype, resampling: Resampling) -> np.ndarray:
    """Reproject selected bands of a raster into a size×size array covering the
    square EPSG:3006 `extent`. Returns (len(bands), size, size). For float
    output the source's nodata is honoured (masked out of the resampling
    kernel, so a -9999 never bleeds into a neighbour) and every cell the
    source does not cover comes back NaN — `_fill_voids` deals with those."""
    e0, n0, e1, n1 = extent
    dst_transform = from_bounds(e0, n0, e1, n1, size, size)
    floating = np.issubdtype(np.dtype(dtype), np.floating)
    out = np.full((len(bands), size, size), np.nan if floating else 0, dtype=dtype)
    with rasterio.open(src_path) as src:
        nodata_kw = {"src_nodata": src.nodata, "dst_nodata": np.nan} if floating else {}
        for i, b in enumerate(bands):
            reproject(
                source=rasterio.band(src, b),
                destination=out[i],
                src_crs=src.crs, src_transform=src.transform,
                dst_crs=SWEREF99, dst_transform=dst_transform,
                resampling=resampling, **nodata_kw,
            )
    return out


def _safe(name: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name or "unknown")


# --- Command: ortho ---------------------------------------------------------

def _darken(hwc: np.ndarray, factor: "float | np.ndarray", space: str) -> np.ndarray:
    """RGB × factor (one number, or one per channel), in linear light (sRGB
    decoded, multiplied, re-encoded) or directly on the sRGB values."""
    f = hwc.astype(np.float32) / 255.0
    if space == "linear":
        lin = np.where(f <= 0.04045, f / 12.92, ((f + 0.055) / 1.055) ** 2.4) * factor
        f = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    else:
        f = f * factor
    return np.round(f.clip(0, 1) * 255).astype(np.uint8)


def _darken_tints(tints: "dict[str, Tint]", factor: float, space: str) -> "dict[str, Tint]":
    """`--darken-tint`: the grass and ground tint colours under the same
    light multiplier as the photo. They are sun-lit colours (the PSD's fill
    sits under an undarkened satellite), so laid over the darkened photo as
    they are they lift it back up: at 50 % the tinted file comes out ~1.85×
    brighter than the terrain twin. That lift is what looks right on the
    course meshes, so it is the default; the OUTER terrain wants the twin's
    darkness with the colouring on top, and darkened alike the tint changes
    hue and contrast and leaves the brightness where `--darken` put it.
    Water is left alone: its colour was picked against the darkened
    texture."""
    def dim(rgb: "Rgb") -> "Rgb":
        r, g, b = _darken(np.array([[rgb]], dtype=np.uint8), factor, space)[0, 0]
        return int(r), int(g), int(b)
    return {kind: ((rgb, a) if kind in TINT_WATER_TYPES else (dim(rgb), a)) for kind, (rgb, a) in tints.items()}


def _parse_grade(text: str | None) -> "tuple[float, float, float] | None":
    """`--tint-grade R,G,B`: per-channel multipliers applied to the finished
    tinted file in linear light. A texture cannot know how it will be
    shaded: Unity's terrain shader renders the same values about twice as
    bright as the course-mesh shaders and greyer, so a terrain next to
    meshes needs its file pulled down and towards green to LOOK the same.
    The numbers are rendered-mesh / rendered-terrain, measured per channel
    (in linear light) on the same ground either side of the seam in a
    screenshot; re-measure and multiply in when the two still differ."""
    if text is None:
        return None
    try:
        r, g, b = (float(v) for v in text.split(","))
    except ValueError:
        raise SystemExit(f"error: --tint-grade wants R,G,B multipliers, got {text!r}") from None
    if not all(0 < v <= 4 for v in (r, g, b)):
        raise SystemExit("error: --tint-grade multipliers must be in (0, 4]")
    return r, g, b


# --- Forest floor (D-VZ10) -------------------------------------------------
# The course's woodland_floor zones (lidar stands from Regenerate trees, or
# drawn) are repainted as forest floor on the square before it is saved, so
# the photo-as-is, the terrain twin and the tinted twin all carry it. The
# drawn playable surfaces, bunkers, paths and water are kept as photographed.
FLOOR_ZONE_TYPE = "woodland_floor"
FLOOR_KEEP_TYPES = ("fairway", "semi_rough", "rough", "tee", "green", "bunker", "path", "water", "water_creek")


class FloorJob:
    """The stands and the keep geometry `_render_ortho` paints with, loaded once."""

    def __init__(self, course_name: str, stands: list, keep, feather_m: float, seed: int):
        self.course_name, self.stands, self.keep, self.feather_m, self.seed = course_name, stands, keep, feather_m, seed


def _load_floor_job(db_path: Path, course_ident: str, color: str | None = None, mix: float | None = None,
                    feather_m: float | None = None, seed: int = 0) -> FloorJob:
    """A course's woodland_floor zones as floor stands (their floorColor /
    floorStdev attributes mixed into `color` at `mix`) and the union of its
    FLOOR_KEEP_TYPES features, both in EPSG:3006 metres."""
    from shapely.ops import unary_union
    from golfpipe import woodland_floor

    fallback = woodland_floor.DEFAULT_FLOOR_RGB if color is None else _parse_hex(color, "--floor-color")
    mix = woodland_floor.DEFAULT_FLOOR_MIX if mix is None else mix
    if not 0.0 <= mix <= 1.0:
        raise SystemExit("error: --floor-mix must be 0..1")
    feather_m = woodland_floor.DEFAULT_FEATHER_M if feather_m is None else feather_m
    if feather_m < 0:
        raise SystemExit("error: --floor-feather must be >= 0")
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute(
        "SELECT type, geometry_json, attributes_json FROM course_features WHERE course_id = ?",
        (course["id"],),
    ).fetchall()
    conn.close()
    stands, keep = [], []
    for r in rows:
        if r["type"] != ZONE_FEATURE_TYPE and r["type"] not in FLOOR_KEEP_TYPES:
            continue
        geom = _zone_geometry_m(json.loads(r["geometry_json"]))
        if geom is None or geom.is_empty:
            continue
        if r["type"] == ZONE_FEATURE_TYPE:
            attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
            if isinstance(attrs, dict) and attrs.get("zoneType") == FLOOR_ZONE_TYPE:
                stands.append(woodland_floor.stand_from_properties(geom, attrs, fallback, mix=mix))
        else:
            keep.append(geom)
    return FloorJob(course["name"], stands, unary_union(keep) if keep else None, feather_m, seed)


def _paint_floor(hwc: np.ndarray, extent, size: int, floor: FloorJob) -> np.ndarray:
    from golfpipe.woodland_floor import paint_woodland_floor

    transform = from_bounds(extent[0], extent[1], extent[2], extent[3], size, size)
    painted, n = paint_woodland_floor(hwc, transform, floor.stands, keep=floor.keep,
                                      feather_m=floor.feather_m, seed=floor.seed, block_rows=512)
    side = (extent[2] - extent[0]) / size
    print(f"  forest floor: {len(floor.stands)} woodland_floor zone(s) of {floor.course_name}, "
          f"{n:,} px (~{n * side * side / 10_000:,.1f} ha)")
    return painted


class BuildingJob:
    """What `_render_ortho` removes buildings with: the lidar roof heights
    and/or the building survey's footprints, and the shadow when given."""

    def __init__(self, roofs: Path | None, survey: Path | None, azimuth_deg: float | None = None,
                 ratio: float | None = None):
        self.roofs, self.survey, self.azimuth_deg, self.ratio = roofs, survey, azimuth_deg, ratio


def _remove_buildings(hwc: np.ndarray, extent, size: int, job: BuildingJob) -> np.ndarray:
    from golfpipe import building_removal

    transform = from_bounds(extent[0], extent[1], extent[2], extent[3], size, size)
    if job.roofs is not None:
        heights = building_removal.roof_heights_on_grid(job.roofs, transform, (size, size))
    else:
        heights = np.zeros((size, size), dtype=np.float32)
    if job.survey is not None:
        heights, surveyed = building_removal.burn_survey(heights, transform, job.survey)
        print(f"  buildings: {surveyed} surveyed footprint(s) from {job.survey.name} on this square")
    cleaned, report = building_removal.remove_buildings(hwc, transform, heights, job.azimuth_deg, job.ratio)
    side = (extent[2] - extent[0]) / size
    if report.buildings == 0:
        print("  buildings: no roofs on this square")
        return cleaned
    how = "measured from the photo" if report.shadow.measured else (
        "as given" if job.azimuth_deg is not None and job.ratio is not None else "fallback, too few roofs to measure")
    print(f"  buildings: {report.buildings} roof(s) and their shadows removed, "
          f"{report.masked_px * side * side:,.0f} m²; shadow toward {report.shadow.azimuth_deg:g}°, "
          f"{report.shadow.ratio:g} x height ({how})")
    return cleaned


def _render_ortho(src: Path, extent, size: int, out: Path, quality: int = DEFAULT_JPEG_QUALITY,
                  terrain_out: Path | None = None, darken: float = DEFAULT_TERRAIN_DARKEN,
                  darken_space: str = DEFAULT_DARKEN_SPACE, tint: "TintJob | None" = None,
                  floor: "FloorJob | None" = None, buildings: "BuildingJob | None" = None) -> None:
    """Render the square to `out` as-is and, with `terrain_out`, a second
    copy of the same render darkened by `darken` (see `_darken`) for use as
    the Unity terrain texture — one reprojection, two files. With `tint`, a
    third: the darkened twin with the course's grass surfaces tinted (see
    `_tint_terrain`), the hand-made Photoshop overlay done from the app's
    own feature shapes. With `buildings`, the lidar roofs and their shadows
    are filled from the ground round them first, and with `floor` the
    course's woodland_floor zones are then painted as forest floor, so every
    file carries both."""
    # Cubic, not bilinear: the source is ~0.16 m/px, so an 8192 px texture
    # of a 2 km square is a 1.5× downsample and bilinear aliases. OPCD's own
    # overlay step is a 16000 → 8192 cubic resample (gdal_translate -r cubic).
    rgb = _reproject_square(src, extent, size, bands=[1, 2, 3], dtype="uint8",
                            resampling=Resampling.cubic)
    out.parent.mkdir(parents=True, exist_ok=True)
    hwc = np.transpose(rgb, (1, 2, 0))
    if buildings is not None:
        hwc = _remove_buildings(hwc, extent, size, buildings)
    if floor is not None:
        hwc = _paint_floor(hwc, extent, size, floor)
    Image.fromarray(hwc).save(out, format="JPEG", quality=quality)
    print(f"  wrote {out}")
    if terrain_out is not None:
        terrain_out.parent.mkdir(parents=True, exist_ok=True)
        dark = _darken(hwc, darken, darken_space)
        tq = max(quality, TERRAIN_JPEG_QUALITY)
        Image.fromarray(dark).save(terrain_out, format="JPEG", quality=tq, subsampling=0)
        print(f"  wrote {terrain_out}  (terrain texture, ×{darken:g} in {darken_space} light, JPEG q{tq} 4:4:4)")
        if tint is not None:
            tints = _darken_tints(tint.tints, darken, darken_space) if tint.darken_tint else tint.tints
            tinted, summary = _tint_terrain(dark, extent, tint.rows, tints, tint.water_feather_m, tint.soften_m)
            tint.out.parent.mkdir(parents=True, exist_ok=True)
            im = Image.fromarray(tinted)
            edge = min(tint.size or DEFAULT_TINT_SIZE, size)
            if edge != size:
                im = im.resize((edge, edge), Image.LANCZOS)
            if tint.grade is not None:
                im = Image.fromarray(_darken(np.asarray(im), np.asarray(tint.grade, dtype=np.float32), "linear"))
                summary += "; graded ×{:g}/{:g}/{:g} (R/G/B, linear light)".format(*tint.grade)
            im.save(tint.out, format="JPEG", quality=tq, subsampling=0)
            print(f"  wrote {tint.out}  ({edge}×{edge}, terrain texture + surface tint from {tint.course_name}: {summary})")


def cmd_ortho(bbox, out_dir: Path | None, size: int, count: int, ortho_tifs: list[Path] | None,
              quality: int = DEFAULT_JPEG_QUALITY, out: Path | None = None,
              extent: Extent | None = None, terrain_out: Path | None = None,
              darken: float = DEFAULT_TERRAIN_DARKEN, darken_space: str = DEFAULT_DARKEN_SPACE,
              tint_out: Path | None = None, tint_course: str | None = None,
              db_path: Path = DEFAULT_DB, tints: "dict[str, Tint] | None" = None,
              water_feather_m: float | None = None, soften_m: float | None = None,
              tint_size: int | None = None, darken_tint: bool = False,
              tint_grade: "tuple[float, float, float] | None" = None,
              floor_course: str | None = None, floor_color: str | None = None, floor_mix: float | None = None,
              floor_feather_m: float | None = None, floor_seed: int = 0,
              remove_buildings: bool = False, roofs: Path | None = None, buildings_survey: Path | None = None,
              shadow_azimuth: float | None = None, shadow_ratio: float | None = None) -> None:
    if not 1 <= quality <= 100:
        raise SystemExit("error: --quality must be 1..100")
    if not 0 < darken <= 1:
        raise SystemExit("error: --darken must be in (0, 1]")
    if darken_space not in ("linear", "srgb"):
        raise SystemExit("error: --darken-space must be linear or srgb")
    if out is not None and (not ortho_tifs or len(ortho_tifs) != 1):
        raise SystemExit("error: --out names one file, so it needs exactly one --ortho source")
    if terrain_out is not None and out is None:
        raise SystemExit("error: --terrain-out goes with --out")
    if out is None and out_dir is None:
        raise SystemExit("error: --out-dir is required (or --out with a single --ortho)")
    tint: TintJob | None = None
    if tint_out is not None:
        if terrain_out is None or not tint_course:
            raise SystemExit("error: --tint-out needs --terrain-out (it tints that twin) and --tint-course")
        if soften_m is None:
            soften_m = DEFAULT_SOFTEN_M
        if soften_m < 0:
            raise SystemExit("error: --soften-m must be >= 0")
        if tint_size is not None and tint_size <= 0:
            raise SystemExit("error: --tint-size must be > 0")
        course, rows = _load_course_features(db_path, tint_course, "opcd")
        if water_feather_m is None:
            water_feather_m = DEFAULT_WATER_FEATHER_M
        if water_feather_m < 0:
            raise SystemExit("error: --water-feather must be >= 0")
        tint = TintJob(tint_out, course["name"], rows, tints if tints is not None else _parse_tints(None),
                       water_feather_m, soften_m, tint_size, darken_tint, tint_grade)
    elif tint_course:
        raise SystemExit("error: --tint-course goes with --tint-out")
    floor = None
    if floor_course:
        floor = _load_floor_job(db_path, floor_course, floor_color, floor_mix, floor_feather_m, floor_seed)
        if not floor.stands:
            print(f"note: {floor.course_name} has no {FLOOR_ZONE_TYPE} zones; no forest floor painted "
                  "(Regenerate trees makes them from lidar)")
            floor = None
    buildings = None
    if remove_buildings:
        if roofs is None and buildings_survey is None:
            raise SystemExit("error: --remove-buildings needs --roofs and/or --buildings-survey")
        for what, path in (("roof heights file", roofs), ("building survey", buildings_survey)):
            if path is not None and not path.is_file():
                raise SystemExit(f"error: no such {what}: {path}")
        if shadow_ratio is not None and not 0 < shadow_ratio <= 5:
            raise SystemExit("error: --shadow-ratio must be in (0, 5]")
        buildings = BuildingJob(roofs, buildings_survey, shadow_azimuth, shadow_ratio)
    elif roofs is not None or buildings_survey is not None or shadow_azimuth is not None or shadow_ratio is not None:
        raise SystemExit("error: --roofs / --buildings-survey / --shadow-azimuth / --shadow-ratio go with --remove-buildings")
    extent = extent or _square_3006_extent(bbox)

    # Reuse already-downloaded/cropped ortho GeoTIFFs (e.g. the build's
    # data/sources/{siteId}/ortho-*.tif) instead of re-fetching. With --out the
    # single source lands at exactly that path (the app's export names its own
    # files); otherwise each goes to out-dir as ortho_<stem>_<size>px.jpg.
    if ortho_tifs:
        for src in ortho_tifs:
            if not src.is_file():
                raise SystemExit(f"error: no such orthophoto: {src}")
            dest = out if out is not None else out_dir / f"ortho_{_safe(src.stem)}_{size}px.jpg"
            print(f"rendering {src.name}")
            _render_ortho(src, extent, size, dest, quality, terrain_out=terrain_out, darken=darken,
                          darken_space=darken_space, tint=tint, floor=floor, buildings=buildings)
        print("\nDone (from local sources).")
        return

    out_dir.mkdir(parents=True, exist_ok=True)

    vintages = stac.ortho_vintages(bbox)
    if not vintages:
        raise SystemExit(f"No orthophoto items found for bbox {bbox}")
    selected = vintages[:count]
    print(f"Found {len(vintages)} vintage(s); rendering the {len(selected)} newest: "
          f"{', '.join(c for c, _ in selected)}")

    with tempfile.TemporaryDirectory(prefix="gspro-ortho-") as tmp:
        tmp_path = Path(tmp)
        for rank, (collection, group) in enumerate(selected):
            dates = sorted({it.datetime[:10] for it in group if it.datetime})
            print(f"\n[{rank + 1}/{len(selected)}] {collection}  ({', '.join(dates) or 'no date'}) — {len(group)} tile(s)")

            downloaded = []
            for it in group:
                dest = tmp_path / f"{it.id}.tif"
                print(f"  downloading {it.id}")
                stac.download_asset(it.data_href, dest)
                downloaded.append(dest)

            mosaic = tmp_path / f"mosaic_{_safe(collection)}.tif"
            mosaic_and_crop(downloaded, bbox, mosaic, buffer_m=0.0)
            _render_ortho(mosaic, extent, size, out_dir / f"ortho_{_safe(collection)}_{size}px.jpg", quality,
                          floor=floor, buildings=buildings)

    print("\nDone. Compare the JPEGs and use whichever vintage looks best in GSPro.")


# --- Command: hillshade -----------------------------------------------------

def _hillshade(dem: np.ndarray, res_m: float, azimuth: float, altitude: float, z: float) -> np.ndarray:
    """QGIS/GDAL-style hillshade (Horn gradients). Returns uint8 0..255."""
    x, y = np.gradient(dem * z, res_m, res_m)
    slope = np.pi / 2.0 - np.arctan(np.hypot(x, y))
    aspect = np.arctan2(-x, y)
    az = np.radians(azimuth)
    alt = np.radians(altitude)
    shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos((az - np.pi / 2.0) - aspect)
    return (255.0 * (shaded + 1) / 2).clip(0, 255).astype("uint8")


def _dem_from_lidar(bbox, tmp: Path, resolution: float) -> Path:
    """Fetch Laserdata Skog lidar for bbox and grid it into a DEM (EPSG:3006)."""
    print("No --dem given; fetching lidar + gridding a DEM (this is the heavy part)…")
    lidar = commands.cmd_fetch_lidar(bbox, tmp / "lidar", tmp / "lidar")
    bbox_3006 = commands.cmd_reproject_bbox(bbox, epsg=3006)
    dem = tmp / "dem.tif"
    commands.cmd_grid_dem(lidar, bbox_3006, dem, resolution=resolution)
    return dem


def _fill_voids(dem: np.ndarray) -> np.ndarray:
    """Fill nodata-ish cells (NaN, or a nodata sentinel like -9999 that
    slipped through untagged) with the mean so nothing cliffs at holes — in
    a hillshade or a heightmap. Swedish ground is never below -1000 m."""
    finite = np.isfinite(dem) & (dem > -1000)
    if finite.all():
        return dem
    dem = dem.copy()
    dem[~finite] = float(np.nanmean(dem[finite])) if finite.any() else 0.0
    return dem


def cmd_hillshade(bbox, out: Path, size: int, dem_path: Path | None,
                  azimuth: float, altitude: float, z: float, resolution: float,
                  extent: Extent | None = None) -> None:
    extent = extent or _square_3006_extent(bbox)
    with tempfile.TemporaryDirectory(prefix="gspro-hs-") as tmp:
        dem_src = dem_path if dem_path else _dem_from_lidar(bbox, Path(tmp), resolution)

        dem = _reproject_square(dem_src, extent, size, bands=[1], dtype="float32",
                                resampling=Resampling.bilinear)[0]

    dem = _fill_voids(dem)
    res_m = (extent[2] - extent[0]) / size  # metres per pixel
    shade = _hillshade(dem, res_m, azimuth, altitude, z)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(shade, mode="L").save(out, quality=92)
    print(f"Wrote {out}  ({size}×{size}, {res_m:.2f} m/px, az {azimuth}°, alt {altitude}°)")


# --- Command: dem -----------------------------------------------------------

def _write_raw(dem: np.ndarray, out: Path, lo: float, hi: float) -> None:
    """Unity RAW heightmap: [lo, hi] -> [0, 65535], uint16 little-endian
    ("Windows" byte order in Unity's import dialog), headerless, rows as they
    come from the reprojection — north-up — so Unity's import wants Flip
    Vertically ticked, exactly like the OPCD .bat's output."""
    span = hi - lo
    if span > 0:
        scaled = np.round((dem - lo) / span * UINT16_MAX).clip(0, UINT16_MAX)
    else:
        scaled = np.zeros_like(dem)
    out.write_bytes(np.ascontiguousarray(scaled).astype("<u2").tobytes())


def _outer_position(extent: Extent, lo: float, inner_sidecar: Path) -> dict:
    """Where the OUTER terrain object goes in Unity when the INNER sits at the
    origin: both squares share a centre, so the outer's south-west corner is
    half the side difference to the south-west, and each heightmap is scaled
    from its own minimum, so the outer is lifted by the difference in minima.
    (OPCD's MinMax sheet computes the same X, Y, Z by hand.)"""
    inner = json.loads(inner_sidecar.read_text(encoding="utf-8"))
    e0, n0, e1, n1 = extent
    side = e1 - e0
    inner_side = float(inner["sideM"])
    ix0, iy0, ix1, iy1 = inner["square3006"]
    dx = ((ix0 + ix1) / 2) - ((e0 + e1) / 2)
    dy = ((iy0 + iy1) / 2) - ((n0 + n1) / 2)
    if abs(dx) > 0.5 or abs(dy) > 0.5:
        print(f"  warning: inner sidecar centre is {dx:.1f} m east, {dy:.1f} m north of this square's — "
              "was it exported for another map area? The outer position below allows for it.")
    offset = -(side - inner_side) / 2
    return {
        "x": round(offset - dx, 3),
        "y": round(lo - float(inner["minM"]), 3),
        "z": round(offset - dy, 3),
        "innerSidecar": inner_sidecar.name,
    }


def cmd_dem(bbox, dem_path: Path, out: Path, resolution: float = DEFAULT_DEM_RESOLUTION,
            extent: Extent | None = None, raw_size: int = UNITY_HEIGHTMAP_RESOLUTION,
            terrain: str | None = None, inner_sidecar: Path | None = None,
            sculpt: list[Path] | None = None) -> None:
    """Clip + bilinear-resample `dem_path` to the square at `resolution` m/px
    and write it as a float32 EPSG:3006 GeoTIFF (deflate) — what OPCD's
    TIF→RAW heightmap step takes — AND do that step: a `<out stem>.raw`
    Unity heightmap, `raw_size`² uint16 little-endian north-up, scaled over
    the height range (0 = skip). The RAW is resampled straight from the
    source DEM, not from the TIF, so it costs one resampling like the .bat.
    A `<out>.json` sidecar records the square, the cell size, the height
    range and the Unity terrain + import settings (OPCD's MinMax sheet);
    with `inner_sidecar` (an outer export) it also carries the outer
    terrain's Unity position relative to the inner at the origin. `sculpt`
    names the Unity sculpt layers `dem_path` contains (the `delta` edits'
    GeoTIFFs, golfpipe/sculpt.py): their sum on the .raw's grid goes next to
    it as `<stem>-sculpt-in.raw` (float32 metres, north-up, cropped) and into
    the sidecar as `sculptIn`, so Unity can tell that sculpt apart from the
    rest of the heights when it captures the next one."""
    if resolution <= 0:
        raise SystemExit("error: --resolution must be > 0")
    if raw_size < 0:
        raise SystemExit("error: --raw-size must be >= 0 (0 skips the .raw)")
    if not dem_path.is_file():
        raise SystemExit(f"error: no such DEM: {dem_path}")
    if inner_sidecar is not None and not inner_sidecar.is_file():
        raise SystemExit(f"error: no such inner sidecar: {inner_sidecar}")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    cells = side / resolution
    size = int(round(cells))
    if abs(cells - size) > 1e-6:
        raise SystemExit(f"error: the {side:g} m square is not a whole number of {resolution:g} m cells")

    dem = _reproject_square(dem_path, extent, size, bands=[1], dtype="float32",
                            resampling=Resampling.bilinear)[0]
    dem = _fill_voids(dem)
    lo, hi = float(dem.min()), float(dem.max())

    raw_dem = None
    if raw_size:
        raw_dem = _fill_voids(_reproject_square(dem_path, extent, raw_size, bands=[1], dtype="float32",
                                                resampling=Resampling.bilinear)[0])
        # One height range for both files, so the TIF's statistics and the
        # RAW's scale agree with the sidecar whichever one is inspected.
        lo, hi = min(lo, float(raw_dem.min())), max(hi, float(raw_dem.max()))

    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        out, "w", driver="GTiff", height=size, width=size, count=1, dtype="float32",
        crs=SWEREF99, transform=from_bounds(e0, n0, e1, n1, size, size),
        compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256,
    ) as dst:
        dst.write(dem, 1)
    print(f"Wrote {out}  ({size}×{size}, {resolution:g} m/px, {side:g} m square, {lo:.2f}..{hi:.2f} m)")

    sidecar_data: dict = {
        "crs": "EPSG:3006",
        "terrain": terrain,
        "square3006": [e0, n0, e1, n1],
        "centre3006": [(e0 + e1) / 2, (n0 + n1) / 2],
        "sideM": side,
        "resolution": resolution,
        "size": size,
        "minM": lo,
        "maxM": hi,
        "heightRangeM": hi - lo,
        "source": dem_path.name,
        "unity": {
            "terrainWidthM": side,
            "terrainLengthM": side,
            "terrainHeightM": hi - lo,
            "heightmapResolution": raw_size or UNITY_HEIGHTMAP_RESOLUTION,
            "depth": 16,
            "byteOrder": "Windows",
            "flipVertically": True,
        },
    }

    if raw_dem is not None:
        raw = out.with_suffix(".raw")
        _write_raw(raw_dem, raw, lo, hi)
        sidecar_data["raw"] = {
            "file": raw.name,
            "size": raw_size,
            "dtype": "uint16",
            "byteOrder": "little-endian",
            "rowOrder": "north-up",
            "scale": {"minM": lo, "maxM": hi, "to": [0, UINT16_MAX]},
        }
        print(f"  heightmap {raw}  ({raw_size}×{raw_size} uint16 little-endian, north-up, "
              f"{lo:.2f} m = 0 .. {hi:.2f} m = {UINT16_MAX})")
        sculpt_raw = out.with_name(out.stem + "-sculpt-in.raw")
        if sculpt:
            from golfpipe.sculpt import sculpt_on_grid
            layer = sculpt_on_grid([Path(p) for p in sculpt], extent, raw_size)
            rows, cols = np.nonzero(np.abs(layer) > 1e-4)
            if rows.size:
                r0, r1, c0, c1 = int(rows.min()), int(rows.max()) + 1, int(cols.min()), int(cols.max()) + 1
                layer[r0:r1, c0:c1].astype("<f4").tofile(sculpt_raw)
                sidecar_data["sculptIn"] = {
                    "file": sculpt_raw.name, "size": raw_size,
                    "crop": {"col0": c0, "row0": r0, "cols": c1 - c0, "rows": r1 - r0},
                    "maxAbsM": round(float(np.abs(layer).max()), 3),
                }
                print(f"  sculpt layer {sculpt_raw}  ({c1 - c0}×{r1 - r0} of the grid, up to "
                      f"{float(np.abs(layer).max()):.2f} m, from {len(sculpt)} Unity sculpt layer(s))")
        if "sculptIn" not in sidecar_data and sculpt_raw.exists():
            sculpt_raw.unlink()  # a stale one from an earlier export

    position = None
    if inner_sidecar is not None:
        position = _outer_position(extent, lo, inner_sidecar)
        sidecar_data["unity"]["position"] = position
    elif terrain == "inner":
        sidecar_data["unity"]["position"] = {"x": 0.0, "y": 0.0, "z": 0.0}

    sidecar = out.with_name(out.name + ".json")
    sidecar.write_text(json.dumps(sidecar_data, indent=2) + "\n", encoding="utf-8")
    print(f"  sidecar {sidecar}")
    print(f"  Unity terrain: Width/Length {side:g} m, Height {hi - lo:.3f} m; "
          f"import RAW 16-bit, Windows byte order, {raw_size or UNITY_HEIGHTMAP_RESOLUTION}², Flip Vertically")
    if position is not None:
        print(f"  Unity outer position (inner at the origin): x {position['x']:g}, y {position['y']:g}, z {position['z']:g}")


# --- Command: trees ---------------------------------------------------------

UNITY_TREES_FORMAT = "unity-trees-v1"
# A crown wider than this fraction of its height reads as a bush to the planter.
BUSH_RADIUS_FRACTION = 0.35


def _load_stems(path: Path) -> list[dict]:
    """Rows of a tree-stems-v1/v2 compact asset as dicts (x, y, heightM,
    crownRadiusM, groundM, kind); v1 rows get kind 2 (unknown)."""
    asset = json.loads(path.read_text(encoding="utf-8"))
    fields = asset.get("fields") or []
    if asset.get("crs") != "EPSG:3006" or not isinstance(asset.get("trees"), list) or "x" not in fields:
        raise SystemExit(f"error: {path} is not a tree-stems asset")
    rows = []
    for row in asset["trees"]:
        d = dict(zip(fields, row))
        d.setdefault("kind", 2)
        rows.append(d)
    return rows


def cmd_trees(bbox, stems_path: Path, sidecar_path: Path, out: Path, terrain: str | None = None,
              exclude: Extent | None = None, extent: Extent | None = None) -> None:
    """Write a unity-trees-v1 file for one terrain: every stem inside the
    square (and outside `exclude`, the inner square when this is the outer)
    as x/z metres from the square's south-west corner, with the plot's
    height range copied from the terrain's heightmap sidecar so the planter's
    ground check and the terrain agree to the centimetre."""
    if not stems_path.is_file():
        raise SystemExit(f"error: no such tree-stems asset: {stems_path}")
    if not sidecar_path.is_file():
        raise SystemExit(f"error: no such heightmap sidecar: {sidecar_path} (export the heightmap first)")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sq = sidecar.get("square3006")
    if sq and any(abs(a - b) > 0.01 for a, b in zip(sq, extent)):
        raise SystemExit(f"error: the sidecar {sidecar_path.name} is for square {sq}, not {list(extent)}")

    trees = []
    outside = excluded = duplicates = 0
    seen: dict[str, int] = {}
    for s in _load_stems(stems_path):
        x, y = float(s["x"]), float(s["y"])
        if not (e0 <= x <= e1 and n0 <= y <= n1):
            outside += 1
            continue
        if exclude is not None and exclude[0] <= x <= exclude[2] and exclude[1] <= y <= exclude[3]:
            excluded += 1
            continue
        h, r = float(s["heightM"]), float(s["crownRadiusM"])
        stem_id = f"epsg3006:{x:.2f}:{y:.2f}"
        # The detector can seed two crowns on one cell (a lobe marker landing
        # on its parent's peak); the planter keys stems by id, so keep the
        # wider crown and drop the twin.
        if stem_id in seen:
            duplicates += 1
            if r > trees[seen[stem_id]]["r"]:
                trees[seen[stem_id]].update({"h": h, "r": r, "g": float(s["groundM"]), "k": int(s["kind"]),
                                             "bush": r > BUSH_RADIUS_FRACTION * h})
            continue
        seen[stem_id] = len(trees)
        trees.append({
            "id": stem_id,
            "x": round(x - e0, 3),
            "z": round(y - n0, 3),
            "h": h,
            "r": r,
            "g": float(s["groundM"]),
            "k": int(s["kind"]),
            "bush": r > BUSH_RADIUS_FRACTION * h,
        })

    doc = {
        "format": UNITY_TREES_FORMAT,
        "plot": {
            "crs": "EPSG:3006",
            "terrain": terrain or sidecar.get("terrain") or "",
            "originX": e0,
            "originY": n0,
            "sizeM": side,
            "minM": float(sidecar["minM"]),
            "maxM": float(sidecar["maxM"]),
        },
        "trees": trees,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n", encoding="utf-8")
    kinds = {k: sum(1 for t in trees if t["k"] == k) for k in (0, 1, 2)}
    print(f"Wrote {out}")
    print(f"  {len(trees)} trees on the {side:g} m {doc['plot']['terrain'] or 'terrain'} square "
          f"(broadleaf {kinds[0]}, conifer {kinds[1]}, unknown {kinds[2]}; "
          f"{sum(1 for t in trees if t['bush'])} bushes); {outside} outside the square"
          + (f", {excluded} left to the inner terrain" if exclude is not None else "")
          + (f", {duplicates} duplicate position(s) merged" if duplicates else ""))
    print(f"  plot origin {e0:.0f},{n0:.0f} (EPSG:3006), height range {doc['plot']['minM']:.2f}..{doc['plot']['maxM']:.2f} m from {sidecar_path.name}")


# --- Command: buildings -----------------------------------------------------

UNITY_BUILDINGS_FORMAT = "unity-buildings-v1"


def _read_plot_sidecar(sidecar_path: Path, extent: Extent) -> dict:
    if not sidecar_path.is_file():
        raise SystemExit(f"error: no such heightmap sidecar: {sidecar_path} (export the heightmap first)")
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sq = sidecar.get("square3006")
    if sq and any(abs(a - b) > 0.01 for a, b in zip(sq, extent)):
        raise SystemExit(f"error: the sidecar {sidecar_path.name} is for square {sq}, not {list(extent)}")
    return sidecar


def cmd_buildings(bbox, survey_path: Path, sidecar_path: Path, out: Path, terrain: str | None = None,
                  exclude: Extent | None = None, extent: Extent | None = None) -> None:
    """Write a unity-buildings-v1 file for one terrain from a fetch-buildings
    survey: every building whose rectangle centre is inside the square (and
    outside `exclude`, the inner square when this is the outer), positioned
    like the trees file — `x`/`z` metres from the square's south-west
    corner — with the footprint ring in the same local metres, the
    rectangle's sides and its `yawDeg`: the Unity rotation about Y
    (clockwise seen from above) that turns a prefab's local +x onto the
    footprint's long axis. Which end is the front, and whether the prefab's
    long axis is its +x or +z, is the planter's business (add 90/180 there).
    `heightM` is the lidar ridge when measured, else the OSM height tag,
    else levels × 3 m, else 0; `heightSource` says which (`none` for 0).
    The plot block copies the terrain's heightmap sidecar exactly as the
    trees file does. Shaped for Unity's JsonUtility: numbers never null,
    the footprint a flat x0, z0, x1, z1, … list."""
    from golfpipe import buildings as buildings_mod

    if not survey_path.is_file():
        raise SystemExit(f"error: no such building survey: {survey_path}")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    sidecar = _read_plot_sidecar(sidecar_path, extent)
    try:
        survey = buildings_mod.read_survey(survey_path)
    except (ValueError, KeyError) as exc:
        raise SystemExit(f"error: {exc}")

    rows = []
    outside = excluded = 0
    for b in survey:
        cx, cy = b.rect.cx, b.rect.cy
        if not (e0 <= cx <= e1 and n0 <= cy <= n1):
            outside += 1
            continue
        if exclude is not None and exclude[0] <= cx <= exclude[2] and exclude[1] <= cy <= exclude[3]:
            excluded += 1
            continue
        if b.roof is not None:
            height, source = b.roof.ridge_m, "lidar"
        elif b.height_tag_m is not None:
            height, source = b.height_tag_m, "tag"
        elif b.levels is not None:
            height, source = b.levels * buildings_mod.LEVEL_HEIGHT_M, "levels"
        else:
            height, source = 0.0, "none"
        ring = list(b.polygon.exterior.coords)
        if len(ring) > 1 and ring[0] == ring[-1]:
            ring = ring[:-1]
        # Unity's JsonUtility reads this (C# 6, no Newtonsoft): no nulls in
        # number fields (0 = unmeasured, `heightSource` says so) and no
        # nested arrays — the footprint is a flat x0, z0, x1, z1, … list.
        footprint: list[float] = []
        for x, y in ring:
            footprint += [round(x - e0, 2), round(y - n0, 2)]
        rows.append({
            "id": b.id,
            "kind": b.kind,
            "name": b.name or "",
            "x": round(cx - e0, 3),
            "z": round(cy - n0, 3),
            "lengthM": round(b.rect.length_m, 2),
            "widthM": round(b.rect.width_m, 2),
            "yawDeg": round((-b.rect.angle_deg) % 360.0, 1),
            "eaveM": round(b.roof.eave_m, 2) if b.roof else 0.0,
            "ridgeM": round(b.roof.ridge_m, 2) if b.roof else 0.0,
            "heightM": round(height, 2),
            "heightSource": source,
            "areaM2": round(b.polygon.area, 1),
            "footprint": footprint,
        })

    doc = {
        "format": UNITY_BUILDINGS_FORMAT,
        "plot": {
            "crs": "EPSG:3006",
            "terrain": terrain or sidecar.get("terrain") or "",
            "originX": e0,
            "originY": n0,
            "sizeM": side,
            "minM": float(sidecar["minM"]),
            "maxM": float(sidecar["maxM"]),
        },
        "buildings": rows,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n", encoding="utf-8")
    sources = {s: sum(1 for r in rows if r["heightSource"] == s) for s in ("lidar", "tag", "levels", "none")}
    print(f"Wrote {out}")
    print(f"  {len(rows)} buildings on the {side:g} m {doc['plot']['terrain'] or 'terrain'} square "
          f"(heights: lidar {sources['lidar']}, tag {sources['tag']}, levels {sources['levels']}, "
          f"none {sources['none']}); {outside} outside the square"
          + (f", {excluded} left to the inner terrain" if exclude is not None else ""))
    print(f"  plot origin {e0:.0f},{n0:.0f} (EPSG:3006), height range {doc['plot']['minM']:.2f}..{doc['plot']['maxM']:.2f} m from {sidecar_path.name}")


# --- Command: svg -----------------------------------------------------------

# The OPCD v4 Inkscape palette, verbatim from `OPCD Palette.gpl` as installed
# (Inkscape share/inkscape/palettes/OPCD_v4.gpl). Fill colour is how the
# toolchain is told what a shape is, so these hexes are not negotiable.
OPCD_PALETTE = {
    "tee": "#a0e5b8",
    "deep_rough": "#164b20",
    "rough": "#278438",
    "semi_rough": "#36b74d",
    "fairway": "#43e561",
    "green": "#bce5a4",
    "bunker": "#e5e5aa",
    "pinestraw": "#b84127",
    "concrete": "#bebebb",
    "lake": "#0000c0",
    "creek": "#00ffff",
    "custom1": "#fca328",
    "custom2": "#be02aa",
    "custom3": "#ffff00",
    "custom4": "#faa0be",
    "hole99": "#ff00cb",
}

# Spellings accepted by --map on top of the palette's own names.
PALETTE_ALIASES = {
    "pine_straw": "pinestraw", "pine straw": "pinestraw",
    "water": "lake", "water_creek": "creek", "path": "concrete",
    "semirough": "semi_rough", "deeprough": "deep_rough",
}

# golf-map feature type -> OPCD palette entry. Types with no OPCD surface
# (trees, penalty_*, oob, outside) are left out and skipped unless --map
# gives them one.
TYPE_SURFACE = {
    "tee": "tee",
    "fairway": "fairway",
    "green": "green",
    "bunker": "bunker",
    "semi_rough": "semi_rough",
    "rough": "rough",
    "deep_rough": "deep_rough",
    "water": "lake",
    "water_creek": "creek",
    "path": "concrete",
}

GSPRO_FILLS = {kind: OPCD_PALETTE[surface] for kind, surface in TYPE_SURFACE.items()}

# Where features that aren't on a hole go. Deliberately NOT the reserved
# Hole99: that layer changes how Blender cuts (it becomes an outer mesh cut by
# every hole), which is a decision to make in Inkscape, not one to inherit
# from a feature having no hole_id in the app.
COURSE_WIDE_LAYER = "Others"

# The roads (ROADS_TYPES) get a layer of their own, topmost in Inkscape, so
# nothing is ever cut into them or painted over them — the opposite end of
# the stack from the Roughs, which sit at the bottom of Others.
ROADS_LAYER = "Roads"

# Blender cuts upper shapes out of lower ones, so paint order inside a layer
# IS the cut order. These three must never be cut by anything else on the
# hole, so they are lifted to the top; everything else keeps the order it has
# in the app, and so do these three among themselves.
TOP_TYPES = ("green", "tee", "bunker")

PATH_STYLE = "fill:{fill};fill-opacity:1;stroke:none"

Pt = tuple[float, float]


def _expand_bspline_controls(points: list[dict]) -> list[Pt]:
    """Corner-flagged controls are triplicated (knot multiplicity 3), forcing
    the curve through them. Port of web/src/geo/bspline.ts."""
    ctrl: list[Pt] = []
    for p in points:
        xy = (float(p["x"]), float(p["y"]))
        ctrl.extend([xy] * (3 if p.get("corner") else 1))
    return ctrl


def _bspline_ring_anchors(points: list[dict]) -> list[dict]:
    """Closed uniform cubic B-spline control ring -> its exact bezier ring.
    Each window of 4 expanded controls yields one cubic; identical math to
    bsplineRingToBezier (web/src/geo/bspline.ts) and the server's geo.ts, so
    the exported outline is the same curve the app draws."""
    ctrl = _expand_bspline_controls(points)
    n = len(ctrl)
    if n < 3:
        return [{"p": c, "hin": c, "hout": c} for c in ctrl]

    anchors: list[dict] = []
    for i in range(n):
        p0, p1, p2 = ctrl[i], ctrl[(i + 1) % n], ctrl[(i + 2) % n]
        anchors.append({
            "p": ((p0[0] + 4 * p1[0] + p2[0]) / 6, (p0[1] + 4 * p1[1] + p2[1]) / 6),
            "hout": ((2 * p1[0] + p2[0]) / 3, (2 * p1[1] + p2[1]) / 3),
            "hin": None,
        })
    for i in range(n):  # segment i ends at anchor i+1 -> that anchor's hIn
        p1, p2 = ctrl[(i + 1) % n], ctrl[(i + 2) % n]
        anchors[(i + 1) % n]["hin"] = ((p1[0] + 2 * p2[0]) / 3, (p1[1] + 2 * p2[1]) / 3)
    return anchors


def _bezier_ring_anchors(points: list[dict]) -> list[dict]:
    """Legacy 'bezier' rings: points lie ON the curve, handles are absolute and
    optional (a missing handle means that segment end is straight)."""
    anchors: list[dict] = []
    for p in points:
        xy = (float(p["x"]), float(p["y"]))
        hin, hout = p.get("hIn"), p.get("hOut")
        anchors.append({
            "p": xy,
            "hin": (float(hin["x"]), float(hin["y"])) if hin else xy,
            "hout": (float(hout["x"]), float(hout["y"])) if hout else xy,
        })
    return anchors


def _ring_anchors(ring: dict, curve_type: str) -> list[dict]:
    points = ring.get("points") or []
    if curve_type == "bspline":
        return _bspline_ring_anchors(points)
    return _bezier_ring_anchors(points)


def _cubic_at(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: float) -> Pt:
    mt = 1.0 - t
    a, b, c, d = mt ** 3, 3 * mt * mt * t, 3 * mt * t * t, t ** 3
    return (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
            a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def _flatten_cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: float, out: list[Pt]) -> None:
    """Sample one cubic into `out` (interior points plus the end point). The
    step count comes from how far the control polygon bows away from the
    chord, so straight-ish segments stay cheap; capped at 64."""
    poly = math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)
    bow = poly - math.dist(p0, p3)
    steps = 1 if bow <= tol else min(64, int(math.sqrt(bow / tol) * 4) + 1)
    for i in range(1, steps + 1):
        out.append(_cubic_at(p0, p1, p2, p3, i / steps))


def _path_d(anchors: list[dict], to_svg, precision: int, flatten: float | None) -> str:
    """SVG path data for one closed ring, in SVG user units (metres)."""
    if not anchors:
        return ""

    def fmt(v: float) -> str:
        s = f"{v:.{precision}f}"
        return s.rstrip("0").rstrip(".") if "." in s else s

    def pt(xy: Pt) -> str:
        sx, sy = to_svg(xy)
        return f"{fmt(sx)},{fmt(sy)}"

    n = len(anchors)
    if flatten is not None:
        poly: list[Pt] = [anchors[0]["p"]]
        for i in range(n):
            a, b = anchors[i], anchors[(i + 1) % n]
            _flatten_cubic(a["p"], a["hout"], b["hin"], b["p"], flatten, poly)
        poly.pop()  # the last sample is the start point again; Z closes it
        return "M " + " L ".join(pt(p) for p in poly) + " Z"

    parts = ["M", pt(anchors[0]["p"])]
    for i in range(n):
        a, b = anchors[i], anchors[(i + 1) % n]
        parts += ["C", pt(a["hout"]), pt(b["hin"]), pt(b["p"])]
    parts.append("Z")
    return " ".join(parts)


def _open_course_db(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise SystemExit(f"error: no course database at {path} (pass --db)")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _resolve_course(conn: sqlite3.Connection, ident: str) -> sqlite3.Row:
    """Accept a course id or a case-insensitive name substring."""
    row = conn.execute("SELECT id, name FROM courses WHERE id = ? COLLATE NOCASE", (ident,)).fetchone()
    if row:
        return row
    rows = conn.execute(
        "SELECT id, name FROM courses WHERE name LIKE ? COLLATE NOCASE ORDER BY name", (f"%{ident}%",)
    ).fetchall()
    if len(rows) == 1:
        return rows[0]
    if not rows:
        known = ", ".join(r["name"] for r in conn.execute("SELECT name FROM courses ORDER BY name"))
        raise SystemExit(f"error: no course matching {ident!r}. Known courses: {known}")
    matches = ", ".join(f"{r['name']} ({r['id']})" for r in rows)
    raise SystemExit(f"error: {ident!r} matches several courses: {matches}")


def _parse_map(pairs: list[str] | None) -> dict[str, str]:
    """--map type=#rrggbb / type=other_type -> extra or overriding fills."""
    extra: dict[str, str] = {}
    for pair in pairs or []:
        kind, _, value = pair.partition("=")
        kind, value = kind.strip(), value.strip()
        if not kind or not value:
            raise SystemExit(f"error: --map wants type=#rrggbb or type=othertype, got {pair!r}")
        key = PALETTE_ALIASES.get(value.lower(), value.lower())
        if key in OPCD_PALETTE:
            value = OPCD_PALETTE[key]
        elif key in GSPRO_FILLS:
            value = GSPRO_FILLS[key]
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            names = ", ".join(OPCD_PALETTE)
            raise SystemExit(f"error: --map {pair!r}: {value!r} is not a #rrggbb colour "
                             f"or an OPCD palette name ({names})")
        extra[kind] = value.lower()
    return extra


# The app's group order (server D28, shared/render/stack-key.ts): the Roughs
# layer under every hole, the holes by number, course-level features above
# them, and the roads (ROADS_TYPES, whatever their hole) on top of it all.
ROUGHS_LAYER = "roughs"
COURSE_GROUP_RANK = 1023
ROADS_TYPES = ("path",)
ROADS_GROUP_RANK = COURSE_GROUP_RANK + 1


def _group_rank_sql(conn: sqlite3.Connection) -> str:
    """SQL for a feature's group rank (aliases f = course_features, h = holes).
    A database from before the server's `layer` migration has no Roughs."""
    has_layer = any(r[1] == "layer" for r in conn.execute("PRAGMA table_info(course_features)"))
    roads = ", ".join(f"'{t}'" for t in ROADS_TYPES)
    roughs = f"WHEN f.layer = '{ROUGHS_LAYER}' THEN 0 " if has_layer else ""
    return (f"CASE WHEN f.type IN ({roads}) THEN {ROADS_GROUP_RANK} {roughs}"
            f"ELSE COALESCE(h.number, {COURSE_GROUP_RANK}) END")


def _load_course_features(db_path: Path, course_ident: str, stack: str) -> tuple[sqlite3.Row, list[sqlite3.Row]]:
    """A course and its features (id, type, geometry_json, sort_order,
    hole_number, group_rank) in paint order: the app's own, or with `stack`
    "opcd" the green/tee/bunker lift inside each group (see TOP_TYPES)."""
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rank = _group_rank_sql(conn)
    # Provenance, for the SVG's exclusions (a road's kerb fillets go with it).
    # A database from before the server's provenance migration has neither.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(course_features)")}
    source = "f.source" if "source" in cols else "NULL"
    source_ref = "f.source_ref" if "source_ref" in cols else "NULL"
    attributes = "f.attributes_json" if "attributes_json" in cols else "NULL"
    rows = conn.execute(
        f"""SELECT f.id, f.type, f.geometry_json, f.sort_order, h.number AS hole_number,
                   {rank} AS group_rank, {source} AS source, {source_ref} AS source_ref,
                   {attributes} AS attributes_json
           FROM course_features f LEFT JOIN holes h ON h.id = f.hole_id
           WHERE f.course_id = ?
           ORDER BY group_rank, f.sort_order, f.id""",
        (course["id"],),
    ).fetchall()
    conn.close()
    if not rows:
        raise SystemExit(f"error: course {course['name']} ({course['id']}) has no features")
    if stack == "opcd":
        # Stable sort, so inside each layer the app's order survives: non-top
        # types first as they are, then green/tee/bunker as they are. The group
        # key keeps the lift from reaching across layers.
        rows = sorted(rows, key=lambda r: (r["group_rank"], r["type"] in TOP_TYPES))
    return course, rows


# --- Terrain tint -----------------------------------------------------------
# The Photoshop step OPCD builders do by hand on the terrain texture: the
# Inkscape SVG's shapes become selections, and a dark-green layer goes
# over the turf (DEFAULT_TINT_OPACITY) so it reads as turf under Unity's lighting
# instead of as a bleached photo. The app's drawn features are those same
# shapes, so this is that layer computed: the grass types get the tint,
# bunkers and paths are painted with opacity 0 in the same stacking order
# the SVG uses, so a bunker cut into a fairway keeps the photo's own sand,
# and water bodies get their own darker, browner layer on top with a wide
# feather so the shoreline fades into the green instead of cutting it.
# Ground that isn't drawn gets the same layer (TINT_GROUND, overridable like
# a type: `--tint ground=@0.3`, `--tint ground=none`): the colourists put
# the WHOLE photo at 50 % over the green fill, so roads, trees and undrawn
# rough are muted along with the turf and the drawn shapes don't stand out
# as green patches on a photo.
# The colour is the fill layer of cooke23's Sat_Shader_Preset PSD: a light
# olive. A bluer, more saturated green reads as paint next to the photo.
# It is a sun-lit colour and goes over the darkened photo as it is, which
# lifts the file — right for the course meshes; `--darken-tint` darkens it
# along with the photo instead (see `_darken_tints`), for the outer terrain.
DEFAULT_TINT_COLOR = "#4c5f30"
# 0.5 = the photo at 50 % over a flat green, which is how the GSPro colourists
# set it up: it looks very green as a file, but under Unity's lighting the
# photo is left as a hint of variation instead of a recognisable satellite.
DEFAULT_TINT_OPACITY = 0.5
# The photo's fine detail (mower stripes, shadows, worn patches) is what
# reads as "a satellite on the floor" in game; the grass shaders supply the
# close-up detail there. So the tinted twin is softened first: detail finer
# than this many metres on the ground goes, as if the photo had been sampled
# at that texel size and scaled back up (1 m = a 2048 px texture of a 2 km
# square; Gaussian, sigma = half of it). Surfaces the tint masks off —
# bunkers, paths — keep the sharp photo, so sand edges stay crisp.
DEFAULT_SOFTEN_M = 1.0
# The tinted twin is written at this edge (or the render's, when smaller):
# after the soften there is nothing in it that 8192 px would still carry.
DEFAULT_TINT_SIZE = 4096
TINT_TYPES = ("fairway", "green", "tee", "semi_rough", "rough", "deep_rough")
TINT_MASK_TYPES = ("bunker", "path")
TINT_GROUND = "ground"
# Water: a separate layer composited over the grass result. Its mask is
# feathered by DEFAULT_WATER_FEATHER_M metres (converted to pixels at render
# time) so the tint runs from the water colour to whatever is beneath —
# the green tint on a fairway, the plain photo elsewhere — over that
# distance, symmetric about the drawn edge.
TINT_WATER_TYPES = ("water", "water_creek")
DEFAULT_WATER_COLOR = "#4a3d22"
DEFAULT_WATER_OPACITY = 0.4
DEFAULT_WATER_FEATHER_M = 4.0
# Curve flattening tolerance and mask feather, both in texture pixels
# (0.25 m at 8192 px over 2 km): a hard 1 px stair-step would show as a
# seam on the terrain up close.
TINT_FLATTEN_PX = 0.25
TINT_FEATHER_PX = 1.0
# Rows per numpy blend chunk: the 8192² texture is 200 MB as bytes and
# would be 800 MB as float32 in one go.
TINT_CHUNK_ROWS = 512

Rgb = tuple[int, int, int]
# (colour, opacity 0..1) — opacity 0 means "mask the tint off here".
Tint = tuple[Rgb, float]


class TintJob:
    """Everything `_render_ortho` needs to tint the terrain twin: where the
    file goes and the course's features + per-type tints, loaded once."""

    def __init__(self, out: Path, course_name: str, rows: list, tints: dict[str, Tint],
                 water_feather_m: float = DEFAULT_WATER_FEATHER_M, soften_m: float = DEFAULT_SOFTEN_M,
                 size: int | None = None, darken_tint: bool = False,
                 grade: "tuple[float, float, float] | None" = None):
        self.out, self.course_name, self.rows, self.tints = out, course_name, rows, tints
        self.water_feather_m, self.soften_m, self.size = water_feather_m, soften_m, size
        self.darken_tint, self.grade = darken_tint, grade


def _parse_hex(text: str, what: str) -> Rgb:
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", text):
        raise SystemExit(f"error: {what}: {text!r} is not a #rrggbb colour")
    return (int(text[1:3], 16), int(text[3:5], 16), int(text[5:7], 16))


def _parse_tints(pairs: list[str] | None, color: str = DEFAULT_TINT_COLOR,
                 opacity: float = DEFAULT_TINT_OPACITY, water_color: str = DEFAULT_WATER_COLOR,
                 water_opacity: float = DEFAULT_WATER_OPACITY) -> dict[str, Tint]:
    """The per-type tint table: TINT_TYPES at (`color`, `opacity`),
    TINT_MASK_TYPES at opacity 0, TINT_WATER_TYPES at (`water_color`,
    `water_opacity`), then each `--tint TYPE=SPEC` on top where SPEC is
    `#rrggbb`, `@OPACITY`, `#rrggbb@OPACITY` or `none` (mask it off). A
    type not in the table (trees, oob …) is ignored entirely."""
    if not 0 <= opacity <= 1:
        raise SystemExit("error: --tint-opacity must be in [0, 1]")
    if not 0 <= water_opacity <= 1:
        raise SystemExit("error: --water-opacity must be in [0, 1]")
    base = _parse_hex(color, "--tint-color")
    water = _parse_hex(water_color, "--water-color")
    tints: dict[str, Tint] = {t: (base, opacity) for t in TINT_TYPES}
    tints.update({t: (base, 0.0) for t in TINT_MASK_TYPES})
    tints[TINT_GROUND] = (base, opacity)
    tints.update({t: (water, water_opacity) for t in TINT_WATER_TYPES})
    for pair in pairs or []:
        kind, _, spec = pair.partition("=")
        kind, spec = kind.strip(), spec.strip()
        if not kind or not spec:
            raise SystemExit(f"error: --tint wants TYPE=#rrggbb[@OPACITY], TYPE=@OPACITY or TYPE=none, got {pair!r}")
        rgb, a = tints.get(kind, (base, opacity))
        if spec.lower() == "none":
            a = 0.0
        else:
            hexpart, _, apart = spec.partition("@")
            if hexpart:
                rgb = _parse_hex(hexpart, f"--tint {pair!r}")
            if apart:
                try:
                    a = float(apart)
                except ValueError:
                    raise SystemExit(f"error: --tint {pair!r}: {apart!r} is not an opacity") from None
                if not 0 <= a <= 1:
                    raise SystemExit(f"error: --tint {pair!r}: opacity must be in [0, 1]")
        tints[kind] = (rgb, a)
    return tints


def _ring_px(ring: dict, curve_type: str, to_px, tol_px: float) -> list[Pt]:
    """One ring as a closed polyline in texture pixels: the same bezier
    expansion the SVG gets, flattened within `tol_px` (the map from metres
    to pixels is affine, so the curve is flattened after mapping)."""
    anchors = _ring_anchors(ring, curve_type)
    if len(anchors) < 3:
        return []
    px = [{"p": to_px(a["p"]), "hin": to_px(a["hin"]), "hout": to_px(a["hout"])} for a in anchors]
    poly: list[Pt] = [px[0]["p"]]
    n = len(px)
    for i in range(n):
        a, b = px[i], px[(i + 1) % n]
        _flatten_cubic(a["p"], a["hout"], b["hin"], b["p"], tol_px, poly)
    poly.pop()  # back at the start
    return poly


def _paint_layer(rows: list, tints: dict[str, Tint], extent: Extent, size: int,
                 stats: dict[str, dict[str, int]]) -> tuple[Image.Image, Image.Image, Image.Image]:
    """Paint `rows` in order over the square into a coverage mask (L, 255
    where a feature is), an opacity plate (L, that feature's opacity) and a
    colour plate (RGB): later features overwrite earlier ones, exactly as
    the SVG stacks them. Multi-ring features are even-odd, like the SVG's.
    The plates start out in the layer's first colour/opacity so a feather
    on the coverage never bleeds black or nothing. Counts go into `stats`
    (`tinted`, `masked`, `water`)."""
    e0, n0, e1, n1 = extent
    scale = size / (e1 - e0)

    def to_px(xy: Pt) -> Pt:
        return ((xy[0] - e0) * scale, (n1 - xy[1]) * scale)

    specs = [tints[r["type"]] for r in rows if tints.get(r["type"]) is not None]
    default_rgb, default_a = next(((rgb, a) for rgb, a in specs if a > 0), ((0, 0, 0), 0.0))
    coverage = Image.new("L", (size, size), 0)
    opacity = Image.new("L", (size, size), int(round(default_a * 255)))
    plate = Image.new("RGB", (size, size), default_rgb)
    draw_cov, draw_op, draw_c = ImageDraw.Draw(coverage), ImageDraw.Draw(opacity), ImageDraw.Draw(plate)
    for row in rows:
        kind = row["type"]
        rgb, a = tints[kind]
        geom = json.loads(row["geometry_json"])
        curve_type = geom.get("curveType") or "bezier"
        polys = [p for p in (_ring_px(r, curve_type, to_px, TINT_FLATTEN_PX) for r in geom.get("rings") or [])
                 if len(p) >= 3]
        if not polys:
            continue
        value = int(round(a * 255))
        if len(polys) == 1:
            draw_cov.polygon(polys[0], fill=255)
            draw_op.polygon(polys[0], fill=value)
            draw_c.polygon(polys[0], fill=rgb)
        else:
            xs = [x for p in polys for x, _ in p]
            ys = [y for p in polys for _, y in p]
            x0, y0 = max(0, math.floor(min(xs)) - 1), max(0, math.floor(min(ys)) - 1)
            x1, y1 = min(size, math.ceil(max(xs)) + 2), min(size, math.ceil(max(ys)) + 2)
            if x1 <= x0 or y1 <= y0:
                continue
            acc = np.zeros((y1 - y0, x1 - x0), dtype=bool)
            for poly in polys:
                m = Image.new("L", (x1 - x0, y1 - y0), 0)
                ImageDraw.Draw(m).polygon([(x - x0, y - y0) for x, y in poly], fill=255)
                acc ^= np.asarray(m, dtype=bool)
            mask = Image.fromarray(acc.astype(np.uint8) * 255)
            coverage.paste(255, (x0, y0, x1, y1), mask)
            opacity.paste(value, (x0, y0, x1, y1), mask)
            plate.paste(rgb, (x0, y0, x1, y1), mask)
        bucket = "water" if kind in TINT_WATER_TYPES else "tinted" if a > 0 else "masked"
        stats[bucket][kind] = stats[bucket].get(kind, 0) + 1
    return coverage, opacity, plate


def _render_tint_masks(rows: list, tints: dict[str, Tint], extent: Extent, size: int,
                       feather_px: float = TINT_FEATHER_PX) -> tuple[Image.Image, Image.Image, Image.Image, dict]:
    """The grass layer: every non-water feature painted in order into an
    opacity mask (L) and a colour plate (RGB), plus a keep-sharp mask (L,
    255 where a masked-off type — bunker, path — is on top), the masks
    feathered by `feather_px` afterwards. Types not in `tints` are counted
    as ignored."""
    stats: dict[str, dict[str, int]] = {"tinted": {}, "masked": {}, "water": {}, "ignored": {}}
    ground = []
    for row in rows:
        kind = row["type"]
        if kind not in tints:
            stats["ignored"][kind] = stats["ignored"].get(kind, 0) + 1
        elif kind not in TINT_WATER_TYPES:
            ground.append(row)
    coverage, opacity, plate = _paint_layer(ground, tints, extent, size, stats)
    alpha = ImageChops.multiply(coverage, opacity)
    sharp = ImageChops.multiply(coverage, opacity.point(lambda v: 255 if v == 0 else 0))
    ground_rgb, ground_a = tints.get(TINT_GROUND) or ((0, 0, 0), 0.0)
    if ground_a > 0:
        alpha = Image.composite(alpha, Image.new("L", alpha.size, int(round(ground_a * 255))), coverage)
        plate = Image.composite(plate, Image.new("RGB", plate.size, ground_rgb), coverage)
    if feather_px > 0:
        alpha = alpha.filter(ImageFilter.BoxBlur(feather_px))
        sharp = sharp.filter(ImageFilter.BoxBlur(feather_px))
    return alpha, plate, sharp, stats


def _render_water_masks(rows: list, tints: dict[str, Tint], extent: Extent, size: int,
                        feather_m: float, stats: dict) -> tuple[Image.Image, Image.Image, Image.Image] | None:
    """The water layer: coverage feathered by `feather_m` metres (so the
    fade is a distance on the ground, not a pixel count), plus the opacity
    and colour plates. None when the course has no water."""
    water = [r for r in rows if r["type"] in TINT_WATER_TYPES and r["type"] in tints]
    if not water:
        return None
    coverage, opacity, plate = _paint_layer(water, tints, extent, size, stats)
    feather_px = feather_m * size / (extent[2] - extent[0])
    if feather_px > 0:
        coverage = coverage.filter(ImageFilter.BoxBlur(feather_px))
    return coverage, opacity, plate


def _tint_terrain(hwc: np.ndarray, extent: Extent, rows: list, tints: dict[str, Tint],
                  water_feather_m: float = DEFAULT_WATER_FEATHER_M,
                  soften_m: float = 0.0) -> tuple[np.ndarray, str]:
    """The darkened terrain render, softened by `soften_m` everywhere but on
    the masked-off surfaces (see DEFAULT_SOFTEN_M), with the grass tint
    composited on top (normal blend in sRGB, what the Photoshop layer does)
    and the water layer over that: inside a water body the photo takes the
    water tint instead of the green; across the feathered shoreline the
    result runs from one to the other. Chunked by rows."""
    size = hwc.shape[0]
    alpha, plate, sharp, stats = _render_tint_masks(rows, tints, extent, size)
    a_all = np.asarray(alpha)
    sigma_px = soften_m / 2.0 * size / (extent[2] - extent[0])
    soft_all = np.asarray(Image.fromarray(hwc).filter(ImageFilter.GaussianBlur(sigma_px))) if sigma_px > 0 else None
    k_all = np.asarray(sharp)
    c_all = np.asarray(plate)
    water = _render_water_masks(rows, tints, extent, size, water_feather_m, stats)
    if water is not None:
        wcov_all, wop_all, wc_all = (np.asarray(im) for im in water)
    out = np.empty_like(hwc)
    for y in range(0, size, TINT_CHUNK_ROWS):
        sl = slice(y, y + TINT_CHUNK_ROWS)
        base = hwc[sl].astype(np.float32)
        if soft_all is not None:
            keep = k_all[sl].astype(np.float32)[..., None] / 255.0
            base = base * keep + soft_all[sl] * (1.0 - keep)
        a = a_all[sl].astype(np.float32)[..., None] / 255.0
        mixed = base * (1.0 - a) + c_all[sl] * a
        if water is not None:
            wcov = wcov_all[sl].astype(np.float32)[..., None] / 255.0
            wop = wop_all[sl].astype(np.float32)[..., None] / 255.0
            wet = base * (1.0 - wop) + wc_all[sl] * wop
            mixed = mixed * (1.0 - wcov) + wet * wcov
        out[sl] = np.round(mixed).clip(0, 255).astype(np.uint8)

    def counts(d: dict) -> str:
        return ", ".join(f"{k} {v}" for k, v in sorted(d.items(), key=lambda kv: -kv[1])) or "none"

    def layer_list(bucket: str) -> str:
        used = sorted(((kind, rgb, a) for kind, (rgb, a) in tints.items() if a > 0 and kind in stats[bucket]),
                      key=lambda t: t[0])
        return "; ".join(f"{kind} #{r:02x}{g:02x}{b:02x} {a * 100:g}%" for kind, (r, g, b), a in used) or "nothing"

    summary = (f"tinted {counts(stats['tinted'])}; masked off {counts(stats['masked'])}"
               + (f"; ignored {counts(stats['ignored'])}" if stats["ignored"] else "")
               + f"; layers {layer_list('tinted')}; feather {TINT_FEATHER_PX:g} px"
               + (f"; softened to {soften_m:g} m outside the masked surfaces" if sigma_px > 0 else "; not softened")
               + ("; undrawn ground #{:02x}{:02x}{:02x} {:g}%".format(*tints[TINT_GROUND][0], tints[TINT_GROUND][1] * 100)
                  if (tints.get(TINT_GROUND) or (None, 0))[1] > 0 else "; undrawn ground untinted")
               + (f"; water {counts(stats['water'])} as {layer_list('water')}, shoreline fade {water_feather_m:g} m"
                  if water is not None else "; no water"))
    return out, summary


# Roads are written merged: every road, drawn path, kerb fillet and width
# taper of one fill that touch become ONE shape. Blender cuts each SVG shape
# on its own, so pieces that merely abut leave hairline slivers between them,
# and pieces that don't quite meet leave gaps. Slits and notches narrower
# than twice ROADS_CLOSE_M are closed, hairline spurs thinner than twice
# ROADS_OPEN_M dropped and holes smaller than ROADS_MIN_HOLE_M2 filled.
# Road curves are flattened within ROADS_FLATTEN_M (or --flatten).
ROADS_FLATTEN_M = 0.02
ROADS_CLOSE_M = 0.3
ROADS_OPEN_M = 0.1
ROADS_MIN_HOLE_M2 = 4.0
# Slivers between a road and the surface drawn beside it (a rough stopping
# just short of the kerb, or meeting it at a slant) narrower than twice
# ROAD_EDGE_GAP_M go to that surface — the one of ROAD_EDGE_FILL_TYPES
# sharing the longest edge with the sliver — which is then written
# flattened. Greens, tees, bunkers and water are never grown.
ROAD_EDGE_GAP_M = 0.5
ROAD_EDGE_FILL_TYPES = ("rough", "semi_rough", "deep_rough", "fairway", "trees")
# Slivers smaller than this are clipper dust, not gaps (m²).
ROAD_GAP_MIN_M2 = 1e-4
# How far a filled sliver reaches into what it fills (m): no hairline seam.
ROAD_GAP_OVERLAP_M = 0.02
# A "sliver" thinner than this on average (area / length, m) is rounding left by
# the closing along a road edge, not a gap: filled (and widened by the overlap)
# it becomes a needle along the kerb, metres long and centimetres wide.
ROAD_GAP_MIN_WIDTH_M = 0.01
# A sliver whose outline is open for more than this (m) - not bounded by the
# road and surfaces all round - is the tip of a wedge where a surface edge
# leaves the road at a slant. The closing ends it with a slanted line that runs
# along the kerb into a spike (and leaves a notch beside it); the fill is cut
# square to the road instead, where it leaves the surface.
ROAD_GAP_OPEN_M = 0.05


@dataclass
class MergedRoad:
    kind: str
    fill: str
    shape: object  # shapely Polygon
    ids: list[str]


def _feature_shape(geom: dict, tol: float):
    """A feature's rings flattened within `tol` metres as one valid shapely
    geometry in EPSG:3006 (outer ring plus holes, as the SVG's even-odd
    draws them), or None."""
    from shapely import make_valid
    from shapely.geometry import Polygon

    curve_type = geom.get("curveType") or "bezier"
    rings: list[list[Pt]] = []
    for ring in geom.get("rings") or []:
        anchors = _ring_anchors(ring, curve_type)
        if len(anchors) < 3:
            continue
        pts: list[Pt] = [anchors[0]["p"]]
        for i in range(len(anchors)):
            a, b = anchors[i], anchors[(i + 1) % len(anchors)]
            _flatten_cubic(a["p"], a["hout"], b["hin"], b["p"], tol, pts)
        rings.append(pts)
    if not rings:
        return None
    shape = make_valid(Polygon(rings[0], rings[1:]))
    return shape if not shape.is_empty and shape.area > 0 else None


def _polygons(shape) -> list:
    """The polygons of a shapely geometry (collections flattened)."""
    if shape is None or shape.is_empty:
        return []
    if shape.geom_type == "Polygon":
        return [shape]
    return [p for g in getattr(shape, "geoms", []) for p in _polygons(g)]


def _shape_subpaths(shape, to_svg, precision: int) -> list[str]:
    """SVG subpaths (straight segments) for every ring of a shapely shape."""
    out = []
    for poly in _polygons(shape):
        for ring in (poly.exterior, *poly.interiors):
            pts = list(ring.coords)[:-1]
            if len(pts) >= 3:
                out.append(_path_d([{"p": p, "hin": p, "hout": p} for p in pts], to_svg, precision, 0.0))
    return out


def _anchors_inside(anchor_rings: list[list[dict]], extent: Extent) -> bool:
    """True when every bezier point and handle lies in the square — and so,
    by the convex hull property, every curve drawn through them."""
    e0, n0, e1, n1 = extent
    return all(e0 <= x <= e1 and n0 <= y <= n1
               for ring in anchor_rings for a in ring for x, y in (a["p"], a["hin"], a["hout"]))


def _clip_to_square(shape, extent: Extent):
    """`shape` cut to the square, or None when nothing of it is left."""
    from shapely.geometry import MultiPolygon, box

    polys = _polygons(shape.intersection(box(*extent)))
    if not polys:
        return None
    return polys[0] if len(polys) == 1 else MultiPolygon(polys)


def _merged_roads(rows: list, fills: dict[str, str], tol: float) -> tuple[list[MergedRoad], str]:
    """The road features (ROADS_TYPES) merged into clean shapes per type (see
    ROADS_CLOSE_M), in the paint order of each shape's first feature, and a
    note on what the merge did ("" when there are no roads)."""
    from shapely import unary_union
    from shapely.geometry import Polygon

    pieces: dict[str, list[tuple[str, object]]] = {}
    for row in rows:
        kind = row["type"]
        if kind not in ROADS_TYPES or not fills.get(kind):
            continue
        shape = _feature_shape(json.loads(row["geometry_json"]), tol)
        if shape is not None:
            pieces.setdefault(kind, []).append((row["id"], shape))

    out: list[tuple[int, MergedRoad]] = []
    merged = 0
    for kind, items in pieces.items():
        order = {fid: i for i, (fid, _) in enumerate(items)}
        raw = unary_union([s for _, s in items])
        # Closing fills slits and notches, opening drops hairline spurs.
        clean = (raw.buffer(ROADS_CLOSE_M, quad_segs=4)
                 .buffer(-ROADS_CLOSE_M - ROADS_OPEN_M, quad_segs=4)
                 .buffer(ROADS_OPEN_M, quad_segs=4))
        clean = clean.simplify(tol / 2)
        for poly in _polygons(clean):
            poly = Polygon(poly.exterior, [h for h in poly.interiors if Polygon(h).area >= ROADS_MIN_HOLE_M2])
            ids = sorted((fid for fid, s in items if s.intersects(poly)), key=order.get)
            if not ids:
                continue
            out.append((order[ids[0]], MergedRoad(kind, fills[kind], poly, ids)))
            merged += len(ids)
    out.sort(key=lambda t: t[0])
    roads = [r for _, r in out]
    if not roads:
        return [], ""
    return roads, (f"{merged} road piece(s) merged into {len(roads)} shape(s), slits and gaps "
                   f"under {2 * ROADS_CLOSE_M:g} m closed")


def _road_edge_fills(rows: list, fills: dict[str, str], roads: list[MergedRoad],
                     tol: float) -> tuple[dict[str, object], int]:
    """Features grown over the slivers between them and a road (see
    ROAD_EDGE_GAP_M): {feature id: its flattened shape plus the slivers}, and
    how many slivers were filled."""
    from shapely import STRtree, unary_union

    if not roads:
        return {}, 0
    road = unary_union([r.shape for r in roads])
    reach = road.buffer(2 * ROAD_EDGE_GAP_M + 0.5)
    near: list[tuple[str, str, object]] = []
    for row in rows:
        kind = row["type"]
        if kind in ROADS_TYPES or not fills.get(kind):
            continue
        shape = _feature_shape(json.loads(row["geometry_json"]), tol)
        if shape is not None and shape.intersects(reach):
            near.append((row["id"], kind, shape))
    if not near:
        return {}, 0

    around = unary_union([road] + [s for _, _, s in near])
    closed = (around.buffer(ROAD_EDGE_GAP_M, join_style="mitre")
              .buffer(-ROAD_EDGE_GAP_M, join_style="mitre"))
    solid = around.buffer(1e-3)
    gaps = [g for g in _polygons(closed.difference(around).intersection(reach))
            if g.area >= ROAD_GAP_MIN_M2 and g.distance(road) < 1e-3
            and g.area / max(g.length / 2, 1e-9) >= ROAD_GAP_MIN_WIDTH_M]
    gaps = [sq for g in gaps for sq in _polygons(_square_off_wedge(g, road, solid))]
    candidates = [(fid, s) for fid, kind, s in near if kind in ROAD_EDGE_FILL_TYPES]
    tree = STRtree([s for _, s in candidates])
    extra: dict[str, list] = {}
    for gap in gaps:
        edge = gap.buffer(0.01)
        best, best_len = None, 0.0
        for i in tree.query(edge):
            fid, shape = candidates[int(i)]
            shared = edge.intersection(shape.boundary).length
            if shared > best_len:
                best, best_len = fid, shared
        if best is not None:
            extra.setdefault(best, []).append(gap.buffer(ROAD_GAP_OVERLAP_M, join_style="mitre"))
    shapes = dict((fid, s) for fid, s in candidates)
    grown = {fid: unary_union([shapes[fid], *more]).simplify(tol / 2) for fid, more in extra.items()}
    return grown, sum(len(v) for v in extra.values())


def _square_off_wedge(gap, road, solid):
    """A road-edge sliver with each open end (see ROAD_GAP_OPEN_M) cut square to
    the road where it leaves the surface. An end already square, or one that is
    not a line from the road to a surface, stays as it is."""
    from shapely import unary_union
    from shapely.geometry import LineString, Point
    from shapely.ops import linemerge, nearest_points, split

    open_part = gap.boundary.difference(solid)
    if open_part.length <= ROAD_GAP_OPEN_M:
        return gap
    merged = linemerge(open_part) if open_part.geom_type == "MultiLineString" else open_part
    ends = [g for g in getattr(merged, "geoms", [merged]) if g.geom_type == "LineString" and g.length > ROAD_GAP_OPEN_M]
    shape = gap
    for end in ends:
        pa, pb = Point(end.coords[0]), Point(end.coords[-1])
        near_a, near_b = road.distance(pa) < 2e-3, road.distance(pb) < 2e-3
        if near_a == near_b:
            continue
        tip, off = (pa, pb) if near_a else (pb, pa)  # the end's point on the kerb; where it leaves the surface
        foot = nearest_points(road.boundary, off)[0]
        dx, dy = foot.x - off.x, foot.y - off.y
        length = (dx * dx + dy * dy) ** 0.5
        if length < 1e-6 or foot.distance(tip) < 0.05:  # already square
            continue
        reach = gap.length + 1.0
        cut = LineString([(off.x - dx / length * reach, off.y - dy / length * reach),
                          (foot.x + dx / length * reach, foot.y + dy / length * reach)])
        kept = [piece for piece in _polygons(split(shape, cut)) if piece.distance(tip) > 1e-3]
        if kept:
            shape = unary_union(kept)
    return shape


# How far (m) a shape may sit past the square's edge and still count as
# inside it: float noise on a shape snapped to the edge, not an overhang.
SQUARE_EDGE_SLACK_M = 1e-6

# Generated kerb fillets / width tapers where centerline roads meet (the
# server's `road-junctions` source); `source_ref` lists the roads' ids.
ROAD_JUNCTIONS_SOURCE = "road-junctions"


def _read_exclude_ids(path: Path | None) -> set[str]:
    """Feature ids from an `--exclude-ids` file: a JSON array of strings, or
    one id per line (blank lines and `#` comments ignored)."""
    if path is None:
        return set()
    text = path.read_text(encoding="utf-8").strip()
    if text.startswith("["):
        ids = json.loads(text)
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise SystemExit(f"error: {path} must be a JSON array of feature id strings")
        return {i.strip() for i in ids if i.strip()}
    return {line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")}


# A path with the attribute surface=bridge is a bridge deck: a prop placed in
# Unity, kept as a course feature only so the vegetation zones leave room for
# it. It is not ground: in the SVG it would become a path mesh lying across the
# creek or lake under it, which breaks the OPCD Blender build.
BRIDGE_SURFACE = "bridge"


def _is_bridge_deck(row) -> bool:
    raw = row["attributes_json"] if "attributes_json" in row.keys() else None
    if not raw:
        return False
    try:
        return json.loads(raw).get("surface") == BRIDGE_SURFACE
    except (ValueError, AttributeError):
        return False


# A surface smaller than this is a slip of the pen (a click or a drag that
# collapsed while drawing), not a feature: OPCD cannot build a mesh and blend
# from it and the whole Blender build fails. Roads are exempt - their kerb
# fillets are small on purpose and merge into the road shapes.
MIN_SHAPE_AREA_M2 = 1.0


def _tiny_rows(rows: list, tol: float, fills: dict[str, str]) -> list:
    """Drawn, non-road features whose shape is under MIN_SHAPE_AREA_M2 (or empty)."""
    tiny = []
    for r in rows:
        if r["type"] in ROADS_TYPES or r["type"] not in fills:
            continue
        shape = _feature_shape(json.loads(r["geometry_json"]), tol)
        if shape is None or shape.area < MIN_SHAPE_AREA_M2:
            tiny.append(r)
    return tiny


def _exclude_rows(rows: list, ids: set[str], types: set[str]) -> tuple[list, dict[str, int], list[str]]:
    """`rows` without the excluded features: those whose id is in `ids`,
    those of a type in `types`, and the road-junction fillets of an excluded
    road (they would be left as orphan patches). Also the excluded count per
    type, and the ids that named no feature of the course."""
    if not ids and not types:
        return rows, {}, []
    dropped = {r["id"] for r in rows if r["id"] in ids or r["type"] in types}
    kept, counts = [], {}
    for r in rows:
        refs = set((r["source_ref"] or "").split(",")) if r["source"] == ROAD_JUNCTIONS_SOURCE else set()
        if r["id"] in dropped or refs & dropped:
            counts[r["type"]] = counts.get(r["type"], 0) + 1
        else:
            kept.append(r)
    known = {r["id"] for r in rows}
    return kept, counts, sorted(ids - known)


def cmd_svg(bbox, out: Path, db_path: Path, course_ident: str,
            flatten: float | None, precision: int, mapped: dict[str, str],
            stack: str = "opcd", extent: Extent | None = None,
            exclude_ids: set[str] | None = None, exclude_types: set[str] | None = None) -> None:
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    fills = {**GSPRO_FILLS, **mapped}

    # EPSG:3006 metres -> SVG user units (also metres). SVG is y-DOWN, so the
    # viewBox top edge is the NORTH bound. Same square extent the ortho and
    # hillshade commands render, so this drops straight on top of them.
    def to_svg(xy: Pt) -> Pt:
        return (xy[0] - e0, n1 - xy[1])

    from shapely.geometry import box

    course, rows = _load_course_features(db_path, course_ident, stack)
    # Bridge decks are props, not ground (with their kerb fillets, like any excluded road).
    rows, decks, _ = _exclude_rows(rows, {r["id"] for r in rows if _is_bridge_deck(r)}, set())
    rows, excluded, unknown_ids = _exclude_rows(rows, exclude_ids or set(), exclude_types or set())
    # A hair of slack: shapes drawn to the edge and snapped there are inside.
    square = box(e0, n0, e1, n1).buffer(SQUARE_EDGE_SLACK_M, join_style="mitre")
    tol = flatten if flatten is not None else ROADS_FLATTEN_M
    tiny = _tiny_rows(rows, tol, fills)
    tiny_ids = {r["id"] for r in tiny}
    rows = [r for r in rows if r["id"] not in tiny_ids]
    roads, road_notes = _merged_roads(rows, fills, tol)
    grown, grown_gaps = _road_edge_fills(rows, fills, roads, tol)

    # One Inkscape layer per hole (Hole1…, the unpadded spelling every OPCD
    # course file here uses) plus 'Others' for features not tied to a hole
    # and 'Roads' for the roads and paths, on or off a hole.

    # Shapes are named hole_<hole>_<index on hole> (others_<index> off-hole).
    # The mesh keeps the material from the fill, so the name only has to say
    # which hole it came from and stay unique.
    layers: dict[str, list[str]] = {}
    counts: dict[str, int] = {}
    written: dict[str, int] = {}
    skipped: dict[str, int] = {}
    # Nothing may reach past the terrain square: Blender cuts the meshes out
    # of the terrain, and a shape overhanging its edge breaks the build. A
    # shape that does is cut to the square (and written flattened); one
    # wholly outside is dropped.
    clipped: dict[str, int] = {}
    dropped_outside: dict[str, int] = {}
    for road in roads:
        if not road.shape.within(square):
            road.shape = _clip_to_square(road.shape, extent)
            clipped[road.kind] = clipped.get(road.kind, 0) + 1
    for road in [r for r in roads if r.shape is None]:
        dropped_outside[road.kind] = dropped_outside.get(road.kind, 0) + 1
    roads = [r for r in roads if r.shape is not None]
    for row in rows:
        kind = row["type"]
        fill = fills.get(kind)
        if not fill:
            skipped[kind] = skipped.get(kind, 0) + 1
            continue

        geom = json.loads(row["geometry_json"])
        curve_type = geom.get("curveType") or "bezier"
        rings = geom.get("rings") or []
        if kind in ROADS_TYPES:
            # Written merged, after the loop (see _merged_roads).
            if any(row["id"] in r.ids for r in roads):
                written[kind] = written.get(kind, 0) + 1
            continue
        anchor_rings = [_ring_anchors(r, curve_type) for r in rings]
        # A shape (flattened) replaces the curves only when it has to: grown
        # over a road sliver, or really overhanging the square — a control
        # point outside need not mean the curve is.
        shape = grown.get(row["id"])
        if shape is None and not _anchors_inside(anchor_rings, extent):
            whole = _feature_shape(geom, tol)
            if whole is not None and not whole.within(square):
                shape = whole
        if shape is None:
            subpaths = [d for d in (_path_d(a, to_svg, precision, flatten) for a in anchor_rings) if d]
        else:
            if not shape.within(square):
                clipped[kind] = clipped.get(kind, 0) + 1
                shape = _clip_to_square(shape, extent)
                if shape is None:
                    dropped_outside[kind] = dropped_outside.get(kind, 0) + 1
                    continue
            subpaths = _shape_subpaths(shape, to_svg, precision)
        if not subpaths:
            continue

        if row["hole_number"] is not None:
            layer, stem = f"Hole{row['hole_number']}", f"hole_{row['hole_number']}"
        else:
            layer, stem = COURSE_WIDE_LAYER, "others"
        counts[stem] = counts.get(stem, 0) + 1
        name = f"{stem}_{counts[stem]}"
        written[kind] = written.get(kind, 0) + 1
        # Several rings on one feature = outer ring plus holes; even-odd makes
        # the inner rings punch through.
        rule = ' fill-rule="evenodd"' if len(subpaths) > 1 else ""
        layers.setdefault(layer, []).append(
            f'    <path id="{name}" inkscape:label="{name}" data-type="{kind}"'
            f' data-feature-id="{row["id"]}"'
            f' style="{PATH_STYLE.format(fill=fill)}"{rule} d="{" ".join(subpaths)}"/>'
        )
    for i, road in enumerate(roads, start=1):
        subpaths = _shape_subpaths(road.shape, to_svg, precision)
        rule = ' fill-rule="evenodd"' if len(subpaths) > 1 else ""
        layers.setdefault(ROADS_LAYER, []).append(
            f'    <path id="roads_{i}" inkscape:label="roads_{i}" data-type="{road.kind}"'
            f' data-feature-id="{" ".join(road.ids)}"'
            f' style="{PATH_STYLE.format(fill=road.fill)}"{rule} d="{" ".join(subpaths)}"/>'
        )

    # Document order matches the OPCD files: the off-hole layer at the bottom,
    # then the holes descending so Hole1 ends up topmost in Inkscape, and the
    # roads over everything.
    order = sorted((k for k in layers if k.startswith("Hole")), key=lambda k: -int(k[4:]))
    if COURSE_WIDE_LAYER in layers:
        order.insert(0, COURSE_WIDE_LAYER)
    if ROADS_LAYER in layers:
        order.append(ROADS_LAYER)

    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        '<svg xmlns="http://www.w3.org/2000/svg"',
        '     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
        '     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"',
        f'     width="{side:.3f}mm" height="{side:.3f}mm" viewBox="0 0 {side:.3f} {side:.3f}"',
        '     version="1.1">',
        f'  <title>{course["name"]}</title>',
        f'  <desc>golf-map course features. CRS EPSG:3006; 1 SVG unit = 1 m;'
        f' square extent {e0:.3f},{n0:.3f},{e1:.3f},{n1:.3f} (SW..NE), side {side:.3f} m —'
        f' the same square `gspro ortho` and `gspro hillshade` render.</desc>',
    ]
    for i, layer in enumerate(order, start=1):
        lines.append(f'  <g inkscape:groupmode="layer" id="layer{i}" inkscape:label="{layer}">')
        lines.extend(layers[layer])
        lines.append("  </g>")
    lines.append("</svg>")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    total = sum(len(v) for v in layers.values())
    kinds = ", ".join(f"{k} {v}" for k, v in sorted(written.items(), key=lambda kv: -kv[1]))
    curves = f"flattened to polylines at {flatten:g} m" if flatten is not None else "cubic beziers"
    order_note = ("app order with " + "/".join(TOP_TYPES) + " lifted to the top"
                  if stack == "opcd" else "the app's own z-order")
    print(f"Wrote {out}")
    print(f"  {course['name']} ({course['id']}): {total} features in {len(order)} layer(s) - {kinds}")
    print(f"  {side:.1f} m square = {side:.1f} mm at 1 unit/m, {curves}, stacked {order_note}")
    if road_notes:
        print(f"  roads: {road_notes}")
    if grown_gaps:
        print(f"  {grown_gaps} sliver(s) between a road and the surface beside it filled with that surface "
              f"({len(grown)} feature(s), written flattened)")
    if decks:
        print(f"  bridge decks left out (props in Unity, not ground): {sum(decks.values())} feature(s)")
    if tiny:
        listed = ", ".join(f"{r['type']} {r['id']}" + (f" (hole {r['hole_number']})" if r["hole_number"] is not None else "")
                           for r in tiny)
        print(f"  warning: {len(tiny)} shape(s) under {MIN_SHAPE_AREA_M2:g} m2 left out (drawn by mistake? delete them): {listed}")
    if excluded:
        detail = ", ".join(f"{k} {v}" for k, v in sorted(excluded.items(), key=lambda kv: -kv[1]))
        print(f"  excluded on request: {sum(excluded.values())} feature(s) - {detail}")
    if unknown_ids:
        print(f"  warning: {len(unknown_ids)} excluded id(s) are not features of this course "
              f"(deleted since?): {', '.join(unknown_ids[:5])}{' …' if len(unknown_ids) > 5 else ''}")
    if skipped:
        detail = ", ".join(f"{k} {v}" for k, v in sorted(skipped.items()))
        print(f"  skipped (no OPCD surface): {detail}; add one with e.g. --map trees=pinestraw")
    if clipped:
        detail = ", ".join(f"{k} {v}" for k, v in sorted(clipped.items(), key=lambda kv: -kv[1]))
        print(f"  {sum(clipped.values())} shape(s) reached past the terrain square and were cut to it "
              f"(written flattened): {detail}")
    if dropped_outside:
        detail = ", ".join(f"{k} {v}" for k, v in sorted(dropped_outside.items(), key=lambda kv: -kv[1]))
        print(f"  {sum(dropped_outside.values())} shape(s) lie wholly outside the terrain square and were "
              f"left out: {detail}")


# --- Command: zones ---------------------------------------------------------
# Lower-vegetation zones (docs/feature-vegetation-zones.md, section 6): the
# course's `vegetation_zone` features rasterized into the densities VSPro's
# texture-mask rules sample — ONE CHANNEL PER VSP ITEM, four items per RGBA
# PNG, 8 bits per channel — plus the unity-zones-v2 JSON the Unity importer
# reads. One channel per item (not per zone type) because VSP multiplies an
# item's density rules together: an item bound to two channels would only
# spawn where both are non-zero, so the pipeline sums every zone type /
# variant that binds an item into that item's own channel. The polygons are
# the source of truth; the rasters are regenerated on every export and never
# edited (D-VZ4). Runs once per terrain square with the same sidecar check
# as `trees`, the outer excluding the inner (D-VZ8).
UNITY_ZONES_FORMAT = "unity-zones-v2"
ZONE_FEATURE_TYPE = "vegetation_zone"
ZONE_TYPES_TABLE = "course_zone_types"
DEFAULT_ZONE_RESOLUTION = 4096
DEFAULT_ZONE_SIMPLIFY_M = 1.0
DEFAULT_ZONE_WEIGHT = 1.0
DEFAULT_ZONE_FEATHER_M = 2.0
DEFAULT_ZONE_NOISE_M = 0.0
DEFAULT_ZONE_SEED = 0
# How a zone meets the zones below it in the stack (attribute `blend`):
# replace takes its share of the ground from them, mix plants over them.
ZONE_BLEND_REPLACE = "replace"
ZONE_BLEND_MIX = "mix"
# Curve flattening for the raster, in mask pixels (0.5 m at 4096 over 2 km),
# and for the exported polygons, in metres (they are simplified afterwards).
ZONE_FLATTEN_PX = 0.25
ZONE_FLATTEN_M = 0.25
# Edge noise is value noise: one random value every this many metres,
# bilinear in between, scaled by the zone's `noise` metres. Bigger than a
# feather so the edge wanders instead of fizzing.
ZONE_NOISE_CELL_M = 6.0
ZONE_CHANNELS = 4


@dataclass
class ZoneVariant:
    key: str
    name: str
    items: list[dict]


@dataclass
class ZoneType:
    """A course_zone_types row. `items` are the Default mix (zones with no
    variant); each variant is its own mix. The row's texture_index/channel
    are no longer read: masks are one channel per item (unity-zones-v2)."""
    key: str
    name: str
    color: str
    items: list[dict]
    variants: list[ZoneVariant] = field(default_factory=list)

    def slots(self) -> list[tuple[str, list[dict]]]:
        """(slot key, items) for the Default mix, then each variant in order."""
        return [(self.key, self.items)] + [(zone_slot(self.key, v.key), v.items) for v in self.variants]


def zone_slot(zone_type: str, variant: str = "") -> str:
    """The raster slot a zone paints: `<type>` for the Default mix,
    `<type>/<variant>` for a variant."""
    return f"{zone_type}/{variant}" if variant else zone_type


@dataclass
class ZonePalette:
    """One more palette a zone plants on its footprint (`extraPalettes`):
    a type, one of its variants ("" = Default) and a weight factor 0..1
    on top of the zone's own weight."""
    zone_type: str
    variant: str = ""
    weight: float = 1.0

    @property
    def slot(self) -> str:
        return zone_slot(self.zone_type, self.variant)


@dataclass
class ZoneSpec:
    id: str
    zone_type: str
    weight: float
    feather: float
    noise: float
    geometry: dict  # the feature's geometry_json: rings + curveType
    variant: str = ""  # variant key; "" = the type's Default mix
    generated: bool = False  # written by a generator (course_features.generated), not drawn
    blend: str = ZONE_BLEND_REPLACE  # ZONE_BLEND_MIX: over the zones below it instead of taking their share
    extras: list[ZonePalette] = field(default_factory=list)  # more palettes on the same footprint

    @property
    def slot(self) -> str:
        return zone_slot(self.zone_type, self.variant)

    def layers(self) -> list[tuple[str, float, bool]]:
        """(slot, weight factor, takes the ground) per palette the zone
        plants, in the order render_zone_masks applies them: the extra
        palettes first, each mixed over the zone's own footprint, then the
        primary palette, which takes the ground unless the zone mixes."""
        return ([(e.slot, e.weight, False) for e in self.extras]
                + [(self.slot, 1.0, self.blend != ZONE_BLEND_MIX)])


@dataclass
class ZoneItem:
    """One VSP item's mask channel: `bindings` are (slot, maxDensity) for
    every place a zone type or variant binds it (twice if a slot lists it
    twice), `sources` the distinct slots in order."""
    item: str
    texture: int
    channel: int
    bindings: list[tuple[str, float]]

    @property
    def sources(self) -> list[str]:
        return list(dict.fromkeys(slot for slot, _ in self.bindings))


def _zone_number(attrs: dict, key: str, default: float, zone_id: str) -> float:
    value = attrs.get(key)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        raise SystemExit(f"error: zone {zone_id}: {key} is not a number ({value!r})") from None


def _zone_type_items(raw_items) -> list[dict]:
    """An items list (items_json, or a variant's items) as
    `{item, minDensity, maxDensity}` dicts; non-dict entries are dropped."""
    if not isinstance(raw_items, list):
        return []
    return [{"item": str(i.get("item") or ""),
             "minDensity": float(i.get("minDensity", 0.0)),
             "maxDensity": float(i.get("maxDensity", 1.0))}
            for i in raw_items if isinstance(i, dict)]


def _zone_type_variants(type_key: str, raw: str | None) -> list[ZoneVariant]:
    """A type's variants_json as ZoneVariants. Malformed JSON reads as no
    variants (with a warning), like the server's defensive parse; entries
    without a key, and repeats of a key, are skipped with a warning."""
    try:
        parsed = json.loads(raw or "[]")
    except ValueError:
        print(f"  warning: zone type {type_key!r}: variants_json is not JSON; no variants")
        return []
    if not isinstance(parsed, list):
        print(f"  warning: zone type {type_key!r}: variants_json is not a list; no variants")
        return []
    variants: list[ZoneVariant] = []
    for v in parsed:
        key = str(v.get("key") or "") if isinstance(v, dict) else ""
        if not key or any(o.key == key for o in variants):
            print(f"  warning: zone type {type_key!r}: skipped a variant with "
                  + (f"a repeated key {key!r}" if key else "no key"))
            continue
        variants.append(ZoneVariant(key, str(v.get("name") or key), _zone_type_items(v.get("items"))))
    return variants


def _load_zone_types(conn: sqlite3.Connection, course_id: str) -> list[ZoneType]:
    """The course's zone-type table in its sort order, each type with its
    Default items and its variants (variants_json, migration 022; a database
    without that column reads as no variants). texture_index/channel are
    ignored: the masks are one channel per item."""
    present = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                           (ZONE_TYPES_TABLE,)).fetchone()
    if not present:
        raise SystemExit(f"error: the database has no {ZONE_TYPES_TABLE} table "
                         "(run the server once so its migrations create it)")
    columns = {c["name"] for c in conn.execute(f"PRAGMA table_info({ZONE_TYPES_TABLE})").fetchall()}
    variants_col = ", variants_json" if "variants_json" in columns else ""
    rows = conn.execute(
        f"""SELECT key, name, color, sort_order, items_json{variants_col}
            FROM {ZONE_TYPES_TABLE} WHERE course_id = ? ORDER BY sort_order, key""",
        (course_id,),
    ).fetchall()
    types: list[ZoneType] = []
    for r in rows:
        try:
            raw_items = json.loads(r["items_json"] or "[]")
        except ValueError:
            raise SystemExit(f"error: zone type {r['key']!r}: items_json is not JSON") from None
        variants = _zone_type_variants(str(r["key"]), r["variants_json"]) if variants_col else []
        types.append(ZoneType(str(r["key"]), str(r["name"] or r["key"]), str(r["color"] or "#000000"),
                              _zone_type_items(raw_items), variants))
    return types


CREEK_SECTION_ZONE_TYPE = "creek_bank"   # pipeline/creek_bank_zones.py ZONE_TYPE
# A hand-drawn creek_bank zone steers creek_bank_zones.py only for the creeks and
# water it comes near: the generator hands a creek the sections within its bank
# reach (bankVegMaxM, default below) plus this many metres (its `near_sections`).
# Farther away it is an ordinary zone and plants its palette itself.
CREEK_SECTION_WATER_TYPES = ("water_creek", "water")
CREEK_SECTION_REACH_M = 10.0
CREEK_SECTION_DEFAULT_MAX_M = 4.5   # creek_bank_zones.DEFAULT_MAX_M


def creek_section_ids(db_path: Path, course_id: str, zones: list["ZoneSpec"]) -> set[str]:
    """The hand-drawn creek_bank zones that are creek sections: within a creek's or
    water's bank reach + CREEK_SECTION_REACH_M of it. The others plant like any zone."""
    candidates = [z for z in zones if z.zone_type == CREEK_SECTION_ZONE_TYPE and not z.generated]
    if not candidates:
        return set()
    conn = _open_course_db(db_path)
    rows = conn.execute(
        f"SELECT geometry_json, attributes_json FROM course_features WHERE course_id = ? AND type IN "
        f"({', '.join('?' for _ in CREEK_SECTION_WATER_TYPES)})", (course_id, *CREEK_SECTION_WATER_TYPES)).fetchall()
    conn.close()
    waters = []
    for r in rows:
        geom = _zone_geometry_m(json.loads(r["geometry_json"]))
        if geom is None or geom.is_empty:
            continue
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        max_m = attrs.get("bankVegMaxM", CREEK_SECTION_DEFAULT_MAX_M) if isinstance(attrs, dict) else CREEK_SECTION_DEFAULT_MAX_M
        waters.append((geom, float(max_m) if isinstance(max_m, (int, float)) else CREEK_SECTION_DEFAULT_MAX_M))
    ids = set()
    for z in candidates:
        geom = _zone_geometry_m(z.geometry)
        if geom is not None and not geom.is_empty and any(
                geom.distance(w) < reach + CREEK_SECTION_REACH_M for w, reach in waters):
            ids.add(z.id)
    return ids


def _load_zones(db_path: Path, course_ident: str) -> tuple[sqlite3.Row, list[ZoneType], list[ZoneSpec]]:
    """A course, its zone-type table and its vegetation_zone features in the
    web editor's stack order (server D28: hole 1, 2, ..., then course-level
    features on top, each group by sort_order — the same order the SVG/tint
    loader uses), with `zoneType`, `zoneVariant` ("" = Default), `weight`,
    `feather`, `noise` read from attributes_json (defaults 1, 2 m, 0 m when
    absent; weight clamped to 0..1). The variant is not checked against the
    type here; cmd_zones falls unknown ones back to the Default mix."""
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    types = _load_zone_types(conn, course["id"])
    has_generated = "generated" in {r[1] for r in conn.execute("PRAGMA table_info(course_features)")}
    try:
        rows = conn.execute(
            f"""SELECT f.id, f.geometry_json, f.attributes_json, f.sort_order, h.number AS hole_number,
                      {"f.generated" if has_generated else "0"} AS generated
               FROM course_features f LEFT JOIN holes h ON h.id = f.hole_id
               WHERE f.course_id = ? AND f.type = ?
               ORDER BY {_group_rank_sql(conn)}, f.sort_order, f.id""",
            (course["id"], ZONE_FEATURE_TYPE),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        raise SystemExit(f"error: {db_path}: {exc} (run the server once so its migrations bring the schema up)") from None
    conn.close()
    zones: list[ZoneSpec] = []
    for r in rows:
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        if not isinstance(attrs, dict):
            attrs = {}
        zones.append(ZoneSpec(
            id=str(r["id"]),
            zone_type=str(attrs.get("zoneType") or ""),
            weight=min(1.0, max(0.0, _zone_number(attrs, "weight", DEFAULT_ZONE_WEIGHT, r["id"]))),
            feather=max(0.0, _zone_number(attrs, "feather", DEFAULT_ZONE_FEATHER_M, r["id"])),
            noise=max(0.0, _zone_number(attrs, "noise", DEFAULT_ZONE_NOISE_M, r["id"])),
            geometry=json.loads(r["geometry_json"]),
            variant=str(attrs.get("zoneVariant") or ""),
            generated=bool(r["generated"]),
            blend=ZONE_BLEND_MIX if attrs.get("blend") == ZONE_BLEND_MIX else ZONE_BLEND_REPLACE,
            extras=_zone_extra_palettes(attrs.get("extraPalettes"), str(r["id"])),
        ))
    return course, types, zones


_ZONE_PALETTE_ENTRY = re.compile(r"([a-z0-9_]+)(?:/([a-z0-9_]+))?(?:=([0-9]*\.?[0-9]+))?")


def _zone_extra_palettes(raw, zone_id: str) -> list[ZonePalette]:
    """A zone's `extraPalettes` attribute — comma-separated
    `<zoneType>[/<variant>][=<weight 0..1>]`, the format of
    shared/features/zone-layers.ts — as ZonePalettes (weight default 1).
    The server validates it; an entry that still does not parse is skipped
    with a warning."""
    if not isinstance(raw, str):
        return []
    extras: list[ZonePalette] = []
    for part in raw.split(","):
        entry = part.strip()
        if not entry:
            continue
        m = _ZONE_PALETTE_ENTRY.fullmatch(entry)
        weight = float(m.group(3)) if m and m.group(3) is not None else 1.0
        if m is None or not 0.0 <= weight <= 1.0:
            print(f"  warning: zone {zone_id}: extra palette {entry!r} is not <zoneType>[/<variant>][=<weight 0..1>]; skipped")
            continue
        extras.append(ZonePalette(m.group(1), m.group(2) or "", weight))
    return extras


class _ValueNoise:
    """A random grid over the square, one value in [-1, 1] every `cell_m`
    metres, bilinear between (scipy map_coordinates), deterministic from
    `seed`. Sampled per crop, so no full-frame field is ever allocated."""

    def __init__(self, seed: int, side_m: float, cell_m: float = ZONE_NOISE_CELL_M):
        n = int(math.ceil(side_m / cell_m)) + 2
        self.grid = np.random.default_rng(seed).uniform(-1.0, 1.0, size=(n, n)).astype(np.float32)
        self.cell_m = cell_m

    def sample(self, y0: int, y1: int, x0: int, x1: int, px_m: float) -> np.ndarray:
        from scipy.ndimage import map_coordinates
        rows = (np.arange(y0, y1, dtype=np.float64) + 0.5) * px_m / self.cell_m
        cols = (np.arange(x0, x1, dtype=np.float64) + 0.5) * px_m / self.cell_m
        rr, cc = np.meshgrid(rows, cols, indexing="ij")
        return map_coordinates(self.grid, [rr, cc], order=1, mode="nearest").astype(np.float32)


def _fill_even_odd(polys: list[list[Pt]], x0: int, y0: int, w: int, h: int) -> np.ndarray:
    """Rings filled even-odd (rings with holes, like the SVG and the tint)
    into a bool crop whose top-left pixel is (x0, y0) of the frame."""
    acc = np.zeros((h, w), dtype=bool)
    for poly in polys:
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).polygon([(x - x0, y - y0) for x, y in poly], fill=255)
        acc ^= np.asarray(m, dtype=bool)
    return acc


def _zone_weight_crop(polys_px: list[list[Pt]], size: int, px_m: float, weight: float, feather_m: float,
                      noise_m: float, noise: "_ValueNoise | None",
                      clip: tuple[int, int, int, int] | None = None) -> tuple[tuple[int, int, int, int], np.ndarray] | None:
    """One zone's weight over its bounding-box crop (padded for the feather
    and the noise), as ((y0, y1, x0, x1), float32 crop): the rings filled
    even-odd, the signed distance in metres (negative inside, zero on the
    drawn edge) from two Euclidean distance transforms, the noise added to
    that distance, then `clamp(0.5 - d / feather, 0, 1) × weight` — or a
    hard edge when the feather is 0. None when nothing lands in the frame.

    `clip` (y0, y1, x0, x1) limits the crop to that rectangle grown by the
    same margin: a pixel's weight only depends on the edge within
    `feather / 2 + noise` of it, so inside `clip` the values are exactly
    those of the whole crop, without distance transforms over a zone that
    is much bigger than the part wanted."""
    xs = [x for p in polys_px for x, _ in p]
    ys = [y for p in polys_px for _, y in p]
    margin = int(math.ceil((feather_m / 2.0 + noise_m) / px_m)) + 2
    x0, y0 = max(0, math.floor(min(xs)) - margin), max(0, math.floor(min(ys)) - margin)
    x1, y1 = min(size, math.ceil(max(xs)) + margin + 1), min(size, math.ceil(max(ys)) + margin + 1)
    if clip is not None:
        y0, y1 = max(y0, clip[0] - margin), min(y1, clip[1] + margin)
        x0, x1 = max(x0, clip[2] - margin), min(x1, clip[3] + margin)
    if x1 <= x0 or y1 <= y0:
        return None
    mask = _fill_even_odd(polys_px, x0, y0, x1 - x0, y1 - y0)
    if not mask.any():
        return None
    if feather_m <= 0.0 and noise_m <= 0.0:
        return (y0, y1, x0, x1), mask.astype(np.float32) * np.float32(weight)
    from scipy.ndimage import distance_transform_edt
    # EDT gives each pixel its distance to the nearest pixel of the other
    # set; boundary pixels sit half a pixel from the edge, hence the 0.5.
    # A crop the polygon fills entirely (clipped by the square) has no
    # outside to measure to: everything is deep inside.
    if mask.all():
        d = np.full(mask.shape, -np.inf, dtype=np.float32)
    else:
        inside = distance_transform_edt(mask) - 0.5
        outside = distance_transform_edt(~mask) - 0.5
        d = np.where(mask, -inside, outside).astype(np.float32) * np.float32(px_m)
    if noise_m > 0.0 and noise is not None:
        d = d + noise.sample(y0, y1, x0, x1, px_m) * np.float32(noise_m)
    if feather_m > 0.0:
        w = np.clip(0.5 - d / np.float32(feather_m), 0.0, 1.0)
    else:
        w = (d < 0.0).astype(np.float32)
    return (y0, y1, x0, x1), (w * np.float32(weight)).astype(np.float32)


def _px_rect(rect: Extent, extent: Extent, size: int) -> tuple[int, int, int, int]:
    """An EPSG:3006 rectangle as (y0, y1, x0, x1) pixel rows/cols of the
    north-up frame, clipped to it."""
    e0, n0, e1, n1 = extent
    scale = size / (e1 - e0)
    x0 = max(0, int(round((rect[0] - e0) * scale)))
    x1 = min(size, int(round((rect[2] - e0) * scale)))
    y0 = max(0, int(round((n1 - rect[3]) * scale)))
    y1 = min(size, int(round((n1 - rect[1]) * scale)))
    return y0, y1, x0, x1


def render_zone_masks(zones: list[ZoneSpec], extent: Extent, size: int, seed: int = DEFAULT_ZONE_SEED,
                      exclude: Extent | None = None,
                      window: tuple[int, int, int, int] | None = None) -> tuple[dict[str, np.ndarray], int]:
    """Per slot (`<type>` for a type's Default mix, `<type>/<variant>` for a
    variant — ZoneSpec.slot), a float32 size×size weight raster in the
    north-up frame of the terrain texture (only slots that have a zone get
    one), and the count of zones that did not land in the frame.

    Overlaps (D-VZ14): the zones drawn by hand sit above the generated ones
    (tall rough, creek banks, lidar proposals; ZoneSpec.generated), and
    their order does not matter. Drawn zones add up: each paints its
    palettes at its weight (the same palette twice: the maximum). A drawn
    replace zone (`blend` = replace) takes its weight of the ground from the
    generated zones below it; a drawn mix zone takes nothing, so the
    generated fill keeps growing under it.

    The generated zones then share what the drawn replace zones left, in
    their stack order, processed from the LAST to the first with a running
    per-pixel budget: a zone of slot S can raise S's raster up to
    `min(its weight, what S already holds + the budget left)` and takes the
    difference out of the budget — so a later zone claims its weight first,
    an earlier zone of another slot keeps only what is left, and zones of
    the same slot combine as a maximum where the budget allows. A generated
    mix zone takes nothing out of the budget. Nothing is scaled up: a lone
    zone at weight 0.3 stays 0.3 and a feather ramp stays a ramp. A zone's
    extra palettes are mix layers on its own footprint at `weight × factor`
    (ZoneSpec.layers). `exclude` (the inner square when this is the outer
    terrain) is zeroed at the end.

    `window` (y0, y1, x0, x1 in frame pixels) renders only that part of the
    frame: the rasters are the window's size and hold exactly the pixels a
    full render has there, since every zone's weight is still computed over
    its own whole crop (the distance field needs the whole polygon) and the
    stack is resolved per pixel. Only zones whose crop reaches the window
    count, and only their slots get a raster (the zones-patch step)."""
    e0, n0, e1, n1 = extent
    px_m = (e1 - e0) / size
    scale = 1.0 / px_m

    def to_px(xy: Pt) -> Pt:
        return ((xy[0] - e0) * scale, (n1 - xy[1]) * scale)

    wy0, wy1, wx0, wx1 = window if window is not None else (0, size, 0, size)
    shape = (wy1 - wy0, wx1 - wx0)
    noise = _ValueNoise(seed, e1 - e0) if any(z.noise > 0 for z in zones) else None
    channels: dict[str, np.ndarray] = {}
    outside = 0

    def weight_in_window(z: ZoneSpec) -> tuple[tuple[int, int, int, int], np.ndarray] | None | str:
        """The zone's weight over its crop's overlap with the window, in window
        coordinates; None when it misses the window, "outside" when it misses the frame."""
        curve = z.geometry.get("curveType") or "bezier"
        polys = [p for p in (_ring_px(r, curve, to_px, ZONE_FLATTEN_PX) for r in z.geometry.get("rings") or [])
                 if len(p) >= 3]
        if polys and window is not None:
            # The crop's own padding (_zone_weight_crop), checked before its distance transforms.
            pad = (z.feather / 2.0 + z.noise) / px_m + 3
            xs = [x for p in polys for x, _ in p]
            ys = [y for p in polys for _, y in p]
            if min(xs) - pad >= wx1 or max(xs) + pad < wx0 or min(ys) - pad >= wy1 or max(ys) + pad < wy0:
                return None
        crop = _zone_weight_crop(polys, size, px_m, z.weight, z.feather, z.noise, noise, clip=window) if polys else None
        if crop is None:
            return "outside"
        (y0, y1, x0, x1), w = crop
        cy0, cy1, cx0, cx1 = max(y0, wy0), min(y1, wy1), max(x0, wx0), min(x1, wx1)
        if cy1 <= cy0 or cx1 <= cx0:
            return None
        return (cy0 - wy0, cy1 - wy0, cx0 - wx0, cx1 - wx0), w[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]

    # Drawn zones first: each palette adds (same palette: the maximum), whatever the order;
    # a replace zone's weight is ground the generated fill below does not get.
    claimed = np.zeros(shape, dtype=np.float32)
    for z in zones:
        if z.generated:
            continue
        got = weight_in_window(z)
        if got is None:
            continue
        if got == "outside":
            outside += 1
            continue
        (y0, y1, x0, x1), w = got
        for slot, factor, takes_ground in z.layers():
            held = channels.setdefault(slot, np.zeros(shape, dtype=np.float32))
            np.maximum(held[y0:y1, x0:x1], w * np.float32(factor), out=held[y0:y1, x0:x1])
            if takes_ground:
                np.maximum(claimed[y0:y1, x0:x1], w, out=claimed[y0:y1, x0:x1])

    # Generated zones under them, from the top of their stack down, sharing what is left.
    remaining = np.clip(1.0 - claimed, 0.0, 1.0).astype(np.float32)
    for z in reversed([z for z in zones if z.generated]):
        got = weight_in_window(z)
        if got is None:
            continue
        if got == "outside":
            outside += 1
            continue
        (y0, y1, x0, x1), w = got
        sub_left = remaining[y0:y1, x0:x1]
        for slot, factor, takes_ground in z.layers():
            held = channels.setdefault(slot, np.zeros(shape, dtype=np.float32))
            sub_held = held[y0:y1, x0:x1]
            new = np.maximum(sub_held, np.minimum(w * np.float32(factor), sub_left + sub_held))
            if takes_ground:
                sub_left -= new - sub_held
                np.maximum(sub_left, 0.0, out=sub_left)
            sub_held[...] = new
    if exclude is not None:
        y0, y1, x0, x1 = _px_rect(exclude, extent, size)
        y0, y1, x0, x1 = max(y0, wy0) - wy0, min(y1, wy1) - wy0, max(x0, wx0) - wx0, min(x1, wx1) - wx0
        if y1 > y0 and x1 > x0:
            for arr in channels.values():
                arr[y0:y1, x0:x1] = 0.0
    return channels, outside


def zone_items(types: list[ZoneType]) -> list[ZoneItem]:
    """Every VSP item the zone-type table binds, in order of first
    appearance walking the table in sort order (each type's Default items,
    then each variant's items), packed four per texture in that order. Item
    identity is the exact `item` string; blank names are skipped. Every
    bound item gets a channel whether or not any zone covers it, so the
    Unity side always rebinds it (an all-zero channel = spawns nowhere)."""
    by_name: dict[str, ZoneItem] = {}
    for t in types:
        for slot, items in t.slots():
            for i in items:
                name = i["item"]
                if not name.strip():
                    continue
                entry = by_name.get(name)
                if entry is None:
                    n = len(by_name)
                    entry = by_name[name] = ZoneItem(name, n // ZONE_CHANNELS, n % ZONE_CHANNELS, [])
                entry.bindings.append((slot, float(i["maxDensity"])))
    return list(by_name.values())


def zone_item_density(item: ZoneItem, slots: dict[str, np.ndarray], size: int | tuple[int, int]) -> np.ndarray:
    """One item's density raster: `clip(sum over its bindings of
    W_slot × maxDensity, 0, 1)`, W_slot from render_zone_masks (a slot with
    no zone contributes nothing). Summed, not multiplied, because VSP
    multiplies an item's density rules: the item gets this one channel.
    `size` is the raster's edge, or its (rows, cols) for a window."""
    acc = np.zeros(size if isinstance(size, tuple) else (size, size), dtype=np.float32)
    for slot, max_density in item.bindings:
        w = slots.get(slot)
        if w is not None and max_density != 0.0:
            acc += w * np.float32(max_density)
    return np.clip(acc, 0.0, 1.0, out=acc)


def _write_zone_masks(slots: dict[str, np.ndarray], items: list[ZoneItem], size: int, out: Path) -> list[dict]:
    """The items' densities packed four per RGBA PNG in item order, named
    `<out stem>-<texture>.png` next to `out`, 8-bit (`round(d × 255)`);
    unused channels stay 0 and are named "" in the manifest. Stale
    `<out stem>-<n>.png` files past the last texture (an earlier export with
    more textures) are removed so the folder matches the manifest."""
    textures = (len(items) + ZONE_CHANNELS - 1) // ZONE_CHANNELS
    masks: list[dict] = []
    for texture in range(textures):
        rgba = np.zeros((size, size, ZONE_CHANNELS), dtype=np.uint8)
        names = [""] * ZONE_CHANNELS
        for item in items[texture * ZONE_CHANNELS:(texture + 1) * ZONE_CHANNELS]:
            names[item.channel] = item.item
            d = zone_item_density(item, slots, size)
            rgba[..., item.channel] = np.round(d * 255.0).clip(0, 255).astype(np.uint8)
        path = out.with_name(f"{out.stem}-{texture}.png")
        Image.fromarray(rgba).save(path, format="PNG")
        masks.append({"file": path.name, "resolution": size, "channels": names})
    stale = re.compile(re.escape(out.stem) + r"-(\d+)\.png")
    if out.parent.is_dir():
        for p in out.parent.iterdir():
            m = stale.fullmatch(p.name)
            if m and int(m.group(1)) >= textures and p.is_file():
                p.unlink()
                print(f"  removed stale mask {p.name}")
    return masks


def _zone_geometry_m(geometry: dict) -> "BaseGeometry | None":
    """A zone's rings as one shapely geometry in EPSG:3006 metres: the same
    bezier/B-spline expansion the SVG gets, flattened within ZONE_FLATTEN_M,
    rings combined even-odd (symmetric difference) like the raster fill."""
    from shapely import make_valid
    from shapely.geometry import Polygon

    curve = geometry.get("curveType") or "bezier"
    geom = None
    for ring in geometry.get("rings") or []:
        pts = _ring_px(ring, curve, lambda xy: xy, ZONE_FLATTEN_M)
        if len(pts) < 3:
            continue
        poly = make_valid(Polygon(pts))
        geom = poly if geom is None else geom.symmetric_difference(poly)
    return geom


def _zone_rings_local(geom, e0: float, n0: float) -> list[dict]:
    """Every ring of every polygon part as `{"nodes": [{"x", "z"}]}` in
    plot-local metres (x east, z north from the square's south-west corner),
    the closing point dropped — the unity-trees-v1 convention."""
    from golfpipe.detect_common import _each_polygon

    rings: list[dict] = []
    for poly in _each_polygon(geom):
        for ring in (poly.exterior, *poly.interiors):
            coords = list(ring.coords)[:-1]
            if len(coords) < 3:
                continue
            rings.append({"nodes": [{"x": round(x - e0, 2), "z": round(y - n0, 2)} for x, y, *_ in coords]})
    return rings


def _prepare_zones(db_path: Path, course_ident: str) -> tuple[sqlite3.Row, list[ZoneType], list[ZoneSpec], dict[str, int]]:
    """The course, its zone types and the zones that rasterize, in stack
    order, checked against the table (cmd_zones and cmd_zones_patch alike):
    hand-drawn creek_bank zones (creek sections) are left out, zones of an
    unknown type are skipped (counted per type in the last value), extra
    palettes of an unknown type dropped, unknown variants fall back to the
    Default mix — each with a line in the report."""
    course, types, zones = _load_zones(db_path, course_ident)
    # A hand-drawn creek_bank zone near a creek or water marks a stretch of it and picks
    # its palette for creek_bank_zones.py (a creek section); the generated creek-bank
    # zones plant it. Away from water it is an ordinary zone.
    sections = creek_section_ids(db_path, course["id"], zones)
    if sections:
        zones = [z for z in zones if z.id not in sections]
        print(f"  {len(sections)} creek section(s) (hand-drawn {CREEK_SECTION_ZONE_TYPE} zones near a creek or water) "
              f"not rasterized: they pick the palette of those banks, which Plant vegetation plants: "
              f"{', '.join(sorted(i[:8] for i in sections))}")
    if not types:
        raise SystemExit(f"error: course {course['name']} ({course['id']}) has no zone types "
                         "(add them in the web zone-type panel first)")
    by_key = {t.key: t for t in types}

    known: list[ZoneSpec] = []
    unknown: dict[str, int] = {}
    for z in zones:
        if z.zone_type in by_key:
            known.append(z)
        else:
            unknown[z.zone_type] = unknown.get(z.zone_type, 0) + 1
    for key, count in sorted(unknown.items()):
        print(f"  warning: {count} zone(s) with zone type {key or '(none)'!r} not in the course's table; skipped")
    fallen: dict[tuple[str, str], int] = {}
    for z in known:
        if z.variant and all(v.key != z.variant for v in by_key[z.zone_type].variants):
            fallen[(z.zone_type, z.variant)] = fallen.get((z.zone_type, z.variant), 0) + 1
            z.variant = ""
    dropped: dict[str, int] = {}
    for z in known:
        kept: list[ZonePalette] = []
        for e in z.extras:
            if e.zone_type not in by_key:
                dropped[e.zone_type] = dropped.get(e.zone_type, 0) + 1
                continue
            if e.variant and all(v.key != e.variant for v in by_key[e.zone_type].variants):
                fallen[(e.zone_type, e.variant)] = fallen.get((e.zone_type, e.variant), 0) + 1
                e.variant = ""
            kept.append(e)
        z.extras = kept
    for (key, variant), count in sorted(fallen.items()):
        print(f"  warning: {count} zone(s) of zone type {key!r} with variant {variant!r} not in its variants; "
              "using its Default mix")
    for key, count in sorted(dropped.items()):
        print(f"  warning: {count} extra palette(s) with zone type {key!r} not in the course's table; skipped")

    return course, types, known, unknown


def _zone_row(z: ZoneSpec, square, excl, e0: float, n0: float, simplify_m: float) -> dict | str:
    """A zone's unity-zones-v2 row (plot-local rings, flattened, clipped to
    the square minus `excl`, simplified), or "outside" / "excluded" when
    nothing of it is left."""
    geom = _zone_geometry_m(z.geometry)
    clipped = geom.intersection(square) if geom is not None and not geom.is_empty else None
    if clipped is None or clipped.is_empty:
        return "outside"
    if excl is not None:
        clipped = clipped.difference(excl)
        if clipped.is_empty:
            return "excluded"
    if simplify_m > 0:
        clipped = clipped.simplify(simplify_m, preserve_topology=True)
    rings = _zone_rings_local(clipped, e0, n0)
    if not rings:
        return "outside"
    return {
        "id": z.id,
        "zoneType": z.zone_type,
        "variant": z.variant,
        "weight": z.weight,
        "feather": z.feather,
        "noise": z.noise,
        "blend": z.blend,
        "extraPalettes": [{"zoneType": e.zone_type, "variant": e.variant, "weight": e.weight} for e in z.extras],
        "rings": rings,
    }


def _zone_types_json(types: list[ZoneType]) -> list[dict]:
    return [{"key": t.key, "name": t.name, "color": t.color, "items": t.items,
             "variants": [{"key": v.key, "name": v.name, "items": v.items} for v in t.variants]}
            for t in types]


def _zone_items_json(items: list[ZoneItem]) -> list[dict]:
    return [{"item": i.item, "texture": i.texture, "channel": i.channel, "sources": i.sources} for i in items]


def cmd_zones(bbox, db_path: Path, course_ident: str, sidecar_path: Path, out: Path,
              terrain: str | None = None, exclude: Extent | None = None, extent: Extent | None = None,
              resolution: int = DEFAULT_ZONE_RESOLUTION, simplify_m: float = DEFAULT_ZONE_SIMPLIFY_M,
              seed: int = DEFAULT_ZONE_SEED) -> None:
    """Rasterize a course's vegetation zones for one terrain into the VSPro
    texture masks — one channel per bound VSP item, four per
    `<out stem>-<texture>.png`, RGBA, `resolution`² — and write the
    unity-zones-v2 JSON at `out`: the plot block copied from the terrain's
    heightmap sidecar exactly as `trees` does, the mask manifest, the items
    (texture, channel, the slots that bind them), the zone-type table with
    its Default items and variants, and every zone that touches the square
    as plot-local polygons (flattened, clipped to the square, minus
    `exclude`, simplified to `simplify_m`) for the Scene-view overlay.
    Zones whose type is not in the course's table are skipped with a
    warning, and so are extra palettes whose type is not; a variant not in
    its type falls back to the Default mix with a warning."""
    from shapely.geometry import box

    if resolution <= 0:
        raise SystemExit("error: --resolution must be > 0")
    if simplify_m < 0:
        raise SystemExit("error: --simplify must be >= 0")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    sidecar = _read_plot_sidecar(sidecar_path, extent)
    course, types, known, unknown = _prepare_zones(db_path, course_ident)

    out.parent.mkdir(parents=True, exist_ok=True)
    slots, outside_raster = render_zone_masks(known, extent, resolution, seed=seed, exclude=exclude)
    items = zone_items(types)
    masks = _write_zone_masks(slots, items, resolution, out)

    square = box(e0, n0, e1, n1)
    excl = box(*exclude) if exclude is not None else None
    rows: list[dict] = []
    outside = excluded = 0
    for z in known:
        row = _zone_row(z, square, excl, e0, n0, simplify_m)
        if row == "outside":
            outside += 1
        elif row == "excluded":
            excluded += 1
        else:
            rows.append(row)

    doc = {
        "format": UNITY_ZONES_FORMAT,
        "plot": {
            "crs": "EPSG:3006",
            "terrain": terrain or sidecar.get("terrain") or "",
            "originX": e0,
            "originY": n0,
            "sizeM": side,
            "minM": float(sidecar["minM"]),
            "maxM": float(sidecar["maxM"]),
        },
        "masks": masks,
        "seed": seed,
        "simplifyM": simplify_m,
        "items": _zone_items_json(items),
        "zoneTypes": _zone_types_json(types),
        "zones": rows,
    }
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n", encoding="utf-8")

    per_slot = {slot: sum(1 for r in rows if zone_slot(r["zoneType"], r["variant"]) == slot)
                for t in types for slot, _ in t.slots()}
    counts = ", ".join(f"{k} {v}" for k, v in per_slot.items() if v) or "none"
    print(f"Wrote {out}")
    print(f"  {len(rows)} zones on the {side:g} m {doc['plot']['terrain'] or 'terrain'} square ({counts}); "
          f"{outside} outside the square"
          + (f", {excluded} left to the inner terrain" if exclude is not None else "")
          + (f", {sum(unknown.values())} skipped (unknown zone type)" if unknown else ""))
    mixing = sum(1 for r in rows if r["blend"] == ZONE_BLEND_MIX)
    extra = sum(len(r["extraPalettes"]) for r in rows)
    if mixing or extra:
        print(f"  {mixing} zone(s) mix over the zones below them, {extra} extra palette(s) on zone footprints")
    print(f"  masks {resolution}² at {side / resolution:.3f} m/px, noise seed {seed}, "
          f"polygons simplified to {simplify_m:g} m, one channel per item: "
          f"{len(items)} item(s) in {len(masks)} texture(s)")
    for i in items:
        print(f"    {masks[i.texture]['file']} {'RGBA'[i.channel]}: {i.item} <- {', '.join(i.sources)}")
    print(f"  plot origin {e0:.0f},{n0:.0f} (EPSG:3006), height range {doc['plot']['minM']:.2f}..{doc['plot']['maxM']:.2f} m from {sidecar_path.name}")


# --- Command: zones-patch ---------------------------------------------------
# Re-rasterize only the part of a terrain's zone masks that some zones cover
# (the web's "Update in Unity" on selected zones), instead of the whole
# square: the window around the zones as they are now and as the last export
# drew them (their rows in the zones JSON), plus zones that export had and
# the course no longer has. The window renders exactly what a full export
# would there (render_zone_masks), so the masks stay what `zones` writes.
# Only the textures whose pixels change are rewritten, and the zones JSON
# gets the zones' new rows. The channel layout cannot move in a patch: when
# the zone types' item bindings differ from the export's, it stops and asks
# for a full export.
ZONES_PATCH_FORMAT = "unity-zones-patch-v1"


ZONES_LAYOUT_CHANGED_EXIT = 3


class ZonesLayoutChanged(SystemExit):
    """The item bindings moved since the export: only a full export can
    follow. Exits with ZONES_LAYOUT_CHANGED_EXIT after printing why."""

    def __init__(self, message: str):
        print(f"error: {message}", file=sys.stderr)
        super().__init__(ZONES_LAYOUT_CHANGED_EXIT)
        self.message = message


def _zone_bindings(types: list[ZoneType]) -> list:
    """What decides the masks' pixels and channels in a zone-type table: every
    slot's (item, maxDensity) bindings, in table order."""
    return [(slot, [(i["item"], float(i["maxDensity"])) for i in items]) for t in types for slot, items in t.slots()]


def _zone_types_from_json(raw: list) -> list[ZoneType]:
    return [ZoneType(str(t["key"]), str(t.get("name") or t["key"]), str(t.get("color") or ""),
                     _zone_type_items(t.get("items")),
                     [ZoneVariant(str(v["key"]), str(v.get("name") or v["key"]), _zone_type_items(v.get("items")))
                      for v in t.get("variants") or []])
            for t in raw]


def _row_slots(row: dict) -> list[str]:
    return ([zone_slot(row["zoneType"], row.get("variant") or "")]
            + [zone_slot(e["zoneType"], e.get("variant") or "") for e in row.get("extraPalettes") or []])


def _row_rect(row: dict, e0: float, n0: float) -> Extent | None:
    """A zones-JSON row's outline bounds in EPSG:3006, padded like its crop."""
    nodes = [n for r in row.get("rings") or [] for n in r.get("nodes") or []]
    if not nodes:
        return None
    pad = float(row.get("feather", DEFAULT_ZONE_FEATHER_M)) / 2.0 + float(row.get("noise", DEFAULT_ZONE_NOISE_M))
    xs, zs = [e0 + n["x"] for n in nodes], [n0 + n["z"] for n in nodes]
    return (min(xs) - pad, min(zs) - pad, max(xs) + pad, max(zs) + pad)


def _zone_rect(z: ZoneSpec) -> Extent | None:
    """A zone's outline bounds in EPSG:3006 (curves flattened), padded like its crop."""
    geom = _zone_geometry_m(z.geometry)
    if geom is None or geom.is_empty:
        return None
    x0, y0, x1, y1 = geom.bounds
    pad = z.feather / 2.0 + z.noise
    return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)


def cmd_zones_patch(db_path: Path, course_ident: str, zones_json: Path, zone_ids: list[str],
                    result_path: Path | None = None, exclude: Extent | None = None) -> dict:
    """Patch a terrain's exported zone masks (`zones_json`, a unity-zones-v2
    file written by `zones`, and its PNGs next to it) for the zones
    `zone_ids`: re-rasterize the window they cover, now and in that export,
    grown by every other zone the export has that the course no longer
    has, and write back only the textures whose pixels changed; update the
    JSON's rows for those zones. Returns (and writes to `result_path`) a
    unity-zones-patch-v1 record: the changed texture files and the window as
    plot-local metres for the Unity respawn. Raises ZonesLayoutChanged
    (exit 3) when the item bindings or channels differ from the export's."""
    from shapely.geometry import box

    prev = json.loads(zones_json.read_text(encoding="utf-8"))
    if prev.get("format") != UNITY_ZONES_FORMAT:
        raise SystemExit(f"error: {zones_json} is not a {UNITY_ZONES_FORMAT} file; export the zones first")
    plot = prev["plot"]
    e0, n0, side = float(plot["originX"]), float(plot["originY"]), float(plot["sizeM"])
    extent: Extent = (e0, n0, e0 + side, n0 + side)
    masks = prev.get("masks") or []
    size = int(masks[0]["resolution"]) if masks else DEFAULT_ZONE_RESOLUTION
    seed = int(prev.get("seed", DEFAULT_ZONE_SEED))
    simplify_m = float(prev.get("simplifyM", DEFAULT_ZONE_SIMPLIFY_M))

    course, types, known, _unknown = _prepare_zones(db_path, course_ident)
    items = zone_items(types)
    wanted = set(zone_ids)
    known_ids = {z.id for z in known}
    prev_rows = prev.get("zones") or []
    prev_by_id = {r["id"]: r for r in prev_rows}
    gone = [r for r in prev_rows if r["id"] not in known_ids]
    missing = sorted(i for i in wanted if i not in known_ids and i not in prev_by_id)
    if missing:
        print(f"  {len(missing)} zone(s) neither in the course's rasterized zones nor in the export: {', '.join(missing)}")

    # Zones the export has not seen: drawn since, or a re-run generator's (it replaces its
    # zones, so they all get new ids). One whose row is exactly a vanished row's is that
    # zone under a new id and changes nothing; the others are new and are patched in.
    square = box(*extent)
    excl = box(*exclude) if exclude is not None else None
    fresh_rows: dict[str, dict] = {}
    unseen = [z for z in known if z.id not in prev_by_id and z.id not in wanted]
    renamed = 0
    if unseen:
        def signature(row: dict) -> str:
            return json.dumps({k: v for k, v in row.items() if k != "id"}, sort_keys=True)
        pool: dict[str, list[str]] = {}
        for r in gone:
            pool.setdefault(signature(r), []).append(r["id"])
        matched: set[str] = set()
        for z in unseen:
            row = _zone_row(z, square, excl, e0, n0, simplify_m)
            if not isinstance(row, dict):
                continue   # not on this square
            same = pool.get(signature(row))
            if same:
                matched.add(same.pop())
                fresh_rows[z.id] = row
                renamed += 1
            else:
                wanted.add(z.id)
        gone = [r for r in gone if r["id"] not in matched]

    rects = [r for r in ([_zone_rect(z) for z in known if z.id in wanted]
                         + [_row_rect(prev_by_id[i], e0, n0) for i in wanted if i in prev_by_id]
                         + [_row_rect(r, e0, n0) for r in gone]) if r is not None]
    record: dict = {"format": ZONES_PATCH_FORMAT, "zonesFile": zones_json.name, "terrain": plot.get("terrain") or "",
                    "changed": False, "textures": [], "window": None, "region": None,
                    "zones": sorted(wanted & known_ids), "removed": [r["id"] for r in gone], "renamed": renamed}
    window = None
    if rects:
        union = (min(r[0] for r in rects), min(r[1] for r in rects), max(r[2] for r in rects), max(r[3] for r in rects))
        y0, y1, x0, x1 = _px_rect(union, extent, size)
        y0, y1, x0, x1 = max(0, y0 - 2), min(size, y1 + 2), max(0, x0 - 2), min(size, x1 + 2)
        inside_excluded = exclude is not None and (exclude[0] <= union[0] and exclude[1] <= union[1]
                                                   and union[2] <= exclude[2] and union[3] <= exclude[3])
        if y1 > y0 and x1 > x0 and not inside_excluded:
            window = (y0, y1, x0, x1)
    # Only a square the zones reach needs the export's channel layout to still hold.
    if window is not None and (_zone_items_json(items) != prev.get("items")
            or _zone_bindings(types) != _zone_bindings(_zone_types_from_json(prev.get("zoneTypes") or []))):
        raise ZonesLayoutChanged(
            f"the zone types' item bindings changed since {zones_json.name} was exported, so the mask "
            "channels may have moved; a patch cannot follow - export (plant) the whole terrain")

    if window is None:
        print(f"Nothing to patch on the {side:g} m {plot.get('terrain') or ''} square: the zones do not reach it")
    else:
        y0, y1, x0, x1 = window
        px_m = side / size
        slots, _ = render_zone_masks(known, extent, size, seed=seed, exclude=exclude, window=window)
        # Items that can differ in the window: those of a slot a zone paints there now, or one a
        # zone of the export painted there. Every other item is 0 there before and after.
        before = {slot for r in prev_rows if (rr := _row_rect(r, e0, n0)) is not None
                  and not (rr[2] < extent[0] + x0 * px_m or rr[0] > extent[0] + x1 * px_m
                           or rr[3] < extent[3] - y1 * px_m or rr[1] > extent[3] - y0 * px_m)
                  for slot in _row_slots(r)}
        touched = set(slots) | before
        for texture, mask in enumerate(masks):
            members = [i for i in items if i.texture == texture and set(i.sources) & touched]
            if not members:
                continue
            path = zones_json.with_name(mask["file"])
            rgba = np.array(Image.open(path).convert("RGBA"))
            if rgba.shape[:2] != (size, size):
                raise SystemExit(f"error: {path.name} is {rgba.shape[1]}x{rgba.shape[0]}, the export says {size}; export the zones again")
            region = rgba[y0:y1, x0:x1]
            new = region.copy()
            for item in members:
                d = zone_item_density(item, slots, (y1 - y0, x1 - x0))
                new[..., item.channel] = np.round(d * 255.0).clip(0, 255).astype(np.uint8)
            if np.array_equal(new, region):
                continue
            rgba[y0:y1, x0:x1] = new
            Image.fromarray(rgba).save(path, format="PNG")
            record["textures"].append(mask["file"])
        record["changed"] = bool(record["textures"])
        record["window"] = {"y0": y0, "y1": y1, "x0": x0, "x1": x1, "resolution": size}
        record["region"] = {"x0": round(x0 * px_m, 3), "z0": round(side - y1 * px_m, 3),
                            "x1": round(x1 * px_m, 3), "z1": round(side - y0 * px_m, 3)}

        print(f"Patched {zones_json.name}: {len(record['zones'])} zone(s)"
              + (f", {len(gone)} removed" if gone else "")
              + f", window {x1 - x0}x{y1 - y0} px ({(x1 - x0) * px_m:.0f} x {(y1 - y0) * px_m:.0f} m)"
              + f", {len(record['textures'])} of {len(masks)} texture(s) changed"
              + (f": {', '.join(record['textures'])}" if record["textures"] else ""))
    # The zones' rows as the masks now have them (patched, or the same zone under a new
    # id); the others keep the export's.
    for z in known:
        if z.id in wanted and z.id not in fresh_rows:
            row = _zone_row(z, square, excl, e0, n0, simplify_m)
            if isinstance(row, dict):
                fresh_rows[z.id] = row
    rows = [fresh_rows[z.id] if z.id in fresh_rows else prev_by_id[z.id]
            for z in known if z.id in fresh_rows or z.id in prev_by_id]
    if rows != prev_rows:
        prev["zones"] = rows
        zones_json.write_text(json.dumps(prev, separators=(",", ":")) + "\n", encoding="utf-8")
    if renamed:
        print(f"  {renamed} zone(s) unchanged under a new id (a re-run generator)")
    if result_path is not None:
        result_path.write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
    return record


# --- Command: gkd -----------------------------------------------------------
# GreenKeeper's course-description file (`<scene>.GKD`): the JSON GSPro reads
# for everything about a course that is not geometry — tee boxes, pin
# positions, green centres, aim points, penalty areas and the out-of-bounds
# ring. Every position in it is a UNITY world coordinate, so this command is
# the same square-local transform `trees` and `zones` already do (x east,
# z north from the square's south-west corner) with y the ground height above
# the terrain's own zero — the sidecar's `minM`, which is where the heightmap
# puts the inner terrain's floor when the importer drops it at 0,0,0.
#
# The file is MERGED, not rewritten: GreenKeeper owns the course metadata
# (name, location, designer, keywords, ratings, the scene folder name) and
# this command replaces only what the app is the source of truth for.
GKD_VERSION = 4.1
GKD_HOLE_COUNT = 18
# The tee sets a GKD carries, in file order, and the three pseudo-tees that
# share a hole's `Tees` list: the two aim points and the green centre.
GKD_TEE_TYPES = ("Black", "White", "Green", "Blue", "Yellow", "Red", "Junior", "Par3")
GKD_AIM_TYPES = ("AimPoint1", "AimPoint2")
GKD_GREEN_CENTER = "GreenCenterPoint"
# GreenKeeper keeps exactly four pin positions per hole, one per tournament day.
GKD_PIN_DAYS = ("Thursday", "Friday", "Saturday", "Sunday")
# The app's tee `name`/`color` -> the GKD tee set. The app is free-form (a tee
# is whatever the course calls it), the GKD is these eight slots; anything
# else needs --tee-map.
GKD_TEE_ALIASES = {
    "black": "Black", "championship": "Black", "tiger": "Black",
    "white": "White", "men": "White", "mens": "White",
    "green": "Green",
    "blue": "Blue",
    "yellow": "Yellow",
    "red": "Red", "ladies": "Red", "women": "Red",
    "junior": "Junior", "juniors": "Junior", "kids": "Junior",
    "par3": "Par3", "par 3": "Par3",
}
# Drawn feature types that become a GKD hazard (a penalty area). A creek is a
# penalty area like any other water in GSPro; the yellow/red distinction lives
# in the local rules, not in the file. Water is drawn where the WATER is, so
# its hazard line is staked outside it (below); a penalty area is drawn where
# the LINE is and goes in as drawn.
GKD_WATER_TYPES = ("water", "water_creek")
GKD_PENALTY_TYPES = ("penalty_yellow", "penalty_red")
GKD_HAZARD_TYPES = (*GKD_WATER_TYPES, *GKD_PENALTY_TYPES)
GKD_OOB_TYPE = "oob"
# A water hazard line never touches the water: every node AND the straight
# line between two nodes stays at least this far outside it.
DEFAULT_GKD_WATER_MARGIN_M = 0.5
# Where the water has a bank the line is staked where the bank ends — the
# first ground flatter than DEFAULT_GKD_BANK_SLOPE_DEG past a run of steeper
# ground that starts within GKD_BANK_START_M of the water — but never further
# out than DEFAULT_GKD_BANK_MAX_M. Found along rays cast straight out from the
# shore every GKD_BANK_RAY_SPACING_M, sampled every GKD_BANK_STEP_M, on a DEM
# smoothed by GKD_SLOPE_SIGMA_M so single lidar returns don't read as banks,
# and the offsets are median-filtered over GKD_BANK_SMOOTH_RAYS neighbouring
# rays (single-ray outliers out) and then Gaussian-smoothed along the shore
# over GKD_BANK_SMOOTH_M. A bank reading flips on and off along a creek edge;
# the median keeps each flip as a hard step, which staked a notched line
# along a straight ditch, so the Gaussian eases the line between the margin
# and the bank top over a few metres instead. Vreta's steep banks peak at
# 12-18 degrees 0.5-2 m from the water and are down to the 3-5 degrees of the
# surrounding ground by 2.5-3.5 m.
DEFAULT_GKD_BANK_MAX_M = 3.0
DEFAULT_GKD_BANK_SLOPE_DEG = 8.0
GKD_BANK_START_M = 2.0
GKD_BANK_RAY_SPACING_M = 0.5
GKD_BANK_STEP_M = 0.25
GKD_SLOPE_SIGMA_M = 0.5
GKD_BANK_SMOOTH_RAYS = 7
GKD_BANK_SMOOTH_M = 3.0
# Hazard lines go in with a node at least every this many metres, so the
# markings GSPro draws between them follow the ground, and are straightened
# only where that moves them less than GKD_HAZARD_TOLERANCE_M (outwards).
DEFAULT_GKD_NODE_SPACING_M = 3.0
GKD_HAZARD_TOLERANCE_M = 0.2
# Water hazard lines that would run closer than this to each other are one
# hazard: two lines a metre apart read as one badly drawn line, and once
# straightened outwards they could cross.
GKD_HAZARD_MERGE_M = 2.0
# Hazard lines must lie strictly inside the course's OOB boundary (GSPro's
# rule): cut this far inside it, so no rounding puts a node on the line.
GKD_OOB_INSET_M = 0.25
# A hazard piece narrower than this after the cut is a sliver along the line, not a hazard.
GKD_MIN_HAZARD_WIDTH_M = 1.0
# A water body whose drawn penalty area(s) hold it gets no line of its own.
# "Hold" allows this much of the water past the drawn line: a hand-drawn
# red/yellow line round a pond clips the shore here and there.
GKD_PENALTY_HOLDS_WATER_M = 1.0
# The OOB rings are long and only need to hold the course: straightened to
# this tolerance (never inwards) and not densified.
DEFAULT_GKD_SIMPLIFY_M = 1.0
# A ring with fewer points than this is a degenerate sliver (a creek clipped
# to a corner of the square, say) and is dropped rather than written.
GKD_MIN_RING_POINTS = 3


class _GkdGround:
    """Terrain height lookup over the square. The export DEM — the same
    GeoTIFF the Unity heightmap was resampled from — read once, voids
    mean-filled like the heightmap's, sampled bilinearly, and returned as a
    Unity y: metres above `min_m`, the terrain's own zero."""

    def __init__(self, dem_path: Path, extent: Extent, min_m: float) -> None:
        with rasterio.open(dem_path) as ds:
            if ds.crs is not None and CRS.from_user_input(ds.crs) != SWEREF99:
                raise SystemExit(f"error: {dem_path} is {ds.crs}, not EPSG:3006")
            b = ds.bounds
            if (b.left - extent[0] > 0.51 or b.bottom - extent[1] > 0.51
                    or extent[2] - b.right > 0.51 or extent[3] - b.top > 0.51):
                raise SystemExit(f"error: {dem_path.name} covers {tuple(round(v) for v in b)}, "
                                 f"which does not hold the square {list(extent)}")
            self._dem = _fill_voids(ds.read(1).astype("float64"))
            self._inv = ~ds.transform
            self._res = abs(ds.transform.a)
        self._min_m = float(min_m)
        self._rows, self._cols = self._dem.shape
        self._slope: "np.ndarray | None" = None

    def _bilinear(self, grid: np.ndarray, xs, ys) -> np.ndarray:
        """`grid` (on the DEM's pixels) sampled bilinearly at EPSG:3006 points."""
        cols, rows = self._inv * (np.asarray(xs, dtype="float64"), np.asarray(ys, dtype="float64"))
        # The affine puts pixel EDGES on whole numbers; the samples sit at
        # their centres, half a pixel in.
        cols, rows = cols - 0.5, rows - 0.5
        c0 = np.clip(np.floor(cols).astype(int), 0, self._cols - 1)
        r0 = np.clip(np.floor(rows).astype(int), 0, self._rows - 1)
        c1, r1 = np.minimum(c0 + 1, self._cols - 1), np.minimum(r0 + 1, self._rows - 1)
        fc, fr = np.clip(cols - c0, 0.0, 1.0), np.clip(rows - r0, 0.0, 1.0)
        top = grid[r0, c0] * (1 - fc) + grid[r0, c1] * fc
        bot = grid[r1, c0] * (1 - fc) + grid[r1, c1] * fc
        return top * (1 - fr) + bot * fr

    def y(self, x: float, y: float) -> float:
        """Unity y (metres above the terrain's zero) at an EPSG:3006 point."""
        return float(self._bilinear(self._dem, [x], [y])[0]) - self._min_m

    def slope_deg(self, xs, ys) -> np.ndarray:
        """Ground slope in degrees at EPSG:3006 points, off the DEM smoothed
        by GKD_SLOPE_SIGMA_M (computed once, on first use)."""
        if self._slope is None:
            from scipy.ndimage import gaussian_filter
            smooth = gaussian_filter(self._dem, GKD_SLOPE_SIGMA_M / self._res)
            gy, gx = np.gradient(smooth, self._res)
            self._slope = np.degrees(np.arctan(np.hypot(gx, gy))).astype("float32")
        return self._bilinear(self._slope, xs, ys)


def _gkd_tee_type(name: str | None, color: str | None, overrides: dict[str, str]) -> str | None:
    """The GKD tee set for one of the app's tees, by its own name first and
    then its colour, or None when neither is one of the eight."""
    for raw in (name, color):
        key = (raw or "").strip().lower()
        if not key:
            continue
        if key in overrides:
            return overrides[key]
        alias = GKD_TEE_ALIASES.get(key)
        if alias in GKD_TEE_TYPES:
            return alias
    return None


def _parse_tee_map(pairs: list[str] | None) -> dict[str, str]:
    """--tee-map "mens tees"=White -> {"mens tees": "White"}."""
    out: dict[str, str] = {}
    for pair in pairs or []:
        raw, _, value = pair.partition("=")
        raw, value = raw.strip().lower(), value.strip()
        match = next((t for t in GKD_TEE_TYPES if t.lower() == value.lower()), None)
        if not raw or match is None:
            raise SystemExit(f"error: --tee-map wants NAME=TEESET, got {pair!r} "
                             f"(tee sets: {', '.join(GKD_TEE_TYPES)})")
        out[raw] = match
    return out


def _gkd_pos(ground: _GkdGround, e0: float, n0: float, x: float, y: float) -> dict:
    """An EPSG:3006 point as a Unity position on the terrain."""
    return {"x": round(x - e0, 4), "y": round(ground.y(x, y), 4), "z": round(y - n0, 4)}


def _gkd_flat(a: dict, b: dict) -> float:
    """Distance between two Unity positions on the ground plane."""
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"])


def _gkd_tee_distance(tee: dict, aims: list[dict], green: dict | None, tee_type: str) -> float:
    """The scorecard distance for one tee: the walk from the tee through the
    hole's aim points to the green centre, on the ground plane.

    An aim point the tee is already past — one no closer to the green than
    the tee itself — drops out, so a forward tee does not walk backwards to a
    dogleg marker meant for the back tees. The Par3 set is the whole course
    played as par 3s, a single shot at the green, so it ignores them all.
    Both rules reproduce the distances in GreenKeeper's own files."""
    if green is None:
        return 0.0
    to_green = _gkd_flat(tee, green)
    route = [] if tee_type == "Par3" else [a for a in aims if _gkd_flat(a, green) < to_green]
    points = [tee, *route, green]
    return sum(_gkd_flat(points[i], points[i + 1]) for i in range(len(points) - 1))


def _gkd_pins(pins: list[dict], place) -> list:
    """The four tournament days for one green. A pin the course named after
    a day takes that day (an app that models pin sheets keeps its own names);
    everything else fills the days left, in the app's order. Days with no pin
    come back as None for the caller to stand in for."""
    days: list = [None] * len(GKD_PIN_DAYS)
    rest: list[dict] = []
    for pin in pins:
        name = (pin.get("name") or "").strip().lower()
        day = next((i for i, d in enumerate(GKD_PIN_DAYS) if d.lower() == name and days[i] is None), None)
        if day is None:
            rest.append(pin)
        else:
            days[day] = place(pin)
    for pin in rest:
        free = next((i for i, taken in enumerate(days) if taken is None), None)
        if free is None:
            break
        days[free] = place(pin)
    return days


def _load_gkd_course(db_path: Path, course_ident: str) -> tuple[sqlite3.Row, list[dict]]:
    """A course and its holes with everything the GKD needs — par, stroke
    index, tees, green centre, pins and aim points — still in WGS84."""
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    holes = [dict(r) for r in conn.execute(
        "SELECT id, number, par, stroke_index FROM holes WHERE course_id = ? ORDER BY number",
        (course["id"],))]
    for hole in holes:
        hole["tees"] = [dict(r) for r in conn.execute(
            "SELECT name, color, lat, lon FROM tees WHERE hole_id = ? ORDER BY sort_order, name",
            (hole["id"],))]
        hole["aims"] = [dict(r) for r in conn.execute(
            "SELECT lat, lon, label FROM aim_points WHERE hole_id = ? ORDER BY sort_order",
            (hole["id"],))]
        green = conn.execute(
            "SELECT id, center_lat, center_lon FROM greens WHERE hole_id = ?", (hole["id"],)).fetchone()
        hole["green"] = dict(green) if green else None
        hole["pins"] = [dict(r) for r in conn.execute(
            "SELECT name, lat, lon FROM pins WHERE green_id = ? ORDER BY active DESC, rowid",
            (green["id"],))] if green else []
    conn.close()
    if not holes:
        raise SystemExit(f"error: course {course['name']} ({course['id']}) has no holes")
    return course, holes


def _load_gkd_outlines(db_path: Path, course_ident: str) -> list[sqlite3.Row]:
    """The course's hazard and OOB features (id, type, geometry_json, hole
    number), in the app's own order."""
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    types = (*GKD_HAZARD_TYPES, GKD_OOB_TYPE)
    rows = conn.execute(
        f"""SELECT f.id, f.type, f.geometry_json, h.number AS hole_number
            FROM course_features f LEFT JOIN holes h ON h.id = f.hole_id
            WHERE f.course_id = ? AND f.type IN ({','.join('?' * len(types))})
            ORDER BY h.number, f.sort_order, f.id""",
        (course["id"], *types)).fetchall()
    conn.close()
    return rows


def _gkd_filled(geom) -> list:
    """Every polygon part of `geom` with its holes filled: a GKD outline is
    one flat point list, so an island inside a pond is inside its hazard (as
    the Rules have it unless the course says otherwise)."""
    from shapely.geometry import Polygon
    from golfpipe.detect_common import _each_polygon

    return [Polygon(p.exterior) for p in _each_polygon(geom) if not p.is_empty]


def _gkd_bank_offsets(pts: np.ndarray, normals: np.ndarray, ground: _GkdGround,
                      margin_m: float, bank_max_m: float, bank_slope_deg: float) -> np.ndarray:
    """How far out from each shore point the hazard line goes: where the bank
    ends along the outward normal, or `margin_m` where there is no bank."""
    steps = np.arange(0.0, bank_max_m + 1e-9, GKD_BANK_STEP_M)
    xs = pts[:, 0, None] + normals[:, 0, None] * steps
    ys = pts[:, 1, None] + normals[:, 1, None] * steps
    steep = ground.slope_deg(xs.ravel(), ys.ravel()).reshape(xs.shape) >= bank_slope_deg
    offsets = np.full(len(pts), margin_m)
    for i, row in enumerate(steep):
        first = int(np.argmax(row))
        if not row[first] or steps[first] > GKD_BANK_START_M:
            continue  # no bank at this spot: steep ground further out is something else
        flat = np.flatnonzero(~row[first:])
        # The first flat sample past the run; a bank that runs off the end
        # of the ray is capped at bank_max_m.
        offsets[i] = steps[first + flat[0]] if flat.size else bank_max_m
    return np.clip(_gkd_smooth_offsets(offsets), margin_m, bank_max_m)


def _gkd_smooth_offsets(offsets: np.ndarray) -> np.ndarray:
    """The raw per-ray bank offsets round a closed shore, steadied."""
    from scipy.ndimage import gaussian_filter1d, median_filter

    if len(offsets) >= GKD_BANK_SMOOTH_RAYS:
        offsets = median_filter(offsets, size=GKD_BANK_SMOOTH_RAYS, mode="wrap")
    if GKD_BANK_SMOOTH_M > 0 and len(offsets) > 1:
        offsets = gaussian_filter1d(offsets, GKD_BANK_SMOOTH_M / GKD_BANK_RAY_SPACING_M, mode="wrap")
    return offsets


def _gkd_water_outline(water, ground: _GkdGround, margin_m: float, bank_max_m: float,
                       bank_slope_deg: float):
    """The area a water hazard line encloses: the water, `margin_m` round it
    everywhere, and out to where the bank ends where it has one. Built as a
    variable-width buffer — a disc of the local offset on every shore sample,
    consecutive discs joined by their convex hull — so a concave shore or a
    narrow channel can't fold the line back over the water."""
    from shapely.geometry import MultiPoint, Point
    from shapely.geometry.polygon import orient
    from shapely.ops import unary_union

    pieces = [water.buffer(margin_m)]
    for poly in _gkd_filled(water):
        ring = orient(poly, 1.0).exterior  # counter-clockwise: outward is to the right
        n = max(int(math.ceil(ring.length / GKD_BANK_RAY_SPACING_M)), GKD_MIN_RING_POINTS)
        pts = np.array([ring.interpolate(i * ring.length / n).coords[0] for i in range(n)])
        tangents = np.roll(pts, -1, axis=0) - np.roll(pts, 1, axis=0)
        tangents /= np.maximum(np.hypot(tangents[:, 0], tangents[:, 1]), 1e-9)[:, None]
        normals = np.column_stack([tangents[:, 1], -tangents[:, 0]])
        offsets = _gkd_bank_offsets(pts, normals, ground, margin_m, bank_max_m, bank_slope_deg)
        discs = [Point(p).buffer(r, quad_segs=4) for p, r in zip(pts, offsets)]
        for i in range(n):
            a, b = discs[i], discs[(i + 1) % n]
            pieces.append(MultiPoint(list(a.exterior.coords) + list(b.exterior.coords)).convex_hull)
    return unary_union(pieces)


def _gkd_densify(coords: list[Pt], spacing_m: float) -> list[Pt]:
    """A closed ring with nodes added so no two are more than `spacing_m`
    apart. On a straight line, so the outline itself does not move."""
    out: list[Pt] = []
    for i, (x0, y0) in enumerate(coords):
        x1, y1 = coords[(i + 1) % len(coords)]
        parts = max(int(math.ceil(math.hypot(x1 - x0, y1 - y0) / spacing_m)), 1)
        out += [(x0 + (x1 - x0) * k / parts, y0 + (y1 - y0) * k / parts) for k in range(parts)]
    return out


def _gkd_ring(outline, must_hold, square, tolerance_m: float, spacing_m: float | None) -> list[list[Pt]]:
    """`outline` as GKD rings: clipped to the square, straightened within
    `tolerance_m` but only ever OUTWARDS, and densified to `spacing_m`.

    Straightening a curve cuts its bends, so the outline is first grown by
    the tolerance and the result checked against `must_hold` — for water
    the water plus its margin, for a drawn line the drawn shape — halving
    the tolerance until nothing of it is cut off. Since GSPro joins the nodes
    with straight lines, that check is on the lines as well as the nodes."""
    from shapely.geometry import Polygon

    rings: list[list[Pt]] = []
    for part in _gkd_filled(outline.intersection(square)):
        hold = must_hold.intersection(part).buffer(-1e-6)
        chosen = part
        t = tolerance_m
        while t >= 0.01 and chosen is part:
            # Straightened as it is when that already holds everything (a
            # drawn line keeps its corners), else grown by t first.
            for base in (part, part.buffer(t)):
                candidate = _gkd_filled(base.simplify(t, preserve_topology=True).intersection(square))
                if len(candidate) == 1 and candidate[0].is_valid and candidate[0].contains(hold):
                    chosen = candidate[0]
                    break
            t /= 2
        coords = [(float(x), float(y)) for x, y, *_ in list(chosen.exterior.coords)[:-1]]
        if spacing_m:
            coords = _gkd_densify(coords, spacing_m)
        if len(coords) >= GKD_MIN_RING_POINTS and Polygon(coords).area > 0:
            rings.append(coords)
    return rings


def _gkd_hazard(coords: list[Pt], ground: _GkdGround, e0: float, n0: float, inner_oob: bool) -> dict:
    """One GKD hazard: a closed outline on the terrain plus the flags GSPro
    plays it by. `noAIL` is set on every water hazard in GreenKeeper's own
    files and cleared on inner-OOB rings, so it is mirrored rather than
    guessed at; drop zones and island greens stay GreenKeeper's to place."""
    return {
        "pointCount": len(coords),
        "coords": [_gkd_pos(ground, e0, n0, x, y) for x, y in coords],
        "DZpos": {"x": 0.0, "y": 0.0, "z": 0.0},
        "freeDrop": False,
        "innerOOB": inner_oob,
        "noAIL": not inner_oob,
        "hasDZ": False,
        "islandGreen": False,
    }


def _gkd_file_boundary(doc: dict, e0: float, n0: float):
    """The course boundary (`pOOB`) already in a GKD, back in EPSG:3006
    metres; None when it has none. GreenKeeper's rings are valid in
    practice, but a self-touching one is repaired to its largest part."""
    from shapely import make_valid
    from shapely.geometry import Polygon

    coords = (doc.get("pOOB") or {}).get("coords") or []
    if len(coords) < GKD_MIN_RING_POINTS:
        return None
    ring = Polygon([(float(c["x"]) + e0, float(c["z"]) + n0) for c in coords])
    if not ring.is_valid:
        parts = _gkd_filled(make_valid(ring))
        ring = max(parts, key=lambda p: p.area) if parts else None
    return ring if ring is not None and ring.area > 0 else None


def _gkd_skeleton(course: sqlite3.Row, scene: str) -> dict:
    """A bare v4.1 GKD for a course GreenKeeper has not described yet: the
    fields the app can fill, and for the rest what GreenKeeper writes for a
    fresh course, to be edited there."""
    return {
        "gkversion": GKD_VERSION,
        "IsArborist": False, "HasAlternateLayouts": False,
        "SceneFolderName": scene, "CourseName": course["name"],
        "Location": "", "CityTown": "", "StateCountyProvince": "", "Country": "",
        "CourseLat": 0.0, "CourseLong": 0.0,
        "Homage": "", "Designer": "", "CourseImageFileName": "splash.jpg",
        "ObjectTextureFileName": "", "DescriptionTxtFileName": "",
        "WindDirectionDefault": 0.0, "WindStrengthDefault": 0,
        "FairwayFirmnessDefault": 0, "GreenFirmnessDefault": 0,
        "DefaultStimp": 2, "MaxStimp": 5, "design": True, "region": 1,
        "CameraDistance": 5000, "AllowNonZeroTeeBoxes": False,
        **{"Keyword" + k: False for k in (
            "BeginnerFriendly", "Coastal", "Desert", "Fantasy", "Heathland", "Historic", "Links",
            "LowPoly", "MajorVenue", "Mountain", "Parkland", "TourStop", "Training", "Tropical")},
        "KeywordsString": "", "BenchMarkComplete": False, "PerformanceScore": 0,
        "unitOfMeasure": 1, "altitude": 0.0, "altitudeV2": 0.0,
        "HasRange": False,
        "RangeTee": {"x": 0.0, "y": 0.0, "z": 0.0}, "RangeAim": {"x": 0.0, "y": 0.0, "z": 0.0},
        "IsMiniGolf": False, "CoursePar": 72,
        **{t + "SR": "0.0/0" for t in (*GKD_TEE_TYPES[:-1], "PAR3")},
        "DifficultyRating": 3.5, "hazardCount": 0, "teeTypeCount": 0,
        "pOOB": {"pointCount": 0, "coords": []}, "CourseInfo": "",
        "Holes": [], "Hazards": [], "TeeTypeTotalDistance": [],
    }


def cmd_gkd(bbox, db_path: Path, course_ident: str, sidecar_path: Path, out: Path,
            dem_path: Path | None = None, template_path: Path | None = None, merge: bool = True,
            extent: Extent | None = None, simplify_m: float = DEFAULT_GKD_SIMPLIFY_M,
            tee_map: dict[str, str] | None = None, altitude: float | None = None,
            water_margin_m: float = DEFAULT_GKD_WATER_MARGIN_M, bank_max_m: float = DEFAULT_GKD_BANK_MAX_M,
            bank_slope_deg: float = DEFAULT_GKD_BANK_SLOPE_DEG,
            node_spacing_m: float = DEFAULT_GKD_NODE_SPACING_M) -> None:
    """Write the GreenKeeper `.GKD` for a course over one terrain square.

    Holes, tees, aim points, green centres and pins come from the app's own
    tables; the penalty areas and the out-of-bounds ring from its drawn
    features (the largest `oob` ring is the course boundary `pOOB`, any other
    is an inner-OOB hazard). Water is staked outside the water — at least
    `water_margin_m`, out to where its bank ends up to `bank_max_m` — and a
    drawn penalty area as drawn; neither line ever cuts inside what it must
    hold. Positions are Unity world metres on that terrain, the heights read
    off the export DEM so they sit on the ground the heightmap built.
    Everything GreenKeeper owns — the course name and location, the
    designer, keywords, slope/rating, the range — is carried over from the
    file being replaced (or --template) untouched."""
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union

    if simplify_m < 0:
        raise SystemExit("error: --simplify must be >= 0")
    if water_margin_m < 0 or bank_max_m < water_margin_m:
        raise SystemExit("error: --water-margin must be >= 0 and --bank-max at least --water-margin")
    if node_spacing_m <= 0:
        raise SystemExit("error: --node-spacing must be > 0")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    sidecar = _read_plot_sidecar(sidecar_path, extent)
    if dem_path is None:
        # The sidecar is written as `<dem>.tif.json`, next to the GeoTIFF the
        # heightmap came from.
        dem_path = sidecar_path.with_suffix("")
    if not dem_path.is_file():
        raise SystemExit(f"error: no such DEM GeoTIFF: {dem_path} (pass --dem)")
    ground = _GkdGround(dem_path, extent, float(sidecar["minM"]))

    course, holes = _load_gkd_course(db_path, course_ident)
    template_path = template_path or (out if merge and out.is_file() else None)
    if template_path is not None:
        if not template_path.is_file():
            raise SystemExit(f"error: no such GKD template: {template_path}")
        doc = json.loads(template_path.read_text(encoding="utf-8"))
    else:
        doc = _gkd_skeleton(course, out.stem)
    old_holes = {h.get("HoleNumber"): h for h in doc.get("Holes") or []}

    outside: list[str] = []
    unmapped: dict[str, int] = {}
    extra_aims = no_green = no_pins = 0

    def place(lat, lon, what: str) -> "dict | None":
        xs, ys = transform_points(WGS84, SWEREF99, [float(lon)], [float(lat)])
        x, y = xs[0], ys[0]
        if not (e0 <= x <= e1 and n0 <= y <= n1):
            outside.append(what)
            return None
        return _gkd_pos(ground, e0, n0, x, y)

    skipped_holes = [h["number"] for h in holes if h["number"] > GKD_HOLE_COUNT]
    by_number = {h["number"]: h for h in holes}
    tee_map = tee_map or {}
    gkd_holes: list[dict] = []
    totals = {t: 0.0 for t in GKD_TEE_TYPES}
    used_tee_types: set[str] = set()

    for number in range(1, GKD_HOLE_COUNT + 1):
        hole = by_number.get(number)
        if hole is None:
            gkd_holes.append(old_holes.get(number)
                             or {"Enabled": False, "HoleNumber": number, "Par": 4, "Index": 0,
                                 "Tees": [], "Pins": []})
            continue
        green = hole["green"]
        centre = place(green["center_lat"], green["center_lon"], f"hole {number} green centre") if green else None
        if centre is None:
            no_green += 1
        aims = [place(a["lat"], a["lon"], f"hole {number} aim point {i + 1}")
                for i, a in enumerate(hole["aims"][:len(GKD_AIM_TYPES)])]
        extra_aims += max(0, len(hole["aims"]) - len(GKD_AIM_TYPES))

        placed: dict[str, dict] = {}
        for tee in hole["tees"]:
            tee_type = _gkd_tee_type(tee["name"], tee["color"], tee_map)
            if tee_type is None:
                label = tee["name"] or tee["color"] or "(unnamed)"
                unmapped[label] = unmapped.get(label, 0) + 1
                continue
            position = place(tee["lat"], tee["lon"], f"hole {number} {tee_type} tee")
            if position is not None and tee_type not in placed:
                placed[tee_type] = position

        tees = []
        for tee_type in GKD_TEE_TYPES:
            position = placed.get(tee_type)
            distance = (_gkd_tee_distance(position, [a for a in aims if a], centre, tee_type)
                        if position is not None else 0.0)
            totals[tee_type] += distance
            if position is not None:
                used_tee_types.add(tee_type)
            tees.append({"TeeType": tee_type, "Enabled": True,
                         "Distance": round(distance, 4), "Position": position})
        for i, name in enumerate(GKD_AIM_TYPES):
            tees.append({"TeeType": name, "Enabled": True, "Distance": 0.0,
                         "Position": aims[i] if i < len(aims) else None})
        # GreenKeeper writes the green centre disabled: it is the hole's
        # measuring point, not somewhere you can play from.
        tees.append({"TeeType": GKD_GREEN_CENTER, "Enabled": False, "Distance": 0.0, "Position": centre})

        pins = _gkd_pins(hole["pins"], lambda p: place(p["lat"], p["lon"], f"hole {number} pin {p['name']}"))
        if not any(pins):
            no_pins += 1
        # A hole still needs four days or GSPro has nowhere to cut: the green
        # centre stands in until the pins are drawn in the app (or moved in
        # GreenKeeper).
        pins = [p or centre or {"x": 0.0, "y": 0.0, "z": 0.0} for p in pins]

        gkd_holes.append({
            "Enabled": True, "HoleNumber": number,
            "Par": int(hole["par"] or 4), "Index": int(hole["stroke_index"] or 0),
            "Tees": tees,
            "Pins": [{"Day": day, "Position": position} for day, position in zip(GKD_PIN_DAYS, pins)],
        })

    square = box(e0, n0, e1, n1)
    hazards: list[dict] = []
    oob_rings: list[list[Pt]] = []
    boundary: "list[Pt] | None" = None
    dropped = covered = beyond = cut = slivers = 0
    waters, penalties = [], []
    for row in _load_gkd_outlines(db_path, course_ident):
        geom = _zone_geometry_m(json.loads(row["geometry_json"]))
        if geom is None or geom.is_empty or not geom.intersects(square):
            dropped += 1
        elif row["type"] in GKD_WATER_TYPES:
            waters.append(geom)
        elif row["type"] in GKD_PENALTY_TYPES:
            penalties.append(unary_union(_gkd_filled(geom)))
        else:
            oob_rings += _gkd_ring(unary_union(_gkd_filled(geom)), geom, square, simplify_m, None)
    inner_oob: list[list[Pt]] = []
    if oob_rings:
        # The course boundary is the ring that holds the golf course; any
        # other `oob` shape is an internal out-of-bounds, which GSPro plays
        # as a hazard with the innerOOB flag.
        oob_rings.sort(key=lambda r: Polygon(r).area, reverse=True)
        boundary, inner_oob = oob_rings[0], oob_rings[1:]

    # Every hazard line lies strictly inside the course boundary: GSPro
    # forbids one on or beyond it, and GreenKeeper misdraws it. The boundary
    # is the drawn ring, else the one already in the file; a hazard is cut
    # GKD_OOB_INSET_M inside it, and one entirely beyond it is left out
    # (out of bounds is out of bounds, water or not).
    held = Polygon(boundary) if boundary else _gkd_file_boundary(doc, e0, n0)
    clip = square if held is None else square.intersection(held.buffer(-GKD_OOB_INSET_M))

    def stake(outline, must_hold, tolerance_m: float, spacing_m: "float | None", inner: bool) -> None:
        nonlocal beyond, cut, slivers
        on_terrain = outline.intersection(square)
        if held is not None:
            if not on_terrain.intersects(clip):
                beyond += 1
                return
            if not clip.contains(on_terrain):
                cut += 1
        # A hazard that only just reaches over the boundary (or the terrain
        # edge) leaves a strip along it after the cut; no player can be in
        # one, and GreenKeeper draws it as a doubled line.
        parts = _gkd_filled(outline.intersection(clip))
        kept = [p for p in parts if not p.buffer(-GKD_MIN_HAZARD_WIDTH_M / 2).is_empty]
        slivers += len(parts) - len(kept)
        for part in kept:
            hazards.extend(_gkd_hazard(r, ground, e0, n0, inner_oob=inner)
                           for r in _gkd_ring(part, must_hold, clip, tolerance_m, spacing_m))

    for area in penalties:
        # Drawn where the line is: in as drawn, never inside it.
        stake(area, area, GKD_HAZARD_TOLERANCE_M, node_spacing_m, inner=False)
    if penalties:
        # A water body the drawn penalty areas already hold is theirs: no
        # second, automatic line round it, however tight the drawn one runs
        # to the shore. Decided per body before the merge below, so a creek
        # running out of a penalty-held pond is staked on its own and does
        # not drag the pond back in.
        drawn = unary_union(penalties).buffer(GKD_PENALTY_HOLDS_WATER_M)
        kept = [w for w in waters if not drawn.contains(w)]
        covered += len(waters) - len(kept)
        waters = kept
    if waters:
        # Water bodies whose lines would meet (a creek running into a pond,
        # a pond drawn in pieces) are staked as one hazard, not overlapping ones.
        wet = unary_union([w.buffer(water_margin_m) for w in waters])
        staked = unary_union([_gkd_water_outline(w, ground, water_margin_m, bank_max_m, bank_slope_deg)
                              for w in waters])
        half = GKD_HAZARD_MERGE_M / 2
        staked = staked.union(staked.buffer(half).buffer(-half))
        for part in _gkd_filled(staked):
            stake(part, wet, GKD_HAZARD_TOLERANCE_M, node_spacing_m, inner=False)
    for ring in inner_oob:
        area = Polygon(ring)
        stake(area, area, simplify_m, None, inner=True)

    doc["Holes"] = gkd_holes
    doc["Hazards"] = hazards
    doc["hazardCount"] = len(hazards)
    doc["teeTypeCount"] = len(used_tee_types)
    doc["TeeTypeTotalDistance"] = [{"TeeType": t, "Enabled": True,
                                    "Distance": round(totals[t], 4), "Position": None}
                                   for t in GKD_TEE_TYPES]
    if boundary is not None:
        doc["pOOB"] = {"pointCount": len(boundary),
                       "coords": [_gkd_pos(ground, e0, n0, x, y) for x, y in boundary]}
    par = sum(h["Par"] for h in gkd_holes if h.get("Enabled"))
    for key in ("CoursePar", "par"):
        if key in doc:
            doc[key] = par
    if altitude is None:
        # The course's own height above sea level, which GSPro thins the air
        # by: the ground under the green centres, back in absolute metres.
        centres = [h["Tees"][-1]["Position"] for h in gkd_holes
                   if h.get("Enabled") and h.get("Tees") and h["Tees"][-1]["Position"]]
        if centres:
            altitude = sum(p["y"] for p in centres) / len(centres) + float(sidecar["minM"])
    if altitude is not None:
        doc["altitudeV2"] = round(float(altitude), 1)

    backup = out.with_suffix(out.suffix + ".bak")
    if out.is_file() and not backup.exists():
        backup.write_bytes(out.read_bytes())
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    played = [h for h in gkd_holes if h.get("Enabled")]
    sets = ", ".join(f"{t} {totals[t]:.0f} m" for t in GKD_TEE_TYPES if t in used_tee_types) or "none"
    print(f"Wrote {out}")
    print(f"  {len(played)} holes, par {par}, on the {e1 - e0:g} m "
          f"{sidecar.get('terrain') or 'terrain'} square from {course['name']} ({course['id']})")
    print(f"  tee sets {sets}")
    print(f"  {len(hazards)} hazards ({sum(1 for h in hazards if h['innerOOB'])} inner OOB, "
          f"{sum(h['pointCount'] for h in hazards)} points), "
          + (f"boundary {len(boundary)} points" if boundary
             else f"no `oob` ring drawn, kept the file's boundary ({doc['pOOB']['pointCount']} points)"
             if (doc.get("pOOB") or {}).get("pointCount") else "NO course boundary (draw an `oob` ring)"))
    print(f"  water staked {water_margin_m:g} m out, to the end of banks steeper than {bank_slope_deg:g} deg "
          f"up to {bank_max_m:g} m; hazard nodes every {node_spacing_m:g} m or closer, OOB within {simplify_m:g} m")
    print(f"  heights from {dem_path.name}, terrain zero {float(sidecar['minM']):.2f} m, "
          f"altitude {doc.get('altitudeV2', 0):.1f} m")
    if template_path is not None:
        print(f"  metadata kept from {template_path.name} (course name, location, keywords, ratings, range)")
    for name, count in sorted(unmapped.items()):
        print(f"  warning: {count} tee(s) named {name!r} are not one of "
              f"{', '.join(GKD_TEE_TYPES)}; skipped (see --tee-map)")
    if no_pins:
        print(f"  warning: {no_pins} hole(s) have no pins; all four days sit on the green centre")
    if no_green:
        print(f"  warning: {no_green} hole(s) have no green centre; their distances are 0")
    if extra_aims:
        print(f"  warning: {extra_aims} aim point(s) past the second dropped (a GKD holds two)")
    if skipped_holes:
        print(f"  warning: hole(s) {', '.join(str(n) for n in skipped_holes)} are past 18 and were left out")
    if dropped:
        print(f"  warning: {dropped} hazard/OOB shape(s) fall outside the square; skipped")
    if covered:
        print(f"  {covered} water hazard(s) left out: a drawn penalty area already holds them")
    if slivers:
        print(f"  {slivers} sliver(s) under {GKD_MIN_HAZARD_WIDTH_M:g} m wide left by the cut dropped")
    if held is None:
        print("  warning: no OOB boundary, drawn or in the file; hazards are not held inside one (GSPro needs them to be)")
    elif beyond or cut:
        print(f"  {beyond} hazard(s) beyond the OOB boundary left out, {cut} cut {GKD_OOB_INSET_M:g} m inside it "
              f"({'the drawn `oob` ring' if boundary else 'the boundary already in the file'})")
    for what in outside:
        print(f"  warning: {what} falls outside the square; left unplaced")


# --- creeks: R.A.M. splines at the water surface ------------------------------

UNITY_CREEKS_FORMAT = "unity-creeks-v1"
CREEK_FEATURE_TYPE = "water_creek"
# NatureManufacture R.A.M. river profile asset a creek gets unless its
# `ramProfile` attribute names another.
DEFAULT_RAM_PROFILE = "Small Stream Profile"
# Spline control points at most this far apart, so the spline's heights follow
# the falling surface between the drawn points.
CREEK_MAX_POINT_SPACING_M = 10.0
# The line derived from a creek polygon is simplified this much before it
# becomes control points.
CREEK_SIMPLIFY_M = 0.5
CREEK_MIN_LENGTH_M = 2.0


def _load_creeks(db_path: Path, course_ident: str) -> tuple[sqlite3.Row, list[sqlite3.Row]]:
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute(
        "SELECT id, geometry_json, attributes_json FROM course_features WHERE course_id = ? AND type = ? ORDER BY sort_order, id",
        (course["id"], CREEK_FEATURE_TYPE),
    ).fetchall()
    conn.close()
    return course, rows


def _densify(points: np.ndarray, max_spacing: float) -> np.ndarray:
    """`points` with evenly spaced ones added wherever two are farther apart
    than `max_spacing`."""
    out = [points[0]]
    for p, q in zip(points[:-1], points[1:]):
        n = int(np.ceil(float(np.hypot(*(q - p))) / max_spacing))
        for i in range(1, n + 1):
            out.append(p + (q - p) * i / n)
    return np.asarray(out)


def cmd_creeks(bbox, db_path: Path, course_ident: str, dem_path: Path, sidecar_path: Path, out: Path,
               extent: Extent | None = None, surface_offset_m: float = 0.0) -> None:
    """Write a unity-creeks-v1 file for the INNER terrain: one R.A.M. spline
    per `water_creek` feature, running downstream, its control points at the
    creek's water surface (golfpipe.creeks.surface_profile over `dem_path`,
    the raw lidar DEM: an edited DEM has the bed dug and would put the water
    on the bed). Points are plot-local Unity coordinates — x east and z north
    from the square's south-west corner, y the height above the heightmap's
    zero (the sidecar's minM, where the inner terrain sits) — plus the width.
    A centerline creek uses its drawn control points (R.A.M. interpolates
    through them the way the editor does); a polygon creek the line down its
    middle (golfpipe.creeks.ribbon_centerline). `ram: false` skips a creek."""
    import rasterio
    from scipy.spatial import cKDTree
    from shapely.geometry import LineString, box

    from golfpipe.creeks import ribbon_centerline, surface_profile
    from golfpipe.detect_common import _each_polygon

    if not sidecar_path.is_file():
        raise SystemExit(f"error: no such heightmap sidecar: {sidecar_path} (export the inner heightmap first)")
    if not dem_path.is_file():
        raise SystemExit(f"error: no such DEM: {dem_path}")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    sq = sidecar.get("square3006")
    if sq and any(abs(a - b) > 0.01 for a, b in zip(sq, extent)):
        raise SystemExit(f"error: the sidecar {sidecar_path.name} is for square {sq}, not {list(extent)}")
    min_m = float(sidecar["minM"])
    with rasterio.open(dem_path) as src:
        if src.crs is None or src.crs.to_epsg() != 3006:
            raise SystemExit(f"error: {dem_path} is not in EPSG:3006")
        dem = src.read(1).astype(np.float64)
        transform = src.transform
        valid = np.isfinite(dem)
        if src.nodata is not None:
            valid &= dem != src.nodata

    course, rows = _load_creeks(db_path, course_ident)
    square = box(e0, n0, e1, n1)
    creeks = []
    skipped: list[str] = []
    for r in rows:
        geometry = json.loads(r["geometry_json"])
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        if not isinstance(attrs, dict):
            attrs = {}
        label = f"creek {r['id']}"
        if attrs.get("ram") is False:
            skipped.append(f"{label}: ram: false")
            continue
        centerline = geometry.get("centerline")
        if centerline and len(centerline.get("points") or []) >= 2:
            line = LineString([(float(p["x"]), float(p["y"])) for p in centerline["points"]])
            width = float(centerline.get("widthM") or 0) or None
            source = "centerline"
        else:
            shape = _zone_geometry_m(geometry)
            polys = sorted(_each_polygon(shape), key=lambda g: g.area, reverse=True) if shape is not None else []
            found = ribbon_centerline(polys[0]) if polys else None
            if found is None:
                skipped.append(f"{label}: no line down its polygon")
                continue
            line, width = found[0].simplify(CREEK_SIMPLIFY_M), found[1]
            source = "polygon"
        clipped = line.intersection(square)
        if clipped.geom_type == "MultiLineString":
            clipped = max(clipped.geoms, key=lambda g: g.length)
        if clipped.is_empty or clipped.geom_type != "LineString" or clipped.length < CREEK_MIN_LENGTH_M:
            skipped.append(f"{label}: outside the inner square")
            continue
        width = width or 2.0
        pts = np.asarray(clipped.coords)[:, :2]
        prof = surface_profile(dem, transform, pts, width, valid=valid)
        if prof is None:
            skipped.append(f"{label}: no DEM under it")
            continue
        if prof.reversed:
            pts = pts[::-1]
        control = _densify(pts, CREEK_MAX_POINT_SPACING_M)
        _, station = cKDTree(np.column_stack([prof.x, prof.y])).query(control)
        z = np.minimum.accumulate(prof.z[station])
        creeks.append({
            "id": f"feature:{r['id']}",
            "profile": str(attrs.get("ramProfile") or DEFAULT_RAM_PROFILE),
            "widthM": round(width, 2),
            "lengthM": round(float(prof.s[-1]), 1),
            "fallM": round(float(z[0] - z[-1]), 2),
            "source": source,
            "points": [[round(float(x - e0), 3), round(float(h - min_m + surface_offset_m), 3), round(float(y - n0), 3), round(width, 2)]
                       for (x, y), h in zip(control, z)],
        })
    doc = {
        "format": UNITY_CREEKS_FORMAT,
        "plot": {
            "crs": "EPSG:3006", "terrain": "inner", "originX": e0, "originY": n0, "sizeM": e1 - e0,
            "minM": min_m, "maxM": float(sidecar["maxM"]),
        },
        "creeks": creeks,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    print(f"  wrote {out}  ({len(creeks)} creek(s) for {course['name']}: "
          f"{sum(1 for c in creeks if c['source'] == 'centerline')} drawn as centerlines, "
          f"{sum(1 for c in creeks if c['source'] == 'polygon')} from polygons; "
          f"{sum(c['lengthM'] for c in creeks):.0f} m, surface from {dem_path.name})")
    for line in skipped:
        print(f"  skipped {line}")


# --- CLI --------------------------------------------------------------------

def _add_bbox(p: argparse.ArgumentParser) -> None:
    _add_area(p)
    p.add_argument("--size", type=int, default=DEFAULT_SIZE, help=f"output edge in px (default {DEFAULT_SIZE})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gspro", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("ortho", help="render the 2 newest orthophoto vintages to square JPEGs")
    _add_bbox(p)
    p.add_argument("--out-dir", help="directory to write ortho_<vintage>_<size>px.jpg into")
    p.add_argument("--out", help="exact output JPEG path; only with a single --ortho source")
    p.add_argument("--count", type=int, default=2, help="how many recent vintages to render (default 2)")
    p.add_argument("--ortho", nargs="+", help="render from these existing ortho GeoTIFFs (e.g. data/sources/<id>/ortho-*.tif) instead of fetching")
    p.add_argument("--quality", type=int, default=DEFAULT_JPEG_QUALITY,
                   help=f"JPEG quality 1..100 (default {DEFAULT_JPEG_QUALITY})")
    p.add_argument("--terrain-out", dest="terrain_out",
                   help="also write the same render darkened for use as the Unity terrain texture (with --out)")
    p.add_argument("--darken", type=float, default=DEFAULT_TERRAIN_DARKEN,
                   help=f"light multiplier for --terrain-out (default {DEFAULT_TERRAIN_DARKEN:g})")
    p.add_argument("--darken-space", dest="darken_space", choices=["linear", "srgb"], default=DEFAULT_DARKEN_SPACE,
                   help=f"multiply in linear light (default) or on the sRGB values")
    p.add_argument("--tint-out", dest="tint_out",
                   help="also write the --terrain-out twin with the course's grass surfaces tinted "
                        "(the Photoshop overlay step, from the app's drawn features; needs --tint-course)")
    p.add_argument("--tint-course", dest="tint_course", help="course id, or a name substring, whose features mask the tint")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database for --tint-course (default {DEFAULT_DB})")
    p.add_argument("--tint-color", dest="tint_color", default=DEFAULT_TINT_COLOR,
                   help=f"tint colour for the grass types and undrawn ground (default {DEFAULT_TINT_COLOR})")
    p.add_argument("--darken-tint", dest="darken_tint", action="store_true",
                   help="--tint-out: put the grass/ground tint colours under --darken too, so the tinted file is as "
                        "dark as the --terrain-out twin instead of lifted by the tint (for the outer terrain)")
    p.add_argument("--tint-opacity", dest="tint_opacity", type=float, default=DEFAULT_TINT_OPACITY,
                   help=f"tint layer opacity 0..1 (default {DEFAULT_TINT_OPACITY:g})")
    p.add_argument("--soften-m", dest="soften_m", type=float, default=DEFAULT_SOFTEN_M,
                   help=f"--tint-out: drop photo detail finer than this many metres, except on the masked surfaces "
                        f"(default {DEFAULT_SOFTEN_M:g}; 0 = keep the photo sharp)")
    p.add_argument("--tint-size", dest="tint_size", type=int, default=None,
                   help=f"--tint-out: edge of that file in px (default {DEFAULT_TINT_SIZE}, or --size when smaller)")
    p.add_argument("--tint-grade", dest="tint_grade", metavar="R,G,B",
                   help="--tint-out: per-channel multipliers on the finished file, in linear light — to make a terrain "
                        "render like the course meshes next to it (e.g. 0.61,0.82,0.35)")
    p.add_argument("--tint", action="append", metavar="TYPE=SPEC",
                   help="per-type override: TYPE=#rrggbb, TYPE=@0.2, TYPE=#rrggbb@0.2 or TYPE=none to mask it off "
                        f"(repeatable; tinted by default: {', '.join(TINT_TYPES)} and {TINT_GROUND} = whatever isn't drawn; masked: {', '.join(TINT_MASK_TYPES)}; "
                        f"water layer: {', '.join(TINT_WATER_TYPES)})")
    p.add_argument("--water-color", dest="water_color", default=DEFAULT_WATER_COLOR,
                   help=f"tint colour for water bodies and creeks (default {DEFAULT_WATER_COLOR}, a dark brown)")
    p.add_argument("--water-opacity", dest="water_opacity", type=float, default=DEFAULT_WATER_OPACITY,
                   help=f"water layer opacity 0..1 (default {DEFAULT_WATER_OPACITY:g})")
    p.add_argument("--water-feather", dest="water_feather", type=float, default=DEFAULT_WATER_FEATHER_M,
                   help=f"shoreline fade width in metres, symmetric about the drawn edge (default {DEFAULT_WATER_FEATHER_M:g})")
    p.add_argument("--floor-course", dest="floor_course",
                   help="course id or name substring: paint its woodland_floor zones as forest floor on every file "
                        f"(keeps its {', '.join(FLOOR_KEEP_TYPES)} as photographed; uses --db)")
    p.add_argument("--floor-color", dest="floor_color",
                   help="palette forest-floor colour #rrggbb (default a moss and litter brown-green)")
    p.add_argument("--floor-mix", dest="floor_mix", type=float,
                   help="how much of each zone's own floorColor goes into --floor-color, 0..1 (default 0.5)")
    p.add_argument("--floor-feather", dest="floor_feather", type=float,
                   help="metres over which the floor fades in from a zone's outline (default 3)")
    p.add_argument("--floor-seed", dest="floor_seed", type=int, default=0, help="forest-floor noise seed (default 0)")
    p.add_argument("--remove-buildings", dest="remove_buildings", action="store_true",
                   help="fill the roofs and their shadows from the ground round them on every file "
                        "(the roofs from --roofs and/or --buildings-survey)")
    p.add_argument("--roofs", help="--remove-buildings: roof heights GeoTIFF (golfpipe canopy --roofs-out)")
    p.add_argument("--buildings-survey", dest="buildings_survey",
                   help="--remove-buildings: building survey GeoJSON (golfpipe fetch-buildings); catches buildings "
                        "newer than the lidar")
    p.add_argument("--shadow-azimuth", dest="shadow_azimuth", type=float,
                   help="--remove-buildings: compass direction the shadows fall toward (default: measured from the photo)")
    p.add_argument("--shadow-ratio", dest="shadow_ratio", type=float,
                   help="--remove-buildings: shadow length per metre of height (default: measured from the photo)")

    p = sub.add_parser("hillshade", help="render a square hillshade JPEG from a DEM or lidar")
    _add_bbox(p)
    p.add_argument("--out", required=True, help="output JPEG path")
    p.add_argument("--dem", help="existing DEM GeoTIFF; if omitted, lidar is fetched + gridded for --bbox")
    p.add_argument("--azimuth", type=float, default=315.0, help="light azimuth degrees (default 315, QGIS default)")
    p.add_argument("--altitude", type=float, default=45.0, help="light altitude degrees (default 45)")
    p.add_argument("--z-factor", type=float, default=1.0, dest="z_factor", help="vertical exaggeration (default 1)")
    p.add_argument("--resolution", type=float, default=grid_dem_mod.DEFAULT_RESOLUTION,
                   help="lidar grid cell size in m when building a DEM (default 0.5)")

    p = sub.add_parser("dem", help="clip a DEM to the square as a float32 EPSG:3006 GeoTIFF + Unity .raw heightmap (+ .json sidecar)")
    _add_area(p)
    p.add_argument("--dem", required=True, help="DEM GeoTIFF to clip (e.g. data/sources/<id>/dem.tif or outer-dem.tif)")
    p.add_argument("--out", required=True,
                   help="output GeoTIFF path; the <stem>.raw heightmap and a <out>.json sidecar are written next to it")
    p.add_argument("--resolution", type=float, default=DEFAULT_DEM_RESOLUTION,
                   help=f"output cell size in m (default {DEFAULT_DEM_RESOLUTION:g}); the side must be a whole number of cells")
    p.add_argument("--raw-size", type=int, default=UNITY_HEIGHTMAP_RESOLUTION, dest="raw_size",
                   help=f"Unity heightmap edge in px for the .raw (default {UNITY_HEIGHTMAP_RESOLUTION}; 0 = no .raw)")
    p.add_argument("--terrain", choices=["inner", "outer"],
                   help="which GSPro terrain this is (recorded in the sidecar; inner gets position 0,0,0)")
    p.add_argument("--inner-sidecar", dest="inner_sidecar",
                   help="the inner export's .tif.json — for an OUTER export, adds the outer terrain's Unity position")
    p.add_argument("--sculpt", action="append",
                   help="a Unity sculpt layer GeoTIFF the DEM contains (repeatable): writes <stem>-sculpt-in.raw + the sidecar's sculptIn")

    p = sub.add_parser("trees", help="write the unity-trees-v1 file for one terrain from a tree-stems asset")
    _add_area(p)
    p.add_argument("--stems", required=True, help="tree-stems.json (golfpipe trees-stems compact asset)")
    p.add_argument("--sidecar", required=True, help="the terrain's heightmap sidecar (<dem>.tif.json) for the height range")
    p.add_argument("--out", required=True, help="output unity-trees-v1 JSON path")
    p.add_argument("--terrain", choices=["inner", "outer"], help="which GSPro terrain (default: the sidecar's)")
    p.add_argument("--exclude-square", dest="exclude_square",
                   help="x0,y0,x1,y1 in EPSG:3006 to leave out — the inner square when writing the outer's trees")

    p = sub.add_parser("buildings", help="write the unity-buildings-v1 file for one terrain from a fetch-buildings survey")
    _add_area(p)
    p.add_argument("--survey", required=True, help="buildings.geojson (golfpipe fetch-buildings output)")
    p.add_argument("--sidecar", required=True, help="the terrain's heightmap sidecar (<dem>.tif.json) for the height range")
    p.add_argument("--out", required=True, help="output unity-buildings-v1 JSON path")
    p.add_argument("--terrain", choices=["inner", "outer"], help="which GSPro terrain (default: the sidecar's)")
    p.add_argument("--exclude-square", dest="exclude_square",
                   help="x0,y0,x1,y1 in EPSG:3006 to leave out — the inner square when writing the outer's buildings")

    p = sub.add_parser("zones", help="rasterize a course's vegetation zones into VSPro texture masks (one channel per item) + unity-zones-v2 JSON for one terrain")
    _add_area(p)
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")
    p.add_argument("--course", required=True, help="course id, or a name substring (e.g. Vreta)")
    p.add_argument("--sidecar", required=True, help="the terrain's heightmap sidecar (<dem>.tif.json) for the height range")
    p.add_argument("--out", required=True, help="output unity-zones-v2 JSON path; the masks go next to it as <stem>-<texture>.png")
    p.add_argument("--terrain", choices=["inner", "outer"], help="which GSPro terrain (default: the sidecar's)")
    p.add_argument("--exclude-square", dest="exclude_square",
                   help="x0,y0,x1,y1 in EPSG:3006 to leave out — the inner square when writing the outer's zones")
    p.add_argument("--resolution", type=int, default=DEFAULT_ZONE_RESOLUTION,
                   help=f"mask edge in px (default {DEFAULT_ZONE_RESOLUTION}; 0.5 m/px on a 2050 m square)")
    p.add_argument("--simplify", type=float, default=DEFAULT_ZONE_SIMPLIFY_M,
                   help=f"tolerance in metres for the exported overlay polygons (default {DEFAULT_ZONE_SIMPLIFY_M:g}; the masks are unaffected)")
    p.add_argument("--seed", type=int, default=DEFAULT_ZONE_SEED,
                   help=f"random seed for the edge noise of zones with noise > 0 (default {DEFAULT_ZONE_SEED})")

    p = sub.add_parser("zones-patch", help="re-rasterize only the part of an exported terrain's zone masks that some zones cover (now and in that export) and update its zones JSON")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")
    p.add_argument("--course", required=True, help="course id, or a name substring (e.g. Vreta)")
    p.add_argument("--zones-json", dest="zones_json", required=True,
                   help="the terrain's unity-zones-v2 export (written by `zones`); its PNGs next to it are patched in place")
    p.add_argument("--ids", required=True, help="comma-separated vegetation_zone feature ids to update")
    p.add_argument("--exclude-square", dest="exclude_square",
                   help="x0,y0,x1,y1 in EPSG:3006 — the inner square when patching the outer's masks")
    p.add_argument("--result", help="write the unity-zones-patch-v1 record (changed textures, region) here")

    p = sub.add_parser("creeks", help="write a course's creeks as R.A.M. splines at the water surface (unity-creeks-v1) for the inner terrain")
    _add_area(p)
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")
    p.add_argument("--course", required=True, help="course id, or a name substring (e.g. Vreta)")
    p.add_argument("--dem", required=True, help="the RAW lidar DEM (sources/<site>/dem.tif): an edited one has the creek beds dug")
    p.add_argument("--sidecar", required=True, help="the inner terrain's heightmap sidecar (<dem>.tif.json) — the square and the terrain's zero")
    p.add_argument("--out", required=True, help="output unity-creeks-v1 JSON path")
    p.add_argument("--surface-offset", dest="surface_offset", type=float, default=0.0,
                   help="metres to raise (or lower, negative) every spline above the sampled water surface (default 0)")

    p = sub.add_parser("gkd", help="write the GreenKeeper .GKD (tees, pins, green centres, aim points, hazards, OOB) for a course")
    _add_area(p)
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")
    p.add_argument("--course", required=True, help="course id, or a name substring (e.g. Vreta)")
    p.add_argument("--sidecar", required=True,
                   help="the INNER terrain's heightmap sidecar (<dem>.tif.json) — the square and the terrain's zero")
    p.add_argument("--out", required=True,
                   help="the course's .GKD in the GSPro scene folder; it is merged in place and backed up as .GKD.bak")
    p.add_argument("--dem", help="DEM GeoTIFF to read heights from (default: the sidecar's own .tif)")
    p.add_argument("--template", help="GKD whose course metadata to keep (default: the --out file itself)")
    p.add_argument("--no-merge", dest="merge", action="store_false",
                   help="start from a bare GreenKeeper v4.1 file instead of the one at --out")
    p.add_argument("--simplify", type=float, default=DEFAULT_GKD_SIMPLIFY_M,
                   help=f"how far in metres the OOB rings may be straightened, outwards only (default {DEFAULT_GKD_SIMPLIFY_M:g})")
    p.add_argument("--water-margin", dest="water_margin", type=float, default=DEFAULT_GKD_WATER_MARGIN_M,
                   help=f"least distance in metres between the water and its hazard line, nodes and the lines "
                        f"between them (default {DEFAULT_GKD_WATER_MARGIN_M:g})")
    p.add_argument("--bank-max", dest="bank_max", type=float, default=DEFAULT_GKD_BANK_MAX_M,
                   help=f"furthest in metres the line goes out to follow a bank (default {DEFAULT_GKD_BANK_MAX_M:g})")
    p.add_argument("--bank-slope", dest="bank_slope", type=float, default=DEFAULT_GKD_BANK_SLOPE_DEG,
                   help=f"ground steeper than this many degrees next to the water is its bank "
                        f"(default {DEFAULT_GKD_BANK_SLOPE_DEG:g})")
    p.add_argument("--node-spacing", dest="node_spacing", type=float, default=DEFAULT_GKD_NODE_SPACING_M,
                   help=f"most metres between two hazard nodes (default {DEFAULT_GKD_NODE_SPACING_M:g})")
    p.add_argument("--tee-map", dest="tee_map", action="append", metavar="NAME=TEESET",
                   help=f"map one of the course's tee names or colours onto a GKD tee set "
                        f"(repeatable; sets: {', '.join(GKD_TEE_TYPES)})")
    p.add_argument("--altitude", type=float,
                   help="course altitude in metres above sea level (default: the ground under the green centres)")

    p = sub.add_parser("svg", help="export a course's drawn features as a layered GSPro/OPCD SVG")
    _add_area(p)
    p.add_argument("--out", required=True, help="output SVG path")
    p.add_argument("--course", required=True, help="course id, or a name substring (e.g. Vreta)")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")
    p.add_argument("--flatten", type=float, metavar="TOL_M",
                   help="emit polylines instead of cubic beziers, within TOL_M metres of the curve")
    p.add_argument("--precision", type=int, default=3, help="decimals in path coordinates, in metres (default 3)")
    p.add_argument("--stack", choices=["opcd", "app"], default="opcd",
                   help="paint order inside a layer: 'opcd' (default) keeps the app's order but "
                        "lifts green/tee/bunker to the top, or 'app' to keep it verbatim")
    p.add_argument("--map", action="append", metavar="TYPE=SURFACE",
                   help="give a feature type a fill: --map trees=pinestraw (an OPCD palette name) "
                        "or --map trees=#b84127 (repeatable)")
    p.add_argument("--exclude-ids", dest="exclude_ids", metavar="FILE",
                   help="leave out the features listed in FILE (a JSON array of ids, or one id per line) "
                        "- for test variants of the SVG; a road's kerb fillets go with it")
    p.add_argument("--exclude-type", dest="exclude_type", action="append", metavar="TYPE",
                   help="leave out every feature of TYPE, e.g. --exclude-type path (repeatable)")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    argv = sys.argv[1:] if argv is None else argv
    if not argv:  # no arguments → show help
        parser.print_help()
        return 0

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0

    _load_dotenv()
    if args.command == "zones-patch":
        cmd_zones_patch(Path(args.db), args.course, Path(args.zones_json),
                        [i.strip() for i in args.ids.split(",") if i.strip()],
                        Path(args.result) if args.result else None,
                        _parse_square(args.exclude_square) if args.exclude_square else None)
        return 0
    bbox, extent = _resolve_area(args)

    if args.command == "ortho":
        cmd_ortho(bbox, Path(args.out_dir) if args.out_dir else None, args.size, args.count,
                  [Path(p) for p in args.ortho] if args.ortho else None,
                  args.quality, Path(args.out) if args.out else None, extent=extent,
                  terrain_out=Path(args.terrain_out) if args.terrain_out else None, darken=args.darken,
                  darken_space=args.darken_space,
                  tint_out=Path(args.tint_out) if args.tint_out else None, tint_course=args.tint_course,
                  db_path=Path(args.db),
                  tints=_parse_tints(args.tint, args.tint_color, args.tint_opacity, args.water_color, args.water_opacity),
                  water_feather_m=args.water_feather, soften_m=args.soften_m, tint_size=args.tint_size,
                  darken_tint=args.darken_tint, tint_grade=_parse_grade(args.tint_grade),
                  floor_course=args.floor_course, floor_color=args.floor_color, floor_mix=args.floor_mix,
                  floor_feather_m=args.floor_feather, floor_seed=args.floor_seed,
                  remove_buildings=args.remove_buildings, roofs=Path(args.roofs) if args.roofs else None,
                  buildings_survey=Path(args.buildings_survey) if args.buildings_survey else None,
                  shadow_azimuth=args.shadow_azimuth, shadow_ratio=args.shadow_ratio)
    elif args.command == "hillshade":
        cmd_hillshade(
            bbox, Path(args.out), args.size,
            Path(args.dem) if args.dem else None,
            args.azimuth, args.altitude, args.z_factor, args.resolution, extent=extent,
        )
    elif args.command == "dem":
        cmd_dem(bbox, Path(args.dem), Path(args.out), args.resolution, extent=extent,
                raw_size=args.raw_size, terrain=args.terrain,
                inner_sidecar=Path(args.inner_sidecar) if args.inner_sidecar else None,
                sculpt=[Path(p) for p in args.sculpt] if args.sculpt else None)
    elif args.command == "trees":
        cmd_trees(bbox, Path(args.stems), Path(args.sidecar), Path(args.out), args.terrain,
                  _parse_square(args.exclude_square) if args.exclude_square else None, extent=extent)
    elif args.command == "buildings":
        cmd_buildings(bbox, Path(args.survey), Path(args.sidecar), Path(args.out), args.terrain,
                      _parse_square(args.exclude_square) if args.exclude_square else None, extent=extent)
    elif args.command == "zones":
        cmd_zones(bbox, Path(args.db), args.course, Path(args.sidecar), Path(args.out), args.terrain,
                  _parse_square(args.exclude_square) if args.exclude_square else None, extent=extent,
                  resolution=args.resolution, simplify_m=args.simplify, seed=args.seed)
    elif args.command == "creeks":
        cmd_creeks(bbox, Path(args.db), args.course, Path(args.dem), Path(args.sidecar), Path(args.out),
                   extent=extent, surface_offset_m=args.surface_offset)
    elif args.command == "gkd":
        cmd_gkd(bbox, Path(args.db), args.course, Path(args.sidecar), Path(args.out),
                Path(args.dem) if args.dem else None,
                Path(args.template) if args.template else None, args.merge, extent=extent,
                simplify_m=args.simplify, tee_map=_parse_tee_map(args.tee_map), altitude=args.altitude,
                water_margin_m=args.water_margin, bank_max_m=args.bank_max, bank_slope_deg=args.bank_slope,
                node_spacing_m=args.node_spacing)
    elif args.command == "svg":
        cmd_svg(bbox, Path(args.out), Path(args.db), args.course,
                args.flatten, args.precision, _parse_map(args.map), args.stack, extent=extent,
                exclude_ids=_read_exclude_ids(Path(args.exclude_ids) if args.exclude_ids else None),
                exclude_types=set(args.exclude_type or []))
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
