"""Tests for shape_edgefade.py (pure Python): python blender/tools/shape_edgefade_test.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_edgefade as ef


class NoiseTest(unittest.TestCase):
    def test_value_noise_is_deterministic_and_in_range(self):
        for x, y in ((0.0, 0.0), (1.37, -4.2), (-812.55, -1603.07), (12345.678, 9876.543)):
            a = ef.value_noise(x, y, 7)
            self.assertEqual(a, ef.value_noise(x, y, 7))
            self.assertTrue(-1.0 <= a <= 1.0)

    def test_the_seed_changes_the_noise(self):
        pts = [(i * 0.31, i * 0.17) for i in range(50)]
        same = sum(1 for x, y in pts if ef.value_noise(x, y, 1) == ef.value_noise(x, y, 2))
        self.assertLess(same, 5)

    def test_noise_is_continuous(self):
        # a small step moves the value only a little (no lattice jumps)
        worst = 0.0
        for i in range(2000):
            x, y = i * 0.0731 - 40.0, i * 0.0419 + 11.0
            worst = max(worst, abs(ef.fractal_noise(x + 0.005, y, 3) - ef.fractal_noise(x, y, 3)))
        self.assertLess(worst, 0.15)

    def test_the_noise_varies_across_the_range(self):
        vals = [ef.fractal_noise(i * 0.137, i * 0.211, 5) for i in range(3000)]
        self.assertLess(min(vals), -0.4)
        self.assertGreater(max(vals), 0.4)
        self.assertLess(abs(sum(vals) / len(vals)), 0.1)


class StripValueTest(unittest.TestCase):
    W = 0.62

    def test_the_ends_are_pure(self):
        for x, y in ((3.0, 4.0), (-812.5, -1603.0), (99.9, 0.1)):
            self.assertEqual(ef.strip_value(0.0, self.W, x, y, 9), 0.0)
            self.assertEqual(ef.strip_value(self.W, self.W, x, y, 9), 1.0)
            self.assertEqual(ef.strip_value(self.W + 0.3, self.W, x, y, 9), 1.0)

    def test_the_value_stays_in_range_and_rises_on_average(self):
        import random
        rnd = random.Random(1)
        pts = [(rnd.uniform(-900, -800), rnd.uniform(-1700, -1600)) for _ in range(400)]
        means = []
        for d in (0.05, 0.15, 0.3, 0.45, 0.58):
            vals = [ef.strip_value(d, self.W, x, y, 4) for x, y in pts]
            self.assertTrue(all(0.0 <= v <= 1.0 for v in vals))
            means.append(sum(vals) / len(vals))
        self.assertEqual(means, sorted(means))
        self.assertLess(means[0], 0.2)
        self.assertGreater(means[-1], 0.8)

    def test_the_ramp_wanders_along_the_edge(self):
        # at one distance from the outer edge the value differs a lot between places: the edge is irregular
        vals = [ef.strip_value(0.3, self.W, -800.0 + i * 0.05, -1600.0, 4) for i in range(200)]
        self.assertGreater(max(vals) - min(vals), 0.3)

    def test_no_amplitude_gives_a_plain_smoothstep(self):
        for d in (0.1, 0.3, 0.5):
            t = d / self.W
            self.assertAlmostEqual(ef.strip_value(d, self.W, 5.0, 5.0, 4, amplitude=0.0), t * t * (3 - 2 * t), places=9)

    def test_neighbouring_pieces_share_the_noise(self):
        # the value is a function of position only: a vertex shared by two path pieces gets the same paint in both
        self.assertEqual(ef.strip_value(0.21, self.W, -801.2, -1604.8, 11), ef.strip_value(0.21, self.W, -801.2, -1604.8, 11))

    def test_a_zero_width_strip_is_all_path(self):
        self.assertEqual(ef.strip_value(0.1, 0.0, 1.0, 1.0, 1), 1.0)


class PaintTest(unittest.TestCase):
    def test_red_is_grass_green_is_path_and_they_sum_to_one(self):
        for s in (0.0, 0.25, 0.5, 1.0, -0.3, 1.4):
            r, g, b = ef.paint(s)
            self.assertAlmostEqual(r + g, 1.0)
            self.assertEqual(b, 0.0)
            self.assertTrue(0.0 <= r <= 1.0 and 0.0 <= g <= 1.0)
        self.assertEqual(ef.paint(0.0), (1.0, 0.0, 0.0))
        self.assertEqual(ef.paint(1.0), (0.0, 1.0, 0.0))


class ValidateTest(unittest.TestCase):
    def test_good_and_bad_params(self):
        self.assertEqual(ef.validate_params({"widthM": 0.6, "maxEdgeM": 0.2, "amplitude": 0.4, "surfaces": ["gravel"], "weld": True}), [])
        self.assertEqual(ef.validate_params({"amplitude": 0}), [])
        bad = ef.validate_params({"widthM": -1, "maxEdgeM": 0.01, "amplitude": -1, "surfaces": [], "weld": "yes"})
        self.assertEqual(len(bad), 5, bad)


if __name__ == "__main__":
    unittest.main()
