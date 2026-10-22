"""gspro gkd — the GreenKeeper course-description file (`<scene>.GKD`) out of
the app DB: holes, tee boxes, pins, green centres, aim points, penalty areas
and the out-of-bounds ring, as Unity world positions on one terrain square.

Real SQLite databases and real GeoTIFFs built in tmp_path (no mocks), the
same shapes as production: courses / holes / tees / greens / pins /
aim_points / course_features, and a DEM + heightmap sidecar like the one
`gspro dem` writes.
"""

import json
import math
import sqlite3

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform as transform_points

import gspro

COURSE = "33333333-3333-3333-3333-333333333333"
E0, N0 = 600000.0, 6400000.0
SIDE = 400.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
# The DEM below is a west-to-east ramp over the square, so a point's height
# is a function of its x alone and every assertion can state it in one line.
MIN_M, MAX_M = 50.0, 90.0


def _height(x: float) -> float:
    """The synthetic DEM's absolute height at an EPSG:3006 easting."""
    return MIN_M + (x - E0) / SIDE * (MAX_M - MIN_M)


def _unity_y(x: float) -> float:
    """That height as a Unity y: metres above the terrain's own zero."""
    return _height(x) - MIN_M


def _wgs84(x: float, y: float) -> tuple[float, float]:
    """An EPSG:3006 point as the (lat, lon) the app's tables store."""
    lons, lats = transform_points(gspro.SWEREF99, gspro.WGS84, [x], [y])
    return lats[0], lons[0]


@pytest.fixture
def terrain(tmp_path):
    """A DEM GeoTIFF over the square and the heightmap sidecar next to it,
    named the way `gspro dem` names them. Returns the sidecar path."""
    dem = tmp_path / "course-inner-dem-400m.tif"
    size = 400  # 1 m/px
    col = np.arange(size, dtype=np.float64) + 0.5
    ramp = MIN_M + col / size * (MAX_M - MIN_M)
    with rasterio.open(
        dem, "w", driver="GTiff", height=size, width=size, count=1, dtype="float32",
        crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, 1.0, 1.0), nodata=-9999.0,
    ) as dst:
        dst.write(np.tile(ramp, (size, 1)).astype(np.float32), 1)
    sidecar = dem.with_suffix(".tif.json")
    sidecar.write_text(json.dumps({
        "crs": "EPSG:3006", "terrain": "inner", "square3006": list(EXTENT),
        "sideM": SIDE, "resolution": 1.0, "size": size,
        "minM": MIN_M, "maxM": MAX_M, "heightRangeM": MAX_M - MIN_M,
    }), encoding="utf-8")
    return sidecar


def _ring(points):
    """A straight-edged control ring over EPSG:3006 points."""
    return {"points": [{"x": x, "y": y} for x, y in points]}


def _box(x0, y0, x1, y1):
    """A rectangular ring in metres from the square's south-west corner."""
    return _ring([(E0 + x0, N0 + y0), (E0 + x1, N0 + y0), (E0 + x1, N0 + y1), (E0 + x0, N0 + y1)])


HOLE = {
    # A 300 m hole running east: tees at x 350, green centre at x 50, one aim
    # point between them. Everything at z 200 so the geometry stays readable.
    "number": 1, "par": 4, "stroke_index": 7,
    "tees": [("Yellow", "yellow", 350.0, 200.0), ("White", "white", 360.0, 200.0)],
    "aims": [(200.0, 200.0)],
    "green": (50.0, 200.0),
    "pins": [],
}


def _make_db(path, holes=(HOLE,), features=(), course_name="Testbana"):
    """A database with the app's shape. `holes` are dicts like HOLE above,
    with positions as (x, z) metres from the square's south-west corner;
    `features` are (type, geometry rings, hole number or None[, attributes])."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER,
                               par INTEGER, stroke_index INTEGER);
           CREATE TABLE tees (id TEXT PRIMARY KEY, hole_id TEXT, name TEXT, color TEXT,
                              lat REAL, lon REAL, sort_order INTEGER);
           CREATE TABLE greens (id TEXT PRIMARY KEY, hole_id TEXT, center_lat REAL, center_lon REAL);
           CREATE TABLE pins (id TEXT PRIMARY KEY, green_id TEXT, name TEXT, lat REAL, lon REAL,
                              active INTEGER DEFAULT 1);
           CREATE TABLE aim_points (id TEXT PRIMARY KEY, hole_id TEXT, sort_order INTEGER,
                                    lat REAL, lon REAL, label TEXT);
           CREATE TABLE course_features (id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT,
                                         type TEXT, geometry_json TEXT, sort_order INTEGER,
                                         attributes_json TEXT);"""
    )
    conn.execute("INSERT INTO courses (id, name) VALUES (?, ?)", (COURSE, course_name))
    for hole in holes:
        hole_id = f"hole-{hole['number']}"
        conn.execute("INSERT INTO holes (id, course_id, number, par, stroke_index) VALUES (?,?,?,?,?)",
                     (hole_id, COURSE, hole["number"], hole["par"], hole["stroke_index"]))
        for i, (name, color, x, z) in enumerate(hole["tees"]):
            lat, lon = _wgs84(E0 + x, N0 + z)
            conn.execute("INSERT INTO tees (id, hole_id, name, color, lat, lon, sort_order) VALUES (?,?,?,?,?,?,?)",
                         (f"{hole_id}-tee-{i}", hole_id, name, color, lat, lon, i))
        for i, (x, z) in enumerate(hole["aims"]):
            lat, lon = _wgs84(E0 + x, N0 + z)
            conn.execute("INSERT INTO aim_points (id, hole_id, sort_order, lat, lon, label) VALUES (?,?,?,?,?,?)",
                         (f"{hole_id}-aim-{i}", hole_id, i, lat, lon, f"A{i + 1}"))
        if hole["green"] is not None:
            green_id = f"{hole_id}-green"
            lat, lon = _wgs84(E0 + hole["green"][0], N0 + hole["green"][1])
            conn.execute("INSERT INTO greens (id, hole_id, center_lat, center_lon) VALUES (?,?,?,?)",
                         (green_id, hole_id, lat, lon))
            for i, (name, x, z) in enumerate(hole["pins"]):
                lat, lon = _wgs84(E0 + x, N0 + z)
                conn.execute("INSERT INTO pins (id, green_id, name, lat, lon, active) VALUES (?,?,?,?,?,1)",
                             (f"{green_id}-pin-{i}", green_id, name, lat, lon))
    for i, (kind, rings, hole_number, *attributes) in enumerate(features):
        conn.execute(
            "INSERT INTO course_features (id, course_id, hole_id, type, geometry_json, sort_order, attributes_json) "
            "VALUES (?,?,?,?,?,?,?)",
            (f"feat-{i}", COURSE, f"hole-{hole_number}" if hole_number else None, kind,
             json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}), i,
             json.dumps(attributes[0]) if attributes else None))
    conn.commit()
    conn.close()
    return path


def _run(tmp_path, terrain, db, out=None, **kwargs):
    """Run cmd_gkd over the square and return the file it wrote."""
    out = out or tmp_path / "Scene.GKD"
    gspro.cmd_gkd(None, db, COURSE, terrain, out, extent=EXTENT, **kwargs)
    return json.loads(out.read_text(encoding="utf-8")), out


def _tee(hole, tee_type):
    return next(t for t in hole["Tees"] if t["TeeType"] == tee_type)


