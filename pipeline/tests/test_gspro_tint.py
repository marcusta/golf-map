"""gspro ortho --tint-out — the terrain twin with the course's grass tinted.

The Photoshop overlay step done from the app DB: real SQLite in tmp_path,
a synthetic orthophoto, no mocks.
"""

import json

import math

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
                    terrain_out=terrain, darken=DARKEN, darken_space="srgb",
                    tint_out=tinted, tint_course="Testbana", db_path=db, **kwargs)
    return Image.open(terrain), Image.open(tinted)


GREEN = (0x4c, 0x5f, 0x30)
DARKEN = 0.5  # what _run darkens by, on the sRGB values


def _expected(dark_px, rgb=GREEN, a=0.5, darken=1):
    """The tint colour goes on as given; with darken_tint under the photo's multiplier (`darken=DARKEN`)."""
    return dark_px * (1 - a) + np.round(np.array(rgb, dtype=float) * darken) * a


def test_grass_and_undrawn_ground_get_the_tint_bunkers_do_not(tmp_path):
    """West half is fairway with a bunker in it; the east half is not drawn.
    Tinted = dark × 0.5 + colour × 0.5 on the fairway AND on the undrawn
    east half (the whole photo sits at half strength over the green); the
    bunker is the darkened photo untouched."""
    dark, tinted = _run(tmp_path, [
        ("fairway", 1, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier"),
        ("bunker", 1, 1, [_rect(0.2, 0.4, 0.3, 0.6)], "bezier"),
    ])
    assert tinted.size == (SIZE, SIZE) and tinted.mode == "RGB"
    assert np.abs(_px(tinted, 0.1, 0.5) - _expected(_px(dark, 0.1, 0.5))).max() < 3
    assert np.abs(_px(tinted, 0.25, 0.5) - _px(dark, 0.25, 0.5)).max() < 3  # bunker: sand stays sand
    assert np.abs(_px(tinted, 0.8, 0.5) - _expected(_px(dark, 0.8, 0.5))).max() < 3  # not drawn: tinted too
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


def test_ground_none_leaves_what_is_not_drawn_alone_and_ground_takes_its_own_spec(tmp_path):
    (tmp_path / "a").mkdir(), (tmp_path / "b").mkdir()
    features = [("fairway", 1, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier")]
    dark, tinted = _run(tmp_path / "a", features, tints=gspro._parse_tints(["ground=none"]))
    assert np.abs(_px(tinted, 0.8, 0.5) - _px(dark, 0.8, 0.5)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.5) - _expected(_px(dark, 0.1, 0.5))).max() < 3
    dark, tinted = _run(tmp_path / "b", features, tints=gspro._parse_tints(["ground=#000000@0.2"]))
    assert np.abs(_px(tinted, 0.8, 0.5) - _expected(_px(dark, 0.8, 0.5), (0, 0, 0), 0.2)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.5) - _expected(_px(dark, 0.1, 0.5))).max() < 3


def test_a_hole_in_a_feature_is_not_that_feature(tmp_path):
    """The hole is undrawn ground: untinted with ground=none while the ring around it is tinted."""
    dark, tinted = _run(tmp_path, [
        ("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0), _rect(0.3, 0.3, 0.7, 0.7)], "bezier"),
    ], tints=gspro._parse_tints(["ground=none"]))
    assert np.abs(_px(tinted, 0.5, 0.5) - _px(dark, 0.5, 0.5)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.1) - _expected(_px(dark, 0.1, 0.1))).max() < 3


def test_parse_tints_defaults_overrides_and_junk():
    t = gspro._parse_tints(None)
    assert t["fairway"] == (GREEN, 0.5) and t["rough"] == t["fairway"] and t["ground"] == t["fairway"]
    assert t["bunker"] == (GREEN, 0.0) and "trees" not in t

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
        "--tint-opacity", "0.25", "--tint", "fairway=#336633", "--darken", "1",
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
    assert np.abs(_px(tinted, 0.45, 0.45) - _expected(_px(dark, 0.45, 0.45), WATER, 0.4, darken=1)).max() < 3
    assert np.abs(_px(tinted, 0.1, 0.9) - _expected(_px(dark, 0.1, 0.9))).max() < 3
    # One pixel outside the shoreline, on the fairway: neither pure green nor pure water.
    edge = _px(tinted, 0.6 + 1.5 / SIZE, 0.45)
    green = _expected(_px(dark, 0.6 + 1.5 / SIZE, 0.45))
    water = _expected(_px(dark, 0.6 + 1.5 / SIZE, 0.45), WATER, 0.4, darken=1)
    assert np.abs(edge - green).max() > 2 and np.abs(edge - water).max() > 2
    lo, hi = np.minimum(green, water) - 2, np.maximum(green, water) + 2
    assert np.all(edge >= lo) and np.all(edge <= hi)


def test_water_with_no_fade_is_a_hard_edge_and_the_defaults_are_brown(tmp_path):
    dark, tinted = _run(tmp_path, [
        ("water", None, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier"),
    ], water_feather_m=0)
    assert np.abs(_px(tinted, 0.25, 0.5) - _expected(_px(dark, 0.25, 0.5), WATER, 0.4, darken=1)).max() < 3
    assert np.abs(_px(tinted, 0.75, 0.5) - _expected(_px(dark, 0.75, 0.5))).max() < 3
    t = gspro._parse_tints(None)
    assert t["water"] == (WATER, 0.4) and t["water_creek"] == (WATER, 0.4)
    t = gspro._parse_tints(["water_creek=@0.1"], water_color="#000000", water_opacity=0.6)
    assert t["water"] == ((0, 0, 0), 0.6) and t["water_creek"] == ((0, 0, 0), 0.1)
    with pytest.raises(SystemExit, match="--water-opacity"):
        gspro._parse_tints(None, water_opacity=2)
    with pytest.raises(SystemExit, match="--water-color"):
        gspro._parse_tints(None, water_color="brown")


def _striped(size=SIZE):
    """1 px black/white vertical stripes: the finest detail a texture holds."""
    hwc = np.zeros((size, size, 3), dtype=np.uint8)
    hwc[:, ::2] = 255
    return hwc


def _row(kind, ring):
    return {"type": kind, "geometry_json": json.dumps({"rings": [ring], "curveType": "bezier"})}


def _contrast(arr, fx, fy, r=3):
    y, x = int((1 - fy) * SIZE), int(fx * SIZE)
    return float(np.ptp(arr[y - r:y + r, x - r:x + r].astype(float), axis=(0, 1)).max())


def test_soften_takes_the_fine_detail_off_turf_and_undrawn_ground_but_not_off_a_bunker():
    """Stripes under a fairway (west half) with a bunker in it, the east half
    undrawn. Softened to 8 px: the stripes are gone on the fairway AND on the
    undrawn ground, and intact inside the bunker (which the tint leaves
    alone too, so there it is the photo exactly)."""
    extent = gspro._square_3006_extent(BBOX)
    rows = [_row("fairway", _rect(0.0, 0.0, 0.5, 1.0)), _row("bunker", _rect(0.1, 0.3, 0.4, 0.7))]
    tints = gspro._parse_tints(None)
    px_m = (extent[2] - extent[0]) / SIZE

    out, summary = gspro._tint_terrain(_striped(), extent, rows, tints, soften_m=8 * px_m)
    assert _contrast(out, 0.25, 0.1) < 10      # fairway
    assert _contrast(out, 0.8, 0.5) < 10       # undrawn
    assert _contrast(out, 0.25, 0.5) == 255    # bunker: the photo as it was
    assert "softened to" in summary

    sharp, summary = gspro._tint_terrain(_striped(), extent, rows, tints, soften_m=0)
    assert _contrast(sharp, 0.25, 0.1) > 100 and _contrast(sharp, 0.8, 0.5) > 100 and _contrast(sharp, 0.25, 0.5) == 255
    assert "not softened" in summary


def test_a_grass_track_is_turf_in_the_tinted_twin_while_a_gravel_path_stays_the_photo():
    """Its mesh is a rough on the satellite material: softened and tinted like
    the rough round it, with no edge band, where a hard path keeps the photo."""
    extent = gspro._square_3006_extent(BBOX)
    track, gravel = _row("path", _rect(0.1, 0.3, 0.4, 0.7)), _row("path", _rect(0.6, 0.3, 0.9, 0.7))
    track["attributes_json"] = json.dumps({"surface": "grass"})
    gravel["attributes_json"] = json.dumps({"surface": "gravel"})
    rows = [_row("rough", _rect(0.0, 0.0, 1.0, 1.0)), track, gravel]
    px_m = (extent[2] - extent[0]) / SIZE

    out, summary = gspro._tint_terrain(_striped(), extent, rows, gspro._parse_tints(None), soften_m=8 * px_m)
    assert _contrast(out, 0.25, 0.5) < 10      # the track: as the rough
    assert _contrast(out, 0.75, 0.5) == 255    # gravel: the photo as it was
    assert "masked off path 1" in summary

    photo = np.full((FILL_SIZE, FILL_SIZE, 3), 90, dtype=np.uint8)
    rows = _path_rows("grass") + [_box_row("path", 10, 18, 90, 22)]
    _, summary = gspro._fill_hazard_edges(photo, FILL_EXTENT, rows, gspro.EdgeFill())
    assert "path 1 " in summary


def test_the_tinted_twin_is_written_at_its_own_smaller_size(tmp_path):
    (tmp_path / "a").mkdir(), (tmp_path / "b").mkdir()
    dark, tinted = _run(tmp_path / "a", [("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier")], tint_size=32)
    assert tinted.size == (32, 32) and dark.size == (SIZE, SIZE)
    # Never scaled UP past the render: the default 8192 on a 64 px render stays 64.
    assert gspro.DEFAULT_TINT_SIZE == 8192 and gspro.DEFAULT_SOFTEN_M == 1.0
    _, tinted = _run(tmp_path / "b", [("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier")])
    assert tinted.size == (SIZE, SIZE)


def test_tint_grade_multiplies_the_finished_file_per_channel_in_linear_light(tmp_path):
    (tmp_path / "a").mkdir(), (tmp_path / "b").mkdir()
    features = [("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier")]
    _, plain = _run(tmp_path / "a", features)
    _, graded = _run(tmp_path / "b", features, tint_grade=(0.5, 1.0, 0.25))

    def linear(px):
        f = px / 255.0
        return np.where(f <= 0.04045, f / 12.92, ((f + 0.055) / 1.055) ** 2.4)

    ratio = linear(_px(graded, 0.7, 0.3)) / linear(_px(plain, 0.7, 0.3))
    assert np.abs(ratio - [0.5, 1.0, 0.25]).max() < 0.06

    assert gspro._parse_grade(None) is None and gspro._parse_grade("0.57,0.67,0.37") == (0.57, 0.67, 0.37)
    for bad in ("1,2", "a,b,c", "0,1,1", "1,1,5"):
        with pytest.raises(SystemExit, match="--tint-grade"):
            gspro._parse_grade(bad)


def test_soften_and_tint_size_refuse_nonsense(tmp_path):
    (tmp_path / "a").mkdir(), (tmp_path / "b").mkdir()
    with pytest.raises(SystemExit, match="--soften-m"):
        _run(tmp_path / "a", [], soften_m=-1)
    with pytest.raises(SystemExit, match="--tint-size"):
        _run(tmp_path / "b", [], tint_size=0)


def test_darken_tint_is_opt_in_and_puts_the_tint_colour_under_the_photos_multiplier(tmp_path):
    """Off (the course meshes): the colour as given. On (the outer terrain):
    sun-lit colours in, the photo's multiplier on them; water as given."""
    features = [("fairway", 1, 0, [_rect(0.0, 0.0, 0.5, 1.0)], "bezier"), ("water", 1, 1, [_rect(0.6, 0.0, 1.0, 1.0)], "bezier")]
    dark, tinted = _run(tmp_path, features, darken_tint=True, water_feather_m=0)
    for fx in (0.1, 0.55):  # fairway, undrawn ground
        assert np.abs(_px(tinted, fx, 0.5) - _expected(_px(dark, fx, 0.5), darken=DARKEN)).max() < 3
        assert np.abs(_px(tinted, fx, 0.5) - _expected(_px(dark, fx, 0.5))).max() > 5
    assert np.abs(_px(tinted, 0.8, 0.5) - _expected(_px(dark, 0.8, 0.5), WATER, 0.4)).max() < 3
    t = gspro._darken_tints(gspro._parse_tints(None), 0.5, "srgb")
    assert t["fairway"] == ((38, 48, 24), 0.5) and t["ground"] == t["fairway"] and t["bunker"][1] == 0.0
    assert t["water"] == (WATER, 0.4)
    assert gspro._darken_tints(gspro._parse_tints(None), 0.4, "linear")["ground"][0] == (47, 60, 28)
    assert gspro._darken_tints(gspro._parse_tints(None), 1.0, "linear")["ground"][0] == GREEN


# --- Hazard edge fill (the sand/gravel halo round bunkers and paths in the -meshes file)

FILL_EXTENT = (500000.0, 6400000.0, 500100.0, 6400100.0)  # 100 m square
FILL_SIZE = 200  # 0.5 m/px, what the 4096 px -meshes file has over Vreta's 2050 m
GRASS = np.array([60, 90, 40], dtype=float)
SAND = np.array([225, 218, 200], dtype=float)


def _box_row(kind, x0, y0, x1, y1):
    e0, n0 = FILL_EXTENT[:2]
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return _row(kind, {"points": [{"x": e0 + x, "y": n0 + y} for x, y in pts]})


def _haloed_photo(halo_m=1.0):
    """Grass everywhere, sand over the 40..60 m box grown by `halo_m` (the
    photo's sand running past the drawn outline)."""
    hwc = np.empty((FILL_SIZE, FILL_SIZE, 3), dtype=np.uint8)
    hwc[:] = GRASS
    lo, hi = int((40 - halo_m) * 2), int((60 + halo_m) * 2)
    hwc[FILL_SIZE - hi:FILL_SIZE - lo, lo:hi] = SAND
    return hwc


def _grass_share(rgb):
    """How far a sand..grass mix is toward the grass (0 = sand, 1 = grass)."""
    return float(np.dot(np.asarray(rgb, dtype=float) - SAND, GRASS - SAND) / np.dot(GRASS - SAND, GRASS - SAND))


def _at(arr, x_m, y_m):
    """The pixel at x_m east, y_m north of the extent's SW corner."""
    return np.asarray(arr, dtype=float)[FILL_SIZE - 1 - int(y_m * 2), int(x_m * 2)]


def test_edge_fill_paints_the_sand_halo_round_a_bunker_from_the_grass_and_keeps_the_sand():
    """A bunker drawn over 40..60 m, the photo's sand 1 m wider all round.
    After the fill: the halo (and the outermost texel inside the outline,
    where bilinear sampling at the seam would read sand) is grass; the
    bunker's sand further in and the grass further out are untouched."""
    photo = _haloed_photo()
    out, summary = gspro._fill_hazard_edges(photo, FILL_EXTENT, [_box_row("bunker", 40, 40, 60, 60)], gspro.EdgeFill())
    for x in (60.25, 60.75, 39.25):                # the halo outside
        assert np.abs(_at(out, x, 50) - GRASS).max() < 4, x
    assert _grass_share(_at(out, 59.9, 50)) > 0.7        # the outermost texel inside: mostly grass (ramp)
    assert np.abs(_at(out, 50, 60.6) - GRASS).max() < 4   # north side too
    assert np.abs(_at(out, 50, 50) - SAND).max() == 0     # the bunker stays photographed
    assert np.abs(_at(out, 58, 50) - SAND).max() == 0
    assert np.abs(_at(out, 80, 50) - _at(photo, 80, 50)).max() == 0  # beyond the band: as it was
    assert np.abs(_at(photo, 60.5, 50) - SAND).max() == 0  # (the halo was there)
    assert "edge fill round bunker 1" in summary


def test_edge_fill_paints_the_gravel_halo_round_a_path_from_its_outline_and_keeps_the_whole_path():
    """Paths are filled by default too, but centred on the outline: the
    path's own concrete samples the file, so its edge texel stays mostly
    gravel and the texel just outside mostly grass."""
    photo = _haloed_photo()
    out, summary = gspro._fill_hazard_edges(photo, FILL_EXTENT, [_box_row("path", 40, 40, 60, 60)], gspro.EdgeFill())
    for x in (60.75, 39.25, 61.25):
        assert np.abs(_at(out, x, 50) - GRASS).max() < 4, x
    assert _grass_share(_at(out, 60.25, 50)) > 0.7        # the outline's outer texel: mostly grass
    assert _grass_share(_at(out, 59.9, 50)) < 0.3         # its inner texel: mostly still the path
    assert np.abs(_at(out, 58, 50) - SAND).max() == 0
    assert "path 1 (0 m in)" in summary


def _bilinear(arr, x_m, y_m):
    """`arr` sampled like the GPU does, at x_m east / y_m north of the SW corner."""
    a = np.asarray(arr, dtype=float)
    fx, fy = x_m * 2 - 0.5, FILL_SIZE - y_m * 2 - 0.5
    x0, y0 = int(np.floor(fx)), int(np.floor(fy))
    tx, ty = fx - x0, fy - y0
    return ((a[y0, x0] * (1 - tx) + a[y0, x0 + 1] * tx) * (1 - ty)
            + (a[y0 + 1, x0] * (1 - tx) + a[y0 + 1, x0 + 1] * tx) * ty)


def test_edge_fill_along_a_shallow_slanted_path_has_no_texel_staircase():
    """A 2 m path at 4 degrees to the texel rows, its gravel running 1.5 m
    past the outline into the grass. Sampled along lines parallel to the
    path, the filled file must be even: a band edge rasterised on the 0.5 m
    texels steps up and down every few metres (seen in Unity as a stepped
    pale strip; the raster band measured std 8..14 here, the ramps <= 5)."""
    ang = math.radians(4.0)
    ux, uy, nx, ny = math.cos(ang), math.sin(ang), -math.sin(ang), math.cos(ang)
    cx, cy = 50.0, 45.0

    def at(t, o):
        return cx + ux * t + nx * o, cy + uy * t + ny * o

    corners = [at(-45, -1), at(45, -1), at(45, 1), at(-45, 1)]
    e0, n0 = FILL_EXTENT[:2]
    rows = [_row("path", {"points": [{"x": e0 + x, "y": n0 + y} for x, y in corners]})]
    ys, xs = np.mgrid[0:FILL_SIZE, 0:FILL_SIZE]
    xm, ym = (xs + 0.5) / 2, (FILL_SIZE - ys - 0.5) / 2
    off = np.abs((xm - cx) * nx + (ym - cy) * ny)          # exact distance from the centre line
    w = np.clip((off - 1.0) / 1.5, 0.0, 1.0)[..., None]    # gravel to the outline, grass 1.5 m past it
    photo = np.round(SAND * (1 - w) + GRASS * w).astype(np.uint8)
    out, _ = gspro._fill_hazard_edges(photo, FILL_EXTENT, rows, gspro.EdgeFill())
    for o in np.arange(0.75, 4.01, 0.25):                   # just inside the outline, outwards
        line = np.array([_bilinear(out, *at(t, o)) for t in np.arange(-30, 30, 0.2)])
        assert line.std(axis=0).max() < 6, (o, line.std(axis=0))
    assert np.abs(_bilinear(out, *at(0, 2.5)) - GRASS).max() < 2   # and the halo is gone


def test_edge_fill_insets_per_type_and_one_inset_overrides_them_all():
    photo = _haloed_photo()
    rows = [_box_row("path", 40, 40, 60, 60)]
    out, _ = gspro._fill_hazard_edges(photo, FILL_EXTENT, rows, gspro.EdgeFill(inset_m=0.5))
    assert _grass_share(_at(out, 59.9, 50)) > 0.7
    out, summary = gspro._fill_hazard_edges(photo, FILL_EXTENT, rows, gspro.EdgeFill(types=("bunker",)))
    assert np.array_equal(out, photo) and "no bunker" in summary


def test_parse_edge_fill_defaults_none_and_junk():
    assert gspro._parse_edge_fill(None) == gspro.EdgeFill(("bunker", "path"), 1.25, None)
    assert [gspro._parse_edge_fill(None).inset_for(k) for k in ("bunker", "path")] == [0.5, 0.0]
    assert gspro._parse_edge_fill("none") is None and gspro._parse_edge_fill("NONE") is None
    assert gspro._parse_edge_fill("bunker, path", 1.5, 0).types == ("bunker", "path")
    assert gspro._parse_edge_fill("bunker", 1.5, 0).inset_for("bunker") == 0
    for bad in (dict(types=","), dict(types=None, margin_m=0), dict(types=None, margin_m=11),
                dict(types=None, inset_m=-1), dict(types=None, inset_m=3)):
        with pytest.raises(SystemExit, match="--edge-fill"):
            gspro._parse_edge_fill(**bad)


def test_the_meshes_file_gets_the_edge_fill_by_default_and_none_keeps_the_old_file(tmp_path, capsys):
    (tmp_path / "a").mkdir(), (tmp_path / "b").mkdir()
    features = [("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier"), ("bunker", 1, 1, [_rect(0.2, 0.4, 0.3, 0.6)], "bezier")]
    _run(tmp_path / "a", features)
    assert "edge fill" in capsys.readouterr().out
    _run(tmp_path / "b", features, edge_fill=None)
    assert "no edge fill (bunkers and paths as photographed)" in capsys.readouterr().out


# --- path fill: the photo's tree shadows lifted off the paths ------------------

GRAVEL = np.array([118, 114, 108], dtype=float)
SHADOW = np.array([22, 30, 52], dtype=float)   # a tree shadow on gravel: dark and blue (measured on Vreta)


def _path_photo(shadow_x=(45.0, 55.0), seed=1):
    """Grass everywhere; a 4 m path over x 10..90 m, y 48..52 m, gravel with a
    +/-6 grain; a tree shadow over `shadow_x` (the same grain, darker, blue)."""
    rng = np.random.default_rng(seed)
    hwc = np.empty((FILL_SIZE, FILL_SIZE, 3), dtype=float)
    hwc[:] = GRASS
    grain = rng.uniform(-6, 6, (FILL_SIZE, FILL_SIZE))[..., None]
    rows = slice(FILL_SIZE - 104, FILL_SIZE - 96)   # y 48..52 m
    hwc[rows, 20:180] = GRAVEL + grain[rows, 20:180]
    if shadow_x is not None:
        c0, c1 = int(shadow_x[0] * 2), int(shadow_x[1] * 2)
        hwc[rows, c0:c1] = SHADOW + grain[rows, c0:c1] * 0.3
    return np.clip(np.round(hwc), 0, 255).astype(np.uint8)


def _path_rows(surface=None, x0=10, x1=90):
    row = _box_row("path", x0, 48, x1, 52)
    if surface is not None:
        row["attributes_json"] = json.dumps({"surface": surface})
    return [row]


def _strip(arr, x0, x1):
    """The path's pixels (y 48.5..51.5 m, inside the outline) over x0..x1 m."""
    return np.asarray(arr, dtype=float)[FILL_SIZE - 103:FILL_SIZE - 97, int(x0 * 2):int(x1 * 2)].reshape(-1, 3)


def test_path_fill_lifts_a_tree_shadow_to_the_sunlit_gravel_and_keeps_its_grain():
    """The shadow over x 45..55 m becomes the gravel round it (within a few
    levels, no blue left), with grain of its own rather than one flat colour;
    the sunlit gravel and everything outside the path stay as they were."""
    photo = _path_photo()
    out, summary = gspro._fill_path_shadows(photo, FILL_EXTENT, _path_rows())
    lifted = _strip(out, 46, 54)
    assert np.abs(lifted.mean(axis=0) - GRAVEL).max() < 8, lifted.mean(axis=0)
    assert lifted[:, 2].mean() - lifted[:, 0].mean() < 2            # the blue is gone
    assert lifted.std(axis=0).min() > 1.0                            # grain, not a flat fill
    assert np.abs(_strip(out, 15, 35) - _strip(photo, 15, 35)).max() <= 1   # sunlit gravel as photographed
    outside = np.ones((FILL_SIZE, FILL_SIZE), dtype=bool)
    outside[FILL_SIZE - 105:FILL_SIZE - 95, 18:182] = False
    assert np.array_equal(out[outside], photo[outside])
    assert "path fill: shadows on 1 paths" in summary


def test_path_fill_along_a_shallow_slanted_path_has_no_texel_staircase():
    """A 3 m path at 4 degrees to the texel rows, in a tree shadow along its
    middle, its photographed edge a smooth 1 m blend into the grass. The
    lifted gravel must end as smoothly: lifting the pixels whose centres are
    inside made it a texel staircase down both sides (jagged teeth in Unity)."""
    ang = math.radians(4.0)
    ux, uy, nx, ny = math.cos(ang), math.sin(ang), -math.sin(ang), math.cos(ang)
    cx, cy = 50.0, 45.0

    def at(t, o):
        return cx + ux * t + nx * o, cy + uy * t + ny * o

    e0, n0 = FILL_EXTENT[:2]
    corners = [at(-45, -1.5), at(45, -1.5), at(45, 1.5), at(-45, 1.5)]
    rows = [_row("path", {"points": [{"x": e0 + x, "y": n0 + y} for x, y in corners]})]
    ys, xs = np.mgrid[0:FILL_SIZE, 0:FILL_SIZE]
    xm, ym = (xs + 0.5) / 2, (FILL_SIZE - ys - 0.5) / 2
    off = np.abs((xm - cx) * nx + (ym - cy) * ny)
    along = (xm - cx) * ux + (ym - cy) * uy
    path_w = np.clip((2.0 - off) / 1.0, 0.0, 1.0)[..., None]          # 1 at 1 m from the centre, 0 at 2 m
    ground = np.where((np.abs(along) < 25)[..., None], SHADOW, GRAVEL)
    photo = np.round(ground * path_w + GRASS * (1 - path_w)).astype(np.uint8)
    out, _ = gspro._fill_path_shadows(photo, FILL_EXTENT, rows)
    for o in np.arange(0.75, 2.51, 0.25):                               # inside the outline, out past it
        line = np.array([_bilinear(out, *at(t, o)) for t in np.arange(-15, 15, 0.2)])
        assert line.std(axis=0).max() < 6, (o, line.std(axis=0))
    assert np.abs(_bilinear(out, *at(0, 0)) - GRAVEL).max() < 15         # and the shadow is lifted


def test_path_fill_keeps_a_dark_asphalt_road_dark():
    """Dark but neutral grey is asphalt, not shadow: a road that dark all along
    stays as photographed."""
    photo = _path_photo(shadow_x=None)
    rows = slice(FILL_SIZE - 104, FILL_SIZE - 96)
    photo[rows, 20:180] = np.clip(photo[rows, 20:180].astype(float) * 0.55, 0, 255).astype(np.uint8)
    out, _ = gspro._fill_path_shadows(photo, FILL_EXTENT, _path_rows("asphalt"))
    assert np.abs(_strip(out, 12, 88) - _strip(photo, 12, 88)).mean() < 1.5


def test_a_path_shaded_end_to_end_takes_the_sunlit_colour_of_the_courses_other_paths():
    """A forest path in shadow all along has no sunlit gravel of its own: it
    gets the sunlit path colour of the course (here a second, sunlit path)."""
    photo = _path_photo(shadow_x=(10.0, 90.0))
    rows = slice(FILL_SIZE - 44, FILL_SIZE - 36)   # a sunlit path at y 18..22 m
    photo[rows, 20:180] = GRAVEL
    out, _ = gspro._fill_path_shadows(photo, FILL_EXTENT, _path_rows() + [_box_row("path", 10, 18, 90, 22)])
    assert np.abs(_strip(out, 30, 70).mean(axis=0) - GRAVEL).max() < 12


def test_path_fill_leaves_grass_tracks_and_bridge_decks_alone():
    photo = _path_photo()
    for surface in ("grass", "bridge"):
        out, summary = gspro._fill_path_shadows(photo, FILL_EXTENT, _path_rows(surface))
        assert np.array_equal(out, photo) and "no paths" in summary, surface


def test_the_meshes_file_gets_the_path_fill_by_default_and_false_keeps_the_shadows(tmp_path, capsys):
    (tmp_path / "a").mkdir(), (tmp_path / "b").mkdir()
    features = [("fairway", 1, 0, [_rect(0.0, 0.0, 1.0, 1.0)], "bezier"), ("path", 1, 1, [_rect(0.1, 0.45, 0.9, 0.55)], "bezier")]
    _run(tmp_path / "a", features)
    assert "path fill: shadows on 1 paths" in capsys.readouterr().out
    _run(tmp_path / "b", features, path_fill=False)
    assert "no path fill (path shadows as photographed)" in capsys.readouterr().out
