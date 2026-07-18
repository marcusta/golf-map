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
import requests
from PIL import Image
from rasterio.enums import Resampling
from rasterio.fill import fillnodata

from golfpipe import detect_common
from golfpipe import detect_trees as detect_trees_mod
from golfpipe import detect_water as detect_water_mod
from golfpipe import grid_dem as grid_dem_mod
from golfpipe import osm as osm_mod
from golfpipe import stac
from golfpipe import water as water_mod
from golfpipe.hillshade import write_hillshade_geotiff
from golfpipe.manifest import build_manifest, write_manifest
from golfpipe.raster import edge_pad_dem, mosaic_and_crop, open_warped_to_mercator
from golfpipe.terrain_rgb import encode_terrain_rgb
from golfpipe.tiling import generate_tile_pyramid, pyramid_bounds_3857, raster_bounds_wgs84

DEFAULT_ORTHO_MINZOOM = 14
DEFAULT_ORTHO_MAXZOOM = 20
DEFAULT_TERRAIN_MINZOOM = 12
DEFAULT_TERRAIN_MAXZOOM = 16
# Hillshade is derived from the ~1 m DEM: tile to 19 (one below ortho's 20 —
# overzooming further only blurs, the DEM has no more detail).
DEFAULT_HILLSHADE_MINZOOM = 14
DEFAULT_HILLSHADE_MAXZOOM = 19
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
    since tile-ortho produces opaque WebP (no alpha/NIR).
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
    only the first 3 (RGB) so downstream WebP tiling doesn't need to guess.
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


def cmd_fetch_water(
    bbox: tuple[float, float, float, float],
    workdir: Path,
    out: Path,
    creek_width_m: float = water_mod.DEFAULT_CREEK_WIDTH_M,
    session=None,
) -> Path:
    """STAC-searches the open vector catalog's Marktäcke collection
    (Topografi 10 land cover, one zipped GeoPackage per kommun) for bbox,
    downloads the zip asset(s) with basic auth into workdir, extracts the
    GeoPackages, and writes one EPSG:3006 GeoJSON FeatureCollection to
    `out`: water polygons (objekttyp Sjö/Anlagt vatten/Vattendragsyta/Hav)
    → properties.type 'water'; watercourse lines (where the product carries
    them) buffered to creek_width_m total width → 'water_creek'. The file
    is importable by the web GeoJSON draft-import wizard.

    NOTE: downloading requires the LANTMATERIET_USER/PASS account to have
    the Marktäcke product activated in Geotorget — without it dl1 responds
    403 even though the anonymous STAC search succeeds.
    """
    items = stac.search_marktacke(bbox, session=session)
    if not items:
        print(f"No marktacke items found for bbox {bbox}", file=sys.stderr)
        raise SystemExit(1)

    workdir.mkdir(parents=True, exist_ok=True)
    gpkg_paths: list[Path] = []
    for item in items:
        href = item.data_href
        dest = workdir / href.rsplit("/", 1)[-1]
        print(f"Fetching marktacke item {item.id} -> {dest}")
        try:
            stac.download_asset_with_progress(href, dest, session=session)
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 403:
                raise water_mod.WaterError(
                    "Marktäcke download returned 403 Forbidden: the "
                    "LANTMATERIET_USER account has not activated the "
                    "'Marktäcke Nedladdning, vektor' product in Geotorget "
                    "(the anonymous STAC search works without it, the "
                    "dl1.lantmateriet.se download does not)."
                ) from exc
            raise
        gpkg_paths.extend(water_mod.extract_geopackages(dest, workdir))

    bbox_3006 = cmd_reproject_bbox(bbox)
    polygons = []
    lines = []
    for gpkg in gpkg_paths:
        polys, creek_lines = water_mod.read_water_features(gpkg, bbox_3006)
        polygons.extend(polys)
        lines.extend(creek_lines)

    collection = water_mod.build_water_geojson(polygons, lines, creek_width_m=creek_width_m)
    water_mod.write_geojson(collection, out)

    counts: dict[str, int] = {}
    for feature in collection["features"]:
        t = feature["properties"]["type"]
        counts[t] = counts.get(t, 0) + 1
    print(f"Water polygons in bbox: {len(polygons)} source, {counts.get('water', 0)} merged")
    print(f"Watercourse lines in bbox: {len(lines)} source, {counts.get('water_creek', 0)} buffered ribbons (width {creek_width_m} m)")
    if not lines:
        print("(no watercourse lines found — the open Marktäcke product may not carry them for this area)")
    print(f"Wrote {out}")
    return out


