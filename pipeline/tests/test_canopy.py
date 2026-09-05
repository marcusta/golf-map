"""canopy command tests — fully offline. Unit tests for the colour ramp,
the return-count building rule and the morphology step, plus one small
end-to-end run over a synthetic LAS scene (the _write_las pattern from
test_detect_trees.py, extended with number_of_returns) that checks the
three tile layers and the manifest merge.
"""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import laspy
import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_origin
from scipy.ndimage import binary_closing

from golfpipe import canopy, grid_dem
from golfpipe.commands import cmd_canopy
from golfpipe.detect_common import STRUCTURE_8
from golfpipe.manifest import merge_manifest_layers
from golfpipe.terrain_rgb import decode_terrain_rgb

E0, N0 = 531000.0, 6473000.0
SIZE = 40
BBOX_3006 = (E0, N0, E0 + SIZE, N0 + SIZE)
GROUND_Z = 10.0


# ─── colour ramp ─────────────────────────────────────────────────────────────

def test_canopy_color_rgba_stops_and_transparency():
    heights = np.array([[0.0, 0.99, 1.0, 8.0], [15.0, 25.0, 35.0, 60.0]])
    rgba = canopy.canopy_color_rgba(heights)

    assert rgba.shape == (2, 4, 4) and rgba.dtype == np.uint8
    assert (rgba[0, 0] == [0, 0, 0, 0]).all()  # no canopy: transparent
    assert rgba[0, 1, 3] == 0  # just under 1 m: still transparent
    assert (rgba[0, 2] == [255, 255, 0, 255]).all()
    assert (rgba[0, 3] == [255, 140, 0, 255]).all()
    assert (rgba[1, 0] == [230, 30, 30, 255]).all()
    assert (rgba[1, 1] == [200, 0, 200, 255]).all()
    assert (rgba[1, 2] == [80, 40, 255, 255]).all()
    assert (rgba[1, 3] == [80, 40, 255, 255]).all()  # above the last stop clamps


def test_canopy_color_rgba_interpolates_between_stops():
    rgba = canopy.canopy_color_rgba(np.array([[4.5]]))  # halfway 1 m -> 8 m
    assert tuple(rgba[0, 0]) == (255, 198, 0, 255)  # G: (255 + 140) / 2 = 197.5 -> 198


# ─── building suppression ────────────────────────────────────────────────────

def test_suppress_buildings_zeroes_single_return_tall_cells_only():
    ndsm = np.array([[9.0, 9.0, 9.0], [1.5, 0.0, 9.0]])
    count = np.array([[10.0, 10.0, 10.0], [10.0, 0.0, 10.0]])
    multi = np.array([[0.0, 0.5, 6.0], [0.0, 0.0, 1.0]])  # fractions 0, .05, .6 / 0, -, .1

    out = canopy.suppress_buildings(ndsm, count, multi)

    assert out[0, 0] == 0.0  # roof: tall, no multi returns
    assert out[0, 1] == 0.0  # roof: 5 % < 10 %
    assert out[0, 2] == 9.0  # foliage: 60 % multi returns
    assert out[1, 0] == 1.5  # too low to be judged, kept
    assert out[1, 1] == 0.0  # no points, untouched
    assert out[1, 2] == 9.0  # exactly 10 % is not under the threshold
    assert ndsm[0, 0] == 9.0  # input not mutated


# ─── morphology ──────────────────────────────────────────────────────────────

def test_clean_canopy_fills_hole_and_clamps():
    ndsm = np.zeros((30, 30))
    ndsm[5:20, 5:20] = 12.0
    ndsm[10, 10] = 0.0  # 1-cell sampling hole
    ndsm[6, 6] = 55.0  # over the 40 m clamp
    ndsm[25, 25] = 0.8  # under 1 m: never canopy

    out = canopy.clean_canopy(ndsm)

    assert out.dtype == np.float32
    assert out[10, 10] > 0  # hole bridged
    assert out[5:20, 5:20].min() >= 12.0
    assert out.max() == 40.0
    assert out[25, 25] == 0.0
    assert out[0:2, :].max() == 0.0  # nothing leaks far outside the blob


def test_clean_canopy_spike_stays_single_cell():
    ndsm = np.zeros((21, 21))
    ndsm[10, 10] = 20.0

    out = canopy.clean_canopy(ndsm)

    # The max filter is masked back to the closed footprint: no 7x7 plateau.
    assert out[10, 10] == 20.0
    assert np.count_nonzero(out) == 1