def test_drawing_groups_are_excluded_from_holes_hazards_and_oob(tmp_path, terrain):
    drawing_group = {**HOLE, 'number': 100}
    db = _make_db(tmp_path / 'groups.sqlite', holes=(HOLE, drawing_group), features=[
        ('water', [_box(20, 20, 80, 80)], 100),
        ('penalty_red', [_box(100, 20, 140, 80)], 100),
        ('oob', [_box(0, 0, 390, 390)], 100),
        ('water', [_box(220, 220, 260, 260)], None),
    ])
    with sqlite3.connect(db) as conn:
        conn.execute('ALTER TABLE holes ADD COLUMN drawing_group_name TEXT')
        conn.execute('UPDATE holes SET drawing_group_name = ? WHERE number = 100', ('Practice area',))
    _, holes = gspro._load_gkd_course(db, COURSE)
    assert [h['number'] for h in holes] == [1]
    outlines = gspro._load_gkd_outlines(db, COURSE)
    assert len(outlines) == 1
    assert outlines[0]['hole_number'] is None
    doc, _ = _run(tmp_path, terrain, db)
    assert len(doc['Hazards']) == 1
    assert sum(h['Enabled'] for h in doc['Holes']) == 1


# --- Positions --------------------------------------------------------------

def test_positions_are_unity_metres_on_the_terrain(tmp_path, terrain):
    """Every position is x/z metres from the square's south-west corner with
    y the ground above the terrain's own zero — the same frame the trees and
    zones exports use, so the GKD lands on the imported heightmap."""
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"))

    hole = doc["Holes"][0]
    yellow = _tee(hole, "Yellow")["Position"]
    assert yellow["x"] == pytest.approx(350.0, abs=0.01)
    assert yellow["z"] == pytest.approx(200.0, abs=0.01)
    assert yellow["y"] == pytest.approx(_unity_y(E0 + 350.0), abs=0.05)

    centre = _tee(hole, gspro.GKD_GREEN_CENTER)["Position"]
    assert (centre["x"], centre["z"]) == pytest.approx((50.0, 200.0), abs=0.01)
    assert centre["y"] == pytest.approx(_unity_y(E0 + 50.0), abs=0.05)
    # The ramp rises eastwards, so the tee is well above the green.
    assert yellow["y"] - centre["y"] == pytest.approx(30.0, abs=0.1)


def test_hole_carries_par_index_and_the_full_tee_list(tmp_path, terrain):
    """A hole holds all eight tee sets plus the two aim points and the green
    centre, in GreenKeeper's order — the sets the hole has no tee for are
    present but disabled with a null position, the way GreenKeeper writes
    them, so GSPro offers no tee that is not in the app."""
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"))

    hole = doc["Holes"][0]
    assert (hole["HoleNumber"], hole["Par"], hole["Index"], hole["Enabled"]) == (1, 4, 7, True)
    assert [t["TeeType"] for t in hole["Tees"]] == [
        *gspro.GKD_TEE_TYPES, *gspro.GKD_AIM_TYPES, gspro.GKD_GREEN_CENTER]
    assert [t["TeeType"] for t in hole["Tees"] if t["Enabled"]] == ["White", "Yellow", "AimPoint1"]
    assert all((t["Position"] is None) == (not t["Enabled"])
               for t in hole["Tees"] if t["TeeType"] != gspro.GKD_GREEN_CENTER)
    assert _tee(hole, "AimPoint1")["Position"]["x"] == pytest.approx(200.0, abs=0.01)
    # The green centre is the hole's measuring point, not a playable tee.
    assert _tee(hole, gspro.GKD_GREEN_CENTER)["Enabled"] is False


def test_a_set_missing_on_one_hole_is_off_there_and_on_elsewhere(tmp_path, terrain):
    holes = (HOLE, {**HOLE, "number": 2, "tees": [("Yellow", "yellow", 250.0, 300.0)],
                    "aims": [], "green": (50.0, 300.0)})
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=holes))

    assert _tee(doc["Holes"][0], "White")["Enabled"] is True
    assert _tee(doc["Holes"][1], "White") == {"TeeType": "White", "Enabled": False, "Distance": 0.0,
                                              "Position": None}
    assert doc["Holes"][1]["Enabled"] is True


def test_a_hole_with_no_tee_is_written_disabled_and_says_so(tmp_path, terrain, capsys):
    holes = (HOLE, {**HOLE, "number": 2, "tees": []})
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=holes))

    assert [h["Enabled"] for h in doc["Holes"][:2]] == [True, False]
    assert "hole(s) 2 have no tee" in capsys.readouterr().out


# --- Tidy tees --------------------------------------------------------------

def _xz(hole, tee_type):
    position = _tee(hole, tee_type)["Position"]
    return position["x"], position["z"]


def test_tees_under_a_metre_apart_share_the_position_furthest_from_the_hole(tmp_path, terrain):
    """Two sets drawn 0.8 m apart are one tee box: both land exactly on the
    back one, with its distance, and the height of the ground there."""
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("Red", "red", 350.6, 200.5)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    gkd_hole = doc["Holes"][0]
    assert _tee(gkd_hole, "Yellow")["Position"] == _tee(gkd_hole, "Red")["Position"]
    assert _xz(gkd_hole, "Red") == pytest.approx((350.6, 200.5), abs=0.01)
    assert _tee(gkd_hole, "Yellow")["Distance"] == _tee(gkd_hole, "Red")["Distance"]


