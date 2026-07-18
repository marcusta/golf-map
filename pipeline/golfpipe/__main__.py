"""CLI entry point: python -m golfpipe <command> ...

Commands:
  fetch-dem         STAC search + download DTM COG(s), mosaic/crop -> dem.tif
  fetch-ortho       STAC search + download best-coverage ortho COG(s) -> ortho.tif
  fetch-lidar       STAC search + download classified lidar COPC point cloud(s)
  fetch-water       Marktäcke vector water -> typed GeoJSON (water / water_creek)
  fetch-osm         Overpass OSM golf/terrain polygons -> typed GeoJSON (ODbL)
  grid-dem          Bin lidar points (ground/water/bridge classes) -> DEM GeoTIFF
  detect-trees      Lidar nDSM tree-canopy polygons -> typed GeoJSON (trees)
  tile-ortho        GeoTIFF -> WebP XYZ tile pyramid
  tile-terrain      GeoTIFF (DEM) -> Terrain-RGB PNG XYZ tile pyramid
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

from golfpipe import commands
from golfpipe import detect_trees
from golfpipe import grid_dem as grid_dem_mod
from golfpipe import osm
from golfpipe import water
from golfpipe.aoi import AoiError, resolve_bbox
from golfpipe.bbox_course import bbox_from_course
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

    p = sub.add_parser("fetch-ortho", help="STAC search + download orthophoto COG(s), mosaic/crop to bbox")
    _add_area_args(p)
    p.add_argument("--workdir", required=True, help="directory to download source COGs into")
    p.add_argument("--out", required=True, help="output path for cropped/mosaicked ortho.tif")
    p.add_argument("--buffer", type=float, default=commands.DEFAULT_FETCH_BUFFER_M, help="crop buffer in metres (default 250)")
    p.add_argument("--collection", help="fetch a specific vintage collection (default: newest); see list-ortho-vintages")

    p = sub.add_parser("list-ortho-vintages", help="List ortho vintages covering an area (JSON, newest first)")
    _add_area_args(p)

    p = sub.add_parser("fetch-lidar", help="STAC search + download classified lidar COPC point cloud(s)")
    _add_area_args(p)
    p.add_argument("--workdir", help="alias for --out-dir (kept for symmetry with fetch-dem/fetch-ortho)")
    p.add_argument("--out-dir", help="directory to download .copc.laz assets into")

    p = sub.add_parser("fetch-water", help="Download Marktäcke vector data and extract water as typed GeoJSON (EPSG:3006)")
    _add_area_args(p)
    p.add_argument("--workdir", required=True, help="directory to download/extract source GeoPackages into")
    p.add_argument("--out", required=True, help="output GeoJSON path (importable by the web GeoJSON import wizard)")
    p.add_argument(
        "--creek-width", dest="creek_width", type=float, default=water.DEFAULT_CREEK_WIDTH_M,
        help=f"total buffered width in metres for watercourse lines (default {water.DEFAULT_CREEK_WIDTH_M})",
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

    p = sub.add_parser("detect-trees", help="Derive tree-canopy polygons from classified lidar via nDSM -> typed GeoJSON")
    p.add_argument("--lidar", required=True, nargs="+", help="one or more .laz/.copc.laz point cloud files (from fetch-lidar)")
    p.add_argument("--bbox-3006", required=True, help="e_min,n_min,e_max,n_max in EPSG:3006 metres")
    p.add_argument("--resolution", type=float, default=grid_dem_mod.DEFAULT_RESOLUTION, help="grid cell size in metres (default 0.5)")
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
            commands.cmd_fetch_dem(bbox, Path(args.workdir), Path(args.out), buffer_m=args.buffer)

        elif args.command == "fetch-ortho":
            bbox = _resolve_area(args)
            commands.cmd_fetch_ortho(bbox, Path(args.workdir), Path(args.out), buffer_m=args.buffer, collection=args.collection)

        elif args.command == "list-ortho-vintages":
            bbox = _resolve_area(args)
            commands.cmd_list_ortho_vintages(bbox)

        elif args.command == "fetch-lidar":
            bbox = _resolve_area(args)
            out_dir = args.out_dir or args.workdir
            if not out_dir:
                parser.error("fetch-lidar requires --out-dir (or --workdir)")
            commands.cmd_fetch_lidar(bbox, Path(out_dir), Path(out_dir))

        elif args.command == "fetch-water":
            bbox = _resolve_area(args)
            commands.cmd_fetch_water(bbox, Path(args.workdir), Path(args.out), creek_width_m=args.creek_width)

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
    except osm.OsmError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except AoiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
