"""Implementations for each CLI subcommand. Kept separate from argument
parsing (__main__.py) so they're easy to unit test directly.
"""

from __future__ import annotations

import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.fill import fillnodata

from golfpipe import grid_dem as grid_dem_mod
from golfpipe import stac
from golfpipe.manifest import build_manifest, write_manifest
from golfpipe.raster import edge_pad_dem, mosaic_and_crop, open_warped_to_mercator
from golfpipe.terrain_rgb import encode_terrain_rgb
from golfpipe.tiling import generate_tile_pyramid, pyramid_bounds_3857, raster_bounds_wgs84

DEFAULT_ORTHO_MINZOOM = 14
DEFAULT_ORTHO_MAXZOOM = 20
DEFAULT_TERRAIN_MINZOOM = 12
DEFAULT_TERRAIN_MAXZOOM = 16
DEFAULT_FETCH_BUFFER_M = 250.0
DEFAULT_TERRAIN_EDGE_PAD_M = 250.0


def cmd_reproject_bbox(
    bbox_wgs84: tuple[float, float, float, float],
    epsg: int = 3006,
) -> tuple[float, float, float, float]:
    """Reprojects a WGS84 (lon/lat) bbox to `epsg`, returning
    (e_min, n_min, e_max, n_max). Used to feed grid-dem's --bbox-3006 from a
    WGS84 area selection (SWEREF99 TM = EPSG:3006, in metres)."""
    from rasterio.crs import CRS
    from rasterio.warp import transform_bounds

    left, bottom, right, top = transform_bounds(
        CRS.from_epsg(4326), CRS.from_epsg(epsg), *bbox_wgs84,
    )
    return (left, bottom, right, top)


def cmd_fetch_dem(bbox: tuple[float, float, float, float], workdir: Path, out: Path, buffer_m: float = DEFAULT_FETCH_BUFFER_M) -> Path:
    """STAC-searches dtm-cog for bbox, downloads matching COG(s) with basic
    auth into workdir, mosaics/crops to bbox+buffer, writes out (kept in the
    source CRS — EPSG:3006/RH2000 — since terrain-RGB tiling reprojects at
    tile time anyway).
    """
    items = stac.search_dem(bbox)
    if not items:
        print(f"No dtm-cog items found for bbox {bbox}", file=sys.stderr)
        raise SystemExit(1)

    workdir.mkdir(parents=True, exist_ok=True)
    downloaded = []
    for item in items:
        dest = workdir / f"{item.id}.tif"
        print(f"Downloading DEM item {item.id} -> {dest}")
        stac.download_asset(item.data_href, dest)
        downloaded.append(dest)

    mosaic_and_crop(downloaded, bbox, out, buffer_m=buffer_m)
    print(f"Wrote {out}")
    return out


def cmd_list_ortho_vintages(bbox: tuple[float, float, float, float]) -> list[dict]:
    """Print (as JSON) the ortho vintages covering bbox, newest first:
    [{collection, dates, count}, …]. Lets callers pick which flight(s) to
    fetch (different vintages are often flown in different seasons)."""
    import json

    out = []
    for collection, items in stac.ortho_vintages(bbox):
        dates = sorted({it.datetime[:10] for it in items if it.datetime})
        out.append({"collection": collection, "dates": dates, "count": len(items)})
    print(json.dumps(out))
    return out


def cmd_fetch_ortho(bbox: tuple[float, float, float, float], workdir: Path, out: Path, buffer_m: float = DEFAULT_FETCH_BUFFER_M, collection: str | None = None) -> Path:
    """STAC-searches stac-bild across all collections for bbox (newest
    coverage first, see golfpipe.stac.search_ortho), downloads the item(s)
    with basic auth, mosaics/crops to bbox+buffer.

    Without `collection`, uses the newest vintage covering the bbox. Pass
    `collection` (e.g. from list-ortho-vintages) to fetch a specific vintage.

    Ortho items are RGBI (4-band); only the first 3 bands (RGB) are kept
    since tile-ortho produces JPEG (no alpha/NIR).
    """
    items = stac.search_ortho(bbox)
    if not items:
        print(f"No orthophoto items found for bbox {bbox}", file=sys.stderr)
        raise SystemExit(1)

    # Keep only items from the requested (or newest) collection covering the
    # bbox, so a mosaic isn't built from mismatched years.
    target_collection = collection or items[0].collection
    selected = [it for it in items if it.collection == target_collection]
    if not selected:
        print(f"No orthophoto items in collection {target_collection!r} for bbox {bbox}", file=sys.stderr)
        raise SystemExit(1)

    workdir.mkdir(parents=True, exist_ok=True)
    downloaded = []
    for item in selected:
        dest = workdir / f"{item.id}.tif"
        print(f"Downloading ortho item {item.id} (collection {item.collection}) -> {dest}")
        stac.download_asset(item.data_href, dest)
        downloaded.append(dest)

    mosaic_and_crop(downloaded, bbox, out, buffer_m=buffer_m)
    _drop_to_rgb_bands(out)
    print(f"Wrote {out}")
    return out


