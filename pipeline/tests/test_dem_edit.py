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
