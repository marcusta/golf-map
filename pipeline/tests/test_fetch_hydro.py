"""fetch-hydro tests — fully offline. The Hydrografi Direkt OGC API is
stubbed behind the session seam (same pattern as test_fetch_water.py): the
fixtures hand-build OGC API Features pages, including the service's quirks
verified live 2026-07-18 — EPSG:3006 output arrives in the official
(northing, easting) axis order, and paging is driven by `rel: next` links.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import requests
import shapely
from shapely.geometry import LineString, Polygon

from golfpipe import hydro
from golfpipe.commands import cmd_fetch_hydro
from golfpipe.stac import MissingCredentialsError

# Bbox around the conftest course spot near Linköping. WGS84 for the API
# calls (reprojects to ≈ (530960, 6472253, 533910, 6475618)), EPSG:3006 for
# direct clip/build calls — chosen so it CONTAINS the reprojected box and
# the "inside" fixtures below sit inside both.
BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)
BBOX_3006 = (530000.0, 6470000.0, 534500.0, 6476000.0)

POND = shapely.box(531400, 6472900, 531600, 6473100)  # inside bbox
WIDE_COURSE = shapely.box(531550, 6472950, 531700, 6473050)  # overlaps POND
FAR_POND = shapely.box(600000, 6600000, 600200, 6600200)  # far outside bbox
CREEK = LineString([(531200, 6473200), (531200, 6474200)])  # 1 km, inside
CREEK_2 = LineString([(532000, 6473000), (532000, 6473500)])  # inside, disjoint


def ne_coords(geom) -> list:
    """Encodes a shapely geometry's coordinates the way the live service
    serves EPSG:3006 — (northing, easting) axis order."""
    if geom.geom_type == "LineString":
        return [[y, x] for x, y in geom.coords]
    if geom.geom_type == "Polygon":
        return [[[y, x] for x, y in ring.coords]
                for ring in [geom.exterior, *geom.interiors]]
    raise AssertionError(f"unsupported fixture geometry {geom.geom_type}")


def feature(geom) -> dict:
    gtype = geom.geom_type
    return {
        "type": "Feature",
        "geometry": {"type": gtype, "coordinates": ne_coords(geom)},
        "properties": {"localType": "sjö" if gtype == "Polygon" else "vattendrag"},
    }


def page(features: list[dict], next_href: str | None = None) -> dict:
    links = [{"rel": "self", "href": "https://example.test/self"}]
    if next_href:
        links.append({"rel": "next", "href": next_href})
    return {"type": "FeatureCollection", "features": features, "links": links,
            "numberReturned": len(features)}


class _StubResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.headers = {"Content-Crs": f"<{hydro.CRS_3006_URI}>"}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error", response=self)

    def json(self):
        return self._payload


class _StubSession:
    """Routes first-page requests by collection id in the URL and follow-up
    pages by exact next-link href; records every call."""

    def __init__(self, first_pages: dict[str, dict], next_pages: dict[str, dict] | None = None):
        self.first_pages = first_pages
        self.next_pages = next_pages or {}
        self.calls: list[dict] = []

    def get(self, url, params=None, auth=None, timeout=None):
        self.calls.append({"url": url, "params": params, "auth": auth})
        if url in self.next_pages:
            return _StubResponse(self.next_pages[url])
        for collection_id, payload in self.first_pages.items():
            if f"/collections/{collection_id}/items" in url:
                return _StubResponse(payload)
        raise AssertionError(f"unexpected URL {url}")


@pytest.fixture
def creds(monkeypatch):
    monkeypatch.setenv("LANTMATERIET_USER", "someuser")
    monkeypatch.setenv("LANTMATERIET_PASS", "somepass")


# ─── axis swap ───────────────────────────────────────────────────────────────

def test_swap_axes_flips_positions_at_any_nesting():
    assert hydro._swap_axes([6473000.0, 531500.0]) == [531500.0, 6473000.0]
    assert hydro._swap_axes([[1.0, 2.0], [3.0, 4.0]]) == [[2.0, 1.0], [4.0, 3.0]]
    ring = [[[6472900.0, 531400.0], [6473100.0, 531600.0]]]
    assert hydro._swap_axes(ring) == [[[531400.0, 6472900.0], [531600.0, 6473100.0]]]


# ─── fetch_collection_geometries ─────────────────────────────────────────────

def test_fetch_follows_next_links_and_swaps_axes(creds):
    next_url = f"{hydro.HYDRO_API_URL}/collections/WatercourseLine/items?f=json&startindex=1"
    session = _StubSession(
        first_pages={"WatercourseLine": page([feature(CREEK)], next_href=next_url)},
        next_pages={next_url: page([feature(CREEK_2)])},
    )

    geoms = hydro.fetch_collection_geometries("WatercourseLine", BBOX_WGS84, session=session)

    assert len(geoms) == 2
    assert geoms[0].equals(CREEK)  # (n, e) input came back as (e, n)
    assert geoms[1].equals(CREEK_2)

    first, second = session.calls
    assert first["params"]["crs"] == hydro.CRS_3006_URI
    assert first["params"]["bbox"] == ",".join(str(v) for v in BBOX_WGS84)
    assert first["auth"] == ("someuser", "somepass")
    assert second["url"] == next_url
    assert second["params"] is None  # next hrefs carry the full query string


def test_fetch_requires_credentials(monkeypatch):
    monkeypatch.delenv("LANTMATERIET_USER", raising=False)
    monkeypatch.delenv("LANTMATERIET_PASS", raising=False)
    with pytest.raises(MissingCredentialsError):
        hydro.fetch_collection_geometries("StandingWater", BBOX_WGS84, session=_StubSession({}))


def test_fetch_401_names_the_entitlement_gap(creds):
    class _Denied:
        def get(self, url, params=None, auth=None, timeout=None):
            return _StubResponse({}, status_code=401)

    with pytest.raises(hydro.HydroError, match="Geotorget"):
        hydro.fetch_collection_geometries("StandingWater", BBOX_WGS84, session=_Denied())


def test_fetch_aborts_on_endless_next_links(creds):
    loop_url = f"{hydro.HYDRO_API_URL}/collections/StandingWater/items?loop=1"
    looping = page([], next_href=loop_url)
    session = _StubSession(
        first_pages={"StandingWater": looping},
        next_pages={loop_url: looping},
    )
    with pytest.raises(hydro.HydroError, match="pages"):
        hydro.fetch_collection_geometries("StandingWater", BBOX_WGS84, session=session)


def test_fetch_skips_null_geometry(creds):
    session = _StubSession(first_pages={"StandingWater": page([
        {"type": "Feature", "geometry": None, "properties": {}},
        feature(POND),
    ])})
    geoms = hydro.fetch_collection_geometries("StandingWater", BBOX_WGS84, session=session)
    assert len(geoms) == 1
    assert geoms[0].equals(POND)


# ─── clip_geometries ─────────────────────────────────────────────────────────

def test_clip_geometries_clips_drops_and_filters_by_kind():
    half_out = shapely.box(534000, 6473000, 535000, 6473500)  # straddles east edge
    polygons = hydro.clip_geometries([POND, FAR_POND, half_out], BBOX_3006, "polygon")
    assert len(polygons) == 2
    clipped = next(p for p in polygons if not p.equals(POND))
    assert clipped.bounds[2] == BBOX_3006[2]  # cut at the bbox east edge

    long_creek = LineString([(533000, 6460000), (533000, 6473000)])  # enters from south
    lines = hydro.clip_geometries([CREEK, long_creek, POND], BBOX_3006, "line")
    assert len(lines) == 2  # POND is not a line
    clipped_line = next(l for l in lines if not l.equals(CREEK))
    assert clipped_line.bounds[1] == BBOX_3006[1]


# ─── build_hydro_geojson ─────────────────────────────────────────────────────

def test_build_hydro_geojson_types_crs_union_and_creek_buffer():
    island_pond = Polygon(
        shapely.box(532500, 6474000, 532900, 6474400).exterior.coords,
        [list(reversed(shapely.box(532600, 6474100, 532700, 6474200).exterior.coords))],
    )
    collection = hydro.build_hydro_geojson([POND, WIDE_COURSE, island_pond], [CREEK], creek_width_m=2.0)

    assert collection["crs"]["properties"]["name"].endswith("EPSG::3006")
    assert collection["attribution"] == hydro.ATTRIBUTION
    waters = [f for f in collection["features"] if f["properties"]["type"] == "water"]
    creeks = [f for f in collection["features"] if f["properties"]["type"] == "water_creek"]

    # POND + overlapping WIDE_COURSE union into one surface; island pond
    # stays separate with its hole intact.
    assert len(waters) == 2
    assert any(len(f["geometry"]["coordinates"]) == 2 for f in waters)
    assert all(f["properties"]["source"] == hydro.SOURCE for f in waters + creeks)

    # 1000 m creek at 2 m total width ≈ 2000 m² ribbon (round caps add a bit).
    assert len(creeks) == 1
    ribbon = Polygon(creeks[0]["geometry"]["coordinates"][0])
    assert 1900 < ribbon.area < 2200


def test_build_hydro_geojson_empty_inputs():
    collection = hydro.build_hydro_geojson([], [])
    assert collection["features"] == []
    assert collection["crs"] == hydro.GEOJSON_CRS_3006


# ─── cmd_fetch_hydro end-to-end (stubbed session) ────────────────────────────

def test_cmd_fetch_hydro_end_to_end(tmp_path: Path, creds, capsys):
    next_url = f"{hydro.HYDRO_API_URL}/collections/WatercourseLine/items?f=json&startindex=1"
    session = _StubSession(
        first_pages={
            "StandingWater": page([feature(POND), feature(FAR_POND)]),
            "WatercoursePolygon": page([feature(WIDE_COURSE)]),
            "WatercourseLine": page([feature(CREEK)], next_href=next_url),
        },
        next_pages={next_url: page([feature(CREEK_2)])},
    )

    out = tmp_path / "hydro.geojson"
    cmd_fetch_hydro(BBOX_WGS84, out, creek_width_m=3.0, session=session)

    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["crs"] == hydro.GEOJSON_CRS_3006
    assert collection["attribution"] == hydro.ATTRIBUTION
    counts: dict[str, int] = {}
    for f in collection["features"]:
        counts[f["properties"]["type"]] = counts.get(f["properties"]["type"], 0) + 1
    # FAR_POND clipped away; POND + WIDE_COURSE merge; two disjoint creeks.
    assert counts == {"water": 1, "water_creek": 2}

    # All output coordinates are EPSG:3006 metres in (easting, northing)
    # order — the (northing, easting) service order must not leak through.
    for f in collection["features"]:
        for ring in f["geometry"]["coordinates"]:
            for x, y in ring:
                assert 400000 < x < 700000 and 6.3e6 < y < 6.6e6

    assert all(c["auth"] == ("someuser", "somepass") for c in session.calls)
    assert "Wrote" in capsys.readouterr().out
