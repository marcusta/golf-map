"""gspro ortho --tint-out — the terrain twin with the course's grass tinted.

The Photoshop overlay step done from the app DB: real SQLite in tmp_path,
a synthetic orthophoto, no mocks.
"""

import numpy as np
import pytest
from PIL import Image

import gspro
from tests.test_gspro import BBOX, _synthetic_ortho
from tests.test_gspro_svg import _make_db, _square

SIZE = 64


def _rect(x0f, y0f, x1f, y1f):
    """A straight-edged ring over a fraction box of the square (legacy bezier
    points without handles draw straight)."""
    (ax, ay), (bx, by) = _square((x0f, y0f)), _square((x1f, y1f))
    return {"points": [{"x": ax, "y": ay}, {"x": bx, "y": ay}, {"x": bx, "y": by}, {"x": ax, "y": by}]}


def _px(im, fx, fy):
    """The pixel at a fraction of the image (fy from the SOUTH, like the extent)."""
    arr = np.asarray(im).astype(float)
    return arr[int((1 - fy) * SIZE), int(fx * SIZE)]


def _run(tmp_path, features, **kwargs):
    src = tmp_path / "ortho.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    db = tmp_path / "app.sqlite"
    _make_db(db, features)
    out, terrain, tinted = (tmp_path / n for n in ("o.jpg", "o-terrain.jpg", "o-meshes.jpg"))
    kwargs.setdefault("tints", gspro._parse_tints(None))
    gspro.cmd_ortho(BBOX, None, size=SIZE, count=2, ortho_tifs=[src], quality=95, out=out,
                    terrain_out=terrain, darken=0.5, darken_space="srgb",
                    tint_out=tinted, tint_course="Testbana", db_path=db, **kwargs)
    return Image.open(terrain), Image.open(tinted)


def _expected(dark_px, rgb=(0x1e, 0x5a, 0x2c), a=0.3):
    return dark_px * (1 - a) + np.array(rgb, dtype=float) * a


def test_grass_gets_the_tint_bunkers_and_undrawn_ground_do_not(tmp_path):
    """West half is fairway with a bunker in it; the east half is not drawn.
    Tinted = dark × 0.7 + colour × 0.3 on the fairway; the bunker and the
    east half are the darkened photo untouched."""
    dark, tinted = _run(tmp_path, [
        ("fairway", 1, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier"),
        ("bunker", 1, 1, [_rect(0.2, 0.4, 0.3, 0.6)], "bezier"),
    ])
    assert tinted.size == (SIZE, SIZE) and tinted.mode == "RGB"
    assert np.abs(_px(tinted, 0.1, 0.5) - _expected(_px(dark, 0.1, 0.5))).max() < 3
    assert np.abs(_px(tinted, 0.25, 0.5) - _px(dark, 0.25, 0.5)).max() < 3  # bunker: sand stays sand
    assert np.abs(_px(tinted, 0.8, 0.5) - _px(dark, 0.8, 0.5)).max() < 3    # not drawn: untouched
    # The tint is a real change, not noise.
    assert np.abs(_px(tinted, 0.1, 0.5) - _px(dark, 0.1, 0.5)).sum() > 10


def test_stacking_follows_the_svg_so_a_green_on_rough_is_the_greens_tint(tmp_path):
    """Per-type overrides land where that type is on top: rough drawn AFTER
    the green in the app still ends up under it (green is lifted)."""
    dark, tinted = _run(tmp_path, [
        ("green", 1, 0, [_rect(0.4, 0.4, 0.6, 0.6)], "bezier"),
        ("rough", 1, 1, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier"),
    ], tints=gspro._parse_tints(["green=#ffffff@0.5", "rough=#000000@0.2"]))
    assert np.abs(_px(tinted, 0.5, 0.5) - _expected(_px(dark, 0.5, 0.5), (255, 255, 255), 0.5)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.1) - _expected(_px(dark, 0.1, 0.1), (0, 0, 0), 0.2)).max() < 3


def test_a_hole_in_a_feature_is_left_untinted(tmp_path):
    dark, tinted = _run(tmp_path, [
        ("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0), _rect(0.3, 0.3, 0.7, 0.7)], "bezier"),
    ])
    assert np.abs(_px(tinted, 0.5, 0.5) - _px(dark, 0.5, 0.5)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.1) - _expected(_px(dark, 0.1, 0.1))).max() < 3


def test_parse_tints_defaults_overrides_and_junk():
    t = gspro._parse_tints(None)
    assert t["fairway"] == ((0x1e, 0x5a, 0x2c), 0.3) and t["rough"] == t["fairway"]
    assert t["bunker"] == ((0x1e, 0x5a, 0x2c), 0.0) and "trees" not in t

    t = gspro._parse_tints(["green=#102030@0.5", "rough=@0.1", "tee=none", "trees=#ff0000"], "#000000", 0.4)
    assert t["green"] == ((0x10, 0x20, 0x30), 0.5)
    assert t["rough"] == ((0, 0, 0), 0.1)
    assert t["tee"] == ((0, 0, 0), 0.0)
    assert t["trees"] == ((255, 0, 0), 0.4)  # inherits the base opacity
    assert t["fairway"] == ((0, 0, 0), 0.4)

    for bad in (["green=#12"], ["green=@2"], ["green=@x"], ["=#000000"], ["green="]):
        with pytest.raises(SystemExit, match="--tint"):
            gspro._parse_tints(bad)
    with pytest.raises(SystemExit, match="--tint-color"):
        gspro._parse_tints(None, "green")
    with pytest.raises(SystemExit, match="--tint-opacity"):
        gspro._parse_tints(None, opacity=1.5)


def test_tint_out_needs_the_terrain_twin_and_a_course(tmp_path):
    src = tmp_path / "ortho.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    out = tmp_path / "o.jpg"
    with pytest.raises(SystemExit, match="--tint-out needs"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src], out=out, tint_out=tmp_path / "t.jpg", tint_course="x")
    with pytest.raises(SystemExit, match="--tint-out needs"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src], out=out, terrain_out=tmp_path / "d.jpg", tint_out=tmp_path / "t.jpg")
    with pytest.raises(SystemExit, match="--tint-course goes with"):
        gspro.cmd_ortho(BBOX, None, 32, 2, [src], out=out, terrain_out=tmp_path / "d.jpg", tint_course="x")


