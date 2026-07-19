"""Implementations for each CLI subcommand. Kept separate from argument
parsing (__main__.py) so they're easy to unit test directly.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import mercantile
import numpy as np
import rasterio
import requests
from PIL import Image
from rasterio.enums import Resampling
from rasterio.fill import fillnodata

from golfpipe import clean_ortho as clean_ortho_mod
from golfpipe import dem_edit as dem_edit_mod
from golfpipe import detect_common
from golfpipe import detect_trees as detect_trees_mod
from golfpipe import detect_water as detect_water_mod
from golfpipe import grid_dem as grid_dem_mod
from golfpipe import hydro as hydro_mod
from golfpipe import osm as osm_mod
from golfpipe import patches as patches_mod
from golfpipe import stac
from golfpipe import water as water_mod
from golfpipe.hillshade import write_hillshade_geotiff
from golfpipe.manifest import build_manifest, write_manifest
from golfpipe.raster import edge_pad_dem, mosaic_and_crop, open_warped_to_mercator
from golfpipe.terrain_rgb import encode_terrain_rgb
from golfpipe.tiling import generate_tile_pyramid, generate_tiles, pyramid_bounds_3857, raster_bounds_wgs84

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


def cmd_fetch_hydro(
    bbox: tuple[float, float, float, float],
    out: Path,
    creek_width_m: float = water_mod.DEFAULT_CREEK_WIDTH_M,
    session=None,
) -> Path:
    """Fetches Lantmäteriet Hydrografi Direkt (OGC API Features, basic auth)
    features intersecting bbox (WGS84) and writes one EPSG:3006 GeoJSON
    FeatureCollection to `out`: StandingWater + WatercoursePolygon surfaces
    → properties.type 'water'; WatercourseLine centerlines buffered to
    creek_width_m total width → 'water_creek'. The file is importable by
    the web GeoJSON draft-import wizard.

    This is the authoritative creek source — Marktäcke (fetch-water) has no
    watercourse lines at all in some areas (verified at Landeryd), while
    the hydrography network carries them everywhere.
    """
    surface_geoms: list = []
    for collection_id in hydro_mod.WATER_SURFACE_COLLECTIONS:
        geoms = hydro_mod.fetch_collection_geometries(collection_id, bbox, session=session)
        print(f"{collection_id}: {len(geoms)} feature(s) intersecting bbox")
        surface_geoms.extend(geoms)
    line_geoms = hydro_mod.fetch_collection_geometries(
        hydro_mod.WATERCOURSE_LINE_COLLECTION, bbox, session=session,
    )
    print(f"{hydro_mod.WATERCOURSE_LINE_COLLECTION}: {len(line_geoms)} feature(s) intersecting bbox")

    bbox_3006 = cmd_reproject_bbox(bbox)
    polygons = hydro_mod.clip_geometries(surface_geoms, bbox_3006, "polygon")
    lines = hydro_mod.clip_geometries(line_geoms, bbox_3006, "line")

    collection = hydro_mod.build_hydro_geojson(polygons, lines, creek_width_m=creek_width_m)
    hydro_mod.write_geojson(collection, out)

    counts: dict[str, int] = {}
    for feature in collection["features"]:
        t = feature["properties"]["type"]
        counts[t] = counts.get(t, 0) + 1
    print(f"Water surfaces in bbox: {len(polygons)} source, {counts.get('water', 0)} merged")
    print(f"Watercourse lines in bbox: {len(lines)} source, {counts.get('water_creek', 0)} buffered ribbons (width {creek_width_m} m)")
    if not collection["features"]:
        print("(no hydrography found in bbox — is it on land in Sweden?)")
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


def cmd_apply_dem_edits(input_path: Path, edits_path: Path, out_path: Path) -> Path:
    """Replays vector terrain edits (plane-fit flatten / circular-median
    smooth, both feathered — see golfpipe/dem_edit.py) onto a DEM GeoTIFF.

    Input is the grid-dem output (float32, EPSG:3006, nodata already mostly
    filled — but nodata cells may remain and pass through untouched); the
    edits file is the D-TE5 handoff (GeoJSON FeatureCollection, WGS84,
    per-feature properties op/featherM/radiusM/flat, applied in createdAt
    order). The input DEM is never modified (D-TE2 — the raw DEM stays the
    single source of truth); the edited DEM is a derived artifact written to
    out_path with the input's profile/transform/nodata. An empty edits file
    writes a byte-identical copy of the input.
    """
    if out_path.resolve() == input_path.resolve():
        raise dem_edit_mod.DemEditError(
            f"refusing to overwrite the input DEM {input_path} — the raw DEM stays "
            "pristine (D-TE2); pass a different --out"
        )

    edits = dem_edit_mod.load_edits(edits_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not edits:
        shutil.copyfile(input_path, out_path)
        print(f"No edits in {edits_path} — wrote a byte-identical copy of the input")
        print(f"Wrote {out_path}")
        return out_path

    with rasterio.open(input_path) as src:
        dem = src.read(1)
        profile = src.profile.copy()
        reprojected = dem_edit_mod.reproject_edits(edits, src.crs)
        edited = dem_edit_mod.apply_edits(dem, src.transform, src.nodata, reprojected)

    # Same profile-copy hygiene as _fill_interior_nodata: drop source
    # tiling/block-size options — they're only valid together with TILED=YES,
    # which we don't set for this derived write.
    profile.pop("blockxsize", None)
    profile.pop("blockysize", None)
    profile.pop("tiled", None)
    profile.update(count=1, dtype="float32")
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(edited, 1)

    changed = int(np.count_nonzero(edited != dem))
    print(f"Applied {len(edits)} edit(s); {changed:,} cell(s) changed")
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


def default_clean_out_path(ortho_path: Path) -> Path:
    """ortho-orto-l2-2025.tif -> ortho-orto-l2-2025.clean.tif, alongside the
    source (the source is never overwritten)."""
    return ortho_path.with_name(ortho_path.stem + ".clean" + ortho_path.suffix)


def cmd_clean_ortho(
    ortho_path: Path,
    trees_path: Path,
    features_path: Path,
    out: Path | None = None,
    manual_mask_path: Path | None = None,
    shadow_azimuth_deg: float = clean_ortho_mod.DEFAULT_SHADOW_AZIMUTH_DEG,
    shadow_length_m: float = clean_ortho_mod.DEFAULT_SHADOW_LENGTH_M,
    corridor_types: tuple[str, ...] = clean_ortho_mod.DEFAULT_CORRIDOR_TYPES,
    margin_m: float = clean_ortho_mod.DEFAULT_MARGIN_M,
    crop_size: int = 512,
    overlap: int = 64,
    weights: str | None = None,
    device: str | None = None,
    mask_out: Path | None = None,
    inpaint_fn=None,
) -> Path:
    """Batch orthophoto cleaning for game-engine texture export: LaMa-inpaints
    tree canopy + cast shadows (and any manual-mask extras) out of the playable
    corridor, writing a cleaned GeoTIFF ALONGSIDE the source (never overwrites;
    default `<stem>.clean.tif`).

    Mask = ((canopy ∪ shadow) ∩ corridor) ∪ manual, dilated margin_m — see
    golfpipe.clean_ortho. Inpainting runs as overlapping crops with a feathered
    stitch (golfpipe.inpaint), so memory stays bounded for arbitrary-size
    orthos. `inpaint_fn` is injectable for tests; by default a LamaInpainter
    is constructed lazily, and only if the mask is non-empty — torch/weights
    are never touched for an empty mask.

    The cleaned GeoTIFF keeps the source CRS/transform/compression, so
    tile-ortho can be pointed at it directly.
    """
    from golfpipe.inpaint import LamaInpainter, inpaint_tiled

    out = out or default_clean_out_path(ortho_path)
    if out.resolve() == ortho_path.resolve():
        raise clean_ortho_mod.CleanOrthoError(
            f"refusing to overwrite the source ortho ({ortho_path}) — pass a different --out"
        )

    canopy = clean_ortho_mod.select_polygons(
        clean_ortho_mod.load_typed_polygons(trees_path), ("trees",), include_untyped=True,
    )
    corridor = clean_ortho_mod.select_polygons(
        clean_ortho_mod.load_typed_polygons(features_path), corridor_types,
    )
    if not corridor:
        raise clean_ortho_mod.CleanOrthoError(
            f"no corridor features of type {', '.join(corridor_types)} in {features_path} "
            "— check --corridor-types against the file's properties.type values"
        )
    manual = []
    if manual_mask_path is not None:
        manual = [geom for _, geom in clean_ortho_mod.load_typed_polygons(manual_mask_path)]
    print(f"Canopy polygons: {len(canopy)}, corridor polygons: {len(corridor)}, manual: {len(manual)}")

    mask_geom = clean_ortho_mod.build_mask_geometry(
        canopy, corridor, manual,
        shadow_azimuth_deg=shadow_azimuth_deg,
        shadow_length_m=shadow_length_m,
        margin_m=margin_m,
    )

    with rasterio.open(ortho_path) as src:
        if src.count < 3:
            raise clean_ortho_mod.CleanOrthoError(
                f"{ortho_path} has {src.count} band(s); clean-ortho needs an RGB ortho"
            )
        profile = src.profile.copy()
        image = np.moveaxis(src.read([1, 2, 3]), 0, -1)
        mask = clean_ortho_mod.rasterize_mask(mask_geom, src.transform, (src.height, src.width))
        pixel_area = abs(src.transform.a * src.transform.e)

    masked_px = int(np.count_nonzero(mask))
    print(f"Mask: {masked_px:,} px (~{masked_px * pixel_area:,.0f} m², "
          f"shadow azimuth {shadow_azimuth_deg}°, length {shadow_length_m} m, margin {margin_m} m)")

    if mask_out is not None:
        mask_profile = profile.copy()
        mask_profile.update(count=1, dtype="uint8", nodata=None)
        with rasterio.open(mask_out, "w", **mask_profile) as dst:
            dst.write((mask * 255).astype(np.uint8), 1)
        print(f"Wrote mask {mask_out}")

    if masked_px == 0:
        print("(mask is empty — writing an unmodified copy; nothing to inpaint)")
        cleaned = image
    else:
        fn = inpaint_fn or LamaInpainter(weights=weights, device=device)

        def progress(done: int, total: int) -> None:
            print(f"  inpainted crop {done}/{total}", end="\r" if done < total else "\n", flush=True)

        cleaned = inpaint_tiled(
            image, mask, fn, crop_size=crop_size, overlap=overlap, progress=progress,
        )

    profile.update(count=3, dtype="uint8")
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(np.moveaxis(cleaned, -1, 0))
    print(f"Wrote {out}")
    return out


def _ortho_webp_encoder(nodata, webp_quality: int):
    """Tile encoder shared by cmd_tile_ortho and cmd_apply_ortho_patches:
    RGB (grayscale replicated) -> WebP bytes; fully-nodata tiles -> None."""

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

    return encode


def cmd_tile_ortho(input_path: Path, out_dir: Path, minzoom: int = DEFAULT_ORTHO_MINZOOM, maxzoom: int = DEFAULT_ORTHO_MAXZOOM, webp_quality: int = 80) -> int:
    """Reprojects input_path to EPSG:3857 (WarpedVRT), cuts 256px XYZ tiles,
    saves WebP at {out_dir}/{z}/{x}/{y}.webp. Skips fully-nodata tiles.
    """
    bbox_wgs84 = raster_bounds_wgs84(input_path)
    pyramid_bounds = pyramid_bounds_3857(bbox_wgs84, minzoom, maxzoom)
    vrt = open_warped_to_mercator(input_path, Resampling.bilinear, extra_bounds_3857=pyramid_bounds)
    try:
        encode = _ortho_webp_encoder(vrt.nodata, webp_quality)
        count = generate_tile_pyramid(vrt, bbox_wgs84, minzoom, maxzoom, out_dir, encode, "webp")
    finally:
        vrt.close()

    print(f"Wrote {count} ortho tiles to {out_dir}")
    return count


def default_patched_out_path(ortho_path: Path) -> Path:
    """ortho-orto-l2-2025.tif -> ortho-orto-l2-2025.patched.tif, alongside
    the source (the pristine source is never overwritten)."""
    return ortho_path.with_name(ortho_path.stem + ".patched" + ortho_path.suffix)


def _lama_inpaint_fn(weights: str | None, device: str | None):
    """Lazy LaMa runner for the patch-bake commands (separate function so
    tests can monkeypatch it and stay torch-free)."""
    from golfpipe.inpaint import LamaInpainter

    return LamaInpainter(weights=weights, device=device)


def _derive_parent_tile(tile, tiles_out: Path, webp_quality: int,
                        fallback_tiles: Path | None = None) -> bytes | None:
    """Composes one parent tile from its four child tiles ON DISK (2x2 of
    256 px -> box-downsampled 256 px). Children are current by construction:
    the affected ones were just rewritten one zoom deeper, the rest are
    untouched build output. When `fallback_tiles` is given (the sim-overlay
    case: `tiles_out` is a sparse copy-on-write tree holding only
    patch-affected tiles), a child missing from `tiles_out` is read from the
    pristine fallback tree instead. Missing children everywhere
    (nodata-skipped / outside coverage) stay black — the same content a
    raster render gives there. Returns None when no child exists at all
    (fully-nodata parent)."""
    from io import BytesIO

    canvas = Image.new("RGB", (512, 512))
    found = False
    for dx in (0, 1):
        for dy in (0, 1):
            rel = Path(str(tile.z + 1)) / str(2 * tile.x + dx) / f"{2 * tile.y + dy}.webp"
            child = tiles_out / rel
            if not child.is_file() and fallback_tiles is not None:
                child = fallback_tiles / rel
            if child.is_file():
                with Image.open(child) as img:
                    canvas.paste(img.convert("RGB"), (dx * 256, dy * 256))
                found = True
    if not found:
        return None
    buf = BytesIO()
    canvas.resize((256, 256), Image.Resampling.BOX).save(buf, format="WEBP", quality=webp_quality)
    return buf.getvalue()


def _retile_affected(
    patched_path: Path,
    bounds_list: list[tuple[float, float, float, float]],
    tiles_out: Path,
    minzoom: int,
    maxzoom: int,
    webp_quality: int,
    pristine_tiles: Path | None = None,
) -> int:
    """Rewrites only the tile-pyramid subtree intersecting `bounds_list`, in
    place inside `tiles_out`.

    With `pristine_tiles` (the dual-photo-state model), `tiles_out` is the
    sparse SIM overlay (`ortho-sim/`, only patch-affected tiles) and the
    pristine flat tree is READ-ONLY: lower-zoom parents derive from sim
    children where they exist and pristine children otherwise, so a sim
    parent composites correctly even when only one of its four children was
    affected. Without it (legacy single-tree mode), `tiles_out` is the
    installed tree itself.

    Only the DEEPEST zoom is rendered from the patched raster (native-
    resolution windows — cheap). Every lower zoom is derived by
    downsampling the zoom below it from the tile tree: without raster
    overviews, rendering a z14 tile from the source would decode nearly the
    whole ortho (seconds per accept), which is exactly the cost this
    incremental path exists to avoid.
    """
    tiles = patches_mod.affected_tiles(bounds_list, minzoom, maxzoom)
    deepest = [t for t in tiles if t.z == maxzoom]
    written = 0
    if deepest:
        xy = [mercantile.xy_bounds(t) for t in deepest]
        subtree_bounds = (
            min(b.left for b in xy), min(b.bottom for b in xy),
            max(b.right for b in xy), max(b.top for b in xy),
        )
        vrt = open_warped_to_mercator(patched_path, Resampling.bilinear, extra_bounds_3857=subtree_bounds)
        try:
            encode = _ortho_webp_encoder(vrt.nodata, webp_quality)
            written = generate_tiles(vrt, deepest, tiles_out, encode, "webp")
        finally:
            vrt.close()

    for z in range(maxzoom - 1, minzoom - 1, -1):
        for tile in tiles:
            if tile.z != z:
                continue
            encoded = _derive_parent_tile(tile, tiles_out, webp_quality, fallback_tiles=pristine_tiles)
            if encoded is None:
                continue
            tile_path = tiles_out / str(tile.z) / str(tile.x) / f"{tile.y}.webp"
            tile_path.parent.mkdir(parents=True, exist_ok=True)
            tile_path.write_bytes(encoded)
            written += 1

    print(f"Retiled {written}/{len(tiles)} affected tiles (z{minzoom}-z{maxzoom}) into {tiles_out}")
    return written


def cmd_apply_ortho_patches(
    ortho_path: Path,
    patches_dir: Path,
    out: Path | None = None,
    tiles_out: Path | None = None,
    minzoom: int = DEFAULT_ORTHO_MINZOOM,
    maxzoom: int = DEFAULT_ORTHO_MAXZOOM,
    extra_bounds_3857: list[tuple[float, float, float, float]] | None = None,
    webp_quality: int = 80,
    weights: str | None = None,
    device: str | None = None,
    inpaint_fn=None,
    pristine_tiles: Path | None = None,
) -> Path:
    """FULL replay: re-inpaints ALL logged masks (patches_dir/patches.json —
    see golfpipe.patches) onto a fresh copy of the PRISTINE source ortho
    (the working `.patched.tif`), then rewrites only the tile-pyramid
    subtree the mask bounds touch (skipped without --tiles-out). Used for
    revert and for rebuilding after vintage changes; the per-accept path is
    the incremental `bake-ortho-patch`.

    Fills are regenerated by LaMa, so a replay is visually equivalent — not
    byte-identical — to the bakes it replaces (see golfpipe.patches).
    An empty log needs no torch at all.

    The retiled subtree covers every logged patch (idempotent — re-running
    always converges the tile tree onto the current log) plus any
    `extra_bounds_3857`, which the server passes for a just-REVERTED patch:
    its bounds leave the log, but its tiles must still be rewritten from the
    reverted raster.
    """
    entries = patches_mod.load_patch_log(patches_dir)
    out = out or default_patched_out_path(ortho_path)
    if patches_mod.needs_inpaint(entries) and inpaint_fn is None:
        inpaint_fn = _lama_inpaint_fn(weights, device)
    patches_mod.apply_patches_to_ortho(ortho_path, patches_dir, entries, out, inpaint_fn=inpaint_fn)
    print(f"Replayed {len(entries)} patch(es) from {patches_dir} -> {out}")

    bounds_list = [e.bounds3857 for e in entries] + list(extra_bounds_3857 or [])
    if tiles_out is None or not bounds_list:
        print("(no retile: " + ("no --tiles-out given" if tiles_out is None else "no affected bounds") + ")")
        return out
    _retile_affected(out, bounds_list, tiles_out, minzoom, maxzoom, webp_quality,
                     pristine_tiles=pristine_tiles)
    return out


def cmd_bake_ortho_patch(
    ortho_path: Path,
    patches_dir: Path,
    seqs: list[int] | None = None,
    out: Path | None = None,
    tiles_out: Path | None = None,
    minzoom: int = DEFAULT_ORTHO_MINZOOM,
    maxzoom: int = DEFAULT_ORTHO_MAXZOOM,
    webp_quality: int = 80,
    weights: str | None = None,
    device: str | None = None,
    inpaint_fn=None,
    pristine_tiles: Path | None = None,
) -> Path:
    """INCREMENTAL accept: bakes the just-appended log entries (`--seq`,
    repeatable; default the last entry) in seq order into the EXISTING
    working `.patched.tif` — windowed LaMa inpaints for mask entries,
    torch-free brush-engine renders for stamp strokes — then rewrites the
    tile-pyramid subtree of the UNION of their bounds in ONE retile pass.
    No full-raster rewrite per accept; a batch of N edits pays for one
    process start, one raster open, and one retile.

    LaMa is only constructed when a mask entry is actually being baked (or
    replayed): a stamp-only accept works without torch or weights.

    The working file is created lazily: when it is missing, or older than
    the pristine source (a rebuild replaced the vintage underneath it), the
    command falls back to a FULL replay of the whole log so the raster
    always converges onto pristine + every logged edit.
    """
    entries = patches_mod.load_patch_log(patches_dir)
    if not entries:
        raise patches_mod.PatchError(f"nothing to bake: {patches_dir} has no logged patches")
    if not seqs:
        selected = [entries[-1]]
    else:
        by_seq = {e.seq: e for e in entries}
        missing = [s for s in seqs if s not in by_seq]
        if missing:
            raise patches_mod.PatchError(
                f"no logged patch with seq {missing[0]} in {patches_dir}")
        selected = sorted((by_seq[s] for s in set(seqs)), key=lambda e: e.seq)
    out = out or default_patched_out_path(ortho_path)

    stale = not out.exists() or out.stat().st_mtime < ortho_path.stat().st_mtime
    if inpaint_fn is None and patches_mod.needs_inpaint(entries if stale else selected):
        inpaint_fn = _lama_inpaint_fn(weights, device)
    if stale:
        patches_mod.apply_patches_to_ortho(ortho_path, patches_dir, entries, out, inpaint_fn=inpaint_fn)
        bounds_list = [e.bounds3857 for e in entries]
        print(f"Working raster was missing/stale — fully replayed {len(entries)} patch(es) -> {out}")
    else:
        baked = 0
        with rasterio.open(out, "r+") as dst:
            for entry in selected:
                if patches_mod.bake_entry_into(dst, patches_dir, entry, inpaint_fn):
                    baked += 1
        bounds_list = [e.bounds3857 for e in selected]
        print(f"Baked {baked}/{len(selected)} patch entr(y/ies) "
              f"(seq {', '.join(str(e.seq) for e in selected)}) into {out}")

    if tiles_out is None:
        print("(no retile: no --tiles-out given)")
        return out
    _retile_affected(out, bounds_list, tiles_out, minzoom, maxzoom, webp_quality,
                     pristine_tiles=pristine_tiles)
    return out


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
