"""fetch-water tests — fully offline. A GeoPackage is plain SQLite, so the
fixtures build a synthetic Marktäcke .gpkg with hand-encoded
GeoPackageBinary blobs (header + shapely WKB), and the end-to-end command
test stubs the STAC search + zip download behind the stac.py session seam
(same pattern as test_stac_download.py).
"""

from __future__ import annotations

import io
import json
import sqlite3
import struct
import zipfile
from pathlib import Path

import pytest
import shapely
from shapely.geometry import LineString, Polygon

from golfpipe import stac, water
from golfpipe.commands import cmd_fetch_water

# Bbox around the conftest course spot near Linköping. WGS84 for the
# command (reprojects to ≈ (530960, 6472253, 533910, 6475618)), EPSG:3006
# for direct water.py calls — chosen so it CONTAINS the reprojected box and
# the "inside" fixtures below sit inside both.
BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)
BBOX_3006 = (530000.0, 6470000.0, 534500.0, 6476000.0)


# ─── GPB encoding + synthetic GeoPackage ─────────────────────────────────────

def gpb(geom, srs_id: int = 3006, envelope: bool = False, empty: bool = False) -> bytes:
    """Encodes a shapely geometry as a GeoPackageBinary blob (little-endian
    header, optional XY envelope, optional empty flag)."""
    flags = 0b00000001  # little-endian header
    if envelope:
        flags |= 0b0000_0010  # envelope indicator 1 (XY)
    if empty:
        flags |= 0b0001_0000
    header = b"GP" + bytes([0, flags]) + struct.pack("<i", srs_id)
    if envelope:
        minx, miny, maxx, maxy = geom.bounds
        header += struct.pack("<4d", minx, maxx, miny, maxy)
    return header + shapely.to_wkb(geom, byte_order=1)


def make_gpkg(
    path: Path,
    polygon_rows: list[tuple[str, bytes]],
    line_rows: list[tuple[str, bytes]] | None = None,
    srs_id: int = 3006,
) -> Path:
    """Minimal Marktäcke-shaped GeoPackage: gpkg_contents +
    gpkg_geometry_columns + a polygon feature table `mark` (and optionally a
    line table `hydrolinje`), each with an `objekttyp` column."""
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT)")
    conn.execute(
        "CREATE TABLE gpkg_geometry_columns "
        "(table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER)"
    )

    def add_table(name: str, gtype: str, rows: list[tuple[str, bytes]]) -> None:
        conn.execute("INSERT INTO gpkg_contents VALUES (?, 'features')", (name,))
        conn.execute("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', ?, ?)", (name, gtype, srs_id))
        conn.execute(f'CREATE TABLE "{name}" (fid INTEGER PRIMARY KEY, objekttyp TEXT, geom BLOB)')
        conn.executemany(f'INSERT INTO "{name}" (objekttyp, geom) VALUES (?, ?)', rows)

    add_table("mark", "MULTIPOLYGON", polygon_rows)
    if line_rows is not None:
        add_table("hydrolinje", "LINESTRING", line_rows)
    conn.commit()
    conn.close()
    return path


def square(cx: float, cy: float, half: float) -> Polygon:
    return shapely.box(cx - half, cy - half, cx + half, cy + half)


LAKE = square(531500, 6473000, 100)  # inside bbox
LAKE_WITH_ISLAND = Polygon(
    square(532500, 6474000, 200).exterior.coords,
    [list(reversed(square(532500, 6474000, 50).exterior.coords))],
)
FAR_LAKE = square(600000, 6600000, 100)  # far outside bbox
FOREST = square(533000, 6473500, 300)  # water-adjacent land cover, ignored
CREEK = LineString([(531200, 6473200), (531200, 6474200)])  # 1 km, inside


@pytest.fixture
def marktacke_gpkg(tmp_path: Path) -> Path:
    return make_gpkg(
        tmp_path / "marktacke_kn0580.gpkg",
        polygon_rows=[
            ("Sjö", gpb(LAKE)),
            ("Anlagt vatten", gpb(LAKE_WITH_ISLAND, envelope=True)),
            ("Sjö", gpb(FAR_LAKE)),
            ("Skogsmark, barr", gpb(FOREST)),
        ],
        line_rows=[
            ("Vattendragslinje", gpb(CREEK)),
            ("Vattendragslinje", gpb(LineString([(600000, 6600000), (600100, 6600000)]))),  # outside
        ],
    )


