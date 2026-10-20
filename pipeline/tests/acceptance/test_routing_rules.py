"""Acceptance B2 (model library, second delivery): the course's routing rules decide, per tree id and before
planting, whether a tree is drawn by its own model's renderer ("own"), is an Arborist billboard ("billboard")
or is left out ("out"). Tree edits apply first, so a tree moved far out is routed as far out.

  arborist.py route --trees <unity-trees-v1> [--edits <tree-edits>] --surfaces <surfaces.json> --gkd <course.GKD>
                    --terrains-square x0 z0 x1 z1 --rules <vegetation-rules.json> --out <routing.json> [--dry-run]

The map is the far-rule tests' (test_arborist_ring.py): a 200 m square, a fairway strip x 90..110, deep rough
elsewhere, the course boundary the square (20, 20)-(180, 180).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

PIPELINE = Path(__file__).resolve().parents[2]


def _map(tmp: Path) -> None:
    cell, side = 0.5, 400
    classes = np.full((side, side), 2, np.uint8)
    classes[:, 180:220] = 1
    classes.tofile(tmp / "s.bin")
    (tmp / "s.json").write_text(json.dumps({"classes": {"1": "fairway", "2": "deep_rough"}, "cellM": cell, "data": "s.bin",
                                           "width": side, "height": side, "worldOrigin": [0, 0]}), encoding="utf-8")
    (tmp / "c.GKD").write_text(json.dumps({"pOOB": {"coords": [{"x": 20, "z": 20}, {"x": 180, "z": 20}, {"x": 180, "z": 180}, {"x": 20, "z": 180}]}}), encoding="utf-8")


def _trees(tmp: Path, stems: list[tuple[str, float, float]]) -> Path:
    path = tmp / "trees.json"
    path.write_text(json.dumps({"format": "unity-trees-v1", "plot": {"crs": "EPSG:3006", "terrain": "inner", "originX": 0, "originY": 0, "sizeM": 200, "minM": 0, "maxM": 10},
                                "trees": [{"id": i, "x": x, "z": z, "h": 18.0, "r": 6.0, "g": 1.0, "k": 0, "bush": False} for i, x, z in stems]}), encoding="utf-8")
    return path


def _rules(tmp: Path, routing: dict) -> Path:
    path = tmp / "vegetation-rules.json"
    path.write_text(json.dumps({"format": "golfmap-vegetation-rules-v1", "routing": routing, "generators": {}}), encoding="utf-8")
    return path


def _route(tmp: Path, trees: Path, rules: Path, *extra: str) -> dict:
    out = tmp / "routing.json"
    subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "route", "--trees", str(trees), "--surfaces", str(tmp / "s.json"),
                    "--gkd", str(tmp / "c.GKD"), "--terrains-square", "0", "0", "200", "200", "--rules", str(rules), "--out", str(out), *extra],
                   check=True, cwd=PIPELINE, capture_output=True, text=True)
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["format"] == "golfmap-routing-v1"
    return doc["routes"]


def test_far_oak_is_a_billboard_near_oak_stays_own_and_the_rules_move_the_line(tmp_path):
    _map(tmp_path)
    # 195.5 is 15.5 m outside the boundary and 85.5 m from the fairway; 120.5 is inside, 10.5 m from it
    trees = _trees(tmp_path, [("far", 195.5, 100.0), ("near", 120.5, 100.0)])

    routes = _route(tmp_path, trees, _rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 60}}))
    assert routes == {"far": "billboard", "near": "own"}

    routes = _route(tmp_path, trees, _rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 200}}))
    assert routes == {"far": "own", "near": "own"}


def test_outer_keep_thins_the_far_row_the_same_way_every_run(tmp_path):
    _map(tmp_path)
    row = [(f"r{i:02d}", 195.5, 30.0 + 5 * i) for i in range(20)]     # 20 far trees, all outside and 85.5 m from play
    trees = _trees(tmp_path, row)
    rules = _rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 60}, "outerKeep": [[None, 0.5]]})

    first = _route(tmp_path, trees, rules)
    assert set(first.values()) <= {"billboard", "out"}
    assert 4 <= list(first.values()).count("out") <= 16            # about half, by position
    assert _route(tmp_path, trees, rules) == first                  # the same trees every run


def test_a_tree_edit_moving_a_tree_far_out_is_routed_from_its_new_place(tmp_path):
    _map(tmp_path)
    trees = _trees(tmp_path, [("moved", 120.5, 100.0)])
    edits = tmp_path / "edits.json"
    edits.write_text(json.dumps({"format": "golfmap-tree-edits-v1", "trees": "trees.json",
                                 "edits": [{"id": "moved", "op": "modify", "x": 195.5, "z": 100.0, "ox": 120.5, "oz": 100.0}]}), encoding="utf-8")
    routes = _route(tmp_path, trees, _rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 60}}), "--edits", str(edits))
    assert routes == {"moved": "billboard"}


def test_dry_run_writes_nothing(tmp_path):
    _map(tmp_path)
    trees = _trees(tmp_path, [("a", 120.5, 100.0)])
    out = tmp_path / "routing.json"
    proc = subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "route", "--trees", str(trees), "--surfaces", str(tmp_path / "s.json"),
                           "--gkd", str(tmp_path / "c.GKD"), "--terrains-square", "0", "0", "200", "200",
                           "--rules", str(_rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 60}})), "--out", str(out), "--dry-run"],
                          cwd=PIPELINE, capture_output=True, text=True)
    assert proc.returncode == 0
    assert "own 1, billboard 0, left out 0" in proc.stdout
    assert not out.exists()
