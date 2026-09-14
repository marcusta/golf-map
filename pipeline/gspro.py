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
             nicer-looking one.
  hillshade  Render a square hillshade JPEG (default 8192×8192, QGIS-style) from
             a DEM — either an existing --dem GeoTIFF or freshly gridded from
             Laserdata Skog lidar for --bbox.
  trees      Convert a tree-stems asset (golfpipe trees-stems output) into the
             unity-trees-v1 file the Unity Tree Planter reads, over one
             terrain square: plot origin/size from the square, the height
             range from that terrain's heightmap sidecar.
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
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds
from PIL import Image

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

def _darken(hwc: np.ndarray, factor: float, space: str) -> np.ndarray:
    """RGB × factor, in linear light (sRGB decoded, multiplied, re-encoded)
    or directly on the sRGB values."""
    f = hwc.astype(np.float32) / 255.0
    if space == "linear":
        lin = np.where(f <= 0.04045, f / 12.92, ((f + 0.055) / 1.055) ** 2.4) * factor
        f = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    else:
        f = f * factor
    return np.round(f.clip(0, 1) * 255).astype(np.uint8)


def _render_ortho(src: Path, extent, size: int, out: Path, quality: int = DEFAULT_JPEG_QUALITY,
                  terrain_out: Path | None = None, darken: float = DEFAULT_TERRAIN_DARKEN,
                  darken_space: str = DEFAULT_DARKEN_SPACE) -> None:
    """Render the square to `out` as-is and, with `terrain_out`, a second
    copy of the same render darkened by `darken` (see `_darken`) for use as
    the Unity terrain texture — one reprojection, two files."""
    # Cubic, not bilinear: the source is ~0.16 m/px, so an 8192 px texture
    # of a 2 km square is a 1.5× downsample and bilinear aliases. OPCD's own
    # overlay step is a 16000 → 8192 cubic resample (gdal_translate -r cubic).
    rgb = _reproject_square(src, extent, size, bands=[1, 2, 3], dtype="uint8",
                            resampling=Resampling.cubic)
    out.parent.mkdir(parents=True, exist_ok=True)
    hwc = np.transpose(rgb, (1, 2, 0))
    Image.fromarray(hwc).save(out, format="JPEG", quality=quality)
    print(f"  wrote {out}")
    if terrain_out is not None:
        terrain_out.parent.mkdir(parents=True, exist_ok=True)
        dark = _darken(hwc, darken, darken_space)
        tq = max(quality, TERRAIN_JPEG_QUALITY)
        Image.fromarray(dark).save(terrain_out, format="JPEG", quality=tq, subsampling=0)
        print(f"  wrote {terrain_out}  (terrain texture, ×{darken:g} in {darken_space} light, JPEG q{tq} 4:4:4)")


def cmd_ortho(bbox, out_dir: Path | None, size: int, count: int, ortho_tifs: list[Path] | None,
              quality: int = DEFAULT_JPEG_QUALITY, out: Path | None = None,
              extent: Extent | None = None, terrain_out: Path | None = None,
              darken: float = DEFAULT_TERRAIN_DARKEN, darken_space: str = DEFAULT_DARKEN_SPACE) -> None:
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
                          darken_space=darken_space)
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
            _render_ortho(mosaic, extent, size, out_dir / f"ortho_{_safe(collection)}_{size}px.jpg", quality)

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
            terrain: str | None = None, inner_sidecar: Path | None = None) -> None:
    """Clip + bilinear-resample `dem_path` to the square at `resolution` m/px
    and write it as a float32 EPSG:3006 GeoTIFF (deflate) — what OPCD's
    TIF→RAW heightmap step takes — AND do that step: a `<out stem>.raw`
    Unity heightmap, `raw_size`² uint16 little-endian north-up, scaled over
    the height range (0 = skip). The RAW is resampled straight from the
    source DEM, not from the TIF, so it costs one resampling like the .bat.
    A `<out>.json` sidecar records the square, the cell size, the height
    range and the Unity terrain + import settings (OPCD's MinMax sheet);
    with `inner_sidecar` (an outer export) it also carries the outer
    terrain's Unity position relative to the inner at the origin."""
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