def test_tees_a_metre_or_more_apart_keep_their_own_positions(tmp_path, terrain):
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("Red", "red", 351.0, 202.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    assert _xz(doc["Holes"][0], "Yellow") == pytest.approx((350.0, 200.0), abs=0.01)
    assert _xz(doc["Holes"][0], "Red") == pytest.approx((351.0, 202.0), abs=0.01)


def test_nearby_tees_nearly_in_a_row_are_put_on_the_line_of_play(tmp_path, terrain, capsys):
    """Red stands 4 m in front of Yellow and 0.5 m off the line from Yellow
    to the aim point: it moves sideways onto the line and keeps its place
    along it. The height is the ground's at the new spot."""
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("Red", "red", 346.0, 200.5)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    gkd_hole = doc["Holes"][0]
    assert _xz(gkd_hole, "Yellow") == pytest.approx((350.0, 200.0), abs=0.01)
    assert _xz(gkd_hole, "Red") == pytest.approx((346.0, 200.0), abs=0.01)
    assert _tee(gkd_hole, "Red")["Position"]["y"] == pytest.approx(_unity_y(E0 + 346.0), abs=0.05)
    assert _tee(gkd_hole, "Red")["Distance"] == pytest.approx(296.0, abs=0.01)
    assert "1 moved" in capsys.readouterr().out


def test_the_row_follows_the_aim_point_not_the_green(tmp_path, terrain):
    """On a dogleg the line of play off the tee is towards the first aim
    point; the row is square to that, not to the green."""
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("Red", "red", 346.0, 201.0)],
            "aims": [(200.0, 260.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    # The line from Yellow to the aim point climbs 0.4 m in z per metre west;
    # Red, 0.56 m off it, ends up on it.
    x, z = _xz(doc["Holes"][0], "Red")
    assert z - 200.0 == pytest.approx((350.0 - x) * 0.4, abs=0.01)
    assert math.hypot(x - 346.0, z - 201.0) == pytest.approx(0.557, abs=0.01)


def test_a_par_3_lines_its_tees_up_on_the_green_centre(tmp_path, terrain):
    hole = {**HOLE, "par": 3, "tees": [("Yellow", "yellow", 200.0, 200.0), ("Red", "red", 195.0, 199.6)],
            "aims": []}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    assert _xz(doc["Holes"][0], "Red") == pytest.approx((195.0, 200.0), abs=0.01)


def test_tees_too_far_off_the_line_or_too_far_apart_are_left_alone(tmp_path, terrain):
    """0.9 m off the line is a tee box beside the other, not a crooked row;
    and 8 m apart is another tee box, however straight."""
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("Red", "red", 346.0, 200.9),
                             ("Junior", None, 338.0, 200.4)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    assert _xz(doc["Holes"][0], "Red") == pytest.approx((346.0, 200.9), abs=0.01)
    assert _xz(doc["Holes"][0], "Junior") == pytest.approx((338.0, 200.4), abs=0.01)


def test_a_chain_of_nearby_tees_lines_up_on_the_longest(tmp_path, terrain):
    """White-Yellow and Yellow-Red are each within 6 m, White-Red is not:
    one group, all on the line from White."""
    hole = {**HOLE, "tees": [("Yellow", "yellow", 355.0, 200.3), ("White", "white", 360.0, 200.0),
                             ("Red", "red", 350.0, 199.6)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    gkd_hole = doc["Holes"][0]
    assert _xz(gkd_hole, "White") == pytest.approx((360.0, 200.0), abs=0.01)
    assert _xz(gkd_hole, "Yellow") == pytest.approx((355.0, 200.0), abs=0.01)
    assert _xz(gkd_hole, "Red") == pytest.approx((350.0, 200.0), abs=0.01)


def test_a_point_outside_the_square_is_left_unplaced(tmp_path, terrain, capsys):
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("White", "white", -40.0, 200.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    assert _tee(doc["Holes"][0], "White")["Position"] is None
    assert _tee(doc["Holes"][0], "Yellow")["Position"] is not None
    assert "White tee falls outside the square" in capsys.readouterr().out


# --- Tee sets ---------------------------------------------------------------

def test_tees_map_by_name_then_colour_and_unknown_ones_are_reported(tmp_path, terrain, capsys):
    """The app names a tee whatever the course calls it; the GKD has eight
    slots. Name wins, colour is the fallback, and anything else is skipped
    loudly rather than guessed into a slot."""
    hole = {**HOLE, "tees": [
        ("Dam", "red", 340.0, 200.0),        # unknown name, known colour
        ("Championship", None, 355.0, 200.0),  # alias for Black
        ("Silver", None, 345.0, 200.0),      # neither
    ]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    gkd_hole = doc["Holes"][0]
    assert _tee(gkd_hole, "Red")["Position"]["x"] == pytest.approx(340.0, abs=0.01)
    assert _tee(gkd_hole, "Black")["Position"]["x"] == pytest.approx(355.0, abs=0.01)
    assert doc["teeTypeCount"] == 2
    assert "1 tee(s) named 'Silver'" in capsys.readouterr().out


def test_tee_map_places_a_course_specific_name(tmp_path, terrain):
    hole = {**HOLE, "tees": [("Silver", None, 345.0, 200.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)),
                  tee_map=gspro._parse_tee_map(["Silver=Blue"]))

    assert _tee(doc["Holes"][0], "Blue")["Position"]["x"] == pytest.approx(345.0, abs=0.01)


def test_parse_tee_map_rejects_a_set_that_is_not_one_of_the_eight():
    with pytest.raises(SystemExit, match="Silver=Platinum"):
        gspro._parse_tee_map(["Silver=Platinum"])


# --- Scorecard distances ----------------------------------------------------

def test_distance_walks_the_tee_through_the_aim_points_to_the_green(tmp_path, terrain):
    """A dogleg's yardage is the walk, not the crow's flight: the aim point
    is 60 m off the straight line, and the distance says so."""
    hole = {**HOLE, "aims": [(200.0, 260.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    walk = math.hypot(150.0, 60.0) + math.hypot(150.0, 60.0)
    assert _tee(doc["Holes"][0], "Yellow")["Distance"] == pytest.approx(walk, abs=0.01)


def test_a_forward_tee_does_not_walk_back_to_an_aim_point_it_is_past(tmp_path, terrain):
    """The Junior tee sits between the aim point and the green, so the marker
    meant for the back tees drops out instead of adding a detour."""
    hole = {**HOLE, "tees": [("Yellow", "yellow", 350.0, 200.0), ("Junior", None, 120.0, 200.0)],
            "aims": [(200.0, 260.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    gkd_hole = doc["Holes"][0]
    assert _tee(gkd_hole, "Junior")["Distance"] == pytest.approx(70.0, abs=0.01)
    assert _tee(gkd_hole, "Yellow")["Distance"] == pytest.approx(2 * math.hypot(150.0, 60.0), abs=0.01)


def test_the_par3_set_plays_straight_at_the_green(tmp_path, terrain):
    """Every hole is a single shot on the Par3 layout, so its distance is the
    straight line however the hole doglegs."""
    hole = {**HOLE, "tees": [("Par3", None, 350.0, 200.0)], "aims": [(200.0, 260.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    assert _tee(doc["Holes"][0], "Par3")["Distance"] == pytest.approx(300.0, abs=0.01)


def test_distance_is_measured_on_the_ground_plane_not_along_the_slope(tmp_path, terrain):
    """The tee is 30 m above the green on this ramp; a scorecard ignores that."""
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"))
    assert _tee(doc["Holes"][0], "Yellow")["Distance"] == pytest.approx(300.0, abs=0.01)


def test_tee_type_total_distance_sums_the_holes(tmp_path, terrain):
    holes = (HOLE, {**HOLE, "number": 2, "tees": [("Yellow", "yellow", 250.0, 300.0)],
                    "aims": [], "green": (50.0, 300.0)})
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=holes))

    totals = {t["TeeType"]: t["Distance"] for t in doc["TeeTypeTotalDistance"]}
    assert [t["TeeType"] for t in doc["TeeTypeTotalDistance"]] == list(gspro.GKD_TEE_TYPES)
    assert totals["Yellow"] == pytest.approx(500.0, abs=0.02)
    # Only hole 1 has a White tee, 10 m behind the yellow one.
    assert totals["White"] == pytest.approx(310.0, abs=0.02)
    assert totals["Black"] == 0.0


# --- Pins -------------------------------------------------------------------

def test_pins_fill_the_four_tournament_days_in_order(tmp_path, terrain):
    hole = {**HOLE, "pins": [("Front", 48.0, 198.0), ("Back", 52.0, 202.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    pins = doc["Holes"][0]["Pins"]
    assert [p["Day"] for p in pins] == list(gspro.GKD_PIN_DAYS)
    assert (pins[0]["Position"]["x"], pins[0]["Position"]["z"]) == pytest.approx((48.0, 198.0), abs=0.01)
    assert (pins[1]["Position"]["x"], pins[1]["Position"]["z"]) == pytest.approx((52.0, 202.0), abs=0.01)
    # Short of four, the green centre stands in so GSPro always has a cup.
    assert (pins[2]["Position"]["x"], pins[3]["Position"]["x"]) == pytest.approx((50.0, 50.0), abs=0.01)


def test_a_pin_named_after_a_day_takes_that_day(tmp_path, terrain):
    """A course that already models pin sheets keeps its own names."""
    hole = {**HOLE, "pins": [("Sunday", 44.0, 196.0), ("Front", 48.0, 198.0)]}
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=(hole,)))

    by_day = {p["Day"]: p["Position"] for p in doc["Holes"][0]["Pins"]}
    assert by_day["Sunday"]["x"] == pytest.approx(44.0, abs=0.01)
    assert by_day["Thursday"]["x"] == pytest.approx(48.0, abs=0.01)


def test_a_hole_with_no_pins_falls_back_to_the_green_centre_and_says_so(tmp_path, terrain, capsys):
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"))

    centre = _tee(doc["Holes"][0], gspro.GKD_GREEN_CENTER)["Position"]
    assert all(p["Position"] == centre for p in doc["Holes"][0]["Pins"])
    assert "1 hole(s) have no pins" in capsys.readouterr().out


# --- Hazards and the boundary ----------------------------------------------

def _hazard_poly(hazard):
    """A GKD hazard back in EPSG:3006 metres."""
    from shapely.geometry import Polygon
    return Polygon([(E0 + c["x"], N0 + c["z"]) for c in hazard["coords"]])


def _water(x0, y0, x1, y1):
    from shapely.geometry import box
    return box(E0 + x0, N0 + y0, E0 + x1, N0 + y1)


def _line_to_water(hazard, water) -> np.ndarray:
    """Distance to the water every 10 cm along the hazard line — the lines
    GSPro draws between the nodes as well as the nodes themselves."""
    ring = _hazard_poly(hazard).exterior
    return np.array([water.distance(ring.interpolate(s)) for s in np.arange(0.0, ring.length, 0.1)])


def _dem_terrain(tmp_path, heights_of):
    """A 400 m square at 0.5 m/px whose heights are `heights_of(xs, ys)`
    (metres from the square's south-west corner). Returns the sidecar."""
    res, size = 0.5, 800
    c = (np.arange(size) + 0.5) * res
    xs, ys = np.meshgrid(c, SIDE - c)
    heights = heights_of(xs, ys)
    dem = tmp_path / "bank-inner-dem-400m.tif"
    with rasterio.open(
        dem, "w", driver="GTiff", height=size, width=size, count=1, dtype="float32",
        crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, res, res),
    ) as dst:
        dst.write(heights.astype(np.float32), 1)
    sidecar = dem.with_suffix(".tif.json")
    sidecar.write_text(json.dumps({"crs": "EPSG:3006", "terrain": "inner", "square3006": list(EXTENT),
                                   "sideM": SIDE, "minM": float(heights.min()), "maxM": float(heights.max())}),
                       encoding="utf-8")
    return sidecar


def _bank_terrain(tmp_path, water_box, bank_m, start_m=0.0, degrees=30.0, percent=None):
    """A flat 400 m square with the water at its lowest and one bank all
    round it: level ground for `start_m` out from the water, then a
    `degrees` (or `percent`) slope for `bank_m`, then level again — falling
    instead where the slope is negative. Returns the sidecar."""
    x0, y0, x1, y1 = water_box
    grade = percent / 100 if percent is not None else math.tan(math.radians(degrees))

    def heights(xs, ys):
        dist = np.hypot(np.maximum(np.maximum(x0 - xs, xs - x1), 0), np.maximum(np.maximum(y0 - ys, ys - y1), 0))
        return 58.0 + np.clip((dist - start_m) / bank_m, 0, 1) * bank_m * grade

    return _dem_terrain(tmp_path, heights)


# Where a line with no bank to follow may sit: the margin, plus the outward
# straightening allowance.
AT_MARGIN_M = gspro.DEFAULT_GKD_WATER_MARGIN_M + gspro.GKD_HAZARD_TOLERANCE_M + 0.05


def test_water_is_staked_at_least_the_margin_outside_it(tmp_path, terrain):
    """Where there is no bank the line runs just outside the margin — never
    on or inside the water, at a node or anywhere between two."""
    features = [("water", [_box(100, 100, 140, 140)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    hazard = doc["Hazards"][0]
    gap = _line_to_water(hazard, _water(100, 100, 140, 140))
    assert gap.min() >= gspro.DEFAULT_GKD_WATER_MARGIN_M - 1e-6
    assert gap.max() <= AT_MARGIN_M
    assert _hazard_poly(hazard).contains(_water(100, 100, 140, 140).buffer(gspro.DEFAULT_GKD_WATER_MARGIN_M))
    assert all(c["y"] == pytest.approx(_unity_y(E0 + c["x"]), abs=0.05) for c in hazard["coords"])
    assert (hazard["innerOOB"], hazard["noAIL"], hazard["hasDZ"], hazard["freeDrop"],
            hazard["islandGreen"]) == (False, False, False, False, False)


def test_the_line_is_staked_where_the_bank_ends(tmp_path):
    """A 2 m bank at 30 degrees: the line goes to its top, not the margin."""
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=2.0)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    gap = _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250))
    assert gap.min() >= gspro.DEFAULT_GKD_WATER_MARGIN_M - 1e-6
    assert np.percentile(gap, 5) >= 1.75
    assert np.percentile(gap, 95) <= 3.0


def test_a_bank_is_followed_no_further_than_bank_max(tmp_path):
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=8.0)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features), bank_max_m=2.5)

    gap = _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250))
    assert np.median(gap) == pytest.approx(2.5, abs=0.1)
    assert gap.max() <= 2.5 + gspro.GKD_HAZARD_TOLERANCE_M + 0.05


def test_steep_ground_that_starts_away_from_the_water_is_not_its_bank(tmp_path):
    """A slope 4 m back from the shore is the next hill, not the pond's bank."""
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=2.0, start_m=4.0)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250)).max() <= AT_MARGIN_M


def test_a_gentle_bank_is_not_a_bank(tmp_path):
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=2.0, degrees=4.0)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250)).max() <= AT_MARGIN_M


def _gap_by_side(hazard, water_box) -> dict[str, np.ndarray]:
    """`_line_to_water` split by which side of a box-shaped water the line
    runs along, leaving out 12 m at each corner, where the line eases from
    one side's offset to the next's."""
    x0, y0, x1, y1 = water_box
    water = _water(*water_box)
    ring = _hazard_poly(hazard).exterior
    sides: dict[str, list[float]] = {"west": [], "east": [], "south": [], "north": []}
    for s in np.arange(0.0, ring.length, 0.1):
        p = ring.interpolate(s)
        x, y = p.x - E0, p.y - N0
        if y0 + 12 < y < y1 - 12 and (x < x0 or x > x1):
            sides["west" if x < x0 else "east"].append(water.distance(p))
        elif x0 + 12 < x < x1 - 12 and (y < y0 or y > y1):
            sides["south" if y < y0 else "north"].append(water.distance(p))
    return {k: np.array(v) for k, v in sides.items()}


def test_a_bank_in_deep_rough_is_steeper_than_15_percent(tmp_path):
    """A 2 m bank at 17.5 %, with no surface drawn round the water (OPCD's
    Outer_Deep, deep rough in GSPro): over 15 %, so the line goes out onto it
    — to where the smoothed slope drops to 15 %, half a metre short of the
    top of so gentle a bank."""
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=2.0, percent=17.5)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    gap = _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250))
    assert np.median(gap) == pytest.approx(1.5, abs=0.2)


