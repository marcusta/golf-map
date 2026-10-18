"""Acceptance A1-A3: photo stems, the young trees the lidar missed on Omberg's open surfaces, found from
their shadows in the summer photo.

The ground truth is pipeline/tests/fixtures/photo-stems-omberg/rough-1-10/truth.json, marked by eye on the
2025 photo (each crown at the sun-side end of its shadow) and checked by Marcus:
- `missing`: 22 young trees with a shadow and no lidar stem (M1..M22)
- `matched`: the 18 lidar stems of the cut-out that cast their own shadow (heights from the 2022 lidar)
- `doubtful`: 3 dark spots that may or may not be a tree; nothing is asserted about them

    python -m golfpipe photo-stems --summer-ortho <2025 tif> --leaf-off-ortho <2023 tif>
        --stems <tree-stems.json> --features <features.json> --out <golfmap-photo-stems-v1 json>
"""
from __future__ import annotations

import json
import math
import statistics
import subprocess
import sys
from pathlib import Path

import pytest
from shapely.geometry import Point
from shapely.ops import unary_union

PIPELINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PIPELINE))
import gspro  # noqa: E402  (only to turn the app's stored outlines into polygons for the open-surface check)

FIXTURES = PIPELINE / "tests" / "fixtures" / "photo-stems-omberg"
OPEN_TYPES = {"rough", "semi_rough", "deep_rough", "fairway"}
CLOSED_TYPES = {"green", "tee", "bunker", "water", "water_creek", "path", "rock_slab", "tree_area"}


def find_photo_stems(cut: str, tmp_path_factory) -> dict:
    folder = FIXTURES / cut
    out = tmp_path_factory.mktemp(cut) / "photo-stems.json"
    proc = subprocess.run(
        [sys.executable, "-m", "golfpipe", "photo-stems",
         "--summer-ortho", str(folder / "ortho-orto-l2-2025.tif"),
         "--leaf-off-ortho", str(folder / "ortho-orto-l2-2023.tif"),
         "--stems", str(folder / "tree-stems.json"),
         "--features", str(folder / "features.json"),
         "--out", str(out)],
        cwd=PIPELINE, capture_output=True, text=True, timeout=600)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["format"] == "golfmap-photo-stems-v1"
    assert doc["crs"] == "EPSG:3006"
    return doc


@pytest.fixture(scope="module")
def rough(tmp_path_factory) -> dict:
    return find_photo_stems("rough-1-10", tmp_path_factory)


@pytest.fixture(scope="module")
def conifer(tmp_path_factory) -> dict:
    return find_photo_stems("lone-conifer", tmp_path_factory)


@pytest.fixture(scope="module")
def truth() -> dict:
    return json.loads((FIXTURES / "rough-1-10" / "truth.json").read_text(encoding="utf-8"))


def dist(a: dict, e: float, n: float) -> float:
    return math.hypot(a["x"] - e, a["y"] - n)


def pair_up(proposals: list[dict], marks: list[dict], within_m: float) -> dict[str, dict]:
    """Each marked tree to at most one proposal and back, nearest pairs first."""
    pairs = sorted((dist(p, m["e"], m["n"]), i, j)
                   for i, p in enumerate(proposals) for j, m in enumerate(marks))
    used_p, used_m, out = set(), set(), {}
    for d, i, j in pairs:
        if d > within_m or i in used_p or j in used_m:
            continue
        used_p.add(i)
        used_m.add(j)
        out[marks[j]["id"]] = proposals[i]
    return out


# --- A1: it finds the missing trees, and only on open grass ---------------------------------------

def test_a1_finds_at_least_90_percent_of_the_missing_young_trees(rough, truth):
    found = pair_up(rough["proposals"], truth["missing"], within_m=1.5)
    missed = sorted({m["id"] for m in truth["missing"]} - set(found))
    assert len(found) >= math.ceil(0.9 * len(truth["missing"])), f"missed {missed}"


def test_a1_at_most_three_proposals_are_not_a_marked_tree(rough, truth):
    marks = truth["missing"] + truth["doubtful"]
    found = pair_up(rough["proposals"], marks, within_m=1.5)
    hit = {id(p) for p in found.values()}
    extra = [(round(p["x"], 1), round(p["y"], 1)) for p in rough["proposals"] if id(p) not in hit]
    assert len(extra) <= 3, f"proposals on no marked tree: {extra}"


