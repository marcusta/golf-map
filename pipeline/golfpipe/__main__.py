"""CLI entry point: python -m golfpipe <command> ...

Commands:
  fetch-dem         STAC search + download DTM COG(s), mosaic/crop -> dem.tif
  fetch-ortho       STAC search + download best-coverage ortho COG(s) -> ortho.tif
  fetch-lidar       STAC search + download classified lidar COPC point cloud(s)
  fetch-water       Marktäcke vector water -> typed GeoJSON (water / water_creek)
  fetch-hydro       Hydrografi Direkt water + creeks -> typed GeoJSON (water / water_creek)
  fetch-osm         Overpass OSM golf/terrain polygons -> typed GeoJSON (ODbL)
  grid-dem          Bin lidar points (ground/water/bridge classes) -> DEM GeoTIFF
  apply-dem-edits   Replay vector terrain edits (plane/smooth + feather) onto a DEM
  dem-analysis      Publishable analysis DEM: 0.5 m greens + 1 m background mosaic
  detect-trees      Lidar nDSM tree-canopy polygons -> typed GeoJSON (trees)
  detect-water      Lidar class-9 presence polygons -> typed GeoJSON (water)
  clean-ortho       LaMa-inpaint canopy+shadows out of the playable corridor -> .clean.tif
  bake-ortho-patch  Windowed bake of logged entries (--seq repeatable: LaMa masks + clone-stamp strokes) into the working .patched.tif + one union-subtree retile
  apply-ortho-patches  Full replay: re-bake every logged entry onto the pristine ortho + retile the affected subtree
  tile-ortho        GeoTIFF -> WebP XYZ tile pyramid
  tile-terrain      GeoTIFF (DEM) -> Terrain-RGB PNG XYZ tile pyramid
  canopy            Lidar -> canopy / canopy-color / surface tile pyramids + manifest update (--trees-out: tree polygons too)
  trees-features    Cleaned canopy grid (canopy.tif or lidar) -> tree polygons GeoJSON with height stats
  manifest          Write manifest.json for a tiled course
  install           Copy tiles+manifest into data/tiles/{courseId}/...
  bbox-from-course  Compute a WGS84 bbox from a course's DB coordinates

Every command that takes an area accepts --bbox (w,s,e,n WGS84) or --aoi
(a GeoJSON file whose combined bbox is used) — see golfpipe/aoi.py.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from golfpipe import clean_ortho
from golfpipe import commands
from golfpipe import dem_analysis
from golfpipe import dem_edit
from golfpipe import detect_trees
from golfpipe import detect_water
from golfpipe import grid_dem as grid_dem_mod
from golfpipe import hydro
from golfpipe import sources
from golfpipe import trees_stems
from golfpipe import osm
from golfpipe import patches
from golfpipe import trees_features
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

    p = sub.add_parser("fetch-lidar", help="STAC search + download classified lidar COPC point cloud(s)")
    _add_area_args(p)
    p.add_argument("--workdir", help="alias for --out-dir (kept for symmetry with fetch-dem/fetch-ortho)")
    p.add_argument("--out-dir", help="directory to download .copc.laz assets into")
    p.add_argument("--items", help="comma-separated STAC item ids to fetch instead of searching (from sources.json)")

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

    p = sub.add_parser("fetch-osm", help="Query Overpass for OSM golf/terrain polygons -> typed GeoJSON (EPSG:3006, ODbL)")
    _add_area_args(p)
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")
    p.add_argument("--overpass-url", dest="overpass_url", default=osm.OVERPASS_URL, help=f"Overpass API endpoint (default {osm.OVERPASS_URL})")

    p = sub.add_parser("grid-dem", help="Bin classified lidar points into a regular-grid DEM GeoTIFF")
    p.add_argument("--lidar", required=True, nargs="+", help="one or more .laz/.copc.laz point cloud files")
    p.add_argument("--bbox-3006", required=True, help="e_min,n_min,e_max,n_max in EPSG:3006 metres")
    p.add_argument("--resolution", type=float, default=grid_dem_mod.DEFAULT_RESOLUTION, help="grid cell size in metres (default 0.5)")
    p.add_argument("--out", required=True, help="output DEM GeoTIFF path")
    p.add_argument(
        "--classes", default=",".join(str(c) for c in grid_dem_mod.DEFAULT_CLASSES),
        help="comma-separated classification codes to use as terrain surface (default 2,9 = ground,water)",
    )

    p = sub.add_parser(
        "apply-dem-edits",
        help="Replay vector terrain edits (plane-fit flatten / median smooth, feathered) onto a DEM GeoTIFF",
    )
    p.add_argument("--input", required=True, help="input DEM GeoTIFF (grid-dem output) — never modified")
    p.add_argument(
        "--edits", required=True,
        help="edits GeoJSON FeatureCollection (WGS84; per-feature properties op/featherM/radiusM/flat, createdAt order)",
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

    p = sub.add_parser(
        "apply-ortho-patches",
        help="Full replay: re-inpaint every logged mask onto the pristine ortho and retile the affected pyramid subtree",
    )
    p.add_argument("--ortho", required=True, help="PRISTINE source ortho GeoTIFF (EPSG:3006) — never modified")
    p.add_argument("--patches-dir", dest="patches_dir", required=True, help="directory with patches.json + <n>.png mask files (see golfpipe/patches.py)")
    p.add_argument("--out", help="output patched GeoTIFF (default: <ortho stem>.patched.tif alongside the source; must differ from --ortho)")
    p.add_argument("--tiles-out", dest="tiles_out", help="ortho tile tree to rewrite affected tiles in (the sparse ortho-sim overlay under the dual-photo-state model; omit to skip retiling)")
    p.add_argument("--pristine-tiles", dest="pristine_tiles", help="read-only pristine flat ortho tree — lower-zoom parents read missing children from it when --tiles-out is a sparse sim overlay")
    p.add_argument("--minzoom", type=int, default=commands.DEFAULT_ORTHO_MINZOOM)
    p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_ORTHO_MAXZOOM)
    p.add_argument(
        "--extra-bounds", dest="extra_bounds", action="append", default=[],
        help="extra west,south,east,north EPSG:3857 bounds to retile (repeatable) — pass a reverted patch's bounds so its tiles rewrite too",
    )
    p.add_argument("--webp-quality", type=int, default=80)
    p.add_argument("--weights", help="LaMa TorchScript checkpoint path (default: $GOLFPIPE_LAMA_WEIGHTS; unused when the log is empty)")
    p.add_argument("--device", help="torch device (default: auto — mps if available, else cuda, else cpu)")

    p = sub.add_parser(
        "bake-ortho-patch",
        help="Incremental accept: windowed bake of the given logged entries (LaMa for masks, brush engine for stamp strokes) into the working .patched.tif + one retile of their union subtree",
    )
    p.add_argument("--ortho", required=True, help="PRISTINE source ortho GeoTIFF (EPSG:3006) — never modified")
    p.add_argument("--patches-dir", dest="patches_dir", required=True, help="directory with patches.json + <n>.png mask files (see golfpipe/patches.py)")
    p.add_argument("--seq", type=int, action="append", default=None,
                   help="log seq to bake (repeatable — a batch bakes in seq order with ONE retile pass; default: the last entry)")
    p.add_argument("--out", help="working patched GeoTIFF (default: <ortho stem>.patched.tif; created by full replay when missing/stale)")
    p.add_argument("--tiles-out", dest="tiles_out", help="ortho tile tree to rewrite affected tiles in (the sparse ortho-sim overlay under the dual-photo-state model; omit to skip retiling)")
    p.add_argument("--pristine-tiles", dest="pristine_tiles", help="read-only pristine flat ortho tree — lower-zoom parents read missing children from it when --tiles-out is a sparse sim overlay")
    p.add_argument("--minzoom", type=int, default=commands.DEFAULT_ORTHO_MINZOOM)
    p.add_argument("--maxzoom", type=int, default=commands.DEFAULT_ORTHO_MAXZOOM)
    p.add_argument("--webp-quality", type=int, default=80)
    p.add_argument("--weights", help="LaMa TorchScript checkpoint path (default: $GOLFPIPE_LAMA_WEIGHTS)")
    p.add_argument("--device", help="torch device (default: auto — mps if available, else cuda, else cpu)")

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
    src.add_argument("--lidar", action="append", help="a .laz/.copc.laz point cloud (repeatable); grids the canopy as `canopy` does")
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

        elif args.command == "list-ortho-vintages":
            bbox = _resolve_area(args)
            commands.cmd_list_ortho_vintages(bbox)

        elif args.command == "fetch-lidar":
            bbox = _resolve_area(args)
            out_dir = args.out_dir or args.workdir
            if not out_dir:
                parser.error("fetch-lidar requires --out-dir (or --workdir)")
            commands.cmd_fetch_lidar(bbox, Path(out_dir), Path(out_dir), items=sources.parse_items_arg(args.items))

        elif args.command == "fetch-water":
            bbox = _resolve_area(args)
            commands.cmd_fetch_water(bbox, Path(args.workdir), Path(args.out), creek_width_m=args.creek_width)

        elif args.command == "fetch-hydro":
            bbox = _resolve_area(args)
            commands.cmd_fetch_hydro(bbox, Path(args.out), creek_width_m=args.creek_width)

        elif args.command == "fetch-osm":
            bbox = _resolve_area(args)
            commands.cmd_fetch_osm(bbox, Path(args.out), overpass_url=args.overpass_url)

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
            commands.cmd_apply_dem_edits(Path(args.input), Path(args.edits), Path(args.out))

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
            )

        elif args.command == "apply-ortho-patches":
            extra_bounds = []
            for raw in args.extra_bounds:
                parts = tuple(float(v) for v in raw.split(","))
                if len(parts) != 4:
                    parser.error("--extra-bounds must be west,south,east,north in EPSG:3857 metres")
                extra_bounds.append(parts)
            commands.cmd_apply_ortho_patches(
                Path(args.ortho), Path(args.patches_dir),
                out=Path(args.out) if args.out else None,
                tiles_out=Path(args.tiles_out) if args.tiles_out else None,
                minzoom=args.minzoom, maxzoom=args.maxzoom,
                extra_bounds_3857=extra_bounds,
                webp_quality=args.webp_quality,
                weights=args.weights, device=args.device,
                pristine_tiles=Path(args.pristine_tiles) if args.pristine_tiles else None,
            )

        elif args.command == "bake-ortho-patch":
            commands.cmd_bake_ortho_patch(
                Path(args.ortho), Path(args.patches_dir),
                seqs=args.seq,
                out=Path(args.out) if args.out else None,
                tiles_out=Path(args.tiles_out) if args.tiles_out else None,
                minzoom=args.minzoom, maxzoom=args.maxzoom,
                webp_quality=args.webp_quality,
                weights=args.weights, device=args.device,
                pristine_tiles=Path(args.pristine_tiles) if args.pristine_tiles else None,
            )

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

        elif args.command == "trees-stems":
            commands.cmd_trees_stems(
                [Path(p) for p in args.lidar], Path(args.out), Path(args.tiles_dir), args.course_id,
                bbox_3006=tuple(float(v) for v in args.bbox.split(",")) if args.bbox else None,
                dem_path=Path(args.dem) if args.dem else None, resolution=args.resolution,
                workdir=Path(args.workdir) if args.workdir else None,
                min_height_m=args.min_height, min_area_m2=args.min_area,
                tall_height_m=args.tall_height, tall_min_area_m2=args.tall_min_area,
                leaf_off_ortho=None if args.no_kind else (Path(args.leaf_off_ortho) if args.leaf_off_ortho else "auto"),
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
    except osm.OsmError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except clean_ortho.CleanOrthoError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except patches.PatchError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except dem_edit.DemEditError as exc:
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
