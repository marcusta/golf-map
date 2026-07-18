"""fetch-osm tests — fully offline. Overpass JSON is hand-built (the shape
`out geom;` returns: ways carry an inline `geometry` list of {lat,lon},
relations carry `members` with per-way geometry + role), and the end-to-end
command test stubs the Overpass HTTP call behind the `overpass_fetch` seam so
pytest never touches the network. Reprojection uses rasterio locally (offline).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from rasterio.crs import CRS
from rasterio.warp import transform as warp_transform

from golfpipe import osm
from golfpipe.commands import cmd_fetch_osm

# WGS84 bbox near Linköping and its EPSG:3006 reprojection helper used by the
# pure-assembly tests. The fixtures below all sit inside this area.
BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)


def reproject(lons, lats):
    xs, ys = warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))
    return xs, ys


def geom(points: list[tuple[float, float]]) -> list[dict]:
    """(lon, lat) pairs -> Overpass `out geom` [{lat, lon}, …]."""
    return [{"lat": lat, "lon": lon} for lon, lat in points]


# A small closed square (lon/lat) inside the bbox, and an inner island.
GREEN = [(15.55, 58.40), (15.552, 58.40), (15.552, 58.401), (15.55, 58.401), (15.55, 58.40)]
LAKE_OUTER = [(15.56, 58.41), (15.564, 58.41), (15.564, 58.414), (15.56, 58.414), (15.56, 58.41)]
LAKE_INNER = [(15.561, 58.411), (15.563, 58.411), (15.563, 58.413), (15.561, 58.413), (15.561, 58.411)]


# ─── classify_osm_tags ───────────────────────────────────────────────────────

def test_classify_covers_golf_water_and_trees():
    assert osm.classify_osm_tags({"golf": "green"}) == "green"
    assert osm.classify_osm_tags({"golf": "tee"}) == "tee"
    assert osm.classify_osm_tags({"golf": "fairway"}) == "fairway"
    assert osm.classify_osm_tags({"golf": "bunker"}) == "bunker"
    assert osm.classify_osm_tags({"golf": "rough"}) == "rough"
    assert osm.classify_osm_tags({"golf": "water_hazard"}) == "water"
    assert osm.classify_osm_tags({"golf": "lateral_water_hazard"}) == "water"
    assert osm.classify_osm_tags({"natural": "water"}) == "water"
    assert osm.classify_osm_tags({"landuse": "forest"}) == "trees"
    assert osm.classify_osm_tags({"natural": "wood"}) == "trees"
    # Golf tags win over land cover; unknown/linear tags are dropped.
    assert osm.classify_osm_tags({"golf": "green", "natural": "water"}) == "green"
    assert osm.classify_osm_tags({"golf": "cartpath"}) is None
    assert osm.classify_osm_tags({"highway": "path"}) is None
    assert osm.classify_osm_tags({}) is None


# ─── build_overpass_query ────────────────────────────────────────────────────

def test_build_overpass_query_uses_sw_ne_bbox_and_out_geom():
    q = osm.build_overpass_query(BBOX_WGS84)
    # Overpass bbox order is S,W,N,E (not the WGS84 W,S,E,N input order).
    assert "(58.39,15.53,58.42,15.58)" in q
    assert 'way["golf"]' in q and 'relation["natural"="water"]' in q
    assert q.strip().endswith("out geom;")


# ─── stitch_rings ────────────────────────────────────────────────────────────

def test_stitch_rings_joins_split_ways_regardless_of_direction():
    # Two half-loops of a square, second one reversed — must stitch to a ring.
    a = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
    b = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0)]  # reversed relative to `a`'s end
    rings = osm.stitch_rings([a, b])
    assert len(rings) == 1
    assert osm._closed(rings[0])
    # An unclosable dangling way yields no ring.
    assert osm.stitch_rings([[(0.0, 0.0), (1.0, 0.0)]]) == []


# ─── assemble_features ───────────────────────────────────────────────────────

def test_assemble_closed_way_becomes_polygon_with_provenance():
    data = {"elements": [
        {"type": "way", "id": 111, "tags": {"golf": "green"}, "geometry": geom(GREEN)},
    ]}
    features, skipped = osm.assemble_features(data, reproject)
    assert len(features) == 1 and not skipped
    feat = features[0]
    assert feat["type"] == "green" and feat["osm_type"] == "way" and feat["osm_id"] == 111
    # Reprojected into EPSG:3006 metres (SWEREF99 TM easting/northing ranges).
    x, y = list(feat["polygon"].exterior.coords)[0]
    assert 400000 < x < 700000 and 6.3e6 < y < 6.6e6


def test_assemble_relation_multipolygon_keeps_hole():
    data = {"elements": [
        {
            "type": "relation", "id": 222, "tags": {"type": "multipolygon", "natural": "water"},
            "members": [
                {"type": "way", "role": "outer", "geometry": geom(LAKE_OUTER)},
                {"type": "way", "role": "inner", "geometry": geom(LAKE_INNER)},
            ],
        },
    ]}
    features, skipped = osm.assemble_features(data, reproject)
    assert len(features) == 1 and not skipped
    poly = features[0]["polygon"]
    assert features[0]["type"] == "water"
    assert len(poly.interiors) == 1  # the island survives as a hole
    assert poly.area > 0


def test_assemble_skips_and_logs_open_classified_way_but_ignores_unclassified():
    data = {"elements": [
        {"type": "way", "id": 1, "tags": {"golf": "fairway"}, "geometry": geom(GREEN[:-1])[:2]},  # 2 pts, can't close
        {"type": "way", "id": 2, "tags": {"highway": "path"}, "geometry": geom(GREEN)},  # unclassified: silent
    ]}
    features, skipped = osm.assemble_features(data, reproject)
    assert features == []
    assert len(skipped) == 1 and "way/1" in skipped[0]


# ─── build_osm_geojson ───────────────────────────────────────────────────────

def test_build_geojson_carries_crs_attribution_and_odbl_provenance():
    data = {"elements": [
        {"type": "way", "id": 111, "tags": {"golf": "green"}, "geometry": geom(GREEN)},
    ]}
    features, _ = osm.assemble_features(data, reproject)
    collection = osm.build_osm_geojson(features, fetch_date="2026-07-18")

    assert collection["type"] == "FeatureCollection"
    assert collection["crs"]["properties"]["name"].endswith("EPSG::3006")
    assert "OpenStreetMap" in collection["attribution"] and "ODbL" in collection["attribution"]
    props = collection["features"][0]["properties"]
    assert props == {
        "type": "green", "source": "osm", "osm_type": "way",
        "osm_id": 111, "fetched": "2026-07-18",
    }
    # Straight-segment polygon rings, 3006 coords.
    ring = collection["features"][0]["geometry"]["coordinates"][0]
    assert collection["features"][0]["geometry"]["type"] == "Polygon"
    for x, y in ring:
        assert 400000 < x < 700000 and 6.3e6 < y < 6.6e6


# ─── cmd_fetch_osm end-to-end (stubbed Overpass) ─────────────────────────────

def test_cmd_fetch_osm_end_to_end(tmp_path: Path, capsys):
    payload = {"elements": [
        {"type": "way", "id": 111, "tags": {"golf": "green"}, "geometry": geom(GREEN)},
        {
            "type": "relation", "id": 222, "tags": {"type": "multipolygon", "natural": "water"},
            "members": [
                {"type": "way", "role": "outer", "geometry": geom(LAKE_OUTER)},
                {"type": "way", "role": "inner", "geometry": geom(LAKE_INNER)},
            ],
        },
        {"type": "way", "id": 333, "tags": {"landuse": "forest"}, "geometry": geom(GREEN)},
    ]}

    calls = []

    def stub_fetch(query, *, url):
        calls.append((query, url))
        return payload

    out = tmp_path / "osm.geojson"
    cmd_fetch_osm(BBOX_WGS84, out, overpass_fetch=stub_fetch, overpass_url="http://stub/api")

    assert calls and calls[0][1] == "http://stub/api"
    assert "out geom;" in calls[0][0]

    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["crs"] == osm.GEOJSON_CRS_3006
    types = sorted(f["properties"]["type"] for f in collection["features"])
    assert types == ["green", "trees", "water"]
    for feature in collection["features"]:
        assert feature["properties"]["source"] == "osm"
        for ring in feature["geometry"]["coordinates"]:
            for x, y in ring:
                assert 400000 < x < 700000 and 6.3e6 < y < 6.6e6
    assert "Wrote" in capsys.readouterr().out


def test_cmd_fetch_osm_writes_empty_collection_when_nothing_mapped(tmp_path: Path, capsys):
    out = tmp_path / "osm.geojson"
    cmd_fetch_osm(BBOX_WGS84, out, overpass_fetch=lambda q, *, url: {"elements": []})
    collection = json.loads(out.read_text(encoding="utf-8"))
    assert collection["features"] == []
    assert "no golf/terrain polygons" in capsys.readouterr().out


def test_fetch_overpass_wraps_urlerror(monkeypatch):
    import urllib.request

    def boom(req, timeout):
        import urllib.error
        raise urllib.error.URLError("no network")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with pytest.raises(osm.OsmError, match="Overpass request"):
        osm.fetch_overpass("data", url="http://stub/api")
