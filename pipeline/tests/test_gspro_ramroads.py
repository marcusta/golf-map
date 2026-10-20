"""gspro.py ramroads / ramroads-propose: render=ram paths as R.A.M. road splines
(unity-ramroads-v1) and which drawn roads would suit R.A.M.

A synthetic course DB on a 400 m square: roads drawn as centerlines (some with
their corridor rings, some without), a fairway, and a tiny ortho GeoTIFF with
the road painted on it and a shadow across it.
"""

from __future__ import annotations

import json
import math
import sqlite3

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

import gspro

E0, N0, SIDE = 500000.0, 6400000.0, 400.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
SQUARE = f"{E0:.0f},{N0:.0f},{E0 + SIDE:.0f},{N0 + SIDE:.0f}"


def _pts(*xy, corner=()):
    """Centerline control points at plot metres (x east, y north from the square's SW corner)."""
    return [{"x": E0 + x, "y": N0 + y, **({"corner": True} if i in corner else {})} for i, (x, y) in enumerate(xy)]


def _rect(x0, y0, x1, y1):
    return {"points": [{"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0},
                       {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]}


def _road(no, points, width, attrs=None, rings=(), source=None, kind="path"):
    geom = {"crs": "EPSG:3006", "curveType": "bezier", "rings": list(rings)}
    if points is not None:
        geom["centerline"] = {"points": points, "widthM": width}
    return {"no": no, "type": kind, "geom": geom, "attrs": attrs, "source": source}


def _db(path, features):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT, geometry_json TEXT,
               sort_order INTEGER, created_at TEXT, feature_no INTEGER, source TEXT, source_ref TEXT,
               attributes_json TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES ('c1', 'Vägbana')")
    for i, f in enumerate(features):
        conn.execute("INSERT INTO course_features VALUES (?, 'c1', NULL, ?, ?, ?, '2026-01-01', ?, ?, NULL, ?)",
                     (f"feat-{f['no'] if f['no'] is not None else f'x{i}'}", f["type"], json.dumps(f["geom"]), i,
                      f["no"], f["source"], json.dumps(f["attrs"]) if f["attrs"] is not None else None))
    conn.commit()
    conn.close()
    return path


RAM = {"surface": "gravel", "render": "ram"}


def test_a_ram_road_is_written_in_plot_metres_resampled_and_cut_to_the_square(tmp_path, capsys):
    db = _db(tmp_path / "app.sqlite", [
        _road(7, _pts((50, 100), (250, 100)), 3.5, RAM),
        # A corner stays sharp: the line runs straight into it and straight out.
        _road(3, _pts((50, 200), (150, 200), (150, 300), corner=(1,)), 3.0, {"surface": "dirt", "render": "ram"}),
        _road(9, _pts((350, 50), (450, 50)), 3.0, {"render": "ram"}),          # leaves the square; no surface
        _road(5, _pts((50, 350), (250, 350)), 3.0, {"surface": "gravel"}),     # an OPCD road: not written
    ])
    out = tmp_path / "ramroads.json"
    gspro.cmd_ramroads(db, "c1", out, EXTENT)

    doc = json.loads(out.read_text())
    assert doc["format"] == "unity-ramroads-v1"
    assert doc["plot"] == {"crs": "EPSG:3006", "terrain": "inner", "originX": E0, "originY": N0, "sizeM": SIDE}
    assert [r["id"] for r in doc["roads"]] == ["path_3", "path_7", "path_9"]   # by feature number
    by_id = {r["id"]: r for r in doc["roads"]}

    straight = by_id["path_7"]
    assert straight["featureId"] == "feat-7" and straight["surface"] == "gravel" and straight["widthM"] == 3.5
    assert straight["lengthM"] == 200.0
    assert len(straight["points"]) == 81 and straight["points"][0] == [50.0, 100.0] and straight["points"][-1] == [250.0, 100.0]
    steps = [math.dist(a, b) for a, b in zip(straight["points"], straight["points"][1:])]
    assert max(steps) - min(steps) < 1e-6 and abs(steps[0] - 2.5) < 1e-6
    assert straight["orthoRgb"] is None and straight["orthoPixels"] == 0

    corner = by_id["path_3"]
    assert corner["lengthM"] == 200.0 and [150.0, 200.0] in corner["points"]

    cut = by_id["path_9"]
    assert cut["surface"] == "gravel"                                          # the default
    assert cut["lengthM"] == 50.0 and cut["points"][-1] == [400.0, 50.0]
    assert doc["surfaces"]["gravel"]["roads"] == 2 and doc["surfaces"]["dirt"]["roads"] == 1
    assert doc["surfaces"]["gravel"]["orthoRgb"] is None
    assert "3 R.A.M. road(s) for Vägbana" in capsys.readouterr().out

    # --reach-m keeps a road on past the square's edge (the outer terrain carries it).
    gspro.cmd_ramroads(db, "c1", out, EXTENT, reach_m=20)
    assert {r["id"]: r for r in json.loads(out.read_text())["roads"]}["path_9"]["lengthM"] == 70.0


def test_a_ram_road_without_a_centerline_or_on_a_bridge_is_skipped_and_named(tmp_path, capsys):
    db = _db(tmp_path / "app.sqlite", [
        _road(4, None, None, RAM, rings=[_rect(10, 10, 60, 14)]),
        _road(6, _pts((10, 40), (60, 40)), 3.0, {"surface": "bridge", "render": "ram"}),
        _road(8, _pts((10, 80), (60, 80)), 3.0, RAM),
    ])
    out = tmp_path / "ramroads.json"
    gspro.main(["ramroads", "--square-3006", SQUARE, "--course", "Väg", "--db", str(db), "--out", str(out)])

    assert [r["id"] for r in json.loads(out.read_text())["roads"]] == ["path_8"]
    printed = capsys.readouterr().out
    assert "skipped path 4: render=ram but no centerline" in printed
    assert "skipped path 6: a bridge deck is a prop" in printed


def _ortho(path):
    """0.5 m pixels over the square: green grass and the road y = 98..102
    between x = 50 and 150, gravel of two tones (darker up to x = 110) with a
    shadow over x = 50..80. With the shadow in, the median is the darker tone."""
    res = 0.5
    n = int(SIDE / res)
    rows, cols = np.mgrid[0:n, 0:n]
    x = (cols + 0.5) * res
    y = SIDE - (rows + 0.5) * res
    rgb = np.empty((3, n, n), np.uint8)
    rgb[:] = np.array([60, 120, 40], np.uint8)[:, None, None]
    road = (x >= 50) & (x <= 150) & (np.abs(y - 100) <= 2)
    rgb[:, road & (x < 110)] = np.array([200, 180, 160], np.uint8)[:, None]
    rgb[:, road & (x >= 110)] = np.array([230, 210, 190], np.uint8)[:, None]
    rgb[:, road & (x < 80)] = np.array([40, 40, 40], np.uint8)[:, None]
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=3, dtype="uint8",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, res, res)) as dst:
        dst.write(rgb)
    return path