def cmd_svg(bbox, out: Path, db_path: Path, course_ident: str,
            flatten: float | None, precision: int, mapped: dict[str, str],
            stack: str = "opcd", extent: Extent | None = None) -> None:
    extent = extent or _square_3006_extent(bbox)
    e0, n0, e1, n1 = extent
    side = e1 - e0
    fills = {**GSPRO_FILLS, **mapped}

    # EPSG:3006 metres -> SVG user units (also metres). SVG is y-DOWN, so the
    # viewBox top edge is the NORTH bound. Same square extent the ortho and
    # hillshade commands render, so this drops straight on top of them.
    def to_svg(xy: Pt) -> Pt:
        return (xy[0] - e0, n1 - xy[1])

    conn = _open_course_db(db_path)
    course = _resolve_course(conn, course_ident)
    rows = conn.execute(
        """SELECT f.id, f.type, f.geometry_json, f.sort_order, h.number AS hole_number
           FROM course_features f LEFT JOIN holes h ON h.id = f.hole_id
           WHERE f.course_id = ?
           ORDER BY (h.number IS NULL), h.number, f.sort_order, f.id""",
        (course["id"],),
    ).fetchall()
    conn.close()
    if not rows:
        raise SystemExit(f"error: course {course['name']} ({course['id']}) has no features")

    # One Inkscape layer per hole (Hole1…, the unpadded spelling every OPCD
    # course file here uses) plus 'Others' for features not tied to a hole.
    if stack == "opcd":
        # Stable sort, so inside each layer the app's order survives: non-top
        # types first as they are, then green/tee/bunker as they are. The hole
        # keys keep the lift from reaching across layers.
        rows = sorted(rows, key=lambda r: (r["hole_number"] is None, r["hole_number"] or 0,
                                           r["type"] in TOP_TYPES))

    # Shapes are named hole_<hole>_<index on hole> (others_<index> off-hole).
    # The mesh keeps the material from the fill, so the name only has to say
    # which hole it came from and stay unique.
    layers: dict[str, list[str]] = {}
    counts: dict[str, int] = {}
    written: dict[str, int] = {}
    skipped: dict[str, int] = {}
    outside = 0
    for row in rows:
        kind = row["type"]
        fill = fills.get(kind)
        if not fill:
            skipped[kind] = skipped.get(kind, 0) + 1
            continue

        geom = json.loads(row["geometry_json"])
        curve_type = geom.get("curveType") or "bezier"
        rings = geom.get("rings") or []
        subpaths = [d for d in (_path_d(_ring_anchors(r, curve_type), to_svg, precision, flatten)
                                for r in rings) if d]
        if not subpaths:
            continue

        layer = f"Hole{row['hole_number']}" if row["hole_number"] is not None else COURSE_WIDE_LAYER
        stem = f"hole_{row['hole_number']}" if row["hole_number"] is not None else "others"
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

        if any(not (e0 <= float(p["x"]) <= e1 and n0 <= float(p["y"]) <= n1)
               for r in rings for p in (r.get("points") or [])):
            outside += 1

    # Document order matches the OPCD files: the off-hole layer at the bottom,
    # then the holes descending so Hole1 ends up topmost in Inkscape.
    order = sorted((k for k in layers if k != COURSE_WIDE_LAYER), key=lambda k: -int(k[4:]))
    if COURSE_WIDE_LAYER in layers:
        order.insert(0, COURSE_WIDE_LAYER)

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
    if skipped:
        detail = ", ".join(f"{k} {v}" for k, v in sorted(skipped.items()))
        print(f"  skipped (no OPCD surface): {detail}; add one with e.g. --map trees=pinestraw")
    if outside:
        print(f"  warning: {outside} feature(s) reach outside the square; widen the area to include them")


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

    p = sub.add_parser("trees", help="write the unity-trees-v1 file for one terrain from a tree-stems asset")
    _add_area(p)
    p.add_argument("--stems", required=True, help="tree-stems.json (golfpipe trees-stems compact asset)")
    p.add_argument("--sidecar", required=True, help="the terrain's heightmap sidecar (<dem>.tif.json) for the height range")
    p.add_argument("--out", required=True, help="output unity-trees-v1 JSON path")
    p.add_argument("--terrain", choices=["inner", "outer"], help="which GSPro terrain (default: the sidecar's)")
    p.add_argument("--exclude-square", dest="exclude_square",
                   help="x0,y0,x1,y1 in EPSG:3006 to leave out — the inner square when writing the outer's trees")

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
    bbox, extent = _resolve_area(args)

    if args.command == "ortho":
        cmd_ortho(bbox, Path(args.out_dir) if args.out_dir else None, args.size, args.count,
                  [Path(p) for p in args.ortho] if args.ortho else None,
                  args.quality, Path(args.out) if args.out else None, extent=extent,
                  terrain_out=Path(args.terrain_out) if args.terrain_out else None, darken=args.darken,
                  darken_space=args.darken_space)
    elif args.command == "hillshade":
        cmd_hillshade(
            bbox, Path(args.out), args.size,
            Path(args.dem) if args.dem else None,
            args.azimuth, args.altitude, args.z_factor, args.resolution, extent=extent,
        )
    elif args.command == "dem":
        cmd_dem(bbox, Path(args.dem), Path(args.out), args.resolution, extent=extent,
                raw_size=args.raw_size, terrain=args.terrain,
                inner_sidecar=Path(args.inner_sidecar) if args.inner_sidecar else None)
    elif args.command == "trees":
        cmd_trees(bbox, Path(args.stems), Path(args.sidecar), Path(args.out), args.terrain,
                  _parse_square(args.exclude_square) if args.exclude_square else None, extent=extent)
    elif args.command == "svg":
        cmd_svg(bbox, Path(args.out), Path(args.db), args.course,
                args.flatten, args.precision, _parse_map(args.map), args.stack, extent=extent)
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
