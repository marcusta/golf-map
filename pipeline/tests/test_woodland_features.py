"""woodland-features tests: synthetic cleaned-canopy grids and a synthetic
ortho (tmpdir GeoTIFFs), no lidar, no network. The property contract is the
one the server's generated-features import expects for vegetation zones
(docs/feature-vegetation-zones.md D-VZ10).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from golfpipe import woodland_features as wf
from golfpipe.__main__ import main
from golfpipe.commands import cmd_woodland_features

E0, N0 = 531000.0, 6473000.0
SIZE = 240
TRANSFORM = from_origin(E0, N0 + SIZE, 1.0, 1.0)

FLOOR = (90, 80, 50)
SHADOW = (30, 28, 20)
CROWN = (40, 95, 40)
MEADOW = (150, 170, 90)


def _grid() -> np.ndarray:
    """Rows north-up (row 0 = north edge), 1 m cells.

    stand:   6x6 m crowns of 15 m on an 8 m pitch over rows 20..100,
             cols 20..100 -> 2 m gaps the closing bridges; cover ~56 %.
    scatter: lone 5x5 m crowns every 30 m along rows 150..155 -> never a stand.
    grove:   solid 25x25 m block at rows 190..215, cols 20..45 -> 625 m², too small.
    """
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    for r in range(20, 100, 8):
        for c in range(20, 100, 8):
            g[r:r + 6, c:c + 6] = 15.0
    for c in range(20, 230, 30):
        g[150:155, c:c + 5] = 12.0
    g[190:215, 20:45] = 10.0
    return g


def _write_tif(path: Path, grid: np.ndarray, transform=TRANSFORM) -> Path:
    profile = {
        "driver": "GTiff", "height": grid.shape[0], "width": grid.shape[1], "count": 1, "dtype": "float32",
        "crs": CRS.from_epsg(3006), "transform": transform, "nodata": 0.0,
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(grid.astype(np.float32), 1)
    return path


def _write_ortho(path: Path, grid: np.ndarray, floor=FLOOR, track: bool = False) -> Path:
    """0.5 m RGB ortho over the grid: crowns green, meadow outside the stand,
    `floor` in the gaps, with the south strip of every gap in shadow. With
    `track`, a 2 m brown track runs across the crowns at row 60 (a place
    where the photo shows floor that the lidar grid calls canopy)."""
    up = np.kron(grid, np.ones((2, 2), dtype=np.float32))
    rgb = np.empty(up.shape + (3,), dtype=np.uint8)
    rgb[:] = MEADOW
    rgb[40:200, 40:200] = floor
    rgb[40:200:16, 40:200] = SHADOW  # a shadow line every 8 m: under half of the floor pixels
    rgb[up > 0] = CROWN
    if track:
        rgb[118:122, 40:200] = FLOOR
    profile = {
        "driver": "GTiff", "height": up.shape[0], "width": up.shape[1], "count": 3, "dtype": "uint8",
        "crs": CRS.from_epsg(3006), "transform": from_origin(E0, N0 + SIZE, 0.5, 0.5),
    }
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(np.moveaxis(rgb, -1, 0))
    return path


def test_the_stand_is_one_polygon_the_scatter_and_the_small_grove_are_not():
    stands = wf.woodland_from_canopy(_grid(), TRANSFORM)
    assert len(stands) == 1
    stand = stands[0]
    minx, miny, maxx, maxy = stand.geometry.bounds
    # 80 m square (cols 20..98 + the edge), in metres from the south-west corner.
    assert minx - E0 == pytest.approx(18, abs=1.5) and maxx - E0 == pytest.approx(100, abs=1.5)
    assert N0 + SIZE - maxy == pytest.approx(18, abs=1.5)
    assert 6000 < stand.area_m2 < 7500
    assert 45 <= stand.cover_pct <= 60 and stand.height_p90_m == 15.0
    assert stand.understory_pct is None and stand.weight == 1.0


def test_min_cover_drops_a_loose_scatter_the_closing_bridged():
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    for r in range(20, 120, 8):
        for c in range(20, 120, 8):
            g[r:r + 2, c:c + 2] = 15.0  # 2x2 crowns on an 8 m pitch: ~6 % cover
    assert wf.woodland_from_canopy(g, TRANSFORM, close_m=5.0) == []
    assert len(wf.woodland_from_canopy(g, TRANSFORM, close_m=5.0, min_cover=0.0)) == 1


def test_roofs_and_their_buffer_are_never_woodland():
    roof = np.zeros((SIZE, SIZE), dtype=bool)
    roof[50:70, 50:70] = True
    stands = wf.woodland_from_canopy(_grid(), TRANSFORM, roof_mask=roof, roof_buffer_m=5.0)
    assert len(stands) == 1
    # The roof and 5 m around it are a hole: 30x30 m, less the 2 m edge, is over min_hole_area.
    assert len(stands[0].geometry.interiors) == 1
    assert not stands[0].geometry.contains(stands[0].geometry.interiors[0].centroid)


def test_understory_sets_the_share_and_the_weight():
    band = np.zeros((SIZE, SIZE))
    band[20:60, 20:100] = 3  # the northern half of the stand has shrubs
    stand = wf.woodland_from_canopy(_grid(), TRANSFORM, band_count=band)[0]
    assert 40 <= stand.understory_pct <= 55
    assert stand.weight == pytest.approx(wf.understory_weight(stand.understory_pct / 100), abs=0.02)
    assert wf.understory_weight(0.0) == wf.DEFAULT_MIN_WEIGHT
    assert wf.understory_weight(0.9) == 1.0
    assert wf.understory_weight(0.1) == 0.5


def test_floor_colour_is_the_sunlit_gap_pixels(tmp_path):
    grid = _grid()
    ortho = _write_ortho(tmp_path / "ortho.tif", grid)
    stands = wf.woodland_from_canopy(grid, TRANSFORM)
    # Gaps are 2 m, so a 1 m crown buffer leaves only the crossings; sample every gap pixel.
    assert wf.floor_colors(stands, grid, TRANSFORM, ortho, gap_buffer_m=0.0, min_pixels=50) == 1
    assert stands[0].floor_color == "#{:02x}{:02x}{:02x}".format(*FLOOR)
    assert stands[0].floor_stdev is not None and stands[0].floor_stdev < 5


def test_without_floor_in_the_gaps_ground_coloured_pixels_anywhere_count(tmp_path):
    grid = _grid()
    # Gaps in shade (the photo's crowns lean over them), one brown track across the crowns.
    ortho = _write_ortho(tmp_path / "ortho.tif", grid, floor=SHADOW, track=True)
    stands = wf.woodland_from_canopy(grid, TRANSFORM)
    assert wf.floor_colors(stands, grid, TRANSFORM, ortho, min_pixels=50) == 1
    assert stands[0].floor_color == "#{:02x}{:02x}{:02x}".format(*FLOOR)


def test_crowns_shade_meadow_and_grey_are_never_floor(tmp_path):
    grid = _grid()
    for floor in (SHADOW, MEADOW, (120, 118, 110)):
        ortho = _write_ortho(tmp_path / "ortho.tif", grid, floor=floor)
        stands = wf.woodland_from_canopy(grid, TRANSFORM)
        assert wf.floor_colors(stands, grid, TRANSFORM, ortho, gap_buffer_m=0.0, min_pixels=50) == 0, floor
        assert stands[0].floor_color is None


def test_feature_collection_property_contract():
    stand = wf.woodland_from_canopy(_grid(), TRANSFORM, band_count=np.ones((SIZE, SIZE)))[0]
    stand.floor_color, stand.floor_stdev = "#5a5032", 7.5
    doc = wf.build_woodland_feature_collection([stand], "m.laz", course_id="c1")
    assert doc["courseId"] == "c1" and doc["crs"]["properties"]["name"].endswith("3006")
    props = doc["features"][0]["properties"]
    assert props == {
        "type": "vegetation_zone", "source": "lidar-woodland", "source_ref": "m.laz", "license": "CC0-1.0",
        "zoneType": "woodland_floor", "weight": 1.0, "feather": 4.0, "noise": 2.0,
        "coverPct": stand.cover_pct, "heightP90M": 15.0, "areaM2": stand.area_m2,
        "understoryPct": 100, "floorColor": "#5a5032", "floorStdev": 7.5,
    }
    bare = wf.build_woodland_feature_collection([wf.WoodlandStand(stand.geometry, 50, 12.0, 100)], "x")
    assert not {"understoryPct", "floorColor", "floorStdev"} & set(bare["features"][0]["properties"])


def test_command_and_cli_from_canopy_tif_with_roofs_and_ortho(tmp_path, capsys):
    grid = _grid()
    tif = _write_tif(tmp_path / "canopy.tif", grid)
    roof = np.zeros((SIZE, SIZE), dtype=np.float32)
    roof[50:70, 50:70] = 1
    roof_tif = _write_tif(tmp_path / "roof.tif", roof)
    ortho = _write_ortho(tmp_path / "ortho.tif", grid)
    out = cmd_woodland_features(tmp_path / "woodland.geojson", canopy_tif=tif, roof_tif=roof_tif,
                                ortho_path=ortho, course_id="c1")
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert len(doc["features"]) == 1
    assert len(doc["features"][0]["geometry"]["coordinates"]) == 2  # shell + the roof hole
    report = capsys.readouterr().out
    assert "Woodland stands: 1" in report and "roof buffer 5 m" in report and "Floor colour for 1 of 1" in report

    out2 = tmp_path / "cli.geojson"
    code = main(["woodland-features", "--canopy-tif", str(tif), "--out", str(out2), "--min-area", "500",
                 "--source-ref", "m21.laz"])
    assert code in (0, None)
    doc = json.loads(out2.read_text(encoding="utf-8"))
    assert len(doc["features"]) == 2  # the 625 m² grove passes a 500 m² floor
    assert {f["properties"]["source_ref"] for f in doc["features"]} == {"m21.laz"}
    with pytest.raises(SystemExit):
        main(["woodland-features", "--lidar", "a.laz", "--out", str(out2)])
