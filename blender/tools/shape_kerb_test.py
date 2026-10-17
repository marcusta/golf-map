"""Unit tests for shape_kerb's pure parts (plain Python: `python blender/tools/shape_kerb_test.py`). kerb_core needs
bpy; it was checked on Omberg's roads_1f (blender/README.md "Shaping: rounded hard-road edge")."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_kerb as kb  # noqa: E402


class Profile(unittest.TestCase):
    def test_flat_on_the_road_full_drop_on_the_grass_edge_rounded_between(self):
        self.assertEqual(kb.profile(0), 0)
        self.assertEqual(kb.profile(1), 1)
        self.assertEqual((kb.profile(-1), kb.profile(2)), (0, 1))
        ts = [i / 10 for i in range(11)]
        ps = [kb.profile(t) for t in ts]
        self.assertEqual(ps, sorted(ps))
        steps = [b - a for a, b in zip(ps, ps[1:])]
        self.assertEqual(steps, sorted(steps))  # rolls over: steeper toward the grass
        self.assertLess(kb.profile(1 / 3), 0.06)  # the first cut barely drops
        self.assertGreater(kb.profile(2 / 3), 0.25)

    def test_strip_paint_grass_out_road_in_shadow_between(self):
        for x, y in ((0.3, 1.7), (12.4, -3.1), (100.0, 55.5)):
            r0, g0, _ = kb.strip_paint(0, x, y)
            r1, g1, _ = kb.strip_paint(1, x, y)
            self.assertAlmostEqual(r0, 1, places=6)
            self.assertAlmostEqual(g1, 1, places=6)
            self.assertLess(g0, 0.02)
            self.assertLess(r1, 1e-6)
            for e in (0.1, 0.3, 0.5, 0.8):
                r, g, b = kb.strip_paint(e, x, y)
                self.assertTrue(0 <= r <= 1 and 0 <= g <= 1 and b == 0 and r + g <= 1 + 1e-9)
            r, g, _ = kb.strip_paint(0.32, x, y)
            self.assertLess(r + g, 0.6)  # the dark band (MAHS black)

    def test_chains_join_segments_and_stop_at_branches(self):
        segs = [((0, 0), (1, 0)), ((1, 0), (2, 0)), ((2, 0), (2, 1)), ((5, 5), (6, 5))]
        lines = sorted(kb.chains(segs), key=len)
        self.assertEqual([len(l) for l in lines], [2, 4])
        self.assertEqual(lines[1][0], (0, 0))
        self.assertEqual(lines[1][-1], (2, 1))

    def test_params(self):
        self.assertEqual(kb.validate_params({}), [])
        self.assertEqual(kb.validate_params({"depthM": 0.05, "roadM": 0.2, "cuts": 3, "surfaces": ["asphalt"]}), [])
        self.assertEqual(len(kb.validate_params({"depthM": 0, "cuts": 9, "surfaces": "asphalt"})), 3)
        self.assertEqual(len(kb.validate_params({"depthM": True, "roadM": -1})), 2)


if __name__ == "__main__":
    unittest.main()
