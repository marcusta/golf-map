"""Tests for shape_paintrules.py (plain Python + numpy): python blender/tools/shape_paintrules_test.py

Synthetic meshes and hand-computed weights for every kind, both modes, and the export file readers."""
import base64
import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_paintrules as pr  # noqa: E402

RED = (1.0, 0.0, 0.0, 1.0)
FRAME = {"e0": 1000.0, "n0": 5000.0, "sideM": 100.0, "minM": 0.0, "px": 0.0, "py": 0.0, "pz": 0.0}


def grid_mesh(nx, ny, step=1.0, z=0.0):
    """A flat (nx x ny)-vertex grid of quads: world (N, 3) and the corner arrays Blender keeps."""
    xs, ys = np.meshgrid(np.arange(nx) * step, np.arange(ny) * step, indexing="xy")
    world = np.column_stack([xs.ravel(), ys.ravel(), np.full(nx * ny, z)])
    loops = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            loops += [a, a + 1, a + 1 + nx, a + nx]
    nf = (nx - 1) * (ny - 1)
    return world, np.array(loops), np.arange(nf) * 4, np.full(nf, 4)


class ChannelTest(unittest.TestCase):
    def test_replace_lerps_toward_the_channel_and_keeps_alpha(self):
        c = np.array([[1.0, 0.0, 0.0, 0.5], [0.2, 0.4, 0.2, 1.0]])
        out = pr.apply_channel(c, [0.5, 0.25], "black")
        np.testing.assert_allclose(out, [[0.5, 0, 0, 0.5], [0.15, 0.3, 0.15, 1.0]])
        out = pr.apply_channel(c, [1.0, 1.0], "blue")
        np.testing.assert_allclose(out, [[0, 0, 1, 0.5], [0, 0, 1, 1.0]])

    def test_overlay_raises_one_component(self):
        c = np.array([[1.0, 0.0, 0.0, 1.0], [0.2, 0.4, 0.2, 1.0]])
        out = pr.apply_channel(c, [0.5, 0.5], "blue", "overlay")
        np.testing.assert_allclose(out, [[1, 0, 0.5, 1], [0.2, 0.4, 0.6, 1]])

    def test_tiny_weights_paint_nothing(self):
        c = np.array([RED, RED])
        out = pr.apply_channel(c, [0.001, 0.0011], "black")
        np.testing.assert_allclose(out[0], RED)
        self.assertLess(out[1, 0], 1.0)
        out = pr.apply_channel(c, [0.0005, 0.0], "black", min_weight=0.0)
        self.assertLess(out[0, 0], 1.0)
        np.testing.assert_allclose(out[1], RED)


class GeometryTest(unittest.TestCase):
    def test_classify_like_unity(self):
        self.assertEqual(pr.classify("Spline_hole_1_3_Rough_-_Mesh"), "Rough")
        self.assertEqual(pr.classify("Spline_hole_1_3_Deep_Rough_-_Mesh"), "Deep")
        self.assertEqual(pr.classify("Spline_hole_1_3_Rough_B_Fairway_-_Blend"), "Blend")
        self.assertEqual(pr.classify("Spline_others_15_0_Water_Base_Lake_-_Mesh"), "Water")
        self.assertEqual(pr.classify("Spline_klippa_Rock_-_Mesh"), "Slab")
        self.assertEqual(pr.classify("Spline_Outer_0_Deep_-_Mesh"), "Deep")
        self.assertTrue(pr.is_course_mesh("Spline_hole_1_3_Rough_-_Mesh"))
        self.assertFalse(pr.is_course_mesh("RAM road path_38"))
        self.assertFalse(pr.is_course_mesh("Spline_x_WaterPlane"))

    def test_point_index_is_the_brute_force_nearest_within_r(self):
        rng = np.random.default_rng(3)
        pts = rng.uniform(0, 30, (500, 2))
        q = rng.uniform(-2, 32, (2000, 2))
        d, i = pr.PointIndex(pts, 1.7).nearest(q, 1.7)
        full = np.sqrt(((q[:, None] - pts[None]) ** 2).sum(axis=2))
        bd = full.min(axis=1)
        within = bd <= 1.7
        np.testing.assert_allclose(d[within], bd[within])
        self.assertTrue(np.isinf(d[~within]).all())
        self.assertTrue((i[~within] == -1).all())
        np.testing.assert_allclose(full[np.arange(len(q))[within], i[within]], bd[within])

    def test_boundary_points_weld_split_vertices(self):
        world, loops, start, total = grid_mesh(3, 3)
        b = pr.boundary_points(world, loops, start, total)
        self.assertEqual(len(b), 8)
        self.assertFalse(((b[:, 0] == 1) & (b[:, 1] == 1)).any())
        # the centre vertex split in two (a UV seam): still welded, still inside
        world2 = np.vstack([world, world[4]])
        loops2 = loops.copy()
        loops2[4 * 3:4 * 4][loops2[12:16] == 4] = 9
        b2 = pr.boundary_points(world2, loops2, start, total)
        self.assertEqual(len(b2), 8)

    def test_side_of(self):
        line = np.array([[0.0, 0.0], [0.0, 10.0]])
        s = pr.side_of(line, np.array([[-1.0, 5.0], [1.0, 5.0]]))
        self.assertGreater(s[0], 0)   # west of a line running north: left
        self.assertLess(s[1], 0)


