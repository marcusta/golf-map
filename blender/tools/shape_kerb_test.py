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

    def test_params(self):
        self.assertEqual(kb.validate_params({}), [])
        self.assertEqual(kb.validate_params({"depthM": 0.05, "cuts": 3, "surfaces": ["asphalt"]}), [])
        self.assertEqual(len(kb.validate_params({"depthM": 0, "cuts": 9, "surfaces": "asphalt"})), 3)
        self.assertEqual(len(kb.validate_params({"depthM": True})), 1)


if __name__ == "__main__":
    unittest.main()
