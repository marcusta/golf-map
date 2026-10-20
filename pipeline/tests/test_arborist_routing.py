"""arborist.py route --ids (the edit loop routes only the trees an edit touched) and the one rule for a routed
course in `trees` (--routing needs --rules, and the routing must be the rules' own). The map is the acceptance
test's (tests/acceptance/test_routing_rules.py): a 200 m square, a fairway strip x 90..110, the boundary
(20, 20)-(180, 180)."""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

PIPELINE = Path(__file__).resolve().parents[1]
FAR = {"farBillboard": {"outsideOob": 10, "fromPlay": 60}}


def _map(tmp: Path) -> None:
    classes = np.full((400, 400), 2, np.uint8)
    classes[:, 180:220] = 1
    classes.tofile(tmp / "s.bin")
    (tmp / "s.json").write_text(json.dumps({"classes": {"1": "fairway", "2": "deep_rough"}, "cellM": 0.5, "data": "s.bin",
                                           "width": 400, "height": 400, "worldOrigin": [0, 0]}), encoding="utf-8")
    (tmp / "c.GKD").write_text(json.dumps({"pOOB": {"coords": [{"x": 20, "z": 20}, {"x": 180, "z": 20}, {"x": 180, "z": 180}, {"x": 20, "z": 180}]}}), encoding="utf-8")


def _write(path: Path, doc: dict) -> Path:
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def _trees(tmp: Path, stems: list[tuple[str, float, float]]) -> Path:
    return _write(tmp / "trees.json", {"format": "unity-trees-v1", "trees": [{"id": i, "x": x, "z": z, "h": 18.0, "r": 6.0, "k": 0} for i, x, z in stems]})


def _edits(tmp: Path, edits: list[dict]) -> Path:
    return _write(tmp / "edits.json", {"format": "golfmap-tree-edits-v1", "trees": "trees.json", "edits": edits})


def _rules(tmp: Path, routing: dict) -> Path:
    return _write(tmp / "vegetation-rules.json", {"format": "golfmap-vegetation-rules-v1", "routing": routing})


def _route(tmp: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "route", "--trees", str(tmp / "trees.json"),
                           "--surfaces", str(tmp / "s.json"), "--gkd", str(tmp / "c.GKD"), "--terrains-square", "0", "0", "200", "200",
                           "--rules", str(tmp / "vegetation-rules.json"), "--out", str(tmp / "routing.json"), *extra],
                          check=True, cwd=PIPELINE, capture_output=True, text=True)


def _routes(tmp: Path) -> dict:
    return json.loads((tmp / "routing.json").read_text(encoding="utf-8"))["routes"]


def test_ids_route_only_the_edited_trees_and_keep_the_rest(tmp_path):
    _map(tmp_path)
    _trees(tmp_path, [("moved", 120.5, 100.0), ("gone", 125.5, 100.0), ("kept", 130.5, 100.0)])
    _rules(tmp_path, FAR)
    _route(tmp_path)
    assert _routes(tmp_path) == {"moved": "own", "gone": "own", "kept": "own"}

    # Unity's last planting stored "kept" by this routing: an edit elsewhere must not change it, whatever it is.
    doc = json.loads((tmp_path / "routing.json").read_text(encoding="utf-8"))
    doc["routes"]["kept"] = "billboard"
    _write(tmp_path / "routing.json", doc)
    edits = _edits(tmp_path, [{"id": "moved", "op": "modify", "x": 195.5, "z": 100.0, "ox": 120.5, "oz": 100.0, "h": 18, "r": 6},
                              {"id": "gone", "op": "delete", "ox": 125.5, "oz": 100.0},
                              {"id": "manual:new", "op": "add", "x": 195.5, "z": 120.0, "h": 18, "r": 6}])
    out = _route(tmp_path, "--edits", str(edits), "--ids", "moved", "gone", "manual:new", "--json")
    assert _routes(tmp_path) == {"moved": "billboard", "kept": "billboard", "manual:new": "billboard"}
    assert json.loads(out.stdout.strip().splitlines()[-1])["counts"] == {"own": 0, "billboard": 3, "out": 0}
    assert "routed again" in out.stdout


def test_ids_route_every_tree_when_the_rules_changed(tmp_path):
    _map(tmp_path)
    _trees(tmp_path, [("a", 195.5, 100.0), ("b", 195.5, 120.0)])
    _rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 200}})
    _route(tmp_path)
    assert _routes(tmp_path) == {"a": "own", "b": "own"}
    _rules(tmp_path, FAR)
    out = _route(tmp_path, "--ids", "a")
    assert _routes(tmp_path) == {"a": "billboard", "b": "billboard"}
    assert "routing every tree" in out.stdout


def test_ids_write_where_out_says_and_leave_from_alone(tmp_path):
    _map(tmp_path)
    _trees(tmp_path, [("a", 120.5, 100.0)])
    _rules(tmp_path, FAR)
    _route(tmp_path)
    before = (tmp_path / "routing.json").read_bytes()
    staged = tmp_path / "staged.json"
    edits = _edits(tmp_path, [{"id": "a", "op": "modify", "x": 195.5, "z": 100.0, "ox": 120.5, "oz": 100.0, "h": 18, "r": 6}])
    subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "route", "--trees", str(tmp_path / "trees.json"), "--edits", str(edits),
                    "--surfaces", str(tmp_path / "s.json"), "--gkd", str(tmp_path / "c.GKD"), "--terrains-square", "0", "0", "200", "200",
                    "--rules", str(tmp_path / "vegetation-rules.json"), "--ids", "a", "--from", str(tmp_path / "routing.json"), "--out", str(staged)],
                   check=True, cwd=PIPELINE, capture_output=True, text=True)
    assert (tmp_path / "routing.json").read_bytes() == before
    assert json.loads(staged.read_text(encoding="utf-8"))["routes"] == {"a": "billboard"}


def _trees_command(tmp: Path, *extra: str) -> subprocess.CompletedProcess:
    # Refused before any input is read: the paths need not exist.
    return subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "trees", "--course-dir", str(tmp), "--planted", str(tmp / "p.json"),
                           "--sizes", str(tmp / "sizes.json"), "--species", str(tmp / "species.json"), "--terrains-square", "0", "0", "200", "200", *extra],
                          cwd=PIPELINE, capture_output=True, text=True)


def test_trees_refuses_routing_without_rules_and_rules_without_routing(tmp_path):
    _map(tmp_path)
    _trees(tmp_path, [("a", 120.5, 100.0)])
    _rules(tmp_path, FAR)
    _route(tmp_path)
    alone = _trees_command(tmp_path, "--routing", str(tmp_path / "routing.json"))
    assert alone.returncode != 0 and "--routing needs --rules" in alone.stderr
    rules_only = _trees_command(tmp_path, "--rules", str(tmp_path / "vegetation-rules.json"))
    assert rules_only.returncode != 0 and "--rules goes with --routing" in rules_only.stderr


def test_trees_refuses_a_routing_made_with_other_rules(tmp_path):
    _map(tmp_path)
    _trees(tmp_path, [("a", 120.5, 100.0)])
    _rules(tmp_path, FAR)
    _route(tmp_path)
    _rules(tmp_path, {"farBillboard": {"outsideOob": 10, "fromPlay": 80}})
    stale = _trees_command(tmp_path, "--routing", str(tmp_path / "routing.json"), "--rules", str(tmp_path / "vegetation-rules.json"))
    assert stale.returncode != 0 and "routed with other rules" in stale.stderr
