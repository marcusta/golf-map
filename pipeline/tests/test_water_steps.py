"""golfpipe.water_steps: a run of water's steps (weirs, sills, a dam with a pipe) found on the lidar."""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import Polygon

from golfpipe.water_steps import adjust_steps, find_steps, water_steps

E0, N0 = 500000.0, 6500000.0
RES = 0.5


def surface(x: np.ndarray) -> np.ndarray:
    """The water along the channel: a pond at 10.0 to x=40, a weir down to a pond at 9.0 to x=80, a weir down to a
    creek falling 8.0 -> 7.0 to x=120."""
    return np.where(x < 40, 10.0, np.where(x < 80, 9.0, 8.0 - (x - 80) / 40.0))


def write_dem(path, second_pond: bool = False):
    w, h = 160.0, 60.0
    nx, ny = int(w / RES), int(h / RES)
    xs = (np.arange(nx) + 0.5) * RES - 20.0           # channel x from -20 to 140
    ys = N0 + 30 - (np.arange(ny) + 0.5) * RES
    X, Y = np.meshgrid(xs, ys)
    water = surface(np.clip(X, 0, 120))
    z = water + 2.0                                     # banks 2 m above the water
    inside = (abs(Y - N0) <= 3.0) & (X >= 0) & (X <= 120)
    z = np.where(inside, water, z)
    if second_pond:                                     # a pond at 6.0 beyond a 5 m dam past the creek's end
        z = np.where((abs(Y - N0) <= 6.0) & (X >= 125) & (X <= 138), 6.0, z)
    with rasterio.open(path, "w", driver="GTiff", width=nx, height=ny, count=1, dtype="float32", crs="EPSG:3006",
                       transform=from_origin(E0 - 20.0, N0 + 30, RES, RES), nodata=-9999) as dst:
        dst.write(z.astype(np.float32), 1)


def channel(x0=0.0, x1=120.0, half=3.0):
    return [[E0 + x0, N0 - half], [E0 + x1, N0 - half], [E0 + x1, N0 + half], [E0 + x0, N0 + half]]


def test_find_steps_on_a_profile():
    s = np.arange(0.0, 121.0, 1.0)
    steps = find_steps(s, surface(s), 0.3)
    assert [round(st["s"]) for st in steps] == [pytest.approx(39, abs=1), pytest.approx(79, abs=1)]
    assert steps[0]["dropM"] == pytest.approx(1.0, abs=0.05)
    assert steps[1]["topM"] == pytest.approx(9.0, abs=0.05)


def test_a_gentle_creek_has_no_step():
    s = np.arange(0.0, 100.0, 1.0)
    assert find_steps(s, 10.0 - s * 0.015, 0.3) == []


def test_asked_cut_and_skip():
    s = np.arange(0.0, 121.0, 1.0)
    z = surface(s)
    found = find_steps(s, z, 0.3)
    out = adjust_steps(found, s, z, cuts=[20.0], skips=[40.0])
    assert [round(st["s"]) for st in out] == [20, pytest.approx(79, abs=1)]
    assert out[0]["forced"] and out[0]["dropM"] == pytest.approx(0.0, abs=0.05)


def test_ponds_creek_and_sills(tmp_path):
    dem = tmp_path / "dem.tif"
    write_dem(dem)
    r = water_steps(str(dem), [{"id": "a", "shape": "hole_3_1", "type": "water_creek", "ring": channel()}])
    kinds = [(p["kind"], p["levelM"]) for p in r["pieces"]]
    assert kinds == [("pond", pytest.approx(10.0, abs=0.05)), ("pond", pytest.approx(9.0, abs=0.05)), ("creek", None)]
    creek = r["pieces"][2]
    assert creek["topM"] == pytest.approx(8.0, abs=0.15) and creek["bottomM"] == pytest.approx(7.0, abs=0.15)
    falls = r["falls"]
    assert [f["style"] for f in falls] == ["sill", "sill"]
    assert falls[0]["dropM"] == pytest.approx(1.0, abs=0.1)
    assert falls[0]["flow"][0] == pytest.approx(1.0, abs=0.05)        # downstream = +x
    # The lip runs across the channel at the downstream edge of the sill, and the sill is left out between the ponds.
    xs = [p[0] - E0 for p in falls[0]["line"]]
    assert all(39.0 <= x <= 41.5 for x in xs)
    up, down = Polygon(r["pieces"][0]["ring"]), Polygon(r["pieces"][1]["ring"])
    assert up.distance(down) == pytest.approx(1.0, abs=0.1)
    assert r["pieces"][0]["digLevelOffsetM"] == pytest.approx(0.0, abs=0.1)


