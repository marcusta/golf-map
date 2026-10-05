"""Unit tests for shape_surfaces (plain Python: `python blender/tools/shape_surfaces_test.py`).

Small synthetic road shapes in SVG-like metres: an asphalt main road with a gravel side road teeing into it (the
side road reaching 0.5 m into the main one, as OPCD's merge leaves them), kerb fillets in its corners, roads side
by side with a slit between them, an asphalt / concrete pair.
"""

import json
import math
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_surfaces as ss  # noqa: E402


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def piece(rings, surface=None, source=None, no=None, for_=()):
    return {"id": f"p{no}", "featureNo": no, "surface": surface, "source": source, "for": list(for_), "rings": rings}


def fillet(leg_gravel=5.0):
    """The right-hand corner between the asphalt kerb (y = 3) and the gravel kerb (x = 2): legs 0.5 m inside both
    roads, the arc (radius 2 about (4, 5)) tangent to both kerbs; the gravel leg runs up to y = leg_gravel."""
    arc = [[4 - 2 * math.sin(t), 5 - 2 * math.cos(t)] for t in [i * math.pi / 32 for i in range(17)]]
    pts = [[1.5, 2.5], [4, 2.5], [4, 3]] + arc[1:] + [[2, leg_gravel], [1.5, leg_gravel], [1.5, 2.5]]
    return pts


ASPHALT = piece([rect(-20, -3, 20, 3)], "asphalt", "osm", 1)
GRAVEL = piece([rect(-2, 2.5, 2, 20)], "gravel", "osm", 2)


def tee(*extra):
    return ss.Regions([ASPHALT, GRAVEL] + list(extra), dominant="asphalt")


class JunctionPieces(unittest.TestCase):
    def test_a_kerb_fillet_goes_to_the_major_road_and_widens_it(self):
        R = tee(piece([fillet()], None, ss.JUNCTION_SOURCE, None, (1, 2)))
        a = R.assignment[0]
        self.assertEqual(a["surface"], "asphalt")
        self.assertGreater(a["alongM"]["asphalt"], a["alongM"]["gravel"])
        self.assertEqual(R.covered(2.3, 3.3), "asphalt")  # the flare outside both roads
        # its leg inside the gravel road stays gravel: no 0.5 m asphalt strip along the gravel kerb
        self.assertEqual(R.covered(1.8, 4.0), "gravel")

    def test_lengths_within_the_tie_go_to_the_higher_surface(self):
        R = tee(piece([fillet(5.7)], None, ss.JUNCTION_SOURCE, None, (1, 2)))  # gravel 3.9 m vs asphalt 3.5 m
        a = R.assignment[0]
        self.assertAlmostEqual(a["alongM"]["gravel"], 3.9, places=3)
        self.assertAlmostEqual(a["alongM"]["asphalt"], 3.5, places=3)
        self.assertEqual((a["surface"], a["why"]), ("asphalt", "tie"))
        R = ss.Regions([ASPHALT, GRAVEL, piece([fillet(5.7)], None, ss.JUNCTION_SOURCE)], tie=0.0)
        self.assertEqual(R.assignment[0]["surface"], "gravel")  # no tie: the longest

    def test_a_piece_lying_along_the_minor_road_goes_to_it(self):
        R = tee(piece([fillet(10)], None, ss.JUNCTION_SOURCE, None, (1, 2)))  # a long taper along the gravel road
        a = R.assignment[0]
        self.assertEqual((a["surface"], a["why"]), ("gravel", "longest"))
        self.assertEqual(R.covered(2.3, 3.3), "gravel")
        self.assertEqual(R.covered(0.0, 2.8), "asphalt")  # its leg in the asphalt road does not win there

    def test_a_road_piece_without_a_surface_joins_the_one_it_runs_along(self):
        side = piece([rect(-2, 19.5, 2, 40)], None, "osm", 3)  # carries the gravel road on
        R = tee(side)
        self.assertEqual(R.assignment[0]["surface"], "gravel")
        self.assertEqual(R.covered(0, 30), "gravel")

    def test_a_derived_piece_touching_nothing_takes_the_dominant_surface(self):
        R = tee(piece([rect(100, 100, 101, 101)], None, ss.JUNCTION_SOURCE))
        self.assertEqual((R.assignment[0]["surface"], R.assignment[0]["why"]), ("asphalt", "dominant"))


