"""Hole-by-hole photo cleanup (golfpipe.hole_cleanup) on a synthetic hole:
real rasters and real geometry; the fill is a plain mean of what the fill may
see, so a test can tell which ground a surface was filled from. Torch-free and
PhotoCraft-free.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform_geom

from golfpipe import hole_cleanup
from golfpipe.__main__ import main

# A 64 m square at 0.25 m/px, the cleaned photo's own scale (the rules count pixels).
E0, N0 = 533000.0, 6473000.0
PX = 0.25
SIZE = 256

ROUGH = (95, 120, 60)
FAIRWAY = (110, 150, 70)
GREEN = (120, 170, 80)
WATER = (40, 60, 90)
SHADOW = (35, 45, 25)
PLAYER = (240, 240, 240)


def box(x0: float, y0: float, x1: float, y1: float) -> dict:
    """A rectangle in metres from the photo's south-west corner, as WGS84."""
    ring = [[E0 + x0, N0 + y0], [E0 + x1, N0 + y0], [E0 + x1, N0 + y1], [E0 + x0, N0 + y1], [E0 + x0, N0 + y0]]
    return transform_geom("EPSG:3006", "EPSG:4326", {"type": "Polygon", "coordinates": [ring]})


def rows(y0: float, y1: float) -> slice:
    return slice(round((64 - y1) / PX), round((64 - y0) / PX))


def cols(x0: float, x1: float) -> slice:
    return slice(round(x0 / PX), round(x1 / PX))


def feature(typ: str, geom: dict, hole: int | None = None) -> dict:
    props = {"type": typ, **({"hole": hole} if hole else {})}
    return {"type": "Feature", "properties": props, "geometry": geom}


def area(kind: str, geom: dict) -> dict:
    return {"id": kind, "name": kind, "kind": kind, "ring": geom["coordinates"][0]}


@pytest.fixture
def scene(tmp_path: Path):
    rng = np.random.default_rng(3)
    rgb = np.empty((SIZE, SIZE, 3), np.float32)
    rgb[:] = ROUGH
    rgb[rows(20, 44), cols(0, 64)] = FAIRWAY
    rgb[rows(26, 38), cols(44, 56)] = GREEN
    rgb[rows(2, 10), cols(50, 62)] = WATER
    rgb += rng.normal(0, 3, rgb.shape)
    # A crown's shadow on the rough, one on the fairway's edge, and one inside Keep unchanged.
    rgb[rows(48, 56), cols(8, 16)] = SHADOW
    rgb[rows(42, 46), cols(20, 26)] = SHADOW
    rgb[rows(2, 8), cols(2, 8)] = SHADOW
    # A player on the green.
    rgb[rows(31, 32), cols(49, 50)] = PLAYER
    photo = np.clip(rgb, 0, 255).astype(np.uint8)

    work = tmp_path / "work.tif"
    with rasterio.open(work, "w", driver="GTiff", height=SIZE, width=SIZE, count=3, dtype="uint8",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + 64, PX, PX)) as dst:
        dst.write(np.moveaxis(photo, 2, 0))
    features = [
        feature("rough", box(0, 0, 64, 64)),
        feature("fairway", box(0, 20, 64, 44), hole=1),
        feature("green", box(44, 26, 56, 38), hole=1),
        feature("water", box(50, 2, 62, 10)),
    ]
    areas = [area("include", box(0, 0, 64, 64)), area("exclude", box(0, 0, 12, 12))]
    return {"work": work, "photo": photo, "features": features, "areas": areas, "out": tmp_path / "h1"}