def _drop_to_rgb_bands(path: Path) -> None:
    """If the raster has more than 3 bands (e.g. RGBI), rewrites it keeping
    only the first 3 (RGB) so downstream JPEG tiling doesn't need to guess.
    """
    with rasterio.open(path) as src:
        if src.count <= 3:
            return
        data = src.read([1, 2, 3])
        profile = src.profile.copy()
        profile.update(count=3)

    with rasterio.open(path, "w", **profile) as dst:
        dst.write(data)


def cmd_fetch_lidar(bbox: tuple[float, float, float, float], workdir: Path, out_dir: Path) -> list[Path]:
    """STAC-searches dsm-skoglig-copc (classified lidar point clouds) for
    bbox, downloads each matching .copc.laz asset with basic auth into
    out_dir. Unlike fetch-dem/fetch-ortho, this does not mosaic/crop —
    grid-dem reads the raw COPC files directly (laspy chunked reads,
    filtered to the target bbox at grid time), since these files are much
    larger (hundreds of MB to ~1 GB) and point-cloud mosaicking isn't a
    rasterio operation anyway.

    Files already present in out_dir with a size matching the remote
    Content-Length are skipped (safe to re-run after a partial fetch).
    """
    items = stac.search_lidar(bbox)
    if not items:
        print(f"No dsm-skoglig-copc items found for bbox {bbox}", file=sys.stderr)
        raise SystemExit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    downloaded = []
    for item in items:
        href = item.data_href
        filename = href.rsplit("/", 1)[-1]
        dest = out_dir / filename
        print(f"Fetching lidar item {item.id} -> {dest}")
        stac.download_asset_with_progress(href, dest)
        downloaded.append(dest)

    return downloaded


def cmd_grid_dem(
    lidar_paths: list[Path],
    bbox_3006: tuple[float, float, float, float],
    out_path: Path,
    resolution: float = grid_dem_mod.DEFAULT_RESOLUTION,
    classes: tuple[int, ...] = grid_dem_mod.DEFAULT_CLASSES,
) -> Path:
    """Bins classified lidar points from lidar_paths into a regular grid
    (mean z of the requested classification codes per cell), fills empty
    cells via rasterio.fill.fillnodata, applies a light 3x3 median filter
    to remove single-cell spikes, and writes a float32 GeoTIFF (EPSG:3006).

    Prints per-class point counts found in the bbox (diagnostic — includes
    classes outside `classes` too, so callers can see what's actually in
    the data) and basic DEM stats (elevation range, spike count).
    """
    sum_grid, count_grid, transform, class_counts = grid_dem_mod.grid_lidar_points(
        lidar_paths, bbox_3006, resolution=resolution, classes=classes,
    )

    print("Per-class point counts (within bbox):")
    for code in sorted(class_counts.counts):
        marker = " (used)" if code in classes else ""
        print(f"  class {code}: {class_counts.counts[code]:,}{marker}")
    print(f"Total points in bbox: {class_counts.total_points_in_bbox:,}")
    print(f"Points used for grid (classes {classes}): {class_counts.points_used_for_grid:,}")

    populated_cells = int(np.count_nonzero(count_grid > 0))
    total_cells = count_grid.size
    print(f"Populated cells: {populated_cells:,} / {total_cells:,} ({100.0 * populated_cells / total_cells:.1f}%)")

    dem = grid_dem_mod.build_dem_grid(sum_grid, count_grid)

    valid = dem[dem != -9999.0]
    if valid.size:
        print(f"DEM elevation range: {float(valid.min()):.2f} .. {float(valid.max()):.2f} m")
    spikes = grid_dem_mod.describe_spikes(dem)
    print(f"Spike cells (8-neighbour max diff > {grid_dem_mod.SPIKE_THRESHOLD_M} m): {spikes:,}")

    grid_dem_mod.write_dem_geotiff(dem, transform, out_path)
    print(f"Wrote {out_path}")
    return out_path