class Regions(unittest.TestCase):
    def test_the_higher_surface_wins_where_pieces_overlap(self):
        R = tee()
        self.assertEqual(R.covered(0, 2.8), "asphalt")  # the gravel road's 0.5 m under the asphalt one
        self.assertEqual(R.covered(0, 3.2), "gravel")
        self.assertEqual(R.covered(10, 0), "asphalt")
        self.assertIsNone(R.covered(10, 10))
        self.assertEqual(R.surfaces(), ["asphalt", "gravel"])

    def test_the_seam_is_the_higher_roads_kerb_with_the_lower_surface_on_its_left(self):
        R = tee(piece([fillet()], None, ss.JUNCTION_SOURCE, None, (1, 2)))
        kerbs = [c for c in R.seams if not c.get("slit")]
        self.assertAlmostEqual(sum(c["length"] for c in kerbs), 4.0 + 2.0, places=3)  # the mouth (y = 3) + the flare's side on x = 2
        # where the arc meets the gravel kerb tangentially, the sliver of ground between them is a slit: its medial
        # line starts next to the tangent point
        for c in R.seams:
            if c.get("slit"):
                self.assertLess(min(math.dist(p, (2, 5)) for p in (c["points"][0], c["points"][-1])), 0.2)  # (the last cm, where the gap is a hair, is no slit)
                self.assertLess(c["length"], 0.5)
        for c in kerbs:
            self.assertEqual((c["high"], c["low"]), ("asphalt", "gravel"))
            (ax, ay), (bx, by) = c["points"][0], c["points"][1]
            L = math.hypot(bx - ax, by - ay)
            mx, my = (ax + bx) / 2 - (by - ay) / L * 0.01, (ay + by) / 2 + (bx - ax) / L * 0.01
            self.assertEqual(R.covered(mx, my), "gravel")
        for x, y in [p for c in kerbs for p in c["points"]]:  # on y = 3 (x in [-2, 2]) or on x = 2 (y in [3, 5])
            self.assertTrue((abs(y - 3) < 1e-6 and -2 - 1e-6 <= x <= 2 + 1e-6) or (abs(x - 2) < 1e-6 and 3 - 1e-6 <= y <= 5 + 1e-6))

    def test_uncovered_ground_goes_to_the_nearest_region(self):
        R = tee()
        self.assertEqual(R.region(2.5, 12), ("gravel", True))
        self.assertEqual(R.region(10, 3.4), ("asphalt", True))
        self.assertEqual(R.region(0, 10), ("gravel", False))

    def test_a_slit_between_two_surfaces_is_split_on_its_medial_line(self):
        R = ss.Regions([piece([rect(0, 0, 10, 2)], "asphalt", None, 1), piece([rect(0, 2.4, 10, 4)], "gravel", None, 2)])
        self.assertEqual(R.region(5, 2.15), ("asphalt", True))
        self.assertEqual(R.region(5, 2.25), ("gravel", True))
        slits = [c for c in R.seams if c.get("slit")]
        self.assertEqual(len(slits), 1)
        self.assertGreater(slits[0]["length"], 9.85)  # sampled every 0.1 m along the asphalt outline
        for x, y in slits[0]["points"]:
            self.assertAlmostEqual(y, 2.2, places=6)
        (ax, ay), (bx, by) = slits[0]["points"][:2]
        self.assertGreater(bx, ax)  # the gravel (y > 2.2) on the left of the direction of travel
        wide = ss.Regions([piece([rect(0, 0, 10, 2)], "asphalt", None, 1), piece([rect(0, 3, 10, 4)], "gravel", None, 2)])
        self.assertEqual([c for c in wide.seams if c.get("slit")], [])  # 1 m apart: no slit

    def test_fade_lines_run_the_width_into_the_lower_surface(self):
        R = tee(piece([fillet()], None, ss.JUNCTION_SOURCE, None, (1, 2)))
        lines = R.fade_lines(0.5)
        self.assertTrue(lines)
        for f in lines:
            self.assertEqual(f["low"], "gravel")
            for x, y in f["points"]:
                self.assertEqual(R.region(x, y)[0], "gravel")
                self.assertGreater(R.seam_distance(x, y, "gravel"), 0.5 - 0.021)
        self.assertGreater(sum(ss.polyline_length(f["points"]) for f in lines), 3.0)

    def test_asphalt_against_concrete_is_a_crisp_seam_with_no_fade(self):
        R = ss.Regions([piece([rect(0, 0, 10, 4)], "asphalt", None, 1), piece([rect(9, 0, 20, 4)], "concrete", None, 2)])
        self.assertEqual([(c["high"], c["low"]) for c in R.seams], [("asphalt", "concrete")])
        self.assertEqual(R.fade_lines(0.5), [])
        self.assertTrue(ss.is_sharp("concrete", "asphalt"))

    def test_the_report_names_surfaces_seams_and_assignments(self):
        R = tee(piece([fillet()], None, ss.JUNCTION_SOURCE, None, (1, 2)))
        rep = R.report()
        self.assertEqual(rep["surfaces"], ["asphalt", "gravel"])
        self.assertAlmostEqual(rep["seamM"]["asphalt/gravel"], 6.0, delta=0.5)  # the kerbs + the cusp's slit
        self.assertEqual(rep["derived"][0]["for"], [1, 2])
        json.dumps(rep)


