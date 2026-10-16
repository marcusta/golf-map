"""apply-dem-edits `shore`: a lake bed dug below the lake's surface.

Offline, synthetic rasters only. The lake polygons reach far past the grid
like the real one does (Vättern's outline is clipped hundreds of metres
outside the terrain square), so the grid's own edge never passes for a shore.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from rasterio.crs import CRS
from rasterio.transform import from_origin

from golfpipe.dem_edit import DemEdit, apply_edits, load_edits, reproject_edits, shore_drop

ORIGIN_X = 533000.0
ORIGIN_Y = 6475000.0
SIZE = 120
NODATA = -9999.0
TRANSFORM = from_origin(ORIGIN_X, ORIGIN_Y, 1.0, 1.0)
LEVEL = 88.76
FAR = 3000.0  # well past the grid in every direction


def ring(e0: float, e1: float, s0: float, s1: float) -> list[list[float]]:
    """Closed EPSG:3006 ring for the box e0..e1 metres east of the grid's
    west edge and s0..s1 metres south of its north edge (may run past it)."""
    x0, x1 = ORIGIN_X + e0, ORIGIN_X + e1
    y0, y1 = ORIGIN_Y - s1, ORIGIN_Y - s0
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def shore_edit(*polygons: list[list[list[float]]], **kwargs) -> DemEdit:
    """A shore edit over one or more polygons (each a list of rings, the
    first the outline, the rest holes)."""
    geometry = ({"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1
                else {"type": "MultiPolygon", "coordinates": list(polygons)})
    return DemEdit(op="shore", geometry=geometry, level_m=LEVEL, depth_m=8.0, **kwargs)


def lake_dem(land: float = 90.0) -> np.ndarray:
    """The lidar's view: the lake a flat sheet at LEVEL, land above it."""
    return np.full((SIZE, SIZE), land, dtype=np.float32)


def apply(dem: np.ndarray, edit: DemEdit) -> np.ndarray:
    logged: list[str] = []
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=logged.append)
    assert logged == []
    return out


# --- the profile -------------------------------------------------------------


def test_shore_drop_follows_the_beach_the_shelf_and_the_slope_and_rounds_into_the_floor():
    d = np.array([0.0, 2.0, 4.0, 100.0, 105.0, 150.0])
    assert shore_drop(d) == pytest.approx([0.0, 0.30, 0.47, 2.39, 2.565, 2.565 + 0.05 * 45], abs=1e-3)
    # The straight 5 % line would hit 8 m at ~213.7 m; the knee is centred
    # there, so the floor is reached ~2.5 m later and not before.
    assert shore_drop(np.array([213.7]))[0] == pytest.approx(8.0 - 0.05 * 2.5 / 4, abs=0.01)
    assert shore_drop(np.array([215.0]))[0] < 8.0
    assert shore_drop(np.array([216.3, 300.0, 5000.0])) == pytest.approx([8.0, 8.0, 8.0], abs=1e-9)


@pytest.mark.parametrize("params", [
    {},
    {"depth_m": 1.5},                       # floor reached on the shelf
    {"depth_m": 0.1, "floor_round_m": 5.0}, # shallower than one knee
    {"edge_ease_m": 0.0, "shelf_ease_m": 0.0, "floor_round_m": 0.0},
    {"slope": 0.2, "depth_m": 20.0, "shelf_end_m": 30.0},
])
def test_shore_drop_never_passes_the_floor_and_only_goes_deeper(params):
    d = np.linspace(0.0, 600.0, 120001)
    drop = shore_drop(d, **params)
    depth = params.get("depth_m", 8.0)
    assert drop[0] == 0.0
    assert drop.max() <= depth + 1e-12
    assert drop[-1] == pytest.approx(depth, abs=1e-9)
    assert np.all(np.diff(drop) >= 0.0)
    # Without hard corners asked for, the slope has no jumps: the bed meets the floor tangentially.
    if params.get("floor_round_m", 5.0) > 0 and params.get("edge_ease_m", 2.0) > 0:
        slope = np.diff(drop) / np.diff(d)
        assert np.abs(np.diff(slope)).max() < 1e-3


def test_shore_drop_rejects_unknown_parameters():
    with pytest.raises(TypeError):
        shore_drop(np.array([1.0]), levelM=88.0)


# --- on a DEM ----------------------------------------------------------------