def test_a_body_drawn_the_other_way_runs_downstream(tmp_path):
    dem = tmp_path / "dem.tif"
    write_dem(dem)
    r = water_steps(str(dem), [{"id": "a", "type": "water_creek", "ring": channel()[::-1]}])
    assert [p["kind"] for p in r["pieces"]][:2] == ["pond", "pond"]
    assert r["pieces"][0]["levelM"] == pytest.approx(10.0, abs=0.05)


def test_outlet_between_bodies(tmp_path):
    dem = tmp_path / "dem.tif"
    write_dem(dem, second_pond=True)
    r = water_steps(str(dem), [
        {"id": "a", "type": "water_creek", "ring": channel()},
        {"id": "b", "type": "water", "ring": channel(126.0, 137.0, 5.0)},
    ])
    outlets = [f for f in r["falls"] if f["style"] == "outlet"]
    assert len(outlets) == 1
    o = outlets[0]
    assert (o["fromBodyId"], o["toBodyId"]) == ("a", "b")
    assert o["bottomM"] == pytest.approx(6.0, abs=0.05)
    assert o["at"][0] - E0 == pytest.approx(126.0, abs=0.5)


def _flat_dem(path, cells):
    """A DEM at 12 m everywhere, `cells` a list of (x0, x1, y0, y1, z) boxes (metres from E0, N0) set to z."""
    w, h = 160.0, 60.0
    nx, ny = int(w / RES), int(h / RES)
    xs = (np.arange(nx) + 0.5) * RES - 20.0
    ys = N0 + 30 - (np.arange(ny) + 0.5) * RES
    X, Y = np.meshgrid(xs, ys)
    z = np.full(X.shape, 12.0)
    for x0, x1, y0, y1, v in cells:
        z = np.where((X >= x0) & (X <= x1) & (Y - N0 >= y0) & (Y - N0 <= y1), v, z)
    with rasterio.open(path, "w", driver="GTiff", width=nx, height=ny, count=1, dtype="float32", crs="EPSG:3006",
                       transform=from_origin(E0 - 20.0, N0 + 30, RES, RES), nodata=-9999) as dst:
        dst.write(z.astype(np.float32), 1)


def box(x0, x1, y0, y1):
    return [[E0 + x0, N0 + y0], [E0 + x1, N0 + y0], [E0 + x1, N0 + y1], [E0 + x0, N0 + y1]]


def test_waters_too_far_apart_for_a_spout_get_a_cascade_along_the_low_ground(tmp_path):
    # Pond A at 10 m, pond B at 8 m, 25 m apart; a runnel between them falling from 9.9 to 8.1 m.
    dem = tmp_path / "dem.tif"
    _flat_dem(dem, [(0, 20, -6, 6, 10.0), (45, 65, -6, 6, 8.0)]
              + [(20 + k, 21 + k, -1, 1, 9.9 - 1.8 * k / 25) for k in range(25)])
    r = water_steps(str(dem), [{"id": "a", "type": "water", "ring": box(0, 20, -6, 6)},
                               {"id": "b", "type": "water", "ring": box(45, 65, -6, 6)}])
    [f] = r["falls"]
    assert f["style"] == "cascade" and (f["fromBodyId"], f["toBodyId"]) == ("a", "b")
    assert f["dropM"] == pytest.approx(2.0, abs=0.05) and f["gapM"] == pytest.approx(25.0, abs=0.5)
    assert len(f["line"]) >= 2
    assert all(abs(y - N0) <= 2.0 for _, y in f["line"])                 # down the runnel, not across the grass


def test_a_sliver_at_a_bodys_start_is_the_end_of_the_water_feeding_it(tmp_path):
    # Pond A at 10 m; 3 m on, body B starts with a 2 m channel (under a bridge, the lidar reads 9.6) that steps down
    # to B's pond at 8 m. One fall, from A's water to B's pond, at the step; the channel joins B's pond.
    dem = tmp_path / "dem.tif"
    _flat_dem(dem, [(0, 20, -6, 6, 10.0), (23, 26, -3, 3, 9.6), (26, 60, -3, 3, 8.0)])
    r = water_steps(str(dem), [{"id": "a", "type": "water", "ring": box(0, 20, -6, 6)},
                               {"id": "b", "type": "water", "ring": box(23, 60, -3, 3)}])
    assert [f["style"] for f in r["falls"]] == ["sill"]
    [f] = r["falls"]
    assert (f["fromBodyId"], f["toBodyId"], f["merged"]) == ("a", "b", True)
    assert f["topM"] == pytest.approx(10.0, abs=0.05) and f["bottomM"] == pytest.approx(8.0, abs=0.05)
    assert [p["bodyId"] for p in r["pieces"]].count("b") == 1