class Helpers(unittest.TestCase):
    def test_rank_orders_hard_surfaces_first(self):
        order = sorted(["dirt", "gravel", "wood", "paving", "concrete", "asphalt", "grass", None], key=ss.rank)
        self.assertEqual(order, ["asphalt", "concrete", "paving", "wood", "gravel", "dirt", "grass", None])
        self.assertEqual(ss.higher("gravel", "asphalt"), "asphalt")

    def test_svg_to_blend_is_the_frame_turned_about_the_square(self):
        f = ss.svg_to_blend({"sideM": 2050.0, "px": 0.0, "pz": 0.0})
        self.assertEqual(f(1165.9, 1507.05), (-1165.9, 1507.05 - 2050.0))

    def test_sidecar_helpers(self):
        doc = {"format": ss.FORMAT, "shapes": {"roads_1": "asphalt"},
               "regions": {"roads_1": {"surface": "asphalt", "mixed": True, "pieces": [ASPHALT]},
                           "roads_2": {"surface": "gravel", "mixed": False, "pieces": [GRAVEL]}}}
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "course-paths.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(doc, f)
            self.assertEqual(ss.sidecar_for_svg(os.path.join(d, "course.svg")), p)
            loaded = ss.load_sidecar(p)
        self.assertEqual(ss.mixed_shapes(loaded), ["roads_1"])
        self.assertEqual(ss.shape_key(loaded, "roads_1"), ss.shape_key(json.loads(json.dumps(doc)), "roads_1"))
        self.assertNotEqual(ss.shape_key(loaded, "roads_1"), ss.shape_key(loaded, "roads_2"))
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump({"format": "other"}, f)
            self.assertRaises(ValueError, ss.load_sidecar, p)

    def test_segment_intersections_cross_touch_and_overlap(self):
        self.assertEqual(ss.seg_intersections((0, 0), (2, 0), (1, -1), (1, 1)), [0.5])
        self.assertEqual(ss.seg_intersections((0, 0), (2, 0), (2, 0), (3, 1)), [1.0])
        self.assertEqual(sorted(ss.seg_intersections((0, 0), (4, 0), (1, 0), (3, 0))), [0.25, 0.75])
        self.assertEqual(ss.seg_intersections((0, 0), (2, 0), (0, 1), (2, 1)), [])

    def test_offset_and_simplify(self):
        off = ss.offset_polyline([(0, 0), (10, 0), (10, 10)], 1.0)
        self.assertEqual(off[0], (0.0, 1.0))
        self.assertAlmostEqual(off[1][0], 9.0)
        self.assertAlmostEqual(off[1][1], 1.0)
        self.assertEqual(ss.simplify([(0, 0), (1, 0.001), (2, 0), (2, 5)], 0.005), [(0, 0), (2, 0), (2, 5)])

    def test_ring_point_test_and_grid_nearest(self):
        r = ss.Ring([(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)])
        self.assertTrue(r.contains(2, 2))
        self.assertFalse(r.contains(5, 2))
        self.assertEqual(r.area(), 16)
        g = ss.SegmentGrid(1.0)
        g.add((0, 0), (10, 0), "a")
        g.add((0, 50), (10, 50), "b")
        d, i = g.nearest(5, 30)
        self.assertEqual((round(d, 6), g.items[i][2]), (20.0, "b"))


if __name__ == "__main__":
    unittest.main()
