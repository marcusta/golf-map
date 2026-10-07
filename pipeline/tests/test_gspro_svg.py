"""gspro svg — course features out of the app DB as a GSPro/OPCD SVG.

Real SQLite databases built in tmp_path (no mocks), same shape as the app's:
courses / holes / course_features.
"""

import json
import re
import sqlite3
import xml.etree.ElementTree as ET

import pytest

import gspro

BBOX = (15.50, 58.52, 15.53, 58.54)  # Vreta-ish, WGS84
COURSE = "11111111-1111-1111-1111-111111111111"
SVG_NS = "{http://www.w3.org/2000/svg}"
INK_NS = "{http://www.inkscape.org/namespaces/inkscape}"


def _square(pt_frac):
    """A point at (fx, fy) of the square extent, as EPSG:3006 metres."""
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    fx, fy = pt_frac
    return (e0 + fx * (e1 - e0), n0 + fy * (n1 - n0))


def _ring(centre_frac, radius_m=20.0, n=6):
    """A closed control ring of `n` points around a point in the extent."""
    import math
    cx, cy = _square(centre_frac)
    return {"points": [
        {"x": cx + radius_m * math.cos(2 * math.pi * i / n),
         "y": cy + radius_m * math.sin(2 * math.pi * i / n)}
        for i in range(n)
    ]}


