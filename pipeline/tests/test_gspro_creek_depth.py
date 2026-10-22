"""gspro.py creek-depth: each creek's depth as the course meshes will have it, with what its dig is.

A synthetic DEM with the digs already in it (flat ground at 20 m), a course DB with creeks drawn as centerlines, their
`creek-digs` edits, a pond, a fairway and a shaping layer that cuts one creek's bed out in Blender:
- a narrow creek (1 m, dug 0.35 m) that comes out shallow, half of it in a Blender bed;
- a wide one (4 m, dug 0.5 m) running into the pond past an undug strip of bank;
- one drawn after the digs (no edit), one longer than its dig, one on a lake.
"""

from __future__ import annotations

import json
import sqlite3

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

import gspro

E0, N0, SIDE, RES = 529000.0, 6486000.0, 200.0, 0.5
GROUND = 20.0
SITE = "s1"


def _dem(path):
    n = int(SIDE / RES)
    rows, cols = np.mgrid[0:n, 0:n]
    x = (cols + 0.5) * RES
    y = SIDE - (rows + 0.5) * RES
    dem = np.full((n, n), GROUND)

    def channel(yc, width, depth, x0, x1):
        d_in = width / 2.0 - np.abs(y - yc)
        dig = np.clip(d_in * np.tan(np.radians(60.0)), 0.0, depth)
        return np.where((d_in > 0) & (x >= x0) & (x <= x1), dig, 0.0)

    dem -= channel(100.0, 1.0, 0.35, 50, 150)          # k_narrow
    dem -= channel(60.0, 4.0, 0.5, 50, 150)            # k_wide, ends 5 m short of the pond
    dem -= channel(170.0, 4.0, 0.5, 50, 150)           # k_long (its line runs on to 180, its dig stops at 100)
    dem = np.where((x >= 155) & (x <= 190) & (np.abs(y - 60) <= 10), GROUND - 1.5, dem)   # the pond
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, RES, RES)) as dst:
        dst.write(dem.astype(np.float32), 1)
    return path


def _line(yc, x0, x1, width):
    return {"crs": "EPSG:3006", "rings": [], "centerline": {
        "points": [{"x": E0 + x0, "y": N0 + yc}, {"x": E0 + x1, "y": N0 + yc}], "widthM": width}}


