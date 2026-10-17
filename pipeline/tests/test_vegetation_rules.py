"""pipeline/vegetation_rules.py: the generators' rules files, a course's overrides of them."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

import vegetation_rules

PIPELINE = Path(__file__).resolve().parent.parent
SOURCES = sorted(p.stem for p in vegetation_rules.RULES_DIR.glob("*.json"))


def test_every_rules_file_reads_and_its_keys_are_unique():
    assert {"tall-grass", "woodland-floor", "rock-shore", "creek-bank", "arborist", "tree-palette"} <= set(SOURCES)
    for source in SOURCES:
        keys = [r["key"] for r in vegetation_rules.rules_of(vegetation_rules.read(source))]
        assert len(keys) == len(set(keys)), source
        assert all(r.get("text") for r in vegetation_rules.rules_of(vegetation_rules.read(source))), source


def test_lists_come_back_as_tuples_and_a_course_value_replaces_the_default():
    r = vegetation_rules.load("tall-grass", overrides={})
    assert r["band-levels"] == (0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.97)
    assert r["clearances"][0] == {"surfaces": ("tee", "green"), "clear": 4.0, "ramp": 4.0}
    assert vegetation_rules.load("tall-grass", overrides={"tall-grass": {"verge-cover": 0.5}, "creek-bank": {"cover": 0.1}})["verge-cover"] == 0.5


def test_an_unknown_rule_stops_the_run():
    with pytest.raises(SystemExit, match="'tall-grass' has no rule 'verge-covr'"):
        vegetation_rules.load("tall-grass", overrides={"tall-grass": {"verge-covr": 0.5}})


def test_the_command_lines_overrides_reach_the_constants_of_every_script_that_imports_them():
    # rock_shore_zones takes the tall rough's clearances: the course's value is there too.
    overrides = json.dumps({"tall-grass": {"clearances": [{"surfaces": ["tee"], "clear": 9.0, "ramp": 1.0}]}})
    code = "import rock_shore_zones, grass_zones; print(grass_zones.CLEARANCES, rock_shore_zones.PLAY_CLEARANCES)"
    out = subprocess.run([sys.executable, "-c", code, "--rule-overrides", overrides], cwd=PIPELINE,
                         capture_output=True, text=True, check=True).stdout
    assert out.strip() == "(((6,), 9.0, 1.0),) (((6,), 9.0, 1.0),)"
