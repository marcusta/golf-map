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

All commands take --bbox west,south,east,north in WGS84 degrees. Outputs are
rendered over the same square SWEREF99 (EPSG:3006) extent, so the ortho and
hillshade line up. Downloads need LANTMATERIET_USER/LANTMATERIET_PASS (loaded
from the repo-root .env, same as golfpipe).
"""

from __future__ import annotations

import argparse
import os
import re
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


def _square_3006_extent(bbox_wgs84: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Reproject the WGS84 bbox to EPSG:3006 metres and expand the shorter side
    so the extent is a true square (GSPro textures/heightmaps are square)."""
    e0, n0, e1, n1 = transform_bounds(WGS84, SWEREF99, *bbox_wgs84)
    cx, cy = (e0 + e1) / 2.0, (n0 + n1) / 2.0
    side = max(e1 - e0, n1 - n0)
    return (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)


def _reproject_square(src_path: Path, extent: tuple[float, float, float, float], size: int,
                      bands: list[int], dtype, resampling: Resampling) -> np.ndarray:
    """Reproject selected bands of a raster into a size×size array covering the
    square EPSG:3006 `extent`. Returns (len(bands), size, size)."""
    e0, n0, e1, n1 = extent
    dst_transform = from_bounds(e0, n0, e1, n1, size, size)
    out = np.zeros((len(bands), size, size), dtype=dtype)
    with rasterio.open(src_path) as src:
        for i, b in enumerate(bands):
            reproject(
                source=rasterio.band(src, b),
                destination=out[i],
                src_crs=src.crs, src_transform=src.transform,
                dst_crs=SWEREF99, dst_transform=dst_transform,
                resampling=resampling,
            )
    return out


def _safe(name: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name or "unknown")


# --- Command: ortho ---------------------------------------------------------

def _render_ortho(src: Path, extent, size: int, out: Path) -> None:
    rgb = _reproject_square(src, extent, size, bands=[1, 2, 3], dtype="uint8",
                            resampling=Resampling.bilinear)
    Image.fromarray(np.transpose(rgb, (1, 2, 0))).save(out, quality=92)
    print(f"  wrote {out}")


def cmd_ortho(bbox, out_dir: Path, size: int, count: int, ortho_tifs: list[Path] | None) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    extent = _square_3006_extent(bbox)

    # Reuse already-downloaded/cropped ortho GeoTIFFs (e.g. the build's
    # data/sources/{courseId}/ortho-*.tif) instead of re-fetching.
    if ortho_tifs:
        for src in ortho_tifs:
            out = out_dir / f"ortho_{_safe(src.stem)}_{size}px.jpg"
            print(f"rendering {src.name}")
            _render_ortho(src, extent, size, out)
        print("\nDone (from local sources).")
        return

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
            _render_ortho(mosaic, extent, size, out_dir / f"ortho_{_safe(collection)}_{size}px.jpg")

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


def cmd_hillshade(bbox, out: Path, size: int, dem_path: Path | None,
                  azimuth: float, altitude: float, z: float, resolution: float) -> None:
    extent = _square_3006_extent(bbox)
    with tempfile.TemporaryDirectory(prefix="gspro-hs-") as tmp:
        dem_src = dem_path if dem_path else _dem_from_lidar(bbox, Path(tmp), resolution)

        dem = _reproject_square(dem_src, extent, size, bands=[1], dtype="float32",
                                resampling=Resampling.bilinear)[0]

    # Fill any voids (0 / nodata-ish) so the shading doesn't cliff at holes.
    finite = np.isfinite(dem) & (dem > -1e5)
    if not finite.all():
        dem = dem.copy()
        dem[~finite] = float(np.nanmean(dem[finite])) if finite.any() else 0.0

    res_m = (extent[2] - extent[0]) / size  # metres per pixel
    shade = _hillshade(dem, res_m, azimuth, altitude, z)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(shade, mode="L").save(out, quality=92)
    print(f"Wrote {out}  ({size}×{size}, {res_m:.2f} m/px, az {azimuth}°, alt {altitude}°)")


# --- CLI --------------------------------------------------------------------

def _add_bbox(p: argparse.ArgumentParser) -> None:
    p.add_argument("--bbox", required=True, help="west,south,east,north in WGS84 degrees")
    p.add_argument("--size", type=int, default=DEFAULT_SIZE, help=f"output edge in px (default {DEFAULT_SIZE})")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gspro", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("ortho", help="render the 2 newest orthophoto vintages to square JPEGs")
    _add_bbox(p)
    p.add_argument("--out-dir", required=True, help="directory to write ortho_<vintage>_<size>px.jpg into")
    p.add_argument("--count", type=int, default=2, help="how many recent vintages to render (default 2)")
    p.add_argument("--ortho", nargs="+", help="render from these existing ortho GeoTIFFs (e.g. data/sources/<id>/ortho-*.tif) instead of fetching")

    p = sub.add_parser("hillshade", help="render a square hillshade JPEG from a DEM or lidar")
    _add_bbox(p)
    p.add_argument("--out", required=True, help="output JPEG path")
    p.add_argument("--dem", help="existing DEM GeoTIFF; if omitted, lidar is fetched + gridded for --bbox")
    p.add_argument("--azimuth", type=float, default=315.0, help="light azimuth degrees (default 315, QGIS default)")
    p.add_argument("--altitude", type=float, default=45.0, help="light altitude degrees (default 45)")
    p.add_argument("--z-factor", type=float, default=1.0, dest="z_factor", help="vertical exaggeration (default 1)")
    p.add_argument("--resolution", type=float, default=grid_dem_mod.DEFAULT_RESOLUTION,
                   help="lidar grid cell size in m when building a DEM (default 0.5)")

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
    bbox = _parse_bbox(args.bbox)

    if args.command == "ortho":
        cmd_ortho(bbox, Path(args.out_dir), args.size, args.count,
                  [Path(p) for p in args.ortho] if args.ortho else None)
    elif args.command == "hillshade":
        cmd_hillshade(
            bbox, Path(args.out), args.size,
            Path(args.dem) if args.dem else None,
            args.azimuth, args.altitude, args.z_factor, args.resolution,
        )
    else:
        parser.print_help()
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