def _rect(x0, y0, x1, y1):
    return {"crs": "EPSG:3006", "curveType": "bezier", "rings": [{"points": [
        {"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]}]}


def _ring(x0, y0, x1, y1):
    return [{"x": E0 + x0, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y0}, {"x": E0 + x1, "y": N0 + y1}, {"x": E0 + x0, "y": N0 + y1}]


def _db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT, site_id TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT, geometry_json TEXT,
               sort_order INTEGER, attributes_json TEXT, feature_no INTEGER);
           CREATE TABLE terrain_edits (
               id TEXT PRIMARY KEY, site_id TEXT, op TEXT, params_json TEXT, rings_json TEXT, enabled INTEGER,
               version INTEGER, created_at TEXT, updated_at TEXT, origin TEXT, origin_ref TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES ('c1', 'Djupbana', ?)", (SITE,))
    conn.execute("INSERT INTO holes VALUES ('h3', 'c1', 3)")
    features = [
        ("k_narrow", "h3", "water_creek", _line(100, 50, 150, 1.0), None),
        ("k_wide", None, "water_creek", _line(60, 50, 156, 4.0), None),
        ("k_new", None, "water_creek", _line(140, 50, 150, 1.5), None),
        ("k_long", None, "water_creek", _line(170, 50, 180, 4.0), None),
        ("k_lake", None, "water_creek", _line(30, 50, 80, 3.0), {"ramOnLake": True}),
        ("k_off", None, "water_creek", _line(10, 50, 80, 1.0), {"dig": False}),
        ("pond", None, "water", _rect(155, 50, 190, 70), None),
        ("fw", None, "fairway", _rect(0, 115, 200, 130), None),
    ]
    for i, (fid, hole, typ, geom, attrs) in enumerate(features):
        conn.execute("INSERT INTO course_features VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)",
                     (fid, hole, typ, json.dumps(geom), i, json.dumps(attrs) if attrs else None, i + 1))
    for fid, ring, depth in (("k_narrow", _ring(50, 99.5, 150, 100.5), 0.35), ("k_wide", _ring(50, 58, 156, 62), 0.5),
                             ("k_long", _ring(50, 168, 100, 172), 0.5)):
        conn.execute("INSERT INTO terrain_edits VALUES (?, ?, 'dig', ?, ?, 1, 1, '', '', 'creek-digs', ?)",
                     (f"e_{fid}", SITE, json.dumps({"depthM": depth, "bankSlopeDeg": 18, "reference": "stream"}),
                      json.dumps([ring]), f"feature:{fid}"))
    conn.commit()
    conn.close()
    return path


def _layers(folder):
    """A hand shaping layer cutting k_narrow's bed out over its first 50 m."""
    folder.mkdir()
    outline = [[E0 + x, N0 + y] for x, y in ((48, 98), (100, 98), (100, 102), (48, 102))]
    (folder / "25-creek-beds.json").write_text(json.dumps({"format": "golfmap-shaping-layer-v1", "id": "creek-beds", "ops": [
        {"id": "brook_k_narrow_1", "op": "golfmap.cut_out", "surface": "WaterBrook", "outline3006": outline}]}))
    return folder


def _report(tmp_path, **kw):
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": [E0, N0, E0 + SIDE, N0 + SIDE],
                                   "minM": 10.0, "raw": {"size": 401}}))
    return gspro.creek_depth_report(_db(tmp_path / "app.sqlite"), "c1", _dem(tmp_path / "dem-edited.tif"), sidecar, **kw)


def test_each_creek_gets_its_depth_in_the_meshes_and_its_dig_state(tmp_path):
    doc = _report(tmp_path, layers_dir=tmp_path / "no-layers")
    assert doc["format"] == gspro.CREEK_DEPTH_FORMAT
    by = {c["id"]: c for c in doc["creeks"]}
    narrow, wide = by["k_narrow"], by["k_wide"]
    assert narrow["label"] == "hole 3 k_narrow" and narrow["dig"]["state"] == "dug"
    assert narrow["demDepthM"]["median"] > 0.3 and narrow["meshDepthM"]["median"] < narrow["minDepthM"]
    assert narrow["status"] == "shallow" and narrow["shallowM"] > 90
    assert wide["meshDepthM"]["median"] > 0.35
    assert [(st["fromM"], st["toM"]) for st in wide["shallow"]] == [(100.0, 105.0)]   # only the undug bank at its mouth
    assert by["k_new"]["status"] == "not-dug" and by["k_new"]["dig"] == {"state": "none"}
    assert by["k_long"]["status"] == "stale" and by["k_long"]["dig"]["outsideM"] > 70
    assert by["k_lake"]["status"] == "on-lake" and "meshDepthM" not in by["k_lake"]
    assert by["k_off"]["status"] == "off"
    assert {c["id"] for c in doc["creeks"] if c.get("farFromPlay")} == {"k_off"}     # 105 m from the fairway
    assert doc["summary"] == {"creeks": 6, "shallow": 2, "not-dug": 1, "stale": 1, "on-lake": 1, "off": 1}


def test_a_bank_left_across_a_creeks_mouth_is_found(tmp_path):
    wide = {c["id"]: c for c in _report(tmp_path, layers_dir=tmp_path / "no-layers")["creeks"]}["k_wide"]
    assert wide["status"] == "shallow"                       # deep enough, but held back from the pond
    (mouth,) = wide["mouths"]
    assert mouth["blocked"] and mouth["demBlockM"] > 0.4
    assert abs(mouth["x"] - (E0 + 152)) < 1.0                      # measured from 3 m out from the shore


def test_a_blender_bed_counts_as_deep_as_the_dem(tmp_path):
    doc = _report(tmp_path, layers_dir=_layers(tmp_path / "shaping"))
    assert doc["blenderBeds"] == {"layers": ["25-creek-beds.json"], "beds": 1, "channels": 0}
    narrow = {c["id"]: c for c in doc["creeks"]}["k_narrow"]
    assert 49 <= narrow["bedM"] <= 52
    assert all(st["fromM"] >= 49 for st in narrow["shallow"])        # the first 50 m are in the bed
    assert 45 <= narrow["shallowM"] <= 52
    # left out, the layer no longer counts (the generated beds layer is made again from the rest)
    (tmp_path / "again").mkdir()
    again = _report(tmp_path / "again", layers_dir=tmp_path / "shaping", ignore_layers=("25-creek-beds.json",))
    assert {c["id"]: c for c in again["creeks"]}["k_narrow"]["bedM"] == 0


def test_cli_prints_and_writes_the_report(tmp_path, capsys):
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": [E0, N0, E0 + SIDE, N0 + SIDE],
                                   "minM": 10.0, "raw": {"size": 401}}))
    db, dem, out = _db(tmp_path / "app.sqlite"), _dem(tmp_path / "dem-edited.tif"), tmp_path / "depth.json"
    gspro.main(["creek-depth", "--db", str(db), "--course", "c1", "--dem", str(dem), "--sidecar", str(sidecar),
                "--out", str(out), "--only", "k_narrow,k_new"])
    text = capsys.readouterr().out
    assert "2 creek(s) - 1 shallow, 1 not dug" in text
    assert "not-dug  k_new" in text and "shallow  hole 3 k_narrow" in text
    assert {c["id"] for c in json.loads(out.read_text())["creeks"]} == {"k_narrow", "k_new"}


