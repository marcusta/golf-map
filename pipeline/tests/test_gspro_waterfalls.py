"""gspro.py waterfalls: each fall's lip, levels and flow for Unity (unity-waterfalls-v1).

A synthetic DEM with two flat ponds, the upper one (12 m) east of x = 101 and
the lower one (10 m) west of x = 100, a 1 m slope between them, and a course
DB with falls drawn along that edge (levels from the lidar, and set on the
feature), one on flat ground, one with its flow set the wrong way round and
one outside the square.
"""

from __future__ import annotations

import json
import sqlite3

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

import gspro

E0, N0, SIDE = 529000.0, 6486000.0, 200.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
RES = 0.5
MIN_M = 8.0
COURSE = "c1"


def _dem(path):
    n = int(SIDE / RES)
    rows, cols = np.mgrid[0:n, 0:n]
    x = (cols + 0.5) * RES
    dem = np.clip(10.0 + 2.0 * (x - 100.0), 10.0, 12.0)
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, RES, RES)) as dst:
        dst.write(dem.astype(np.float32), 1)
    return path


def _line(*points):
    return {"crs": "EPSG:3006", "curveType": "bezier", "rings": [],
            "centerline": {"points": [{"x": E0 + x, "y": N0 + y} for x, y in points], "widthM": 2}}


