"""Acceptance C3 (zone palettes on the model library): Vreta's lower vegetation is exactly what it was before.

Vreta stays on the old path: its grass-palette.json names prefabs and textures itself (no "model"), the
palette's "prefabItems" / "prefabItemsInVsp" and the species file's "species" map still decide who draws a
bush. This runs the Arborist writer's lower half on Vreta's own files with the arguments the app passes
(ArboristService.lower) into a scratch folder and compares the package with a golden recorded from the code
before the change (2026-10-21, commit 6de6e69 + the working tree of that day) with lower_digest.py. The Unity
half reads the same palette file, which must not change either.
Machine data (the GSPro course folder, the export folder's zones export, the Arborist key) is required.

  python -m pytest pipeline/tests/acceptance/test_vreta_lower_unchanged.py
  python pipeline/tests/acceptance/test_vreta_lower_unchanged.py --record     (only with Marcus's approval)
"""
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from lower_digest import lower_package_digest

REPO = Path(__file__).resolve().parents[3]
PIPELINE = REPO / "pipeline"
GOLDEN = Path(__file__).with_name("vreta-lower.golden.json")
DOCS = REPO / "docs" / "gspro" / "vreta"
COURSE_DIR = Path("C:/GSProV1/Core/GSP/Courses/Vreta_lidar_scene")
EXPORT_DIR = Path("D:/gspro_courses/vreta-opcd")


def write_vreta_lower(out: Path) -> Path:
    subprocess.run([sys.executable, str(PIPELINE / "arborist.py"), "lower",
                    "--course-dir", str(COURSE_DIR),
                    "--species", str(DOCS / "arborist-species.json"),
                    "--library", str(REPO / "data" / "arborist" / "GolfMap library.biome"),
                    "--palette", str(DOCS / "grass-palette.json"),
                    "--zones", str(EXPORT_DIR / "vreta-inner-zones.json"),
                    "--out-dir", str(out)],
                   check=True, cwd=PIPELINE, capture_output=True, text=True)
    return out / "arboristdata.dat"


def palette_sha() -> str:
    return hashlib.sha256((DOCS / "grass-palette.json").read_bytes()).hexdigest()


def test_vreta_lower_vegetation_is_unchanged(tmp_path):
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    # The palette Unity's golfmap.grass.apply and the Arborist writer both read is Vreta's old one, untouched.
    assert palette_sha() == golden["paletteSha256"], "Vreta's grass-palette.json changed"
    now = lower_package_digest(write_vreta_lower(tmp_path))
    assert sorted(now["items"]) == sorted(golden["items"]), "the lower-vegetation items Vreta's Arborist file holds changed"
    changed = sorted(name for name in golden["items"] if now["items"][name] != golden["items"][name])
    assert not changed, f"{len(changed)} of {len(golden['items'])} items differ: {changed[:10]}"
    assert now["maskGroups"] == golden["maskGroups"]


if __name__ == "__main__" and "--record" in sys.argv:
    with tempfile.TemporaryDirectory() as tmp:
        digest = lower_package_digest(write_vreta_lower(Path(tmp)))
    GOLDEN.write_text(json.dumps({"recorded": "2026-10-21, commit 6de6e69 + working tree", "paletteSha256": palette_sha(), **digest},
                                 indent=1) + "\n", encoding="utf-8")
    print(f"recorded {len(digest['items'])} items, {len(digest['maskGroups'])} mask groups into {GOLDEN}")
