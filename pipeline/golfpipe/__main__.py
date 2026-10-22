"""CLI entry point: python -m golfpipe <command> ...

Commands:
  fetch-dem         STAC search + download DTM COG(s), mosaic/crop -> dem.tif
  fetch-ortho       STAC search + download best-coverage ortho COG(s) -> ortho.tif (+ ortho.nir.tif, the NIR band)
  fetch-nir         The NIR band for an ortho fetched before it was kept -> <ortho stem>.nir.tif
  surfaces-predict  The course-surface model over a site -> class + confidence GeoTIFF (0.32 m)
  propose-bunkers   Bunkers found by the surface model, edges from the NIR band -> EPSG:3006 GeoJSON proposals
  fetch-lidar       STAC search + download classified lidar COPC point cloud(s)
  fetch-water       Marktäcke vector water -> typed GeoJSON (water / water_creek)
  fetch-hydro       Hydrografi Direkt water + creeks -> typed GeoJSON (water / water_creek)
  fetch-osm         Overpass OSM golf/terrain polygons -> typed GeoJSON (ODbL)
  fetch-roads       Overpass OSM highway centerlines -> buffered road corridors as typed GeoJSON (path, ODbL)
  road-grades       fetch-roads centerlines -> 'corridor' terrain edit per road (D-TE5 edits GeoJSON)
  fetch-buildings  Overpass OSM building footprints (+ lidar eave/ridge heights) -> building survey GeoJSON (ODbL)
  building-pads     Building survey -> flat 'plane' terrain edit per footprint (D-TE5 edits GeoJSON)
  grid-dem       Bin lidar points (ground/water/bridge classes) -> DEM GeoTIFF
  apply-dem-edits   Replay vector terrain edits (plane/smooth/corridor + feather) onto a DEM (--edits repeatable)
  dem-analysis      Publishable analysis DEM: 0.5 m greens + 1 m background mosaic
  detect-trees      Lidar nDSM tree-canopy polygons -> typed GeoJSON (trees)
  detect-water      Lidar class-9 presence polygons -> typed GeoJSON (water)
  lake-plane        A big lake's water surface out to the horizon -> Unity plane meshes (golfmap-lake-plane-v1)
  shore-edits       Hydro lake + both terrains' lidar ground hits -> the true shoreline as one 'shore' terrain edit (D-TE5)
  clean-ortho       LaMa-inpaint canopy+shadows out of the playable corridor (+ --woodland: forest floor) -> .clean.tif
  cleaned-init      Ortho GeoTIFF -> the site's cleaned photo: one square 8192 px RGB GeoTIFF on the inner terrain square
  cleaned-replace   Any image of the cleaned photo's pixel size (or an undo snapshot) -> the cleaned photo + retile under what changed
  cleaned-patch     Rectangles of finished pixels (the Clean tool's strokes) written into the cleaned photo + retile under them
  cleaned-export    The cleaned photo -> PNG, JPEG or raw RGB bytes
  cleanup-hole      One hole's trees, shadows, players and paths painted out of a working copy of the cleaned photo
  cleanup-compose   The accepted holes' changed pixels -> one transparent PNG for cleaned-replace
  tile-ortho        GeoTIFF -> WebP XYZ tile pyramid
  tile-terrain      GeoTIFF (DEM) -> Terrain-RGB PNG XYZ tile pyramid
  canopy            Lidar -> canopy / canopy-color / surface tile pyramids + manifest update (--trees-out: tree polygons too)
  photo-stems       Summer + leaf-off photo, lidar stems, course features -> young trees the lidar missed, from their shadows on open ground
  trees-features    Cleaned canopy grid (canopy.tif or lidar) -> tree polygons GeoJSON with height stats
  lowveg-features   Lidar returns 0.5..3 m above ground -> shrub-zone proposals (vegetation_zone GeoJSON, trees and roofs cut out)
  woodland-features Cleaned canopy grid -> woodland-floor zone proposals per closed stand (+ floor colour from an ortho)
  manifest          Write manifest.json for a tiled course
  install           Copy tiles+manifest into data/tiles/{courseId}/...
  bbox-from-course  Compute a WGS84 bbox from a course's DB coordinates

Every command that takes an area accepts --bbox (w,s,e,n WGS84) or --aoi
(a GeoJSON file whose combined bbox is used) — see golfpipe/aoi.py.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import json

from golfpipe import buildings
from golfpipe import bunker_proposals
from golfpipe import nir as nir_mod
from golfpipe import surface_model
from golfpipe.sculpt import SculptError
from golfpipe import clean_ortho
from golfpipe import cleaned
from golfpipe import commands
from golfpipe import dem_analysis
from golfpipe import dem_edit
from golfpipe import detect_trees
from golfpipe import detect_water
from golfpipe import grid_dem as grid_dem_mod
from golfpipe import hole_cleanup
from golfpipe import hydro
from golfpipe import lake_plane
from golfpipe import sources
from golfpipe import trees_stems
from golfpipe import photo_stems
import vegetation_rules
from golfpipe import osm
from golfpipe import patches
from golfpipe import roads
from golfpipe import shore
from golfpipe import trees_features
from golfpipe import lowveg_features
from golfpipe import woodland_features
from golfpipe import woodland_floor
from golfpipe import water
from golfpipe.aoi import AoiError, resolve_bbox
from golfpipe.bbox_course import bbox_from_course
from golfpipe.inpaint import InpaintError
from golfpipe.install import build_register_payloads, install_course_tiles, post_payloads, print_payloads
from golfpipe.stac import MissingCredentialsError


def _add_area_args(sp: argparse.ArgumentParser) -> None:
    group = sp.add_mutually_exclusive_group(required=True)
    group.add_argument("--bbox", help="west,south,east,north in WGS84 degrees")
    group.add_argument("--aoi", help="GeoJSON file (Feature/FeatureCollection/geometry, WGS84); its bbox is used")


def _resolve_area(args: argparse.Namespace) -> tuple[float, float, float, float]:
    try:
        return resolve_bbox(args.bbox, args.aoi)
    except AoiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2)


def _parse_square_3006(parser: argparse.ArgumentParser, value: str | None) -> tuple[float, float, float, float] | None:
    """--square-3006 x0,y0,x1,y1 (EPSG:3006 metres), or None when not given."""
    if not value:
        return None
    try:
        square = tuple(float(v) for v in value.split(","))
    except ValueError:
        square = ()
    if len(square) != 4 or not (square[2] > square[0] and square[3] > square[1]):
        parser.error("--square-3006 must be x0,y0,x1,y1 with x1 > x0 and y1 > y0 (EPSG:3006 metres)")
    return square


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="golfpipe", description="golf-map tile pipeline")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("fetch-dem", help="STAC search + download DEM COG(s), mosaic/crop to bbox")
    _add_area_args(p)
    p.add_argument("--workdir", required=True, help="directory to download source COGs into")
    p.add_argument("--out", required=True, help="output path for cropped/mosaicked dem.tif")
    p.add_argument("--buffer", type=float, default=commands.DEFAULT_FETCH_BUFFER_M, help="crop buffer in metres (default 250)")
    p.add_argument("--items", help="comma-separated STAC item ids to fetch instead of searching (from sources.json)")

    p = sub.add_parser("fetch-ortho", help="STAC search + download orthophoto COG(s), mosaic/crop to bbox")
    _add_area_args(p)
    p.add_argument("--workdir", required=True, help="directory to download source COGs into")
    p.add_argument("--out", required=True, help="output path for cropped/mosaicked ortho.tif")
    p.add_argument("--buffer", type=float, default=commands.DEFAULT_FETCH_BUFFER_M, help="crop buffer in metres (default 250)")
    p.add_argument("--collection", help="fetch a specific vintage collection (default: newest); see list-ortho-vintages")
    p.add_argument("--items", help="comma-separated STAC item ids to fetch instead of searching (from sources.json)")

    p = sub.add_parser("list-ortho-vintages", help="List ortho vintages covering an area (JSON, newest first)")
    _add_area_args(p)

    p = sub.add_parser("fetch-nir", help="The ortho's near-infrared band beside it (<ortho stem>.nir.tif) from its vintage's RGBI items")
    p.add_argument("--ortho", required=True, help="the site's RGB ortho GeoTIFF the NIR must line up with")
    p.add_argument("--collection", required=True, help="its vintage, e.g. orto-l2-2025")
    p.add_argument("--tile-dir", action="append", default=[],
                   help="folder of RGBI items already on disk (<item id>.tif, also one level down); repeatable")
    p.add_argument("--workdir", help="where missing items are downloaded and deleted afterwards (default: beside the ortho)")
    p.add_argument("--no-download", action="store_true", help="only items already on disk")

    p = sub.add_parser("surfaces-predict", help="The course-surface model over a site -> class + confidence GeoTIFF (0.32 m)")
    p.add_argument("--ortho", required=True, help="RGB ortho GeoTIFF (EPSG:3006)")
    p.add_argument("--nir", help="its NIR band (default <ortho stem>.nir.tif, see fetch-nir)")
    p.add_argument("--dem", required=True, help="the raw lidar DEM GeoTIFF")
    p.add_argument("--model", required=True, help="the model .pt (its card .json beside it)")
    p.add_argument("--out", required=True, help="output GeoTIFF (+ .json of what it was made from)")
    p.add_argument("--device", help="cpu | cuda | mps (default: the best there is)")
    p.add_argument("--force", action="store_true", help="run even when the output is current")

    p = sub.add_parser("propose-bunkers", help="Bunker proposals: the surface model finds them, the NIR band draws the edges (EPSG:3006 GeoJSON)")
    p.add_argument("--ortho", required=True, help="RGB ortho GeoTIFF (EPSG:3006) the course is drawn on")
    p.add_argument("--nir", help="its NIR band (default <ortho stem>.nir.tif)")
    p.add_argument("--dem", required=True, help="the raw lidar DEM GeoTIFF")
    p.add_argument("--model", required=True, help="the surface model .pt")
    p.add_argument("--surfaces", required=True, help="the model's GeoTIFF for this site: reused when current, else made")
    p.add_argument("--known", help="drawn bunkers, EPSG:3006 GeoJSON: proposals on them are left out")
    p.add_argument("--min-area", type=float, default=2.0, help="smallest bunker, m² (default 2)")
    p.add_argument("--out", required=True, help="output EPSG:3006 GeoJSON, most confident first")
    p.add_argument("--device", help="cpu | cuda | mps for the model (default: the best there is)")

    p = sub.add_parser("fetch-lidar", help="STAC search + download classified lidar COPC point cloud(s)")
    _add_area_args(p)
    p.add_argument("--workdir", help="alias for --out-dir (kept for symmetry with fetch-dem/fetch-ortho)")
    p.add_argument("--out-dir", help="directory to download .copc.laz assets into")
    p.add_argument("--items", help="comma-separated STAC item ids to fetch instead of searching (from sources.json)")
    p.add_argument("--skip-forbidden", action="store_true", dest="skip_forbidden",
                   help="warn and skip tiles Lantmäteriet withholds (HTTP 403) instead of aborting")

    p = sub.add_parser("fetch-water", help="Download Marktäcke vector data and extract water as typed GeoJSON (EPSG:3006)")
    _add_area_args(p)
    p.add_argument("--workdir", required=True, help="directory to download/extract source GeoPackages into")
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")
    p.add_argument(
        "--creek-width", dest="creek_width", type=float, default=water.DEFAULT_CREEK_WIDTH_M,
        help=f"total buffered width in metres for watercourse lines (default {water.DEFAULT_CREEK_WIDTH_M})",
    )

    p = sub.add_parser("fetch-hydro", help="Fetch Hydrografi Direkt water surfaces + watercourse lines as typed GeoJSON (EPSG:3006)")
    _add_area_args(p)
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")
    p.add_argument(
        "--creek-width", dest="creek_width", type=float, default=water.DEFAULT_CREEK_WIDTH_M,
        help=f"total buffered width in metres for watercourse centerlines (default {water.DEFAULT_CREEK_WIDTH_M})",
    )
    p.add_argument("--square-3006", dest="square_3006", help="x0,y0,x1,y1 EPSG:3006 metres: clip to this exact terrain square (--bbox is its WGS84 envelope, which is larger)")

    p = sub.add_parser("fetch-osm", help="Query Overpass for OSM golf/terrain polygons -> typed GeoJSON (EPSG:3006, ODbL)")
    _add_area_args(p)
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")
    p.add_argument("--overpass-url", dest="overpass_url", default=osm.OVERPASS_URL, help=f"Overpass API endpoint (default {osm.OVERPASS_URL})")

    p = sub.add_parser("fetch-roads", help="Query Overpass for OSM highway centerlines -> buffered road corridor polygons as typed GeoJSON (path, EPSG:3006, ODbL)")
    _add_area_args(p)
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard; bucket on road_class)")
    p.add_argument("--overpass-url", dest="overpass_url", default=osm.OVERPASS_URL, help=f"Overpass API endpoint (default {osm.OVERPASS_URL})")
    p.add_argument(
        "--class-width", dest="class_width", action="append", default=[], metavar="CLASS=METRES",
        help="override the default total width for a highway class, repeatable (e.g. service=4); "
             "defaults: " + ", ".join(f"{k}={v:g}" for k, v in roads.CLASS_WIDTH_M.items()),
    )
    p.add_argument("--no-clip", dest="clip", action="store_false", help="keep whole ways instead of clipping the corridors to the area")
    p.add_argument("--square-3006", dest="square_3006", help="x0,y0,x1,y1 EPSG:3006 metres: clip to this exact terrain square (--bbox is its WGS84 envelope, which is larger)")
    p.add_argument("--merge", action="store_true", help="union the corridors per class into road-network polygons (one big feature, no junction overlaps) instead of one polygon per OSM way")
    p.add_argument("--simplify", type=float, default=roads.DEFAULT_SIMPLIFY_M, help=f"simplify tolerance in metres (default {roads.DEFAULT_SIMPLIFY_M})")
    p.add_argument("--min-area", dest="min_area", type=float, default=roads.DEFAULT_MIN_AREA_M2, help=f"drop road polygons under this many m² (default {roads.DEFAULT_MIN_AREA_M2:g})")
    p.add_argument("--centerlines-out", dest="centerlines_out", help="also write the clipped centerlines with widths (EPSG:3006 LineStrings) — the input for road-grades")
    p.add_argument("--near", help="GeoJSON of the course's features (WGS84, or EPSG:3006 with a crs member): keep only roads within --near-m of them")
    p.add_argument("--near-m", dest="near_m", type=float, default=roads.DEFAULT_NEAR_M, help=f"distance for --near in metres (default {roads.DEFAULT_NEAR_M:g})")
    p.add_argument("--no-nvdb", dest="nvdb", action="store_false", help="OSM only: skip Trafikverket NVDB widths/surfaces/missing roads even when TRAFIKVERKET_API_KEY is set")

    p = sub.add_parser("road-grades", help="fetch-roads centerlines -> one 'corridor' terrain edit per road (D-TE5 edits GeoJSON: smooth along, flat across)")
    p.add_argument("--centerlines", required=True, help="fetch-roads --centerlines-out file")
    p.add_argument("--out", required=True, help="output edits GeoJSON (WGS84 FeatureCollection, origin road-grades)")
    p.add_argument("--feather", type=float, default=roads.DEFAULT_GRADE_FEATHER_M, help=f"blend band beyond the pavement in metres (default {roads.DEFAULT_GRADE_FEATHER_M:g})")
    p.add_argument("--smooth", type=float, default=roads.DEFAULT_GRADE_SMOOTH_M, help=f"along-road smoothing window in metres (default {roads.DEFAULT_GRADE_SMOOTH_M:g})")
    p.add_argument("--classes", help="comma-separated road_class groups to grade (road,track,path; default all)")

    p = sub.add_parser("fetch-buildings", help="Query Overpass for OSM building footprints, fit rectangles, measure roof heights from lidar -> building survey GeoJSON (EPSG:3006, ODbL)")
    _add_area_args(p)
    p.add_argument("--out", required=True, help="output building survey GeoJSON (input for gspro.py buildings / building-pads)")
    p.add_argument("--lidar", nargs="*", default=[], help="LAS/LAZ/COPC files (fetch-lidar output) to measure eave/ridge heights from; omit for OSM tags only")
    p.add_argument("--resolution", type=float, default=detect_trees.DEFAULT_RESOLUTION, help=f"nDSM cell size in metres for the roof measurement (default {detect_trees.DEFAULT_RESOLUTION})")
    p.add_argument("--overpass-url", dest="overpass_url", default=osm.OVERPASS_URL, help=f"Overpass API endpoint (default {osm.OVERPASS_URL})")

    p = sub.add_parser("building-pads", help="fetch-buildings survey -> one flat 'plane' terrain edit per footprint (D-TE5 edits GeoJSON, for apply-dem-edits --edits or the server import)")
    p.add_argument("--survey", required=True, help="fetch-buildings output GeoJSON")
    p.add_argument("--out", required=True, help="output edits GeoJSON (WGS84 FeatureCollection, origin building-pads)")
    p.add_argument("--buffer", type=float, default=buildings.DEFAULT_PAD_BUFFER_M, help=f"flat apron around the footprint in metres (default {buildings.DEFAULT_PAD_BUFFER_M:g})")
    p.add_argument("--feather", type=float, default=buildings.DEFAULT_PAD_FEATHER_M, help=f"blend band outside the apron in metres (default {buildings.DEFAULT_PAD_FEATHER_M:g})")
    p.add_argument("--sloped", action="store_true", help="fit a tilted plane instead of a dead-flat pad")
    p.add_argument("--square-3006", dest="square_3006", help="x0,y0,x1,y1 EPSG:3006 metres: pads only for buildings whose footprint centre is inside this square (the inner terrain; the outer is scenery)")

    p = sub.add_parser("sculpt-tif", help="a Unity sculpt capture (golfmap-sculpt-v1 .json + .raw) -> the EPSG:3006 GeoTIFF a `delta` terrain edit adds")
    p.add_argument("--capture", required=True, help="the capture's .json (its .raw next to it)")
    p.add_argument("--out", required=True, help="output GeoTIFF")

    p = sub.add_parser("grid-dem", help="Bin classified lidar points into a regular-grid DEM GeoTIFF")
    p.add_argument("--lidar", required=True, nargs="+", help="one or more .laz/.copc.laz point cloud files")
    p.add_argument("--bbox-3006", required=True, help="e_min,n_min,e_max,n_max in EPSG:3006 metres")
    p.add_argument("--resolution", type=float, default=grid_dem_mod.DEFAULT_RESOLUTION, help="grid cell size in metres (default 0.5)")
    p.add_argument("--out", required=True, help="output DEM GeoTIFF path")
    p.add_argument(
        "--classes", default=",".join(str(c) for c in grid_dem_mod.DEFAULT_CLASSES),
        help="comma-separated classification codes to use as terrain surface (default 2,9,17 = ground,water,bridge)",
    )

    p = sub.add_parser(
        "apply-dem-edits",
        help="Replay vector terrain edits (plane-fit flatten / median smooth, feathered) onto a DEM GeoTIFF",
    )
    p.add_argument("--input", required=True, help="input DEM GeoTIFF (grid-dem output) — never modified")
    p.add_argument("--terrain", choices=("inner", "outer"), default="inner", help="which terrain's DEM this is: a shore's innerDepthM caps the inner only")
    p.add_argument(
        "--edits", required=True, action="append",
        help="edits GeoJSON FeatureCollection (WGS84; per-feature properties op/featherM/radiusM/flat, createdAt order); "
             "repeatable — e.g. the site's edits plus a building-pads file",
    )
    p.add_argument("--out", required=True, help="output edited DEM GeoTIFF path (must differ from --input)")

    p = sub.add_parser(
        "dem-analysis",
        help="Build the publishable analysis DEM: 0.5 m around greens + a 1 m background, one tiled deflate GeoTIFF",
    )
    p.add_argument(
        "--input", required=True,
        help="builder DEM GeoTIFF — dem-edited.tif when the site has terrain edits, else dem.tif",
    )
    p.add_argument("--greens", required=True, help="green polygons as a WGS84 GeoJSON FeatureCollection")
    p.add_argument("--out", required=True, help="output analysis DEM path (must differ from --input)")
    p.add_argument(
        "--green-buffer", dest="green_buffer", type=float, default=dem_analysis.DEFAULT_GREEN_BUFFER_M,
        help=f"metres of full-resolution margin around each green (default {dem_analysis.DEFAULT_GREEN_BUFFER_M:g})",
    )
    p.add_argument(
        "--coarse-factor", dest="coarse_factor", type=int, default=dem_analysis.DEFAULT_COARSE_FACTOR,
        help=f"block factor for the background (default {dem_analysis.DEFAULT_COARSE_FACTOR} = 1 m from a 0.5 m DEM)",
    )

    p = sub.add_parser("detect-trees", help="Derive tree-canopy polygons from classified lidar via nDSM -> typed GeoJSON")
    p.add_argument("--lidar", required=True, nargs="+", help="one or more .laz/.copc.laz point cloud files (from fetch-lidar)")
    p.add_argument("--bbox-3006", required=True, help="e_min,n_min,e_max,n_max in EPSG:3006 metres")
    p.add_argument(
        "--resolution", type=float, default=detect_trees.DEFAULT_RESOLUTION,
        help=f"grid cell size in metres (default {detect_trees.DEFAULT_RESOLUTION}; coarser than grid-dem so ~1-2 pts/m² lidar fills cells)",
    )
    p.add_argument(
        "--min-height", dest="min_height", type=float, default=detect_trees.DEFAULT_MIN_HEIGHT_M,
        help=f"minimum height above ground in metres to count as canopy (default {detect_trees.DEFAULT_MIN_HEIGHT_M})",
    )
    p.add_argument(
        "--min-area", dest="min_area", type=float, default=detect_trees.DEFAULT_MIN_AREA_M2,
        help=f"minimum crown polygon area in m² (default {detect_trees.DEFAULT_MIN_AREA_M2})",
    )
    p.add_argument(
        "--simplify", dest="simplify_tolerance", type=float, default=detect_trees.DEFAULT_SIMPLIFY_TOLERANCE_M,
        help=f"polygon simplification tolerance in metres (default {detect_trees.DEFAULT_SIMPLIFY_TOLERANCE_M})",
    )
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")

    p = sub.add_parser("detect-water", help="Derive water polygons from class-9 lidar returns -> typed GeoJSON")
    p.add_argument("--lidar", required=True, nargs="+", help="one or more .laz/.copc.laz point cloud files (from fetch-lidar)")
    p.add_argument("--bbox-3006", required=True, help="e_min,n_min,e_max,n_max in EPSG:3006 metres")
    p.add_argument("--resolution", type=float, default=grid_dem_mod.DEFAULT_RESOLUTION, help="grid cell size in metres (default 0.5)")
    p.add_argument(
        "--closing-radius", dest="closing_radius", type=float, default=detect_water.DEFAULT_CLOSING_RADIUS_M,
        help=f"binary-closing radius in metres bridging sparse class-9 returns (default {detect_water.DEFAULT_CLOSING_RADIUS_M})",
    )
    p.add_argument(
        "--min-area", dest="min_area", type=float, default=detect_water.DEFAULT_MIN_AREA_M2,
        help=f"minimum water polygon area in m² (default {detect_water.DEFAULT_MIN_AREA_M2} — ponds, not puddles)",
    )
    p.add_argument(
        "--simplify", dest="simplify_tolerance", type=float, default=detect_water.DEFAULT_SIMPLIFY_TOLERANCE_M,
        help=f"polygon simplification tolerance in metres (default {detect_water.DEFAULT_SIMPLIFY_TOLERANCE_M})",
    )
    p.add_argument(
        "--flatness-spread", dest="flatness_spread", type=float, default=detect_water.DEFAULT_FLATNESS_SPREAD_M,
        help=(
            "warn (report-only, never filters) when a polygon's class-9 z-spread exceeds this "
            f"many metres (default {detect_water.DEFAULT_FLATNESS_SPREAD_M})"
        ),
    )
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")

    p = sub.add_parser("horizon", help="A big lake's far shore: a low hazy ridge where its water reaches the horizon (golfmap-horizon-v1 + haze texture, for golfmap.horizon.build)")
    p.add_argument("--lake-plane", dest="lake_plane", required=True, help="<prefix>-inner-lake-plane.json (golfpipe lake-plane)")
    p.add_argument("--out", required=True, help="<prefix>-horizon.json (the texture goes next to it as .png)")
    p.add_argument("--distance", type=float, default=3900.0, help="the ridge's foot from the lake's centre (m; the planes reach 4000)")
    p.add_argument("--height-min", dest="height_min", type=float, default=30.0, help="lowest crest over the water (m)")
    p.add_argument("--height-max", dest="height_max", type=float, default=70.0, help="highest crest over the water (m)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--centre", help="x,z: the lake's centre in Unity metres, for a lake-plane file without one")

    p = sub.add_parser("lake-plane", help="A big lake's water surface (the shore edit's outline, Hydrografi beyond the squares) as Unity plane meshes for golfmap.lake.build (golfmap-lake-plane-v1)")
    p.add_argument("--shore", required=True, help="the shore-edits output (D-TE5, WGS84; its levelM is the level) or its --out-3006 file")
    p.add_argument("--hydro", help="fetch-hydro GeoJSON reaching radiusM round the course: the lake beyond the outer square")
    p.add_argument("--inner-sidecar", dest="inner_sidecar", required=True, help="inner heightmap sidecar (<prefix>-inner-dem-<side>m.tif.json): the Unity frame")
    p.add_argument("--outer-sidecar", dest="outer_sidecar", help="outer heightmap sidecar: where the shore outline stops and Hydrografi takes over")
    p.add_argument("--level", type=float, help="water level in metres (default: the shore edit's levelM)")
    p.add_argument("--name", default="Lake", help="object name prefix in Unity (default Lake): <name>_WaterPlane[_Outer|_Far|_Collider]")
    p.add_argument("--radius-m", dest="radius_m", type=float, default=lake_plane.DEFAULT_RADIUS_M, help=f"how far from the inner square's centre the water goes (default {lake_plane.DEFAULT_RADIUS_M:g}: inside GSPro's 5 km draw distance)")
    p.add_argument("--under-bank-m", dest="under_bank_m", type=float, default=lake_plane.DEFAULT_UNDER_BANK_M, help=f"how far the plane runs in under the banks (default {lake_plane.DEFAULT_UNDER_BANK_M:g})")
    p.add_argument("--near-cell-m", dest="near_cell_m", type=float, default=lake_plane.DEFAULT_NEAR_CELL_M, help=f"cell size round the course (default {lake_plane.DEFAULT_NEAR_CELL_M:g}; Gerstner waves need it fine)")
    p.add_argument("--outer-cell-m", dest="outer_cell_m", type=float, default=lake_plane.DEFAULT_OUTER_CELL_M)
    p.add_argument("--far-cell-m", dest="far_cell_m", type=float, default=lake_plane.DEFAULT_FAR_CELL_M)
    p.add_argument("--outer-sink-m", dest="outer_sink_m", type=float, default=0.0, help="how far the outer terrain sits under its sidecar position in Unity (golfmap.terrain.update's sinkM): its ground that low beside the lake is covered too")
    p.add_argument("--out", required=True, help="output JSON, by convention <export folder>/<prefix>-inner-lake-plane.json (where golfmap.lake.build looks)")

    p = sub.add_parser("shore-edits", help="A big lake's true shoreline (hydro lake corrected by each terrain's lidar ground hits) -> ONE 'shore' terrain edit (D-TE5 edits GeoJSON, WGS84)")
    p.add_argument("--hydro", required=True, help="fetch-hydro GeoJSON (EPSG:3006) for the outer square plus a margin (>= 300 m of open lake past it)")
    p.add_argument("--inner-dem", dest="inner_dem", required=True, help="inner terrain's raw lidar DEM GeoTIFF (sources/dem.tif)")
    p.add_argument("--inner-lidar", dest="inner_lidar", required=True, help="folder of the inner terrain's .laz/.copc.laz (or one file)")
    p.add_argument("--outer-dem", dest="outer_dem", required=True, help="outer terrain's DEM GeoTIFF (sources/outer-dem.tif)")
    p.add_argument("--outer-lidar", dest="outer_lidar", required=True, help="folder of the outer terrain's .laz/.copc.laz (or one file)")
    p.add_argument("--level", type=float, help="lake level in metres (default: median inner DEM over the lake shrunk by 20 m)")
    p.add_argument("--min-area-m2", dest="min_area_m2", type=float, default=shore.DEFAULT_MIN_LAKE_AREA_M2, help=f"refuse when the largest water polygon is smaller (default {shore.DEFAULT_MIN_LAKE_AREA_M2:g})")
    p.add_argument("--out", help="output edits GeoJSON (WGS84, op shore, origin shore-edits; default shore-edits.geojson next to --hydro)")
    p.add_argument("--out-3006", dest="out_3006", help="also write the polygon as EPSG:3006 GeoJSON for inspection")
    for key, default in shore.PROFILE_DEFAULTS.items():
        p.add_argument(f"--{shore.profile_flag(key)}", dest=f"profile_{key}", type=float, default=default, metavar="N", help=f"shore profile {key} (default {default:g})")

    p = sub.add_parser(
        "clean-ortho",
        help="LaMa-inpaint tree canopy + shadows (and manual-mask extras) out of the playable corridor",
    )
    p.add_argument("--ortho", required=True, help="source ortho GeoTIFF (EPSG:3006) — never overwritten")
    p.add_argument("--trees", required=True, help="trees/canopy GeoJSON (detect-trees output or exported features)")
    p.add_argument("--features", required=True, help="course-features GeoJSON defining the corridor (typed like the shared contract; EPSG:3006 or WGS84)")
    p.add_argument("--manual-mask", dest="manual_mask", help="optional extra mask GeoJSON, honored verbatim (not clipped to the corridor)")
    p.add_argument(
        "--shadow-azimuth", dest="shadow_azimuth", type=float, default=clean_ortho.DEFAULT_SHADOW_AZIMUTH_DEG,
        help=(
            "compass direction the shadows FALL TOWARD, degrees (0 = north, 90 = east; "
            f"default {clean_ortho.DEFAULT_SHADOW_AZIMUTH_DEG} — measure a tree in the source ortho)"
        ),
    )
    p.add_argument(
        "--shadow-length", dest="shadow_length", type=float, default=clean_ortho.DEFAULT_SHADOW_LENGTH_M,
        help=f"shadow offset in metres (default {clean_ortho.DEFAULT_SHADOW_LENGTH_M}; 0 disables the shadow band)",
    )
    p.add_argument(
        "--corridor-types", dest="corridor_types", default=",".join(clean_ortho.DEFAULT_CORRIDOR_TYPES),
        help=f"comma-separated feature types forming the playable corridor (default {','.join(clean_ortho.DEFAULT_CORRIDOR_TYPES)})",
    )
    p.add_argument(
        "--margin", type=float, default=clean_ortho.DEFAULT_MARGIN_M,
        help=f"mask dilation in metres (default {clean_ortho.DEFAULT_MARGIN_M})",
    )
    p.add_argument("--crop", type=int, default=512, help="inpaint crop size in pixels (default 512)")
    p.add_argument("--overlap", type=int, default=64, help="crop overlap in pixels for the feathered stitch (default 64)")
    p.add_argument("--weights", help="LaMa TorchScript checkpoint path (default: $GOLFPIPE_LAMA_WEIGHTS; see pipeline/README.md)")
    p.add_argument("--device", help="torch device (default: auto — mps if available, else cuda, else cpu; pass cpu/cuda/mps to force)")
    p.add_argument("--out", help="output GeoTIFF path (default: <ortho stem>.clean.tif alongside the source)")
    p.add_argument("--mask-out", dest="mask_out", help="optional: also write the rasterized mask as a GeoTIFF for eyeballing")
    p.add_argument(
        "--woodland",
        help="woodland-features GeoJSON (or a features export): repaint these stands as forest floor outside the corridor",
    )
    p.add_argument(
        "--keep", action="append", default=[],
        help="GeoJSON whose polygons the forest floor never paints over (repeatable; e.g. fetch-roads output)",
    )
    p.add_argument(
        "--floor-color", dest="floor_color", default="#{:02x}{:02x}{:02x}".format(*woodland_floor.DEFAULT_FLOOR_RGB),
        help="forest-floor colour for stands without their own floorColor (default %(default)s)",
    )
    p.add_argument(
        "--floor-feather", dest="floor_feather", type=float, default=woodland_floor.DEFAULT_FEATHER_M,
        help=f"metres over which the floor fades in from a stand's outline (default {woodland_floor.DEFAULT_FEATHER_M})",
    )
    p.add_argument(
        "--floor-mix", dest="floor_mix", type=float, default=woodland_floor.DEFAULT_FLOOR_MIX,
        help=f"how much of a stand's own floorColor goes into --floor-color, 0..1 (default {woodland_floor.DEFAULT_FLOOR_MIX})",
    )
    p.add_argument("--seed", type=int, default=0, help="forest-floor noise seed (default 0)")

    def _cleaned_tile_args(p):
        p.add_argument("--tiles-out", dest="tiles_out", help="the sparse ortho-sim tile tree to rewrite the changed tiles in (omit to skip retiling)")
        p.add_argument("--pristine-tiles", dest="pristine_tiles", help="read-only pristine ortho tile tree: lower-zoom parents read the children the sim tree lacks from it")
        p.add_argument("--minzoom", type=int, default=commands.DEFAULT_ORTHO_MINZOOM)
        p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_ORTHO_MAXZOOM)
        p.add_argument("--webp-quality", type=int, default=80)

    p = sub.add_parser(
        "cleaned-init",
        help="Create the site's cleaned photo (golfpipe/cleaned.py) from an ortho GeoTIFF; prints what it wrote as JSON",
    )
    p.add_argument("--ortho", required=True, help="source ortho GeoTIFF: the pristine photo, or a working raster to carry its edits over; never modified")
    p.add_argument("--square-3006", dest="square_3006", required=True, help="x0,y0,x1,y1 in EPSG:3006 metres: the inner terrain square")
    p.add_argument("--out", required=True, help="the cleaned photo to write (ortho-<collection>.cleaned.tif); must not exist")
    p.add_argument("--size", type=int, default=cleaned.CLEANED_SIZE, help=f"pixels per side (default {cleaned.CLEANED_SIZE})")

    p = sub.add_parser(
        "cleaned-replace",
        help="Make the cleaned photo show an image of the same pixel size (PNG/JPEG/TIFF, transparent parts keep the photo) and retile under what changed; prints the change as JSON",
    )
    p.add_argument("--cleaned", required=True, help="the cleaned photo, changed in place")
    p.add_argument("--image", required=True, help="the image to take; read, never changed")
    _cleaned_tile_args(p)

    p = sub.add_parser(
        "cleaned-patch",
        help="Write rectangles of raw RGBA pixels into the cleaned photo and retile under them; prints counts as JSON",
    )
    p.add_argument("--cleaned", required=True, help="the cleaned photo, changed in place")
    p.add_argument("--patches-dir", dest="patches_dir", required=True, help="directory with patches.json ([{x, y, w, h, file}]) and the raw RGBA files it names")
    _cleaned_tile_args(p)

    p = sub.add_parser("cleaned-export", help="Write the cleaned photo as a PNG, a JPEG or raw RGB bytes; prints the file as JSON")
    p.add_argument("--cleaned", required=True, help="the cleaned photo")
    p.add_argument("--out", required=True, help="the image file to write")
    p.add_argument("--format", dest="format", choices=cleaned.EXPORT_FORMATS, default="png", help="png (lossless; default), jpg (q95) or rgb (raw bytes, 3 per pixel)")

    p = sub.add_parser(
        "cleanup-hole",
        help="Paint trees, shadows, players and paths out of one hole of a working copy of the cleaned photo "
             "(golfpipe/hole_cleanup.py); writes the hole's review files and prints its result as JSON",
    )
    p.add_argument("--work", required=True, help="working copy of the cleaned photo (GeoTIFF), changed in place")
    p.add_argument("--features", required=True, help="the course's features: GeoJSON (WGS84) with properties.type and properties.hole")
    p.add_argument("--areas", required=True, help="the site's cleanup areas as stored: JSON [{kind, ring}] (WGS84)")
    p.add_argument("--hole", type=int, required=True, help="hole number")
    p.add_argument("--region", help="the hole's saved map view (JSON {center, span}); omit for the box round its own features")
    p.add_argument("--out", required=True, help="folder for the hole's files (photo/filled/changed/review/detect/overlay .png, hole.json)")
    p.add_argument("--weights", help="LaMa TorchScript checkpoint path (default: $GOLFPIPE_LAMA_WEIGHTS)")
    p.add_argument("--device", help="torch device (default: auto)")
    p.add_argument("--photocraft", help="photocraft-cli executable (default: $GOLFPIPE_PHOTOCRAFT_CLI, else ../crafts/photocraft beside golf-map); 'none' fills every surface with LaMa")

    p = sub.add_parser(
        "cleanup-compose",
        help="The accepted holes' changed pixels as one transparent PNG of the photo's size, for cleaned-replace; prints it as JSON",
    )
    p.add_argument("--job", required=True, help="the cleanup job folder (its h<n>/ folders)")
    p.add_argument("--holes", required=True, help="comma-separated hole numbers, in the order they were cleaned")
    p.add_argument("--size", type=int, default=cleaned.CLEANED_SIZE, help=f"pixels per side (default {cleaned.CLEANED_SIZE})")
    p.add_argument("--out", required=True, help="the RGBA PNG to write")

    p = sub.add_parser("tile-ortho", help="Tile an orthophoto GeoTIFF into an XYZ WebP pyramid")
    p.add_argument("--input", required=True, help="input orthophoto GeoTIFF (any CRS)")
    p.add_argument("--out", required=True, help="output tile directory")
    p.add_argument("--minzoom", type=int, default=commands.DEFAULT_ORTHO_MINZOOM)
    p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_ORTHO_MAXZOOM)
    p.add_argument("--webp-quality", type=int, default=80)

    p = sub.add_parser("tile-terrain", help="Tile a DEM GeoTIFF into a Terrain-RGB XYZ PNG pyramid")
    p.add_argument("--input", required=True, help="input DEM GeoTIFF (any CRS)")
    p.add_argument("--out", required=True, help="output tile directory")
    p.add_argument("--minzoom", type=int, default=commands.DEFAULT_TERRAIN_MINZOOM)
    p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_TERRAIN_MAXZOOM)
    p.add_argument(
        "--fill-nodata",
        dest="fill_nodata",
        action="store_true",
        default=True,
        help="Inpaint interior nodata holes via rasterio.fill.fillnodata before tiling (default: on)",
    )
    p.add_argument(
        "--no-fill-nodata",
        dest="fill_nodata",
        action="store_false",
        help="Disable interior nodata inpainting; 0-fill all nodata (old behavior)",
    )
    p.add_argument(
        "--edge-pad",
        dest="edge_pad_m",
        type=float,
        default=commands.DEFAULT_TERRAIN_EDGE_PAD_M,
        help=(
            "Metres to pre-pad the DEM by (edge-replicated heights) before tiling, so "
            "boundary/overlap tiles beyond real DEM coverage don't get 0-filled into a "
            "cliff wall (default 250; pass 0 to restore the old 0-fill-everywhere behavior)"
        ),
    )

    p = sub.add_parser("tile-hillshade", help="Render an opaque QGIS-style hillshade from a DEM and tile it (WebP)")
    p.add_argument("--input", required=True, help="input DEM GeoTIFF (EPSG:3006)")
    p.add_argument("--out", required=True, help="output tile directory")
    p.add_argument("--minzoom", type=int, default=commands.DEFAULT_HILLSHADE_MINZOOM)
    p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_HILLSHADE_MAXZOOM)
    p.add_argument("--azimuth", type=float, default=315.0, help="light azimuth degrees (default 315, QGIS default)")
    p.add_argument("--altitude", type=float, default=45.0, help="light altitude degrees (default 45)")
    p.add_argument("--z-factor", dest="z_factor", type=float, default=1.0, help="vertical exaggeration (default 1)")

    p = sub.add_parser("canopy", help="Lidar -> canopy height, canopy-color and surface (DSM) tile pyramids + manifest update")
    p.add_argument("--lidar", required=True, action="append", help="a .laz/.copc.laz point cloud (repeatable)")
    p.add_argument("--dem", help="ground DEM GeoTIFF; used for surface = DEM + canopy, and as the area when no --bbox/--aoi")
    p.add_argument("--course-id", dest="course_id", required=True, help="course id written to manifest.json")
    p.add_argument("--tiles-dir", dest="tiles_dir", required=True, help="data/tiles/<courseId>; canopy/, canopy-color/, surface/ are written under it")
    p.add_argument("--workdir", required=True, help="directory for canopy.tif / surface.tif intermediates")
    area = p.add_mutually_exclusive_group(required=False)
    area.add_argument("--bbox", help="west,south,east,north in WGS84 degrees (default: the --dem extent)")
    area.add_argument("--aoi", help="GeoJSON file (WGS84); its bbox is used")
    p.add_argument("--minzoom", type=int, default=commands.DEFAULT_TERRAIN_MINZOOM)
    p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_TERRAIN_MAXZOOM)
    p.add_argument(
        "--surface-shape", dest="surface_shape", choices=("crown", "flat"), default="crown",
        help="surface DSM canopy: 'crown' tapers/blurs plateaus into crown shapes (default), 'flat' adds the cleaned canopy as is",
    )
    p.add_argument(
        "--trees-out", dest="trees_out",
        help="also write trees-features GeoJSON (tree polygons from the same cleaned canopy grid, default thresholds)",
    )
    p.add_argument(
        "--min-hole-area", dest="min_hole_area", type=float, default=trees_features.DEFAULT_MIN_HOLE_AREA_M2,
        help=f"with --trees-out: fill interior rings (clearings) under this area in m² (default {trees_features.DEFAULT_MIN_HOLE_AREA_M2}; 0 = keep all)",
    )
    p.add_argument(
        "--woodland-out", dest="woodland_out",
        help="also write woodland-features GeoJSON (woodland-floor stands from the same grid, default thresholds)",
    )
    p.add_argument(
        "--roofs-out", dest="roofs_out",
        help="also write the roof heights GeoTIFF (m above ground on roof cells) for gspro.py ortho --remove-buildings",
    )
    p.add_argument(
        "--woodland-ortho", dest="woodland_ortho",
        help="with --woodland-out: RGB ortho GeoTIFF (EPSG:3006) to sample each stand's floor colour from",
    )

    p = sub.add_parser(
        "trees-features",
        help="Tree polygons (GeoJSON, EPSG:3006) from the cleaned canopy grid the canopy command tiles",
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--canopy-tif", dest="canopy_tif", help="canopy.tif from a canopy --workdir (cleaned canopy heights, m AGL)")
    p.add_argument(
        "--roof-tif", dest="roof_tif",
        help=f"roof.tif from the same canopy --workdir (roof-suppressed cells); with it polygons under "
             f"{trees_features.ROOF_GUARD_AREA_M2:g} m² are kept when no roof cell is within {trees_features.ROOF_GUARD_M:g} m, "
             "without it they are dropped (--lidar builds the mask itself)",
    )
    src.add_argument("--lidar", action="append", help="a .laz/.copc.laz point cloud (repeatable); counts returns per cell, trees and roofs from the canopy grid `canopy` builds")
    p.add_argument("--dem", help="ground DEM GeoTIFF; with --lidar its extent is the area when no --bbox is given")
    p.add_argument("--course-id", dest="course_id", help="course id written as a top-level courseId member")
    p.add_argument("--out", required=True, help="output GeoJSON path")
    p.add_argument(
        "--min-height", dest="min_height", type=float, default=trees_features.DEFAULT_MIN_HEIGHT_M,
        help=f"canopy height in metres a cell needs to count as trees (default {trees_features.DEFAULT_MIN_HEIGHT_M})",
    )
    p.add_argument(
        "--min-area", dest="min_area", type=float, default=trees_features.DEFAULT_MIN_AREA_M2,
        help=f"minimum polygon area in m² (default {trees_features.DEFAULT_MIN_AREA_M2}; under "
             f"{trees_features.ROOF_GUARD_AREA_M2:g} m² needs the roof mask, see --roof-tif)",
    )
    p.add_argument(
        "--min-hole-area", dest="min_hole_area", type=float, default=trees_features.DEFAULT_MIN_HOLE_AREA_M2,
        help=f"fill interior rings (clearings) under this area in m² (default {trees_features.DEFAULT_MIN_HOLE_AREA_M2}; 0 = keep all)",
    )
    p.add_argument(
        "--close", type=float, default=trees_features.DEFAULT_CLOSE_M,
        help=f"binary closing radius in metres on the canopy mask, bridges gaps narrower than 2x this (default {trees_features.DEFAULT_CLOSE_M}; 0 = off)",
    )
    p.add_argument(
        "--round", type=float, default=trees_features.DEFAULT_ROUND_M,
        help=f"outline rounding radius in metres: buffer close/open + Chaikin corner cutting (default {trees_features.DEFAULT_ROUND_M}; 0 = keep cell outlines)",
    )
    p.add_argument(
        "--simplify", type=float, default=trees_features.DEFAULT_SIMPLIFY_M,
        help=f"polygon simplification tolerance in metres, applied after rounding (default {trees_features.DEFAULT_SIMPLIFY_M})",
    )
    p.add_argument(
        "--source-ref", dest="source_ref",
        help="properties.source_ref (default: canopy tif basename, or comma-joined lidar basenames)",
    )
    p.add_argument("--bbox", help="e_min,n_min,e_max,n_max in EPSG:3006 metres to clip to (default: raster / DEM extent)")
    p.add_argument(
        "--resolution", type=float, default=detect_trees.DEFAULT_RESOLUTION,
        help=f"grid cell size in metres when gridding from --lidar (default {detect_trees.DEFAULT_RESOLUTION})",
    )

    p = sub.add_parser(
        "lowveg-features",
        help="Shrub-zone proposals (vegetation_zone GeoJSON, EPSG:3006): with --lidar, cells whose returns "
             "between --min-height and --max-height above ground reach --min-points, away from trees and roofs; "
             "with --canopy-tif, the cleaned canopy grid's cells in that band (never under 1 m)",
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--canopy-tif", dest="canopy_tif", help="canopy.tif from a canopy --workdir (cleaned canopy heights, m AGL)")
    src.add_argument("--lidar", action="append", help="a .laz/.copc.laz point cloud (repeatable); grids the canopy as `canopy` does")
    p.add_argument("--dem", help="ground DEM GeoTIFF; with --lidar its extent is the area when no --bbox is given")
    p.add_argument("--course-id", dest="course_id", help="course id written as a top-level courseId member")
    p.add_argument("--out", required=True, help="output GeoJSON path")
    p.add_argument(
        "--trees", help="trees GeoJSON (trees-features output, EPSG:3006) to cut out of the proposals, buffered by --tree-buffer",
    )
    p.add_argument(
        "--tree-buffer", dest="tree_buffer", type=float, default=lowveg_features.DEFAULT_TREE_BUFFER_M,
        help=f"metres around a tree polygon or an above-max-height cell that never count as low vegetation (default {lowveg_features.DEFAULT_TREE_BUFFER_M})",
    )
    p.add_argument(
        "--min-height", dest="min_height", type=float, default=lowveg_features.DEFAULT_MIN_HEIGHT_M,
        help=f"lowest canopy height in metres that counts as low vegetation (default {lowveg_features.DEFAULT_MIN_HEIGHT_M})",
    )
    p.add_argument(
        "--max-height", dest="max_height", type=float, default=lowveg_features.DEFAULT_MAX_HEIGHT_M,
        help=f"highest; anything above is a tree (default {lowveg_features.DEFAULT_MAX_HEIGHT_M})",
    )
    p.add_argument(
        "--min-area", dest="min_area", type=float, default=lowveg_features.DEFAULT_MIN_AREA_M2,
        help=f"minimum polygon area in m² (default {lowveg_features.DEFAULT_MIN_AREA_M2})",
    )
    p.add_argument(
        "--min-hole-area", dest="min_hole_area", type=float, default=lowveg_features.DEFAULT_MIN_HOLE_AREA_M2,
        help=f"fill interior rings under this area in m² (default {lowveg_features.DEFAULT_MIN_HOLE_AREA_M2}; 0 = keep all)",
    )
    p.add_argument(
        "--close", type=float, default=lowveg_features.DEFAULT_CLOSE_M,
        help=f"binary closing radius in metres on the mask (default {lowveg_features.DEFAULT_CLOSE_M}; 0 = off)",
    )
    p.add_argument(
        "--round", type=float, default=lowveg_features.DEFAULT_ROUND_M,
        help=f"outline rounding radius in metres, as trees-features (default {lowveg_features.DEFAULT_ROUND_M}; 0 = keep cell outlines)",
    )
    p.add_argument(
        "--simplify", type=float, default=lowveg_features.DEFAULT_SIMPLIFY_M,
        help=f"polygon simplification tolerance in metres (default {lowveg_features.DEFAULT_SIMPLIFY_M})",
    )
    p.add_argument(
        "--source-ref", dest="source_ref",
        help="properties.source_ref (default: canopy tif basename, or comma-joined lidar basenames)",
    )
    p.add_argument(
        "--min-points", dest="min_points", type=int, default=lowveg_features.DEFAULT_MIN_POINTS,
        help=f"with --lidar: returns in the height band over a cell's 3x3 neighbourhood to count as low vegetation (default {lowveg_features.DEFAULT_MIN_POINTS})",
    )
    p.add_argument(
        "--roof-buffer", dest="roof_buffer", type=float, default=lowveg_features.DEFAULT_ROOF_BUFFER_M,
        help=f"with --lidar: metres around a roof where nothing is proposed; garden objects read as shrubs (default {lowveg_features.DEFAULT_ROOF_BUFFER_M}; 0 = roofs only)",
    )
    p.add_argument("--bbox", help="e_min,n_min,e_max,n_max in EPSG:3006 metres to clip to (default: raster / DEM extent)")
    p.add_argument(
        "--resolution", type=float, default=detect_trees.DEFAULT_RESOLUTION,
        help=f"grid cell size in metres when gridding from --lidar (default {detect_trees.DEFAULT_RESOLUTION})",
    )

    p = sub.add_parser(
        "woodland-features",
        help="Woodland-floor zone proposals (vegetation_zone GeoJSON, EPSG:3006): one polygon per closed stand "
             "of the cleaned canopy grid, weight from understory returns (--lidar), floor colour from --ortho",
    )
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--canopy-tif", dest="canopy_tif", help="canopy.tif from a canopy --workdir (cleaned canopy heights, m AGL)")
    src.add_argument("--lidar", action="append", help="a .laz/.copc.laz point cloud (repeatable); grids the canopy as `canopy` does")
    p.add_argument("--dem", help="ground DEM GeoTIFF; with --lidar its extent is the area when no --bbox is given")
    p.add_argument("--roof-tif", dest="roof_tif", help="with --canopy-tif: roof.tif from the same canopy workdir")
    p.add_argument("--ortho", help="RGB ortho GeoTIFF in EPSG:3006 to sample each stand's floor colour from (the one clean-ortho will clean)")
    p.add_argument("--course-id", dest="course_id", help="course id written as a top-level courseId member")
    p.add_argument("--out", required=True, help="output GeoJSON path")
    wf = woodland_features
    for flag, dest, default, text in (
        ("--min-height", "min_height", wf.DEFAULT_MIN_HEIGHT_M, "canopy height in metres a cell needs to count as tree cover"),
        ("--close", "close", wf.DEFAULT_CLOSE_M, "closing radius in metres; crowns up to about twice this apart join one stand"),
        ("--min-area", "min_area", wf.DEFAULT_MIN_AREA_M2, "smallest stand in m²"),
        ("--min-hole-area", "min_hole_area", wf.DEFAULT_MIN_HOLE_AREA_M2, "fill clearings under this area in m²"),
        ("--edge", "edge", wf.DEFAULT_EDGE_M, "metres the floor runs out past the outermost crowns"),
        ("--min-cover", "min_cover", wf.DEFAULT_MIN_COVER, "least canopy cover (0..1) inside a stand"),
        ("--roof-buffer", "roof_buffer", wf.DEFAULT_ROOF_BUFFER_M, "metres around a roof that are never woodland"),
        ("--round", "round", wf.DEFAULT_ROUND_M, "outline rounding radius in metres"),
        ("--simplify", "simplify", wf.DEFAULT_SIMPLIFY_M, "polygon simplification tolerance in metres"),
        ("--min-weight", "min_weight", wf.DEFAULT_MIN_WEIGHT, "with --lidar: the weight of a stand without understory"),
    ):
        p.add_argument(flag, dest=dest, type=float, default=default, help=f"{text} (default {default})")
    p.add_argument(
        "--source-ref", dest="source_ref",
        help="properties.source_ref (default: canopy tif basename, or comma-joined lidar basenames)",
    )
    p.add_argument("--bbox", help="e_min,n_min,e_max,n_max in EPSG:3006 metres to clip to (default: raster / DEM extent)")
    p.add_argument(
        "--resolution", type=float, default=detect_trees.DEFAULT_RESOLUTION,
        help=f"grid cell size in metres when gridding from --lidar (default {detect_trees.DEFAULT_RESOLUTION})",
    )

    p = sub.add_parser("trees-stems", help="Individual crown maxima from lidar, GeoJSON and compact tree-stems asset")
    p.add_argument("--lidar", action="append", required=True)
    p.add_argument("--out", required=True, help="output EPSG:3006 GeoJSON")
    p.add_argument("--tiles-dir", required=True)
    p.add_argument("--course-id", required=True)
    p.add_argument("--bbox", help="e_min,n_min,e_max,n_max in EPSG:3006")
    p.add_argument("--dem", help="DEM extent when --bbox is omitted")
    p.add_argument("--resolution", type=float, default=1.0)
    p.add_argument("--workdir", help="optional scratch directory for suppressed nDSM and ground rasters")
    p.add_argument(
        "--min-height", type=float, default=trees_stems.DEFAULT_MIN_HEIGHT_M,
        help=f"nDSM height in metres a cell needs to join a crown (default {trees_stems.DEFAULT_MIN_HEIGHT_M})",
    )
    p.add_argument(
        "--min-area", type=float, default=trees_stems.DEFAULT_MIN_AREA_M2,
        help=f"segmented support in m² for crowns under --tall-height (default {trees_stems.DEFAULT_MIN_AREA_M2})",
    )
    p.add_argument(
        "--tall-height", type=float, default=trees_stems.TALL_HEIGHT_M,
        help=f"crown top in metres from which --tall-min-area applies (default {trees_stems.TALL_HEIGHT_M})",
    )
    p.add_argument(
        "--tall-min-area", type=float, default=trees_stems.TALL_MIN_AREA_M2,
        help=f"segmented support in m² for crowns at or above --tall-height (default {trees_stems.TALL_MIN_AREA_M2}; "
             f"under {trees_stems.ROOF_GUARD_AREA_M2:g} m² a crown must also be more than {trees_stems.ROOF_GUARD_M:g} m from a roof-suppressed cell)",
    )
    p.add_argument(
        "--leaf-off-ortho",
        help="XYZ webp pyramid the crown kind is read from (default: newest Oct-Apr vintage in the tiles-dir manifest)",
    )
    p.add_argument("--no-kind", action="store_true", help="skip crown kind; every stem is written as unknown")
    p.add_argument("--tile-m", type=float, default=commands.DEFAULT_TREES_TILE_M, dest="tile_m",
                   help="detect in parallel on tiles of about this side in metres (default 0 = whole box in one process; "
                        "tiling re-reads the lidar per tile, so it only pays on very large or dense boxes)")
    p.add_argument("--workers", type=int, help="processes for tiled detection (default: every core)")

    p = sub.add_parser("photo-stems", help="Young trees the lidar missed on open ground, found from their shadows in the summer photo (golfmap-photo-stems-v1)")
    p.add_argument("--summer-ortho", required=True, help="leaf-on ortho GeoTIFF (EPSG:3006) the shadows are read from")
    p.add_argument("--leaf-off-ortho", help="leaf-off ortho GeoTIFF the kind is read from (default: every proposal unknown)")
    p.add_argument("--stems", required=True, help="the site's lidar tree-stems asset (v2)")
    p.add_argument("--features", required=True, help="the course's features: JSON list of {type, source, attributes, geometry}")
    p.add_argument("--out", required=True, help="output golfmap-photo-stems-v1 JSON")
    p.add_argument("--known", help="the accepted photo stems asset (tree-stems-photo.json): its accepted and skipped stems are left out")
    p.add_argument("--dem", help="DEM GeoTIFF (EPSG:3006) each proposal's groundM is read from")
    p.add_argument("--lidar-size-factor", dest="lidar_size_factor", type=float, default=1.0,
                   help="the course's trees.lidarSizeFactor: calibrate against the lidar stems at the size the trees export plants them (default 1)")
    vegetation_rules.add_overrides_flag(p)

    p = sub.add_parser("rock-candidates", help="Boulders standing on the ground, found in the lidar and ranked with the course's ortho vintages")
    p.add_argument("--lidar", action="append", required=True)
    p.add_argument("--out", required=True, help="output EPSG:3006 GeoJSON, best candidates first")
    p.add_argument("--bbox", help="e_min,n_min,e_max,n_max in EPSG:3006")
    p.add_argument("--dem", help="DEM extent when --bbox is omitted")
    p.add_argument("--tiles-dir", help="course tiles directory: every ortho vintage in its manifest is used (default: lidar alone)")
    p.add_argument("--ortho", action="append", default=[], metavar="NAME=DIR",
                   help="another XYZ webp pyramid to look in, repeatable")
    p.add_argument("--known", action="append", default=[],
                   help="golfmap-walls-v1 spec (stone-walls.json) whose boulders are already placed, repeatable")
    p.add_argument("--buildings", help="fetch-buildings survey: candidates on a footprint are dropped")
    p.add_argument("--near", help="GeoJSON of the course's features (WGS84, or EPSG:3006 with a crs member): keep only candidates within --near-m of them")
    p.add_argument("--near-m", dest="near_m", type=float, default=35.0, help="distance for --near in metres (default 35)")
    p.add_argument("--resolution", type=float, default=1.0)

    p = sub.add_parser("manifest", help="Write manifest.json for a tiled course")
    p.add_argument("--course", required=True, help="course id")
    p.add_argument("--tiles-dir", required=True, help="directory containing ortho/, terrain/ and hillshade/ subdirs")
    p.add_argument("--dem", help="path to dem.tif, used to compute elevation range and bounds")
    p.add_argument("--out", help="output manifest.json path (default: <tiles-dir>/manifest.json)")

    p = sub.add_parser("install", help="Copy tiles+manifest into data/tiles/{courseId}/... and print register payloads")
    p.add_argument("--course", required=True, help="course id")
    p.add_argument("--ortho", help="ortho tile directory to install")
    p.add_argument("--terrain", help="terrain tile directory to install")
    p.add_argument("--hillshade", help="hillshade tile directory to install")
    p.add_argument("--manifest", help="manifest.json to install")
    p.add_argument("--data-dir", required=True, help="server data directory (contains tiles/)")
    p.add_argument("--api-url", help="optional: POST register payloads to this API base URL")
    p.add_argument("--cookie", help="optional: session Cookie header to send with --api-url")

    p = sub.add_parser("bbox-from-course", help="Compute a WGS84 bbox from a course's tees/greens/aim_points")
    p.add_argument("--db", required=True, help="path to server sqlite DB (read-only)")
    p.add_argument("--course", required=True, help="course id")
    p.add_argument("--buffer", type=float, default=250.0, help="buffer in metres (default 250)")

    p = sub.add_parser("reproject-bbox", help="Reproject a WGS84 bbox to another CRS; prints e_min,n_min,e_max,n_max")
    _add_area_args(p)
    p.add_argument("--to", type=int, default=3006, help="target EPSG code (default 3006 = SWEREF99 TM, metres)")

    return parser


def _load_dotenv() -> None:
    """Load KEY=VALUE lines from the nearest .env (cwd upward, 3 levels).

    Stdlib-only; already-set environment variables win over .env values.
    """
    import os

    d = Path.cwd()
    for _ in range(4):
        f = d / ".env"
        if f.is_file():
            for line in f.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip().strip("'\"")
                if key and value and key not in os.environ:
                    os.environ[key] = value
            return
        d = d.parent


def main(argv: list[str] | None = None) -> int:
    _load_dotenv()
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "fetch-dem":
            bbox = _resolve_area(args)
            commands.cmd_fetch_dem(bbox, Path(args.workdir), Path(args.out), buffer_m=args.buffer, items=sources.parse_items_arg(args.items))

        elif args.command == "fetch-ortho":
            bbox = _resolve_area(args)
            commands.cmd_fetch_ortho(bbox, Path(args.workdir), Path(args.out), buffer_m=args.buffer, collection=args.collection, items=sources.parse_items_arg(args.items))

        elif args.command == "fetch-nir":
            ortho = Path(args.ortho)
            report = nir_mod.fetch_nir(ortho, args.collection, [Path(d) for d in args.tile_dir],
                                       Path(args.workdir) if args.workdir else ortho.parent / "nir-work",
                                       allow_download=not args.no_download)
            print(f"wrote {report['out']} from {len(report['items'])} item(s), {report['downloaded']} downloaded; "
                  f"RGB check {report['rgbCheck']:.2f}")
            print(json.dumps(report))

        elif args.command in ("surfaces-predict", "propose-bunkers"):
            ortho = Path(args.ortho)
            nir = Path(args.nir) if args.nir else nir_mod.nir_path(ortho)
            if not nir.exists():
                raise surface_model.SurfaceModelError(f"{nir} is missing: run fetch-nir for {ortho.name} first")
            dem, model = Path(args.dem), Path(args.model)
            surfaces = Path(args.out if args.command == "surfaces-predict" else args.surfaces)
            if getattr(args, "force", False) or not surface_model.is_current(surfaces, ortho, nir, dem, model):
                rep = surface_model.predict(ortho, nir, dem, model, surfaces, device=args.device)
                print(f"surfaces: {rep['width']}x{rep['height']} px on {rep['device']} in {rep['seconds']} s")
            else:
                print(f"surfaces: {surfaces.name} is current")
            if args.command == "propose-bunkers":
                fc = bunker_proposals.propose(surfaces, ortho, nir,
                                              bunker_proposals.load_known(Path(args.known) if args.known else None),
                                              min_area_m2=args.min_area)
                Path(args.out).parent.mkdir(parents=True, exist_ok=True)
                Path(args.out).write_text(json.dumps(fc))
                sk = fc["skipped"]
                print(f"{len(fc['features'])} bunker proposal(s); left out: {sk['drawn']} already drawn, "
                      f"{sk['notCourse']} not course, {sk['small']} small")
                print(json.dumps({"proposals": len(fc["features"]), "skipped": sk}))

        elif args.command == "list-ortho-vintages":
            bbox = _resolve_area(args)
            commands.cmd_list_ortho_vintages(bbox)

        elif args.command == "fetch-lidar":
            bbox = _resolve_area(args)
            out_dir = args.out_dir or args.workdir
            if not out_dir:
                parser.error("fetch-lidar requires --out-dir (or --workdir)")
            commands.cmd_fetch_lidar(bbox, Path(out_dir), Path(out_dir), items=sources.parse_items_arg(args.items),
                                     skip_forbidden=args.skip_forbidden)

        elif args.command == "fetch-water":
            bbox = _resolve_area(args)
            commands.cmd_fetch_water(bbox, Path(args.workdir), Path(args.out), creek_width_m=args.creek_width)

        elif args.command == "fetch-hydro":
            bbox = _resolve_area(args)
            commands.cmd_fetch_hydro(bbox, Path(args.out), creek_width_m=args.creek_width,
                                     square_3006=_parse_square_3006(parser, args.square_3006))

        elif args.command == "fetch-osm":
            bbox = _resolve_area(args)
            commands.cmd_fetch_osm(bbox, Path(args.out), overpass_url=args.overpass_url)

        elif args.command == "fetch-roads":
            bbox = _resolve_area(args)
            class_widths: dict[str, float] = {}
            for spec in args.class_width:
                name, sep, value = spec.partition("=")
                try:
                    metres = float(value)
                except ValueError:
                    metres = float("nan")
                if not sep or not name or not metres > 0:
                    parser.error(f"--class-width expects CLASS=METRES, got {spec!r}")
                class_widths[name.strip()] = metres
            commands.cmd_fetch_roads(
                bbox, Path(args.out), overpass_url=args.overpass_url, class_widths=class_widths or None,
                clip=args.clip, simplify_m=args.simplify, min_area_m2=args.min_area,
                centerlines_out=Path(args.centerlines_out) if args.centerlines_out else None,
                merge=args.merge,
                near_path=Path(args.near) if args.near else None, near_m=args.near_m,
                nvdb_key=os.environ.get("TRAFIKVERKET_API_KEY") or None if args.nvdb else None,
                square_3006=_parse_square_3006(parser, args.square_3006),
            )

        elif args.command == "road-grades":
            commands.cmd_road_grades(
                Path(args.centerlines), Path(args.out), feather_m=args.feather, smooth_m=args.smooth,
                classes={c.strip() for c in args.classes.split(",") if c.strip()} if args.classes else None,
            )

        elif args.command == "fetch-buildings":
            bbox = _resolve_area(args)
            commands.cmd_fetch_buildings(
                bbox, Path(args.out), lidar_paths=[Path(p) for p in args.lidar] or None,
                overpass_url=args.overpass_url, resolution=args.resolution,
            )

        elif args.command == "grid-dem":
            bbox_3006 = tuple(float(v) for v in args.bbox_3006.split(","))
            if len(bbox_3006) != 4:
                parser.error("--bbox-3006 must have 4 comma-separated values (e_min,n_min,e_max,n_max)")
            classes = tuple(int(v) for v in args.classes.split(","))
            commands.cmd_grid_dem(
                [Path(p) for p in args.lidar], bbox_3006, Path(args.out),
                resolution=args.resolution, classes=classes,
            )

        elif args.command == "apply-dem-edits":
            commands.cmd_apply_dem_edits(Path(args.input), [Path(p) for p in args.edits], Path(args.out), terrain=args.terrain)

        elif args.command == "sculpt-tif":
            from golfpipe import sculpt as sculpt_mod
            meta = sculpt_mod.capture_to_geotiff(Path(args.capture), Path(args.out))
            print(f"Sculpt layer: {meta['cells']} cell(s), {meta['areaM2']} m², +{meta['maxRaiseM']} / {meta['maxLowerM']} m")
            print("bounds3006 " + ",".join(str(v) for v in meta["bounds3006"]))
            print(f"Wrote {args.out}")

        elif args.command == "building-pads":
            commands.cmd_building_pads(
                Path(args.survey), Path(args.out), buffer_m=args.buffer, feather_m=args.feather, flat=not args.sloped,
                square_3006=_parse_square_3006(parser, args.square_3006),
            )

        elif args.command == "dem-analysis":
            commands.cmd_dem_analysis(
                Path(args.input), Path(args.greens), Path(args.out),
                buffer_m=args.green_buffer, coarse_factor=args.coarse_factor,
            )

        elif args.command == "detect-trees":
            bbox_3006 = tuple(float(v) for v in args.bbox_3006.split(","))
            if len(bbox_3006) != 4:
                parser.error("--bbox-3006 must have 4 comma-separated values (e_min,n_min,e_max,n_max)")
            commands.cmd_detect_trees(
                [Path(p) for p in args.lidar], bbox_3006, Path(args.out),
                resolution=args.resolution,
                min_height_m=args.min_height,
                min_area_m2=args.min_area,
                simplify_tolerance_m=args.simplify_tolerance,
            )

        elif args.command == "detect-water":
            bbox_3006 = tuple(float(v) for v in args.bbox_3006.split(","))
            if len(bbox_3006) != 4:
                parser.error("--bbox-3006 must have 4 comma-separated values (e_min,n_min,e_max,n_max)")
            commands.cmd_detect_water(
                [Path(p) for p in args.lidar], bbox_3006, Path(args.out),
                resolution=args.resolution,
                closing_radius_m=args.closing_radius,
                min_area_m2=args.min_area,
                simplify_tolerance_m=args.simplify_tolerance,
                flatness_spread_m=args.flatness_spread,
            )

        elif args.command == "horizon":
            from golfpipe.horizon import cmd_horizon
            cmd_horizon(Path(args.lake_plane), Path(args.out), args.distance, (args.height_min, args.height_max), args.seed,
                        tuple(float(v) for v in args.centre.split(",")) if args.centre else None)

        elif args.command == "lake-plane":
            commands.cmd_lake_plane(
                Path(args.shore), Path(args.hydro) if args.hydro else None, Path(args.inner_sidecar),
                Path(args.outer_sidecar) if args.outer_sidecar else None, Path(args.out),
                level=args.level, name=args.name, radius_m=args.radius_m, under_bank_m=args.under_bank_m,
                near_cell_m=args.near_cell_m, outer_cell_m=args.outer_cell_m, far_cell_m=args.far_cell_m,
                outer_sink_m=args.outer_sink_m,
            )

        elif args.command == "shore-edits":
            hydro_path = Path(args.hydro)
            commands.cmd_shore_edits(
                hydro_path, Path(args.inner_dem), Path(args.inner_lidar), Path(args.outer_dem), Path(args.outer_lidar),
                Path(args.out) if args.out else hydro_path.with_name("shore-edits.geojson"),
                out_3006=Path(args.out_3006) if args.out_3006 else None,
                level=args.level, min_area_m2=args.min_area_m2,
                profile={key: getattr(args, f"profile_{key}") for key in shore.PROFILE_DEFAULTS},
            )

        elif args.command == "clean-ortho":
            corridor_types = tuple(t.strip() for t in args.corridor_types.split(",") if t.strip())
            if not corridor_types:
                parser.error("--corridor-types must name at least one feature type")
            commands.cmd_clean_ortho(
                Path(args.ortho), Path(args.trees), Path(args.features),
                out=Path(args.out) if args.out else None,
                manual_mask_path=Path(args.manual_mask) if args.manual_mask else None,
                shadow_azimuth_deg=args.shadow_azimuth,
                shadow_length_m=args.shadow_length,
                corridor_types=corridor_types,
                margin_m=args.margin,
                crop_size=args.crop,
                overlap=args.overlap,
                weights=args.weights,
                device=args.device,
                mask_out=Path(args.mask_out) if args.mask_out else None,
                woodland_path=Path(args.woodland) if args.woodland else None,
                keep_paths=[Path(k) for k in args.keep],
                floor_color=args.floor_color,
                floor_feather_m=args.floor_feather,
                floor_mix=args.floor_mix,
                seed=args.seed,
            )

        elif args.command == "cleaned-init":
            try:
                square = tuple(float(v) for v in args.square_3006.split(","))
            except ValueError:
                square = ()
            if len(square) != 4:
                parser.error("--square-3006 must be x0,y0,x1,y1 in EPSG:3006 metres")
            cleaned.cmd_cleaned_init(Path(args.ortho), square, Path(args.out), size=args.size)

        elif args.command == "cleaned-replace":
            cleaned.cmd_cleaned_replace(
                Path(args.cleaned), Path(args.image),
                tiles_out=Path(args.tiles_out) if args.tiles_out else None,
                pristine_tiles=Path(args.pristine_tiles) if args.pristine_tiles else None,
                minzoom=args.minzoom, maxzoom=args.maxzoom, webp_quality=args.webp_quality,
            )

        elif args.command == "cleaned-patch":
            cleaned.cmd_cleaned_patch(
                Path(args.cleaned), Path(args.patches_dir),
                tiles_out=Path(args.tiles_out) if args.tiles_out else None,
                pristine_tiles=Path(args.pristine_tiles) if args.pristine_tiles else None,
                minzoom=args.minzoom, maxzoom=args.maxzoom, webp_quality=args.webp_quality,
            )

        elif args.command == "cleaned-export":
            cleaned.cmd_cleaned_export(Path(args.cleaned), Path(args.out), fmt=args.format)

        elif args.command == "cleanup-hole":
            from golfpipe.inpaint import LamaInpainter
            import json as _json

            if args.photocraft == "none":
                photocraft = None
            else:
                photocraft = Path(args.photocraft) if args.photocraft else hole_cleanup.default_photocraft()
            doc = hole_cleanup.clean_hole(
                Path(args.work), hole_cleanup.load_features(Path(args.features)), hole_cleanup.load_areas(Path(args.areas)),
                args.hole, _json.loads(args.region) if args.region else None, Path(args.out),
                LamaInpainter(args.weights, device=args.device), photocraft,
                progress=lambda msg: print(msg, file=sys.stderr, flush=True),
            )
            commands._emit_json(doc)

        elif args.command == "cleanup-compose":
            try:
                holes = [int(v) for v in args.holes.split(",") if v.strip()]
            except ValueError:
                parser.error("--holes must be comma-separated hole numbers")
            commands._emit_json(hole_cleanup.compose(Path(args.job), holes, args.size, Path(args.out)))

        elif args.command == "tile-ortho":
            commands.cmd_tile_ortho(
                Path(args.input), Path(args.out),
                minzoom=args.minzoom, maxzoom=args.maxzoom, webp_quality=args.webp_quality,
            )

        elif args.command == "tile-terrain":
            commands.cmd_tile_terrain(
                Path(args.input), Path(args.out),
                minzoom=args.minzoom, maxzoom=args.maxzoom,
                fill_nodata=args.fill_nodata,
                edge_pad_m=args.edge_pad_m,
            )

        elif args.command == "tile-hillshade":
            commands.cmd_tile_hillshade(
                Path(args.input), Path(args.out),
                minzoom=args.minzoom, maxzoom=args.maxzoom,
                azimuth=args.azimuth, altitude=args.altitude, z=args.z_factor,
            )

        elif args.command == "canopy":
            if not args.dem and not (args.bbox or args.aoi):
                parser.error("canopy needs --bbox or --aoi when no --dem is given")
            bbox = _resolve_area(args) if (args.bbox or args.aoi) else None
            counts = commands.cmd_canopy(
                [Path(p) for p in args.lidar],
                Path(args.dem) if args.dem else None,
                args.course_id, Path(args.tiles_dir), Path(args.workdir),
                bbox_wgs84=bbox, minzoom=args.minzoom, maxzoom=args.maxzoom,
                surface_shape=args.surface_shape,
                trees_out=Path(args.trees_out) if args.trees_out else None,
                min_hole_area_m2=args.min_hole_area,
                woodland_out=Path(args.woodland_out) if args.woodland_out else None,
                woodland_ortho=Path(args.woodland_ortho) if args.woodland_ortho else None,
                roofs_out=Path(args.roofs_out) if args.roofs_out else None,
            )
            print("Tiles written: " + ", ".join(f"{k}={v}" for k, v in counts.items()))

        elif args.command == "trees-features":
            bbox_3006 = None
            if args.bbox:
                bbox_3006 = tuple(float(v) for v in args.bbox.split(","))
                if len(bbox_3006) != 4:
                    parser.error("--bbox must have 4 comma-separated values (e_min,n_min,e_max,n_max in EPSG:3006)")
            if args.lidar and not (args.dem or bbox_3006):
                parser.error("trees-features with --lidar needs --dem or --bbox to define the area")
            commands.cmd_trees_features(
                Path(args.out),
                canopy_tif=Path(args.canopy_tif) if args.canopy_tif else None,
                lidar_paths=[Path(p) for p in args.lidar] if args.lidar else None,
                dem_path=Path(args.dem) if args.dem else None,
                course_id=args.course_id,
                bbox_3006=bbox_3006,
                min_height_m=args.min_height, min_area_m2=args.min_area,
                close_m=args.close, round_m=args.round, simplify_m=args.simplify, min_hole_area_m2=args.min_hole_area,
                source_ref=args.source_ref, resolution=args.resolution,
                roof_tif=Path(args.roof_tif) if args.roof_tif else None,
            )

        elif args.command == "lowveg-features":
            bbox_3006 = None
            if args.bbox:
                bbox_3006 = tuple(float(v) for v in args.bbox.split(","))
                if len(bbox_3006) != 4:
                    parser.error("--bbox must have 4 comma-separated values (e_min,n_min,e_max,n_max in EPSG:3006)")
            if args.lidar and not (args.dem or bbox_3006):
                parser.error("lowveg-features with --lidar needs --dem or --bbox to define the area")
            if args.max_height <= args.min_height:
                parser.error("--max-height must be greater than --min-height")
            commands.cmd_lowveg_features(
                Path(args.out),
                canopy_tif=Path(args.canopy_tif) if args.canopy_tif else None,
                lidar_paths=[Path(p) for p in args.lidar] if args.lidar else None,
                dem_path=Path(args.dem) if args.dem else None,
                course_id=args.course_id,
                bbox_3006=bbox_3006,
                trees_path=Path(args.trees) if args.trees else None,
                min_height_m=args.min_height, max_height_m=args.max_height, tree_buffer_m=args.tree_buffer,
                min_area_m2=args.min_area, close_m=args.close, round_m=args.round, simplify_m=args.simplify,
                min_hole_area_m2=args.min_hole_area, source_ref=args.source_ref, resolution=args.resolution,
                min_points=args.min_points, roof_buffer_m=args.roof_buffer,
            )

        elif args.command == "woodland-features":
            bbox_3006 = None
            if args.bbox:
                bbox_3006 = tuple(float(v) for v in args.bbox.split(","))
                if len(bbox_3006) != 4:
                    parser.error("--bbox must have 4 comma-separated values (e_min,n_min,e_max,n_max in EPSG:3006)")
            if args.lidar and not (args.dem or bbox_3006):
                parser.error("woodland-features with --lidar needs --dem or --bbox to define the area")
            if args.roof_tif and not args.canopy_tif:
                parser.error("--roof-tif goes with --canopy-tif; --lidar finds the roofs itself")
            commands.cmd_woodland_features(
                Path(args.out),
                canopy_tif=Path(args.canopy_tif) if args.canopy_tif else None,
                lidar_paths=[Path(p) for p in args.lidar] if args.lidar else None,
                dem_path=Path(args.dem) if args.dem else None,
                roof_tif=Path(args.roof_tif) if args.roof_tif else None,
                ortho_path=Path(args.ortho) if args.ortho else None,
                course_id=args.course_id, bbox_3006=bbox_3006,
                min_height_m=args.min_height, close_m=args.close, min_area_m2=args.min_area,
                min_hole_area_m2=args.min_hole_area, edge_m=args.edge, min_cover=args.min_cover,
                roof_buffer_m=args.roof_buffer, round_m=args.round, simplify_m=args.simplify,
                min_weight=args.min_weight, source_ref=args.source_ref, resolution=args.resolution,
            )

        elif args.command == "trees-stems":
            commands.cmd_trees_stems(
                [Path(p) for p in args.lidar], Path(args.out), Path(args.tiles_dir), args.course_id,
                bbox_3006=tuple(float(v) for v in args.bbox.split(",")) if args.bbox else None,
                dem_path=Path(args.dem) if args.dem else None, resolution=args.resolution,
                workdir=Path(args.workdir) if args.workdir else None,
                min_height_m=args.min_height, min_area_m2=args.min_area,
                tall_height_m=args.tall_height, tall_min_area_m2=args.tall_min_area,
                leaf_off_ortho=None if args.no_kind else (Path(args.leaf_off_ortho) if args.leaf_off_ortho else "auto"),
                tile_m=args.tile_m, workers=args.workers,
            )

        elif args.command == "photo-stems":
            photo_stems.cmd_photo_stems(
                Path(args.summer_ortho), Path(args.leaf_off_ortho) if args.leaf_off_ortho else None,
                Path(args.stems), Path(args.features), Path(args.out),
                known_path=Path(args.known) if args.known else None,
                dem=Path(args.dem) if args.dem else None,
                lidar_size_factor=args.lidar_size_factor,
            )

        elif args.command == "rock-candidates":
            commands.cmd_rock_candidates(
                [Path(p) for p in args.lidar], Path(args.out),
                bbox_3006=tuple(float(v) for v in args.bbox.split(",")) if args.bbox else None,
                dem_path=Path(args.dem) if args.dem else None,
                tiles_dir=Path(args.tiles_dir) if args.tiles_dir else None,
                orthos=dict(item.split("=", 1) for item in args.ortho),
                known_paths=[Path(p) for p in args.known],
                buildings_path=Path(args.buildings) if args.buildings else None,
                near_path=Path(args.near) if args.near else None, near_m=args.near_m, resolution=args.resolution,
            )

        elif args.command == "manifest":
            commands.cmd_manifest(
                args.course, Path(args.tiles_dir),
                dem_path=Path(args.dem) if args.dem else None,
                out_path=Path(args.out) if args.out else None,
            )

        elif args.command == "install":
            installed = install_course_tiles(
                args.course, Path(args.data_dir),
                ortho_dir=Path(args.ortho) if args.ortho else None,
                terrain_dir=Path(args.terrain) if args.terrain else None,
                hillshade_dir=Path(args.hillshade) if args.hillshade else None,
                manifest_path=Path(args.manifest) if args.manifest else None,
            )
            payloads = build_register_payloads(args.course, installed)
            print_payloads(payloads)
            if args.api_url:
                responses = post_payloads(payloads, args.api_url, cookie=args.cookie)
                for resp in responses:
                    print(f"POST {resp.url} -> {resp.status_code}")

        elif args.command == "bbox-from-course":
            bbox = bbox_from_course(Path(args.db), args.course, buffer_m=args.buffer)
            print(",".join(str(v) for v in bbox))

        elif args.command == "reproject-bbox":
            bbox = _resolve_area(args)
            out = commands.cmd_reproject_bbox(bbox, epsg=args.to)
            print(",".join(str(v) for v in out))

        else:
            parser.error(f"Unknown command: {args.command}")

    except MissingCredentialsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except water.WaterError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except hydro.HydroError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except photo_stems.PhotoStemsError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except lake_plane.LakePlaneError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except shore.ShoreError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except osm.OsmError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except clean_ortho.CleanOrthoError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except hole_cleanup.HoleCleanupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (surface_model.SurfaceModelError, bunker_proposals.BunkerProposalsError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except patches.PatchError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except dem_edit.DemEditError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except SculptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except InpaintError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except AoiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