def cmd_fetch_osm(
    bbox: tuple[float, float, float, float],
    out: Path,
    overpass_fetch=None,
    overpass_url: str = osm_mod.OVERPASS_URL,
) -> Path:
    """Queries the Overpass API for OSM golf + land-cover polygons in bbox
    (WGS84), reprojects them to EPSG:3006, and writes one GeoJSON
    FeatureCollection to `out`, importable by the web GeoJSON draft-import
    wizard. Tag→type: golf=green/tee/fairway/bunker/rough → same;
    golf=water_hazard|lateral_water_hazard and natural=water → 'water';
    landuse=forest|natural=wood → 'trees'. Closed ways become one Polygon;
    type=multipolygon relations become one Polygon per outer ring with
    inners as holes. Anything else (incl. linear ways) is skipped.

    LICENSING: OSM is ODbL — every feature carries provenance properties and
    the collection a top-level `attribution` field (see golfpipe.osm). Durable
    provenance/attribution before public distribution is a flagged wave-level
    decision; no schema column is added here.
    """
    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    fetch = overpass_fetch or osm_mod.fetch_overpass
    query = osm_mod.build_overpass_query(bbox)
    print(f"Querying Overpass for golf/terrain features in bbox {bbox} ...")
    overpass_json = fetch(query, url=overpass_url)

    src = CRS.from_epsg(4326)
    dst = CRS.from_epsg(osm_mod.SWEREF99_TM_SRID)

    def reproject(lons, lats):
        xs, ys = warp_transform(src, dst, list(lons), list(lats))
        return xs, ys

    features, skipped = osm_mod.assemble_features(overpass_json, reproject)
    from datetime import date

    collection = osm_mod.build_osm_geojson(features, fetch_date=date.today().isoformat())
    osm_mod.write_geojson(collection, out)

    counts: dict[str, int] = {}
    for feature in collection["features"]:
        t = feature["properties"]["type"]
        counts[t] = counts.get(t, 0) + 1
    print(f"OSM features imported: {len(collection['features'])} " + (
        ", ".join(f"{t}={n}" for t, n in sorted(counts.items())) or "(none)"
    ))
    if skipped:
        print(f"Skipped {len(skipped)} element(s):")
        for note in skipped[:10]:
            print(f"  - {note}")
        if len(skipped) > 10:
            print(f"  … and {len(skipped) - 10} more")
    if not collection["features"]:
        print("(no golf/terrain polygons found in bbox — is the course mapped in OSM?)")
    print(f"Wrote {out}")
    return out


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


