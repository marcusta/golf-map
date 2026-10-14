"""gspro batch — several commands in ONE process over a shared cache.

The point of the command is that it changes nothing: a batch of
[dem, trees, zones, creeks, gkd, svg, shaping-global] must write byte-identical
files to running those commands one at a time, only faster. So the first test
runs the same course both ways into two directories and compares every byte,
and the rest cover the report, the failures and the sharing.

One synthetic course, no mocks: a real SQLite database with the app's tables, a
real DEM GeoTIFF with a creek channel in it, and a real tree-stems asset, all
built in tmp_path.
"""

from __future__ import annotations

import codecs
import io
import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import transform as transform_points

import gspro

COURSE = "44444444-4444-4444-4444-444444444444"
SITE = "site-batch"
E0, N0 = 530000.0, 6487000.0
SIDE = 400.0
EXTENT = (E0, N0, E0 + SIDE, N0 + SIDE)
SQUARE = f"{E0},{N0},{E0 + SIDE},{N0 + SIDE}"
DEM_RES = 0.5
# Big enough that the files are real work, small enough that the suite stays quick.
RAW_SIZE = 129
ZONE_RES = 256

DEM_NAME = "batchbana-inner-dem-400m.tif"


def _ring(*xy: tuple[float, float]) -> dict:
    return {"points": [{"x": E0 + x, "y": N0 + y} for x, y in xy]}


def _rect(x0: float, y0: float, x1: float, y1: float) -> dict:
    return _ring((x0, y0), (x1, y0), (x1, y1), (x0, y1))


def _wgs84(x: float, y: float) -> tuple[float, float]:
    lons, lats = transform_points(gspro.SWEREF99, gspro.WGS84, [x], [y])
    return lats[0], lons[0]


def _feature(fid, kind, rings, no, hole=None, attrs=None, centerline=None, generated=0):
    geom: dict = {"crs": "EPSG:3006", "curveType": "bezier", "rings": rings}
    if centerline is not None:
        geom["centerline"] = centerline
    return dict(id=fid, type=kind, geom=geom, no=no, hole=hole, attrs=attrs, generated=generated)


# A course with something for every command: holes and tees for the GKD, water
# for its hazard lines, a creek drawn as a centerline down the DEM's channel,
# a gravel road and a paved lot for the shaping layer, a rock slab for its
# cut-out, and two vegetation zones for the masks.
FEATURES = [
    _feature("tee-1", "tee", [_rect(340, 190, 360, 210)], 1, hole=1),
    _feature("green-1", "green", [_rect(40, 180, 80, 220)], 2, hole=1),
    _feature("fairway-1", "fairway", [_rect(90, 170, 330, 230)], 3, hole=1),
    _feature("rough-1", "rough", [_rect(70, 150, 350, 250)], 4, hole=1),
    _feature("bunker-1", "bunker", [_rect(95, 165, 115, 180)], 5, hole=1),
    _feature("pond-1", "water", [_rect(150, 60, 220, 120)], 6, hole=1),
    _feature("creek-1", "water_creek", [], 7, centerline={
        "points": [{"x": E0 + 380, "y": N0 + 300}, {"x": E0 + 200, "y": N0 + 300},
                   {"x": E0 + 20, "y": N0 + 300}], "widthM": 3}),
    _feature("road-1", "path", [_rect(10, 320, 390, 326)], 8, attrs={"surface": "gravel"}),
    _feature("lot-1", "path", [_rect(250, 40, 300, 90)], 9, attrs={"surface": "asphalt"}),
    _feature("slab-1", "rock_slab", [_rect(120, 280, 140, 300)], 10, attrs={"marginM": 1.5}),
    _feature("oob-1", "oob", [_rect(5, 5, 395, 395)], 11),
    _feature("zone-1", "vegetation_zone", [_rect(30, 30, 130, 130)], 12,
             attrs={"zoneType": "rough_tall", "feather": 2.0, "noise": 0.0, "weight": 0.8}),
    _feature("zone-2", "vegetation_zone", [_rect(240, 240, 360, 360)], 13,
             attrs={"zoneType": "shrub", "feather": 0.0, "noise": 0.3}),
]

