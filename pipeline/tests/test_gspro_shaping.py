"""gspro shaping-global — the generated Blender shaping layer out of the app DB.

Real SQLite databases built in tmp_path (no mocks), same shape as the app's:
courses (with site_id) / holes / course_features / terrain_edits.
"""

import json
import math
import sqlite3

import pytest
from shapely.geometry import LineString, Point, Polygon

import gspro


def test_path_transition_sidecar_and_shaping_are_meter_based_and_deterministic(tmp_path):
    transition = dict(id="fade", pattern="soft-fade", placement="end", startM=0, direction=1,
                      transitionLengthM=8, holdLengthM=0, fadeLengthM=4, ending="grass",
                      edgeIrregularity=.4, dirtAmount=.3, centerGrassReachM=1,
                      trackWidthM=.45, trackSpacingM=1.5, variation=.4, seed=1)
    centerline = {"points": [{"x": X0, "y": Y0}, {"x": X0 + 20, "y": Y0 + 8}, {"x": X0 + 50, "y": Y0}], "widthM": 4}
    feature = _feature("road-transition", "path", [_rect(0, -2, 50, 10)], 10,
                       attrs={"surface": "gravel", "pathTransitions": [transition]}, centerline=centerline)
    db = tmp_path / "transition.sqlite"
    _make_db(db, [feature], [])
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute("SELECT * FROM course_features"))
    first = gspro._path_transition_entries(rows, {"road-transition": ["roads_a"]})
    assert first == gspro._path_transition_entries(rows, {"road-transition": ["roads_a"]})
    entry = first[0]
    assert entry["centerline3006"][0] == [X0, Y0]
    assert len(entry["centerline3006"]) > 3
    assert entry["lengthM"] > math.hypot(20, 8) + math.hypot(30, 8)
    assert entry["transitions"][0]["startM"] == pytest.approx(entry["lengthM"] - 12)
    doc, _ = gspro.shaping_global(db, "Testbana")
    ops = [o["op"] for o in doc["ops"]]
    assert ops.index("golfmap.path_transition") > ops.index("golfmap.path_edge_fade")
    old = {"shapes": {}, "regions": {}}
    assert "transitions changed" in gspro._path_surface_changes(old, {**old, "transitions": first})[0][0]
    transition.update(placement="start")
    conn.execute("UPDATE course_features SET attributes_json=?", (json.dumps({"surface": "gravel", "pathTransitions": [transition]}),))
    rows = list(conn.execute("SELECT * FROM course_features"))
    anchored = gspro._path_transition_entries(rows, {"road-transition": ["roads_a"]})[0]["transitions"][0]
    assert anchored["startM"] == 12 and anchored["direction"] == -1
    first_section = {**transition, "placement": "section", "startM": 10, "direction": 1, "ending": "continue"}
    second_section = {**first_section, "id": "later", "startM": 30}
    conn.execute("UPDATE course_features SET attributes_json=?", (json.dumps({"surface": "gravel", "pathTransitions": [first_section, second_section]}),))
    rows = list(conn.execute("SELECT * FROM course_features"))
    exported = gspro._path_transition_entries(rows, {"road-transition": ["roads_a"]})[0]["transitions"]
    assert [t["id"] for t in exported] == ["fade"]  # nominal spans apart, but paint persists to endpoint
    # Gravel wears with or without transitions: two tracks on a road, one band on a footpath, none on dirt.
    def wear(surface, width):
        geometry = json.loads(rows[0]["geometry_json"])
        geometry["centerline"]["widthM"] = width
        conn.execute("UPDATE course_features SET attributes_json=?, geometry_json=?", (json.dumps({"surface": surface}), json.dumps(geometry)))
        entries = gspro._path_transition_entries(list(conn.execute("SELECT * FROM course_features")), {"road-transition": ["roads_a"]})
        return entries[0] if entries else None
    road = wear("gravel", 4)
    assert road["transitions"] == [] and road["wear"]["tracks"] == 2
    assert road["wear"]["trackSpacingM"] + road["wear"]["trackWidthM"] < 4 - .5
    assert wear("gravel", 2)["wear"]["tracks"] == 2 and wear("gravel", 1.6)["wear"]["tracks"] == 1
    assert wear("gravel", 1.2) is None and wear("dirt", 4) is None
    assert road == wear("gravel", 4)
    conn.close()

COURSE = "11111111-1111-1111-1111-111111111111"
SITE = "site-1"
X0, Y0 = 530000.0, 6487000.0  # EPSG:3006 metres


def _rect(x0, y0, x1, y1):
    return {"points": [{"x": X0 + x, "y": Y0 + y} for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]}


def _edit_ring(x0, y0, x1, y1):
    return [{"x": X0 + x, "y": Y0 + y} for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]