def cmd_detect_trees(
    lidar_paths: list[Path],
    bbox_3006: tuple[float, float, float, float],
    out: Path,
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
    min_height_m: float = detect_trees_mod.DEFAULT_MIN_HEIGHT_M,
    min_area_m2: float = detect_trees_mod.DEFAULT_MIN_AREA_M2,
    simplify_tolerance_m: float = detect_trees_mod.DEFAULT_SIMPLIFY_TOLERANCE_M,
) -> Path:
    """Derives draft `trees` canopy polygons from the classified COPC lidar
    cmd_fetch_lidar downloads, via an nDSM (Laserdata Skog does not classify
    vegetation, so class codes can't select trees):

      ground  = mean z of DEFAULT_CLASSES returns (grid-dem's own path)
      surface = max z per cell over all returns except noise (7/18)
      nDSM    = surface - ground

    The default 1.0 m resolution (detect_trees.DEFAULT_RESOLUTION, coarser
    than grid-dem's 0.5 m) keeps ~1-2 pts/m² lidar from leaving empty cells
    all over real forest. Threshold at min_height_m, binary closing + opening
    (sampling-hole bridge / crown dissolve first, then noise removal),
    8-connected polygonize, min-area filter, simplify.
    Writes one EPSG:3006 GeoJSON FeatureCollection (properties.type
    'trees') importable by the web GeoJSON draft-import wizard.
    """
    print("Gridding ground returns (mean z) ...")
    ground_sum, ground_count, transform, ground_counts = grid_dem_mod.grid_lidar_points(
        lidar_paths, bbox_3006, resolution=resolution, classes=grid_dem_mod.DEFAULT_CLASSES,
    )
    ground_dem = grid_dem_mod.build_dem_grid(ground_sum, ground_count)

    print(f"Gridding surface returns (max z, all classes except noise {detect_trees_mod.NOISE_CLASSES}) ...")
    surface_max, surface_count, _, surface_counts = grid_dem_mod.grid_lidar_points(
        lidar_paths, bbox_3006, resolution=resolution,
        classes=None, aggregate="max", exclude_classes=detect_trees_mod.NOISE_CLASSES,
    )

    print(f"Ground points used: {ground_counts.points_used_for_grid:,}")
    print(f"Surface points used: {surface_counts.points_used_for_grid:,}")

    ndsm = detect_trees_mod.build_ndsm(ground_dem, surface_max, surface_count)
    raw_cells = int(np.count_nonzero(ndsm >= min_height_m))
    mask = detect_trees_mod.canopy_mask(ndsm, min_height_m=min_height_m)
    cleaned_cells = int(np.count_nonzero(mask))
    cell_area = resolution * resolution
    print(f"Canopy cells >= {min_height_m} m: {raw_cells:,} raw, {cleaned_cells:,} after morphology "
          f"(~{cleaned_cells * cell_area:,.0f} m²)")

    polygons = detect_trees_mod.mask_to_polygons(mask, transform)
    kept = detect_trees_mod.filter_and_simplify(
        polygons, min_area_m2=min_area_m2, simplify_tolerance_m=simplify_tolerance_m,
    )
    print(f"Crown polygons: {len(polygons)} polygonized, {len(kept)} kept (min area {min_area_m2} m²)")

    collection = detect_trees_mod.build_trees_geojson(kept)
    water_mod.write_geojson(collection, out)
    if not collection["features"]:
        print("(no canopy found — is the bbox on the course? try a lower --min-height)")
    print(f"Wrote {out}")
    return out


def cmd_detect_water(
    lidar_paths: list[Path],
    bbox_3006: tuple[float, float, float, float],
    out: Path,
    resolution: float = grid_dem_mod.DEFAULT_RESOLUTION,
    closing_radius_m: float = detect_water_mod.DEFAULT_CLOSING_RADIUS_M,
    min_area_m2: float = detect_water_mod.DEFAULT_MIN_AREA_M2,
    simplify_tolerance_m: float = detect_water_mod.DEFAULT_SIMPLIFY_TOLERANCE_M,
    flatness_spread_m: float = detect_water_mod.DEFAULT_FLATNESS_SPREAD_M,
) -> Path:
    """Derives draft `water` polygons from the classified COPC lidar
    cmd_fetch_lidar downloads: per-cell PRESENCE of class-9 (water) points,
    generously closed (water absorbs NIR, so returns are sparse), opened,
    8-connected polygonized, min-area filtered, simplified. A per-polygon
    flatness check (class-9 z-spread > flatness_spread_m) is REPORT-ONLY —
    warnings are printed, nothing is dropped. Creeks rarely carry class-9
    returns: water_creek is out of scope (fetch-water covers it once the
    Marktäcke entitlement is active). Writes one EPSG:3006 GeoJSON
    FeatureCollection (properties.type 'water') importable by the web
    GeoJSON draft-import wizard.
    """
    print(f"Gridding water returns (class {detect_water_mod.WATER_CLASSES} presence) ...")
    sum_grid, count_grid, transform, class_counts = grid_dem_mod.grid_lidar_points(
        lidar_paths, bbox_3006, resolution=resolution, classes=detect_water_mod.WATER_CLASSES,
    )
    print(f"Class-9 points used: {class_counts.points_used_for_grid:,}")

    presence_cells = int(np.count_nonzero(count_grid > 0))
    mask = detect_water_mod.water_mask(count_grid, resolution, closing_radius_m=closing_radius_m)
    cleaned_cells = int(np.count_nonzero(mask))
    cell_area = resolution * resolution
    print(f"Water cells: {presence_cells:,} with returns, {cleaned_cells:,} after closing "
          f"(radius {closing_radius_m} m) + opening (~{cleaned_cells * cell_area:,.0f} m²)")

    polygons = detect_common.mask_to_polygons(mask, transform)
    kept = detect_common.filter_and_simplify(
        polygons, min_area_m2=min_area_m2, simplify_tolerance_m=simplify_tolerance_m,
    )
    print(f"Water polygons: {len(polygons)} polygonized, {len(kept)} kept (min area {min_area_m2} m²)")

    # Report-only flatness sanity check: standing water is flat, so a big
    # z-spread hints at misclassified noise — warn, never filter silently.
    spreads = detect_water_mod.flatness_spreads(kept, sum_grid, count_grid, transform)
    for i, (polygon, spread) in enumerate(zip(kept, spreads)):
        if spread > flatness_spread_m:
            e, n = polygon.centroid.x, polygon.centroid.y
            print(f"warning: water polygon {i} at ({e:.0f}, {n:.0f}) has class-9 z-spread "
                  f"{spread:.2f} m (> {flatness_spread_m} m) — possible misclassified noise, kept anyway")

    collection = detect_water_mod.build_water_geojson(kept)
    water_mod.write_geojson(collection, out)
    if not collection["features"]:
        print("(no water found — class 9 may be absent here; creeks rarely carry class-9 returns)")
    print(f"Wrote {out}")
    return out