ZONE_TYPES = [
    ("rough_tall", "Tall rough", "#8a9a3a", [{"item": "Tall grass", "minDensity": 0.0, "maxDensity": 1.0}]),
    ("shrub", "Shrubs", "#6b8f3a", [{"item": "Hazel bush", "minDensity": 0.1, "maxDensity": 0.6}]),
]


def _make_db(path: Path) -> Path:
    """The app's tables, as the migrations leave them for a course that has
    everything these commands read."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE courses (id TEXT PRIMARY KEY, name TEXT, site_id TEXT, gspro_meta_json TEXT);
           CREATE TABLE holes (id TEXT PRIMARY KEY, course_id TEXT, number INTEGER, par INTEGER,
                               stroke_index INTEGER);
           CREATE TABLE tees (id TEXT PRIMARY KEY, hole_id TEXT, name TEXT, color TEXT,
                              lat REAL, lon REAL, sort_order INTEGER);
           CREATE TABLE greens (id TEXT PRIMARY KEY, hole_id TEXT, center_lat REAL, center_lon REAL);
           CREATE TABLE pins (id TEXT PRIMARY KEY, green_id TEXT, name TEXT, lat REAL, lon REAL,
                              active INTEGER DEFAULT 1);
           CREATE TABLE aim_points (id TEXT PRIMARY KEY, hole_id TEXT, sort_order INTEGER,
                                    lat REAL, lon REAL, label TEXT);
           CREATE TABLE course_features (
               id TEXT PRIMARY KEY, course_id TEXT, hole_id TEXT, type TEXT, geometry_json TEXT,
               sort_order INTEGER, created_at TEXT, source TEXT, source_ref TEXT, attributes_json TEXT,
               generated INTEGER NOT NULL DEFAULT 0, feature_no INTEGER, layer TEXT);
           CREATE TABLE course_zone_types (
               id TEXT PRIMARY KEY, course_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
               color TEXT NOT NULL, texture_index INTEGER NOT NULL, channel INTEGER NOT NULL,
               sort_order INTEGER NOT NULL, items_json TEXT NOT NULL DEFAULT '[]',
               variants_json TEXT NOT NULL DEFAULT '[]');
           CREATE TABLE terrain_edits (
               id TEXT PRIMARY KEY, site_id TEXT, op TEXT, params_json TEXT, rings_json TEXT,
               enabled INTEGER, version INTEGER, created_at TEXT, updated_at TEXT, origin TEXT,
               origin_ref TEXT);"""
    )
    conn.execute("INSERT INTO courses VALUES (?, 'Batchbana', ?, NULL)", (COURSE, SITE))
    conn.execute("INSERT INTO holes VALUES ('h1', ?, 1, 4, 7)", (COURSE,))
    for i, (name, color, x, y) in enumerate([("Yellow", "yellow", 350.0, 200.0),
                                             ("White", "white", 358.0, 200.0)]):
        lat, lon = _wgs84(E0 + x, N0 + y)
        conn.execute("INSERT INTO tees VALUES (?, 'h1', ?, ?, ?, ?, ?)",
                     (f"tee-{i}", name, color, lat, lon, i))
    lat, lon = _wgs84(E0 + 200.0, N0 + 200.0)
    conn.execute("INSERT INTO aim_points VALUES ('aim-0', 'h1', 0, ?, ?, 'A1')", (lat, lon))
    lat, lon = _wgs84(E0 + 60.0, N0 + 200.0)
    conn.execute("INSERT INTO greens VALUES ('g1', 'h1', ?, ?)", (lat, lon))
    lat, lon = _wgs84(E0 + 62.0, N0 + 204.0)
    conn.execute("INSERT INTO pins VALUES ('p1', 'g1', 'Mitten', ?, ?, 1)", (lat, lon))
    for i, f in enumerate(FEATURES):
        conn.execute(
            "INSERT INTO course_features VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)",
            (f["id"], COURSE, "h1" if f["hole"] else None, f["type"], json.dumps(f["geom"]), i,
             f"2026-02-01T00:00:{i:02d}Z", json.dumps(f["attrs"]) if f["attrs"] else None,
             f["generated"], f["no"]))
    for i, (key, name, color, items) in enumerate(ZONE_TYPES):
        conn.execute("INSERT INTO course_zone_types VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, '[]')",
                     (f"zt-{i}", COURSE, key, name, color, i, i, json.dumps(items)))
    conn.execute("INSERT INTO terrain_edits VALUES ('e1', ?, 'plane', ?, ?, 1, 1, ?, ?, "
                 "'building-pads', NULL)",
                 (SITE, json.dumps({"featherM": 3, "flat": True}),
                  json.dumps([[{"x": E0 + 150, "y": N0 + 240}, {"x": E0 + 170, "y": N0 + 240},
                               {"x": E0 + 170, "y": N0 + 260}, {"x": E0 + 150, "y": N0 + 260}]]),
                  "2026-01-01 00:00:00.000001", "2026-01-01 00:00:00.000001"))
    conn.commit()
    conn.close()
    return path