def _feature(fid, kind, rings, no, hole=None, generated=0, attrs=None, centerline=None):
    geom = {"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}
    if centerline:
        geom["centerline"] = centerline
    return dict(id=fid, type=kind, geom=geom, no=no, hole=hole, generated=generated, attrs=attrs)


def _edit(eid, rings, op="plane", params=None, origin="building-pads", ref=None, enabled=1, site=SITE, created="2000-01-01 00:00:00.000001"):
    return dict(id=eid, op=op, params=params or {"featherM": 4, "flat": True}, rings=rings, origin=origin,
                ref=ref, enabled=enabled, site=site, created=created)


def _make_db(path, features, edits=()):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT, site_id TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT, geometry_json TEXT,
               sort_order INTEGER, created_at TEXT, source TEXT, source_ref TEXT, attributes_json TEXT,
               generated INTEGER NOT NULL DEFAULT 0, feature_no INTEGER);
           CREATE TABLE terrain_edits (
               id TEXT PRIMARY KEY, site_id TEXT, op TEXT, params_json TEXT, rings_json TEXT,
               enabled INTEGER, version INTEGER, created_at TEXT, updated_at TEXT, origin TEXT, origin_ref TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES (?, ?, ?)", (COURSE, "Testbana Östra", SITE))
    conn.execute("INSERT INTO holes VALUES ('h1', ?, 1)", (COURSE,))
    for i, f in enumerate(features):
        conn.execute(
            "INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
            (f["id"], COURSE, "h1" if f["hole"] else None, f["type"], json.dumps(f["geom"]), i,
             f"2026-01-01T00:00:{i:02d}Z", json.dumps(f["attrs"]) if f["attrs"] else None, f["generated"], f["no"]),
        )
    for e in edits:
        conn.execute(
            "INSERT INTO terrain_edits VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
            (e["id"], e["site"], e["op"], json.dumps(e["params"]), json.dumps([e["rings"]]), e["enabled"],
             e["created"], e["created"], e["origin"], e["ref"]),
        )
    conn.commit()
    conn.close()


FEATURES = [
    _feature("tee-a", "tee", [_rect(0, 0, 10, 5)], 1, hole=1),
    _feature("tee-b", "tee", [_rect(0, 20, 10, 25)], 2, hole=1),
    _feature("green", "green", [_rect(100, 0, 130, 30)], 3, hole=1),
    _feature("lot", "path", [_rect(-60, 0, -20, 30)], 0x1a, attrs={"surface": "asphalt"}),
    _feature("road", "path", [_rect(-20, 10, 200, 15)], 5, attrs={"surface": "gravel"}),     # long and thin: a road outline
    _feature("lane", "path", [_rect(-60, -20, -30, -10)], 6,
             centerline={"points": [], "widthM": 3}),                                          # compact, but a centerline road
    _feature("fillet", "path", [_rect(-20, 0, -18, 2)], None, generated=1),                    # generated kerb fillet
    _feature("deck", "path", [_rect(140, 0, 150, 10)], 8, attrs={"surface": "bridge"}),       # a prop
]

EDITS = [
    _edit("e-near", _edit_ring(40, 0, 60, 20), ref="osm:way/7"),                    # 20 x 20 ring, 12 x 12 level core
    _edit("e-far", _edit_ring(900, 900, 920, 920), ref="osm:way/8"),                # nowhere near a course shape
    _edit("e-off", _edit_ring(40, 30, 60, 50), ref="osm:way/9", enabled=0),         # disabled
    _edit("e-lot", _edit_ring(-62, -2, -18, 32), params={"featherM": 2}, origin="road-grades", ref="feature:lot"),
    _edit("e-gone", _edit_ring(-62, 40, -40, 60), params={"featherM": 2}, origin="road-grades", ref="feature:deleted"),
    _edit("e-dig", _edit_ring(0, 0, 5, 5), op="dig", origin="bunker-digs", ref="feature:tee-a"),
    _edit("e-other", _edit_ring(40, 0, 60, 20), ref="osm:way/10", site="other-site"),
    _edit("e-hand", _edit_ring(0, -30, 20, -10), params={"featherM": 2}, origin=None, ref=None),  # hand-drawn tilted plane
]


def _layer(tmp_path, features=FEATURES, edits=EDITS, name="app.sqlite"):
    db = tmp_path / name
    _make_db(db, features, edits)
    doc, stats = gspro.shaping_global(db, "Testbana")
    return doc, stats


def _ops(doc):
    return {o["id"]: o for o in doc["ops"]}


def test_the_layer_is_the_shaping_format_generated_for_the_course(tmp_path):
    doc, _ = _layer(tmp_path)
    assert doc["format"] == "golfmap-shaping-layer-v1"
    assert doc["id"] == "global" and doc["generated"] is True
    assert doc["course"] == {"id": COURSE, "name": "Testbana Östra"}


def test_tees_are_flattened_and_paths_smoothed_by_type_before_the_footprints_with_no_cut_on_non_concrete(tmp_path):
    """Selected by type, so a tee or path drawn tomorrow is covered without a
    new op; then the lots, then the pads (the plan's area-edit order). The cart-path cut
    is the concrete-slab look: this course's paths are asphalt and gravel, so none."""
    doc, stats = _layer(tmp_path)
    ids = [o["id"] for o in doc["ops"]]
    assert ids[:2] == ["tees", "paths-smooth"]
    assert "paths-cut" not in ids
    ops = _ops(doc)
    assert ops["tees"]["op"] == "afrod.flattentees" and ops["tees"]["select"] == {"type": "tee"}
    assert ops["tees"]["params"] == gspro.SHAPING_TEE_PARAMS
    assert ops["paths-smooth"]["op"] == "afrod.smoothcartpaths" and ops["paths-smooth"]["select"] == {"type": "path"}
    assert ops["paths-smooth"]["params"] == gspro.SHAPING_PATH_SMOOTH_PARAMS
    assert stats["tees"] == 2 and stats["concrete_paths"] == 0 and stats["concrete_cut_skipped"] == 0
    assert ids.index("lot-1a") > ids.index("paths-smooth") and ids.index("pad-osm-way-7") > ids.index("lot-1a")


def test_only_concrete_paths_are_cut_selected_by_feature_id(tmp_path):
    """The cut simulates slabs: a concrete path (alone in its network) is cut, then everything smoothed."""
    features = [f for f in FEATURES if f["id"] in ("tee-a", "green", "road")] + [
        _feature("slabs", "path", [_rect(-300, 0, -100, 4)], 0x20, attrs={"surface": "concrete"})]
    doc, stats = _layer(tmp_path, features=features, edits=[])
    ids = [o["id"] for o in doc["ops"]]
    ops = _ops(doc)
    assert ids.index("paths-cut") < ids.index("paths-smooth")
    assert ops["paths-cut"] == {"id": "paths-cut", "op": "afrod.cutcartpaths", "select": {"feature": ["slabs"]}}
    assert stats["concrete_paths"] == 1 and stats["concrete_cut_skipped"] == 0


def test_a_concrete_path_in_a_mixed_road_shape_is_not_cut_and_is_counted(tmp_path):
    """The cut runs before split_surfaces, on the whole merged mesh: it would cut the asphalt and gravel too."""
    features = [dict(f, attrs={"surface": "concrete"}) if f["id"] == "lot" else f for f in FEATURES]
    doc, stats = _layer(tmp_path, features=features)
    assert "paths-cut" not in [o["id"] for o in doc["ops"]]
    assert stats["mixed_roads"] == 1 and stats["concrete_paths"] == 1 and stats["concrete_cut_skipped"] == 1


def test_gravel_and_dirt_paths_get_the_edge_fade_last_on_the_final_heights(tmp_path):
    """The fade needs each part's own surface (after the split) and the heights the lots and pads leave: it is the
    layer's last op. Asphalt and concrete keep a crisp edge: a course without gravel or dirt gets no op."""
    doc, stats = _layer(tmp_path)
    ids = [o["id"] for o in doc["ops"]]
    assert ids[-1] == "paths-edge-fade" and ids.index("paths-surfaces") < ids.index("paths-edge-fade")
    assert _ops(doc)["paths-edge-fade"] == {"id": "paths-edge-fade", "op": "golfmap.path_edge_fade", "select": {"type": "path"}}
    assert stats["edge_fade_paths"] == 1
    hard = [f for f in FEATURES if f["id"] in ("tee-a", "green", "lot")]
    doc, stats = _layer(tmp_path, features=hard, edits=[], name="hard.sqlite")
    assert "paths-edge-fade" not in [o["id"] for o in doc["ops"]] and stats["edge_fade_paths"] == 0


def test_a_road_network_of_two_surfaces_is_split_per_surface_after_the_cut_and_smooth(tmp_path):
    """The asphalt lot and the gravel road touch: one `roads_<n>` shape in the SVG, of two surfaces, so Blender
    cuts its mesh apart (golfmap.split_surfaces, selected by the shape's name) before any footprint levels it;
    the shape is exactly the one the SVG export's paths sidecar marks mixed."""
    doc, stats = _layer(tmp_path)
    ids = [o["id"] for o in doc["ops"]]
    split = _ops(doc)["paths-surfaces"]
    assert split == {"id": "paths-surfaces", "op": "golfmap.split_surfaces", "select": {"shape": ["roads_5"]}}
    assert ids.index("paths-smooth") < ids.index("paths-surfaces") < ids.index("lot-1a")
    assert stats["mixed_roads"] == 1
    import importlib.util
    spec = importlib.util.spec_from_file_location("shape_layers", gspro.SHAPING_ENGINE_LAYERS)
    sl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sl)
    assert sl.validate_layer(doc) == []
    out = tmp_path / "course.svg"
    gspro.cmd_svg((15.50, 58.52, 15.53, 58.54), out, tmp_path / "app.sqlite", "Testbana", None, 3, {}, stack="app")
    sidecar = json.loads(gspro.path_surfaces_file(out).read_text(encoding="utf-8"))
    assert sorted(n for n, r in sidecar["regions"].items() if r["mixed"]) == split["select"]["shape"]


