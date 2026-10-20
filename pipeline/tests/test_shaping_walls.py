"""shaping_walls: docs/gspro/<course>/stone-walls.json -> shaping/80-walls.gen.json (golfmap.wall_ground ops).

Real files in tmp_path; the ops are checked with the Blender op's own validation (blender/tools/shape_wallground.py,
pure Python) and, once shape_layers knows the op, the layer validation."""

import json
import sys
from pathlib import Path

import pytest

import shaping_walls as sw

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "blender" / "tools"))
import shape_layers  # noqa: E402
import shape_wallground  # noqa: E402

TOE = [[477591.42, 6457801.18], [477592.0, 6457803.0], [477593.0, 6457805.0]]
LIP = [[477592.27, 6457801.13], [477593.0, 6457803.2], [477594.0, 6457805.1]]


def _spec(**over):
    spec = {
        "format": "golfmap-walls-v1",
        "defaults": {"style": "rose", "ground": True, "faceDeg": 55, "baseInM": 0.1, "beyondM": 0.4, "taperM": 1.2,
                     "subdivideM": 0.3, "groundChannel": "blue", "stoneAlbedo": "Assets/Rock.tif", "paintFeatherM": 0.2,
                     "minFaceM": 0.2},
        "styles": {
            "teewall": {"style": "wall", "faceDeg": 86, "baseInM": 0.05, "beyondM": 1.2},
            "wall": {"faceDeg": 80, "baseInM": 0.05, "beyondM": 1.2},
            "rose": {},
            "cliff": {"faceDeg": 70, "jitterDeg": 10, "beyondM": 1.0, "taperM": 2.5, "roundTopM": 0.4},
        },
        "walls": [
            {"id": "tee", "seed": 1601, "style": "teewall", "toe": TOE, "lip": LIP, "note": "the tee's front"},
            {"id": "own", "style": "wall", "faceDeg": 75, "toe": TOE, "lip": LIP},
            {"id": "plain", "toe": TOE, "lip": LIP},
            {"id": "off", "ground": False, "toe": TOE, "lip": LIP},
            {"id": "klippa", "style": "cliff", "toe": TOE, "lip": LIP, "paintOnly": True, "paintInsetM": 0.8,
             "outline": [TOE[0], TOE[2], LIP[2], LIP[0]], "grassPatches": [[477592.5, 6457803.0, 0.6], [477593.0, 6457804.0, 0.5, 0.7]]},
        ],
    }
    spec.update(over)
    return spec


def _write(tmp_path, spec):
    course = tmp_path / "docs" / "gspro" / "testbana"
    course.mkdir(parents=True)
    (course / "stone-walls.json").write_text(json.dumps(spec), encoding="utf-8")
    return course


