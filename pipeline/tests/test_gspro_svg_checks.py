"""The SVG export's checks of what OPCD will see (gspro._green_border_problems,
gspro._hidden_shapes): paint order is bottom first, the topmost shape wins."""
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
