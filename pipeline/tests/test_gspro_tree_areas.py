"""Tree species areas in the trees export (gspro.py trees --course): a drawn
`tree_area` feature's species mix goes into the unity-trees-v1 file with its
outline, and every stem inside names the area (shared/features/tree-areas.ts;
the Unity planter applies it)."""
import json
import sqlite3

import pytest

import gspro

COURSE = "course-trees"
E0, N0 = 500000.0, 6400000.0
EXTENT = (E0, N0, E0 + 200.0, N0 + 200.0)


def _rect(x0, y0, x1, y1):
    return {"points": [{"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0},
                       {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]}


def _make_db(path, areas, other=()):
    """areas: (id, rings, attrs, hole number | None, sort_order), bottom to top as inserted."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT,
               geometry_json TEXT, sort_order INTEGER, attributes_json TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES (?, ?)", (COURSE, "Trädbana"))
    for number in (1, 2):
        conn.execute("INSERT INTO holes VALUES (?, ?, ?)", (f"h{number}", COURSE, number))
    for fid, rings, attrs, hole, order in areas:
        conn.execute("INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (fid, COURSE, f"h{hole}" if hole else None, "tree_area",
                      json.dumps({"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}), order, json.dumps(attrs)))
    for fid, kind, rings, *attrs in other:   # (id, type, rings[, attributes])
        conn.execute("INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (fid, COURSE, None, kind, json.dumps({"crs": "EPSG:3006", "rings": rings}), 0,
                      json.dumps(attrs[0] if attrs else {"zoneType": "shrub"})))
    conn.commit()
    conn.close()


def _stems(path, points):
    """points: (x, y) metres from the square's corner; 10 m broadleaves."""
    rows = [[E0 + x, N0 + y, 10.0, 3.0, 50.0, 0] for x, y in points]
    path.write_text(json.dumps({"version": 2, "crs": "EPSG:3006", "fields": ["x", "y", "heightM", "crownRadiusM", "groundM", "kind"], "trees": rows}))
    return path


def _sidecar(path, extent=EXTENT, terrain="inner"):
    path.write_text(json.dumps({"terrain": terrain, "square3006": list(extent), "minM": 40.0, "maxM": 60.0}))
    return path


def _export(tmp_path, areas, points, course=COURSE, other=(), exclude=None, extent=EXTENT):
    db = tmp_path / "app.sqlite"
    db.unlink(missing_ok=True)
    _make_db(db, areas, other)
    out = tmp_path / "x-inner-trees.json"
    gspro.cmd_trees(None, _stems(tmp_path / "stems.json", points), _sidecar(tmp_path / "x.tif.json", extent), out,
                    exclude=exclude, extent=extent, db_path=db, course=course)
    return json.loads(out.read_text())


def test_stems_inside_an_area_name_it_and_the_file_carries_the_areas_mix_and_outline(tmp_path):
    doc = _export(tmp_path, [
        ("grove", [_rect(10, 10, 60, 60)], {"species": "oak=9, birch", "name": " Oak grove "}, None, 0),
    ], [(20, 20), (50, 55), (100, 100)])

    assert [t.get("area") for t in doc["trees"]] == ["grove", "grove", None]
    [area] = doc["areas"]
    assert {k: v for k, v in area.items() if k != "rings"} == {
        "id": "grove", "name": "Oak grove", "ignoreKind": False,
        "species": [{"species": "oak", "weight": 9.0}, {"species": "birch", "weight": 1.0}],
        "stems": 2,
    }
    assert len(area["rings"]) == 1
    ring = area["rings"][0]["nodes"]
    assert sorted((n["x"], n["z"]) for n in ring) == [(10.0, 10.0), (10.0, 60.0), (60.0, 10.0), (60.0, 60.0)]


def test_where_areas_overlap_the_one_higher_in_the_stack_wins(tmp_path):
    doc = _export(tmp_path, [
        ("course-level", [_rect(0, 0, 100, 100)], {"species": "pine"}, None, 0),   # course level: above every hole
        ("hole-2-top", [_rect(0, 0, 50, 50)], {"species": "birch"}, 2, 1),
        ("hole-2-low", [_rect(0, 0, 50, 50)], {"species": "elm"}, 2, 0),
        ("hole-1", [_rect(40, 40, 90, 90)], {"species": "oak", "ignoreKind": True}, 1, 5),
    ], [(10, 10), (45, 45), (80, 80), (150, 150)])

    # Course-level features sit above the holes (server D28), so it takes everything it covers.
    assert [t.get("area") for t in doc["trees"]] == ["course-level", "course-level", "course-level", None]
    assert [a["id"] for a in doc["areas"]] == ["hole-1", "hole-2-low", "hole-2-top", "course-level"]
    assert {a["id"]: a["stems"] for a in doc["areas"]} == {"hole-1": 0, "hole-2-low": 0, "hole-2-top": 0, "course-level": 3}
    assert doc["areas"][0]["ignoreKind"] is True

    doc = _export(tmp_path, [
        ("hole-2-low", [_rect(0, 0, 50, 50)], {"species": "elm"}, 2, 0),
        ("hole-2-top", [_rect(0, 0, 50, 50)], {"species": "birch"}, 2, 1),
        ("hole-1", [_rect(40, 40, 90, 90)], {"species": "oak"}, 1, 5),
    ], [(10, 10), (45, 45), (80, 80)])
    # Hole 2 above hole 1; within hole 2 the higher sort order.
    assert [t.get("area") for t in doc["trees"]] == ["hole-2-top", "hole-2-top", "hole-1"]


def test_areas_are_clipped_to_the_square_and_the_outer_leaves_out_the_inner_square(tmp_path):
    areas = [
        ("straddles", [_rect(150, 150, 260, 260)], {"species": "oak"}, None, 0),
        ("beyond", [_rect(300, 300, 400, 400)], {"species": "oak"}, None, 1),
    ]
    doc = _export(tmp_path, areas, [(160, 160)])
    assert [a["id"] for a in doc["areas"]] == ["straddles"]
    assert max(n["x"] for n in doc["areas"][0]["rings"][0]["nodes"]) == 200.0

    # As the outer terrain: an area wholly on the (excluded) inner square is left out.
    doc = _export(tmp_path, [("inner-only", [_rect(10, 10, 60, 60)], {"species": "oak"}, None, 0)],
                  [(20, 20), (150, 150)], exclude=(E0, N0, E0 + 100.0, N0 + 100.0))
    assert doc["areas"] == []
    assert [t.get("area") for t in doc["trees"]] == [None]


def test_an_area_without_a_usable_mix_is_skipped_and_other_types_are_ignored(tmp_path, capsys):
    doc = _export(tmp_path, [
        ("broken", [_rect(0, 0, 100, 100)], {"species": "red oak"}, None, 0),
        ("zeros", [_rect(0, 0, 100, 100)], {"species": "oak=0"}, None, 1),
    ], [(10, 10)], other=[("zone", "vegetation_zone", [_rect(0, 0, 100, 100)])])
    assert doc["areas"] == []
    assert "area" not in doc["trees"][0]
    out = capsys.readouterr().out
    assert "tree area broken has no usable species mix" in out and "tree area zeros" in out


def test_without_a_course_the_file_is_as_before(tmp_path):
    out = tmp_path / "t.json"
    gspro.cmd_trees(None, _stems(tmp_path / "stems.json", [(10, 10)]), _sidecar(tmp_path / "x.tif.json"), out, extent=EXTENT)
    doc = json.loads(out.read_text())
    assert "areas" not in doc and "area" not in doc["trees"][0]


def test_the_species_mix_parser_mirrors_the_shared_one():
    assert gspro._parse_species_mix(" Oak=9, birch ,, pine=0 ") == [
        {"species": "oak", "weight": 9.0}, {"species": "birch", "weight": 1.0}, {"species": "pine", "weight": 0.0}]
    for raw in ("9oak", "oak=", "oak=x", "red oak", "oak, oak", None, 3):
        assert gspro._parse_species_mix(raw) is None


def test_cli_passes_the_course(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(gspro, "cmd_trees", lambda *a, **k: seen.update(k))
    monkeypatch.setattr("sys.argv", ["gspro.py", "trees", "--square-3006", ",".join(str(v) for v in EXTENT),
                                     "--stems", "s.json", "--sidecar", "x.json", "--out", "o.json", "--course", "Vreta"])
    gspro.main()
    assert seen["course"] == "Vreta" and seen["db_path"] == gspro.DEFAULT_DB


def test_stems_on_a_path_are_moved_to_just_beside_it_and_keep_their_id():
    from shapely.geometry import Point, box
    path = box(100.0, 0.0, 102.0, 50.0)                        # a 2 m path running north
    trees = [{"id": "a", "x": 100.4, "z": 10.0},               # on the path, nearer its west edge
             {"id": "b", "x": 102.3, "z": 20.0},               # beside it, inside the clearance
             {"id": "c", "x": 110.0, "z": 30.0}]               # well clear
    moved, longest = gspro._move_stems_off_paths(trees, [path], 0.0, 0.0, clearance_m=0.8)
    assert moved == 2 and longest == pytest.approx(1.2, abs=0.01)
    assert [t["id"] for t in trees] == ["a", "b", "c"]
    assert trees[0]["x"] == pytest.approx(99.15, abs=0.01) and trees[0]["z"] == pytest.approx(10.0, abs=0.01)
    assert trees[1]["x"] == pytest.approx(102.85, abs=0.01)
    assert trees[2] == {"id": "c", "x": 110.0, "z": 30.0}
    assert all(path.distance(Point(t["x"], t["z"])) >= 0.8 for t in trees)



def test_low_stems_on_rocks_and_every_stem_in_a_power_line_corridor_are_left_out(tmp_path):
    """What the lidar reads as a tree but is a boulder or a wire: a low stem on a rock goes, a tall
    tree over the same rock stays, and a power line's corridor is cleared whatever the height."""
    from shapely.geometry import box
    rocks_file = tmp_path / "stone-walls.json"
    rocks_file.write_text(json.dumps({"boulders": [{"id": "r1", "e": 1050.0, "n": 2050.0, "lengthM": 4.0},
                                                   {"id": "broken", "e": "x"}]}), encoding="utf-8")
    rocks = gspro._load_placed_rocks(rocks_file) + [box(1000.0, 2000.0, 1010.0, 2010.0)]   # + a slab
    wire = box(1100.0, 2000.0, 1108.0, 2100.0)                 # an 8 m corridor running north
    trees = [{"id": "bush-on-boulder", "x": 51.0, "z": 50.5, "h": 1.8},
             {"id": "pine-over-boulder", "x": 50.5, "z": 51.0, "h": 14.0},
             {"id": "bush-on-slab", "x": 5.0, "z": 5.0, "h": 2.4},
             {"id": "bush-beside-boulder", "x": 54.0, "z": 50.0, "h": 1.8},
             {"id": "wire", "x": 104.0, "z": 40.0, "h": 17.0},
             {"id": "low-under-wire", "x": 101.0, "z": 60.0, "h": 2.0},
             {"id": "tree", "x": 120.0, "z": 40.0, "h": 17.0}]
    kept, as_rock, as_wire = gspro._drop_stems_on_rocks_and_power_lines(trees, rocks, [wire], 1000.0, 2000.0)
    assert [t["id"] for t in kept] == ["pine-over-boulder", "bush-beside-boulder", "tree"]
    assert (as_rock, as_wire) == (2, 2)
    # nothing to keep out: the list comes back as it is
    assert gspro._drop_stems_on_rocks_and_power_lines(trees, [], [], 0.0, 0.0) == (trees, 0, 0)


def test_low_stems_on_a_rock_slab_are_left_out_but_a_cliff_from_the_dem_keeps_its_scrub(tmp_path, capsys):
    """A rock slab drawn over a boulder field drops the low stems on it; a slab with riseMode dem (a cliff or
    shore rock whose mesh is the course DEM) keeps every stem: the lidar's scrub and low pines grow there."""
    def stems(path, points):   # 3 m bushes
        rows = [[E0 + x, N0 + y, 3.0, 1.5, 50.0, 0] for x, y in points]
        path.write_text(json.dumps({"version": 2, "crs": "EPSG:3006", "fields": ["x", "y", "heightM", "crownRadiusM", "groundM", "kind"], "trees": rows}))
        return path

    db = tmp_path / "app.sqlite"
    _make_db(db, [], other=[
        ("slab", "rock_slab", [_rect(10, 10, 30, 30)], {"marginM": 1.5}),
        ("cliff", "rock_slab", [_rect(100, 100, 140, 140)], {"riseMode": "dem", "riseWaterM": 8}),
        ("dome", "rock_slab", [_rect(150, 10, 170, 30)], {"riseMode": "dome", "riseTopM": 1}),
    ])
    out = tmp_path / "x-inner-trees.json"
    gspro.cmd_trees(None, stems(tmp_path / "stems.json", [(20, 20), (160, 20), (120, 120), (130, 105), (60, 60)]),
                    _sidecar(tmp_path / "x.tif.json"), out, extent=EXTENT, db_path=db, course=COURSE)
    kept = [(t["x"], t["z"]) for t in json.loads(out.read_text())["trees"]]
    assert kept == [(120.0, 120.0), (130.0, 105.0), (60.0, 60.0)]
    assert "left out: 2 stem(s) under 6 m on a rock slab or placed rock" in capsys.readouterr().out
