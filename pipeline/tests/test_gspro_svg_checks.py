"""The SVG export's checks of what OPCD will see (gspro._green_border_problems,
gspro._hidden_shapes, gspro._overlap_slivers, gspro._narrow_necks) and their findings
(gspro._svg_check_findings) plus the `svg` command's refusal on them: paint order is bottom first, the
topmost shape wins."""
import json
import re

from shapely.geometry import Point, box

import gspro


def paint(*items):
    return [(layer, name, kind, shape) for layer, name, kind, shape in items]


def test_green_inside_fairway_is_fine():
    p = paint(("Hole1", "hole_1_1", "fairway", Point(0, 0).buffer(20)),
              ("Hole1", "hole_1_2", "green", Point(0, 0).buffer(10)))
    assert gspro._green_border_problems(p) == []


def test_green_straight_in_rough_or_on_nothing_is_reported():
    # Omberg hole 13: the green lay in course-wide rough, with bunkers beside it.
    p = paint(("Others", "others_1", "rough", Point(0, 0).buffer(50)),
              ("Hole13", "hole_13_1", "green", Point(0, 0).buffer(10)),
              ("Hole13", "hole_13_2", "green", Point(200, 0).buffer(10)))
    problems = dict(gspro._green_border_problems(p))
    assert set(problems) == {"hole_13_1", "hole_13_2"}
    assert set(problems["hole_13_1"]) == {"rough"}
    assert set(problems["hole_13_2"]) == {gspro.GREEN_BORDER_NOTHING}


def test_the_topmost_shape_counts():
    # Fairway drawn under the course-wide rough's layer order would be hidden;
    # a rough of a hole painted above the fairway covers part of the edge.
    green = Point(0, 0).buffer(10)
    p = paint(("Others", "others_1", "rough", Point(0, 0).buffer(50)),
              ("Hole2", "hole_2_1", "rough", box(5, -20, 30, 20)),
              ("Hole1", "hole_1_1", "fairway", Point(0, 0).buffer(20)),
              ("Hole1", "hole_1_2", "green", green))
    assert gspro._green_border_problems(p) == []
    p = paint(("Others", "others_1", "rough", Point(0, 0).buffer(50)),
              ("Hole2", "hole_2_1", "fairway", Point(0, 0).buffer(20)),
              ("Hole1", "hole_1_2", "green", green),
              ("Hole1", "hole_1_3", "bunker", box(9, -3, 14, 3)))
    problems = dict(gspro._green_border_problems(p))
    assert set(problems["hole_1_2"]) == {"bunker"}


def test_snapping_noise_along_the_edge_is_ignored():
    green = Point(0, 0).buffer(10)
    fairway = Point(0.05, 0).buffer(20).difference(box(19.9, -0.01, 21, 0.01))
    p = paint(("Hole1", "hole_1_1", "fairway", fairway), ("Hole1", "hole_1_2", "green", green))
    assert gspro._green_border_problems(p) == []


def test_a_shape_covered_by_the_ones_above_is_hidden():
    # Omberg: hole 10's tees all lay under hole 1's fairway and semi rough.
    p = paint(("Hole10", "hole_10_1", "tee", box(0, 0, 5, 5)),
              ("Hole10", "hole_10_2", "tee", box(100, 0, 105, 5)),
              ("Hole1", "hole_1_1", "semi_rough", box(-10, -10, 3, 20)),
              ("Hole1", "hole_1_2", "fairway", box(2, -10, 20, 20)))
    assert gspro._hidden_shapes(p) == [("hole_10_1", ["hole_1_1", "hole_1_2"])]


def test_a_shape_on_top_is_never_hidden():
    p = paint(("Hole1", "hole_1_1", "fairway", box(0, 0, 20, 20)),
              ("Hole1", "hole_1_2", "green", box(5, 5, 10, 10)))
    assert gspro._hidden_shapes(p) == []


def test_a_spike_is_reported_once_with_its_angle():
    # A thin wedge (Omberg's driving-range fairway had two 19° spikes after the road-edge fill).
    from shapely.geometry import Polygon
    wedge = Polygon([(0, 0), (40, 6), (0, 12), (-20, 6)])
    spikes = gspro._sharp_corners(wedge)
    assert len(spikes) == 1
    x, y, angle = spikes[0]
    assert (x, y) == (40, 6) and 15 < angle < 18


