"""Tests for shape_recipes.py (recipe formats, steps, parameters) and the recipe library's params. Plain Python:

    python blender/tools/shape_recipes_test.py
"""

import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import shape_paint  # noqa: E402
import shape_recipes as sr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))


def v1(*steps):
    return {"format": sr.FORMAT, "steps": list(steps)}


class ParseTest(unittest.TestCase):
    def test_afrod_list(self):
        r = sr.parse_recipe([{"meshblendjoin": {}}, {"bunkereditlip": {"bunker_lip_depth": 0.02, "bunker_dig_inset": 2}}])
        self.assertEqual(r["format"], sr.AFROD)
        self.assertEqual([s["op"] for s in r["steps"]], ["afrod.meshblendjoin", "afrod.bunkereditlip"])
        self.assertEqual(r["steps"][1]["params"]["bunker_dig_inset"], 2)
        self.assertEqual(r["problems"], [])
        self.assertEqual(sr.afrod_items(r["steps"]), [{"meshblendjoin": {}}, {"bunkereditlip": {"bunker_lip_depth": 0.02, "bunker_dig_inset": 2}}])

    def test_afrod_list_problems(self):
        r = sr.parse_recipe([{"nosuch": {}}, {"a": {}, "b": {}}, {"loopcut": 3}])
        self.assertTrue(any("unknown Afrod command 'nosuch'" in p for p in r["problems"]))
        self.assertTrue(any("one command" in p for p in r["problems"]))
        self.assertTrue(any("arguments must be an object" in p for p in r["problems"]))

    def test_golfmap_v1(self):
        r = sr.parse_recipe(v1({"op": "bunkerstudio.shape", "tag": "dig", "params": {"preset": "LINKS", "depth": 0.5}},
                               {"op": "afrod.meshblendjoin"},
                               {"op": "afrod.loopcut", "ringsFromSeam": True, "params": {"loopcut_inset": 0}},
                               {"op": "golfmap.paint_map", "params": {"map": {"mesh": {"red": "dirt"}}}}))
        self.assertEqual(r["format"], sr.FORMAT)
        self.assertEqual(r["problems"], [])
        self.assertEqual(r["steps"][0]["tag"], "dig")
        self.assertEqual(r["steps"][1]["params"], {})
        self.assertTrue(r["steps"][2]["ringsFromSeam"])

    def test_edge_jitter_step(self):
        ok = sr.parse_recipe(v1({"op": "golfmap.paint_map", "params": {"map": {}}},
                                {"op": "golfmap.edge_jitter", "params": {"amount": 0.4, "kinds": ["mesh", "blend"]}}))
        self.assertEqual(ok["problems"], [])
        self.assertEqual(sr.jitter_params({})["amount"], 0.5)
        for bad, word in (({"amount": 2}, "amount"), ({"kinds": ["rough"]}, "kinds"), ({"seed": 1.5}, "seed"),
                          ({"wobble": 1}, "wobble")):
            text = " ".join(sr.parse_recipe(v1({"op": "golfmap.edge_jitter", "params": bad}))["problems"])
            self.assertIn(word, text)
        early = sr.parse_recipe(v1({"op": "golfmap.edge_jitter"}, {"op": "afrod.meshblendjoin"}))
        self.assertIn("come last", " ".join(early["problems"]))

    def test_bad_roots(self):
        self.assertTrue(sr.parse_recipe({"format": "x"})["problems"])
        self.assertTrue(sr.parse_recipe({"format": sr.FORMAT, "steps": []})["problems"])
        self.assertTrue(sr.parse_recipe("steps")["problems"])

    def test_unknown_ops_and_keys(self):
        r = sr.parse_recipe(v1({"op": "blender.sculpt"}, {"op": "afrod.loopcut", "extra": 1}, {"op": "nodot"}))
        text = " ".join(r["problems"])
        self.assertIn("unknown op 'blender.sculpt'", text)
        self.assertIn("unknown key(s) extra", text)
        self.assertIn("'<toolset>.<name>'", text)

    def test_studio_after_topology_is_an_error(self):
        r = sr.parse_recipe(v1({"op": "afrod.meshblendjoin"}, {"op": "bunkerstudio.shape"}))
        self.assertTrue(any("studio steps must come before any Afrod topology step" in p for p in r["problems"]))
        # reshape-only Afrod steps before a studio step are allowed
        r = sr.parse_recipe(v1({"op": "afrod.zshiftloop", "params": {"z_shift": 0.01, "inset": 1}}, {"op": "bunkerstudio.shape"}))
        self.assertEqual(r["problems"], [])

    def test_one_studio_step(self):
        r = sr.parse_recipe(v1({"op": "bunkerstudio.shape"}, {"op": "shorelinestudio.shape", "params": {"preset": "NATURAL_POND"}}))
        self.assertTrue(any("at most one studio step" in p for p in r["problems"]))

    def test_studio_fields(self):
        r = sr.parse_recipe(v1({"op": "bunkerstudio.shape", "params": {"preset": "HUGE", "depth": 5, "colour": 1,
                                                                        "highSide": "north"}}))
        text = " ".join(r["problems"])
        self.assertIn("preset must be one of", text)
        self.assertIn("depth must be within", text)
        self.assertIn("unknown field 'colour'", text)
        self.assertIn("highSide must be", text)
        self.assertEqual(sr.parse_recipe(v1({"op": "bunkerstudio.shape", "params": {"highSide": 135}}))["problems"], [])
        r = sr.parse_recipe(v1({"op": "shorelinestudio.shape", "params": {"depth": 1}}))
        self.assertTrue(any("preset is required" in p for p in r["problems"]))

    def test_tags(self):
        r = sr.parse_recipe(v1({"op": "afrod.loopcut", "tag": "a"}, {"op": "afrod.loopcut", "tag": "a"}, {"op": "afrod.loopcut", "tag": "x.y"}))
        text = " ".join(r["problems"])
        self.assertIn("tag 'a' repeats", text)
        self.assertIn("without dots", text)

    def test_colour_values(self):
        r = sr.parse_recipe([{"fillvertexpaint": {"vertex_paint_type": "purple"}}])
        self.assertTrue(any("vertex_paint_type must be one of" in p for p in r["problems"]))