def test_clean_canopy_crown_cell_takes_7x7_max_within_footprint():
    ndsm = np.zeros((30, 30))
    ndsm[5:20, 5:20] = 12.0
    ndsm[12, 12] = 25.0  # crown top

    out = canopy.clean_canopy(ndsm)

    # Cells within 3 of the top (7x7 window) take it; cells further away keep 12.
    assert (out[9:16, 9:16] == 25.0).all()
    assert out[8, 12] == 12.0 and out[12, 16] == 12.0
    # Footprint equals the closed >= 1 m mask.
    mask = ndsm >= canopy.MIN_CANOPY_HEIGHT_M
    closed = binary_closing(mask, structure=STRUCTURE_8)
    assert np.count_nonzero(out) == np.count_nonzero(closed | mask)
    assert ((out > 0) == (closed | mask)).all()


# ─── crown shaping (surface DSM only) ────────────────────────────────────────

def test_crown_shape_spike_keeps_its_height():
    h = np.zeros((21, 21), dtype=np.float32)
    h[10, 10] = 20.0

    out = canopy.crown_shape(h, 1.0)

    assert out.dtype == np.float32
    assert out[10, 10] == pytest.approx(20.0, rel=1e-3)
    assert np.count_nonzero(out) == 1  # no bleed outside the footprint


def test_crown_shape_block_tapers_edges_and_keeps_centre():
    h = np.zeros((40, 40), dtype=np.float32)
    h[10:30, 10:30] = 15.0

    out = canopy.crown_shape(h, 1.0)

    centre = out[20, 20]
    assert centre == pytest.approx(15.0, rel=0.02)
    # Every footprint edge cell is below the centre, and well below the input.
    edge = np.concatenate([out[10, 10:30], out[29, 10:30], out[10:30, 10], out[10:30, 29]])
    assert (edge < centre).all()
    assert edge.max() < 0.7 * 15.0
    # Monotone shoulder from the edge inward along the middle row.
    row = out[20, 10:20]
    assert (np.diff(row) >= -1e-4).all()
    # Nothing outside the footprint, nothing above 1.02x the input.
    assert out[h == 0].max() == 0.0
    assert (out <= h * 1.02 + 1e-6).all()


def test_crown_shape_never_exceeds_input_with_uneven_heights():
    rng = np.random.default_rng(1)
    h = np.zeros((50, 50), dtype=np.float32)
    h[5:45, 5:45] = rng.uniform(2.0, 30.0, size=(40, 40)).astype(np.float32)
    h[20:25, 20:25] = 0.0  # a hole in the footprint

    out = canopy.crown_shape(h, 1.0)

    assert (out <= h * 1.02 + 1e-6).all()
    assert out[h == 0].max() == 0.0
    assert out[h > 0].min() > 0.0


def test_crown_shape_dips_between_raw_ndsm_maxima():
    # Cleaned canopy: one 15 m plateau. Raw nDSM: two 15 m tops, 8 m between.
    h = np.zeros((30, 30), dtype=np.float32)
    h[5:25, 5:25] = 15.0
    ndsm = np.full((30, 30), 8.0)
    ndsm[h == 0] = 0.0
    ndsm[10, 15] = 15.0
    ndsm[20, 15] = 15.0

    flat = canopy.crown_shape(h, 1.0)
    dipped = canopy.crown_shape(h, 1.0, ndsm=ndsm)

    assert dipped[15, 15] < flat[15, 15]  # between the tops
    assert dipped[15, 15] > 0.7 * flat[15, 15]  # bounded dip
    assert (dipped <= h * 1.02 + 1e-6).all()
    assert dipped[h == 0].max() == 0.0


# ─── multi-return accumulator ────────────────────────────────────────────────

def _write_las(path: Path, x, y, z, classification, number_of_returns=None) -> Path:
    header = laspy.LasHeader(point_format=3, version="1.2")
    header.offsets = [float(np.min(np.asarray(v, dtype=np.float64))) for v in (x, y, z)]
    header.scales = [0.001, 0.001, 0.001]
    las = laspy.LasData(header)
    las.x = np.asarray(x, dtype=np.float64)
    las.y = np.asarray(y, dtype=np.float64)
    las.z = np.asarray(z, dtype=np.float64)
    las.classification = np.asarray(classification, dtype=np.uint8)
    if number_of_returns is not None:
        las.number_of_returns = np.asarray(number_of_returns, dtype=np.uint8)
        las.return_number = np.ones(len(las.x), dtype=np.uint8)
    las.write(str(path))
    return path