def test_bends_and_dense_curves_are_not_spikes():
    assert gspro._sharp_corners(box(0, 0, 10, 10)) == []          # 90° corners
    assert gspro._sharp_corners(Point(0, 0).buffer(30, quad_segs=256)) == []   # 1000+ tiny segments


def test_a_thin_overlap_strip_is_reported_with_its_width_and_length():
    # Landeryd hole 8: a bunker reaching 0.12 m into the green's semi rough over 1.4 m failed the build.
    semi = box(0, 0, 30, 20)
    bunker = box(10, 19.88, 11.4, 25)
    p = paint(("Hole8", "hole_8_233", "semi_rough", semi), ("Hole8", "hole_8_253", "bunker", bunker))
    [(lower, upper, width, length, x, y)] = gspro._overlap_slivers(p)
    assert (lower, upper) == ("hole_8_233", "hole_8_253")
    assert abs(width - 0.12) < 0.01 and abs(length - 1.4) < 0.15
    assert abs(x - 10.7) < 0.01 and abs(y - 19.94) < 0.01


def test_overlapping_well_clear_or_corner_to_corner_is_fine():
    semi = box(0, 0, 30, 20)
    for bunker in (box(10, 18, 14, 25),          # 2 m into the semi: a proper bite
                   box(10, 20.5, 14, 25),        # clear of it
                   box(30 - 0.1, 20 - 0.1, 35, 25),  # corners grazing: 0.1 x 0.1
                   box(5, 5, 8, 8)):             # inside it
        p = paint(("Hole1", "hole_1_1", "semi_rough", semi), ("Hole1", "hole_1_2", "bunker", bunker))
        assert gspro._overlap_slivers(p) == [], bunker.bounds


def test_roads_are_left_to_the_road_merge():
    p = paint(("Hole1", "hole_1_1", "fairway", box(0, 0, 30, 20)),
              ("Roads", "roads_1", "path", box(-5, 19.9, 40, 23)))
    assert gspro._overlap_slivers(p) == []


# --- narrow necks (OPCD's opcd_cut_mesh validator) ------------------------------

def _dumbbell(bridge_m):
    """Two 4 m squares joined by a 1 m long bridge `bridge_m` wide."""
    from shapely import unary_union
    return unary_union([box(0, 0, 4, 4), box(5, 0, 9, 4), box(3.9, 2 - bridge_m / 2, 5.1, 2 + bridge_m / 2)])


def test_a_shape_pinched_to_a_neck_under_the_blend_is_reported_at_the_neck():
    # Landeryd's first upload: OPCD refused 12 shapes that pinch under its 0.24 m blend.
    p = paint(("Others", "others_1", "rough", _dumbbell(0.1)))
    [(name, regions)] = gspro._narrow_necks(p)
    assert name == "others_1"
    neck = regions[0]
    c = neck.centroid
    assert 4 <= c.x <= 5 and 1.9 <= c.y <= 2.1          # in the bridge
    assert neck.bounds[0] >= 3.5 and neck.bounds[2] <= 5.5


def test_a_hole_too_close_to_the_edge_is_a_neck_too():
    # Landeryd's others_98fb3: a 0.04 m strip between a hole of the canopy and its outer edge.
    frame = box(0, 0, 10, 10).difference(box(2, 2, 9.9, 8))
    [(name, [neck])] = gspro._narrow_necks(paint(("Others", "others_1", "trees", frame)))
    assert 9.85 <= neck.centroid.x <= 10 and 2 <= neck.centroid.y <= 8


def test_a_neck_wider_than_the_blend_is_fine():
    for shape in (_dumbbell(0.5), box(0, 0, 10, 10), Point(0, 0).buffer(5),
                  box(0, 0, 10, 10).difference(box(2, 2, 8, 8))):   # a 2 m wide frame
        assert gspro._narrow_necks(paint(("Others", "others_1", "rough", shape))) == [], shape.bounds


def test_two_separate_pieces_are_no_neck_and_roads_are_left_out():
    from shapely import unary_union
    apart = unary_union([box(0, 0, 4, 4), box(5, 0, 9, 4)])
    assert gspro._narrow_necks(paint(("Others", "others_1", "rough", apart))) == []
    assert gspro._narrow_necks(paint(("Roads", "roads_1", "path", _dumbbell(0.1)))) == []