DECL = [
    {"id": "depth", "min": 0.2, "max": 1.2, "default": 0.45,
     "maps": [{"step": "bunkerstudio.shape", "field": "depth", "mode": "set"}]},
    {"id": "lipHeight", "min": 0, "max": 2, "default": 1,
     "maps": [{"step": "bunkereditlip", "field": "bunker_lip_depth", "mode": "scale"}]},
    {"id": "rag", "min": 0, "max": 2, "default": 1,
     "maps": [{"step": "slides", "field": "loopslide_random", "mode": "scale"}]},
    {"id": "steep", "min": 0.5, "max": 2, "default": 1,
     "maps": [{"step": "bunkerstudio.shape", "field": "faceSteepness", "mode": "scale"}]},
]
STEPS = sr.parse_recipe(v1(
    {"op": "bunkerstudio.shape", "params": {"preset": "CLASSIC"}},
    {"op": "afrod.bunkereditlip", "params": {"bunker_lip_depth": 0.02, "bunker_dig_inset": 2}},
    {"op": "afrod.randomslideloop", "tag": "slides", "params": {"loopslide_inset": 3, "loopslide_random": 0.3}},
    {"op": "afrod.bunkereditlip", "params": {"bunker_lip_depth": -0.01, "bunker_dig_inset": 5}},
))["steps"]