class ObjectRuleTest(unittest.TestCase):
    def setUp(self):
        # border at x = 0 and x = 4 along y 0..4 (a strip), vertices across it
        ys = np.arange(0, 4.01, 0.25)
        self.border = np.vstack([np.column_stack([np.zeros_like(ys), ys, np.zeros_like(ys)]),
                                 np.column_stack([np.full_like(ys, 4.0), ys, np.zeros_like(ys)])])

    def test_fade_from_the_border(self):
        rule = pr.normalise({"kind": "object", "match": "_WaterBrook_-_Mesh", "fadeM": 0.5})
        xyz = np.array([[0.0, 2, 0], [0.25, 2, 0], [2.0, 2, 0]])
        w = pr.object_weights(xyz, self.border, rule)
        np.testing.assert_allclose(w, [0.0, 0.5, 1.0])
        out = pr.apply_channel(np.array([RED] * 3), w, rule["channel"])
        np.testing.assert_allclose(out[:, 0], [1.0, 0.5, 0.0])

    def test_below_by_depth_and_side(self):
        rule = pr.normalise({"kind": "object", "match": "x", "belowM": 0.1, "softM": 0.08, "reachM": 1.5})
        xyz = np.array([[1.0, 2, -0.1], [1.0, 2, -0.14], [1.0, 2, -0.3], [2.0, 2, -0.14]])
        np.testing.assert_allclose(pr.object_weights(xyz, self.border, rule), [0.0, 0.5, 1.0, 1.0])
        # a creek line along x = 2 running north: x < 2 is its left (grass 0.3 m deep), x > 2 its right (0.1)
        line = np.array([[2.0, -1.0], [2.0, 5.0]])
        xyz = np.array([[1.0, 2, -0.34], [3.0, 2, -0.14]])
        w = pr.object_weights(xyz, self.border, rule, line, 0.3, float("nan"))
        np.testing.assert_allclose(w, [0.5, 0.5])

    def test_shore_band(self):
        rule = pr.normalise({"kind": "object", "match": "Lake", "channel": "red", "shoreM": 0.6, "softM": 0.3,
                             "reachM": 4.0})
        xyz = np.array([[1.0, 2, -0.3], [1.0, 2, -0.75], [1.0, 2, -1.0], [2.0, 2, -0.1]])
        w = pr.object_weights(xyz, self.border, rule)
        np.testing.assert_allclose(w, [1.0, 0.5, 0.0, 1.0])
        c = np.array([[0.0, 0.0, 1.0, 1.0]] * 4)
        np.testing.assert_allclose(pr.apply_channel(c, w, "red")[:, :3], [[1, 0, 0], [0.5, 0, 0.5], [0, 0, 1], [1, 0, 0]])