def cmd_tile_ortho(input_path: Path, out_dir: Path, minzoom: int = DEFAULT_ORTHO_MINZOOM, maxzoom: int = DEFAULT_ORTHO_MAXZOOM, webp_quality: int = 80) -> int:
    """Reprojects input_path to EPSG:3857 (WarpedVRT), cuts 256px XYZ tiles,
    saves WebP at {out_dir}/{z}/{x}/{y}.webp. Skips fully-nodata tiles.
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
            img.save(buf, format="WEBP", quality=webp_quality)
            return buf.getvalue()

        count = generate_tile_pyramid(vrt, bbox_wgs84, minzoom, maxzoom, out_dir, encode, "webp")
    finally:
        vrt.close()

    print(f"Wrote {count} ortho tiles to {out_dir}")
    return count


def cmd_tile_hillshade(
    dem_path: Path,
    out_dir: Path,
    minzoom: int = DEFAULT_HILLSHADE_MINZOOM,
    maxzoom: int = DEFAULT_HILLSHADE_MAXZOOM,
    azimuth: float = 315.0,
    altitude: float = 45.0,
    z: float = 1.0,
) -> int:
    """Renders an opaque QGIS-style grayscale hillshade from the DEM (Horn,
    default az 315° / alt 45° / z 1) and tiles it into an XYZ WebP pyramid at
    out_dir. The intermediate hillshade GeoTIFF is temporary; the served tiles
    are ordinary opaque raster tiles (tiled via the same encoder as ortho —
    grayscale is replicated to RGB).
    """
    with tempfile.TemporaryDirectory(prefix="golfpipe-hs-") as tmp:
        hillshade_tif = Path(tmp) / "hillshade.tif"
        write_hillshade_geotiff(dem_path, hillshade_tif, azimuth=azimuth, altitude=altitude, z=z)
        count = cmd_tile_ortho(hillshade_tif, out_dir, minzoom=minzoom, maxzoom=maxzoom)
    print(f"Wrote {count} hillshade tiles to {out_dir}")
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
    hillshade_dir = tiles_dir / "hillshade"
    manifest = build_manifest(
        course_id,
        ortho_tiles_dir=ortho_dir if ortho_dir.exists() else None,
        terrain_tiles_dir=terrain_dir if terrain_dir.exists() else None,
        hillshade_tiles_dir=hillshade_dir if hillshade_dir.exists() else None,
        dem_path=dem_path,
    )
    target = out_path or (tiles_dir / "manifest.json")
    write_manifest(manifest, target)
    print(f"Wrote {target}")
    return target