class ParamsTest(unittest.TestCase):
    def test_validate(self):
        self.assertEqual(sr.validate_params(DECL), [])
        bad = [{"id": "seed", "min": 0, "max": 1, "default": 0, "maps": [{"step": "a", "field": "b"}]},
               {"id": "x", "min": 2, "max": 1, "default": 0, "maps": []},
               {"id": "y", "min": 0, "max": 1, "default": 3, "maps": [{"step": "a", "field": "b", "mode": "add"}]},
               {"id": "y", "min": 0, "max": 1, "default": 0, "step": 0, "maps": [{"step": "a"}]}]
        text = " ".join(sr.validate_params(bad))
        for want in ("other than 'seed'", "min < max", "default must be within", "mode must be set or scale", "repeats",
                     "step must be > 0", "needs step and field", "maps must be a non-empty list"):
            self.assertIn(want, text)

    def test_defaults(self):
        values, seed, other, warnings = sr.resolve_overrides(DECL, None)
        self.assertEqual(values, {"depth": 0.45, "lipHeight": 1, "rag": 1, "steep": 1})
        self.assertIsNone(seed)
        self.assertEqual(other, {})
        self.assertEqual(warnings, [])

    def test_overrides_seed_clamp_and_other(self):
        values, seed, other, warnings = sr.resolve_overrides(DECL, {"depth": 0.8, "lipHeight": 5, "seed": 7,
                                                                    "bunker_dig_depth": 0.4})
        self.assertEqual(values["depth"], 0.8)
        self.assertEqual(values["lipHeight"], 2)
        self.assertEqual(values["rag"], 1)
        self.assertEqual(seed, 7)
        self.assertEqual(other, {"bunker_dig_depth": 0.4})
        self.assertTrue(any("clamped" in w for w in warnings))
        with self.assertRaises(sr.RecipeError):
            sr.resolve_overrides(DECL, {"seed": 1.5})
        with self.assertRaises(sr.RecipeError):
            sr.resolve_overrides(DECL, {"depth": "deep"})

    def test_apply_set_and_scale(self):
        values, _, _, _ = sr.resolve_overrides(DECL, {"depth": 0.6, "lipHeight": 1.5, "rag": 2, "steep": 1.25})
        steps, applied = sr.apply_params(STEPS, DECL, values)
        self.assertEqual(steps[0]["params"]["depth"], 0.6)
        self.assertAlmostEqual(steps[1]["params"]["bunker_lip_depth"], 0.03)
        self.assertAlmostEqual(steps[3]["params"]["bunker_lip_depth"], -0.015)  # every matching step
        self.assertAlmostEqual(steps[2]["params"]["loopslide_random"], 0.6)  # by tag
        self.assertAlmostEqual(steps[0]["params"]["faceSteepness"], 1.25)  # scale of the studio field's default 1.0
        self.assertEqual(STEPS[1]["params"]["bunker_lip_depth"], 0.02)  # input untouched
        self.assertEqual(len(applied), 5)
        self.assertEqual({a["mode"] for a in applied}, {"set", "scale"})

    def test_map_by_full_op_name(self):
        decl = [{"id": "d", "min": 0, "max": 1, "default": 0.5, "maps": [{"step": "afrod.bunkereditlip", "field": "bunker_dig_inset", "mode": "set"}]}]
        steps, _ = sr.apply_params(STEPS, decl, {"d": 0.5})
        self.assertEqual(steps[1]["params"]["bunker_dig_inset"], 0.5)

    def test_set_keeps_integers(self):
        decl = [{"id": "inset", "min": 1, "max": 9, "default": 3, "maps": [{"step": "slides", "field": "loopslide_inset", "mode": "set"}]}]
        steps, _ = sr.apply_params(STEPS, decl, {"inset": 4.0})
        self.assertIsInstance(steps[2]["params"]["loopslide_inset"], int)

    def test_map_errors(self):
        decl = [{"id": "x", "min": 0, "max": 1, "default": 1, "maps": [{"step": "nosuch", "field": "a"}]}]
        with self.assertRaises(sr.RecipeError):
            sr.apply_params(STEPS, decl, {"x": 1})
        decl = [{"id": "x", "min": 0, "max": 1, "default": 1, "maps": [{"step": "slides", "field": "missing", "mode": "scale"}]}]
        with self.assertRaises(sr.RecipeError):
            sr.apply_params(STEPS, decl, {"x": 1})

    def test_step_matches(self):
        s = {"op": "afrod.loopcut", "tag": "cut1"}
        self.assertTrue(sr.step_matches(s, "afrod.loopcut"))
        self.assertTrue(sr.step_matches(s, "loopcut"))
        self.assertTrue(sr.step_matches(s, "cut1"))
        self.assertFalse(sr.step_matches({"op": "bunkerstudio.shape"}, "shape"))


class PaintAndRingsTest(unittest.TestCase):
    def setUp(self):
        self.lib = shape_paint.load_library()
        self.role = lambda t, k: shape_paint.role_weights(t, k, self.lib)

    def test_translate_ce_simgolf_colours(self):
        m = {"red": "grassLip", "black": "shadow", "green": "floor", "blue": "floor"}
        ch = sr.colour_channels(m, "mesh", self.role)
        self.assertEqual(ch, {"red": "red", "green": "blue", "blue": "blue", "black": "black"})
        p, changed = sr.translate_colours({"vertex_paint_type": "green", "paint_strength": 1.0}, ch)
        self.assertEqual(p["vertex_paint_type"], "blue")
        self.assertEqual(changed, [("vertex_paint_type", "green", "blue")])
        p, changed = sr.translate_colours({"vertex_paint_type": "red"}, ch)
        self.assertEqual(changed, [])

    def test_split_map_refused(self):
        ch = sr.colour_channels({"red": {"grassLip": 0.5, "dirt": 0.5}}, "mesh", self.role)
        self.assertIsNone(ch["red"])
        with self.assertRaises(sr.RecipeError):
            sr.translate_colours({"vertex_paint_type": "red"}, ch)

    def test_shift_insets(self):
        p = sr.shift_insets({"loopcut_inset": 0, "bunker_dig_inset": 2, "bunker_lip_depth": 0.02, "flag": True}, 3)
        self.assertEqual(p, {"loopcut_inset": 3, "bunker_dig_inset": 5, "bunker_lip_depth": 0.02, "flag": True})
        self.assertEqual(sr.shift_insets({"inset": 1}, 0), {"inset": 1})