def cmd_tile_ortho(input_path: Path, out_dir: Path, minzoom: int = DEFAULT_ORTHO_MINZOOM, maxzoom: int = DEFAULT_ORTHO_MAXZOOM, jpeg_quality: int = 85) -> int:
    """Reprojects input_path to EPSG:3857 (WarpedVRT), cuts 256px XYZ tiles,
    saves JPEG at {out_dir}/{z}/{x}/{y}.jpg. Skips fully-nodata tiles.
    """
    bbox_wgs84 = raster_bounds_wgs84(input_path)
    pyramid_bounds = pyramid_bounds_3857(bbox_wgs84, minzoom, maxzoom)
    vrt = open_warped_to_mercator(input_path, Resampling.bilinear, extra_bounds_3857=pyramid_bounds)
    try:
        nodata = vrt.nodata

        def encode(data: np.ndarray):
            bands = data.shape[0]
            if bands < 3:
                # Grayscale source: replicate to RGB.
                rgb = np.repeat(data[0:1], 3, axis=0)
            else:
                rgb = data[:3]

            if nodata is not None and np.all(rgb == nodata):
                return None
            if nodata is None and np.all(rgb == 0):
                return None

            img_array = np.moveaxis(rgb, 0, -1).astype(np.uint8)
            img = Image.fromarray(img_array)
            from io import BytesIO

            buf = BytesIO()
            img.save(buf, format="JPEG", quality=jpeg_quality)
            return buf.getvalue()

        count = generate_tile_pyramid(vrt, bbox_wgs84, minzoom, maxzoom, out_dir, encode, "jpg")
    finally:
        vrt.close()

    print(f"Wrote {count} ortho tiles to {out_dir}")
    return count


@contextmanager
def _fill_interior_nodata(input_path: Path, max_search_distance: float = 100.0):
    """Yields a path to a DEM with interior nodata holes inpainted via
    rasterio.fill.fillnodata (GDAL's conic-search interpolation), or the
    original input_path unchanged if the source has no nodata value or no
    nodata pixels at all.

    This only touches nodata *within* the source raster's own extent (e.g.
    corridors/gaps left by a PDAL polygon-crop step). It does not affect
    the WarpedVRT padding added later for tile-grid alignment (see
    open_warped_to_mercator's extra_bounds_3857) — that padding is added
    after this function returns, is genuinely outside the source's real
    coverage, and is intentionally still 0-filled at encode time.
    """
    with rasterio.open(input_path) as src:
        nodata = src.nodata
        if nodata is None:
            yield input_path
            return

        data = src.read(1)
        mask = data != nodata
        if mask.all():
            # No nodata pixels present at all; nothing to fill.
            yield input_path
            return

        filled = fillnodata(data, mask=mask.astype(np.uint8), max_search_distance=max_search_distance)
        profile = src.profile.copy()
        # Drop source tiling/block-size options: they're only valid together
        # with TILED=YES, which we don't set for this small scratch write.
        profile.pop("blockxsize", None)
        profile.pop("blockysize", None)
        profile.pop("tiled", None)

    with tempfile.TemporaryDirectory() as tmpdir:
        filled_path = Path(tmpdir) / "filled.tif"
        with rasterio.open(filled_path, "w", **profile) as dst:
            dst.write(filled, 1)
        yield filled_path


