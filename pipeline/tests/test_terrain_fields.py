"""terrain_fields — slope, terrain position and wetness from a DEM
(pipeline/terrain_fields.py). Synthetic ground: tilted planes, a mound, a
valley, a closed pit."""

import math

import numpy as np

import terrain_fields as tf

CELL = 2.0
N = 80                              # 160 m


def xy():
    y, x = np.mgrid[0:N, 0:N]
    return x * CELL, y * CELL


def test_slope_of_a_tilted_plane():
    x, _ = xy()
    f = tf.terrain_fields(x * math.tan(math.radians(10)), CELL, tpi_radius=20)
    assert abs(float(f.slope[N // 2, N // 2]) - 10) < 0.2
    assert abs(float(f.tpi[N // 2, N // 2])) < 0.05          # a plane is neither knoll nor hollow


def test_a_mound_is_a_knoll_and_dry_and_a_valley_floor_is_a_hollow_and_wet():
    x, y = xy()
    mound = 4.0 * np.exp(-((x - 80) ** 2 + (y - 80) ** 2) / (2 * 15 ** 2))
    f = tf.terrain_fields(mound + 0.01 * y, CELL, tpi_radius=30)
    assert f.tpi[40, 40] > 1.0
    assert f.twi[40, 40] < np.percentile(f.twi, 10)

    valley = 0.08 * np.abs(x - 80) + 0.01 * (160 - y)            # a V down the middle, falling south
    f = tf.terrain_fields(valley, CELL, tpi_radius=30)
    assert f.tpi[40, 40] < -0.5
    assert f.twi[60, 40] > np.percentile(f.twi, 95)
    assert f.twi[60, 40] > f.twi[60, 10] + 3                     # the floor against the valley side


def test_a_closed_pit_is_filled_to_its_rim_and_water_runs_on_past_it():
    x, y = xy()
    z = 0.02 * (160 - y)                                         # falls south
    z[30:36, 38:44] -= 1.0                                       # a pit on the way down
    filled = tf.fill_depressions(z)
    assert (filled >= z).all()
    assert abs(float(filled[33, 41]) - float(z[36, 41])) < 0.01  # up to the downhill rim
    assert (filled[:20] == z[:20]).all()                         # ground that drained already is untouched
    acc = tf.flow_accumulation(filled)
    assert acc.min() >= 1.0
    assert acc[N - 1].sum() >= 0.95 * N * N                      # everything reaches the low edge


def test_fields_come_back_on_the_dem_grid():
    x, y = xy()
    z = np.repeat(np.repeat(0.05 * x + 0.02 * y, 4, axis=0), 4, axis=1)[:317, :309]   # 0.5 m cells, odd shape
    f = tf.terrain_fields(z, 0.5)
    assert f.slope.shape == f.tpi.shape == f.twi.shape == z.shape
    assert np.isfinite(f.twi).all()