class HighSideTest(unittest.TestCase):
    def test_index_faces_target(self):
        pts = [(math.cos(a), math.sin(a)) for a in [i * math.pi / 8 for i in range(16)]]
        self.assertEqual(sr.high_side_index(pts, (0, 0), (10, 0)), 0)
        self.assertEqual(sr.high_side_index(pts, (0, 0), (0, 10)), 4)
        self.assertIsNone(sr.high_side_index(pts, (0, 0), (0, 0)))

    def test_bearing(self):
        x, y = sr.bearing_vector_blend(90)  # east in EPSG:3006 is -x in the .blend
        self.assertAlmostEqual(x, -1)
        self.assertAlmostEqual(y, 0, places=9)
        x, y = sr.bearing_vector_blend(0)  # north is -y
        self.assertAlmostEqual(y, -1)
        self.assertEqual(sr.studio_high_side_bearing(450), 90.0)
        self.assertIsNone(sr.studio_high_side_bearing("green"))

    def test_style_values(self):
        base = {"normal_face_width": 0.45, "high_face_width": 0.22, "entry_face_width": 1.0, "crown_raise": 0.035, "floor_flatten": 0.0}
        ranges = {"high_face_width": (0.08, 1.0), "crown_raise": (0.0, 0.25), "floor_flatten": (0.0, 1.0)}
        v = sr.bunker_style_values(base, 1.5, 1.0, ranges)
        self.assertAlmostEqual(v["normal_face_width"], 0.3)
        self.assertAlmostEqual(v["entry_face_width"], 1.0 / 1.5)
        v = sr.bunker_style_values(base, 1.0, 2.0, ranges)
        self.assertAlmostEqual(v["crown_raise"], 0.07)
        self.assertGreater(v["high_face_width"], 0.08)  # clamped just inside (float32 props)
        self.assertLess(v["high_face_width"], 0.0801)
        self.assertEqual(v["floor_flatten"], 0.0)  # in range: untouched
        self.assertEqual(sr.bunker_style_values(base), dict(base))


class LibraryTest(unittest.TestCase):
    """Every library entry with params: its recipe file (when present on this machine) parses and every map matches."""

    def test_params_map_onto_their_recipes(self):
        lib = shape_paint.load_library()
        checked = 0
        for e in lib["recipes"]:
            path = shape_paint.recipe_path(e)
            if not e.get("params"):
                continue
            self.assertEqual(sr.validate_params(e["params"]), [], e["id"])
            if path is None:
                continue  # third-party file not on this machine
            r = sr.load_recipe(path)
            self.assertEqual(r["problems"], [], e["id"])
            values, _, _, _ = sr.resolve_overrides(e["params"], {})
            sr.apply_params(r["steps"], e["params"], values)
            maxed = {p["id"]: p["max"] for p in e["params"]}
            sr.apply_params(r["steps"], e["params"], maxed)
            checked += 1
        self.assertGreaterEqual(checked, 5)

    def test_composites(self):
        lib = shape_paint.load_library()
        ids = {e["id"]: e for e in lib["recipes"]}
        for rid in ("golfmap-bunker-studio-conway", "golfmap-creek-shoreline-meadow-brook",
                    "golfmap-creek-shoreline-maintained-drain", "golfmap-lake-shoreline-overhang"):
            e = ids[rid]
            r = sr.load_recipe(os.path.join(REPO, "blender", "recipes", e["file"]))
            self.assertEqual(r["format"], sr.FORMAT, rid)
            self.assertTrue(sr.is_studio(r["steps"][0]["op"]), rid)
            for s in r["steps"]:  # every Afrod paint colour translates to one golfmap channel
                if sr.step_source(s["op"]) == sr.AFROD:
                    m = shape_paint.step_paint_map(e, s, lib)["mesh"]
                    sr.translate_colours(s["params"], sr.colour_channels(m, "mesh", lambda t, k: shape_paint.role_weights(t, k, lib)))
        self.assertIn("bunkerstudio.shape", lib["studioPaint"])
        self.assertIn("shorelinestudio.shape", lib["studioPaint"])
        with open(os.path.join(REPO, "blender", "recipes", "library.json"), encoding="utf-8") as f:
            json.load(f)


if __name__ == "__main__":
    unittest.main()