def test_a_straight_shore_gives_the_profile_across_it_and_leaves_the_land_alone():
    dem = lake_dem()
    dem[:, 50:] = LEVEL
    # Water east of 50 m, past the grid to the north, east and south.
    out = apply(dem, shore_edit([ring(50.0, FAR, -FAR, FAR)], feather_m=3.0))   # featherM is ignored

    assert np.array_equal(out[:, :50], dem[:, :50])                            # land bit-identical
    d = np.arange(50, SIZE) - 50 + 0.5
    expected = (LEVEL - shore_drop(d)).astype(np.float32)
    for row in (0, 60, SIZE - 1):     # the grid's north and south edges are not shores either
        assert out[row, 50:] == pytest.approx(expected, abs=1e-4)


def test_an_island_stays_untouched_and_the_bed_rises_towards_it():
    dem = np.full((SIZE, SIZE), LEVEL, dtype=np.float32)
    dem[55:65, 55:65] = 91.0
    island = ring(55.0, 65.0, 55.0, 65.0)[::-1]
    out = apply(dem, shore_edit([ring(-FAR, FAR, -FAR, FAR), island], cliff_depth_m=0.0))   # a low island, no cliff rule

    assert np.array_equal(out[55:65, 55:65], dem[55:65, 55:65])
    # East of the island the bed falls away from it along the profile.
    east = LEVEL - out[60, 65:].astype(np.float64)
    assert east == pytest.approx(shore_drop(np.arange(65, SIZE) - 65 + 0.5), abs=1e-4)
    assert np.all(np.diff(east) > 0)
    # Nothing else in the grid is shore: far corners are on the shelf, not on the beach.
    assert LEVEL - out[0, 0] == pytest.approx(shore_drop(np.array([np.hypot(55.0, 55.0)]))[0], abs=0.05)


def test_a_narrow_sound_gets_its_channel_and_steeper_banks_than_wide_water():
    dem = lake_dem()
    sound = ring(-FAR, FAR, 30.0, 42.0)          # 12 m wide, east-west through the grid
    lake = ring(-FAR, FAR, 80.0, FAR)            # wide water from 80 m south
    dem[30:42] = LEVEL
    dem[80:] = LEVEL
    out = apply(dem, shore_edit([sound], [lake]))

    drop = LEVEL - out.astype(np.float64)
    col = 60
    assert drop[35, col] == pytest.approx(1.0, abs=0.01)       # the middle reaches channelDepthM
    assert drop[36, col] == pytest.approx(1.0, abs=0.01)
    assert np.allclose(drop[30:42, col], drop[30:42, col][::-1], atol=1e-6)   # symmetric across
    assert np.allclose(drop[30:42], drop[30:42, :1], atol=1e-6)               # the same all along it
    # The same distance from the shore in wide water is shallower: the sound's banks are steeper.
    for k in (0, 1, 2, 3):
        assert drop[30 + k, col] > drop[80 + k, col] + 0.05
    # Wide water follows the profile.
    assert drop[80:, col] == pytest.approx(shore_drop(np.arange(80, SIZE) - 80 + 0.5), abs=1e-4)
    assert np.array_equal(out[42:80], dem[42:80])


def test_land_just_past_the_grid_edge_is_the_shore():
    dem = np.full((SIZE, SIZE), LEVEL, dtype=np.float32)
    # The shore runs 2 m west of the grid; the first column's centres are 2.5 m from it.
    out = apply(dem, shore_edit([ring(-2.0, FAR, -FAR, FAR)]))
    drop = LEVEL - out.astype(np.float64)
    assert drop[:, 0] == pytest.approx(np.full(SIZE, shore_drop(np.array([2.5]))[0]), abs=1e-4)
    assert drop[60, 0] < 0.5                                   # a beach, not the deep floor
    assert drop[60, :] == pytest.approx(shore_drop(np.arange(SIZE) + 2.5), abs=1e-4)


def test_ground_above_the_lake_inside_the_polygon_comes_down_and_deeper_ground_stays():
    dem = lake_dem()
    dem[:, 50:] = LEVEL
    dem[60, 70] = LEVEL + 1.2        # a fill (or a boat) inside the outline
    dem[60, 90] = LEVEL - 20.0       # already deeper than the bed
    dem[61, 80] = NODATA
    out = apply(dem, shore_edit([ring(50.0, FAR, -FAR, FAR)]))
    assert out[60, 70] == pytest.approx(LEVEL - shore_drop(np.array([20.5]))[0], abs=1e-4)
    assert out[60, 90] == dem[60, 90]                         # digs, never fills
    assert out[61, 80] == NODATA