def test_a1_nothing_within_3_m_of_a_lidar_stem(rough):
    stems = json.loads((FIXTURES / "rough-1-10" / "tree-stems.json").read_text(encoding="utf-8"))["trees"]
    near = [(round(p["x"], 1), round(p["y"], 1)) for p in rough["proposals"]
            if any(math.hypot(p["x"] - s[0], p["y"] - s[1]) < 3.0 for s in stems)]
    assert near == []


def test_a1_nothing_outside_rough_semi_deep_rough_and_fairway(rough):
    rows = json.loads((FIXTURES / "rough-1-10" / "features.json").read_text(encoding="utf-8"))
    shapes = {}
    for r in rows:
        g = gspro._zone_geometry_m(r["geometry"])
        if g is not None and not g.is_empty:
            shapes.setdefault(r["type"], []).append(g)
    open_ground = unary_union([g for t in OPEN_TYPES for g in shapes.get(t, [])])
    closed = unary_union([g for t in CLOSED_TYPES for g in shapes.get(t, [])])
    outside = [(round(p["x"], 1), round(p["y"], 1)) for p in rough["proposals"]
               if not open_ground.contains(Point(p["x"], p["y"])) or closed.contains(Point(p["x"], p["y"]))]
    assert outside == []


# --- A2: sized like the lidar-matched young trees ---------------------------------------------------

def test_a2_a_lidar_trees_height_from_its_own_shadow_is_within_1_m_for_3_of_4(rough, truth):
    """Leave one out: each matched lidar stem's height read from its shadow with that stem left out of the
    calibration (`matched[].heightFromShadowM`), against its lidar height."""
    close, report = 0, []
    for m in truth["matched"]:
        hit = [r for r in rough["matched"] if math.hypot(r["x"] - m["e"], r["y"] - m["n"]) < 0.5]
        est = hit[0]["heightFromShadowM"] if hit else None
        report.append((m["heightM"], est))
        if est is not None and abs(est - m["heightM"]) <= 1.0:
            close += 1
    assert close >= math.ceil(0.75 * len(truth["matched"])), f"(lidar m, from shadow m): {report}"


def test_a2_proposals_are_sized_like_the_matched_lidar_trees(rough, truth):
    found = list(pair_up(rough["proposals"], truth["missing"], within_m=1.5).values())
    assert found, "no marked tree was proposed"
    lidar_h = statistics.median(m["heightM"] for m in truth["matched"])
    lidar_r = statistics.median(m["crownRadiusM"] for m in truth["matched"])
    assert abs(statistics.median(p["heightM"] for p in found) - lidar_h) <= 1.0
    assert abs(statistics.median(p["crownRadiusM"] for p in found) - lidar_r) <= 0.5


def test_a2_nothing_under_1_5_m_is_proposed(rough):
    low = [(round(p["x"], 1), round(p["y"], 1), p["heightM"]) for p in rough["proposals"] if p["heightM"] < 1.5]
    assert low == []


# --- A3: kind from the leaf-off photo -----------------------------------------------------------------

def test_a3_a_conifer_the_lidar_missed_is_green_in_the_leaf_off_photo_and_proposed_as_conifer(conifer):
    # The lone conifer's lidar stem (E 477354.5 N 6457191.5, 9.2 m) is left out of this cut-out's stems.
    near = [p for p in conifer["proposals"] if dist(p, 477354.5, 6457191.5) <= 2.0]
    assert len(near) == 1, conifer["proposals"]
    assert near[0]["kind"] == 1


def test_a3_bare_in_the_leaf_off_photo_is_never_a_conifer(rough, truth):
    found = pair_up(rough["proposals"], truth["missing"], within_m=1.5)
    conifers = [mid for mid, p in found.items() if p["kind"] == 1]
    assert conifers == []
    # M22's bare crown and branches show in the 2023 photo: a broadleaf.
    if "M22" in found:
        assert found["M22"]["kind"] == 0


def test_every_proposal_is_a_photo_stem_with_a_stable_epsg3006_id(rough):
    for p in rough["proposals"]:
        assert p["source"] == "ortho-shadow"
        assert p["id"] == f"epsg3006:{p['x']:.2f}:{p['y']:.2f}"
