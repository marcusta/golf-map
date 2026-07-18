"""Water features from Lantmäteriet Marktäcke GeoPackages (fetch-water).

The open vector catalog (stac.VEKTOR_STAC_URL, CC BY 4.0) serves the
Topografi 10 land-cover layer as one zipped GeoPackage per kommun. Water
surfaces are ordinary land-cover polygons there (attribute `objekttyp` in
WATER_POLYGON_OBJEKTTYP); narrow watercourses — where the product carries
them at all — are line features (`objekttyp` in WATER_LINE_OBJEKTTYP) that
must be buffered into ribbons before they are useful as course features.

Everything here is offline-testable: a GeoPackage is just SQLite, so the
reader is stdlib sqlite3 plus a hand-rolled GeoPackageBinary header parser
in front of shapely's WKB loader — no fiona/GDAL (see pipeline/AGENTS.md).

Output convention (shared with fetch-osm / detect-trees, consumed by the
web GeoJSON draft-import wizard): a GeoJSON FeatureCollection in EPSG:3006
with a legacy `crs` member naming the CRS and `properties.type` set to a
web feature type ('water' / 'water_creek').
"""

from __future__ import annotations

import json
import sqlite3
import zipfile
from dataclasses import dataclass
from pathlib import Path

import shapely
import shapely.wkb
from shapely.geometry.base import BaseGeometry

# Topografi 10 / Marktäcke land-cover classes that are standing water
# surfaces (polygon geometry).
WATER_POLYGON_OBJEKTTYP = frozenset({"Sjö", "Anlagt vatten", "Vattendragsyta", "Hav"})
# Watercourse line classes (creeks/ditches mapped as centerlines because
# they are too narrow to carry as surfaces).
WATER_LINE_OBJEKTTYP = frozenset({"Vattendragslinje", "Vattendrag"})

# Total buffered width (metres) for watercourse lines. Lantmäteriet maps
# watercourses narrower than ~6 m as lines; a typical course-crossing creek
# or ditch is 1–3 m across, so 2 m is a sane draft default the editor can
# refine.
DEFAULT_CREEK_WIDTH_M = 2.0

SWEREF99_TM_SRID = 3006

GEOJSON_CRS_3006 = {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3006"}}

ATTRIBUTION = "© Lantmäteriet, Marktäcke (CC BY 4.0)"

# Envelope byte size per GeoPackageBinary envelope-contents indicator code
# (GeoPackage spec table 6): 0 none, 1 XY, 2 XYZ, 3 XYM, 4 XYZM.
_GPB_ENVELOPE_BYTES = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}


class WaterError(RuntimeError):
    pass


def parse_gpb(blob: bytes) -> BaseGeometry | None:
    """Parses a GeoPackageBinary blob (GPB header + WKB) into a shapely
    geometry. Returns None for the GPB 'empty geometry' flag. Raises
    WaterError on malformed headers.
    """
    if blob is None or len(blob) < 8 or blob[0:2] != b"GP":
        raise WaterError("not a GeoPackageBinary blob (missing 'GP' magic)")
    flags = blob[3]
    if (flags >> 5) & 1:
        raise WaterError("extended GeoPackageBinary geometries are not supported")
    if (flags >> 4) & 1:  # empty-geometry flag
        return None
    envelope_indicator = (flags >> 1) & 0b111
    envelope_bytes = _GPB_ENVELOPE_BYTES.get(envelope_indicator)
    if envelope_bytes is None:
        raise WaterError(f"invalid GeoPackageBinary envelope indicator: {envelope_indicator}")
    return shapely.wkb.loads(blob[8 + envelope_bytes :])