def test_load_edits_reads_a_shore_and_skips_bad_ones(tmp_path: Path):
    from rasterio.warp import transform as warp_transform

    def feature(**props):
        r = ring(50.0, 500.0, -500.0, 500.0)
        xs, ys = warp_transform(CRS.from_epsg(3006), CRS.from_epsg(4326), [p[0] for p in r], [p[1] for p in r])
        return {"type": "Feature", "properties": {"op": "shore", **props},
                "geometry": {"type": "Polygon", "coordinates": [[[x, y] for x, y in zip(xs, ys)]]}}

    path = tmp_path / "edits.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [
        feature(levelM=LEVEL, featherM=4, depthM=6, shelfEndM=80, channelDepthM=1.5),
        feature(depthM=6),                                            # no levelM
        feature(levelM=LEVEL, channelFullM=15, channelGoneM=15),      # gone not past full
        feature(levelM=LEVEL, slope="steep"),
    ]}))
    logged: list[str] = []
    edits = load_edits(path, log=logged.append)
    assert len(logged) == 3 and all("skipped" in line for line in logged)
    assert "levelM" in logged[0] and "channelGoneM" in logged[1] and "slope" in logged[2]
    [e] = edits
    assert (e.op, e.level_m, e.feather_m, e.depth_m, e.shelf_end_m, e.channel_depth_m) == \
        ("shore", LEVEL, 0.0, 6.0, 80.0, 1.5)
    assert (e.edge_slope, e.edge_m, e.slope, e.floor_round_m, e.channel_gone_m) == (0.15, 2.0, 0.05, 5.0, 15.0)

    # The file's edit, reprojected, digs the same bed as one built here.
    dem = lake_dem()
    dem[:, 50:] = LEVEL
    [projected] = reproject_edits(edits, CRS.from_epsg(3006))
    out = apply_edits(dem, TRANSFORM, NODATA, [projected], log=lambda *_: None)
    assert out[60, 70] == pytest.approx(
        LEVEL - shore_drop(np.array([20.5]), depth_m=6.0, shelf_end_m=80.0)[0], abs=0.02)
    assert np.array_equal(out[:, :49], dem[:, :49])


def test_under_a_cliff_the_rock_goes_on_down_and_a_low_shore_keeps_the_shelf():
    from golfpipe.dem_edit import shore_cliffness
    dem = lake_dem(LEVEL + 1.0)                  # a low shore to the north ...
    dem[:, 60:] = LEVEL + 13.0                   # ... and a 13 m cliff on the east half
    dem[60:] = LEVEL                             # the lake: south of row 60
    lake = ring(-FAR, FAR, 60.0, FAR)             # the lake: 60 m south of the north edge and on (rows 60..)
    edit = shore_edit([lake], cliff_smooth_m=0.0)
    out = apply(dem, edit)
    under_cliff = LEVEL - out[60:, 90].astype(np.float64)   # south from the cliff foot, x far from the corner
    under_low = LEVEL - out[60:, 10].astype(np.float64)
    d = np.arange(60, SIZE) - 60 + 0.5
    # The low shore follows the profile; under the cliff the bed falls at cliffSlope to cliffDepthM.
    assert under_low == pytest.approx(shore_drop(d), abs=1e-4)
    assert under_cliff[0] == pytest.approx(min(6.0, 1.5 * d[0]), abs=1e-3)
    assert under_cliff[3] == pytest.approx(min(6.0, 1.5 * d[3]), abs=1e-3)      # 3.5 m out: 5.25 m deep
    assert under_cliff[10] == pytest.approx(6.0, abs=1e-3)
    assert np.all(under_cliff >= under_low - 1e-9)
    # The cliffness itself: 1 off the cliff, 0 off the low shore.
    water = np.zeros(dem.shape, bool); water[60:] = True
    c = shore_cliffness(water, np.where(water, np.nan, dem), LEVEL, 1.0, 4.0, 1.5, 3.5, 0.0)
    assert c[61, 90] == 1.0 and c[61, 10] == 0.0


def test_cliff_depth_zero_turns_the_cliff_rule_off():
    dem = lake_dem(LEVEL + 13.0)
    dem[60:] = LEVEL
    lake = ring(-FAR, FAR, 60.0, FAR)
    out = apply(dem, shore_edit([lake], cliff_depth_m=0.0))
    d = np.arange(60, SIZE) - 60 + 0.5
    assert (LEVEL - out[60:, 50].astype(np.float64)) == pytest.approx(shore_drop(d), abs=1e-4)
