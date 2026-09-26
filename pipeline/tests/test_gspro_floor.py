"""gspro ortho --floor-course: the course's woodland_floor zones painted as
forest floor on the exported square (docs/feature-vegetation-zones.md
D-VZ10). A real SQLite database and a synthetic ortho GeoTIFF in tmp_path;
a 200 m square at 200 px, one pixel per metre.
"""

import json
import sqlite3

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin

import gspro

COURSE = "33333333-3333-3333-3333-333333333333"
E0, N0 = 600000.0, 6400000.0
SIDE = 200.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
SIZE = 200
PHOTO = (200, 40, 200)
BROWN = (90, 80, 50)


def _rect(x0, y0, x1, y1):
    return {"points": [{"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0},
                       {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]}


def _make_db(path, features):
    """features: [(type, rings, attributes | None)]."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT,
               geometry_json TEXT, sort_order INTEGER, attributes_json TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES (?, ?)", (COURSE, "Skogsbana"))
    for i, (kind, rings, attrs) in enumerate(features):
        conn.execute(
            "INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"f{i}", COURSE, None, kind, json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}),
             i, json.dumps(attrs) if attrs is not None else None),
        )
    conn.commit()
    conn.close()
    return path


def _ortho(path):
    rgb = np.empty((3, 400, 400), dtype=np.uint8)
    for band, value in enumerate(PHOTO):
        rgb[band] = value
    profile = {"driver": "GTiff", "height": 400, "width": 400, "count": 3, "dtype": "uint8",
               "crs": CRS.from_epsg(3006), "transform": from_origin(E0, N0 + SIDE, 0.5, 0.5)}
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(rgb)
    return path


def _at(img, x_m, y_m):
    return np.asarray(img)[SIZE - 1 - int(y_m), int(x_m)].astype(int)


WOOD = {"zoneType": "woodland_floor", "weight": 1, "feather": 4, "noise": 2, "floorColor": "#5a5032"}


def _run(tmp_path, features, **kw):
    db = _make_db(tmp_path / "app.sqlite", features)
    out = tmp_path / "ortho.jpg"
    terrain = tmp_path / "ortho-terrain.jpg"
    gspro.cmd_ortho(None, None, SIZE, 1, [_ortho(tmp_path / "src.tif")], out=out, extent=EXTENT,
                    terrain_out=terrain, db_path=db, floor_course=COURSE, **{"floor_color": "#5a5032", **kw})
    return Image.open(out).convert("RGB"), Image.open(terrain).convert("RGB")


def test_woodland_floor_zones_are_painted_and_the_fairway_and_path_are_kept(tmp_path, capsys):
    photo, terrain = _run(tmp_path, [
        ("vegetation_zone", [_rect(20, 20, 180, 180)], WOOD),
        ("vegetation_zone", [_rect(0, 0, 10, 10)], {"zoneType": "shrub"}),  # not floor
        ("fairway", [_rect(100, 0, 200, 60)], None),
        ("path", [_rect(60, 0, 64, 200)], None),
    ], floor_feather_m=0.0)
    assert np.all(np.abs(_at(photo, 40, 120) - BROWN) < 45)  # woodland
    assert np.all(np.abs(_at(photo, 150, 30) - PHOTO) < 12)  # fairway through it
    assert np.all(np.abs(_at(photo, 62, 120) - PHOTO) < 12)  # path through it
    assert np.all(np.abs(_at(photo, 5, 5) - PHOTO) < 12)  # shrub zone, outside
    # The terrain twin is the darkened same render: floor in it too.
    t = _at(terrain, 40, 120)
    assert t[0] < 90 and abs(int(t[0]) - int(t[2])) < 60 and t[1] < 90
    report = capsys.readouterr().out
    assert "forest floor: 1 woodland_floor zone(s) of Skogsbana" in report


def test_mix_zero_ignores_the_zone_colour(tmp_path):
    photo, _ = _run(tmp_path, [("vegetation_zone", [_rect(20, 20, 180, 180)], WOOD)],
                    floor_feather_m=0.0, floor_mix=0.0, floor_color="#204060")
    assert np.all(np.abs(_at(photo, 100, 100) - (0x20, 0x40, 0x60)) < 45)


def test_a_course_without_floor_zones_exports_the_photo(tmp_path, capsys):
    photo, _ = _run(tmp_path, [("fairway", [_rect(100, 0, 200, 60)], None)])
    assert np.all(np.abs(_at(photo, 40, 120) - PHOTO) < 12)
    assert "has no woodland_floor zones" in capsys.readouterr().out


def test_floor_mix_is_checked(tmp_path):
    with pytest.raises(SystemExit):
        _run(tmp_path, [("vegetation_zone", [_rect(20, 20, 180, 180)], WOOD)], floor_mix=2.0)


# --- --remove-buildings ------------------------------------------------------

def _roofs(path, x0, y0, x1, y1, height=8.0):
    """A roof-heights GeoTIFF (1 m cells) with one roof over metres from the square's corner."""
    grid = np.zeros((200, 200), dtype=np.float32)
    grid[int(SIDE - y1):int(SIDE - y0), int(x0):int(x1)] = height
    with rasterio.open(path, "w", driver="GTiff", height=200, width=200, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, 1.0, 1.0), nodata=-1.0) as dst:
        dst.write(grid, 1)
    return path


def test_remove_buildings_fills_the_roof_on_every_file(tmp_path, capsys):
    src = tmp_path / "src.tif"
    rgb = np.empty((3, 400, 400), dtype=np.uint8)
    for band, value in enumerate(PHOTO):
        rgb[band] = value
    rgb[:, 160:200, 160:200] = 250  # a white 20 x 20 m roof at (80..100, 100..120) m
    with rasterio.open(src, "w", driver="GTiff", height=400, width=400, count=3, dtype="uint8",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, 0.5, 0.5)) as dst:
        dst.write(rgb)
    roofs = _roofs(tmp_path / "roofs.tif", 80, 100, 100, 120)
    out, terrain = tmp_path / "o.jpg", tmp_path / "o-terrain.jpg"
    gspro.cmd_ortho(None, None, SIZE, 1, [src], out=out, extent=EXTENT, terrain_out=terrain,
                    remove_buildings=True, roofs=roofs, shadow_azimuth=0.0, shadow_ratio=0.5)
    photo = Image.open(out).convert("RGB")
    assert np.all(np.abs(_at(photo, 90, 110) - PHOTO) < 30)  # the roof is ground now
    assert np.all(np.abs(_at(photo, 30, 30) - PHOTO) < 12)
    assert "1 roof(s) and their shadows removed" in capsys.readouterr().out
    assert np.asarray(Image.open(terrain))[SIZE - 111, 90].max() < 200  # the twin is from the same render


def test_remove_buildings_needs_a_source_and_the_flags_go_together(tmp_path):
    src = _ortho(tmp_path / "src.tif")
    with pytest.raises(SystemExit):
        gspro.cmd_ortho(None, None, SIZE, 1, [src], out=tmp_path / "o.jpg", extent=EXTENT, remove_buildings=True)
    with pytest.raises(SystemExit):
        gspro.cmd_ortho(None, None, SIZE, 1, [src], out=tmp_path / "o.jpg", extent=EXTENT,
                        roofs=tmp_path / "roofs.tif")
    with pytest.raises(SystemExit):
        gspro.cmd_ortho(None, None, SIZE, 1, [src], out=tmp_path / "o.jpg", extent=EXTENT, remove_buildings=True,
                        roofs=tmp_path / "missing.tif")
