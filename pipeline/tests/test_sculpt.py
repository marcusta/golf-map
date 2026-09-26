"""Unity sculpt layers: capture -> GeoTIFF -> `delta` edit, and back onto the
heightmap grid (gspro.py dem --sculpt). Synthetic rasters only.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds, from_origin

import gspro
from golfpipe.dem_edit import load_edits, apply_edits, reproject_edits
from golfpipe.sculpt import SculptError, capture_to_geotiff, sculpt_on_grid

E0, N0, SIDE, SIZE = 533000.0, 6475000.0, 40.0, 81   # 81 heightmap pixels over 40 m
SQUARE = (E0, N0, E0 + SIDE, N0 + SIDE)


def capture(tmp_path: Path, block: np.ndarray, col0: int, row0: int, name="inner") -> Path:
    raw = tmp_path / f"c-{name}-sculpt.raw"
    block.astype("<f4").tofile(raw)
    meta = tmp_path / f"c-{name}-sculpt.json"
    meta.write_text(json.dumps({
        "format": "golfmap-sculpt-v1", "terrain": name, "square3006": list(SQUARE), "size": SIZE,
        "file": raw.name, "crop": {"col0": col0, "row0": row0, "cols": block.shape[1], "rows": block.shape[0]},
        "cells": int((block != 0).sum()), "areaM2": 1, "maxRaiseM": float(block.max()), "maxLowerM": float(block.min()),
    }))
    return meta


def test_capture_becomes_a_geotiff_on_the_heightmap_pixels_and_comes_back_cell_for_cell(tmp_path: Path):
    block = np.array([[0.1, 0.2, 0.3], [0.0, -0.4, 0.5]], dtype=np.float32)
    meta = capture_to_geotiff(capture(tmp_path, block, col0=10, row0=20), tmp_path / "inner-sculpt.tif")
    px = SIDE / SIZE
    assert meta["bounds3006"] == pytest.approx([E0 + 10 * px, N0 + SIDE - 22 * px, E0 + 13 * px, N0 + SIDE - 20 * px], abs=1e-3)
    with rasterio.open(tmp_path / "inner-sculpt.tif") as src:
        assert src.crs == CRS.from_epsg(3006)
        assert np.allclose(src.read(1), block)
    # Back onto the full grid (what gspro.py dem writes as sculpt-in): the same cells, nothing else.
    grid = sculpt_on_grid([tmp_path / "inner-sculpt.tif"], SQUARE, SIZE)
    assert grid[20:22, 10:13] == pytest.approx(block, abs=1e-5)
    grid[20:22, 10:13] = 0
    assert np.abs(grid).max() < 1e-6


def test_a_capture_without_cells_or_with_a_short_raw_is_refused(tmp_path: Path):
    meta = capture(tmp_path, np.ones((2, 2)), 0, 0)
    doc = json.loads(meta.read_text()); doc["crop"] = None; meta.write_text(json.dumps(doc))
    with pytest.raises(SculptError, match="no sculpted cells"):
        capture_to_geotiff(meta, tmp_path / "x.tif")
    meta = capture(tmp_path, np.ones((2, 2)), 0, 0)
    doc = json.loads(meta.read_text()); doc["crop"]["cols"] = 5; meta.write_text(json.dumps(doc))
    with pytest.raises(SculptError, match="holds 4 floats"):
        capture_to_geotiff(meta, tmp_path / "x.tif")


def test_delta_edit_adds_the_layer_where_it_is_and_nowhere_else(tmp_path: Path):
    # A 40 m DEM at 0.5 m cells, flat at 20 m; a sculpt raising a 5 × 5-pixel block 0.3 m.
    block = np.full((5, 5), 0.3, dtype=np.float32)
    meta = capture_to_geotiff(capture(tmp_path, block, col0=40, row0=40), tmp_path / "inner-sculpt.tif")
    x0, y0, x1, y1 = meta["bounds3006"]
    from rasterio.warp import transform as warp
    ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    lons, lats = warp(CRS.from_epsg(3006), CRS.from_epsg(4326), [p[0] for p in ring], [p[1] for p in ring])
    edits_path = tmp_path / "edits.geojson"
    edits_path.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "properties": {"op": "delta", "featherM": 0, "raster": str(tmp_path / "inner-sculpt.tif")},
        "geometry": {"type": "Polygon", "coordinates": [[[lo, la] for lo, la in zip(lons, lats)]]},
    }]}))
    [edit] = reproject_edits(load_edits(edits_path), CRS.from_epsg(3006))
    dem = np.full((80, 80), 20.0, dtype=np.float32)
    out = apply_edits(dem, from_origin(E0, N0 + SIDE, 0.5, 0.5), None, [edit], log=lambda *_: None)
    # The block's middle (x ≈ E0 + 20.9 m, y ≈ N0 + 19.1 m) is raised by the full 0.3 m ...
    assert out[int(20.9 / 0.5), int(20.9 / 0.5)] == pytest.approx(20.3, abs=0.01)
    # ... and nothing moved outside the layer, or anywhere down.
    assert np.all(out >= 20.0 - 1e-6)
    assert int((out > 20.001).sum()) <= 36
    assert out[5, 5] == 20.0


def test_load_edits_skips_a_delta_whose_raster_is_missing(tmp_path: Path):
    path = tmp_path / "edits.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"op": "delta", "featherM": 0, "raster": str(tmp_path / "gone.tif")},
        "geometry": {"type": "Polygon", "coordinates": [[[15.5, 58.5], [15.6, 58.5], [15.6, 58.6], [15.5, 58.5]]]},
    }]}))
    logged: list[str] = []
    assert load_edits(path, log=logged.append) == []
    assert "delta needs an existing raster" in logged[0]


def test_gspro_dem_writes_the_sculpt_layer_it_contains_next_to_the_heightmap(tmp_path: Path):
    dem = tmp_path / "dem.tif"
    with rasterio.open(dem, "w", driver="GTiff", width=80, height=80, count=1, dtype="float32",
                       crs=CRS.from_epsg(3006), transform=from_origin(E0, N0 + SIDE, 0.5, 0.5)) as dst:
        dst.write(np.full((80, 80), 20.0, dtype=np.float32), 1)
    block = np.full((3, 4), 0.25, dtype=np.float32)
    capture_to_geotiff(capture(tmp_path, block, col0=30, row0=12), tmp_path / "inner-sculpt.tif")
    out = tmp_path / "x-inner-dem-40m.tif"
    gspro.cmd_dem(None, dem, out, 0.5, extent=SQUARE, raw_size=SIZE, terrain="inner", sculpt=[tmp_path / "inner-sculpt.tif"])
    sidecar = json.loads((tmp_path / "x-inner-dem-40m.tif.json").read_text())
    s = sidecar["sculptIn"]
    assert (s["file"], s["size"], s["crop"]) == ("x-inner-dem-40m-sculpt-in.raw", SIZE, {"col0": 30, "row0": 12, "cols": 4, "rows": 3})
    data = np.fromfile(tmp_path / s["file"], dtype="<f4").reshape(3, 4)
    assert data == pytest.approx(block, abs=1e-5)
    # Exported again without a sculpt: the stale file goes.
    gspro.cmd_dem(None, dem, out, 0.5, extent=SQUARE, raw_size=SIZE, terrain="inner")
    assert "sculptIn" not in json.loads((tmp_path / "x-inner-dem-40m.tif.json").read_text())
    assert not (tmp_path / s["file"]).exists()
