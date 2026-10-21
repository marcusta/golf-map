"""gspro.py creeks: R.A.M. splines at the creek's water surface (unity-creeks-v1).

A synthetic DEM with a creek channel falling east, a course DB with one creek
drawn as a centerline (uphill, so it must be turned) and one as a polygon.
"""

from __future__ import annotations

import json
import sqlite3

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

import gspro

E0, N0, SIDE = 529000.0, 6486000.0, 200.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
RES = 0.5
MIN_M = 12.0


def _dem(path):
    """Ground falling 3 m west to east at 20..17 m, a 1 m-deep, 3 m-wide
    channel along y = N0 + 100 and another along y = N0 + 40."""
    n = int(SIDE / RES)
    rows, cols = np.mgrid[0:n, 0:n]
    x = (cols + 0.5) * RES
    y = SIDE - (rows + 0.5) * RES
    dem = 20.0 - 3.0 * x / SIDE
    for yc in (100.0, 40.0):
        dem = dem - (np.abs(y - yc) <= 1.5) * 1.0
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, RES, RES)) as dst:
        dst.write(dem.astype(np.float32), 1)
    return path


def _db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT,
               geometry_json TEXT, sort_order INTEGER, attributes_json TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES ('c1', 'Bäckbana')")
    # Drawn from east to west: uphill.
    line = {"crs": "EPSG:3006", "rings": [], "centerline": {
        "points": [{"x": E0 + 190, "y": N0 + 100}, {"x": E0 + 100, "y": N0 + 100}, {"x": E0 + 10, "y": N0 + 100}], "widthM": 3}}
    ribbon = {"crs": "EPSG:3006", "curveType": "bezier", "rings": [{"points": [
        {"x": E0 + 10, "y": N0 + 38.5}, {"x": E0 + 190, "y": N0 + 38.5}, {"x": E0 + 190, "y": N0 + 41.5}, {"x": E0 + 10, "y": N0 + 41.5}]}]}
    conn.execute("INSERT INTO course_features VALUES ('k1', 'c1', NULL, 'water_creek', ?, 0, ?)",
                 (json.dumps(line), json.dumps({"ramProfile": "Swamp Profile"})))
    conn.execute("INSERT INTO course_features VALUES ('k2', 'c1', NULL, 'water_creek', ?, 1, NULL)", (json.dumps(ribbon),))
    conn.execute("INSERT INTO course_features VALUES ('k3', 'c1', NULL, 'water_creek', ?, 2, ?)",
                 (json.dumps(ribbon), json.dumps({"ram": False})))
    conn.commit()
    conn.close()
    return path


def test_creeks_export_splines_at_the_surface_running_downstream(tmp_path, capsys):
    dem = _dem(tmp_path / "dem.tif")
    db = _db(tmp_path / "app.sqlite")
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": list(EXTENT), "minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "creeks.json"

    gspro.cmd_creeks(None, db, "c1", dem, sidecar, out, extent=EXTENT)

    doc = json.loads(out.read_text())
    assert doc["format"] == "unity-creeks-v1"
    assert doc["plot"] == {"crs": "EPSG:3006", "terrain": "inner", "originX": E0, "originY": N0,
                           "sizeM": SIDE, "minM": MIN_M, "maxM": 30.0}
    by_id = {c["id"]: c for c in doc["creeks"]}
    assert set(by_id) == {"feature:k1", "feature:k2"}                 # ram: false skipped
    drawn, derived = by_id["feature:k1"], by_id["feature:k2"]
    assert (drawn["source"], drawn["profile"], drawn["widthM"]) == ("centerline", "Swamp Profile", 3)
    assert (derived["source"], derived["profile"]) == ("polygon", gspro.DEFAULT_RAM_PROFILE)
    assert derived["widthM"] == pytest.approx(3.0, rel=0.2)

    for creek, yc in ((drawn, 100.0), (derived, 40.0)):
        pts = np.array(creek["points"])
        assert pts[0, 0] < pts[-1, 0]                                  # upstream (west) first
        assert np.all(np.diff(pts[:, 1]) <= 1e-9)                      # the surface never climbs
        assert np.all(np.hypot(*np.diff(pts[:, [0, 2]], axis=0).T) <= gspro.CREEK_MAX_POINT_SPACING_M + 1e-6)
        assert np.allclose(pts[:, 2], yc, atol=0.6)                    # z = metres north of the square's corner
        # y = the channel floor above the terrain's zero: 19 m − 3 m·x/200 − minM.
        expect = 20.0 - 1.0 - 3.0 * pts[:, 0] / SIDE - MIN_M
        assert np.max(np.abs(pts[:, 1] - expect)) < 0.15
    assert drawn["fallM"] == pytest.approx(3.0 * 180 / SIDE, abs=0.2)
    assert "skipped creek k3: ram: false" in capsys.readouterr().out