def test_roads_of_one_surface_are_not_split(tmp_path):
    features = [f for f in FEATURES if f["id"] != "lot"] + [
        _feature("lot", "path", [_rect(-60, 0, -20, 30)], 0x1a, attrs={"surface": "gravel"})]
    doc, stats = _layer(tmp_path, features=features)
    assert "paths-surfaces" not in _ops(doc) and stats["mixed_roads"] == 0


def test_no_tee_or_path_ops_for_a_course_without_them(tmp_path):
    doc, _ = _layer(tmp_path, features=[_feature("green", "green", [_rect(100, 0, 130, 30)], 3, hole=1)], edits=[])
    assert doc["ops"] == []


def test_a_paved_lot_is_levelled_as_a_tilted_plane_named_after_its_shape(tmp_path):
    """Only a hand-made path polygon compact enough to be an area: not a road
    outline, a centerline road, a generated fillet or a bridge deck. Its own
    outline is the level footprint, with the DEM lot planes' 2 m falloff."""
    doc, stats = _layer(tmp_path)
    lots = [o for o in doc["ops"] if o["id"].startswith("lot-")]
    assert [o["id"] for o in lots] == ["lot-1a"]
    lot = lots[0]
    assert lot["op"] == "golfmap.flatten_footprint"
    assert lot["featureId"] == "lot" and lot["seed"] == 0x1a
    assert lot["level"] == "plane" and lot["falloffM"] == gspro.SHAPING_LOT_FALLOFF_M
    assert Polygon(lot["footprint3006"]).equals(Polygon([(X0 - 60, Y0), (X0 - 20, Y0), (X0 - 20, Y0 + 30), (X0 - 60, Y0 + 30)]))
    assert stats["lots"] == 1