def _make_dem(path: Path) -> Path:
    """Ground falling 6 m west to east over the square at DEM_RES, with a
    1 m-deep channel along y = N0 + 300 for the creek to run down and a void
    corner so `_fill_voids` has something to do."""
    n = int(SIDE / DEM_RES)
    rows, cols = np.mgrid[0:n, 0:n]
    x = (cols + 0.5) * DEM_RES
    y = SIDE - (rows + 0.5) * DEM_RES
    dem = 80.0 - 6.0 * x / SIDE + 1.5 * np.sin(y / 70.0)
    dem = dem - (np.abs(y - 300.0) <= 1.5) * 1.0
    dem[:8, :8] = -9999.0
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, DEM_RES, DEM_RES),
                       nodata=-9999.0) as dst:
        dst.write(dem.astype(np.float32), 1)
    return path


def _make_stems(path: Path) -> Path:
    rng = np.random.default_rng(7)
    trees = []
    for i in range(60):
        x = float(E0 + rng.uniform(5, 395))
        y = float(N0 + rng.uniform(5, 395))
        trees.append([round(x, 2), round(y, 2), round(float(rng.uniform(4, 22)), 2),
                      round(float(rng.uniform(1.5, 5)), 2), round(70.0 + i * 0.1, 2), int(i % 2)])
    path.write_text(json.dumps({"version": 2, "crs": "EPSG:3006",
                                "fields": ["x", "y", "heightM", "crownRadiusM", "groundM", "kind"],
                                "trees": trees}), encoding="utf-8")
    return path


@pytest.fixture
def course(tmp_path):
    """The inputs every run below shares: database, source DEM, tree stems."""
    src = tmp_path / "in"
    src.mkdir()
    return {"db": _make_db(src / "app.sqlite"), "dem": _make_dem(src / "dem.tif"),
            "stems": _make_stems(src / "tree-stems.json")}


