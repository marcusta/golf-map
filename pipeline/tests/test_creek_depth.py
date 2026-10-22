"""golfpipe.creek_depth: a creek's depth as the course meshes will have it.

Synthetic flat ground with channels of known width and depth on a 0.5 m DEM, a heightmap frame like the inner
export's, and the module's model of terrain.obj (every second sample, OPCD's smooth) and of the conformed meshes.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
from rasterio.transform import from_origin

from golfpipe import creek_depth as cd

E0, N0, SIDE, RES = 529000.0, 6486000.0, 200.0, 0.5
GROUND = 20.0


def _frame():
    # 401 samples a side over 200 m: .raw pixels ~0.5 m, terrain.obj nodes 1 m apart (every second sample).
    return cd.HeightmapFrame.from_sidecar({"square3006": [E0, N0, E0 + SIDE, N0 + SIDE], "raw": {"size": 401}})


def _dem(channels):
    """Flat ground at GROUND; each channel (y centre, width, depth) dug along x as the dig does it: flat floor,
    60 degree walls inside the outline, the outline at ground level."""
    n = int(SIDE / RES)
    rows, cols = np.mgrid[0:n, 0:n]
    y = SIDE - (rows + 0.5) * RES
    dem = np.full((n, n), GROUND)
    for yc, width, depth in channels:
        d_in = width / 2.0 - np.abs(y - yc)          # metres in from the outline
        dig = np.clip(d_in * np.tan(np.radians(60.0)), 0.0, depth)
        dem = dem - np.where(d_in > 0, dig, 0.0)
    return dem, from_origin(E0, N0 + SIDE, RES, RES)


def _line(yc):
    return [[E0 + 50.0, N0 + yc], [E0 + 150.0, N0 + yc]]


def _surfaces(dem, transform):
    terrain = cd.terrain_surface(dem, transform, _frame(), (E0 + 40, N0 + 10, E0 + 160, N0 + 190))
    return terrain, cd.MeshSurface(terrain)


def test_smooth_and_plane_height_match_terrain_obj():
    path = Path(__file__).resolve().parents[2] / "blender" / "tools" / "terrain_obj.py"
    spec = importlib.util.spec_from_file_location("terrain_obj_for_test", path)
    terrain_obj = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(terrain_obj)
    rng = np.random.default_rng(7)
    g = rng.normal(0.0, 1.0, (9, 11))
    assert np.array_equal(cd.smooth_grid(g, 1.5), terrain_obj.smooth_grid(g, 1.5))
    u, v = np.arange(11.0), np.arange(9.0) * 1.3
    qu, qv = rng.uniform(0, 10, 50), rng.uniform(0, 10.4, 50)
    assert np.array_equal(cd.plane_height(u, v, g, qu, qv)[0], terrain_obj.plane_height(u, v, g, qu, qv)[0])


def test_terrain_nodes_follow_the_heightmap_frame():
    frame = _frame()
    assert frame.grid == 201 and abs(frame.spacing - 1.0) < 1e-12
    dem, transform = _dem([])
    terrain = cd.terrain_surface(dem, transform, frame, (E0 + 10, N0 + 10, E0 + 20, N0 + 20))
    assert terrain.u[0] == E0 + 7 and terrain.v[0] == N0 + 7          # 3 nodes of margin
    assert np.allclose(terrain.g, GROUND)                             # flat ground stays flat through the smooth


def test_a_wide_channel_keeps_its_depth_in_the_meshes():
    dem, transform = _dem([(100.0, 4.0, 0.5)])
    terrain, mesh = _surfaces(dem, transform)
    on_dem = cd.creek_sections(_line(100.0), 4.0, lambda x, y: cd.dem_sample(dem, transform, x, y))
    in_mesh = cd.creek_sections(_line(100.0), 4.0, mesh.at)
    assert abs(np.nanmedian(on_dem.depth) - 0.5) < 0.02
    assert np.nanmedian(in_mesh.depth) > 0.35       # most of it: the walls go soft, the floor stays


def test_a_narrow_channel_comes_out_shallow_in_the_meshes():
    """Vreta's maintained drain: 0.35 m dug in a creek about 1 m wide; the meshes keep a fraction of it."""
    dem, transform = _dem([(100.0, 1.0, 0.35)])
    terrain, mesh = _surfaces(dem, transform)
    on_dem = cd.creek_sections(_line(100.0), 1.0, lambda x, y: cd.dem_sample(dem, transform, x, y))
    on_terrain = cd.creek_sections(_line(100.0), 1.0, terrain.at)
    in_mesh = cd.creek_sections(_line(100.0), 1.0, mesh.at)
    dem_d, terrain_d, mesh_d = (float(np.nanmedian(x.depth)) for x in (on_dem, on_terrain, in_mesh))
    assert dem_d > 0.3
    assert terrain_d < dem_d - 0.1                  # the 1 m grid and OPCD's smooth fill it in
    assert mesh_d <= terrain_d + 1e-9 and mesh_d < cd.WATER_ABOVE_BED_M + cd.MIN_FREEBOARD_M
    assert np.all(in_mesh.worst <= in_mesh.depth + 1e-9)
    stretches = cd.shallow_stretches(in_mesh.s, in_mesh.depth, cd.WATER_ABOVE_BED_M + cd.MIN_FREEBOARD_M)
    assert len(stretches) == 1 and stretches[0] == (0, in_mesh.s.size - 1)


def test_undug_ground_has_no_depth():
    dem, transform = _dem([])
    _, mesh = _surfaces(dem, transform)
    sec = cd.creek_sections(_line(100.0), 1.5, mesh.at)
    assert np.allclose(sec.depth, 0.0, atol=1e-9)


def test_shallow_stretches_join_near_ones_and_drop_short_ones():
    s = np.arange(0.0, 20.0, 0.5)
    depth = np.full(s.size, 0.5)
    depth[(s >= 2.0) & (s <= 4.0)] = 0.1        # 2.5 m long
    depth[(s >= 5.0) & (s <= 6.0)] = 0.1        # 1 m on, joined to the first
    depth[(s >= 12.0) & (s <= 12.5)] = 0.1      # 1 m long: dropped
    depth[16.0 == s] = np.nan                   # no ground: shallow, but alone - dropped
    out = cd.shallow_stretches(s, depth, 0.25)
    assert [(s[a], s[b]) for a, b in out] == [(2.0, 6.0)]
    skip = (s >= 2.0) & (s <= 6.0)
    assert cd.shallow_stretches(s, depth, 0.25, skip=skip) == []


def test_mouth_block_sees_a_bank_across_the_mouth():
    """A creek bed at 19.6 m running east into a pond (bed 18.5 m) past a 0.6 m-high bank ridge."""
    def surface(x, y):
        x = np.asarray(x, np.float64)
        return np.where(x < 2.0, 19.6, np.where(x < 3.0, 20.2, 18.5))
    assert abs(cd.mouth_block([0.0, 0.0], [10.0, 0.0], 19.6, surface, 6.0) - 0.6) < 1e-9
    open_mouth = lambda x, y: np.where(np.asarray(x, np.float64) < 2.0, 19.6, 18.5)  # noqa: E731
    assert cd.mouth_block([0.0, 0.0], [10.0, 0.0], 19.6, open_mouth, 6.0) <= 0.0