# ─── parse_gpb ───────────────────────────────────────────────────────────────

def test_parse_gpb_round_trips_with_and_without_envelope():
    for envelope in (False, True):
        geom = water.parse_gpb(gpb(LAKE, envelope=envelope))
        assert geom.equals(LAKE)


def test_parse_gpb_empty_flag_and_bad_magic():
    assert water.parse_gpb(gpb(LAKE, empty=True)) is None
    with pytest.raises(water.WaterError, match="GP"):
        water.parse_gpb(b"XX" + b"\x00" * 10)


# ─── read_water_features ─────────────────────────────────────────────────────

def test_read_water_features_classifies_clips_and_keeps_holes(marktacke_gpkg: Path):
    polygons, lines = water.read_water_features(marktacke_gpkg, BBOX_3006)

    # FAR_LAKE clipped away entirely, FOREST not a water class.
    assert len(polygons) == 2
    assert len(lines) == 1

    with_hole = next(p for p in polygons if len(p.interiors) == 1)
    assert with_hole.equals(LAKE_WITH_ISLAND)
    assert lines[0].equals(CREEK)


def test_read_water_features_rejects_wrong_srs(tmp_path: Path):
    bad = make_gpkg(tmp_path / "wgs84.gpkg", [("Sjö", gpb(LAKE, srs_id=4326))], srs_id=4326)
    with pytest.raises(water.WaterError, match="4326"):
        water.read_water_features(bad, BBOX_3006)


# ─── build_water_geojson ─────────────────────────────────────────────────────

def test_build_water_geojson_types_crs_and_creek_buffer():
    collection = water.build_water_geojson([LAKE, LAKE_WITH_ISLAND], [CREEK], creek_width_m=2.0)

    assert collection["crs"]["properties"]["name"].endswith("EPSG::3006")
    types = sorted({f["properties"]["type"] for f in collection["features"]})
    assert types == ["water", "water_creek"]

    # Disjoint lakes stay separate features; the island hole survives.
    waters = [f for f in collection["features"] if f["properties"]["type"] == "water"]
    assert len(waters) == 2
    assert any(len(f["geometry"]["coordinates"]) == 2 for f in waters)

    # 1000 m creek at 2 m total width ≈ 2000 m² ribbon (round caps add a bit).
    creek = next(f for f in collection["features"] if f["properties"]["type"] == "water_creek")
    ribbon = Polygon(creek["geometry"]["coordinates"][0])
    assert 1900 < ribbon.area < 2200


def test_build_water_geojson_unions_touching_polygons_and_contiguous_creek_segments():
    half_a = shapely.box(0, 0, 100, 100)
    half_b = shapely.box(100, 0, 200, 100)  # shares an edge (kommun-split lake)
    seg_a = LineString([(0, 500), (100, 500)])
    seg_b = LineString([(100, 500), (200, 500)])
    collection = water.build_water_geojson([half_a, half_b], [seg_a, seg_b], creek_width_m=2.0)

    waters = [f for f in collection["features"] if f["properties"]["type"] == "water"]
    creeks = [f for f in collection["features"] if f["properties"]["type"] == "water_creek"]
    assert len(waters) == 1
    assert len(creeks) == 1
    assert Polygon(waters[0]["geometry"]["coordinates"][0]).area == pytest.approx(20000)


# ─── extract_geopackages ─────────────────────────────────────────────────────

def test_extract_geopackages_extracts_and_skips_reruns(tmp_path: Path, marktacke_gpkg: Path):
    zip_path = tmp_path / "marktacke_kn0580.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.write(marktacke_gpkg, "marktacke_kn0580.gpkg")
        zf.writestr("readme.txt", "not a gpkg")

    out_dir = tmp_path / "extracted"
    first = water.extract_geopackages(zip_path, out_dir)
    assert [p.name for p in first] == ["marktacke_kn0580.gpkg"]
    again = water.extract_geopackages(zip_path, out_dir)  # size-match skip path
    assert again == first

    empty_zip = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty_zip, "w") as zf:
        zf.writestr("readme.txt", "nothing here")
    with pytest.raises(water.WaterError, match="no .gpkg"):
        water.extract_geopackages(empty_zip, out_dir)