def test_the_neck_check_is_fast_on_thousands_of_shapes():
    import time
    shapes = [("Others", f"others_{k}", "trees", Point(k % 50 * 12, k // 50 * 12).buffer(4, quad_segs=16))
              for k in range(2500)]
    shapes.append(("Others", "others_x", "trees", _dumbbell(0.1)))
    t = time.perf_counter()
    assert [n for n, _ in gspro._narrow_necks(paint(*shapes))] == ["others_x"]
    assert time.perf_counter() - t < 5


# --- findings (golfmap-svg-checks-v1) ---------------------------------------------

def _no_svg(xy):
    return xy


def test_findings_are_keyed_on_feature_ids_with_the_problem_as_geometry():
    semi = box(0, 0, 30, 20)
    bunker = box(10, 19.88, 11.4, 25)
    p = paint(("Hole8", "hole_8_233", "semi_rough", semi), ("Hole8", "hole_8_253", "bunker", bunker),
              ("Others", "others_1", "rough", _dumbbell(0.1).union(box(-50, -50, -40, -40))))
    ids = {"hole_8_233": ["f-semi"], "hole_8_253": ["f-bunker"], "others_1": ["f-rough"]}
    by_code = {f["code"]: f for f in gspro._svg_check_findings(p, ids, _no_svg)}

    sliver = by_code["overlap-sliver"]
    assert sliver["key"] == "overlap-sliver:f-semi+f-bunker"
    assert sliver["severity"] == "error" and sliver["accepted"] is False
    assert [s["name"] for s in sliver["shapes"]] == ["hole_8_233", "hole_8_253"]
    assert sliver["shapes"][1] == {"name": "hole_8_253", "type": "bunker", "featureIds": ["f-bunker"]}
    assert re.fullmatch(r"hole_8_253 reaches 0\.1\d m into hole_8_233 over 1\.\d m: under OPCD's 0\.24 m blend, "
                        r"the build fails - clear the edge or overlap it more", sliver["message"])
    assert sliver["geometry"]["type"] == "Polygon"
    xs = [x for x, _ in sliver["geometry"]["coordinates"][0]]
    assert min(xs) == 10 and max(xs) == 11.4
    assert sliver["at"] == [10.7, 19.94]

    neck = by_code["narrow-neck"]
    assert neck["key"] == "narrow-neck:f-rough" and neck["severity"] == "error"
    assert neck["message"] == "others_1 pinches to under 0.24 m (OPCD's blend): widen it to 0.3 m or split it there"
    assert 4 <= neck["at"][0] <= 5


def test_a_hidden_shape_is_keyed_on_itself_and_a_spike_is_a_note():
    from shapely.geometry import Polygon
    p = paint(("Hole10", "hole_10_1", "tee", box(0, 0, 5, 5)),
              ("Hole1", "hole_1_1", "fairway", box(-10, -10, 20, 20)),
              ("Hole1", "hole_1_2", "rough", Polygon([(100, 0), (140, 6), (100, 12), (80, 6)])))
    ids = {"hole_10_1": ["f-tee"], "hole_1_1": ["f-fw"], "hole_1_2": ["f-r"]}
    findings = gspro._svg_check_findings(p, ids, _no_svg)
    hidden = next(f for f in findings if f["code"] == "hidden-shape")
    assert hidden["key"] == "hidden-shape:f-tee"
    assert [s["name"] for s in hidden["shapes"]] == ["hole_10_1", "hole_1_1"]
    spike = next(f for f in findings if f["code"] == "sharp-corner")
    assert spike["severity"] == "note" and spike["geometry"] == {"type": "Point", "coordinates": [140.0, 6.0]}


def test_finding_geometry_is_simplified_and_rounded():
    g = gspro._finding_geojson(Point(0.123456, 0).buffer(30, quad_segs=512))
    ring = g["coordinates"][0]
    assert len(ring) <= gspro.FINDING_MAX_VERTICES
    assert all(round(v, 2) == v for xy in ring for v in xy)
    assert gspro._finding_geojson(None) is None


# --- `gspro.py svg` refusing on errors (--checks-out, --accepted, --check-only, --allow-errors) ---

def _cli_course(tmp_path, lone_green=True):
    """A course DB with a green on hole 1: straight on nothing (a green-border
    error) or inside a fairway (clean)."""
    from test_gspro_svg import _make_db, _ring
    features = [("green", 1, 1, [_ring((0.40, 0.40), 10)], "bspline", 1, "f-green")]
    if not lone_green:
        features.insert(0, ("fairway", 1, 0, [_ring((0.40, 0.40), 40)], "bspline", 2, "f-fairway"))
    db = tmp_path / "app.sqlite"
    _make_db(db, features, holes=(1,))
    return db


def _svg(tmp_path, db, *extra):
    from test_gspro_svg import BBOX
    out = tmp_path / "out" / "course.svg"
    argv = ["svg", "--bbox", ",".join(map(str, BBOX)), "--course", "Testbana", "--db", str(db),
            "--out", str(out), *extra]
    try:
        code = gspro.main(argv)
    except SystemExit as exc:
        code = exc.code
    return code, out


def _written(out):
    return sorted(p.name for p in out.parent.glob("*")) if out.parent.exists() else []


def test_an_error_writes_nothing_but_the_checks_and_exits_3(tmp_path, capsys):
    db = _cli_course(tmp_path)
    checks = tmp_path / "checks.json"
    code, out = _svg(tmp_path, db, "--checks-out", str(checks))
    assert code == gspro.SVG_CHECKS_FAILED_EXIT == 3
    assert _written(out) == []
    printed = capsys.readouterr().out.splitlines()
    assert any(line.startswith("  error: green hole_1_1 meets more than fairway/semi rough") for line in printed)
    assert printed[-1] == "error: 1 SVG check error(s); nothing written (accept known ones, or fix the shapes)"
    doc = json.loads(checks.read_text(encoding="utf-8"))
    assert doc["format"] == "golfmap-svg-checks-v1" and doc["courseName"] == "Testbana"
    assert (doc["errors"], doc["accepted"]) == (1, 0) and doc["checkedAt"].endswith("Z")
    [f] = [f for f in doc["findings"] if f["severity"] == "error"]
    assert f["key"] == "green-border:f-green" and f["code"] == "green-border" and f["accepted"] is False
    assert f["shapes"] == [{"name": "hole_1_1", "type": "green", "featureIds": ["f-green"]}]
    assert f["geometry"]["type"] in ("Polygon", "MultiPolygon")
    assert f["at"][0] > 400000 and f["at"][1] > 6000000          # EPSG:3006 metres, not SVG units


def test_an_accepted_error_lets_the_export_through(tmp_path, capsys):
    db = _cli_course(tmp_path)
    checks, accepted = tmp_path / "checks.json", tmp_path / "accepted.json"
    accepted.write_text(json.dumps({"format": "golfmap-svg-checks-accepted-v1", "accepted": [
        {"key": "green-border:f-green", "note": "OPCD builds it", "at": "2026-10-21T08:00:00Z"}]}), encoding="utf-8")
    code, out = _svg(tmp_path, db, "--checks-out", str(checks), "--accepted", str(accepted))
    assert code == 0 and out.is_file()
    assert _written(out) == ["course-paths.json", "course-shapes.json", "course.svg"]
    assert any(line.endswith(" (accepted)") for line in capsys.readouterr().out.splitlines())
    doc = json.loads(checks.read_text(encoding="utf-8"))
    assert (doc["errors"], doc["accepted"]) == (0, 1)
    assert [f["accepted"] for f in doc["findings"] if f["code"] == "green-border"] == [True]
    # A missing accepted file accepts nothing.
    code, _ = _svg(tmp_path / "again", db, "--accepted", str(tmp_path / "nope.json"))
    assert code == 3


def test_check_only_writes_only_the_checks_errors_or_not(tmp_path):
    for lone_green, errors in ((False, 0), (True, 1)):
        base = tmp_path / str(lone_green)
        base.mkdir()
        db = _cli_course(base, lone_green)
        checks = base / "checks.json"
        code, out = _svg(base, db, "--check-only", "--checks-out", str(checks))
        assert code == 0 and _written(out) == []
        assert json.loads(checks.read_text(encoding="utf-8"))["errors"] == errors
    code, _ = _svg(tmp_path, db, "--check-only")       # needs --checks-out
    assert code == 2


def test_allow_errors_writes_the_svg_anyway(tmp_path):
    db = _cli_course(tmp_path)
    checks = tmp_path / "checks.json"
    code, out = _svg(tmp_path, db, "--allow-errors", "--checks-out", str(checks))
    assert code == 0 and out.is_file()
    assert json.loads(checks.read_text(encoding="utf-8"))["errors"] == 1