def extract_geopackages(zip_path: Path, dest_dir: Path) -> list[Path]:
    """Extracts every .gpkg member of a downloaded Marktäcke zip into
    dest_dir, returning their paths. Members already extracted with a
    matching size are skipped (safe to re-run after a partial fetch,
    mirroring fetch-lidar's skip behavior).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    out: list[Path] = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".gpkg"):
                continue
            dest = dest_dir / Path(info.filename).name
            if dest.exists() and dest.stat().st_size == info.file_size:
                out.append(dest)
                continue
            with zf.open(info) as src, open(dest, "wb") as f:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            out.append(dest)
    if not out:
        raise WaterError(f"{zip_path.name} contains no .gpkg member")
    return out


@dataclass(frozen=True)
class _FeatureTable:
    table: str
    geometry_column: str
    srs_id: int


def _feature_tables(conn: sqlite3.Connection) -> list[_FeatureTable]:
    rows = conn.execute(
        "SELECT c.table_name, g.column_name, g.srs_id "
        "FROM gpkg_contents c JOIN gpkg_geometry_columns g ON c.table_name = g.table_name "
        "WHERE c.data_type = 'features'"
    ).fetchall()
    return [_FeatureTable(table=t, geometry_column=col, srs_id=srs) for t, col, srs in rows]


def _objekttyp_column(conn: sqlite3.Connection, table: str) -> str | None:
    for row in conn.execute(f'PRAGMA table_info("{table}")'):
        if str(row[1]).lower() == "objekttyp":
            return str(row[1])
    return None


def read_water_features(
    gpkg_path: Path,
    bbox_3006: tuple[float, float, float, float],
) -> tuple[list[BaseGeometry], list[BaseGeometry]]:
    """Reads a Marktäcke GeoPackage and returns (water_polygons,
    watercourse_lines), each clipped to bbox_3006 (EPSG:3006 metres).

    Layer-agnostic: every feature table with an `objekttyp` column is
    scanned, polygons classified via WATER_POLYGON_OBJEKTTYP and lines via
    WATER_LINE_OBJEKTTYP (a geometry whose dimension doesn't match its
    class set is skipped). Tables in a CRS other than EPSG:3006 raise —
    the whole downstream contract is SWEREF99 TM.
    """
    clip = shapely.box(*bbox_3006)
    polygons: list[BaseGeometry] = []
    lines: list[BaseGeometry] = []

    conn = sqlite3.connect(f"file:{gpkg_path}?mode=ro", uri=True)
    try:
        tables = _feature_tables(conn)
        if not tables:
            raise WaterError(f"{gpkg_path.name} has no feature tables (not a GeoPackage?)")
        for ft in tables:
            objcol = _objekttyp_column(conn, ft.table)
            if objcol is None:
                continue
            if ft.srs_id != SWEREF99_TM_SRID:
                raise WaterError(
                    f"{gpkg_path.name} table {ft.table!r} is srs_id {ft.srs_id}, expected EPSG:{SWEREF99_TM_SRID}"
                )
            cursor = conn.execute(f'SELECT "{objcol}", "{ft.geometry_column}" FROM "{ft.table}"')
            for objekttyp, blob in cursor:
                is_poly_class = objekttyp in WATER_POLYGON_OBJEKTTYP
                is_line_class = objekttyp in WATER_LINE_OBJEKTTYP
                if not is_poly_class and not is_line_class:
                    continue
                geom = parse_gpb(blob)
                if geom is None or geom.is_empty:
                    continue
                clipped = geom.intersection(clip)
                if clipped.is_empty:
                    continue
                if is_poly_class and clipped.geom_type in ("Polygon", "MultiPolygon"):
                    polygons.append(clipped)
                elif is_line_class and clipped.geom_type in ("LineString", "MultiLineString"):
                    lines.append(clipped)
    finally:
        conn.close()

    return polygons, lines


def _each_polygon(geom: BaseGeometry):
    """Yields the individual Polygons of a Polygon/MultiPolygon/collection."""
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        for part in geom.geoms:
            yield from _each_polygon(part)


def _polygon_coordinates(polygon, ndigits: int = 2) -> list[list[list[float]]]:
    def ring(coords):
        return [[round(x, ndigits), round(y, ndigits)] for x, y, *_ in coords]

    return [ring(polygon.exterior.coords)] + [ring(interior.coords) for interior in polygon.interiors]


def build_water_geojson(
    polygons: list[BaseGeometry],
    lines: list[BaseGeometry],
    creek_width_m: float = DEFAULT_CREEK_WIDTH_M,
) -> dict:
    """Builds the EPSG:3006 FeatureCollection: water polygons unioned (a
    lake split across kommun files becomes one surface) and exploded into
    one 'water' feature per disjoint polygon (holes preserved); watercourse
    lines buffered by creek_width_m/2 per side, unioned (so contiguous
    centerline segments merge seamlessly) and exploded into 'water_creek'
    features.
    """
    features: list[dict] = []

    def add(geom: BaseGeometry, feature_type: str) -> None:
        for polygon in _each_polygon(geom):
            features.append({
                "type": "Feature",
                "properties": {"type": feature_type, "source": "lantmateriet-marktacke"},
                "geometry": {"type": "Polygon", "coordinates": _polygon_coordinates(polygon)},
            })

    if polygons:
        add(shapely.unary_union(polygons), "water")
    if lines:
        buffered = [line.buffer(creek_width_m / 2.0) for line in lines]
        add(shapely.unary_union(buffered), "water_creek")

    return {
        "type": "FeatureCollection",
        "crs": GEOJSON_CRS_3006,
        "attribution": ATTRIBUTION,
        "features": features,
    }


def write_geojson(collection: dict, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(collection, ensure_ascii=False), encoding="utf-8")
    return out_path