def test_a_building_pad_near_the_course_is_its_flat_core_with_the_feather_as_falloff(tmp_path):
    """The DEM pad feathers INSIDE its ring; the footprint is the dead-flat core
    (ring shrunk by featherM) and falloffM the band out to the same outer edge.
    The id comes from origin_ref, which survives a re-import of the pads."""
    doc, _ = _layer(tmp_path)
    pad = _ops(doc)["pad-osm-way-7"]
    assert pad["op"] == "golfmap.flatten_footprint"
    assert pad["level"] == "median" and pad["falloffM"] == 4.0
    assert pad["origin"] == "building-pads" and pad["originRef"] == "osm:way/7"
    core = Polygon(pad["footprint3006"])
    assert core.bounds == pytest.approx((X0 + 44, Y0 + 4, X0 + 56, Y0 + 16), abs=0.01)
    assert "featureId" not in pad


def test_a_hand_drawn_plane_is_kept_tilted_and_named_after_its_edit_id(tmp_path):
    pad = _ops(_layer(tmp_path)[0])["pad-ehand"]
    assert pad["level"] == "plane" and pad["falloffM"] == 2.0
    assert "originRef" not in pad and "origin" not in pad


def test_edits_that_are_not_pads_of_this_course_near_its_meshes_are_left_out(tmp_path):
    """Far from every shape (moves no mesh), disabled, another site's, not a
    plane, or a lot graded from a feature (this course's is a lot op; a
    deleted feature's is stale)."""
    doc, stats = _layer(tmp_path)
    assert sorted(i for i in _ops(doc) if i.startswith("pad-")) == ["pad-ehand", "pad-osm-way-7"]
    assert stats["pads_far"] == 1 and stats["lot_edits"] == 1 and stats["stale_edits"] == 1


def test_regenerating_is_byte_identical_and_reimported_pads_keep_their_ids(tmp_path):
    """Pads get new row ids (and created_at slots) on every import; the layer
    must not change with them, nor with the database's row order."""
    out_a, out_b = tmp_path / "a.json", tmp_path / "b.json"
    _make_db(tmp_path / "a.sqlite", FEATURES, EDITS)
    reimported = [dict(e, id=f"new-{e['id']}", created=f"2000-01-01 00:00:00.00009{i}") if e["origin"] == "building-pads" else e
                  for i, e in enumerate(reversed(EDITS))]
    _make_db(tmp_path / "b.sqlite", list(reversed(FEATURES)), reimported)
    gspro.cmd_shaping_global(tmp_path / "a.sqlite", "Testbana", out_a)
    gspro.cmd_shaping_global(tmp_path / "b.sqlite", "Testbana", out_b)
    assert out_a.read_bytes() == out_b.read_bytes()
    gspro.cmd_shaping_global(tmp_path / "a.sqlite", "Testbana", out_b)
    assert out_a.read_bytes() == out_b.read_bytes()


def test_a_new_lot_or_pad_adds_an_op_and_changes_no_other(tmp_path):
    before = _ops(_layer(tmp_path, name="a.sqlite")[0])
    more_features = FEATURES + [_feature("lot2", "path", [_rect(-120, 0, -90, 30)], 0x2f)]
    more_edits = EDITS + [_edit("e-new", _edit_ring(100, 40, 120, 60), ref="osm:way/11")]
    after = _ops(_layer(tmp_path, more_features, more_edits, name="b.sqlite")[0])
    assert set(after) - set(before) == {"lot-2f", "pad-osm-way-11"}
    assert all(after[k] == v for k, v in before.items())


def test_the_database_is_only_read(tmp_path):
    db = tmp_path / "app.sqlite"
    _make_db(db, FEATURES, EDITS)
    before = db.read_bytes()
    gspro.cmd_shaping_global(db, "Testbana", tmp_path / "out.json")
    assert db.read_bytes() == before


def test_the_cli_writes_one_coordinate_pair_per_line(tmp_path, capsys):
    db = tmp_path / "app.sqlite"
    _make_db(db, FEATURES, EDITS)
    out = tmp_path / "shaping" / "00-global.gen.json"
    assert gspro.main(["shaping-global", "--course", "testbana", "--db", str(db), "--out", str(out)]) == 0
    text = out.read_text(encoding="utf-8")
    assert json.loads(text)["format"] == "golfmap-shaping-layer-v1"
    assert f"[{X0 - 60:.1f}, {Y0:.1f}]" in text
    report = capsys.readouterr().out
    assert "2 tee(s)" in report and "1 lot(s)" in report and "2 pad(s)" in report


def test_the_default_file_goes_under_the_courses_docs_folder():
    assert gspro._course_slug("Testbana Östra") == "testbana-ostra"
    assert gspro._course_slug("Vreta") == "vreta"


# --- 10-features.gen.json: per-feature recipes (recipe edits + course defaults) ---

LIBRARY = [
    {"id": "conway", "name": "Conway bunker", "file": "cesimgolf-Conway_Bunker_Standard.json", "author": "cesimgolf",
     "surfaces": ["bunker"], "default": True},
    {"id": "pot", "name": "Pot bunker", "file": "golfmap-pot.json", "author": "golfmap", "surfaces": ["bunker"]},
    {"id": "pond", "name": "Natural pond", "file": "golfmap-pond.json", "author": "golfmap", "surfaces": ["lake", "creek"],
     "default": "lake"},
    {"id": "edge", "name": "Path edge", "file": "golfmap-path-edge.json", "author": "golfmap", "surfaces": ["path"]},
    {"name": "no id", "file": "x.json"},
]

