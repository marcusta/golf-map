"""apply-dem-edits: plane-fit / median-smooth / feather replay onto a DEM.

Offline, synthetic rasters only. Direct-module tests build DemEdits with
EPSG:3006 geometry (the pure engine); file/CLI tests exercise the full D-TE5
handoff — WGS84 FeatureCollection reprojected via transform_geom.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from golfpipe import dem_edit
from golfpipe.__main__ import main
from golfpipe.commands import cmd_apply_dem_edits
from golfpipe.dem_edit import DemEdit, DemEditError, apply_edits, fit_plane, load_edits

ORIGIN_X = 533000.0  # SWEREF99 TM metres (near Linkoping, like conftest)
ORIGIN_Y = 6475000.0
RES = 1.0
SIZE = 80
NODATA = -9999.0
TRANSFORM = from_origin(ORIGIN_X, ORIGIN_Y, RES, RES)


def cell_coords() -> tuple[np.ndarray, np.ndarray]:
    """(x, y) world coordinates of every cell center, shape (SIZE, SIZE)."""
    rows, cols = np.mgrid[0:SIZE, 0:SIZE]
    x = ORIGIN_X + (cols + 0.5) * RES
    y = ORIGIN_Y - (rows + 0.5) * RES
    return x, y


def rect_3006(col0: int, col1: int, row0: int, row1: int) -> list[list[float]]:
    """Closed ring for a rectangle covering cell centers cols col0..col1-1,
    rows row0..row1-1 (edges on cell boundaries, all_touched=False burns
    exactly those cells)."""
    e0, e1 = ORIGIN_X + col0 * RES, ORIGIN_X + col1 * RES
    n0, n1 = ORIGIN_Y - row1 * RES, ORIGIN_Y - row0 * RES
    return [[e0, n0], [e1, n0], [e1, n1], [e0, n1], [e0, n0]]


def rect_mask(col0: int, col1: int, row0: int, row1: int) -> np.ndarray:
    mask = np.zeros((SIZE, SIZE), dtype=bool)
    mask[row0:row1, col0:col1] = True
    return mask


def edit_3006(op: str, ring: list[list[float]], **kwargs) -> DemEdit:
    return DemEdit(op=op, geometry={"type": "Polygon", "coordinates": [ring]}, **kwargs)


def ring_to_wgs84(ring: list[list[float]]) -> list[list[float]]:
    from rasterio.warp import transform as warp_transform

    xs, ys = warp_transform(
        CRS.from_epsg(3006), CRS.from_epsg(4326),
        [p[0] for p in ring], [p[1] for p in ring],
    )
    return [[x, y] for x, y in zip(xs, ys)]


def wgs84_feature(op: str, ring: list[list[float]], **props) -> dict:
    return {
        "type": "Feature",
        "properties": {"op": op, **props},
        "geometry": {"type": "Polygon", "coordinates": [ring_to_wgs84(ring)]},
    }


def write_edits(tmp_path: Path, features: list[dict], name: str = "edits.geojson") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    return path


def write_dem(tmp_path: Path, heights: np.ndarray, name: str = "dem.tif") -> Path:
    path = tmp_path / name
    profile = {
        "driver": "GTiff",
        "height": heights.shape[0],
        "width": heights.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": CRS.from_epsg(3006),
        "transform": TRANSFORM,
        "nodata": NODATA,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights.astype(np.float32), 1)
    return path


def sloped_dem(a: float = 0.03, b: float = 0.02, c: float = 60.0) -> np.ndarray:
    """z = a·(x − ORIGIN_X) + b·(ORIGIN_Y − y) + c — a plane in world metres."""
    x, y = cell_coords()
    return (a * (x - ORIGIN_X) + b * (ORIGIN_Y - y) + c).astype(np.float32)


# ---------------------------------------------------------------- plane


def test_plane_recovers_slope_despite_noise_and_outliers():
    rng = np.random.default_rng(42)
    truth = sloped_dem().astype(np.float64)
    dem = truth + rng.normal(0.0, 0.02, truth.shape)
    # Cars/bushes: a handful of tall outliers inside the polygon.
    outlier_rows = rng.integers(15, 45, size=10)
    outlier_cols = rng.integers(15, 45, size=10)
    dem[outlier_rows, outlier_cols] += 3.0
    dem = dem.astype(np.float32)

    edit = edit_3006("plane", rect_3006(10, 50, 10, 50), feather_m=0.0)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])

    mask = rect_mask(10, 50, 10, 50)
    # Recovered plane matches the true (outlier-free) plane everywhere in
    # the mask — including where the outliers sat.
    assert np.allclose(out[mask], truth[mask], atol=0.02)
    # Hard edge, so everything outside the mask is bit-identical.
    assert np.array_equal(out[~mask], dem[~mask])


def test_plane_flat_zeroes_the_gradient():
    dem = sloped_dem()
    edit = edit_3006("plane", rect_3006(20, 60, 20, 60), feather_m=0.0, flat=True)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])

    mask = rect_mask(20, 60, 20, 60)
    values = out[mask]
    assert float(values.std()) < 1e-4  # dead flat
    assert abs(float(values.mean()) - float(dem[mask].mean())) < 0.05
    assert np.array_equal(out[~mask], dem[~mask])


def test_fit_plane_rejects_too_few_points_and_rank_deficiency():
    rng = np.random.default_rng(7)
    # Too few samples.
    assert fit_plane([0.0] * 8, [0.0] * 8, [1.0] * 8) is None
    # Collinear cells: x varies, y constant -> rank-deficient normal system.
    x = np.arange(32, dtype=float)
    y = np.zeros(32)
    z = rng.normal(0, 0.1, 32)
    assert fit_plane(x, y, z) is None


def test_degenerate_small_mask_skips_with_warning(capsys):
    dem = sloped_dem()
    edit = edit_3006("plane", rect_3006(10, 13, 10, 13), feather_m=0.0)  # 9 cells < 16
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])
    assert np.array_equal(out, dem)
    assert "skipped" in capsys.readouterr().out


# ---------------------------------------------------------------- smooth


def test_smooth_kills_spike_but_preserves_linear_grade():
    x, _ = cell_coords()
    grade = (0.1 * (x - ORIGIN_X)).astype(np.float64)
    dem = grade.copy()
    dem[30, 30] += 5.0  # single-cell spike
    dem = dem.astype(np.float32)

    edit = edit_3006("smooth", rect_3006(25, 36, 25, 36), feather_m=0.0, radius_m=2.0)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])

    mask = rect_mask(25, 36, 25, 36)
    # Spike is gone: back to roughly the local grade value.
    assert abs(float(out[30, 30]) - grade[30, 30]) < 0.15
    # Linear grade passes through the median untouched (symmetric circular
    # footprint), except right next to the spike where one order statistic
    # may shift by one cell's grade step.
    near_spike = np.zeros_like(mask)
    near_spike[27:34, 27:34] = True
    steady = mask & ~near_spike
    assert np.allclose(out[steady], grade[steady], atol=1e-5)
    # Endpoints of the grade (mask edge cells) are unchanged.
    assert np.allclose(out[25, 25:36], grade[25, 25:36], atol=1e-5)
    assert np.array_equal(out[~mask], dem[~mask])


def test_smooth_radius_converts_to_cells_minimum_one(capsys):
    # A tiny radius still smooths with a >= 1-cell footprint.
    dem = np.full((SIZE, SIZE), 10.0, dtype=np.float32)
    dem[30, 30] = 20.0
    edit = edit_3006("smooth", rect_3006(28, 33, 28, 33), feather_m=0.0, radius_m=0.01)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])
    assert out[30, 30] == pytest.approx(10.0)


# ---------------------------------------------------------------- feather


def test_feather_is_monotone_from_edge_to_interior():
    dem = sloped_dem(a=0.5, b=0.0, c=0.0)
    feather_m = 4.0
    edit = edit_3006("plane", rect_3006(20, 60, 20, 60), feather_m=feather_m, flat=True)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])

    mask = rect_mask(20, 60, 20, 60)
    flat_value = float(out[40, 40])  # deep interior: fully the op value

    # Transect down column 25, from the top edge of the mask to its center.
    # Implied weight w = (out - original) / (flat - original).
    col = 25
    ws = []
    for row in range(20, 41):
        original = float(dem[row, col])
        assert abs(flat_value - original) > 1e-6
        w = (float(out[row, col]) - original) / (flat_value - original)
        ws.append(w)
    ws = np.asarray(ws)
    assert np.all(ws >= -1e-9) and np.all(ws <= 1 + 1e-6)
    assert np.all(np.diff(ws) >= -1e-6)  # monotone edge -> interior
    assert ws[0] < 0.5  # edge band is mostly original
    assert ws[-1] == pytest.approx(1.0, abs=1e-6)  # interior is fully the op
    # Nothing outside the mask moves (feather band is inside the polygon).
    assert np.array_equal(out[~mask], dem[~mask])


def test_nodata_cells_pass_through_untouched():
    dem = sloped_dem()
    dem[30:35, 30:35] = NODATA
    edit = edit_3006("plane", rect_3006(20, 60, 20, 60), feather_m=2.0, flat=True)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])

    assert np.all(out[30:35, 30:35] == NODATA)
    mask = rect_mask(20, 60, 20, 60)
    valid_interior = mask.copy()
    valid_interior[30:35, 30:35] = False
    assert not np.array_equal(out[valid_interior], dem[valid_interior])


# ---------------------------------------------------------------- ordering


def test_overlapping_edits_apply_in_created_at_order():
    dem = sloped_dem(a=0.2, b=0.0, c=10.0)
    first = edit_3006(
        "plane", rect_3006(10, 40, 10, 30),
        feather_m=0.0, flat=True, created_at="2026-07-01T00:00:00Z",
    )
    second = edit_3006(
        "plane", rect_3006(30, 60, 10, 30),
        feather_m=0.0, flat=True, created_at="2026-07-02T00:00:00Z",
    )

    forward = apply_edits(dem, TRANSFORM, NODATA, [first, second])
    backward = apply_edits(dem, TRANSFORM, NODATA, [second, first])

    overlap = rect_mask(30, 40, 10, 30)
    # Order-dependent on the overlap: the later edit reads the earlier one's
    # output, so its mean differs between the two orders.
    assert not np.allclose(forward[overlap], backward[overlap])
    # Deterministic: the overlap ends at the last-applied edit's flat value.
    assert float(forward[overlap].std()) < 1e-4
    assert float(backward[overlap].std()) < 1e-4


def test_load_edits_sorts_by_created_at_defensively(tmp_path: Path):
    features = [
        wgs84_feature("smooth", rect_3006(30, 60, 10, 30), createdAt="2026-07-02T00:00:00Z"),
        wgs84_feature("plane", rect_3006(10, 40, 10, 30), createdAt="2026-07-01T00:00:00Z", flat=True),
    ]
    edits = load_edits(write_edits(tmp_path, features))
    assert [e.op for e in edits] == ["plane", "smooth"]
    assert edits[0].flat is True
    assert edits[0].feather_m == dem_edit.DEFAULT_FEATHER_M  # default 2
    assert edits[1].radius_m == dem_edit.DEFAULT_SMOOTH_RADIUS_M  # default 2


def test_load_edits_skips_unknown_op_and_rejects_bad_files(tmp_path: Path, capsys):
    features = [
        wgs84_feature("terraform", rect_3006(10, 40, 10, 30)),
        wgs84_feature("plane", rect_3006(10, 40, 10, 30)),
    ]
    edits = load_edits(write_edits(tmp_path, features))
    assert [e.op for e in edits] == ["plane"]
    assert "unknown op" in capsys.readouterr().out

    bad = tmp_path / "bad.geojson"
    bad.write_text("{not json")
    with pytest.raises(DemEditError):
        load_edits(bad)
    not_fc = tmp_path / "not_fc.geojson"
    not_fc.write_text(json.dumps({"type": "Feature"}))
    with pytest.raises(DemEditError):
        load_edits(not_fc)


# ---------------------------------------------------------------- corridor


def bumpy_road_dem(grade: float = 0.02, bump: float = 0.3, period: float = 8.0) -> np.ndarray:
    """A 2 % east-west grade with `bump`-amplitude undulations every `period`
    metres along it and a one-cell spike on the road — the terrain a cart
    path bounces over."""
    x, y = cell_coords()
    dx = x - ORIGIN_X
    z = 60.0 + grade * dx + bump * np.sin(2 * np.pi * dx / period)
    z[40, 30] += 1.5
    return z.astype(np.float32)


def road_centerline(col0: int, col1: int, row: int) -> list[list[float]]:
    """East-west centerline through the centres of row `row`, cols col0..col1."""
    y = ORIGIN_Y - (row + 0.5) * RES
    return [[ORIGIN_X + col0 * RES, y], [ORIGIN_X + col1 * RES, y]]


def test_corridor_smooths_along_the_road_flattens_across_and_keeps_the_grade(capsys):
    dem = bumpy_road_dem()
    # Road: rows 37..43 (7 m wide), cols 5..75; hard edge so the numbers are exact.
    edit = edit_3006("corridor", rect_3006(5, 75, 37, 44), feather_m=0.0,
                     centerline=road_centerline(5, 75, 40), smooth_m=25.0, width_m=7.0)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit])
    assert "warning" not in capsys.readouterr().out

    road = out[37:44, 5:75]
    before = dem[37:44, 5:75]
    cols = np.arange(5, 75) + 0.5
    # Along the road: the undulations (±0.3 m) and the spike are gone; what is
    # left follows the 2 % grade to within a few centimetres.
    residual_after = road[3] - (60.0 + 0.02 * cols)
    residual_before = before[3] - (60.0 + 0.02 * cols)
    assert np.abs(residual_before).max() > 0.29
    assert np.abs(residual_after[10:-10]).max() < 0.06
    assert abs((road[3, -5] - road[3, 5]) - 0.02 * 60) < 0.1
    # Across the road every cell of a station shares one height.
    assert np.ptp(road, axis=0).max() < 1e-6
    # Outside the polygon nothing moved.
    untouched = np.ones(dem.shape, dtype=bool)
    untouched[37:44, 5:75] = False
    assert np.array_equal(out[untouched], dem[untouched])


def test_corridor_profile_ignores_the_verge_when_width_is_given():
    dem = bumpy_road_dem(bump=0.0)
    # A verge 2 m higher on both sides of a 3 m road, inside the edit polygon.
    dem[36:39, :] += 2.0
    dem[42:45, :] += 2.0
    ring = rect_3006(5, 75, 36, 45)
    line = road_centerline(5, 75, 40)
    with_width = apply_edits(dem, TRANSFORM, NODATA, [edit_3006("corridor", ring, feather_m=0.0, centerline=line, width_m=3.0)])
    without = apply_edits(dem, TRANSFORM, NODATA, [edit_3006("corridor", ring, feather_m=0.0, centerline=line)])
    # With the width the road keeps its own level; without it the verge drags the profile up.
    assert abs(with_width[40, 40] - dem[40, 40]) < 0.05
    assert without[40, 40] - dem[40, 40] > 1.0


def test_corridor_follows_a_bent_centerline():
    dem = bumpy_road_dem()
    # An L: east along row 40 to col 40, then north (up the rows) along col 40.
    y40 = ORIGIN_Y - 40.5 * RES
    line = [[ORIGIN_X + 5.0, y40], [ORIGIN_X + 40.5, y40], [ORIGIN_X + 40.5, ORIGIN_Y - 5.0]]
    ring = [[ORIGIN_X + 5, y40 - 3], [ORIGIN_X + 43.5, y40 - 3], [ORIGIN_X + 43.5, ORIGIN_Y - 5],
            [ORIGIN_X + 37.5, ORIGIN_Y - 5], [ORIGIN_X + 37.5, y40 + 3], [ORIGIN_X + 5, y40 + 3], [ORIGIN_X + 5, y40 - 3]]
    out = apply_edits(dem, TRANSFORM, NODATA, [edit_3006("corridor", ring, feather_m=0.0, centerline=line)])
    # The north leg is flat across (same x grade for every station), and smooth along.
    leg = out[6:36, 38:43]
    assert np.ptp(leg, axis=1).max() < 1e-6
    assert np.abs(np.diff(leg[:, 2])).max() < 0.03
    # The east leg lost its bumps.
    east = out[40, 8:34] - (60.0 + 0.02 * (np.arange(8, 34) + 0.5))
    assert np.abs(east).max() < 0.06


def test_corridor_skips_without_a_usable_centerline(capsys):
    dem = bumpy_road_dem()
    ring = rect_3006(5, 75, 37, 44)
    out = apply_edits(dem, TRANSFORM, NODATA, [
        edit_3006("corridor", ring, centerline=None),
        edit_3006("corridor", ring, centerline=[[ORIGIN_X + 10, ORIGIN_Y - 40.5], [ORIGIN_X + 10, ORIGIN_Y - 40.5]]),
    ])
    assert np.array_equal(out, dem)
    printed = capsys.readouterr().out
    assert "has no centerline" in printed and "zero length" in printed


def test_load_edits_reads_corridor_centerline_and_rejects_malformed_ones(tmp_path: Path, capsys):
    line = ring_to_wgs84(road_centerline(5, 75, 40))
    features = [
        wgs84_feature("corridor", rect_3006(5, 75, 37, 44), centerline=line, smoothM=30, widthM=5, featherM=2),
        wgs84_feature("corridor", rect_3006(5, 75, 37, 44), centerline=line[:1]),
        wgs84_feature("corridor", rect_3006(5, 75, 37, 44), centerline=line, smoothM=0),
        wgs84_feature("corridor", rect_3006(5, 75, 37, 44)),
    ]
    edits = load_edits(write_edits(tmp_path, features))
    assert len(edits) == 1
    edit = edits[0]
    assert edit.op == "corridor" and edit.smooth_m == 30.0 and edit.width_m == 5.0 and edit.feather_m == 2.0
    assert edit.centerline == line
    printed = capsys.readouterr().out
    assert printed.count("needs a centerline") == 2 and "must be > 0" in printed

    # Reprojection carries the centerline into the DEM CRS alongside the polygon.
    [projected] = dem_edit.reproject_edits(edits, CRS.from_epsg(3006))
    assert np.allclose(np.asarray(projected.centerline), np.asarray(road_centerline(5, 75, 40)), atol=0.01)
    out = apply_edits(bumpy_road_dem(), TRANSFORM, NODATA, [projected])
    assert np.ptp(out[38:43, 40]) < 1e-6


# ---------------------------------------------------------------- command / CLI


def test_empty_edits_writes_byte_identical_copy(tmp_path: Path):
    dem_path = write_dem(tmp_path, sloped_dem())
    edits_path = write_edits(tmp_path, [])
    out_path = tmp_path / "edited.tif"
    cmd_apply_dem_edits(dem_path, edits_path, out_path)
    assert out_path.read_bytes() == dem_path.read_bytes()


def test_cmd_refuses_overwriting_the_input(tmp_path: Path):
    dem_path = write_dem(tmp_path, sloped_dem())
    edits_path = write_edits(tmp_path, [])
    with pytest.raises(DemEditError):
        cmd_apply_dem_edits(dem_path, edits_path, dem_path)


def test_main_applies_wgs84_edits_and_never_touches_the_input(tmp_path: Path):
    dem = sloped_dem()
    dem_path = write_dem(tmp_path, dem)
    input_bytes = dem_path.read_bytes()
    edits_path = write_edits(tmp_path, [
        wgs84_feature(
            "plane", rect_3006(20, 60, 20, 60),
            featherM=0.0, flat=True, createdAt="2026-07-18T00:00:00Z",
        ),
    ])
    out_path = tmp_path / "edited.tif"

    rc = main([
        "apply-dem-edits",
        "--input", str(dem_path),
        "--edits", str(edits_path),
        "--out", str(out_path),
    ])
    assert rc == 0
    assert dem_path.read_bytes() == input_bytes  # raw DEM stays pristine

    with rasterio.open(out_path) as src:
        assert src.crs == CRS.from_epsg(3006)
        assert src.transform == TRANSFORM
        assert src.nodata == NODATA
        assert src.dtypes[0] == "float32"
        out = src.read(1)

    # The reprojected WGS84 polygon lands on the same cells the 3006 ring
    # would: interior is flat, outside is untouched.
    interior = rect_mask(22, 58, 22, 58)
    assert float(out[interior].std()) < 1e-3
    outside = ~rect_mask(19, 61, 19, 61)
    assert np.array_equal(out[outside], dem[outside])


def test_main_reports_bad_edits_file_as_error(tmp_path: Path, capsys):
    dem_path = write_dem(tmp_path, sloped_dem())
    bad = tmp_path / "bad.geojson"
    bad.write_text(json.dumps({"type": "Feature"}))
    rc = main([
        "apply-dem-edits",
        "--input", str(dem_path),
        "--edits", str(bad),
        "--out", str(tmp_path / "edited.tif"),
    ])
    assert rc == 1
    assert "FeatureCollection" in capsys.readouterr().err


# --- dig ---------------------------------------------------------------------


def test_dig_drop_starts_at_the_edge_follows_the_bank_and_floors_at_depth():
    d = np.linspace(0.0, 20.0, 401)
    drop = dem_edit.dig_drop(d, depth_m=1.2, slope_deg=10.0)
    assert drop[0] == pytest.approx(0.0, abs=1e-9)
    assert np.all(np.diff(drop) >= -1e-12)          # only ever deeper going in
    assert drop.max() <= 1.2 + 1e-9                 # never past the floor
    # The bank runs at the requested angle until the toe rounds off.
    tan10 = np.tan(np.radians(10.0))
    assert drop[d == 2.0][0] == pytest.approx(2.0 * tan10, rel=0.05)
    # Past the toe (1.2 / tan 10° = 6.8 m, plus the rounding) it is the floor.
    assert drop[d >= 12.0].min() == pytest.approx(1.2, abs=0.01)


def test_dig_drop_shelf_comes_before_the_bank():
    d = np.array([0.0, 1.0, 2.0, 4.0, 30.0])
    drop = dem_edit.dig_drop(d, depth_m=1.0, slope_deg=30.0, shelf_m=2.0, shelf_depth_m=0.2)
    assert drop[1] == pytest.approx(0.1)            # halfway down the shelf
    assert drop[2] == pytest.approx(0.2, abs=1e-6)  # shelf edge
    assert drop[4] == pytest.approx(1.0, abs=1e-3)


def pond_dem() -> np.ndarray:
    """A pond at 10 m (lidar sees the water surface) in ground at 12 m."""
    dem = np.full((SIZE, SIZE), 12.0, dtype=np.float32)
    dem[rect_mask(20, 60, 20, 60)] = 10.0
    return dem


def test_dig_level_deepens_a_pond_below_its_water_level_and_keeps_its_rim():
    dem = pond_dem()
    edit = edit_3006("dig", rect_3006(20, 60, 20, 60), feather_m=0.0,
                     depth_m=1.5, bank_slope_deg=20.0, reference="level")
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)

    assert np.all(out <= dem + 1e-6)                           # digs, never fills
    outside = ~rect_mask(20, 60, 20, 60)
    assert np.array_equal(out[outside], dem[outside])          # banks untouched
    assert out[40, 40] == pytest.approx(10.0 - 1.5, abs=0.01)  # floor at level − depth
    # The outermost ring (cell centres 0.5 m in) barely moves, so the water
    # plane OPCD puts at the lowest rim vertex stays at the water level.
    rim = rect_mask(20, 60, 20, 60) & ~rect_mask(21, 59, 21, 59)
    assert float(dem[rim].min() - out[rim].min()) < 0.25


def test_dig_level_on_a_narrow_arm_never_reaches_full_depth():
    dem = np.full((SIZE, SIZE), 10.0, dtype=np.float32)
    edit = edit_3006("dig", rect_3006(10, 70, 38, 42), feather_m=0.0,
                     depth_m=2.0, bank_slope_deg=15.0, reference="level")
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)
    # 4 m wide: 2 m from the centre line to the bank at 15° is ~0.54 m of drop.
    assert 10.0 - float(out[40, 40]) < 0.6
    assert 10.0 - float(out[40, 40]) > 0.3


def test_dig_plane_follows_the_tilted_ground_and_steepens_its_face():
    x, y = cell_coords()
    dem = (20.0 + 0.05 * (x - ORIGIN_X)).astype(np.float32)   # 5 % grade rising east
    # Face towards the east (bearing 90°): steep there, gentle entry on the west.
    edit = edit_3006("dig", rect_3006(25, 55, 25, 55), feather_m=0.0,
                     depth_m=0.5, bank_slope_deg=15.0, face_slope_deg=45.0, face_bearing_deg=90.0,
                     reference="plane")
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)

    drop = dem - out
    assert np.all(drop >= -1e-6)
    assert drop[40, 40] == pytest.approx(0.5, abs=0.02)        # floor follows the grade
    # The outermost cells (0.5 m in): the east (face) side drops far more than the west.
    east, west = drop[40, 54], drop[40, 25]
    assert east > 2 * west
    assert west == pytest.approx(0.5 * np.tan(np.radians(15.0)), abs=0.02)


def test_dig_plane_reference_ignores_the_smoothed_hollow():
    x, y = cell_coords()
    dem = np.full((SIZE, SIZE), 30.0, dtype=np.float32)
    dem[rect_mask(30, 50, 30, 50)] = 29.9      # the lidar kept only 10 cm of the bunker
    edit = edit_3006("dig", rect_3006(30, 50, 30, 50), feather_m=0.0,
                     depth_m=0.6, bank_slope_deg=40.0, reference="plane")
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)
    assert out[40, 40] == pytest.approx(30.0 - 0.6, abs=0.01)  # measured from the ground around it


def test_dig_variation_changes_the_bank_around_the_outline_and_is_seeded():
    dem = pond_dem()
    base = dict(feather_m=0.0, depth_m=1.5, bank_slope_deg=12.0, reference="level", variation=1.0)
    a = apply_edits(dem, TRANSFORM, NODATA, [edit_3006("dig", rect_3006(20, 60, 20, 60), seed=1, **base)], log=lambda *_: None)
    b = apply_edits(dem, TRANSFORM, NODATA, [edit_3006("dig", rect_3006(20, 60, 20, 60), seed=1, **base)], log=lambda *_: None)
    c = apply_edits(dem, TRANSFORM, NODATA, [edit_3006("dig", rect_3006(20, 60, 20, 60), seed=2, **base)], log=lambda *_: None)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)
    # Same distance in on the four sides, different drops.
    sides = [a[40, 23], a[40, 56], a[23, 40], a[56, 40]]
    assert max(sides) - min(sides) > 0.02


def test_load_edits_reads_dig_params_and_skips_bad_ones(tmp_path: Path):
    ring = rect_3006(20, 60, 20, 60)
    path = write_edits(tmp_path, [
        wgs84_feature("dig", ring, featherM=0, depthM=0.4, bankSlopeDeg=18, faceSlopeDeg=40,
                      faceBearingDeg=270, reference="plane", rimM=3, variation=0.3, seed=7),
        wgs84_feature("dig", ring, featherM=0),                                   # no depth
        wgs84_feature("dig", ring, featherM=0, depthM=1, faceSlopeDeg=40),       # face without bearing
        wgs84_feature("dig", ring, featherM=0, depthM=1, reference="sea"),
    ])
    logged: list[str] = []
    edits = load_edits(path, log=logged.append)
    assert len(edits) == 1
    e = edits[0]
    assert (e.op, e.depth_m, e.bank_slope_deg, e.face_slope_deg, e.face_bearing_deg) == ("dig", 0.4, 18.0, 40.0, 270.0)
    assert (e.reference, e.rim_m, e.variation, e.seed) == ("plane", 3.0, 0.3, 7)
    assert len(logged) == 3 and all("skipped" in line for line in logged)


def test_dig_level_tapers_bank_inside_the_outline_down_to_the_water_instead_of_a_wall():
    dem = pond_dem()
    # The outline takes in a 2 m strip of bank, 0.8 m above the water, on its east side.
    dem[rect_mask(56, 60, 20, 60)] = 10.8
    edit = edit_3006("dig", rect_3006(20, 60, 20, 60), feather_m=0.0,
                     depth_m=1.0, bank_slope_deg=15.0, reference="level", rim_m=2.0)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)
    # The outermost bank cell (0.5 m in) keeps nearly all of its height ...
    assert float(dem[40, 59] - out[40, 59]) < 0.15
    # ... and the bank comes down in slopes, not a wall: under 30° per 1 m cell,
    # the steepest where the (unnaturally sharp) test strip meets the water.
    steps = np.abs(np.diff(out[40, 46:60].astype(float)))
    assert steps.max() < 0.6
    assert out[40, 40] == pytest.approx(9.0, abs=0.01)     # the level is still the water's


def test_dig_stream_digs_a_creek_bed_below_its_falling_surface():
    # A creek along row 40 falling 2 m west to east, 1 m below grassy banks.
    x, y = cell_coords()
    dem = (20.0 - 2.0 * (x - ORIGIN_X) / (SIZE * RES) + 1.0).astype(np.float32)
    dem[38:43, :] -= 1.0
    ring = rect_3006(4, 76, 38, 43)
    edits = [
        edit_3006("dig", ring, feather_m=0.0, depth_m=0.4, bank_slope_deg=30.0, reference="stream", rim_m=1.0),
        edit_3006("dig", ring, feather_m=0.0, depth_m=0.4, bank_slope_deg=30.0, reference="stream", rim_m=1.0,
                  centerline=[[ORIGIN_X + 76, ORIGIN_Y - 40.5], [ORIGIN_X + 4, ORIGIN_Y - 40.5]], width_m=5.0),
    ]
    for edit in edits:   # derived from the polygon, and drawn uphill as a line
        out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)
        assert np.all(out <= dem + 1e-6)
        beyond_bank = ~rect_mask(3, 77, 37, 44)   # past rimM (1 m) from the outline
        assert np.array_equal(out[beyond_bank], dem[beyond_bank])
        bed = out[40, 8:72].astype(float)
        assert np.all(np.diff(bed) <= 1e-6)                          # the bed only falls downstream
        # The middle of the bed is ~the surface minus the depth.
        surface = dem[40, 8:72].astype(float)
        assert np.median(surface - bed) == pytest.approx(0.4, abs=0.08)


def test_dig_stream_gives_a_narrow_creek_its_full_depth_below_the_water_and_a_bank_outside_it():
    # Vreta's creeks: ~2 m wide Hydrografi ribbons on the 0.5 m export DEM.
    # Lidar sees the two middle cells at the water surface, the outer two
    # 15 cm up the bank, the grass beside them 30 cm up. Falls 2 % eastwards.
    res, size = 0.5, 80
    transform = from_origin(ORIGIN_X, ORIGIN_Y, res, res)
    cols = np.arange(size)
    surface = 20.0 - 0.02 * (cols + 0.5) * res
    dem = np.tile(surface + 0.3, (size, 1))
    dem[38:42, :] = surface + 0.15
    dem[39:41, :] = surface
    dem = dem.astype(np.float32)
    e0, e1, n0, n1 = ORIGIN_X + 4 * res, ORIGIN_X + 76 * res, ORIGIN_Y - 42 * res, ORIGIN_Y - 38 * res
    ring = [[e0, n0], [e1, n0], [e1, n1], [e0, n1], [e0, n0]]
    inside = np.zeros((size, size), bool)
    inside[38:42, 4:76] = True
    maintained_drain = dict(feather_m=0.0, depth_m=0.35, bank_slope_deg=18.0, reference="stream", rim_m=1.0)
    edits = [
        edit_3006("dig", ring, **maintained_drain),                          # a polygon: line found down it
        edit_3006("dig", ring, **maintained_drain, width_m=2.0,
                  centerline=[[e0, ORIGIN_Y - 20.0], [e1, ORIGIN_Y - 20.0]]),  # a drawn line
    ]
    mid = slice(12, 68)   # away from the creek's ends
    for edit in edits:
        out = apply_edits(dem, transform, NODATA, [edit], log=lambda *_: None).astype(float)
        assert np.all(out <= dem + 1e-6)                                     # digs, never fills
        # Depth under the water plane: the preset's 0.35 m along the line.
        depth = surface[mid] - out[39:41, mid]
        assert np.mean(depth >= 0.9 * 0.35) >= 0.9
        # No ground inside the outline pokes through the water.
        assert np.all(out[38:42, mid] <= surface[mid] + 0.01)
        # The bank beside it slopes down to the water edge over rimM (1 m,
        # two cells) and is never cut below the water ...
        for row in (37, 42):
            assert np.all(out[row, mid] < dem[row, mid] - 0.1)
            assert np.all(out[row, mid] >= surface[mid] - 1e-6)
        assert np.all(out[36, mid] < dem[36, mid])
        assert np.all(out[37, mid] < out[36, mid])
        # ... and the ground further out is left alone.
        assert np.array_equal(out[:34], dem[:34].astype(float))
        assert np.array_equal(out[46:], dem[46:].astype(float))


def test_dig_stream_keeps_the_preset_bank_where_the_creek_is_wide_enough():
    # 8 m wide, flat at the surface: the 18° bank runs from the edge as preset.
    dem = np.full((SIZE, SIZE), 10.0, dtype=np.float32)
    edit = edit_3006("dig", rect_3006(4, 76, 36, 44), feather_m=0.0, depth_m=0.35,
                     bank_slope_deg=18.0, reference="stream", rim_m=1.0)
    out = apply_edits(dem, TRANSFORM, NODATA, [edit], log=lambda *_: None)
    tan18 = np.tan(np.radians(18.0))
    assert 10.0 - float(out[40, 40]) == pytest.approx(0.35, abs=0.01)
    assert 10.0 - float(out[36, 40]) == pytest.approx(0.5 * tan18, abs=0.02)   # 0.5 m in


def test_load_edits_reads_a_creek_dig_line_and_width(tmp_path: Path):
    ring = rect_3006(4, 76, 38, 43)
    line = ring_to_wgs84([[ORIGIN_X + 4, ORIGIN_Y - 40.5], [ORIGIN_X + 76, ORIGIN_Y - 40.5]])
    path = write_edits(tmp_path, [wgs84_feature("dig", ring, featherM=0, depthM=0.3, reference="stream", centerline=line, widthM=2.5)])
    [e] = load_edits(path)
    assert (e.reference, e.width_m, len(e.centerline)) == ("stream", 2.5, 2)