def _jobs(course, out: Path) -> list[dict]:
    """The six commands of one export, with the arguments the CLI takes today
    (so the server hands over the argv arrays it already builds).  The DEM goes
    first: the trees, zones, creeks and GKD jobs all read its sidecar."""
    dem = out / DEM_NAME
    sidecar = out / f"{DEM_NAME}.json"
    return [
        {"id": "dem-inner", "command": "dem", "args": [
            "--square-3006", SQUARE, "--dem", str(course["dem"]), "--out", str(dem),
            "--resolution", "1.0", "--raw-size", str(RAW_SIZE), "--terrain", "inner"]},
        {"id": "trees-inner", "command": "trees", "args": [
            "--square-3006", SQUARE, "--stems", str(course["stems"]), "--sidecar", str(sidecar),
            "--out", str(out / "batchbana-inner-trees.json"), "--terrain", "inner",
            "--course", COURSE, "--db", str(course["db"])]},
        {"id": "zones-inner", "command": "zones", "args": [
            "--square-3006", SQUARE, "--db", str(course["db"]), "--course", COURSE,
            "--sidecar", str(sidecar), "--out", str(out / "batchbana-inner-zones.json"),
            "--terrain", "inner", "--resolution", str(ZONE_RES)]},
        {"id": "creeks-inner", "command": "creeks", "args": [
            "--square-3006", SQUARE, "--db", str(course["db"]), "--course", COURSE,
            "--dem", str(course["dem"]), "--sidecar", str(sidecar),
            "--out", str(out / "batchbana-inner-creeks.json")]},
        {"id": "gkd", "command": "gkd", "args": [
            "--square-3006", SQUARE, "--db", str(course["db"]), "--course", COURSE,
            "--sidecar", str(sidecar), "--out", str(out / "Batchbana.GKD"), "--no-merge"]},
        {"id": "svg", "command": "svg", "args": [
            "--square-3006", SQUARE, "--db", str(course["db"]), "--course", COURSE,
            "--out", str(out / "batchbana.svg")]},
        {"id": "shaping", "command": "shaping-global", "args": [
            "--db", str(course["db"]), "--course", COURSE, "--out-dir", str(out / "shaping")]},
    ]


def _run_one_by_one(jobs: list[dict]) -> None:
    """What the server does today: one process per kind (here one `main` call
    per kind, with no batch cache)."""
    assert gspro._BATCH is None
    for job in jobs:
        assert gspro.main([job["command"], *job["args"]]) == 0


def _run_batch(jobs: list[dict], tmp_path: Path, name="jobs.json", **doc) -> tuple[int, dict]:
    jobs_file = tmp_path / name
    jobs_file.write_text(json.dumps({"jobs": jobs, **doc}), encoding="utf-8")
    result = tmp_path / f"{jobs_file.stem}-result.json"
    code = gspro.main(["batch", "--jobs", str(jobs_file), "--result", str(result)])
    return code, json.loads(result.read_text(encoding="utf-8"))


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)).replace("\\", "/"): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


# --- Determinism ------------------------------------------------------------

def test_a_batch_writes_the_same_bytes_as_the_separate_runs(course, tmp_path):
    """Six commands in one process over the shared cache produce exactly the
    files the six separate runs do — every byte of the SVG, the GeoTIFF, the
    .raw heightmap, the sidecars, the zone PNGs, the creeks, the GKD and the
    shaping layers."""
    one, many = tmp_path / "one", tmp_path / "many"
    _run_one_by_one(_jobs(course, one))
    code, result = _run_batch(_jobs(course, many), tmp_path)

    assert code == 0, [j for j in result["jobs"] if not j["ok"]]
    separate, batched = _tree(one), _tree(many)
    assert sorted(batched) == sorted(separate)
    # Files worth naming, so a failure says which one drifted.
    assert len(separate) > 10 and f"{DEM_NAME}.json" in separate and "batchbana.svg" in separate
    differ = [name for name in separate if separate[name] != batched[name]]
    assert differ == []


def test_the_batch_reports_the_same_lines_the_separate_runs_print(course, tmp_path, capsys):
    """A job's report in the result is what that command printed — the batch
    log is the same lines, prefixed with the job's id."""
    jobs = _jobs(course, tmp_path / "one")
    _run_one_by_one(jobs)
    alone = capsys.readouterr().out.splitlines()

    _, result = _run_batch(_jobs(course, tmp_path / "many"), tmp_path)
    log = capsys.readouterr().out.splitlines()

    reported = [line for job in result["jobs"] for line in job["report"]]
    assert len(reported) == len(alone)
    # The paths differ (another output directory), so compare what does not.
    assert [line.replace(str(tmp_path / "many"), "") for line in reported] \
        == [line.replace(str(tmp_path / "one"), "") for line in alone]
    for job in result["jobs"]:
        for line in job["report"]:
            assert f"[{job['id']}] {line}" in log


