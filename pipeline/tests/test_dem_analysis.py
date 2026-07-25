"""dem-analysis (deploy-split W4): greens stay 0.5 m, everything else goes 1 m.

Real rasters throughout (synthetic but genuine GeoTIFFs on disk), no mocks —
the point of the command is what the bytes on the VPS look like.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from golfpipe import commands
from golfpipe.dem_analysis import (
    DEFAULT_COARSE_FACTOR,
    DEFAULT_GREEN_BUFFER_M,
    FALLBACK_NODATA,
    DemAnalysisError,
    build_analysis_dem,
    coarsen,
    green_mask,
    load_green_geometries,
)

SWEREF99_TM = CRS.from_epsg(3006)
ORIGIN_X = 533000.0
ORIGIN_Y = 6475000.0
PIXEL = 0.5  # the real builder DEM resolution
SIZE = 400  # 200 m square
NODATA = -9999.0

# Green polygon: a 30 m square whose NW corner sits 40 m in from the raster's
# NW corner, so the 30 m buffer stays comfortably inside the raster.
GREEN_E0 = ORIGIN_X + 40.0
GREEN_N0 = ORIGIN_Y - 40.0
GREEN_SIDE = 30.0


def _heights() -> np.ndarray:
    """A tilted plane plus a short-wavelength ripple. The ripple is what makes
    coarsening lossy: a 2x2 block mean of a 3 m-wavelength sine is measurably
    different from the cell values, so "full resolution inside the greens" is
    a claim with teeth.
    """
    rows = np.arange(SIZE, dtype=np.float64)[:, None]
    cols = np.arange(SIZE, dtype=np.float64)[None, :]
    east = cols * PIXEL
    south = rows * PIXEL
    plane = 50.0 + 0.02 * east + 0.01 * south
    ripple = 0.35 * np.sin(east * 2 * math.pi / 3.0) * np.cos(south * 2 * math.pi / 3.0)
    return (plane + ripple).astype(np.float32)


def _write_dem(path: Path, heights: np.ndarray) -> Path:
    profile = {
        "driver": "GTiff",
        "height": heights.shape[0],
        "width": heights.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": SWEREF99_TM,
        "transform": from_origin(ORIGIN_X, ORIGIN_Y, PIXEL, PIXEL),
        "nodata": NODATA,
        "compress": "deflate",
        "predictor": 3,
        "zlevel": 9,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(heights, 1)
    return path


@pytest.fixture
def builder_dem(tmp_path: Path) -> Path:
    return _write_dem(tmp_path / "dem.tif", _heights())


@pytest.fixture
def greens_geojson(tmp_path: Path) -> Path:
    """The green as WGS84 GeoJSON — the same handoff shape the publish CLI
    writes (D-TE5 style: FeatureCollection, WGS84, reprojected by the
    command).
    """
    from rasterio.warp import transform_geom

    ring_3006 = [
        [GREEN_E0, GREEN_N0],
        [GREEN_E0 + GREEN_SIDE, GREEN_N0],
        [GREEN_E0 + GREEN_SIDE, GREEN_N0 - GREEN_SIDE],
        [GREEN_E0, GREEN_N0 - GREEN_SIDE],
        [GREEN_E0, GREEN_N0],
    ]
    geometry = transform_geom(SWEREF99_TM, "EPSG:4326", {"type": "Polygon", "coordinates": [ring_3006]})
    path = tmp_path / "greens.geojson"
    path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "geometry": geometry, "properties": {"holeNumber": 1}}],
    }), encoding="utf-8")
    return path


def _rc(east: float, north: float) -> tuple[int, int]:
    """Raster row/col for an EPSG:3006 point."""
    return int((ORIGIN_Y - north) / PIXEL), int((east - ORIGIN_X) / PIXEL)


# ─── The parity claim ─────────────────────────────────────────────────────


def test_greens_plus_buffer_are_bit_identical_to_the_builder_dem(builder_dem, greens_geojson, tmp_path):
    out = commands.cmd_dem_analysis(builder_dem, greens_geojson, tmp_path / "dem-analysis.tif")

    with rasterio.open(builder_dem) as src, rasterio.open(out) as dst:
        source = src.read(1)
        analysis = dst.read(1)
        geometries = load_green_geometries(greens_geojson)
        from golfpipe.dem_analysis import reproject_geometries

        mask = green_mask(reproject_geometries(geometries, src.crs), source.shape, src.transform)

    assert mask.any()
    # Bit-identical, not "close": green reads on the VPS must equal the
    # builder's answer exactly.
    assert np.array_equal(analysis[mask], source[mask])

    # A point on the green itself, and one 25 m outside it (inside the 30 m
    # buffer) — both full resolution.
    for east, north in ((GREEN_E0 + 15.0, GREEN_N0 - 15.0), (GREEN_E0 + GREEN_SIDE + 25.0, GREEN_N0 - 15.0)):
        row, col = _rc(east, north)
        assert mask[row, col]
        assert analysis[row, col] == source[row, col]


def test_outside_the_buffer_the_background_is_a_1m_block_mean(builder_dem, greens_geojson, tmp_path):
    out = commands.cmd_dem_analysis(builder_dem, greens_geojson, tmp_path / "dem-analysis.tif")

    with rasterio.open(builder_dem) as src, rasterio.open(out) as dst:
        source = src.read(1)
        analysis = dst.read(1)

    # 60 m east of the green's east edge — well beyond the 30 m buffer.
    row, col = _rc(GREEN_E0 + GREEN_SIDE + 60.0, GREEN_N0 - 15.0)
    block_r = (row // DEFAULT_COARSE_FACTOR) * DEFAULT_COARSE_FACTOR
    block_c = (col // DEFAULT_COARSE_FACTOR) * DEFAULT_COARSE_FACTOR
    block = source[block_r:block_r + DEFAULT_COARSE_FACTOR, block_c:block_c + DEFAULT_COARSE_FACTOR]
    assert analysis[row, col] == pytest.approx(float(block.mean()), abs=1e-4)
    # Every cell of the block carries the same value (that is what deflate eats).
    assert len(set(analysis[block_r:block_r + 2, block_c:block_c + 2].ravel().tolist())) == 1

    # The ripple guarantees the background is genuinely lossy — otherwise this
    # test would pass on a no-op implementation. (Cell-by-cell the difference
    # can happen to be ~0 where the ripple crosses its block mean, so this is
    # a claim about the patch, not one cell.)
    patch = (slice(row - 20, row + 20), slice(col - 20, col + 20))
    assert np.abs(analysis[patch] - source[patch]).max() > 0.15


def test_the_buffer_distance_is_honoured(builder_dem, greens_geojson, tmp_path):
    out = commands.cmd_dem_analysis(
        builder_dem, greens_geojson, tmp_path / "dem-analysis.tif", buffer_m=10.0,
    )
    with rasterio.open(builder_dem) as src, rasterio.open(out) as dst:
        source = src.read(1)
        analysis = dst.read(1)

    inside_row, inside_col = _rc(GREEN_E0 + GREEN_SIDE + 8.0, GREEN_N0 - 15.0)
    outside_row, outside_col = _rc(GREEN_E0 + GREEN_SIDE + 14.0, GREEN_N0 - 15.0)
    assert analysis[inside_row, inside_col] == source[inside_row, inside_col]
    assert analysis[outside_row, outside_col] != source[outside_row, outside_col]


def test_nodata_footprint_is_unchanged(tmp_path, greens_geojson):
    heights = _heights()
    heights[0:40, 0:40] = NODATA  # NW corner, far from the green
    dem = _write_dem(tmp_path / "dem-nodata.tif", heights)

    out = commands.cmd_dem_analysis(dem, greens_geojson, tmp_path / "dem-analysis.tif")
    with rasterio.open(out) as dst:
        analysis = dst.read(1)
        assert dst.nodata == NODATA

    # analysis.service returns null exactly where the source had nodata — no
    # more (a block mean must not bleed into a nodata cell), no less.
    assert np.array_equal(analysis == NODATA, heights == NODATA)


def test_an_untagged_source_gets_the_nodata_sentinel_not_sea_level(tmp_path, greens_geojson):
    """A source without a nodata tag can still carry NaN holes. Writing those
    as 0.0 m would publish sea level over a lidar gap — and the server, seeing
    no nodata tag, would return it as a real elevation."""
    heights = _heights()
    heights[0:40, 0:40] = np.nan  # NW corner, far from the green
    profile_path = tmp_path / "dem-untagged.tif"
    profile = {
        "driver": "GTiff", "height": SIZE, "width": SIZE, "count": 1, "dtype": "float32",
        "crs": SWEREF99_TM, "transform": from_origin(ORIGIN_X, ORIGIN_Y, PIXEL, PIXEL),
        # No "nodata" key at all — this is the case under test.
    }
    with rasterio.open(profile_path, "w", **profile) as dst:
        dst.write(heights, 1)

    out = commands.cmd_dem_analysis(profile_path, greens_geojson, tmp_path / "dem-analysis.tif")
    with rasterio.open(out) as dst:
        analysis = dst.read(1)
        assert dst.nodata == FALLBACK_NODATA

    hole = np.isnan(heights)
    assert np.array_equal(analysis == FALLBACK_NODATA, hole)
    assert not np.any(analysis[hole] == 0.0)
    # The real terrain is untouched by the sentinel choice.
    assert np.all(analysis[~hole] > 40.0)


def test_the_mosaic_is_smaller_than_the_full_dem(builder_dem, greens_geojson, tmp_path):
    out = commands.cmd_dem_analysis(builder_dem, greens_geojson, tmp_path / "dem-analysis.tif")
    source_bytes = builder_dem.stat().st_size
    out_bytes = out.stat().st_size
    # Both files are deflate+predictor3, so this is a like-for-like comparison:
    # the win comes purely from the piecewise-constant background.
    assert out_bytes < source_bytes
    print(f"\nrippled  : dem-analysis {out_bytes:,} B vs source {source_bytes:,} B "
          f"({100 * out_bytes / source_bytes:.0f}%)")


def test_size_win_on_a_realistic_lidar_surface(greens_geojson, tmp_path):
    """This is the number the deploy budget cares about, so measure it on a
    realistic surface: broad terrain waves plus 3 cm of per-cell roughness.

    The roughness matters. An analytically smooth raster already deflates to
    ~7% of raw and leaves almost nothing for coarsening to win; real lidar is
    noisy at the cell level, which is exactly the noise a 2x2 block mean
    removes.
    """
    rows = np.arange(SIZE, dtype=np.float64)[:, None]
    cols = np.arange(SIZE, dtype=np.float64)[None, :]
    east, south = cols * PIXEL, rows * PIXEL
    terrain = (50.0 + 0.02 * east + 0.01 * south
               + 1.5 * np.sin(east * 2 * math.pi / 120.0)
               + 1.1 * np.cos(south * 2 * math.pi / 90.0))
    roughness = np.random.default_rng(20260725).normal(0.0, 0.03, terrain.shape)
    dem = _write_dem(tmp_path / "dem-lidar.tif", (terrain + roughness).astype(np.float32))

    out = commands.cmd_dem_analysis(dem, greens_geojson, tmp_path / "dem-analysis.tif")
    source_bytes = dem.stat().st_size
    out_bytes = out.stat().st_size
    print(f"\nlidar-ish: dem-analysis {out_bytes:,} B vs source {source_bytes:,} B "
          f"({100 * out_bytes / source_bytes:.0f}%)")
    # ~48% measured. Greens+buffer are ~18% of this 200 m fixture; a real
    # course AOI is far bigger relative to its greens, so production lands
    # closer to the ~25-30% floor. Threshold is loose enough to survive a
    # zlib version bump.
    assert out_bytes < source_bytes * 0.60


# ─── Guards + degenerate inputs ───────────────────────────────────────────


def test_refuses_to_overwrite_the_input(builder_dem, greens_geojson):
    with pytest.raises(DemAnalysisError, match="refusing to overwrite"):
        commands.cmd_dem_analysis(builder_dem, greens_geojson, builder_dem)


def test_no_greens_coarsens_everything(builder_dem, tmp_path, capsys):
    empty = tmp_path / "empty.geojson"
    empty.write_text(json.dumps({"type": "FeatureCollection", "features": []}), encoding="utf-8")

    out = commands.cmd_dem_analysis(builder_dem, empty, tmp_path / "dem-analysis.tif")
    assert "no green polygons" in capsys.readouterr().out

    with rasterio.open(builder_dem) as src, rasterio.open(out) as dst:
        source = src.read(1)
        analysis = dst.read(1)
    assert not np.array_equal(analysis, source)


def test_malformed_features_are_skipped_not_fatal(tmp_path, capsys):
    path = tmp_path / "greens.geojson"
    path.write_text(json.dumps({
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [15.0, 58.0]}, "properties": {}},
            "not-a-feature",
        ],
    }), encoding="utf-8")
    assert load_green_geometries(path) == []
    out = capsys.readouterr().out
    assert "not a Feature object" in out
    assert "not a Polygon/MultiPolygon" in out


def test_a_non_geojson_file_is_fatal(tmp_path):
    path = tmp_path / "greens.geojson"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(DemAnalysisError, match="greens must be a GeoJSON object"):
        load_green_geometries(path)


# ─── Unit-level checks on the two pure helpers ────────────────────────────


def test_coarsen_handles_a_partial_trailing_block():
    dem = np.arange(9, dtype=np.float64).reshape(3, 3)
    valid = np.ones_like(dem, dtype=bool)
    out = coarsen(dem, valid, 2)
    assert out.shape == (3, 3)
    assert out[0, 0] == pytest.approx((0 + 1 + 3 + 4) / 4)
    assert out[2, 2] == pytest.approx(8.0)  # 1x1 trailing block


def test_coarsen_ignores_invalid_cells():
    dem = np.array([[10.0, 20.0], [30.0, -9999.0]])
    valid = np.array([[True, True], [True, False]])
    out = coarsen(dem, valid, 2)
    assert out[0, 0] == pytest.approx(20.0)  # (10+20+30)/3, nodata excluded


def test_build_analysis_dem_defaults_match_the_documented_contract():
    assert DEFAULT_GREEN_BUFFER_M == 30.0
    assert DEFAULT_COARSE_FACTOR == 2
    dem = np.full((4, 4), 5.0, dtype=np.float32)
    out, mask = build_analysis_dem(dem, from_origin(0, 0, 0.5, 0.5), None, [])
    assert not mask.any()
    assert np.allclose(out, 5.0)
