"""Unit tests for shape_layers (plain Python: `python blender/tools/shape_layers_test.py`)."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_layers as sl  # noqa: E402

SVG = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
  <g inkscape:groupmode="layer" id="layer1" inkscape:label="Others">
    <path id="others_1" data-type="rough" data-feature-id="f-rough" d="M 0,0 L 10,0 L 10,10 Z"/>
  </g>
  <g inkscape:groupmode="layer" id="layer2" inkscape:label="Hole18">
    <path id="hole_18_1" inkscape:label="hole_18_1" data-type="tee" data-feature-id="f-tee" d="M 100,200 C 101,201 102,202 110,205 L 110,210 Z"/>
    <path id="hole_18_2" data-type="bunker" data-feature-id="f-bunker" d="m 50,50 l 5,0 l 0,5 z"/>
  </g>
  <g inkscape:groupmode="layer" id="layer20" inkscape:label="Roads">
    <path id="roads_1" data-type="path" data-feature-id="f-a f-b" d="M 0,0 H 20 V 5 H 0 Z"/>
  </g>
</svg>"""

OBJECTS = [
    {"name": "Spline_hole_18_1_Tee_-_Mesh", "shapeId": "hole_18_1", "parentId": "hole_18_1", "kind": "mesh"},
    {"name": "Spline_hole_18_1_B_Semi_Tee_-_Blend", "shapeId": "hole_18_1", "parentId": "hole_18_1", "kind": "blend"},
    {"name": "Spline_hole_18_2_Bunker_-_Mesh", "shapeId": "hole_18_2", "parentId": "hole_18_2", "kind": "mesh"},
    {"name": "Spline_others_1_piece1_Rough_-_Mesh", "shapeId": "others_1_piece1", "parentId": "others_1", "kind": "mesh"},
    {"name": "Spline_others_1_piece2_0_Rough_-_Mesh", "shapeId": "others_1_piece2_0", "parentId": "others_1_piece2_0", "kind": "mesh"},
    {"name": "Spline_roads_1_Concrete_-_Mesh", "shapeId": "roads_1", "parentId": "roads_1", "kind": "mesh"},
    {"name": "Spline_roads_1_hole0_B_Concrete_-_Blend", "shapeId": "roads_1_hole0", "parentId": "roads_1", "kind": "blend"},
    {"name": "Spline_Outer_Deep_Sat_1_0_piece1_-_Mesh", "shapeId": "Outer_Deep_Sat_1_0", "parentId": "Outer_Deep_Sat_1_0", "kind": "mesh"},
]


def layer(ops, lid="spike"):
    return {"format": sl.FORMAT, "id": lid, "ops": ops}


SURFACE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">
  <g inkscape:groupmode="layer" id="layer1" inkscape:label="Roads">
    <path id="roads_1" data-type="path" data-surface="gravel" data-feature-id="f-a f-b" d="M 0,0 H 20 V 5 H 0 Z"/>
    <path id="roads_2" data-type="path" data-surface="concrete" data-feature-id="f-c" d="M 0,0 H 20 V 5 H 0 Z"/>
    <path id="roads_3" data-type="path" data-feature-id="f-d" d="M 0,0 H 20 V 5 H 0 Z"/>
  </g>
