"""creeks.py: the line down a creek polygon and the monotone water surface.

Synthetic geometry and rasters only (TESTING.md): a buffered line whose
centre we know, a DEM with a creek channel falling one way under noisy banks.
"""

from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import from_origin
from shapely.geometry import LineString

from golfpipe.creeks import ribbon_centerline, surface_profile

X0, Y0, RES = 533000.0, 6475000.0, 0.5


def test_ribbon_centerline_recovers_the_line_and_width_of_a_buffered_creek():
    true_line = LineString([(0, 0), (40, 0), (60, 20), (60, 50)])
    ribbon = true_line.buffer(1.5, cap_style="flat")
    line, width = ribbon_centerline(ribbon)
    assert width == pytest.approx(3.0, rel=0.15)
    # Every point of the found line is on the creek's axis, within 0.5 m ...
    assert max(true_line.distance(LineString([p, p])) for p in line.coords) < 0.5
    # ... and it runs (nearly) end to end.
    assert line.length == pytest.approx(true_line.length, rel=0.05)


def test_ribbon_centerline_none_for_degenerate_polygons():
    assert ribbon_centerline(LineString([(0, 0), (1, 0)]).buffer(0)) is None


def creek_dem(size=200):
    """A valley falling 2 m west to east with a 1 m-deep channel along row
    100 (y = Y0 - 50.25) and bumps in the channel floor."""
    rows, cols = np.mgrid[0:size, 0:size]
    x = cols * RES
    dem = 20.0 - 2.0 * x / (size * RES)
    channel = np.abs(rows - 100) <= 2
    dem = dem + 1.0 - channel * 1.0
    # Lidar noise in the channel: two bumps (vegetation, a stone).
    dem[98:103, 60:64] += 0.6
    dem[98:103, 140:143] += 0.4
    return dem.astype(np.float32), from_origin(X0, Y0, RES, RES)


def test_surface_profile_takes_the_channel_low_point_and_only_falls():
    dem, transform = creek_dem()
    y = Y0 - 100.25 * RES
    line = np.array([[X0 + 2, y], [X0 + 98, y]])
    prof = surface_profile(dem, transform, line, width_m=3.0)
    assert not prof.reversed
    assert np.all(np.diff(prof.z) <= 1e-9)                   # never climbs
    # The banks (1 m higher) never lift it: the start is the channel floor ...
    assert prof.z[0] == pytest.approx(20.0 - 2.0 * 2 / 100, abs=0.1)
    # ... and the bumps are gone: over the first bump the surface is below the
    # floor just upstream of it, not 0.6 m above.
    i = int(np.argmin(np.abs(prof.x - (X0 + 31))))
    assert prof.z[i] <= prof.z[i - 4] + 1e-9
    assert prof.z[i] < 20.0 - 2.0 * 31 / 100 + 0.05


def test_surface_profile_turns_an_uphill_line_to_run_downstream():
    dem, transform = creek_dem()
    y = Y0 - 100.25 * RES
    prof = surface_profile(dem, transform, np.array([[X0 + 98, y], [X0 + 2, y]]), width_m=3.0)
    assert prof.reversed
    assert prof.x[0] < prof.x[-1]                             # now west (upstream) to east
    assert np.all(np.diff(prof.z) <= 1e-9)


def test_surface_profile_none_for_a_line_off_the_raster():
    dem, transform = creek_dem()
    assert surface_profile(dem, transform, np.array([[X0 - 500, Y0], [X0 - 400, Y0]]), width_m=2.0) is None