def test_ortho_rgb_is_the_median_of_the_sunlit_road_pixels(tmp_path):
    db = _db(tmp_path / "app.sqlite", [
        _road(1, _pts((50, 100), (150, 100)), 4.0, RAM, rings=[_rect(50, 98, 150, 102)]),
        _road(2, _pts((50, 300), (150, 300)), 4.0, RAM),        # off the painted road: grass, but still a colour
    ])
    out = tmp_path / "ramroads.json"
    gspro.cmd_ramroads(db, "c1", out, EXTENT, ortho=_ortho(tmp_path / "ortho.tif"))

    doc = json.loads(out.read_text())
    road = doc["roads"][0]
    # The darkest 35 %: the shadow (30 %) and a little of the darker tone; the
    # rest is mostly the lighter tone. Kept in, the shadow would make it [200, 180, 160].
    assert road["orthoRgb"] == [230, 210, 190]
    # The corridor shrunk 0.6 m all round: 98.8 x 2.8 m of 0.5 m pixels, of which 65 % are kept.
    assert 0.6 * 1100 < road["orthoPixels"] < 0.7 * 1110
    assert doc["roads"][1]["orthoRgb"] == [60, 120, 40]
    assert doc["surfaces"]["gravel"]["roads"] == 2
    # Road 1's rings (400 m2) and road 2's centerline buffered by half its width (no rings): 400 m2 + round ends.
    assert abs(doc["surfaces"]["gravel"]["areaM2"] - (800 + math.pi * 4)) < 0.5
    assert doc["surfaces"]["gravel"]["orthoRgb"] is not None