def test_grid_lidar_points_multi_return_count(tmp_path: Path):
    path = _write_las(
        tmp_path / "r.las",
        [5.5, 5.5, 5.5, 2.5], [5.5, 5.5, 5.5, 2.5], [18.0, 17.0, 16.0, 12.0],
        [1, 1, 1, 1], number_of_returns=[1, 2, 3, 1],
    )
    bbox = (0.0, 0.0, 10.0, 10.0)
    multi = np.zeros(grid_dem.grid_shape(bbox, 1.0))
    max_grid, count, _, _ = grid_dem.grid_lidar_points(
        [path], bbox, resolution=1.0, classes=None, aggregate="max", multi_return_count=multi,
    )
    assert count[4, 5] == 3 and multi[4, 5] == 2
    assert count[7, 2] == 1 and multi[7, 2] == 0
    assert max_grid[4, 5] == pytest.approx(18.0)


def test_grid_lidar_points_rejects_wrong_accumulator_shape(tmp_path: Path):
    path = _write_las(tmp_path / "one.las", [1.0], [1.0], [1.0], [2])
    with pytest.raises(ValueError, match="shape"):
        grid_dem.grid_lidar_points([path], (0.0, 0.0, 2.0, 2.0), multi_return_count=np.zeros((1, 1)))


# ─── manifest merge ──────────────────────────────────────────────────────────

def test_merge_manifest_layers_keeps_unknown_fields():
    existing = {
        "courseId": "c", "layers": {"ortho": {"minzoom": 14, "maxzoom": 20}},
        "generatedAt": "old", "orthoVintages": [{"collection": "x"}], "activeOrtho": "x",
    }
    fresh = {"courseId": "c", "layers": {"canopy": {"minzoom": 12, "maxzoom": 17}}, "generatedAt": "new"}
    merged = merge_manifest_layers(existing, fresh)
    assert merged["layers"] == {"ortho": {"minzoom": 14, "maxzoom": 20}, "canopy": {"minzoom": 12, "maxzoom": 17}}
    assert merged["orthoVintages"] == [{"collection": "x"}] and merged["activeOrtho"] == "x"
    assert merged["generatedAt"] == "new"
    assert merge_manifest_layers(None, fresh) is fresh


# ─── end to end ──────────────────────────────────────────────────────────────

def _block(x0, x1, y0, y1):
    xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
    return E0 + xs.ravel(), N0 + ys.ravel()


@pytest.fixture
def scene(tmp_path: Path) -> tuple[Path, Path]:
    """Flat ground at 10 m; a 12x12 crown block at 18 m (multi returns) in
    the south-west; a 10x10 roof block at 18 m (single returns) in the
    north-east. Plus a 0.5 m DEM at 20 m (differs from lidar ground so the
    surface layer proves it uses the --dem)."""
    xs, ys, zs, cls, nret = [], [], [], [], []

    def add(bx, by, z, c, n):
        xs.append(bx); ys.append(by)
        zs.append(np.full(bx.shape, z)); cls.append(np.full(bx.shape, c)); nret.append(np.full(bx.shape, n))

    add(*_block(0, SIZE, 0, SIZE), GROUND_Z, 2, 1)
    add(*_block(5, 17, 5, 17), 18.0, 1, 3)
    add(*_block(25, 35, 25, 35), 18.0, 1, 1)
    las = _write_las(
        tmp_path / "scene.las", np.concatenate(xs), np.concatenate(ys), np.concatenate(zs),
        np.concatenate(cls), number_of_returns=np.concatenate(nret),
    )

    dem = tmp_path / "dem.tif"
    n = SIZE * 2
    profile = {
        "driver": "GTiff", "height": n, "width": n, "count": 1, "dtype": "float32",
        "crs": CRS.from_epsg(3006), "transform": from_origin(E0, N0 + SIZE, 0.5, 0.5), "nodata": -9999.0,
    }
    with rasterio.open(dem, "w", **profile) as dst:
        dst.write(np.full((n, n), 20.0, dtype=np.float32), 1)
    return las, dem


def _decode_png(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path))


