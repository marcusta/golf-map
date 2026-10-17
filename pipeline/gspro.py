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
             terrain square. Merges into the existing .GKD: the course details
             the app keeps (name, location, designer, description, keywords)
             and its tee sets' ratings go into the header, the rest of it
             stays GreenKeeper's.
  holes      Write a course's tees, aim points and green centres (EPSG:3006)
             for the Unity hole navigator.
  svg      Export a course's drawn features from the app database as a
             layered, fill-only SVG in the GSPro/OPCD trace palette: one
             Inkscape layer per hole, shapes named <type>_<n>, fills from
             the OPCD v4 palette.
  batch      Run several of these commands in ONE process from a JSON job
             list (--jobs <file>, or stdin), each job's arguments exactly as
             the command takes them on the command line. They share the
             database connection, the course's loaded and flattened features
             and the DEM reads, so an export that was five processes pays for
             the interpreter, the imports and that work once. --result writes
             a per-job report; the exit code is 0 only when every job
             succeeded.
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

import zlib
import argparse
import contextlib
import copy as copy_mod
import io
import html
import json
import math
import os
import re
import sqlite3
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import shapely
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
    source does not cover comes back NaN — `_fill_voids` deals with those.

    Inside a `batch` the result is kept per (file, extent, size, bands,
    dtype, resampling), so two jobs asking the same raster for the same grid
    resample it once; the caller always gets its own array to work on."""
    cache = _BATCH
    if cache is None or not src_path.is_file():
        return _reproject_square_now(src_path, extent, size, bands, dtype, resampling)
    key = (_file_key(src_path), tuple(extent), size, tuple(bands), np.dtype(dtype).str, int(resampling))
    return cache.cached("demWindows", key,
                        lambda: _reproject_square_now(src_path, extent, size, bands, dtype, resampling),
                        sizeof=lambda a: a.nbytes, copy=np.ndarray.copy)


def _reproject_square_now(src_path: Path, extent: tuple[float, float, float, float], size: int,
                          bands: list[int], dtype, resampling: Resampling) -> np.ndarray:
    e0, n0, e1, n1 = extent
    dst_transform = from_bounds(e0, n0, e1, n1, size, size)
    floating = np.issubdtype(np.dtype(dtype), np.floating)
    out = np.full((len(bands), size, size), np.nan if floating else 0, dtype=dtype)
    with rasterio.open(src_path) as src:
        nodata_kw = {"src_nodata": src.nodata, "dst_nodata": np.nan} if floating else {}
        # All bands in one warp on every core: band by band on one thread the
        # 8192 px ortho took 27 s of its 66 s export, the source read three times.
        reproject(
            source=rasterio.band(src, bands),
            destination=out,
            src_crs=src.crs, src_transform=src.transform,
            dst_crs=SWEREF99, dst_transform=dst_transform,
            resampling=resampling, num_threads=os.cpu_count() or 1, **nodata_kw,
        )
    return out


def _safe(name: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name or "unknown")


# --- One process, several jobs: the batch cache ------------------------------
# `batch` (cmd_batch) runs several commands in one interpreter. What each of
# them would otherwise redo — opening the database, loading and flattening the
# course's features, resampling and reading the DEM, parsing a sidecar — is
# kept here while that batch runs and thrown away when it ends. A one-shot CLI
# run has no cache (`_BATCH is None`) and does exactly what it always did.
#
# Only what cannot change while the batch runs goes in, and everything keyed on
# a file carries that file's mtime and size, so the job that rewrites a DEM
# invalidates every reader of the old one instead of being served it.

# The slots, in the order `shared` reports them.
_BATCH_SLOTS = ("db", "features", "shapes", "courseShapes", "demWindows", "demBands", "sidecars")
# How big one cached value may be, per slot, and how much the whole cache may
# hold. A whole DEM band is the one big thing worth keeping — `creeks` and
# `gkd` each read a 4100² DEM, and `gkd`'s is the one `dem` just wrote (134 MB
# as float64) — while a resampled window is cheap to redo and an 8192² ortho
# window (200 MB) would cost more memory than it saves time.
BATCH_VALUE_MAX_BYTES = {"demBands": 320 << 20, "demWindows": 96 << 20}
BATCH_VALUE_DEFAULT_MAX_BYTES = 128 << 20
BATCH_BUDGET_BYTES = 1 << 30


class _SharedConnection(sqlite3.Connection):
    """A batch's read-only connection to one database, shared by every job:
    `close()` does nothing, because each command closes what it believes it
    opened, and the batch closes it for real when it ends."""

    def close(self) -> None:
        pass

    def close_for_real(self) -> None:
        sqlite3.Connection.close(self)


class _BatchCache:
    """What the jobs of one batch share. `cached` is the only way in: a miss
    builds the value, and it is kept only while the cache stays inside its
    budget — so a huge raster window is still handed back, just not held."""

    def __init__(self) -> None:
        self.conns: dict[str, _SharedConnection] = {}
        self.slots: dict[str, dict] = {slot: {} for slot in _BATCH_SLOTS}
        self.counts: dict[str, list[int]] = {slot: [0, 0] for slot in _BATCH_SLOTS}
        self.bytes = 0

    def cached(self, slot: str, key, build, *, sizeof=None, copy=None):
        """The value for `key` in `slot`, from `build()` on a miss. `sizeof`
        measures a big value against the budget; `copy` is applied on the way
        in and out when the caller may change what it gets.

        The budget is decided BEFORE the copy: a value the cache will not keep
        is handed over as it was built, so an 8192² ortho window (200 MB, over
        the `demWindows` budget) is never duplicated just to be dropped."""
        store = self.slots[slot]
        hit = key in store
        self.counts[slot][0 if hit else 1] += 1
        if hit:
            value = store[key]
            return copy(value) if copy is not None else value
        value = build()
        size = sizeof(value) if sizeof is not None else 0
        if self.fits(slot, size):
            self.put(slot, key, copy(value) if copy is not None else value, size)
        return value

    def fits(self, slot: str, size: int) -> bool:
        """Whether a value of `size` bytes may be kept: inside the slot's own
        limit and inside what the whole cache may hold."""
        return (size <= BATCH_VALUE_MAX_BYTES.get(slot, BATCH_VALUE_DEFAULT_MAX_BYTES)
                and self.bytes + size <= BATCH_BUDGET_BYTES)

    def put(self, slot: str, key, value, size: int = 0) -> None:
        """Keep `value` under `key` unless it busts the slot's or the whole
        cache's budget — a value too big is still handed back, just not held."""
        if self.fits(slot, size):
            self.slots[slot][key] = value
            self.bytes += size

    def connection(self, path: Path) -> _SharedConnection:
        key = str(path.resolve())
        conn = self.conns.get(key)
        self.counts["db"][0 if conn is not None else 1] += 1
        if conn is None:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, factory=_SharedConnection)
            conn.row_factory = sqlite3.Row
            self.conns[key] = conn
        return conn

    def stats(self) -> dict:
        """The `shared` block of the batch result: hits and misses per slot."""
        out: dict = {slot: {"hits": h, "misses": m} for slot, (h, m) in self.counts.items()}
        out["bytes"] = self.bytes
        return out

    def close(self) -> None:
        for conn in self.conns.values():
            conn.close_for_real()
        self.conns.clear()
        for store in self.slots.values():
            store.clear()
        self.bytes = 0


_BATCH: "_BatchCache | None" = None


def _file_key(path: Path) -> tuple:
    """A cache key for a file's contents as they are now: the resolved path,
    the mtime in nanoseconds and the size. A job that rewrites the file (the
    DEM `dem` writes and `gkd` then reads) gets a new key, never a stale hit."""
    st = path.stat()
    return (str(path.resolve()), st.st_mtime_ns, st.st_size)


def _read_sidecar_json(path: Path) -> dict:
    """A heightmap sidecar parsed; cached per file inside a batch, and the
    caller always gets its own copy."""
    cache = _BATCH
    if cache is None or not path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return cache.cached("sidecars", _file_key(path),
                        lambda: json.loads(path.read_text(encoding="utf-8")), copy=copy_mod.deepcopy)


@dataclass(eq=False)
class _DemBand:
    """Band 1 of a DEM GeoTIFF read whole — what `gkd` and `creeks` each do
    over the same square. `values` is as stored (float64); `filled` is
    `_fill_voids` of it and `valid` the finite, non-nodata cells, computed on
    first use because one reader wants the one and one the other. Readers
    treat all three as read-only: inside a batch they are shared."""

    values: np.ndarray
    transform: object
    crs: object
    nodata: "float | None"
    bounds: tuple[float, float, float, float]
    filled_in: "np.ndarray | None" = None
    valid_in: "np.ndarray | None" = None

    @property
    def filled(self) -> np.ndarray:
        if self.filled_in is None:
            self.filled_in = _fill_voids(self.values)
        return self.filled_in

    @property
    def valid(self) -> np.ndarray:
        if self.valid_in is None:
            ok = np.isfinite(self.values)
            if self.nodata is not None:
                ok = ok & (self.values != self.nodata)
            self.valid_in = ok
        return self.valid_in


def _band_bounds(transform, shape) -> tuple[float, float, float, float]:
    """(left, bottom, right, top) of a raster band, as `rasterio` reports a
    dataset's `bounds`."""
    rows, cols = shape
    return tuple(rasterio.transform.array_bounds(rows, cols, transform))  # type: ignore[return-value]


def _read_dem_band(path: Path) -> _DemBand:
    """Band 1 of a DEM GeoTIFF, read whole and cached per file inside a batch
    (`creeks` and `gkd` read the same DEM the `dem` job just wrote)."""
    def build() -> _DemBand:
        with rasterio.open(path) as ds:
            return _DemBand(values=ds.read(1).astype("float64"), transform=ds.transform, crs=ds.crs,
                            nodata=ds.nodata,
                            bounds=(ds.bounds.left, ds.bounds.bottom, ds.bounds.right, ds.bounds.top))

    cache = _BATCH
    if cache is None or not path.is_file():
        return build()   # the callers check for the file first; let rasterio say it
    return cache.cached("demBands", _file_key(path), build, sizeof=lambda b: b.values.nbytes)


def _publish_dem_band(path: Path, values: np.ndarray, transform, crs, nodata=None,
                      voids_filled: bool = False) -> None:
    """Hand a raster this process has just written to the batch cache, keyed
    exactly as `_read_dem_band` keys the file — so the next job reading it
    back (`gkd` over the DEM `dem` wrote) takes it from memory. Nothing but
    this very file's bytes can be found under that key."""
    cache = _BATCH
    if cache is None or not path.is_file():
        return
    band = _DemBand(values=np.asarray(values, dtype="float64"), transform=transform, crs=crs,
                    nodata=nodata, bounds=_band_bounds(transform, values.shape))
    if voids_filled:   # the writer filled them already; `_fill_voids` would be a no-op
        band.filled_in = band.values
    cache.put("demBands", _file_key(path), band, band.values.nbytes)


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
            # After the resize: the band must hold at the resolution the meshes sample.
            # Paths first, so the edge fill ramps from the lifted path into the grass.
            if tint.path_fill:
                arr, fill_summary = _fill_path_shadows(np.asarray(im), extent, tint.rows)
                im = Image.fromarray(arr)
                summary += "; " + fill_summary
            else:
                summary += "; no path fill (path shadows as photographed)"
            if tint.edge_fill is not None:
                arr, fill_summary = _fill_hazard_edges(np.asarray(im), extent, tint.rows, tint.edge_fill)
                im = Image.fromarray(arr)
                summary += "; " + fill_summary
            else:
                summary += "; no edge fill (bunkers and paths as photographed)"
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
              shadow_azimuth: float | None = None, shadow_ratio: float | None = None,
              edge_fill: "EdgeFill | None" = ..., path_fill: bool = True) -> None:
    # edge_fill: the -meshes file's band round bunkers and paths; ... = EdgeFill(), None = as photographed.
    # path_fill: the -meshes file's path shadows lifted (see PATH_FILL_RATIO); False = as photographed.
    if edge_fill is ...:
        edge_fill = EdgeFill()
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
                       water_feather_m, soften_m, tint_size, darken_tint, tint_grade, edge_fill, path_fill)
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
    slipped through untagged) with the nearest valid cell's height, so nothing
    cliffs at holes — in a hillshade or a heightmap. Swedish ground is never
    below -1000 m. Not the mean: the lidar sees no ground on open water, and a
    hole out on Vättern filled with the square's mean (~98 m at Omberg) stood
    as a 10 m black block above the lake in GSPro; filled from its edges it
    is lake bed again."""
    from scipy.ndimage import distance_transform_edt
    finite = np.isfinite(dem) & (dem > -1000)
    if finite.all():
        return dem
    if not finite.any():
        return np.zeros_like(dem)
    _, (rows, cols) = distance_transform_edt(~finite, return_indices=True)
    return dem[rows, cols]


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
    inner = _read_sidecar_json(inner_sidecar)
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
    transform = from_bounds(e0, n0, e1, n1, size, size)
    with rasterio.open(
        out, "w", driver="GTiff", height=size, width=size, count=1, dtype="float32",
        crs=SWEREF99, transform=transform,
        compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256,
    ) as dst:
        dst.write(dem, 1)
    # Lossless deflate of the very array above, with its voids already filled:
    # the `gkd` job of the same batch reads this file back and gets it for free.
    _publish_dem_band(out, dem, transform, SWEREF99, None, voids_filled=True)
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


# Tree species areas (shared/features/tree-areas.ts): a drawn polygon whose
# species mix the Unity tree planter uses for the stems inside it. The mix is
# one attribute string, comma-separated `<species>[=<weight>]` (relative, default 1).
TREE_AREA_FEATURE_TYPE = "tree_area"
_TREE_SPECIES_ENTRY = re.compile(r"([a-z][a-z0-9_-]*)(?:=([0-9]*\.?[0-9]+))?")
TREE_AREA_SIMPLIFY_M = 0.5


def _parse_species_mix(raw) -> list[dict] | None:
    """shared/features/tree-areas.ts parseSpeciesMix: [{species, weight}], or
    None when an entry is malformed or a species is named twice."""
    if not isinstance(raw, str):
        return None
    mix: list[dict] = []
    for part in raw.split(","):
        entry = part.strip().lower()
        if not entry:
            continue
        m = _TREE_SPECIES_ENTRY.fullmatch(entry)
        if not m or any(s["species"] == m.group(1) for s in mix):
            return None
        mix.append({"species": m.group(1), "weight": float(m.group(2)) if m.group(2) is not None else 1.0})
    return mix


def _load_tree_areas(db_path: Path, course_ident: str) -> list[dict]:
    """A course's tree species areas bottom to top in the web editor's stack
    order (as _load_zones), each {id, name, ignoreKind, species, geometry}.
    An area without a usable mix (the server refuses those) is skipped with a warning."""
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    try:
        rows = conn.execute(
            f"""SELECT f.id, f.geometry_json, f.attributes_json
               FROM course_features f LEFT JOIN holes h ON h.id = f.hole_id
               WHERE f.course_id = ? AND f.type = ?
               ORDER BY {_group_rank_sql(conn)}, f.sort_order, f.id""",
            (course["id"], TREE_AREA_FEATURE_TYPE),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        raise SystemExit(f"error: {db_path}: {exc} (run the server once so its migrations bring the schema up)") from None
    conn.close()
    areas = []
    for r in rows:
        attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        attrs = attrs if isinstance(attrs, dict) else {}
        mix = _parse_species_mix(attrs.get("species"))
        if not mix or not any(s["weight"] > 0 for s in mix):
            print(f"  warning: tree area {r['id']} has no usable species mix ({attrs.get('species')!r}); skipped")
            continue
        name = attrs.get("name")
        areas.append({
            "id": str(r["id"]),
            "name": name.strip() if isinstance(name, str) else "",
            "ignoreKind": attrs.get("ignoreKind") is True,
            "species": mix,
            "geometry": json.loads(r["geometry_json"]),
        })
    return areas


def _place_tree_areas(areas: list[dict], extent: Extent, exclude: Extent | None,
                      trees: list[dict], e0: float, n0: float) -> list[dict]:
    """Give every stem inside a tree area that area's id (`area`; the topmost
    area wins where they overlap) and return the areas' unity-trees-v1 rows:
    {id, name, ignoreKind, species: [{species, weight}], stems, rings} with the
    outline clipped to the square (minus `exclude`) in plot-local metres."""
    from shapely import intersects_xy
    from shapely.geometry import box

    square = box(*extent)
    excl = box(*exclude) if exclude is not None else None
    xs = np.array([t["x"] + e0 for t in trees], dtype=np.float64)
    ys = np.array([t["z"] + n0 for t in trees], dtype=np.float64)
    owner = np.full(len(trees), -1, dtype=np.int64)
    rows = []
    for area in areas:
        geom = _zone_geometry_m(area["geometry"])
        clipped = geom.intersection(square) if geom is not None and not geom.is_empty else None
        if clipped is not None and excl is not None:
            clipped = clipped.difference(excl)
        if clipped is None or clipped.is_empty:
            continue
        if len(trees):
            owner[intersects_xy(clipped, xs, ys)] = len(rows)   # later (higher in the stack) wins
        rows.append({
            "id": area["id"],
            "name": area["name"],
            "ignoreKind": area["ignoreKind"],
            "species": area["species"],
            "stems": 0,
            "rings": _zone_rings_local(clipped.simplify(TREE_AREA_SIMPLIFY_M, preserve_topology=True), e0, n0),
        })
    for i, t in enumerate(trees):
        if owner[i] >= 0:
            row = rows[owner[i]]
            t["area"] = row["id"]
            row["stems"] += 1
    return rows


# A stem the survey puts on a road or path (a crown leaning over it, a detection a
# metre off) is moved to the nearest spot this far outside the path's edge: room for
# the trunk and its root flare.
TREE_PATH_CLEARANCE_M = 0.8


def _load_path_geometries(db_path: Path, course_ident: str) -> list:
    """The course's `path` features (roads, cart paths, parking lots) in EPSG:3006 metres."""
    from shapely import make_valid
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute("SELECT geometry_json FROM course_features WHERE course_id = ? AND type = 'path'",
                        (course["id"],)).fetchall()
    conn.close()
    geoms = (_zone_geometry_m(json.loads(r["geometry_json"])) for r in rows)
    return [make_valid(g) for g in geoms if g is not None and not g.is_empty]


def _move_stems_off_paths(trees: list[dict], paths: list, e0: float, n0: float,
                          clearance_m: float = TREE_PATH_CLEARANCE_M) -> tuple[int, float]:
    """Move every stem on a path, or within `clearance_m` of its edge, to the nearest
    point that far outside it. The stem keeps its id (the surveyed position), so looks
    and hand edits keyed by it in Unity stay with the tree. Returns (moved, longest move in metres)."""
    from shapely import contains_xy
    from shapely.geometry import Point
    from shapely.ops import nearest_points, unary_union
    if not trees or not paths:
        return 0, 0.0
    keep_out = unary_union(paths).buffer(clearance_m, quad_segs=4)
    xs = np.array([t["x"] + e0 for t in trees], dtype=np.float64)
    ys = np.array([t["z"] + n0 for t in trees], dtype=np.float64)
    edge = keep_out.boundary
    moved, longest = 0, 0.0
    for i in np.flatnonzero(contains_xy(keep_out, xs, ys)):
        at = Point(xs[i], ys[i])
        to = nearest_points(edge, at)[0]
        d = at.distance(to)
        # A few centimetres past the edge, so rounding cannot leave the stem inside.
        k = (d + 0.05) / d if d > 1e-6 else 1.0
        trees[i]["x"] = round(at.x + (to.x - at.x) * k - e0, 3)
        trees[i]["z"] = round(at.y + (to.y - at.y) * k - n0, 3)
        moved += 1
        longest = max(longest, d)
    return moved, longest


# What the lidar reads as a tree but is not one. The detector takes anything standing 1 m or more
# over the ground model as a crown, and the ground model has filtered out boulders and never had
# the wires: a 1.5 m rock comes out as a 1.5 m bush, a power line as a row of tall thin trees.
# - `power_line` features (shared/features/power-line.ts, drawn as a centerline with a width): every
#   stem inside the corridor is dropped, whatever its height (the wires hang over cleared ground).
# - `rock_slab` features and the course's placed rocks (`--rocks`: a golfmap-walls-v1 stone-walls.json,
#   its `boulders` with e/n/lengthM): stems under TREE_ROCK_MAX_HEIGHT_M standing on one are dropped.
#   A taller one is a real tree beside or over the rock and stays. A slab with riseMode `dem` (a cliff or
#   the shore rock, its mesh the course DEM) keeps every stem: the scrub and low wind-shaped trees the
#   lidar sees on a cliff stand in its cracks and on its ledges (Omberg's 14th, along Vättern).
POWER_LINE_FEATURE_TYPE = "power_line"
# The corridor is drawn about as wide as the wires hang (8 m by default); the keep-out reaches this far
# beyond it on both sides, so no crown is planted into the outer wires.
TREE_POWER_LINE_CLEARANCE_M = 3.0
TREE_ROCK_MAX_HEIGHT_M = 6.0
TREE_ROCK_SLAB_MARGIN_M = 0.5          # the detector's cells are 1 m: a stem this far off a slab's edge is the slab
TREE_ROCK_BOULDER_RADIUS_FRACTION = 0.5   # of lengthM: a boulder's keep-out is the circle round its long side


def _load_feature_geometries(db_path: Path, course_ident: str, feature_type: str) -> list:
    """The course's features of one type as valid shapely geometries in EPSG:3006 metres."""
    from shapely import make_valid
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute("SELECT geometry_json FROM course_features WHERE course_id = ? AND type = ?",
                        (course["id"], feature_type)).fetchall()
    conn.close()
    geoms = (_zone_geometry_m(json.loads(r["geometry_json"])) for r in rows)
    return [make_valid(g) for g in geoms if g is not None and not g.is_empty]


def _load_tree_rock_slabs(db_path: Path, course_ident: str) -> list:
    """The course's `rock_slab` features that keep the stems off them, as valid shapely geometries in EPSG:3006
    metres: every slab but the riseMode `dem` ones (see above)."""
    from shapely import make_valid
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute("SELECT geometry_json, attributes_json FROM course_features WHERE course_id = ? AND type = ?",
                        (course["id"], ROCK_SLAB_TYPE)).fetchall()
    conn.close()
    out = []
    for r in rows:
        try:
            attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        except ValueError:
            attrs = {}
        if isinstance(attrs, dict) and attrs.get(SHAPING_SLAB_RISE_MODE_ATTRIBUTE) == "dem":
            continue
        g = _zone_geometry_m(json.loads(r["geometry_json"]))
        if g is not None and not g.is_empty:
            out.append(make_valid(g))
    return out


def _load_placed_rocks(rocks_path: Path) -> list:
    """The single rocks of a golfmap-walls-v1 spec (`boulders`: e, n, lengthM) as circles in EPSG:3006 metres."""
    from shapely.geometry import Point
    spec = json.loads(rocks_path.read_text(encoding="utf-8"))
    out = []
    for b in spec.get("boulders") or []:
        try:
            e, n, length = float(b["e"]), float(b["n"]), float(b.get("lengthM", 1.0))
        except (KeyError, TypeError, ValueError):
            continue
        out.append(Point(e, n).buffer(max(length * TREE_ROCK_BOULDER_RADIUS_FRACTION, 0.5), quad_segs=6))
    return out


def _drop_stems_on_rocks_and_power_lines(trees: list[dict], rocks: list, power_lines: list,
                                         e0: float, n0: float) -> tuple[list[dict], int, int]:
    """`trees` without the stems that are a rock or a power line (see above): (kept, dropped as rock,
    dropped as power line)."""
    from shapely import contains_xy
    from shapely.ops import unary_union
    if not trees or not (rocks or power_lines):
        return trees, 0, 0
    xs = np.array([t["x"] + e0 for t in trees], dtype=np.float64)
    ys = np.array([t["z"] + n0 for t in trees], dtype=np.float64)
    wire = contains_xy(unary_union(power_lines), xs, ys) if power_lines else np.zeros(len(trees), dtype=bool)
    rock = np.zeros(len(trees), dtype=bool)
    if rocks:
        low = np.array([t["h"] < TREE_ROCK_MAX_HEIGHT_M for t in trees], dtype=bool)
        rock = contains_xy(unary_union(rocks), xs, ys) & low & ~wire
    drop = wire | rock
    return [t for t, d in zip(trees, drop) if not d], int(rock.sum()), int(wire.sum())