def test_a_waterfall_drops_the_creeks_spline_over_its_lip(tmp_path):
    # The polygon creek along y = N0 + 40 with a 1 m step at x = 100: a pond at 19.0 above, 18.0 below.
    n = int(SIDE / RES)
    rows, cols = np.mgrid[0:n, 0:n]
    x = (cols + 0.5) * RES
    y = SIDE - (rows + 0.5) * RES
    dem = np.where(x < 100, 20.0, 19.0) - (np.abs(y - 40.0) <= 1.5) * 1.0
    path = tmp_path / "dem.tif"
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, RES, RES)) as dst:
        dst.write(dem.astype(np.float32), 1)
    db = _db(tmp_path / "app.sqlite")
    conn = sqlite3.connect(db)
    lip = {"crs": "EPSG:3006", "rings": [], "centerline": {
        "points": [{"x": E0 + 100, "y": N0 + 37.5}, {"x": E0 + 100, "y": N0 + 42.5}], "widthM": 2}}
    conn.execute("INSERT INTO course_features VALUES ('w1', 'c1', NULL, 'waterfall', ?, 3, ?)",
                 (json.dumps(lip), json.dumps({"style": "sill", "sillM": 1})))
    conn.commit()
    conn.close()
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": list(EXTENT), "minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "creeks.json"

    gspro.cmd_creeks(None, db, "c1", path, sidecar, out, extent=EXTENT)

    by_id = {c["id"]: c for c in json.loads(out.read_text())["creeks"]}
    creek = by_id["feature:k2"]
    assert creek["falls"] == 1 and "feature:k2#2" not in by_id          # one spline down the whole creek
    pts = [(p[0], p[1] + MIN_M) for p in creek["points"]]
    upper = [h for x, h in pts if x < 98.5]
    lower = [h for x, h in pts if x > 101.5]
    assert all(h == pytest.approx(19.0, abs=0.03) for h in upper)       # flat above the fall, no ramp
    assert all(h == pytest.approx(18.0, abs=0.03) for h in lower)
    # The drop happens over the lip: from the upper water at the lip to the lower within half a metre.
    drops = [(b[0] - a[0], a[1] - b[1]) for a, b in zip(pts, pts[1:]) if a[1] - b[1] > 0.5]
    assert len(drops) == 1 and drops[0][0] <= 0.5 and drops[0][1] == pytest.approx(0.96, abs=0.06)
    assert 99.0 <= [x for x, h in pts if h > 18.9][-1] <= 101.0          # the lip near x = 100
    assert by_id["feature:k1"].get("falls") is None                     # the other creek has no fall
    # A polygon creek's neck is as wide as the lip (5 m) plus the pad, not the polygon's 3 m mean width.
    # Its points over the sill and down the face are listed (Unity keeps them as the neck); the others keep the width.
    neck = creek["fallPoints"]
    assert len(neck) == 4 and all(98.0 <= creek["points"][i][0] <= 102.0 for i in neck)
    assert all(creek["points"][i][3] == pytest.approx(5.0 + gspro.CREEK_FALL_WIDTH_PAD_M, abs=0.01) for i in neck)
    assert all(p[3] == creek["widthM"] for i, p in enumerate(creek["points"]) if i not in neck)


def test_a_fountain_or_a_cascade_on_a_creek_is_no_fall(tmp_path):
    dem = _dem(tmp_path / "dem.tif")
    db = _db(tmp_path / "app.sqlite")
    conn = sqlite3.connect(db)
    across = {"crs": "EPSG:3006", "rings": [], "centerline": {
        "points": [{"x": E0 + 60, "y": N0 + 39.4}, {"x": E0 + 60, "y": N0 + 40.6}], "widthM": 1}}
    down = {"crs": "EPSG:3006", "rings": [], "centerline": {
        "points": [{"x": E0 + 120, "y": N0 + 40}, {"x": E0 + 150, "y": N0 + 40}], "widthM": 1}}
    conn.execute("INSERT INTO course_features VALUES ('f1', 'c1', NULL, 'waterfall', ?, 3, ?)",
                 (json.dumps(across), json.dumps({"style": "fountain"})))
    conn.execute("INSERT INTO course_features VALUES ('f2', 'c1', NULL, 'waterfall', ?, 4, ?)",
                 (json.dumps(down), json.dumps({"style": "cascade"})))
    conn.commit()
    conn.close()
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": list(EXTENT), "minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "creeks.json"

    gspro.cmd_creeks(None, db, "c1", dem, sidecar, out, extent=EXTENT)

    creek = {c["id"]: c for c in json.loads(out.read_text())["creeks"]}["feature:k2"]
    assert creek.get("falls") is None and creek.get("fallsAt") is None
    assert len({round(p[3], 2) for p in creek["points"]}) == 1          # no neck anywhere


def test_a_creek_on_a_lake_runs_level_as_drawn_and_is_cut_at_no_fall(tmp_path):
    # ramOnLake: hole 9's channel through pond 576 to fall E - drawn from the pond downstream, here uphill on the DEM.
    dem = _dem(tmp_path / "dem.tif")
    db = _db(tmp_path / "app.sqlite")
    conn = sqlite3.connect(db)
    conn.execute("UPDATE course_features SET attributes_json = ? WHERE id = 'k1'", (json.dumps({"ramOnLake": True}),))
    lip = {"crs": "EPSG:3006", "rings": [], "centerline": {
        "points": [{"x": E0 + 100, "y": N0 + 97.5}, {"x": E0 + 100, "y": N0 + 102.5}], "widthM": 2}}
    conn.execute("INSERT INTO course_features VALUES ('w1', 'c1', NULL, 'waterfall', ?, 3, ?)",
                 (json.dumps(lip), json.dumps({"style": "sill", "sillM": 1})))
    conn.commit()
    conn.close()
    sidecar = tmp_path / "inner.tif.json"
    sidecar.write_text(json.dumps({"terrain": "inner", "square3006": list(EXTENT), "minM": MIN_M, "maxM": 30.0}))
    out = tmp_path / "creeks.json"

    gspro.cmd_creeks(None, db, "c1", dem, sidecar, out, extent=EXTENT)

    creek = {c["id"]: c for c in json.loads(out.read_text())["creeks"]}["feature:k1"]
    pts = np.array(creek["points"])
    assert creek["onLake"] is True
    assert pts[0, 0] > pts[-1, 0]                                      # as drawn (east first), not turned
    assert np.ptp(pts[:, 1]) == 0                                      # level
    assert creek.get("falls") is None                                  # the lip on it cuts nothing