def test_the_same_bank_in_rough_is_no_bank(tmp_path):
    """Rough drawn round the water: the bank must be steeper than 20 %, so a
    17.5 % one leaves the line 1 m out; drawn deep rough is like undrawn."""
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=2.0, percent=17.5)
    for kind, expected in (("rough", 1.0), ("deep_rough", 1.5)):
        features = [(kind, [_box(120, 120, 280, 280)], 1), ("water", [_box(150, 150, 250, 250)], 1)]
        doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / f"{kind}.sqlite", features=features),
                      out=tmp_path / f"{kind}.GKD")

        gap = _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250))
        assert np.median(gap) == pytest.approx(expected, abs=0.2), kind


def test_ground_falling_away_from_the_water_is_no_bank(tmp_path):
    """A pond dammed above its surroundings: its steep sides fall away from
    the water, so the line stays 1 m out."""
    terrain = _bank_terrain(tmp_path, (150, 150, 250, 250), bank_m=2.0, degrees=-30.0)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert _line_to_water(doc["Hazards"][0], _water(150, 150, 250, 250)).max() <= AT_MARGIN_M


def test_a_pond_on_a_hillside_has_its_bank_on_the_uphill_side_only(tmp_path):
    """The ground rises 30 % to the east all over: the line follows it up to
    the 3 m cap on the east side, and stays 1 m out where the ground falls
    away (west) or runs along the shore (north and south)."""
    terrain = _dem_terrain(tmp_path, lambda xs, ys: 50.0 + 0.3 * xs)
    features = [("water", [_box(150, 150, 250, 250)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    sides = _gap_by_side(doc["Hazards"][0], (150, 150, 250, 250))
    assert np.median(sides["east"]) == pytest.approx(gspro.DEFAULT_GKD_BANK_MAX_M,
                                                     abs=gspro.GKD_HAZARD_TOLERANCE_M + 0.05)
    for side in ("west", "north", "south"):
        assert sides[side].max() <= AT_MARGIN_M, side


def test_hazards_are_played_as_they_lie_unless_their_line_says_otherwise(tmp_path, terrain):
    """noAIL is off by default; `noAsItLies` on a penalty area turns it on
    for that line, and on a water body for the automatic line holding it —
    also when that line holds other water as well."""
    features = [("penalty_red", [_box(20, 20, 60, 60)], 1, {"noAsItLies": True}),
                ("penalty_yellow", [_box(20, 300, 60, 340)], 1),
                ("water", [_box(100, 100, 140, 140)], 1),
                ("water_creek", [_box(140, 115, 200, 125)], 1, {"noAsItLies": True}),
                ("water", [_box(300, 300, 330, 330)], 2, {"noAsItLies": False})]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    def at(x, y):
        from shapely.geometry import Point
        return next(h for h in doc["Hazards"] if _hazard_poly(h).contains(Point(E0 + x, N0 + y)))

    assert at(40, 40)["noAIL"] is True
    assert at(40, 320)["noAIL"] is False
    assert at(120, 120)["noAIL"] is True          # the pond, merged with the creek that asks
    assert at(315, 315)["noAIL"] is False


def test_gkd_lines_are_the_lines_in_the_gkd(tmp_path, terrain):
    """`gkd-lines` writes the very lines the .GKD gets, in EPSG:3006, with
    the water each automatic line holds and the feature each drawn one is."""
    features = [("water", [_box(100, 100, 140, 140)], 1),
                ("water_creek", [_box(140, 115, 200, 125)], 1),
                ("water", [_box(300, 300, 330, 330)], 2, {"noAsItLies": True}),
                ("penalty_red", [_box(20, 20, 60, 60)], 1)]
    db = _make_db(tmp_path / "app.sqlite", features=features)
    doc, _ = _run(tmp_path, terrain, db)
    out = tmp_path / "lines.json"
    gspro.cmd_gkd_lines(None, db, COURSE, terrain, out, extent=EXTENT)
    lines = json.loads(out.read_text(encoding="utf-8"))

    assert lines["courseId"] == COURSE and lines["crs"] == "EPSG:3006"
    assert lines["rule"] == {"marginM": 1.0, "bankMaxM": 3.0, "bankStartM": 2.0, "deepPct": 15.0, "roughPct": 20.0}
    found = {(line["kind"], tuple(line.get("waterIds") or [line.get("featureId")]), line["noAsItLies"])
             for line in lines["lines"]}
    assert found == {("penalty", ("feat-3",), False), ("water", ("feat-0", "feat-1"), False),
                     ("water", ("feat-2",), True)}
    assert next(line for line in lines["lines"] if line["kind"] == "penalty")["type"] == "penalty_red"
    assert len(lines["lines"]) == len(doc["Hazards"])
    for line, hazard in zip(lines["lines"], doc["Hazards"]):
        coords = np.array([[c["x"] + E0, c["z"] + N0] for c in hazard["coords"]])
        assert np.abs(coords - np.array(line["points"])).max() < 2e-3


def test_water_that_meets_is_one_hazard(tmp_path, terrain):
    """A creek running into a pond, and two ponds whose lines would run a
    metre apart, are staked as one hazard; a pond well away is its own."""
    features = [("water", [_box(100, 100, 140, 140)], 1),
                ("water_creek", [_box(140, 115, 200, 125)], 1),      # runs into the pond
                ("water", [_box(100, 142.5, 140, 170)], 1),          # 2.5 m from the pond
                ("water", [_box(300, 300, 330, 330)], 2)]            # well away
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 2
    merged = max((_hazard_poly(h) for h in doc["Hazards"]), key=lambda p: p.area)
    for x0, y0, x1, y1 in [(100, 100, 140, 140), (140, 115, 200, 125), (100, 142.5, 140, 170)]:
        assert merged.contains(_water(x0, y0, x1, y1).buffer(gspro.DEFAULT_GKD_WATER_MARGIN_M))


def test_an_island_is_inside_its_hazard(tmp_path, terrain):
    """A GKD outline is one flat ring, and an island in a pond is in its
    penalty area anyway."""
    island = _box(115, 115, 125, 125)
    island["points"].reverse()
    features = [("water", [_box(100, 100, 140, 140), island], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 1
    assert _hazard_poly(doc["Hazards"][0]).contains(_water(115, 115, 125, 125))


def test_a_drawn_penalty_area_goes_in_as_drawn(tmp_path, terrain):
    """A penalty area is drawn where the line is, so no margin or bank."""
    features = [("penalty_red", [_box(100, 100, 160, 130)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    hazard = _hazard_poly(doc["Hazards"][0])
    assert hazard.buffer(1e-6).contains(_water(100, 100, 160, 130))
    assert hazard.area == pytest.approx(60 * 30, abs=0.5)


def test_water_inside_a_drawn_penalty_area_is_left_to_it(tmp_path, terrain, capsys):
    features = [("penalty_yellow", [_box(80, 80, 180, 180)], 1), ("water", [_box(100, 100, 140, 140)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 1
    assert _hazard_poly(doc["Hazards"][0]).area == pytest.approx(100 * 100, abs=0.5)
    assert "1 water hazard(s) left out" in capsys.readouterr().out


def test_a_red_line_drawn_tight_to_the_shore_is_the_only_line(tmp_path, terrain, capsys):
    """The drawn line runs closer to the water than the automatic one would
    (0.5 m, and up to 3 m out on a flat bank) and even clips the shore by
    half a metre: the water is still the penalty area's, no second line."""
    features = [("penalty_red", [_box(100.5, 99.8, 140.2, 140.3)], 1), ("water", [_box(100, 100, 140, 140)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 1
    assert _hazard_poly(doc["Hazards"][0]).area == pytest.approx(39.7 * 40.5, abs=0.5)
    assert "1 water hazard(s) left out" in capsys.readouterr().out


def test_a_creek_out_of_a_penalty_held_pond_is_staked_on_its_own(tmp_path, terrain):
    """The pond is the red line's; the creek running out of it still gets its
    automatic line, which does not swallow the pond again."""
    features = [("penalty_red", [_box(95, 95, 145, 145)], 1),
                ("water", [_box(100, 100, 140, 140)], 1),
                ("water_creek", [_box(140, 115, 220, 125)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 2
    creek = min((_hazard_poly(h) for h in doc["Hazards"]), key=lambda p: p.area)
    assert creek.contains(_water(146, 115, 220, 125))
    assert not creek.contains(_water(110, 110, 130, 130))


def test_water_only_partly_inside_a_penalty_area_keeps_its_line(tmp_path, terrain):
    features = [("penalty_yellow", [_box(80, 80, 120, 180)], 1), ("water", [_box(100, 100, 140, 140)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 2


def test_hazard_nodes_are_no_further_apart_than_the_spacing(tmp_path, terrain):
    """Nodes along the whole line, so the markings follow the ground."""
    features = [("water", [_box(100, 100, 200, 200)], 1)]
    db = _make_db(tmp_path / "app.sqlite", features=features)

    fine, _ = _run(tmp_path, terrain, db, out=tmp_path / "fine.GKD", node_spacing_m=2.0)
    coarse, _ = _run(tmp_path, terrain, db, out=tmp_path / "coarse.GKD", node_spacing_m=10.0)

    coords = fine["Hazards"][0]["coords"]
    gaps = [math.hypot(a["x"] - b["x"], a["z"] - b["z"]) for a, b in zip(coords, coords[1:] + coords[:1])]
    assert max(gaps) <= 2.0 + 1e-6
    assert coarse["Hazards"][0]["pointCount"] < fine["Hazards"][0]["pointCount"]


def test_a_surface_that_is_not_a_penalty_area_is_not_a_hazard(tmp_path, terrain):
    features = [("bunker", [_box(100, 100, 140, 140)], 1), ("fairway", [_box(60, 60, 340, 340)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert doc["Hazards"] == []


def test_the_largest_oob_ring_is_the_boundary_and_the_rest_are_inner_oob(tmp_path, terrain):
    features = [("oob", [_box(150, 150, 200, 200)], None),   # an internal OOB
                ("oob", [_box(10, 10, 390, 390)], None)]     # the course boundary
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert doc["pOOB"]["pointCount"] == len(doc["pOOB"]["coords"]) == 4
    assert {(round(c["x"]), round(c["z"])) for c in doc["pOOB"]["coords"]} == {
        (10, 10), (390, 10), (390, 390), (10, 390)}
    assert len(doc["Hazards"]) == 1
    inner = doc["Hazards"][0]
    assert (inner["innerOOB"], inner["noAIL"]) == (True, False)
    assert {(round(c["x"]), round(c["z"])) for c in inner["coords"]} == {
        (150, 150), (200, 150), (200, 200), (150, 200)}


def test_an_oob_ring_is_never_straightened_inwards(tmp_path, terrain):
    """Straightening a curved boundary must not cut the course it holds."""
    circle = _ring([(E0 + 200 + 150 * math.cos(a), N0 + 200 + 150 * math.sin(a))
                    for a in np.linspace(0, 2 * math.pi, 60, endpoint=False)])
    db = _make_db(tmp_path / "app.sqlite", features=[("oob", [circle], None)])
    doc, _ = _run(tmp_path, terrain, db, simplify_m=3.0)

    drawn = gspro._zone_geometry_m({"crs": "EPSG:3006", "curveType": "bezier", "rings": [circle]})
    assert _hazard_poly(doc["pOOB"]).buffer(1e-6).contains(drawn)
    assert doc["pOOB"]["pointCount"] < 60


def test_an_outline_is_clipped_to_the_square(tmp_path, terrain):
    """A shape drawn past the terrain edge is cut at it, so no coordinate
    lands off the imported heightmap."""
    features = [("water", [_box(300, 300, 600, 600)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    coords = doc["Hazards"][0]["coords"]
    assert all(0 <= c["x"] <= SIDE and 0 <= c["z"] <= SIDE for c in coords)
    assert max(c["x"] for c in coords) == pytest.approx(SIDE, abs=0.01)


def test_an_outline_entirely_off_the_square_is_skipped(tmp_path, terrain, capsys):
    features = [("water", [_box(-300, -300, -100, -100)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert doc["Hazards"] == []
    assert "1 hazard/OOB shape(s) fall outside the square" in capsys.readouterr().out


# --- Merging with GreenKeeper's own file ------------------------------------

GK_METADATA = {"CourseName": "Vreta Kloster Golfklubb", "Designer": "Fandorm",
               "Location": "Linkoping, , Sweden", "region": 3, "DifficultyRating": 4.2,
               "HasRange": True, "RangeTee": {"x": 1.0, "y": 2.0, "z": 3.0},
               "KeywordParkland": True, "WhiteSR": "70.1/122"}


def _greenkeeper_file(path):
    doc = {**gspro._gkd_skeleton({"name": "placeholder"}, "Scene"), **GK_METADATA,
           "Holes": [{"Enabled": True, "HoleNumber": n, "Par": 4, "Index": 0, "Tees": [], "Pins": []}
                     for n in range(1, 19)]}
    path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    return path


def test_merging_keeps_everything_greenkeeper_owns(tmp_path, terrain):
    """GreenKeeper owns the course's identity and setup; this command owns
    the geometry. Running it must not undo work done in GreenKeeper."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"), out=out)

    assert {k: doc[k] for k in GK_METADATA} == GK_METADATA
    assert doc["Holes"][0]["Par"] == 4 and _tee(doc["Holes"][0], "Yellow")["Position"] is not None


APP_META = {"courseName": "Vreta Kloster", "city": "Ljungsbro", "state": "", "country": "Sweden",
            "designer": "Marcus", "homage": "", "description": "Oak parkland, opened 1990.",
            "difficulty": 4.9, "keywords": ["Parkland", "Historic"]}


def _db_with_meta(path, meta):
    """A course database from after migration 028, with the course's details."""
    db = _make_db(path)
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE courses ADD COLUMN gspro_meta_json TEXT")
    conn.execute("UPDATE courses SET gspro_meta_json = ?", (json.dumps(meta) if meta else None,))
    conn.commit()
    conn.close()
    return db


def test_the_apps_course_details_go_into_the_header(tmp_path, terrain):
    """Details typed in the app win over the file's, in GreenKeeper's own
    spelling; what the app does not keep (region, the range) stays."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    doc, _ = _run(tmp_path, terrain, _db_with_meta(tmp_path / "app.sqlite", APP_META), out=out)

    assert doc["CourseName"] == "Vreta Kloster" and doc["Designer"] == "Marcus"
    assert doc["Location"] == "Ljungsbro, , Sweden" and doc["CityTown"] == "Ljungsbro"
    assert doc["CourseInfo"] == "Oak parkland, opened 1990." and doc["DifficultyRating"] == 4.9
    assert doc["KeywordParkland"] is True and doc["KeywordHistoric"] is True and doc["KeywordLinks"] is False
    assert doc["KeywordsString"] == "Historic, Parkland"
    assert doc["WhiteSR"] == GK_METADATA["WhiteSR"]
    assert doc["region"] == 3 and doc["HasRange"] is True and doc["RangeTee"] == GK_METADATA["RangeTee"]


def test_tee_set_ratings_go_into_the_header(tmp_path, terrain, capsys):
    """A tee set's rating lands on the GKD set its tees do — the men's or the
    women's, whichever the set says GSPro shows; sets without one, and GKD
    sets the course has none for, keep the file's."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    db = _make_db(tmp_path / "app.sqlite")
    conn = sqlite3.connect(db)
    conn.execute("""CREATE TABLE course_tee_sets (id TEXT PRIMARY KEY, course_id TEXT, name TEXT, color TEXT,
        sort_order INTEGER, rating_men REAL, slope_men INTEGER, rating_women REAL, slope_women INTEGER,
        gspro_rating TEXT)""")
    conn.executemany("INSERT INTO course_tee_sets VALUES (?,?,?,?,?,?,?,?,?,?)", [
        ("s1", COURSE, "Gul", "yellow", 0, 71.5, 135, 77.2, 141, "men"),
        ("s2", COURSE, "Red", "red", 1, 66.0, 120, 72.3, 129, "women"),
        ("s3", COURSE, "Blue", "blue", 2, None, None, 75.9, 137, "men"),
        ("s4", COURSE, "Klubbtee", None, 3, 70.0, 130, None, None, "men"),
    ])
    conn.commit()
    conn.close()
    doc, _ = _run(tmp_path, terrain, db, out=out)

    assert doc["YellowSR"] == "71.5/135" and doc["RedSR"] == "72.3/129"
    assert doc["BlueSR"] == "0.0/0" and doc["WhiteSR"] == GK_METADATA["WhiteSR"]
    assert "ratings from the course's tee sets: Yellow 71.5/135, Red 72.3/129" in capsys.readouterr().out


def test_a_tee_sets_gspro_tee_decides_where_its_tees_and_rating_go(tmp_path, terrain, capsys):
    """The club's "57" is GSPro's Yellow because its tee set says so, whatever
    its name and colour; a set with no GSPro tee stays out of the file even
    when its colour is one of the eight."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    hole = {**HOLE, "tees": [("57", "white", 345.0, 200.0), ("Klubb", "red", 350.0, 200.0),
                             ("Knatte", None, 380.0, 200.0)]}
    db = _make_db(tmp_path / "app.sqlite", holes=(hole,))
    conn = sqlite3.connect(db)
    conn.execute("""CREATE TABLE course_tee_sets (id TEXT PRIMARY KEY, course_id TEXT, name TEXT, color TEXT,
        sort_order INTEGER, rating_men REAL, slope_men INTEGER, rating_women REAL, slope_women INTEGER,
        gspro_rating TEXT, gspro_tee TEXT)""")
    conn.executemany("INSERT INTO course_tee_sets VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        ("s1", COURSE, "57", "white", 0, 71.5, 135, None, None, "men", "Yellow"),
        ("s2", COURSE, "Klubb", "red", 1, 66.0, 120, None, None, "men", None),
        ("s3", COURSE, "Knatte", None, 2, 60.1, 101, None, None, "men", "Junior"),
    ])
    conn.execute("ALTER TABLE tees ADD COLUMN tee_set_id TEXT")
    conn.execute("UPDATE tees SET tee_set_id = (SELECT id FROM course_tee_sets s WHERE s.name = tees.name)")
    conn.commit()
    conn.close()
    doc, _ = _run(tmp_path, terrain, db, out=out)

    gkd_hole = doc["Holes"][0]
    assert _tee(gkd_hole, "Yellow")["Position"]["x"] == pytest.approx(345.0, abs=0.01)
    assert _tee(gkd_hole, "Junior")["Position"]["x"] == pytest.approx(380.0, abs=0.01)
    assert not _tee(gkd_hole, "White")["Enabled"] and not _tee(gkd_hole, "Red")["Enabled"]
    assert doc["YellowSR"] == "71.5/135" and doc["JuniorSR"] == "60.1/101"
    assert doc["WhiteSR"] == GK_METADATA["WhiteSR"] and doc["RedSR"] == "0.0/0"
    assert "1 tee(s) named 'Klubb' have no GSPro tee" in capsys.readouterr().out


def test_a_course_without_details_keeps_the_files(tmp_path, terrain):
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    doc, _ = _run(tmp_path, terrain, _db_with_meta(tmp_path / "app.sqlite", None), out=out)

    assert {k: doc[k] for k in GK_METADATA} == GK_METADATA


def test_merging_backs_the_original_up_once(tmp_path, terrain):
    """The first run keeps GreenKeeper's file; later runs must not overwrite
    that backup with their own output."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    original = out.read_bytes()
    db = _make_db(tmp_path / "app.sqlite")

    _run(tmp_path, terrain, db, out=out)
    _run(tmp_path, terrain, db, out=out)

    assert (tmp_path / "Scene.GKD.bak").read_bytes() == original


def test_no_merge_starts_from_a_bare_greenkeeper_file(tmp_path, terrain):
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"), out=out, merge=False)

    assert doc["gkversion"] == gspro.GKD_VERSION
    assert doc["CourseName"] == "Testbana" and doc["Designer"] == ""


def test_a_hole_the_course_has_not_drawn_keeps_the_existing_entry(tmp_path, terrain):
    """A course still being built has 18 GKD holes either way; the ones it
    has no data for are left as GreenKeeper had them."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"), out=out)

    assert len(doc["Holes"]) == gspro.GKD_HOLE_COUNT
    assert doc["Holes"][1] == {"Enabled": True, "HoleNumber": 2, "Par": 4, "Index": 0,
                               "Tees": [], "Pins": []}


def test_course_par_counts_the_holes_that_are_in_play(tmp_path, terrain):
    """Holes the course has not drawn are written disabled, so a half-built
    course does not advertise a par it cannot play."""
    holes = (HOLE, {**HOLE, "number": 2, "par": 5, "green": (50.0, 300.0),
                    "tees": [("Yellow", "yellow", 350.0, 300.0)], "aims": []})
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=holes))

    assert [h["Enabled"] for h in doc["Holes"]] == [True, True] + [False] * 16
    assert doc["CoursePar"] == 4 + 5


def test_altitude_is_the_ground_under_the_greens(tmp_path, terrain):
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"))
    assert doc["altitudeV2"] == pytest.approx(_height(E0 + 50.0), abs=0.1)


def test_an_explicit_altitude_wins(tmp_path, terrain):
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"), altitude=123.4)
    assert doc["altitudeV2"] == pytest.approx(123.4)


def test_the_file_is_minified_utf8_like_greenkeepers_own(tmp_path, terrain):
    _, out = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", course_name="Vreta Kloster"))
    text = out.read_text(encoding="utf-8")

    assert text.startswith('{"gkversion":') and not text.endswith("\n")
    assert "\n" not in text and ", " not in text


# --- Guard rails ------------------------------------------------------------

def test_a_sidecar_for_another_square_is_refused(tmp_path, terrain):
    with pytest.raises(SystemExit, match="is for square"):
        gspro.cmd_gkd(None, _make_db(tmp_path / "app.sqlite"), COURSE, terrain, tmp_path / "Scene.GKD",
                      extent=(E0 + 10, N0, E0 + SIDE + 10, N0 + SIDE))


def test_a_missing_dem_names_the_flag_that_fixes_it(tmp_path, terrain):
    terrain.with_suffix("").unlink()
    with pytest.raises(SystemExit, match="pass --dem"):
        _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite"))


def test_a_course_with_no_holes_is_refused(tmp_path, terrain):
    with pytest.raises(SystemExit, match="has no holes"):
        _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=()))


def test_holes_past_eighteen_are_left_out(tmp_path, terrain, capsys):
    holes = (HOLE, {**HOLE, "number": 19, "green": (50.0, 300.0),
                    "tees": [("Yellow", "yellow", 350.0, 300.0)], "aims": []})
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", holes=holes))

    assert len(doc["Holes"]) == gspro.GKD_HOLE_COUNT
    assert "hole(s) 19 are past 18" in capsys.readouterr().out

# --- Hazards stay inside the OOB boundary -----------------------------------

def _strictly_inside(hazard, boundary) -> bool:
    """Every node and every line between two nodes inside the boundary,
    at least the inset away from it."""
    poly = _hazard_poly(hazard)
    inner = boundary.buffer(-gspro.GKD_OOB_INSET_M + 1e-6)
    return inner.contains(poly)


BOUNDARY = (20, 20, 380, 380)


def test_a_hazard_crossing_the_boundary_is_cut_inside_it(tmp_path, terrain, capsys):
    """GSPro forbids a hazard line on or beyond out of bounds: the part of a
    pond beyond the boundary is out of bounds anyway, so the line is cut
    just inside it."""
    features = [("oob", [_box(*BOUNDARY)], None), ("water", [_box(350, 150, 420, 200)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 1
    boundary = _water(*BOUNDARY)
    assert _strictly_inside(doc["Hazards"][0], boundary)
    # Everything of the pond on the course side is still in it.
    assert _hazard_poly(doc["Hazards"][0]).contains(
        _water(350, 150, 380 - gspro.GKD_OOB_INSET_M - 0.01, 200).buffer(-0.01))
    assert "0 hazard(s) beyond the OOB boundary left out, 1 cut 0.25 m inside it (the drawn `oob` ring)" \
        in capsys.readouterr().out


def test_a_hazard_entirely_beyond_the_boundary_is_left_out(tmp_path, terrain, capsys):
    features = [("oob", [_box(*BOUNDARY)], None),
                ("water", [_box(385, 100, 395, 140)], 1),      # between the boundary and the terrain edge
                ("water", [_box(100, 100, 140, 140)], 1)]      # on the course
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 1
    assert _strictly_inside(doc["Hazards"][0], _water(*BOUNDARY))
    assert "1 hazard(s) beyond the OOB boundary left out, 0 cut" in capsys.readouterr().out


def test_water_staked_out_to_the_boundary_stops_short_of_it(tmp_path, terrain):
    """Water drawn right up to the boundary: its margin would reach past the
    line, so the margin yields there — the boundary rule wins."""
    features = [("oob", [_box(*BOUNDARY)], None), ("water", [_box(200, 150, 379.9, 200)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert _strictly_inside(doc["Hazards"][0], _water(*BOUNDARY))


def test_penalty_areas_and_inner_oob_are_held_inside_the_boundary_too(tmp_path, terrain):
    features = [("oob", [_box(*BOUNDARY)], None),
                ("oob", [_box(360, 300, 400, 340)], None),          # an inner OOB that crosses the line
                ("penalty_red", [_box(-10, 100, 60, 130)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert len(doc["Hazards"]) == 2
    assert all(_strictly_inside(h, _water(*BOUNDARY)) for h in doc["Hazards"])
    assert [h["innerOOB"] for h in doc["Hazards"]] == [False, True]


def test_without_a_drawn_ring_the_boundary_already_in_the_file_holds_the_hazards(tmp_path, terrain, capsys):
    """GreenKeeper may own the boundary: the hazards are cut to that one."""
    out = _greenkeeper_file(tmp_path / "Scene.GKD")
    template = json.loads(out.read_text(encoding="utf-8"))
    x0, y0, x1, y1 = BOUNDARY
    template["pOOB"] = {"pointCount": 4, "coords": [{"x": x, "y": 0.0, "z": z}
                                                     for x, z in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]}
    out.write_text(json.dumps(template), encoding="utf-8")
    features = [("water", [_box(350, 150, 420, 200)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features), out=out)

    assert doc["pOOB"]["pointCount"] == 4  # kept as GreenKeeper had it
    assert _strictly_inside(doc["Hazards"][0], _water(*BOUNDARY))
    assert "cut 0.25 m inside it (the boundary already in the file)" in capsys.readouterr().out


def test_with_no_boundary_anywhere_the_export_says_so(tmp_path, terrain, capsys):
    features = [("water", [_box(100, 100, 140, 140)], 1)]
    _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))
    assert "no OOB boundary, drawn or in the file" in capsys.readouterr().out

from shapely.geometry import Point  # noqa: E402


# --- A bank that comes and goes, and slivers -----------------------------------

def _patchy_bank_terrain(tmp_path, water_box):
    """The water's south shore has a 2.5 m bank only just steeper than the
    bank threshold, under lidar-like noise (fixed seed), so the bank reading
    flickers on and off every few metres along it — what made a notched
    line along a straight ditch. Returns the sidecar."""
    x0, y0, x1, y1 = water_box
    res, size = 0.5, 800
    c = (np.arange(size) + 0.5) * res
    xs, ys = np.meshgrid(c, SIDE - c)
    below = np.clip(y0 - ys, 0, None)  # metres south of the shore
    rise = 2.5 * (gspro.DEFAULT_GKD_BANK_DEEP_PCT + 1.0) / 100
    noise = np.random.default_rng(7).normal(0.0, 0.06, xs.shape)
    heights = 58.0 + np.clip(below / 2.5, 0, 1) * rise + noise
    dem = tmp_path / "patchy-inner-dem-400m.tif"
    with rasterio.open(
        dem, "w", driver="GTiff", height=size, width=size, count=1, dtype="float32",
        crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, res, res),
    ) as dst:
        dst.write(heights.astype(np.float32), 1)
    sidecar = dem.with_suffix(".tif.json")
    sidecar.write_text(json.dumps({"crs": "EPSG:3006", "terrain": "inner", "square3006": list(EXTENT),
                                   "sideM": SIDE, "minM": 58.0, "maxM": 58.0 + rise}), encoding="utf-8")
    return sidecar


def test_a_bank_that_comes_and_goes_gives_a_smooth_line_not_a_notched_one(tmp_path):
    """Along a straight ditch the bank reading flips every few metres. The
    line eases between the margin and the bank top instead of stepping."""
    water = (100, 200, 300, 206)
    terrain = _patchy_bank_terrain(tmp_path, water)
    features = [("water_creek", [_box(*water)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    ring = _hazard_poly(doc["Hazards"][0]).exterior
    south = [ring.interpolate(ring.project(Point(E0 + x, N0 + 150))) for x in np.arange(130, 270, 0.5)]
    gap = np.array([_water(*water).distance(p) for p in south])
    assert gap.min() >= gspro.DEFAULT_GKD_WATER_MARGIN_M - 1e-6
    # Unsmoothed, the flicker notches the line: it jumps about half a metre
    # between neighbouring samples here; smoothed, it eases along.
    assert np.abs(np.diff(gap)).max() < 0.35
    # ...and still sits out on the bank, not back at the margin.
    assert np.median(gap) > 1.5


def test_a_hazard_that_barely_reaches_over_the_boundary_leaves_no_sliver(tmp_path, terrain, capsys):
    """Water just beyond the line: after the cut its margin would be a strip
    under a metre wide along the boundary, which is dropped."""
    features = [("oob", [_box(*BOUNDARY)], None), ("water", [_box(380.2, 100, 420, 140)], 1)]
    doc, _ = _run(tmp_path, terrain, _make_db(tmp_path / "app.sqlite", features=features))

    assert doc["Hazards"] == []
    assert "1 sliver(s) under 1 m wide left by the cut dropped" in capsys.readouterr().out