def _propose_db(path):
    fairway_ring = _rect(50, 50, 100, 100)
    return _db(path, [
        _road(1, _pts((300, 300), (380, 300)), 3.0, {"surface": "gravel"}),             # ends on road 2: a candidate
        _road(2, _pts((380, 250), (380, 390)), 3.0, {"surface": "gravel"}),             # road 1 joins it mid-way
        _road(3, _pts((300, 100), (380, 100)), 3.0, {"surface": "gravel-track"}),       # crossed by road 4
        _road(4, _pts((340, 60), (340, 140)), 3.0, {"surface": "dirt"}),                # crosses road 3
        _road(5, _pts((300, 200), (330, 200)), 3.0, {"surface": "asphalt"}),            # far, alone, but hard
        _road(6, _pts((50, 112), (100, 112)), 4.0, {"surface": "gravel"}),              # 10 m from the fairway
        _road(7, _pts((200, 380), (260, 380)), 3.0, RAM),                               # already R.A.M.
        _road(None, None, None, None, rings=[_rect(378, 298, 382, 302)], source="road-junctions"),  # a fillet
        {"no": 10, "type": "fairway", "geom": {"crs": "EPSG:3006", "curveType": "bezier", "rings": [fairway_ring]},
         "attrs": None, "source": None},
    ])


def test_propose_keeps_far_loose_roads_met_only_at_their_ends(tmp_path):
    doc = gspro.ramroads_proposal(_propose_db(tmp_path / "app.sqlite"), "c1")

    assert doc["format"] == "golfmap-ramroads-proposal-v1"
    assert doc["rules"]["minDistanceM"] == 30 and "gravel" in doc["rules"]["surfaces"]
    assert doc["rules"]["play"] == ["green", "tee", "fairway", "semi_rough", "bunker"]
    assert doc["already"] == [7]
    assert [c["featureNo"] for c in doc["candidates"]] == [1]
    one = doc["candidates"][0]
    assert one["featureId"] == "feat-1" and one["surface"] == "gravel" and one["widthM"] == 3.0
    assert one["lengthM"] == 80.0 and one["touches"] == [2]
    assert one["distanceToPlayM"] > 200

    why = {r["featureNo"]: r["reason"] for r in doc["rejected"]}
    assert set(why) == {2, 3, 4, 5, 6}                                      # the fillet is no road here
    assert "joined by path 1 mid-way" in why[2]
    assert "crossed by path 4 mid-way" in why[3] and "crossed by path 3 mid-way" in why[4]
    assert why[5] == "asphalt: hard surface, keeps its kerbs in Blender"
    assert why[6] == "10 m from play (fairway 10)"


def test_propose_prints_json_without_out_and_takes_the_distance(tmp_path, capsys):
    db = _propose_db(tmp_path / "app.sqlite")
    gspro.main(["ramroads-propose", "--course", "c1", "--db", str(db), "--min-distance-m", "5"])
    doc = json.loads(capsys.readouterr().out)
    assert doc["rules"]["minDistanceM"] == 5
    assert [c["featureNo"] for c in doc["candidates"]] == [1, 6]
    assert doc["candidates"][1]["distanceToPlayM"] == 10.0
