"""clean-ortho --woodland tests: the forest-floor repaint on synthetic
orthos, offline and without torch (the LaMa pass gets a fake fill)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import box

from golfpipe import woodland_floor as wfl
from golfpipe.__main__ import main
from golfpipe.clean_ortho import CleanOrthoError
from golfpipe.commands import cmd_clean_ortho
from golfpipe.water import GEOJSON_CRS_3006

E0, N0 = 533000.0, 6473000.0
SIZE = 120  # 120x120 px at 0.5 m: a 60 m square
PX = 0.5
TRANSFORM = from_origin(E0, N0 + SIZE * PX, PX, PX)
PHOTO = (200, 40, 200)
BROWN = (90, 80, 50)


def _feature(geom, props: dict) -> dict:
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Polygon", "coordinates": [[list(c) for c in geom.exterior.coords]]}}


def _write(path: Path, features: list[dict]) -> Path:
    path.write_text(json.dumps({"type": "FeatureCollection", "crs": GEOJSON_CRS_3006, "features": features}))
    return path


def _image() -> np.ndarray:
    img = np.empty((SIZE, SIZE, 3), dtype=np.uint8)
    img[:] = PHOTO
    return img


def _px(e: float, n: float) -> tuple[int, int]:
    """(row, col) of the pixel holding the point e, n (metres from the south-west corner)."""
    return int((SIZE * PX - n) / PX), int(e / PX)


STAND = box(E0 + 10, N0 + 10, E0 + 50, N0 + 50)


def test_load_woodland_stands_filters_by_zone_type_and_reads_the_colour(tmp_path):
    path = _write(tmp_path / "w.geojson", [
        _feature(STAND, {"type": "vegetation_zone", "zoneType": "woodland_floor", "floorColor": "#5a5032",
                         "floorStdev": 7.5}),
        _feature(STAND, {"type": "vegetation_zone", "zoneType": "shrub"}),
        _feature(STAND, {"type": "fairway"}),
        _feature(STAND, {}),
    ])
    stands = wfl.load_woodland_stands(path, fallback_rgb=(10, 20, 30), fallback_stdev=4.0, mix=1.0)
    assert [(s.rgb, s.stdev, s.sampled) for s in stands] == [
        ((90.0, 80.0, 50.0), 7.5, True),
        ((10.0, 20.0, 30.0), 4.0, False),
    ]
    half = wfl.load_woodland_stands(path, fallback_rgb=(10, 20, 30), fallback_stdev=4.0, mix=0.5)
    assert [(s.rgb, s.stdev) for s in half] == [((50.0, 50.0, 40.0), 5.75), ((10.0, 20.0, 30.0), 4.0)]
    palette = wfl.load_woodland_stands(path, fallback_rgb=(10, 20, 30), fallback_stdev=4.0, mix=0.0)
    assert palette[0].rgb == (10.0, 20.0, 30.0) and palette[0].sampled
    with pytest.raises(CleanOrthoError):
        wfl.parse_hex_color("#12345")
    with pytest.raises(CleanOrthoError):
        wfl.load_woodland_stands(path, mix=1.5)


def test_noise_is_seamless_across_blocks_and_about_unit_spread():
    xs = E0 + np.arange(0, 200, 0.5)
    ys = N0 + 200 - np.arange(0, 200, 0.5)
    whole, hue = wfl.floor_noise(xs, ys, seed=3)
    top, _ = wfl.floor_noise(xs, ys[:150], seed=3)
    bottom, _ = wfl.floor_noise(xs, ys[150:], seed=3)
    assert np.array_equal(np.vstack([top, bottom]), whole)
    assert 0.7 < whole.std() < 1.3 and 0.6 < hue.std() < 1.4
    other, _ = wfl.floor_noise(xs, ys, seed=4)
    assert not np.allclose(other, whole)


def test_the_stand_is_painted_in_its_colour_with_a_feathered_edge():
    stand = wfl.FloorStand(STAND, BROWN, stdev=6.0)
    out, painted = wfl.paint_woodland_floor(_image(), TRANSFORM, [stand], feather_m=3.0, block_rows=37)
    centre = out[_px(30, 30)]
    assert np.all(np.abs(centre.astype(int) - BROWN) < 40)
    assert tuple(out[_px(5, 5)]) == PHOTO  # outside
    # 1 m inside the edge: a third floor, two thirds photo.
    edge = out[_px(11, 30)].astype(int)
    assert 110 < edge[0] < 190 and edge[1] < 80
    assert painted == pytest.approx((40 / PX) ** 2, rel=0.05)
    # Block size does not change the result.
    again, _ = wfl.paint_woodland_floor(_image(), TRANSFORM, [stand], feather_m=3.0, block_rows=1000)
    assert np.array_equal(out, again)


def test_the_keep_geometry_stays_photo():
    road = box(E0 + 28, N0, E0 + 32, N0 + 60)
    stand = wfl.FloorStand(STAND, BROWN, stdev=0.0)
    out, _ = wfl.paint_woodland_floor(_image(), TRANSFORM, [stand], keep=road, feather_m=0.0)
    assert tuple(out[_px(30, 30)]) == PHOTO
    assert tuple(out[_px(20, 30)]) == BROWN


def test_cmd_clean_ortho_paints_the_woodland_outside_the_corridor_and_roads(tmp_path):
    ortho = tmp_path / "ortho.tif"
    profile = {"driver": "GTiff", "height": SIZE, "width": SIZE, "count": 3, "dtype": "uint8",
               "crs": rasterio.crs.CRS.from_epsg(3006), "transform": TRANSFORM}
    with rasterio.open(ortho, "w", **profile) as dst:
        dst.write(np.moveaxis(_image(), -1, 0))
    trees = _write(tmp_path / "trees.geojson", [_feature(box(E0 + 2, N0 + 52, E0 + 6, N0 + 56), {"type": "trees"})])
    features = _write(tmp_path / "features.geojson", [_feature(box(E0, N0 + 50, E0 + 60, N0 + 60), {"type": "fairway"})])
    woodland = _write(tmp_path / "woodland.geojson", [
        _feature(box(E0 + 10, N0 + 10, E0 + 50, N0 + 55), {"type": "vegetation_zone", "zoneType": "woodland_floor"}),
    ])
    roads = _write(tmp_path / "roads.geojson", [_feature(box(E0 + 28, N0, E0 + 32, N0 + 50), {"type": "path"})])

    def fill(image, mask):
        out = image.copy()
        out[mask] = (0, 0, 255)
        return out

    out = cmd_clean_ortho(ortho, trees, features, woodland_path=woodland, keep_paths=[roads],
                          floor_color="#5a5032", floor_feather_m=0.0, inpaint_fn=fill)
    with rasterio.open(out) as src:
        cleaned = np.moveaxis(src.read(), 0, -1)
    assert np.all(np.abs(cleaned[_px(20, 30)].astype(int) - BROWN) < 40)  # woodland
    assert tuple(cleaned[_px(30, 30)]) == PHOTO  # road through it
    assert tuple(cleaned[_px(20, 53)]) == PHOTO  # corridor, not canopy
    assert tuple(cleaned[_px(4, 54)]) == (0, 0, 255)  # corridor canopy: the LaMa pass
    assert tuple(cleaned[_px(5, 5)]) == PHOTO  # outside everything

    # CLI: a tree outside the corridor keeps the LaMa mask empty, so no torch is needed.
    far_tree = _write(tmp_path / "far.geojson", [_feature(box(E0 + 2, N0 + 2, E0 + 6, N0 + 6), {"type": "trees"})])
    cli_out = tmp_path / "cli.tif"
    code = main(["clean-ortho", "--ortho", str(ortho), "--trees", str(far_tree), "--features", str(features),
                 "--woodland", str(woodland), "--keep", str(roads), "--floor-color", "#5a5032",
                 "--floor-feather", "0", "--floor-mix", "0.5", "--seed", "2", "--out", str(cli_out)])
    assert code in (0, None)
    with rasterio.open(cli_out) as src:
        cli = np.moveaxis(src.read(), 0, -1)
    assert np.all(np.abs(cli[_px(20, 30)].astype(int) - BROWN) < 40) and tuple(cli[_px(30, 30)]) == PHOTO
