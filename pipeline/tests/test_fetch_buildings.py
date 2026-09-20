"""fetch-buildings tests — fully offline. Overpass JSON is hand-built (ways
with inline `geometry`, a multipolygon relation with member geometry), the
nDSM for the roof measurement is a numpy grid + affine, the lidar end-to-end
test writes a small synthetic LAS, and the command test stubs the Overpass
call behind the `overpass_fetch` seam.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import laspy
import numpy as np
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform as warp_transform
from shapely.affinity import rotate
from shapely.geometry import Point, Polygon, box

from golfpipe import buildings
from golfpipe.commands import cmd_fetch_buildings

BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)


def reproject(lons, lats):
    return warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))


def geom(points):
    return [{"lat": lat, "lon": lon} for lon, lat in points]


def way(osm_id, points, **tags):
    return {"type": "way", "id": osm_id, "tags": tags, "geometry": geom(points)}


def p3006(lon, lat):
    xs, ys = reproject([lon], [lat])
    return Point(xs[0], ys[0])


# ~14 × 9 m house, closed ring (lon/lat degrees ≈ 58 m per 0.001° lon here).
HOUSE = [(15.550, 58.400), (15.55024, 58.400), (15.55024, 58.40008), (15.550, 58.40008), (15.550, 58.400)]
COURT_OUTER = [(15.560, 58.410), (15.5606, 58.410), (15.5606, 58.4104), (15.560, 58.4104), (15.560, 58.410)]
COURT_INNER = [(15.5602, 58.4101), (15.5604, 58.4101), (15.5604, 58.4103), (15.5602, 58.4103), (15.5602, 58.4101)]


# ─── tag parsing + rectangle ─────────────────────────────────────────────────

def test_parse_levels_takes_first_number_and_rejects_junk():
    assert buildings.parse_levels("2") == 2.0
    assert buildings.parse_levels("1.5") == 1.5
    assert buildings.parse_levels("1;2") == 1.0
    assert buildings.parse_levels("2-3") == 2.0
    assert buildings.parse_levels("many") is None
    assert buildings.parse_levels("0") is None
    assert buildings.parse_levels(None) is None


def test_footprint_rect_recovers_sides_and_bearing():
    footprint = rotate(box(0, 0, 20, 8), 30, origin=(0, 0))
    rect = buildings.footprint_rect(footprint)
    assert math.isclose(rect.length_m, 20.0, abs_tol=1e-6)
    assert math.isclose(rect.width_m, 8.0, abs_tol=1e-6)
    assert math.isclose(rect.angle_deg, 30.0, abs_tol=0.01)
    c = footprint.centroid
    assert math.isclose(rect.cx, c.x, abs_tol=1e-6) and math.isclose(rect.cy, c.y, abs_tol=1e-6)

    # A bearing wraps into [0, 180): 200° of the long axis is the same line as 20°.
    rect = buildings.footprint_rect(rotate(box(0, 0, 20, 8), 200, origin=(0, 0)))
    assert math.isclose(rect.angle_deg, 20.0, abs_tol=0.01)
    # An L-shape still gets its bounding rectangle.
    l_shape = Polygon([(0, 0), (12, 0), (12, 4), (4, 4), (4, 10), (0, 10)])
    rect = buildings.footprint_rect(l_shape)
    assert math.isclose(rect.length_m, 12.0, abs_tol=1e-6) and math.isclose(rect.width_m, 10.0, abs_tol=1e-6)


def test_build_query_asks_for_ways_and_multipolygons_with_geom():
    q = buildings.build_buildings_query(BBOX_WGS84)
    assert 'way["building"](58.39,15.53,58.42,15.58)' in q
    assert 'relation["building"]["type"="multipolygon"]' in q
    assert q.rstrip().endswith("out geom;")


# ─── assembly ────────────────────────────────────────────────────────────────

def test_assemble_way_carries_tags_rect_and_source_id():
    doc = {"elements": [way(7, HOUSE, building="detached", **{"building:levels": "2"}, height="7.5", name="Villa")]}
    found, skipped = buildings.assemble_buildings(doc, reproject)
    assert skipped == []
    [b] = found
    assert (b.id, b.osm_type, b.osm_id, b.kind, b.levels, b.height_tag_m, b.name) == \
        ("osm:way/7", "way", 7, "detached", 2.0, 7.5, "Villa")
    assert b.polygon.contains(p3006(15.5501, 58.40004))
    assert 100 < b.polygon.area < 160
    assert b.rect.length_m > b.rect.width_m > 0
    assert b.roof is None
    assert buildings.fallback_height_m(b) == 7.5


def test_assemble_relation_keeps_courtyard_hole_and_skips_bad_elements():
    relation = {
        "type": "relation", "id": 9, "tags": {"building": "apartments", "type": "multipolygon"},
        "members": [
            {"type": "way", "role": "outer", "geometry": geom(COURT_OUTER)},
            {"type": "way", "role": "inner", "geometry": geom(COURT_INNER)},
        ],
    }
    doc = {"elements": [
        relation,
        way(10, HOUSE[:3], building="yes"),  # open ring
        way(11, [(15.57, 58.41), (15.570001, 58.41), (15.570001, 58.410001), (15.57, 58.41)], building="shed"),
        way(12, HOUSE, natural="water"),  # not a building
    ]}
    found, skipped = buildings.assemble_buildings(doc, reproject)
    assert [b.id for b in found] == ["osm:relation/9"]
    b = found[0]
    assert b.kind == "apartments"
    assert len(b.polygon.interiors) == 1
    assert not b.polygon.contains(p3006(15.5603, 58.4102))  # the courtyard
    assert b.polygon.contains(p3006(15.56005, 58.41005))
    assert skipped == [
        "way/10: building way is not a closed ring",
        "way/11: footprint under 4 m²",
    ]


def test_fallback_height_prefers_tag_then_levels():
    doc = {"elements": [
        way(1, HOUSE, building="yes", **{"building:levels": "2"}),
        way(2, HOUSE, building="yes"),
    ]}
    found, _ = buildings.assemble_buildings(doc, reproject)
    assert buildings.fallback_height_m(found[0]) == 2 * buildings.LEVEL_HEIGHT_M
    assert buildings.fallback_height_m(found[1]) is None


# ─── roof measurement ────────────────────────────────────────────────────────

def _ndsm_with_gable(size=40, x0=10, x1=26, y0=12, y1=22, eave=5.0, ridge=9.0):
    """1 m grid, origin (1000, 1040): a gable roof over cells [x0,x1)×[y0,y1)
    rising from `eave` at the north/south edges to `ridge` mid-way."""
    ndsm = np.zeros((size, size), dtype=np.float64)
    rows = np.arange(y0, y1)
    t = 1.0 - np.abs((rows + 0.5 - (y0 + y1) / 2.0) / ((y1 - y0) / 2.0))
    ndsm[y0:y1, x0:x1] = (eave + (ridge - eave) * t)[:, None]
    transform = from_origin(1000.0, 1040.0, 1.0, 1.0)
    footprint = box(1000 + x0, 1040 - y1, 1000 + x1, 1040 - y0)
    return ndsm, transform, footprint


def test_measure_roof_reads_eave_and_ridge_inside_inset_footprint():
    ndsm, transform, footprint = _ndsm_with_gable()
    roof = buildings.measure_roof(footprint, ndsm, transform)
    assert roof is not None
    assert roof.cells > 100
    assert 5.0 <= roof.eave_m <= 6.2
    assert 8.3 <= roof.ridge_m <= 9.0
    assert roof.ridge_m > roof.eave_m


def test_measure_roof_returns_none_for_tiny_or_groundlevel_footprints():
    ndsm, transform, _ = _ndsm_with_gable()
    # Off the roof: only ground (0 m) cells.
    assert buildings.measure_roof(box(1001, 1001, 1006, 1006), ndsm, transform) is None
    # A shed of two cells cannot reach MIN_ROOF_CELLS.
    assert buildings.measure_roof(box(1011, 1020, 1013, 1021), ndsm, transform) is None


def test_measure_roofs_fills_in_place_and_counts():
    ndsm, transform, footprint = _ndsm_with_gable()
    on = buildings.Building("a", "way", 1, "yes", None, None, None, footprint, buildings.footprint_rect(footprint))
    off_fp = box(1001, 1001, 1006, 1006)
    off = buildings.Building("b", "way", 2, "yes", None, None, None, off_fp, buildings.footprint_rect(off_fp))
    assert buildings.measure_roofs([on, off], ndsm, transform) == 1
    assert on.roof is not None and off.roof is None


# ─── GeoJSON ─────────────────────────────────────────────────────────────────

def test_build_geojson_carries_survey_fields_and_provenance():
    doc = {"elements": [way(7, HOUSE, building="detached", **{"building:levels": "2"})]}
    found, _ = buildings.assemble_buildings(doc, reproject)
    found[0].roof = buildings.Roof(5.5, 8.25, 90)
    collection = buildings.build_buildings_geojson(found, fetch_date="2026-09-15")
    assert collection["crs"]["properties"]["name"] == "urn:ogc:def:crs:EPSG::3006"
    assert "ODbL" in collection["attribution"]
    [feature] = collection["features"]
    props = feature["properties"]
    assert props["type"] == "building"
    assert props["id"] == "osm:way/7"
    assert props["kind"] == "detached"
    assert props["levels"] == 2.0 and props["heightTagM"] is None
    assert props["fallbackHeightM"] == 6.0
    assert props["eaveM"] == 5.5 and props["ridgeM"] == 8.25 and props["roofCells"] == 90
    assert set(props["rect"]) == {"cx", "cy", "lengthM", "widthM", "angleDeg"}
    assert props["source"] == "osm" and props["osm_type"] == "way" and props["osm_id"] == 7
    assert props["fetched"] == "2026-09-15"
    assert feature["geometry"]["type"] == "Polygon"


# ─── end-to-end command ──────────────────────────────────────────────────────

def test_cmd_fetch_buildings_without_lidar(tmp_path: Path, capsys):
    doc = {"elements": [
        way(1, HOUSE, building="detached", **{"building:levels": "1"}),
        way(2, COURT_OUTER, building="apartments"),
        way(3, HOUSE[:3], building="yes"),
    ]}
    calls = []

    def stub(query, *, url=""):
        calls.append(url)
        return doc

    out = tmp_path / "buildings.geojson"
    assert cmd_fetch_buildings(BBOX_WGS84, out, overpass_fetch=stub, overpass_url="http://stub.invalid") == out
    assert calls == ["http://stub.invalid"]
    collection = json.loads(out.read_text(encoding="utf-8"))
    assert [f["properties"]["id"] for f in collection["features"]] == ["osm:way/1", "osm:way/2"]
    assert all(f["properties"]["eaveM"] is None for f in collection["features"])
    printed = capsys.readouterr().out
    assert "Buildings: 2 (apartments=1, detached=1)" in printed
    assert "No --lidar" in printed and "(1 have height or levels)" in printed
    assert "way/3: building way is not a closed ring" in printed


def _write_las(path: Path, x, y, z, classification) -> Path:
    header = laspy.LasHeader(point_format=3, version="1.2")
    header.offsets = [float(np.min(np.asarray(v, dtype=np.float64))) for v in (x, y, z)]
    header.scales = [0.001, 0.001, 0.001]
    las = laspy.LasData(header)
    las.x, las.y, las.z = (np.asarray(v, dtype=np.float64) for v in (x, y, z))
    las.classification = np.asarray(classification, dtype=np.uint8)
    las.write(str(path))
    return path


def test_cmd_fetch_buildings_measures_roof_from_lidar(tmp_path: Path, capsys):
    doc = {"elements": [way(1, HOUSE, building="detached")]}
    footprint, _ = buildings.assemble_buildings(doc, reproject)
    fp = footprint[0].polygon
    e0, n0, e1, n1 = fp.bounds
    # Ground (class 2) at z=20 on a 1 m lattice 6 m around the house; a flat
    # 6.5 m roof (class 1, z=26.5) on every lattice point inside the footprint.
    gx, gy = np.meshgrid(np.arange(math.floor(e0) - 6, math.ceil(e1) + 7) + 0.5,
                         np.arange(math.floor(n0) - 6, math.ceil(n1) + 7) + 0.5)
    gx, gy = gx.ravel(), gy.ravel()
    inside = np.array([fp.contains(Point(x, y)) for x, y in zip(gx, gy)])
    las = _write_las(
        tmp_path / "house.las",
        np.concatenate([gx, gx[inside]]), np.concatenate([gy, gy[inside]]),
        np.concatenate([np.full(gx.shape, 20.0), np.full(int(inside.sum()), 26.5)]),
        np.concatenate([np.full(gx.shape, 2), np.full(int(inside.sum()), 1)]),
    )
    out = tmp_path / "buildings.geojson"
    cmd_fetch_buildings(BBOX_WGS84, out, lidar_paths=[las], overpass_fetch=lambda q, *, url="": doc)
    [feature] = json.loads(out.read_text(encoding="utf-8"))["features"]
    props = feature["properties"]
    assert props["roofCells"] >= buildings.MIN_ROOF_CELLS
    assert 6.0 <= props["eaveM"] <= 6.5
    assert 6.0 <= props["ridgeM"] <= 6.5
    assert "Roofs measured: 1 of 1" in capsys.readouterr().out