def test_cmd_canopy_end_to_end(tmp_path: Path, scene):
    las, dem = scene
    tiles = tmp_path / "tiles"
    tiles.mkdir()
    (tiles / "manifest.json").write_text(json.dumps({
        "courseId": "c1", "layers": {"ortho": {"minzoom": 14, "maxzoom": 20}},
        "generatedAt": "old", "activeOrtho": "orto-l2-2025",
    }))

    counts = cmd_canopy([las], dem, "c1", tiles, tmp_path / "work", minzoom=17, maxzoom=18)

    assert counts["canopy"] == counts["canopy-color"] == counts["surface"] > 0
    with rasterio.open(tmp_path / "work" / "canopy.tif") as src:
        c = src.read(1)
        assert src.crs == CRS.from_epsg(3006) and c.shape == (SIZE, SIZE)
    # Crown block (rows 23..35 north-up, cols 5..17) kept at 8 m; roof block zeroed.
    assert c[SIZE - 17:SIZE - 5, 5:17].min() == pytest.approx(8.0)
    assert c[SIZE - 35:SIZE - 25, 25:35].max() == 0.0
    with rasterio.open(tmp_path / "work" / "surface.tif") as src:
        s = src.read(1)
    assert s[SIZE - 10, 10] == pytest.approx(28.0, rel=0.02)  # DEM 20 + canopy 8 (crown-shaped: centre within 2 %)
    assert s[SIZE - 6, 5] < s[SIZE - 10, 10]  # crown edge cell is lower than the interior
    assert s[SIZE - 6, 5] > 20.0
    assert s[0, 0] == pytest.approx(20.0)  # DEM ground where no canopy

    for layer in ("canopy", "canopy-color", "surface"):
        pngs = list((tiles / layer).rglob("*.png"))
        assert pngs, layer
    color = np.concatenate([_decode_png(p).reshape(-1, 4) for p in (tiles / "canopy-color").rglob("*.png")])
    assert color.shape[1] == 4
    drawn = color[color[:, 3] == 255]
    assert len(drawn) and (drawn[:, 3] == 255).all() and (color[color[:, 3] == 0][:, :3] == 0).all()
    heights = np.concatenate([decode_terrain_rgb(_decode_png(p)).ravel() for p in (tiles / "canopy").rglob("*.png")])
    assert heights.max() == pytest.approx(8.0, abs=0.2)

    manifest = json.loads((tiles / "manifest.json").read_text())
    assert manifest["layers"]["ortho"] == {"minzoom": 14, "maxzoom": 20}
    for layer in ("canopy", "canopy-color", "surface"):
        assert manifest["layers"][layer] == {"minzoom": 17, "maxzoom": 18}
    assert manifest["activeOrtho"] == "orto-l2-2025"
    assert manifest["generatedAt"] != "old"
    assert (tiles / "manifest.json.bak").exists()


def test_cmd_canopy_flat_surface_shape_adds_canopy_as_is(tmp_path: Path, scene):
    las, dem = scene
    tiles = tmp_path / "tiles"
    tiles.mkdir()
    cmd_canopy([las], dem, "c1", tiles, tmp_path / "work", minzoom=17, maxzoom=17, surface_shape="flat")
    with rasterio.open(tmp_path / "work" / "surface.tif") as src:
        s = src.read(1)
    assert s[SIZE - 10, 10] == pytest.approx(28.0)
    assert s[SIZE - 6, 5] == pytest.approx(28.0)  # edge cell: full height, no taper


def test_cmd_canopy_rejects_unknown_surface_shape(tmp_path: Path, scene):
    las, dem = scene
    with pytest.raises(ValueError, match="surface_shape"):
        cmd_canopy([las], dem, "c1", tmp_path / "tiles", tmp_path / "work", surface_shape="round")


def test_cmd_canopy_trees_out_writes_polygons_from_the_same_grid(tmp_path: Path, scene):
    las, dem = scene
    tiles = tmp_path / "tiles"
    tiles.mkdir()
    trees_out = tmp_path / "trees.geojson"
    cmd_canopy([las], dem, "c1", tiles, tmp_path / "work", minzoom=17, maxzoom=17, trees_out=trees_out)

    with rasterio.open(tmp_path / "work" / "canopy.tif") as src:
        assert src.nodata == 0.0 and src.crs == CRS.from_epsg(3006)
    fc = json.loads(trees_out.read_text(encoding="utf-8"))
    assert fc["courseId"] == "c1"
    assert len(fc["features"]) == 1  # the crown block; the roof block was suppressed
    props = fc["features"][0]["properties"]
    assert props["type"] == "trees" and props["source"] == "lidar-canopy"
    assert props["source_ref"] == "scene.las" and props["license"] == "CC0-1.0"
    assert props["heightMaxM"] == pytest.approx(8.0, abs=0.05)
    assert props["areaM2"] == pytest.approx(144, rel=0.25)  # 12x12 block (+ closing/filter growth)
