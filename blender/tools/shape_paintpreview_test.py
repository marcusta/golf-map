"""Tests for shape_paintpreview.py (plain Python + numpy): python blender/tools/shape_paintpreview_test.py

Synthetic meshes sent as Unity sends them (Unity world, base64), the preview cross-checked against shape_paintrules
applied directly in the .blend frame."""
import base64
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import shape_coords  # noqa: E402
import shape_paintpreview as pp  # noqa: E402
import shape_paintrules as pr  # noqa: E402

FRAME = {"e0": 1000.0, "n0": 5000.0, "sideM": 100.0, "minM": 0.0, "px": 0.0, "py": 0.0, "pz": 0.0}
RED = (1.0, 0.0, 0.0, 1.0)


def grid_blend(nx, ny, x0, y0, step=1.0, z=0.0):
    """A flat grid of triangles in the .blend frame: world (N, 3), triangles (T*3,)."""
    xs, ys = np.meshgrid(x0 + np.arange(nx) * step, y0 + np.arange(ny) * step, indexing="xy")
    world = np.column_stack([xs.ravel(), ys.ravel(), np.full(nx * ny, z)])
    tris = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i
            tris += [a, a + 1, a + 1 + nx, a, a + 1 + nx, a + nx]
    return world, np.array(tris)


def unity_mesh(name, world, tris, colours=None):
    """The mesh as golfmap.paint.meshes sends it: Unity world (-x, z, -y), base64."""
    u = np.column_stack([-world[:, 0], world[:, 2], -world[:, 1]]).astype(np.float32)
    enc = lambda a: base64.b64encode(np.ascontiguousarray(a).tobytes()).decode("ascii")  # noqa: E731
    return {"object": name, "surface": pr.classify(name), "vertexCount": len(world), "positions": enc(u),
            "colors": "" if colours is None else enc(np.asarray(colours, dtype=np.float32)),
            "triangles": enc(tris.astype(np.int32))}


def decode(text):
    return np.frombuffer(base64.b64decode(text), dtype=np.float32).reshape(-1, 4).astype(np.float64)


def q(c):
    return np.floor(np.clip(c, 0, 1) * 255 + 0.5) / 255


def to3006(x, y):
    return list(shape_coords.from_blend(x, y, FRAME))


