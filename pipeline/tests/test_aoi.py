"""Tests for --bbox / --aoi resolution (golfpipe.aoi). No network."""

import json
from pathlib import Path

import pytest

from golfpipe.aoi import AoiError, bbox_from_geojson, parse_bbox, resolve_bbox


def test_parse_bbox_valid():
    assert parse_bbox("15.55,58.39,15.58,58.41") == (15.55, 58.39, 15.58, 58.41)


def test_parse_bbox_rejects_wrong_arity():
    with pytest.raises(AoiError):
        parse_bbox("15.55,58.39,15.58")


def test_parse_bbox_rejects_non_numeric():
    with pytest.raises(AoiError):
        parse_bbox("a,b,c,d")


def test_parse_bbox_rejects_out_of_range_lon():
    # Looks like it could be a projected-CRS value (SWEREF99 TM easting),
    # not WGS84 longitude.
    with pytest.raises(AoiError):
        parse_bbox("533000,6472500,535000,6475000")


def test_parse_bbox_rejects_inverted_order():
    with pytest.raises(AoiError):
        parse_bbox("15.58,58.39,15.55,58.41")  # west > east


def test_bbox_from_geojson_bare_polygon(tmp_path: Path):
    geom = {
        "type": "Polygon",
        "coordinates": [
            [
                [15.55, 58.39],
                [15.58, 58.39],
                [15.58, 58.41],
                [15.55, 58.41],
                [15.55, 58.39],
            ]
        ],
    }
    path = tmp_path / "aoi.geojson"
    path.write_text(json.dumps(geom), encoding="utf-8")

    bbox = bbox_from_geojson(path)
    assert bbox == pytest.approx((15.55, 58.39, 15.58, 58.41))


def test_bbox_from_geojson_feature_collection(tmp_path: Path):
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [15.55, 58.39],
                            [15.56, 58.39],
                            [15.56, 58.40],
                            [15.55, 58.40],
                            [15.55, 58.39],
                        ]
                    ],
                },
            },
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Point",
                    "coordinates": [15.60, 58.42],
                },
            },
        ],
    }
    path = tmp_path / "aoi_fc.geojson"
    path.write_text(json.dumps(fc), encoding="utf-8")

    bbox = bbox_from_geojson(path)
    # Combined bbox of the polygon AND the extra point.
    assert bbox == pytest.approx((15.55, 58.39, 15.60, 58.42))


def test_bbox_from_geojson_single_feature(tmp_path: Path):
    feature = {
        "type": "Feature",
        "properties": {},
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [15.55, 58.39],
                    [15.58, 58.39],
                    [15.58, 58.41],
                    [15.55, 58.41],
                    [15.55, 58.39],
                ]
            ],
        },
    }
    path = tmp_path / "aoi_feature.geojson"
    path.write_text(json.dumps(feature), encoding="utf-8")

    bbox = bbox_from_geojson(path)
    assert bbox == pytest.approx((15.55, 58.39, 15.58, 58.41))


def test_bbox_from_geojson_empty_feature_collection_errors(tmp_path: Path):
    path = tmp_path / "empty.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")
    with pytest.raises(AoiError):
        bbox_from_geojson(path)


def test_bbox_from_geojson_rejects_projected_coords(tmp_path: Path):
    """A polygon in SWEREF99 TM metres (not WGS84) should be rejected by
    the lon/lat range check rather than silently producing a bogus bbox.
    """
    geom = {
        "type": "Polygon",
        "coordinates": [
            [
                [533000.0, 6472500.0],
                [535000.0, 6472500.0],
                [535000.0, 6475000.0],
                [533000.0, 6475000.0],
                [533000.0, 6472500.0],
            ]
        ],
    }
    path = tmp_path / "projected.geojson"
    path.write_text(json.dumps(geom), encoding="utf-8")
    with pytest.raises(AoiError):
        bbox_from_geojson(path)


def test_bbox_from_geojson_invalid_json(tmp_path: Path):
    path = tmp_path / "bad.geojson"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(AoiError):
        bbox_from_geojson(path)


def test_resolve_bbox_prefers_explicit_bbox():
    assert resolve_bbox("15.55,58.39,15.58,58.41", None) == (15.55, 58.39, 15.58, 58.41)


def test_resolve_bbox_uses_aoi_file(tmp_path: Path):
    geom = {
        "type": "Polygon",
        "coordinates": [[[15.55, 58.39], [15.58, 58.39], [15.58, 58.41], [15.55, 58.41], [15.55, 58.39]]],
    }
    path = tmp_path / "aoi.geojson"
    path.write_text(json.dumps(geom), encoding="utf-8")
    assert resolve_bbox(None, str(path)) == pytest.approx((15.55, 58.39, 15.58, 58.41))


def test_resolve_bbox_requires_one_of_bbox_or_aoi():
    with pytest.raises(AoiError):
        resolve_bbox(None, None)


def test_resolve_bbox_rejects_both():
    with pytest.raises(AoiError):
        resolve_bbox("15.55,58.39,15.58,58.41", "somefile.geojson")
