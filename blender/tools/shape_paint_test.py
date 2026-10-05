"""Unit tests for shape_paint's weight maths and library logic (plain Python:
`python blender/tools/shape_paint_test.py`). Run inside Blender to also test the bpy glue:
`blender -b --factory-startup --python blender/tools/shape_paint_test.py`."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import shape_paint as sp  # noqa: E402
import shape_recipes as sr  # noqa: E402

LIB = sp.load_library()
RED, GREEN, BLUE, BLACK = (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (0.0, 0.0, 0.0)


def close(a, b, eps=1e-9):
    return all(abs(x - y) <= eps for x, y in zip(a, b))


def mapped(recipe_id, kind, colour):
    entry = sp.find_entry(recipe_id, LIB)
    return sp.dominant(sp.remap_color(colour, sp.role_matrix(entry["paint"][kind], kind, LIB)))


class WeightMaths(unittest.TestCase):
    def test_weights_black_is_the_rest(self):
        self.assertEqual(sp.weights((0.25, 0.25, 0.0)), (0.25, 0.25, 0.0, 0.5))
        self.assertEqual(sp.weights((0.7, 0.6, 0.0))[3], 0.0)  # over-full (sRGB mix): no negative black

    def test_identity_is_exact(self):
        m = sp.role_matrix({}, "mesh", LIB)
        self.assertTrue(sp.is_identity(m))
        for c in (RED, GREEN, BLUE, BLACK, (0.2, 0.3, 0.1), (0.7, 0.6, 0.0)):
            self.assertEqual(sp.remap_color(c, m), c)

    def test_permutation_and_black(self):
        # kaustin: black (base) -> floor (blue), red stays
        m = sp.role_matrix({"red": "grassLip", "green": "dirt", "black": "floor", "blue": "floor"}, "mesh", LIB)
        self.assertEqual(sp.remap_color(BLACK, m), BLUE)
        self.assertEqual(sp.remap_color(RED, m), RED)
        # 75 % black over red (KA_Creek ring 6): red 0.25 stays, black 0.75 becomes blue
        self.assertTrue(close(sp.remap_color((0.25, 0.0, 0.0), m), (0.25, 0.0, 0.75)))

    def test_into_black_drops_the_channel(self):
        # OPCD bunker blend: red (at the bunker) -> browning (black), black (outside) -> adjoining (red)
        m = sp.role_matrix(LIB["opcdDefault"]["bunker"]["blend"], "blend", LIB)
        self.assertEqual(sp.remap_color(RED, m), BLACK)
        self.assertEqual(sp.remap_color(BLACK, m), RED)
        self.assertTrue(close(sp.remap_color((0.4, 0.0, 0.0), m), (0.6, 0.0, 0.0)))

    def test_merge_and_split(self):
        m = sp.role_matrix({"green": "floor", "blue": "floor"}, "mesh", LIB)
        self.assertTrue(close(sp.remap_color((0.0, 0.3, 0.5), m), (0.0, 0.0, 0.8)))
        m = sp.role_matrix({"blue": {"floor": 0.5, "dirt": 0.5}}, "mesh", LIB)
        self.assertTrue(close(sp.remap_color(BLUE, m), (0.0, 0.5, 0.5)))
        self.assertTrue(close(sp.remap_color((0.0, 0.0, 0.4), m), (0.0, 0.2, 0.2)))

    def test_weights_sum_is_kept(self):
        m = sp.role_matrix(LIB["opcdDefault"]["bunker"]["mesh"], "mesh", LIB)
        for c in ((0.1, 0.2, 0.3), (0.5, 0.5, 0.0), (0.0, 0.0, 0.0)):
            out = sp.remap_color(c, m)
            self.assertAlmostEqual(sum(sp.weights(out)), 1.0)

    def test_bad_role(self):
        with self.assertRaises(ValueError):
            sp.role_matrix({"red": "sand"}, "mesh", LIB)
        with self.assertRaises(ValueError):
            sp.role_matrix({"red": "grassLip"}, "blend", LIB)


class Library(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(sp.validate_library(LIB), [])

    def test_at_most_one_default_per_surface(self):
        # Bunkers keep OPCD's shape by default (paint only); lakes and creeks have no default until one is
        # picked per feature (2026-09-29).
        self.assertEqual(sp.default_recipe("bunker", LIB)["id"], "golfmap-bunker-paint-only")
        self.assertIsNone(sp.default_recipe("lake", LIB))
        self.assertIsNone(sp.default_recipe("creek", LIB))
        self.assertEqual(sp.default_recipe("path", LIB)["id"], "raised-path-blitz")
        for surface in ("bunker", "lake", "creek", "path"):
            self.assertLessEqual(sum(1 for r in LIB["recipes"] if r.get("default") and surface in r["surfaces"]), 1)

    def test_find_by_id_and_path(self):
        self.assertEqual(sp.find_entry("cesimgolf-conway", LIB)["id"], "cesimgolf-conway")
        self.assertEqual(sp.find_entry("cesimgolf-Conway_Bunker_Standard.json", LIB)["id"], "cesimgolf-conway")
        self.assertEqual(sp.find_entry("D:\\gspro\\afrod-recipes\\cesimgolf-Conway_Bunker_Standard.json", LIB)["id"],
                         "cesimgolf-conway")
        p = "D:/gspro/afrod-recipes/kaustin-Lake Gradual Entry-20260928T172349Z-1-001/Lake Gradual Entry/KA_Lake_gradual.json"
        self.assertEqual(sp.find_entry(p, LIB)["id"], "kaustin-lake-gradual")
        self.assertIsNone(sp.find_entry("nope.json", LIB))

    def test_files_exist_when_folder_present(self):
        d = sp.default_recipe_dirs()[0]
        if not os.path.isdir(d):
            self.skipTest(d + " not here")
        for r in LIB["recipes"]:
            self.assertIsNotNone(sp.recipe_path(r), r["file"])

    def test_author_meanings(self):
        # ce.simgolf: red lip with 3DG, black shadow, green sand, blue wet floor -> sand
        self.assertEqual(mapped("cesimgolf-conway", "mesh", RED), "red")
        self.assertEqual(mapped("cesimgolf-conway", "mesh", BLACK), "black")
        self.assertEqual(mapped("cesimgolf-conway", "mesh", GREEN), "blue")
        self.assertEqual(mapped("cesimgolf-conway", "mesh", BLUE), "blue")
        self.assertEqual(mapped("cesimgolf-hazeltine", "blend", BLUE), "black")
        # kaustin: black = base (sand / bed), red = adjoining, green = dirt
        for rid in ("kaustin-bunker-higher-lip", "kaustin-lake-gradual", "kaustin-creek"):
            self.assertEqual(mapped(rid, "mesh", BLACK), "blue")
            self.assertEqual(mapped(rid, "mesh", RED), "red")
            self.assertEqual(mapped(rid, "mesh", GREEN), "green")
        # BLRK: black dirt, green/blue sand
        self.assertEqual(mapped("blrk-bunker-simple-no-dig", "mesh", BLACK), "green")
        self.assertEqual(mapped("blrk-bunker-simple-no-dig", "mesh", GREEN), "blue")


class Planning(unittest.TestCase):
    bunker = [
        {"name": "Spline_x_Bunker_-_Mesh", "kind": "mesh", "parentId": "x"},
        {"name": "Spline_x_piece1_Rough_B_Bunker_-_Blend", "kind": "blend", "parentId": "x"},
        {"name": "Spline_x_piece2_Rough_B_Bunker_-_Blend", "kind": "blend", "parentId": "x"},
    ]

    def test_surface_from_name(self):
        self.assertEqual(sp.surface_from_name("Spline_hole_18_1c_B_Rough_Bunker_-_Blend"), "bunker")
        self.assertEqual(sp.surface_from_name("Spline_hole_5_8_B_Deep_Water_Base_Creek_-_Blend"), "creek")
        self.assertEqual(sp.surface_from_name("Spline_others_16_Water_Base_Lake_-_Mesh"), "lake")
        self.assertEqual(sp.surface_from_name("Spline_roads_5_Concrete_-_Mesh"), "path")
        self.assertIsNone(sp.surface_from_name("Spline_hole_1_3_Green_-_Mesh"))

    def test_last_blend_gets_the_recipe_map(self):
        rows = {r["name"]: r for r in sp.plan(self.bunker, sp.find_entry("cesimgolf-conway", LIB), LIB)}
        self.assertEqual(rows["Spline_x_Bunker_-_Mesh"]["source"], "recipe")
        self.assertEqual(rows["Spline_x_piece2_Rough_B_Bunker_-_Blend"]["source"], "recipe")
        self.assertEqual(rows["Spline_x_piece1_Rough_B_Bunker_-_Blend"]["source"], "opcdDefault")

    def test_reshape_only_recipe_uses_opcd_default(self):
        objs = [{"name": "Spline_c_Water_Base_Creek_-_Mesh", "kind": "mesh", "parentId": "c"},
                {"name": "Spline_c_B_Rough_Water_Base_Creek_-_Blend", "kind": "blend", "parentId": "c"}]
        rows = sp.plan(objs, sp.find_entry("simple-creek-double-subdivided", LIB), LIB)
        self.assertEqual([r["source"] for r in rows], ["opcdDefault", "opcdDefault"])
        self.assertEqual(rows[0]["surface"], "creek")

    def test_opcd_default_skips_golfmap_objects(self):
        objs = [dict(self.bunker[0], marked=True), self.bunker[1]]
        rows = sp.plan(objs, None, LIB)
        self.assertEqual([r["source"] for r in rows], ["skip", "opcdDefault"])

    def test_second_call_is_a_no_op(self):
        # marked = the paint still matches the hash written by the first remap
        objs = [dict(self.bunker[0], marked=True)]
        self.assertEqual(sp.plan(objs, sp.find_entry("blrk-bunker-simple-no-dig", LIB), LIB)[0]["source"], "skip")

    def test_opcd_bunker_default_keeps_the_look(self):
        # OPCD bunker material: red/green dirt, blue/black sand -> golfmap dirt (green) / floor (blue)
        m = sp.role_matrix(LIB["opcdDefault"]["bunker"]["mesh"], "mesh", LIB)
        self.assertEqual(sp.dominant(sp.remap_color(RED, m)), "green")
        self.assertEqual(sp.dominant(sp.remap_color(BLACK, m)), "blue")


try:
    import bpy  # noqa: F401
except ImportError:
    bpy = None


def _obj(name, colours, kind="mesh", pid="x"):
    """A quad strip whose corners carry `colours` (one per vertex), with OPCD's Col attribute."""
    me = bpy.data.meshes.new(name)
    n = len(colours)
    me.from_pydata([(i, 0, 0) for i in range(n)] + [(i, 1, 0) for i in range(n)], [],
                   [(i, i + 1, n + i + 1, n + i) for i in range(n - 1)])
    a = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    for loop in me.loops:
        v = loop.vertex_index % n
        a.data[loop.index].color_srgb = tuple(colours[v]) + (1.0,)
    ob = bpy.data.objects.new(name, me)
    ob["opcd_kind"], ob["opcd_parent_id"] = kind, pid
    return ob