def _engine():
    import importlib.util
    from pathlib import Path as _P
    path = _P(__file__).resolve().parents[2] / "blender" / "tools" / "shape_layers.py"
    spec = importlib.util.spec_from_file_location("shape_layers_for_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_shaping_creek_beds_cuts_out_the_shallow_stretches_of_dug_creeks(tmp_path):
    from shapely.geometry import Polygon

    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": [E0, N0, E0 + SIDE, N0 + SIDE],
                                   "minM": 10.0, "raw": {"size": 401}}))
    db, dem = _db(tmp_path / "app.sqlite"), _dem(tmp_path / "dem-edited.tif")
    layers = _layers(tmp_path / "shaping")
    doc, notes = gspro.shaping_creek_beds(db, "c1", dem, sidecar, layers)
    assert _engine().validate_layer(doc) == []
    beds = [o for o in doc["ops"] if o["op"] == "golfmap.cut_out"]
    assert {o["name"].rsplit("_", 1)[0] for o in beds} == {"bed_k_narrow"}
    # k_wide's one shallow stretch is the bank left at its mouth: wide enough to dig, so a note, not a bed
    assert any(n.startswith("k_wide: 0 bed(s)") and "the DEM is not dug at 100-105 m" in n for n in notes)
    narrow = [Polygon(o["outline3006"]) for o in beds if "k_narrow" in o["name"]]
    hand = Polygon([(E0 + 48, N0 + 98), (E0 + 100, N0 + 98), (E0 + 100, N0 + 102), (E0 + 48, N0 + 102)])
    assert all(p.intersection(hand).area < 0.01 for p in narrow)            # the hand layer's bed stays its own
    assert sum(p.area for p in narrow) > 35                                  # the other 50 m, 0.8 m wide (shrunk 0.1)
    assert all(o["surface"] == "WaterBrook" and o["rise"]["mode"] == "dem" for o in beds)
    assert not any(o["op"] == "golfmap.creek_channel" for o in doc["ops"])  # the DEM holds these digs
    assert any("k_new: not-dug - no bed" in n for n in notes)
    assert any("k_long: stale - no bed" in n for n in notes)


def test_a_creek_narrower_than_the_dem_gets_a_channel(tmp_path):
    """0.4 m wide, dug 0.55 m: the 0.5 m DEM can hardly hold it, so the bed gets a channel at the dig's depth."""
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": [E0, N0, E0 + SIDE, N0 + SIDE],
                                   "minM": 10.0, "raw": {"size": 401}}))
    dem = _dem(tmp_path / "dem-edited.tif")
    with rasterio.open(dem, "r+") as ds:                                    # a 0.4 m drain dug where the DEM can
        a = ds.read(1)
        rows = np.arange(a.shape[0])
        y = SIDE - (rows + 0.5) * RES
        a[np.abs(y - 125.0) <= 0.2, 100:300] -= 0.55
        ds.write(a, 1)
    db = _db(tmp_path / "app.sqlite")
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO course_features VALUES ('k_drain', 'c1', NULL, 'water_creek', ?, 20, ?, 21)",
                 (json.dumps(_line(125, 50, 150, 0.4)), json.dumps({"digDepthM": 0.55})))
    conn.execute("INSERT INTO terrain_edits VALUES ('e_drain', ?, 'dig', ?, ?, 1, 1, '', '', 'creek-digs', 'feature:k_drain')",
                 (SITE, json.dumps({"depthM": 0.55, "bankSlopeDeg": 25}), json.dumps([_ring(50, 124.8, 150, 125.2)])))
    conn.commit()
    conn.close()
    doc, _ = gspro.shaping_creek_beds(db, "c1", dem, sidecar, tmp_path / "no-layers")
    assert _engine().validate_layer(doc) == []
    chans = [o for o in doc["ops"] if o["op"] == "golfmap.creek_channel" and "k_drain" in o["id"]]
    assert chans and all(o["depthM"] == 0.55 and o["widthM"] == 0.5 and o["wallM"] == 0.5 for o in chans)
    names = {o["name"] for o in doc["ops"] if o["op"] == "golfmap.cut_out"}
    assert all(o["object"] == f"Spline_{o['id'].split('_channel')[0]}_WaterBrook_-_Mesh" and o["id"].split("_channel")[0] in names
               for o in chans)


def test_cmd_shaping_creek_beds_writes_the_layer_or_leaves_it_without_a_dem(tmp_path, capsys):
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": [E0, N0, E0 + SIDE, N0 + SIDE],
                                   "minM": 10.0, "raw": {"size": 401}}))
    db, dem = _db(tmp_path / "app.sqlite"), _dem(tmp_path / "dem-edited.tif")
    out_dir = tmp_path / "shaping"
    out_dir.mkdir()
    out = gspro.cmd_shaping_creek_beds(db, "c1", out_dir, dem_path=dem, sidecar_path=sidecar)
    assert out == out_dir / gspro.CREEK_BEDS_GEN_FILE and json.loads(out.read_text())["id"] == gspro.CREEK_BEDS_ID
    before = out.read_text()
    assert gspro.cmd_shaping_creek_beds(db, "c1", out_dir, dem_path=tmp_path / "missing.tif", sidecar_path=sidecar) is None
    assert "creek beds not generated" in capsys.readouterr().out and out.read_text() == before