POWER_LINES_FORMAT = "golfmap-power-lines-v1"


def cmd_power_lines(course_ident: str, out: Path, db_path: Path | None = None) -> None:
    """Write the course's `power_line` features for Unity's golfmap.powerlines.build: each line's
    points (one per pole, EPSG:3006) under `power_line_<feature number in hex>`."""
    conn = _open_course_db(db_path or DEFAULT_DB)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute("SELECT id, feature_no, geometry_json FROM course_features WHERE course_id = ? AND type = ? "
                        "ORDER BY feature_no IS NULL, feature_no, id", (course["id"], POWER_LINE_FEATURE_TYPE)).fetchall()
    conn.close()
    lines = []
    for r in rows:
        points = ((json.loads(r["geometry_json"]).get("centerline") or {}).get("points")) or []
        if len(points) < 2:
            print(f"  warning: power line {r['id']} has no centerline of two or more points; skipped")
            continue
        part = f"{r['feature_no']:x}" if r["feature_no"] is not None else f"{_id_seed(r['id']):x}"
        lines.append({"id": str(r["id"]), "name": f"power_line_{part}",
                      "points": [[round(float(p["x"]), 2), round(float(p["y"]), 2)] for p in points]})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"format": POWER_LINES_FORMAT, "crs": "EPSG:3006", "lines": lines}, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    print(f"  {len(lines)} power line(s), {sum(len(l['points']) for l in lines)} pole position(s)")


def cmd_trees(bbox, stems_path: Path, sidecar_path: Path, out: Path, terrain: str | None = None,
              exclude: Extent | None = None, extent: Extent | None = None,
              db_path: Path | None = None, course: str | None = None, rocks_path: Path | None = None) -> None:
    """Write a unity-trees-v1 file for one terrain: every stem inside the
    square (and outside `exclude`, the inner square when this is the outer)
    as x/z metres from the square's south-west corner, with the plot's
    height range copied from the terrain's heightmap sidecar so the planter's
    ground check and the terrain agree to the centimetre. With `course`, the
    course's tree species areas (read from `db_path`) go into `areas` and each
    stem inside one names it in `area`, and stems standing on the course's
    paths are moved to just beside them (_move_stems_off_paths), and stems that
    are really a power line or a rock (the course's `power_line` and `rock_slab`
    features, and the placed rocks of `rocks_path`) are left out."""
    if not stems_path.is_file():
        raise SystemExit(f"error: no such tree-stems asset: {stems_path}")
    if not sidecar_path.is_file():
        raise SystemExit(f"error: no such heightmap sidecar: {sidecar_path} (export the heightmap first)")
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    sidecar = _read_sidecar_json(sidecar_path)
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

    rocks = _load_placed_rocks(rocks_path) if rocks_path is not None and rocks_path.is_file() else []
    wires = []
    if course is not None:
        rocks += [g.buffer(TREE_ROCK_SLAB_MARGIN_M, quad_segs=4)
                  for g in _load_tree_rock_slabs(db_path or DEFAULT_DB, course)]
        wires = [g.buffer(TREE_POWER_LINE_CLEARANCE_M, quad_segs=4)
                 for g in _load_feature_geometries(db_path or DEFAULT_DB, course, POWER_LINE_FEATURE_TYPE)]
    trees, as_rock, as_wire = _drop_stems_on_rocks_and_power_lines(trees, rocks, wires, e0, n0)

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
    moved, longest = 0, 0.0
    if course is not None:
        moved, longest = _move_stems_off_paths(trees, _load_path_geometries(db_path or DEFAULT_DB, course), e0, n0)
        areas = _place_tree_areas(_load_tree_areas(db_path or DEFAULT_DB, course), extent, exclude, trees, e0, n0)
        doc["areas"] = areas
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n", encoding="utf-8")
    kinds = {k: sum(1 for t in trees if t["k"] == k) for k in (0, 1, 2)}
    print(f"Wrote {out}")
    print(f"  {len(trees)} trees on the {side:g} m {doc['plot']['terrain'] or 'terrain'} square "
          f"(broadleaf {kinds[0]}, conifer {kinds[1]}, unknown {kinds[2]}; "
          f"{sum(1 for t in trees if t['bush'])} bushes); {outside} outside the square"
          + (f", {excluded} left to the inner terrain" if exclude is not None else "")
          + (f", {duplicates} duplicate position(s) merged" if duplicates else ""))
    if as_rock or as_wire:
        print(f"  left out: {as_rock} stem(s) under {TREE_ROCK_MAX_HEIGHT_M:g} m on a rock slab or placed rock, "
              f"{as_wire} in a power line's corridor")
    if moved:
        print(f"  {moved} stem(s) on a road or path moved to {TREE_PATH_CLEARANCE_M:g} m beside it (longest move {longest:.1f} m)")
    print(f"  plot origin {e0:.0f},{n0:.0f} (EPSG:3006), height range {doc['plot']['minM']:.2f}..{doc['plot']['maxM']:.2f} m from {sidecar_path.name}")
    for a in doc.get("areas", []):
        mix = ", ".join(f"{s['species']} {s['weight']:g}" for s in a["species"])
        print(f"  tree area {a['name'] or a['id']}: {a['stems']} stems -> {mix}" + (" (whatever the survey's class)" if a["ignoreKind"] else ""))


# --- Command: buildings -----------------------------------------------------

UNITY_BUILDINGS_FORMAT = "unity-buildings-v1"


def _read_plot_sidecar(sidecar_path: Path, extent: Extent) -> dict:
    if not sidecar_path.is_file():
        raise SystemExit(f"error: no such heightmap sidecar: {sidecar_path} (export the heightmap first)")
    sidecar = _read_sidecar_json(sidecar_path)
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
    """A read-only connection to the app database. Inside a batch every job
    shares one per database file (`_SharedConnection`: its `close()` is a
    no-op), so the jobs pay for opening it once."""
    if not path.is_file():
        raise SystemExit(f"error: no course database at {path} (pass --db)")
    cache = _BATCH
    if cache is not None:
        return cache.connection(path)
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
    rank = "h.number"
    if _has_column(conn, 'holes', 'drawing_group_after'):
        # Same integer ranks as shared/render/stack-key.ts drawScopeRanks:
        # insert groups above the chosen hole; internal numbers stay stable.
        after = "COALESCE(h.drawing_group_after, 98)"
        other = "COALESCE(dg.drawing_group_after, 98)"
        group_order = "COALESCE(h.drawing_group_order, h.number)" if _has_column(conn, 'holes', 'drawing_group_order') else 'h.number'
        other_order = "COALESCE(dg.drawing_group_order, dg.number)" if _has_column(conn, 'holes', 'drawing_group_order') else 'dg.number'
        count = ("SELECT COUNT(*) FROM holes dg WHERE dg.course_id = h.course_id "
                 "AND dg.drawing_group_name IS NOT NULL AND ")
        rank = (f"CASE WHEN h.drawing_group_name IS NULL THEN h.number + ({count}{other} < h.number) "
                f"ELSE {after} + ({count}({other}, {other_order}, dg.number) <= ({after}, {group_order}, h.number)) END")
    if _has_column(conn, 'holes', 'drawing_stack_order'):
        rank = f"COALESCE(h.drawing_stack_order, {rank})"
    return (f"CASE WHEN f.type IN ({roads}) THEN {ROADS_GROUP_RANK} {roughs}"
            f"ELSE COALESCE({rank}, {COURSE_GROUP_RANK}) END")


def _load_course_features(db_path: Path, course_ident: str, stack: str) -> tuple[sqlite3.Row, list[sqlite3.Row]]:
    """A course and its features (id, type, geometry_json, sort_order,
    hole_number, group_rank, source, source_ref, attributes_json, created_at,
    feature_no, generated) in paint order: the app's own, or with `stack`
    "opcd" the green/tee/bunker lift inside each group (see TOP_TYPES).

    Inside a batch the rows are loaded once per (database file, course,
    stack) — the `svg`, `shaping-global`, `trees` and `gkd` jobs of one export
    all want the same ones — and the caller gets its own list to filter."""
    cache = _BATCH
    if cache is None or not db_path.is_file():
        return _load_course_features_now(db_path, course_ident, stack)
    return cache.cached("features", (_file_key(db_path), course_ident.lower(), stack),
                        lambda: _load_course_features_now(db_path, course_ident, stack),
                        copy=lambda loaded: (loaded[0], list(loaded[1])))


