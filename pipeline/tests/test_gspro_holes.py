"""gspro holes — the course's tees, aim points and green centres in EPSG:3006
for Unity's hole navigator, out of a real SQLite database with the app's shape
(the one test_gspro_gkd builds).
"""

import json

import pytest

import gspro
from test_gspro_gkd import COURSE, E0, HOLE, N0, _make_db


def _run(tmp_path, holes):
    out = tmp_path / "course-holes.json"
    gspro.cmd_holes(COURSE, out, _make_db(tmp_path / "app.sqlite", holes=holes))
    return json.loads(out.read_text(encoding="utf-8"))


def test_a_hole_carries_every_tee_and_aim_point_and_the_green_centre(tmp_path):
    third_aim = {**HOLE, "aims": [(250.0, 200.0), (200.0, 210.0), (120.0, 190.0)]}
    doc = _run(tmp_path, [third_aim])

    assert doc["format"] == gspro.HOLES_FORMAT and doc["crs"] == "EPSG:3006"
    hole, = doc["holes"]
    assert (hole["number"], hole["par"]) == (1, 4)
    assert [(t["name"], t["color"]) for t in hole["tees"]] == [("Yellow", "yellow"), ("White", "white")]
    assert (hole["tees"][0]["e"], hole["tees"][0]["n"]) == pytest.approx((E0 + 350.0, N0 + 200.0), abs=0.02)
    # All three: the GKD's two-aim-point limit is not the navigator's.
    assert [(a["e"], a["n"]) for a in hole["aims"]] == [
        pytest.approx((E0 + 250.0, N0 + 200.0), abs=0.02),
        pytest.approx((E0 + 200.0, N0 + 210.0), abs=0.02),
        pytest.approx((E0 + 120.0, N0 + 190.0), abs=0.02)]
    assert (hole["green"]["e"], hole["green"]["n"]) == pytest.approx((E0 + 50.0, N0 + 200.0), abs=0.02)


def test_a_hole_without_a_green_is_kept_with_a_null_green(tmp_path):
    doc = _run(tmp_path, [HOLE, {**HOLE, "number": 2, "green": None, "aims": []}])

    assert [h["number"] for h in doc["holes"]] == [1, 2]
    assert doc["holes"][1]["green"] is None
    assert len(doc["holes"][1]["tees"]) == 2