# --- The result file --------------------------------------------------------

def test_the_result_names_every_job_with_its_timing_and_report(course, tmp_path):
    code, result = _run_batch(_jobs(course, tmp_path / "out"), tmp_path)

    assert code == 0
    assert result["format"] == "golfmap-gspro-batch-v1"
    assert [j["id"] for j in result["jobs"]] == ["dem-inner", "trees-inner", "zones-inner",
                                                 "creeks-inner", "gkd", "svg", "shaping"]
    assert [j["command"] for j in result["jobs"]] == ["dem", "trees", "zones", "creeks", "gkd",
                                                      "svg", "shaping-global"]
    assert all(set(j) == {"id", "command", "ok", "seconds", "report", "error"} for j in result["jobs"])
    assert all(j["ok"] and j["error"] is None and j["report"] for j in result["jobs"])
    assert all(j["seconds"] >= 0 for j in result["jobs"])
    assert result["seconds"] >= sum(j["seconds"] for j in result["jobs"]) - 0.5
    assert set(result["shared"]) == {*gspro._BATCH_SLOTS, "bytes"}


def test_a_job_with_no_id_is_named_after_its_command_and_place(course, tmp_path):
    jobs = _jobs(course, tmp_path / "out")[:2]
    for job in jobs:
        job.pop("id")
    _, result = _run_batch(jobs, tmp_path)
    assert [j["id"] for j in result["jobs"]] == ["dem-1", "trees-2"]


# --- Failures ---------------------------------------------------------------

def _failing(course, out: Path) -> dict:
    """A `creeks` job whose DEM is not there: the command raises
    SystemExit("error: …"), which must become this job's error."""
    return {"id": "creeks-bad", "command": "creeks", "args": [
        "--square-3006", SQUARE, "--db", str(course["db"]), "--course", COURSE,
        "--dem", str(out / "nope.tif"), "--sidecar", str(out / f"{DEM_NAME}.json"),
        "--out", str(out / "nope.json")]}


def test_a_failed_job_is_in_the_result_the_later_jobs_still_run_and_the_exit_code_is_1(course, tmp_path):
    out = tmp_path / "out"
    jobs = _jobs(course, out)
    jobs.insert(1, _failing(course, out))
    code, result = _run_batch(jobs, tmp_path)

    assert code == 1
    bad = next(j for j in result["jobs"] if j["id"] == "creeks-bad")
    assert bad["ok"] is False and "no such DEM" in bad["error"]
    # Everything after it ran as if it had not been there.
    assert [j["ok"] for j in result["jobs"] if j["id"] != "creeks-bad"] == [True] * 7
    assert (out / "batchbana.svg").is_file()


def test_a_job_with_a_bad_argument_fails_alone(course, tmp_path):
    """Argparse exits 2 on an unknown flag; that is the job's error, not the
    batch's, and its usage goes into its own report."""
    out = tmp_path / "out"
    jobs = [{"id": "oops", "command": "svg", "args": ["--square-3006", SQUARE, "--course", COURSE,
                                                      "--db", str(course["db"]),
                                                      "--out", str(out / "x.svg"), "--nope"]},
            *_jobs(course, out)[:1]]
    code, result = _run_batch(jobs, tmp_path)

    assert code == 1
    assert result["jobs"][0]["error"] == "exited with code 2"
    assert any("--nope" in line for line in result["jobs"][0]["report"])
    assert result["jobs"][1]["ok"] is True


