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

from golfpipe import buildings as buildings_mod
from golfpipe import canopy as canopy_mod
from golfpipe import clean_ortho as clean_ortho_mod
from golfpipe import dem_analysis as dem_analysis_mod
from golfpipe import dem_edit as dem_edit_mod
from golfpipe import detect_common
from golfpipe import detect_trees as detect_trees_mod
from golfpipe import detect_water as detect_water_mod
from golfpipe import grid_dem as grid_dem_mod
from golfpipe import hydro as hydro_mod
from golfpipe import nvdb as nvdb_mod
from golfpipe import osm as osm_mod
from golfpipe import patches as patches_mod
from golfpipe import roads as roads_mod
from golfpipe import stac
from golfpipe import trees_features as trees_features_mod
from golfpipe import lowveg_features as lowveg_features_mod
from golfpipe import woodland_features as woodland_features_mod
from golfpipe import woodland_floor as woodland_floor_mod
from golfpipe import sources as sources_mod
from golfpipe import water as water_mod
from golfpipe.hillshade import write_hillshade_geotiff
from golfpipe.manifest import build_manifest, merge_into_existing, write_manifest
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


def cmd_fetch_dem(bbox: tuple[float, float, float, float], workdir: Path, out: Path, buffer_m: float = DEFAULT_FETCH_BUFFER_M,
                  items: list[str] | None = None) -> Path:
    """STAC-searches dtm-cog for bbox, downloads matching COG(s) with basic
    auth into workdir, mosaics/crops to bbox+buffer, writes out (kept in the
    source CRS — EPSG:3006/RH2000 — since terrain-RGB tiling reprojects at
    tile time anyway).

    `items` pins STAC item ids (from a sources.json recipe) instead of
    searching. Every fetch records what it downloaded in the recipe next to
    `out` (golfpipe.sources).
    """
    items = stac.search_dem(bbox, ids=items)
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
    sources_mod.record_fetch(sources_mod.recipe_path_for(out), "dem", collection=stac.DEM_COLLECTION,
                             items=[it.id for it in items], bbox_wgs84=bbox, files=[out.name], buffer_m=buffer_m)
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


def cmd_fetch_ortho(bbox: tuple[float, float, float, float], workdir: Path, out: Path, buffer_m: float = DEFAULT_FETCH_BUFFER_M, collection: str | None = None,
                    items: list[str] | None = None) -> Path:
    """STAC-searches stac-bild across all collections for bbox (newest
    coverage first, see golfpipe.stac.search_ortho), downloads the item(s)
    with basic auth, mosaics/crops to bbox+buffer.

    Without `collection`, uses the newest vintage covering the bbox. Pass
    `collection` (e.g. from list-ortho-vintages) to fetch a specific vintage.

    Ortho items are RGBI (4-band); only the first 3 bands (RGB) are kept
    since tile-ortho produces opaque WebP (no alpha/NIR).

    `items` pins STAC item ids (from a sources.json recipe) instead of
    searching; the fetch is recorded in the recipe next to `out`.
    """
    items = stac.search_ortho(bbox, ids=items)
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
    sources_mod.record_fetch(sources_mod.recipe_path_for(out), "ortho", collection=target_collection,
                             items=[it.id for it in selected], bbox_wgs84=bbox, files=[out.name], buffer_m=buffer_m)
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


def cmd_fetch_lidar(bbox: tuple[float, float, float, float], workdir: Path, out_dir: Path, items: list[str] | None = None,
                    skip_forbidden: bool = False) -> list[Path]:
    """STAC-searches dsm-skoglig-copc (classified lidar point clouds) for
    bbox, downloads each matching .copc.laz asset with basic auth into
    out_dir. Unlike fetch-dem/fetch-ortho, this does not mosaic/crop —
    grid-dem reads the raw COPC files directly (laspy chunked reads,
    filtered to the target bbox at grid time), since these files are much
    larger (hundreds of MB to ~1 GB) and point-cloud mosaicking isn't a
    rasterio operation anyway.

    Files already present in out_dir with a size matching the remote
    Content-Length are skipped (safe to re-run after a partial fetch).

    `items` pins STAC item ids (from a sources.json recipe) instead of
    searching; the fetch is recorded in `out_dir/../sources.json`.

    Lantmäteriet withholds some tiles (HTTP 403 although the STAC index
    lists them — restricted areas). `skip_forbidden` warns and carries on
    without those, for background scenery where a flat patch beats no DEM;
    the default aborts, as a course's own terrain must be complete.
    """
    import requests

    items = stac.search_lidar(bbox, ids=items)
    if not items:
        print(f"No dsm-skoglig-copc items found for bbox {bbox}", file=sys.stderr)
        raise SystemExit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    downloaded = []
    fetched_items = []
    for item in items:
        href = item.data_href
        filename = href.rsplit("/", 1)[-1]
        dest = out_dir / filename
        print(f"Fetching lidar item {item.id} -> {dest}")
        try:
            stac.download_asset_with_progress(href, dest)
        except requests.HTTPError as exc:
            status = getattr(exc.response, "status_code", None)
            if skip_forbidden and status == 403:
                print(f"warning: lidar item {item.id} is withheld by Lantmäteriet (HTTP 403); skipped — "
                      f"that area will have no points", file=sys.stderr)
                continue
            raise
        downloaded.append(dest)
        fetched_items.append(item)
    if not downloaded:
        print("error: every lidar item for the bbox was withheld (HTTP 403)", file=sys.stderr)
        raise SystemExit(1)

    sources_mod.record_fetch(sources_mod.recipe_path_for(out_dir), "lidar", collection=stac.LIDAR_COLLECTION,
                             items=[it.id for it in fetched_items], bbox_wgs84=bbox, files=[p.name for p in downloaded])
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
    overpass_json = osm_mod.with_retries(fetch)(query, url=overpass_url)

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


def cmd_fetch_roads(
    bbox: tuple[float, float, float, float],
    out: Path,
    overpass_fetch=None,
    overpass_url: str = osm_mod.OVERPASS_URL,
    class_widths: dict[str, float] | None = None,
    clip: bool = True,
    simplify_m: float = roads_mod.DEFAULT_SIMPLIFY_M,
    min_area_m2: float = roads_mod.DEFAULT_MIN_AREA_M2,
    centerlines_out: Path | None = None,
    merge: bool = False,
    near_path: Path | None = None,
    near_m: float = roads_mod.DEFAULT_NEAR_M,
    nvdb_key: str | None = None,
    nvdb_fetch=None,
    square_3006: tuple[float, float, float, float] | None = None,
) -> Path:
    """Queries Overpass for OSM highway centerlines in bbox (WGS84), buffers
    each to its road width (width tag > lanes > class table, see
    golfpipe/roads.py), clips them to the bbox and writes one EPSG:3006
    GeoJSON FeatureCollection of `path` features to `out`, importable by the
    web GeoJSON draft-import wizard (bucket on `road_class` to pick roads /
    tracks / footpaths apart). `class_widths` overrides the per-class
    default widths (`{"service": 4.0}`). `centerlines_out` also writes the
    clipped centerlines with their widths — the input for `road-grades`.
    One polygon per OSM way unless `merge` (see roads.merge_corridors).
    `square_3006` (x0, y0, x1, y1 EPSG:3006 metres, the terrain square bbox
    is the envelope of) clips to the exact square instead of to the bbox.

    `near_path` (a GeoJSON of the course's features) narrows the area to
    within `near_m` of them (roads.near_area_3006) — roads beyond that are
    scenery. `nvdb_key` (Trafikverket open data API key) fuses NVDB in:
    measured widths, paved/unpaved, and the roads OSM lacks (golfpipe/nvdb.py).
    Without a key, or when the NVDB call fails, the result is OSM only.

    LICENSING: OSM is ODbL — each polygon carries the ids of the ways merged
    into it and the collection a top-level `attribution` (see cmd_fetch_osm).
    NVDB is CC0; NVDB-only roads say so per feature.
    """
    from datetime import date

    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    src = CRS.from_epsg(4326)
    dst = CRS.from_epsg(osm_mod.SWEREF99_TM_SRID)

    def reproject(lons, lats):
        return warp_transform(src, dst, list(lons), list(lats))

    area = roads_mod.bbox_polygon_3006(bbox, reproject)
    if square_3006 is not None:
        area = area.intersection(roads_mod.square_polygon_3006(square_3006))
    if near_path is not None:
        import json

        near = roads_mod.near_area_3006(json.loads(Path(near_path).read_text(encoding="utf-8")), reproject, near_m)
        if near is None:
            print(f"No course features in {near_path} — keeping the whole area")
        else:
            area = area.intersection(near)
            e0, n0, e1, n1 = area.bounds
            lons, lats = warp_transform(dst, src, [e0, e1, e0, e1], [n0, n0, n1, n1])
            bbox = (max(bbox[0], min(lons)), max(bbox[1], min(lats)), min(bbox[2], max(lons)), min(bbox[3], max(lats)))
            print(f"Limited to {near_m:g} m around the course features: {area.area / 1e6:.2f} km²")

    fetch = overpass_fetch or osm_mod.fetch_overpass
    query = roads_mod.build_roads_query(bbox)
    print(f"Querying Overpass for highway ways in bbox {bbox} ...")
    overpass_json = osm_mod.with_retries(fetch)(query, url=overpass_url)

    ways, skipped = roads_mod.assemble_roads(overpass_json, reproject, class_widths)
    print(f"OSM road ways: {len(ways)}")

    clip_geom = area if clip else None
    attribution = roads_mod.ATTRIBUTION
    if nvdb_key or nvdb_fetch is not None:
        fetch_nvdb = nvdb_fetch or nvdb_mod.fetch_nvdb
        try:
            e0, n0, e1, n1 = area.bounds
            rows = fetch_nvdb(nvdb_key, (e0, n0, e1, n1))
        except nvdb_mod.NvdbError as exc:
            print(f"NVDB unavailable, OSM only: {exc}")
        else:
            network = nvdb_mod.build_network(rows, today=date.today().isoformat())
            if network.truncated:
                print(f"NVDB: row limit hit for {', '.join(network.truncated)} — the area is too large, results are partial")
            ways, fused = nvdb_mod.fuse(ways, network, clip=area)
            attribution = f"{roads_mod.ATTRIBUTION}; {nvdb_mod.ATTRIBUTION}"
            print(f"NVDB links: {len(network.links)} — along OSM ways: {fused.matched} "
                  f"(measured width {fused.measured_width}, road-type width {fused.kind_width}, surface {fused.surface}); "
                  f"added {fused.added} road(s) OSM lacks, {fused.added_m / 1000:.2f} km")
    else:
        print(f"NVDB skipped (no {nvdb_mod.API_KEY_ENV}) — widths from OSM tags and the class table")

    ways, absorbed = roads_mod.absorb_parking_aisles(ways)
    lots = sum(1 for w in ways if w.group == roads_mod.PARKING_GROUP)
    if lots:
        print(f"Parking lots: {lots} (absorbed {absorbed} aisle(s) inside them)")

    sources: dict[str, int] = {}
    for way in ways:
        if way.group != roads_mod.PARKING_GROUP:
            sources[way.width_source] = sources.get(way.width_source, 0) + 1
    print(f"Road widths: " + (", ".join(f"{k}: {n}" for k, n in sorted(sources.items())) or "none"))

    polygons = roads_mod.merge_corridors(ways, clip=clip_geom, simplify_m=simplify_m, min_area_m2=min_area_m2, merge=merge)
    collection = roads_mod.build_roads_geojson(polygons, fetch_date=date.today().isoformat(), attribution=attribution)
    water_mod.write_geojson(collection, out)
    if centerlines_out is not None:
        lines = roads_mod.build_centerlines_geojson(ways, fetch_date=date.today().isoformat(), clip=clip_geom, attribution=attribution)
        water_mod.write_geojson(lines, centerlines_out)
        center = [f for f in lines["features"] if f["geometry"]["type"] == "LineString"]
        n_lots = len(lines["features"]) - len(center)
        print(f"Centerlines: {len(center)}, {sum(f['properties']['lengthM'] for f in center) / 1000:.1f} km"
              + (f" + {n_lots} parking lot(s)" if n_lots else "") + f" — wrote {centerlines_out}")

    groups: dict[str, int] = {}
    for rp in polygons:
        groups[rp.group] = groups.get(rp.group, 0) + 1
    total_area = sum(rp.polygon.area for rp in polygons)
    print(f"Road polygons: {len(polygons)} (" + (", ".join(f"{g}={n}" for g, n in sorted(groups.items())) or "none")
          + f"), {total_area:,.0f} m² of surface" + ("" if clip else " (unclipped)"))
    if skipped:
        print(f"Skipped {len(skipped)} way(s):")
        for note in skipped[:10]:
            print(f"  - {note}")
        if len(skipped) > 10:
            print(f"  … and {len(skipped) - 10} more")
    if not polygons:
        print("(no highway ways found in bbox)")
    print(f"Wrote {out}")
    return out