def _load_course_features_now(db_path: Path, course_ident: str,
                              stack: str) -> tuple[sqlite3.Row, list[sqlite3.Row]]:
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rank = _group_rank_sql(conn)
    # Provenance, for the SVG's exclusions (a road's kerb fillets go with it).
    # A database from before the server's provenance migration has neither.
    cols = {r[1] for r in conn.execute("PRAGMA table_info(course_features)")}
    source = "f.source" if "source" in cols else "NULL"
    source_ref = "f.source_ref" if "source_ref" in cols else "NULL"
    attributes = "f.attributes_json" if "attributes_json" in cols else "NULL"
    created = "f.created_at" if "created_at" in cols else "NULL"
    number = "f.feature_no" if "feature_no" in cols else "NULL"
    generated = "f.generated" if "generated" in cols else "0"
    group_name = "h.drawing_group_name" if _has_column(conn, "holes", "drawing_group_name") else "NULL"
    rows = conn.execute(
        f"""SELECT f.id, f.type, f.geometry_json, f.sort_order, h.number AS hole_number,
                   {rank} AS group_rank, {source} AS source, {source_ref} AS source_ref,
                   {attributes} AS attributes_json, {created} AS created_at,
                   {number} AS feature_no, {generated} AS generated, {group_name} AS drawing_group_name
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
# The tinted twin is written at this edge (or the render's, when smaller).
# The soften leaves the grass nothing 4096 px would not carry, but bunkers and
# paths stay sharp, and a 2-3.5 m path is 4-7 texels wide at 4096 over
# Vreta's 2 km: its diagonal edges stepped in 0.5 m blocks, and Unity's BC1
# (4x4-texel blocks) made them 2 m teeth. 8192 halves both.
DEFAULT_TINT_SIZE = 8192
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

# --- Hazard edge fill -------------------------------------------------------
# The course meshes sample the `-meshes` file twice: OPCD's MAHS materials use
# it as the base colour of every channel set to "Use Satellite for Base" (the
# _Sat rough, the bunker blends, the bunker's own sand), and the StixGames 3D
# grass on the roughs colours every blade by it (`_ColorMap`). The photo's
# sand runs past the drawn bunker outline (misregistration, the soften blur,
# half a texel of bilinear sampling), so the strip of grass round every bunker
# rendered pale and the Stix blades there came out white. Measured on Vreta
# (2025 photo, 35 bunkers): luma is up over the grass to ~1.0 m outside the
# outline in the 4096 px `-meshes` file (0.5 m in the 8192 photo). Paths do
# the same with gravel: +4 luma on average, but the long ones +5..9 luma and
# +6..8 blue within 1.5 m (a grey strip along both sides in Unity).
# So the finished `-meshes` file gets a band round each bunker and path filled
# from the grass beyond it (building_removal.nearest_fill: nearest clean ground
# on a 1 m grid, blurred): from the type's EDGE_FILL_INSET_M inside the outline
# out to EDGE_FILL_M, then fading out over EDGE_FILL_FEATHER_M. A bunker starts
# 0.5 m in (the first 0.5 m texel, so bilinear sampling at the seam reads
# grass, not sand); a path at its outline, as it is ~2 m wide and its concrete
# (`_Sat`) samples this file too, so a 0.5 m inset would green a quarter of it
# each side. Both ends are ramps on each pixel centre's exact distance to the
# drawn outline, not on a raster of it: with 0.5 m texels a raster edge is a
# staircase, and along a long path at a shallow angle every texel row showed
# as a step (the first path fill had a hard one at 1.25 m out). The rest stays
# photographed: a filled bunker turns green at a distance. `--edge-fill none`
# keeps the old file (as photographed, halo included).
EDGE_FILL_TYPES = ("bunker", "path")
DEFAULT_EDGE_FILL_M = 1.25
EDGE_FILL_INSET_M = {"bunker": 0.5, "path": 0.0}
# A type with no entry above.
DEFAULT_EDGE_FILL_INSET_M = 0.5
# Fill colours come from at least this far beyond the band (its outer pixels
# can still carry the halo).
EDGE_FILL_GAP_M = 0.5
# Outer fade (fill 1 at EDGE_FILL_M, 0 this much further out) and the inner
# ramp (fill 0.5 at the inset, over this width), both linear: two 0.5 m
# texels each, as a one-texel ramp still aliases into steps under bilinear
# sampling (measured along a 4 degree path: std 10 at one texel, 2-3 at two).
EDGE_FILL_FEATHER_M = 1.0
EDGE_FILL_INNER_RAMP_M = 1.0


@dataclass(frozen=True)
class EdgeFill:
    """Which feature types get their edge band filled, and how wide it is
    (`inset_m` None = each type's EDGE_FILL_INSET_M)."""
    types: tuple[str, ...] = EDGE_FILL_TYPES
    margin_m: float = DEFAULT_EDGE_FILL_M
    inset_m: float | None = None

    def inset_for(self, kind: str) -> float:
        if self.inset_m is not None:
            return self.inset_m
        return EDGE_FILL_INSET_M.get(kind, DEFAULT_EDGE_FILL_INSET_M)


def _parse_edge_fill(types: str | None, margin_m: float | None = None,
                     inset_m: float | None = None) -> "EdgeFill | None":
    """`--edge-fill` (comma-separated types, `none` = off; default bunker,path)
    with its band widths, validated (no inset = per type)."""
    if types is not None and types.strip().lower() == "none":
        return None
    kinds = EDGE_FILL_TYPES if types is None else tuple(t.strip() for t in types.split(",") if t.strip())
    if not kinds:
        raise SystemExit("error: --edge-fill wants feature types (e.g. bunker,path) or none")
    margin_m = DEFAULT_EDGE_FILL_M if margin_m is None else margin_m
    if not 0 < margin_m <= 10:
        raise SystemExit("error: --edge-fill-m must be in (0, 10]")
    if inset_m is not None and not 0 <= inset_m <= 2:
        raise SystemExit("error: --edge-fill-inset-m must be in [0, 2]")
    return EdgeFill(kinds, margin_m, inset_m)


def _signed_distance(shape, x: np.ndarray, y: np.ndarray, reach: float) -> np.ndarray:
    """Each point's distance to `shape`'s outline in metres, negative inside;
    +/-inf past `reach` (nearest segment through an STRtree, so a long path
    outline is not walked once per pixel)."""
    import shapely

    segs = []
    for poly in _polygons(shape):
        for ring in (poly.exterior, *poly.interiors):
            c = np.asarray(ring.coords)
            segs.append(np.stack([c[:-1], c[1:]], axis=1))
    lines = shapely.linestrings(np.concatenate(segs))
    pts = shapely.points(x, y)
    (qi, _), dist = shapely.STRtree(lines).query_nearest(pts, max_distance=reach, return_distance=True)
    d = np.full(len(x), np.inf)
    np.minimum.at(d, qi, dist)
    shapely.prepare(shape)
    return np.where(shapely.contains_xy(shape, x, y), -d, d)


def _fill_hazard_edges(hwc: np.ndarray, extent: Extent, rows: list, fill: EdgeFill) -> tuple[np.ndarray, str]:
    """`hwc` (the finished `-meshes` image on `extent`) with a band round
    every feature of `fill.types` - from its type's inset inside its outline
    to `margin_m` outside - filled from the ground beyond it (see EDGE_FILL_M).
    Returns (image, summary)."""
    from rasterio.features import rasterize
    from shapely.ops import unary_union
    from golfpipe.building_removal import nearest_fill

    height, width = hwc.shape[:2]
    px = (extent[2] - extent[0]) / width
    by_type, counts = {}, {}
    for row in _grass_tracks_as_turf(rows):
        if row["type"] not in fill.types:
            continue
        shape = _row_shape(row, min(0.05, px / 4))
        if shape is not None:
            by_type.setdefault(row["type"], []).append(shape)
            counts[row["type"]] = counts.get(row["type"], 0) + 1
    if not by_type:
        return hwc, f"no {', '.join(fill.types)} to fill round"
    unions = {kind: unary_union(shapes) for kind, shapes in by_type.items()}
    hazards = unary_union(list(unions.values()))
    transform = from_bounds(extent[0], extent[1], extent[2], extent[3], width, height)

    def burn(geom) -> np.ndarray:
        return rasterize([(geom, 1)], out_shape=(height, width), transform=transform, fill=0,
                         dtype="uint8", all_touched=True).astype(bool)

    # Every pixel the ramps can reach; the alpha itself comes from exact distances.
    reach = fill.margin_m + EDGE_FILL_FEATHER_M + px
    r, c = np.nonzero(burn(hazards.buffer(reach)))
    x, y = extent[0] + (c + 0.5) * px, extent[3] - (r + 0.5) * px
    alpha = np.ones(len(x))
    nearest = np.full(len(x), np.inf)
    for kind, shape in unions.items():
        inset = fill.inset_for(kind)
        d = _signed_distance(shape, x, y, max(reach, inset + EDGE_FILL_INNER_RAMP_M) + px)
        alpha = np.minimum(alpha, np.clip((d + inset) / EDGE_FILL_INNER_RAMP_M + 0.5, 0.0, 1.0))
        nearest = np.minimum(nearest, d)
    alpha = np.minimum(alpha, np.clip((fill.margin_m + EDGE_FILL_FEATHER_M - nearest) / EDGE_FILL_FEATHER_M, 0.0, 1.0))
    at = alpha > 0
    if not at.any():
        return hwc, f"edge fill: band under a pixel at {px:g} m/px, nothing filled"
    r, c, a = r[at], c[at], alpha[at][:, None]
    filled = nearest_fill(hwc, burn(hazards.buffer(fill.margin_m + EDGE_FILL_GAP_M)), px)
    out = np.array(hwc, copy=True)
    out[r, c] = np.clip(np.round(hwc[r, c].astype(np.float64) * (1.0 - a) + filled[r, c] * a), 0, 255).astype(np.uint8)
    what = ", ".join(f"{k} {v} ({fill.inset_for(k):g} m in)" for k, v in sorted(counts.items()))
    return out, (f"edge fill round {what} to {fill.margin_m:g} m out of the outline (+{EDGE_FILL_FEATHER_M:g} m fade), "
                 f"{float(a.sum()) * px * px:,.0f} m² from the ground beyond")


# Path shadow fill (`--path-fill`, on by default). The cart paths' concrete
# (`OPCD MAHS Concrete - Asphalt_Sat`, red and green channels *Use Satellite
# for Base*) takes its colour from the `-meshes` file, so every tree shadow the
# photo caught on a path was baked into it: dark blue blocks on the path by
# hole 13's tees, whole stretches of forest path near black, while Unity draws
# its own shadows on top. Measured on Vreta (2025 photo, 4096 px file, 109
# paths): path luma median 95, p10 36; the shadowed pixels are blue (B - R up to
# 0.8 x luma below luma 30, sunlit gravel -0.05) where dark asphalt is neutral.
# So inside every path (roads and OSM paths included; not bridge decks, not
# `surface: grass` tracks, which are meant green) a pixel is shadow when it is
# much darker than the sunlit path near it (luma under PATH_FILL_RATIO of the
# local reference), blue (PATH_FILL_BLUE), or in a stretch that is mostly blue
# (a path shaded end to end has no sunlit pixels to compare with). Shadow is
# replaced by the sunlit path colour near it (a normalised Gaussian of the
# sunlit pixels, PATH_FILL_NEAR_M, with a PATH_FILL_FAR_M one and the course's
# sunlit path colour behind it for a path shaded all along) times the pixel's
# own relief against its shadow neighbours (PATH_FILL_DETAIL_M, clipped to
# +/-PATH_FILL_DETAIL), so the gravel keeps its grain and the path its real
# colour changes; smoothstep weights, so a penumbra is lifted partly. Every
# pixel inside the outline counts, green ones too: the path mesh covers it, and
# sparing green-dark pixels near the edge (canopy over a forest path) left a
# narrow path a bright line between dark ones. At the outline the lift ramps
# out over PATH_FILL_EDGE_M (at least two texels) on each pixel centre's exact
# distance to it: a mask of the pixel centres inside made the lifted gravel a
# texel staircase along every diagonal path, seen in Unity as jagged teeth down
# both sides. Runs on the -meshes file only, before the edge fill (which then
# ramps the edge into the grass).
PATH_FILL_SKIP_SURFACES = ("grass", "bridge")  # "bridge" = BRIDGE_SURFACE, defined further down
PATH_FILL_RATIO = (0.60, 0.85)        # luma / sunlit reference: shadow at the first, sunlit from the second
PATH_FILL_BLUE = (0.05, 0.35)          # (B - R) / luma: sunlit gravel ~-0.05, shadow 0.4..1
PATH_FILL_BLUE_SHARE = (0.30, 0.60)    # share of blue pixels within PATH_FILL_BLUE_M: a shaded stretch
PATH_FILL_BLUE_M = 2.0
PATH_FILL_NEAR_M = 6.0
PATH_FILL_FAR_M = 30.0
PATH_FILL_FAR_WEIGHT = 0.05
PATH_FILL_CELL_M = 2.0                 # the references are computed on this grid, then bilinear
PATH_FILL_DETAIL_M = 1.0
PATH_FILL_DETAIL = 0.2
PATH_FILL_EDGE_M = 0.5                 # the lift's ramp across the outline (never under two texels)
_LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def _path_cover(shape, extent: Extent, px: float, r0: int, r1: int, c0: int, c1: int) -> np.ndarray:
    """How much of the path each pixel of the [r0:r1, c0:c1] window is, 0..1:
    1 more than half the ramp inside `shape`'s outline, 0 as far outside,
    linear between on the pixel centre's exact distance to it."""
    from rasterio.features import rasterize

    ramp = max(PATH_FILL_EDGE_M, 2 * px)
    win = from_bounds(extent[0] + c0 * px, extent[3] - r1 * px, extent[0] + c1 * px, extent[3] - r0 * px,
                      c1 - c0, r1 - r0)
    near = rasterize([(shape.buffer(ramp), 1)], out_shape=(r1 - r0, c1 - c0), transform=win, fill=0,
                     dtype="uint8", all_touched=True).astype(bool)
    cover = np.zeros((r1 - r0, c1 - c0), dtype=np.float32)
    r, c = np.nonzero(near)
    if len(r):
        x, y = extent[0] + (c0 + c + 0.5) * px, extent[3] - (r0 + r + 0.5) * px
        d = _signed_distance(shape, x, y, ramp + px)
        cover[r, c] = np.clip(0.5 - d / ramp, 0.0, 1.0)
    return cover


def _smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def _path_fill_rows(rows: list) -> list:
    return [r for r in rows if r["type"] == "path" and _row_surface(r) not in PATH_FILL_SKIP_SURFACES]


def _row_raw_surface(row) -> str | None:
    raw = row["attributes_json"] if "attributes_json" in row.keys() else None
    if not raw:
        return None
    try:
        return json.loads(raw).get("surface")
    except (ValueError, AttributeError):
        return None


def _row_surface(row) -> str | None:
    """The row's surface as the export, Blender and Unity know it: a gravel track (gravel with a grass middle) is
    gravel everywhere; only its wear entry (`_path_wear`) adds the grass."""
    surface = _row_raw_surface(row)
    return "gravel" if surface == GRAVEL_TRACK_SURFACE else surface


def _grass_tracks_as_turf(rows: list) -> list:
    """`rows` with every `surface: grass` track retyped GRASS_TRACK_FILL: its
    mesh is a rough on the satellite material, so in the `-meshes` file it is
    turf (softened, tinted, no edge band), not a path kept as photographed -
    that left it a dark grey strip with every wheel mark in the tinted green."""
    return [{**{k: r[k] for k in r.keys()}, "type": GRASS_TRACK_FILL}
            if r["type"] == "path" and _row_surface(r) == GRASS_TRACK_SURFACE else r for r in rows]


def _fill_path_shadows(hwc: np.ndarray, extent: Extent, rows: list) -> tuple[np.ndarray, str]:
    """`hwc` (the `-meshes` image on `extent`) with the photo's shadows on the
    course's paths lifted to the sunlit path colour round them (see
    PATH_FILL_RATIO). Returns (image, summary)."""
    from rasterio.features import rasterize
    from scipy.ndimage import gaussian_filter, zoom
    from shapely.ops import unary_union

    height, width = hwc.shape[:2]
    px = (extent[2] - extent[0]) / width
    shapes = [s for s in (_row_shape(r, min(0.05, px / 4))
                          for r in _path_fill_rows(rows)) if s is not None]
    if not shapes:
        return hwc, "no paths to lift shadows on"
    transform = from_bounds(extent[0], extent[1], extent[2], extent[3], width, height)
    mask = rasterize([(unary_union(shapes), 1)], out_shape=(height, width), transform=transform, fill=0,
                     dtype="uint8").astype(bool)
    if not mask.any():
        return hwc, "path fill: paths under a pixel, nothing lifted"
    # Work on the paths' bounding box only (+ the far kernel's reach).
    rows_any, cols_any = np.nonzero(mask.any(axis=1))[0], np.nonzero(mask.any(axis=0))[0]
    pad = int(math.ceil(3 * PATH_FILL_FAR_M / px))
    r0, r1 = max(0, rows_any[0] - pad), min(height, rows_any[-1] + pad + 1)
    c0, c1 = max(0, cols_any[0] - pad), min(width, cols_any[-1] + pad + 1)
    m = mask[r0:r1, c0:c1]
    rgb = hwc[r0:r1, c0:c1].astype(np.float32)
    luma = rgb @ _LUMA
    lc = np.maximum(luma, 1.0)
    blue = (rgb[..., 2] - rgb[..., 0]) / lc
    green = (rgb[..., 1] - (rgb[..., 0] + rgb[..., 2]) / 2) / lc
    mf = m.astype(np.float32)

    def blur(v, metres):
        return gaussian_filter(v, metres / px)

    s_blue = _smoothstep((blue - PATH_FILL_BLUE[0]) / (PATH_FILL_BLUE[1] - PATH_FILL_BLUE[0])) * mf
    share = blur(s_blue, PATH_FILL_BLUE_M) / np.maximum(blur(mf, PATH_FILL_BLUE_M), 1e-6)
    neutral = m & (blue < 0.1) & (green < 0.1) & (share < PATH_FILL_BLUE_SHARE[0] + 0.05)
    if not neutral.any():
        return hwc, "path fill: no sunlit path in the photo to take the colour from, nothing lifted"
    sunlit = rgb[neutral & (luma >= np.percentile(luma[neutral], 50))].mean(axis=0)

    # Normalised Gaussians of the sunlit pixels on a coarse grid (a 30 m kernel on
    # 0.5 m texels would take a minute), the course colour as the last resort.
    f = max(1, int(round(PATH_FILL_CELL_M / px)))
    h, w = m.shape
    hp, wp = -(-h // f), -(-w // f)
    grid_pad = ((0, hp * f - h), (0, wp * f - w))

    def cells(v):
        return np.pad(v, grid_pad).reshape(hp, f, wp, f).sum(axis=(1, 3))

    def upsample(v):
        return zoom(v, (f, f), order=1, grid_mode=True, mode="nearest")[:h, :w]

    def reference(channels, weight, fallback):
        near, far = PATH_FILL_NEAR_M / (px * f), PATH_FILL_FAR_M / (px * f)
        cw = cells(weight)
        den = gaussian_filter(cw, near) + PATH_FILL_FAR_WEIGHT * gaussian_filter(cw, far) + 1e-3
        out = []
        for v, fb in zip(channels, fallback):
            cv = cells(v * weight)
            num = gaussian_filter(cv, near) + PATH_FILL_FAR_WEIGHT * gaussian_filter(cv, far) + 1e-3 * fb
            out.append(upsample(num / den))
        return out

    sunlit_luma = float(sunlit @ _LUMA)
    ref_luma, = reference([luma], neutral.astype(np.float32), [sunlit_luma])
    weight = (neutral & (luma >= 0.75 * ref_luma)).astype(np.float32)
    ref_luma, *ref_rgb = reference([luma, rgb[..., 0], rgb[..., 1], rgb[..., 2]], weight, [sunlit_luma, *sunlit])
    ref_rgb = np.stack(ref_rgb, axis=-1)
    ref_l = np.maximum(ref_luma, 1.0)

    lo, hi = PATH_FILL_RATIO
    s_dark = _smoothstep((hi - luma / ref_l) / (hi - lo))
    below = _smoothstep((0.95 * ref_l - luma) / (0.2 * ref_l))   # blue but as bright as the sunlit path: not shadow
    b_lo, b_hi = PATH_FILL_BLUE_SHARE
    s_stretch = _smoothstep((share - b_lo) / (b_hi - b_lo)) * _smoothstep((0.9 * ref_l - luma) / (0.25 * ref_l))
    shadow = np.maximum(np.maximum(s_dark, s_blue * below), s_stretch)
    shadow = shadow * _path_cover(unary_union(shapes), extent, px, r0, r1, c0, c1)

    near_shadow = blur(luma * shadow, PATH_FILL_DETAIL_M) / np.maximum(blur(shadow, PATH_FILL_DETAIL_M), 1e-6)
    detail = np.clip(luma / np.maximum(near_shadow, 1.0), 1 - PATH_FILL_DETAIL, 1 + PATH_FILL_DETAIL)
    a = shadow[..., None]
    lifted = rgb * (1 - a) + ref_rgb * detail[..., None] * a
    out = np.array(hwc, copy=True)
    out[r0:r1, c0:c1] = np.clip(np.round(lifted), 0, 255).astype(np.uint8)
    return out, (f"path fill: shadows on {len(shapes)} paths lifted to the sunlit path colour round them, "
                 f"{float(shadow.sum()) * px * px:,.0f} m²")


class TintJob:
    """Everything `_render_ortho` needs to tint the terrain twin: where the
    file goes and the course's features + per-type tints, loaded once."""

    def __init__(self, out: Path, course_name: str, rows: list, tints: dict[str, Tint],
                 water_feather_m: float = DEFAULT_WATER_FEATHER_M, soften_m: float = DEFAULT_SOFTEN_M,
                 size: int | None = None, darken_tint: bool = False,
                 grade: "tuple[float, float, float] | None" = None,
                 edge_fill: "EdgeFill | None" = EdgeFill(), path_fill: bool = True):
        self.out, self.course_name, self.rows, self.tints = out, course_name, rows, tints
        self.water_feather_m, self.soften_m, self.size = water_feather_m, soften_m, size
        self.darken_tint, self.grade, self.edge_fill = darken_tint, grade, edge_fill
        self.path_fill = path_fill


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
    rows = _grass_tracks_as_turf(rows)
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


# Roads of every surface are merged into ONE shape per network, as OPCD builds
# them best (the kerb fillets and tapers of "Round kerbs at junctions" dissolve
# inside it). Which part of a road is gravel and which asphalt is not the SVG's
# business: the sidecar next to it (PATH_REGIONS_FORMAT) carries the raw
# pieces with their surfaces, and the Blender shaping step cuts the OPCD mesh
# along those seams and separates the parts (unity/README.md "Cart paths").
# Splitting the shapes in the SVG instead was tried (2026-10-04/05): any seam
# through a junction cut the fillets into slivers, and every repair of those
# left its own bumps - OPCD's build failed on the result.
# Grass tracks (`surface: grass`) are not hard ground: written with
# GRASS_TRACK_FILL, merged among themselves, under every hard road and no
# further than PATH_SURFACE_OVERLAP_M under it, no thinner than
# GRASS_TRACK_MIN_WIDTH_M.
GRASS_TRACK_SURFACE = "grass"
GRASS_TRACK_FILL = "rough"
PATH_SURFACE_OVERLAP_M = 0.05
GRASS_TRACK_MIN_WIDTH_M = 0.3
# A road shape (or track) under this is a slip, not a mesh (m²).
PATH_SURFACE_MIN_M2 = 1.0


@dataclass
class MergedRoad:
    kind: str
    fill: str
    shape: object  # shapely Polygon
    ids: list[str]
    surface: str | None = None  # GRASS_TRACK_SURFACE for a track; None for a hard road (its surfaces are in the sidecar)


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


def _row_shape(row, tol: float):
    """`_feature_shape` for a course_features row. Inside a batch a feature is
    flattened once per tolerance however many passes ask for it — `svg` alone
    wants every road shape four times — keyed on the feature's id and a
    checksum of its geometry, so an edited feature is flattened again."""
    geom_json = row["geometry_json"]
    cache = _BATCH
    if cache is None:
        return _feature_shape(json.loads(geom_json), tol)
    key = (row["id"], len(geom_json), zlib.crc32(geom_json.encode("utf-8")), round(float(tol), 9))
    return cache.cached("shapes", key, lambda: _feature_shape(json.loads(geom_json), tol))


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


PATH_REGIONS_FORMAT = "golfmap-path-regions-v1"


def path_surfaces_file(svg: Path) -> Path:
    """The road-surface sidecar written next to an SVG: <stem>-paths.json."""
    return svg.with_name(f"{svg.stem}-paths.json")


def _transition_centerline(centerline: dict) -> list:
    """Same chord-scaled Catmull-Rom and 5 cm recursive flatten as shared/centerline.ts."""
    pts = []
    for p in centerline.get("points", []):
        if not pts or math.hypot(p["x"] - pts[-1]["x"], p["y"] - pts[-1]["y"]) > 1e-6:
            pts.append(p)
    line = [(p["x"], p["y"]) for p in pts]
    if len(line) < 2:
        return []
    lengths = [math.dist(a, b) for a, b in zip(line, line[1:])]
    def handle(i, chord, span):
        if i == 0 or i == len(line) - 1 or pts[i].get("corner"):
            return (chord[0] * span / 3, chord[1] * span / 3)
        dx, dy = line[i + 1][0] - line[i - 1][0], line[i + 1][1] - line[i - 1][1]
        norm = math.hypot(dx, dy)
        if norm < 1e-9:
            return (chord[0] * span / 3, chord[1] * span / 3)
        reach = min(lengths[i - 1], lengths[i]) / 3
        return dx / norm * reach, dy / norm * reach
    out = [line[0]]
    def flatten(c, depth=0):
        a, b, c2, d = c
        dx, dy = d[0] - a[0], d[1] - a[1]
        chord = math.hypot(dx, dy)
        def off(p):
            return abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / chord if chord > 1e-9 else math.dist(p, a)
        if depth >= 12 or max(off(b), off(c2)) <= .05:
            out.append(d)
            return
        mid = lambda p, q: ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        ab, bc, cd = mid(a, b), mid(b, c2), mid(c2, d)
        abc, bcd = mid(ab, bc), mid(bc, cd)
        m = mid(abc, bcd)
        flatten((a, ab, abc, m), depth + 1)
        flatten((m, bcd, cd, d), depth + 1)
    for i, (a, b) in enumerate(zip(line, line[1:])):
        chord = ((b[0] - a[0]) / lengths[i], (b[1] - a[1]) / lengths[i])
        ha, hb = handle(i, chord, lengths[i]), handle(i + 1, chord, lengths[i])
        flatten((a, (a[0] + ha[0], a[1] + ha[1]), (b[0] - hb[0], b[1] - hb[1]), b))
    return out


PATH_WEAR_MIN_WIDTH_M = 1.4     # narrower gravel stays loose all over
PATH_WEAR_TWO_TRACKS_M = 1.8    # from this width on: two wheel tracks; below, one trodden middle
PATH_WEAR_EDGE_M = 0.12         # how far past a track's width the packed look fades out (a soft edge would close the middle string)


GRAVEL_TRACK_SURFACE = "gravel-track"  # gravel with grass down the middle (grusväg med gräsmitt)
GRASS_MIDDLE_CLEAR_M = 1.5    # the grass middle stops this far from any other road (wheels turn in and out there)
GRASS_MIDDLE_TAPER_M = 1.5    # ... and narrows to nothing over this much road before that
GRASS_MIDDLE_STEP_M = 0.25    # centreline sampling for where it is clear of the other roads
GRASS_MIDDLE_TOL = 0.05       # flattening tolerance of the other roads' outlines for that test


def _grass_middle_spans(line: list, others) -> list:
    """Stations [a, b] of the centreline farther than GRASS_MIDDLE_CLEAR_M from every other road (`others`, a
    shapely geometry or None): where a gravel track keeps its grass middle."""
    from shapely.geometry import Point
    length = sum(math.dist(a, b) for a, b in zip(line, line[1:]))
    if length <= 0:
        return []
    if others is None or others.is_empty:
        return [[0.0, round(length, 3)]]
    n = max(1, math.ceil(length / GRASS_MIDDLE_STEP_M))
    stations = [length * i / n for i in range(n + 1)]
    clear = []
    for st in stations:
        at, x, y = 0.0, line[-1][0], line[-1][1]
        for a, b in zip(line, line[1:]):
            d = math.dist(a, b)
            if at + d >= st and d > 0:
                t = (st - at) / d
                x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                break
            at += d
        clear.append(others.distance(Point(x, y)) > GRASS_MIDDLE_CLEAR_M)
    spans, start = [], None
    for st, ok in zip(stations, clear):
        if ok and start is None:
            start = st
        elif not ok and start is not None:
            spans.append([round(start, 3), round(st, 3)])
            start = None
    if start is not None:
        spans.append([round(start, 3), round(length, 3)])
    return [s for s in spans if s[1] - s[0] > 2 * GRASS_MIDDLE_TAPER_M]


def _path_wear(surface: str, width: float, feature_id: str, grass_middle: list | None = None) -> dict | None:
    """Where traffic has packed a gravel path's stones into the fines (blender/README.md "Shaping: path
    transitions", wear): two wheel tracks on a road, one trodden band on a footpath. Metres from the centreline.
    `grass_middle` (a gravel track's spans, `_grass_middle_spans`): two tracks whatever the width, grass between
    them instead of the loose string."""
    if surface != "gravel" or (width < PATH_WEAR_MIN_WIDTH_M and grass_middle is None):
        return None
    import zlib
    seed = zlib.crc32(feature_id.encode("utf-8")) & 0x7FFFFFFF
    if grass_middle is not None:
        track, spacing = round(min(0.6, width * 0.22), 2), round(min(1.6, width * 0.55), 2)
        return {"tracks": 2, "trackWidthM": track, "trackSpacingM": spacing, "edgeM": PATH_WEAR_EDGE_M,
                "strength": 1, "seed": seed,
                "grassMiddle": {"halfWidthM": round(max(0.12, (spacing - track) / 2 * 0.7), 2), "edgeM": 0.1,
                                "taperM": GRASS_MIDDLE_TAPER_M, "spans": grass_middle}}
    if width < PATH_WEAR_TWO_TRACKS_M:
        return {"tracks": 1, "trackWidthM": round(width * 0.45, 2), "trackSpacingM": 0, "edgeM": PATH_WEAR_EDGE_M,
                "strength": 0.8, "seed": seed}
    # Loose gravel on both shoulders and in a string down the middle, the two tracks between them.
    return {"tracks": 2, "trackWidthM": round(min(0.7, width * 0.24), 2),
            "trackSpacingM": round(min(1.6, width * 0.5), 2), "edgeM": PATH_WEAR_EDGE_M, "strength": 1, "seed": seed}


def _path_transition_entries(rows: list, feature_shapes: dict) -> list:
    """The sidecar's `transitions`: per gravel / dirt path feature with a centreline, its end and section
    transitions and, on gravel, its wear. A feature with neither has no entry."""
    entries = []
    others = None  # the roads that are no gravel track, for where a gravel track's grass middle stops
    for row in rows:
        surface = _row_surface(row)
        if row["type"] != "path" or surface not in ("gravel", "dirt"):
            continue
        attrs = json.loads(row["attributes_json"] or "{}")
        transitions = attrs.get("pathTransitions")
        geometry = json.loads(row["geometry_json"])
        centerline = geometry.get("centerline")
        if geometry.get("crs") != "EPSG:3006":
            continue
        if not centerline:
            continue
        if not isinstance(transitions, list):
            transitions = []
        line = _transition_centerline(centerline)
        length = sum(math.dist(a, b) for a, b in zip(line, line[1:]))
        grass_middle = None
        if _row_raw_surface(row) == GRAVEL_TRACK_SURFACE and len(line) >= 2:
            if others is None:
                from shapely import unary_union
                shapes = [_row_shape(r, GRASS_MIDDLE_TOL) for r in rows
                          if r["type"] in ROADS_TYPES and _row_raw_surface(r) != GRAVEL_TRACK_SURFACE]
                others = unary_union([g for g in shapes if g is not None])
            grass_middle = _grass_middle_spans(line, others)
        wear = _path_wear(surface, centerline["widthM"], row["id"], grass_middle)
        if not transitions and not wear:
            continue
        valid = []
        occupied = []
        ids = set()
        for t in transitions:
            if not isinstance(t, dict) or t.get("pattern") not in ("soft-fade", "overgrown-gravel", "wheel-tracks"):
                continue
            try:
                numeric = ("startM", "transitionLengthM", "holdLengthM", "fadeLengthM", "centerGrassReachM", "trackWidthM", "trackSpacingM", "edgeIrregularity", "dirtAmount", "variation", "seed")
                if any(isinstance(t[k], bool) or not isinstance(t[k], (int, float)) or not math.isfinite(t[k]) or t[k] < 0 for k in numeric):
                    continue
                if not isinstance(t.get("id"), str) or not t["id"].strip() or t["id"] in ids:
                    continue
                if t.get("placement") not in ("start", "end", "section") or t.get("ending") not in ("grass", "continue") or t.get("direction") not in (-1, 1):
                    continue
                if any(t[k] > 1 for k in ("edgeIrregularity", "dirtAmount", "variation")) or t["seed"] != int(t["seed"]) or t["seed"] > 9007199254740991:
                    continue
                if min(t[k] for k in ("transitionLengthM", "trackWidthM", "trackSpacingM")) <= 0 or t["trackSpacingM"] + t["trackWidthM"] > centerline["widthM"]:
                    continue
                total = sum(t[k] for k in ("transitionLengthM", "holdLengthM", "fadeLengthM"))
                direction = -1 if t["placement"] == "start" else 1 if t["placement"] == "end" else t["direction"]
                start = total if t["placement"] == "start" else length - total if t["placement"] == "end" else t["startM"]
                end = start + direction * total
                lo, hi = sorted((start - direction * t["centerGrassReachM"], end))
                if direction not in (-1, 1) or not all(math.isfinite(v) for v in (total, start, end)) or total <= 0 or lo < -1e-6 or hi > length + 1e-6:
                    continue
                lo, hi = sorted((start - direction * t["centerGrassReachM"], length if direction == 1 else 0))
                if any(min(hi, b) - max(lo, a) > 1e-6 for a, b in occupied):
                    continue
                occupied.append((lo, hi))
                ids.add(t["id"])
                valid.append({**t, "startM": start, "direction": direction})
            except (KeyError, TypeError, ValueError):
                continue
        for shape in sorted(feature_shapes.get(row["id"], [])):
            if valid or wear:
                entries.append({"featureId": row["id"], "shape": shape, "surface": surface,
                                "widthM": centerline["widthM"], "lengthM": length,
                                "centerline3006": [list(p) for p in line], "transitions": valid,
                                **({"wear": wear} if wear else {})})
    return sorted(entries, key=lambda e: (e["shape"], e["featureId"]))


def _road_regions(roads: list[MergedRoad], names: list[str], rows: list, tol: float, to_svg) -> dict:
    """The sidecar's content: per road shape its dominant surface (by the
    area of the pieces that carry one) and every piece in it - id, feature
    number, surface, source and the roads a junction piece was made for - with
    its outline in SVG units, for the Blender step that cuts the mesh."""
    by_id = {r["id"]: r for r in rows}
    shapes: dict[str, str] = {}
    regions: dict[str, dict] = {}
    for road, name in zip(roads, names):
        pieces = []
        area: dict[str, float] = {}
        for fid in road.ids:
            r = by_id.get(fid)
            if r is None:
                continue
            shape = _row_shape(r, tol)
            if shape is None:
                continue
            surface = road.surface or _row_surface(r)
            if surface:
                area[surface] = area.get(surface, 0.0) + shape.area
            refs = [x for x in (r["source_ref"] or "").split(",") if x] if r["source"] == ROAD_JUNCTIONS_SOURCE else []
            pieces.append({
                "id": fid,
                "featureNo": r["feature_no"],
                "surface": surface,
                "source": r["source"],
                "for": [by_id[x]["feature_no"] for x in refs if x in by_id],
                "rings": [[[round(x, 3), round(y, 3)] for x, y in map(to_svg, poly.exterior.coords)] for poly in _polygons(shape)],
            })
        dominant = max(area, key=area.get) if area else None
        if dominant:
            shapes[name] = dominant
        regions[name] = {"surface": dominant, "mixed": len(area) > 1, "pieces": pieces}
    result = {"shapes": dict(sorted(shapes.items())), "regions": regions}
    feature_shapes = {}
    for road, name in zip(roads, names):
        for fid in road.ids:
            feature_shapes.setdefault(fid, []).append(name)
    transitions = _path_transition_entries(rows, feature_shapes)
    if transitions:
        result["transitions"] = transitions
    return result


def _write_path_surfaces(svg: Path, regions: dict) -> Path:
    """Write the road-surface sidecar of `svg` (path_surfaces_file)."""
    out = path_surfaces_file(svg)
    out.write_text(json.dumps({
        "format": PATH_REGIONS_FORMAT,
        "note": "The surfaces of the road shapes of the SVG next to this file (the Draw panel's path surface). "
                "shapes: each shape's dominant surface, what Unity's golfmap.paths.materials uses until the "
                "Blender step has cut a mixed shape's mesh apart; regions: every piece of each shape with its "
                "surface and outline (SVG units), the input of that cut. OPCD names the meshes Spline_<shape>_....",
        "svg": svg.name,
        **regions,
    }, indent=1) + "\n", encoding="utf-8")
    return out


def _path_surface_changes(old: dict | None, new: dict) -> tuple[list[str], list[str]]:
    """What a sidecar written now says that the one of the last SVG export
    (`old`, None when there is none) did not: report lines for the pieces
    whose surface changed, and warnings for what the meshes built from that
    SVG cannot follow - road shapes that came or went, pieces whose outline
    moved."""
    if old is None:
        return [], []

    def pieces(doc: dict) -> dict[str, tuple[str, dict]]:
        return {p["id"]: (name, p) for name, r in (doc.get("regions") or {}).items() for p in r.get("pieces") or []}

    before, after = pieces(old), pieces(new)
    surfaced: dict[str, list[str]] = {}
    moved: set[str] = set()
    regrassed: set[str] = set()
    for fid, (name, p) in after.items():
        was = before.get(fid)
        if was is None:
            continue
        if was[1].get("surface") != p.get("surface"):
            surfaced.setdefault(name, []).append(f"{was[1].get('surface') or 'none'} -> {p.get('surface') or 'none'}")
            if (was[1].get("surface") == GRASS_TRACK_SURFACE) != (p.get("surface") == GRASS_TRACK_SURFACE):
                regrassed.add(was[0])
        if was[0] == name and was[1].get("rings") != p.get("rings"):
            moved.add(name)
    lines = []
    if old.get("transitions", []) != new.get("transitions", []):
        lines.append("path transitions changed; reapply Blender shaping and refresh Unity")
    for name in sorted(surfaced):
        region = new["regions"][name]
        state = "mixed" if region["mixed"] else (region["surface"] or "no surface")
        lines.append(f"{name}: {len(surfaced[name])} piece(s) changed surface ({', '.join(sorted(set(surfaced[name])))}); now {state}")
    warnings = []
    if regrassed:
        warnings.append(f"warning: {', '.join(sorted(regrassed))} changed between a grass track and a hard surface: a grass track is "
                        "built as rough, a hard path as a path mesh, so this needs the SVG export and the OPCD build")
    came = sorted(set(new.get("regions") or {}) - set(old.get("regions") or {}))
    gone = sorted(set(old.get("regions") or {}) - set(new.get("regions") or {}))
    if came or gone:
        warnings.append("warning: the road shapes differ from the last SVG export's"
                        + (f" (new: {', '.join(came)})" if came else "") + (f" (gone: {', '.join(gone)})" if gone else "")
                        + ": the meshes do not have them; export the SVG and build it in OPCD")
    if moved:
        warnings.append(f"warning: the outline of {', '.join(sorted(moved))} moved since the last SVG export: the meshes keep "
                        "the old outline until the SVG is exported and built in OPCD")
    return lines, warnings


def _merged_roads(rows: list, fills: dict[str, str], tol: float) -> tuple[list[MergedRoad], str]:
    """The road features (ROADS_TYPES) merged into clean shapes per type (see
    ROADS_CLOSE_M), in the paint order of each shape's first feature, and a
    note on what the merge did ("" when there are no roads). Grass tracks are
    merged on their own, as rough, under the hard roads."""
    from shapely import unary_union
    from shapely.geometry import Polygon

    pieces: dict[str, list[tuple[str, object, str | None]]] = {}
    for row in rows:
        kind = row["type"]
        if kind not in ROADS_TYPES or not fills.get(kind):
            continue
        shape = _row_shape(row, tol)
        if shape is not None:
            pieces.setdefault(kind, []).append((row["id"], shape, _row_surface(row)))

    def cleaned(raw):
        # Closing fills slits and notches, opening drops hairline spurs.
        clean = (raw.buffer(ROADS_CLOSE_M, quad_segs=4)
                 .buffer(-ROADS_CLOSE_M - ROADS_OPEN_M, quad_segs=4)
                 .buffer(ROADS_OPEN_M, quad_segs=4))
        return clean.simplify(tol / 2)

    def without_small_holes(poly):
        return Polygon(poly.exterior, [h for h in poly.interiors if Polygon(h).area >= ROADS_MIN_HOLE_M2])

    out: list[tuple[tuple[int, int], MergedRoad]] = []
    merged = 0
    tracks = 0
    for kind, items in pieces.items():
        order = {fid: i for i, (fid, _, _) in enumerate(items)}
        # Grass tracks apart only when the type keeps its own fill (--map gave it one otherwise).
        split_grass = fills[kind] == GSPRO_FILLS.get(kind)
        hard = [(fid, s) for fid, s, surf in items if not (split_grass and surf == GRASS_TRACK_SURFACE)]
        grass = [(fid, s) for fid, s, surf in items if split_grass and surf == GRASS_TRACK_SURFACE]
        network = cleaned(unary_union([s for _, s in hard])) if hard else None
        groups = [(None, fills[kind], hard, 1, network)]
        if grass:
            track = cleaned(unary_union([s for _, s in grass]))
            if network is not None:
                # Under the hard roads, reaching PATH_SURFACE_OVERLAP_M under them
                # and no further (cut by a road along its edge, a whole track
                # left a sliver of rough beside it); no part thinner than
                # GRASS_TRACK_MIN_WIDTH_M (a track that thin is no track).
                track = track.difference(network.buffer(-PATH_SURFACE_OVERLAP_M, quad_segs=4))
            r = GRASS_TRACK_MIN_WIDTH_M / 2
            # The opening's arcs and the cut's intersections put vertices millimetres
            # apart (OPCD merges those into degenerate faces): 2 cm is accuracy enough for rough.
            track = track.buffer(-r, quad_segs=8).buffer(r, quad_segs=8).simplify(0.02)
            groups.insert(0, (GRASS_TRACK_SURFACE, OPCD_PALETTE[GRASS_TRACK_FILL], grass, 0, track))
        for surface, fill, members, rank, shape in groups:
            if shape is None:
                continue
            for poly in _polygons(shape):
                if poly.area < PATH_SURFACE_MIN_M2:
                    continue
                poly = without_small_holes(poly)
                ids = sorted((fid for fid, s in members if s.intersects(poly)), key=order.get)
                if not ids:
                    continue
                out.append(((rank, order[ids[0]]), MergedRoad(kind, fill, poly, ids, surface)))
                merged += len(ids)
                tracks += surface == GRASS_TRACK_SURFACE
    out.sort(key=lambda t: t[0])
    roads = [r for _, r in out]
    if not roads:
        return [], ""
    note = (f"{merged} road piece(s) merged into {len(roads)} shape(s), slits and gaps "
            f"under {2 * ROADS_CLOSE_M:g} m closed")
    if tracks:
        note += f"; {tracks} grass track(s) written as {GRASS_TRACK_FILL}"
    return roads, note


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
        shape = _row_shape(row, tol)
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
        shape = _row_shape(r, tol)
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


# Unnumbered features (generated ones, or a database from before the server's
# migration 026) are named after their id instead: this many characters of it.
UNNUMBERED_ID_LEN = 5


def _shape_ids(rows_oldest_first: list) -> dict[str, str]:
    """The id part of each feature's shape name: its per-course number in hex
    (`feature_no`, handed out by the server and never reused, so the name
    never changes). A feature without a number takes UNNUMBERED_ID_LEN
    characters of its id, or as many more as it needs to differ from every
    name taken before it, so it never renames an older one."""
    short: dict[str, str] = {}
    taken: set[str] = set()
    for r in rows_oldest_first:
        if r["feature_no"] is not None:
            short[r["id"]] = f"{r['feature_no']:x}"
            taken.add(short[r["id"]])
    for r in rows_oldest_first:
        if r["feature_no"] is not None:
            continue
        key = re.sub(r"[^0-9A-Za-z]", "", str(r["id"])).lower()
        n = UNNUMBERED_ID_LEN
        while key[:n] in taken and n < len(key):
            n += 1
        if key[:n] in taken:  # the same id once stripped, e.g. "a-1" and "a1"
            raise SystemExit(f"error: feature id {r['id']} gives the same shape name as another feature")
        short[r["id"]] = key[:n]
        taken.add(key[:n])
    return short


def _road_names(roads: list[MergedRoad], rows_oldest_first: list, shape_ids: dict[str, str]) -> list[str]:
    """The id part of each merged road's shape name (`roads_<part>`), like
    every other shape's: the lowest `feature_no` among the pieces merged into
    it, in hex, so adding, removing or reordering an unrelated road never
    renames it (the old `roads_<i>` counted them in paint order). A road of
    unnumbered pieces only (generated kerb fillets) takes the oldest piece's
    `_shape_ids` name. Names are unique: where two roads would share one (a
    piece reaching into both, when the merge splits a thin neck), the road
    whose own candidates rank first keeps it and the other falls back to its
    next piece, then to a `_2`, `_3`… suffix."""
    number = {r["id"]: r["feature_no"] for r in rows_oldest_first}
    age = {r["id"]: i for i, r in enumerate(rows_oldest_first)}

    def candidates(road: MergedRoad) -> list[tuple[int, int, str]]:
        numbered = sorted(number[f] for f in road.ids if number.get(f) is not None)
        unnumbered = sorted((f for f in road.ids if f in age and number.get(f) is None), key=age.get)
        return ([(0, n, f"{n:x}") for n in numbered]
                + [(1, age[f], shape_ids[f]) for f in unnumbered if f in shape_ids])

    names: list[str | None] = [None] * len(roads)
    taken: set[str] = set()
    ranked = sorted(range(len(roads)), key=lambda i: ([c[:2] for c in candidates(roads[i])], roads[i].ids))
    for i in ranked:
        cands = [c[2] for c in candidates(roads[i])]
        if not cands:  # no piece the course knows (cannot happen from cmd_svg): stay unique anyway
            cands = [re.sub(r"[^0-9A-Za-z]", "", roads[i].ids[0]).lower()[:UNNUMBERED_ID_LEN] or "road"]
        name = next((c for c in cands if c not in taken), None)
        k = 2
        while name is None or name in taken:
            name = f"{cands[0]}_{k}"
            k += 1
        names[i] = name
        taken.add(name)
    return names  # type: ignore[return-value]


# A green's edge must meet fairway or semi rough: OPCD builds a blend mesh
# between a green and what surrounds it, and Omberg's hole 13 (green and two
# bunkers lying straight in rough, 2-3 m apart) failed the whole build without
# a word, where each of the three alone built. The band is what lies just
# outside the green as painted (the topmost shape there); bits under
# GREEN_BORDER_MIN_M2 are snapping noise along a shared edge.
GREEN_BORDER_BAND_M = 0.5
GREEN_BORDER_OK = ("fairway", "semi_rough")
GREEN_BORDER_MIN_M2 = 0.25
# Nothing painted there: OPCD's own outer surface (Outer_Deep_Sat).
GREEN_BORDER_NOTHING = "nothing (OPCD outer deep rough)"
# A shape whose visible part is under this share of it is covered by the
# shapes painted above it: OPCD makes no mesh for it.
HIDDEN_VISIBLE_SHARE = 0.01


# A corner sharper than this is a spike, not a drawn bend: a lumpy union, a
# road-edge fill's wedge (Omberg's driving-range fairway failed OPCD with two
# 19° spikes and 2 cm steps). Measured between the outline points at least
# SHARP_CORNER_REACH_M along the edge on each side, so a densely flattened
# curve reads as the bend it is, not as its tiny segments.
SHARP_CORNER_DEG = 25.0
SHARP_CORNER_REACH_M = 0.5


def _sharp_corners(shape) -> list[tuple[float, float, float]]:
    """The spikes in a shape's outline: [(x, y, angle in degrees)], one per
    run of sharp vertices (its sharpest), on every ring."""
    import math

    out = []
    for poly in _polygons(shape):
        for ring in (poly.exterior, *poly.interiors):
            pts = list(ring.coords)[:-1]
            pts = [p for k, p in enumerate(pts) if k == 0 or p != pts[k - 1]]
            n = len(pts)
            if n < 3 or ring.length < 4 * SHARP_CORNER_REACH_M:
                continue
            seg = [math.dist(pts[k], pts[(k + 1) % n]) for k in range(n)]

            def reach(k, step):
                j, run = k, 0.0
                while run < SHARP_CORNER_REACH_M:
                    run += seg[j if step > 0 else (j - 1) % n]
                    j = (j + step) % n
                    if j == k:
                        break
                return pts[j]

            angles = []
            for k in range(n):
                a, b, c = reach(k, -1), pts[k], reach(k, 1)
                v1, v2 = (a[0] - b[0], a[1] - b[1]), (c[0] - b[0], c[1] - b[1])
                d = math.hypot(*v1) * math.hypot(*v2)
                angles.append(math.degrees(math.acos(max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / d)))) if d else 180.0)
            sharp = [k for k in range(n) if angles[k] < SHARP_CORNER_DEG]
            # One spike per run of neighbouring sharp vertices (they share the reach).
            runs: list[list[int]] = []
            for k in sharp:
                if runs and k - runs[-1][-1] <= 2:
                    runs[-1].append(k)
                else:
                    runs.append([k])
            if len(runs) > 1 and runs[0][0] + n - runs[-1][-1] <= 2:
                runs[0] = runs.pop() + runs[0]
            for r in runs:
                k = min(r, key=lambda k: angles[k])
                out.append((pts[k][0], pts[k][1], angles[k]))
    return out


def _paint_tops(paint: list, i: int, area) -> dict[str, float]:
    """What is seen on top within `area`, painting `paint` (bottom first) but
    leaving out shape `i`: {kind: m2}, plus GREEN_BORDER_NOTHING for the part
    no shape covers."""
    seen: dict[str, float] = {}
    left = area
    for j in range(len(paint) - 1, -1, -1):
        if j == i or left.is_empty:
            continue
        _, _, kind, shape = paint[j]
        if shape is None or not shape.intersects(left):
            continue
        part = left.intersection(shape).area
        if part > 0:
            seen[kind] = seen.get(kind, 0.0) + part
            left = left.difference(shape)
    if not left.is_empty and left.area > 0:
        seen[GREEN_BORDER_NOTHING] = left.area
    return seen


def _green_border_problems(paint: list) -> list[tuple[str, dict[str, float]]]:
    """Greens whose edge meets anything but fairway or semi rough, as painted:
    [(shape name, {what it meets: m2})]. `paint` is [(layer, name, kind,
    shapely shape)] in paint order, bottom first."""
    problems = []
    for i, (_, name, kind, shape) in enumerate(paint):
        if kind != "green" or shape is None or shape.is_empty:
            continue
        band = shape.buffer(GREEN_BORDER_BAND_M).difference(shape)
        bad = {k: a for k, a in _paint_tops(paint, i, band).items()
               if k not in GREEN_BORDER_OK and a >= GREEN_BORDER_MIN_M2}
        if bad:
            problems.append((name, bad))
    return problems


def _hidden_shapes(paint: list) -> list[tuple[str, list[str]]]:
    """Shapes the ones painted above them cover (all but HIDDEN_VISIBLE_SHARE):
    [(shape name, [names of the shapes above that overlap it])]."""
    from shapely import STRtree, unary_union

    shapes = [s for *_, s in paint]
    tree = STRtree([s for s in shapes if s is not None])
    index = [i for i, s in enumerate(shapes) if s is not None]
    hidden = []
    for i, (_, name, _, shape) in enumerate(paint):
        if shape is None or shape.is_empty or shape.area <= 0:
            continue
        above = [index[k] for k in tree.query(shape) if index[k] > i]
        if not above:
            continue
        over = [j for j in above if paint[j][3].intersection(shape).area > 0]
        if over and shape.difference(unary_union([paint[j][3] for j in over])).area < HIDDEN_VISIBLE_SHARE * shape.area:
            hidden.append((name, [paint[j][1] for j in over]))
    return hidden


def cmd_svg(bbox, out: Path, db_path: Path, course_ident: str,
            flatten: float | None, precision: int, mapped: dict[str, str],
            stack: str = "opcd", extent: Extent | None = None,
            exclude_ids: set[str] | None = None, exclude_types: set[str] | None = None,
            paths_only: bool = False) -> None:
    """`paths_only`: rewrite only the road-surface sidecar of the SVG at `out`
    (which must exist), from the course as it is now - a path's surface
    changed, its outline did not, so the SVG and the meshes built from it
    stand. Reports what changed against the sidecar it replaces."""
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
    # From every shape the course could write, oldest first, so excluding one
    # never changes another's, and a new one never renames an older one.
    shapes = sorted((r for r in rows if r["type"] in fills), key=lambda r: (r["created_at"] or "", r["id"]))
    shape_ids = _shape_ids(shapes)
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

    # Shapes are named hole_<hole>_<feature number in hex> (others_<number>
    # off-hole; _shape_ids). OPCD carries the name into the mesh
    # (Spline_hole_2_1a_Bunker_-_Mesh) and Unity keys saved edits to it, so it
    # must not change when other features on the hole do. The mesh keeps the
    # material from the fill, so the name only has to say which hole and which
    # feature.
    layers: dict[str, list[str]] = {}
    painted: dict[str, list] = {}
    written: dict[str, int] = {}
    skipped: dict[str, int] = {}
    slabs = 0
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
    if paths_only:
        if not out.exists():
            raise SystemExit(f"error: {out} does not exist: export the SVG once first (the surfaces file describes its road shapes)")
        names = [f"roads_{part}" for part in _road_names(roads, shapes, shape_ids)]
        regions = _road_regions(roads, names, rows, tol, to_svg)
        sidecar = path_surfaces_file(out)
        try:
            old = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.exists() else None
        except ValueError:
            old = None
        changes, warnings = _path_surface_changes(old, regions)
        _write_path_surfaces(out, regions)
        mixed = sorted(n for n, r in regions["regions"].items() if r["mixed"])
        print(f"Wrote {sidecar}")
        print(f"  {course['name']} ({course['id']}): {len(regions['shapes'])} road shape(s) with a surface"
              + (f"; {len(mixed)} of mixed surfaces, for Blender to cut: {', '.join(mixed)}" if mixed else ""))
        for line in changes or ([] if old is None else ["no path changed surface since the last export"]):
            print(f"  {line}")
        for line in warnings:
            print(f"  {line}")
        return
    for row in rows:
        kind = row["type"]
        fill = fills.get(kind)
        if not fill:
            if kind == ROCK_SLAB_TYPE:   # no OPCD surface by design: shaping-global cuts it out of the meshes
                slabs += 1
            elif kind == POWER_LINE_FEATURE_TYPE:   # overhead, no surface: only the trees export reads it
                pass
            else:
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
            whole = _row_shape(row, tol)
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
        name = f"{stem}_{shape_ids[row['id']]}"
        written[kind] = written.get(kind, 0) + 1
        # Several rings on one feature = outer ring plus holes; even-odd makes
        # the inner rings punch through.
        rule = ' fill-rule="evenodd"' if len(subpaths) > 1 else ""
        # The shape as written, for the checks of what OPCD will see (paint order).
        painted.setdefault(layer, []).append((name, kind, shape if shape is not None else _row_shape(row, tol)))
        layers.setdefault(layer, []).append(
            f'    <path id="{name}" inkscape:label="{name}" data-type="{kind}"'
            f' data-feature-id="{row["id"]}"'
            f' style="{PATH_STYLE.format(fill=fill)}"{rule} d="{" ".join(subpaths)}"/>'
        )
    # Merged roads are named after their lowest-numbered piece (_road_names),
    # so a road drawn elsewhere never renames one; still written in paint order.
    road_names = [f"roads_{part}" for part in _road_names(roads, shapes, shape_ids)]
    for road, name in zip(roads, road_names):
        painted.setdefault(ROADS_LAYER, []).append((name, road.kind, road.shape))
        subpaths = _shape_subpaths(road.shape, to_svg, precision)
        rule = ' fill-rule="evenodd"' if len(subpaths) > 1 else ""
        surface = f' data-surface="{road.surface}"' if road.surface else ""
        layers.setdefault(ROADS_LAYER, []).append(
            f'    <path id="{name}" inkscape:label="{name}" data-type="{road.kind}"{surface}'
            f' data-feature-id="{" ".join(road.ids)}"'
            f' style="{PATH_STYLE.format(fill=road.fill)}"{rule} d="{" ".join(subpaths)}"/>'
        )

    # Document order matches the OPCD files: the off-hole layer at the bottom,
    # then the holes descending so Hole1 ends up topmost in Inkscape, and the
    # roads over everything.
    layer_ranks = {f"Hole{r['hole_number']}": r['group_rank'] for r in rows
                   if r['hole_number'] is not None and r['type'] not in ROADS_TYPES}
    order = sorted((k for k in layers if k.startswith("Hole")), key=lambda k: -layer_ranks[k])
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
        # Keep OPCD's Hole<N> label: it drives mesh construction. The human
        # name is metadata, so renaming a group never renames its meshes.
        group_name = next((r["drawing_group_name"] for r in rows
                           if r["hole_number"] is not None and f"Hole{r['hole_number']}" == layer
                           and r["drawing_group_name"]), None)
        group_attr = f' data-group-name="{html.escape(group_name, quote=True)}"' if group_name else ''
        lines.append(f'  <g inkscape:groupmode="layer" id="layer{i}" inkscape:label="{layer}"{group_attr}>')
        lines.extend(layers[layer])
        lines.append("  </g>")
    lines.append("</svg>")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    regions = _road_regions(roads, road_names, rows, tol, to_svg)
    surfaces_out = _write_path_surfaces(out, regions)

    total = sum(len(v) for v in layers.values())
    kinds = ", ".join(f"{k} {v}" for k, v in sorted(written.items(), key=lambda kv: -kv[1]))
    curves = f"flattened to polylines at {flatten:g} m" if flatten is not None else "cubic beziers"
    order_note = ("app order with " + "/".join(TOP_TYPES) + " lifted to the top"
                  if stack == "opcd" else "the app's own z-order")
    print(f"Wrote {out}")
    print(f"  {course['name']} ({course['id']}): {total} features in {len(order)} layer(s) - {kinds}")
    mixed = sorted(n for n, r in regions["regions"].items() if r["mixed"])
    print(f"  wrote {surfaces_out.name} ({len(regions['shapes'])} road shape(s) with a surface"
          + (f"; {len(mixed)} of mixed surfaces, for Blender to cut: {', '.join(mixed)}" if mixed else "") + ")")
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
    if slabs:
        print(f"  rock slabs left out (cut out of the meshes in Blender by the shaping layer, not an OPCD surface): {slabs} feature(s)")
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
    paint = [(layer, name, kind, shape) for layer in order for name, kind, shape in painted.get(layer, [])]
    for name, meets in _green_border_problems(paint):
        detail = ", ".join(f"{k} {a:.1f} m2" for k, a in sorted(meets.items(), key=lambda kv: -kv[1]))
        print(f"  warning: green {name} meets more than fairway/semi rough at its edge ({detail}): "
              f"OPCD's green blend can fail the whole build - surround it with fairway or semi rough")
    for _, name, kind, shape in paint:
        spikes = _sharp_corners(shape) if shape is not None else []
        if spikes:
            x, y, angle = min(spikes, key=lambda s: s[2])
            sx, sy = to_svg((x, y))
            print(f"  warning: {kind} {name} has {len(spikes)} spike(s) under {SHARP_CORNER_DEG:g}° "
                  f"(sharpest {angle:.0f}° at SVG {sx:.0f},{sy:.0f}): a lumpy union or a fill artefact? smooth it")
    for name, above in _hidden_shapes(paint):
        listed = ", ".join(above[:3]) + (" …" if len(above) > 3 else "")
        print(f"  warning: {name} is covered by the shapes above it ({listed}): OPCD makes no mesh for it")


# --- Command: shaping-global --------------------------------------------------
# The generated shaping layer blender/SHAPING-PLAN.md replays onto the OPCD
# course meshes in Blender (`docs/gspro/<course>/shaping/00-global.gen.json`,
# format golfmap-shaping-layer-v1): the area edits every course gets, written
# from the course DB so a tee or lot drawn tomorrow is in the next generation
# without anyone editing a layer. Applied in list order:
#   1. `afrod.flattentees` on every tee mesh (select by type);
#   2. `afrod.cutcartpaths` on the concrete paths only (select by feature id;
#      the cut simulates concrete slabs and is wrong on asphalt, gravel and
#      dirt; none when the course has no concrete path, or when it has mixed
#      road shapes, see below), then `afrod.smoothcartpaths` on every road/path
#      mesh (select by type). The cut paint is decided per shape from the
#      SVG's data-surface (grass tracks), else the op's `pathSurfaces`, else
#      the DB - see shape_apply.cut_paint_mode;
#   2b. `golfmap.split_surfaces` on the road shapes of more than one surface
#      (select by shape name, `roads_<n>` as the SVG export names them,
#      worked out here the same way: _mixed_road_shapes): Blender cuts their
#      meshes along the seams of the export's `<stem>-paths.json` sidecar and
#      separates one object per surface (blender/tools/shape_surfaces.py);
#      after the cut and smooth, before the footprints, which then level the
#      separated parts alike (they share the seam vertices);
#   3. no op for paved lots: the road grading smooths a lot's lidar ground in
#      the DEM (a `smooth` edit, not a plane: real lots slope and bend, and a
#      plane per lot left shelves where neighbouring lots met), and the meshes
#      follow it through the conform;
#   4. `golfmap.flatten_footprint` per building pad / other plane terrain
#      edit on the course's site (`level: median` for a flat pad), when it
#      comes near a course shape at all.
# A footprint is the area that ends up level (EPSG:3006, metres); `falloffM` is
# the blend band OUTSIDE it. The DEM edits feather inside their ring instead,
# so a terrain edit's ring is shrunk by its featherM: the same level core and
# the same outer edge. No timestamps and sorted, stable ids (a pad by its
# origin_ref: pad rows get new ids on every re-import), so a
# regeneration diffs cleanly.
#
# The same command writes `10-features.gen.json` next to it (id `features`):
# one `afrod.recipe` op per course feature with a shaping recipe - the
# feature's `recipe` terrain edit (op `recipe`, origin_ref `feature:<id>`,
# params {recipe: <library id>, overrides?}; see shaping_features), else the
# course default of its surface in the recipe library for every bunker, water
# (lake) and creek. Area ops first, edge recipes after (the plan's order).

SHAPING_LAYER_FORMAT = "golfmap-shaping-layer-v1"
SHAPING_GLOBAL_ID = "global"
SHAPING_GLOBAL_FILE = "00-global.gen.json"
SHAPING_TEE_TYPE = "tee"
SHAPING_TEE_PARAMS = {"tees_flat_inset": 1, "tees_flat_outset": 3.0}
SHAPING_PATH_SMOOTH_PARAMS = {"smooth_path_distance": 3.0, "smooth_path_amt": 20}
# A pad whose falloff edge stays further than this from every course shape
# moves no mesh vertex (blends reach a few metres past a shape): left out.
SHAPING_PAD_REACH_M = 10.0
SHAPING_TERRAIN_OP = "plane"
SHAPING_COORD_DECIMALS = 2
SHAPING_SIMPLIFY_M = 0.02


def _shaping_ring(poly, tol: float = SHAPING_SIMPLIFY_M) -> list[list[float]]:
    """A polygon's outer ring as [[x, y], ...] (open, cm), simplified within `tol` (a hair by default)."""
    pts = list(poly.simplify(tol).exterior.coords)[:-1]
    return [[round(x, SHAPING_COORD_DECIMALS), round(y, SHAPING_COORD_DECIMALS)] for x, y in pts]


def _largest_polygon(shape):
    polys = _polygons(shape)
    return max(polys, key=lambda p: p.area) if polys else None


def _load_plane_edits(db_path: Path, course_id: str) -> list[sqlite3.Row]:
    """The enabled `plane` terrain edits of the course's site (none without a site)."""
    conn = _open_course_db(db_path)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        course_cols = {r[1] for r in conn.execute("PRAGMA table_info(courses)")}
        if "terrain_edits" not in tables or "site_id" not in course_cols:
            return []
        site = conn.execute("SELECT site_id FROM courses WHERE id = ?", (course_id,)).fetchone()
        if not site or not site["site_id"]:
            return []
        return conn.execute(
            """SELECT id, op, params_json, rings_json, origin, origin_ref, created_at FROM terrain_edits
               WHERE site_id = ? AND op = ? AND enabled = 1 ORDER BY created_at, id""",
            (site["site_id"], SHAPING_TERRAIN_OP),
        ).fetchall()
    finally:
        conn.close()


def _pad_slug(edit) -> str:
    ref = edit["origin_ref"]
    if ref:
        return re.sub(r"[^0-9a-z]+", "-", ref.lower()).strip("-")
    return re.sub(r"[^0-9a-z]", "", str(edit["id"]).lower())[:8]


def _course_slug(name: str) -> str:
    import unicodedata
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-") or "course"


def _shaping_json(doc: dict) -> str:
    """Indented JSON with each [x, y] pair on one line (a footprint diffs per vertex)."""
    text = json.dumps(doc, indent=2, ensure_ascii=False)
    return re.sub(r"\[\s+(-?[\d.eE+-]+),\s+(-?[\d.eE+-]+)\s+\]", r"[\1, \2]", text) + "\n"


SHAPING_COURSE_SHAPE_FLATTEN_M = 0.25


def _course_mesh_shapes(db_path: Path, rows: list, fills: dict) -> tuple[list, object]:
    """Every shape the SVG writes for this course and an STRtree over them —
    "is there a mesh near here", which the building pads ask once each.
    Bridge decks are props, not ground. Built once per batch."""
    from shapely import STRtree

    def build() -> tuple[list, object]:
        shapes = [s for r in rows if r["type"] in fills and not _is_bridge_deck(r)
                  for s in [_row_shape(r, SHAPING_COURSE_SHAPE_FLATTEN_M)] if s is not None]
        return shapes, (STRtree(shapes) if shapes else None)

    cache = _BATCH
    if cache is None or not db_path.is_file():
        return build()
    key = (_file_key(db_path), tuple(r["id"] for r in rows), tuple(sorted(fills)))
    return cache.cached("courseShapes", key, build)


def shaping_global(db_path: Path, course_ident: str) -> tuple[dict, dict]:
    """The global shaping layer for a course, and counts for the report."""
    from shapely.geometry import Polygon

    course, rows = _load_course_features(db_path, course_ident, "app")
    fills = GSPRO_FILLS
    shapes_oldest = sorted((r for r in rows if r["type"] in fills), key=lambda r: (r["created_at"] or "", r["id"]))
    shape_ids = _shape_ids(shapes_oldest)
    course_ids = {r["id"] for r in rows}
    stats: dict = {}
    ops: list[dict] = []

    tees = [r for r in rows if r["type"] == SHAPING_TEE_TYPE]
    stats["tees"] = len(tees)
    if tees:
        ops.append({"id": "tees", "op": "afrod.flattentees", "select": {"type": SHAPING_TEE_TYPE},
                    "params": dict(SHAPING_TEE_PARAMS)})
    paths = [r for r in rows if r["type"] in ROADS_TYPES and not _is_bridge_deck(r)]
    stats["paths"] = len(paths)
    mixed = _mixed_road_shapes(rows) if paths else []
    stats["mixed_roads"] = len(mixed)
    # The cut is Afrod's concrete-slab look (a cross loop every few metres, painted as an expansion joint): only on
    # paths whose surface is concrete. Asphalt, gravel, dirt ... are not cut: the loops plus smoothcartpaths'
    # topological z smoothing leave 3-4 cm kinks every ~4 m (dark bands across the path in GSPro; Vreta, roads_124).
    # A concrete piece inside a mixed road shape cannot be cut alone here (the cut runs before split_surfaces, on the
    # whole merged mesh), so with mixed shapes in the course nothing is cut and `concrete_cut_skipped` says how many.
    concrete = sorted((r for r in paths if _row_surface(r) == "concrete"), key=lambda r: r["id"])
    stats["concrete_paths"] = len(concrete)
    stats["concrete_cut_skipped"] = len(concrete) if mixed else 0
    if concrete and not mixed:
        ops.append({"id": "paths-cut", "op": "afrod.cutcartpaths", "select": {"feature": [r["id"] for r in concrete]}})
    if paths:
        ops.append({"id": "paths-smooth", "op": "afrod.smoothcartpaths", "select": {"type": "path"},
                    "params": dict(SHAPING_PATH_SMOOTH_PARAMS)})
    if mixed:
        ops.append({"id": SHAPING_SPLIT_ID, "op": "golfmap.split_surfaces", "select": {"shape": mixed}})

    # Where the meshes are: every shape the SVG writes (bridge decks are props).
    course_shapes, tree = _course_mesh_shapes(db_path, rows, fills)
    pads, used = [], set()
    stats.update(pads_far=0, lot_edits=0, stale_edits=0, bad_edits=0)
    for edit in _load_plane_edits(db_path, course["id"]):
        ref = edit["origin_ref"] or ""
        if ref.startswith("feature:"):
            # A lot plane from an older road grading (lots are smoothed now, not
            # planes): no mesh op; another course's, or a deleted feature's, is not ours.
            stats["lot_edits" if ref[len("feature:"):] in course_ids else "stale_edits"] += 1
            continue
        try:
            rings = json.loads(edit["rings_json"])
            params = json.loads(edit["params_json"] or "{}")
            ring = Polygon([(p["x"], p["y"]) for p in rings[0]])
        except (ValueError, KeyError, IndexError, TypeError):
            stats["bad_edits"] += 1
            continue
        ring = _largest_polygon(ring.buffer(0)) if not ring.is_valid else ring
        if ring is None or ring.area <= 0:
            stats["bad_edits"] += 1
            continue
        feather = float(params.get("featherM") or 0.0)
        core = _largest_polygon(ring.buffer(-feather, quad_segs=4)) if feather > 0 else ring
        falloff = feather
        if core is None:  # narrower than its feather: all of it is the blend
            core, falloff = ring, 0.0
        reach = core.buffer(falloff + SHAPING_PAD_REACH_M, quad_segs=4)
        if tree is None or not any(course_shapes[int(i)].intersects(reach) for i in tree.query(reach)):
            stats["pads_far"] += 1
            continue
        pid = base = f"pad-{_pad_slug(edit)}"
        k = 2
        while pid in used:
            pid, k = f"{base}-{k}", k + 1
        used.add(pid)
        op = {"id": pid, "op": "golfmap.flatten_footprint", "footprint3006": _shaping_ring(core),
              "level": "median" if params.get("flat") else "plane", "falloffM": falloff}
        if edit["origin"]:
            op["origin"] = edit["origin"]
        if edit["origin_ref"]:
            op["originRef"] = edit["origin_ref"]
        pads.append(op)
    pads.sort(key=lambda o: o["id"])
    ops += pads
    stats["pads"] = len(pads)

    # On the final heights too: the hard roads' fringe strips roll over into a lip above the verge, as laid asphalt
    # does (blender/README.md "Shaping: rounded hard-road edge"). After split_surfaces (each part's own surface).
    hard = [r for r in paths if _row_surface(r) in SHAPING_KERB_SURFACES]
    stats["kerb_paths"] = len(hard)
    if hard:
        ops.append({"id": SHAPING_KERB_ID, "op": "golfmap.path_kerb", "select": {"type": "path"}})

    # Last, on the final heights (the footprints above level lots and pads): gravel and dirt paths break up into the
    # grass instead of ending on a line (blender/README.md "Shaping: path edge fade"). After split_surfaces, which
    # gives every part its own surface; asphalt, concrete ... keep their crisp edge.
    soft = [r for r in paths if _row_surface(r) in SHAPING_EDGE_FADE_SURFACES]
    stats["edge_fade_paths"] = len(soft)
    if soft:
        ops.append({"id": SHAPING_EDGE_FADE_ID, "op": "golfmap.path_edge_fade", "select": {"type": "path"}})

    # After every op that moves or cuts meshes: a slab is cut out of the final surface, whatever lies under it.
    slab_ops, slab_stats = _rock_slab_ops(rows)
    ops += slab_ops
    stats.update(slab_stats)

    # Last of all: the transition and wear paint only refines and paints the path meshes in place, and a road's
    # box spans the course, so every cut-out reads it - painted before them, a paint tweak would re-cut every slab.
    entries = _path_transition_entries(rows, {r["id"]: ["eligible"] for r in paths})
    if entries:
        op = {"id": "paths-transitions", "op": "golfmap.path_transition", "select": {"type": "path"}}
        if any("wear" in e for e in entries):
            op["maxEdgeM"] = SHAPING_WEAR_MAX_EDGE_M
        ops.append(op)

    doc = {
        "format": SHAPING_LAYER_FORMAT,
        "id": SHAPING_GLOBAL_ID,
        "generated": True,
        "generator": "pipeline/gspro.py shaping-global",
        "course": {"id": course["id"], "name": course["name"]},
        "ops": ops,
    }
    return doc, stats


SHAPING_WEAR_MAX_EDGE_M = 0.2   # the middle string between two tracks is ~0.3 m wide on a 2 m path
SHAPING_SPLIT_ID = "paths-surfaces"
SHAPING_EDGE_FADE_ID = "paths-edge-fade"
SHAPING_KERB_ID = "paths-kerb"
SHAPING_KERB_SURFACES = ("asphalt", "concrete", "paving")  # shape_kerb.SURFACES
SHAPING_EDGE_FADE_SURFACES = ("gravel", "dirt")   # shape_edgefade.SURFACES

# --- Rock slabs ----------------------------------------------------------------
# A `rock_slab` feature (shared/features/rock-slab.ts, Swedish "berghäll") is no
# OPCD surface: the SVG leaves it out and its mesh comes from a `golfmap.cut_out`
# op (blender/README.md "Shaping: cut-outs"), one per slab, last in the global
# layer. Its outline is the drawn polygon grown by the feature's `marginM` (a
# slab traced tight to the rock in the photo reads too small in game; the
# Vreta ones were grown 1.5 m by hand), lightly simplified, and kept
# SHAPING_SLAB_GAP_M off every earlier slab's.
ROCK_SLAB_TYPE = "rock_slab"
SHAPING_SLAB_PREFIX = "hall"               # Spline_hall_<feature number in hex>_Rock_-_Mesh
SHAPING_SLAB_MARGIN_ATTRIBUTE, SHAPING_SLAB_TILE_ATTRIBUTE = "marginM", "uvM"
# shared/features/rock-slab.ts ROCK_SLAB_RISE_ATTRIBUTES: feature attribute -> the cut-out's `rise` key
SHAPING_SLAB_RISE_ATTRIBUTES = {"riseWaterM": "waterM", "riseTopM": "topM", "riseFootM": "footM", "riseApronM": "apronM",
                                "riseNoiseM": "noiseM", "riseMaxEdgeM": "maxEdgeM", "riseSeed": "seed"}
# rock-slab.ts ROCK_SLAB_RISE_MODE_ATTRIBUTE / ROCK_SLAB_UV_MODE_ATTRIBUTE: the cut-out's `rise.mode` and `uv`
SHAPING_SLAB_RISE_MODE_ATTRIBUTE, SHAPING_SLAB_RISE_MODES = "riseMode", ("dome", "dem")
SHAPING_SLAB_UV_MODE_ATTRIBUTE, SHAPING_SLAB_UV_MODES = "uvMode", ("planar", "box")
SHAPING_SLAB_DEM_UNUSED = ("topM", "footM")  # a dem rise (a cliff from the course DEM) has no top or foot
SHAPING_SLAB_MARGIN_M = 1.5                # the default margin; attribute marginM takes 0..5
SHAPING_SLAB_MARGIN_MAX_M = 5.0
SHAPING_SLAB_UV_M = 4.0                    # shape_apply CUT_OUT_UV_M: written only when a slab differs
SHAPING_SLAB_FLATTEN_M = 0.05              # the drawn curve flattened within this
SHAPING_SLAB_SIMPLIFY_M = 0.15             # the grown outline, lightly simplified
SHAPING_SLAB_GAP_M = 0.8                   # least distance between two slabs' outlines
# The keep-out round an earlier slab is its outline buffered by the gap plus 1 cm: the later outline's
# vertices are rounded to cm (SHAPING_COORD_DECIMALS, up to 7 mm each) and the buffer's chords cut in
# by about 1 mm, so the written outlines stay at least SHAPING_SLAB_GAP_M apart.
SHAPING_SLAB_KEEPOUT_M = SHAPING_SLAB_GAP_M + 0.01
SHAPING_SLAB_CRUMB_M2 = 0.01               # a trimmed slab's leftover piece under this is rounding dust


def _slab_number(attrs: dict, key: str, default: float, valid, rule: str, name: str, warnings: list[str]) -> float:
    """A slab's numeric attribute, `default` when unset; an invalid one (the server refuses those) also falls
    back, with a warning."""
    value = attrs.get(key)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not valid(value):
        warnings.append(f"rock slab {name}: {key} {value!r} is not {rule}; the default {default:g} is used")
        return default
    return float(value)


def _slab_choice(attrs: dict, key: str, choices: tuple, name: str, warnings: list[str]) -> str:
    """A slab's string attribute out of `choices`, the first when unset; an invalid one (the server refuses those)
    also falls back, with a warning."""
    value = attrs.get(key)
    if value is None:
        return choices[0]
    if value not in choices:
        warnings.append(f"rock slab {name}: {key} {value!r} is not one of {', '.join(choices)}; {choices[0]} is used")
        return choices[0]
    return value


def _slab_names(slabs: list) -> dict[str, str]:
    """`hall_<feature number in hex>` per slab (`slabs` in feature-number order: a numbered feature never
    changes name). A slab without a number takes a hash of its id; a name already taken gets `_2`, `_3`..."""
    names: dict[str, str] = {}
    taken: set[str] = set()
    for r in slabs:
        part = f"{r['feature_no']:x}" if r["feature_no"] is not None else f"{_id_seed(r['id']):x}"
        name, k = f"{SHAPING_SLAB_PREFIX}_{part}", 2
        while name in taken:
            name, k = f"{SHAPING_SLAB_PREFIX}_{part}_{k}", k + 1
        taken.add(name)
        names[r["id"]] = name
    return names


def _rock_slab_ops(rows: list) -> tuple[list[dict], dict]:
    """One `golfmap.cut_out` op per `rock_slab` feature, and counts for the report (`rock_slabs` written,
    `rock_slabs_skipped`, `rock_slabs_trimmed`, `rock_slab_warnings` lines). Slabs go in feature-number order;
    a later slab whose grown outline comes within SHAPING_SLAB_GAP_M of an earlier one's written outline loses
    the part inside that outline buffered by the gap, and is skipped (with a warning) when that leaves no
    single polygon."""
    from shapely.geometry import Polygon

    slabs = sorted((r for r in rows if r["type"] == ROCK_SLAB_TYPE),
                   key=lambda r: (r["feature_no"] is None, r["feature_no"] or 0, r["created_at"] or "", r["id"]))
    names = _slab_names(slabs)
    warnings: list[str] = []
    ops: list[dict] = []
    written: list = []   # the slabs' polygons as written, so far
    trimmed = 0
    for r in slabs:
        name = names[r["id"]]
        try:
            attrs = json.loads(r["attributes_json"]) if r["attributes_json"] else {}
        except ValueError:
            attrs = {}
        attrs = attrs if isinstance(attrs, dict) else {}
        margin = _slab_number(attrs, SHAPING_SLAB_MARGIN_ATTRIBUTE, SHAPING_SLAB_MARGIN_M,
                              lambda v: 0 <= v <= SHAPING_SLAB_MARGIN_MAX_M, f"between 0 and {SHAPING_SLAB_MARGIN_MAX_M:g} m",
                              name, warnings)
        uv = _slab_number(attrs, SHAPING_SLAB_TILE_ATTRIBUTE, SHAPING_SLAB_UV_M, lambda v: v > 0, "above 0", name, warnings)

        pieces = _polygons(_row_shape(r, SHAPING_SLAB_FLATTEN_M))
        drawn = max(pieces, key=lambda p: p.area) if pieces else None
        if drawn is None or drawn.area < MIN_SHAPE_AREA_M2:
            warnings.append(f"rock slab {name} ({r['id']}) is under {MIN_SHAPE_AREA_M2:g} m2 (drawn by mistake? delete it); skipped")
            continue
        if len(pieces) > 1:
            warnings.append(f"rock slab {name} ({r['id']}) is drawn as {len(pieces)} separate pieces; only the largest is cut out")
        grown = Polygon(drawn.exterior).buffer(margin, quad_segs=8).simplify(SHAPING_SLAB_SIMPLIFY_M)

        cut = False
        for polygon in written:
            keepout = polygon.buffer(SHAPING_SLAB_KEEPOUT_M, quad_segs=16)
            if grown.intersects(keepout):
                grown, cut = grown.difference(keepout), True
        parts = [p for p in _polygons(grown) if p.area >= SHAPING_SLAB_CRUMB_M2]
        if len(parts) != 1 or parts[0].interiors or parts[0].area < MIN_SHAPE_AREA_M2:
            why = ("nothing is left of it" if not parts else
                   "it would surround a slab and leave a hole" if len(parts) == 1 and parts[0].interiors else
                   "only a sliver is left" if len(parts) == 1 else f"it would be split in {len(parts)}")
            warnings.append(f"rock slab {name} ({r['id']}) skipped: kept {SHAPING_SLAB_GAP_M:g} m off the slab(s) before it, "
                            f"{why}")
            continue
        trimmed += cut
        ring = _shaping_ring(parts[0], 0.0)
        ring = [p for i, p in enumerate(ring) if p != ring[i - 1]]   # rounding to cm can merge neighbours
        if len(ring) < 3:
            warnings.append(f"rock slab {name} ({r['id']}) skipped: its outline collapsed")
            continue
        op = {"id": name.replace("_", "-"), "op": "golfmap.cut_out", "name": name, "outline3006": ring,
              "featureId": r["id"], "origin": ROCK_SLAB_TYPE,
              "note": f"rock slab {name.split('_', 1)[1]}: the drawn outline grown {margin:g} m"
                      + (f", trimmed to keep {SHAPING_SLAB_GAP_M:g} m off the slab before it" if cut else "")}
        if uv != SHAPING_SLAB_UV_M:
            op["uvM"] = uv
        uv_mode = _slab_choice(attrs, SHAPING_SLAB_UV_MODE_ATTRIBUTE, SHAPING_SLAB_UV_MODES, name, warnings)
        if uv_mode != SHAPING_SLAB_UV_MODES[0]:
            op["uv"] = uv_mode
        # A rock rising out of the ground or the water (shared/features/rock-slab.ts `rise`): passed to the cut-out
        # as is, Blender refines and lifts the slab after the cut (blender/README.md "Shaping: cut-outs"). Mode dem
        # (a cliff: the slab and its apron go to the course DEM) needs no riseTopM and has no use for riseFootM.
        rise = {k: float(attrs[a]) for a, k in SHAPING_SLAB_RISE_ATTRIBUTES.items()
                if isinstance(attrs.get(a), (int, float)) and not isinstance(attrs.get(a), bool)}
        mode = _slab_choice(attrs, SHAPING_SLAB_RISE_MODE_ATTRIBUTE, SHAPING_SLAB_RISE_MODES, name, warnings)
        if mode == "dem":
            unused = [k for k in SHAPING_SLAB_DEM_UNUSED if k in rise]
            if unused:
                warnings.append(f"rock slab {name} ({r['id']}): riseMode dem takes its heights from the DEM; "
                                + ", ".join("rise" + k[0].upper() + k[1:] for k in unused) + " left out")
            op["rise"] = dict(sorted({k: v for k, v in rise.items() if k not in unused}.items()), mode="dem")
        elif rise.get("topM", 0) > 0:
            op["rise"] = dict(sorted(rise.items()))
        elif rise:
            warnings.append(f"rock slab {name} ({r['id']}): rise* attributes without a riseTopM above 0; left flat")
        ops.append(op)
        polygon = Polygon(ring)
        written.append(polygon if polygon.is_valid else polygon.buffer(0))
    return ops, {"rock_slabs": len(ops), "rock_slabs_skipped": len(slabs) - len(ops), "rock_slabs_trimmed": trimmed,
                 "rock_slab_warnings": warnings}


def _mixed_road_shapes(rows: list) -> list[str]:
    """The merged road shapes (`roads_<n>`) whose pieces carry more than one
    surface: the shapes the SVG export's `<stem>-paths.json` marks `mixed`,
    worked out from the same rows the same way (cmd_svg: bridge decks and
    tiny shapes left out, _merged_roads, _road_names, _road_regions; without
    the export's --exclude options)."""
    fills = GSPRO_FILLS
    shapes = sorted((r for r in rows if r["type"] in fills), key=lambda r: (r["created_at"] or "", r["id"]))
    shape_ids = _shape_ids(shapes)
    rows, _, _ = _exclude_rows(rows, {r["id"] for r in rows if _is_bridge_deck(r)}, set())
    tiny = {r["id"] for r in _tiny_rows(rows, ROADS_FLATTEN_M, fills)}
    rows = [r for r in rows if r["id"] not in tiny]
    roads, _ = _merged_roads(rows, fills, ROADS_FLATTEN_M)
    if not roads:
        return []
    names = [f"roads_{part}" for part in _road_names(roads, shapes, shape_ids)]
    regions = _road_regions(roads, names, rows, ROADS_FLATTEN_M, lambda xy: xy)["regions"]
    return sorted(n for n, r in regions.items() if r["mixed"])


def _id_seed(text: str) -> int:
    """A stable seed for a feature without a number."""
    import zlib
    return zlib.crc32(text.encode("utf-8")) & 0xFFFF


def cmd_shaping_global(db_path: Path, course_ident: str, out: Path | None = None, out_dir: Path | None = None,
                       library: Path | None = None) -> Path:
    """Write 00-global.gen.json (to `out`, else into `out_dir`, else the course's
    docs folder) and 10-features.gen.json next to it. Returns the global layer's path."""
    doc, stats = shaping_global(db_path, course_ident)
    if out is None:
        folder = out_dir or REPO_ROOT / "docs" / "gspro" / _course_slug(doc["course"]["name"]) / "shaping"
        out = folder / SHAPING_GLOBAL_FILE
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(_shaping_json(doc), encoding="utf-8", newline="\n")
    counts: dict[str, int] = {}
    for op in doc["ops"]:
        counts[op["op"]] = counts.get(op["op"], 0) + 1
    print(f"Wrote {out}")
    print(f"  {doc['course']['name']} ({doc['course']['id']}): {len(doc['ops'])} op(s) - "
          + ", ".join(f"{k} {v}" for k, v in counts.items()))
    print(f"  {stats['tees']} tee(s), {stats['paths']} path piece(s) (bridge decks left out), "
          f"{stats['pads']} pad(s)")
    if stats.get("mixed_roads"):
        split = next(o for o in doc["ops"] if o["id"] == SHAPING_SPLIT_ID)
        print(f"  {stats['mixed_roads']} road shape(s) of mixed surfaces split per surface in Blender: "
              + ", ".join(split["select"]["shape"]))
    if stats["pads_far"]:
        print(f"  {stats['pads_far']} plane edit(s) further than {SHAPING_PAD_REACH_M:g} m from every course "
              f"shape left out (they move no mesh)")
    if stats["lot_edits"]:
        print(f"  {stats['lot_edits']} old lot plane edit(s) of this course's paths skipped (re-run Road grades: lots are smoothed now)")
    if stats["stale_edits"]:
        print(f"  {stats['stale_edits']} plane edit(s) of a feature not on this course (deleted, or another "
              f"course's) skipped")
    if stats["bad_edits"]:
        print(f"  warning: {stats['bad_edits']} plane edit(s) with unreadable rings skipped")
    if stats["rock_slabs"] or stats["rock_slabs_skipped"]:
        print(f"  {stats['rock_slabs']} rock slab(s) cut out of the meshes in Blender (outline grown by its margin, "
              f"{SHAPING_SLAB_GAP_M:g} m kept between slabs; {stats['rock_slabs_trimmed']} trimmed to that)"
              + (f", {stats['rock_slabs_skipped']} skipped" if stats["rock_slabs_skipped"] else ""))
        for line in stats["rock_slab_warnings"]:
            print(f"  warning: {line}")

    features_doc, fstats, warnings = shaping_features(db_path, course_ident, library)
    features_out = out.parent / SHAPING_FEATURES_FILE
    features_out.write_text(_shaping_json(features_doc), encoding="utf-8", newline="\n")
    defaults = ", ".join(f"{k} {v}" for k, v in sorted(fstats["defaults"].items())) or "none"
    print(f"Wrote {features_out}")
    print(f"  {len(features_doc['ops'])} recipe op(s): {fstats['edits']} from recipe edits, "
          f"{sum(fstats['defaults'].values())} course default(s) ({defaults})"
          + (f", {fstats['opted_out']} feature(s) with recipe none" if fstats["opted_out"] else ""))
    for line in warnings:
        print(f"  warning: {line}")
    return out


# --- Shaping: per-feature recipes (10-features.gen.json) ----------------------
# The Terrain editor's recipe edits (blender/SHAPING-PLAN.md, "Terrain editor ->
# Blender") and the course defaults as `afrod.recipe` ops, one per feature:
#   - a feature with an enabled `recipe` terrain edit on its course's site
#     (origin_ref `feature:<id>`, the feature on THIS course: an edit of another
#     course sharing the site, or of a deleted feature, is not ours) gets that
#     library recipe; `none` opts it out of any recipe, the default included;
#   - every other bunker, water (lake) and water_creek (creek) gets its
#     surface's default from the library (`default: true`, or the surfaces it is
#     the default for); paths get a recipe only from an edit;
#   - bridge decks are props, never meshes.
# Op ids are `recipe-<shape id>` (the feature number in hex, like its mesh
# name), `select` the feature id, `recipe` the library entry's `file`, `seed`
# the feature number. Overrides: the engine (blender/tools/shape_layers.py)
# decides what an afrod.recipe op may carry. When its op spec takes an
# `overrides` key the edit's overrides go there whole; otherwise the keys its
# params spec knows are merged into `params` and the rest are dropped with a
# warning (today afrod.recipe takes no params, so every override is reported,
# never written: a layer the engine rejects would stop the whole replay).

SHAPING_FEATURES_ID = "features"
SHAPING_FEATURES_FILE = "10-features.gen.json"
SHAPING_RECIPE_OP = "recipe"
SHAPING_NO_RECIPE = "none"
SHAPING_RECIPE_SURFACE = {"bunker": "bunker", "water": "lake", "water_creek": "creek", "path": "path"}
SHAPING_DEFAULT_RECIPE_TYPES = ("bunker", "water", "water_creek")
DEFAULT_RECIPE_LIBRARY = REPO_ROOT / "blender" / "recipes" / "library.json"
SHAPING_ENGINE_LAYERS = REPO_ROOT / "blender" / "tools" / "shape_layers.py"


def recipe_library_path() -> Path:
    """The recipe library: $GOLFMAP_RECIPE_LIBRARY, else blender/recipes/library.json."""
    env = os.environ.get("GOLFMAP_RECIPE_LIBRARY")
    return Path(env) if env else DEFAULT_RECIPE_LIBRARY


def load_recipe_library(path: Path) -> list[dict] | None:
    """Library entries in file order ({id, file, surfaces, defaultFor}), None when
    there is no file. A top-level list or {"recipes": [...]}; entries without an
    id or file are skipped, like the server does."""
    if not path.is_file():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    items = doc if isinstance(doc, list) else (doc.get("recipes") if isinstance(doc, dict) else None)
    if not isinstance(items, list):
        raise SystemExit(f"error: recipe library {path} must be a list of recipes (or {{\"recipes\": [...]}})")
    known = set(SHAPING_RECIPE_SURFACE.values())
    entries, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            continue
        rid, file = item.get("id"), item.get("file")
        if not (isinstance(rid, str) and rid and isinstance(file, str) and file) or rid in seen or rid == SHAPING_NO_RECIPE:
            continue
        seen.add(rid)
        raw = item.get("surfaces")
        surfaces = [s for s in (raw if isinstance(raw, list) else [raw]) if s in known]
        d = item.get("default")
        default_for = surfaces if d is True else [s for s in (d if isinstance(d, list) else [d]) if s in surfaces]
        entries.append({"id": rid, "file": file, "surfaces": surfaces, "defaultFor": default_for})
    return entries


def _recipe_override_support(engine: Path = SHAPING_ENGINE_LAYERS) -> tuple[str, set[str]]:
    """How the shaping engine takes an afrod.recipe op's overrides: ("key", set())
    when the op takes an `overrides` key, else ("params", <param names it knows>)."""
    import importlib.util
    try:
        spec = importlib.util.spec_from_file_location("golfmap_shape_layers", engine)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        op = module.OPS["afrod.recipe"]
    except Exception:  # no engine checkout: write no overrides
        return "params", set()
    if "overrides" in op.get("keys", set()):
        return "key", set()
    return "params", set(op.get("params", {}))


def _load_recipe_edits(db_path: Path, course_id: str) -> list[sqlite3.Row]:
    """The enabled `recipe` terrain edits of the course's site, oldest first."""
    conn = _open_course_db(db_path)
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        course_cols = {r[1] for r in conn.execute("PRAGMA table_info(courses)")}
        if "terrain_edits" not in tables or "site_id" not in course_cols:
            return []
        site = conn.execute("SELECT site_id FROM courses WHERE id = ?", (course_id,)).fetchone()
        if not site or not site["site_id"]:
            return []
        return conn.execute(
            """SELECT id, params_json, origin_ref, created_at FROM terrain_edits
               WHERE site_id = ? AND op = ? AND enabled = 1 ORDER BY created_at, id""",
            (site["site_id"], SHAPING_RECIPE_OP),
        ).fetchall()
    finally:
        conn.close()


def shaping_features(db_path: Path, course_ident: str, library: Path | None = None,
                     engine: Path = SHAPING_ENGINE_LAYERS) -> tuple[dict, dict, list[str]]:
    """The per-feature recipe layer for a course, counts, and warnings."""
    course, rows = _load_course_features(db_path, course_ident, "app")
    library = library or recipe_library_path()
    entries = load_recipe_library(library)
    warnings: list[str] = []
    stats: dict = {"edits": 0, "defaults": {}, "opted_out": 0, "other_edits": 0, "unknown": 0,
                   "unresolved": 0, "mismatched": 0, "no_default": {}, "overrides_dropped": 0}
    by_id = {e["id"]: e for e in entries or []}
    defaults: dict[str, dict] = {}
    for e in entries or []:
        for surface in e["defaultFor"]:
            if surface in defaults:
                warnings.append(f"recipes {defaults[surface]['id']} and {e['id']} are both the {surface} default: "
                                f"{defaults[surface]['id']} (first in the library) is used")
            else:
                defaults[surface] = e
    if entries is None:
        warnings.append(f"no recipe library at {library}: no recipe ops (course defaults and recipe edits need it)")

    shapes_oldest = sorted((r for r in rows if r["type"] in GSPRO_FILLS), key=lambda r: (r["created_at"] or "", r["id"]))
    shape_ids = _shape_ids(shapes_oldest)
    course_ids = {r["id"] for r in rows}
    edits: dict[str, dict] = {}
    for edit in _load_recipe_edits(db_path, course["id"]):
        ref = edit["origin_ref"] or ""
        fid = ref[len("feature:"):] if ref.startswith("feature:") else None
        if fid not in course_ids:
            stats["other_edits"] += 1
            continue
        if fid in edits:  # the server keeps one per feature; the oldest wins
            continue
        try:
            params = json.loads(edit["params_json"] or "{}")
        except ValueError:
            params = {}
        edits[fid] = params if isinstance(params, dict) else {}

    mode, known_params = _recipe_override_support(engine)
    ops = []
    for r in rows:
        surface = SHAPING_RECIPE_SURFACE.get(r["type"])
        if surface is None or r["id"] not in shape_ids or _is_bridge_deck(r):
            continue
        name = shape_ids[r["id"]]
        params = edits.get(r["id"])
        overrides: dict = {}
        if params is not None:
            rid = params.get("recipe")
            if rid == SHAPING_NO_RECIPE:
                stats["opted_out"] += 1
                continue
            if entries is None:
                stats["unresolved"] += 1
                continue
            entry = by_id.get(rid)
            if entry is None:
                stats["unknown"] += 1
                warnings.append(f"feature {name} ({r['type']}): recipe {rid!r} is not in the library - left out")
                continue
            if surface not in entry["surfaces"]:
                stats["mismatched"] += 1
                warnings.append(f"feature {name}: recipe {rid!r} is not made for {surface} (it is for "
                                f"{', '.join(entry['surfaces']) or 'no surface'}) - used anyway")
            raw = params.get("overrides")
            overrides = raw if isinstance(raw, dict) else {}
            note = f"{entry['id']} (recipe edit)"
            stats["edits"] += 1
        elif r["type"] in SHAPING_DEFAULT_RECIPE_TYPES:
            entry = defaults.get(surface)
            if entry is None:
                if entries is not None:
                    stats["no_default"][surface] = stats["no_default"].get(surface, 0) + 1
                continue
            note = f"{entry['id']} (default for {surface})"
            stats["defaults"][surface] = stats["defaults"].get(surface, 0) + 1
        else:
            continue
        seed = r["feature_no"] if r["feature_no"] is not None else _id_seed(r["id"])
        op = {"id": f"recipe-{name}", "op": "afrod.recipe", "select": {"feature": r["id"]},
              "recipe": entry["file"], "seed": seed, "note": note}
        if overrides:
            ordered = {k: overrides[k] for k in sorted(overrides)}
            if mode == "key":
                op["overrides"] = ordered
            else:
                kept = {k: v for k, v in ordered.items() if k in known_params}
                dropped = [k for k in ordered if k not in known_params]
                if kept:
                    op["params"] = kept
                if dropped:
                    stats["overrides_dropped"] += len(dropped)
                    warnings.append(f"feature {name}: override(s) {', '.join(dropped)} not written - the shaping "
                                    f"engine's afrod.recipe does not take them")
        ops.append(((r["feature_no"] is None, r["feature_no"] or 0, name), op))
    ops.sort(key=lambda t: t[0])
    for surface, n in sorted(stats["no_default"].items()):
        warnings.append(f"{n} {surface} feature(s) without a recipe: the library has no {surface} default")
    if stats["unresolved"]:
        warnings.append(f"{stats['unresolved']} recipe edit(s) not resolved (no library)")
    if stats["other_edits"]:
        warnings.append(f"{stats['other_edits']} recipe edit(s) of a feature not on this course (deleted, or another "
                        f"course's on the site) skipped")
    doc = {
        "format": SHAPING_LAYER_FORMAT,
        "id": SHAPING_FEATURES_ID,
        "generated": True,
        "generator": "pipeline/gspro.py shaping-global",
        "course": {"id": course["id"], "name": course["name"]},
        "ops": [op for _, op in ops],
    }
    return doc, stats, warnings


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
# How wide a zone's mix fades into the vegetation next to it (attribute
# `edgeBlend`, metres, centred on the drawn edge; D-VZ16). Absent: this for a
# zone drawn by hand that replaces, 0 for generated and mix zones. 0 on a
# drawn replace zone = a hard border, also against a neighbour that blends.
# The mixes are diffused with a Gaussian of edgeBlend / ZONE_BLEND_SIGMAS
# (so nearly all of the change lies within the width), inside a band of
# ZONE_BLEND_BAND widths around the zone's edge, in tiles of ZONE_BLEND_TILE_PX.
# The line where two mixes are even wanders: each mix is weighted by
# exp(ZONE_BLEND_WANDER x its own value noise, one value per ZONE_NOISE_CELL_M).
DEFAULT_ZONE_EDGE_BLEND_M = 8.0
ZONE_BLEND_SIGMAS = 4.0
ZONE_BLEND_BAND = 3.0
ZONE_BLEND_WANDER = 1.2
ZONE_BLEND_TILE_PX = 1024
# Curve flattening for the raster, in mask pixels (0.5 m at 4096 over 2 km),
# and for the exported polygons, in metres (they are simplified afterwards).
ZONE_FLATTEN_PX = 0.25
ZONE_FLATTEN_M = 0.25
# Edge noise is value noise: one random value every this many metres,
# bilinear in between, scaled by the zone's `noise` metres. Bigger than a
# feather so the edge wanders instead of fizzing.
ZONE_NOISE_CELL_M = 6.0
ZONE_CHANNELS = 4
# Bush height (D-VZ17): a zone's `heightMin`/`heightMax` (metres) go into one
# more mask, `<stem>-height.png`, 8-bit grey at 1/ZONE_HEIGHT_DOWNSCALE of the
# density masks' resolution: 0 = no height set there, else the intended height
# as `value / 256 x ZONE_HEIGHT_RANGE_M` (5 cm steps) - VSP's scale rule reads
# value / 256 (TextureMask.cs). Inside a zone the height varies between its
# min and max with value noise, one value every ZONE_HEIGHT_NOISE_CELL_M metres,
# stretched by ZONE_HEIGHT_SPREAD so both ends of the range are reached and
# raised to ZONE_HEIGHT_SKEW: most of a zone stays in the lower part of its
# range, with bumps of taller bushes a few metres across. An even spread
# between min and max read as one level line along a hedge (Vreta, hole 5).
ZONE_HEIGHT_RANGE_M = 12.8
ZONE_HEIGHT_MAX_M = 12.0
ZONE_HEIGHT_DOWNSCALE = 2
ZONE_HEIGHT_NOISE_CELL_M = 3.0
ZONE_HEIGHT_SPREAD = 0.75
ZONE_HEIGHT_SKEW = 2.2
ZONE_HEIGHT_SEED = 0x48454947


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


def _zone_blend_reach(edge_blend: float) -> float:
    """Half the band a zone's edge blend works in (a hard zone closes the default's band)."""
    return ZONE_BLEND_BAND * max(edge_blend, DEFAULT_ZONE_EDGE_BLEND_M) / 2.0


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
    edge_blend: float = 0.0  # metres its mix fades into its neighbours over; <= feather: no blend
    height: tuple[float, float] | None = None  # (min, max) metres its bushes are scaled to; None = the palette's sizes

    @property
    def slot(self) -> str:
        return zone_slot(self.zone_type, self.variant)

    @property
    def blends(self) -> bool:
        return self.edge_blend > 0.0

    @property
    def hard(self) -> bool:
        """Drawn, replacing and without an edge blend: its border stays as drawn."""
        return not self.generated and self.blend != ZONE_BLEND_MIX and not self.blends

    @property
    def reach(self) -> float:
        """How far from its drawn edge the zone can change a pixel, in metres
        (its feather and noise, or the blend band it opens or closes)."""
        return max(self.feather / 2.0 + self.noise, _zone_blend_reach(self.edge_blend))

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


def _zone_height(attrs: dict, zone_id: str) -> tuple[float, float] | None:
    """A zone's `heightMin`/`heightMax` as (min, max) metres, None when it has
    none. The server validates them (both or neither, 0 < min <= max <=
    ZONE_HEIGHT_MAX_M); a pair that still is not that is dropped with a warning."""
    lo, hi = attrs.get("heightMin"), attrs.get("heightMax")
    if lo is None and hi is None:
        return None
    ok = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lo, hi))
    if not ok or not 0.0 < lo <= hi <= ZONE_HEIGHT_MAX_M:
        print(f"  warning: zone {zone_id}: heightMin/heightMax {lo!r}/{hi!r} are not 0 < min <= max <= "
              f"{ZONE_HEIGHT_MAX_M:g} m; no bush height")
        return None
    return float(lo), float(hi)


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
    absent; weight clamped to 0..1) and `edgeBlend` (absent:
    DEFAULT_ZONE_EDGE_BLEND_M for a drawn replace zone, else 0). The variant is not checked against the
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
        mixes = attrs.get("blend") == ZONE_BLEND_MIX
        edge_default = 0.0 if r["generated"] or mixes else DEFAULT_ZONE_EDGE_BLEND_M
        zones.append(ZoneSpec(
            id=str(r["id"]),
            zone_type=str(attrs.get("zoneType") or ""),
            weight=min(1.0, max(0.0, _zone_number(attrs, "weight", DEFAULT_ZONE_WEIGHT, r["id"]))),
            feather=max(0.0, _zone_number(attrs, "feather", DEFAULT_ZONE_FEATHER_M, r["id"])),
            noise=max(0.0, _zone_number(attrs, "noise", DEFAULT_ZONE_NOISE_M, r["id"])),
            geometry=json.loads(r["geometry_json"]),
            variant=str(attrs.get("zoneVariant") or ""),
            generated=bool(r["generated"]),
            blend=ZONE_BLEND_MIX if mixes else ZONE_BLEND_REPLACE,
            extras=_zone_extra_palettes(attrs.get("extraPalettes"), str(r["id"])),
            edge_blend=max(0.0, _zone_number(attrs, "edgeBlend", edge_default, r["id"])),
            height=_zone_height(attrs, str(r["id"])),
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
    into a bool crop whose top-left pixel is (x0, y0) of the frame.

    A pixel is filled when the point VSP reads it for lies inside. VSP looks a
    spawn location up as pixel round(metres / pixel size) of the Unity texture
    (TextureMask.cs), so Unity pixel (x, z) stands for the square centred on
    (x, z) pixels from the terrain's corner - not on (x + 0.5, z + 0.5) - and
    Unity's row z is the PNG's row size - 1 - z. In frame coordinates (x east,
    y south from the north edge) PNG pixel (col, row) is therefore read for the
    point (col, row + 1). PIL's polygon fill is not that: it fills
    floor(min) .. floor(max), up to a pixel too far west and south, which put
    the grass half a metre onto one side of every path, tee and green."""
    from rasterio import features
    from shapely.geometry import Polygon as _Polygon
    acc = np.zeros((h, w), dtype=bool)
    for poly in polys:
        # rasterio fills the pixels whose centre (col + 0.5, row + 0.5) is inside. The nudge
        # counts a point on the west or south edge as inside (a zone that ends at the frame).
        ring = _Polygon([(x - x0 + 0.5 - 1e-4, y - y0 - 0.5 + 1e-4) for x, y in poly])
        if ring.is_empty or ring.area <= 0:
            continue
        acc ^= features.rasterize([ring], out_shape=(h, w)).astype(bool)
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
                      window: tuple[int, int, int, int] | None = None,
                      planted: set[str] | None = None) -> tuple[dict[str, np.ndarray], int]:
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
    count, and only their slots get a raster (the zones-patch step).

    Edge blend (D-VZ16): around the edge of a zone with an `edge_blend`, the
    mixes diffuse into each other. Each slot is blurred (a Gaussian of
    edge_blend / ZONE_BLEND_SIGMAS), weighted by its own noise so the border
    wanders, and every pixel's slots are then scaled to sum to what they did
    before. So the blend changes which mix grows near the edge, never how
    much: a mix only reaches where something grew already, beside bare ground
    (a path, mown rough) the zone ends exactly where it did, and a zone with
    nothing to blend with is unchanged. A drawn replace zone without an edge
    blend keeps its border as drawn. `planted` = the slots that bind items
    (None: all): only they blend. A slot nothing grows from is bare ground to
    the blend - an itemless zone lying over a path (Vreta's old lidar woodland
    proposals) otherwise hands its weight there to the mixes blending beside
    it, and they grow across the path."""
    e0, n0, e1, n1 = extent
    px_m = (e1 - e0) / size
    scale = 1.0 / px_m

    def to_px(xy: Pt) -> Pt:
        return ((xy[0] - e0) * scale, (n1 - xy[1]) * scale)

    flat: list[tuple[ZoneSpec, list[list[Pt]]]] = []
    for z in zones:
        curve = z.geometry.get("curveType") or "bezier"
        flat.append((z, [p for p in (_ring_px(r, curve, to_px, ZONE_FLATTEN_PX) for r in z.geometry.get("rings") or [])
                         if len(p) >= 3]))
    noise = _ValueNoise(seed, e1 - e0) if any(z.noise > 0 for z in zones) else None
    exclude_px = _px_rect(exclude, extent, size) if exclude is not None else None
    channels, outside = _resolve_zone_stack(flat, size, px_m, noise, exclude_px, window)

    blending = [(z, polys) for z, polys in flat if z.blends and polys]
    if not blending:
        return channels, outside
    wy0, wy1, wx0, wx1 = window if window is not None else (0, size, 0, size)
    widths = sorted({z.edge_blend for z, _ in blending})
    # A blurred pixel reads the stack this far around it (scipy's Gaussian is cut at 4 sigma).
    halo = int(4.0 * widths[-1] / ZONE_BLEND_SIGMAS / px_m + 0.5) + 1
    wander: dict[str, _ValueNoise] = {}
    step = ZONE_BLEND_TILE_PX
    tiles: set[tuple[int, int]] = set()
    for z, polys in blending:
        pad = _zone_blend_reach(z.edge_blend) / px_m + 3
        xs = [x for p in polys for x, _ in p]
        ys = [y for p in polys for _, y in p]
        bx0, bx1 = max(wx0, int(min(xs) - pad)), min(wx1, int(max(xs) + pad) + 1)
        by0, by1 = max(wy0, int(min(ys) - pad)), min(wy1, int(max(ys) + pad) + 1)
        if bx1 > bx0 and by1 > by0:
            tiles.update((ty, tx) for ty in range((by0 - wy0) // step, (by1 - 1 - wy0) // step + 1)
                         for tx in range((bx0 - wx0) // step, (bx1 - 1 - wx0) // step + 1))
    for ty, tx in sorted(tiles):
        tile = (wy0 + ty * step, min(wy1, wy0 + (ty + 1) * step), wx0 + tx * step, min(wx1, wx0 + (tx + 1) * step))
        around = (max(0, tile[0] - halo), min(size, tile[1] + halo), max(0, tile[2] - halo), min(size, tile[3] + halo))
        plain, _ = _resolve_zone_stack(flat, size, px_m, noise, exclude_px, around)
        for slot in plain:
            if slot not in wander:
                wander[slot] = _ValueNoise(zlib.crc32(slot.encode("utf-8")) ^ (seed & 0xFFFFFFFF), e1 - e0)
        blended = _blend_zone_tile(plain, around, tile, flat, widths, size, px_m, wander, planted)
        for slot, arr in blended.items():
            # A slot that only grows in the halo outside a window has no raster yet, and the
            # blur can still carry it into the tile.
            held = channels.setdefault(slot, np.zeros((wy1 - wy0, wx1 - wx0), dtype=np.float32))
            held[tile[0] - wy0:tile[1] - wy0, tile[2] - wx0:tile[3] - wx0] = arr
    return channels, outside


def render_zone_heights(zones: list[ZoneSpec], extent: Extent, size: int, seed: int = DEFAULT_ZONE_SEED,
                        exclude: Extent | None = None,
                        window: tuple[int, int, int, int] | None = None) -> np.ndarray:
    """The bush-height mask (D-VZ17): a uint8 size x size raster in the masks'
    north-up frame (or its `window`, y0, y1, x0, x1 in this raster's pixels),
    0 where no zone sets a height and else the intended height as
    `round(metres / ZONE_HEIGHT_RANGE_M x 256)`, at least 1.

    A zone with a height covers every pixel its weight reaches (its feather
    ramp and edge noise included, a pixel more than the density masks so no
    bush at its rim falls outside). Inside it the height is value noise
    between its min and max, skewed towards the min so the max shows as bumps,
    the same field for every zone so two zones with the same range meet
    without a step. Where zones with a height overlap, the
    one with the larger weight there decides. `exclude` is zeroed."""
    e0, n0, e1, n1 = extent
    px_m = (e1 - e0) / size
    scale = 1.0 / px_m
    wy0, wy1, wx0, wx1 = window if window is not None else (0, size, 0, size)
    out = np.zeros((wy1 - wy0, wx1 - wx0), dtype=np.uint8)
    tall = [z for z in zones if z.height is not None]
    if not tall:
        return out

    def to_px(xy: Pt) -> Pt:
        return ((xy[0] - e0) * scale, (n1 - xy[1]) * scale)

    edge_noise = _ValueNoise(seed, e1 - e0) if any(z.noise > 0 for z in tall) else None
    waves = _ValueNoise(ZONE_HEIGHT_SEED ^ (seed & 0xFFFFFFFF), e1 - e0, ZONE_HEIGHT_NOISE_CELL_M)
    best = np.zeros(out.shape, dtype=np.float32)
    for z in tall:
        curve = z.geometry.get("curveType") or "bezier"
        polys = [p for p in (_ring_px(r, curve, to_px, ZONE_FLATTEN_PX) for r in z.geometry.get("rings") or [])
                 if len(p) >= 3]
        crop = _zone_weight_crop(polys, size, px_m, max(z.weight, 1e-3), z.feather + 2.0 * px_m, z.noise, edge_noise,
                                 clip=window) if polys else None
        if crop is None:
            continue
        (y0, y1, x0, x1), w = crop
        cy0, cy1, cx0, cx1 = max(y0, wy0), min(y1, wy1), max(x0, wx0), min(x1, wx1)
        if cy1 <= cy0 or cx1 <= cx0:
            continue
        w = w[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        rows, cols = slice(cy0 - wy0, cy1 - wy0), slice(cx0 - wx0, cx1 - wx0)
        take = w > best[rows, cols]
        if not take.any():
            continue
        lo, hi = z.height
        t = np.clip(0.5 + ZONE_HEIGHT_SPREAD * waves.sample(cy0, cy1, cx0, cx1, px_m), 0.0, 1.0) ** ZONE_HEIGHT_SKEW
        value = np.clip(np.round((lo + (hi - lo) * t) / ZONE_HEIGHT_RANGE_M * 256.0), 1, 255).astype(np.uint8)
        out[rows, cols] = np.where(take, value, out[rows, cols])
        best[rows, cols] = np.where(take, w, best[rows, cols])
    if exclude is not None:
        y0, y1, x0, x1 = _px_rect(exclude, extent, size)
        y0, y1, x0, x1 = max(y0, wy0) - wy0, min(y1, wy1) - wy0, max(x0, wx0) - wx0, min(x1, wx1) - wx0
        if y1 > y0 and x1 > x0:
            out[y0:y1, x0:x1] = 0
    return out


def zone_height_meta(zones: list[ZoneSpec], items: list["ZoneItem"], out: Path, resolution: int) -> dict | None:
    """The export's `height` block, None when no zone sets a height: the mask
    file next to `out`, its resolution, the metres a full pixel stands for and
    the items that can grow in a zone with a height (every item of a palette
    such a zone plants). Unity gives the bushes among them a height-driven
    twin; the grass items are named too and left alone there."""
    slots = {slot for z in zones if z.height is not None for slot, _, _ in z.layers()}
    names = [i.item for i in items if set(i.sources) & slots]
    if not names:
        return None
    return {"file": f"{out.stem}-height.png", "resolution": max(1, resolution // ZONE_HEIGHT_DOWNSCALE),
            "rangeM": ZONE_HEIGHT_RANGE_M, "items": names}


def _zone_edge_band(polys: list[list[Pt]], width_m: float, tile: tuple[int, int, int, int], size: int,
                    px_m: float) -> tuple[tuple[slice, slice], np.ndarray] | None:
    """How much of the blend applies around one zone's drawn edge, over a
    tile: 1 within half of ZONE_BLEND_BAND x width_m / 2 of the edge, down to
    0 at that distance, as ((rows, cols) of the tile, values)."""
    band_m = ZONE_BLEND_BAND * width_m
    crop = _zone_weight_crop(polys, size, px_m, 1.0, band_m, 0.0, None, clip=tile)
    if crop is None:
        return None
    (y0, y1, x0, x1), w = crop
    cy0, cy1, cx0, cx1 = max(y0, tile[0]), min(y1, tile[1]), max(x0, tile[2]), min(x1, tile[3])
    if cy1 <= cy0 or cx1 <= cx0:
        return None
    w = w[cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
    return ((slice(cy0 - tile[0], cy1 - tile[0]), slice(cx0 - tile[2], cx1 - tile[2])),
            np.clip(2.0 - 4.0 * np.abs(0.5 - w), 0.0, 1.0).astype(np.float32))


def _blend_zone_tile(plain: dict[str, np.ndarray], around: tuple[int, int, int, int], tile: tuple[int, int, int, int],
                     flat: list[tuple[ZoneSpec, list[list[Pt]]]], widths: list[float], size: int, px_m: float,
                     wander: dict[str, "_ValueNoise"], planted: set[str] | None = None) -> dict[str, np.ndarray]:
    """One tile's slots with the edge blends applied (render_zone_masks):
    `plain` is the stack over `around`, the tile grown by the blur's reach.
    Slots are walked in sorted order so a window gives the frame's floats."""
    from scipy.ndimage import gaussian_filter

    inner = (slice(tile[0] - around[0], tile[1] - around[0]), slice(tile[2] - around[2], tile[3] - around[2]))
    shape = (tile[1] - tile[0], tile[3] - tile[2])
    out = {slot: plain[slot][inner].copy() for slot in sorted(plain)}
    slots = [slot for slot in sorted(plain) if planted is None or slot in planted]   # the rest: as they are
    if not slots:
        return out
    total = np.zeros(shape, dtype=np.float32)
    for slot in slots:
        total += out[slot]

    def bands(members, width_m: float) -> np.ndarray:
        acc = np.zeros(shape, dtype=np.float32)
        for polys in members:
            got = _zone_edge_band(polys, width_m, tile, size, px_m)
            if got is not None:
                np.maximum(acc[got[0]], got[1], out=acc[got[0]])
        return acc

    keep = bands([polys for z, polys in flat if z.hard and polys], DEFAULT_ZONE_EDGE_BLEND_M)
    weights = {slot: np.exp(np.float32(ZONE_BLEND_WANDER) * wander[slot].sample(*tile, px_m)) for slot in slots}
    for width in widths:
        band = bands([polys for z, polys in flat if z.edge_blend == width and polys], width) * (1.0 - keep)
        if not band.any():
            continue
        sigma_px = width / ZONE_BLEND_SIGMAS / px_m
        spread = {slot: gaussian_filter(plain[slot], sigma_px, mode="nearest", truncate=4.0)[inner] * weights[slot]
                  for slot in slots}
        spread_total = np.zeros(shape, dtype=np.float32)
        for slot in slots:
            spread_total += spread[slot]
        has = spread_total > 1e-6
        share = np.divide(total, spread_total, out=np.zeros(shape, dtype=np.float32), where=has)
        for slot in slots:
            out[slot] += band * np.where(has, spread[slot] * share - out[slot], 0.0)
    return out


def _resolve_zone_stack(flat: list[tuple[ZoneSpec, list[list[Pt]]]], size: int, px_m: float,
                        noise: "_ValueNoise | None", exclude_px: tuple[int, int, int, int] | None,
                        window: tuple[int, int, int, int] | None) -> tuple[dict[str, np.ndarray], int]:
    """render_zone_masks' stack (before the edge blends) over the frame or a
    window of it, from the zones' rings already in frame pixels."""
    wy0, wy1, wx0, wx1 = window if window is not None else (0, size, 0, size)
    shape = (wy1 - wy0, wx1 - wx0)
    channels: dict[str, np.ndarray] = {}
    outside = 0

    def weight_in_window(z: ZoneSpec, polys: list[list[Pt]]) -> tuple[tuple[int, int, int, int], np.ndarray] | None | str:
        """The zone's weight over its crop's overlap with the window, in window
        coordinates; None when it misses the window, "outside" when it misses the frame."""
        feather = z.feather
        if polys and window is not None:
            # The crop's own padding (_zone_weight_crop), checked before its distance transforms.
            pad = (feather / 2.0 + z.noise) / px_m + 3
            xs = [x for p in polys for x, _ in p]
            ys = [y for p in polys for _, y in p]
            if min(xs) - pad >= wx1 or max(xs) + pad < wx0 or min(ys) - pad >= wy1 or max(ys) + pad < wy0:
                return None
        crop = _zone_weight_crop(polys, size, px_m, z.weight, feather, z.noise, noise, clip=window) if polys else None
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
    for z, polys in flat:
        if z.generated:
            continue
        got = weight_in_window(z, polys)
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
    for z, polys in reversed([f for f in flat if f[0].generated]):
        got = weight_in_window(z, polys)
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
    if exclude_px is not None:
        y0, y1, x0, x1 = exclude_px
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
              f"not rasterized: they pick the palette of those banks, which Update vegetation plants: "
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
        "edgeBlend": z.edge_blend,
        "blend": z.blend,
        "extraPalettes": [{"zoneType": e.zone_type, "variant": e.variant, "weight": e.weight} for e in z.extras],
        # Only on a zone that sets one, so rows from before bush heights still compare equal.
        **({"heightMin": z.height[0], "heightMax": z.height[1]} if z.height is not None else {}),
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
    its type falls back to the Default mix with a warning. When a zone sets
    a bush height, `<out stem>-height.png` and the `height` block are
    written too (render_zone_heights); else a stale one is removed."""
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
    items = zone_items(types)
    slots, outside_raster = render_zone_masks(known, extent, resolution, seed=seed, exclude=exclude,
                                              planted={slot for i in items for slot, _ in i.bindings})
    masks = _write_zone_masks(slots, items, resolution, out)
    height = zone_height_meta(known, items, out, resolution)
    height_path = out.with_name(f"{out.stem}-height.png")
    if height is not None:
        Image.fromarray(render_zone_heights(known, extent, height["resolution"], seed=seed, exclude=exclude)
                        ).save(height_path, format="PNG")
    elif height_path.is_file():
        height_path.unlink()
        print(f"  removed stale mask {height_path.name}")

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
    if height is not None:
        doc["height"] = height
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
    blending = [r["edgeBlend"] for r in rows if r["edgeBlend"] > 0]
    if blending:
        widths = f"{min(blending):g}" + (f"-{max(blending):g}" if max(blending) > min(blending) else "")
        print(f"  {len(blending)} zone(s) blend into their neighbours over {widths} m (edgeBlend)")
    print(f"  masks {resolution}² at {side / resolution:.3f} m/px, noise seed {seed}, "
          f"polygons simplified to {simplify_m:g} m, one channel per item: "
          f"{len(items)} item(s) in {len(masks)} texture(s)")
    for i in items:
        print(f"    {masks[i.texture]['file']} {'RGBA'[i.channel]}: {i.item} <- {', '.join(i.sources)}")
    if height is not None:
        tall = [r for r in rows if "heightMin" in r]
        span = f" ({min(r['heightMin'] for r in tall):g}-{max(r['heightMax'] for r in tall):g} m)" if tall else ""
        print(f"  {len(tall)} zone(s) on the square set a bush height{span}: {height['file']} "
              f"{height['resolution']}², {len(height['items'])} item(s) can grow there")
    print(f"  plot origin {e0:.0f},{n0:.0f} (EPSG:3006), height range {doc['plot']['minM']:.2f}..{doc['plot']['maxM']:.2f} m from {sidecar_path.name}")


# --- Command: zones-patch ---------------------------------------------------
# Re-rasterize only the part of a terrain's zone masks that some zones cover
# (the web's "Update N zones" on selected zones), instead of the whole
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
    pad = max(float(row.get("feather", DEFAULT_ZONE_FEATHER_M)) / 2.0 + float(row.get("noise", DEFAULT_ZONE_NOISE_M)),
              _zone_blend_reach(float(row.get("edgeBlend", 0.0))))
    xs, zs = [e0 + n["x"] for n in nodes], [n0 + n["z"] for n in nodes]
    return (min(xs) - pad, min(zs) - pad, max(xs) + pad, max(zs) + pad)


def _zone_rect(z: ZoneSpec) -> Extent | None:
    """A zone's outline bounds in EPSG:3006 (curves flattened), padded like its crop."""
    geom = _zone_geometry_m(z.geometry)
    if geom is None or geom.is_empty:
        return None
    x0, y0, x1, y1 = geom.bounds
    pad = z.reach
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
            # An export from before edge blends has no edgeBlend: such a row had none.
            return json.dumps({"edgeBlend": 0.0, **{k: v for k, v in row.items() if k != "id"}}, sort_keys=True)
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
    # Which items have a height-driven twin in Unity is part of the layout too.
    height = zone_height_meta(known, items, zones_json, size)
    if window is not None and height != prev.get("height"):
        raise ZonesLayoutChanged(
            f"the palettes that grow in a zone with a bush height changed since {zones_json.name} was exported "
            "(the first height on a palette, or the last one gone), so Unity needs other items; "
            "a patch cannot follow - export (plant) the whole terrain")

    if window is None:
        print(f"Nothing to patch on the {side:g} m {plot.get('terrain') or ''} square: the zones do not reach it")
    else:
        y0, y1, x0, x1 = window
        px_m = side / size
        slots, _ = render_zone_masks(known, extent, size, seed=seed, exclude=exclude, window=window,
                                     planted={slot for i in items for slot, _ in i.bindings})
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
        if height is not None:
            down = size // height["resolution"]
            hy0, hy1, hx0, hx1 = y0 // down, -(-y1 // down), x0 // down, -(-x1 // down)
            path = zones_json.with_name(height["file"])
            grey = np.array(Image.open(path).convert("L"))
            if grey.shape != (height["resolution"], height["resolution"]):
                raise SystemExit(f"error: {path.name} is {grey.shape[1]}x{grey.shape[0]}, the export says "
                                 f"{height['resolution']}; export the zones again")
            new = render_zone_heights(known, extent, height["resolution"], seed=seed, exclude=exclude,
                                      window=(hy0, hy1, hx0, hx1))
            if not np.array_equal(new, grey[hy0:hy1, hx0:hx1]):
                grey[hy0:hy1, hx0:hx1] = new
                Image.fromarray(grey).save(path, format="PNG")
                record["textures"].append(height["file"])
        record["changed"] = bool(record["textures"])
        record["window"] = {"y0": y0, "y1": y1, "x0": x0, "x1": x1, "resolution": size}
        record["region"] = {"x0": round(x0 * px_m, 3), "z0": round(side - y1 * px_m, 3),
                            "x1": round(x1 * px_m, 3), "z1": round(side - y0 * px_m, 3)}

        print(f"Patched {zones_json.name}: {len(record['zones'])} zone(s)"
              + (f", {len(gone)} removed" if gone else "")
              + f", window {x1 - x0}x{y1 - y0} px ({(x1 - x0) * px_m:.0f} x {(y1 - y0) * px_m:.0f} m)"
              + f", {len(record['textures'])} of {len(masks) + (height is not None)} texture(s) changed"
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
# The file is MERGED, not rewritten: this command replaces only what the app
# is the source of truth for. That includes the course details (name,
# location, designer, description, keywords) once the app keeps them for the
# course (courses.gspro_meta_json, typed in the export panel or read back
# from a .GKD saved in GreenKeeper) and the ratings of the course's tee sets
# (course_tee_sets); until then, and for the rest of the
# header (the range, wind, stimp, the scene folder name), the file's own stay.
GKD_VERSION = 4.1
GKD_HOLE_COUNT = 18
# The tee sets a GKD carries, in file order, and the three pseudo-tees that
# share a hole's `Tees` list: the two aim points and the green centre.
GKD_TEE_TYPES = ("Black", "White", "Green", "Blue", "Yellow", "Red", "Junior", "Par3")
# The tee sets with a course/slope rating (`<set>SR`); Par3 is spelled PAR3 there.
GKD_RATING_TEES = (*GKD_TEE_TYPES[:-1], "PAR3")
GKD_KEYWORDS = ("BeginnerFriendly", "Coastal", "Desert", "Fantasy", "Heathland", "Historic", "Links",
                "LowPoly", "MajorVenue", "Mountain", "Parkland", "TourStop", "Training", "Tropical")
# GKD header key -> the field of the app's course details (GsproCourseMeta,
# shared/gspro-course-meta.ts) it is written from.
GKD_META_TEXT = {
    "CourseName": "courseName", "CityTown": "city", "StateCountyProvince": "state", "Country": "country",
    "Designer": "designer", "Homage": "homage", "CourseInfo": "description",
}
GKD_AIM_TYPES = ("AimPoint1", "AimPoint2")
GKD_GREEN_CENTER = "GreenCenterPoint"
# Tidy tees (`_gkd_tidy_tees`): tees drawn closer than GKD_TEE_SAME_M are one
# tee box and share one position; tees within GKD_TEE_ROW_M of each other
# that stand less than GKD_TEE_ROW_OFFSET_M off the line of play are put on it.
GKD_TEE_SAME_M = 1.0
GKD_TEE_ROW_M = 6.0
GKD_TEE_ROW_OFFSET_M = 0.7
# GreenKeeper keeps exactly four pin positions per hole, one per tournament day.
GKD_PIN_DAYS = ("Thursday", "Friday", "Saturday", "Sunday")
# The app's tee `name`/`color` -> the GKD tee set, for a tee whose course tee
# set does not say (`course_tee_sets.gspro_tee`, which the app fills from this
# same match when a set is made — shared/tee-sets.ts, keep the two in step).
# The app is free-form (a tee is whatever the course calls it), the GKD is
# these eight slots; anything else needs a GSPro tee picked in the app, or
# --tee-map.
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
        band = _read_dem_band(dem_path)
        if band.crs is not None and CRS.from_user_input(band.crs) != SWEREF99:
            raise SystemExit(f"error: {dem_path} is {band.crs}, not EPSG:3006")
        b = band.bounds
        if (b[0] - extent[0] > 0.51 or b[1] - extent[1] > 0.51
                or extent[2] - b[2] > 0.51 or extent[3] - b[3] > 0.51):
            raise SystemExit(f"error: {dem_path.name} covers {tuple(round(v) for v in b)}, "
                             f"which does not hold the square {list(extent)}")
        self._dem = band.filled
        self._inv = ~band.transform
        self._res = abs(band.transform.a)
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


def _gkd_set_tee_type(row, overrides: dict[str, str]) -> str | None:
    """The GKD tee set of a tee (or tee set) row. --tee-map wins; then, when
    the row's course tee set says (`set_id`, from a database with
    `course_tee_sets.gspro_tee`, server migration 030), that set's GSPro tee
    — None for a set the app keeps out of GSPro; otherwise the name/colour
    match."""
    for raw in (row["name"], row["color"]):
        key = (raw or "").strip().lower()
        if key in overrides:
            return overrides[key]
    if row["set_id"] is not None:
        return row["gspro_tee"] if row["gspro_tee"] in GKD_TEE_TYPES else None
    return _gkd_tee_type(row["name"], row["color"], overrides)


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column for r in conn.execute(f"PRAGMA table_info({table})"))


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


def _gkd_tee_groups(positions: list[dict], within_m: float, strict: bool = False) -> list[list[int]]:
    """Indices of `positions` grouped so that every tee is within `within_m`
    of another in its group (chains count: A-B and B-C make one group)."""
    groups: list[list[int]] = []
    for i, position in enumerate(positions):
        near = [g for g in groups
                if any((d := _gkd_flat(position, positions[j])) < within_m or (not strict and d == within_m)
                       for j in g)]
        for g in near:
            groups.remove(g)
        groups.append([j for g in near for j in g] + [i])
    return groups


def _gkd_tidy_tees(placed: dict[str, dict], aims: list[dict], green: dict | None, on_ground) -> tuple[int, int]:
    """Square up one hole's tees in place, so the tee markers GSPro sets out
    look kept; returns how many were (stacked, lined up).

    Tees drawn under GKD_TEE_SAME_M apart are one tee box played by several
    sets: they all go onto the one furthest from the hole. Then tees within
    GKD_TEE_ROW_M of each other that already stand nearly in a row — under
    GKD_TEE_ROW_OFFSET_M off the line from the longest of them to its first
    aim point (the green centre where it has none, a par 3) — are moved
    sideways onto that line. "Longest" is the walk to the green, the same for
    every set (the Par3 set's straight shot would misorder them)."""
    if green is None:
        return 0, 0

    def length(tee_type: str) -> float:
        return _gkd_tee_distance(placed[tee_type], aims, green, "")

    stacked = lined_up = 0
    types = list(placed)
    for group in _gkd_tee_groups([placed[t] for t in types], GKD_TEE_SAME_M, strict=True):
        if len(group) < 2:
            continue
        members = [types[i] for i in group]
        back = placed[max(members, key=length)]
        for tee_type in members:
            if placed[tee_type] != back:
                placed[tee_type] = dict(back)
                stacked += 1

    for group in _gkd_tee_groups([placed[t] for t in types], GKD_TEE_ROW_M):
        if len(group) < 2:
            continue
        members = [types[i] for i in group]
        back = placed[max(members, key=length)]
        to_green = _gkd_flat(back, green)
        target = next((a for a in aims if _gkd_flat(a, green) < to_green), green)
        run = _gkd_flat(back, target)
        if run == 0:
            continue
        dx, dz = (target["x"] - back["x"]) / run, (target["z"] - back["z"]) / run
        for tee_type in members:
            tee = placed[tee_type]
            along = (tee["x"] - back["x"]) * dx + (tee["z"] - back["z"]) * dz
            off = (tee["x"] - back["x"]) * dz - (tee["z"] - back["z"]) * dx
            # Under a millimetre off is in the row already (and what a stacked tee is).
            if 0.001 < abs(off) < GKD_TEE_ROW_OFFSET_M:
                placed[tee_type] = on_ground(back["x"] + along * dx, back["z"] + along * dz)
                lined_up += 1
    return stacked, lined_up


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
    playable = " AND drawing_group_name IS NULL" if _has_column(conn, "holes", "drawing_group_name") else ""
    holes = [dict(r) for r in conn.execute(
        f"SELECT id, number, par, stroke_index FROM holes WHERE course_id = ?{playable} ORDER BY number",
        (course["id"],))]
    # A tee's GKD tee set is its course tee set's (`_gkd_set_tee_type`); a
    # database from before the sets had one gives every tee no set.
    tees_sql = ("SELECT t.name, t.color, t.lat, t.lon, s.id AS set_id, s.gspro_tee FROM tees t "
                "LEFT JOIN course_tee_sets s ON s.id = t.tee_set_id WHERE t.hole_id = ? ORDER BY t.sort_order, t.name"
                if _has_column(conn, "course_tee_sets", "gspro_tee") else
                "SELECT name, color, lat, lon, NULL AS set_id, NULL AS gspro_tee FROM tees "
                "WHERE hole_id = ? ORDER BY sort_order, name")
    for hole in holes:
        hole["tees"] = [dict(r) for r in conn.execute(tees_sql, (hole["id"],))]
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


def _load_gkd_meta(db_path: Path, course_id: str) -> "dict | None":
    """The course details the app keeps for a course (`courses.gspro_meta_json`,
    the server's GsproCourseMeta); None when it keeps none, or the database
    predates the column."""
    conn = _open_course_db(db_path)
    try:
        row = conn.execute("SELECT gspro_meta_json FROM courses WHERE id = ?", (course_id,)).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        conn.close()
    return json.loads(row[0]) if row and row[0] else None


def _gkd_apply_meta(doc: dict, meta: dict) -> None:
    """Write the app's course details into a GKD's header. Only these keys:
    the rest of the header (wind, stimp, firmness, the range, the splash
    image) stays as GreenKeeper left it."""
    for key, field in GKD_META_TEXT.items():
        doc[key] = str(meta.get(field) or "")
    # GreenKeeper's own spelling, empty parts included: "Linköping, , Sweden".
    doc["Location"] = ", ".join(doc[k] for k in ("CityTown", "StateCountyProvince", "Country"))
    doc["DifficultyRating"] = float(meta.get("difficulty") or 0.0)
    on = [k for k in GKD_KEYWORDS if k in (meta.get("keywords") or [])]
    for keyword in GKD_KEYWORDS:
        doc["Keyword" + keyword] = keyword in on
    doc["KeywordsString"] = ", ".join(on)


def _load_gkd_ratings(db_path: Path, course_id: str, tee_map: dict[str, str]) -> dict[str, str]:
    """The course's tee-set ratings as GKD header values: `{"YellowSR":
    "71.5/135"}`. Each of the app's tee sets (`course_tee_sets`, server
    migration 029) keeps a men's and a women's course rating and slope and
    says which of the two GSPro shows; a set lands on the GKD set its tees
    do (`_gkd_set_tee_type`, the first of the course's sets to claim it). Sets
    without that rating, and a database from before the table, give nothing."""
    conn = _open_course_db(db_path)
    try:
        mapped = "id AS set_id, gspro_tee" if _has_column(conn, "course_tee_sets", "gspro_tee") \
            else "NULL AS set_id, NULL AS gspro_tee"
        rows = conn.execute(
            f"SELECT name, color, rating_men, slope_men, rating_women, slope_women, gspro_rating, {mapped} "
            "FROM course_tee_sets WHERE course_id = ? ORDER BY sort_order, name", (course_id,)).fetchall()
    except sqlite3.OperationalError:
        return {}
    finally:
        conn.close()
    out: dict[str, str] = {}
    claimed: set[str] = set()
    for row in rows:
        tee_type = _gkd_set_tee_type(row, tee_map)
        if tee_type is None or tee_type in claimed:
            continue
        claimed.add(tee_type)
        who = "women" if row["gspro_rating"] == "women" else "men"
        rating, slope = row["rating_" + who], row["slope_" + who]
        if rating is not None and slope is not None:
            out[GKD_RATING_TEES[GKD_TEE_TYPES.index(tee_type)] + "SR"] = f"{float(rating):.1f}/{int(slope)}"
    return out


def _load_gkd_outlines(db_path: Path, course_ident: str) -> list[sqlite3.Row]:
    """The course's hazard and OOB features (id, type, geometry_json, hole
    number), in the app's own order."""
    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    types = (*GKD_HAZARD_TYPES, GKD_OOB_TYPE)
    playable = " AND h.drawing_group_name IS NULL" if _has_column(conn, "holes", "drawing_group_name") else ""
    rows = conn.execute(
        f"""SELECT f.id, f.type, f.geometry_json, h.number AS hole_number
            FROM course_features f LEFT JOIN holes h ON h.id = f.hole_id
            WHERE f.course_id = ? AND f.type IN ({','.join('?' * len(types))}){playable}
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
        **{"Keyword" + k: False for k in GKD_KEYWORDS},
        "KeywordsString": "", "BenchMarkComplete": False, "PerformanceScore": 0,
        "unitOfMeasure": 1, "altitude": 0.0, "altitudeV2": 0.0,
        "HasRange": False,
        "RangeTee": {"x": 0.0, "y": 0.0, "z": 0.0}, "RangeAim": {"x": 0.0, "y": 0.0, "z": 0.0},
        "IsMiniGolf": False, "CoursePar": 72,
        **{t + "SR": "0.0/0" for t in GKD_RATING_TEES},
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
    The course details — name, location, designer, description, keywords —
    are the app's when it keeps any for the course
    (`courses.gspro_meta_json`), and each tee set's rating/slope is the
    course tee set's when it has one (`course_tee_sets`); the rest of the
    header (the range, wind, stimp), and those too when the app keeps none,
    are carried over from the file being replaced (or --template) untouched."""
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
    meta = _load_gkd_meta(db_path, course["id"])
    if meta is not None:
        _gkd_apply_meta(doc, meta)
    ratings = _load_gkd_ratings(db_path, course["id"], tee_map or {})
    doc.update(ratings)

    outside: list[str] = []
    unmapped: dict[str, int] = {}
    extra_aims = no_green = no_pins = stacked = lined_up = 0
    no_tees: list[int] = []

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
            tee_type = _gkd_set_tee_type(tee, tee_map)
            if tee_type is None:
                label = tee["name"] or tee["color"] or "(unnamed)"
                unmapped[label] = unmapped.get(label, 0) + 1
                continue
            position = place(tee["lat"], tee["lon"], f"hole {number} {tee_type} tee")
            if position is not None and tee_type not in placed:
                placed[tee_type] = position
        if not placed:
            no_tees.append(number)
        moved = _gkd_tidy_tees(placed, [a for a in aims if a], centre,
                               lambda x, z: _gkd_pos(ground, e0, n0, x + e0, z + n0))
        stacked, lined_up = stacked + moved[0], lined_up + moved[1]

        # A set the hole has no tee for, and an aim point it does not have,
        # is a disabled row with no position — how GreenKeeper itself writes
        # one. Enabled, it is a tee GSPro offers with nowhere to stand.
        tees = []
        for tee_type in GKD_TEE_TYPES:
            position = placed.get(tee_type)
            distance = (_gkd_tee_distance(position, [a for a in aims if a], centre, tee_type)
                        if position is not None else 0.0)
            totals[tee_type] += distance
            if position is not None:
                used_tee_types.add(tee_type)
            tees.append({"TeeType": tee_type, "Enabled": position is not None,
                         "Distance": round(distance, 4), "Position": position})
        for i, name in enumerate(GKD_AIM_TYPES):
            position = aims[i] if i < len(aims) else None
            tees.append({"TeeType": name, "Enabled": position is not None, "Distance": 0.0,
                         "Position": position})
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
            # No tee, no hole: there is nowhere to play it from.
            "Enabled": bool(placed), "HoleNumber": number,
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
    if stacked or lined_up:
        print(f"  tees tidied: {stacked} put on the tee under {GKD_TEE_SAME_M:g} m behind it, "
              f"{lined_up} moved up to {GKD_TEE_ROW_OFFSET_M:g} m sideways into a row")
    print(f"  {len(hazards)} hazards ({sum(1 for h in hazards if h['innerOOB'])} inner OOB, "
          f"{sum(h['pointCount'] for h in hazards)} points), "
          + (f"boundary {len(boundary)} points" if boundary
             else f"no `oob` ring drawn, kept the file's boundary ({doc['pOOB']['pointCount']} points)"
             if (doc.get("pOOB") or {}).get("pointCount") else "NO course boundary (draw an `oob` ring)"))
    print(f"  water staked {water_margin_m:g} m out, to the end of banks steeper than {bank_slope_deg:g} deg "
          f"up to {bank_max_m:g} m; hazard nodes every {node_spacing_m:g} m or closer, OOB within {simplify_m:g} m")
    print(f"  heights from {dem_path.name}, terrain zero {float(sidecar['minM']):.2f} m, "
          f"altitude {doc.get('altitudeV2', 0):.1f} m")
    if meta is not None:
        print("  course details (name, location, designer, description, keywords) from the app"
              + (f"; the rest of the header kept from {template_path.name}" if template_path is not None else ""))
    elif template_path is not None:
        print(f"  metadata kept from {template_path.name} (course name, location, keywords, range)")
    if ratings:
        print("  ratings from the course's tee sets: "
              + ", ".join(f"{key[:-2]} {value}" for key, value in ratings.items()))
    for name, count in sorted(unmapped.items()):
        print(f"  warning: {count} tee(s) named {name!r} have no GSPro tee "
              f"({', '.join(GKD_TEE_TYPES)}); skipped (pick one for the tee set in the app, or --tee-map)")
    if no_tees:
        print(f"  warning: hole(s) {', '.join(str(n) for n in no_tees)} have no tee and were written disabled")
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


# --- Command: holes -----------------------------------------------------------
# Where each hole is played from and to, for Unity's hole navigator
# (GolfMapHoleNavigator.cs): every tee, every aim point (a GKD holds two) and
# the green centre in EPSG:3006. No heights: the navigator stands on the
# ground the scene has.

HOLES_FORMAT = "golfmap-holes-v1"


def cmd_holes(course_ident: str, out: Path, db_path: Path | None = None) -> None:
    """Write the course's holes (tees, aim points, green centre; EPSG:3006) for Unity's hole navigator."""
    course, holes = _load_gkd_course(db_path or DEFAULT_DB, course_ident)

    def point(lat, lon, **extra) -> "dict | None":
        if lat is None or lon is None:
            return None
        xs, ys = transform_points(WGS84, SWEREF99, [float(lon)], [float(lat)])
        return {**extra, "e": round(xs[0], 2), "n": round(ys[0], 2)}

    rows = []
    for hole in holes:
        tees = [point(t["lat"], t["lon"], name=t["name"] or t["color"] or "", color=t["color"] or "") for t in hole["tees"]]
        aims = [point(a["lat"], a["lon"], label=a["label"] or "") for a in hole["aims"]]
        green = point(hole["green"]["center_lat"], hole["green"]["center_lon"]) if hole["green"] else None
        if green is None:
            print(f"  warning: hole {hole['number']} has no green centre")
        rows.append({"number": int(hole["number"]), "par": int(hole["par"] or 0),
                     "tees": [t for t in tees if t], "aims": [a for a in aims if a], "green": green})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"format": HOLES_FORMAT, "crs": "EPSG:3006", "course": course["name"], "holes": rows},
                              indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {out}")
    print(f"  {len(rows)} hole(s), {sum(len(r['tees']) for r in rows)} tee(s), {sum(len(r['aims']) for r in rows)} aim point(s)")


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
    sidecar = _read_sidecar_json(sidecar_path)
    sq = sidecar.get("square3006")
    if sq and any(abs(a - b) > 0.01 for a, b in zip(sq, extent)):
        raise SystemExit(f"error: the sidecar {sidecar_path.name} is for square {sq}, not {list(extent)}")
    min_m = float(sidecar["minM"])
    band = _read_dem_band(dem_path)
    if band.crs is None or band.crs.to_epsg() != 3006:
        raise SystemExit(f"error: {dem_path} is not in EPSG:3006")
    dem, transform, valid = band.values, band.transform, band.valid

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


# --- Command: batch ---------------------------------------------------------
# One export is five or six of the commands above over the same course and the
# same square. As five processes they each pay the interpreter plus
# rasterio/shapely imports (2-4 s), open the database, load and flatten the
# course's features again, and re-read the DEM the previous one had just
# written. `batch` runs them in order in ONE process over the batch cache
# above, with each job's output captured, prefixed and reported.

BATCH_FORMAT = "golfmap-gspro-batch-v1"


class _JobOut(io.TextIOBase):
    """One job's stdout and stderr: every finished line is kept for the result
    file and written through to the real stdout prefixed with the job's id, so
    a batch log reads like the separate runs it replaces.

    It also answers the questions a library asks of `sys.stdout` before it
    prints — `encoding`, `errors`, `isatty()`, `fileno()` — which a bare
    `TextIOBase` answers with None or by raising. The text really does go
    through the real stream's codec, so `encoding` and `errors` are its own
    (utf-8 / strict when it has none): a library that checks whether it may
    print a glyph gets the truth, not a promise this stream cannot keep."""

    def __init__(self, job_id: str, stream) -> None:
        self.lines: list[str] = []
        self._id = job_id
        self._stream = stream
        self._partial = ""

    def writable(self) -> bool:
        return True

    @property
    def encoding(self) -> str:
        return getattr(self._stream, "encoding", None) or "utf-8"

    @property
    def errors(self) -> str:
        return getattr(self._stream, "errors", None) or "strict"

    def isatty(self) -> bool:
        return False

    def fileno(self) -> int:
        """The real stream's descriptor: a subprocess handed it writes into the
        batch log (unprefixed, but there), and only a real stream without one
        makes this raise — as `sys.stdout` itself would have."""
        try:
            return self._stream.fileno()
        except (AttributeError, OSError, ValueError):   # incl. io.UnsupportedOperation
            raise io.UnsupportedOperation("fileno")

    def write(self, text: str) -> int:
        self._partial += text
        while "\n" in self._partial:
            line, _, self._partial = self._partial.partition("\n")
            self._line(line)
        return len(text)

    def flush(self) -> None:
        if self._partial:
            line, self._partial = self._partial, ""
            self._line(line)

    def _line(self, line: str) -> None:
        self.lines.append(line)
        print(f"[{self._id}] {line}", file=self._stream, flush=True)


def _batch_error(exc: BaseException) -> str:
    """What a failed job says in the result. A command's own
    `raise SystemExit("error: …")` is the message the one-shot CLI would have
    printed; argparse's exit is its code; anything else names its type."""
    if isinstance(exc, SystemExit):
        code = exc.code
        if code is None or code == 0:
            return ""
        return f"exited with code {code}" if isinstance(code, int) else str(code)
    return f"{type(exc).__name__}: {exc}"


def _batch_jobs(doc: dict) -> list[tuple[str, str, list[str]]]:
    """(id, command, args) per job, validated. `args` are the flags the
    one-shot CLI takes for that command, verbatim — so a caller hands over the
    argv it already builds, minus `gspro.py <command>`. Ids default to
    `<command>-<position>` and must be unique: the log and the result key on
    them."""
    jobs = doc.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise SystemExit('error: the job list needs a non-empty "jobs" array')
    out: list[tuple[str, str, list[str]]] = []
    seen: set[str] = set()
    for i, job in enumerate(jobs):
        where = f"job {i + 1}"
        if not isinstance(job, dict):
            raise SystemExit(f"error: {where} is not an object")
        command = job.get("command")
        if not isinstance(command, str) or not command:
            raise SystemExit(f'error: {where} has no "command"')
        if command == "batch":
            raise SystemExit(f"error: {where}: a batch cannot run `batch`")
        args = job.get("args") or []
        if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
            raise SystemExit(f'error: {where} ({command}): "args" must be a list of strings')
        job_id = str(job.get("id") or f"{command}-{i + 1}")
        if job_id in seen:
            raise SystemExit(f"error: two jobs share the id {job_id!r}")
        seen.add(job_id)
        out.append((job_id, command, list(args)))
    return out


def _read_batch_doc(path: Path | None) -> dict:
    """The job list, from `--jobs <file>` or stdin."""
    if path is None:
        text, where = sys.stdin.read(), "the job list on stdin"
    elif not path.is_file():
        raise SystemExit(f"error: no such job list: {path}")
    else:
        text, where = path.read_text(encoding="utf-8"), str(path)
    try:
        doc = json.loads(text)
    except ValueError as exc:
        raise SystemExit(f"error: {where} is not JSON ({exc})")
    if not isinstance(doc, dict):
        raise SystemExit(f'error: {where} must be an object with a "jobs" array')
    return doc


def _batch_shared_line(shared: dict) -> str:
    """The `shared` block as one line for the log: only what was asked for."""
    parts = [f"{slot} {counts['hits']}/{counts['hits'] + counts['misses']}"
             for slot in _BATCH_SLOTS
             for counts in [shared[slot]] if counts["hits"] or counts["misses"]]
    return ", ".join(parts) + f"; {shared['bytes'] / (1 << 20):.0f} MB held"


def cmd_batch(doc: dict, result_path: Path | None = None, stop_on_error: bool = False) -> int:
    """Run the job list in order in this process, sharing the batch cache.
    Each job's report is captured, printed prefixed with its id and recorded;
    a job that fails (a `SystemExit` from the command, a bad argument, any
    exception) is that job's error and the batch carries on, unless
    `stopOnError` — then the jobs after it are reported as not run. Writes the
    golfmap-gspro-batch-v1 result and returns 0 only when every job
    succeeded."""
    global _BATCH

    jobs = _batch_jobs(doc)
    stop = stop_on_error or bool(doc.get("stopOnError"))
    log = sys.stdout
    results: list[dict] = []
    stopped = ""
    started = time.perf_counter()
    _BATCH = _BatchCache()
    try:
        print(f"batch: {len(jobs)} job(s) in one process"
              + (" (stopping at the first failure)" if stop else ""), file=log, flush=True)
        for job_id, command, args in jobs:
            if stopped:
                results.append({"id": job_id, "command": command, "ok": False, "seconds": 0.0,
                                "report": [], "error": f"not run ({stopped} failed, stopOnError)"})
                continue
            out = _JobOut(job_id, log)
            at = time.perf_counter()
            error = ""
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                    try:
                        code = main([command, *args])
                    finally:
                        out.flush()
                if code:
                    error = f"exited with code {code}"
            except KeyboardInterrupt:
                raise
            except BaseException as exc:   # this job's failure, not the batch's
                out.flush()
                error = _batch_error(exc)
            seconds = round(time.perf_counter() - at, 3)
            results.append({"id": job_id, "command": command, "ok": not error, "seconds": seconds,
                            "report": out.lines, "error": error or None})
            print(f"[{job_id}] {'FAILED: ' + error if error else 'ok'} in {seconds:.2f} s",
                  file=log, flush=True)
            if error and stop:
                stopped = job_id
        shared = _BATCH.stats()
    finally:
        _BATCH.close()
        _BATCH = None

    total = round(time.perf_counter() - started, 3)
    ok = sum(1 for r in results if r["ok"])
    if result_path is not None:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps({"format": BATCH_FORMAT, "jobs": results,
                                           "seconds": total, "shared": shared}, indent=1) + "\n",
                               encoding="utf-8")
        print(f"batch: wrote {result_path}", file=log)
    print(f"batch: {ok} of {len(results)} job(s) ok in {total:.1f} s "
          f"(shared: {_batch_shared_line(shared)})", file=log, flush=True)
    return 0 if ok == len(results) else 1


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
    p.add_argument("--edge-fill", dest="edge_fill", metavar="TYPES",
                   help=f"--tint-out: fill a band round these feature types (comma-separated) from the grass beyond "
                        f"it, so the course meshes and the 3D grass next to them do not pick up the photo's sand or gravel "
                        f"(default {','.join(EDGE_FILL_TYPES)}; none = keep them as photographed, the old file)")
    p.add_argument("--edge-fill-m", dest="edge_fill_m", type=float,
                   help=f"--edge-fill: how far out of the outline the band reaches, metres (default {DEFAULT_EDGE_FILL_M:g})")
    p.add_argument("--path-fill", dest="path_fill", action=argparse.BooleanOptionalAction, default=True,
                   help="--tint-out: lift the photo's tree shadows on the course's paths to the sunlit path colour "
                        "round them, keeping the gravel's grain (default on; --no-path-fill = as photographed)")
    p.add_argument("--edge-fill-inset-m", dest="edge_fill_inset_m", type=float,
                   help="--edge-fill: how far inside the outline it starts, metres, for every type (default per type: "
                        + ", ".join(f"{k} {v:g}" for k, v in EDGE_FILL_INSET_M.items()) + ")")
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
    p.add_argument("--course", help="course id or name substring: add its tree species areas (and each stem's area), "
                                    "leave out the stems on its rock slabs and in its power lines' corridors")
    p.add_argument("--rocks", help="a golfmap-walls-v1 stone-walls.json: low stems on its placed rocks are left out")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database for --course (default {DEFAULT_DB})")

    p = sub.add_parser("power-lines", help="write the course's power_line features for Unity's golfmap.powerlines.build")
    p.add_argument("--course", required=True, help="course id or name substring")
    p.add_argument("--out", required=True, help="output golfmap-power-lines-v1 JSON path (<export folder>/<prefix>-power-lines.json)")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")

    p = sub.add_parser("holes", help="write the course's tees, aim points and green centres for Unity's hole navigator")
    p.add_argument("--course", required=True, help="course id or name substring")
    p.add_argument("--out", required=True, help="output golfmap-holes-v1 JSON path (<export folder>/<prefix>-holes.json)")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database (default {DEFAULT_DB})")

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

    p = sub.add_parser("shaping-global", help="write a course's generated Blender shaping layers: 00-global "
                       "(tees flattened, paths cut + smoothed, lots and building pads levelled) and 10-features "
                       "(per-feature recipes: recipe edits + course defaults); blender/SHAPING-PLAN.md")
    p.add_argument("--course", required=True, help="course id, or a name substring (e.g. Vreta)")
    p.add_argument("--db", default=str(DEFAULT_DB), help=f"app database, opened read-only (default {DEFAULT_DB})")
    p.add_argument("--out", help=f"the global layer's path (default docs/gspro/<course>/shaping/{SHAPING_GLOBAL_FILE}); "
                                 f"{SHAPING_FEATURES_FILE} goes next to it")
    p.add_argument("--out-dir", dest="out_dir", help="the layer folder both files go into (default docs/gspro/<course>/shaping)")
    p.add_argument("--library", help="the shaping recipe library (default $GOLFMAP_RECIPE_LIBRARY, else "
                                     "blender/recipes/library.json)")

    p = sub.add_parser("batch", help="run several of the commands above in ONE process from a JSON job list, "
                                     "sharing the database, the course's features and the DEM reads")
    p.add_argument("--jobs", help="the job list JSON ({\"jobs\": [{\"id\", \"command\", \"args\"}], "
                                  "\"stopOnError\": false}); omit to read it from stdin")
    p.add_argument("--result", help=f"write the {BATCH_FORMAT} result (per-job ok/seconds/report/error, "
                                    f"the totals and the cache stats) here")
    p.add_argument("--stop-on-error", dest="stop_on_error", action="store_true",
                   help="stop at the first failed job, like \"stopOnError\": true in the job list")

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
    p.add_argument("--paths-only", dest="paths_only", action="store_true",
                   help="rewrite only <stem>-paths.json (the road surfaces) of the existing SVG at --out, "
                        "after a path changed surface; the SVG is left as it is")

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
    if args.command == "batch":
        return cmd_batch(_read_batch_doc(Path(args.jobs) if args.jobs else None),
                         Path(args.result) if args.result else None, args.stop_on_error)
    if args.command == "zones-patch":
        cmd_zones_patch(Path(args.db), args.course, Path(args.zones_json),
                        [i.strip() for i in args.ids.split(",") if i.strip()],
                        Path(args.result) if args.result else None,
                        _parse_square(args.exclude_square) if args.exclude_square else None)
        return 0
    if args.command == "shaping-global":
        cmd_shaping_global(Path(args.db), args.course, Path(args.out) if args.out else None,
                           Path(args.out_dir) if args.out_dir else None, Path(args.library) if args.library else None)
        return 0
    if args.command == "power-lines":
        cmd_power_lines(args.course, Path(args.out), Path(args.db))
        return 0
    if args.command == "holes":
        cmd_holes(args.course, Path(args.out), Path(args.db))
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
                  shadow_azimuth=args.shadow_azimuth, shadow_ratio=args.shadow_ratio,
                  edge_fill=_parse_edge_fill(args.edge_fill, args.edge_fill_m, args.edge_fill_inset_m),
                  path_fill=args.path_fill)
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
                  _parse_square(args.exclude_square) if args.exclude_square else None, extent=extent,
                  db_path=Path(args.db), course=args.course,
                  rocks_path=Path(args.rocks) if args.rocks else None)
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
                exclude_types=set(args.exclude_type or []), paths_only=args.paths_only)
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