class PreviewTest(unittest.TestCase):
    def setUp(self):
        # a rough west of the origin (.blend x -20..0, y -10..0) and a fairway beyond it
        self.rough, self.rtris = grid_blend(21, 11, -20.0, -10.0)
        self.fair, self.ftris = grid_blend(5, 5, -40.0, -10.0)
        self.base = np.tile(RED, (len(self.rough), 1))

    def meshes(self):
        return [unity_mesh("Spline_hole_1_3_Rough_-_Mesh", self.rough, self.rtris, self.base),
                unity_mesh("Spline_hole_1_4_Fairway_-_Mesh", self.fair, self.ftris, np.tile(RED, (len(self.fair), 1)))]

    def stroke(self, **kw):
        s = {"id": "s1", "geometry": "line", "points3006": [to3006(-5.0, -5.0), to3006(-15.0, -5.0)],
             "widthM": 2.0, "featherM": 1.0, "channel": "black", "strength": 1.0}
        s.update(kw)
        return s

    def paint(self, strokes, rules=()):
        return {"format": "golfmap-paint-v1", "rules": list(rules), "lakebed": {"enabled": False}, "strokes": strokes}

    def test_a_line_stroke_matches_the_rules_applied_in_the_blend_frame(self):
        s = self.stroke()
        out = pp.preview({"frame": FRAME, "paint": self.paint([s]), "meshes": self.meshes()})
        self.assertEqual(out["changed"], 1)
        self.assertEqual(out["objects"][0]["object"], "Spline_hole_1_3_Rough_-_Mesh")
        self.assertEqual(out["unchanged"], ["Spline_hole_1_4_Fairway_-_Mesh"])
        rule = pr.normalise(dict(s, kind="stroke"))
        w = pr.stroke_weights(self.rough[:, :2], pr.stroke_geometry(rule, FRAME), rule)
        want = q(pr.apply_channel(self.base, w, "black"))
        np.testing.assert_allclose(decode(out["objects"][0]["colors"]), want, atol=1e-6)
        got = decode(out["objects"][0]["colors"])
        # on the line: black; 3 m and more off it (1 m half width + 1 m feather): red as sent
        on = np.argmin(np.hypot(self.rough[:, 0] + 10, self.rough[:, 1] + 5))
        off = np.argmin(np.hypot(self.rough[:, 0] + 10, self.rough[:, 1] + 1))
        np.testing.assert_allclose(got[on], (0, 0, 0, 1), atol=1e-6)
        np.testing.assert_allclose(got[off], RED, atol=1e-6)

    def test_strokes_compose_in_layer_order(self):
        a = self.stroke(id="a", geometry="circle", centre3006=to3006(-10.0, -5.0), radiusM=4.0, featherM=0.5,
                        channel="blue", points3006=None)
        a.pop("points3006")
        b = self.stroke(id="b", strength=0.5, mode="replace")
        out = pp.preview({"frame": FRAME, "paint": self.paint([a, b]), "meshes": self.meshes()})
        got = decode(out["objects"][0]["colors"])
        ra, rb = pr.normalise(dict(a, kind="stroke")), pr.normalise(dict(b, kind="stroke"))
        c = q(pr.apply_channel(self.base, pr.stroke_weights(self.rough[:, :2], pr.stroke_geometry(ra, FRAME), ra), "blue"))
        c = q(pr.apply_channel(c, pr.stroke_weights(self.rough[:, :2], pr.stroke_geometry(rb, FRAME), rb), "black"))
        np.testing.assert_allclose(got, c, atol=1e-6)
        # where both reach: blue half way to black
        i = np.argmin(np.hypot(self.rough[:, 0] + 10, self.rough[:, 1] + 5))
        np.testing.assert_allclose(got[i], q(np.array([0, 0, 0.5, 1])), atol=1e-6)

    def test_only_paints_the_named_ops_but_checks_them_all(self):
        a = self.stroke(id="a", channel="blue")
        b = self.stroke(id="b", strength=0.5)
        out = pp.preview({"frame": FRAME, "paint": self.paint([a, b]), "only": ["paint-stroke-b"], "meshes": self.meshes()})
        rb = pr.normalise(dict(b, kind="stroke"))
        want = q(pr.apply_channel(self.base, pr.stroke_weights(self.rough[:, :2], pr.stroke_geometry(rb, FRAME), rb), "black"))
        np.testing.assert_allclose(decode(out["objects"][0]["colors"]), want, atol=1e-6)
        self.assertEqual(out["ops"], 1)
        with self.assertRaises(pr.RuleError):
            pp.preview({"paint": self.paint([self.stroke(id="a", channel="purple"), b]), "only": ["paint-stroke-b"], "meshes": []})

    def test_surfaces_and_a_disabled_stroke(self):
        s = self.stroke(surfaces=["Fairway"])
        out = pp.preview({"frame": FRAME, "paint": self.paint([s]), "meshes": self.meshes()})
        self.assertEqual(out["changed"], 0)
        out = pp.preview({"frame": FRAME, "paint": self.paint([self.stroke(enabled=False)]), "meshes": self.meshes()})
        self.assertEqual(out["changed"], 0)
        self.assertEqual(out["ops"], 0)

    def test_an_object_rule_reads_the_mesh_border(self):
        rule = {"id": "o", "kind": "object", "match": "_Rough_-_", "channel": "green", "fadeM": 2.0}
        out = pp.preview({"frame": FRAME, "paint": self.paint([], [rule]), "meshes": self.meshes()})
        got = decode(out["objects"][0]["colors"])
        border = pr.boundary_points(self.rough, self.rtris, np.arange(len(self.rtris) // 3) * 3,
                                    np.full(len(self.rtris) // 3, 3))
        w = pr.object_weights(self.rough, border, pr.normalise(rule))
        np.testing.assert_allclose(got, q(pr.apply_channel(self.base, w, "green")), atol=1e-6)
        self.assertEqual(len(border), 2 * 21 + 2 * 9)   # the grid's outline

    def test_a_mesh_without_colours_paints_from_red(self):
        meshes = self.meshes()
        meshes[0]["colors"] = ""
        out = pp.preview({"frame": FRAME, "paint": self.paint([self.stroke()]), "meshes": meshes})
        got = decode(out["objects"][0]["colors"])
        self.assertEqual(len(got), len(self.rough))
        np.testing.assert_allclose(got[0], RED, atol=1e-6)

    def test_bad_rules_fail_even_without_meshes(self):
        with self.assertRaises(pr.RuleError):
            pp.preview({"paint": self.paint([self.stroke(channel="purple")]), "meshes": []})
        with self.assertRaises(pr.RuleError):
            pp.preview({"paint": self.paint([self.stroke(id="a"), self.stroke(id="a")]), "meshes": []})
        out = pp.preview({"paint": self.paint([self.stroke()]), "meshes": []})
        self.assertEqual((out["changed"], out["ops"]), (0, 1))

    def test_road_rule_without_an_export_paints_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            rule = {"id": "r", "kind": "road", "channel": "black"}
            out = pp.preview({"folder": d, "frame": FRAME, "paint": self.paint([], [rule]), "meshes": self.meshes()})
            self.assertEqual(out["changed"], 0)

    def test_the_command_line_reads_stdin_and_the_folder_sidecar(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "c-inner-dem-100m.tif.json"), "w") as f:
                json.dump({"square3006": [1000.0, 5000.0, 1100.0, 5100.0], "minM": 0.0}, f)
            doc = {"folder": d, "paint": self.paint([self.stroke()]), "meshes": self.meshes()}
            r = subprocess.run([sys.executable, os.path.join(HERE, "shape_paintpreview.py")], input=json.dumps(doc),
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads(r.stdout)["changed"], 1)
            doc["paint"]["strokes"][0]["channel"] = "purple"
            r = subprocess.run([sys.executable, os.path.join(HERE, "shape_paintpreview.py")], input=json.dumps(doc),
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 1)
            self.assertIn("channel", r.stderr)


if __name__ == "__main__":
    unittest.main()
