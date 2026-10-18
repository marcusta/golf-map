"""Tests for shape_opkey: the op cache's per-op code keys (plain Python: `python blender/tools/shape_opkey_test.py`).

Every test works on a temp copy of blender/tools/*.py (the real files are only read): it edits shape_apply.py or
a sibling there and compares the op kinds' code keys before and after.
"""

import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import shape_opkey as ok  # noqa: E402

SOURCES = {f: open(os.path.join(HERE, f), encoding="utf-8").read()
           for f in os.listdir(HERE) if f.endswith(".py")}
CUT, KERB = "golfmap.cut_out", "golfmap.path_kerb"


def edit(src, old, new):
    assert src.count(old) == 1, f"anchor {old!r} found {src.count(old)} times"
    return src.replace(old, new)


def closures(edits=None):
    """{kind: closure record} of a temp copy of the tools folder with edits {file: (old, new) or [(old, new)...]}."""
    d = tempfile.mkdtemp(prefix="opkey-")
    try:
        for f, src in SOURCES.items():
            for old, new in _pairs((edits or {}).get(f)):
                src = edit(src, old, new)
            with open(os.path.join(d, f), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(src)
        g = ok.Graph(os.path.join(d, "shape_apply.py"))
        return {k: g.closure(k) for k in g.kinds()}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _pairs(e):
    if e is None:
        return []
    return [e] if isinstance(e[0], str) else list(e)


BASE = closures()


def changed(after):
    return {k for k in BASE if BASE[k]["key"] != after[k]["key"]}


class KindKeys(unittest.TestCase):
    def test_a_kerb_only_function_leaves_cut_out_alone(self):
        after = closures({"shape_apply.py": ("def _kerb_cut(pieces, lines):", "def _kerb_cut(pieces, lines, _probe=None):")})
        self.assertIn(KERB, changed(after))
        self.assertNotIn(CUT, changed(after))
        self.assertEqual(changed(after), {KERB})

    def test_a_kerb_only_constant_and_planner_leave_cut_out_alone(self):
        for old, new in (("KERB_SLIVER_M = 0.008", "KERB_SLIVER_M = 0.009"),
                         ("def plan_path_kerb(ctx, op):", "def plan_path_kerb(ctx, op, _probe=None):")):
            after = closures({"shape_apply.py": (old, new)})
            self.assertEqual(changed(after), {KERB}, old)

    def test_a_kerb_module_edit_leaves_cut_out_alone(self):
        # shape_layers imports shape_kerb (layer validation), so a whole-file sibling sha would reach every op
        after = closures({"shape_kerb.py": ("def validate_params(op):", "def validate_params(op, _probe=None):")})
        self.assertNotIn(CUT, changed(after))
        after = closures({"shape_kerb.py": ("def profile(t):", "def profile(t, _probe=None):")})
        self.assertEqual(changed(after), {KERB})

    def test_b_helpers_cut_out_runs_change_its_key(self):
        for old, new in (("def weld_tjunctions(names, tol=1e-3):", "def weld_tjunctions(names, tol=1e-3, _probe=None):"),
                         ("def _rise_set_z(o, co, new_z, moved, slab):", "def _rise_set_z(o, co, new_z, moved, slab, _probe=None):"),
                         ("def rock_rise(ctx, op, slab, poly):", "def rock_rise(ctx, op, slab, poly, _probe=None):"),
                         ("def _weld_neighbours(objs, boxes, name, own, pad=0.5):",
                          "def _weld_neighbours(objs, boxes, name, own, pad=0.5, _probe=None):")):
            after = closures({"shape_apply.py": (old, new)})
            self.assertIn(CUT, changed(after), old)

    def test_b_sibling_function_cut_out_runs(self):
        # cut_out's rise noise comes from shape_edgefade.value_noise; the edge-fade maths elsewhere does not reach it
        after = closures({"shape_edgefade.py": ("def value_noise(x, y, seed):", "def value_noise(x, y, seed, _probe=None):")})
        self.assertIn(CUT, changed(after))
        self.assertNotIn("afrod.flattentees", changed(after))

    def test_c_constants_cut_out_reads_change_its_key(self):
        for old, new in (("CUT_OUT_WELD_M = 1e-3", "CUT_OUT_WELD_M = 2e-3"),
                         ("RISE_DEFAULTS = {\"footM\": 0.35", "RISE_DEFAULTS = {\"footM\": 0.36"),
                         ("TERRACE_RISER = 0.35", "TERRACE_RISER = 0.36"),
                         ("RISE_DEM_DEFAULTS.update(RISE_DEM_SHAPE)", "RISE_DEM_DEFAULTS.update(RISE_DEM_SHAPE, x=1)")):
            after = closures({"shape_apply.py": (old, new)})
            self.assertIn(CUT, changed(after), old)

    def test_d_every_kind_resolves(self):
        planners = ok.Graph(os.path.join(HERE, "shape_apply.py")).root.tables.get("PLANNERS", {})
        for kind, c in BASE.items():
            self.assertIsNone(c["wholeFile"], kind)
            self.assertEqual(c["problems"], [], kind)
            self.assertEqual(c["wholeModules"], {}, kind)
            self.assertIn(kind, planners)
            self.assertGreater(c["functions"], 10, kind)
            # naming the dispatch table (or another kind's runner) would put every op's code into this key
            self.assertFalse([n for n in c["names"]["shape_apply"] if n.startswith("RUNNERS")], kind)
            self.assertNotIn("op_path_kerb" if kind != KERB else "op_cut_out", c["names"]["shape_apply"], kind)
        self.assertEqual(set(BASE), set(planners))

    def test_e_framework_edit_changes_every_key(self):
        for old, new in (("class OpCache:", "class OpCache:\n    _probe = None\n"),
                         ("def state_hash(meta, arrays):", "def state_hash(meta, arrays, _probe=None):"),
                         ("def capture_state(obj):", "def capture_state(obj, _probe=None):"),
                         ("class Unit:", "class Unit:\n    _probe = None\n")):
            after = closures({"shape_apply.py": (old, new)})
            self.assertEqual(changed(after), set(BASE), old)

    def test_comments_outside_reached_code_change_nothing(self):
        after = closures({"shape_apply.py": ("def op_key(layer, op):", "# a comment\n\n\ndef op_key(layer, op):")})
        self.assertEqual(changed(after), set())


class Conservative(unittest.TestCase):
    def test_unresolved_name_falls_back_to_the_whole_file(self):
        after = closures({"shape_apply.py": ("def cut_out_name(op):\n", "def cut_out_name(op):\n    NOT_DEFINED_ANYWHERE\n")})
        self.assertTrue(after[CUT]["wholeFile"])
        self.assertIn("unresolved name NOT_DEFINED_ANYWHERE", after[CUT]["wholeFile"])
        self.assertIsNone(after[KERB]["wholeFile"])
        # a whole-file key then changes with any edit of the file
        again = closures({"shape_apply.py": [("def cut_out_name(op):\n", "def cut_out_name(op):\n    NOT_DEFINED_ANYWHERE\n"),
                                             ("KERB_SLIVER_M = 0.008", "KERB_SLIVER_M = 0.009")]})
        self.assertNotEqual(after[CUT]["key"], again[CUT]["key"])

    def test_dynamic_lookup_falls_back(self):
        for line in ("globals()['weld_tjunctions']", "getattr(sys.modules[__name__], 'x')", "eval('1')"):
            after = closures({"shape_apply.py": ("def cut_out_name(op):\n", "def cut_out_name(op):\n    %s\n" % line)})
            self.assertTrue(after[CUT]["wholeFile"], line)

    def test_kind_table_used_another_way_follows_every_planner(self):
        after = closures({"shape_apply.py": ("        run = ctx.runner.run(ctx, op, unit, lambda: cut_out(ctx, op))",
                                             "        run = ctx.runner.run(ctx, op, unit, lambda: cut_out(ctx, op))\n"
                                             "        plan_units(ctx, dict(op, op='afrod.recipe'))")})
        self.assertTrue(any("every PLANNERS entry followed" in p for p in after[CUT]["problems"]))
        again = closures({"shape_apply.py": [("        run = ctx.runner.run(ctx, op, unit, lambda: cut_out(ctx, op))",
                                              "        run = ctx.runner.run(ctx, op, unit, lambda: cut_out(ctx, op))\n"
                                              "        plan_units(ctx, dict(op, op='afrod.recipe'))"),
                                             ("def plan_path_kerb(ctx, op):", "def plan_path_kerb(ctx, op, _probe=None):")]})
        self.assertNotEqual(after[CUT]["key"], again[CUT]["key"])

    def test_a_function_that_rebinds_a_global_is_part_of_its_readers(self):
        after = closures({"shape_apply.py": ("def op_key(layer, op):",
                                             "def _set_weld(v):\n    global CUT_OUT_WELD_M\n    CUT_OUT_WELD_M = v\n\n\n"
                                             "def op_key(layer, op):")})
        self.assertIn(CUT, changed(after))
        self.assertNotIn(KERB, changed(after))

    def test_module_object_passed_on_takes_the_whole_sibling(self):
        after = closures({"shape_apply.py": ("def cut_out_name(op):\n", "def cut_out_name(op):\n    print(sl)\n")})
        self.assertIn("shape_layers", after[CUT]["wholeModules"])
        self.assertEqual(after[CUT]["modules"]["shape_layers"], "whole")

    def test_cheap(self):
        import time
        t = time.time()
        g = ok.Graph(os.path.join(HERE, "shape_apply.py"))
        for k in g.kinds():
            g.closure(k)
        self.assertLess(time.time() - t, 1.0)


if __name__ == "__main__":
    for k, c in sorted(BASE.items()):
        print("%-26s %s %3d functions %2d classes %5d lines  %s" % (
            k, c["key"][:12], c["functions"], c["classes"], c["lines"],
            " ".join("%s:%s" % (m, v) for m, v in c["modules"].items() if m != "shape_apply")))
    unittest.main()