def mean_fill(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Fills each hidden pixel with the nearest pixel the fill may see: it
    continues what lies next to the hole, as LaMa does."""
    from scipy import ndimage as ndi

    _, (iy, ix) = ndi.distance_transform_edt(mask, return_indices=True)
    return image[iy, ix]


def lum(px: np.ndarray) -> float:
    return float((px.reshape(-1, 3).astype(np.float32) @ np.array([0.299, 0.587, 0.114])).mean())


def read(path: Path) -> np.ndarray:
    with rasterio.open(path) as src:
        return np.moveaxis(src.read([1, 2, 3]), 0, 2)


def test_a_hole_loses_its_shadows_and_players_and_nothing_else(scene):
    doc = hole_cleanup.clean_hole(scene["work"], scene["features"], scene["areas"], 1, None, scene["out"], mean_fill, None)
    after = read(scene["work"])
    before = scene["photo"]

    # The crown's shadow on the rough is now lit rough, filled from rough only.
    assert lum(after[rows(48, 56), cols(8, 16)]) > 0.9 * lum(before[rows(58, 62), cols(30, 40)])
    # The shadow across the fairway's edge: each side filled from its own surface, so the edge stays.
    fair = after[rows(42, 44), cols(20, 26)].reshape(-1, 3).mean(axis=0)
    rough = after[rows(44, 46), cols(20, 26)].reshape(-1, 3).mean(axis=0)
    assert np.abs(fair - FAIRWAY).max() < 12 and np.abs(rough - ROUGH).max() < 12
    # The player is green grass now.
    assert np.abs(after[rows(31, 32), cols(49, 50)].reshape(-1, 3).mean(axis=0) - GREEN).max() < 12
    # Water and Keep unchanged are as photographed, and so is everything that was no target.
    assert (after[rows(2, 10), cols(50, 62)] == before[rows(2, 10), cols(50, 62)]).all()
    assert (after[rows(2, 8), cols(2, 8)] == before[rows(2, 8), cols(2, 8)]).all()
    changed = np.asarray(Image.open(scene["out"] / "changed.png")) > 0
    assert (after[~changed] == before[~changed]).all()
    assert doc["changedPx"] == int(changed.sum()) > 0
    assert doc["hole"] == 1 and doc["scopePx"] > 0 and doc["targetPx"] >= doc["changedPx"]

    # Without PhotoCraft every surface is LaMa's, and the hole says so.
    assert any("PhotoCraft not found" in w for w in doc["warnings"])
    for name in ("photo.png", "filled.png", "review.png", "detect.png", "overlay.png", "hole.json"):
        assert (scene["out"] / name).is_file(), name
    assert json.loads((scene["out"] / "hole.json").read_text())["changedPx"] == doc["changedPx"]


def test_a_hole_without_a_saved_view_is_the_box_round_its_own_features(scene):
    x0, y0, x1, y1 = hole_cleanup.hole_box3006(1, None, scene["features"])
    assert (x0, y0) == pytest.approx((E0 - 40, N0 + 20 - 40), abs=0.01)
    assert (x1, y1) == pytest.approx((E0 + 64 + 40, N0 + 44 + 40), abs=0.01)
    with pytest.raises(hole_cleanup.HoleCleanupError, match="hole 2 has neither"):
        hole_cleanup.hole_box3006(2, None, scene["features"])


def test_no_cleanup_area_changes_nothing(scene):
    doc = hole_cleanup.clean_hole(scene["work"], scene["features"], [], 1, None, scene["out"], mean_fill, None)
    assert doc["scopePx"] == 0 and doc["changedPx"] == 0
    assert (read(scene["work"]) == scene["photo"]).all()


def test_compose_lays_only_the_changed_pixels_of_the_accepted_holes(scene, tmp_path: Path):
    hole_cleanup.clean_hole(scene["work"], scene["features"], scene["areas"], 1, None, tmp_path / "job" / "h1", mean_fill, None)
    out = tmp_path / "overlay.png"
    assert main(["cleanup-compose", "--job", str(tmp_path / "job"), "--holes", "1", "--size", str(SIZE), "--out", str(out)]) in (0, None)
    rgba = np.asarray(Image.open(out))
    changed = np.asarray(Image.open(tmp_path / "job" / "h1" / "changed.png")) > 0
    assert rgba.shape == (SIZE, SIZE, 4)
    assert ((rgba[..., 3] == 255) == changed).all()
    filled = np.asarray(Image.open(tmp_path / "job" / "h1" / "filled.png"))
    assert (rgba[changed][:, :3] == filled[changed]).all()
    # A hole that never ran is refused, not composed as empty.
    assert main(["cleanup-compose", "--job", str(tmp_path / "job"), "--holes", "1,2", "--size", str(SIZE), "--out", str(out)]) == 1