def test_ops_merge_defaults_style_wall_like_unity(tmp_path):
    course = _write(tmp_path, _spec())
    out = sw.write_shaping_walls(course)
    assert out == course / "shaping" / "80-walls.gen.json"
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["format"] == "golfmap-shaping-layer-v1" and doc["id"] == "walls" and doc["generated"] is True
    assert doc["source"] == "docs/gspro/testbana/stone-walls.json"
    ops = {op["id"]: op for op in doc["ops"]}
    assert list(ops) == ["tee", "own", "plain", "klippa"]          # wall order; "off" has no ground
    tee = ops["tee"]
    assert tee["op"] == "golfmap.wall_ground" and tee["wall"] == "tee" and tee["seed"] == 1601
    assert tee["note"] == "the tee's front" and tee["toe3006"] == TOE and tee["lip3006"] == LIP
    # the preset over the defaults; the preset's own style picks the builder (wall: a terrace)
    assert tee["ground"] == {"profile": "terrace", "faceDeg": 86.0, "baseInM": 0.05, "beyondM": 1.2, "taperM": 1.2,
                             "subdivideM": 0.3, "paintFeatherM": 0.2, "minFaceM": 0.2, "jitterDeg": 0.0,
                             "paintInsetM": 0.0, "roundTopM": 0.0, "groundChannel": "blue", "paintOnly": False,
                             "stoneFace": True}
    assert ops["own"]["ground"]["faceDeg"] == 75.0 and ops["own"]["ground"]["beyondM"] == 1.2   # the wall wins
    assert ops["plain"]["ground"]["faceDeg"] == 55.0 and ops["plain"]["seed"] == 1             # defaults; Unity's seed 1
    k = ops["klippa"]
    assert k["ground"]["profile"] == "cliff" and k["ground"]["paintOnly"] is True and k["ground"]["jitterDeg"] == 10.0
    assert k["ground"]["roundTopM"] == 0.4 and k["ground"]["paintInsetM"] == 0.8
    assert len(k["outline3006"]) == 4
    assert k["grassPatches3006"] == [[477592.5, 6457803.0, 0.6, 0.6], [477593.0, 6457804.0, 0.5, 0.7]]
    for op in doc["ops"]:
        assert shape_wallground.validate_params(op) == [], op["id"]
        if op["op"] in shape_layers.OPS:
            assert shape_layers.validate_op(op) == [], op["id"]
    # one [E, N] pair per line, as the other shaping layers
    assert "[477591.42, 6457801.18]" in out.read_text(encoding="utf-8")


def test_unity_defaults_without_spec_defaults_and_no_stone(tmp_path):
    spec = _spec(defaults={"ground": True}, styles=None)
    spec["walls"] = [{"id": "w", "toe": TOE, "lip": LIP}]
    doc = sw.shaping_walls(_write(tmp_path, spec))
    g = doc["ops"][0]["ground"]
    assert g["faceDeg"] == 60.0 and g["baseInM"] == 0.2 and g["subdivideM"] == 0.35 and g["minFaceM"] == 0.35
    assert g["stoneFace"] is False and g["profile"] == "terrace"


@pytest.mark.parametrize("wall,message", [
    ({"id": "w", "style": "nope", "toe": TOE, "lip": LIP}, "does not define"),
    ({"id": "w", "toe": TOE, "lip": LIP[:2]}, "same number"),
    ({"toe": TOE, "lip": LIP}, "no id"),
    ({"id": "w", "groundChannel": "pink", "toe": TOE, "lip": LIP}, "groundChannel"),
])
def test_bad_walls_are_refused(tmp_path, wall, message):
    spec = _spec()
    spec["walls"] = [wall]
    with pytest.raises(sw.WallsError, match=message):
        sw.shaping_walls(_write(tmp_path, spec))


def test_no_spec_removes_a_stale_layer(tmp_path):
    course = tmp_path / "docs" / "gspro" / "empty"
    (course / "shaping").mkdir(parents=True)
    stale = course / "shaping" / "80-walls.gen.json"
    stale.write_text("{}", encoding="utf-8")
    assert sw.write_shaping_walls(course) is None
    assert not stale.exists()


@pytest.mark.parametrize("course,count", [("ombergs-golfklubb", 8), ("vreta", 2)])
def test_real_courses(tmp_path, course, count):
    folder = REPO / "docs" / "gspro" / course
    if not (folder / "stone-walls.json").exists():
        pytest.skip(f"no stone walls for {course}")
    out = sw.write_shaping_walls(folder, tmp_path)
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert len(doc["ops"]) == count
    for op in doc["ops"]:
        assert shape_wallground.validate_params(op) == []
    if course == "ombergs-golfklubb":
        tee = next(op for op in doc["ops"] if op["id"] == "h9-north-tee-wall")
        assert tee["ground"]["faceDeg"] == 86.0 and tee["ground"]["beyondM"] == 1.2 and tee["seed"] == 1601
    else:
        assert "h4-klippa-a" not in {op["id"] for op in doc["ops"]}       # ground: false