def test_stop_on_error_reports_the_rest_as_not_run(course, tmp_path):
    out = tmp_path / "out"
    jobs = [*_jobs(course, out)[:1], _failing(course, out), *_jobs(course, out)[5:]]
    code, result = _run_batch(jobs, tmp_path, stopOnError=True)

    assert code == 1
    assert [j["ok"] for j in result["jobs"]] == [True, False, False, False]
    assert result["jobs"][2]["error"] == "not run (creeks-bad failed, stopOnError)"
    assert result["jobs"][2]["report"] == [] and result["jobs"][2]["seconds"] == 0.0
    assert not (out / "batchbana.svg").exists()


def test_the_flag_stops_the_batch_too(course, tmp_path):
    out = tmp_path / "out"
    jobs = [_failing(course, out), *_jobs(course, out)[:1]]
    jobs_file = tmp_path / "jobs.json"
    jobs_file.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")
    result = tmp_path / "r.json"
    code = gspro.main(["batch", "--jobs", str(jobs_file), "--result", str(result),
                       "--stop-on-error"])
    assert code == 1
    assert [j["ok"] for j in json.loads(result.read_text())["jobs"]] == [False, False]


# --- The job list -----------------------------------------------------------

def test_the_jobs_can_come_from_stdin(course, tmp_path, monkeypatch):
    jobs = _jobs(course, tmp_path / "out")[:1]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"jobs": jobs})))
    assert gspro.main(["batch"]) == 0
    assert (tmp_path / "out" / DEM_NAME).is_file()


@pytest.mark.parametrize("doc, message", [
    ({}, 'needs a non-empty "jobs" array'),
    ({"jobs": []}, 'needs a non-empty "jobs" array'),
    ({"jobs": [{"args": []}]}, 'job 1 has no "command"'),
    ({"jobs": [{"command": "batch"}]}, "a batch cannot run `batch`"),
    ({"jobs": [{"command": "svg", "args": "x"}]}, '"args" must be a list of strings'),
    ({"jobs": [{"command": "svg", "args": [1]}]}, '"args" must be a list of strings'),
    ({"jobs": [{"id": "a", "command": "svg"}, {"id": "a", "command": "dem"}]},
     "two jobs share the id 'a'"),
])
def test_a_malformed_job_list_is_refused_before_anything_runs(tmp_path, doc, message):
    jobs_file = tmp_path / "jobs.json"
    jobs_file.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(SystemExit, match=message.replace("(", r"\(").replace(")", r"\)")):
        gspro.main(["batch", "--jobs", str(jobs_file)])


def test_a_missing_or_unparsable_job_list_says_so(tmp_path):
    with pytest.raises(SystemExit, match="no such job list"):
        gspro.main(["batch", "--jobs", str(tmp_path / "gone.json")])
    bad = tmp_path / "bad.json"
    bad.write_text("{nope", encoding="utf-8")
    with pytest.raises(SystemExit, match="is not JSON"):
        gspro.main(["batch", "--jobs", str(bad)])
    arr = tmp_path / "arr.json"
    arr.write_text("[]", encoding="utf-8")
    with pytest.raises(SystemExit, match='must be an object with a "jobs" array'):
        gspro.main(["batch", "--jobs", str(arr)])


# --- What is shared ---------------------------------------------------------

def test_the_shared_block_shows_the_dem_and_the_features_reused(course, tmp_path):
    """The saving, counted: the DEM `dem` resampled is read back by `gkd`
    without touching the disk, the course's features are loaded once per
    stack however many jobs want them, and a feature is flattened once per
    tolerance."""
    _, result = _run_batch(_jobs(course, tmp_path / "out"), tmp_path)
    shared = result["shared"]

    # One connection for the one database, reused by every job that reads it.
    assert shared["db"]["misses"] == 1 and shared["db"]["hits"] >= 8
    # Two loads for the whole batch: `svg` wants the opcd stack, the two
    # shaping layers the app one (and share it).
    assert shared["features"]["misses"] == 2 and shared["features"]["hits"] >= 1
    # The DEM the first job wrote, read back by `gkd` from memory.
    assert shared["demBands"]["hits"] == 1
    # One sidecar, parsed once for the four jobs that want it.
    assert shared["sidecars"] == {"hits": 3, "misses": 1}
    assert shared["shapes"]["hits"] > 0
    assert shared["bytes"] > 0