def _make_db(path, features, holes=(1, 2), numbered=True):
    """features: (type, hole_number|None, sort_order, rings, curve_type[, no[, id]]).
    `no` is the server's per-course feature number (default: position in the
    list + 1; None = unnumbered, like a generated feature), `id` defaults to
    feat-<position>. The list is also the order they were drawn in
    (created_at). numbered=False leaves the column out, like a database from
    before the server's migration 026."""
    conn = sqlite3.connect(path)
    conn.executescript(
        f"""CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT,
               geometry_json TEXT, sort_order INTEGER, created_at TEXT{", feature_no INTEGER" if numbered else ""});"""
    )
    conn.execute("INSERT INTO courses VALUES (?, ?)", (COURSE, "Testbana"))
    for number in holes:
        conn.execute("INSERT INTO holes VALUES (?, ?, ?)", (f"h{number}", COURSE, number))
    for i, (kind, hole, order, rings, curve, *given) in enumerate(features):
        geom = {"crs": "EPSG:3006", "curveType": curve, "rings": rings}
        no = given[0] if given else i + 1
        fid = given[1] if len(given) > 1 else f"feat-{i}"
        row = [fid, COURSE, f"h{hole}" if hole else None, kind, json.dumps(geom), order,
               f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z"] + ([no] if numbered else [])
        conn.execute(f"INSERT INTO course_features VALUES ({', '.join('?' * len(row))})", row)
    conn.commit()
    conn.close()


def _export(tmp_path, features, holes=(1, 2), numbered=True, **kwargs):
    tmp_path.mkdir(parents=True, exist_ok=True)  # callers pass subdirs for a 2nd export
    db = tmp_path / "app.sqlite"
    _make_db(db, features, holes, numbered)
    out = tmp_path / "course.svg"
    kwargs.setdefault("flatten", None)
    kwargs.setdefault("precision", 3)
    kwargs.setdefault("mapped", {})
    kwargs.setdefault("stack", "app")  # tests pin order explicitly; opt in to opcd
    gspro.cmd_svg(BBOX, out, db, "Testbana", **kwargs)
    return out


def _layers(out):
    """[(label, [path ids])] in document order."""
    root = ET.parse(out).getroot()
    return [
        (g.get(f"{INK_NS}label"), [p.get("id") for p in g.findall(f"{SVG_NS}path")])
        for g in root.findall(f"{SVG_NS}g")
    ]


BASIC = [
    ("semi_rough", 1, 0, [_ring((0.40, 0.40), 40)], "bspline"),
    ("fairway", 1, 1, [_ring((0.40, 0.40), 30)], "bspline"),
    ("bunker", 1, 2, [_ring((0.42, 0.42), 5)], "bspline"),
    ("bunker", 2, 0, [_ring((0.60, 0.60), 5)], "bspline"),
    ("green", 2, 1, [_ring((0.61, 0.61), 12)], "bspline"),
    ("water", None, 0, [_ring((0.20, 0.70), 25)], "bspline"),
]


def test_layer_per_hole_and_others_for_the_rest(tmp_path):
    """One layer per hole named HoleN, features with no hole on 'Others' —
    never the reserved Hole99, which would change how Blender cuts. Document
    order matches the OPCD course files: Others first, then the holes
    descending, so Hole1 lands topmost in Inkscape."""
    layers = _layers(_export(tmp_path, BASIC))
    assert [label for label, _ in layers] == ["Others", "Hole2", "Hole1"]
    assert dict(layers)["Others"] == ["others_6"]


def test_shape_ids_are_hole_number_plus_the_features_number_in_hex(tmp_path):
    """Ids are hole_<hole>_<feature number in hex> (others_<number> off-hole):
    the mesh they become traces back to a hole, and the number is the one the
    server hands out per course and never reuses. The material is already in
    the mesh name via the fill, so the type is only kept as a data-type
    attribute."""
    layers = dict(_layers(_export(tmp_path, BASIC)))
    assert layers["Hole1"] == ["hole_1_1", "hole_1_2", "hole_1_3"]
    assert layers["Hole2"] == ["hole_2_4", "hole_2_5"]
    assert layers["Others"] == ["others_6"]

    root = ET.parse(_export(tmp_path / "t", BASIC)).getroot()
    types = {p.get("id"): p.get("data-type") for p in root.iter(f"{SVG_NS}path")}
    assert types["hole_1_1"] == "semi_rough"
    assert types["hole_1_3"] == "bunker"
    assert len(set(types)) == len(types)  # ids unique

    feats = [("bunker", 1, 0, [_ring((0.42, 0.42), 5)], "bspline", 26), ("bunker", 1, 1, [_ring((0.45, 0.45), 5)], "bspline", 4095)]
    assert dict(_layers(_export(tmp_path / "hex", feats)))["Hole1"] == ["hole_1_1a", "hole_1_fff"]


def test_a_shape_keeps_its_name_when_other_features_on_the_hole_change(tmp_path):
    """The name is what Unity keys saved edits to (bunker lips, paint), and OPCD
    carries it into the mesh name (Spline_hole_1_3_Bunker_-_Mesh). Adding,
    removing or reordering other features on the hole must not rename it."""
    semi = ("semi_rough", 1, 0, [_ring((0.40, 0.40), 40)], "bspline", 1, "semi")
    fairway = ("fairway", 1, 1, [_ring((0.40, 0.40), 30)], "bspline", 2, "fairway")
    bunker = ("bunker", 1, 2, [_ring((0.42, 0.42), 5)], "bspline", 3, "bunker")
    rough = ("rough", 1, -1, [_ring((0.40, 0.40), 60)], "bspline", 4, "rough")

    def bunker_name(features, sub):
        root = ET.parse(_export(tmp_path / sub, features)).getroot()
        return [p.get("id") for p in root.iter(f"{SVG_NS}path") if p.get("data-feature-id") == "bunker"]

    assert bunker_name([semi, fairway, bunker], "a") == ["hole_1_3"]
    assert bunker_name([rough, semi, fairway, bunker], "b") == ["hole_1_3"]  # a rough drawn under it
    assert bunker_name([semi, bunker], "c") == ["hole_1_3"]                  # the fairway deleted
    assert bunker_name([bunker, fairway, semi], "d") == ["hole_1_3"]         # listed in another order


def test_an_unnumbered_feature_is_named_after_its_id(tmp_path):
    """Generated features have no number (and a database from before the
    server's migration 026 has none at all): 5 characters of the id, more only
    where an older shape already has that name."""
    feats = [
        ("bunker", 1, 0, [_ring((0.42, 0.42), 5)], "bspline", None, "abcde111-old"),
        ("bunker", 1, 1, [_ring((0.45, 0.45), 5)], "bspline", None, "abcde000-new"),  # sorts first by id
        ("bunker", 1, 2, [_ring((0.48, 0.48), 5)], "bspline", 7, "7b20e4aa-numbered"),
    ]
    assert dict(_layers(_export(tmp_path / "a", feats)))["Hole1"] == ["hole_1_abcde", "hole_1_abcde0", "hole_1_7"]
    assert dict(_layers(_export(tmp_path / "b", feats, numbered=False)))["Hole1"] == ["hole_1_abcde", "hole_1_abcde0", "hole_1_7b20e"]


def _types_in(out, layer):
    root = ET.parse(out).getroot()
    g = next(g for g in root.findall(f"{SVG_NS}g") if g.get(f"{INK_NS}label") == layer)
    return [p.get("data-type") for p in g.findall(f"{SVG_NS}path")]


def test_stack_app_keeps_the_draw_tools_order(tmp_path):
    """--stack app reproduces the course's own sort_order verbatim, warts and
    all — including a fairway the draw tool has above its green."""
    feats = [
        ("green", 1, 0, [_ring((0.40, 0.40), 12)], "bspline"),
        ("fairway", 1, 1, [_ring((0.40, 0.40), 30)], "bspline"),
    ]
    assert _types_in(_export(tmp_path, feats, stack="app"), "Hole1") == ["green", "fairway"]


def test_stack_opcd_lifts_green_tee_bunker_and_leaves_the_rest_alone(tmp_path):
    """--stack opcd (the default): green, tee and bunker always end up on top
    so nothing on the hole cuts them; every other type keeps the order it has
    in the app, interleaving and all."""
    feats = [
        ("green", 1, 0, [_ring((0.40, 0.40), 12)], "bspline"),
        ("fairway", 1, 1, [_ring((0.40, 0.40), 30)], "bspline"),
        ("deep_rough", 1, 2, [_ring((0.40, 0.40), 60)], "bspline"),
        ("bunker", 1, 3, [_ring((0.41, 0.41), 5)], "bspline"),
        ("semi_rough", 1, 4, [_ring((0.40, 0.40), 45)], "bspline"),
        ("deep_rough", 1, 5, [_ring((0.39, 0.39), 55)], "bspline"),
    ]
    assert _types_in(_export(tmp_path, feats, stack="opcd"), "Hole1") == [
        # untouched app order...
        "fairway", "deep_rough", "semi_rough", "deep_rough",
        # ...then the three lifted, also in app order
        "green", "bunker"]


def test_the_roughs_layer_is_written_under_the_course_level_features(tmp_path):
    """The app's Roughs layer (course_features.layer = 'roughs', no hole) sits
    under everything, so inside Others its shapes come before the course-level
    ones whatever their sort_order."""
    feats = [
        ("water", None, 0, [_ring((0.20, 0.70), 25)], "bspline"),
        ("rough", None, 7, [_ring((0.20, 0.70), 60)], "bspline"),
    ]
    tmp_path.mkdir(parents=True, exist_ok=True)
    db = tmp_path / "app.sqlite"
    _make_db(db, feats)
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE course_features ADD COLUMN layer TEXT")
    conn.execute("UPDATE course_features SET layer = 'roughs' WHERE type = 'rough'")
    conn.commit()
    conn.close()
    out = tmp_path / "course.svg"
    gspro.cmd_svg(BBOX, out, db, "Testbana", flatten=None, precision=3, mapped={}, stack="app")
    assert _types_in(out, "Others") == ["rough", "water"]


def test_roads_get_their_own_layer_on_top_of_everything(tmp_path):
    """Roads and paths, on a hole or not and whatever their sort_order, go to
    a 'Roads' layer written last — topmost in Inkscape, over Hole1 — the
    opposite end of the stack from the Roughs."""
    feats = BASIC + [
        ("path", None, -5, [_ring((0.30, 0.50), 8)], "bspline"),
        ("path", 1, 0, [_ring((0.41, 0.41), 4)], "bspline"),
    ]
    for stack in ("app", "opcd"):
        layers = _layers(_export(tmp_path / stack, feats, stack=stack))
        assert [label for label, _ in layers] == ["Others", "Hole2", "Hole1", "Roads"]
        assert dict(layers)["Roads"] == ["roads_7", "roads_8"]  # named after their pieces' numbers
        assert "path" not in _types_in(tmp_path / stack / "course.svg", "Hole1")


def test_the_lift_does_not_reach_across_layers(tmp_path):
    """Lifting is per layer: hole 1's green must not jump over hole 2's
    shapes, and off-hole features stay in Others."""
    feats = [
        ("green", 1, 0, [_ring((0.40, 0.40), 12)], "bspline"),
        ("fairway", 1, 1, [_ring((0.40, 0.40), 30)], "bspline"),
        ("green", 2, 0, [_ring((0.60, 0.60), 12)], "bspline"),
        ("fairway", 2, 1, [_ring((0.60, 0.60), 30)], "bspline"),
        ("water", None, 0, [_ring((0.20, 0.70), 25)], "bspline"),
    ]
    out = _export(tmp_path, feats, stack="opcd")
    assert _types_in(out, "Hole1") == ["fairway", "green"]
    assert _types_in(out, "Hole2") == ["fairway", "green"]
    assert _types_in(out, "Others") == ["water"]


def test_stack_opcd_keeps_sort_order_within_one_type(tmp_path):
    feats = [
        ("semi_rough", 1, 7, [_ring((0.40, 0.40), 40)], "bspline"),
        ("semi_rough", 1, 2, [_ring((0.44, 0.44), 40)], "bspline"),
    ]
    root = ET.parse(_export(tmp_path, feats, stack="opcd")).getroot()
    assert [p.get("id") for p in root.iter(f"{SVG_NS}path")] == ["hole_1_2", "hole_1_1"]
    # the sort_order 2 shape (further east) is still written first
    ds = [p.get("d") for p in root.iter(f"{SVG_NS}path")]
    xs = [float(re.match(r"M (-?[\d.]+)", d).group(1)) for d in ds]
    assert xs[0] > xs[1]


def test_fills_are_the_opcd_palette_and_nothing_is_stroked(tmp_path):
    """Hexes are OPCD_v4.gpl verbatim: water is the palette's Lake, creek its
    Creek. Fill colour is what tells the toolchain what a shape is."""
    root = ET.parse(_export(tmp_path, BASIC)).getroot()
    styles = {p.get("data-type"): p.get("style") for p in root.iter(f"{SVG_NS}path")}
    assert "fill:#36b74d" in styles["semi_rough"]
    assert "fill:#43e561" in styles["fairway"]
    assert "fill:#e5e5aa" in styles["bunker"]
    assert "fill:#bce5a4" in styles["green"]
    assert "fill:#0000c0" in styles["water"]  # Lake
    assert all("stroke:none" in s for s in styles.values())
    assert not any(p.get("stroke") for p in root.iter(f"{SVG_NS}path"))


def test_untyped_features_are_skipped_until_mapped(tmp_path):
    """A type with no OPCD surface (trees) is left out rather than guessed at;
    --map takes an OPCD palette name or a raw hex."""
    feats = [("trees", 1, 0, [_ring((0.4, 0.4), 20)], "bspline")] + BASIC
    assert 'data-type="trees"' not in ET.tostring(ET.parse(_export(tmp_path, feats)).getroot(), "unicode")

    out = _export(tmp_path / "b", feats, mapped=gspro._parse_map(["trees=pinestraw"]))
    trees = [p for p in ET.parse(out).getroot().iter(f"{SVG_NS}path") if p.get("data-type") == "trees"]
    assert len(trees) == 1 and "fill:#b84127" in trees[0].get("style")


def test_map_accepts_palette_names_aliases_and_hexes():
    assert gspro._parse_map(["trees=pinestraw"]) == {"trees": "#b84127"}
    assert gspro._parse_map(["trees=pine_straw"]) == {"trees": "#b84127"}
    assert gspro._parse_map(["path=concrete"]) == {"path": "#bebebb"}
    assert gspro._parse_map(["oob=custom4"]) == {"oob": "#faa0be"}
    assert gspro._parse_map(["trees=#B84127"]) == {"trees": "#b84127"}


def test_palette_matches_opcd_v4_gpl():
    """Guard against drift from the installed OPCD v4 palette."""
    assert gspro.OPCD_PALETTE["pinestraw"] == "#b84127"
    assert gspro.OPCD_PALETTE["concrete"] == "#bebebb"
    assert gspro.OPCD_PALETTE["custom4"] == "#faa0be"
    assert gspro.OPCD_PALETTE["hole99"] == "#ff00cb"
    assert gspro.GSPRO_FILLS["water"] == gspro.OPCD_PALETTE["lake"]
    assert gspro.GSPRO_FILLS["water_creek"] == gspro.OPCD_PALETTE["creek"]
    assert gspro.GSPRO_FILLS["path"] == gspro.OPCD_PALETTE["concrete"]
    # Types OPCD has no surface for must NOT get a silent default.
    assert not {"trees", "penalty_red", "penalty_yellow", "oob", "outside"} & set(gspro.GSPRO_FILLS)


def test_map_rejects_junk():
    with pytest.raises(SystemExit):
        gspro._parse_map(["trees=chartreuse"])
    with pytest.raises(SystemExit):
        gspro._parse_map(["trees"])


def test_viewbox_is_the_square_extent_in_metres(tmp_path):
    """1 SVG user unit = 1 m over the same square the ortho and hillshade
    commands render, and the document is that many mm so Inkscape agrees."""
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    side = e1 - e0
    root = ET.parse(_export(tmp_path, BASIC)).getroot()
    assert root.get("viewBox") == f"0 0 {side:.3f} {side:.3f}"
    assert root.get("width") == f"{side:.3f}mm" == root.get("height")


def test_north_is_up_and_the_origin_is_the_north_west_corner(tmp_path):
    """SVG y runs DOWN, so a feature in the north-west maps near (0, 0) and
    one in the south-east near (side, side)."""
    feats = [
        ("green", 1, 0, [_ring((0.1, 0.9), 5)], "bspline"),   # north-west
        ("green", 2, 0, [_ring((0.9, 0.1), 5)], "bspline"),   # south-east
    ]
    root = ET.parse(_export(tmp_path, feats)).getroot()
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    side = e1 - e0

    def first_point(pid):
        d = next(p for p in root.iter(f"{SVG_NS}path") if p.get("id") == pid).get("d")
        x, y = re.match(r"M (-?[\d.]+),(-?[\d.]+)", d).groups()
        return float(x), float(y)

    nw, se = first_point("hole_1_1"), first_point("hole_2_2")
    assert nw[0] == pytest.approx(0.1 * side, abs=30)
    assert nw[1] == pytest.approx(0.1 * side, abs=30)  # 90% north -> 10% down
    assert se[0] == pytest.approx(0.9 * side, abs=30)
    assert se[1] == pytest.approx(0.9 * side, abs=30)


def test_holes_in_a_feature_punch_through(tmp_path):
    """A feature with several rings becomes one even-odd path, so the inner
    rings are holes rather than separate filled blobs."""
    feats = [("water", 1, 0, [_ring((0.5, 0.5), 60), _ring((0.5, 0.5), 20)], "bspline")]
    path = next(p for p in ET.parse(_export(tmp_path, feats)).getroot().iter(f"{SVG_NS}path"))
    assert path.get("fill-rule") == "evenodd"
    assert path.get("d").count("M ") == 2


def test_bspline_ring_matches_the_apps_bezier_expansion():
    """Control ring -> bezier is the same math as web/src/geo/bspline.ts: for
    controls p0..p3 the anchor is (p0 + 4·p1 + p2)/6 with handles at thirds."""
    pts = [{"x": 0.0, "y": 0.0}, {"x": 10.0, "y": 0.0}, {"x": 10.0, "y": 10.0}, {"x": 0.0, "y": 10.0}]
    anchors = gspro._bspline_ring_anchors(pts)
    assert len(anchors) == 4
    p0, p1, p2 = (0.0, 0.0), (10.0, 0.0), (10.0, 10.0)
    assert anchors[0]["p"] == pytest.approx(((p0[0] + 4 * p1[0] + p2[0]) / 6,
                                             (p0[1] + 4 * p1[1] + p2[1]) / 6))
    assert anchors[0]["hout"] == pytest.approx(((2 * p1[0] + p2[0]) / 3, (2 * p1[1] + p2[1]) / 3))
    # The curve stays inside the control polygon's convex hull.
    assert all(0 <= a["p"][0] <= 10 and 0 <= a["p"][1] <= 10 for a in anchors)


def test_corner_controls_pull_the_curve_onto_the_point():
    """A `corner` control is triplicated (knot multiplicity 3), so the curve
    passes exactly through it."""
    pts = [{"x": 0.0, "y": 0.0, "corner": True}, {"x": 10.0, "y": 0.0},
           {"x": 10.0, "y": 10.0}, {"x": 0.0, "y": 10.0}]
    anchors = gspro._bspline_ring_anchors(pts)
    assert len(anchors) == 6  # 3 + 3 singles
    assert any(a["p"] == pytest.approx((0.0, 0.0)) for a in anchors)


def test_flatten_emits_polylines_close_to_the_curve(tmp_path):
    """--flatten trades the C commands for L commands within the tolerance."""
    feats = [("green", 1, 0, [_ring((0.5, 0.5), 40, n=8)], "bspline")]
    curved = ET.parse(_export(tmp_path / "c", feats)).getroot()
    flat = ET.parse(_export(tmp_path / "f", feats, flatten=0.05)).getroot()

    d_curved = next(p for p in curved.iter(f"{SVG_NS}path")).get("d")
    d_flat = next(p for p in flat.iter(f"{SVG_NS}path")).get("d")
    assert "C" in d_curved and "L" not in d_curved
    assert "L" in d_flat and "C" not in d_flat

    def pts(d):
        return [tuple(map(float, m.split(","))) for m in re.findall(r"(-?[\d.]+,-?[\d.]+)", d)]

    # Every flattened vertex sits on the curve, so the two share a bbox.
    cb, fb = pts(d_curved), pts(d_flat)
    for axis in (0, 1):
        assert min(p[axis] for p in fb) == pytest.approx(min(p[axis] for p in cb), abs=0.5)
        assert max(p[axis] for p in fb) == pytest.approx(max(p[axis] for p in cb), abs=0.5)


def test_legacy_bezier_geometry_still_exports(tmp_path):
    """Older features are 'bezier': points lie on the curve, handles optional."""
    cx, cy = _square((0.5, 0.5))
    rings = [{"points": [
        {"x": cx, "y": cy, "hOut": {"x": cx + 5, "y": cy}},
        {"x": cx + 20, "y": cy, "hIn": {"x": cx + 15, "y": cy}},
        {"x": cx + 20, "y": cy + 20},
    ]}]
    out = _export(tmp_path, [("green", 1, 0, rings, "bezier")])
    assert next(ET.parse(out).getroot().iter(f"{SVG_NS}path")).get("d").endswith("Z")


def test_unknown_course_lists_what_it_knows(tmp_path):
    db = tmp_path / "app.sqlite"
    _make_db(db, BASIC)
    with pytest.raises(SystemExit, match="Testbana"):
        gspro.cmd_svg(BBOX, tmp_path / "x.svg", db, "Nowhere", None, 3, {})


def test_course_resolves_by_name_substring_or_id(tmp_path):
    db = tmp_path / "app.sqlite"
    _make_db(db, BASIC)
    conn = gspro._open_course_db(db)
    assert gspro._resolve_course(conn, "testb")["id"] == COURSE
    assert gspro._resolve_course(conn, COURSE)["name"] == "Testbana"
    conn.close()


def _rect(x0, y0, x1, y1):
    """An axis-aligned ring in metres from the extent's centre (straight edges)."""
    cx, cy = _square((0.5, 0.5))
    return {"points": [{"x": cx + x, "y": cy + y} for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]}


def _shape(out, pid):
    """A written path as a shapely geometry in SVG units (even-odd rings)."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    d = next(p for p in ET.parse(out).getroot().iter(f"{SVG_NS}path") if p.get("id") == pid).get("d")
    rings = [Polygon([tuple(map(float, xy.split(","))) for xy in re.findall(r"(-?[\d.]+,-?[\d.]+)", sub)])
             for sub in d.split("Z") if sub.strip()]
    shape = rings[0]
    for r in rings[1:]:
        shape = shape.symmetric_difference(r)
    return unary_union(shape)


def test_touching_road_pieces_are_one_shape_with_the_slits_between_them_closed(tmp_path):
    """Blender cuts each shape on its own, so a road and the kerb fillet, drawn
    parking area or next road beside it are written as ONE shape: a hairline
    slit between them (here 0.2 m) is closed, the ids of every piece kept."""
    feats = [
        ("path", None, 0, [_rect(-30, -3, 0, 3)], "bezier"),
        ("path", None, 1, [_rect(0.2, -3, 30, 3)], "bezier"),   # 0.2 m short of the first
        ("path", None, 2, [_rect(80, -3, 90, 3)], "bezier"),    # apart: its own shape
    ]
    out = _export(tmp_path, feats)
    assert dict(_layers(out))["Roads"] == ["roads_1", "roads_3"]
    root = ET.parse(out).getroot()
    ids = {p.get("id"): p.get("data-feature-id") for p in root.iter(f"{SVG_NS}path")}
    assert ids == {"roads_1": "feat-0 feat-1", "roads_3": "feat-2"}
    road = _shape(out, "roads_1")
    assert road.geom_type == "Polygon" and not road.interiors
    assert road.area == pytest.approx(60 * 6, rel=1e-3)  # the slit filled


def _road_ids(out):
    """{road shape id: data-feature-id} for the Roads layer."""
    root = ET.parse(out).getroot()
    g = next(g for g in root.findall(f"{SVG_NS}g") if g.get(f"{INK_NS}label") == "Roads")
    return {p.get("id"): p.get("data-feature-id") for p in g.findall(f"{SVG_NS}path")}


def test_a_merged_road_is_named_after_its_lowest_numbered_piece(tmp_path):
    """roads_<lowest feature number in hex>, like every other shape, whatever
    order the pieces are painted in; a road of generated (unnumbered) pieces
    only - kerb fillets - takes its oldest piece's id-derived name."""
    feats = [
        ("path", None, 0, [_rect(-30, -3, 0, 3)], "bezier", 0x2b, "road-a"),
        ("path", None, 1, [_rect(0, -3, 30, 3)], "bezier", 0x1c, "road-b"),     # touches road-a, lower number
        ("path", None, 2, [_rect(80, -3, 90, 3)], "bezier", None, "f1llet-old"),
        ("path", None, 3, [_rect(90, -3, 95, 3)], "bezier", None, "0fillet-new"),  # sorts first by id, drawn later
    ]
    ids = _road_ids(_export(tmp_path, feats))
    assert ids == {"roads_1c": "road-a road-b", "roads_f1lle": "f1llet-old 0fillet-new"}


def test_adding_an_unrelated_road_does_not_rename_a_merged_road(tmp_path):
    """The name is what Blender/Unity key shaping and edits to: a road drawn
    elsewhere - even painted before the others, even a generated one - and a
    piece added to the road itself leave the existing names alone."""
    road = ("path", None, 5, [_rect(-30, -3, 0, 3)], "bezier", 5, "road")
    lane = ("path", None, 6, [_rect(40, -3, 60, 3)], "bezier", 9, "lane")
    before = _road_ids(_export(tmp_path / "a", [road, lane]))
    assert before == {"roads_5": "road", "roads_9": "lane"}

    newer = ("path", None, -1, [_rect(-80, 20, -60, 26)], "bezier", 12, "newer")   # painted first
    fillet = ("path", None, 0, [_rect(-90, -3, -85, 3)], "bezier", None, "00fillet")
    spur = ("path", None, 7, [_rect(0, -3, 10, 3)], "bezier", 13, "spur")          # joins "road"
    after = _road_ids(_export(tmp_path / "b", [road, lane, newer, fillet, spur]))
    assert after["roads_5"] == "road spur" and after["roads_9"] == "lane"
    assert after["roads_c"] == "newer" and after["roads_00fil"] == "00fillet"


def test_road_names_stay_unique_when_two_roads_share_their_lowest_piece():
    """A piece can reach into two merged roads (the merge opens a thin neck):
    the road ranking first keeps the number, the other takes its next piece's,
    and one with no other piece a suffix."""
    rows = [{"id": i, "feature_no": n} for i, n in (("a", 3), ("b", 7), ("c", None))]
    shape_ids = gspro._shape_ids(rows)
    road = lambda *ids: gspro.MergedRoad("path", "#000000", None, list(ids))
    assert gspro._road_names([road("b", "a"), road("a")], rows, shape_ids) == ["7", "3"]
    assert gspro._road_names([road("a"), road("a"), road("c")], rows, shape_ids) == ["3", "3_2", "c"]


def test_a_small_hole_inside_the_roads_is_filled_a_big_one_kept(tmp_path):
    """Four pieces round a 0.5 m pocket fill it; a ring road round a real island keeps it."""
    feats = [
        ("path", None, 0, [_rect(-10, -10, 10, -0.25), _rect(-0.25, -0.25, 0.25, 0.25)], "bezier"),
        ("path", None, 1, [_rect(-10, 0.25, 10, 10)], "bezier"),
        ("path", None, 2, [_rect(-10, -0.25, -0.25, 0.25)], "bezier"),
        ("path", None, 3, [_rect(0.25, -0.25, 10, 0.25)], "bezier"),
        ("path", None, 4, [_rect(40, -10, 60, 10), _rect(45, -5, 55, 5)], "bezier"),
    ]
    out = _export(tmp_path, feats)
    pocket = _shape(out, "roads_1")
    assert pocket.geom_type == "Polygon" and not pocket.interiors
    ring = _shape(out, "roads_5")
    assert ring.area == pytest.approx(400 - 100, rel=1e-3)


def test_a_rough_drawn_just_short_of_a_road_is_grown_to_it(tmp_path):
    """A 0.4 m sliver between a road and the rough beside it goes to the rough
    (written flattened); a green the same distance off is left alone."""
    feats = [
        ("path", None, 0, [_rect(-50, -3, 50, 3)], "bezier"),
        ("rough", 1, 0, [_rect(-50, 3.4, 50, 30)], "bezier"),
        ("green", 1, 1, [_rect(-20, -20, 20, -3.4)], "bezier"),
    ]
    out = _export(tmp_path, feats)
    rough = _shape(out, "hole_1_2")
    assert rough.area == pytest.approx(100 * (30 - 3) + 100 * 0.02, rel=2e-3)  # down to the kerb, a hair under it
    green = _shape(out, "hole_1_3")
    assert green.area == pytest.approx(40 * 16.6, rel=1e-6)


# Vreta hole 1, where the new fairway's edge comes out from under a curving
# path at a slant (metres from a local origin, as drawn, flattened).
SLANT_ROAD = [(1.18, -4.66), (0.65, -3.35), (0.27, -2.14), (0.22, -1.94), (0.01, -0.66), (-0.07, 0.74), (0.0, 3.35),
              (0.24, 6.0), (3.25, 6.0), (3.0, 3.23), (2.93, 0.74), (3.0, -0.37), (3.16, -1.32), (3.46, -2.3),
              (3.91, -3.4), (5.17, -6.0), (1.83, -6.0)]
SLANT_FAIRWAY = [(0.54, 5.34), (-0.07, 1.54), (-0.2, 0.57), (-0.65, -6.0), (-6.0, -6.0), (-6.0, 6.0), (0.62, 6.0)]


def test_a_surface_leaving_a_road_at_a_slant_gets_no_spike_along_the_kerb(tmp_path):
    """The wedge between the fairway's edge and the path it leaves is filled
    only up to a cut square to the path, not with the closing's slanted end,
    which ran down along the kerb into a spike beside a notch."""
    from shapely.geometry import Point, Polygon
    cx, cy = _square((0.5, 0.5))
    e0, _, _, n1 = gspro._square_3006_extent(BBOX)
    to_svg = lambda x, y: (cx + x - e0, n1 - (cy + y))
    ring = lambda pts: {"points": [{"x": cx + x, "y": cy + y} for x, y in pts]}
    out = _export(tmp_path, [("path", None, 0, [ring(SLANT_ROAD)], "bezier"),
                             ("fairway", 1, 0, [ring(SLANT_FAIRWAY)], "bezier")])
    road = Polygon([to_svg(*p) for p in SLANT_ROAD])
    added = _shape(out, "hole_1_2").difference(Polygon([to_svg(*p) for p in SLANT_FAIRWAY])).difference(road.buffer(0.03))
    assert added.area > 0.1  # the narrow part of the wedge is filled
    # Nothing added more than a few cm from the fairway's own edge: a spike runs away from it along the kerb.
    edge = Polygon([to_svg(*p) for p in SLANT_FAIRWAY]).boundary
    assert max(edge.distance(Point(c)) for p in gspro._polygons(added) for c in p.exterior.coords) < 0.4  # the slanted end: 0.58


def test_a_hairline_along_a_road_is_not_a_gap(tmp_path):
    """A surface drawn 1 mm short of the kerb for 40 m: not grown into a
    needle along the road (the overlap alone would make it 4 cm wide)."""
    feats = [
        ("path", None, 0, [_rect(-50, -3, 50, 3)], "bezier"),
        ("rough", 1, 0, [_rect(-20, 3.001, 20, 30)], "bezier"),
    ]
    out = _export(tmp_path, feats)
    assert _shape(out, "hole_1_2").area == pytest.approx(40 * 26.999, rel=1e-6)


# --- Exclusions (test variants of the SVG for the Blender build) -------------


def _feature_ids(out):
    return sorted(p.get("data-feature-id") for p in ET.parse(out).getroot().iter(f"{SVG_NS}path"))


def test_excluded_ids_and_types_are_left_out_and_reported(tmp_path, capsys):
    """Excluding by id drops exactly those shapes; by type every shape of it.
    The report counts what went, and warns about ids the course doesn't have."""
    out = _export(tmp_path, BASIC, exclude_ids={"feat-2", "feat-4", "gone-1"}, exclude_types={"water"})
    assert _feature_ids(out) == ["feat-0", "feat-1", "feat-3"]
    report = capsys.readouterr().out
    assert "excluded on request: 3 feature(s)" in report
    assert "1 excluded id(s) are not features of this course" in report and "gone-1" in report


def test_excluding_everything_on_a_hole_drops_its_layer(tmp_path):
    out = _export(tmp_path, BASIC, exclude_ids={"feat-3", "feat-4"})
    assert [label for label, _ in _layers(out)] == ["Others", "Hole1"]


def test_an_excluded_road_takes_its_junction_fillets_with_it(tmp_path):
    """The server stores a road's kerb fillets as generated `path` features
    (source road-junctions, source_ref = the roads' ids); excluding a road must
    not leave its fillet behind as an orphan patch."""
    feats = [
        ("path", None, 0, [_rect(-30, -3, 0, 3)], "bezier"),
        ("path", None, 1, [_rect(80, -3, 90, 3)], "bezier"),
        ("path", None, 2, [_rect(0, 3, 2, 5)], "bezier"),    # fillet of feat-0
        ("path", None, 3, [_rect(90, 3, 92, 5)], "bezier"),  # fillet of feat-1
    ]
    db = tmp_path / "app.sqlite"
    _make_db(db, feats)
    conn = sqlite3.connect(db)
    conn.executescript("ALTER TABLE course_features ADD COLUMN source TEXT;"
                       "ALTER TABLE course_features ADD COLUMN source_ref TEXT;")
    conn.execute("UPDATE course_features SET source = 'road-junctions', source_ref = 'feat-0' WHERE id = 'feat-2'")
    conn.execute("UPDATE course_features SET source = 'road-junctions', source_ref = 'feat-1' WHERE id = 'feat-3'")
    conn.commit()
    conn.close()
    out = tmp_path / "course.svg"
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app", exclude_ids={"feat-0"})
    assert _feature_ids(out) == ["feat-1 feat-3"]


def test_bridge_decks_are_props_not_ground_and_stay_out_with_their_fillets(tmp_path, capsys):
    """A path with surface=bridge is a bridge deck placed as a prop in Unity; in
    the SVG it would lie across the creek under it and break the Blender build."""
    feats = [
        ("path", None, 0, [_rect(-30, -3, 0, 3)], "bezier"),    # an ordinary path
        ("path", None, 1, [_rect(80, -3, 90, 3)], "bezier"),    # a bridge deck
        ("path", None, 2, [_rect(90, 3, 92, 5)], "bezier"),     # the deck's kerb fillet
    ]
    db = tmp_path / "app.sqlite"
    _make_db(db, feats)
    conn = sqlite3.connect(db)
    conn.executescript("ALTER TABLE course_features ADD COLUMN source TEXT;"
                       "ALTER TABLE course_features ADD COLUMN source_ref TEXT;"
                       "ALTER TABLE course_features ADD COLUMN attributes_json TEXT;")
    conn.execute("""UPDATE course_features SET source = 'props-bridges', attributes_json = '{"surface":"bridge"}' WHERE id = 'feat-1'""")
    conn.execute("UPDATE course_features SET source = 'road-junctions', source_ref = 'feat-1' WHERE id = 'feat-2'")
    conn.execute("""UPDATE course_features SET attributes_json = '{"surface":"gravel"}' WHERE id = 'feat-0'""")
    conn.commit()
    conn.close()
    out = tmp_path / "course.svg"
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app")
    assert _feature_ids(out) == ["feat-0"]
    assert "bridge decks left out (props in Unity, not ground): 2 feature(s)" in capsys.readouterr().out


def test_a_shape_that_collapsed_while_drawing_is_left_out_and_named(tmp_path, capsys):
    """A bunker of 8 points inside 0.4 x 0.15 m (a click that became a feature)
    breaks OPCD's Blender build; small road pieces (kerb fillets) are fine
    when they touch a road, which they merge into."""
    feats = [
        ("bunker", 1, 0, [_ring((0.42, 0.42), 5)], "bspline"),
        ("bunker", None, 1, [_ring((0.60, 0.60), 0.2)], "bspline"),   # the slip
        ("path", None, 2, [_rect(0, 0, 0.5, 0.5)], "bezier"),          # a tiny road piece: a fillet
        ("path", None, 3, [_rect(0.5, -3, 30, 3)], "bezier"),          # the road it fillets
    ]
    out = _export(tmp_path, feats)
    ids = _feature_ids(out)
    assert "feat-1" not in " ".join(ids)
    assert "feat-0" in ids and any("feat-2" in i and "feat-3" in i for i in ids)
    assert "warning: 1 shape(s) under 1 m2 left out (drawn by mistake? delete them): bunker feat-1" in capsys.readouterr().out


def test_exclude_ids_file_is_a_json_array_or_one_id_per_line(tmp_path):
    js = tmp_path / "ids.json"
    js.write_text('["a", " b ", ""]', encoding="utf-8")
    assert gspro._read_exclude_ids(js) == {"a", "b"}
    txt = tmp_path / "ids.txt"
    txt.write_text("# broken paths\na\n\n  b\n", encoding="utf-8")
    assert gspro._read_exclude_ids(txt) == {"a", "b"}
    assert gspro._read_exclude_ids(None) == set()


# --- Nothing past the terrain square ------------------------------------------


def _edge_ring(fx, fy, radius_m, n=8):
    """A b-spline control ring centred at (fx, fy) of the extent."""
    return _ring((fx, fy), radius_m, n)


def test_a_creek_reaching_past_the_square_is_cut_to_it(tmp_path, capsys):
    """Blender cuts the meshes out of the terrain, so a shape overhanging the
    square's edge breaks the build: it is written cut to the square instead."""
    feats = [("water_creek", None, 0, [_edge_ring(0.999, 0.5, 20)], "bspline")]
    out = _export(tmp_path, feats)
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    side = e1 - e0
    creek = _shape(out, "others_1")
    x0, y0, x1, y1 = creek.bounds
    assert x1 <= side + 1e-3 and x0 >= 0 and y0 >= 0 and y1 <= side
    assert x1 == pytest.approx(side, abs=1e-3)  # reaches the edge, not short of it
    assert "1 shape(s) reached past the terrain square and were cut to it" in capsys.readouterr().out


def test_a_shape_whose_control_points_are_outside_but_curve_inside_keeps_its_curves(tmp_path, capsys):
    """A b-spline passes inside its control points: one control point just past
    the edge doesn't mean the curve is, and then nothing is cut or flattened."""
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    ring = _edge_ring(0.5, 0.5, 20, n=8)
    ring["points"][0]["x"] = e1 + 0.5  # a spike out to the edge; the curve stays well inside
    ring["points"][0]["y"] = (n0 + n1) / 2
    for p in ring["points"][1:]:
        p["x"] = e1 - 60 + (p["x"] - (e0 + e1) / 2)
    out = _export(tmp_path, [("water_creek", None, 0, [ring], "bspline")])
    d = next(p for p in ET.parse(out).getroot().iter(f"{SVG_NS}path")).get("d")
    assert "C" in d  # still cubic beziers
    assert "cut to it" not in capsys.readouterr().out


def test_a_shape_wholly_outside_the_square_is_left_out(tmp_path, capsys):
    feats = [
        ("water", None, 0, [_edge_ring(1.2, 0.5, 20)], "bspline"),
        ("green", 1, 0, [_edge_ring(0.5, 0.5, 20)], "bspline"),
    ]
    out = _export(tmp_path, feats)
    assert [label for label, _ in _layers(out)] == ["Hole1"]
    assert "1 shape(s) lie wholly outside the terrain square and were left out: water 1" in capsys.readouterr().out


def test_a_road_running_off_the_square_is_cut_at_its_edge(tmp_path):
    e0, n0, e1, n1 = gspro._square_3006_extent(BBOX)
    half = (e1 - e0) / 2
    out = _export(tmp_path, [("path", None, 0, [_rect(half - 50, -3, half + 50, 3)], "bezier")])
    x0, _, x1, _ = _shape(out, "roads_1").bounds
    assert x1 == pytest.approx(e1 - e0, abs=1e-3)
    assert x1 - x0 == pytest.approx(50, abs=0.2)


def _export_with_surfaces(tmp_path, features, surfaces):
    """_export with attributes_json {"surface": ...} set on the features named in `surfaces` ({id: surface})."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    db = tmp_path / "app.sqlite"
    _make_db(db, features)
    conn = sqlite3.connect(db)
    conn.execute("ALTER TABLE course_features ADD COLUMN attributes_json TEXT")
    for fid, surface in surfaces.items():
        conn.execute("UPDATE course_features SET attributes_json = ? WHERE id = ?", (json.dumps({"surface": surface}), fid))
    conn.commit()
    conn.close()
    out = tmp_path / "course.svg"
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app")
    return out


def _road_attrs(out, attr):
    root = ET.parse(out).getroot()
    g = next(g for g in root.findall(f"{SVG_NS}g") if g.get(f"{INK_NS}label") == "Roads")
    return [(p.get("id"), p.get(attr)) for p in g.findall(f"{SVG_NS}path")]


def test_roads_of_mixed_surfaces_are_one_shape_and_the_sidecar_says_which_parts_are_what(tmp_path):
    """A gravel lane joining an asphalt road is ONE merged shape (what OPCD
    builds best; splitting it in the SVG left slivers at every junction). The
    sidecar beside the SVG says the shape's dominant surface and lists every
    piece with its surface and outline, for the Blender step that cuts the
    mesh apart."""
    feats = [
        ("path", None, 0, [_rect(-30, -3, 0, 3)], "bezier", 4, "road"),
        ("path", None, 1, [_rect(0.2, -2, 30, 2)], "bezier", 2, "lane"),    # 0.2 m short of the road
    ]
    out = _export_with_surfaces(tmp_path, feats, {"road": "asphalt", "lane": "gravel"})
    assert _road_attrs(out, "data-surface") == [("roads_2", None)]
    assert dict(_road_attrs(out, "data-feature-id")) == {"roads_2": "road lane"}
    assert _shape(out, "roads_2").area == pytest.approx(30 * 6 + 29.8 * 4 + 0.2 * 4, rel=1e-3)  # slit closed
    sidecar = json.loads(gspro.path_surfaces_file(out).read_text(encoding="utf-8"))
    assert sidecar["format"] == "golfmap-path-regions-v1" and sidecar["svg"] == "course.svg"
    assert sidecar["shapes"] == {"roads_2": "asphalt"}          # by area
    region = sidecar["regions"]["roads_2"]
    assert region["mixed"] is True
    assert {(p["id"], p["surface"], p["featureNo"]) for p in region["pieces"]} == {("road", "asphalt", 4), ("lane", "gravel", 2)}
    assert all(len(p["rings"]) == 1 and len(p["rings"][0]) >= 4 for p in region["pieces"])


def test_paths_only_rewrites_the_surfaces_file_of_the_exported_svg_and_says_what_changed(tmp_path, capsys):
    """After a path changed surface in the Draw panel, `svg --paths-only`
    rewrites just the sidecar from the course as it is now: the SVG (and so
    the meshes OPCD built from it) stands, the report names the shape and its
    new state. An outline that moved since the export is a warning: the
    meshes cannot follow that without a new SVG and build."""
    feats = [
        ("path", None, 0, [_rect(-30, -3, 0, 3)], "bezier", 4, "road"),
        ("path", None, 1, [_rect(0.2, -2, 30, 2)], "bezier", 2, "lane"),
    ]
    out = _export_with_surfaces(tmp_path, feats, {"road": "asphalt", "lane": "asphalt"})
    db = tmp_path / "app.sqlite"
    svg_before = out.read_bytes()
    assert json.loads(gspro.path_surfaces_file(out).read_text(encoding="utf-8"))["regions"]["roads_2"]["mixed"] is False

    conn = sqlite3.connect(db)
    conn.execute("UPDATE course_features SET attributes_json = ? WHERE id = 'lane'", (json.dumps({"surface": "gravel"}),))
    conn.commit()
    capsys.readouterr()
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app", paths_only=True)
    report = capsys.readouterr().out
    assert out.read_bytes() == svg_before
    sidecar = json.loads(gspro.path_surfaces_file(out).read_text(encoding="utf-8"))
    assert sidecar["svg"] == "course.svg" and sidecar["regions"]["roads_2"]["mixed"] is True
    assert {(p["id"], p["surface"]) for p in sidecar["regions"]["roads_2"]["pieces"]} == {("road", "asphalt"), ("lane", "gravel")}
    assert "roads_2: 1 piece(s) changed surface (asphalt -> gravel); now mixed" in report
    assert "for Blender to cut: roads_2" in report and "warning" not in report

    # Again with nothing changed: says so.
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app", paths_only=True)
    assert "no path changed surface since the last export" in capsys.readouterr().out

    # The lane redrawn wider: its outline is no longer the SVG's.
    geom = json.loads(conn.execute("SELECT geometry_json FROM course_features WHERE id = 'lane'").fetchone()[0])
    geom["rings"] = [_rect(0.2, -3, 30, 3)]
    conn.execute("UPDATE course_features SET geometry_json = ? WHERE id = 'lane'", (json.dumps(geom),))
    conn.commit()
    conn.close()
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app", paths_only=True)
    assert "warning: the outline of roads_2 moved since the last SVG export" in capsys.readouterr().out

    # A hard path made a grass track: OPCD builds that as rough, not a path mesh.
    conn = sqlite3.connect(db)
    conn.execute("UPDATE course_features SET attributes_json = ? WHERE id = 'lane'", (json.dumps({"surface": "grass"}),))
    conn.commit()
    conn.close()
    gspro.cmd_svg(BBOX, out, db, "Testbana", None, 3, {}, "app", paths_only=True)
    assert "warning: roads_2 changed between a grass track and a hard surface" in capsys.readouterr().out

    # No SVG to describe: refused.
    with pytest.raises(SystemExit, match="export the SVG once first"):
        gspro.cmd_svg(BBOX, tmp_path / "other.svg", db, "Testbana", None, 3, {}, "app", paths_only=True)


def test_grass_tracks_are_written_as_rough_under_the_other_roads(tmp_path):
    """A grass track is not hard ground: its own shape with the rough fill,
    painted before every hard road so a gravel path crossing it wins, and
    reaching only 5 cm under it (cut by a road running along its edge, a whole
    track left a sliver of rough beside the road)."""
    feats = [
        ("path", None, 0, [_rect(-3, -30, 3, 30)], "bezier", 1, "track"),
        ("path", None, 1, [_rect(-30, -2, 30, 2)], "bezier", 2, "path"),    # crosses the track
    ]
    out = _export_with_surfaces(tmp_path, feats, {"track": "grass", "path": "gravel"})
    # The crossing cuts the track in two: one shape each side (a track and a road are never one mesh).
    assert _road_attrs(out, "data-surface") == [("roads_1", "grass"), ("roads_1_2", "grass"), ("roads_2", None)]
    fills = dict(_road_attrs(out, "style"))
    assert gspro.OPCD_PALETTE["rough"] in fills["roads_1"] and gspro.OPCD_PALETTE["concrete"] in fills["roads_2"]
    halves = [_shape(out, "roads_1"), _shape(out, "roads_1_2")]
    assert sum(h.area for h in halves) == pytest.approx(6 * 60 - 6 * (4 - 2 * gspro.PATH_SURFACE_OVERLAP_M), rel=1e-2)
    for h in halves:
        assert h.intersection(_shape(out, "roads_2")).area == pytest.approx(6 * gspro.PATH_SURFACE_OVERLAP_M, abs=0.05)