RECIPE_FEATURES = [
    _feature("b1", "bunker", [_rect(0, 40, 5, 45)], 0x10, hole=1),
    _feature("b2", "bunker", [_rect(10, 40, 15, 45)], 0x11, hole=1),
    _feature("b3", "bunker", [_rect(20, 40, 25, 45)], 0x12, hole=1),
    _feature("pond", "water", [_rect(0, 60, 30, 80)], 0x20),
    _feature("creek", "water_creek", [_rect(0, 90, 100, 93)], 0x21),
    _feature("road", "path", [_rect(-20, 10, 200, 15)], 5, attrs={"surface": "gravel"}),
    _feature("lane", "path", [_rect(-20, 20, 200, 25)], 6, attrs={"surface": "gravel"}),
    _feature("deck", "path", [_rect(140, 0, 150, 10)], 8, attrs={"surface": "bridge"}),
    _feature("green", "green", [_rect(100, 0, 130, 30)], 3, hole=1),
]


def _recipe_edit(eid, fid, recipe, overrides=None, enabled=1, site=SITE, created="2026-09-28 10:00:00"):
    params = {"featherM": 0, "recipe": recipe}
    if overrides:
        params["overrides"] = overrides
    return dict(id=eid, params=params, ref=f"feature:{fid}", enabled=enabled, site=site, created=created)


RECIPE_EDITS = [
    _recipe_edit("r-b2", "b2", "pot", overrides={"rings": 3, "lip": "soft"}),
    _recipe_edit("r-b3", "b3", "none"),
    _recipe_edit("r-road", "road", "edge"),
    _recipe_edit("r-off", "b1", "pot", enabled=0),                    # disabled: b1 keeps the default
    _recipe_edit("r-other", "someone-elses-bunker", "pot"),          # another course's feature on the site
    _recipe_edit("r-site", "pond", "pot", site="other-site"),        # another site's
]


def _make_recipe_db(path, features=RECIPE_FEATURES, edits=RECIPE_EDITS):
    _make_db(path, features, [])
    conn = sqlite3.connect(path)
    for e in edits:
        conn.execute("INSERT INTO terrain_edits VALUES (?, ?, 'recipe', ?, '[]', ?, 1, ?, ?, 'feature', ?)",
                     (e["id"], e["site"], json.dumps(e["params"]), e["enabled"], e["created"], e["created"], e["ref"]))
    conn.commit()
    conn.close()


def _features_layer(tmp_path, library=LIBRARY, features=RECIPE_FEATURES, edits=RECIPE_EDITS, name="app.sqlite", engine=None):
    db = tmp_path / name
    _make_recipe_db(db, features, edits)
    lib = tmp_path / "library.json"
    if library is not None:
        lib.write_text(json.dumps(library), encoding="utf-8")
    kwargs = {"engine": engine} if engine else {}
    return gspro.shaping_features(db, "Testbana", lib, **kwargs)


def test_every_bunker_lake_and_creek_gets_its_recipe_edit_or_its_surface_default(tmp_path):
    doc, stats, warnings = _features_layer(tmp_path)
    assert doc["format"] == "golfmap-shaping-layer-v1" and doc["id"] == "features" and doc["generated"] is True
    ops = _ops(doc)
    # by feature number; b3 opted out (recipe none); this library has no creek default
    assert list(ops) == ["recipe-5", "recipe-10", "recipe-11", "recipe-20"]
    assert ops["recipe-10"] == {"id": "recipe-10", "op": "afrod.recipe", "select": {"feature": "b1"},
                                "recipe": "cesimgolf-Conway_Bunker_Standard.json", "seed": 0x10,
                                "note": "conway (default for bunker)"}
    assert ops["recipe-11"]["recipe"] == "golfmap-pot.json" and ops["recipe-11"]["note"] == "pot (recipe edit)"
    assert ops["recipe-20"]["recipe"] == "golfmap-pond.json" and ops["recipe-20"]["seed"] == 0x20
    assert ops["recipe-5"]["select"] == {"feature": "road"} and ops["recipe-5"]["recipe"] == "golfmap-path-edge.json"
    assert stats["edits"] == 2 and stats["defaults"] == {"bunker": 1, "lake": 1} and stats["opted_out"] == 1
    assert stats["other_edits"] == 1 and stats["no_default"] == {"creek": 1}
    assert any("no creek default" in w for w in warnings)


def test_paths_and_bridge_decks_get_no_default(tmp_path):
    doc, _, _ = _features_layer(tmp_path, edits=[])
    assert [o["select"]["feature"] for o in doc["ops"]] == ["b1", "b2", "b3", "pond"]


def test_the_layer_is_one_the_shaping_engine_accepts(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("shape_layers", gspro.SHAPING_ENGINE_LAYERS)
    sl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sl)
    doc, _, _ = _features_layer(tmp_path)
    assert sl.validate_layer(doc) == []


def test_overrides_the_engine_does_not_take_are_reported_not_written(tmp_path):
    """afrod.recipe without params: writing them would make the engine reject the whole layer."""
    engine = tmp_path / "engine_none.py"
    engine.write_text('OPS = {"afrod.recipe": {"params": {}, "keys": {"recipe"}}}\n', encoding="utf-8")
    doc, stats, warnings = _features_layer(tmp_path, engine=engine)
    op = _ops(doc)["recipe-11"]
    assert "params" not in op and "overrides" not in op
    assert stats["overrides_dropped"] == 2
    assert any("lip, rings not written" in w for w in warnings)