def _colours(ob):
    a = ob.data.color_attributes["Col"]
    return [tuple(round(c, 3) for c in a.data[loop.index].color_srgb[:3]) for loop in ob.data.loops]


def _strip(rows=5, cols=40, spacing=0.19, border=3):
    """A grid strip standing in for a bunker's rings: row 0 is the seam, rows < border dirt (green), the rest sand."""
    idx = lambda r, c: r * cols + c
    edges = [(idx(r, c), idx(r, c + 1)) for r in range(rows) for c in range(cols - 1)]
    edges += [(idx(r, c), idx(r + 1, c)) for r in range(rows - 1) for c in range(cols)]
    xy = [(c * spacing, r * spacing) for r in range(rows) for c in range(cols)]
    colours = [GREEN if r < border else BLUE for r in range(rows) for c in range(cols)]
    return edges, [idx(0, c) for c in range(cols)], xy, colours


class EdgeJitter(unittest.TestCase):
    P = sr.jitter_params({})

    def run_strip(self, seed=5, **params):
        edges, seam, xy, colours = _strip()
        hops, nb = sp.seam_hops(len(xy), edges, seam)
        return hops, colours, sp.jitter_colors(colours, hops, nb, xy, seed, sr.jitter_params(params))

    def test_hops_count_rings_from_the_seam(self):
        hops, _, _ = self.run_strip()
        self.assertEqual(sorted(set(hops)), [0, 1, 2, 3, 4])

    def test_only_the_border_rings_move(self):
        hops, before, after = self.run_strip()
        moved = {hops[v] for v in range(len(before)) if after[v] != before[v]}
        self.assertEqual(moved, {2, 3})  # the last dirt ring and the first sand ring; the seam never
        for v in range(len(before)):
            g, b = after[v][1], after[v][2]
            self.assertAlmostEqual(g + b, 1.0)          # a mix of the two neighbours, no new colour
            self.assertLessEqual(abs(g - before[v][1]), self.P["amount"] + 1e-9)

    def test_ragged_both_ways(self):
        hops, before, after = self.run_strip()
        self.assertTrue(any(hops[v] == 2 and after[v][2] > 0.05 for v in range(len(after))))  # sand reaches out
        self.assertTrue(any(hops[v] == 3 and after[v][1] > 0.05 for v in range(len(after))))  # dirt reaches in
        self.assertTrue(any(hops[v] in (2, 3) and after[v] == before[v] for v in range(len(after))))  # not everywhere

    def test_deterministic_per_seed(self):
        self.assertEqual(self.run_strip(seed=5)[2], self.run_strip(seed=5)[2])
        self.assertNotEqual(self.run_strip(seed=5)[2], self.run_strip(seed=6)[2])

    def test_amount_zero_changes_nothing(self):
        _, before, after = self.run_strip(amount=0.0)
        self.assertEqual(before, after)

    def test_noise_range_and_balance(self):
        vals = [sp.jitter_noise(x * 0.19, 1.3, 11, 0.6, 0.5) for x in range(400)]
        self.assertTrue(all(-1.0 <= v <= 1.0 for v in vals))
        self.assertLess(abs(sum(vals) / len(vals)), 0.15)


