"""building-pads tests — offline. A survey GeoJSON is built from the same
hand-made Overpass JSON fetch-buildings tests use, the pad edits are checked
for extent (footprint + apron dead flat, feather outside) both as geometry
and by replaying them onto a synthetic DEM with apply-dem-edits — together
with a hand-drawn edits file, the two-file case the map build runs.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform as warp_transform
from shapely.geometry import Point, box, shape

from golfpipe import buildings
from golfpipe.commands import cmd_apply_dem_edits, cmd_building_pads, cmd_fetch_buildings

BBOX_WGS84 = (15.53, 58.39, 15.58, 58.42)
HOUSE = [(15.550, 58.400), (15.55024, 58.400), (15.55024, 58.40008), (15.550, 58.40008), (15.550, 58.400)]


def reproject(lons, lats):
    return warp_transform(CRS.from_epsg(4326), CRS.from_epsg(3006), list(lons), list(lats))


def to_wgs84(xs, ys):
    return warp_transform(CRS.from_epsg(3006), CRS.from_epsg(4326), list(xs), list(ys))


def way(osm_id, points, **tags):
    return {"type": "way", "id": osm_id, "tags": tags, "geometry": [{"lat": lat, "lon": lon} for lon, lat in points]}


def survey_file(tmp_path: Path, elements) -> Path:
    out = tmp_path / "buildings.geojson"
    cmd_fetch_buildings(BBOX_WGS84, out, overpass_fetch=lambda q, *, url="": {"elements": elements})
    return out


def test_read_survey_roundtrips_fetch_buildings_output(tmp_path: Path):
    path = survey_file(tmp_path, [way(1, HOUSE, building="detached", **{"building:levels": "2"})])
    [b] = buildings.read_survey(path)
    assert b.id == "osm:way/1" and b.kind == "detached" and b.levels == 2.0
    assert b.rect.length_m > b.rect.width_m > 0
    assert b.roof is None
    assert 100 < b.polygon.area < 160


def test_pad_polygon_grows_by_apron_plus_feather():
    footprint = box(0, 0, 10, 6)
    pad = buildings.pad_polygon(footprint, buffer_m=1.5, feather_m=4.0)
    assert pad.contains(Point(-5.4, 3))  # 5.5 m out along a side, just inside
    assert not pad.contains(Point(-5.6, 3))
    assert pad.contains(footprint.buffer(1.5))


def test_pad_edit_features_are_d_te5_planes_with_origin():
    footprint = box(500_000, 6_470_000, 500_012, 6_470_008)
    b = buildings.Building("osm:way/1", "way", 1, "detached", None, None, None, footprint, buildings.footprint_rect(footprint))
    [feature] = buildings.pad_edit_features([b], to_wgs84, buffer_m=1.5, feather_m=4.0, created_at="2026-09-15T10:00:00Z")
    props = feature["properties"]
    assert props["op"] == "plane" and props["flat"] is True and props["featherM"] == 4.0
    assert props["origin"] == "building-pads" and props["originRef"] == "osm:way/1"
    assert props["createdAt"] == "2026-09-15T10:00:00Z#00000"
    assert props["kind"] == "detached" and props["areaM2"] == 96.0
    ring = feature["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1]
    # WGS84 degrees, and the ring reprojects back to the pad polygon.
    assert all(14 < lon < 17 and 58 < lat < 59 for lon, lat in ring)
    xs, ys = reproject([p[0] for p in ring], [p[1] for p in ring])
    back = shape({"type": "Polygon", "coordinates": [list(zip(xs, ys))]})
    pad = buildings.pad_polygon(footprint, 1.5, 4.0)
    assert back.symmetric_difference(pad).area < 0.02 * pad.area

    # Sloped pads leave `flat` out.
    [sloped] = buildings.pad_edit_features([b], to_wgs84, flat=False)
    assert "flat" not in sloped["properties"] and sloped["properties"]["createdAt"] is None


def test_cmd_building_pads_writes_one_edit_per_building(tmp_path: Path, capsys):
    survey = survey_file(tmp_path, [
        way(1, HOUSE, building="detached"),
        way(2, [(15.56, 58.41), (15.5602, 58.41), (15.5602, 58.4101), (15.56, 58.4101), (15.56, 58.41)], building="garage"),
    ])
    out = tmp_path / "pads.geojson"
    assert cmd_building_pads(survey, out, buffer_m=1.0, feather_m=3.0) == out
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["type"] == "FeatureCollection" and "crs" not in doc  # D-TE5 is plain WGS84
    assert [f["properties"]["originRef"] for f in doc["features"]] == ["osm:way/1", "osm:way/2"]
    assert all(f["properties"]["featherM"] == 3.0 for f in doc["features"])
    printed = capsys.readouterr().out
    assert "Building pads: 2 plane edits (flat, apron 1 m, feather 3 m)" in printed


# ─── replay: the pad flattens the DEM under the house, with the site's own edit ──

def _sloped_dem(path: Path, footprint) -> tuple[Path, float]:
    """80×80 m, 1 m cells, a 5 % east-west slope with 0.4 m bumps, centred on the footprint."""
    cx, cy = footprint.centroid.x, footprint.centroid.y
    x0, y1 = math.floor(cx) - 40, math.ceil(cy) + 40
    transform = from_origin(x0, y1, 1.0, 1.0)
    cols = np.arange(80, dtype=np.float64)
    rng = np.random.default_rng(7)
    dem = 50.0 + 0.05 * cols[None, :] + rng.uniform(-0.4, 0.4, size=(80, 80))
    with rasterio.open(
        path, "w", driver="GTiff", height=80, width=80, count=1, dtype="float32",
        crs=CRS.from_epsg(3006), transform=transform, nodata=-9999.0,
    ) as dst:
        dst.write(dem.astype(np.float32), 1)
    return path, float(np.ptp(dem))


def test_pads_flatten_footprint_alongside_site_edits(tmp_path: Path, capsys):
    survey = survey_file(tmp_path, [way(1, HOUSE, building="detached")])
    [b] = buildings.read_survey(survey)
    dem_path, _ = _sloped_dem(tmp_path / "dem.tif", b.polygon)
    pads = cmd_building_pads(survey, tmp_path / "pads.geojson", buffer_m=1.5, feather_m=3.0)

    # A hand-drawn smooth edit elsewhere on the grid, as the server would export it.
    e0, n0, e1, n1 = b.polygon.bounds
    lons, lats = to_wgs84([e0 - 30, e0 - 20, e0 - 20, e0 - 30], [n0, n0, n0 + 10, n0 + 10])
    site_edits = tmp_path / "site.geojson"
    site_edits.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"op": "smooth", "featherM": 1, "radiusM": 2, "createdAt": "2026-09-15T11:00:00Z"},
        "geometry": {"type": "Polygon", "coordinates": [[[lon, lat] for lon, lat in zip(lons, lats)] + [[lons[0], lats[0]]]]},
    }]}), encoding="utf-8")

    out = cmd_apply_dem_edits(dem_path, [site_edits, pads], tmp_path / "dem-edited.tif")
    assert "Applied 2 edit(s)" in capsys.readouterr().out
    with rasterio.open(out) as src, rasterio.open(dem_path) as raw:
        edited, before = src.read(1), raw.read(1)
        # Every cell under the footprint (+ apron) is at one height now.
        mask = rasterio.features.geometry_mask([b.polygon.buffer(1.5)], out_shape=edited.shape,
                                               transform=src.transform, invert=True)
        assert mask.sum() > 100
        assert float(np.ptp(edited[mask])) < 0.01
        assert float(np.ptp(before[mask])) > 0.5
        # Far from both edits nothing moved.
        far = np.zeros(edited.shape, dtype=bool)
        far[:5, -5:] = True
        assert np.array_equal(edited[far], before[far])


def test_apply_dem_edits_single_path_still_works(tmp_path: Path):
    survey = survey_file(tmp_path, [way(1, HOUSE, building="detached")])
    [b] = buildings.read_survey(survey)
    dem_path, _ = _sloped_dem(tmp_path / "dem.tif", b.polygon)
    pads = cmd_building_pads(survey, tmp_path / "pads.geojson")
    out = cmd_apply_dem_edits(dem_path, pads, tmp_path / "dem-edited.tif")
    with rasterio.open(out) as src:
        assert src.read(1).shape == (80, 80)


def test_cmd_building_pads_square_keeps_only_the_inner_terrains_buildings(tmp_path: Path, capsys):
    garage = [(15.56, 58.41), (15.5602, 58.41), (15.5602, 58.4101), (15.56, 58.4101), (15.56, 58.41)]
    survey = survey_file(tmp_path, [way(1, HOUSE, building="detached"), way(2, garage, building="garage")])
    # A square round the house only (the garage is ~1 km away): the inner terrain.
    xs, ys = reproject([p[0] for p in HOUSE], [p[1] for p in HOUSE])
    square = (min(xs) - 100, min(ys) - 100, max(xs) + 100, max(ys) + 100)
    out = cmd_building_pads(survey, tmp_path / "pads.geojson", square_3006=square)
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert [f["properties"]["originRef"] for f in doc["features"]] == ["osm:way/1"]
    assert "; 1 building(s) outside the square left without a pad" in capsys.readouterr().out