class RoadRuleTest(unittest.TestCase):
    def test_band_and_fade(self):
        rule = pr.normalise({"kind": "road", "surfaces": ["rough", "Deep"], "channel": "black", "strength": 1,
                             "insetM": 0.4, "fadeM": 1.0})
        self.assertEqual(rule["surfaces"], ["Rough", "Deep"])
        s = pr.road_samples([(np.array([[0.0, 0.0], [10.0, 0.0]]), 4.0)])
        self.assertEqual(len(s), 41)
        self.assertAlmostEqual(pr.road_reach(s, rule), 2.6)
        # full out to 2 - 0.4 = 1.6, half way at 2.1, nothing from 2.6
        xy = np.array([[5.0, 1.0], [5.0, 1.6], [5.0, 2.1], [5.0, 2.6], [5.0, 3.0], [5.1, 0.0]])
        np.testing.assert_allclose(pr.road_weights(xy, s, rule), [1.0, 1.0, 0.5, 0.0, 0.0, 1.0])

    def test_samples_like_unity(self):
        s = pr.road_samples([(np.array([[0.0, 0.0], [0.6, 0.0], [0.6, 0.3]]), 3.0)])
        # 0.6 m -> 3 steps (0, .2, .4, .6), then 0.3 m -> 2 steps (.15, .3), no repeated corner
        np.testing.assert_allclose(s[:, 0], [0, 0.2, 0.4, 0.6, 0.6, 0.6])
        np.testing.assert_allclose(s[:, 1], [0, 0, 0, 0, 0.15, 0.3])
        self.assertTrue((s[:, 2] == 1.5).all())

    def test_ramroads_file_in_the_blend_frame(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x-inner-ramroads.json")
            with open(p, "w") as f:
                json.dump({"format": "unity-ramroads-v1", "plot": {"terrain": "inner"}, "roads": [
                    {"id": "path_1", "widthM": 3.5, "points": [[10, 20], [12, 20]]},
                    {"id": "", "widthM": 3, "points": [[0, 0], [1, 1]]},
                    {"id": "path_2", "points": [[5, 5]]}]}, f)
            roads = pr.load_roads(p)
        self.assertEqual(len(roads), 1)
        np.testing.assert_allclose(roads[0][0], [[-10, -20], [-12, -20]])
        self.assertEqual(roads[0][1], 3.5)


class EdgeRuleTest(unittest.TestCase):
    def test_full_coverage_paints_at_the_edge_and_nothing_past_width(self):
        rule = pr.normalise({"kind": "edge", "edge": "bunker", "channel": "blue", "mode": "overlay", "widthM": 2.0,
                             "strength": 0.8, "coverage": 1.0, "noiseM": 3.5, "seed": 1})
        edge = np.array([[0.0, y, 0.0] for y in np.arange(0, 10.01, 0.1)])
        xy = np.array([[0.0, 5.0], [2.5, 5.0], [0.3, 5.0]])
        w = pr.edge_weights(xy, edge, rule)
        self.assertAlmostEqual(w[0], 0.8)
        self.assertEqual(w[1], 0.0)
        off, off2, thr = pr.edge_noise(rule)
        self.assertEqual(thr, -np.inf)
        n2 = pr.perlin01(off2[0] - 0.3 * 2 / 3.5, off2[1] - 5.0 * 2 / 3.5)
        reach = 2.0 * (0.35 + 0.65 * min(1.0, max(0.0, (n2 - 0.2) / 0.6)))
        t = min(1.0, 0.3 / reach)
        self.assertAlmostEqual(w[2], 0.8 * (1 - t * t * (3 - 2 * t)) if 0.3 < reach else 0.0)
        out = pr.apply_channel(np.array([RED]), w[:1], "blue", "overlay")
        np.testing.assert_allclose(out, [[1.0, 0.0, 0.8, 1.0]])

    def test_coverage_share_and_determinism(self):
        rule = pr.normalise({"kind": "edge", "edge": "bunker", "widthM": 2.0, "coverage": 0.55, "seed": 7})
        edge = np.array([[0.0, y, 0.0] for y in np.arange(0, 400.01, 0.25)])
        xy = np.column_stack([np.zeros(1601), np.arange(0, 400.01, 0.25)])
        w = pr.edge_weights(xy, edge, rule)
        self.assertTrue(np.array_equal(w, pr.edge_weights(xy, edge, rule)))
        share = float((w > 0.5).mean())
        self.assertGreater(share, 0.3)
        self.assertLess(share, 0.8)
        none = pr.normalise(dict(rule, coverage=0.0, kind="edge", edge="bunker"))
        self.assertFalse(pr.edge_weights(xy, edge, none).any())


class LakeBedTest(unittest.TestCase):
    def plane(self):
        # 4 x 4 cells of 10 m from Unity (x, z) = (0, 0); distance = 10 m per column (stepM 1: data in metres)
        dist = np.tile(np.array([0, 10, 30, 60], dtype=np.uint8), 4)
        cliff = np.zeros(16, dtype=np.uint8)
        cliff[[0, 4, 8, 12]] = 255          # the first column is a cliff
        grid = {"x0": 0.0, "z0": 0.0, "cellM": 10.0, "stepM": 1.0, "width": 4, "height": 4}
        return {"surfaceY": 8.0, "grid": grid, "dist": dist, "cliff": cliff}

    def test_band_fade_cliff_and_bank(self):
        rule = pr.normalise({"kind": "lakebed", "bandM": 25, "fadeM": 20})
        p = self.plane()
        # Unity x = -blend x, z = -blend y. Cell centres at 5, 15, 25, 35.
        xyz = np.array([[-15, -15, 0], [-25, -15, 0], [-30, -15, 0], [-35, -15, 0], [-15, -15, 8.5],
                        [-10, -15, 0], [-100, -15, 0]])
        k = pr.lakebed_weights(xyz, p, rule)
        # 15: d 10 -> 1; 25: d 30 -> 1 - 5/20; 30: d 45 -> 0; 35: d 60 -> 0; bank; 10: d 5, cliff half -> 0.5; off grid
        np.testing.assert_allclose(k, [1.0, 0.75, 0.0, 0.0, 0.0, 0.5, 0.0])
        c = np.array([[0.0, 0.0, 0.0, 1.0]] * 7)
        out = pr.apply_channel(c, k, "red", min_weight=0.0)
        np.testing.assert_allclose(out[:2, 0], [1.0, 0.75])

    def test_mesh_choice(self):
        p = self.plane()
        name = "Spline_others_15_0_Water_Base_Lake_-_Mesh"
        self.assertTrue(pr.lake_mesh_selected(name, (-20, -20, 0), (-10, -10, 9), p))
        self.assertFalse(pr.lake_mesh_selected(name, (-20, -20, 8.5), (-10, -10, 9), p))   # all above the water
        self.assertFalse(pr.lake_mesh_selected(name, (10, 10, 0), (20, 20, 9), p))          # off the grid
        self.assertFalse(pr.lake_mesh_selected("Spline_hole_1_Rough_-_Mesh", (-20, -20, 0), (-10, -10, 9), p))

    def test_file(self):
        p = self.plane()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c-inner-lake-plane.json")
            with open(path, "w") as f:
                json.dump({"format": "golfmap-lake-plane-v1", "name": "L", "surfaceY": 8.0, "shoreDistance": dict(
                    p["grid"], data=base64.b64encode(p["dist"].tobytes()).decode(),
                    cliff=base64.b64encode(p["cliff"].tobytes()).decode())}, f)
            got = pr.load_lake_plane(path)
        self.assertEqual(got["grid"]["width"], 4)
        self.assertTrue(np.array_equal(got["dist"], p["dist"]))


class StrokeTest(unittest.TestCase):
    def test_line_replace(self):
        rule = pr.normalise({"kind": "stroke", "id": "s", "geometry": "line", "points3006": [[990, 4990], [980, 4990]],
                             "widthM": 2.0, "featherM": 1.0, "channel": "black", "strength": 0.8})
        geom = pr.stroke_geometry(rule, FRAME)
        np.testing.assert_allclose(geom[1], [[10, 10], [20, 10]])   # x = -(E - e0), y = -(N - n0)
        xy = np.array([[15, 10], [15, 11], [15, 11.5], [15, 12], [15, 13]])
        w = pr.stroke_weights(xy, geom, rule)
        np.testing.assert_allclose(w, [0.8, 0.8, 0.4, 0.0, 0.0])
        box = pr.stroke_box(geom, rule)
        self.assertEqual(box, (8.0, 8.0, 22.0, 12.0))

    def test_polygon_overlay_and_hard_edge(self):
        rule = pr.normalise({"kind": "stroke", "id": "p", "geometry": "polygon", "channel": "green", "mode": "overlay",
                             "featherM": 0, "points3006": [[1000, 5000], [990, 5000], [990, 4990], [1000, 4990]]})
        geom = pr.stroke_geometry(rule, FRAME)
        xy = np.array([[5, 5], [0, 5], [-0.01, 5], [11, 5]])
        w = pr.stroke_weights(xy, geom, rule)
        np.testing.assert_allclose(w, [1, 1, 0, 0])
        out = pr.apply_channel(np.array([RED] * 4), w, "green", "overlay")
        np.testing.assert_allclose(out[:, :3], [[1, 1, 0], [1, 1, 0], [1, 0, 0], [1, 0, 0]])

    def test_circle_feather(self):
        rule = pr.normalise({"kind": "stroke", "id": "c", "geometry": "circle", "centre3006": [990, 4990],
                             "radiusM": 2.0, "featherM": 2.0, "channel": "blue"})
        geom = pr.stroke_geometry(rule, FRAME)
        xy = np.array([[10, 10], [12, 10], [13, 10], [14, 10]])
        np.testing.assert_allclose(pr.stroke_weights(xy, geom, rule), [1.0, 1.0, 0.5, 0.0])

    def test_filters(self):
        rule = pr.normalise({"kind": "stroke", "geometry": "circle", "centre3006": [0, 0], "radiusM": 1,
                             "channel": "red", "surfaces": ["Rough"], "match": "hole_3_"})
        self.assertTrue(pr.stroke_touches("Spline_hole_3_1_Rough_-_Mesh", rule))
        self.assertFalse(pr.stroke_touches("Spline_hole_4_1_Rough_-_Mesh", rule))
        self.assertFalse(pr.stroke_touches("Spline_hole_3_1_Fairway_-_Mesh", rule))
        self.assertFalse(pr.stroke_touches("RAM road hole_3_", rule))


class RuleTest(unittest.TestCase):
    def test_errors(self):
        bad = [({"kind": "edge", "edge": "bunker", "channel": "black", "mode": "overlay"}, "no overlay"),
               ({"kind": "object"}, "needs match"),
               ({"kind": "object", "match": "x", "fadeM": 0}, "fadeM"),
               ({"kind": "road", "surfaces": ["Lawn"]}, "unknown surface"),
               ({"kind": "edge", "edge": "green"}, "not supported"),
               ({"kind": "stroke", "geometry": "line", "points3006": [[0, 0]], "channel": "red"}, "points3006"),
               ({"kind": "stroke", "geometry": "circle", "centre3006": [0, 0], "radiusM": 1}, "needs channel"),
               ({"kind": "paint"}, "kind must")]
        for rule, msg in bad:
            errs = pr.validate(rule)
            self.assertEqual(len(errs), 1, rule)
            self.assertIn(msg, errs[0])

    def test_paint_rule_drops_unity_only_keys(self):
        r = pr.paint_rule({"id": "creek-bed", "kind": "object", "match": "x", "material": {"albedo": "a"},
                           "grassFrom": "rough", "enabled": True})
        self.assertEqual(r, {"id": "creek-bed", "kind": "object", "match": "x"})

    def test_dependency_follows_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "c-inner-dem-100m.tif.json"), "w") as f:
                f.write("{}")
            op = {"id": "paint-ram-roads", "op": "golfmap.paint", "rule": {"kind": "road"}}
            self.assertEqual(pr.dependency(op, d), {"file": "c-inner-ramroads.json", "sha": None})
            with open(os.path.join(d, "c-inner-ramroads.json"), "w") as f:
                f.write("{}")
            a = pr.dependency(op, d)
            with open(os.path.join(d, "c-inner-ramroads.json"), "w") as f:
                f.write('{"roads": []}')
            self.assertNotEqual(a["sha"], pr.dependency(op, d)["sha"])
            self.assertIsNone(pr.dependency({"rule": {"kind": "object", "match": "x"}}, d))
            self.assertEqual(pr.dependency({"rule": {"kind": "object", "match": "x", "creek": "feature:1"}}, d)["file"],
                             "c-inner-creeks.json")
            self.assertEqual(pr.dependency({"rule": {"kind": "lakebed"}}, d)["file"], "c-inner-lake-plane.json")


if __name__ == "__main__":
    unittest.main()
