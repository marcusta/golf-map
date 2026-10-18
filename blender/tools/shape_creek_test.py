"""Tests for shape_creek.py (plain Python + numpy): python blender/tools/shape_creek_test.py"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_creek as sc  # noqa: E402


def corridor(length=20.0, half=1.2, step=0.15):
    """A flat-ish corridor along y (x across), heights falling 0.05 m per metre downstream (+y -> -z), with a 0.3 m V
    already in it (what the DEM carries)."""
    xs = np.arange(-half, half + 1e-9, step)
    ys = np.arange(0.0, length + 1e-9, step)
    gx, gy = np.meshgrid(xs, ys)
    xy = np.stack([gx.ravel(), gy.ravel()], axis=1)
    z = 100.0 - 0.05 * xy[:, 1] - 0.3 * np.clip(1 - np.abs(xy[:, 0]) / 0.9, 0, 1)
    return xy, z


class ChannelTest(unittest.TestCase):
    def setUp(self):
        self.xy, self.z = corridor()
        self.line = np.array([[0.0, -2.0], [0.0, 22.0]])

    def test_bed_is_depth_under_the_ground_beside(self):
        new, info = sc.channel_heights(self.xy, self.z, self.line, width=0.7, depth=0.7, wall=0.15, ramp=0.0)
        mid = (np.abs(self.xy[:, 0]) < 0.3) & (self.xy[:, 1] > 5) & (self.xy[:, 1] < 15)
        beside = (np.abs(np.abs(self.xy[:, 0]) - 1.1) < 0.1) & (self.xy[:, 1] > 5) & (self.xy[:, 1] < 15)
        # the ground beside is the corridor's shoulder (the V's skirt is 0 there): 0.7 m under it
        for y in (6.0, 10.0, 14.0):
            m = mid & (np.abs(self.xy[:, 1] - y) < 0.1)
            b = beside & (np.abs(self.xy[:, 1] - y) < 0.3)
            self.assertAlmostEqual(float(new[m].mean()), float(self.z[b].mean()) - 0.7, delta=0.03)
        self.assertGreater(info["moved"], 0)

    def test_walls_are_steep_and_flat_outside_untouched(self):
        new, _ = sc.channel_heights(self.xy, self.z, self.line, width=0.7, depth=0.7, wall=0.15, ramp=0.0)
        far = np.abs(self.xy[:, 0]) >= 0.35 + 0.15
        self.assertTrue(np.allclose(new[far], self.z[far]))
        self.assertTrue((new <= self.z + 1e-12).all())

    def test_pinned_vertices_stay(self):
        pinned = (np.abs(self.xy[:, 0]) > 1.19) | (self.xy[:, 1] < 0.01) | (self.xy[:, 1] > 19.99)
        new, _ = sc.channel_heights(self.xy, self.z, self.line, ramp=1.5, pinned=pinned)
        self.assertTrue(np.array_equal(new[pinned], self.z[pinned]))

    def test_ramp_eases_in_from_the_ends(self):
        new, _ = sc.channel_heights(self.xy, self.z, self.line, ramp=2.0, depth=0.7)
        mid = np.abs(self.xy[:, 0]) < 0.1
        drop = (self.z - new)
        at = lambda y: float(drop[mid & (np.abs(self.xy[:, 1] - y) < 0.08)].mean())
        self.assertLess(at(0.3), at(1.0))
        self.assertLess(at(1.0), at(10.0))
        self.assertLess(at(19.7), at(19.0))

    def test_needs_ground_beside(self):
        with self.assertRaises(ValueError):
            sc.channel_heights(self.xy[np.abs(self.xy[:, 0]) < 0.5], self.z[np.abs(self.xy[:, 0]) < 0.5], self.line)


if __name__ == "__main__":
    unittest.main()
