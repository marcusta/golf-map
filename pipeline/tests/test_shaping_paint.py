"""shaping-paint: paint.json -> the generated Blender paint layer (90-paint.gen.json, golfmap.paint ops).

Real files in tmp_path; the layer is checked with the engine's own validator (blender/tools/shape_layers.py) once
golfmap.paint is registered there, else its op shape by hand.
"""

import json
import sys

import pytest

import shaping_paint as sp

sys.path.insert(0, str(sp.TOOLS))
import shape_layers  # noqa: E402

RULES = [
    {"id": "bunker-surround", "enabled": False, "kind": "edge", "edge": "bunker", "surfaces": ["Rough"],
     "channel": "blue", "mode": "overlay", "widthM": 2.2},
    {"id": "ram-roads", "kind": "road", "surfaces": ["Rough", "Deep"], "channel": "black", "strength": 1,
     "insetM": 0.4, "fadeM": 1.0},
    {"id": "creek-bed", "kind": "object", "match": "_WaterBrook_-_Mesh", "channel": "black", "fadeM": 0.5,
     "material": {"albedo": "a.tga", "normal": "n.png"}, "belowM": 0.1, "creek": "feature:abc", "grassFrom": "rough"},
    {"id": "edge-on", "kind": "edge", "edge": "bunker", "channel": "black"},
    {"id": "pond-shore", "kind": "object", "match": "_hole_17_230_Water_Base_Lake_-_Mesh", "channel": "red",
     "shoreM": 0.6, "softM": 0.3, "reachM": 4.0, "material": {"base": "self"}},
]
STROKES = [
    {"id": "worn-tee-path", "geometry": "line", "points3006": [[477500.0, 6457500.0], [477510.0, 6457505.0]],
     "widthM": 1.2, "featherM": 0.6, "channel": "black", "strength": 0.7, "surfaces": ["Rough"]},
    {"id": "off", "enabled": False, "geometry": "circle", "centre3006": [477500.0, 6457500.0], "radiusM": 2,
     "channel": "blue"},
    {"id": "dry-patch", "geometry": "circle", "centre3006": [477520.0, 6457520.0], "radiusM": 3, "featherM": 2,
     "channel": "blue", "mode": "overlay"},
]


def paint_doc(**extra):
    return dict({"format": "golfmap-paint-v1", "notes": ["n"], "rules": RULES}, **extra)


def test_ops_in_unity_order_with_stable_ids():
    layer = sp.paint_layer(paint_doc(strokes=STROKES))
    ids = [op["id"] for op in layer["ops"]]
    # object rules (file order), road, edge (enabled only), the lake bed, then the strokes (enabled, file order)
    assert ids == ["paint-creek-bed", "paint-pond-shore", "paint-ram-roads", "paint-edge-on", "paint-lakebed",
                   "paint-stroke-worn-tee-path", "paint-stroke-dry-patch"]
    assert all(op["op"] == "golfmap.paint" for op in layer["ops"])
    assert layer["format"] == "golfmap-shaping-layer-v1" and layer["generated"] is True and layer["id"] == "paint"
    assert layer == sp.paint_layer(paint_doc(strokes=STROKES))


def test_unity_only_keys_left_out():
    layer = sp.paint_layer(paint_doc())
    creek = layer["ops"][0]["rule"]
    assert creek == {"id": "creek-bed", "kind": "object", "match": "_WaterBrook_-_Mesh", "channel": "black",
                     "fadeM": 0.5, "belowM": 0.1, "creek": "feature:abc"}
    assert "material" not in layer["ops"][1]["rule"]
    road = layer["ops"][2]["rule"]
    assert road == RULES[1]