def test_the_cache_is_gone_when_the_batch_ends(course, tmp_path):
    """A one-shot CLI run shares nothing — the cache exists only inside a
    batch, and a batch that throws still clears it."""
    assert gspro._BATCH is None
    _run_batch(_jobs(course, tmp_path / "out")[:1], tmp_path)
    assert gspro._BATCH is None
    jobs = tmp_path / "bad.json"
    jobs.write_text(json.dumps({"jobs": [{}]}), encoding="utf-8")
    with pytest.raises(SystemExit):
        gspro.main(["batch", "--jobs", str(jobs)])
    assert gspro._BATCH is None


@pytest.fixture
def batch_cache():
    """A cache as a batch has one, for the invalidation tests."""
    gspro._BATCH = gspro._BatchCache()
    try:
        yield gspro._BATCH
    finally:
        gspro._BATCH.close()
        gspro._BATCH = None


def test_an_edited_feature_is_flattened_again(batch_cache):
    """The shape cache is keyed on the feature's geometry, not only its id:
    the same id with another outline is another shape."""
    row = {"id": "f1", "geometry_json": json.dumps(
        {"crs": "EPSG:3006", "curveType": "bezier", "rings": [_rect(0, 0, 10, 10)]})}
    first = gspro._row_shape(row, 0.1)
    assert gspro._row_shape(row, 0.1) is first              # one flatten, two askers
    assert gspro._row_shape(row, 0.5) is not first          # another tolerance, another shape
    edited = {"id": "f1", "geometry_json": json.dumps(
        {"crs": "EPSG:3006", "curveType": "bezier", "rings": [_rect(0, 0, 20, 20)]})}
    assert gspro._row_shape(edited, 0.1).area == pytest.approx(400.0)
    assert first.area == pytest.approx(100.0)
    assert batch_cache.stats()["shapes"] == {"hits": 1, "misses": 3}


def test_a_rewritten_dem_is_read_again(tmp_path, batch_cache):
    """Everything keyed on a file carries its mtime and size, so the job that
    rewrites a DEM invalidates the readers of the old one."""
    dem = _make_dem(tmp_path / "dem.tif")
    first = gspro._read_dem_band(dem)
    assert gspro._read_dem_band(dem) is first
    with rasterio.open(dem, "r+") as ds:
        ds.write(np.full((int(SIDE / DEM_RES), int(SIDE / DEM_RES)), 42.0, dtype="float32"), 1)
    again = gspro._read_dem_band(dem)
    assert again is not first and float(again.values.max()) == 42.0
    assert batch_cache.stats()["demBands"] == {"hits": 1, "misses": 2}


def test_a_value_the_cache_will_not_keep_is_never_copied(batch_cache, monkeypatch):
    """The budget is decided before the copy. A window over its slot's limit
    (the real one: an 8192² ortho window at 200 MB against `demWindows`' 96 MB)
    would otherwise be duplicated only to be dropped, doubling peak memory for
    nothing. The caller gets the value as it was built; only a value the cache
    keeps is copied."""
    monkeypatch.setitem(gspro.BATCH_VALUE_MAX_BYTES, "demWindows", 1 << 10)
    copies = []

    def copy(value):
        copies.append(value)
        return value.copy()

    big = np.zeros(1 << 8, dtype="float64")                      # 2 KB, over the 1 KB limit
    assert batch_cache.cached("demWindows", "big", lambda: big,
                              sizeof=lambda a: a.nbytes, copy=copy) is big
    assert copies == [] and batch_cache.slots["demWindows"] == {} and batch_cache.bytes == 0

    small = np.zeros(1 << 6, dtype="float64")                    # 512 B, kept
    assert batch_cache.cached("demWindows", "small", lambda: small,
                              sizeof=lambda a: a.nbytes, copy=copy) is small
    assert copies == [small] and batch_cache.bytes == small.nbytes
    # What is held is the copy, so the caller writing into its array cannot
    # change what the next job is served.
    assert batch_cache.cached("demWindows", "small", lambda: None) is not small
    assert batch_cache.stats()["demWindows"] == {"hits": 1, "misses": 2}