def _db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT, geometry_json TEXT,
               sort_order INTEGER, attributes_json TEXT, created_at TEXT, feature_no INTEGER);"""
    )
    conn.execute("INSERT INTO courses VALUES (?, 'Fallbana')", (COURSE,))
    conn.execute("INSERT INTO holes VALUES ('h3', ?, 3)", (COURSE,))
    falls = [
        # Drawn south to north along the edge, slightly bowed: everything from the lidar.
        ("f1", "h3", _line((100.5, 90), (100.8, 100), (100.5, 110)), None, 0x1a),
        # Everything set on the feature: nothing read.
        ("f2", None, _line((100.5, 120), (100.5, 125)),
         {"style": "outlet", "topM": 12.5, "bottomM": 9.8, "flowBearingDeg": 270}, 0x1b),
        # On the flat lower pond: the two sides do not differ.
        ("f3", None, _line((40, 50), (40, 60)), {"style": "sill", "sillM": 2.5}, 0x1c),
        # Its flow set east, uphill: the levels are read that way round, and warned about.
        ("f4", None, _line((100.5, 150), (100.5, 160)), {"flowBearingDeg": 90}, 0x1d),
        # Outside the inner square.
        ("f5", None, _line((-50, 50), (-40, 50)), None, 0x1e),
    ]
    for i, (fid, hole, geom, attrs, no) in enumerate(falls):
        conn.execute("INSERT INTO course_features VALUES (?, ?, ?, 'waterfall', ?, ?, ?, ?, ?)",
                     (fid, COURSE, hole, json.dumps(geom), i, json.dumps(attrs) if attrs else None, f"2026-10-18 10:0{i}:00", no))
    # A shape the SVG writes, so the course is not only falls.
    ring = {"crs": "EPSG:3006", "rings": [{"points": [{"x": E0 + 10, "y": N0 + 10}, {"x": E0 + 30, "y": N0 + 10}, {"x": E0 + 30, "y": N0 + 30}]}]}
    conn.execute("INSERT INTO course_features VALUES ('w1', ?, NULL, 'water', ?, 9, NULL, '2026-10-01 10:00:00', 3)",
                 (COURSE, json.dumps(ring)))
    conn.commit()
    conn.close()
    return path


def _run(tmp_path, capsys):
    dem = _dem(tmp_path / "dem.tif")
    db = _db(tmp_path / "app.sqlite")
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": list(EXTENT), "minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "waterfalls.json"
    gspro.cmd_waterfalls(None, db, COURSE, dem, sidecar, out, extent=EXTENT)
    return json.loads(out.read_text()), capsys.readouterr().out


def test_waterfalls_export_lips_levels_and_flow_in_the_creeks_frame(tmp_path, capsys):
    doc, printed = _run(tmp_path, capsys)

    assert doc["format"] == "unity-waterfalls-v1"
    assert doc["plot"] == {"crs": "EPSG:3006", "terrain": "inner", "originX": E0, "originY": N0,
                           "sizeM": SIDE, "minM": MIN_M, "maxM": 30.0}
    by_feature = {f["featureId"]: f for f in doc["waterfalls"]}
    assert set(by_feature) == {"f1", "f2", "f3", "f4"}          # f5 is outside the square

    # Read from the lidar: the upper pond east, the lower west, so it falls west.
    f1 = by_feature["f1"]
    assert (f1["id"], f1["style"], f1["sillM"]) == ("hole_3_1a", "sill", 1.0)
    assert f1["fromLidar"] == ["flowBearingDeg", "topM", "bottomM"]
    assert f1["topM"] == pytest.approx(12.0, abs=0.05) and f1["bottomM"] == pytest.approx(10.0, abs=0.05)
    assert f1["topY"] == pytest.approx(f1["topM"] - MIN_M) and f1["bottomY"] == pytest.approx(f1["bottomM"] - MIN_M)
    assert f1["flow"] == pytest.approx([-1.0, 0.0], abs=0.01)   # x east, z north: west is -x
    assert f1["flowBearingDeg"] == pytest.approx(270, abs=0.5)
    lip = np.array(f1["lip"])
    assert len(lip) > 3                                          # the curve, flattened
    assert lip[0] == pytest.approx([100.5, 90.0]) and lip[-1] == pytest.approx([100.5, 110.0])
    assert lip[:, 0].max() > 100.6                               # it bows east through (100.8, 100)
    assert f1["widthM"] == pytest.approx(20.0, abs=0.1)

    # Set on the feature: taken as they are.
    f2 = by_feature["f2"]
    assert (f2["id"], f2["style"], f2["sillM"], f2["fromLidar"]) == ("others_1b", "outlet", 0.0, [])
    assert (f2["topM"], f2["bottomM"], f2["topY"], f2["bottomY"]) == (12.5, 9.8, 4.5, 1.8)
    assert f2["flow"] == pytest.approx([-1.0, 0.0], abs=1e-4)
    assert f2["lip"] == [[100.5, 120.0], [100.5, 125.0]] and f2["widthM"] == 5.0

    f3 = by_feature["f3"]
    assert f3["sillM"] == 2.5 and f3["topM"] - f3["bottomM"] < 0.2

    # The flow says east: the upstream side is the lower pond, so the drop comes out negative.
    f4 = by_feature["f4"]
    assert f4["fromLidar"] == ["topM", "bottomM"]
    assert f4["flow"] == pytest.approx([1.0, 0.0], abs=1e-4)
    assert f4["topM"] == pytest.approx(10.0, abs=0.05) and f4["bottomM"] == pytest.approx(12.0, abs=0.05)

    assert "others_1c: the water above and below differ by 0.00 m (under 0.2 m) on the lidar" in printed
    assert "others_1d: the water above and below differ by -2.00 m" in printed and "right way round" in printed
    assert "skipped others_1e: outside the inner square" in printed
    assert "hole_3_1a sill: 12.00 -> 10.00 m (drop 2.00 m), lip 20.01 m, falls towards 270 deg" in printed


def test_waterfalls_command_line(tmp_path, capsys):
    dem = _dem(tmp_path / "dem.tif")
    db = _db(tmp_path / "app.sqlite")
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "out" / "x-inner-waterfalls.json"
    square = ",".join(str(v) for v in EXTENT)
    gspro.main(["waterfalls", "--square-3006", square, "--db", str(db), "--course", "Fallbana",
                "--dem", str(dem), "--sidecar", str(sidecar), "--out", str(out)])
    doc = json.loads(out.read_text())
    assert [f["id"] for f in doc["waterfalls"]] == ["hole_3_1a", "others_1b", "others_1c", "others_1d"]
    assert "4 waterfall(s) for Fallbana" in capsys.readouterr().out


def test_a_cascade_runs_down_its_line_and_a_fountain_stands_in_its_pond(tmp_path, capsys):
    dem = _dem(tmp_path / "dem.tif")
    db = _db(tmp_path / "app.sqlite")
    conn = sqlite3.connect(db)
    # A cascade drawn down the slope, east (upper pond) to west (lower), and a fountain in the lower pond.
    conn.execute("INSERT INTO course_features VALUES ('c1', ?, NULL, 'waterfall', ?, 20, ?, '2026-10-19 10:00:00', 40)",
                 (COURSE, json.dumps(_line((106, 60), (100, 61), (94, 60))), json.dumps({"style": "cascade", "widthM": 0.8})))
    conn.execute("INSERT INTO course_features VALUES ('q1', ?, NULL, 'waterfall', ?, 21, ?, '2026-10-19 10:01:00', 41)",
                 (COURSE, json.dumps(_line((50, 70), (52, 70))), json.dumps({"style": "fountain", "heightM": 2})))
    conn.commit()
    conn.close()
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": list(EXTENT), "minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "waterfalls.json"
    gspro.cmd_waterfalls(None, db, COURSE, dem, sidecar, out, extent=EXTENT)
    by = {f["featureId"]: f for f in json.loads(out.read_text())["waterfalls"]}
    c = by["c1"]
    assert c["style"] == "cascade" and c["path"] is True and c["widthM"] == 0.8
    assert c["topM"] == pytest.approx(12.0, abs=0.05) and c["bottomM"] == pytest.approx(10.0, abs=0.05)
    assert c["flow"][0] < -0.99                                          # west, first point to last
    assert len(c["lip"]) >= 3 and c["lip"][0][0] == pytest.approx(106.0, abs=0.01)
    q = by["q1"]
    assert q["style"] == "fountain" and q["heightM"] == 2
    assert q["at"] == [pytest.approx(51.0, abs=0.01), pytest.approx(70.0, abs=0.01)]
    assert q["topM"] == pytest.approx(10.0, abs=0.05)
