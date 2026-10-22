"""gspro play-lines - every hole's tee -> aim points -> green centre (EPSG:3006), for every course on the course's
site: the course check's area (the play-surface meshes these lines cross + a buffer). Out of the same app-shaped
SQLite database test_gspro_gkd builds.
"""

import json
import sqlite3

import pytest

import gspro
from test_gspro_gkd import COURSE, E0, HOLE, N0, _make_db, _wgs84


def test_each_tee_runs_through_the_aim_points_to_the_green(tmp_path):
    db = _make_db(tmp_path / "app.sqlite", holes=[{**HOLE, "aims": [(250.0, 200.0), (120.0, 190.0)]}])
    out = tmp_path / "x-play-lines.json"
    gspro.cmd_play_lines(COURSE, out, db)
    doc = json.loads(out.read_text(encoding="utf-8"))

    assert doc["format"] == gspro.PLAY_LINES_FORMAT and doc["crs"] == "EPSG:3006"
    course, = doc["courses"]
    hole, = course["holes"]
    assert hole["number"] == 1
    # one line per tee (Yellow, White), each tee -> aim 1 -> aim 2 -> green
    assert len(hole["lines"]) == 2
    yellow = hole["lines"][0]
    assert yellow == [pytest.approx([E0 + x, N0 + z], abs=0.02) for x, z in [(350.0, 200.0), (250.0, 200.0), (120.0, 190.0), (50.0, 200.0)]]


def test_a_hole_with_neither_aims_nor_green_has_no_line_and_a_site_brings_its_other_course(tmp_path):
    db = _make_db(tmp_path / "app.sqlite", holes=[HOLE, {**HOLE, "number": 2, "green": None, "aims": []}])
    conn = sqlite3.connect(db)
    other = "44444444-4444-4444-4444-444444444444"
    conn.executescript("ALTER TABLE courses ADD COLUMN site_id TEXT;")
    conn.execute("UPDATE courses SET site_id = 'site-1'")
    conn.execute("INSERT INTO courses (id, name, site_id) VALUES (?, 'Andra banan', 'site-1')", (other,))
    conn.execute("INSERT INTO holes (id, course_id, number, par, stroke_index) VALUES ('o-1', ?, 1, 3, 1)", (other,))
    for i, (x, z) in enumerate([(0.0, 0.0)]):
        lat, lon = _wgs84(E0 + x, N0 + z)
        conn.execute("INSERT INTO tees (id, hole_id, name, color, lat, lon, sort_order) VALUES (?, 'o-1', 'Red', 'red', ?, ?, ?)", (f"o-t{i}", lat, lon, i))
    lat, lon = _wgs84(E0 + 0.0, N0 + 150.0)
    conn.execute("INSERT INTO greens (id, hole_id, center_lat, center_lon) VALUES ('o-g', 'o-1', ?, ?)", (lat, lon))
    conn.commit()
    conn.close()

    doc = gspro.play_lines(db, COURSE)
    names = [c["name"] for c in doc["courses"]]
    assert names == ["Andra banan", "Testbana"]
    ours = doc["courses"][1]
    # hole 2: its tees and nothing to aim at - no line of two points, so no hole
    assert [h["number"] for h in ours["holes"]] == [1]
    theirs = doc["courses"][0]
    assert theirs["holes"][0]["lines"] == [[pytest.approx([E0, N0], abs=0.02), pytest.approx([E0, N0 + 150.0], abs=0.02)]]