def test_overrides_go_into_params_the_engine_knows_or_whole_into_an_overrides_key(tmp_path):
    engine = tmp_path / "engine_params.py"
    engine.write_text('OPS = {"afrod.recipe": {"params": {"rings": int}, "keys": {"recipe"}}}\n', encoding="utf-8")
    doc, stats, _ = _features_layer(tmp_path, engine=engine)
    assert _ops(doc)["recipe-11"]["params"] == {"rings": 3} and stats["overrides_dropped"] == 1
    engine = tmp_path / "engine_key.py"
    engine.write_text('OPS = {"afrod.recipe": {"params": {}, "keys": {"recipe", "overrides"}}}\n', encoding="utf-8")
    doc, _, _ = _features_layer(tmp_path, engine=engine, name="b.sqlite")
    assert _ops(doc)["recipe-11"]["overrides"] == {"lip": "soft", "rings": 3}


def test_an_unknown_recipe_is_left_out_with_a_warning(tmp_path):
    doc, stats, warnings = _features_layer(tmp_path, edits=[_recipe_edit("r", "b2", "gone")])
    assert "recipe-11" not in _ops(doc) and stats["unknown"] == 1
    assert any("'gone' is not in the library" in w for w in warnings)


def test_without_a_library_the_layer_is_written_empty_with_a_warning(tmp_path):
    """So a sync drops recipe ops applied before instead of keeping stale ones."""
    doc, stats, warnings = _features_layer(tmp_path, library=None)
    assert doc["ops"] == [] and stats["unresolved"] == 2
    assert any("no recipe library" in w for w in warnings)


def test_the_cli_writes_both_layers_into_out_dir_byte_identically(tmp_path, capsys):
    db = tmp_path / "app.sqlite"
    _make_recipe_db(db)
    lib = tmp_path / "library.json"
    lib.write_text(json.dumps(LIBRARY), encoding="utf-8")
    out = tmp_path / "shaping"
    args = ["shaping-global", "--course", COURSE, "--db", str(db), "--out-dir", str(out), "--library", str(lib)]
    assert gspro.main(args) == 0
    first = (out / "10-features.gen.json").read_bytes()
    assert (out / "00-global.gen.json").is_file()
    report = capsys.readouterr().out
    assert "4 recipe op(s): 2 from recipe edits, 2 course default(s) (bunker 1, lake 1)" in report
    assert gspro.main(args) == 0
    assert (out / "10-features.gen.json").read_bytes() == first


# --- rock slabs: one golfmap.cut_out per `rock_slab` feature, last in 00-global.gen.json ---

def _shape_layers():
    import importlib.util
    spec = importlib.util.spec_from_file_location("shape_layers", gspro.SHAPING_ENGINE_LAYERS)
    sl = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sl)
    return sl


def _slab(fid, x0, y0, x1, y1, no, attrs=None):
    return _feature(fid, "rock_slab", [_rect(x0, y0, x1, y1)], no, attrs=attrs)


def _slab_ops(doc):
    return [o for o in doc["ops"] if o["op"] == "golfmap.cut_out"]


def _outline(op):
    return Polygon(op["outline3006"])


def _only_slab(tmp_path, feature, name="alone.sqlite"):
    """The cut-out op a slab gets with nothing else on the course."""
    doc, _ = _layer(tmp_path, features=[feature], edits=[], name=name)
    return _slab_ops(doc)[0]


# Two slabs far from everything else on the test course.
SLABS = [_slab("rock-b", 300, 0, 310, 6, 0x2b), _slab("rock-a", 200, 0, 208, 6, 0x2a)]


def test_each_rock_slab_is_one_cut_out_op_after_every_other_op_in_feature_number_order(tmp_path):
    """The cut comes after everything that moves or cuts meshes (paths-edge-fade is the last of those); the ops
    carry the feature they came from, and the layer is one the shaping engine accepts."""
    doc, stats = _layer(tmp_path, features=FEATURES + SLABS)
    ids = [o["id"] for o in doc["ops"]]
    assert ids[-3:] == ["paths-edge-fade", "hall-2a", "hall-2b"]
    a = _ops(doc)["hall-2a"]
    assert a["op"] == "golfmap.cut_out" and a["name"] == "hall_2a"
    assert a["featureId"] == "rock-a" and a["origin"] == "rock_slab"
    assert set(a) == {"id", "op", "name", "outline3006", "featureId", "origin", "note"}
    assert stats["rock_slabs"] == 2 and stats["rock_slabs_skipped"] == 0 and stats["rock_slab_warnings"] == []
    sl = _shape_layers()
    assert sl.validate_layer(doc) == []
    assert all(sl.validate_op(op) == [] for op in _slab_ops(doc))
    # The order is the feature numbers', not the database's.
    again, _ = _layer(tmp_path, features=list(reversed(FEATURES + SLABS)), name="reversed.sqlite")
    assert again["ops"] == doc["ops"]


def test_a_course_with_only_slabs_gets_only_their_ops(tmp_path):
    doc, _ = _layer(tmp_path, features=SLABS, edits=[])
    assert [o["id"] for o in doc["ops"]] == ["hall-2a", "hall-2b"]


def test_a_slab_with_rise_attributes_gets_a_rise_the_engine_accepts(tmp_path, capsys):
    """riseTopM turns the klippa on; the other rise* attributes come along under the cut-out's own key names, and
    rise* without riseTopM leaves the slab flat with a warning (shared/features/rock-slab.ts)."""
    attrs = {"riseWaterM": 9.43, "riseTopM": 0.9, "riseFootM": 0.35, "riseApronM": 3, "riseSeed": 247, "other": "x"}
    op = _only_slab(tmp_path, _slab("rock-r", 200, 0, 208, 6, 0x2c, attrs=attrs))
    assert op["rise"] == {"waterM": 9.43, "topM": 0.9, "footM": 0.35, "apronM": 3.0, "seed": 247.0}
    assert _shape_layers().validate_op(op) == []
    doc, stats = _layer(tmp_path, features=[_slab("rock-f", 200, 0, 208, 6, 0x2d, attrs={"riseWaterM": 9.4})], edits=[],
                        name="flat.sqlite")
    assert "rise" not in _slab_ops(doc)[0]
    assert any("riseTopM" in w for w in stats["rock_slab_warnings"])


