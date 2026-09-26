"""Building removal for the orthophoto export: synthetic photos with a
roof, its shadow and ground round it; a roof-heights GeoTIFF and a building
survey in tmp_path. Offline, no torch.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from golfpipe import building_removal as br

E0, N0 = 531000.0, 6473000.0
SIZE = 400  # 400 px at 0.25 m: a 100 m square
PX = 0.25
TRANSFORM = from_origin(E0, N0 + SIZE * PX, PX, PX)
GRASS = (90, 140, 60)
GRAVEL = (170, 160, 140)
ROOF = (150, 50, 40)
SHADE = (30, 40, 25)


def _px(e: float, n: float) -> tuple[int, int]:
    return int((SIZE * PX - n) / PX), int(e / PX)


def _scene(azimuth_deg: float = 45.0, ratio: float = 1.0, height: float = 8.0):
    """Grass with a gravel strip along the south; a 12 x 12 m roof at
    (40..52, 40..52) m, `height` tall, casting its shadow toward azimuth_deg
    for height x ratio metres. Returns (rgb, heights)."""
    rgb = np.empty((SIZE, SIZE, 3), dtype=np.uint8)
    rgb[:] = GRASS
    rgb[_px(0, 10)[0]:, :] = GRAVEL
    heights = np.zeros((SIZE, SIZE), dtype=np.float32)
    r0, c0 = _px(40, 52)
    r1, c1 = _px(52, 40)
    heights[r0:r1, c0:c1] = height
    shadow = br.shadow_mask(heights, PX, azimuth_deg, ratio)
    rgb[shadow] = SHADE
    rgb[heights > 0] = ROOF
    return rgb, heights


def test_shadow_mask_falls_toward_the_azimuth_for_height_times_ratio():
    heights = np.zeros((SIZE, SIZE), dtype=np.float32)
    r0, c0 = _px(40, 52)
    r1, c1 = _px(52, 40)
    heights[r0:r1, c0:c1] = 8.0
    east = br.shadow_mask(heights, PX, 90.0, 1.0)
    assert east[_px(55, 46)] and east[_px(59.5, 46)]
    assert not east[_px(61, 46)] and not east[_px(36, 46)]
    assert not east[_px(46, 46)]  # the roof is not its own shadow
    north = br.shadow_mask(heights, PX, 0.0, 0.5)
    assert north[_px(46, 55)] and not north[_px(46, 57)]


def test_estimate_shadow_measures_direction_and_length():
    rgb, heights = _scene(azimuth_deg=45.0, ratio=1.0)
    shadow = br.estimate_shadow(rgb, heights, PX)
    assert shadow.measured
    assert shadow.azimuth_deg == pytest.approx(45.0, abs=10.0)
    assert shadow.ratio == pytest.approx(1.0, abs=0.35)


def test_too_few_roofs_or_no_contrast_falls_back():
    rgb, heights = _scene()
    tiny = np.zeros_like(heights)
    tiny[:8, :8] = 3.0  # 4 m²
    assert not br.estimate_shadow(rgb, tiny, PX).measured
    flat = np.empty_like(rgb)
    flat[:] = GRASS
    shadow = br.estimate_shadow(flat, heights, PX)
    assert not shadow.measured and shadow.azimuth_deg == br.FALLBACK_AZIMUTH_DEG


def test_remove_buildings_fills_roof_and_shadow_from_the_ground_round_them():
    rgb, heights = _scene(azimuth_deg=45.0, ratio=1.0)
    out, report = br.remove_buildings(rgb, TRANSFORM, heights, grow_m=1.0, feather_m=0.5)
    assert report.buildings == 1 and report.shadow.measured
    for e, n in ((46, 46), (56, 56)):  # roof, shadow
        assert np.all(np.abs(out[_px(e, n)].astype(int) - GRASS) < 30), (e, n)
    assert tuple(out[_px(10, 80)]) == GRASS  # far away: untouched
    assert tuple(out[_px(50, 3)]) == GRAVEL


def test_small_roofs_are_dropped_and_no_roofs_is_a_copy():
    rgb, _ = _scene()
    van = np.zeros((SIZE, SIZE), dtype=np.float32)
    van[100:108, 100:120] = 2.5  # 2 x 5 m
    out, report = br.remove_buildings(rgb, TRANSFORM, van)
    assert report.buildings == 0 and np.array_equal(out, rgb)


def test_given_shadow_is_used_as_is():
    rgb, heights = _scene(azimuth_deg=180.0, ratio=1.0)
    _, report = br.remove_buildings(rgb, TRANSFORM, heights, azimuth_deg=180.0, ratio=1.0)
    assert (report.shadow.azimuth_deg, report.shadow.ratio, report.shadow.measured) == (180.0, 1.0, False)


def test_roof_heights_on_grid_keeps_zero_as_zero(tmp_path):
    """GDAL nudges valid zeros to the smallest float when the destination
    nodata is 0; the whole square then read as one roof on Vreta."""
    src = np.zeros((100, 100), dtype=np.float32)
    src[40:52, 40:52] = 8.0
    path = tmp_path / "roofs.tif"
    with rasterio.open(path, "w", driver="GTiff", height=100, width=100, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + 100, 1.0, 1.0), nodata=-1.0) as dst:
        dst.write(src, 1)
    grid = br.roof_heights_on_grid(path, TRANSFORM, (SIZE, SIZE))
    assert np.count_nonzero(grid) == 48 * 48
    assert grid[_px(46, 55)] == 8.0 and grid[_px(10, 10)] == 0.0


def test_burn_survey_adds_buildings_the_lidar_missed(tmp_path):
    ring = [[E0 + 20, N0 + 20], [E0 + 30, N0 + 20], [E0 + 30, N0 + 30], [E0 + 20, N0 + 30], [E0 + 20, N0 + 20]]
    survey = tmp_path / "buildings.geojson"
    survey.write_text(json.dumps({
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3006"}},
        "features": [
            {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]},
             "properties": {"type": "building", "id": "osm:way/1", "kind": "yes"}},
            {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[E0 + 500, N0 + 500], [E0 + 510, N0 + 500],
                                                                                  [E0 + 510, N0 + 510], [E0 + 500, N0 + 500]]]},
             "properties": {"type": "building", "id": "osm:way/2", "kind": "yes", "levels": 3}},
        ],
    }))
    heights, touched = br.burn_survey(np.zeros((SIZE, SIZE), dtype=np.float32), TRANSFORM, survey)
    assert touched == 1
    assert heights[_px(25, 25)] == br.SURVEY_DEFAULT_HEIGHT_M
    # Grown by SURVEY_GROW_M for OSM offsets and roof lean.
    assert heights[_px(20 - br.SURVEY_GROW_M + 0.5, 25)] > 0 and heights[_px(20 - br.SURVEY_GROW_M - 0.5, 25)] == 0