def test_lakebed_defaults_settings_and_off():
    layer = sp.paint_layer(paint_doc())
    lake = [op for op in layer["ops"] if op["id"] == "paint-lakebed"][0]
    assert lake["rule"] == {"id": "lakebed", "kind": "lakebed", "bandM": 25.0, "fadeM": 20.0}
    layer = sp.paint_layer(paint_doc(lakebed={"bandM": 30, "fadeM": 10}))
    assert [op for op in layer["ops"] if op["id"] == "paint-lakebed"][0]["rule"]["bandM"] == 30
    layer = sp.paint_layer(paint_doc(lakebed={"enabled": False}))
    assert "paint-lakebed" not in [op["id"] for op in layer["ops"]]


def test_strokes_become_stroke_rules():
    layer = sp.paint_layer(paint_doc(strokes=STROKES))
    s = [op for op in layer["ops"] if op["id"] == "paint-stroke-worn-tee-path"][0]["rule"]
    assert s["kind"] == "stroke" and s["geometry"] == "line" and s["widthM"] == 1.2 and "enabled" not in s


@pytest.mark.parametrize("doc, message", [
    ({"format": "golfmap-paint-v2", "rules": []}, "format"),
    ({"format": "golfmap-paint-v1", "rules": [{"id": "x", "kind": "paint"}]}, "kind must be"),
    ({"format": "golfmap-paint-v1", "rules": [{"id": "x", "kind": "object"}]}, "needs match"),
    ({"format": "golfmap-paint-v1", "rules": [{"id": "x", "kind": "edge", "edge": "bunker", "mode": "overlay"}]},
     "no overlay"),
    ({"format": "golfmap-paint-v1", "rules": [], "strokes": [{"geometry": "circle"}]}, "needs an id"),
    ({"format": "golfmap-paint-v1", "rules": [], "strokes": [{"id": "a", "geometry": "circle", "centre3006": [0, 0],
                                                            "radiusM": 1}]}, "needs channel"),
    ({"format": "golfmap-paint-v1", "rules": [{"id": "a", "kind": "object", "match": "x"},
                                              {"id": "a", "kind": "object", "match": "y"}]}, "repeats"),
])
def test_bad_input(doc, message):
    with pytest.raises(sp.PaintError, match=message):
        sp.paint_layer(doc)


def test_cli_writes_the_layer(tmp_path, capsys):
    course = tmp_path / "course"
    course.mkdir()
    (course / "paint.json").write_text(json.dumps(paint_doc(strokes=STROKES)), encoding="utf-8")
    out = sp.cmd_shaping_paint(course, tmp_path / "layers")
    assert out == tmp_path / "layers" / "90-paint.gen.json"
    text = out.read_text(encoding="utf-8")
    assert '[477500.0, 6457500.0]' in text   # one [E, N] pair per line
    doc = json.loads(text)
    assert doc["course"] == {"folder": "course"}
    assert len(doc["ops"]) == 7
    assert "7 golfmap.paint op(s)" in capsys.readouterr().out
    # the default: <course>/shaping/
    assert sp.cmd_shaping_paint(course) == course / "shaping" / "90-paint.gen.json"
    if "golfmap.paint" in shape_layers.OPS:
        assert shape_layers.validate_layer(doc) == []
    else:
        for op in doc["ops"]:
            assert set(op) == {"id", "op", "rule"}


def test_missing_paint_json_writes_no_layer_and_removes_a_stale_one(tmp_path):
    stale = tmp_path / "shaping" / sp.OUT_FILE
    stale.parent.mkdir()
    stale.write_text("{}", encoding="utf-8")
    assert sp.cmd_shaping_paint(tmp_path) is None
    assert not stale.exists()


def test_omberg_paint_json_generates():
    course = sp.REPO_ROOT / "docs" / "gspro" / "ombergs-golfklubb"
    if not (course / "paint.json").is_file():
        pytest.skip("no Omberg paint.json")
    doc = sp.paint_layer(json.loads((course / "paint.json").read_text(encoding="utf-8")))
    ids = [op["id"] for op in doc["ops"]]
    assert ids[0] == "paint-creek-bed" and ids[-1] == "paint-lakebed"
    assert "paint-bunker-surround" not in ids
