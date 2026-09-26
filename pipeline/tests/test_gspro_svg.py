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


def _make_db(path, features, holes=(1, 2)):
    """features: (type, hole_number|None, sort_order, rings, curve_type)."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT,
               geometry_json TEXT, sort_order INTEGER);"""
    )
    conn.execute("INSERT INTO courses VALUES (?, ?)", (COURSE, "Testbana"))
    for number in holes:
        conn.execute("INSERT INTO holes VALUES (?, ?, ?)", (f"h{number}", COURSE, number))
    for i, (kind, hole, order, rings, curve) in enumerate(features):
        geom = {"crs": "EPSG:3006", "curveType": curve, "rings": rings}
        conn.execute(
            "INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?)",
            (f"feat-{i}", COURSE, f"h{hole}" if hole else None, kind, json.dumps(geom), order),
        )
    conn.commit()
    conn.close()


def _export(tmp_path, features, holes=(1, 2), **kwargs):
    tmp_path.mkdir(parents=True, exist_ok=True)  # callers pass subdirs for a 2nd export
    db = tmp_path / "app.sqlite"
    _make_db(db, features, holes)
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
    assert dict(layers)["Others"] == ["others_1"]


def test_shape_ids_are_hole_number_plus_index_on_that_hole(tmp_path):
    """Ids are hole_<hole>_<index on hole>: unique across the document, and
    the mesh they become traces back to a hole. The material is already in the
    mesh name via the fill, so the type is only kept as a data-type attribute."""
    layers = dict(_layers(_export(tmp_path, BASIC)))
    assert layers["Hole1"] == ["hole_1_1", "hole_1_2", "hole_1_3"]
    assert layers["Hole2"] == ["hole_2_1", "hole_2_2"]
    assert layers["Others"] == ["others_1"]

    root = ET.parse(_export(tmp_path / "t", BASIC)).getroot()
    types = {p.get("id"): p.get("data-type") for p in root.iter(f"{SVG_NS}path")}
    assert types["hole_1_1"] == "semi_rough"
    assert types["hole_1_3"] == "bunker"
    assert len(set(types)) == len(types)  # ids unique


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
        assert dict(layers)["Roads"] == ["roads_1", "roads_2"]
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
    assert [p.get("id") for p in root.iter(f"{SVG_NS}path")] == ["hole_1_1", "hole_1_2"]
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

    nw, se = first_point("hole_1_1"), first_point("hole_2_1")
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
    assert dict(_layers(out))["Roads"] == ["roads_1", "roads_2"]
    root = ET.parse(out).getroot()
    ids = {p.get("id"): p.get("data-feature-id") for p in root.iter(f"{SVG_NS}path")}
    assert ids == {"roads_1": "feat-0 feat-1", "roads_2": "feat-2"}
    road = _shape(out, "roads_1")
    assert road.geom_type == "Polygon" and not road.interiors
    assert road.area == pytest.approx(60 * 6, rel=1e-3)  # the slit filled


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
    ring = _shape(out, "roads_2")
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
    rough = _shape(out, "hole_1_1")
    assert rough.area == pytest.approx(100 * (30 - 3) + 100 * 0.02, rel=2e-3)  # down to the kerb, a hair under it
    green = _shape(out, "hole_1_2")
    assert green.area == pytest.approx(40 * 16.6, rel=1e-6)


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