def test_the_slab_names_pass_the_engines_validation_whatever_the_feature_id(tmp_path):
    """Named from the feature number in hex, never from its id (an id may spell a golf surface word); an
    unnumbered slab takes a hash of its id."""
    sl = _shape_layers()
    features = [_slab("tee-rough-slab", 200, 0, 208, 6, None), _slab("deep-water", 300, 0, 310, 6, 0xbeef),
                _slab("green-lake", 400, 0, 410, 6, 0xdad)]
    doc, _ = _layer(tmp_path, features=features, edits=[])
    names = [o["name"] for o in _slab_ops(doc)]
    assert "hall_beef" in names and "hall_dad" in names
    assert len(set(names)) == 3 and all(n.startswith("hall_") for n in names)
    assert sl.validate_layer(doc) == []
    for n in names:
        assert not any(w in n for w in sl.SURFACE_WORDS)


def test_the_outline_is_the_drawn_polygon_grown_1_5_m_with_rounded_corners(tmp_path):
    op = _only_slab(tmp_path, _slab("rock", 0, 0, 8, 6, 0x2a))
    outline = _outline(op)
    assert outline.bounds == pytest.approx((X0 - 1.5, Y0 - 1.5, X0 + 9.5, Y0 + 7.5), abs=0.02)
    # a rounded join: 1.0 m diagonally off the corner is inside, 1.2 m (1.7 m from the corner) is not
    assert outline.contains(Point(X0 + 8 + 1.0, Y0 + 6 + 1.0)) and not outline.contains(Point(X0 + 8 + 1.2, Y0 + 6 + 1.2))
    assert outline.area == pytest.approx(8 * 6 + 2 * (8 + 6) * 1.5 + math.pi * 1.5 ** 2, rel=0.01)
    assert "uvM" not in op and "grown 1.5 m" in op["note"]


def test_marginM_sets_how_far_the_outline_grows_and_zero_keeps_the_drawn_polygon(tmp_path):
    wide = _outline(_only_slab(tmp_path, _slab("rock", 0, 0, 8, 6, 5, {"marginM": 3}), "wide.sqlite"))
    assert wide.bounds == pytest.approx((X0 - 3, Y0 - 3, X0 + 11, Y0 + 9), abs=0.02)
    exact = _outline(_only_slab(tmp_path, _slab("rock", 0, 0, 8, 6, 5, {"marginM": 0}), "exact.sqlite"))
    drawn = Polygon([(X0, Y0), (X0 + 8, Y0), (X0 + 8, Y0 + 6), (X0, Y0 + 6)])
    assert exact.symmetric_difference(drawn).area < 0.01


def test_the_outline_is_lightly_simplified_within_0_15_m(tmp_path):
    """A drawn circle of 200 points: the grown outline keeps its shape (within 0.15 m of the exact buffer)
    with far fewer vertices."""
    circle = {"points": [{"x": X0 + 5 * math.cos(2 * math.pi * i / 200), "y": Y0 + 5 * math.sin(2 * math.pi * i / 200)}
                         for i in range(200)]}
    op = _only_slab(tmp_path, _feature("round", "rock_slab", [circle], 7))
    exact = Polygon([(p["x"], p["y"]) for p in circle["points"]]).buffer(1.5, quad_segs=32)
    assert len(op["outline3006"]) < 60
    assert _outline(op).hausdorff_distance(exact) <= gspro.SHAPING_SLAB_SIMPLIFY_M + 0.02


def test_uvM_is_written_only_when_it_differs_from_the_default(tmp_path):
    assert "uvM" not in _only_slab(tmp_path, _slab("rock", 0, 0, 8, 6, 5, {"uvM": 4}), "a.sqlite")
    assert _only_slab(tmp_path, _slab("rock", 0, 0, 8, 6, 5, {"uvM": 6}), "b.sqlite")["uvM"] == 6
    assert _only_slab(tmp_path, _slab("rock", 0, 0, 8, 6, 5, {"uvM": 2.5}), "c.sqlite")["uvM"] == 2.5


def test_a_margin_or_tile_size_the_server_would_refuse_falls_back_with_a_warning(tmp_path):
    for i, attrs in enumerate(({"marginM": 9}, {"marginM": -1}, {"marginM": "wide"}, {"uvM": 0}, {"uvM": True})):
        doc, stats = _layer(tmp_path, features=[_slab("rock", 0, 0, 8, 6, 0x2a, attrs)], edits=[], name=f"bad{i}.sqlite")
        op = _slab_ops(doc)[0]
        assert "uvM" not in op and "grown 1.5 m" in op["note"]
        assert stats["rock_slabs"] == 1 and len(stats["rock_slab_warnings"]) == 1
        assert "hall_2a" in stats["rock_slab_warnings"][0] and "default" in stats["rock_slab_warnings"][0]