def test_cli_tints_from_the_db(tmp_path, capsys):
    src = tmp_path / "ortho.tif"
    _synthetic_ortho(src, gspro._square_3006_extent(BBOX))
    db = tmp_path / "app.sqlite"
    _make_db(db, [("fairway", 1, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier"),
                  ("trees", None, 0, [_rect(0.6, 0.6, 0.7, 0.7)], "bezier")])
    tinted = tmp_path / "t.jpg"
    code = gspro.main([
        "ortho", "--bbox", ",".join(map(str, BBOX)), "--size", "32", "--ortho", str(src),
        "--out", str(tmp_path / "o.jpg"), "--terrain-out", str(tmp_path / "d.jpg"),
        "--tint-out", str(tinted), "--tint-course", "Testbana", "--db", str(db),
        "--tint-opacity", "0.25", "--tint", "fairway=#336633",
    ])
    assert code == 0 and tinted.exists()
    report = capsys.readouterr().out
    assert "tinted fairway 1" in report and "ignored trees 1" in report
    assert "fairway #336633 25%" in report


WATER = (0x4a, 0x3d, 0x22)


def test_water_gets_its_own_brown_tint_that_fades_into_the_green_at_the_shore(tmp_path):
    """A pond inside a fairway: the pond centre is the darkened photo with the
    water tint (not the green), far out on the fairway it is the green result,
    and just outside the drawn shoreline it is strictly between the two — the
    feather runs the water colour into the green over a ground distance."""
    dark, tinted = _run(tmp_path, [
        ("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier"),
        ("water", 1, 1, [_rect(0.3, 0.3, 0.6, 0.6)], "bezier"),
    ], water_feather_m=150)  # ~4 px of the 64 px square, so the fade is visible
    assert np.abs(_px(tinted, 0.45, 0.45) - _expected(_px(dark, 0.45, 0.45), WATER, 0.4)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.9) - _expected(_px(dark, 0.1, 0.9))).max() < 3
    # One pixel outside the shoreline, on the fairway: neither pure green nor pure water.
    edge = _px(tinted, 0.6 + 1.5 / SIZE, 0.45)
    green = _expected(_px(dark, 0.6 + 1.5 / SIZE, 0.45))
    water = _expected(_px(dark, 0.6 + 1.5 / SIZE, 0.45), WATER, 0.4)
    assert np.abs(edge - green).max() > 2 and np.abs(edge - water).max() > 2
    lo, hi = np.minimum(green, water) - 2, np.maximum(green, water) + 2
    assert np.all(edge >= lo) and np.all(edge <= hi)


def test_water_with_no_fade_is_a_hard_edge_and_the_defaults_are_brown(tmp_path):
    dark, tinted = _run(tmp_path, [
        ("water", None, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier"),
    ], water_feather_m=0)
    assert np.abs(_px(tinted, 0.25, 0.5) - _expected(_px(dark, 0.25, 0.5), WATER, 0.4)).max() < 3
    assert np.abs(_px(tinted, 0.75, 0.5) - _px(dark, 0.75, 0.5)).max() < 3
    t = gspro._parse_tints(None)
    assert t["water"] == (WATER, 0.4) and t["water_creek"] == (WATER, 0.4)
    t = gspro._parse_tints(["water_creek=@0.1"], water_color="#000000", water_opacity=0.6)
    assert t["water"] == ((0, 0, 0), 0.6) and t["water_creek"] == ((0, 0, 0), 0.1)
    with pytest.raises(SystemExit, match="--water-opacity"):
        gspro._parse_tints(None, water_opacity=2)
    with pytest.raises(SystemExit, match="--water-color"):
        gspro._parse_tints(None, water_color="brown")
