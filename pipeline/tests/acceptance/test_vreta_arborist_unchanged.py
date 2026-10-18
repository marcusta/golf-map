"""Acceptance A4 (Arborist half): Vreta's Arborist trees are exactly what they were before the model library.

Vreta has no placements file until it is replanted in its own editor, so this runs the Arborist writer on
the planted-trees dump Unity wrote on 2026-10-15 (data/arborist/vreta-planted-trees.json), with the same
arguments the app passes (ArboristService.trees), into a scratch folder. The golden was recorded from the
code before the change (2026-10-18, commit 461e428 + the working tree of that day) with digest.py.
Machine data (the GSPro course folder, the export folder, the Arborist key) is required, not optional.
"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from digest import trees_package_digest

REPO = Path(__file__).resolve().parents[3]
PIPELINE = REPO / "pipeline"
GOLDEN = Path(__file__).with_name("vreta-arborist-trees.golden.json")
COURSE_DIR = Path("C:/GSProV1/Core/GSP/Courses/Vreta_lidar_scene")
EXPORT_DIR = Path("D:/gspro_courses/vreta-opcd")
SQUARE = ["-1475", "-1475", "3525", "3525"]


def write_vreta_trees(out: Path) -> Path:
    planted = out / "vreta-planted-trees.json"   # a copy: the writer puts its vsp-far list beside it
    shutil.copy(REPO / "data" / "arborist" / "vreta-planted-trees.json", planted)
    subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "trees",
                    "--course-dir", str(COURSE_DIR),
                    "--species", str(REPO / "docs" / "gspro" / "vreta" / "arborist-species.json"),
                    "--planted", str(planted),
                    "--sizes", str(REPO / "data" / "arborist" / "catalog-sizes.json"),
                    "--terrains-square", *SQUARE,
                    "--surfaces", str(EXPORT_DIR / "vreta-inner-surfaces.json"),
                    "--stems", str(EXPORT_DIR / "vreta-inner-trees.json"),
                    "--palette", str(REPO / "docs" / "gspro" / "vreta" / "palette.json"),
                    "--out-dir", str(out)],
                   check=True, cwd=PIPELINE, capture_output=True, text=True)
    return out / "arboristdata.dat"


def test_vreta_arborist_trees_are_unchanged(tmp_path):
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    now = trees_package_digest(write_vreta_trees(tmp_path))
    assert sorted(now) == sorted(golden["items"]), "the Arborist items Vreta's trees use changed"
    changed = {name: {"was": golden["items"][name], "now": now[name]} for name in golden["items"] if now[name] != golden["items"][name]}
    assert not changed, f"{len(changed)} of {len(golden['items'])} Arborist items differ: {sorted(changed)[:10]}"
    # The VSP side's list of trees Arborist draws instead (golfmap.vsp.trees.trim) is unchanged too.
    assert vsp_far_digest(tmp_path / "vreta-vsp-far.json") == golden["vspFar"]


def vsp_far_digest(path: Path) -> dict:
    positions = sorted(f"{x:.3f},{z:.3f}" for x, z in json.loads(path.read_text(encoding="utf-8"))["positions"])
    return {"count": len(positions), "sha256": hashlib.sha256("\n".join(positions).encode("utf-8")).hexdigest()}
