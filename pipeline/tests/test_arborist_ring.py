"""arborist.py: the distance rules that decide who draws a tree (FarRule, ForstRing)."""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import arborist  # noqa: E402

RING = {"playM": 15, "minM": {"PF Birch": 30},
        "replace": {"PF_Oak_tall Terrain": "Oak__tall", "PF_Oak_tall_bare": "CE_Oak-Tall-Thin", "PF_Oak": "Oak__big", "PF Birch": "S7_European_White_Birch@tint=#527e4b"}}


def test_ring_radius_is_the_widest_that_applies():
    ring = arborist.ForstRing(RING)
    assert ring.radius("PF_Oak_big Terrain") == 15
    assert ring.radius("PF Birch C wide") == 30
    assert arborist.ForstRing(dict(RING, playM=45)).radius("PF Birch C wide") == 45


def test_ring_target_whole_name_then_longest_part():
    ring = arborist.ForstRing(RING)
    assert ring.target("PF_Oak_tall Terrain") == "Oak__tall"
    assert ring.target("PF_Oak_tall_bare Terrain") == "CE_Oak-Tall-Thin"
    assert ring.target("PF_Oak_small Terrain") == "Oak__big"
    assert ring.target("PF Birch A large 1") == "S7_European_White_Birch@tint=#527e4b"
    assert ring.target("Fir_02_S") is None


def test_ring_replaces_only_beyond_the_radius_and_only_mapped_prefabs():
    ring = arborist.ForstRing(RING)
    assert not ring.replaced("PF_Oak_big Terrain", 0)
    assert not ring.replaced("PF_Oak_big Terrain", 15)
    assert ring.replaced("PF_Oak_big Terrain", 15.5)
    assert not ring.replaced("PF Birch C wide", 29)      # the birch ring is max(playM, its minM)
    assert ring.replaced("PF Birch C wide", 31)
    assert not arborist.ForstRing({"playM": 15}).replaced("PF_Oak_big Terrain", 60)   # nothing to replace it with


@pytest.fixture()
def rule(tmp_path):
    """A 200 m square map at 0.5 m: a fairway strip x 90..110, deep rough everywhere else; the course boundary is
    the square from (20, 20) to (180, 180)."""
    cell, side = 0.5, 400
    classes = np.full((side, side), 2, np.uint8)
    classes[:, 180:220] = 1
    classes.tofile(tmp_path / "s.bin")
    (tmp_path / "s.json").write_text(json.dumps({"classes": {"1": "fairway", "2": "deep_rough"}, "cellM": cell, "data": "s.bin",
                                                 "width": side, "height": side, "worldOrigin": [0, 0]}), encoding="utf-8")
    (tmp_path / "c.GKD").write_text(json.dumps({"pOOB": {"coords": [{"x": 20, "z": 20}, {"x": 180, "z": 20}, {"x": 180, "z": 180}, {"x": 20, "z": 180}]}}), encoding="utf-8")
    return arborist.FarRule(tmp_path / "s.json", tmp_path / "c.GKD", (0, 0, 200, 200), outside_m=10, play_m=60)


def test_from_play_is_the_distance_to_the_playing_field(rule):
    assert rule.from_play(100, 100) == 0
    assert rule.from_play(70.5, 100) == pytest.approx(20, abs=1.01)
    assert rule.from_play(140.5, 50) == pytest.approx(31, abs=1.01)


def test_ring_and_far_rule_split_the_trees_three_ways(rule):
    ring = arborist.ForstRing(RING)

    def who(x):
        if rule.far(x, 100):
            return "billboard"
        return "arborist" if ring.replaced("PF_Oak_big Terrain", rule.from_play(x, 100)) else "course"

    # 175.5 is 65 m from the play but inside the boundary, 195.5 is 15 m outside it and 85 m from the play
    assert [who(x) for x in (100.5, 120.5, 135.5, 160.5, 175.5, 195.5)] == ["course", "course", "arborist", "arborist", "arborist", "billboard"]


def test_billboard_only_when_far_from_both_the_boundary_and_the_play(rule):
    assert not rule.far(175.5, 100)    # in bounds, 65 m from the play: a player can stand there
    assert not rule.far(185.5, 100)    # 5 m outside the boundary, 75 m from the play
    assert not rule.far(100, 5)      # 15 m outside the boundary but on the fairway (a driving range out of bounds)
    assert not rule.far(165, 5)        # 15 m outside, 55 m from the fairway
    assert rule.far(195.5, 100)        # 15 m outside, 85 m from the fairway