def cmd_road_grades(
    centerlines_path: Path,
    out: Path,
    feather_m: float = roads_mod.DEFAULT_GRADE_FEATHER_M,
    smooth_m: float = roads_mod.DEFAULT_GRADE_SMOOTH_M,
    classes: set[str] | None = None,
) -> Path:
    """Turns fetch-roads centerlines into the road grading: one `corridor`
    terrain edit per centerline, one tilted `plane` per parking lot (replayed
    before the corridors, see roads.lot_grade_features) — smooth along the road over `smooth_m`,
    flat across its width, feathered `feather_m` beyond the pavement (see
    golfpipe/dem_edit.py). `classes` keeps only those road_class groups
    (road / track / path). Written as the D-TE5 edits handoff like
    `building-pads`, for `apply-dem-edits --edits` or the server's
    `import-terrain-edits` (origin `road-grades`).
    """
    from datetime import datetime, timezone

    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    lines = roads_mod.read_centerlines(centerlines_path)
    lots = roads_mod.read_parking_lots(centerlines_path)
    if classes:
        lines = [c for c in lines if c.group in classes]
        lots = lots if roads_mod.PARKING_GROUP in classes else []
    src = CRS.from_epsg(osm_mod.SWEREF99_TM_SRID)
    dst = CRS.from_epsg(4326)

    def to_wgs84(xs, ys):
        return warp_transform(src, dst, list(xs), list(ys))

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Lots first: the corridors then grade each road over them (see roads.lot_grade_features).
    features = roads_mod.lot_grade_features(lots, to_wgs84, created_at=stamp)
    features += roads_mod.grade_edit_features(lines, to_wgs84, feather_m=feather_m, smooth_m=smooth_m, created_at=stamp,
                                              first_index=len(features))
    water_mod.write_geojson({"type": "FeatureCollection", "attribution": roads_mod.ATTRIBUTION, "features": features}, out)
    groups: dict[str, int] = {}
    for c in lines:
        groups[c.group] = groups.get(c.group, 0) + 1
    print(f"Road grades: {len(lines)} corridor edits (" + (", ".join(f"{g}={n}" for g, n in sorted(groups.items())) or "none")
          + f"), {sum(c.line.length for c in lines) / 1000:.1f} km, smooth {smooth_m:g} m along, feather {feather_m:g} m"
          + (f"; {len(lots)} parking lot plane(s), {sum(l.polygon.area for l in lots):,.0f} m²" if lots else ""))
    print(f"Wrote {out}")
    return out


def cmd_fetch_buildings(
    bbox: tuple[float, float, float, float],
    out: Path,
    lidar_paths: list[Path] | None = None,
    overpass_fetch=None,
    overpass_url: str = osm_mod.OVERPASS_URL,
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
) -> Path:
    """Queries Overpass for OSM building footprints in bbox (WGS84),
    reprojects them to EPSG:3006, fits each its minimum rotated rectangle
    (length / width / bearing — what the Unity building planter matches a
    prefab on) and, when `lidar_paths` are given, measures eave and ridge
    heights from the same nDSM detect-trees builds (max-return surface minus
    ground, gridded at `resolution` m). Writes the building survey as one
    EPSG:3006 GeoJSON FeatureCollection (`properties.type` "building"; see
    golfpipe/buildings.py) — the input for `gspro.py buildings` and
    `building-pads`, not for the web import wizard.

    LICENSING: OSM is ODbL — per-feature provenance + collection
    `attribution`, as for cmd_fetch_osm.
    """
    from datetime import date

    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    fetch = overpass_fetch or osm_mod.fetch_overpass
    query = buildings_mod.build_buildings_query(bbox)
    print(f"Querying Overpass for buildings in bbox {bbox} ...")
    overpass_json = osm_mod.with_retries(fetch)(query, url=overpass_url)

    src = CRS.from_epsg(4326)
    dst = CRS.from_epsg(osm_mod.SWEREF99_TM_SRID)

    def reproject(lons, lats):
        return warp_transform(src, dst, list(lons), list(lats))

    buildings, skipped = buildings_mod.assemble_buildings(overpass_json, reproject)
    kinds: dict[str, int] = {}
    for b in buildings:
        kinds[b.kind] = kinds.get(b.kind, 0) + 1
    top = ", ".join(f"{k}={n}" for k, n in sorted(kinds.items(), key=lambda kv: (-kv[1], kv[0]))[:6])
    print(f"Buildings: {len(buildings)}" + (f" ({top}{', …' if len(kinds) > 6 else ''})" if kinds else ""))

    measured = 0
    if lidar_paths and buildings:
        # Grid the union of the footprints, not the bbox: whole footprints
        # crossing the area edge must be measurable too.
        e0, n0, e1, n1 = roads_mod.bbox_polygon_3006(bbox, reproject).bounds
        for b in buildings:
            be0, bn0, be1, bn1 = b.polygon.bounds
            e0, n0, e1, n1 = min(e0, be0), min(n0, bn0), max(e1, be1), max(n1, bn1)
        pad = 2 * resolution
        bbox_3006 = (e0 - pad, n0 - pad, e1 + pad, n1 + pad)
        print("Gridding ground returns (mean z) ...")
        ground_sum, ground_count, transform, _ = grid_dem_mod.grid_lidar_points(
            lidar_paths, bbox_3006, resolution=resolution, classes=grid_dem_mod.DEFAULT_CLASSES,
        )
        ground_dem = grid_dem_mod.build_dem_grid(ground_sum, ground_count)
        print(f"Gridding surface returns (max z, all classes except noise {detect_trees_mod.NOISE_CLASSES}) ...")
        surface_max, surface_count, _, _ = grid_dem_mod.grid_lidar_points(
            lidar_paths, bbox_3006, resolution=resolution,
            classes=None, aggregate="max", exclude_classes=detect_trees_mod.NOISE_CLASSES,
        )
        ndsm = detect_trees_mod.build_ndsm(ground_dem, surface_max, surface_count)
        measured = buildings_mod.measure_roofs(buildings, ndsm, transform)
        eaves = sorted(b.roof.eave_m for b in buildings if b.roof)
        ridges = sorted(b.roof.ridge_m for b in buildings if b.roof)
        if eaves:
            print(f"Roofs measured: {measured} of {len(buildings)} (median eave {eaves[len(eaves) // 2]:.1f} m, "
                  f"median ridge {ridges[len(ridges) // 2]:.1f} m); "
                  f"{len(buildings) - measured} too small for {resolution:g} m cells or no roof return")
        else:
            print(f"Roofs measured: 0 of {len(buildings)}")
    elif buildings:
        print("No --lidar: heights from OSM tags only "
              f"({sum(1 for b in buildings if buildings_mod.fallback_height_m(b) is not None)} have height or levels)")

    collection = buildings_mod.build_buildings_geojson(buildings, fetch_date=date.today().isoformat())
    water_mod.write_geojson(collection, out)
    if skipped:
        print(f"Skipped {len(skipped)} element(s):")
        for note in skipped[:10]:
            print(f"  - {note}")
        if len(skipped) > 10:
            print(f"  … and {len(skipped) - 10} more")
    if not buildings:
        print("(no buildings found in bbox)")
    print(f"Wrote {out}")
    return out


def cmd_building_pads(
    survey_path: Path,
    out: Path,
    buffer_m: float = buildings_mod.DEFAULT_PAD_BUFFER_M,
    feather_m: float = buildings_mod.DEFAULT_PAD_FEATHER_M,
    flat: bool = True,
    square_3006: tuple[float, float, float, float] | None = None,
) -> Path:
    """Turns a fetch-buildings survey into the flat pads under its buildings:
    one `plane` terrain edit per footprint (dead-flat unless `flat` is off,
    then a fitted slope), over the footprint plus `buffer_m` of apron, with
    a `feather_m` blend band outside that (see buildings.pad_polygon for why
    the polygon is grown by both). Written as the D-TE5 edits handoff
    (WGS84 FeatureCollection) so it can go straight to `apply-dem-edits
    --edits` next to the site's own edits, or into the server's terrain_edits
    via `bun run import-terrain-edits` (origin `building-pads`, replacing
    the previous generation and nothing else). With `square_3006` only the
    buildings whose footprint centre lies inside that square get a pad: the
    inner terrain's. The outer plot is scenery, and a pad there only cuts
    and fills ground nobody plays on (the survey still covers it for the
    outer buildings export).
    """
    from datetime import datetime, timezone

    from rasterio.crs import CRS
    from rasterio.warp import transform as warp_transform

    survey = buildings_mod.read_survey(survey_path)
    outside = 0
    if square_3006 is not None:
        x0, y0, x1, y1 = square_3006
        kept = [b for b in survey if x0 <= b.polygon.centroid.x <= x1 and y0 <= b.polygon.centroid.y <= y1]
        outside = len(survey) - len(kept)
        survey = kept
    src = CRS.from_epsg(osm_mod.SWEREF99_TM_SRID)
    dst = CRS.from_epsg(4326)

    def to_wgs84(xs, ys):
        return warp_transform(src, dst, list(xs), list(ys))

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    features = buildings_mod.pad_edit_features(
        survey, to_wgs84, buffer_m=buffer_m, feather_m=feather_m, flat=flat, created_at=stamp,
    )
    water_mod.write_geojson(buildings_mod.build_pads_geojson(features), out)
    total = sum(b.polygon.area for b in survey)
    print(f"Building pads: {len(features)} plane edits ({'flat' if flat else 'fitted slope'}, "
          f"apron {buffer_m:g} m, feather {feather_m:g} m) over {total:,.0f} m² of footprint"
          + (f"; {outside} building(s) outside the square left without a pad" if square_3006 is not None else ""))
    print(f"Wrote {out}")
    return out