def test_a_shared_connection_survives_a_commands_close(tmp_path, batch_cache):
    """Every command closes the database it opened; inside a batch that must
    not take the shared connection down with it."""
    db = _make_db(tmp_path / "app.sqlite")
    conn = gspro._open_course_db(db)
    conn.close()
    assert gspro._open_course_db(db) is conn
    assert conn.execute("SELECT count(*) FROM course_features").fetchone()[0] == len(FEATURES)
    batch_cache.close()
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


# --- A job's stdout ---------------------------------------------------------

def test_a_jobs_stdout_answers_the_questions_a_stream_is_asked(tmp_path):
    """`_JobOut` stands in for `sys.stdout` inside a job, so it has to answer
    like a stream and not like a bare `TextIOBase` (encoding None, `fileno()`
    raising): an encoding and errors — the real stream's, utf-8/strict when it
    has none — not a tty, and the real stream's descriptor."""
    out = gspro._JobOut("job", io.StringIO())
    assert out.encoding == "utf-8" and out.errors == "strict"
    assert out.isatty() is False and out.writable() is True
    with pytest.raises(io.UnsupportedOperation):
        out.fileno()                      # a StringIO has none, and says so

    with open(tmp_path / "log.txt", "w", encoding="utf-8") as log:
        through = gspro._JobOut("job", log)
        assert through.encoding == "utf-8" and through.errors == "strict"
        assert through.fileno() == log.fileno()


def test_a_job_that_reads_sys_stdout_encoding_runs(tmp_path, monkeypatch):
    """A library that asks `sys.stdout` about itself before printing (rich,
    tqdm, click ... all do) must not fail inside a batch job. The job here is
    that library: it reads the encoding, the errors, whether it is a tty and
    the descriptor, then prints — and its line is still captured and prefixed."""
    seen: dict = {}

    def library_job(argv):
        seen["argv"] = argv
        seen["encoding"] = sys.stdout.encoding
        seen["errors"] = sys.stdout.errors
        seen["isatty"] = sys.stdout.isatty()
        seen["fileno"] = sys.stdout.fileno()
        seen["stderrEncoding"] = sys.stderr.encoding
        print("a line through the library's stdout")
        return 0

    monkeypatch.setattr(gspro, "main", library_job)
    result = tmp_path / "r.json"
    with open(tmp_path / "batch.log", "w", encoding="utf-8") as log:
        monkeypatch.setattr(sys, "stdout", log)
        code = gspro.cmd_batch({"jobs": [{"id": "lib", "command": "svg", "args": ["--square-3006", SQUARE]}]},
                               result)
        descriptor = log.fileno()

    assert code == 0
    assert seen["argv"] == ["svg", "--square-3006", SQUARE]
    assert codecs.lookup(seen["encoding"]) and codecs.lookup(seen["stderrEncoding"])
    assert seen["errors"] and seen["isatty"] is False and seen["fileno"] == descriptor
    job = json.loads(result.read_text(encoding="utf-8"))["jobs"][0]
    assert job["ok"] and job["report"] == ["a line through the library's stdout"]
    assert "[lib] a line through the library's stdout" in (tmp_path / "batch.log").read_text(encoding="utf-8")