@unittest.skipIf(bpy is None, "needs Blender")
class BlenderGlue(unittest.TestCase):
    def test_edge_jitter_on_a_mesh(self):
        edges, seam, xy, colours = _strip(rows=5, cols=12)
        me = bpy.data.meshes.new("jitter")
        faces = [(r * 12 + c, r * 12 + c + 1, (r + 1) * 12 + c + 1, (r + 1) * 12 + c) for r in range(4) for c in range(11)]
        me.from_pydata([(x, y, 0.0) for x, y in xy], [], faces)
        attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        for loop in me.loops:
            attr.data[loop.index].color_srgb = colours[loop.vertex_index] + (1.0,)
        ob = bpy.data.objects.new("Spline_j_Bunker_-_Mesh", me)
        bpy.context.scene.collection.objects.link(ob)
        rows = sp.edge_jitter([ob], {}, seed=3)
        self.assertGreater(rows[0]["changed"], 0)
        seam_rows = {tuple(round(c, 3) for c in attr.data[l.index].color_srgb[:3]) for l in me.loops if l.vertex_index < 12}
        self.assertEqual(seam_rows, {GREEN})

    def test_recipe_then_default_is_not_applied_twice(self):
        mesh = _obj("Spline_x_Bunker_-_Mesh", [RED, BLACK, GREEN, BLUE])
        blend = _obj("Spline_x_B_Rough_Bunker_-_Blend", [RED, BLACK, RED, BLACK], kind="blend")
        res = sp.remap_after_recipe([mesh, blend], "kaustin-bunker-higher-lip")
        self.assertEqual([r["source"] for r in res["objects"]], ["recipe", "opcdDefault"])  # permanent join: blend map empty
        self.assertEqual(set(_colours(mesh)), {RED, BLUE, GREEN})
        self.assertIn(BLUE, _colours(mesh))
        before = _colours(mesh), _colours(blend)
        again = sp.remap_opcd_default([mesh, blend])
        self.assertEqual([r["source"] for r in again["objects"]], ["skip", "skip"])
        self.assertEqual((_colours(mesh), _colours(blend)), before)

    def test_restored_paint_is_remapped_again(self):
        mesh = _obj("Spline_y_Bunker_-_Mesh", [RED, GREEN, BLUE, BLACK], pid="y")
        sp.remap_opcd_default([mesh])
        self.assertEqual(set(_colours(mesh)), {GREEN, BLUE})
        a = mesh.data.color_attributes["Col"]
        for loop in mesh.data.loops:  # a snapshot restore: OPCD's paint back, properties kept
            a.data[loop.index].color_srgb = (1.0, 0.0, 0.0, 1.0)
        self.assertFalse(sp.is_golfmap(mesh))
        self.assertEqual(sp.remap_opcd_default([mesh])["objects"][0]["source"], "opcdDefault")
        self.assertEqual(set(_colours(mesh)), {GREEN})

    def test_remap_twice_maps_once(self):
        # BLRK maps black -> dirt (green) and green -> floor (blue): mapping twice would turn its dirt band to sand
        mesh = _obj("Spline_w_Bunker_-_Mesh", [RED, BLACK, GREEN, BLUE], pid="w")
        sp.remap_after_recipe([mesh], "blrk-bunker-simple-no-dig")
        once = _colours(mesh)
        self.assertIn(GREEN, once)
        res = sp.remap_after_recipe([mesh], "blrk-bunker-simple-no-dig")
        self.assertEqual(res["objects"][0]["source"], "skip")
        self.assertEqual(_colours(mesh), once)

    def test_unknown_recipe_leaves_paint(self):
        mesh = _obj("Spline_z_Bunker_-_Mesh", [RED, GREEN], pid="z")
        res = sp.remap_after_recipe([mesh], "not-a-recipe.json")
        self.assertTrue(res["warnings"])
        self.assertEqual(set(_colours(mesh)), {RED, GREEN})


if __name__ == "__main__":
    argv = [sys.argv[0]] + (sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:] if bpy is None else [])
    result = unittest.main(argv=argv, exit=bpy is None)