def test_slabs_whose_outlines_would_touch_or_overlap_are_kept_0_8_m_apart_the_later_one_shrinks(tmp_path):
    """A is drawn 0..8 m; B 3 m beyond it, so their 1.5 m margins meet (touch); C is 4 m beyond B, its outline 1.0 m
    clear of B's: the later slab gives way, with 0.8 m left between the written outlines; the earlier one and
    the slabs already clear of it are as they would be alone."""
    a = _slab("rock-a", 0, 0, 8, 6, 1)
    b = _slab("rock-b", 11, 0, 19, 6, 2)
    c = _slab("rock-c", 23, 0, 31, 6, 3)
    far = _slab("rock-far", 100, 0, 108, 6, 4)
    doc, stats = _layer(tmp_path, features=[far, c, b, a], edits=[])
    ops = _ops(doc)
    alone = {k: _only_slab(tmp_path, f, f"{k}.sqlite")["outline3006"] for k, f in (("a", a), ("c", c), ("far", far))}
    assert ops["hall-1"]["outline3006"] == alone["a"]
    assert ops["hall-3"]["outline3006"] == alone["c"] and ops["hall-4"]["outline3006"] == alone["far"]
    assert stats["rock_slabs"] == 4 and stats["rock_slabs_trimmed"] == 1
    first, second = _outline(ops["hall-1"]), _outline(ops["hall-2"])
    assert 0.8 <= first.distance(second) <= 0.83
    across = second.intersection(LineString([(X0 + 9, Y0 + 3), (X0 + 20, Y0 + 3)]))     # mid-height, off the rounded corners
    assert across.bounds[0] == pytest.approx(first.bounds[2] + 0.8, abs=0.03)
    assert second.bounds[2] == pytest.approx(X0 + 19 + 1.5, abs=0.02)      # the far side is untouched
    assert "trimmed to keep 0.8 m" in ops["hall-2"]["note"] and "trimmed" not in ops["hall-3"]["note"]
    assert second.is_valid and _shape_layers().validate_layer(doc) == []


def test_a_later_slab_that_is_split_swallowed_or_would_enclose_an_earlier_one_is_skipped_with_a_warning(tmp_path, capsys):
    """Shrinking must leave one polygon without a hole: a long slab across an earlier one would be cut in two,
    one inside an earlier slab's margin has nothing left, one around an earlier slab would leave a hole."""
    a = _slab("rock-a", 0, 0, 8, 6, 1)
    split = _slab("across", -10, 2.5, 18, 3.5, 2)
    inside = _slab("inside", 3, 2, 5, 4, 3)
    ring = _slab("ring", -40, -40, 50, 50, 4)
    ok = _slab("ok", 200, 0, 208, 6, 5)
    db = tmp_path / "app.sqlite"
    _make_db(db, [ring, inside, split, a, ok], [])
    doc, stats = gspro.shaping_global(db, "Testbana")
    assert [o["name"] for o in _slab_ops(doc)] == ["hall_1", "hall_5"]
    assert stats["rock_slabs"] == 2 and stats["rock_slabs_skipped"] == 3
    warnings = stats["rock_slab_warnings"]
    assert len(warnings) == 3
    assert any("hall_2" in w and "split in 2" in w for w in warnings)
    assert any("hall_3" in w and "nothing is left" in w for w in warnings)
    assert any("hall_4" in w and "leave a hole" in w for w in warnings)
    gspro.cmd_shaping_global(db, "Testbana", tmp_path / "out.json")
    report = capsys.readouterr().out
    assert "2 rock slab(s) cut out of the meshes in Blender" in report and "3 skipped" in report
    assert "warning: rock slab hall_2" in report


def test_a_slab_drawn_by_mistake_is_skipped_with_a_warning(tmp_path):
    doc, stats = _layer(tmp_path, features=[_slab("speck", 0, 0, 0.5, 0.5, 9), _slab("ok", 50, 0, 58, 6, 10)], edits=[])
    assert [o["name"] for o in _slab_ops(doc)] == ["hall_a"]
    assert stats["rock_slabs_skipped"] == 1 and "under 1 m2" in stats["rock_slab_warnings"][0]


def test_the_report_counts_the_slabs_and_a_course_without_any_changes_in_nothing(tmp_path, capsys):
    db = tmp_path / "app.sqlite"
    _make_db(db, FEATURES + SLABS, EDITS)
    gspro.cmd_shaping_global(db, "Testbana", tmp_path / "a.json")
    report = capsys.readouterr().out
    assert "golfmap.cut_out 2" in report
    assert "2 rock slab(s) cut out of the meshes in Blender (outline grown by its margin, 0.8 m kept between slabs; 0 trimmed to that)" in report

    plain = tmp_path / "plain.sqlite"
    _make_db(plain, FEATURES, EDITS)
    gspro.cmd_shaping_global(plain, "Testbana", tmp_path / "b.json")
    assert "rock slab" not in capsys.readouterr().out
    assert "cut_out" not in (tmp_path / "b.json").read_text(encoding="utf-8")
    # The slabs only add their ops at the end: every other op is as it was.
    with_slabs = json.loads((tmp_path / "a.json").read_text(encoding="utf-8"))
    without = json.loads((tmp_path / "b.json").read_text(encoding="utf-8"))
    assert with_slabs["ops"][:len(without["ops"])] == without["ops"]
    assert {k: v for k, v in with_slabs.items() if k != "ops"} == {k: v for k, v in without.items() if k != "ops"}


def test_regenerating_with_slabs_is_byte_identical_whatever_the_row_order(tmp_path):
    features = FEATURES + SLABS + [_slab("rock-c", 211, 0, 219, 6, 0x2c)]
    _make_db(tmp_path / "a.sqlite", features, EDITS)
    _make_db(tmp_path / "b.sqlite", list(reversed(features)), EDITS)
    gspro.cmd_shaping_global(tmp_path / "a.sqlite", "Testbana", tmp_path / "a.json")
    gspro.cmd_shaping_global(tmp_path / "b.sqlite", "Testbana", tmp_path / "b.json")
    assert (tmp_path / "a.json").read_bytes() == (tmp_path / "b.json").read_bytes()