</svg>"""


class CutPaintDecisionTest(unittest.TestCase):
    def setUp(self):
        self.paths = sl.parse_svg(SURFACE_SVG)
        self.db_calls = []

    def db(self, fids):
        self.db_calls.append(list(fids))
        return {f: "concrete" for f in fids}

    def test_parse_keeps_data_surface(self):
        self.assertEqual(self.paths["roads_1"]["surface"], "gravel")
        self.assertEqual(self.paths["roads_2"]["surface"], "concrete")
        self.assertIsNone(self.paths["roads_3"]["surface"])
        self.assertIsNone(sl.parse_svg(SVG)["roads_1"]["surface"])  # the shared fixture has none

    def test_svg_surface_wins_over_op_and_db(self):
        r = sl.cut_paint_decision({"pathSurfaces": {"f-a": "concrete", "f-b": "concrete"}}, self.paths["roads_1"], self.db)
        self.assertEqual(r, {"mode": "restore", "source": "svg", "surfaces": {"f-a": "gravel", "f-b": "gravel"}})
        self.assertEqual(self.db_calls, [])
        r = sl.cut_paint_decision({}, self.paths["roads_2"], self.db)
        self.assertEqual((r["mode"], r["source"]), ("keep", "svg"))
        self.assertEqual(self.db_calls, [])

    def test_explicit_cut_paint_wins(self):
        r = sl.cut_paint_decision({"cutPaint": "keep"}, self.paths["roads_1"], self.db)
        self.assertEqual(r, {"mode": "keep", "source": "op", "surfaces": None})
        r = sl.cut_paint_decision({"cutPaint": "restore"}, self.paths["roads_2"], self.db)
        self.assertEqual((r["mode"], r["source"]), ("restore", "op"))

    def test_falls_back_to_op_then_db(self):
        r = sl.cut_paint_decision({"pathSurfaces": {"f-d": "concrete"}}, self.paths["roads_3"], self.db)
        self.assertEqual((r["mode"], r["source"]), ("keep", "op"))
        r = sl.cut_paint_decision({"pathSurfaces": {"f-d": "asphalt"}}, self.paths["roads_3"], self.db)
        self.assertEqual((r["mode"], r["source"]), ("restore", "op"))
        r = sl.cut_paint_decision({}, self.paths["roads_3"], self.db)
        self.assertEqual((r["mode"], r["source"], self.db_calls), ("keep", "db", [["f-d"]]))

    def test_unknown_restores(self):
        r = sl.cut_paint_decision({}, {}, self.db)
        self.assertEqual(r, {"mode": "restore", "source": "none", "surfaces": {}})
        r = sl.cut_paint_decision({}, self.paths["roads_3"], lambda fids: {f: None for f in fids})
        self.assertEqual((r["mode"], r["source"]), ("restore", "db"))



class SvgTest(unittest.TestCase):
    def test_parse(self):
        p = sl.parse_svg(SVG)
        self.assertEqual(set(p), {"others_1", "hole_18_1", "hole_18_2", "roads_1"})
        self.assertEqual(p["hole_18_1"]["type"], "tee")
        self.assertEqual(p["hole_18_1"]["hole"], 18)
        self.assertEqual(p["hole_18_1"]["layer"], "Hole18")
        self.assertIsNone(p["others_1"]["hole"])
        self.assertEqual(p["roads_1"]["featureIds"], ["f-a", "f-b"])
        self.assertEqual(p["hole_18_1"]["bbox"], [100, 200, 110, 210])
        self.assertEqual(p["hole_18_2"]["bbox"], [50, 50, 55, 55])  # relative commands
        self.assertEqual(p["roads_1"]["bbox"], [0, 0, 20, 5])  # H/V

    def test_resolve_shape(self):
        ids = {"hole_1_2", "hole_1_20", "others_5", "roads_1"}
        self.assertEqual(sl.resolve_shape("hole_1_2_0", ids), "hole_1_2")
        self.assertEqual(sl.resolve_shape("hole_1_20", ids), "hole_1_20")
        self.assertEqual(sl.resolve_shape("others_5_piece1_1", ids), "others_5")
        self.assertEqual(sl.resolve_shape("roads_1_hole3", ids), "roads_1")
        self.assertIsNone(sl.resolve_shape("Outer_Deep_Sat_1_0", ids))

    def test_choose_svg(self):
        good = sl.parse_svg(SVG)
        other = {k: v for k, v in good.items() if k != "hole_18_2"}
        extra = dict(good, hole_18_3=good["hole_18_2"])
        ranked = sl.choose_svg({"a.svg": other, "b.svg": good, "c.svg": extra},
                               [o["shapeId"] for o in OBJECTS])
        self.assertEqual([p for p, _ in ranked], ["b.svg", "c.svg", "a.svg"])

    def test_naming_scheme_and_seed(self):
        p = sl.parse_svg(SVG)
        self.assertEqual(sl.naming_scheme(p), "index")
        self.assertEqual(sl.naming_scheme({"hole_2_1a": 0, "hole_2_3": 0}), "feature-no")
        self.assertEqual(sl.naming_scheme({"hole_2_5": 0, "hole_2_9": 0}), "feature-no")
        tee = p["hole_18_1"]
        self.assertEqual(sl.feature_seed(tee, "index"), sl.stable_seed("f-tee"))
        self.assertEqual(sl.feature_seed(dict(tee, id="hole_18_1a"), "feature-no"), 0x1a)
        self.assertEqual(sl.feature_seed(dict(tee, featureNo=77), "index"), 77)
        self.assertEqual(sl.stable_seed("f-tee"), sl.stable_seed("f-tee"))


class SelectTest(unittest.TestCase):
    def setUp(self):
        self.index = sl.build_index(OBJECTS, sl.parse_svg(SVG))

    def names(self, sel):
        recs, problems = sl.select(sel, self.index)
        return [r["name"] for r in recs], problems

    def test_by_feature(self):
        self.assertEqual(self.names({"feature": "f-tee"}), (["Spline_hole_18_1_Tee_-_Mesh"], []))
        self.assertEqual(self.names({"feature": "f-tee", "kind": "any"})[0],
                         ["Spline_hole_18_1_B_Semi_Tee_-_Blend", "Spline_hole_18_1_Tee_-_Mesh"])
        # split pieces share the feature
        self.assertEqual(len(self.names({"feature": "f-rough"})[0]), 2)
        # a merged road answers to any of its features
        self.assertEqual(self.names({"feature": "f-b"})[0], ["Spline_roads_1_Concrete_-_Mesh"])

    def test_by_type_hole(self):
        self.assertEqual(self.names({"type": "bunker"})[0], ["Spline_hole_18_2_Bunker_-_Mesh"])
        self.assertEqual(len(self.names({"hole": 18})[0]), 2)
        self.assertEqual(self.names({"type": ["tee", "path"], "kind": "blend"})[0],
                         ["Spline_hole_18_1_B_Semi_Tee_-_Blend", "Spline_roads_1_hole0_B_Concrete_-_Blend"])

    def test_unresolved(self):
        names, problems = self.names({"feature": ["f-tee", "nope"]})
        self.assertEqual(names, ["Spline_hole_18_1_Tee_-_Mesh"])
        self.assertEqual(len(problems), 1)
        self.assertIn("nope", problems[0])
        self.assertEqual(self.names({"type": "green"}), ([], ["selector matched no objects"]))

    def test_unmapped_outer(self):
        outer = [r for r in self.index if r["name"].startswith("Spline_Outer")][0]
        self.assertIsNone(outer["svgId"])

    def test_by_shape(self):
        """golfmap.split_surfaces picks merged roads by their SVG id: every object OPCD built from it."""
        self.assertEqual(self.names({"shape": "roads_1", "kind": "any"})[0],
                         ["Spline_roads_1_Concrete_-_Mesh", "Spline_roads_1_hole0_B_Concrete_-_Blend"])
        names, problems = self.names({"shape": ["roads_1", "roads_9"]})
        self.assertEqual((names, problems), (["Spline_roads_1_Concrete_-_Mesh"], ["shape 'roads_9' has no mesh object"]))

    def test_group_by_feature(self):
        recs, _ = sl.select({"hole": 18, "kind": "any"}, self.index)
        self.assertEqual([g for g, _ in sl.group_by_feature(recs)], ["hole_18_1", "hole_18_2"])


class LayerTest(unittest.TestCase):
    def write(self, files):
        d = tempfile.mkdtemp()
        for name, data in files.items():
            with open(os.path.join(d, name), "w", encoding="utf-8") as f:
                f.write(data if isinstance(data, str) else json.dumps(data))
        return d

    def test_order_and_filter(self):
        ok = layer([{"id": "t", "op": "afrod.flattentees", "select": {"type": "tee"}}])
        d = self.write({"10-b.json": layer([], "b"), "05-a.json": ok, "README.md": "x", "notes.json": "{}"})
        self.assertEqual([os.path.basename(p) for p, _ in sl.load_layers(d)], ["05-a.json", "10-b.json"])

    def test_validation_errors(self):
        bad = layer([
            {"id": "x", "op": "afrod.nope", "select": {"type": "tee"}},
            {"id": "y", "op": "afrod.flattentees", "select": {"typ": "tee"}, "params": {"tees_flat_inset": 1.5}},
            {"id": "z", "op": "afrod.recipe", "select": {"feature": "f"}},
            {"id": "w", "op": "golfmap.flatten_footprint", "footprint3006": [[1, 2], [3, 4]], "level": "max"},
            {"id": "w", "op": "afrod.smoothcartpaths", "select": {"type": "path", "kind": "both"}, "seed": "1"},
            {"id": "v", "op": "golfmap.flatten_footprint", "footprint3006": [[0, 0], [1, 0], [1, 1]], "protect": "green"},
        ])
        d = self.write({"05-bad.json": bad})
        with self.assertRaises(sl.LayerError) as e:
            sl.load_layers(d)
        msg = str(e.exception)
        for part in ("unknown op 'afrod.nope'", "unknown select key 'typ'", "tees_flat_inset' must be int",
                     "missing 'recipe'", "footprint3006", "level must be", "repeats", "select.kind", "seed must be", "protect must be"):
            self.assertIn(part, msg)

    def test_valid_plan_example(self):
        ok = layer([
            {"id": "tees", "op": "afrod.flattentees", "select": {"type": "tee"},
             "params": {"tees_flat_inset": 1, "tees_flat_outset": 3.0}},
            {"id": "paths-cut", "op": "afrod.cutcartpaths", "select": {"type": "path"}},
            {"id": "paths-smooth", "op": "afrod.smoothcartpaths", "select": {"type": "path"},
             "params": {"smooth_path_distance": 3.0, "smooth_path_amt": 20}},
            {"id": "pad", "op": "golfmap.flatten_footprint", "footprint3006": [[530100.5, 6487700.2], [530112.0, 6487701.0], [530111.2, 6487690.4]],
             "level": "median", "falloffM": 3.0},
            {"id": "bunker-1c", "op": "afrod.recipe", "select": {"feature": "abc"}, "recipe": "x.json", "seed": 28},
        ])
        self.assertEqual(sl.validate_layer(ok), [])

    def test_cut_out_validation(self):
        ring = [[530110.1, 6487074.8], [530112.0, 6487075.2], [530111.3, 6487067.2]]
        ok = layer([{"id": "hall", "op": "golfmap.cut_out", "name": "hall_h11_north", "outline3006": ring,
                     "surface": "Rock", "sliverM": 0.05, "weld": True, "protect": ["green"]}])
        self.assertEqual(sl.validate_layer(ok), [])
        bad = layer([
            {"id": "a", "op": "golfmap.cut_out", "name": "Hall North", "outline3006": ring[:2], "weld": "yes"},
            {"id": "b", "op": "golfmap.cut_out", "name": "rough_rock", "outline3006": ring, "surface": "rock"},
            {"id": "c", "op": "golfmap.cut_out", "name": "hall", "outline3006": ring, "select": {"type": "rough"}},
            {"id": "d", "op": "golfmap.cut_out", "outline3006": ring},
        ])
        msg = "\n".join(sl.validate_layer(bad))
        for part in ("name must be lower-case", "outline3006 must be", "weld must be", "golf surface word",
                     "surface must be one capitalised word", "takes no select", "missing 'name'"):
            self.assertIn(part, msg)

    def test_cut_out_creek_bed_surface(self):
        # the creek bed is the one cut-out whose surface may carry a golf word (Unity classes it Water)
        ring = [[477667.0, 6457205.0], [477669.0, 6457205.0], [477668.0, 6457225.0]]
        ok = layer([{"id": "brook", "op": "golfmap.cut_out", "name": "brook_h17", "outline3006": ring,
                     "surface": "WaterBrook", "rise": {"mode": "dem", "apronM": 1.0, "maxEdgeM": 0.2, "sharpen": 0.0}}])
        self.assertEqual(sl.validate_layer(ok), [])
        bad = layer([{"id": "x", "op": "golfmap.cut_out", "name": "water_brook", "outline3006": ring, "surface": "WaterBrook"},
                     {"id": "y", "op": "golfmap.cut_out", "name": "brook", "outline3006": ring, "surface": "WaterFall"}])
        self.assertEqual(len([e for e in sl.validate_layer(bad) if "golf surface word" in e]), 2)

    def test_split_surfaces_validation(self):
        ok = layer([{"id": "paths-surfaces", "op": "golfmap.split_surfaces", "select": {"shape": ["roads_124"]},
                     "fadeM": 0.5, "minPartM2": 1, "junctionTie": 0.15, "slitM": 0.8, "sliverM": 0.05, "weld": True,
                     "paths": "vreta-paths.json"}])
        self.assertEqual(sl.validate_layer(ok), [])
        bad = layer([{"id": "s", "op": "golfmap.split_surfaces", "select": {"shape": "roads_124"}, "fadeM": -1,
                      "junctionTie": 1.5, "weld": "yes", "colour": 1}])
        errors = " ".join(sl.validate_layer(bad))
        for want in ("fadeM must be", "junctionTie must be", "weld must be", "unknown key 'colour'"):
            self.assertIn(want, errors)

    def test_recipe_validation(self):
        self.assertEqual(sl.validate_recipe([{"loopcut": {"loopcut_inset": 0}}, {"meshblendjoin": {}}]), [])
        self.assertEqual(len(sl.validate_recipe([{"loopcut": {}, "x": {}}, {"frobnicate": {}}])), 2)
        conway = "D:/gspro/afrod-recipes/cesimgolf-Conway_Bunker_Standard.json"
        if os.path.isfile(conway):
            with open(conway, encoding="utf-8") as f:
                self.assertEqual(sl.validate_recipe(json.load(f)), [])

    def test_recipe_op_overrides_and_library_ids(self):
        op = {"id": "b", "op": "afrod.recipe", "select": {"feature": "f"}, "recipe": "cesimgolf-conway",
              "overrides": {"bunker_lip_depth": 0.2, "bunkerlip_type": "Concave", "v": [1, 2]}}
        self.assertEqual(sl.validate_op(op), [])
        self.assertTrue(sl.validate_op(dict(op, overrides={"x": {}})))
        self.assertTrue(sl.validate_op(dict(op, overrides=[1])))
        self.assertTrue(sl.validate_op(dict(op, recipe="")))

    def test_find_recipe_library_id(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "blender", "recipes"))
            with open(os.path.join(root, "blender", "recipes", "library.json"), "w", encoding="utf-8") as f:
                json.dump({"recipes": [{"id": "mine", "file": "my.json"}]}, f)
            with open(os.path.join(root, "blender", "recipes", "my.json"), "w", encoding="utf-8") as f:
                f.write("[]")
            dirs = [os.path.join(root, "nowhere"), os.path.join(root, "blender", "recipes")]
            self.assertEqual(sl.find_recipe("mine", dirs, root), os.path.normpath(os.path.join(root, "blender", "recipes", "my.json")))
            self.assertIsNone(sl.find_recipe("other", dirs, root))
            self.assertIsNone(sl.find_recipe("mine", dirs))


class FootprintTest(unittest.TestCase):
    SQUARE = [(0, 0), (10, 0), (10, 10), (0, 10)]

    def test_point_and_distance(self):
        self.assertTrue(sl.point_in_polygon(5, 5, self.SQUARE))
        self.assertFalse(sl.point_in_polygon(11, 5, self.SQUARE))
        self.assertAlmostEqual(sl.distance_to_polygon(12, 5, self.SQUARE), 2.0)
        self.assertAlmostEqual(sl.distance_to_polygon(5, 5, self.SQUARE), 5.0)
        self.assertEqual(sl.bbox_distance((0, 0, 1, 1), (4, 5, 6, 6)), 5.0)
        self.assertEqual(sl.bbox_distance((0, 0, 1, 1), (0.5, 0.5, 2, 2)), 0.0)

    def test_levels(self):
        pts = [(0, 0, 1.0), (1, 0, 2.0), (0, 1, 4.0), (1, 1, 9.0)]
        self.assertEqual(sl.fit_level(pts, "median")(0, 0), 3.0)
        self.assertEqual(sl.fit_level(pts, "mean")(0, 0), 4.0)
        self.assertEqual(sl.fit_level(pts, "min")(0, 0), 1.0)
        plane = sl.fit_level([(x, y, 2 * x - y + 5) for x in range(3) for y in range(3)], "plane")
        self.assertAlmostEqual(plane(10, 4), 21.0)
        with self.assertRaises(ValueError):
            sl.fit_level([], "median")

    def test_moves(self):
        verts = [("in1", 2, 2, 1.0), ("in2", 8, 8, 3.0), ("in3", 5, 5, 2.5),
                 ("near", 11.5, 5, 10.0), ("edge", 10 + 3, 5, 10.0), ("far", 20, 5, 10.0)]
        moves, n_in = sl.footprint_moves(verts, self.SQUARE, "median", falloff=3.0)
        self.assertEqual(n_in, 3)
        self.assertEqual(moves["in1"], 2.5)
        self.assertNotIn("in3", moves)  # already at the level
        self.assertAlmostEqual(moves["near"], 10.0 + (2.5 - 10.0) * sl.smooth_falloff(0.5))
        self.assertNotIn("edge", moves)  # t = 1: weight 0
        self.assertNotIn("far", moves)
        # coincident vertices (a welded seam) get the same height
        m2, _ = sl.footprint_moves(verts + [("near-twin", 11.5, 5, 10.0)], self.SQUARE, "median", falloff=3.0)
        self.assertEqual(m2["near"], m2["near-twin"])

    def test_protect_guard(self):
        # a protected (green) vertex at (12, 5): weights fade to 0 towards it over a 2 m band
        green = [(12.0, 5.0)]
        guard = lambda x, y: min(((x - gx) ** 2 + (y - gy) ** 2) ** 0.5 for gx, gy in green)
        verts = [("in1", 2, 2, 1.0), ("in2", 8, 8, 3.0), ("in3", 5, 5, 2.5), ("at-green", 12.0, 5.0, 10.0),
                 ("near", 11.5, 5, 10.0), ("far", 20, 5, 10.0)]
        moves, _ = sl.footprint_moves(verts, self.SQUARE, "median", falloff=3.0, guard=guard, band=2.0)
        self.assertNotIn("at-green", moves)  # weight 0 at the protected vertex
        w_near = sl.smooth_falloff(0.5) * (1 - sl.smooth_falloff(0.25))
        self.assertAlmostEqual(moves["near"], 10.0 + (2.5 - 10.0) * w_near)
        self.assertNotIn("far", moves)
        self.assertEqual(moves["in1"], 2.5)

    def test_nearest_hole(self):
        p = sl.parse_svg(SVG)
        self.assertEqual(sl.nearest_hole(51, 51, p)[0], 18)
        self.assertEqual(sl.nearest_hole(5, 5, p)[0], 18)  # others_1 has no hole


class PathEdgeFadeLayerTest(unittest.TestCase):
    def test_the_op_and_its_keys_validate(self):
        ok = layer([{"id": "fade", "op": "golfmap.path_edge_fade", "select": {"type": "path"},
                     "widthM": 0.6, "maxEdgeM": 0.2, "amplitude": 0.4, "surfaces": ["gravel", "dirt"], "weld": True}])
        self.assertEqual(sl.validate_layer(ok), [])

    def test_it_needs_a_select_and_rejects_bad_values_and_keys(self):
        errs = sl.validate_layer(layer([{"id": "fade", "op": "golfmap.path_edge_fade"}]))
        self.assertTrue(any("select" in e for e in errs), errs)
        bad = layer([{"id": "fade", "op": "golfmap.path_edge_fade", "select": {"type": "path"},
                      "widthM": -1, "maxEdgeM": 0.01, "surfaces": [], "colour": "red"}])
        errs = sl.validate_layer(bad)
        for want in ("widthM must be", "maxEdgeM must be", "surfaces must be", "unknown key 'colour'"):
            self.assertTrue(any(want in e for e in errs), (want, errs))


if __name__ == "__main__":
    unittest.main()