def cmd_tile_terrain(
    input_path: Path,
    out_dir: Path,
    minzoom: int = DEFAULT_TERRAIN_MINZOOM,
    maxzoom: int = DEFAULT_TERRAIN_MAXZOOM,
    fill_nodata: bool = True,
    edge_pad_m: float = DEFAULT_TERRAIN_EDGE_PAD_M,
) -> int:
    """Reprojects input_path (single-band DEM) to EPSG:3857 (WarpedVRT,
    bilinear resampling), cuts 256px XYZ tiles, Terrain-RGB encodes each
    tile, and saves PNG at {out_dir}/{z}/{x}/{y}.png.

    Nodata / edge handling: a DEM can have "no real data" pixels for two
    different reasons, which need different treatment:

    1. Interior nodata — holes *inside* the raster's real coverage (e.g.
       a PDAL polygon-crop step leaves a corridor or ragged edge of nodata
       pixels surrounded by valid data on all sides). Filling these with a
       flat height of 0 m is wrong: it carves a canyon/cliff-wall straight
       through real terrain. When fill_nodata is True (the default), these
       are inpainted via rasterio.fill.fillnodata (GDAL conic-search
       interpolation from surrounding valid pixels) *before* reprojection,
       so the tiled output has continuous, plausible heights there.
    2. Outside-coverage padding — the WarpedVRT's virtual extent is grown
       to cover the full XYZ tile pyramid bounds (see
       open_warped_to_mercator), which almost always extends past the
       source DEM's real extent since tile grids rarely align to it (and,
       for a DEM whose coverage simply stops at a course boundary, tile
       pyramids covering the boundary/overlap tiles reach well beyond real
       survey coverage too). Rather than 0-filling that grown area (which
       produces a 40-90 m sea-level cliff wall ringing the real terrain —
       the "Landeryd edge-wall" bug), the DEM is pre-padded by edge_pad_m
       metres (edge_pad_m > 0, default DEFAULT_TERRAIN_EDGE_PAD_M) using
       edge-replicated heights (golfpipe.raster.edge_pad_dem: numpy
       `mode="edge"`, i.e. the outermost real row/column repeated outward)
       *before* the WarpedVRT is built, so boundary/overlap tiles sample
       plausible terrain instead of a hard 0 m floor. Any remaining area
       outside even that padded extent (i.e. more than edge_pad_m metres
       past real coverage) is still 0-filled at encode time as a last
       resort; pass edge_pad_m=0 to restore the old behavior of 0-filling
       all outside-coverage area directly.

    Passing fill_nodata=False restores the old behavior of 0-filling
    interior nodata too (useful for tests/debugging, not recommended for
    real DEMs with interior gaps).

    IMPORTANT: the tile pyramid enumeration (which z/x/y tiles get
    written) and manifest bounds are computed from bbox_wgs84 derived
    from the *original* (unpadded) prepared_path, before edge_pad_dem
    runs — edge padding only changes what heights boundary/overlap tiles
    sample, never which tiles exist or what bounds get reported.
    """
    with _fill_interior_nodata(input_path) if fill_nodata else _noop_path(input_path) as prepared_path:
        bbox_wgs84 = raster_bounds_wgs84(prepared_path)
        pyramid_bounds = pyramid_bounds_3857(bbox_wgs84, minzoom, maxzoom)

        with edge_pad_dem(prepared_path, edge_pad_m) as padded_path:
            vrt = open_warped_to_mercator(padded_path, Resampling.bilinear, extra_bounds_3857=pyramid_bounds)
            try:
                nodata = vrt.nodata

                def encode(data: np.ndarray):
                    heights = data[0].astype(np.float64)
                    if nodata is not None:
                        heights = np.where(heights == nodata, 0.0, heights)
                    heights = np.nan_to_num(heights, nan=0.0, posinf=0.0, neginf=0.0)

                    rgb = encode_terrain_rgb(heights)
                    img = Image.fromarray(rgb)
                    from io import BytesIO

                    buf = BytesIO()
                    img.save(buf, format="PNG")
                    return buf.getvalue()

                count = generate_tile_pyramid(vrt, bbox_wgs84, minzoom, maxzoom, out_dir, encode, "png")
            finally:
                vrt.close()

    print(f"Wrote {count} terrain tiles to {out_dir}")
    return count


@contextmanager
def _noop_path(input_path: Path):
    yield input_path


def cmd_manifest(course_id: str, tiles_dir: Path, dem_path: Path | None = None, out_path: Path | None = None) -> Path:
    ortho_dir = tiles_dir / "ortho"
    terrain_dir = tiles_dir / "terrain"
    manifest = build_manifest(
        course_id,
        ortho_tiles_dir=ortho_dir if ortho_dir.exists() else None,
        terrain_tiles_dir=terrain_dir if terrain_dir.exists() else None,
        dem_path=dem_path,
    )
    target = out_path or (tiles_dir / "manifest.json")
    write_manifest(manifest, target)
    print(f"Wrote {target}")
    return target