def cmd_fetch_hydro(
    bbox: tuple[float, float, float, float],
    out: Path,
    creek_width_m: float = water_mod.DEFAULT_CREEK_WIDTH_M,
    session=None,
    square_3006: tuple[float, float, float, float] | None = None,
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

    `square_3006` (x0, y0, x1, y1 EPSG:3006 metres, the terrain square bbox
    is the envelope of) clips to the exact square instead of the bbox's grid
    envelope, which reaches past it; creek centerlines stop half a ribbon
    inside it so the buffered ribbons do too.
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

    bbox_3006 = square_3006 or cmd_reproject_bbox(bbox)
    polygons = hydro_mod.clip_geometries(surface_geoms, bbox_3006, "polygon")
    if square_3006 is not None:
        half = creek_width_m / 2.0
        x0, y0, x1, y1 = square_3006
        lines = hydro_mod.clip_geometries(line_geoms, (x0 + half, y0 + half, x1 - half, y1 - half), "line")
    else:
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


def cmd_dem_analysis(
    input_path: Path,
    greens_path: Path,
    out_path: Path,
    buffer_m: float = dem_analysis_mod.DEFAULT_GREEN_BUFFER_M,
    coarse_factor: int = dem_analysis_mod.DEFAULT_COARSE_FACTOR,
) -> Path:
    """Builds the publishable analysis DEM (deploy-split §6, option b): full
    0.5 m detail within `buffer_m` of every green polygon, a `coarse_factor`
    block-mean (1 m) background everywhere else, written as ONE deflate
    GeoTIFF on the input's grid.

    `input_path` MUST be the DEM the builder itself analyses — that is
    `sources/<siteId>/dem-edited.tif` when the site has terrain edits, else
    `dem.tif`. The publish CLI picks it; passing the raw DEM for an edited
    site would publish green reads that disagree with the visible terrain.

    `greens_path` is a WGS84 GeoJSON FeatureCollection of green polygons
    (same handoff shape as apply-dem-edits, D-TE5). No greens at all is
    allowed but warned about — the whole raster then goes coarse, which is
    unusable for putt reading.
    """
    if out_path.resolve() == input_path.resolve():
        raise dem_analysis_mod.DemAnalysisError(
            f"refusing to overwrite the input DEM {input_path} — the builder DEM stays "
            "the source of truth; pass a different --out"
        )
    if coarse_factor < 1:
        raise dem_analysis_mod.DemAnalysisError("--coarse-factor must be >= 1")

    geometries = dem_analysis_mod.load_green_geometries(greens_path)
    if not geometries:
        print(f"warning: no green polygons in {greens_path} — the whole raster will be coarsened")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(input_path) as src:
        dem = src.read(1)
        profile = src.profile.copy()
        src_nodata = src.nodata
        reprojected = dem_analysis_mod.reproject_geometries(geometries, src.crs)
        analysis, mask = dem_analysis_mod.build_analysis_dem(
            dem, src.transform, src_nodata, reprojected,
            buffer_m=buffer_m, coarse_factor=coarse_factor,
        )
        cell_x = abs(src.transform.a)
        cell_y = abs(src.transform.e)

    # Same profile hygiene as cmd_apply_dem_edits, then force the compressed
    # tiled layout: DEFLATE + floating-point predictor is what makes the
    # replicated coarse background nearly free.
    profile.pop("blockxsize", None)
    profile.pop("blockysize", None)
    profile.pop("tiled", None)
    profile.update(
        count=1,
        dtype="float32",
        # The output ALWAYS carries a nodata tag, even when the source had
        # none: invalid cells are filled with the sentinel, and an untagged
        # -9999 would read as a real elevation.
        nodata=dem_analysis_mod.output_nodata(src_nodata),
        compress="deflate",
        predictor=3,
        zlevel=9,
        tiled=True,
        blockxsize=256,
        blockysize=256,
    )
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(analysis, 1)

    full_res_cells = int(np.count_nonzero(mask))
    total_cells = int(mask.size)
    pct = 100.0 * full_res_cells / total_cells if total_cells else 0.0
    src_bytes = input_path.stat().st_size
    out_bytes = out_path.stat().st_size
    print(
        f"{len(geometries)} green polygon(s), {buffer_m:g} m buffer -> "
        f"{full_res_cells:,} full-res cell(s) ({pct:.1f}% of the raster), "
        f"background at {cell_x * coarse_factor:g}x{cell_y * coarse_factor:g} m"
    )
    print(f"Size {out_bytes / 1e6:.1f} MB (source {src_bytes / 1e6:.1f} MB, {100.0 * out_bytes / max(src_bytes, 1):.0f}%)")
    print(f"Wrote {out_path}")
    return out_path


def cmd_apply_dem_edits(input_path: Path, edits_paths: Path | list[Path], out_path: Path) -> Path:
    """Replays vector terrain edits (plane-fit flatten / circular-median
    smooth, both feathered — see golfpipe/dem_edit.py) onto a DEM GeoTIFF.

    Input is the grid-dem output (float32, EPSG:3006, nodata already mostly
    filled — but nodata cells may remain and pass through untouched); each
    edits file is the D-TE5 handoff (GeoJSON FeatureCollection, WGS84,
    per-feature properties op/featherM/radiusM/flat). Several files (the
    site's own edits plus a generated `building-pads` file) are applied as
    one list in createdAt order. The input DEM is never modified (D-TE2 —
    the raw DEM stays the single source of truth); the edited DEM is a
    derived artifact written to out_path with the input's
    profile/transform/nodata. No edits at all writes a byte-identical copy
    of the input.
    """
    if out_path.resolve() == input_path.resolve():
        raise dem_edit_mod.DemEditError(
            f"refusing to overwrite the input DEM {input_path} — the raw DEM stays "
            "pristine (D-TE2); pass a different --out"
        )

    paths = [edits_paths] if isinstance(edits_paths, Path) else list(edits_paths)
    edits: list[dem_edit_mod.DemEdit] = []
    for edits_path in paths:
        edits.extend(dem_edit_mod.load_edits(edits_path))
    if len(paths) > 1:
        edits.sort(key=lambda e: (e.created_at is None, e.created_at or ""))
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not edits:
        shutil.copyfile(input_path, out_path)
        print(f"No edits in {', '.join(str(p) for p in paths)} — wrote a byte-identical copy of the input")
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
    woodland_path: Path | None = None,
    keep_paths: list[Path] | None = None,
    floor_color: str | None = None,
    floor_feather_m: float = woodland_floor_mod.DEFAULT_FEATHER_M,
    floor_mix: float = woodland_floor_mod.DEFAULT_FLOOR_MIX,
    seed: int = 0,
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

    With woodland_path (woodland-features output) every stand is first
    repainted as forest floor outside the corridor and outside the polygons
    of keep_paths (roads), in floor_color mixed with the stand's floorColor
    at floor_mix — see golfpipe.woodland_floor. The LaMa pass then runs as before.

    The cleaned GeoTIFF keeps the source CRS/transform/compression, so
    tile-ortho can be pointed at it directly.
    """
    from golfpipe.inpaint import LamaInpainter, inpaint_tiled
    from shapely.ops import unary_union

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
        ortho_transform = src.transform

    masked_px = int(np.count_nonzero(mask))
    print(f"Mask: {masked_px:,} px (~{masked_px * pixel_area:,.0f} m², "
          f"shadow azimuth {shadow_azimuth_deg}°, length {shadow_length_m} m, margin {margin_m} m)")

    if mask_out is not None:
        mask_profile = profile.copy()
        mask_profile.update(count=1, dtype="uint8", nodata=None)
        with rasterio.open(mask_out, "w", **mask_profile) as dst:
            dst.write((mask * 255).astype(np.uint8), 1)
        print(f"Wrote mask {mask_out}")

    if woodland_path is not None:
        fallback = woodland_floor_mod.parse_hex_color(floor_color) if floor_color else woodland_floor_mod.DEFAULT_FLOOR_RGB
        stands = woodland_floor_mod.load_woodland_stands(woodland_path, fallback_rgb=fallback, mix=floor_mix)
        keep = list(corridor)
        for keep_path in keep_paths or []:
            keep.extend(geom for _, geom in clean_ortho_mod.load_typed_polygons(keep_path))
        own = sum(1 for s in stands if s.sampled)
        print(f"Woodland: {len(stands)} stand(s) ({own} with their own floor colour), "
              f"{len(keep)} keep polygon(s), feather {floor_feather_m:g} m")
        image, painted = woodland_floor_mod.paint_woodland_floor(
            image, ortho_transform, stands, keep=unary_union(keep) if keep else None,
            feather_m=floor_feather_m, seed=seed,
        )
        print(f"Forest floor: {painted:,} px (~{painted * pixel_area:,.0f} m²)")

    if masked_px == 0:
        print("(mask is empty — nothing to inpaint" + (")" if woodland_path else "; writing an unmodified copy)"))
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


EXPORT_META_NAME = "export.json"
EXPORT_FORMATS = {"png": ("png", "pgw"), "jpg": ("jpg", "jgw")}
EXPORT_JPEG_QUALITY = 95
# zlib level of the export PNG. An 8192 px photo barely compresses whatever
# the level, so the cheap one is used: the default 6 takes several times as
# long for a few percent.
EXPORT_PNG_COMPRESS_LEVEL = 1
EXPORT_WARP_THREADS = 4
# Largest per-channel difference (8-bit levels) still counted as unchanged
# on import. 2 swallows the one-level shift an editor's colour-profile
# conversion leaves on every pixel.
DEFAULT_IMPORT_TOLERANCE = 2
DEFAULT_IMPORT_MIN_AREA_PX = 4
# Frame pixels kept around the change mask in the stored patch: 1 for the
# dilation plus 1 fully transparent, so the alpha ramp that resampling makes
# ends inside the PNG and not on its border.
IMPORT_CROP_PAD_PX = 2
_DIFF_STRIP_ROWS = 512


def _bounds_json(bounds: tuple[float, float, float, float]) -> dict:
    west, south, east, north = bounds
    return {"west": west, "south": south, "east": east, "north": north}


def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _emit_json(doc: dict) -> None:
    """The one stdout line of the export/import commands — the server parses
    it, so progress goes to stderr."""
    import json

    print(json.dumps(doc))


def cmd_export_ortho_square(
    ortho_path: Path,
    frame_path: Path,
    out_dir: Path,
    seq: int,
    log_seq: int,
    size: int | None = None,
    fmt: str = "png",
    bounds_wgs84: tuple[float, float, float, float] | None = None,
) -> dict:
    """Exports the cleaned photo as ONE square image on the site's fixed
    frame (golfpipe.square_frame), for editing in an external image editor
    (docs/feature-ortho-export-import.md).

    `ortho_path` is the working `.patched.tif` brought up to date by
    `bake-ortho-patch` (or the pristine ortho of a site never patched) — the
    replayed log is the only export source. `frame_path` is the site's
    `sim-frame.json`: created here from `bounds_wgs84` when missing, never
    changed afterwards. Bands 1..3 are resampled bilinearly into the frame;
    ground the ortho does not cover comes out black.

    Writes into `out_dir` (one directory per export, immutable — an existing
    `export.json` there is refused):

        ortho-sim-<seq>.png|jpg   the image
        ortho-sim-<seq>.pgw|jgw   ESRI world file, EPSG:3006
        export.json               exportSeq, extent3006, size, logSeq (the
                                  highest patch seq the image contains),
                                  sha256 + bytes of the image, createdAt,
                                  file, format

    PNG is the editing format. `fmt` "jpg" (q95) is for a Unity texture;
    importing an edit of it needs an explicit tolerance. Prints `export.json`
    as one JSON line on stdout and returns it.
    """
    import json
    import time
    from datetime import datetime, timezone

    from rasterio.warp import reproject

    from golfpipe import square_frame as square_frame_mod

    if fmt not in EXPORT_FORMATS:
        raise patches_mod.PatchError(f"unknown export format {fmt!r} (png or jpg)")
    if seq < 1:
        raise patches_mod.PatchError(f"--seq must be 1 or higher, got {seq}")
    if log_seq < 0:
        raise patches_mod.PatchError(f"--log-seq must be 0 (empty log) or higher, got {log_seq}")
    meta_path = out_dir / EXPORT_META_NAME
    if meta_path.exists():
        raise patches_mod.PatchError(f"export {out_dir} already exists — exports are immutable, use a new --seq")
    if not ortho_path.is_file():
        raise patches_mod.PatchError(f"ortho not found: {ortho_path}")

    t0 = time.perf_counter()
    with rasterio.open(ortho_path) as src:
        if src.count < 3:
            raise patches_mod.PatchError(f"{ortho_path} has {src.count} band(s); the export needs an RGB ortho")
        frame, created = square_frame_mod.ensure_frame(frame_path, bounds_wgs84, size)
        if created:
            print(f"Created frame {frame_path}: {frame.side_m:g} m square, {frame.size} px", file=sys.stderr)
        rgb = np.zeros((3, frame.size, frame.size), dtype=np.uint8)
        for i in range(3):
            reproject(
                source=rasterio.band(src, i + 1),
                destination=rgb[i],
                src_crs=src.crs, src_transform=src.transform,
                dst_crs=square_frame_mod.SWEREF99_TM, dst_transform=frame.transform,
                resampling=Resampling.bilinear,
                # Same bytes as one thread (checked on a 10648 px ortho,
                # 1/4/8 threads), a third of the time.
                num_threads=EXPORT_WARP_THREADS,
            )
    t1 = time.perf_counter()

    ext, world_ext = EXPORT_FORMATS[fmt]
    stem = f"ortho-sim-{seq}"
    out_dir.mkdir(parents=True, exist_ok=True)
    image_path = out_dir / f"{stem}.{ext}"
    img = Image.fromarray(np.ascontiguousarray(np.moveaxis(rgb, 0, -1)))
    del rgb
    if fmt == "png":
        img.save(image_path, format="PNG", compress_level=EXPORT_PNG_COMPRESS_LEVEL)
    else:
        img.save(image_path, format="JPEG", quality=EXPORT_JPEG_QUALITY)
    del img
    t2 = time.perf_counter()

    (out_dir / f"{stem}.{world_ext}").write_text(square_frame_mod.world_file_text(frame), encoding="ascii")
    meta = {
        "exportSeq": seq,
        "extent3006": list(frame.extent3006),
        "size": frame.size,
        "logSeq": log_seq,
        "sha256": _sha256_file(image_path),
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "file": image_path.name,
        "format": fmt,
        "bytes": image_path.stat().st_size,
    }
    # Written last: its presence is what marks the export complete.
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {image_path} ({frame.size} px, {frame.res_m:.3f} m/px, {meta['bytes'] / 1e6:.1f} MB): "
          f"resample {t1 - t0:.1f} s, encode {t2 - t1:.1f} s, hash {time.perf_counter() - t2:.1f} s", file=sys.stderr)
    _emit_json(meta)
    return meta


def _load_export_meta(export_dir: Path) -> dict:
    import json

    meta_path = export_dir / EXPORT_META_NAME
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise patches_mod.PatchError(f"cannot read export {meta_path}: {exc}") from exc
    if not isinstance(meta, dict):
        raise patches_mod.PatchError(f"{meta_path} is not an export description")
    for key, kind in (("exportSeq", int), ("file", str), ("sha256", str)):
        if not isinstance(meta.get(key), kind):
            raise patches_mod.PatchError(f"{meta_path}: missing or malformed `{key}`")
    file = meta["file"]
    if "/" in file or "\\" in file or file.startswith("."):
        raise patches_mod.PatchError(f"{meta_path}: export file name {file!r} must be a plain name")
    return meta


def _change_mask(before: np.ndarray, after: np.ndarray, tolerance: int) -> np.ndarray:
    """(H, W) bool: pixels whose largest per-channel difference exceeds
    `tolerance`. Compared in row strips to keep the int16 temporaries small."""
    mask = np.zeros(before.shape[:2], dtype=bool)
    for r in range(0, before.shape[0], _DIFF_STRIP_ROWS):
        a = before[r:r + _DIFF_STRIP_ROWS].astype(np.int16)
        b = after[r:r + _DIFF_STRIP_ROWS].astype(np.int16)
        mask[r:r + _DIFF_STRIP_ROWS] = np.abs(a - b).max(axis=2) > tolerance
    return mask


def _mask_bbox(mask: np.ndarray) -> tuple[int, int, int, int]:
    """(r0, r1, c0, c1), end-exclusive, of a non-empty bool mask."""
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    return int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1


def cmd_import_ortho_square(
    ortho_path: Path,
    patches_dir: Path,
    export_dir: Path,
    image_path: Path,
    seq: int,
    tolerance: int | None = None,
    min_area_px: int = DEFAULT_IMPORT_MIN_AREA_PX,
) -> dict:
    """Turns an externally edited export back into ONE `raster` patch-log
    payload holding only what the user changed (D-OX3).

    `image_path` (the edited image) is compared pixel by pixel with the
    export it was edited from (`export_dir`, an `export-ortho-square`
    output). Pixels differing by more than `tolerance` levels in any channel
    are the change; 8-connected regions of fewer than `min_area_px` pixels
    are dropped as noise, the rest is dilated 1 px. The mask's bounding box
    (plus IMPORT_CROP_PAD_PX) is written to `patches_dir/<seq>.png` as RGBA:
    alpha 255 on the mask, the edited colour on the mask and two pixels
    around it, zero elsewhere.

    Because the comparison is against the export and not against the current
    raster, an edit of an OLD export still imports correctly after the log
    has grown: it carries the user's own changes and nothing else.

    A lossy image — a JPEG export, or an edited file saved as JPEG/WebP — is
    refused unless `tolerance` is passed explicitly: codec noise would mark
    the whole frame as changed.

    Does NOT touch `patches.json` or the raster. Prints one JSON line on
    stdout and returns it; the server appends the entry (kind "raster",
    `file`, `bounds3006`, `bounds3857`, `exportSeq`, `changedPixels` as
    printed) and runs `bake-ortho-patch --seq`. When nothing changed the
    command still succeeds: `"changed": false` with a `reason`, and no PNG
    is written. `ortho_path` is only read for its extent: a change wholly
    off the photo is such a no-change.
    """
    import hashlib
    import time

    from rasterio.warp import transform_bounds
    from scipy import ndimage

    from golfpipe import square_frame as square_frame_mod

    explicit_tolerance = tolerance is not None
    tolerance = DEFAULT_IMPORT_TOLERANCE if tolerance is None else tolerance
    if not 0 <= tolerance <= 254:
        raise patches_mod.PatchError(f"--tolerance must be 0..254, got {tolerance}")
    if min_area_px < 1:
        raise patches_mod.PatchError(f"--min-area-px must be 1 or higher, got {min_area_px}")
    if seq < 1:
        raise patches_mod.PatchError(f"--seq must be 1 or higher, got {seq}")
    if any(e.seq == seq for e in patches_mod.load_patch_log(patches_dir)):
        raise patches_mod.PatchError(f"seq {seq} is already in the patch log of {patches_dir}")

    meta = _load_export_meta(export_dir)
    frame = square_frame_mod.frame_from_json(meta, str(export_dir / EXPORT_META_NAME))
    export_path = export_dir / meta["file"]
    if not export_path.is_file():
        raise patches_mod.PatchError(f"export image missing: {export_path}")
    if not image_path.is_file():
        raise patches_mod.PatchError(f"edited image not found: {image_path}")

    t0 = time.perf_counter()
    export_bytes = export_path.read_bytes()
    if hashlib.sha256(export_bytes).hexdigest() != meta["sha256"]:
        raise patches_mod.PatchError(
            f"{export_path} no longer matches its export.json (sha256) — the export was modified; "
            "edit a copy and import that"
        )
    del export_bytes

    try:
        with Image.open(image_path) as img:
            edited_format = img.format
            if img.size != (frame.size, frame.size):
                raise patches_mod.PatchError(
                    f"{image_path.name} is {img.size[0]}×{img.size[1]} px; export {meta['exportSeq']} is "
                    f"{frame.size}×{frame.size} px — the edited image must keep the export's size"
                )
            lossy = meta.get("format") == "jpg" or edited_format in ("JPEG", "MPO", "WEBP")
            if lossy and not explicit_tolerance:
                raise patches_mod.PatchError(
                    "refusing to import a JPEG/WebP image with the default tolerance: codec noise would mark "
                    "the whole frame as changed. Save the edit as PNG from a PNG export, or pass --tolerance "
                    "explicitly (try 12 or more)"
                )
            after = np.asarray(img.convert("RGB"))
    except (OSError, Image.DecompressionBombError) as exc:
        raise patches_mod.PatchError(f"cannot read the edited image {image_path}: {exc}") from exc
    with Image.open(export_path) as img:
        before = np.asarray(img.convert("RGB"))
    t1 = time.perf_counter()

    result: dict = {
        "changed": False,
        "seq": seq,
        "exportSeq": meta["exportSeq"],
        "changedPixels": 0,
        "diffPixels": 0,
        "tolerance": tolerance,
        "minAreaPx": min_area_px,
    }

    def no_change(reason: str) -> dict:
        result["reason"] = reason
        print(f"No change imported ({reason}): {result['diffPixels']} differing pixel(s) "
              f"against export {meta['exportSeq']}", file=sys.stderr)
        _emit_json(result)
        return result

    raw = _change_mask(before, after, tolerance)
    del before
    result["diffPixels"] = int(np.count_nonzero(raw))
    if not result["diffPixels"]:
        return no_change("identical")

    # Label inside the raw change's bounding box only — a full-frame label
    # image would be a quarter of a gigabyte for a handful of pixels.
    r0, r1, c0, c1 = _mask_bbox(raw)
    labels, _count = ndimage.label(raw[r0:r1, c0:c1], structure=np.ones((3, 3), dtype=bool))
    keep = np.bincount(labels.ravel()) >= min_area_px
    keep[0] = False
    kept = keep[labels]
    regions = int(np.count_nonzero(keep))
    if not regions:
        return no_change("below-min-area")
    raw[:] = False
    raw[r0:r1, c0:c1] = kept
    del labels, kept

    r0, r1, c0, c1 = _mask_bbox(raw)
    pad = IMPORT_CROP_PAD_PX
    r0, c0 = max(0, r0 - pad), max(0, c0 - pad)
    r1, c1 = min(frame.size, r1 + pad), min(frame.size, c1 + pad)
    mask = ndimage.binary_dilation(raw[r0:r1, c0:c1], structure=np.ones((3, 3), dtype=bool))
    bounds3006 = frame.pixel_bounds3006(r0, r1, c0, c1)

    with rasterio.open(ortho_path) as src:
        ob = src.bounds
        ortho_bounds = (ob.left, ob.bottom, ob.right, ob.top)
        if src.crs != square_frame_mod.SWEREF99_TM:
            ortho_bounds = transform_bounds(src.crs, square_frame_mod.SWEREF99_TM, *ortho_bounds)
    if (bounds3006[0] >= ortho_bounds[2] or bounds3006[2] <= ortho_bounds[0]
            or bounds3006[1] >= ortho_bounds[3] or bounds3006[3] <= ortho_bounds[1]):
        return no_change("outside-ortho")

    # Colour is kept on the mask and two pixels around it — the transparent
    # neighbours the bilinear replay blends with at the edge — and zeroed
    # beyond, where it is never read: scattered edits in one large bounding
    # box then compress to almost nothing.
    near = ndimage.binary_dilation(mask, structure=np.ones((3, 3), dtype=bool), iterations=2)
    rgba = np.dstack([np.where(near[..., None], after[r0:r1, c0:c1], 0), np.where(mask, 255, 0)]).astype(np.uint8)
    patches_dir.mkdir(parents=True, exist_ok=True)
    patch_path = patches_dir / f"{seq}.png"
    tmp_path = patches_dir / f"{seq}.png.tmp"
    Image.fromarray(rgba).save(tmp_path, format="PNG")
    tmp_path.replace(patch_path)

    result.update({
        "changed": True,
        "kind": "raster",
        "file": patch_path.name,
        "bounds3006": _bounds_json(bounds3006),
        "bounds3857": _bounds_json(patches_mod.bounds3006_to_3857(bounds3006)),
        "changedPixels": int(np.count_nonzero(mask)),
        "regions": regions,
        "widthPx": c1 - c0,
        "heightPx": r1 - r0,
        "bytes": patch_path.stat().st_size,
    })
    print(f"Imported {result['changedPixels']} changed pixel(s) in {regions} region(s), "
          f"{(bounds3006[2] - bounds3006[0]):.1f} × {(bounds3006[3] - bounds3006[1]):.1f} m, "
          f"against export {meta['exportSeq']} -> {patch_path} ({result['bytes'] / 1e6:.2f} MB): "
          f"read {t1 - t0:.1f} s, diff {time.perf_counter() - t1:.1f} s", file=sys.stderr)
    _emit_json(result)
    return result


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


def _build_manifest_from_tiles_dir(course_id: str, tiles_dir: Path, dem_path: Path | None) -> dict:
    def existing(name: str) -> Path | None:
        d = tiles_dir / name
        return d if d.exists() else None

    return build_manifest(
        course_id,
        ortho_tiles_dir=existing("ortho"),
        terrain_tiles_dir=existing("terrain"),
        hillshade_tiles_dir=existing("hillshade"),
        dem_path=dem_path,
        canopy_tiles_dir=existing("canopy"),
        canopy_color_tiles_dir=existing("canopy-color"),
        surface_tiles_dir=existing("surface"),
    )


def cmd_manifest(course_id: str, tiles_dir: Path, dem_path: Path | None = None, out_path: Path | None = None) -> Path:
    """Scans tiles_dir for layer pyramids and writes manifest.json. When the
    target already exists it is backed up (.bak, .bak2, ...) and the new
    layers/generatedAt are merged into it, keeping server-written fields
    (orthoVintages, activeOrtho, builtOrtho, ...)."""
    manifest = _build_manifest_from_tiles_dir(course_id, tiles_dir, dem_path)
    target = out_path or (tiles_dir / "manifest.json")
    _, backup = merge_into_existing(manifest, target)
    if backup is not None:
        print(f"Backed up manifest to {backup}")
    print(f"Wrote {target}")
    return target


def _tile_canopy_color(canopy_tif: Path, out_dir: Path, minzoom: int, maxzoom: int) -> int:
    """Tiles the canopy height GeoTIFF into RGBA PNGs coloured by
    canopy.canopy_color_rgba (transparent under 1 m). Same WarpedVRT /
    bilinear / pyramid path as cmd_tile_terrain, colourised per tile after
    reprojection; no edge padding (outside the grid there is no canopy).
    """
    bbox_wgs84 = raster_bounds_wgs84(canopy_tif)
    pyramid_bounds = pyramid_bounds_3857(bbox_wgs84, minzoom, maxzoom)
    vrt = open_warped_to_mercator(canopy_tif, Resampling.bilinear, extra_bounds_3857=pyramid_bounds)
    try:
        nodata = vrt.nodata

        def encode(data: np.ndarray):
            heights = data[0].astype(np.float64)
            if nodata is not None:
                heights = np.where(heights == nodata, 0.0, heights)
            heights = np.nan_to_num(heights, nan=0.0, posinf=0.0, neginf=0.0)
            rgba = canopy_mod.canopy_color_rgba(heights)
            from io import BytesIO

            buf = BytesIO()
            Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
            return buf.getvalue()

        count = generate_tile_pyramid(vrt, bbox_wgs84, minzoom, maxzoom, out_dir, encode, "png")
    finally:
        vrt.close()
    print(f"Wrote {count} canopy-color tiles to {out_dir}")
    return count


def _dem_bbox_3006(dem_path: Path) -> tuple[float, float, float, float]:
    from rasterio.crs import CRS
    from rasterio.warp import transform_bounds

    with rasterio.open(dem_path) as src:
        if src.crs == CRS.from_epsg(3006):
            return tuple(src.bounds)
        return tuple(transform_bounds(src.crs, CRS.from_epsg(3006), *src.bounds))


class CanopyGrid:
    """Result of _build_canopy_grid: the cleaned canopy (what canopy.tif
    holds and what trees-features polygonizes), plus the inputs the surface
    DSM needs."""

    def __init__(self, canopy, transform, ground_dem, suppressed_ndsm, resolution: float,
                 surface_count=None, multi_count=None, roof_mask=None, ndsm=None):
        self.canopy = canopy
        # The nDSM before roof suppression: roof heights for --roofs-out.
        self.ndsm = ndsm
        self.transform = transform
        self.ground_dem = ground_dem
        self.suppressed_ndsm = suppressed_ndsm
        self.resolution = resolution
        # Per-cell surface return count and count of returns from multi-return
        # pulses; trees-stems uses their ratio as a crown-porosity feature.
        self.surface_count = surface_count
        self.multi_count = multi_count
        # Bool grid of the cells suppress_buildings zeroed; the roof guard in
        # trees-features and trees-stems keeps small tall crowns away from it.
        self.roof_mask = roof_mask


def _build_canopy_grid(
    lidar_paths: list[Path],
    bbox_3006: tuple[float, float, float, float],
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
) -> CanopyGrid:
    """Lidar -> ground grid, max-z surface, nDSM, roof suppression,
    canopy.clean_canopy. Shared by cmd_canopy and cmd_trees_features so the
    tiles and the polygons come from one grid.
    """
    print("Gridding ground returns (mean z) ...")
    ground_sum, ground_count, transform, ground_counts = grid_dem_mod.grid_lidar_points(
        lidar_paths, bbox_3006, resolution=resolution, classes=grid_dem_mod.DEFAULT_CLASSES,
    )
    ground_dem = grid_dem_mod.build_dem_grid(ground_sum, ground_count)
    print(f"Ground points used: {ground_counts.points_used_for_grid:,}")

    print(f"Gridding surface returns (max z, all classes except noise {detect_trees_mod.NOISE_CLASSES}) ...")
    multi_count = np.zeros(grid_dem_mod.grid_shape(bbox_3006, resolution), dtype=np.float64)
    surface_max, surface_count, _, surface_counts = grid_dem_mod.grid_lidar_points(
        lidar_paths, bbox_3006, resolution=resolution,
        classes=None, aggregate="max", exclude_classes=detect_trees_mod.NOISE_CLASSES,
        multi_return_count=multi_count,
    )
    print(f"Surface points used: {surface_counts.points_used_for_grid:,} "
          f"({int(multi_count.sum()):,} with more than one return)")

    ndsm = detect_trees_mod.build_ndsm(ground_dem, surface_max, surface_count)
    raw_cells = int(np.count_nonzero(ndsm >= canopy_mod.MIN_CANOPY_HEIGHT_M))
    suppressed = canopy_mod.suppress_buildings(ndsm, surface_count, multi_count, cell_size_m=resolution)
    roof_mask = (ndsm >= canopy_mod.BUILDING_MIN_HEIGHT_M) & (suppressed == 0.0)
    roof_cells = int(np.count_nonzero(roof_mask))
    canopy = canopy_mod.clean_canopy(suppressed)
    canopy_cells = int(np.count_nonzero(canopy > 0))
    print(f"Canopy cells >= {canopy_mod.MIN_CANOPY_HEIGHT_M} m: {raw_cells:,} raw, "
          f"{roof_cells:,} suppressed as roofs, {canopy_cells:,} after cleaning "
          f"(~{canopy_cells * resolution * resolution:,.0f} m²); max height {float(canopy.max()):.1f} m")
    return CanopyGrid(canopy, transform, ground_dem, suppressed, resolution, surface_count, multi_count, roof_mask,
                      ndsm=ndsm)


def _write_roof_mask(roof_mask: np.ndarray, transform, path: Path) -> None:
    grid_dem_mod.write_dem_geotiff(roof_mask.astype(np.float32), transform, path, nodata_value=-1.0)


def _read_roof_mask(path: Path, bbox_3006, shape) -> np.ndarray:
    roof, _ = trees_features_mod.read_canopy_tif(path, bbox_3006)
    if roof.shape != shape:
        raise ValueError(f"{path} is {roof.shape}, the canopy grid is {shape}; both must come from one canopy run")
    return roof > 0.0


def _write_trees_features(
    canopy: np.ndarray,
    transform,
    out: Path,
    source_ref: str,
    course_id: str | None,
    min_height_m: float = trees_features_mod.DEFAULT_MIN_HEIGHT_M,
    min_area_m2: float = trees_features_mod.DEFAULT_MIN_AREA_M2,
    close_m: float = trees_features_mod.DEFAULT_CLOSE_M,
    round_m: float = trees_features_mod.DEFAULT_ROUND_M,
    simplify_m: float = trees_features_mod.DEFAULT_SIMPLIFY_M,
    min_hole_area_m2: float = trees_features_mod.DEFAULT_MIN_HOLE_AREA_M2,
    roof_mask: np.ndarray | None = None,
) -> dict:
    if roof_mask is None:
        print(f"No roof mask: polygons under {trees_features_mod.ROOF_GUARD_AREA_M2:g} m² are dropped "
              "(pass --roof-tif from the canopy workdir to keep small crowns away from roofs)")
    trees = trees_features_mod.trees_from_canopy(
        canopy, transform, min_height_m=min_height_m, min_area_m2=min_area_m2,
        close_m=close_m, round_m=round_m, simplify_m=simplify_m, min_hole_area_m2=min_hole_area_m2,
        roof_mask=roof_mask,
    )
    collection = trees_features_mod.build_trees_feature_collection(trees, source_ref, course_id=course_id)
    water_mod.write_geojson(collection, out)
    total_area = sum(t.area_m2 for t in trees)
    holes = sum(len(t.geometry.interiors) for t in trees)
    print(f"Tree polygons: {len(trees)} (>= {min_height_m} m, >= {min_area_m2} m², "
          f"holes >= {min_hole_area_m2} m², close {close_m} m, round {round_m} m, simplify {simplify_m} m); "
          f"{holes} holes; total area {total_area:,} m²")
    if not trees:
        print("(no canopy >= min height found; try a lower --min-height)")
    print(f"Wrote {out}")
    return collection


def cmd_trees_features(
    out: Path,
    canopy_tif: Path | None = None,
    lidar_paths: list[Path] | None = None,
    dem_path: Path | None = None,
    course_id: str | None = None,
    bbox_3006: tuple[float, float, float, float] | None = None,
    min_height_m: float = trees_features_mod.DEFAULT_MIN_HEIGHT_M,
    min_area_m2: float = trees_features_mod.DEFAULT_MIN_AREA_M2,
    close_m: float = trees_features_mod.DEFAULT_CLOSE_M,
    round_m: float = trees_features_mod.DEFAULT_ROUND_M,
    simplify_m: float = trees_features_mod.DEFAULT_SIMPLIFY_M,
    min_hole_area_m2: float = trees_features_mod.DEFAULT_MIN_HOLE_AREA_M2,
    source_ref: str | None = None,
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
    roof_tif: Path | None = None,
) -> Path:
    """Tree polygons (GeoJSON, EPSG:3006) from the cleaned canopy grid the
    `canopy` command tiles. Input is either canopy_tif (the canopy.tif in a
    canopy workdir, optionally clipped to bbox_3006; roof_tif is the roof.tif
    beside it, which enables the roof guard for small crowns) or lidar_paths
    (+ dem_path for the area when bbox_3006 is not given), in which case the
    grid and its roof mask are built exactly as cmd_canopy builds them.
    source_ref defaults to the canopy tif basename or the comma-joined lidar
    basenames. See golfpipe/trees_features.py for the polygon steps and
    property contract.
    """
    roof_mask = None
    if canopy_tif is not None:
        print(f"Reading cleaned canopy from {canopy_tif}")
        canopy, transform = trees_features_mod.read_canopy_tif(canopy_tif, bbox_3006)
        if roof_tif is not None:
            roof_mask = _read_roof_mask(roof_tif, bbox_3006, canopy.shape)
        if source_ref is None:
            source_ref = canopy_tif.name
    elif lidar_paths:
        if bbox_3006 is None:
            if dem_path is None:
                raise ValueError("trees-features from lidar needs --bbox or --dem to define the area")
            bbox_3006 = _dem_bbox_3006(dem_path)
        print(f"Area (EPSG:3006): {', '.join(f'{v:.1f}' for v in bbox_3006)}")
        grid = _build_canopy_grid(lidar_paths, bbox_3006, resolution=resolution)
        canopy, transform, roof_mask = grid.canopy, grid.transform, grid.roof_mask
        if source_ref is None:
            source_ref = ",".join(p.name for p in lidar_paths)
    else:
        raise ValueError("trees-features needs --canopy-tif or --lidar")

    _write_trees_features(
        canopy, transform, out, source_ref, course_id,
        min_height_m=min_height_m, min_area_m2=min_area_m2, close_m=close_m, round_m=round_m, simplify_m=simplify_m,
        min_hole_area_m2=min_hole_area_m2, roof_mask=roof_mask,
    )
    return out


def cmd_lowveg_features(
    out: Path,
    canopy_tif: Path | None = None,
    lidar_paths: list[Path] | None = None,
    dem_path: Path | None = None,
    course_id: str | None = None,
    bbox_3006: tuple[float, float, float, float] | None = None,
    trees_path: Path | None = None,
    min_height_m: float = lowveg_features_mod.DEFAULT_MIN_HEIGHT_M,
    max_height_m: float = lowveg_features_mod.DEFAULT_MAX_HEIGHT_M,
    tree_buffer_m: float = lowveg_features_mod.DEFAULT_TREE_BUFFER_M,
    min_area_m2: float = lowveg_features_mod.DEFAULT_MIN_AREA_M2,
    close_m: float = lowveg_features_mod.DEFAULT_CLOSE_M,
    round_m: float = lowveg_features_mod.DEFAULT_ROUND_M,
    simplify_m: float = lowveg_features_mod.DEFAULT_SIMPLIFY_M,
    min_hole_area_m2: float = lowveg_features_mod.DEFAULT_MIN_HOLE_AREA_M2,
    source_ref: str | None = None,
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
    min_points: int = lowveg_features_mod.DEFAULT_MIN_POINTS,
    roof_buffer_m: float = lowveg_features_mod.DEFAULT_ROOF_BUFFER_M,
) -> Path:
    """Shrub-zone proposals (GeoJSON, EPSG:3006, `vegetation_zone` features
    of zone type `shrub`, source `lidar-lowveg`): low vegetation between
    min_height_m and max_height_m that is not trees.
    With lidar_paths (+ dem_path for the area when bbox_3006 is not given)
    the returns in that height band are counted per cell (min_points over
    3x3 cells), with trees and roofs from the canopy grid cmd_canopy builds
    and nothing proposed within roof_buffer_m of a roof. With canopy_tif
    (the canopy.tif in a canopy workdir, optionally clipped to bbox_3006)
    the cleaned grid's cells in the band are used, which never go under
    1 m. trees_path is a trees GeoJSON (trees-features output) whose
    polygons, buffered by tree_buffer_m, are cut out on top of the grid's
    own above-max_height cells. See golfpipe/lowveg_features.py for the
    steps and the property contract."""
    band = None
    roof_mask = None
    if canopy_tif is not None:
        print(f"Reading cleaned canopy from {canopy_tif}")
        canopy, transform = lowveg_features_mod.read_canopy_tif(canopy_tif, bbox_3006)
        if min_height_m < canopy_mod.MIN_CANOPY_HEIGHT_M:
            print(f"Note: the cleaned canopy has no cells under {canopy_mod.MIN_CANOPY_HEIGHT_M:g} m, so "
                  f"{min_height_m:g}..{canopy_mod.MIN_CANOPY_HEIGHT_M:g} m scrub is missing; "
                  "run with --lidar to count points instead")
        if source_ref is None:
            source_ref = canopy_tif.name
    elif lidar_paths:
        if bbox_3006 is None:
            if dem_path is None:
                raise ValueError("lowveg-features from lidar needs --bbox or --dem to define the area")
            bbox_3006 = _dem_bbox_3006(dem_path)
        print(f"Area (EPSG:3006): {', '.join(f'{v:.1f}' for v in bbox_3006)}")
        grid = _build_canopy_grid(lidar_paths, bbox_3006, resolution=resolution)
        canopy, transform, roof_mask = grid.canopy, grid.transform, grid.roof_mask
        print(f"Counting returns {min_height_m:g}..{max_height_m:g} m above ground ...")
        band = lowveg_features_mod.count_band_points(
            lidar_paths, bbox_3006, grid.ground_dem, resolution,
            min_height_m=min_height_m, max_height_m=max_height_m, exclude_classes=detect_trees_mod.NOISE_CLASSES,
        )
        print(f"Returns in the band: {int(band.count.sum()):,} in {int(np.count_nonzero(band.count)):,} cells")
        if source_ref is None:
            source_ref = ",".join(p.name for p in lidar_paths)
    else:
        raise ValueError("lowveg-features needs --canopy-tif or --lidar")

    trees = None
    if trees_path is not None:
        trees = lowveg_features_mod.read_tree_polygons(trees_path)
        print(f"Trees to cut out: {len(trees)} polygon(s) from {trees_path.name}, buffered {tree_buffer_m:g} m")
    shared = dict(
        min_height_m=min_height_m, max_height_m=max_height_m, trees=trees, tree_buffer_m=tree_buffer_m,
        min_area_m2=min_area_m2, close_m=close_m, round_m=round_m, simplify_m=simplify_m,
        min_hole_area_m2=min_hole_area_m2,
    )
    if band is not None:
        zones = lowveg_features_mod.lowveg_from_points(
            band, canopy, transform, roof_mask=roof_mask, min_points=min_points, roof_buffer_m=roof_buffer_m,
            **shared,
        )
    else:
        zones = lowveg_features_mod.lowveg_from_canopy(canopy, transform, **shared)
    collection = lowveg_features_mod.build_lowveg_feature_collection(zones, source_ref, course_id=course_id)
    water_mod.write_geojson(collection, out)
    total_area = sum(z.area_m2 for z in zones)
    print(f"Shrub zone proposals: {len(zones)} ({min_height_m:g}..{max_height_m:g} m, >= {min_area_m2:g} m², "
          f"holes >= {min_hole_area_m2:g} m², tree buffer {tree_buffer_m:g} m, close {close_m:g} m, "
          f"round {round_m:g} m, simplify {simplify_m:g} m"
          + (f", >= {min_points} returns per 3x3 cells, roof buffer {roof_buffer_m:g} m" if band is not None else "")
          + f"); total area {total_area:,} m²")
    if not zones:
        print("(no low vegetation in that height band; try a wider --min-height/--max-height)")
    print(f"Wrote {out}")
    return out


def cmd_woodland_features(
    out: Path,
    canopy_tif: Path | None = None,
    lidar_paths: list[Path] | None = None,
    dem_path: Path | None = None,
    roof_tif: Path | None = None,
    ortho_path: Path | None = None,
    course_id: str | None = None,
    bbox_3006: tuple[float, float, float, float] | None = None,
    min_height_m: float = woodland_features_mod.DEFAULT_MIN_HEIGHT_M,
    close_m: float = woodland_features_mod.DEFAULT_CLOSE_M,
    min_area_m2: float = woodland_features_mod.DEFAULT_MIN_AREA_M2,
    min_hole_area_m2: float = woodland_features_mod.DEFAULT_MIN_HOLE_AREA_M2,
    edge_m: float = woodland_features_mod.DEFAULT_EDGE_M,
    min_cover: float = woodland_features_mod.DEFAULT_MIN_COVER,
    roof_buffer_m: float = woodland_features_mod.DEFAULT_ROOF_BUFFER_M,
    round_m: float = woodland_features_mod.DEFAULT_ROUND_M,
    simplify_m: float = woodland_features_mod.DEFAULT_SIMPLIFY_M,
    min_weight: float = woodland_features_mod.DEFAULT_MIN_WEIGHT,
    source_ref: str | None = None,
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
) -> Path:
    """Woodland-floor zone proposals (GeoJSON, EPSG:3006, `vegetation_zone`
    features of zone type `woodland_floor`, source `lidar-woodland`): one
    polygon per closed stand of the cleaned canopy grid. With lidar_paths the
    grid is built in-process (roofs from it, understory returns 0.5..3 m
    counted for the weight); with canopy_tif (+ roof_tif from the same
    canopy workdir) the grid is read and every weight is 1. ortho_path, an
    RGB GeoTIFF in EPSG:3006, adds each stand's floor colour. See
    golfpipe/woodland_features.py for the steps and the property contract."""
    roof_mask = None
    band_count = None
    if canopy_tif is not None:
        print(f"Reading cleaned canopy from {canopy_tif}")
        canopy, transform = trees_features_mod.read_canopy_tif(canopy_tif, bbox_3006)
        if roof_tif is not None:
            roof_mask = _read_roof_mask(roof_tif, bbox_3006, canopy.shape)
        if source_ref is None:
            source_ref = canopy_tif.name
    elif lidar_paths:
        if bbox_3006 is None:
            if dem_path is None:
                raise ValueError("woodland-features from lidar needs --bbox or --dem to define the area")
            bbox_3006 = _dem_bbox_3006(dem_path)
        print(f"Area (EPSG:3006): {', '.join(f'{v:.1f}' for v in bbox_3006)}")
        grid = _build_canopy_grid(lidar_paths, bbox_3006, resolution=resolution)
        canopy, transform, roof_mask = grid.canopy, grid.transform, grid.roof_mask
        print("Counting understory returns 0.5..3 m above ground ...")
        band = lowveg_features_mod.count_band_points(
            lidar_paths, bbox_3006, grid.ground_dem, resolution, exclude_classes=detect_trees_mod.NOISE_CLASSES,
        )
        band_count = band.count
        if source_ref is None:
            source_ref = ",".join(p.name for p in lidar_paths)
    else:
        raise ValueError("woodland-features needs --canopy-tif or --lidar")

    _write_woodland_features(
        canopy, transform, out, source_ref, course_id, roof_mask=roof_mask, band_count=band_count,
        ortho_path=ortho_path, min_height_m=min_height_m, close_m=close_m, min_area_m2=min_area_m2,
        min_hole_area_m2=min_hole_area_m2, edge_m=edge_m, min_cover=min_cover, roof_buffer_m=roof_buffer_m,
        round_m=round_m, simplify_m=simplify_m, min_weight=min_weight,
    )
    return out


def _write_woodland_features(
    canopy, transform, out: Path, source_ref: str, course_id: str | None, roof_mask=None, band_count=None,
    ortho_path: Path | None = None, min_height_m: float = woodland_features_mod.DEFAULT_MIN_HEIGHT_M,
    close_m: float = woodland_features_mod.DEFAULT_CLOSE_M, min_area_m2: float = woodland_features_mod.DEFAULT_MIN_AREA_M2,
    min_hole_area_m2: float = woodland_features_mod.DEFAULT_MIN_HOLE_AREA_M2,
    edge_m: float = woodland_features_mod.DEFAULT_EDGE_M, min_cover: float = woodland_features_mod.DEFAULT_MIN_COVER,
    roof_buffer_m: float = woodland_features_mod.DEFAULT_ROOF_BUFFER_M,
    round_m: float = woodland_features_mod.DEFAULT_ROUND_M, simplify_m: float = woodland_features_mod.DEFAULT_SIMPLIFY_M,
    min_weight: float = woodland_features_mod.DEFAULT_MIN_WEIGHT,
) -> None:
    """Stands from a cleaned canopy grid -> woodland GeoJSON at out, with the
    report; shared by cmd_woodland_features and cmd_canopy --woodland-out."""
    stands = woodland_features_mod.woodland_from_canopy(
        canopy, transform, roof_mask=roof_mask, band_count=band_count,
        min_height_m=min_height_m, close_m=close_m, min_area_m2=min_area_m2, min_hole_area_m2=min_hole_area_m2,
        edge_m=edge_m, min_cover=min_cover, roof_buffer_m=roof_buffer_m, round_m=round_m, simplify_m=simplify_m,
        min_weight=min_weight,
    )
    if ortho_path is not None and stands:
        print(f"Sampling floor colours from {ortho_path} ...")
        n = woodland_features_mod.floor_colors(stands, canopy, transform, ortho_path)
        print(f"Floor colour for {n} of {len(stands)} stand(s)"
              + ("" if n == len(stands) else "; the rest have too few visible floor pixels (clean-ortho falls back)"))
    collection = woodland_features_mod.build_woodland_feature_collection(stands, source_ref, course_id=course_id)
    water_mod.write_geojson(collection, out)
    total_ha = sum(s.area_m2 for s in stands) / 10_000
    print(f"Woodland stands: {len(stands)} (canopy >= {min_height_m:g} m, close {close_m:g} m, "
          f">= {min_area_m2:g} m², cover >= {min_cover:.0%}, edge {edge_m:g} m"
          + (f", roof buffer {roof_buffer_m:g} m" if roof_mask is not None else ", no roof mask")
          + f"); total {total_ha:,.1f} ha")
    if not stands:
        print("(no closed stands; try a larger --close or a smaller --min-area / --min-cover)")
    print(f"Wrote {out}")


# Tree-stems tiling (opt-in, --tile-m): the square is cut into tiles of about
# that side, each detected in its own process with TREES_TILE_MARGIN_M of
# neighbouring ground around it (a crown is at most 10 m in radius and the
# peak window 7 m, so a tree straddling a tile edge is seen whole from both
# sides); a stem is kept by the tile whose core holds its peak. Tile edges
# sit on the global cell grid, so the per-tile grids are sub-grids of the
# untiled one and the result matched it stem for stem on Vreta.
#
# Off by default because it did not pay: on Vreta's 2050 m square the
# untiled run takes 22 s of which ~18 s is reading the two 1 GB LAZ files,
# and every tile re-reads the files that touch it while the lazrs
# decompressor already uses every core — nine tiles took 60 s. Tiling wins
# only when detection itself dominates, i.e. very large or very dense
# boxes; reach for it there.
DEFAULT_TREES_TILE_M = 0.0
TREES_TILE_MARGIN_M = 30.0


def _lidar_bounds_3006(path: Path) -> tuple[float, float, float, float]:
    """(x_min, y_min, x_max, y_max) from the LAS header, no point reading."""
    import laspy
    with laspy.open(str(path)) as reader:
        h = reader.header
        return float(h.mins[0]), float(h.mins[1]), float(h.maxs[0]), float(h.maxs[1])


def _trees_tiles(bbox_3006, resolution: float, tile_m: float, margin_m: float):
    """[(core, padded)] boxes in EPSG:3006 covering bbox_3006: cores partition
    the box into roughly tile_m squares, padded grows each by margin_m and
    clips to the box; every edge is a whole number of cells from the box's
    north-west corner, the origin of the untiled grid."""
    e_min, n_min, e_max, n_max = bbox_3006
    cols = int(np.ceil((e_max - e_min) / resolution))
    rows = int(np.ceil((n_max - n_min) / resolution))
    n_x = max(1, int(np.ceil((e_max - e_min) / tile_m)))
    n_y = max(1, int(np.ceil((n_max - n_min) / tile_m)))
    margin = int(np.ceil(margin_m / resolution))
    col_edges = [int(round(cols * i / n_x)) for i in range(n_x + 1)]
    row_edges = [int(round(rows * j / n_y)) for j in range(n_y + 1)]
    tiles = []
    for j in range(n_y):
        for i in range(n_x):
            c0, c1, r0, r1 = col_edges[i], col_edges[i + 1], row_edges[j], row_edges[j + 1]
            core = (e_min + c0 * resolution, n_max - r1 * resolution, e_min + c1 * resolution, n_max - r0 * resolution)
            pc0, pc1 = max(0, c0 - margin), min(cols, c1 + margin)
            pr0, pr1 = max(0, r0 - margin), min(rows, r1 + margin)
            padded = (e_min + pc0 * resolution, n_max - pr1 * resolution, e_min + pc1 * resolution, n_max - pr0 * resolution)
            tiles.append((core, padded))
    return tiles


def _stems_for_tile(job):
    """One tile's stems (module-level so a process pool can pickle it):
    grid the padded box from the lidar files that touch it, detect, keep the
    stems whose peak lies in the core. Returns (index, stems, cells)."""
    from golfpipe import trees_stems as trees_stems_mod
    from golfpipe.trees_stems import stems_from_ndsm
    index, lidar_paths, core, padded, resolution, thresholds, leaf_off_ortho = job
    touching = [p for p in lidar_paths if _touches(_lidar_bounds_3006(p), padded)]
    if not touching:
        return index, [], 0
    grid = _build_canopy_grid(touching, padded, resolution=resolution)
    leaf_off_rgb = None
    if leaf_off_ortho is not None:
        leaf_off_rgb = trees_stems_mod.sample_ortho_rgb(Path(leaf_off_ortho), grid.transform, grid.suppressed_ndsm.shape)
    stems = stems_from_ndsm(grid.suppressed_ndsm, grid.ground_dem, grid.transform, leaf_off_rgb=leaf_off_rgb,
                            roof_mask=grid.roof_mask, **thresholds)
    x0, y0, x1, y1 = core
    kept = [s for s in stems if x0 <= s.x < x1 and y0 <= s.y < y1]
    return index, kept, int(grid.suppressed_ndsm.size)


def _touches(a, b) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def cmd_trees_stems(lidar_paths: list[Path], out: Path, tiles_dir: Path, course_id: str,
                    bbox_3006=None, dem_path=None, resolution=1.0, workdir=None,
                    min_height_m=None, min_area_m2=None, tall_height_m=None, tall_min_area_m2=None,
                    leaf_off_ortho="auto", tile_m: float = DEFAULT_TREES_TILE_M, workers: int | None = None):
    """Extract crown maxima, write GeoJSON + compact asset, merge its manifest entry.
    Threshold arguments left as None take the trees_stems module defaults.

    leaf_off_ortho picks the ortho pyramid the crown kind is read from: "auto"
    takes the newest Oct-Apr vintage listed in tiles_dir/manifest.json, a Path
    names a pyramid directory, None skips kind (every stem unknown).

    tile_m > 0 cuts the box into tiles of about that side detected in
    parallel on up to `workers` processes (default: every core); 0 (the
    default, see DEFAULT_TREES_TILE_M for why) detects the whole box in this
    process, which is also what `workdir`'s diagnostic rasters need."""
    import json
    import time
    from golfpipe import trees_stems as trees_stems_mod
    from golfpipe.trees_stems import stems_from_ndsm, compact_asset, feature_collection
    from golfpipe.manifest import _now_iso

    if not np.isfinite(resolution) or resolution <= 0:
        raise ValueError("resolution must be positive")
    if bbox_3006 is None:
        if dem_path is None:
            raise ValueError("trees-stems needs --bbox or --dem")
        bbox_3006 = _dem_bbox_3006(dem_path)
    if len(bbox_3006) != 4 or not np.all(np.isfinite(bbox_3006)) or bbox_3006[0] >= bbox_3006[2] or bbox_3006[1] >= bbox_3006[3]:
        raise ValueError("bbox must have increasing finite EPSG:3006 bounds")
    started = time.monotonic()
    thresholds = dict(
        min_height_m=trees_stems_mod.DEFAULT_MIN_HEIGHT_M if min_height_m is None else min_height_m,
        min_area_m2=trees_stems_mod.DEFAULT_MIN_AREA_M2 if min_area_m2 is None else min_area_m2,
        tall_height_m=trees_stems_mod.TALL_HEIGHT_M if tall_height_m is None else tall_height_m,
        tall_min_area_m2=trees_stems_mod.TALL_MIN_AREA_M2 if tall_min_area_m2 is None else tall_min_area_m2,
    )
    if leaf_off_ortho == "auto":
        manifest_path = tiles_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        leaf_off_ortho = trees_stems_mod.leaf_off_ortho_dir(tiles_dir, manifest)
        if leaf_off_ortho is None:
            print("No leaf-off ortho vintage in manifest; crown kind left unknown", file=sys.stderr)

    tiles = _trees_tiles(bbox_3006, resolution, tile_m, TREES_TILE_MARGIN_M) if tile_m and tile_m > 0 else []
    if len(tiles) > 1 and workdir is None:
        from concurrent.futures import ProcessPoolExecutor
        import os
        n_workers = max(1, min(workers or os.cpu_count() or 1, len(tiles)))
        print(f"Detecting on {len(tiles)} tiles of ~{tile_m:g} m (+{TREES_TILE_MARGIN_M:g} m margin) on {n_workers} process(es) ...")
        jobs = [(i, list(lidar_paths), core, padded, resolution, thresholds,
                 None if leaf_off_ortho is None else Path(leaf_off_ortho)) for i, (core, padded) in enumerate(tiles)]
        results = []
        with ProcessPoolExecutor(max_workers=n_workers) as pool:
            for index, kept, cells in pool.map(_stems_for_tile, jobs):
                print(f"  tile {index + 1}/{len(tiles)}: {len(kept):,} stems from {cells:,} cells")
                results.extend(kept)
        # The untiled run lists stems north to south, west to east (peak
        # label order); sort the merged set the same way.
        stems = sorted(results, key=lambda s: (-s.y, s.x))
    else:
        if len(tiles) > 1:
            print("Tiling skipped: --workdir rasters cover the whole box", file=sys.stderr)
        grid = _build_canopy_grid(lidar_paths, bbox_3006, resolution=resolution)
        if workdir is not None:
            workdir.mkdir(parents=True, exist_ok=True)
            grid_dem_mod.write_dem_geotiff(grid.suppressed_ndsm.astype(np.float32), grid.transform, workdir / "stems-ndsm.tif", nodata_value=0.0)
            grid_dem_mod.write_dem_geotiff(grid.ground_dem, grid.transform, workdir / "stems-ground.tif")
            grid_dem_mod.write_dem_geotiff(grid.surface_count.astype(np.float32), grid.transform, workdir / "stems-surface-count.tif", nodata_value=-1.0)
            grid_dem_mod.write_dem_geotiff(grid.multi_count.astype(np.float32), grid.transform, workdir / "stems-multi-count.tif", nodata_value=-1.0)
            _write_roof_mask(grid.roof_mask, grid.transform, workdir / "stems-roof.tif")
        leaf_off_rgb = None
        if leaf_off_ortho is not None:
            leaf_off_rgb = trees_stems_mod.sample_ortho_rgb(Path(leaf_off_ortho), grid.transform, grid.suppressed_ndsm.shape)
            covered = np.isfinite(leaf_off_rgb[..., 0]).mean()
            print(f"Leaf-off ortho {leaf_off_ortho} covers {covered:.0%} of the grid")
        stems = stems_from_ndsm(grid.suppressed_ndsm, grid.ground_dem, grid.transform, leaf_off_rgb=leaf_off_rgb,
                                roof_mask=grid.roof_mask, **thresholds)
    out.parent.mkdir(parents=True, exist_ok=True)
    source_ref = ",".join(p.name for p in lidar_paths)
    out.write_text(json.dumps(feature_collection(stems, source_ref, course_id), separators=(",", ":")) + "\n")
    tiles_dir.mkdir(parents=True, exist_ok=True)
    asset = tiles_dir / "tree-stems.json"
    asset.write_text(json.dumps(compact_asset(stems), separators=(",", ":")) + "\n")
    fresh = {"courseId": course_id, "generatedAt": _now_iso(), "assets": {
        "tree-stems": {"path": asset.name, "format": "tree-stems-v1", "count": len(stems)}}}
    merge_into_existing(fresh, tiles_dir / "manifest.json")
    kinds = np.bincount([stem.kind for stem in stems], minlength=3)
    print(f"Wrote {len(stems):,} crown estimates ({kinds[0]:,} broadleaf, {kinds[1]:,} conifer, {kinds[2]:,} unknown), "
          f"{asset.stat().st_size:,} asset bytes in {time.monotonic() - started:.1f} s")
    return stems


def cmd_canopy(
    lidar_paths: list[Path],
    dem_path: Path | None,
    course_id: str,
    tiles_dir: Path,
    workdir: Path,
    bbox_wgs84: tuple[float, float, float, float] | None = None,
    minzoom: int = DEFAULT_TERRAIN_MINZOOM,
    maxzoom: int = DEFAULT_TERRAIN_MAXZOOM,
    resolution: float = detect_trees_mod.DEFAULT_RESOLUTION,
    surface_shape: str = "crown",
    trees_out: Path | None = None,
    min_hole_area_m2: float = trees_features_mod.DEFAULT_MIN_HOLE_AREA_M2,
    woodland_out: Path | None = None,
    woodland_ortho: Path | None = None,
    roofs_out: Path | None = None,
) -> dict[str, int]:
    """Lidar -> canopy height (nDSM, buildings suppressed, cleaned) ->
    three XYZ tile pyramids under tiles_dir plus a manifest.json update:

      canopy        Terrain-RGB PNG, value = height above ground (m), 0 = none
      canopy-color  RGBA PNG display ramp (transparent < 1 m)
      surface       Terrain-RGB PNG, value = ground DEM + canopy height (DSM)

    Area: bbox_wgs84 when given, else the --dem extent. The ground in
    surface.tif is the --dem GeoTIFF (resampled to the canopy grid) where it
    has data, the lidar ground grid elsewhere. surface_shape "crown"
    (default) passes the canopy through canopy.crown_shape (edge taper +
    blur, plateau dips from the raw nDSM) before adding it to the ground;
    "flat" adds the cleaned canopy as is. The canopy / canopy-color layers
    are the same either way. Intermediates canopy.tif (cleaned canopy
    height in metres AGL, nodata 0) and surface.tif (float32, EPSG:3006)
    land in workdir. trees_out, when given, also writes the trees-features
    GeoJSON (default thresholds; min_hole_area_m2 fills interior rings
    smaller than that) from the same cleaned grid. woodland_out, when given,
    writes the woodland-features GeoJSON from that grid too (understory
    returns counted in one more pass over the lidar; floor colours from
    woodland_ortho when given). roofs_out, when given, writes the roof
    heights (metres above ground on the roof cells, 0 elsewhere; float32
    EPSG:3006 on the canopy grid) that `gspro.py ortho --remove-buildings`
    reads. Returns tile counts per layer.
    """
    if surface_shape not in ("crown", "flat"):
        raise ValueError(f"surface_shape must be 'crown' or 'flat', got {surface_shape!r}")
    if bbox_wgs84 is not None:
        bbox_3006 = cmd_reproject_bbox(bbox_wgs84, epsg=3006)
    elif dem_path is not None:
        bbox_3006 = _dem_bbox_3006(dem_path)
    else:
        raise ValueError("canopy needs --bbox/--aoi or --dem to define the area")
    print(f"Area (EPSG:3006): {', '.join(f'{v:.1f}' for v in bbox_3006)}")

    grid = _build_canopy_grid(lidar_paths, bbox_3006, resolution=resolution)
    canopy, transform, ground_dem, suppressed = grid.canopy, grid.transform, grid.ground_dem, grid.suppressed_ndsm

    workdir.mkdir(parents=True, exist_ok=True)
    canopy_tif = workdir / "canopy.tif"
    grid_dem_mod.write_dem_geotiff(canopy, transform, canopy_tif, nodata_value=0.0)
    print(f"Wrote {canopy_tif}")
    roof_tif = workdir / "roof.tif"
    _write_roof_mask(grid.roof_mask, transform, roof_tif)
    print(f"Wrote {roof_tif}")

    if trees_out is not None:
        _write_trees_features(
            canopy, transform, trees_out, ",".join(p.name for p in lidar_paths), course_id,
            min_hole_area_m2=min_hole_area_m2, roof_mask=grid.roof_mask,
        )
    if roofs_out is not None:
        heights = np.where(grid.roof_mask, np.nan_to_num(grid.ndsm, nan=0.0), 0.0).astype(np.float32)
        roofs_out.parent.mkdir(parents=True, exist_ok=True)
        grid_dem_mod.write_dem_geotiff(heights, transform, roofs_out, nodata_value=-1.0)
        print(f"Wrote {roofs_out} ({int(np.count_nonzero(heights)):,} roof cells)")
    if woodland_out is not None:
        print("Counting understory returns 0.5..3 m above ground ...")
        band = lowveg_features_mod.count_band_points(
            lidar_paths, bbox_3006, ground_dem, resolution, exclude_classes=detect_trees_mod.NOISE_CLASSES,
        )
        _write_woodland_features(
            canopy, transform, woodland_out, ",".join(p.name for p in lidar_paths), course_id,
            roof_mask=grid.roof_mask, band_count=band.count, ortho_path=woodland_ortho,
        )

    ground = ground_dem.astype(np.float64)
    if dem_path is not None:
        print(f"Resampling {dem_path} onto the {resolution} m grid ...")
        dem_ground = canopy_mod.resample_dem_to_grid(dem_path, transform, canopy.shape)
        has_dem = dem_ground != detect_trees_mod.NODATA
        ground = np.where(has_dem, dem_ground, ground)
        print(f"DEM covers {100.0 * np.count_nonzero(has_dem) / has_dem.size:.1f}% of the grid")
    if surface_shape == "crown":
        print("Shaping canopy crowns for the surface DSM ...")
        surface_canopy = canopy_mod.crown_shape(canopy, resolution, ndsm=suppressed)
    else:
        surface_canopy = canopy
    valid_ground = ground != detect_trees_mod.NODATA
    surface = np.full(canopy.shape, detect_trees_mod.NODATA, dtype=np.float32)
    surface[valid_ground] = (ground[valid_ground] + surface_canopy[valid_ground]).astype(np.float32)
    surface_tif = workdir / "surface.tif"
    grid_dem_mod.write_dem_geotiff(surface, transform, surface_tif)
    print(f"Wrote {surface_tif}")

    counts: dict[str, int] = {}
    print("Tiling canopy ...")
    counts["canopy"] = cmd_tile_terrain(
        canopy_tif, tiles_dir / "canopy", minzoom=minzoom, maxzoom=maxzoom, fill_nodata=False, edge_pad_m=0.0,
    )
    print("Tiling canopy-color ...")
    counts["canopy-color"] = _tile_canopy_color(canopy_tif, tiles_dir / "canopy-color", minzoom, maxzoom)
    print("Tiling surface ...")
    counts["surface"] = cmd_tile_terrain(surface_tif, tiles_dir / "surface", minzoom=minzoom, maxzoom=maxzoom)

    manifest_path = tiles_dir / "manifest.json"
    fresh = _build_manifest_from_tiles_dir(course_id, tiles_dir, dem_path)
    _, backup = merge_into_existing(fresh, manifest_path)
    if backup is not None:
        print(f"Backed up manifest to {backup}")
    print(f"Wrote {manifest_path}")
    return counts