# ─── cmd_fetch_water end-to-end (stubbed session) ────────────────────────────

class _StubResponse:
    def __init__(self, payload):
        self._payload = payload
        self.headers = {}
        if isinstance(payload, bytes):
            self.headers["Content-Length"] = str(len(payload))

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload

    def iter_content(self, chunk_size):
        yield self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _StubSession:
    """Serves the STAC search JSON and the zip download; records auth."""

    def __init__(self, zip_bytes: bytes):
        self.zip_bytes = zip_bytes
        self.calls = []

    def get(self, url, params=None, auth=None, stream=None, timeout=None):
        self.calls.append({"url": url, "auth": auth})
        if "search" in url:
            return _StubResponse({
                "features": [
                    {
                        "id": "0580",
                        "collection": "marktacke",
                        "bbox": [15.2, 58.0, 16.1, 58.6],
                        "assets": {
                            "data": {
                                "href": "https://dl1.lantmateriet.se/mark/marktacke/marktacke_kn0580.zip",
                                "type": "application/zip",
                            },
                        },
                    }
                ]
            })
        return _StubResponse(self.zip_bytes)


def test_cmd_fetch_water_end_to_end(tmp_path: Path, marktacke_gpkg: Path, monkeypatch, capsys):
    monkeypatch.setenv("LANTMATERIET_USER", "someuser")
    monkeypatch.setenv("LANTMATERIET_PASS", "somepass")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.write(marktacke_gpkg, "marktacke_kn0580.gpkg")
    session = _StubSession(buf.getvalue())

    out = tmp_path / "water.geojson"
    cmd_fetch_water(BBOX_WGS84, tmp_path / "work", out, creek_width_m=3.0, session=session)

    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["crs"] == water.GEOJSON_CRS_3006
    types = {f["properties"]["type"] for f in collection["features"]}
    assert types == {"water", "water_creek"}
    # All output coordinates are EPSG:3006 metres (not degrees).
    for feature in collection["features"]:
        for ring in feature["geometry"]["coordinates"]:
            for x, y in ring:
                assert 400000 < x < 700000 and 6.3e6 < y < 6.6e6

    download_call = next(c for c in session.calls if c["url"].endswith(".zip"))
    assert download_call["auth"] == ("someuser", "somepass")
    assert "Wrote" in capsys.readouterr().out


def test_cmd_fetch_water_403_names_the_entitlement_gap(tmp_path: Path, monkeypatch):
    """The real-world failure mode (verified 2026-07-18): the STAC search is
    anonymous and succeeds, but dl1 returns 403 unless the account has the
    Marktäcke product activated in Geotorget."""
    import requests

    monkeypatch.setenv("LANTMATERIET_USER", "someuser")
    monkeypatch.setenv("LANTMATERIET_PASS", "somepass")

    class _Forbidden(_StubResponse):
        def __init__(self):
            super().__init__(b"")
            self.status_code = 403

        def raise_for_status(self):
            raise requests.HTTPError("403 Client Error", response=self)

    class _ForbiddenSession(_StubSession):
        def get(self, url, params=None, auth=None, stream=None, timeout=None):
            if "search" in url:
                return super().get(url, params=params)
            return _Forbidden()

    with pytest.raises(water.WaterError, match="Geotorget"):
        cmd_fetch_water(BBOX_WGS84, tmp_path / "work", tmp_path / "out.geojson", session=_ForbiddenSession(b""))


def test_cmd_fetch_water_exits_when_no_items(tmp_path: Path):
    class _EmptySession:
        def get(self, url, params=None, timeout=None):
            return _StubResponse({"features": []})

    with pytest.raises(SystemExit):
        cmd_fetch_water(BBOX_WGS84, tmp_path / "work", tmp_path / "out.geojson", session=_EmptySession())


def test_search_marktacke_hits_vektor_catalog():
    class _SearchSession:
        def __init__(self):
            self.urls = []

        def get(self, url, params=None, timeout=None):
            self.urls.append((url, params))
            return _StubResponse({"features": []})

    session = _SearchSession()
    stac.search_marktacke((15.5, 58.3, 15.6, 58.4), session=session)
    url, params = session.urls[0]
    assert url.startswith(stac.VEKTOR_STAC_URL)
    assert params["collections"] == "marktacke"
